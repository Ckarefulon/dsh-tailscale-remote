// 设置页那一行背后的两个管理端点的行为测试。
//
// 这一层是「用户在设置里看到的东西」的唯一后端：状态读不到、换密钥换了个寂寞、
// 或者换完之后旧链接还能用，都属于在这里能抓到、在别处抓不到的 bug。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { internals } from '../index.js'

const { statePayload, registerAdminRoutes, rotateLoginSecret, freshRuntime, installLoginRoute, STATE_PATH, ROTATE_PATH } =
  internals

// 与生产默认值一致：换密钥同时吊销会话。测试若不打开它，就会把新增的那条路径
// 整条跳过、全绿却什么都没验到。
const CONFIG = {
  enabled: true,
  httpsPort: 7259,
  loginRoute: true,
  cookieMaxAgeDays: 3650,
  revokeSessionsOnRotate: true,
  stateFile: undefined,
}

/** 造一个能记录 connection.fetch 注册与 webServer 路由的 scope。 */
function fakeScope({ routes = [], webRoutes = [], secret = Buffer.alloc(32, 5), port = 19387 } = {}) {
  const logs = []
  const fetchRoutes = []
  const registered = []
  const credentialWrites = []
  const records = new Map()
  // 照抄真实 modifyRecord 的语义：mutate 返回 undefined 表示「不改」，
  // 否则写入并返回**写入后**的记录（调用方靠回读确认有没有真的落地）。
  const credentials = {
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) {
        records.set(key, next)
        credentialWrites.push({ key, record: next })
      }
      return records.get(key)
    },
  }
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
  const store = { connection, webServer, credentials }
  return {
    logs,
    fetchRoutes,
    registered,
    credentialWrites,
    credentials,
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

/** 造一个已就绪、带 webScope 的 runtime。 */
function readyRuntime(scope, authority = 'host.ts.net:7259') {
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.phase = 'ready'
  runtime.handoffUrl = `https://${authority}/?token=abc`
  runtime.state = {
    url: `https://${authority}/?token=abc`,
    plainUrl: `https://${authority}/`,
    loginUrl: `https://${authority}/remote/OLD`,
    loginPath: '/remote/OLD',
    loginSecret: 'OLD',
    authority,
    cookieMaxAgeDays: 3650,
  }
  return runtime
}

const noPersist = { persistState: async () => {} }

test('换密钥同时吊销会话：写入正确的 credentials 记录，并换掉活着的签名密钥', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret

  await rotateLoginSecret(scope, CONFIG, runtime, noPersist, 'host.ts.net:7259')

  // 1) 持久化：必须写进 client-connection 那条会话记录，否则重启后旧 cookie 复活。
  assert.equal(scope.credentialWrites.length, 1, '必须恰好写一次会话密钥')
  const write = scope.credentialWrites[0]
  assert.equal(write.key, internals.AUTH_RECORD_KEY)
  assert.equal(write.key, 'client-connection/browser-session', '键写错就会静默写到别的记录上')
  assert.equal(write.record.kind, 'grant')
  assert.equal(write.record.payload.version, 1)
  const written = write.record.payload.secret
  assert.equal(typeof written, 'string')
  assert.equal(Buffer.from(written, 'base64url').byteLength, 32, '长度必须与 client-connection 的 SECRET_BYTES 一致')
  assert.notEqual(written, before.toString('base64url'))

  // 2) 立即生效：活着的那个密钥也必须换掉，否则旧 cookie 在本次运行内依然有效。
  const after = scope.store.connection.browserAuth.secret
  assert.ok(Buffer.isBuffer(after), 'browserAuth.secret 必须是 Buffer（client-connection 逐字比较它）')
  assert.equal(after.byteLength, 32)
  assert.notEqual(after.toString('hex'), before.toString('hex'))
})

test('换密钥后，用旧签名密钥铸的 cookie 再也验不过（这才是「原密钥不能用」）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const authority = 'host.ts.net:7259'
  const oldSecret = scope.store.connection.browserAuth.secret

  // 泄露场景：对方用旧密钥的登录链接换到了一张 cookie。
  const leaked = internals.mintSessionCookie({ browserAuth: { secret: oldSecret } }, authority, 3650 * 86400000)
  assert.ok(leaked !== undefined)

  await rotateLoginSecret(scope, CONFIG, runtime, noPersist, authority)

  // 用**当前**密钥重算签名：必须与泄露那张 cookie 的签名不同，否则它仍然可用。
  const body = leaked.value.split('.')[1]
  const live = scope.store.connection.browserAuth.secret
  const expectedNow = createHmac('sha256', live).update(body).digest('base64url')
  const leakedSignature = leaked.value.split('.')[2]
  assert.notEqual(expectedNow, leakedSignature, '泄露的 cookie 必须验不过')

  // 反向确认：换之前它是验得过的，证明这个断言真的在测「换」这件事。
  const expectedBefore = createHmac('sha256', oldSecret).update(body).digest('base64url')
  assert.equal(expectedBefore, leakedSignature)
})

test('从哪台设备发起更换，就只有那台被补发 cookie（点按钮的不会掉线）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime)

  const response = await routeFor(scope, ROTATE_PATH).fetch({
    headers: new Headers({ host: 'host.ts.net:7259' }),
  })
  assert.equal(response.status, 200)

  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie !== null, '补发的 cookie 必须由 HTTP 头带走（放 body 里没用）')
  // cookie 名按 authority 派生：补错了 authority，浏览器会直接忽略。
  const expectedName = `dsh-auth-${createHash('sha256').update('host.ts.net:7259').digest('base64url')}`
  assert.ok(cookie.startsWith(`${expectedName}=`), `cookie 名必须对应发起请求的 authority，实际 ${cookie.slice(0, 40)}`)
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)

  // 补发的 cookie 必须是**新**密钥签的，否则它自己立刻又被吊销了。
  const value = cookie.slice(expectedName.length + 1).split(';')[0]
  const body = value.split('.')[1]
  const expected = createHmac('sha256', scope.store.connection.browserAuth.secret).update(body).digest('base64url')
  assert.equal(value.split('.')[2], expected, '补发的 cookie 必须用新密钥签名')

  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.revokesSessions, true)
  assert.equal(payload.stayedSignedIn, true)
  assert.equal('cookie' in payload, false, 'cookie 不该出现在 body 里')
})

test('拿不到 Host 头时不补发 cookie，但照样吊销（不静默降级成「没吊销」）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime)

  const response = await routeFor(scope, ROTATE_PATH).fetch({ headers: new Headers({}) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  const payload = await response.json()
  assert.equal(payload.revokesSessions, true)
  assert.equal(payload.stayedSignedIn, false)
  assert.equal(scope.credentialWrites.length, 1, '没有 Host 也要吊销会话')
})

test('credentials 写入没真正落地时明确失败，绝不假装成功', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret.toString('hex')
  // 模拟「写错键 / 被只读来源遮蔽」：modifyRecord 正常返回，但记录没变成我们要的。
  scope.credentials.modifyRecord = async () => ({
    kind: 'grant',
    payload: { version: 1, secret: Buffer.alloc(32, 9).toString('base64url') },
  })

  const persisted = []
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async (_s, v) => persisted.push(v) }),
    /没有写入成功/,
  )
  assert.equal(persisted.length, 0, '吊销失败就不该把新登录密钥写出去')
  assert.equal(
    scope.store.connection.browserAuth.secret.toString('hex'),
    before,
    '失败时不能改动活着的密钥',
  )
})

test('凭证写入抛错时，不装新路由也不写盘（顺序保证：先吊销，后换密钥）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  scope.credentials.modifyRecord = async () => {
    throw new Error('store unavailable')
  }

  const persisted = []
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async (_s, v) => persisted.push(v) }),
    /store unavailable/,
  )
  assert.equal(persisted.length, 0)
  assert.equal(scope.registered.length, 0, '失败时不该留下半装的新路由')
  assert.equal(runtime.state.loginPath, '/remote/OLD', '活状态不能变成半成品')
})

test('revokeSessionsOnRotate=false 时只换登录密钥，不碰会话（可选的老行为）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret.toString('hex')

  const result = await rotateLoginSecret(
    scope,
    { ...CONFIG, revokeSessionsOnRotate: false },
    runtime,
    noPersist,
    'host.ts.net:7259',
  )

  assert.equal(scope.credentialWrites.length, 0, '不该写会话记录')
  assert.equal(scope.store.connection.browserAuth.secret.toString('hex'), before, '不该动签名密钥')
  assert.equal(result.revokesSessions, false)
  assert.equal(result.stayedSignedIn, false)
  assert.match(result.loginPath, /^\/remote\/[A-Za-z0-9_-]{22,}$/, '登录密钥照常换')
})

test('状态端点会告诉客户端「换密钥会踢掉所有设备」', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.revokesSessions, true)

  const off = fakeScope()
  const offRuntime = readyRuntime(off)
  registerAdminRoutes(off, { ...CONFIG, revokeSessionsOnRotate: false }, offRuntime)
  const offBody = await (await routeFor(off, STATE_PATH).fetch()).json()
  assert.equal(offBody.revokesSessions, false)
})
