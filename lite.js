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
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
]

/**
 * 精简页面的种子包：手机上看对话、切会话、开设置页所必需的那些。
 *
 * 这只是**种子**，不是最终集合 —— 真正保留的是它在活图上的传递闭包（`inject` 与
 * `external` 两条边都走）。闭包能自动带上所有被同步 `require()` 的依赖，所以不必
 * 手工维护；包名改了也只是这一条失配，其余照旧。
 *
 * 刻意**不含** `@deepseek-ai/dsh-client-hmr`：它是唯一会通过 `/plugins/events` 把
 * **完整**插件图推回页面的插件，留着的话客户端会立刻把裁掉的包全部重新拉一遍，
 * 精简就白做了。手机也不需要热更新。
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
  '@deepseek-ai/dsh-client-ui-sidebar-right',
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
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-shortcuts',
  'dsh-tailscale-remote',
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
  out = `${out.slice(0, head2End)}${marker}${out.slice(head2End)}`

  return { html: out, changed: true, reason: 'ok', removed: matched.length, preloads: lite.batches.length }
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
