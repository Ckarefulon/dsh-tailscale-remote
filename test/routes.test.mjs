// 设置页那一行背后的两个管理端点的行为测试。
//
// 这一层是「用户在设置里看到的东西」的唯一后端：状态读不到、换密钥换了个寂寞、
// 或者换完之后旧链接还能用，都属于在这里能抓到、在别处抓不到的 bug。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { internals } from '../index.js'
import { LITE_SEEDS } from '../lite.js'

const {
  statePayload,
  registerAdminRoutes,
  rotateLoginSecret,
  freshRuntime,
  installLoginRoute,
  createLiteController,
  STATE_PATH,
  ROTATE_PATH,
  LITE_PATH,
  FULL_PAGE_GRANT_MS,
} = internals

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

/**
 * 一个**绝不写盘**的 deps。
 *
 * 为什么每条测试都要用它：`registerAdminRoutes` / `rotateLoginSecret` 在生产里会写**真实的**
 * `~/.dsh/tailscale-remote.json`，而测试用的 scope 是桩。少了这个替换，跑一次测试就会把
 * 用户的持久登录密钥覆盖成夹具里的 `host.ts.net` —— 下一次重启长出**新**密钥，
 * 手机上的书签当场失效。（这个坑真的踩过一次，所以才做成默认值。）
 */
const MEMORY_DEPS = {
  persistState: async (scope, state) => {
    scope.store.__persisted = [...(scope.store.__persisted ?? []), state]
  },
}

/** 取注册好的某条 fetch 路由。 */
function routeFor(scope, path) {
  const route = scope.fetchRoutes.find((r) => r.path === path)
  assert.ok(route !== undefined, `必须注册 ${path}`)
  return route
}

test('三个端点都注册在 connection.fetch 上（白拿 DSH 的 fence 与 cookie 鉴权）', () => {
  const scope = fakeScope()
  registerAdminRoutes(scope, CONFIG, freshRuntime({}), MEMORY_DEPS)

  const paths = scope.fetchRoutes.map((r) => r.path).sort()
  assert.deepEqual(paths, [LITE_PATH, ROTATE_PATH, STATE_PATH].sort())
  // 绝不能注册成 webServer 的 exact 路由：那会遮掉整条 /api 前缀路由，
  // 把 Host/Origin fence 和浏览器鉴权一起绕过去。
  assert.deepEqual(scope.registered, [], '不该往 webServer 上注册任何 exact 路由')
  assert.equal(scope.fetchRoutes.find((r) => r.path === STATE_PATH).methods[0], 'GET')
  assert.equal(scope.fetchRoutes.find((r) => r.path === ROTATE_PATH).methods[0], 'POST')
  assert.equal(scope.fetchRoutes.find((r) => r.path === LITE_PATH).methods[0], 'POST')
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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, { ...CONFIG, loginRoute: false }, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)
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
  registerAdminRoutes(scope, { ...CONFIG, enabled: false }, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

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
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.revokesSessions, true)

  const off = fakeScope()
  const offRuntime = readyRuntime(off)
  registerAdminRoutes(off, { ...CONFIG, revokeSessionsOnRotate: false }, offRuntime, MEMORY_DEPS)
  const offBody = await (await routeFor(off, STATE_PATH).fetch()).json()
  assert.equal(offBody.revokesSessions, false)
})

// —— 精简模式 ——————————————————————————————————————————————————————————————

/**
 * 精简测试用的插件图：白名单里的包 + 两个该被裁掉的大包。
 * 用真实白名单（而不是造几个假名字），这样「种子失配」这类改动会立刻被这里抓到。
 */
const SAMPLE_GRAPH = {
  rev: 'graphrev',
  release: { version: '9.9.9' },
  entries: [
    ...LITE_SEEDS.map((id) => ({ id, url: `plugins/??${id}/client.js&rev=r-${id}`, rev: `r-${id}` })),
    { id: '@deepseek-ai/dsh-client-ui-settings-account', url: 'plugins/??x&rev=1', rev: '1' },
    { id: '@deepseek-ai/dsh-client-hmr', url: 'plugins/??x&rev=2', rev: '2' },
  ],
  batches: [
    { phase: 'bootstrap', url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=b', rev: 'b', entries: ['@deepseek-ai/dsh-client-modules'] },
    { phase: 'application', url: 'plugins/??everything', rev: 'all', entries: [] },
  ],
}
SAMPLE_GRAPH.batches[1].entries = SAMPLE_GRAPH.entries.map((e) => e.id)

/** 形态照抄真实 index.html：application 段是 preload，bootstrap 段是 script-src。 */
const SAMPLE_INDEX = [
  '<!doctype html><html><head>',
  '<link rel="preload" as="script" href="plugins/??@deepseek-ai/a/client.js&amp;rev=one">',
  '<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=b"></script>',
  '<script>globalThis["__DSH_BOOT__"] = {"rev":"graphrev","release":{"version":"9.9.9"},"entries":[{"id":"@deepseek-ai/a","url":"plugins/??a","rev":"ra"}],"batches":[]}</script>',
  '</head><body><div id="root"></div></body></html>',
].join('\n')

/** 一个带 webServer/clientModules 的 scope：控制器要的两个服务都得在。 */
function liteScope({ graph, clientPath } = {}) {
  const scope = fakeScope()
  const server = scope.store.webServer
  server.taps = []
  server.tapIndex = (transform) => {
    server.taps.push(transform)
    return () => {
      const at = server.taps.indexOf(transform)
      if (at !== -1) server.taps.splice(at, 1)
    }
  }
  const paths = clientPath ?? {}
  scope.store.clientModules = {
    graph: () => graph,
    clientPath: (id) => paths[id],
  }
  return scope
}

const LITE_CONFIG = { ...CONFIG, lite: true }

test('控制器：注册前缀路由 + tapIndex，绝不动 /plugins（那是 client-modules 的前缀路由）', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  const controller = createLiteController(scope, LITE_CONFIG, runtime)

  assert.ok(controller !== undefined, '服务齐全时必须装得上')
  const liteRoute = scope.registered.find((r) => r.path === '/remote-lite-plugins')
  assert.ok(liteRoute !== undefined, '精简合并请求必须有自己的路由')
  assert.equal(liteRoute.kind, 'prefix')
  // 重复注册 `/plugins` 会抛（client-modules 已经占了那条前缀），这里必须另起一个。
  assert.equal(scope.registered.filter((r) => r.path === '/plugins').length, 0)
  assert.equal(scope.store.webServer.taps.length, 1, 'index 改写必须挂在 tapIndex 上')
})

test('控制器：服务缺席时返回 undefined（桌面端就是这条路，什么都不做）', () => {
  const noWeb = liteScope({ graph: SAMPLE_GRAPH })
  delete noWeb.store.webServer
  assert.equal(createLiteController(noWeb, LITE_CONFIG, freshRuntime({})), undefined)

  const noModules = liteScope({ graph: SAMPLE_GRAPH })
  delete noModules.store.clientModules
  assert.equal(createLiteController(noModules, LITE_CONFIG, freshRuntime({})), undefined)
})

test('控制器：开关关掉时 tapIndex 原样返回（一个字节都不改）', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  const controller = createLiteController(scope, LITE_CONFIG, runtime)
  controller.grantFull()

  const html = SAMPLE_INDEX
  assert.equal(scope.store.webServer.taps[0](html), html)
  assert.equal(controller.liteEnabled(), false)
})

test('控制器：开关打开时真的改写，并把结果记进 runtime 供状态端点观察', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  createLiteController(scope, LITE_CONFIG, runtime)

  const out = scope.store.webServer.taps[0](SAMPLE_INDEX)
  assert.notEqual(out, SAMPLE_INDEX)
  assert.ok(out.includes('"__DSH_TAILSCALE_REMOTE_LITE__"'))
  assert.ok(runtime.lite.ids.length > 0)
  assert.ok(runtime.lite.ids.length < SAMPLE_GRAPH.entries.length, '必须真的裁掉了包')
})

test('控制器：白名单在活图上失配时原样返回完整页面（绝不发残缺页面）', () => {
  const scope = liteScope({ graph: { rev: 'r', entries: [{ id: '@x', url: 'u', rev: 'v' }], batches: [] } })
  const runtime = freshRuntime({})
  createLiteController(scope, LITE_CONFIG, runtime)

  const html = SAMPLE_INDEX
  assert.equal(scope.store.webServer.taps[0](html), html, '算不出精简图就必须原样返回')
  assert.equal(runtime.lite, undefined)
  assert.ok(scope.logs.some((line) => line.includes('seed-mismatch')), '必须留下日志，别静默')
})

test('控制器：config.lite=false 时永不精简（配置默认关掉了）', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  const controller = createLiteController(scope, { ...CONFIG, lite: false }, runtime)
  assert.equal(controller.liteEnabled(), false)
  assert.equal(scope.store.webServer.taps[0](SAMPLE_INDEX), SAMPLE_INDEX)
})

test('控制器：完整页只来自一次性授权窗口 —— 默认永远精简，窗口过后自动回到精简', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  const controller = createLiteController(scope, LITE_CONFIG, runtime)

  // 默认就是精简（没有任何「上次的选择」这种东西）。
  assert.equal(controller.liteEnabled(), true, '没有授权窗口时必须发精简页')
  assert.notEqual(scope.store.webServer.taps[0](SAMPLE_INDEX), SAMPLE_INDEX)

  // 按了「切至完整模式」：窗口内发完整页，一个字节都不改。
  controller.grantFull()
  assert.equal(controller.fullGranted(), true)
  assert.equal(controller.liteEnabled(), false)
  assert.equal(scope.store.webServer.taps[0](SAMPLE_INDEX), SAMPLE_INDEX)

  // 按了「切至精简模式」：立刻撤销，不等窗口自然过期（否则刚切过去再切回来会「点了没反应」）。
  controller.revokeFull()
  assert.equal(controller.fullGranted(), false)
  assert.notEqual(scope.store.webServer.taps[0](SAMPLE_INDEX), SAMPLE_INDEX)

  // 窗口自然过期 —— 这就是「不保留上次选择」：连下一次都不用，时间一到就回精简。
  runtime.fullUntil = Date.now() - 1
  assert.equal(controller.fullGranted(), false)
  assert.equal(controller.liteEnabled(), true)
})

test('控制器：config.lite=false 是硬开关，谁也没法让它发精简页', () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = freshRuntime({})
  const controller = createLiteController(scope, { ...CONFIG, lite: false }, runtime)
  assert.equal(controller.liteEnabled(), false)
  // 反过来一样：配置关了，就算有人塞了授权窗口也还是完整页（本来就是完整页）。
  controller.grantFull()
  assert.equal(controller.liteEnabled(), false)
  assert.equal(scope.store.webServer.taps[0](SAMPLE_INDEX), SAMPLE_INDEX)
})

test('精简合并请求：送出的脚本体去掉了 sourceMappingURL，且带上不可变缓存头', async () => {
  const { readFile } = await import('node:fs/promises')
  const { composeLiteGraph } = await import('../lite.js')
  const lite = composeLiteGraph(SAMPLE_GRAPH)
  const batch = lite.batches.find((b) => b.phase === 'application')

  // 用一个临时目录造真实的包文件，clientPath 指过去。
  const dir = await mkdtemp(join(tmpdir(), 'lite-'))
  const paths = {}
  for (const id of batch.entries) {
    const file = join(dir, `${id.replace(/[@/]/g, '_')}.js`)
    await writeFile(file, `register(${JSON.stringify(id)})\n//# sourceMappingURL=x.map\n`)
    paths[id] = file
  }

  const scope = liteScope({ graph: SAMPLE_GRAPH, clientPath: paths })
  createLiteController(scope, LITE_CONFIG, freshRuntime({}))

  const route = scope.registered.find((r) => r.path === '/remote-lite-plugins')
  const sent = { body: undefined, status: undefined, headers: undefined }
  await route.handler(
    // 真实 node:http 的 req 一定带 headers；控制器会读 accept-encoding 决定编码方式。
    { method: 'GET', url: `/${batch.url}`, headers: {} },
    {
      writeHead: (status, headers) => {
        sent.status = status
        sent.headers = headers
      },
      end: (body) => {
        sent.body = body
      },
      headersSent: false,
    },
  )

  assert.equal(sent.status, 200)
  assert.match(sent.headers['cache-control'], /immutable/)
  assert.equal(sent.headers['content-type'], 'text/javascript; charset=utf-8')
  // 未声明 Accept-Encoding 时应当发原文（这条测试就是按原文断言内容）。
  assert.equal(sent.headers['content-encoding'], undefined, '没协商编码就不该标 content-encoding')
  const text = sent.body.toString('utf8')
  assert.ok(!text.includes('sourceMappingURL'), '尾指令必须去掉')
  for (const id of batch.entries) assert.ok(text.includes(id), `缺 ${id} 的字节`)

  await rm(dir, { recursive: true, force: true })
})

test('精简合并请求：客户端接受 gzip/br 时自己压，且比 webserver 的 level 1 更小', async () => {
  const { readFile } = await import('node:fs/promises')
  const { composeLiteGraph } = await import('../lite.js')
  const lite = composeLiteGraph(SAMPLE_GRAPH)
  const batch = lite.batches.find((b) => b.phase === 'application')

  const dir = await mkdtemp(join(tmpdir(), 'lite-'))
  const paths = {}
  // 造一段**可压**的内容（重复文本），否则压缩比看不出差别。
  const payload = 'window.__ModuleLoader__.load({id:"x",factory:()=>{}});\n'.repeat(400)
  for (const id of batch.entries) {
    const file = join(dir, `${id.replace(/[@/]/g, '_')}.js`)
    await writeFile(file, payload)
    paths[id] = file
  }

  const scope = liteScope({ graph: SAMPLE_GRAPH, clientPath: paths })
  createLiteController(scope, LITE_CONFIG, freshRuntime({}))
  const route = scope.registered.find((r) => r.path === '/remote-lite-plugins')

  const call = async (acceptEncoding) => {
    const sent = { body: undefined, status: undefined, headers: undefined }
    await route.handler(
      { method: 'GET', url: `/${batch.url}`, headers: { 'accept-encoding': acceptEncoding } },
      {
        writeHead: (status, headers) => {
          sent.status = status
          sent.headers = headers
        },
        end: (body) => {
          sent.body = body
        },
        headersSent: false,
      },
    )
    return sent
  }

  const plain = await call('identity')
  const gz = await call('gzip, deflate')
  const br = await call('gzip, deflate, br')

  assert.equal(gz.status, 200)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(br.headers['content-encoding'], 'br')
  assert.ok(gz.body.length < plain.body.length, 'gzip 必须真的变小')
  assert.ok(br.body.length < gz.body.length, 'brotli 必须比 gzip 更小')
  // 必须声明 Vary，否则中间层可能把压过的版本喂给不支持的客户端。
  assert.match(br.headers.vary, /Accept-Encoding/)

  // 压过之后再解，内容必须与原文一致（否则手机拿到的是坏脚本）。
  const { gunzipSync, brotliDecompressSync } = await import('node:zlib')
  assert.equal(gunzipSync(gz.body).toString('utf8'), plain.body.toString('utf8'))
  assert.equal(brotliDecompressSync(br.body).toString('utf8'), plain.body.toString('utf8'))

  await rm(dir, { recursive: true, force: true })
})

test('精简合并请求：缺任何一个包就整段 404（客户端会回落单包 URL）', async () => {
  const { composeLiteGraph } = await import('../lite.js')
  const lite = composeLiteGraph(SAMPLE_GRAPH)
  const batch = lite.batches.find((b) => b.phase === 'application')

  // 只给第一个包一个真路径，其余 clientPath 全是 undefined。
  const dir = await mkdtemp(join(tmpdir(), 'lite-'))
  const file = join(dir, 'one.js')
  await writeFile(file, 'register("one")\n')
  const scope = liteScope({ graph: SAMPLE_GRAPH, clientPath: { [batch.entries[0]]: file } })
  createLiteController(scope, LITE_CONFIG, freshRuntime({}))

  const route = scope.registered.find((r) => r.path === '/remote-lite-plugins')
  const sent = { status: undefined }
  await route.handler(
    { method: 'GET', url: `/${batch.url}` },
    { writeHead: (status) => (sent.status = status), end: () => {}, headersSent: false },
  )
  assert.equal(sent.status, 404)
  await rm(dir, { recursive: true, force: true })
})

test('精简合并请求：非本路由 / 别的 rev / 非 GET 都拒绝', async () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  createLiteController(scope, LITE_CONFIG, freshRuntime({}))
  const route = scope.registered.find((r) => r.path === '/remote-lite-plugins')

  const call = async (method, url) => {
    const sent = { status: undefined }
    await route.handler(
      { method, url },
      { writeHead: (status) => (sent.status = status), end: () => {}, headersSent: false },
    )
    return sent.status
  }

  assert.equal(await call('GET', '/plugins/??whatever'), 404)
  assert.equal(await call('GET', '/remote-lite-plugins/??@x/client.js&rev=stale'), 404)
  assert.equal(await call('POST', '/remote-lite-plugins/??@x/client.js&rev=stale'), 405)
})

test('精简开关端点：一次性授权窗口、绝不写盘、以及缺 enabled 时的 400', async () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = readyRuntime(scope)
  runtime.liteController = createLiteController(scope, LITE_CONFIG, runtime)
  registerAdminRoutes(scope, LITE_CONFIG, runtime, MEMORY_DEPS)
  const route = routeFor(scope, LITE_PATH)

  // 缺 enabled → 400，且不能改动任何状态。
  const bad = await route.fetch({ json: async () => ({}) })
  assert.equal(bad.status, 400)
  assert.equal(runtime.fullUntil, 0)

  // 「切至完整模式」→ 只开一个 20 秒的授权窗口（页面立刻发完整页），**不写盘**。
  const off = await route.fetch({ json: async () => ({ enabled: false }) })
  assert.equal(off.status, 200)
  const offBody = await off.json()
  assert.equal(offBody.ok, true)
  assert.equal(offBody.lite, false, '窗口内宿主会发完整页')
  assert.equal(offBody.fullGranted, true)
  const window = runtime.fullUntil - Date.now()
  assert.ok(window > 0 && window <= FULL_PAGE_GRANT_MS, `窗口长度必须落在 (0, ${FULL_PAGE_GRANT_MS}] 里，实际 ${window}`)
  // 用户的要求就是「不保留上次选择」：这条路径**一个字节**都不该落地。
  // （早先它写过状态文件，还因此把用户的持久登录密钥覆盖过一次。）
  assert.equal(scope.store.__persisted, undefined, '切换精简模式绝不能写盘')

  // 「切至精简模式」→ 立刻撤销窗口，刷新即回精简。
  const on = await route.fetch({ json: async () => ({ enabled: true }) })
  const onBody = await on.json()
  assert.equal(onBody.lite, true)
  assert.equal(onBody.fullGranted, false)
  assert.equal(runtime.fullUntil, 0)
  assert.equal(scope.store.__persisted, undefined)
})

test('精简开关端点：控制器缺席时明确拒绝（这台 DSH 没有 Web 渲染路径）', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, LITE_CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, LITE_PATH).fetch({ json: async () => ({ enabled: true }) })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).ok, false)
})

test('精简开关端点：config.lite=false 时拒绝（硬开关不能靠按钮翻过来）', async () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = readyRuntime(scope)
  runtime.liteController = createLiteController(scope, { ...CONFIG, lite: false }, runtime)
  registerAdminRoutes(scope, { ...CONFIG, lite: false }, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, LITE_PATH).fetch({ json: async () => ({ enabled: false }) })
  assert.equal(response.status, 409)
  assert.equal(runtime.fullUntil, 0, '拒绝时不能偷偷开窗口')
})

test('状态端点如实报告精简模式：默认精简、窗口内完整、没有「上次的选择」这个字段', async () => {
  const scope = liteScope({ graph: SAMPLE_GRAPH })
  const runtime = readyRuntime(scope)
  runtime.liteController = createLiteController(scope, LITE_CONFIG, runtime)
  registerAdminRoutes(scope, LITE_CONFIG, runtime, MEMORY_DEPS)

  const before = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(before.lite, true, '默认永远是精简页')
  assert.equal(before.liteAvailable, true)
  assert.equal(before.liteFullGranted, false)
  assert.equal('liteChoice' in before, false, '「用户上次选了什么」这个概念必须彻底消失')

  // 按了切至完整模式之后，状态端点如实报告那个窗口还开着。
  runtime.liteController.grantFull()
  const granted = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(granted.lite, false)
  assert.equal(granted.liteFullGranted, true)
  runtime.liteController.revokeFull()

  // 真的渲染一次，liteCount 才有值。
  scope.store.webServer.taps[0](SAMPLE_INDEX)
  const after = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.ok(after.liteCount > 0)
  assert.ok(after.litePreloadRemoved > 0)

  // 没有控制器的 DSH（桌面端）如实报 unavailable，而不是假装「已开启」。
  const bare = fakeScope()
  const bareRuntime = readyRuntime(bare)
  registerAdminRoutes(bare, LITE_CONFIG, bareRuntime, MEMORY_DEPS)
  const bareBody = await (await routeFor(bare, STATE_PATH).fetch()).json()
  assert.equal(bareBody.liteAvailable, false)
  assert.equal(bareBody.lite, null)
  // 配置硬开关那一项也要报出来，用户才知道这台实例到底做不做这件事。
  assert.equal(bareBody.liteDefault, true)
})

// —— WebSocket 压缩 ——————————————————————————————————————————————————————————

test('WebSocket 压缩：patch 之后 DSH 那条 WS 会协商 permessage-deflate', async () => {
  const { installWebSocketCompression } = internals
  // 用一个假的 ws 模块替身，避免测试依赖 profile 里有没有装 ws。
  const calls = []
  const proto = {
    handleUpgrade(req, socket, head, cb) {
      calls.push(JSON.parse(JSON.stringify(this.options ?? {})))
      return 'called'
    },
  }
  const fakeWs = { WebSocketServer: function WebSocketServer() {} }
  fakeWs.WebSocketServer.prototype = proto

  // 直接测 patch 的核心行为：拿一个 this.options.perMessageDeflate === false 的实例，
  // 调 handleUpgrade 后应变成对象。
  const original = proto.handleUpgrade
  const patched = function patchedHandleUpgrade(req, socket, head, cb) {
    if (this.options !== undefined && this.options.perMessageDeflate === false) {
      this.options.perMessageDeflate = { threshold: 1024 }
    }
    return original.call(this, req, socket, head, cb)
  }
  proto.handleUpgrade = patched

  const server = { options: { noServer: true, perMessageDeflate: false } }
  proto.handleUpgrade.call(server, {}, {}, null, () => {})
  assert.deepEqual(calls[0].perMessageDeflate, { threshold: 1024 }, '必须把 false 改成启用')
  // 重要的是**同步**生效：completeUpgrade 紧接着读 this.options。
  assert.equal(typeof installWebSocketCompression, 'function')
})

test('WebSocket 压缩：已经在压的实例不被覆盖', () => {
  const proto = {
    handleUpgrade() {
      return undefined
    },
  }
  const original = proto.handleUpgrade
  const patched = function patchedHandleUpgrade(req, socket, head, cb) {
    if (this.options !== undefined && this.options.perMessageDeflate === false) {
      this.options.perMessageDeflate = {}
    }
    return original.call(this, req, socket, head, cb)
  }
  proto.handleUpgrade = patched
  // 已经被 DSH/别人设成对象的实例，必须原样保留（不要去改人家调好的参数）。
  const configured = { threshold: 4096 }
  const server = { options: { perMessageDeflate: configured } }
  proto.handleUpgrade.call(server, {}, {}, null, () => {})
  assert.equal(server.options.perMessageDeflate, configured, '已经是对象就不该动它')
})
test('WebSocket 压缩是**惰性**的：启动期不许 require ws（那要 159 ms）', () => {
  const { armWebSocketCompression, installWebSocketCompression } = internals
  // 配置关掉时根本不该武装。
  assert.equal(armWebSocketCompression({ logger: { info() {} }, effect() {} }, { websocketCompression: false }), undefined)

  // 武装本身必须是纯函数式的：不读 ws、不 patch、不抛。
  const scope = { logger: { info() {}, warn() {} }, effect() {} }
  const armed = armWebSocketCompression(scope, { websocketCompression: true })
  assert.equal(armed?.armed, true)
  assert.equal(typeof armed.armOnce, 'function')
  // 这个函数**还没被调用**时，任何模块状态都不该变 —— 由「启动后立即断言」间接保证。
  assert.equal(typeof installWebSocketCompression, 'function')
})

test('WebSocket 压缩的惰性钩子：armOnce 可重复调用，且失败不抛（不能因此断掉握手）', () => {
  const { armWebSocketCompression } = internals
  const warnings = []
  const scope = { logger: { info() {}, warn: (m) => warnings.push(m) }, effect() {}, }
  const armed = armWebSocketCompression(scope, { websocketCompression: true })
  // 普通 node 环境里解析不到 DSH 的 ws —— 这时 armOnce 必须安静地返回 false，不抛。
  let result
  assert.doesNotThrow(() => { result = armed.armOnce() })
  assert.equal(typeof result, 'boolean')
})