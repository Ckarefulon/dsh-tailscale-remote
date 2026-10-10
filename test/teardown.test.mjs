// 退出清理的行为测试：用假的 deps 记录调用，不碰真实的 tailscale。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { internals } from '../index.js'

const { teardown, setup } = internals

/** 造一个记录调用的假 deps。 */
function fakeDeps(overrides = {}) {
  const calls = []
  const persisted = []
  const deps = {
    calls,
    persisted,
    run: async (binary, args) => {
      calls.push({ binary, args })
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
    resolveBinary: async () => 'tailscale',
    readStatus: async () => ({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } }),
    readServeStatus: async () => undefined,
    waitForPort: async () => 19387,
    // 假实现，绝不写真实 $DSH_HOME（否则测试会污染用户的家目录）。
    persistState: async (scope, state) => {
      persisted.push(state)
    },
    announce: () => {},
    // 默认：假装桌面客户端启动成功（真实实现启动的是常驻托盘程序）。
    launchGui: async () => true,
    resolveGui: () => 'C:\\fake\\tailscale-ipn.exe',
    // 默认没有历史状态 → 每次生成新密钥；个别用例覆盖它来验证「跨重启复用」。
    loadState: async () => undefined,
    ensureLoginSecret: async () => 'test-secret-0123456789abcdef',
    ...overrides,
  }
  return deps
}

/** 造一个最小的 scope。 */
function fakeScope({ port = 19387, trusted = [] } = {}) {
  const logs = []
  const routes = []
  const store = {
    webServer: { port },
    connection: {
      trustedHosts: trusted,
      authenticatedUrl: (u) => `${u}?token=abc`,
      // 真实的 connection 上有这个活的 BrowserAuth 实例；插件会改它的 maxAgeMilliseconds。
      browserAuth: { maxAgeMilliseconds: 30 * 86400000 },
    },
  }
  // 插件用嵌套 inject 去拿 webServer 注册登录入口；这里给一个能记录路由的替身。
  const fakeWebServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  return {
    logs,
    routes,
    store,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    get: (name) => store[name],
    inject: (_deps, callback) =>
      callback({
        get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
        effect: (fn) => fn(),
      }),
  }
}

// 测试里把两段等待预算压成 0，否则每个「拉不起来」的用例要白等 8~33 秒。
const CONFIG = {
  httpsPort: 7259,
  binaryPath: undefined,
  connectOnStart: true,
  serveOnStart: true,
  trustedHosts: true,
  readyTimeoutMs: 0,
  guiReadyTimeoutMs: 0,
  cookieMaxAgeDays: 0,
  loginRoute: true,
}

test('本来就在运行的 tailscale：退出时只撤路由，不 down', async () => {
  const deps = fakeDeps()
  const scope = fakeScope({ trusted: ['host.ts.net:7259'] })
  const undo = { trustedHost: 'host.ts.net:7259', createdRoute: true, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off'])
  assert.equal(scope.store.connection.trustedHosts.length, 0, '信任项必须被移除')
  assert.equal(undo.createdRoute, false)
})

test('本次由 DSH 拉起的 tailscale：撤路由 + down', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off', 'down'])
})

test('路由没建起来但 tailscale 是我们拉起的：仍然要 down', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['down'])
})

test('什么都没做：退出时不调用任何命令', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.length, 0)
})

test('幂等：连跑两次只清理一次', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)
  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off', 'down'])
})

test('只移除自己那一项，保留别人的信任项', async () => {
  const deps = fakeDeps()
  const scope = fakeScope({ trusted: ['other.example:1234', 'host.ts.net:7259', '127.0.0.1:9999'] })
  const undo = { trustedHost: 'host.ts.net:7259', createdRoute: false, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  assert.deepEqual(scope.store.connection.trustedHosts, ['other.example:1234', '127.0.0.1:9999'])
})

test('命令失败不抛异常（disposer 绝不能 reject）', async () => {
  const deps = fakeDeps({
    run: async (binary, args) => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await assert.doesNotReject(() => teardown(scope, CONFIG, undo, deps))
  assert.ok(scope.logs.some((l) => l.startsWith('warn:')), '失败必须留下警告日志')
})

test('setup 在 connection 上 push 信任项，并把端口读成目标', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.deepEqual(scope.store.connection.trustedHosts, ['host.ts.net:7259'])
  assert.equal(undo.trustedHost, 'host.ts.net:7259')
  const serve = deps.calls.find((c) => c.args[0] === 'serve' && c.args.includes('--bg'))
  assert.deepEqual(serve.args, ['serve', '--bg', '--https=7259', 'http://127.0.0.1:19387'])
  assert.equal(undo.createdRoute, true, '我们建的路由要记下来，退出时撤掉')
  assert.equal(deps.persisted.length, 1, '要把可用地址落盘')
  assert.equal(deps.persisted[0].plainUrl, 'https://host.ts.net:7259/')
  assert.equal(deps.persisted[0].url, 'https://host.ts.net:7259/?token=abc', '落盘的应是带令牌的首次登录链接')
})

test('已有精确匹配的路由：不重复建，但认领下来以便退出时撤掉（崩溃恢复）', async () => {
  const deps = fakeDeps({
    readServeStatus: async () => ({
      Web: { 'host.ts.net:7259': { Handlers: { '/': { Proxy: 'http://127.0.0.1:19387' } } } },
      TCP: { '7259': { HTTPS: true } },
    }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.some((c) => c.args[0] === 'serve' && c.args.includes('--bg')), false, '不该重复建路由')
  assert.equal(
    undo.createdRoute,
    true,
    '精确指向本实例的路由必须认领：否则上次崩溃留下的路由永远撤不掉，「关 DSH 就关掉」失效',
  )
  assert.equal(undo.trustedHost, 'host.ts.net:7259', '信任项仍要加')
})

test('冲突的已有配置：不动手，也不加信任项', async () => {
  const deps = fakeDeps({
    readServeStatus: async () => ({
      Web: { 'host.ts.net:7259': { Handlers: { '/': { Proxy: 'http://10.0.0.9:80' } } } },
      TCP: { '7259': { HTTPS: true } },
    }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.some((c) => c.args[0] === 'serve' && c.args.includes('--bg')), false)
  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
  assert.ok(scope.logs.some((l) => l.includes('冲突')), '冲突必须有日志')
})

test('up 不生效（exit 0 但 backend 没起来）→ 拉起桌面客户端，成功后才建路由', async () => {
  // 复现真实故障：tailscale 被完全退出后，`tailscale up` exit 0 但 BackendState 仍是 NoState。
  let backendState = 'NoState'
  const deps = fakeDeps({
    readStatus: async () => ({
      BackendState: backendState,
      Self: backendState === 'Running' ? { DNSName: 'host.ts.net.' } : { DNSName: '' },
    }),
    // 只有「启动桌面客户端」这一下才会真正把 backend 拉起来。
    launchGui: async () => {
      backendState = 'Running'
      return true
    },
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.ok(scope.logs.some((l) => l.includes('改为启动桌面客户端')), '必须回落到启动客户端')
  assert.equal(undo.startedTailscale, true, 'backend 是本次拉起来的 → 退出时才该 down')
  assert.deepEqual(scope.store.connection.trustedHosts, ['host.ts.net:7259'], '起来了就该配信任项')
  assert.equal(undo.createdRoute, true, '起来了就该建路由')
})

test('up 不生效且找不到桌面客户端 → 不建路由，并给出可操作提示', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'NoState', Self: { DNSName: '' } }),
    resolveGui: () => undefined,
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
  assert.equal(undo.startedTailscale, false, '没拉起来就不能宣称是我们拉起的')
  assert.ok(scope.logs.some((l) => l.includes('请手动打开 Tailscale 客户端')), '必须提示用户手动处理')
})

test('桌面客户端也拉不起来 → 不建路由（不谎报成功）', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'NoState', Self: { DNSName: '' } }),
    launchGui: async () => true, // 启动动作成功，但 backend 始终没起来
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.startedTailscale, false)
  assert.ok(scope.logs.some((l) => l.includes('等不到 tailscale 进入 Running')))
})

test('tailscale 没在跑且 up 失败：不建路由，也不 down（不是我们拉起来的）', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'Stopped' }),
    resolveGui: () => undefined,
    run: async (binary, args) => {
      deps.calls.push({ binary, args })
      return { ok: false, code: 1, stdout: '', stderr: 'not logged in' }
    },
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.startedTailscale, false, 'up 失败就不能宣称是我们拉起的')
  assert.equal(undo.createdRoute, false)
  assert.deepEqual(deps.calls.map((c) => c.args.join(' ')), ['up'])
})

test('拿不到 Web 端口：不建路由', async () => {
  const deps = fakeDeps({ waitForPort: async () => undefined })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
})

test('把 connection 上的 cookie 有效期改成配置的天数（不是干等 30 天）', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, cookieMaxAgeDays: 3650 }, undo, deps)

  assert.equal(
    scope.store.connection.browserAuth.maxAgeMilliseconds,
    3650 * 86400000,
    '必须直接改那个活的 maxAgeMilliseconds，否则种下的 cookie 还是 30 天',
  )
})

test('cookieMaxAgeDays=0 表示不插手 DSH 的默认值', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, cookieMaxAgeDays: 0 }, undo, deps)

  assert.equal(scope.store.connection.browserAuth.maxAgeMilliseconds, 30 * 86400000, '保持原样')
})

test('登录入口用持久密钥，并且落进状态文件（跨重启不变）', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'STABLE_SECRET_abcdefghijklmnop' })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.loginPath, '/remote/STABLE_SECRET_abcdefghijklmnop')
  const state = deps.persisted.at(-1)
  assert.equal(state.loginUrl, 'https://host.ts.net:7259/remote/STABLE_SECRET_abcdefghijklmnop')
  assert.equal(state.loginSecret, 'STABLE_SECRET_abcdefghijklmnop', '密钥要落盘，下次才能复用')
})

test('密钥从历史状态文件复用；没有才新生成', async () => {
  const { ensureLoginSecret } = internals
  const reused = await ensureLoginSecret(fakeScope(), CONFIG, {
    loadState: async () => ({ loginSecret: 'KEEP_THIS_0123456789abcdefgh' }),
  })
  assert.equal(reused, 'KEEP_THIS_0123456789abcdefgh', '已有密钥必须复用，否则手机上的书签会失效')

  const fresh = await ensureLoginSecret(fakeScope(), CONFIG, { loadState: async () => undefined })
  assert.match(fresh, /^[A-Za-z0-9_-]{22,}$/, '没有历史时生成足够长的随机密钥')
  assert.notEqual(fresh, reused)
})

test('历史状态文件损坏/密钥形状不对时，重新生成而不是沿用', async () => {
  const { ensureLoginSecret } = internals
  const bad = await ensureLoginSecret(fakeScope(), CONFIG, {
    loadState: async () => ({ loginSecret: 'short' }),
  })
  assert.match(bad, /^[A-Za-z0-9_-]{22,}$/)
  assert.notEqual(bad, 'short')
})

test('loginRoute=false 时不注册登录入口，也不写 loginSecret', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, loginRoute: false }, undo, deps)

  assert.equal(undo.loginPath, undefined)
  assert.equal(deps.persisted.at(-1).loginSecret, undefined)
})

test('登录入口的处理器：没有签名密钥时回落到令牌跳转，非 GET 405', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'SECRET_abcdefghijklmnopqrst' })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  const route = scope.routes.find((r) => r.path === '/remote/SECRET_abcdefghijklmnopqrst')
  assert.ok(route !== undefined, '必须注册这条 exact 路由')
  assert.equal(route.kind, 'exact', 'exact 才能盖过 SPA 的 fallback')

  const seen = []
  const res = {
    writeHead: (code, headers) => seen.push({ code, headers }),
    end: () => {},
  }
  route.handler({ method: 'GET' }, res)
  assert.equal(seen[0].code, 302)
  assert.equal(seen[0].headers.location, 'https://host.ts.net:7259/?token=abc')

  route.handler({ method: 'POST' }, res)
  assert.equal(seen[1].code, 405)
})

test('能拿到签名密钥时：自己铸 cookie，一跳直达根路径（不再走令牌链）', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'SECRET_abcdefghijklmnopqrst' })
  const scope = fakeScope()
  scope.store.connection.browserAuth.secret = Buffer.alloc(32, 7)
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  const route = scope.routes.find((r) => r.path === '/remote/SECRET_abcdefghijklmnopqrst')
  const seen = []
  route.handler({ method: 'GET' }, { writeHead: (c, h) => seen.push({ c, h }), end: () => {} })

  assert.equal(seen[0].c, 302)
  assert.equal(seen[0].h.location, 'https://host.ts.net:7259/', '直接跳根路径，不再经过 ?token=')
  const cookie = seen[0].h['set-cookie']
  assert.ok(cookie.startsWith('dsh-auth-'), 'cookie 名必须是 DSH 的前缀，否则 isAuthenticated 找不到')
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /SameSite=Lax/, 'Lax 而不是 Strict —— 从别的 App 点进来时也要带上 cookie')
  assert.match(cookie, /Path=\//)
})

test('铸出来的 cookie 与 client-connection 的 encodeCookie 同构', async () => {
  const secret = Buffer.alloc(32, 9)
  const authority = 'host.ts.net:7259'
  const minted = internals.mintSessionCookie({ browserAuth: { secret } }, authority, 3650 * 86400000)

  const b64url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  assert.equal(minted.name, `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`)

  const parts = minted.value.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'v1')
  assert.equal(parts[2], b64url(createHmac('sha256', secret).update(parts[1]).digest()), '签名必须对得上')

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  assert.equal(payload.version, 1)
  assert.equal(payload.authority, authority, 'authority 必须与请求的 Host 一致')
  assert.ok(payload.expiresAt > payload.issuedAt)
  assert.ok(payload.expiresAt - payload.issuedAt <= 3650 * 86400000, 'DSH 会校验这个上限')
})

test('拿不到签名密钥时不铸 cookie（回落到令牌链，不抛）', () => {
  assert.equal(internals.mintSessionCookie({ browserAuth: {} }, 'h:1', 1000), undefined)
  assert.equal(internals.mintSessionCookie(undefined, 'h:1', 1000), undefined)
  assert.equal(internals.mintSessionCookie({ browserAuth: { secret: 'not-a-buffer' } }, 'h:1', 1000), undefined)
})
