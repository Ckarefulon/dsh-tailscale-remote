/**
 * dsh-tailscale-remote — 把本机 DSH Web GUI 通过 Tailscale Serve 暴露到 tailnet 上，
 * 让手机在任何网络下都能打开；DSH 退出时把这条路由撤掉。
 *
 * 设计要点（都是实测结论，别凭直觉改）：
 *
 * 1. `tailscale serve` **保留客户端的 Host 头**（实测：请求 tailnet 地址时，后端收到
 *    的 `host` 就是 `xxx.ts.net:7259`）。而 DSH 的 `/api` fence（`isTrustedApiRequest`）
 *    要求 Host 是回环地址或命中 `trustedHosts`，否则一律 403。所以插件必须把
 *    `<dnsName>:<port>` 塞进 `connection.trustedHosts`，否则手机上页面能开、RPC 全 403。
 *
 * 2. `connection.trustedHosts` 是服务上一个**公开的可变数组**，fence 每次请求都读它，
 *    所以运行时 push 立刻生效，不需要改 profile 的 cordis.yml。
 *
 * 3. 手机上要"打开网页就能连"，靠的是 `connection.authenticatedUrl(url)` 生成的一次性
 *    令牌链接：带 `?token=` 打开会种下 30 天的 HttpOnly cookie，之后书签直接访问即可。
 *
 * 4. 退出清理挂在 `ctx.effect(() => () => ...)` 上：这是唯一可靠的关停挂点（没有
 *    `app-boot/shutdown` 事件，Host 侧也没有 Electron 的 `before-quit`）。清理必须
 *    幂等、绝不 reject（reject 的 disposer 会让 runProfile 抛 AggregateError）。
 *
 * @module dsh-tailscale-remote
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { LITE_HIDE, LITE_ROUTE, composeComboBody, composeLiteGraph, encodeComboBody, matchLiteRequest, rewriteIndex } from './lite.js'

/** 稳定插件名。 */
export const name = 'dsh-tailscale-remote'

/** 清理阶段单条命令的超时（毫秒）。进程关停预算很紧，宁可放弃也不要拖住。 */
const TEARDOWN_TIMEOUT_MS = 3500

/** 启动阶段单条命令的超时（毫秒）。`tailscale up` 可能要等网络。 */
const SETUP_TIMEOUT_MS = 12000

/** 各平台 tailscale 可执行文件的候选路径，按顺序探测。 */
const BINARY_CANDIDATES = {
  win32: [
    process.env.TAILSCALE_PATH,
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    'tailscale',
  ],
  darwin: [
    process.env.TAILSCALE_PATH,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/bin/tailscale',
    'tailscale',
  ],
  linux: [
    process.env.TAILSCALE_PATH,
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/sbin/tailscale',
    'tailscale',
  ],
}

/**
 * 各平台的 Tailscale **桌面客户端**——也就是用户手动「打开 Tailscale」的那一下。
 *
 * 为什么需要它：在 Windows（以及 macOS 的 App 形态）上，tailscaled 由客户端负责
 * 初始化 backend。用户从托盘「完全退出」之后，服务还在跑、`tailscale status` 报
 * `BackendState: NoState` + `Health: ["Tailscale is starting. Please wait."]`，
 * 此时 **`tailscale up` 会「立刻 exit 0、不输出任何东西、也什么都不做」**（实测）。
 * 只有把客户端拉起来，backend 才会真正连上（实测：启动后立刻变 Running + Online）。
 */
const GUI_CANDIDATES = {
  win32: [
    process.env.TAILSCALE_GUI_PATH,
    'C:\\Program Files\\Tailscale\\tailscale-ipn.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale-ipn.exe',
  ],
  darwin: [process.env.TAILSCALE_GUI_PATH, '/Applications/Tailscale.app'],
  linux: [process.env.TAILSCALE_GUI_PATH],
}

/** 把行内注释里提到的"配置"收敛成带默认值的普通对象（本包刻意不依赖 schemastery）。 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const port = Number(source.httpsPort)
  return {
    enabled: source.enabled !== false,
    httpsPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 7259,
    connectOnStart: source.connectOnStart !== false,
    serveOnStart: source.serveOnStart !== false,
    teardownOnExit: source.teardownOnExit !== false,
    trustedHosts: source.trustedHosts !== false,
    binaryPath: typeof source.binaryPath === 'string' && source.binaryPath !== '' ? source.binaryPath : undefined,
    guiPath: typeof source.guiPath === 'string' && source.guiPath !== '' ? source.guiPath : undefined,
    // 等 backend 就绪的两段预算：先等 `tailscale up`，再等桌面客户端。
    readyTimeoutMs: Number.isFinite(source.readyTimeoutMs) && source.readyTimeoutMs >= 0 ? source.readyTimeoutMs : 8000,
    guiReadyTimeoutMs:
      Number.isFinite(source.guiReadyTimeoutMs) && source.guiReadyTimeoutMs >= 0 ? source.guiReadyTimeoutMs : 25000,
    stateFile: typeof source.stateFile === 'string' && source.stateFile !== '' ? source.stateFile : undefined,
    // 登录 cookie 的有效期（天）。DSH 默认 30 天，对「手机随时连」太短；
    // 这里直接改 connection 上那个活的 maxAgeMilliseconds，让种下的 cookie 长期有效。
    // 0 表示不动 DSH 的默认值。
    cookieMaxAgeDays:
      Number.isFinite(source.cookieMaxAgeDays) && source.cookieMaxAgeDays >= 0 ? source.cookieMaxAgeDays : 3650,
    // 是否注册一个「稳定登录入口」路由（/remote/<持久密钥>），让手机不用去翻令牌。
    loginRoute: source.loginRoute !== false,
    // 换密钥时是否**同时吊销所有已登录的会话**。
    //
    // 默认 true，因为换密钥的动机通常就是「密钥泄露了」：只换登录密钥的话，
    // 已经用泄露密钥登录过的人手里那张 10 年 cookie 依然有效。代价是所有设备
    // （含自己的手机）都要重新登录一次；点按钮的那台会被补发 cookie、不掉线。
    revokeSessionsOnRotate: source.revokeSessionsOnRotate !== false,
    // 精简模式（默认开）：HTTP 渲染出来的 index.html 只带手机真正需要的那部分客户端插件，
    // 首屏从约 5.3 MB gzip 降到约 1.3 MB。**桌面版不受影响**（它不经过这条路，见 lite.js 顶部）。
    //
    // 这里只是**默认值**：用户在设置页里切换过一次之后，以那个持久选择为准。
    lite: source.lite !== false,
    // 精简模式的种子包（不填就用 lite.js 里那份默认白名单）。
    // 只在「DSH 升级后默认白名单失配、又想自己补几个包」时才需要。
    liteSeeds: Array.isArray(source.liteSeeds) ? source.liteSeeds.filter((id) => typeof id === 'string') : undefined,
    // 精简页面上要藏掉的界面锚点（CSS 选择器）。不填就用 lite.js 的 LITE_HIDE。
    liteHide: Array.isArray(source.liteHide) ? source.liteHide.filter((s) => typeof s === 'string') : undefined,
    // 给 DSH 的 WebSocket（`/api/remote.mux`，会话历史走它）开 permessage-deflate。
    // 这是「手机拉会话历史慢」的主因：那条 WS 默认完全不压缩。
    websocketCompression: source.websocketCompression !== false,
  }
}

/**
 * 跑一条命令，收集 stdout/stderr，超时就杀掉。
 * 永不 reject —— 调用方永远拿到一个结果对象。
 */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // 刻意不用 AbortSignal.timeout()：它的定时器是 unref 的，关停阶段可能永远不触发。
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 进程可能已经没了 */
      }
      finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n[超时 ${String(timeoutMs)}ms]`.trim() })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ ok: code === 0, code: code ?? -1, stdout, stderr }))
  })
}

/** 探测可用的 tailscale 可执行文件；找不到返回 undefined。 */
async function resolveBinary(ctx, configured) {
  const candidates = [...(BINARY_CANDIDATES[process.platform] ?? ['tailscale'])]
  if (configured !== undefined) candidates.unshift(configured)
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    // 带路径分隔符的候选先做存在性检查，省一次进程启动。
    if (/[\\/]/.test(candidate) && !existsSync(candidate)) continue
    const result = await run(candidate, ['version'], 5000)
    if (result.ok) return candidate
  }
  return undefined
}

/** 解析 `tailscale status --json`；失败返回 undefined。 */
async function readStatus(binary) {
  const result = await run(binary, ['status', '--json'], 6000)
  if (!result.ok) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

/** 解析 `tailscale serve status --json`；失败返回 undefined（视为"无配置"）。 */
async function readServeStatus(binary) {
  const result = await run(binary, ['serve', 'status', '--json'], 6000)
  if (result.ok && result.stdout.trim() !== '') {
    try {
      return JSON.parse(result.stdout)
    } catch {
      return undefined
    }
  }
  // 没有 serve 配置时该命令可能以非零码退出，这里统一当作空配置。
  return undefined
}

/** `Self.DNSName` 带结尾点，去掉它才是可用的主机名。 */
function dnsNameOf(status) {
  const raw = status?.Self?.DNSName
  if (typeof raw !== 'string' || raw === '') return undefined
  return raw.replace(/\.$/, '').toLowerCase()
}

/** 探测桌面客户端路径；找不到返回 undefined。 */
function resolveGui(configured) {
  const candidates = [...(GUI_CANDIDATES[process.platform] ?? [])]
  if (typeof configured === 'string' && configured !== '') candidates.unshift(configured)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 启动桌面客户端。**刻意 detached + unref**：它是常驻托盘程序，不能因为 DSH
 * 退出就被带走（也不能让 DSH 因为它的 stdio 一直挂着不退出）。
 * @returns 是否成功发起启动（不代表 backend 已就绪）。
 */
function launchGui(target) {
  return new Promise((resolve) => {
    try {
      const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => resolve(false))
      child.unref()
      // 只要没有立刻报错就当作已发起；backend 是否起来由 waitForRunning 判定。
      setTimeout(() => resolve(true), 300)
    } catch {
      resolve(false)
    }
  })
}

/** backend 是否已经 Running。 */
async function isRunning(deps, binary) {
  const status = await deps.readStatus(binary)
  return status?.BackendState === 'Running'
}

/** 轮询等待 backend 变 Running；超时返回 false（绝不抛）。 */
async function waitForRunning(deps, binary, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isRunning(deps, binary)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * 确保 tailscale backend 真的在 Running —— **光看 `tailscale up` 的退出码是不够的**。
 *
 * 顺序：已经 Running 就直接成功 → `tailscale up` → 还不 Running 就拉起桌面客户端。
 * 每一步都用 `readStatus` 验证，而不是相信命令的退出码。
 * @returns true 表示 backend 确实 Running（此时才值得去配 Serve 路由）。
 */
async function ensureRunning(binary, config, deps, logger, undo) {
  if (await isRunning(deps, binary)) {
    logger.info('tailscale-remote: tailscale 本来就在运行，退出时不会把它断开')
    return true
  }
  if (!config.connectOnStart) {
    logger.warn('tailscale-remote: tailscale 未连接，且 connectOnStart=false，跳过')
    return false
  }

  logger.info('tailscale-remote: tailscale 未连接，执行 tailscale up')
  const up = await deps.run(binary, ['up'], SETUP_TIMEOUT_MS)
  if (!up.ok) {
    logger.warn(`tailscale-remote: tailscale up 失败: ${(up.stderr || up.stdout).trim().slice(0, 300)}`)
  }
  if (await waitForRunning(deps, binary, config.readyTimeoutMs)) {
    undo.startedTailscale = true
    return true
  }

  // Windows/macOS：`tailscale up` 在客户端被完全退出后会「exit 0 但什么都不做」，
  // 必须把桌面客户端拉起来才会真正初始化 backend。
  const gui = deps.resolveGui(config.guiPath)
  if (gui === undefined) {
    logger.warn(
      'tailscale-remote: tailscale up 没有生效（backend 仍不是 Running）。' +
        '请手动打开 Tailscale 客户端登录/连接，或设置 config.guiPath 指向它',
    )
    return false
  }
  logger.info(`tailscale-remote: tailscale up 未生效，改为启动桌面客户端 ${gui}`)
  const launched = await deps.launchGui(gui)
  if (!launched) {
    logger.warn(`tailscale-remote: 启动 ${gui} 失败`)
    return false
  }
  if (await waitForRunning(deps, binary, config.guiReadyTimeoutMs)) {
    logger.info('tailscale-remote: tailscale 已由桌面客户端拉起')
    undo.startedTailscale = true
    return true
  }
  logger.warn('tailscale-remote: 等不到 tailscale 进入 Running；请检查客户端是否需要登录')
  return false
}

/**
 * 判定 7259 端口上现有的 serve 路由与我们的目标是什么关系。
 * 只有"空着"或"本来就是指向我们的回环代理"才动手；其余一律视为冲突，不覆盖。
 */
function classifyServe(status, port, target) {
  const web = status?.Web
  const tcp = status?.TCP
  const authority = Object.keys(web ?? {}).find((key) => {
    try {
      return Number(new URL(`https://${key}`).port) === port
    } catch {
      return false
    }
  })
  if (authority === undefined) {
    const claimed = tcp !== undefined && Object.prototype.hasOwnProperty.call(tcp, String(port))
    if (claimed) return { kind: 'conflict', reason: `TCP ${String(port)} 已被其它 Tailscale Serve 配置占用` }
    return { kind: 'absent' }
  }
  const handlers = web?.[authority]?.Handlers
  if (handlers === null || typeof handlers !== 'object') {
    return { kind: 'conflict', reason: `${authority} 的 Serve 处理程序无法识别` }
  }
  const paths = Object.keys(handlers)
  if (paths.length !== 1 || paths[0] !== '/') {
    return { kind: 'conflict', reason: `${authority} 上还有其它路径处理程序（${paths.join(', ')}）` }
  }
  const proxy = handlers['/']?.Proxy
  if (typeof proxy !== 'string') return { kind: 'conflict', reason: `${authority} 的根处理程序不是反向代理` }
  // tailscale 写回的形态可能带尾斜杠；归一化后比较，否则会把自己的路由误判成陈旧路由，
  // 进而把它记成"本次新建"，退出时撤掉一条其实不是自己建的路由。
  const normalized = proxy.replace(/\/+$/, '')
  if (normalized === target) return { kind: 'exact', authority }
  // 指向另一个回环地址 = 上一次 DSH 换端口后留下的陈旧路由，可以接管。
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(normalized)) {
    return { kind: 'stale', authority, previousProxy: proxy }
  }
  return { kind: 'conflict', reason: `${authority} 已代理到 ${proxy}` }
}

/**
 * 解析 DSH home，与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 同一套优先级：
 * 显式配置 > `$DSH_HOME`（空/纯空白视为未设） > `~/.dsh`。
 *
 * 注意：**Host 进程的环境里通常没有 `DSH_HOME`**（那个变量是 shell 调用时才注入的），
 * 所以只读 `process.env.DSH_HOME` 会让状态文件永远写不出来。这里必须回落到 `~/.dsh`。
 */
function resolveDshHome(configured) {
  const fromConfig = typeof configured === 'string' && configured.trim() !== '' ? configured : undefined
  if (fromConfig !== undefined) return fromConfig
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 把当前远程地址写一份到磁盘，方便用户随时取用；失败只记日志。 */
async function persistState(ctx, state) {
  const home = resolveDshHome(process.env.DSH_HOME)
  const path = state.stateFile ?? join(home, 'tailscale-remote.json')
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (error) {
    ctx.logger.warn(`tailscale-remote: 写入 ${path} 失败：${String(error?.message ?? error)}`)
  }
}

/** 读回上一次的状态文件；不存在或坏了都返回 undefined（绝不抛）。 */
async function loadState(scope, config) {
  const home = resolveDshHome(process.env.DSH_HOME)
  const path = config.stateFile ?? join(home, 'tailscale-remote.json')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 取得（或首次生成）**跨重启稳定**的登录密钥。
 *
 * 为什么要它：DSH 的登录令牌是**进程级**的（`PROCESS_LAUNCH_TOKENS` 以 root ctx 为键），
 * 每次重启 DSH 都会换，用户根本没法记、也没法存成书签。这里自己生成一个持久随机密钥，
 * 存进状态文件，让「手机上的登录链接」永远不变。
 */
async function ensureLoginSecret(scope, config, deps) {
  const previous = await deps.loadState(scope, config)
  const existing = previous?.loginSecret
  if (typeof existing === 'string' && /^[A-Za-z0-9_-]{22,}$/.test(existing)) return existing
  return randomBytes(24).toString('base64url')
}

/** DSH 的浏览器会话 cookie 前缀（与 client-connection 的 `COOKIE_PREFIX` 一致）。 */
const COOKIE_PREFIX = 'dsh-auth-'

/** base64url 编码（与 DSH 内部实现逐字一致：+→-、/→_、去掉尾部 =）。 */
function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * 直接**铸造** DSH 的浏览器会话 cookie。
 *
 * 为什么要自己铸：DSH 正常流程是「带 `?token=` 访问 → 303 + Set-Cookie → 跳回 `/`」。
 * 这条链在手机浏览器上很脆（跨站跳转 + `SameSite=Strict`：从别的 App 点进来时，
 * 后续请求可能不带 cookie，于是又看到那句未授权提示）。自己铸就只要一跳：
 * `/remote/<密钥>` → 302 到 `/` **同时把 cookie 种下去**，而且可以用 `SameSite=Lax`。
 *
 * 格式必须和 `client-connection` 完全一致，否则 `isAuthenticated` 验不过：
 *   cookie 名 = `dsh-auth-` + base64url(sha256(authority))
 *   值       = `v1.` + base64url(JSON) + `.` + base64url(HMAC-SHA256(secret, base64url(JSON)))
 *   JSON     = { version: 1, authority, issuedAt, expiresAt }
 * @returns 铸好的 cookie；拿不到签名密钥时返回 undefined（调用方回落到令牌跳转）。
 */
function mintSessionCookie(connection, authority, maxAgeMilliseconds) {
  const secret = connection?.browserAuth?.secret
  if (!Buffer.isBuffer(secret) || secret.length === 0) return undefined
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeMilliseconds
  if (!Number.isSafeInteger(expiresAt)) return undefined
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  return {
    name: COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest()),
    value: `v1.${body}.${signature}`,
    maxAgeSeconds: Math.floor(maxAgeMilliseconds / 1000),
    expiresAt,
  }
}

/** 把铸好的 cookie 序列化成 `Set-Cookie` 头值。`SameSite=Lax` 是刻意的（见上）。 */
function sessionCookieHeader(minted) {
  return `${minted.name}=${minted.value}; Max-Age=${String(minted.maxAgeSeconds)}; Path=/; Expires=${new Date(minted.expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`
}

/**
 * 设置页那一行读的两个管理端点。
 *
 * 注册在 `connection.fetch` 上而**不是** `webServer.register`：`/api` 那条前缀路由
 * 上挂着 DSH 自己的 Host/Origin fence 与浏览器 cookie 鉴权（`connection.admit`），
 * 注册到 `connection.fetch` 等于白拿这套策略。反过来，用 `webServer.register` 建一条
 * exact 的 `/api/...` 会**抢先命中** `match()` 的 exact 表，把整条 `/api` 前缀路由遮掉。
 */
const STATE_PATH = '/api/dsh-tailscale-remote/state'
const ROTATE_PATH = '/api/dsh-tailscale-remote/rotate'
const LITE_PATH = '/api/dsh-tailscale-remote/lite'

/**
 * 惰性版：启动期**什么都不做**，只在手机的 WebSocket 真的开始握手时才付出代价。
 *
 * 为什么必须惰性：`require('ws')` 要从 `app.asar` 里读并编译，实测 **159 ms**。
 * 那笔钱花在 DSH 启动路径上就是「插件拖慢了启动」，而用户明确不许。所以这里只挂
 * 一个一次性钩子：等 `/api/remote.mux` 的第一条 upgrade 请求路过时，再在那条请求
 * 里做 patch（此时进程已经起来了，150 ms 落在手机那条连接上，不影响桌面）。
 *
 * 挂哪：`webServer.registerUpgrade` 拿不到（DSH 的 gateway 已经占了那个 path，重复
 * 注册会抛），所以改成监听 `http.Server` 的 `upgrade` 事件。`ws` 的 `noServer` 模式
 * 下，DSH 自己也是靠 `server.on('upgrade')` 把请求交给 `handleUpgrade` 的，所以我们的
 * listener 一定会先于/晚于它跑一次 —— 但只要在**同一个 tick 内** patch 好 prototype，
 * 同步执行的 `handleUpgrade` 就一定能看到新 options。
 *
 * 具体做法：`prependListener` 把一个**只做 patch、不消费请求**的 listener 插到最前，
 * 它就地把 prototype 换好，然后原样让事件继续流向 DSH 的 listener。
 * @param scope - 插件上下文。
 * @param config - 归一化配置。
 * @returns `{ armed }` 或 undefined（配置关掉时）。
 */
function armWebSocketCompression(scope, config) {
  if (!config.websocketCompression) return undefined
  return {
    armed: true,
    /**
     * 第一次握手时调用一次；之后是 no-op。
     * @returns 是否真的 patch 成功。
     */
    armOnce() {
      const result = installWebSocketCompression(scope, config)
      return result?.enabled === true
    },
  }
}

/**
 * 拿到 **DSH 自己用的那一个** `ws` 模块。
 *
 * 为什么不能 `createRequire(import.meta.url)('ws')`：实测在 DSH 运行时里那是
 * `MODULE_NOT_FOUND` —— profile 的 `node_modules` 里没有 `ws`，它在 `app.asar` 的
 * `dsh/node_modules` 下。而**只有**拿到同一个模块实例，对 prototype 的 patch 才会
 * 作用到 DSH 已经建好的那个 `WebSocketServer`（同一个对象，prototype 共享）。
 *
 * 做法：沿 DSH 的包路径找几个锚点，从那里 `createRequire` 解析。`app.asar` 里的
 * 路径对 Node 是普通路径（Electron 的 asar 层负责读），所以 `createRequire` 直接可用。
 *
 * 全部失败就返回 undefined（调用方静默跳过；不开压缩但功能完全正常）。
 * @returns `ws` 模块，或 undefined。
 */
function resolveHostWebSocket() {
  const anchors = []
  // 1) 最可靠：从**正在运行的那个 DSH 的 app 根**出发。宿主进程里 `process.execPath`
  //    指向 Electron/Node 可执行文件，`process.resourcesPath` 在 Electron 下就是
  //    resources 目录（asar 所在处）。
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    anchors.push(join(resources, 'app.asar', 'dsh', 'index.js'))
    anchors.push(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'index.js'))
  }
  // 2) 兜底：直接从本模块往上找 `@deepseek-ai/dsh-*`（有些部署是解包安装的）。
  anchors.push(import.meta.url)

  for (const anchor of anchors) {
    try {
      const ws = createRequire(anchor)('ws')
      if (ws?.WebSocketServer?.prototype !== undefined) return ws
    } catch {
      // 这个锚点不行，试下一个。
    }
  }
  return undefined
}

/**
 * 给 DSH 那条 WebSocket 打开 `permessage-deflate` 压缩。
 *
 * 这是「手机中途连接很慢」的最大一项：会话历史/事件全部走 `/api/remote.mux`，
 * 而 DSH 用 `new WebSocketServer({ noServer: true })` 建它，`ws` 的默认
 * `perMessageDeflate: false` 意味着**完全不压**。实测一个会话的界面只有约 12 KB
 * 文字，同一时刻这条 WS 的下行却有 22.5 MB —— 这些 JSON 高度重复，压缩率通常
 * 在 5–15 倍，对窄带手机是决定性的。
 *
 * 实现上只 patch `handleUpgrade`：`ws` 在它内部**同步**调用 `completeUpgrade()`，
 * 而后者用 `this.options` 构造 `WebSocket`，所以在这里把 `this.options.perMessageDeflate`
 * 打开一定生效，没有竞态。
 *
 * 为什么这个 patch 能作用到 DSH 已有的 mux：宿主进程里插件与 DSH 解析到的是同一个
 * `ws` 模块实例（实测严格相等），prototype 是共享的。
 *
 * 一切失败都**静默降级**（只是不开压缩，功能不变），绝不影响启动。
 * @param scope - 插件上下文（用来挂 disposer 与日志）。
 * @param config - 归一化配置（`websocketCompression` 关掉就完全不动）。
 * @returns `{ enabled }`；跳过时返回 undefined。
 */
function installWebSocketCompression(scope, config) {
  if (!config.websocketCompression) return undefined
  // 关键：**不能**从本模块位置解析 `ws` —— 实测在 DSH 运行时里那是 MODULE_NOT_FOUND
  // （profile 的 node_modules 里没有 `ws`，它在 app.asar 里）。必须借用 DSH 自己的
  // 模块图，见 resolveHostWebSocket。
  const ws = resolveHostWebSocket()
  if (ws === undefined) return undefined
  const proto = ws?.WebSocketServer?.prototype
  if (proto === undefined || typeof proto.handleUpgrade !== 'function') return undefined
  // 已经打过（重复加载）就别重复包。
  if (proto.handleUpgrade.__dshTailscaleRemotePatched === true) {
    return { enabled: true, alreadyPatched: true }
  }

  const original = proto.handleUpgrade
  const patched = function patchedHandleUpgrade(req, socket, head, callback) {
    // 只在**服务端**补齐默认值；`ws` 自己的构造函数会把 `true` 规范化成 `{}`。
    if (this.options !== undefined && this.options.perMessageDeflate === false) {
      this.options.perMessageDeflate = {
        // 阈值与窗口都取保守值：手机内存和 CPU 都有限，选太大的窗口反而拖慢首包。
        threshold: 1024,
        // 只压服务端 → 客户端的下行（会话事件几乎全在这个方向）；
        // 客户端 → 服务端的输入很小，压它只白白多花 CPU。
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      }
    }
    return original.call(this, req, socket, head, callback)
  }
  patched.__dshTailscaleRemotePatched = true
  proto.handleUpgrade = patched

  scope.effect(
    () => () => {
      // 拆插件时还原，避免留下一个已经没人负责的 patch。
      if (proto.handleUpgrade === patched) proto.handleUpgrade = original
    },
    'tailscale-remote: websocket compression',
  )
  scope.logger.info('tailscale-remote: 已为 DSH 的 WebSocket 开启 permessage-deflate（手机拉会话历史会快很多）')
  return { enabled: true }
}

/**
 * 精简模式：把 HTTP 渲染出来的那份页面裁小。
 *
 * 为什么整条路都挂在 `webServer` + `clientModules` 上，而不是改 DSH：DSH 的宿主半边
 * 每次渲染 index 都会重跑一遍注入表（`collectIndexInjections`），`__DSH_BOOT__` 是
 * 其中一行；本插件只加一个 `tapIndex` 变换，把**渲染结果**换掉，一行 DSH 代码都不动。
 *
 * 三个关键事实（都是读 DSH 源码 + 实测确认的，别凭直觉改）：
 *
 * 1. **桌面版走不到这条路。** Electron 直接读 dist 里的 index.html，再把
 *    `injections` 表经 IPC 交给客户端，客户端靠 `__DSH_TRANSPORT__.loadBundle`
 *    拉包。`tapIndex` 只参与 `webServer.renderIndex()`，而那只在
 *    `dsh-host-frontend-static` 的 HTTP 回退路径上发生。所以桌面端一个字节都不会变。
 *
 * 2. **必须自己服务精简合并请求。** 精简图的包名与整图不同，URL 自然也不同；
 *    `clientModules` 只按它自己那份整图的 URL 查表，认不出精简版 URL。于是本插件
 *    另外注册一条前缀路由（`LITE_ROUTE`），从 `clientModules.clientPath(id)` 拿路径
 *    再拼脚本。刻意用另一个前缀：`/plugins` 已经是 `client-modules` 的前缀路由，
 *    重复注册会抛。
 *
 * 3. **`client-hmr` 不能留。** 它是唯一会通过 `/plugins/events` 把**完整**插件图推回
 *    页面的插件；留着的话客户端立刻把裁掉的包全部重新拉一遍，精简白做。它不在种子
 *    白名单里，闭包也不会带上它（没有任何保留包 inject 它）。已实测：精简集里没有第二个
 *    会触发图同步的包。
 */
function createLiteController(scope, config, runtime) {
  const webServer = scope.get('webServer', false)
  const clientModules = scope.get('clientModules', false)
  if (webServer === undefined || clientModules === undefined) {
    // 桌面版的 web-runtime 组合里有 webServer；拿不到就静默放弃精简，页面照旧。
    return undefined
  }

  const logger = scope.logger
  /** 内核字节缓存：包名 → Buffer。合并请求每次都会重新拼，但读盘只读一次。 */
  const bundleCache = new Map()
  /** 压好的合并正文缓存：`包名+rev+编码` → `{ body, encoding, rawBytes }`。 */
  const comboCache = new Map()

  /**
   * 用**当前**的整图重算一次精简图。
   *
   * 刻意每次渲染 index 时都重算：插件图会随 Loader 装配而变（`onGraphChanged`），
   * 缓存住会让「先渲染、后装配」的时序下发出一个缺包的页面。代价是每次 index 请求
   * 求一次闭包 —— 那是几十个字符串的集合运算，可忽略。
   */
  const currentLite = () => {
    const full = clientModules.graph()
    return composeLiteGraph(full, {
      ...(config.liteSeeds === undefined ? {} : { seeds: config.liteSeeds }),
    })
  }

  /** 读一个包的内核字节；读不到就返回 undefined（调用方回 404，让客户端自己回落单包 URL）。 */
  const readBundle = async (id) => {
    const cached = bundleCache.get(id)
    if (cached !== undefined) return cached
    const path = clientModules.clientPath(id)
    if (typeof path !== 'string') return undefined
    try {
      const bytes = await readFile(path)
      bundleCache.set(id, bytes)
      return bytes
    } catch {
      return undefined
    }
  }

  /**
   * 把一个合并请求的正文压好并缓存。
   *
   * 缓存键是「包名 + 各自的 rev + 协商到的编码」：rev 变了 URL 就变了，所以旧条目
   * 永远不会被错误命中，也就不需要失效逻辑。缓存值同时记住未压缩大小，方便状态端点
   * 报出真实节省。
   *
   * 为什么缓存：brotli q5 压这 5 MB 要约 0.1–0.5 s。不缓存的话每次刷新手机都要等
   * 这段时间；缓存之后只有第一次付出。
   * @param ids - 该段的包名（有序）。
   * @param buffers - 与之对应的原始字节。
   * @param acceptEncoding - 客户端的 `Accept-Encoding`。
   * @returns `{ body, encoding }`。
   */
  const encodeCombo = async (ids, buffers, acceptEncoding) => {
    const key = `${ids.join(',')}|${String(acceptEncoding ?? '')}`
    const cached = comboCache.get(key)
    if (cached !== undefined) return cached
    const raw = composeComboBody(buffers)
    const encoded = encodeComboBody(raw, acceptEncoding)
    const record = { ...encoded, rawBytes: raw.length }
    comboCache.set(key, record)
    return record
  }

  /** 精简合并请求：`<路由>/??<包名>/client.js,...&rev=<rev>`。 */
  const serveLiteBundle = async (req, res) => {
    const url = req.url ?? '/'
    const batch = matchLiteRequest(url, currentLite())
    if (batch === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const buffers = []
    for (const id of batch.entries) {
      const bytes = await readBundle(id)
      if (bytes === undefined) {
        // 少一个包就整段不成 —— 合并脚本里缺一个包会让紧随其后的包也注册失败，
        // 客户端还得逐包重试。直接 404，让它走 client-modules 的单包 URL。
        logger.warn(`tailscale-remote: 精简请求读不到 ${id} 的客户端包，回 404`)
        res.writeHead(404)
        res.end()
        return
      }
      buffers.push(bytes)
    }
    // 正文自己压：webserver 的 gzip 是 level 1（实测 1,295,803 B），而同一份字节用
    // brotli q5 只要约 880 KB、gzip level 6 要 1,062,672 B。手机走 tailnet 时这是
    // 实打实的省流量和省时间，所以这里自己压并把结果缓存住（只算一次，不是每请求）。
    const encoded = await encodeCombo(batch.entries, buffers, req.headers['accept-encoding'])
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      // 与 client-modules 自己的合并请求同口径：rev 变了 URL 就变，所以可以长期缓存。
      'cache-control': 'public, max-age=31536000, immutable',
      ...(encoded.encoding === undefined ? {} : { 'content-encoding': encoded.encoding }),
      // 别让 webserver 的 compression 再套一层（它会看 Content-Encoding 跳过）。
      vary: 'Accept-Encoding',
    })
    res.end(req.method === 'HEAD' ? undefined : encoded.body)
  }

  // 让 DSH 那条 WebSocket（`/api/remote.mux`）**开启压缩**。
  //
  // 这是「手机上载入会话历史很慢、甚至载不出来」的真正主因：会话历史不走 HTTP，
  // 走的是这条 WS；而 DSH 建 mux 时用的是 `new WebSocketServer({ noServer: true })`，
  // `ws` 的默认值是 `perMessageDeflate: false` —— 实测握手响应里**根本没有**
  // `sec-websocket-extensions`，也就是说那几十 MB 的会话事件是**明文 JSON**过的。
  // 一个真实会话的 `bodyLen` 约 12 KB 的界面，背后收进了 22.5 MB 的下行文本。
  //
  // 做法：patch `ws.WebSocketServer.prototype.handleUpgrade`，让它在读完握手头之后、
  // 真正建 socket 之前把 `this.options.perMessageDeflate` 打开。为什么在这个位置：
  // `completeUpgrade()` 是**同步**用 `this.options` 构造 `WebSocket` 的，所以在
  // `handleUpgrade` 里改 `this.options` 一定生效（没有竞态）。
  //
  // 为什么能拿到同一个 `ws`：宿主进程里 DSH 与插件解析到的是**同一个**模块实例
  // （实测两次 `require('ws')` 严格相等），所以 prototype 上的改动对 DSH 自己已经
  // 建好的那个 mux 也生效 —— 不用重建、不用重启、不碰 DSH 一行代码。
  //
  // 风险控制：拿不到 `ws`、或 prototype 已经不是预期形状，就**静默跳过**（只是没开
  // 压缩，功能完全不受影响）；绝不因为这条路失败而影响启动。
  //
  // **惰性**：这里只是登记一个「等第一条握手路过时再动手」的钩子，启动期**不**
  // `require('ws')`（实测那次 require 要 159 ms，会让桌面端启动变慢）。真正的 patch
  // 发生在下一次 WS 握手时，那一次握手本身要几毫秒，多出来的代价放在手机上、
  // 而不是你的启动路径上。见 armWebSocketCompression。
  let websocketPatch = armWebSocketCompression(scope, config)

  // 惰性触发器：等第一条 WS upgrade 路过时，就地把 `ws` 的 handleUpgrade patch 好。
  //
  // `prependListener` + 不消费事件 = 只观察不干预：DSH 自己那个 listener 照常收到
  // 事件、照常完成握手。patch 必须在同一次 `emit('upgrade')` 的同步链里完成，因为
  // `ws` 的 `handleUpgrade` 也是同步读 `this.options` 的 —— prepend 保证了顺序。
  //
  // 每一步失败都吞掉：压缩没开不影响任何功能，但绝不能让一条 upgrade 因为我们的
  // hook 抛错而断掉（那会让手机连不上）。
  if (websocketPatch !== undefined) {
    const raw = webServer.server
    if (raw !== undefined && typeof raw.prependListener === 'function') {
      const onUpgrade = () => {
        try {
          websocketPatch.armOnce()
        } catch (error) {
          scope.logger.warn(`tailscale-remote: 开启 WebSocket 压缩失败（不影响使用）：${error?.message ?? error}`)
        } finally {
          // 一次性：patch 之后再没有意义，摘掉避免每次握手都走一遍。
          raw.removeListener('upgrade', onUpgrade)
        }
      }
      raw.prependListener('upgrade', onUpgrade)
      scope.effect(
        () => () => {
          try {
            raw.removeListener('upgrade', onUpgrade)
          } catch {
            /* 拆插件时 server 可能已经关了，无所谓 */
          }
        },
        'tailscale-remote: websocket compression trigger',
      )
    } else {
      // 拿不到底层 server（未来的 DSH 改了装配方式）：退回启动期直接 patch。
      // 这条退路会让启动慢 159 ms，所以只在真拿不到时走。
      websocketPatch = installWebSocketCompression(scope, config)
    }
  }

  // index 改写。**只碰渲染结果**，不碰 DSH 的任何服务状态。
  // 改写只在「精简开着」且真的算出了精简图时发生；任何一步失败都原样返回完整页面。
  scope.effect(
    () =>
      webServer.tapIndex((html) => {
        if (!liteEnabled()) return html
        const lite = currentLite()
        if (lite === undefined) {
          // 白名单在活图上失配（多半是 DSH 升级拆/改了包）。**宁可多发几 MB，也不能
          // 发一个残缺页面** —— 手机上用户没有任何自救手段。只记一次日志，别刷屏。
          warnLiteUnavailable('seed-mismatch')
          return html
        }
        const result = rewriteIndex(html, { lite, hide: config.liteHide ?? LITE_HIDE })
        if (!result.changed) {
          warnLiteUnavailable(result.reason)
          return html
        }
        runtime.lite = {
          ids: lite.ids,
          removed: result.removed,
          preloads: result.preloads,
          // 压缩是**惰性**挂上的：这里只报「有没有武装」，不触发它。
          compress: websocketPatch === undefined ? undefined : 'websocket',
          rawBytes: comboCache.get([...comboCache.keys()][0])?.rawBytes,
          wireBytes: [...comboCache.values()][0]?.body?.length,
        }
        return result.html
      }),
    'tailscale-remote: lite index',
  )

  // 精简合并请求的投递路由。
  //
  // 为什么不复用 `clientModules.fetchBundle`：它按**整图**的 URL 查表，认不出精简图的
  // URL（精简图的合并 URL 里包名更少、rev 也不同）。所以这里自己拼：包路径从
  // `clientModules.clientPath(id)` 拿（那是 DSH 的公开读接口），字节从盘上读。
  scope.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: LITE_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return undefined
          }
          // 必须把 promise 交回给 webserver：它 `await route.handler(...)`，
          // 丢掉的话请求会在 body 写出来之前就被当成处理完毕。
          return serveLiteBundle(req, res).catch((error) => {
            logger.warn(`tailscale-remote: 精简请求处理失败：${String(error?.message ?? error)}`)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end()
            }
          })
        },
      }),
    'tailscale-remote: lite bundle route',
  )

  /** 只记一次同类日志，别在每个 index 请求上刷屏。 */
  let lastWarn
  const warnLiteUnavailable = (reason) => {
    if (lastWarn === reason) return
    lastWarn = reason
    logger.warn(`tailscale-remote: 这一轮不精简页面（${String(reason)}），改发完整页面`)
  }

  /**
   * 精简开关。
   *
   * 两层，顺序不能反：
   *  1. `config.lite` 是**硬开关** —— 关掉就意味着这台实例不做这件事，用户的选择也翻不过来。
   *     否则「配置里关了」会被「用户点过开启」压过去，那个配置项就成了谎话。
   *  2. 在配置允许的前提下，用户的**持久选择**（`runtime.liteChoice`）优先于配置的默认值
   *     —— 否则用户点了关闭、刷新页面又变回精简，看起来像按钮坏了。
   * @returns 是否把页面裁小。
   */
  function liteEnabled() {
    if (!config.lite) return false
    return runtime.liteChoice ?? true
  }

  return { liteEnabled, currentLite, serveLiteBundle }
}

/**
 * DSH 浏览器会话 cookie 的签名密钥在 credentials 里的记录键。
 *
 * 值是 `credentialKey('client-connection', 'browser-session')` —— 那个 helper 只是
 * `brandString(`${scope}/${id}`)`（`@deepseek-ai/dsh-credentials` 的 types），所以
 * 运行时就是这条普通字符串。**必须逐字一致**：写错键会静默写到另一条记录上，
 * 于是重启后旧密钥照旧生效、旧 cookie 继续能用 —— 换了个寂寞而且毫无提示。
 */
const AUTH_RECORD_KEY = 'client-connection/browser-session'
/** 会话密钥长度（字节），与 client-connection 的 `SECRET_BYTES` 一致，否则它拒绝加载。 */
const SESSION_SECRET_BYTES = 32
/** 记录格式版本，与 `STORED_SECRET_VERSION` 一致。 */
const STORED_SECRET_VERSION = 1

/** 从请求头取规范化的 authority（cookie 名与签名受众都用它）。 */
function hostAuthority(headers) {
  const host = headers?.get?.('host')
  if (typeof host !== 'string' || host === '') return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

/**
 * 换掉 DSH 浏览器会话 cookie 的签名密钥，从而**立刻吊销所有已登录的会话**。
 *
 * 为什么换密钥必须连这一步一起做：登录链接（`/remote/<密钥>`）只负责**换取**一张
 * 会话 cookie。密钥泄露后，如果对方已经用它登录过，他手里那张 cookie 是用
 * `browserAuth.secret` 签名的、**有效期 10 年**，换登录密钥完全不影响它。
 * 要让泄露的密钥真正失效，签名密钥也得换。
 *
 * 两处都要改，缺一不可：
 *  1. credentials 记录（**持久**）—— 否则 DSH 一重启就把旧密钥读回来，旧 cookie 复活。
 *  2. 活着的 `browserAuth.secret`（**立即生效**）—— 它按引用比较签名，改了就当场失效。
 * @param scope - 带 `connection` / `credentials` 的上下文。
 * @returns 新的密钥字节。
 * @throws 服务缺席、或写入没有真正落到那条记录上时（绝不假装成功）。
 */
async function rotateSessionSecret(scope) {
  const credentials = scope.get('credentials', false)
  if (credentials === undefined || typeof credentials.modifyRecord !== 'function') {
    throw new Error('读不到 credentials 服务，无法吊销已登录的会话')
  }
  const connection = scope.get('connection', false)
  if (connection?.browserAuth === undefined) {
    throw new Error('读不到 connection.browserAuth，无法吊销已登录的会话')
  }

  const secret = randomBytes(SESSION_SECRET_BYTES).toString('base64url')
  const written = await credentials.modifyRecord(AUTH_RECORD_KEY, () =>
    Promise.resolve({
      kind: 'grant',
      payload: { version: STORED_SECRET_VERSION, secret },
    }),
  )

  // 回读确认。写错键、或被只读来源遮蔽时，`modifyRecord` 会**成功返回**但记录没变，
  // 于是这里不校验的话就是「报成功、实则没换」——重启后旧 cookie 复活。
  if (written?.payload?.secret !== secret) {
    throw new Error('会话密钥没有写入成功（credentials 记录未更新）')
  }

  connection.browserAuth.secret = Buffer.from(secret, 'base64url')
  return connection.browserAuth.secret
}

/**
 * 组装管理端点要返回的状态。
 *
 * 刻意**不抛**：「还在启动」「起不来」都是设置页要看的正常答案，不是错误响应。
 * @param config - 归一化后的配置。
 * @param runtime - 本次运行的活状态（见 `apply`）。
 */
function statePayload(config, runtime) {
  const state = runtime.state
  return {
    ok: true,
    enabled: config.enabled,
    phase: runtime.phase,
    error: runtime.error ?? null,
    // 只有「已就绪」才谈得上换密钥：换密钥要写回状态文件并重建登录路由。
    canRotate: config.enabled && config.loginRoute && runtime.phase === 'ready',
    // 换密钥会不会把所有设备踢下线（客户端据此决定警告文案的强度）。
    revokesSessions: config.enabled && config.loginRoute && config.revokeSessionsOnRotate,
    plainUrl: state?.plainUrl ?? null,
    loginUrl: state?.loginUrl ?? null,
    authority: state?.authority ?? null,
    dnsName: state?.dnsName ?? null,
    httpsPort: state?.httpsPort ?? config.httpsPort,
    cookieMaxAgeDays: state?.cookieMaxAgeDays ?? config.cookieMaxAgeDays,
    updatedAt: state?.updatedAt ?? null,
    // 精简模式状态。`lite` 说的是**这份页面真的被裁了没有**（控制器已算出精简图并改写成功），
    // `liteChoice` 说的是**用户选了什么**；两者在切换后、重载前会不一致，所以分开报。
    lite: runtime.liteController === undefined ? null : runtime.liteController.liteEnabled(),
    liteAvailable: runtime.liteController !== undefined,
    liteChoice: runtime.liteChoice ?? null,
    liteDefault: config.lite,
    liteCount: runtime.lite?.ids?.length ?? null,
    litePreloadRemoved: runtime.lite?.removed ?? null,
  }
}

/**
 * 注册（或换成）登录入口路由。
 *
 * 换密钥时**必须先撤掉旧的**：路由表按 `(kind, path)` 去重，路径变了不会报冲突，
 * 于是旧链接会继续可用 —— 那会让「换完之后旧链接立刻失效」变成谎话。
 * @param runtime - 活状态；`webScope` 缺席时什么都不做。
 * @param connection - `connection` 服务（取签名密钥用）。
 * @param config - 归一化后的配置。
 * @param authority - `<dnsName>:<httpsPort>`。
 * @param secret - 要用的密钥。
 * @returns 新路径；装不上时返回 undefined。
 */
function installLoginRoute(runtime, connection, config, authority, secret) {
  const webScope = runtime.webScope
  if (webScope === undefined) return undefined
  const webServer = webScope.get('webServer')
  if (webServer === undefined) return undefined

  runtime.login?.dispose?.()
  runtime.login = undefined

  const path = `/remote/${secret}`
  const dispose = webScope.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          // 首选：自己铸 cookie，一跳到位（见 mintSessionCookie 的说明）。
          const minted = mintSessionCookie(connection, authority, config.cookieMaxAgeDays * 86400000)
          if (minted !== undefined) {
            res.writeHead(302, {
              location: `https://${authority}/`,
              'set-cookie': sessionCookieHeader(minted),
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            res.end()
            return
          }
          // 回落：拿不到签名密钥时走 DSH 自己的令牌链。
          res.writeHead(302, {
            location: runtime.handoffUrl ?? `https://${authority}/`,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end()
        },
      }),
    'tailscale-remote: login route',
  )

  runtime.login = { secret, path, dispose }
  return path
}

/**
 * 换一个新密钥：换登录密钥 → 吊销所有会话 → 装上新路由 → 写回状态文件 → 更新活状态。
 *
 * 吊销会话是**有意的**：登录密钥泄露后，对方可能已经用它换到一张 10 年有效的会话
 * cookie；只换登录密钥的话他照样在里面。代价是**所有设备都要重新登录一次**，
 * 包括你自己的手机 —— 这正是「密钥泄露」时该有的行为。
 *
 * 例外：**发起这次更换的那个浏览器会被补发一张新 cookie**，所以它自己不会掉线。
 * 也就是说「在你电脑上点更换」= 电脑留着、其它设备全部踢掉。
 * @param scope - 带 `connection` 的上下文。
 * @param config - 归一化后的配置。
 * @param runtime - 活状态。
 * @param deps - 依赖注入（测试替换用）。
 * @param requestingAuthority - 发起请求的那个 authority（用它给当前浏览器补发 cookie）。
 * @returns `{ loginUrl, loginPath, updatedAt, revokesSessions, stayedSignedIn }`。
 * @throws 未就绪 / 登录入口已关闭 / webServer 或 credentials 不可用时。
 */
async function rotateLoginSecret(scope, config, runtime, deps = REAL_DEPS, requestingAuthority) {
  if (!config.loginRoute) throw new Error('登录入口已关闭（loginRoute=false），没有可更换的密钥')
  const state = runtime.state
  if (state === undefined) throw new Error('远程访问还没就绪，稍后再试')

  const connection = scope.get('connection', false)

  // 先吊销会话，再装新路由：反过来的话，若吊销失败就已经把新密钥写出去了，
  // 用户会以为换成功了，而泄露的那张 cookie 还活着。
  if (config.revokeSessionsOnRotate) await rotateSessionSecret(scope)

  const secret = randomBytes(24).toString('base64url')
  const loginPath = installLoginRoute(runtime, connection, config, state.authority, secret)
  if (loginPath === undefined) throw new Error('webServer 不可用，换不了密钥')

  const loginUrl = `https://${state.authority}${loginPath}`
  let handoffUrl = state.plainUrl
  try {
    handoffUrl = connection?.authenticatedUrl?.(state.plainUrl) ?? state.plainUrl
  } catch {
    handoffUrl = state.plainUrl
  }

  const next = {
    ...state,
    url: handoffUrl,
    loginUrl,
    loginPath,
    loginSecret: secret,
    updatedAt: new Date().toISOString(),
  }
  await deps.persistState(scope, next)
  runtime.state = next
  runtime.handoffUrl = handoffUrl
  if (runtime.undo !== undefined) runtime.undo.loginPath = loginPath

  // 给**发起请求的那个 authority** 补一张新 cookie，让点按钮的这台设备不掉线。
  // 只能补这一个：cookie 按 authority 命名并签名，给别的 authority 种的 cookie
  // 浏览器会直接忽略。
  let stayedSignedIn = false
  if (config.revokeSessionsOnRotate && typeof requestingAuthority === 'string' && requestingAuthority !== '') {
    const minted = mintSessionCookie(connection, requestingAuthority, config.cookieMaxAgeDays * 86400000)
    if (minted !== undefined) stayedSignedIn = true
    return {
      loginUrl,
      loginPath,
      updatedAt: next.updatedAt,
      revokesSessions: true,
      stayedSignedIn,
      cookie: minted === undefined ? null : sessionCookieHeader(minted),
    }
  }

  return { loginUrl, loginPath, updatedAt: next.updatedAt, revokesSessions: config.revokeSessionsOnRotate, stayedSignedIn }
}

/**
 * 注册管理端点。
 *
 * 即便 `enabled=false` 也注册：设置页那一行要能回答「为什么没起来」，
 * 而不是只能看到一个 404。
 * @param scope - 带 `connection` 的上下文。
 * @param config - 归一化后的配置。
 * @param runtime - 活状态。
 */
function registerAdminRoutes(scope, config, runtime, deps = REAL_DEPS) {
  const connection = scope.get('connection', false)
  const routes = connection?.fetch
  if (routes === undefined) return

  const json = (payload, status = 200, extraHeaders) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(extraHeaders ?? {}),
      },
    })

  // 每条路由都显式挂在自己的 effect 上。
  //
  // `connection.fetch.register` 内部**确实**会用「读服务的那个 ctx」调 `owner.effect`，
  // 但那个 ctx 来自 cordis 的服务代理在调用点绑定 —— 与其依赖这条链路，不如自己
  // 明确声明生命周期：`scope.effect(() => routes.register(...))` 拿返回的 disposer
  // 作为清理函数，插件卸载时路由一定跟着走，不多不少。
  scope.effect(
    () =>
      routes.register({
        path: STATE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(json(statePayload(config, runtime))),
      }),
    'tailscale-remote: state route',
  )

  scope.effect(
    () =>
      routes.register({
        path: ROTATE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const result = await rotateLoginSecret(scope, config, runtime, deps, hostAuthority(request?.headers))
            // 补发的 cookie 必须由 HTTP 响应带走；放在 body 里没用。
            const cookie = typeof result.cookie === 'string' ? { 'set-cookie': result.cookie } : undefined
            const { cookie: _omitted, ...payload } = result
            return json({ ok: true, ...payload }, 200, cookie)
          } catch (error) {
            return json({ ok: false, error: String(error?.message ?? error) }, 409)
          }
        },
      }),
    'tailscale-remote: rotate route',
  )

  // 切换精简模式。
  //
  // 为什么要走服务端而不是客户端存 localStorage：这个开关决定的是**宿主下一次渲染
  // index 时发哪一版页面** —— 它必须让宿主知道，不能只存在浏览器里。写进状态文件
  // 才能跨重启保留，也让手机和电脑看到同一个选择（用户可能从任意一端切）。
  scope.effect(
    () =>
      routes.register({
        path: LITE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json().catch(() => undefined)
            const enabled = body?.enabled
            if (typeof enabled !== 'boolean') {
              return json({ ok: false, error: '缺少 enabled（布尔值）' }, 400)
            }
            const controller = runtime.liteController
            if (controller === undefined) {
              return json({ ok: false, error: '这条 DSH 上没有 Web 渲染路径，精简模式不可用' }, 409)
            }
            runtime.liteChoice = enabled
            // 立刻写盘：用户切完通常马上刷新页面，重启后也得记住。
            // 失败**不算失败**：这次切换在本次运行里已经生效，只是下次重启会回默认值。
            //
            // `deps` 必须一路透传到这里：这个函数写的是**真实的** `~/.dsh/tailscale-remote.json`，
            // 而单测会调这条路由。测试若不替换 deps，就会把用户的持久登录密钥覆盖掉
            // —— 下一次重启长出**新**密钥，手机上的书签当场失效。（这个坑真的踩过一次。）
            const warning = await persistLiteChoice(scope, config, runtime, enabled, deps)
            return json({ ok: true, lite: controller.liteEnabled(), ...(warning === undefined ? {} : { warning }) })
          } catch (error) {
            return json({ ok: false, error: String(error?.message ?? error) }, 409)
          }
        },
      }),
    'tailscale-remote: lite route',
  )
}

/**
 * 把精简开关的选择写进状态文件。
 *
 * 只在**已有状态文件**上改：没有的话（远程访问还没起来）就别凭空造一个，
 * 那会写出一份缺 `authority` 的半截记录。
 * @param deps - 依赖注入；测试必须替换掉它，否则会写真实的 `~/.dsh/tailscale-remote.json`。
 * @returns 写失败时的提示文案；成功或无需写时返回 undefined（绝不抛）。
 */
async function persistLiteChoice(scope, config, runtime, enabled, deps = REAL_DEPS) {
  const state = runtime.state
  if (state === undefined) return undefined
  const next = { ...state, lite: enabled, updatedAt: new Date().toISOString() }
  try {
    await deps.persistState(scope, next)
    runtime.state = next
    return undefined
  } catch (error) {
    return `选择已生效，但没能写进状态文件（下次重启可能回默认值）：${String(error?.message ?? error)}`
  }
}

/**
 * 本次运行的活状态。
 *
 * 设置页那一行要能回答「现在到哪一步了」，而 `setup` 的返回值只够写日志；
 * 这里把阶段、错误、状态快照和已装的登录路由都挂在一个对象上，`apply` 建一次、
 * `setup` 往里写、管理端点读。
 * @param undo - 本次运行的回滚清单（换密钥时要更新它的 loginPath）。
 */
function freshRuntime(undo) {
  return {
    phase: 'starting',
    error: undefined,
    /** 最近一次写盘的状态快照（见 `setup` 末尾）。 */
    state: undefined,
    /** 登录入口落地的那个 webServer 作用域；换密钥时复用它。 */
    webScope: undefined,
    /** 当前登录路由 `{ secret, path, dispose }`；换密钥时先撤掉它。 */
    login: undefined,
    /** 回落跳转用的带令牌地址。 */
    handoffUrl: undefined,
    /**
     * 用户对精简模式的**持久选择**（写进状态文件，跨重启保留）。
     * undefined = 从没选过，这时用配置里的默认值。
     */
    liteChoice: undefined,
    /** 最近一次改写 index 的结果 `{ ids, removed, preloads }`；只用于状态端点观察。 */
    lite: undefined,
    /** `createLiteController` 的产物；桌面端没有 webServer/clientModules 时为 undefined。 */
    liteController: undefined,
    undo,
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} rawConfig - 该行声明的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  // connection 是可选依赖：服务晚到也会触发，永不出现则保持静默。
  // 服务只从 scope 参数上取（inject 新建的 fiber 的 store 里才有它）。
  ctx.inject(['connection'], (scope) => {
    if (scope.get('connection') === undefined) return

    /** 本次运行真正做过的副作用，退出时按这个清单回滚。 */
    const undo = {
      /** 我们 push 进 trustedHosts 的那一项。 */
      trustedHost: undefined,
      /** 7259 路由是不是我们建的（本来就在就留着，不动）。 */
      createdRoute: false,
      /** tailscale 是不是我们拉起来的（本来 Running 就不 down）。 */
      startedTailscale: false,
      /** 启动阶段探测到的可执行文件，退出时直接复用——关停预算里再探一次就超时了。 */
      binary: undefined,
      /** 注册的登录入口路径（fiber 拆除时路由会跟着注销，这里只作记录）。 */
      loginPath: undefined,
      disposed: false,
    }
    const runtime = freshRuntime(undo)

    // 管理端点**即便 enabled=false 也注册**：设置页那一行要能回答「为什么没起来」，
    // 而不是只能看到一个 404。客户端半边是独立声明的，禁用时照样会加载并渲染这一行。
    if (!config.enabled) {
      runtime.phase = 'disabled'
      ctx.logger.info('tailscale-remote: enabled=false，只提供设置页状态，不动作')
      registerAdminRoutes(scope, config, runtime)
      return
    }

    registerAdminRoutes(scope, config, runtime)

    // 精简模式的装配。
    //
    // 单独一段嵌套 inject：`webServer` / `clientModules` 与 `connection` 的到达顺序没有
    // 保证，只声明 `connection` 时这两个可能还没到。服务迟到也要装上，所以走 inject
    // 而不是在这里一次性读（晚到会被 `ctx.get(..., false)` 静默跳过，精简就永远不生效）。
    //
    // 桌面版拿不到 `webServer`（那条渲染路径在 Electron 里），此时什么都不做 ——
    // 这正是「桌面端一个字节都不动」的落点。
    scope.inject(['webServer', 'clientModules'], (liteScope) => {
      runtime.liteController = createLiteController(liteScope, config, runtime)
      if (runtime.liteController !== undefined) {
        ctx.logger.info('tailscale-remote: 精简模式已装配（只作用于 HTTP 渲染的页面，桌面端不受影响）')
      }
    })

    // 退出清理挂在这里：这是唯一可靠的关停挂点，且 disposer 绝不能 reject。
    scope.effect(() => async () => {
      if (undo.disposed) return
      undo.disposed = true
      if (!config.teardownOnExit) return
      // 关停预算很紧：全部吞掉异常，绝不让 disposer reject（会变成 AggregateError）。
      await Promise.allSettled([teardown(scope, config, undo)])
    }, 'tailscale-remote: teardown')

    // 启动流程异步跑，不阻塞 Loader 装配。
    setup(scope, config, undo, REAL_DEPS, runtime).catch((error) => {
      runtime.phase = 'error'
      runtime.error = String(error?.message ?? error)
      scope.logger.warn(`tailscale-remote: 启动失败：${runtime.error}`)
    })
  })
}

/** 真实依赖；测试通过 `deps` 参数替换它们，生产路径永远用这一份。 */
const REAL_DEPS = {
  run,
  resolveBinary,
  readStatus,
  readServeStatus,
  waitForPort,
  persistState,
  loadState,
  ensureLoginSecret,
  announce,
  launchGui,
  resolveGui,
}

/** 启动：拉起 tailscale → 建 serve 路由 → 信任该 authority → 打印手机可用的链接。 */
async function setup(scope, config, undo, deps = REAL_DEPS, runtime = freshRuntime(undo)) {
  const logger = scope.logger
  runtime.undo = undo
  runtime.phase = 'starting'
  runtime.error = undefined

  // 读回用户上次对精简模式的选择。读不到（首次运行 / 文件坏了）就保持 undefined，
  // 由 `liteEnabled()` 回落配置默认值 —— 一条读失败的记录不该把默认行为改掉。
  if (config.lite) {
    const previous = await deps.loadState(scope, config)
    if (typeof previous?.lite === 'boolean') {
      runtime.liteChoice = previous.lite
      logger.info(`tailscale-remote: 读回精简模式选择 = ${String(previous.lite)}`)
    }
  }

  const binary = await deps.resolveBinary(scope, config.binaryPath)
  if (binary === undefined) {
    runtime.phase = 'unavailable'
    runtime.error = '找不到 tailscale 可执行文件'
    logger.warn('tailscale-remote: 找不到 tailscale 可执行文件；请安装 Tailscale 或用 config.binaryPath 指定路径')
    return
  }
  // 记下来给退出阶段复用：关停时只有几秒预算，不能再跑一轮 `tailscale version` 探测。
  undo.binary = binary

  let status = await deps.readStatus(binary)
  const wasRunning = status?.BackendState === 'Running'

  // 关键：必须验证 backend 真的 Running，不能只信 `tailscale up` 的退出码
  // （Windows 上客户端被完全退出时，up 会 exit 0 但什么都不做）。
  const running = await ensureRunning(binary, config, deps, logger, undo)
  if (!running) {
    runtime.phase = 'unavailable'
    runtime.error = 'tailscale 没在运行'
    return
  }
  if (!wasRunning) status = await deps.readStatus(binary)

  const dnsName = dnsNameOf(status)
  if (dnsName === undefined) {
    runtime.phase = 'unavailable'
    runtime.error = '读不到 tailnet DNS 名称'
    logger.warn('tailscale-remote: 读不到 tailnet DNS 名称，跳过 Serve 配置')
    return
  }

  // DSH 自己的 Web 端口从服务上读，绝不写死。
  const port = await deps.waitForPort(scope)
  if (port === undefined) {
    runtime.phase = 'unavailable'
    runtime.error = '等不到 DSH Web 端口'
    logger.warn('tailscale-remote: 等不到 DSH Web 端口，跳过 Serve 配置')
    return
  }

  const target = `http://127.0.0.1:${String(port)}`
  const authority = `${dnsName}:${String(config.httpsPort)}`

  if (config.serveOnStart) {
    const serveStatus = await deps.readServeStatus(binary)
    const state = classifyServe(serveStatus, config.httpsPort, target)
    if (state.kind === 'conflict') {
      runtime.phase = 'error'
      runtime.error = `${String(config.httpsPort)} 端口上有冲突的 Serve 配置（${state.reason}）`
      logger.warn(`tailscale-remote: ${String(config.httpsPort)} 端口上有冲突的 Serve 配置（${state.reason}），不覆盖`)
      return
    }
    if (state.kind === 'exact') {
      // 已经有一条精确指向本实例 DSH 端口的路由。它只可能是上一次运行留下的
      // （正常退出会撤掉，所以这种情况基本等于「上次 DSH 是崩溃/强杀结束的」）。
      // 既然目标就是我们自己，就把它**认领下来**，退出时一并撤掉 —— 否则用户的
      // 「关 DSH 就关掉」在崩溃恢复后会永远失效，路由会一直留在那儿。
      logger.info(`tailscale-remote: ${authority} 已在代理 ${target}，接管它（退出时会撤掉）`)
      undo.createdRoute = true
    } else {
      if (state.kind === 'stale') {
        logger.info(`tailscale-remote: 接管陈旧路由 ${state.authority}（原代理 ${state.previousProxy}）`)
      }
      const serve = await deps.run(binary, ['serve', '--bg', `--https=${String(config.httpsPort)}`, target], SETUP_TIMEOUT_MS)
      if (!serve.ok) {
        const detail = (serve.stderr || serve.stdout).trim().slice(0, 300)
        runtime.phase = 'error'
        runtime.error = detail === '' ? '配置 Serve 失败' : detail
        logger.warn(
          `tailscale-remote: 配置 Serve 失败: ${detail}；` +
            '若提示 HTTPS 证书，请先在 Tailscale 管理台为该 tailnet 启用 HTTPS 证书',
        )
        return
      }
      undo.createdRoute = true
    }
  }

  // 关键一步：让 DSH 的 /api fence 接受这个 authority，否则手机上前端能开、RPC 全 403。
  if (config.trustedHosts) {
    const trusted = connectionTrustedHosts(scope)
    if (trusted === undefined) {
      logger.warn('tailscale-remote: 读不到 connection.trustedHosts，远程 RPC 会被 403 拒绝')
    } else if (!trusted.includes(authority)) {
      trusted.push(authority)
      undo.trustedHost = authority
      logger.info(`tailscale-remote: 已把 ${authority} 加入 /api 信任列表`)
    }
  }

  const plainUrl = `https://${authority}/`
  const connection = scope.get('connection')

  // 把登录 cookie 的有效期拉长。DSH 默认 30 天，对「手机随时连」太短。
  // `connection.browserAuth.maxAgeMilliseconds` 是**活的**字段：authorizeIndex 种 cookie 时
  // 用它算 expiresAt / Max-Age，isAuthenticated 校验时也用它，所以在这里改立刻就生效。
  if (config.cookieMaxAgeDays > 0) {
    const maxAgeMilliseconds = config.cookieMaxAgeDays * 86400000
    const auth = connection?.browserAuth
    if (auth !== undefined && Number.isSafeInteger(Date.now() + maxAgeMilliseconds)) {
      auth.maxAgeMilliseconds = maxAgeMilliseconds
      logger.info(`tailscale-remote: 登录 cookie 有效期设为 ${String(config.cookieMaxAgeDays)} 天`)
    } else {
      logger.warn('tailscale-remote: 读不到 connection.browserAuth，cookie 有效期沿用 DSH 默认值')
    }
  }

  let handoffUrl = plainUrl
  try {
    // authenticatedUrl 会把本进程的启动令牌加到链接上；首次打开会种下 cookie。
    handoffUrl = connection?.authenticatedUrl?.(plainUrl) ?? plainUrl
  } catch {
    handoffUrl = plainUrl
  }
  runtime.handoffUrl = handoffUrl

  // 稳定的登录入口：/remote/<持久密钥> → 302 到带令牌的地址。
  // 令牌每次都变、用户没法存书签；这条路径的密钥写在状态文件里，**跨重启不变**，
  // 所以手机上存一次就够了。密钥同时充当访问门槛（不知道密钥的人拿不到会话）。
  let loginUrl = plainUrl
  let loginPath
  if (config.loginRoute) {
    const secret = await deps.ensureLoginSecret(scope, config, deps)
    // 路径在这里**同步**算出来：`scope.inject` 的服务晚到时回调是异步的，
    // 若等回调再算，webServer 迟到就会让状态文件里丢掉 loginUrl。
    loginPath = `/remote/${secret}`
    loginUrl = `https://${authority}${loginPath}`
    undo.loginPath = loginPath
    // 登录入口的跳转目标就是上面这个带令牌的地址；注册在 DSH 自己的 webserver 上
    // （所以不需要第二个端口、也不需要额外的 tailscale serve 路由）。
    // 嵌套 inject：webServer 缺席时只丢登录入口，tailscale / 信任项照常工作。
    scope.inject(['webServer'], (webScope) => {
      runtime.webScope = webScope
      installLoginRoute(runtime, connection, config, authority, secret)
    })
  }

  const loginSecret = loginPath === undefined ? undefined : loginPath.slice('/remote/'.length)
  const snapshot = {
    url: handoffUrl,
    loginUrl,
    loginPath,
    loginSecret,
    plainUrl,
    authority,
    dnsName,
    httpsPort: config.httpsPort,
    target,
    cookieMaxAgeDays: config.cookieMaxAgeDays,
    // 精简模式的选择。写进来才能在重启后被 `setup` 读回去（见开头那段）。
    lite: runtime.liteChoice ?? config.lite,
    updatedAt: new Date().toISOString(),
    stateFile: config.stateFile,
  }
  await deps.persistState(scope, snapshot)
  runtime.state = snapshot
  runtime.phase = 'ready'
  runtime.error = undefined

  logger.info(`tailscale-remote: 手机可用地址 ${plainUrl}`)
  if (loginUrl !== plainUrl) {
    logger.info(`tailscale-remote: 手机登录入口（存一次书签即可，跨重启不变）${loginUrl}`)
  }
  logger.info(`tailscale-remote: 一次性令牌链接（每次重启都会变）${handoffUrl}`)
  // 也打到 stdout：桌面版的日志面板里能直接看到。
  deps.announce?.(plainUrl, loginUrl, handoffUrl)
}

/** 默认的 announce：写 stdout，桌面版日志面板可见。 */
function announce(plainUrl, loginUrl, handoffUrl) {
  console.log(`dsh tailscale-remote: ${plainUrl}`)
  if (loginUrl !== plainUrl) console.log(`dsh tailscale-remote (手机登录入口): ${loginUrl}`)
  console.log(`dsh tailscale-remote (一次性令牌): ${handoffUrl}`)
}

/**
 * 等 `webServer.port` 就绪。
 * WebServer 在构造函数里就 provide 了服务，但端口要等 `[Service.init]` 的异步 listen
 * 完成才赋值；插件激活时机与它没有顺序保证，所以这里轮询而不是一次性读。
 */
async function waitForPort(scope, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const port = scope.get('webServer')?.port
    if (Number.isInteger(port) && port > 0) return port
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 从 connection 服务上取那个可变的 trustedHosts 数组。 */
function connectionTrustedHosts(scope, strict = true) {
  const connection = scope.get('connection', strict)
  const trusted = connection?.trustedHosts
  return Array.isArray(trusted) ? trusted : undefined
}

/** 退出：按 undo 清单回滚。幂等、并发安全、绝不抛。 */
async function teardown(scope, config, undo, deps = REAL_DEPS) {
  const logger = scope.logger
  try {
    if (undo.trustedHost !== undefined) {
      // strict=false：关停时 connection 的 fiber 可能已经不再 active，但仍要清掉那一项。
      const trusted = connectionTrustedHosts(scope, false)
      if (trusted !== undefined) {
        const at = trusted.indexOf(undo.trustedHost)
        if (at !== -1) trusted.splice(at, 1)
      }
      undo.trustedHost = undefined
    }
  } catch {
    /* 上下文可能已经在拆除中 */
  }

  if (!undo.createdRoute && !undo.startedTailscale) return

  const binary = undo.binary ?? (await deps.resolveBinary(scope, config.binaryPath))
  if (binary === undefined) return

  // 两条清理各自独立：Serve 路由没建起来不代表 tailscale 不是我们拉起的。
  if (undo.createdRoute) {
    undo.createdRoute = false
    const off = await deps.run(binary, ['serve', `--https=${String(config.httpsPort)}`, 'off'], TEARDOWN_TIMEOUT_MS)
    if (off.ok) logger.info(`tailscale-remote: 已撤销 ${String(config.httpsPort)} 端口上的 Serve 路由`)
    else logger.warn(`tailscale-remote: 撤销 Serve 路由失败: ${(off.stderr || off.stdout).trim().slice(0, 200)}`)
  }

  if (undo.startedTailscale) {
    undo.startedTailscale = false
    const down = await deps.run(binary, ['down'], TEARDOWN_TIMEOUT_MS)
    if (down.ok) logger.info('tailscale-remote: 已断开 tailscale（本次由 DSH 拉起）')
    else logger.warn(`tailscale-remote: tailscale down 失败: ${(down.stderr || down.stdout).trim().slice(0, 200)}`)
  }
}

/**
 * 纯函数与底层 runner 的测试入口。
 * 生产路径不读这个对象；它只为单元测试而存在（决定"要不要覆盖已有 Serve 配置"的
 * `classifyServe` 是这里风险最高的一段逻辑，必须有牙齿地测）。
 */
export const internals = {
  normalizeConfig,
  classifyServe,
  dnsNameOf,
  resolveDshHome,
  resolveGui,
  run,
  resolveBinary,
  readServeStatus,
  readStatus,
  waitForPort,
  waitForRunning,
  ensureRunning,
  ensureLoginSecret,
  mintSessionCookie,
  sessionCookieHeader,
  statePayload,
  installLoginRoute,
  rotateLoginSecret,
  rotateSessionSecret,
  hostAuthority,
  registerAdminRoutes,
  createLiteController,
  installWebSocketCompression,
  armWebSocketCompression,
  persistLiteChoice,
  freshRuntime,
  setup,
  teardown,
  REAL_DEPS,
  STATE_PATH,
  ROTATE_PATH,
  LITE_PATH,
  AUTH_RECORD_KEY,
}
