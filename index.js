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
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} rawConfig - 该行声明的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info('tailscale-remote: enabled=false，插件不动作')
    return
  }

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
      disposed: false,
    }

    // 退出清理挂在这里：这是唯一可靠的关停挂点，且 disposer 绝不能 reject。
    scope.effect(() => async () => {
      if (undo.disposed) return
      undo.disposed = true
      if (!config.teardownOnExit) return
      // 关停预算很紧：全部吞掉异常，绝不让 disposer reject（会变成 AggregateError）。
      await Promise.allSettled([teardown(scope, config, undo)])
    }, 'tailscale-remote: teardown')

    // 启动流程异步跑，不阻塞 Loader 装配。
    setup(scope, config, undo).catch((error) => {
      scope.logger.warn(`tailscale-remote: 启动失败：${String(error?.message ?? error)}`)
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
  announce,
  launchGui,
  resolveGui,
}

/** 启动：拉起 tailscale → 建 serve 路由 → 信任该 authority → 打印手机可用的链接。 */
async function setup(scope, config, undo, deps = REAL_DEPS) {
  const logger = scope.logger
  const binary = await deps.resolveBinary(scope, config.binaryPath)
  if (binary === undefined) {
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
  if (!running) return
  if (!wasRunning) status = await deps.readStatus(binary)

  const dnsName = dnsNameOf(status)
  if (dnsName === undefined) {
    logger.warn('tailscale-remote: 读不到 tailnet DNS 名称，跳过 Serve 配置')
    return
  }

  // DSH 自己的 Web 端口从服务上读，绝不写死。
  const port = await deps.waitForPort(scope)
  if (port === undefined) {
    logger.warn('tailscale-remote: 等不到 DSH Web 端口，跳过 Serve 配置')
    return
  }

  const target = `http://127.0.0.1:${String(port)}`
  const authority = `${dnsName}:${String(config.httpsPort)}`

  if (config.serveOnStart) {
    const serveStatus = await deps.readServeStatus(binary)
    const state = classifyServe(serveStatus, config.httpsPort, target)
    if (state.kind === 'conflict') {
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
        logger.warn(
          `tailscale-remote: 配置 Serve 失败: ${(serve.stderr || serve.stdout).trim().slice(0, 300)}；` +
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
  let handoffUrl = plainUrl
  try {
    // authenticatedUrl 会把本进程的启动令牌加到链接上；首次打开会种下 30 天 cookie。
    handoffUrl = connection?.authenticatedUrl?.(plainUrl) ?? plainUrl
  } catch {
    handoffUrl = plainUrl
  }

  await deps.persistState(scope, {
    url: handoffUrl,
    plainUrl,
    authority,
    dnsName,
    httpsPort: config.httpsPort,
    target,
    updatedAt: new Date().toISOString(),
    stateFile: config.stateFile,
  })

  logger.info(`tailscale-remote: 手机可用地址 ${plainUrl}`)
  logger.info(`tailscale-remote: 首次登录链接（令牌随进程变化，cookie 有效期 30 天）${handoffUrl}`)
  // 也打到 stdout：桌面版的日志面板里能直接看到。
  deps.announce?.(plainUrl, handoffUrl)
}

/** 默认的 announce：写 stdout，桌面版日志面板可见。 */
function announce(plainUrl, handoffUrl) {
  console.log(`dsh tailscale-remote: ${plainUrl}`)
  console.log(`dsh tailscale-remote (首次登录): ${handoffUrl}`)
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
  setup,
  teardown,
  REAL_DEPS,
}
