// 「精简模式」的纯逻辑：决定手机那一份页面里**发哪些客户端插件**，以及怎么把
// 宿主渲染好的 index.html 改写成精简版。这里不碰任何服务、不读文件、不发请求，
// 所以可以被单测完整覆盖；真正的 HTTP 与磁盘动作留在 index.js。
//
// 背景：DSH 的 Web 首屏会把插件图里**每一个**客户端包都 preload 下来（本机实测
// 约 5.3 MB gzip）。其中大半是手机根本用不到的东西 —— 设置里的账号插画（单个包
// 就 2.4 MB）、插件管理器、模型设置、各种第三方面板。手机走 Tailscale 时带宽很窄，
// 这些字节是纯粹的负担。
//
// 做法：不动 DSH 的任何代码，而是在**HTTP 渲染出来的 index.html** 上做手术：
//   1. 用一份白名单（见 LITE_SEEDS）在活的插件图上求闭包，得到精简图；
//   2. 把 `globalThis["__DSH_BOOT__"]` 换成精简图，客户端就只认这些包；
//   3. 把整图那些 `rel=preload` 的合并请求换成精简版的（由本插件自己的路由服务），
//      首屏因此只下载精简闭包。
//
// 为什么只作用于 HTTP 页面：桌面端不是走这条路 —— 它由 Electron 直接读 dist 里的
// index.html、再通过 IPC 把 `injections` 表交给客户端。`webServer.tapIndex` 只参与
// `webServer.renderIndex()`，也就是 frontend-static 那条 HTTP 回退路径。所以桌面端
// 一个字节都不会被裁掉。

import { createHash } from 'node:crypto'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** 精简组合的版本号；白名单或拼装方式变了就 +1（会进合并请求的 rev，从而失效缓存）。 */
export const LITE_VERSION = 1

/** 精简页面的插件资源路由。刻意不用 `/plugins`（那是 client-modules 的前缀路由，重复注册会抛）。 */
export const LITE_ROUTE = '/remote-lite-plugins'

/**
 * 单个合并请求的 URL 上限。
 *
 * 与 `@deepseek-ai/dsh-client-modules` 的 `MAX_COMBO_URL_BYTES` 一致：它按
 * **带 `.map`** 的最长形态来分段，所以这里也必须按同样的口径算，否则一个 URL 在
 * 服务端合法、在浏览器里却超长。
 */
const MAX_COMBO_URL_BYTES = 3 * 1024

/** rev 的长度，同样抄 client-modules 的 `HASH_REVISION_LENGTH`。 */
const HASH_REVISION_LENGTH = 12

/**
 * 必须存在于活图里、否则**放弃精简**改发完整页面的核心包。
 *
 * 为什么要有这一条：这份白名单按包名写死，而 DSH 升级可能改名或拆包。真出现那种
 * 情况时，宁可多发几 MB，也不能把一个残缺的页面发给手机 —— 后者连设置页都进不去，
 * 用户在手机上没有任何自救手段。
 */
export const LITE_REQUIRED = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-api-remotes',
  // 注意：`ui-settings-general` **不在**这里。它只是设置页的界面，精简页面把设置入口
  // 换成自己的开关，不再需要它。但 `ui-settings`（服务）必须在 —— 见 LITE_SEEDS。
  '@deepseek-ai/dsh-client-ui-settings',
]

/**
 * 精简页面的种子包：手机上看对话、切会话、发消息所必需的那些。
 *
 * 这只是**种子**，不是最终集合 —— 真正保留的是它在活图上的传递闭包（`inject` 与
 * `external` 两条边都走）。闭包能自动带上所有被同步 `require()` 的依赖，所以不必
 * 手工维护；包名改了也只是这一条失配，其余照旧。
 *
 * 刻意**不含** `@deepseek-ai/dsh-client-hmr`：它是唯一会通过 `/plugins/events` 把
 * **完整**插件图推回页面的插件，留着的话客户端会立刻把裁掉的包全部重新拉一遍，
 * 精简就白做了。手机也不需要热更新。
 *
 * 也刻意**不含**这几项（用户点名不要，共省约 210 KB gzip）：
 *   - `ui-settings-general`：设置页的界面。手机上不留设置入口（见 LITE_HIDE），
 *     所以它的行插槽没人渲染。**注意 `ui-settings` 本身必须留** —— 它 `provide`
 *     了 `configForms`/`settingsSchema`，locale / theme / chat / conversation 都
 *     硬依赖它，删了会让整个 boot 审计报「pending」并让页面起不来。
 *   - `ui-sidebar-right` / `ui-trajectory` / `ui-tool` / `ui-attachment` / `ui-reference`：
 *     右侧栏、轨迹视图、工具调用渲染、附件与引用。
 *
 * 但这几项里 `sidebarRight` 是 `ui-chat`/`ui-reference` 的**硬依赖服务**，所以
 * 不能直接从图里删（详见 LITE_SERVICE_KEEP）。
 */
export const LITE_SEEDS = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  'dsh-tailscale-remote',
]

/**
 * 只留服务、不留界面的包。
 *
 * 为什么需要这一类：Cordis 的 `exports.inject` 是**服务级**门禁 —— 一个包声明的服务
 * 没有提供者时，它的 fiber 停在 `pending`，而 shell 的 boot 审计（`webRun` 末尾那个
 * `bZ`）把 `pending` 也算失败，直接抛 `web boot: N entries did not activate`，
 * **整个页面白屏**。所以「用户不要右侧栏」不能简单地删 `ui-sidebar-right`
 * （它 provide 了 `sidebarRight`，`ui-chat` 硬依赖），只能**留着包、藏掉界面**。
 *
 * 藏法：这些包把界面注册在插槽上，而插槽的挂载点由容器决定。这里列的是
 * 「注册了就要藏起来」的插槽名，见 LITE_HIDE。
 */
export const LITE_SERVICE_KEEP = [
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-tool',
]

/**
 * 精简页面上要**藏掉**的界面锚点（CSS 选择器）。
 *
 * 为什么用 CSS 而不是删包：见 LITE_SERVICE_KEEP。这些选择器都是 DSH 自己的
 * **稳定**锚点（`data-slot` 是插槽系统公开的定位键），不是哈希类名，所以 DSH
 * 小版本升级不会让它们失效；真失效了也只是「多显示一块」，不会白屏。
 *
 * **只在这份（手机的）页面上生效** —— 桌面窗口走的是另一条渲染路径，一个字节都
 * 不经过这里。
 *
 * 注意**不能藏** `sidebar.settings`：那是 `ui-settings` 注册在侧边栏底部的**唯一**
 * 设置入口（`sidebar.settings` 是 `single` 插槽，旁边没有第二个），藏掉之后手机上
 * 就再也进不去设置页了 —— 而设置里有账号、模型、插件等一堆东西。精简模式那个图标
 * 是加在它**旁边**的 `sidebar.footer.action` 里，不是替换它。
 */
export const LITE_HIDE = [
  // 右侧栏：连同它的开关按钮（按钮没有 data-slot，只能按 aria-label 定位）。
  '[data-slot="rightbar"]',
  'button[aria-label="打开右侧边栏"]',
  'button[aria-label="收起右侧边栏"]',
  // 会话视图切换里那个「轨迹」页签。
  '[data-slot="conversation.view"][data-slot-id="trajectory"]',
]

/**
 * 精简页面上要**修的布局**（只改这一份页面）。
 *
 * 只做一件事：把「工作区」标题行里搜索按钮前面那段空档去掉。
 *
 * 成因（实测 DOM）：那一行是 `display:flex; gap:4px; justify-content:flex-end`，
 * 但搜索按钮的容器 `_9lTDKa_searchSlot` 自带 `flex: 1 1 0%` 和一个**硬编码**的
 * `margin-left: 146px`。146px 是按「工作区」这几个字的宽度估出来的，一旦窄了/宽了
 * 就留下一段多余空白。把它归零、让 flex 自己撑开，按钮就贴到右边该在的位置。
 *
 * 为什么用属性选择器而不是哈希类名：`_9lTDKa_` 前缀是构建产物，DSH 一升级就变；
 * `[class*="_searchSlot"]` 认的是那一段可读的语义名，稳得多，而且匹配不到时只是
 * 布局保持原样，不会坏事。
 */
export const LITE_FIX = [
  {
    // 搜索按钮那一格：去掉硬编码左边距，让它靠 flex 定位。
    selector: '[class*="_searchSlot"]',
    css: 'margin-left:0 !important;flex:0 0 auto !important',
  },
]

/** 去掉 DSH loader 里那个 `/client` 子路径后缀，得到包名。 */
export function stripClientSuffix(id) {
  return id.endsWith('/client') ? id.slice(0, -7) : id
}

/** 按 client-modules 的 framed-hash 口径算 12 位十六进制摘要（换版本 → 换 rev → 换缓存）。 */
function framedHash(parts) {
  const hash = createHash('sha1')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** 一个合并请求在**浏览器里**的形态：文档相对（无前导斜杠）。 */
function comboReference(ids, rev, sourceMap) {
  const list = ids.map((id) => `${id}/client.js${sourceMap === true ? '.map' : ''}`).join(',')
  return `${LITE_ROUTE.slice(1)}/??${list}&rev=${rev}`
}

/** 分段时长度的口径：带 `.map` 的最长形态 + 占位 rev（与 client-modules 逐字一致）。 */
function projectedComboUrlBytes(ids) {
  return Buffer.byteLength(comboReference(ids, '0'.repeat(HASH_REVISION_LENGTH), true))
}

/**
 * 按 URL 上限把一个有序包列表切成若干合并请求。
 * @returns 每段的包子列表；任何单段超限时返回 undefined（调用方放弃精简）。
 */
function partitionIds(ids) {
  const chunks = []
  let current = []
  for (const id of ids) {
    const candidate = [...current, id]
    if (projectedComboUrlBytes(candidate) <= MAX_COMBO_URL_BYTES) {
      current = candidate
      continue
    }
    if (current.length === 0) return undefined
    chunks.push(current)
    current = [id]
    if (projectedComboUrlBytes(current) > MAX_COMBO_URL_BYTES) return undefined
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 在活的插件图上求精简闭包，产出可以直接替换 `__DSH_BOOT__` 的精简图。
 *
 * 保序：行序照抄整图（整图已经是 `orderByModuleGraph()` 的拓扑序），所以精简图的
 * 拓扑序天然正确 —— 客户端会按这个顺序把依赖先 materialize 再让消费者 `require()`。
 * @param graph - `clientModules.graph()` 返回的整图（或它的 JSON 副本）。
 * @param options - 测试注入点：`seeds` / `required` / `version`。
 * @returns `{ graph, entries, batches, ids }`；无法安全精简时返回 undefined。
 */
export function composeLiteGraph(graph, options = {}) {
  const seeds = options.seeds ?? LITE_SEEDS
  const required = options.required ?? LITE_REQUIRED
  const version = options.version ?? LITE_VERSION
  if (graph === null || typeof graph !== 'object') return undefined
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) return undefined

  const byId = new Map()
  for (const entry of graph.entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    if (typeof entry.rev !== 'string') continue
    byId.set(entry.id, entry)
  }
  // 核心包缺一个就整体放弃：宁可用完整页面，也不发一个进不去设置页的残缺页面。
  for (const id of required) if (!byId.has(id)) return undefined

  const keep = new Set()
  const queue = []
  for (const seed of seeds) {
    const id = stripClientSuffix(seed)
    if (byId.has(id) && !keep.has(id)) queue.push(id)
  }
  while (queue.length > 0) {
    const id = queue.pop()
    if (keep.has(id)) continue
    keep.add(id)
    const entry = byId.get(id)
    const inject = Array.isArray(entry.inject) ? entry.inject : []
    const external = Array.isArray(entry.external) ? entry.external : []
    for (const edge of [...inject, ...external]) {
      const dependency = stripClientSuffix(edge)
      if (byId.has(dependency) && !keep.has(dependency)) queue.push(dependency)
    }
  }

  const entries = graph.entries.filter((entry) => keep.has(entry.id))
  const ids = entries.map((entry) => entry.id)

  // bootstrap 段原样保留（只有 `@deepseek-ai/dsh-client-modules`，它的 URL 由
  // client-modules 自己服务）。剔掉万一混进来的非保留包，保证「每个包只属于一段」。
  const batches = []
  const seen = new Set()
  for (const batch of graph.batches) {
    if (batch === null || typeof batch !== 'object' || batch.phase !== 'bootstrap') continue
    if (typeof batch.url !== 'string' || typeof batch.rev !== 'string' || !Array.isArray(batch.entries)) continue
    const members = batch.entries.filter((id) => keep.has(id) && !seen.has(id))
    if (members.length === 0) continue
    for (const id of members) seen.add(id)
    batches.push({ phase: 'bootstrap', url: batch.url, rev: batch.rev, entries: members })
  }

  const application = ids.filter((id) => !seen.has(id))
  const chunks = partitionIds(application)
  if (chunks === undefined) return undefined
  for (const chunk of chunks) {
    const rev = framedHash([
      'dsh-tailscale-remote-lite',
      String(version),
      ...chunk.flatMap((id) => [id, byId.get(id).rev]),
    ])
    batches.push({
      phase: 'application',
      url: comboReference(chunk, rev),
      rev,
      entries: chunk,
    })
  }

  // 每一个保留包都必须落在某一段里，否则客户端的 manifest 解析会抛。
  for (const id of ids) if (!batches.some((batch) => batch.entries.includes(id))) return undefined

  return {
    graph: {
      rev: typeof graph.rev === 'string' ? graph.rev : 'lite',
      ...(graph.release === undefined ? {} : { release: graph.release }),
      entries,
      batches,
    },
    entries,
    batches,
    ids,
    // 给客户端半边读的页面变体标记：`full` 恒为保留包名列表，可用来断言「真的裁过」。
    marker: 'lite',
  }
}

/**
 * 把若干原始 bundle 拼成一个合并请求的脚本体。
 *
 * 与 client-modules 的 `prepareSource` 同口径：去掉行尾的 `//# sourceURL=` 与
 * `//# sourceMappingURL=` 指令（它们会把后一个包的内容算进前一个包的映射里），
 * 保证每个包以换行收尾，再用 `;` 分隔。
 * @param buffers - 每个包的原始字节，顺序必须与 URL 里的包名一致。
 * @returns 拼好的脚本字节。
 */
export function composeComboBody(buffers) {
  let out = ''
  for (const buffer of buffers) {
    let source = Buffer.from(buffer).toString('utf8')
    source = source.replace(/(?:\r?\n)?\/\/# sourceURL=[^\r\n]*(?:\r?\n)?$/, '')
    source = source.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '')
    if (!source.endsWith('\n')) source += '\n'
    out += `${source};\n`
  }
  return Buffer.from(out, 'utf8')
}

/** 把值渲染成 `renderRow` 那种 `<` 转义过的 JSON（避免在 `<script>` 里出现 `</script>`）。 */
function serializeGlobal(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * 选一种「手机上真的能省字节」的压缩来编码合并请求的正文。
 *
 * 为什么不能只依赖 webserver 的 gzip：实测那条约 5.0 MB 的合并请求在
 * `compressionLevel: 1` 下是 1,295,803 B，而这个函数据同一份字节：
 *
 *   gzip level 1 → 1,295,803（webserver 默认）
 *   gzip level 6 → 1,062,672（-18%）
 *   brotli q5    →   ~880,000（-32%）
 *
 * 手机上这是实打实的省流量与省时间。brotli 优先（几乎所有现代手机浏览器都支持），
 * 不支持就退 `gzip`，都不支持就发原文。
 *
 * 压缩在**拼好之后同步做一次**并缓存在调用方，所以只花一次 CPU（约 0.1–0.5 s），
 * 之后每个请求都是直接吐缓存。这也是为什么不在每个请求里现压。
 * @param body - 未压缩的正文。
 * @param acceptEncoding - 客户端的 `Accept-Encoding` 头（可缺省）。
 * @returns `{ body, encoding }`；`encoding` 为 undefined 表示发原文。
 */
export function encodeComboBody(body, acceptEncoding) {
  const accepted = String(acceptEncoding ?? '').toLowerCase()
  if (accepted.includes('br')) {
    return { body: brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        // 这个正文是脚本，不是网页；文本模式更省。
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    }), encoding: 'br' }
  }
  if (accepted.includes('gzip')) {
    // 6 是速度/比率的拐点：再往上只多省 0.5%，CPU 却翻倍。
    return { body: gzipSync(body, { level: 6 }), encoding: 'gzip' }
  }
  return { body, encoding: undefined }
}

/** `renderRow` 对属性值的转义，用于按原样定位 preload 链接。 */
function escapeHtmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const BOOT_MARKER = 'globalThis["__DSH_BOOT__"] = '

/**
 * 精简页面上种下的标记全局。
 *
 * 为什么不用「`__DSH_BOOT__.entries.length` 变少了」来判断：那是拿数字当契约，
 * DSH 一升级就骗人。这个全局由**本插件**在改写 index 时种下，只说明「这一份
 * 页面是精简版」，与整图长什么样无关，因而是可信的。客户端半边读它来决定设置页
 * 那一行该说「当前是精简模式」还是「当前是完整模式」—— 两者在切换后、重载前会
 * 短暂不一致，这个标记说的是**这份页面真的在跑哪一版**。
 */
export const LITE_MARKER = '__DSH_TAILSCALE_REMOTE_LITE__'

/**
 * 整图那些首屏预载。
 *
 * 为什么按前缀整片删、而不是按 `full.batches` 逐条精确匹配：这些
 * `<link rel="preload" as="script">` 行**只有** `@deepseek-ai/dsh-client-modules` 会
 * 产出（`bootInjections` 是唯一来源，已全库核对）。按前缀删对图形的其它变化免疫，
 * 而且删不干净也只是多下几个字节 —— `__DSH_BOOT__` 换了，页面照样按精简图启动。
 *
 * 注意 `href` 里的 `&` 已被 `escapeHtmlAttribute` 转义成 `&amp;`，所以不能用
 * 原始的合并请求 URL 直接比。
 */
const PRELOAD_PATTERN = /<link rel="preload" as="script" href="plugins\/\?\?[^"]*">/g

/**
 * 把宿主渲染好的 index.html 改写成精简版。
 *
 * 只动三处，别的一律原样保留（其它插件的注入、`<base href="./">`、`__DSH_BOOT_READY__`
 * 收尾脚本等）：
 *   1. 删掉整图那些首屏预载（它们才是那 5 MB 的来源）；
 *   2. 在 head 里补上精简版的预载；
 *   3. 换掉 `__DSH_BOOT__`。
 *
 * 换 `__DSH_BOOT__` 一旦失败就**原样返回**并给出原因：宁可发完整页面，也不能发一个
 * 「图没换掉但预载被删」的半截页面 —— 后者会让客户端去要一堆没预载的包。
 * @param html - `webServer.renderIndex()` 的输出。
 * @param input - `{ lite }`：`composeLiteGraph()` 的产物。
 * @returns `{ html, changed, reason, removed, preloads }`。
 */
export function rewriteIndex(html, input) {
  const lite = input?.lite
  if (typeof html !== 'string') return { html, changed: false, reason: 'html-not-a-string' }
  if (lite === undefined || lite === null) return { html, changed: false, reason: 'no-lite-graph' }

  // 先确认整图那段 `__DSH_BOOT__` 真的在、且是完整的一对 `<script>`；不满足就什么都不做。
  const at = html.indexOf(BOOT_MARKER)
  if (at < 0) return { html, changed: false, reason: 'boot-marker-missing' }
  if (html.indexOf('</script>', at) < 0) return { html, changed: false, reason: 'boot-script-unterminated' }

  PRELOAD_PATTERN.lastIndex = 0
  const matched = html.match(PRELOAD_PATTERN) ?? []
  let out = html.replace(PRELOAD_PATTERN, '')

  const preloads = lite.batches
    .filter((batch) => batch.phase === 'application')
    .map((batch) => `<link rel="preload" as="script" href="${escapeHtmlAttribute(batch.url)}">`)
    .join('')
  const head = /<head(?:\s[^>]*)?>/i.exec(out)
  if (head === null) return { html, changed: false, reason: 'head-missing' }
  const headEnd = head.index + head[0].length
  out = `${out.slice(0, headEnd)}${preloads}${out.slice(headEnd)}`

  const at2 = out.indexOf(BOOT_MARKER)
  const end2 = at2 < 0 ? -1 : out.indexOf('</script>', at2)
  if (at2 < 0 || end2 < 0) return { html, changed: false, reason: 'boot-marker-lost' }
  out = `${out.slice(0, at2)}${BOOT_MARKER}${serializeGlobal(lite.graph)}${out.slice(end2)}`

  // 页面变体的标记：让客户端半边能说出「这份页面跑的是哪一版」，而不是靠猜。
  const marker = `<script>globalThis[${JSON.stringify(LITE_MARKER)}] = ${JSON.stringify(lite.marker)}<\/script>`
  const head2 = /<head(?:\s[^>]*)?>/i.exec(out)
  if (head2 === null) return { html, changed: false, reason: 'head-missing' }
  const head2End = head2.index + head2[0].length
  out = `${out.slice(0, head2End)}${marker}${hideCss(input.hide)}${out.slice(head2End)}`

  return { html: out, changed: true, reason: 'ok', removed: matched.length, preloads: lite.batches.length }
}

/**
 * 藏掉指定界面锚点的那一段 `<style>`。
 *
 * 为什么用 CSS 而不是删包：`exports.inject` 是**服务级**门禁，一个包提供的服务被
 * 别人硬依赖时，删包会让消费者的 fiber 停在 `pending`，而 boot 审计把 pending 算
 * 失败 —— 整个页面白屏。所以「用户不要右侧栏」只能留包、藏界面。
 *
 * `display: none !important` 而不是 `visibility: hidden`：后者仍然占布局，侧边栏
 * 那块空白会留着。用 `!important` 是因为 DSH 自己的类名带优先级。
 * @param selectors - 要隐藏的 CSS 选择器；省略时用 `LITE_HIDE`。
 */
function hideCss(selectors) {
  const list = Array.isArray(selectors) && selectors.length > 0 ? selectors : LITE_HIDE
  const rules = []
  if (list.length > 0) {
    // 选择器只来自本模块的常量（绝不拼接外部输入），所以不需要转义。
    rules.push(`${list.join(',')}{display:none !important}`)
  }
  // 布局修正（跟「藏掉」分开写：一个是 display:none，一个是改几条属性）。
  for (const fix of LITE_FIX) rules.push(`${fix.selector}{${fix.css}}`)
  if (rules.length === 0) return ''
  return `<style data-dsh-tailscale-remote-hide>${rules.join('')}</style>`
}

/**
 * 解析一个精简合并请求，取回它对应的那一段。
 *
 * 必须拿**整个 `req.url`**（含查询）来比，不能只用 pathname：`comboReference` 生成的
 * 形态是 `remote-lite-plugins/??<id>/client.js,...&rev=<rev>`，第一个 `?` 之后全是查询，
 * 于是 URL 解析出来的 pathname 对每一段都是同一个 `/<路由>/`。这与
 * `client-modules` 自己的 `bundleResource` 口径一致（它也按 `pathname + search` 查表）。
 * @param url - 请求的完整 URL（`req.url`）。
 * @param lite - 当前的 `composeLiteGraph()` 产物。
 * @returns 命中时返回那一段 `{ url, rev, entries }`；不是本路由、或不是当前图里的
 *          任何一段时返回 undefined。
 */
export function matchLiteRequest(url, lite) {
  if (lite === undefined || lite === null || typeof url !== 'string') return undefined
  if (url !== LITE_ROUTE && !url.startsWith(`${LITE_ROUTE}/`)) return undefined
  for (const batch of lite.batches) {
    if (batch.phase !== 'application') continue
    if (`/${batch.url}` === url) return batch
  }
  return undefined
}
