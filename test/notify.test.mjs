// 状态通知的行为测试。
//
// 这一层最容易出的是「静默坏掉」：通知不弹，用户只会以为手机没响，不会去看日志。
// 所以这里盯三件事 ——
//   1. **哪些结束方式算通知、哪些不算**（自己按停止不该弹，子代理不该弹）；
//   2. **游标语义**（页面刚打开不许把历史重弹一遍，离开久了不许一次全弹）；
//   3. **审批链不被通知拖垮**（我们的监听器是 waterfall 里的一环，抛了就是把人挡在门外）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { internals } from '../index.js'

const {
  classifyTurnEnd,
  createNotifier,
  notifyPayload,
  registerAdminRoutes,
  freshRuntime,
  NOTIFY_EVENTS_MAX,
  NOTIFY_EVENT_TTL_MS,
  NOTIFY_DEDUPE_MS,
  NOTIFY_FEED_PATH,
  NOTIFY_PATH,
} = internals

const CONFIG = {
  enabled: true,
  notify: true,
  httpsPort: 7259,
  loginRoute: true,
  cookieMaxAgeDays: 3650,
  revokeSessionsOnRotate: true,
  stateFile: undefined,
}

function configOf(overrides = {}) {
  return { ...CONFIG, ...overrides }
}

/**
 * 造一个能记监听器、能按需回答服务的 scope。
 * @param live - `sessionId → Session` 的活表（`ctx.sessions`）。
 */
function fakeScope({ live = new Map(), titles = true } = {}) {
  const listeners = new Map()
  const scope = {
    listeners,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name, handler) => {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(handler)
        if (at !== -1) list.splice(at, 1)
      }
    },
    get: (name) => {
      if (name === 'sessions') return { get: (id) => live.get(id) }
      if (name === 'sessionTitle') return titles ? { get: (session) => ({ title: `标题-${String(session.id)}` }) } : undefined
      return undefined
    },
    effect: (fn) => fn(),
  }
  return scope
}

/** 发一次事件（emit 模式）。 */
function emit(scope, name, ...args) {
  for (const handler of scope.listeners.get(name) ?? []) handler(...args)
}

/** 一个 Session 形状（只需要 `id` 与 `header`，宿主那半边就是这么判活的）。 */
function sessionOf(id, header = {}) {
  return { id, header: { id, ...header } }
}

/** `turn/end` 事件夹具。 */
function turnEnd(reason) {
  return { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason } }
}

/** 临时把 Date.now 钉住，好在去重 / 过期这类时间逻辑上写确定性的断言。 */
function withClock(fn) {
  const original = Date.now
  let now = 1_000_000
  Date.now = () => now
  const clock = { advance: (ms) => { now += ms } }
  try {
    return fn(clock)
  } finally {
    Date.now = original
  }
}

test('turn/end 的归类：completed → 🟢，error → 🔴，其余一律不发', () => {
  assert.deepEqual(classifyTurnEnd({ kind: 'completed' }), { kind: 'done', detail: undefined })
  assert.deepEqual(classifyTurnEnd({ kind: 'error', error: { message: 'connection reset' } }), {
    kind: 'error',
    detail: 'connection reset',
  })
  // 用户自己按的停止、上下文截断、被策略挡下、以及畸形输入：都不该吵用户。
  assert.equal(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), undefined)
  assert.equal(classifyTurnEnd({ kind: 'interrupted' }), undefined)
  assert.equal(classifyTurnEnd({ kind: 'max-tokens' }), undefined)
  assert.equal(classifyTurnEnd({ kind: 'blocked' }), undefined)
  assert.equal(classifyTurnEnd(undefined), undefined)
  assert.equal(classifyTurnEnd('completed'), undefined)
})

test('错误信息压成一行并截断（通知正文只有一两行的位置）', () => {
  assert.equal(internals.errorText({ message: 'a\n  b' }), 'a b')
  assert.equal(internals.errorText(''), undefined)
  assert.equal(internals.errorText(undefined), undefined)
  assert.equal(internals.errorText({ code: 'X' }), '{"code":"X"}')
  const long = internals.errorText('x'.repeat(400))
  assert.equal(long.length, 158, '超长错误必须截断（157 + 省略号）')
  assert.ok(long.endsWith('…'))
})

test('采集：三种状态各记一条，带上会话标题与附注', () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)

  notifier.record('done', live.get('s1'))
  notifier.record('question', { id: 's1' }, 'bash')
  notifier.record('error', 's1', 'boom')

  assert.deepEqual(
    runtime.notify.events.map((event) => [event.seq, event.kind, event.sessionId, event.sessionTitle, event.detail]),
    [
      [1, 'done', 's1', '标题-s1', undefined],
      [2, 'question', 's1', '标题-s1', 'bash'],
      [3, 'error', 's1', '标题-s1', 'boom'],
    ],
  )
  assert.equal(runtime.notify.seq, 3)
})

test('子代理会话一律不发（一次任务能开出几十个）', () => {
  const live = new Map([
    ['s1', sessionOf('s1', { origin: 'subagent' })],
    ['s2', sessionOf('s2', { parentSession: 's0' })],
  ])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)

  notifier.record('done', 's1')
  notifier.record('done', 's2')
  assert.equal(runtime.notify.events.length, 0)
})

test('总开关关掉时什么都不记（而且不占去重窗口）', () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  runtime.notifyEnabled = true
  const notifier = createNotifier(scope, configOf(), runtime)

  runtime.notifyEnabled = false
  assert.equal(notifier.record('done', 's1'), undefined)
  assert.equal(runtime.notify.events.length, 0)
  // 重新打开后第一次就该记：关闭期间不该把一个假的「刚发过」留在去重表里。
  runtime.notifyEnabled = true
  assert.ok(notifier.record('done', 's1') !== undefined)
})

test('配置里 notify=false 时整条链路都不存在', () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf({ notify: false }), runtime)
  assert.equal(notifier.record('done', 's1'), undefined)
  const dispose = notifier.attach()
  assert.equal(typeof dispose, 'function')
  // 连监听都不该挂：配置关掉时热路径上不该留我们的回调。
  assert.equal(scope.listeners.size, 0)
  dispose()
})

test('去重：同一会话同一类别在窗口内只发一条（错误常常两条链路各报一次）', () => {
  withClock((clock) => {
    const live = new Map([['s1', sessionOf('s1')]])
    const scope = fakeScope({ live })
    const runtime = freshRuntime({})
    const notifier = createNotifier(scope, configOf(), runtime)

    assert.ok(notifier.record('error', 's1', 'first') !== undefined)
    clock.advance(NOTIFY_DEDUPE_MS - 1)
    assert.equal(notifier.record('error', 's1', 'second'), undefined, '窗口内必须丢掉')
    clock.advance(2)
    assert.ok(notifier.record('error', 's1', 'third') !== undefined, '窗口过了要能再发')
    // 不同类别互不影响：同一会话的「完成」不该被「错误」挡住。
    assert.ok(notifier.record('done', 's1') !== undefined)
  })
})

test('缓冲有上限，超了就丢最旧的（游标只增不减）', () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)

  const kinds = ['done', 'question', 'error']
  // 每种会用掉自己的去重名额，所以交替着来、并推到窗口之外。
  withClock((clock) => {
    for (let i = 0; i < NOTIFY_EVENTS_MAX + 5; i += 1) {
      clock.advance(NOTIFY_DEDUPE_MS + 1)
      notifier.record(kinds[i % kinds.length], 's1', `d${String(i)}`)
    }
  })

  assert.equal(runtime.notify.events.length, NOTIFY_EVENTS_MAX)
  assert.equal(runtime.notify.seq, NOTIFY_EVENTS_MAX + 5)
  assert.equal(runtime.notify.events[0].seq, 6, '最旧的 5 条应该被挤出去')
})

test('过期事件不再发给客户端', () => {
  withClock((clock) => {
    const live = new Map([['s1', sessionOf('s1')]])
    const scope = fakeScope({ live })
    const runtime = freshRuntime({})
    const notifier = createNotifier(scope, configOf(), runtime)

    notifier.record('done', 's1')
    clock.advance(NOTIFY_EVENT_TTL_MS + 1)
    notifier.record('done', 's1')
    assert.equal(runtime.notify.events.length, 1, '过期那条必须被剪掉')
    assert.equal(runtime.notify.events[0].seq, 2)
  })
})

test('挂上四个监听：turn/end、api-session/error、审批、提问', () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)
  const dispose = notifier.attach()

  emit(scope, 'session/event', live.get('s1'), turnEnd({ kind: 'completed' }))
  // 与通知无关的事件类型一律不记（这条是热路径，多记一条就是噪音）。
  emit(scope, 'session/event', live.get('s1'), { type: 'step/start', data: {} })
  emit(scope, 'api-session/error', 's1', 'provider down')

  assert.deepEqual(
    runtime.notify.events.map((event) => event.kind),
    ['done', 'error'],
  )

  dispose()
  assert.equal(scope.listeners.get('session/event').length, 0, '拆除后不许再收事件')
})

test('fork / 恢复出来的旧事件不通知（否则启动那一刻弹一脸「会话完成」）', () => {
  const live = new Map([['s1', { id: 's1', header: { id: 's1' }, isOwnSeq: (seq) => seq >= 100 }]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  createNotifier(scope, configOf(), runtime).attach()

  // 序列 3 是继承来的；序列 120 才是本次进程里刚发生的。
  emit(scope, 'session/event', live.get('s1'), { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  assert.equal(runtime.notify.events.length, 0)
  emit(scope, 'session/event', live.get('s1'), { type: 'turn/end', seq: 120, data: { reason: { kind: 'completed' } } })
  assert.equal(runtime.notify.events.length, 1)
})

test('审批 / 提问是 waterfall：我们只旁听，必须原样把结果交回去', async () => {
  // 两条记录用不同会话：同会话同类别的第二条会被去重窗口挡掉（那是刻意的）。
  const live = new Map([
    ['s1', sessionOf('s1')],
    ['s2', sessionOf('s2')],
  ])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)
  notifier.attach()

  const approval = scope.listeners.get('approval/request')[0]
  const result = await approval({ agent: { id: 's1' }, toolName: 'bash' }, () => Promise.resolve('allowed-once'))
  assert.equal(result, 'allowed-once', '审批结果必须原样返回')
  assert.equal(runtime.notify.events[0].detail, 'bash')

  const question = scope.listeners.get('user-questions/request')[0]
  const answer = await question(
    { agent: { id: 's2' }, questions: [{ id: 'q', question: 'which?', header: '选一个' }] },
    () => Promise.resolve({ answers: [] }),
  )
  assert.deepEqual(answer, { answers: [] })
  assert.equal(runtime.notify.events[1].detail, '选一个')
})

test('监听器出问题也绝不断掉审批链', async () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  // 标题服务一读就抛：采集器必须自己吞掉，而不是让 next() 永不执行。
  scope.get = (name) => {
    if (name === 'sessions') return { get: (id) => live.get(id) }
    if (name === 'sessionTitle') throw new Error('boom')
    return undefined
  }
  const runtime = freshRuntime({})
  createNotifier(scope, configOf(), runtime).attach()

  const approval = scope.listeners.get('approval/request')[0]
  const result = await approval({ agent: { id: 's1' }, toolName: 'bash' }, () => Promise.resolve('rejected'))
  assert.equal(result, 'rejected')
})

test('feed 的游标语义：首次不回放、增量只给新的、落后太多就丢弃', () => {
  const live = new Map([['s1', sessionOf('s1')]])
  const scope = fakeScope({ live })
  const runtime = freshRuntime({})
  const notifier = createNotifier(scope, configOf(), runtime)
  withClock((clock) => {
    for (let i = 0; i < 5; i += 1) {
      clock.advance(NOTIFY_DEDUPE_MS + 1)
      notifier.record('done', 's1', `d${String(i)}`)
    }
  })

  // 不带 since：只给游标，页面刚打开不该把历史重弹一遍。
  const first = notifyPayload(configOf(), runtime, `${NOTIFY_FEED_PATH}`)
  assert.equal(first.cursor, 5)
  assert.deepEqual(first.events, [])
  assert.equal(first.notify, true)

  const incremental = notifyPayload(configOf(), runtime, `${NOTIFY_FEED_PATH}?since=3`)
  assert.deepEqual(
    incremental.events.map((event) => event.seq),
    [4, 5],
  )

  // 已经拿到最新：没有新事件。
  assert.deepEqual(notifyPayload(configOf(), runtime, `${NOTIFY_FEED_PATH}?since=5`).events, [])

  // 落后很多（手机锁屏一晚上回来，游标早就被挤出了缓冲）：只给游标，
  // 不把攒下的一口气全弹出来。
  runtime.notify.seq = NOTIFY_EVENTS_MAX * 4 + 10
  const far = notifyPayload(configOf(), runtime, `${NOTIFY_FEED_PATH}?since=0`)
  assert.equal(far.cursor, NOTIFY_EVENTS_MAX * 4 + 10)
  assert.deepEqual(far.events, [])
})

test('feed 的 notify 字段跟着两层开关走', () => {
  const runtime = freshRuntime({})
  assert.equal(notifyPayload(configOf(), runtime, NOTIFY_FEED_PATH).notify, true)
  runtime.notifyEnabled = false
  assert.equal(notifyPayload(configOf(), runtime, NOTIFY_FEED_PATH).notify, false)
  runtime.notifyEnabled = true
  assert.equal(notifyPayload(configOf({ notify: false }), runtime, NOTIFY_FEED_PATH).notify, false)
})

test('POST /notify：改总开关、清空缓冲、并写回状态文件', async () => {
  const scope = fakeScope()
  scope.store = {}
  const persisted = []
  // registerAdminRoutes 只用到 connection.fetch 与 effect。
  const fetchRoutes = []
  scope.get = (name) =>
    name === 'connection'
      ? {
          fetch: {
            register: (route) => {
              fetchRoutes.push(route)
              return async () => {}
            },
          },
        }
      : undefined
  scope.effect = (fn) => fn()

  const runtime = freshRuntime({})
  runtime.state = { plainUrl: 'https://host.ts.net:7259/', notify: true }
  const deps = { persistState: async (_scope, state) => persisted.push(state) }

  registerAdminRoutes(scope, configOf(), runtime, deps)

  const route = fetchRoutes.find((r) => r.path === NOTIFY_PATH)
  assert.ok(route !== undefined)

  const post = (body) =>
    route.fetch(
      new Request('http://x/api/dsh-tailscale-remote/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  runtime.notify.seq = 3
  runtime.notify.events.push({ seq: 3, kind: 'done', at: Date.now(), sessionId: 's1' })

  const off = await post({ enabled: false })
  assert.deepEqual(await off.json(), { ok: true, notify: false, persisted: true })
  assert.equal(runtime.notifyEnabled, false)
  assert.equal(runtime.notify.events.length, 0, '关闭时必须清空缓冲，别让重新打开时弹旧事')
  assert.equal(runtime.notify.seq, 3, '游标不回收')
  assert.equal(persisted.at(-1).notify, false)

  const on = await post({ enabled: true })
  assert.deepEqual(await on.json(), { ok: true, notify: true, persisted: true })
  assert.equal(persisted.at(-1).notify, true)

  const bad = await post({})
  assert.equal(bad.status, 400)
})

test('POST /notify：配置关掉时明确拒绝，不是静悄悄成功', async () => {
  const fetchRoutes = []
  const scope = {
    get: () => ({ fetch: { register: (route) => (fetchRoutes.push(route), async () => {}) } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const runtime = freshRuntime({})
  registerAdminRoutes(scope, configOf({ notify: false }), runtime, { persistState: async () => {} })

  const route = fetchRoutes.find((r) => r.path === NOTIFY_PATH)
  const response = await route.fetch(
    new Request('http://x/api/dsh-tailscale-remote/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }),
  )
  assert.equal(response.status, 409)
  assert.equal((await response.json()).ok, false)
})
