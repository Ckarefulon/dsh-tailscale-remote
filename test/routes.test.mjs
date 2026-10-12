// 设置页那一行背后的两个管理端点的行为测试。
//
// 这一层是「用户在设置里看到的东西」的唯一后端：状态读不到、换密钥换了个寂寞、
// 或者换完之后旧链接还能用，都属于在这里能抓到、在别处抓不到的 bug。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { internals } from '../index.js'

const { statePayload, registerAdminRoutes, rotateLoginSecret, freshRuntime, installLoginRoute, STATE_PATH, ROTATE_PATH } =
  internals

const CONFIG = {
  enabled: true,
  httpsPort: 7259,
  loginRoute: true,
  cookieMaxAgeDays: 3650,
  stateFile: undefined,
}

/** 造一个能记录 connection.fetch 注册与 webServer 路由的 scope。 */
function fakeScope({ routes = [], webRoutes = [], secret = Buffer.alloc(32, 5), port = 19387 } = {}) {
  const logs = []
  const fetchRoutes = []
  const registered = []
  const webServer = {
    register: (route) => {
      registered.push(route)
      return () => {
        const at = registered.indexOf(route)
        if (at !== -1) registered.splice(at, 1)
      }
    },
    port,
  }
  const connection = {
    trustedHosts: [],
    authenticatedUrl: (url) => `${url}?token=abc`,
    browserAuth: { secret, maxAgeMilliseconds: 30 * 86400000 },
    fetch: {
      register: (route) => {
        fetchRoutes.push(route)
        return async () => {}
      },
    },
  }
  const store = { connection, webServer }
  return {
    logs,
    fetchRoutes,
    registered,
    store,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    get: (name) => store[name],
    inject: (_deps, callback) =>
      callback({
        get: (name) => store[name],
        effect: (fn) => fn(),
      }),
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

/** 取注册好的某条 fetch 路由。 */
function routeFor(scope, path) {
  const route = scope.fetchRoutes.find((r) => r.path === path)
  assert.ok(route !== undefined, `必须注册 ${path}`)
  return route
}

test('两个端点都注册在 connection.fetch 上（白拿 DSH 的 fence 与 cookie 鉴权）', () => {
  const scope = fakeScope()
  registerAdminRoutes(scope, CONFIG, freshRuntime({}))

  const paths = scope.fetchRoutes.map((r) => r.path).sort()
  assert.deepEqual(paths, [ROTATE_PATH, STATE_PATH].sort())
  // 绝不能注册成 webServer 的 exact 路由：那会遮掉整条 /api 前缀路由，
  // 把 Host/Origin fence 和浏览器鉴权一起绕过去。
  assert.deepEqual(scope.registered, [], '不该往 webServer 上注册任何 exact 路由')
  assert.equal(scope.fetchRoutes.find((r) => r.path === STATE_PATH).methods[0], 'GET')
  assert.equal(scope.fetchRoutes.find((r) => r.path === ROTATE_PATH).methods[0], 'POST')
})

test('状态端点：就绪时给出链接与可换密钥标志', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'ready'
  runtime.state = {
    plainUrl: 'https://host.ts.net:7259/',
    loginUrl: 'https://host.ts.net:7259/remote/SECRET',
    authority: 'host.ts.net:7259',
    dnsName: 'host.ts.net',
    httpsPort: 7259,
    cookieMaxAgeDays: 3650,
    updatedAt: '2026-10-12T00:00:00.000Z',
  }
  registerAdminRoutes(scope, CONFIG, runtime)

  const response = await routeFor(scope, STATE_PATH).fetch()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'ready')
  assert.equal(body.loginUrl, 'https://host.ts.net:7259/remote/SECRET')
  assert.equal(body.canRotate, true)
  assert.equal(body.error, null)
  assert.match(response.headers.get('cache-control'), /no-store/, '状态不能缓存')
})

test('状态端点：还在启动时也返回 200 并说清楚阶段（不是错误响应）', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'starting'
  registerAdminRoutes(scope, CONFIG, runtime)

  const response = await routeFor(scope, STATE_PATH).fetch()
  // 「还在启动」是设置页要看的正常答案，不是失败 —— 用 200 + phase 表达。
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'starting')
  assert.equal(body.canRotate, false, '没就绪就不该允许换密钥')
  assert.equal(body.loginUrl, null)
})

test('状态端点：启动失败时把真正的原因带出来', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'error'
  runtime.error = '端口上有冲突的 Serve 配置'
  registerAdminRoutes(scope, CONFIG, runtime)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.phase, 'error')
  assert.equal(body.error, '端口上有冲突的 Serve 配置')
  assert.equal(body.canRotate, false)
})

test('状态端点：loginRoute=false 时不允许换密钥（没有密钥可换）', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'ready'
  runtime.state = { plainUrl: 'https://h/', loginUrl: 'https://h/', cookieMaxAgeDays: 3650 }
  registerAdminRoutes(scope, { ...CONFIG, loginRoute: false }, runtime)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.canRotate, false)
})

test('换密钥：装了新路由、撤了旧的、写了盘、活状态也更新了', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.phase = 'ready'
  runtime.handoffUrl = 'https://host.ts.net:7259/?token=abc'
  runtime.state = {
    url: 'https://host.ts.net:7259/?token=abc',
    plainUrl: 'https://host.ts.net:7259/',
    loginUrl: 'https://host.ts.net:7259/remote/OLD',
    loginPath: '/remote/OLD',
    loginSecret: 'OLD',
    authority: 'host.ts.net:7259',
    cookieMaxAgeDays: 3650,
  }

  // 先装上「旧」的那一条，模拟真实运行时。
  const oldPath = installLoginRoute(runtime, scope.get('connection'), CONFIG, 'host.ts.net:7259', 'OLD')
  assert.equal(oldPath, '/remote/OLD')
  assert.equal(scope.registered.length, 1)
  assert.equal(scope.registered[0].path, '/remote/OLD')

  const persisted = []
  const result = await rotateLoginSecret(scope, CONFIG, runtime, {
    persistState: async (_scope, state) => persisted.push(state),
  })

  assert.match(result.loginPath, /^\/remote\/[A-Za-z0-9_-]{22,}$/)
  assert.notEqual(result.loginPath, '/remote/OLD')
  assert.equal(result.loginUrl, `https://host.ts.net:7259${result.loginPath}`)

  // 关键：旧路由必须**已经不在**路由表里。只加新不减旧的话，旧链接照样能用，
  // 那「换完之后旧链接立刻失效」就是句谎话。
  assert.equal(scope.registered.length, 1, '旧路由必须被撤掉')
  assert.equal(scope.registered[0].path, result.loginPath)
  assert.equal(
    scope.registered.some((r) => r.path === '/remote/OLD'),
    false,
    '旧路径不能还在表里',
  )

  // 落盘的内容必须是新的。
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].loginPath, result.loginPath)
  assert.equal(persisted[0].loginUrl, result.loginUrl)
  assert.equal(persisted[0].loginSecret, result.loginPath.slice('/remote/'.length))
  assert.equal(persisted[0].plainUrl, 'https://host.ts.net:7259/', '其它字段不能被抹掉')

  // 活状态也要跟上，否则设置页刷新还是旧链接。
  assert.equal(runtime.state.loginPath, result.loginPath)
  assert.equal(runtime.login.path, result.loginPath)
  // 退出清理清单也要跟着走，不然关停时撤的是旧路径。
  assert.equal(runtime.undo.loginPath, result.loginPath)
})

test('换密钥：新密钥每次都不一样', async () => {
  const seen = new Set()
  for (let i = 0; i < 5; i += 1) {
    const scope = fakeScope()
    const runtime = freshRuntime({})
    runtime.webScope = scope
    runtime.state = { plainUrl: 'https://h/', authority: 'h:7259', cookieMaxAgeDays: 3650 }
    const result = await rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} })
    seen.add(result.loginPath)
  }
  assert.equal(seen.size, 5, '五次必须给出五个不同密钥')
})

test('换密钥：还没就绪时明确拒绝，不静默成功', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  // phase 还是 starting、state 还是 undefined
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} }),
    /还没就绪/,
  )
  assert.equal(scope.registered.length, 0, '失败时不该留下半装的路由')
})

test('换密钥：loginRoute=false 时明确拒绝', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.state = { plainUrl: 'https://h/', authority: 'h:7259' }
  await assert.rejects(
    () => rotateLoginSecret(scope, { ...CONFIG, loginRoute: false }, runtime, { persistState: async () => {} }),
    /登录入口已关闭/,
  )
})

test('换密钥：webServer 不可用时明确拒绝（不假装成功）', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.state = { plainUrl: 'https://h/', authority: 'h:7259' }
  // webScope 缺席
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} }),
    /webServer 不可用/,
  )
})

test('换密钥端点：失败时回 409 + ok:false + 原因（客户端靠 body 说话）', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  registerAdminRoutes(scope, CONFIG, runtime)

  const response = await routeFor(scope, ROTATE_PATH).fetch()
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /还没就绪/)
})

test('换密钥端点：成功后回 ok:true 和新链接', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.state = { plainUrl: 'https://host.ts.net:7259/', authority: 'host.ts.net:7259', cookieMaxAgeDays: 3650 }
  // 直接替换成不写盘的实现，避免碰真实 $DSH_HOME。
  runtime.undo = {}
  registerAdminRoutes(scope, CONFIG, runtime)
  // 把真实 persistState 换掉：这里只关心 HTTP 层的形状。
  const original = internals.REAL_DEPS.persistState
  internals.REAL_DEPS.persistState = async () => {}
  try {
    const response = await routeFor(scope, ROTATE_PATH).fetch()
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.match(body.loginUrl, /^https:\/\/host\.ts\.net:7259\/remote\/[A-Za-z0-9_-]{22,}$/)
  } finally {
    internals.REAL_DEPS.persistState = original
  }
})

test('statePayload 在没有任何状态时也不抛（早启动的窗口）', () => {
  const payload = statePayload(CONFIG, freshRuntime({}))
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'starting')
  assert.equal(payload.loginUrl, null)
  assert.equal(payload.plainUrl, null)
  assert.equal(payload.httpsPort, 7259, '端口要回落到配置值')
  assert.equal(payload.cookieMaxAgeDays, 3650)
})

test('enabled=false 时仍然注册端点，好让设置页回答「为什么没起来」', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'disabled'
  registerAdminRoutes(scope, { ...CONFIG, enabled: false }, runtime)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'disabled')
  assert.equal(body.enabled, false)
  assert.equal(body.canRotate, false)
})
