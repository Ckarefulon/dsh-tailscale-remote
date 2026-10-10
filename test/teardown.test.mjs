// 退出清理的行为测试：用假的 deps 记录调用，不碰真实的 tailscale。
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
    ...overrides,
  }
  return deps
}

/** 造一个最小的 scope。 */
function fakeScope({ port = 19387, trusted = [] } = {}) {
  const logs = []
  const store = {
    webServer: { port },
    connection: { trustedHosts: trusted, authenticatedUrl: (u) => `${u}?token=abc` },
  }
  return {
    logs,
    store,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    get: (name) => store[name],
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
