/**
 * 浏览器半边的测试：按 Web GUI 的真实方式加载发布的 bundle（桩模块表 + 桩 cordis
 * 上下文），再断言注册结果落在宿主真正拥有的插槽上。
 *
 * 这一半是宿主测试覆盖不到的，而且失败后果最重 —— 一个加载了却没注册自己 id 的
 * bundle 会让整个 Web boot 失败，所以单独在这里验。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { internals } from '../index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// 按 manifest 导出的那个确切路径读，这样发布布局一旦漂移，这个测试也会红。
const bundle = readFileSync(join(root, 'client', 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** React 桩：够跑 `createElement` 和模块体（注册期间从不渲染）。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/**
 * 一个够用的迷你渲染器。
 *
 * 为什么不用上面那个一次性的桩：那一行**先渲染「正在读取」再渲染链接**，
 * 而「链接真的显示出来了」正是这一行唯一值得断言的事。只渲染首帧的话，
 * 测到的是 loading 文案，真正的功能一行都没验。
 *
 * 实现的是这个组件用到的那个子集：useState 带真实的 setter、useEffect 按依赖
 * 数组决定要不要重跑、useCallback/useRef/useMemo 保持引用。渲染是同步递归的，
 * 状态更新后立即重渲染（React 会批处理，这里不需要）。
 */
function createRenderer() {
  let hooks = []
  let cursor = 0
  let scheduled = false
  let renderFn = null

  /** 深比较依赖数组（长度和每个元素）。 */
  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (value) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: value }
      return hooks[index]
    },
    useState: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const hook = hooks[index]
      const setter = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        if (!scheduled) {
          scheduled = true
          // 同步重渲染；组件里没有跨 await 的竞态需要模拟。
          queueMicrotask(() => {
            scheduled = false
            if (renderFn !== null) renderFn()
          })
        }
      }
      return [hook.value, setter]
    },
    useCallback: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useMemo: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { value: fn(), deps }
      return hooks[index].value
    },
    useEffect: (effect, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      previous?.cleanup?.()
      // 同步跑 effect。React 的时机是「渲染后」，这里在渲染中就跑了 —— 对这个
      // 组件没区别（它的 effect 只启动异步 fetch 和挂监听，不 setState）。
      hooks[index] = { deps, cleanup: effect() }
    },
  }

  return {
    React,
    /**
     * 渲染一次组件。
     * @param component - 要渲染的函数组件。
     * @param props - 传给组件的 props。
     * @returns 渲染结果（React 元素树）。
     */
    render(component, props) {
      cursor = 0
      renderFn = () => this.render(component, props)
      return component(props)
    },
    /** 让所有已排队的微任务（含 setState 触发的重渲染）落地。 */
    async flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    },
    /** 卸载：跑所有 cleanup。 */
    unmount() {
      for (const hook of hooks) hook?.cleanup?.()
      hooks = []
      cursor = 0
    },
  }
}

/**
 * 把 bundle 装进桩环境。
 * @param overrides - 追加/覆盖的 `window`、`document`、`navigator`、`locale`、`fetch`。
 * @returns `{ loaded, registrations, ctx, exports, renderer, calls }`。
 */
function loadBundle(overrides = {}) {
  const registrations = []
  const calls = []
  let loaded = null
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '', style: {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    execCommand: () => true,
    ...(overrides.document ?? {}),
  }
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry
      },
    },
    location: { origin: 'http://127.0.0.1:19387' },
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(overrides.window ?? {}),
  }
  const renderer = createRenderer()
  const require = (id) => {
    if (id === 'react') return renderer.React
    throw new Error(`unexpected module request: ${id}`)
  }
  const fetchImpl =
    overrides.fetch === undefined
      ? async (path, options) => {
          calls.push({ path, options })
          return {
            status: 200,
            json: async () => ({
              ok: true,
              phase: 'ready',
              canRotate: true,
              loginUrl: 'https://host.ts.net:7259/remote/SECRET',
              plainUrl: 'https://host.ts.net:7259/',
              cookieMaxAgeDays: 3650,
            }),
          }
        }
      : // 自定义 fetch 也照样记一遍：不记的话「点按钮有没有打到端点」就测不出来了。
        async (path, options) => {
          calls.push({ path, options })
          return overrides.fetch(path, options)
        }
  const run = new Function('window', 'document', 'navigator', 'globalThis', 'fetch', bundle)
  run(
    window,
    document,
    overrides.navigator ?? {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      language: 'zh-CN',
    },
    window,
    fetchImpl,
  )
  assert.notEqual(loaded, null, 'bundle 必须调用 window.__ModuleLoader__.load')

  const moduleExports = loaded.factory(require)
  assert.equal(typeof moduleExports, 'object')

  const slots = {
    inject: (name, register) => {
      registrations.push({ kind: 'slots.inject', name, register })
    },
    register: (definition, component) => {
      registrations.push({ kind: 'slots.register', definition, component })
    },
  }
  const store = { slots }
  if (overrides.locale !== null) {
    store.locale = overrides.locale ?? {
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }),
      subscribe: () => () => {},
    }
  }
  const ctx = {
    ...store,
    // 动态包的 ctx 是 Proxy：直接读服务受 inject 门禁，`get` 不受。这里照抄。
    get: (name) => store[name],
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return { loaded, registrations, ctx, exports: moduleExports, renderer, calls }
}

/** 跑一遍 `apply` 并返回它产生的注册。 */
function applyAndCollect(overrides = {}) {
  const env = loadBundle(overrides)
  env.exports.apply(env.ctx)
  return env
}

/**
 * 把这一行渲染到「已加载」状态。
 *
 * 走完真实路径：apply → inject 回调 → register → 渲染首帧 → 等 fetch 落地 →
 * 重渲染。返回的元素树就是用户看到的那一帧。
 * @param overrides - 同 loadBundle。
 */
async function renderRow(overrides = {}) {
  const env = applyAndCollect(overrides)
  const inject = env.registrations.find((r) => r.kind === 'slots.inject')
  // inject 回调返回 disposer；这里手工触发一次，让 register 落地。
  inject.register()
  const registration = env.registrations.find((r) => r.kind === 'slots.register')
  const props = typeof registration.definition.inject === 'function' ? registration.definition.inject() : {}
  env.renderer.render(registration.component, props)
  await env.renderer.flush()
  const tree = env.renderer.render(registration.component, props)
  await env.renderer.flush()
  return { ...env, tree, registration, props }
}

describe('浏览器半边', () => {
  it('按 manifest 的名字注册（外壳就是按这个名字索引的）', () => {
    const { loaded } = loadBundle()
    assert.equal(loaded.id, manifest.name)
    assert.equal(typeof loaded.factory, 'function')
  })

  it('导出 apply 和 inject，并且 return 了 exports', () => {
    const { exports } = loadBundle()
    assert.equal(typeof exports.apply, 'function')
    assert.ok(Array.isArray(exports.inject))
    // 什么都不返回的 bundle 会让 Web boot 失败。
    assert.equal(typeof exports, 'object')
  })

  it('只硬依赖 slots，locale 走可选的 ctx.get', () => {
    const { exports } = loadBundle()
    // locale 写进 inject 会在它缺席时把整包 park 掉，所以只能硬依赖 slots。
    assert.deepEqual(exports.inject, ['slots'])
    assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-general'])
  })

  it('是合法 JavaScript 且是合法 UTF-8', () => {
    const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
    assert.equal(source.includes('\uFFFD'), false, 'bundle 里出现了 U+FFFD 替换字符')
    // 本机 PowerShell 往返读写会把 UTF-8 中文变成这些序列。
    assert.equal(/鐗|缃戦|鈥|锛|鍜|浣|绋/.test(source), false, 'bundle 里出现了乱码')
    assert.ok((source.match(/[\u4e00-\u9fff]/g) ?? []).length > 100, '中文文案缺失')
    // 解析才是真正的语法测试：上面的 loadBundle 只走到它执行到的那条路径。
    assert.doesNotThrow(() => new Function(source))
  })
})

describe('注册', () => {
  it('往「设置 → 通用」注册一行，id 用自己的', () => {
    const { registrations } = applyAndCollect()
    const inject = registrations.filter((r) => r.kind === 'slots.inject')
    // 两处：设置页那一行（手机链接）+ 侧边栏底部的完整模式开关。
    assert.equal(inject.length, 2)
    assert.deepEqual(inject.map((r) => r.name).sort(), ['settings.general.item', 'sidebar.footer.action'])
    assert.equal(inject[0].name, 'settings.general.item', '这一行的座位就是通用设置的行插槽')

    // register 只在 inject 回调里发生 —— 这正是「插槽还没声明时不要硬注册」的写法。
    assert.equal(registrations.filter((r) => r.kind === 'slots.register').length, 0, 'apply 阶段不该直接注册')

    inject[0].register()
    const registers = registrations.filter((r) => r.kind === 'slots.register')
    assert.equal(registers.length, 1, 'inject 回调被调用时只注册一行')
    const definition = registers[0].definition
    assert.equal(definition.name, 'settings.general.item')
    assert.equal(definition.id, 'dsh-tailscale-remote', '用自己的 id，不要占用宿主那几行的 id')
    assert.equal(typeof definition.order, 'number')
    // 排在 current-version(100) 之前，别顶到最下面去。
    assert.ok(definition.order < 100, 'order 必须小于 current-version 的 100')
    assert.ok(definition.order > 30, 'order 要排在 performance-usage(30) 之后')
  })

  it('底部开关注册到 sidebar.footer.action（精简页面上它顶替被藏掉的设置入口）', () => {
    const { registrations } = applyAndCollect()
    const inject = registrations.filter((r) => r.kind === 'slots.inject')
    const footer = inject.find((r) => r.name === 'sidebar.footer.action')
    assert.ok(footer !== undefined, '必须注册到侧边栏底部那个插槽')

    footer.register()
    const registration = registrations.find(
      (r) => r.kind === 'slots.register' && r.definition.name === 'sidebar.footer.action',
    )
    assert.ok(registration !== undefined)
    assert.equal(registration.definition.id, 'dsh-tailscale-remote', '用自己的 id')
    assert.equal(typeof registration.component, 'function')
    assert.equal(typeof registration.definition.inject, 'function', '要靠 inject 面把 ctx 递进去')
  })

  it('注册的不是宿主已有的任何一行', () => {
    const { registrations } = applyAndCollect()
    registrations.find((r) => r.kind === 'slots.inject').register()
    const id = registrations.find((r) => r.kind === 'slots.register').definition.id
    // 这些是宿主自己占掉的 id（见 ui-settings-general / ui-theme 的注册）。
    for (const taken of ['developer-tools', 'current-version', 'appearance', 'font-size', 'permission', 'language']) {
      assert.notEqual(id, taken, `id ${taken} 是宿主的，占用会替换掉那一行`)
    }
  })

  it('组件是函数，并且通过 inject 面拿到 ctx（插槽的 standard props 里没有它）', () => {
    const { registrations } = applyAndCollect()
    registrations.find((r) => r.kind === 'slots.inject').register()
    const registration = registrations.find((r) => r.kind === 'slots.register')
    assert.equal(typeof registration.component, 'function')
    assert.equal(typeof registration.definition.inject, 'function', '必须靠 inject 面把 ctx 递进去')
    const props = registration.definition.inject()
    assert.equal(typeof props.ctx, 'object')
    assert.equal(typeof props.ctx.get, 'function')
  })
})

describe('渲染出来的一行', () => {
  /** 从渲染结果里收集所有字符串。 */
  function stringsOf(node, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string') {
      out.push(node)
      return out
    }
    if (Array.isArray(node)) {
      for (const child of node) stringsOf(child, out)
      return out
    }
    if (typeof node === 'object' && node.children !== undefined) {
      stringsOf(node.children, out)
      return out
    }
    return out
  }

  /** 深度找所有满足谓词的节点。 */
  function find(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const child of node) find(child, predicate, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) find(node.children, predicate, out)
    return out
  }

  const ZH_LOCALE = { getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }), subscribe: () => () => {} }
  const EN_LOCALE = { getSnapshot: () => ({ active: 'en', locales: [], revision: 1 }), subscribe: () => () => {} }

  it('取到状态后把手机登录链接显示在只读输入框里', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE })
    const inputs = find(tree, (node) => node.type === 'input')
    assert.equal(inputs.length, 1, '就一个链接框')
    assert.equal(inputs[0].props.readOnly, true)
    assert.equal(inputs[0].props.value, 'https://host.ts.net:7259/remote/SECRET')
  })

  it('只请求这一个状态端点，且带同源凭据', async () => {
    const { calls } = await renderRow({ locale: ZH_LOCALE })
    assert.equal(calls.length, 1, '挂载时只取一次状态（不轮询）')
    assert.equal(calls[0].path, '/api/dsh-tailscale-remote/state')
    assert.equal(calls[0].options.credentials, 'same-origin')
  })

  it('中文环境下给中文，不出现字面量 key', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('手机连接'), '标题必须是中文')
    assert.ok(text.includes('手机登录链接'), '要有链接那一行的标签')
    assert.ok(text.includes('更换密钥'), '要有更换密钥的入口')
    // 字面量 key 泄漏是最典型的 i18n bug（兜底表漏键时会直接把 key 显示出来）。
    assert.equal(/\b(row|label|title|description|copy|rotate)\.[a-zA-Z]/.test(text), false, '文案里出现了字面量 key')
    assert.equal(text.includes('undefined'), false, '文案里出现了 undefined')
  })

  it('英文环境下给英文', async () => {
    const { tree } = await renderRow({ locale: EN_LOCALE })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('Phone access'), '标题必须是英文')
    assert.ok(text.includes('Change key'), '要有更换密钥的入口')
    assert.equal(/[\u4e00-\u9fff]/.test(text), false, '英文环境下不该出现中文')
  })

  it('拿不到 locale 服务时按浏览器语言兜底（而不是崩掉或显示 key）', async () => {
    const { tree } = await renderRow({ locale: null, navigator: { language: 'zh-CN', userAgent: 'x' } })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('手机连接'), 'navigator.language=zh-CN 时应当说中文')
    assert.equal(text.includes('undefined'), false)
  })

  it('拿不到 locale 服务且浏览器是英文时说英文', async () => {
    const { tree } = await renderRow({ locale: null, navigator: { language: 'en-US', userAgent: 'x' } })
    assert.ok(stringsOf(tree).join('\n').includes('Phone access'))
  })

  // —— 精简模式那一段 ——————————————————————————————————————————————————————

  /** 状态端点带精简字段的桩；同时应答 lite 切换端点（有状态地跟着翻转）。 */
  const liteFetch = (lite, overrides = {}) => {
    let current = lite
    return async (path, options) => {
      if (path === '/api/dsh-tailscale-remote/lite') {
        current = JSON.parse(options.body).enabled
        return { status: 200, json: async () => ({ ok: true, lite: current }) }
      }
      if (path !== '/api/dsh-tailscale-remote/state') throw new Error(`unexpected ${path}`)
      return {
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'ready',
          canRotate: true,
          loginUrl: 'https://host.ts.net:7259/remote/SECRET',
          plainUrl: 'https://host.ts.net:7259/',
          cookieMaxAgeDays: 3650,
          liteAvailable: true,
          lite: current,
          liteChoice: current,
          liteDefault: true,
          liteCount: 35,
          litePreloadRemoved: 2,
          ...overrides,
        }),
      }
    }
  }

  it('精简开关**不再**出现在设置页那一行里（用户要求只在 Remote 端那处）', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE, fetch: liteFetch(true) })
    const text = stringsOf(tree).join('\n')
    // 设置行只负责手机链接与换密钥；精简模式那一段已经移走。
    assert.equal(text.includes('精简模式'), false, '设置行里不该再有精简模式那一段')
    assert.ok(text.includes('手机连接'), '手机链接那一行还在')
    assert.ok(text.includes('更换密钥'), '换密钥还在')
  })

  it('绝不用 emoji 当图标（DSH 的图标语言里没有 emoji）', () => {
    const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
    assert.equal(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(source),
      false,
      'bundle 里出现了 emoji 码点',
    )
  })

  it('客户端写死的三个路径与宿主注册的逐字一致', () => {
    // 两半各存一份路径表，这是刻意的（bundle 不能 import 宿主代码）。代价是漂移
    // 会**静默**失败：前端 fetch 一个没人注册的路径，得到 404，界面上只显示
    // 「HTTP 404」，看不出是路径写错了。所以这里显式把两份钉在一起。
    assert.ok(bundle.includes(`'${internals.STATE_PATH}'`), `bundle 里必须出现 ${internals.STATE_PATH}`)
    assert.ok(bundle.includes(`'${internals.ROTATE_PATH}'`), `bundle 里必须出现 ${internals.ROTATE_PATH}`)
    assert.ok(bundle.includes(`'${internals.LITE_PATH}'`), `bundle 里必须出现 ${internals.LITE_PATH}`)
  })

  it('三个路径都在 /api 前缀下（否则会绕过 DSH 的 fence 与鉴权）', () => {
    for (const path of [internals.STATE_PATH, internals.ROTATE_PATH, internals.LITE_PATH]) {
      assert.ok(path.startsWith('/api/'), `${path} 必须在 /api 下`)
      // 照抄 connection 的 endpointFromPath：剥掉 `/api/` 之后按 `/` 切，
      // 每个 segment 都不能是空、`.` 或 `..`（否则注册时直接抛错）。
      const endpoint = path.slice('/api/'.length)
      assert.notEqual(endpoint, '')
      for (const segment of endpoint.split('/')) {
        assert.equal(['', '.', '..'].includes(segment), false, `${path} 的 segment ${JSON.stringify(segment)} 非法`)
        assert.match(segment, /^[A-Za-z0-9_$.-]+$/, `${path} 的 segment 含非法字符`)
      }
    }
  })
})

describe('底部那个精简/完整开关图标', () => {
  function findAll(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, predicate, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) findAll(node.children, predicate, out)
    return out
  }
  function textOf(node, out = []) {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach((c) => textOf(c, out))
    else if (node !== null && typeof node === 'object' && node.children !== undefined) textOf(node.children, out)
    return out
  }

  /** 按 DSH 图标规范断言一棵 svg 子树。 */
  function assertDshIcon(svg) {
    assert.equal(svg.props.width, 16, '按 DSH 图标规范用 16')
    assert.equal(svg.props.height, 16)
    assert.equal(svg.props.viewBox, '0 0 16 16')
    assert.equal(svg.props.fill, 'none')
    assert.equal(svg.props['aria-hidden'], 'true')
    assert.equal(typeof svg.props.strokeWidth, 'number')
    for (const path of [].concat(svg.children ?? [])) {
      if (path?.type !== 'path') continue
      assert.equal(path.props.stroke, 'currentColor', '每条 path 用 currentColor')
      assert.equal(path.props.strokeWidth, undefined, 'strokeWidth 不能写在 path 上')
    }
  }

  /** 渲染出那个底部图标。`state` 覆盖状态端点返回的 lite 字段，`extraProps` 是插槽 owner props。 */
  async function renderIcon(overrides = {}) {
    const liteState = overrides.state ?? { lite: true, liteAvailable: true }
    const fetchImpl = async (path) => {
      if (path === '/api/dsh-tailscale-remote/state') {
        return { status: 200, json: async () => ({ ok: true, liteCount: 30, ...liteState }) }
      }
      return { status: 200, json: async () => ({ ok: true, lite: liteState.lite }) }
    }
    // 注意：state/extraProps 是本辅助函数自己的参数，不能透给 applyAndCollect。
    const { state: _ignoredState, extraProps, ...rest } = overrides
    void _ignoredState
    const { registrations, renderer } = applyAndCollect({ ...rest, fetch: fetchImpl })
    const footer = registrations
      .filter((r) => r.kind === 'slots.inject')
      .find((r) => r.name === 'sidebar.footer.action')
    footer.register()
    const registration = registrations.find(
      (r) => r.kind === 'slots.register' && r.definition.name === 'sidebar.footer.action',
    )
    assert.ok(registration !== undefined, '必须先注册到底部插槽')
    // 插槽 owner 真正会传下来的 props（ui-sidebar 的 renderSlot(..., { wide })）。
    const props = { ...registration.definition.inject(), ...(extraProps ?? { wide: true }) }
    renderer.render(registration.component, props)
    await renderer.flush()
    const tree = renderer.render(registration.component, props)
    await renderer.flush()
    return tree
  }

  it('画的是 16×16 SVG 图标，没有可见文字（用户要求这一处用图标）', async () => {
    const tree = await renderIcon({ window: { __DSH_TAILSCALE_REMOTE_LITE__: 'lite' }, extraProps: { wide: true } })
    const buttons = findAll(tree, (node) => node.type === 'button')
    assert.equal(buttons.length, 1, '应当渲染出一个图标按钮')
    const button = buttons[0]
    assert.equal(textOf(button).join('').trim(), '', '按钮里不该有可见文字')

    // 按钮里挂的是图标组件节点（h(LiteSwitchIcon)），夹具不展开函数组件，
    // 所以按组件引用确认「这里是一个图标而不是文字」，再把组件本身渲一次断言 SVG。
    const child = [].concat(button.children ?? [])[0]
    assert.equal(typeof child?.type, 'function', '按钮里必须是图标组件，不是文本')

    // 真渲一次图标组件，按 DSH 图标规范逐条断言。
    const renderer2 = applyAndCollect({}).renderer
    const svg = renderer2.render(child.type, child.props)
    assert.equal(svg.type, 'svg')
    assertDshIcon(svg)

    // 无障碍文字走 aria-label / title。
    assert.ok(typeof button.props['aria-label'] === 'string' && button.props['aria-label'].length > 0)
    assert.ok(typeof button.props.title === 'string' && button.props.title.length > 0)
  })

  it('**完整模式页面里也要有**（否则切过去就再也切不回来了）', async () => {
    // window 上**没有** LITE 标记 = 完整版页面；lite 状态是 false。
    const tree = await renderIcon({
      window: {},
      extraProps: { wide: true },
      state: { lite: false, liteAvailable: true },
    })
    const buttons = findAll(tree, (node) => node.type === 'button')
    assert.equal(buttons.length, 1, '完整版页面上必须也有这个图标，否则没有切回精简版的入口')

    // 按钮语义要跟着走：完整模式下点它是「切至精简模式」。
    const button = buttons[0]
    const label = button.props['aria-label']
    assert.ok(label.includes('精简'), `完整模式的按钮应说切至精简，实际：${label}`)
    assert.equal(textOf(button).join('').trim(), '', '仍然不该有可见文字')
  })

  it('侧边栏收起（wide=false）时只有头像，不渲染这个图标', async () => {
    const tree = await renderIcon({ window: { __DSH_TAILSCALE_REMOTE_LITE__: 'lite' }, extraProps: { wide: false } })
    assert.equal(findAll(tree, (node) => node.type === 'button').length, 0, '收起态不该有图标')
  })
})
describe('换密钥', () => {
  const ZH_LOCALE = { getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }), subscribe: () => () => {} }

  function find(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const child of node) find(child, predicate, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) find(node.children, predicate, out)
    return out
  }

  /** 按可见文字找按钮。 */
  function buttonWith(tree, label) {
    return find(tree, (node) => node.type === 'button' && node.children.includes(label))[0]
  }

  it('先要一次确认，确认后才真的 POST（换密钥会让旧链接失效）', async () => {
    const { tree, renderer, registration, props, calls } = await renderRow({ locale: ZH_LOCALE })

    const trigger = buttonWith(tree, '更换密钥')
    assert.ok(trigger !== undefined, '要有「更换密钥」按钮')
    assert.equal(trigger.props.disabled, false, '就绪状态下按钮可用')
    trigger.props.onClick()
    await renderer.flush()

    // 第一次点击只进入确认态，绝不发请求。
    assert.equal(calls.length, 1, '点第一下不能就换了')

    const afterConfirm = renderer.render(registration.component, props)
    await renderer.flush()
    assert.ok(buttonWith(afterConfirm, '确认更换') !== undefined, '要出现确认按钮')
    assert.ok(buttonWith(afterConfirm, '取消') !== undefined, '要能取消')

    buttonWith(afterConfirm, '确认更换').props.onClick()
    await renderer.flush()

    const rotateCall = calls.find((c) => c.path === '/api/dsh-tailscale-remote/rotate')
    assert.ok(rotateCall !== undefined, '确认后必须 POST 那个端点')
    assert.equal(rotateCall.options.method, 'POST')
  })

  it('取消不发请求', async () => {
    const { tree, renderer, registration, props, calls } = await renderRow({ locale: ZH_LOCALE })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const afterConfirm = renderer.render(registration.component, props)
    await renderer.flush()
    buttonWith(afterConfirm, '取消').props.onClick()
    await renderer.flush()
    assert.equal(calls.filter((c) => c.path.endsWith('/rotate')).length, 0, '取消不能发请求')
  })

  it('canRotate=false 时按钮是禁用的（没就绪 / 登录入口关了）', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'starting',
          canRotate: false,
          loginUrl: null,
          plainUrl: null,
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    const trigger = buttonWith(tree, '更换密钥')
    assert.ok(trigger !== undefined)
    assert.equal(trigger.props.disabled, true, '没就绪就不该允许换密钥')
    // 没就绪时要说清楚现在到哪一步了，而不是显示一个空链接框。
    const inputs = find(tree, (node) => node.type === 'input')
    assert.equal(inputs[0].props.value, '')
  })

  it('换密钥失败时把原因显示出来（不是静默失败）', async () => {
    let rotated = false
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async (path) => {
        if (path.endsWith('/rotate')) {
          rotated = true
          return { status: 409, json: async () => ({ ok: false, error: '远程访问还没就绪，稍后再试' }) }
        }
        return {
          status: 200,
          json: async () => ({
            ok: true,
            phase: 'ready',
            canRotate: true,
            loginUrl: 'https://host.ts.net:7259/remote/OLD',
            plainUrl: 'https://host.ts.net:7259/',
            cookieMaxAgeDays: 3650,
          }),
        }
      },
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    buttonWith(renderer.render(registration.component, props), '确认更换').props.onClick()
    await renderer.flush()
    assert.equal(rotated, true)

    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('远程访问还没就绪'), `失败原因必须显示出来，实际是：${text}`)
  })

  it('拿不到状态端点时给出错误和重试，而不是空界面', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({ status: 500, json: async () => ({ ok: false, error: 'boom' }) }),
    })
    const alerts = find(tree, (node) => node.props?.role === 'alert')
    assert.equal(alerts.length, 1, '必须有 role=alert 的错误区')
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(alerts[0]).join(' ')
    assert.ok(text.includes('boom'), '要把真正的原因显示出来')
    assert.ok(text.includes('重试'), '要能重试')
  })

  it('非 200 但 body 是 JSON 时，用的是 body 里的原因（不拿状态码覆盖原文）', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({ status: 503, json: async () => ({ ok: false, error: '还没起来' }) }),
    })
    const alerts = find(tree, (node) => node.props?.role === 'alert')
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(alerts[0]).join(' ')
    assert.ok(text.includes('还没起来'), `应当用 body 里的 error，实际：${text}`)
    assert.equal(text.includes('503'), false, '不该拿状态码覆盖掉真正的原因')
  })

  /**
   * 换密钥的警告文案必须跟着**实际行为**走。
   *
   * 这是最容易变成谎言的一处：默认行为是连会话一起吊销（所有设备退出），
   * 如果文案还写着「已经登录的设备不受影响」，用户就会以为只是换个链接，
   * 结果手机被踢下线还不知道为什么。
   */
  it('revokesSessions=true 时，警告明说所有设备都会退出', async () => {
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'ready',
          canRotate: true,
          revokesSessions: true,
          loginUrl: 'https://host.ts.net:7259/remote/OLD',
          plainUrl: 'https://host.ts.net:7259/',
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('所有已登录的设备都会退出'), `警告必须说清后果，实际：${text}`)
    assert.equal(text.includes('不受影响'), false, '不能同时说「不受影响」——那是反的')
  })

  it('revokesSessions=false 时才说「已登录的设备不受影响」', async () => {
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'ready',
          canRotate: true,
          revokesSessions: false,
          loginUrl: 'https://host.ts.net:7259/remote/OLD',
          plainUrl: 'https://host.ts.net:7259/',
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('不受影响'), `实际：${text}`)
    assert.equal(text.includes('所有已登录的设备都会退出'), false)
  })
})

describe('桌面端一个字节都不准动', () => {
  it('桌面窗口（有 dshDesktopBoot）里**原有的设置条目照旧注册**', () => {
    // `dshDesktopBoot` 只由 Electron preload 用 contextBridge 注入；有它 = 桌面窗口。
    // 关键：设置页那一行（手机连接 + 换密钥）是这个插件**原本就有**的功能，
    // 「精简模式只在远程端」绝不能把它连带删掉 —— 那是删掉既有功能，不是「不加字节」。
    const { registrations } = applyAndCollect({ window: { dshDesktopBoot: { ready: async () => ({}) } } })
    const injects = registrations.filter((r) => r.kind === 'slots.inject')
    assert.equal(injects.length, 1, '桌面里只注册设置页那一行')
    assert.equal(injects[0].name, 'settings.general.item', '桌面也必须保留手机连接那一行')
  })

  it('桌面窗口里**不注册**精简模式图标（那是新增的，只在远程端）', () => {
    const { registrations } = applyAndCollect({ window: { dshDesktopBoot: { ready: async () => ({}) } } })
    const footer = registrations.filter((r) => r.kind === 'slots.inject').find((r) => r.name === 'sidebar.footer.action')
    assert.equal(footer, undefined, '桌面窗口里不该有那个图标')
  })

  it('手机页面（没有 dshDesktopBoot）里照常注册', () => {
    const { registrations } = applyAndCollect({ window: {} })
    const injects = registrations.filter((r) => r.kind === 'slots.inject')
    assert.equal(injects.length, 2, '手机页面上要注册设置行 + 底部图标')
  })


})
