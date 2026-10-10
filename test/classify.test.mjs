// 用 node --test 跑：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { internals } from '../index.js'

const { classifyServe, normalizeConfig, dnsNameOf, resolveDshHome } = internals

const PORT = 7259
const TARGET = 'http://127.0.0.1:19387'

/** 造一份 serve status，authority 用 tailnet 主机名。 */
function statusWith(proxy, { authority = `host.ts.net:${PORT}`, extraPaths = null, tcp = undefined } = {}) {
  const handlers = extraPaths ?? { '/': { Proxy: proxy } }
  return {
    Web: { [authority]: { Handlers: handlers } },
    ...(tcp === undefined ? { TCP: { [String(PORT)]: { HTTPS: true } } } : { TCP: tcp }),
  }
}

test('空配置 → absent', () => {
  assert.equal(classifyServe(undefined, PORT, TARGET).kind, 'absent')
  assert.equal(classifyServe({}, PORT, TARGET).kind, 'absent')
  assert.equal(classifyServe({ Web: {}, TCP: {} }, PORT, TARGET).kind, 'absent')
})

test('已在代理我们的目标 → exact（不动手）', () => {
  const state = classifyServe(statusWith(TARGET), PORT, TARGET)
  assert.equal(state.kind, 'exact')
  assert.equal(state.authority, `host.ts.net:${PORT}`)
})

test('尾部斜杠不同的同一目标也算 exact（否则会撤掉自己没建的路由）', () => {
  // tailscale 自己写回来的形态可能带尾斜杠；不归一化就会被误判成 stale，
  // 于是把这条路由记成"本次新建"，退出时把它撤掉。
  const state = classifyServe(statusWith(`${TARGET}/`), PORT, TARGET)
  assert.equal(state.kind, 'exact')
})

test('陈旧路由（指向别的回环端口）→ stale，可以接管', () => {
  const state = classifyServe(statusWith('http://127.0.0.1:3080'), PORT, TARGET)
  assert.equal(state.kind, 'stale')
  assert.equal(state.previousProxy, 'http://127.0.0.1:3080')
})

test('指向别处（非回环）→ conflict，绝不覆盖', () => {
  const state = classifyServe(statusWith('http://192.168.1.50:8080'), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('根路径之外还有其它处理程序 → conflict', () => {
  const state = classifyServe(statusWith(TARGET, { extraPaths: { '/': { Proxy: TARGET }, '/api': { Proxy: TARGET } } }), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('根处理程序不是反向代理 → conflict', () => {
  const state = classifyServe(statusWith(undefined, { extraPaths: { '/': { Text: 'hi' } } }), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('端口被 TCP 占用但无 Web 处理程序 → conflict', () => {
  const state = classifyServe({ Web: {}, TCP: { [String(PORT)]: { HTTPS: true } } }, PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('端口上的 Web 处理程序属于另一个 authority → 仍按代理目标判定', () => {
  const status = {
    Web: { 'other.ts.net:7259': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
    TCP: { [String(PORT)]: { HTTPS: true } },
  }
  // 另一个 authority 占着同一个端口，但指向别处的回环地址：可以接管。
  const state = classifyServe(status, PORT, TARGET)
  assert.equal(state.kind, 'stale')
  assert.equal(state.authority, 'other.ts.net:7259')
})

test('端口上的 Web 处理程序属于另一个 authority 且指向外部 → conflict', () => {
  const status = {
    Web: { 'other.ts.net:7259': { Handlers: { '/': { Proxy: 'http://10.0.0.9:80' } } } },
    TCP: { [String(PORT)]: { HTTPS: true } },
  }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'conflict')
})

test('别的端口上的配置不影响我们', () => {
  const status = {
    Web: { 'host.ts.net:9527': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9527' } } } },
    TCP: { '9527': { HTTPS: true } },
  }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'absent')
})

test('Handlers 不是对象 → conflict', () => {
  const status = { Web: { [`host.ts.net:${PORT}`]: { Handlers: null } }, TCP: {} }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'conflict')
})

test('config 归一化：坏端口回落 7259，显式关掉的开关保留', () => {
  const c = normalizeConfig({ httpsPort: 'abc', serveOnStart: false })
  assert.equal(c.httpsPort, 7259)
  assert.equal(c.serveOnStart, false)
  assert.equal(c.enabled, true)
})

test('config 归一化：enabled:false 与自定义端口', () => {
  const c = normalizeConfig({ enabled: false, httpsPort: 8443 })
  assert.equal(c.enabled, false)
  assert.equal(c.httpsPort, 8443)
})

test('config 归一化：越界端口回落默认值', () => {
  assert.equal(normalizeConfig({ httpsPort: 70000 }).httpsPort, 7259)
  assert.equal(normalizeConfig({ httpsPort: -1 }).httpsPort, 7259)
  assert.equal(normalizeConfig({ httpsPort: 0 }).httpsPort, 7259)
})

test('config 归一化：null/非对象入参不炸', () => {
  assert.equal(normalizeConfig(null).httpsPort, 7259)
  assert.equal(normalizeConfig(undefined).enabled, true)
  assert.equal(normalizeConfig('nonsense').enabled, true)
})

test('DNS 名去尾部点并小写', () => {
  assert.equal(dnsNameOf({ Self: { DNSName: 'Ckarefulon.Beardie-Tet.Ts.Net.' } }), 'ckarefulon.beardie-tet.ts.net')
  assert.equal(dnsNameOf({ Self: {} }), undefined)
  assert.equal(dnsNameOf(undefined), undefined)
})

test('DSH home 解析：显式配置优先，其次 $DSH_HOME', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\env-home'
    assert.equal(resolveDshHome('C:\\explicit'), 'C:\\explicit')
    assert.equal(resolveDshHome(undefined), 'C:\\env-home')
    assert.equal(resolveDshHome('   '), 'C:\\env-home', '纯空白视为未设')
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('DSH home 解析：$DSH_HOME 缺失时回落 ~/.dsh（Host 进程里通常没有这个变量）', () => {
  const original = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    const home = resolveDshHome(undefined)
    // 这条断言是为了钉住一个真实 bug：只读 process.env.DSH_HOME 会让状态文件永远写不出来。
    assert.ok(home.endsWith('.dsh'), `应回落到 ~/.dsh，实际得到 ${home}`)
    assert.ok(home.length > '.dsh'.length, '必须是绝对路径而不是裸的相对名')
  } finally {
    if (original !== undefined) process.env.DSH_HOME = original
  }
})

test('DSH home 解析：$DSH_HOME 为空串时也回落', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '   '
    assert.ok(resolveDshHome(undefined).endsWith('.dsh'))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})
