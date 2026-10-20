// 精简模式纯逻辑的测试。
//
// 这一层的赌注比别处都高：改写失败会发一个**残缺页面**给手机，而用户在手机上
// 没有任何自救手段（没有 DevTools、没法装插件、连不上别的界面）。所以这里既要验
// 「正常路径真的裁掉了东西」，也要验「任何一个前置条件不满足时都原样发完整页面」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LITE_HIDE,
  LITE_MARKER,
  LITE_REQUIRED,
  LITE_ROUTE,
  LITE_SEEDS,
  composeComboBody,
  composeLiteGraph,
  encodeComboBody,
  matchLiteRequest,
  rewriteIndex,
  stripClientSuffix,
} from '../lite.js'

/** 造一个够真的插件图：id/url/rev 齐备，可以带 inject 与 external 边。 */
function graphOf(rows, batches) {
  return {
    rev: 'graphrev',
    release: { version: '9.9.9' },
    entries: rows.map((row) => ({
      id: row.id,
      url: `plugins/??${row.id}/client.js&rev=rev-${row.id}`,
      rev: `rev-${row.id}`,
      ...(row.inject === undefined ? {} : { inject: row.inject }),
      ...(row.external === undefined ? {} : { external: row.external }),
    })),
    batches: batches ?? [
      { phase: 'bootstrap', url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=b', rev: 'b', entries: ['@deepseek-ai/dsh-client-modules'] },
      { phase: 'application', url: 'plugins/??everything', rev: 'all', entries: rows.map((row) => row.id) },
    ],
  }
}

/** 一个「每个保留包都在，另有一个该被裁掉的大包」的图，最后一条是被裁的目标。 */
function sampleGraph() {
  const rows = LITE_SEEDS.map((id) => ({ id }))
  rows.push({ id: '@deepseek-ai/dsh-client-ui-settings-account' })
  rows.push({ id: '@deepseek-ai/dsh-client-hmr', inject: [] })
  return graphOf(rows)
}

test('闭包：种子只拉必需的一串，裁掉白名单外的包', () => {
  const full = sampleGraph()
  const lite = composeLiteGraph(full)
  assert.ok(lite !== undefined, '样本图里 LITE_REQUIRED 齐全，应该能精简')

  assert.ok(lite.ids.includes('@deepseek-ai/dsh-client-ui-chat'))
  assert.ok(lite.ids.includes('dsh-tailscale-remote'))
  // 2.4 MB 的账号插画包必须被裁掉 —— 它正是整个改动的动机。
  assert.ok(!lite.ids.includes('@deepseek-ai/dsh-client-ui-settings-account'))
  // client-hmr 绝不能留：它会把整图推回页面，把裁掉的包全部重新拉一遍。
  assert.ok(!lite.ids.includes('@deepseek-ai/dsh-client-hmr'))
})

test('闭包跟着 inject 边传递（依赖会被自动带上，无需手工维护种子）', () => {
  const full = graphOf([
    ...LITE_REQUIRED.map((id) => ({ id })),
    { id: '@deepseek-ai/dsh-client-ui-chat', inject: ['@deepseek-ai/dsh-client-ui-settings'] },
    { id: '@deepseek-ai/dsh-client-ui-settings', inject: ['@deepseek-ai/dsh-whoever'] },
    { id: '@deepseek-ai/dsh-whoever' },
    { id: '@deepseek-ai/dsh-unwanted' },
  ])
  const lite = composeLiteGraph(full, { seeds: ['@deepseek-ai/dsh-client-ui-chat'] })
  assert.ok(lite.ids.includes('@deepseek-ai/dsh-whoever'), 'inject 的依赖必须被带上')
  assert.ok(!lite.ids.includes('@deepseek-ai/dsh-unwanted'))
})

test('闭包跟着 external 边传递（同步 require 的依赖也必须带上）', () => {
  const full = graphOf([
    ...LITE_REQUIRED.map((id) => ({ id })),
    { id: '@deepseek-ai/dsh-api-session-controller', external: ['@deepseek-ai/dsh-api-gateway/client'] },
    { id: '@deepseek-ai/dsh-api-gateway' },
    { id: '@deepseek-ai/dsh-unwanted' },
  ])
  const lite = composeLiteGraph(full, { seeds: ['@deepseek-ai/dsh-api-session-controller'] })
  assert.ok(lite.ids.includes('@deepseek-ai/dsh-api-gateway'), 'external 的依赖必须被带上')
  assert.ok(!lite.ids.includes('@deepseek-ai/dsh-unwanted'))
})

test('行序照抄整图，从而保持整图的拓扑序', () => {
  const full = sampleGraph()
  const lite = composeLiteGraph(full)
  const fullOrder = full.entries.map((e) => e.id).filter((id) => lite.ids.includes(id))
  assert.deepEqual(lite.ids, fullOrder)
})

test('必需包缺席时返回 undefined（宁可用完整页面，也不发残缺页面）', () => {
  for (const missing of LITE_REQUIRED) {
    const full = graphOf([...LITE_SEEDS.filter((id) => id !== missing).map((id) => ({ id })), { id: '@deepseek-ai/dsh-extra' }])
    assert.equal(
      composeLiteGraph(full),
      undefined,
      `少了 ${missing} 必须整体放弃精简`,
    )
  }
})

test('畸形输入一律 undefined，绝不抛', () => {
  assert.equal(composeLiteGraph(null), undefined)
  assert.equal(composeLiteGraph('nope'), undefined)
  assert.equal(composeLiteGraph({ entries: [], batches: [] }), undefined)
  assert.equal(composeLiteGraph({ entries: LITE_SEEDS.map((id) => ({ id })), batches: 'not-an-array' }), undefined)
})

test('每一段都是 application，且每个保留包恰好属于一段', () => {
  const lite = composeLiteGraph(sampleGraph())
  const appBatches = lite.batches.filter((b) => b.phase === 'application')
  assert.ok(appBatches.length > 0)

  const seen = []
  for (const batch of lite.batches) {
    assert.ok(batch.entries.length > 0, '空段会让客户端的 manifest 解析抛')
    for (const id of batch.entries) {
      assert.ok(!seen.includes(id), `${id} 不能同时属于两段`)
      seen.push(id)
    }
  }
  assert.deepEqual(seen.sort(), [...lite.ids].sort(), '每个保留包都必须落在某一段里')
})

test('合并请求 URL 与 matchLiteRequest 能对上（路径里带 ?? 与 rev）', () => {
  const lite = composeLiteGraph(sampleGraph())
  for (const batch of lite.batches.filter((b) => b.phase === 'application')) {
    assert.ok(batch.url.startsWith(`${LITE_ROUTE.slice(1)}/??`), `URL 形态不对：${batch.url}`)
    assert.ok(batch.url.includes('&rev='), '缺 rev 会让客户端拿不到包')
    // 必须按整个 URL（含查询）比：只用 pathname 的话每一段的 pathname 都是 "/"。
    const matched = matchLiteRequest(`/${batch.url}`, lite)
    assert.ok(matched !== undefined, `必须能解析自己的 URL：/${batch.url}`)
    assert.deepEqual(matched.entries, batch.entries)
  }
})

test('matchLiteRequest 拒绝别的路由、别的 rev、以及不要的路径', () => {
  const lite = composeLiteGraph(sampleGraph())
  const batch = lite.batches.find((b) => b.phase === 'application')

  assert.equal(matchLiteRequest('/plugins/??something', lite), undefined)
  assert.equal(matchLiteRequest(`/${batch.url.replace(/rev=[^&]+/, 'rev=stale')}`, lite), undefined)
  assert.equal(matchLiteRequest('/', lite), undefined)
  assert.equal(matchLiteRequest(undefined, lite), undefined)
  assert.equal(matchLiteRequest(`/${batch.url}`, undefined), undefined)
})

test('每段 URL 都不超过 DSH 的 3 KiB 上限', () => {
  // 用最多的种子（IC 长度最坏情况）逼出分段逻辑。
  const full = graphOf([...LITE_SEEDS, ...LITE_SEEDS.map((id) => `${id}-padding-${'x'.repeat(40)}`)].map((id) => ({ id })))
  const lite = composeLiteGraph(full)
  assert.ok(lite !== undefined)
  for (const batch of lite.batches) {
    // 与 client-modules 同口径：按带 .map 的最长形态算。
    const worst = Buffer.byteLength(`plugins/${batch.url.slice(LITE_ROUTE.length - 1)}.map`)
    assert.ok(worst <= 3 * 1024, `段太长：${batch.url.length} 字节`)
  }
})

test('rev 跟着成员变化，缓存不会串味', () => {
  const appBatch = (lite) => lite.batches.find((b) => b.phase === 'application')
  const a = composeLiteGraph(graphOf([...LITE_SEEDS.map((id) => ({ id })), { id: '@deepseek-ai/a' }]))
  const b = composeLiteGraph(graphOf([...LITE_SEEDS.map((id) => ({ id })), { id: '@deepseek-ai/a' }]))
  assert.ok(a !== undefined)
  // 同样的输入应当得到同样的 rev（否则每次渲染 index 都换 URL，缓存全废）。
  assert.equal(appBatch(a).rev, appBatch(b).rev)
  // 版本号一变 rev 必须变，否则浏览器会拿旧缓存里的旧包。
  const v2 = composeLiteGraph(graphOf([...LITE_SEEDS.map((id) => ({ id })), { id: '@deepseek-ai/a' }]), { version: 2 })
  assert.notEqual(appBatch(a).rev, appBatch(v2).rev)
})

test('stripClientSuffix 只剥末尾的 /client', () => {
  assert.equal(stripClientSuffix('@x/y/client'), '@x/y')
  assert.equal(stripClientSuffix('@x/y'), '@x/y')
  assert.equal(stripClientSuffix('@x/client-z'), '@x/client-z')
})

test('composeComboBody：逐字复刻 client-modules 的 buildComboScript 口径', () => {
  const body = composeComboBody([
    Buffer.from('register("a")\n//# sourceMappingURL=a.js.map\n'),
    Buffer.from('register("b")\n//# sourceURL=b.js'),
    Buffer.from('register("c")'),
  ]).toString('utf8')

  assert.ok(!body.includes('sourceMappingURL'), 'sourceMappingURL 会把后一个包算进前一个包的映射')
  assert.ok(!body.includes('sourceURL'))
  // 注意 `;` 在**换行之后**：DSH 是 `prepareSource(...) + ";\n"`，而 prepareSource
  // 保证源码以换行收尾。照抄这个形态，别自作聪明对齐成 ";\n" 收尾。
  assert.equal(body, 'register("a")\n;\nregister("b")\n;\nregister("c")\n;\n')
})

// —— index 改写 ————————————————————————————————————————————————————————————

/**
 * 造一份足够像真的 index.html。
 *
 * 形态照抄真实页面（已核对）：bootstrap 段是 `<script src>`（`script-src` 行），
 * application 段才是 `<link rel="preload" as="script">`。所以「删 preload」只会删掉
 * application 段 —— 那正是首屏那 5 MB —— 而 bootstrap 那段原地不动。
 */
function sampleIndex() {
  return [
    '<!doctype html><html><head>',
    '<meta charset="utf-8">',
    '<link rel="preload" as="script" href="plugins/??@deepseek-ai/a/client.js,@deepseek-ai/b/client.js&amp;rev=one">',
    '<link rel="preload" as="script" href="plugins/??@deepseek-ai/c/client.js&amp;rev=two">',
    '<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=b"></script>',
    '<script>globalThis["__DSH_REMOTE_ACCESS__"] = {"type":"baseline"}</script>',
    '<script>globalThis["__DSH_BOOT__"] = {"rev":"graphrev","release":{"version":"9.9.9"},"entries":[{"id":"@deepseek-ai/a","url":"plugins/??@deepseek-ai/a/client.js&rev=ra","rev":"ra"}],"batches":[]}</script>',
    '<script type="module" crossorigin src="./assets/index-XXXX.js"></script>',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n')
}

test('rewriteIndex 真的换掉了图，且删干净了整图 application 段的首屏预载', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  assert.equal(result.changed, true, `改写应当成功，原因=${result.reason}`)
  assert.equal(result.removed, 2, '整图那两条 application preload 都该删掉')

  // bootstrap 那段要原样留着（它由 client-modules 自己服务，是本路由之外的东西）。
  assert.ok(result.html.includes('<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=b">'))
  // 整图那两段 application 的 preload 必须消失 —— 它们就是那 5 MB。
  assert.ok(!result.html.includes('@deepseek-ai/a/client.js,@deepseek-ai/b/client.js'))
  assert.ok(!result.html.includes('plugins/??@deepseek-ai/c/client.js'))

  // 精简版的 preload 必须补上（这是首屏真正下载的东西）。
  for (const batch of lite.batches.filter((b) => b.phase === 'application')) {
    assert.ok(result.html.includes(batch.url), `缺精简 preload：${batch.url}`)
  }
})

test('rewriteIndex 换掉了 __DSH_BOOT__，且只动它这一段', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })

  const at = result.html.indexOf('globalThis["__DSH_BOOT__"] = ')
  const end = result.html.indexOf('</script>', at)
  const literal = result.html.slice(at, end)
  const parsed = JSON.parse(literal.slice('globalThis["__DSH_BOOT__"] = '.length))
  assert.deepEqual(
    parsed.entries.map((e) => e.id),
    lite.ids,
    '页面里的图必须就是精简图（客户端只认这个）',
  )

  // 别的注入一个字都不能动 —— 尤其是 __DSH_REMOTE_ACCESS__（api-remote-access 靠它）。
  assert.ok(result.html.includes('globalThis["__DSH_REMOTE_ACCESS__"] = {"type":"baseline"}'))
  assert.ok(result.html.includes('<script type="module" crossorigin src="./assets/index-XXXX.js"></script>'))
})

test('rewriteIndex 种下页面变体标记（客户端靠它判断这份页面是精简版）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  assert.ok(result.html.includes(`globalThis[${JSON.stringify(LITE_MARKER)}] = "lite"`))
})

test('rewriteIndex：换不掉 __DSH_BOOT__ 时必须原样返回，绝不能半改', () => {
  const lite = composeLiteGraph(sampleGraph())
  const noBoot = sampleIndex().replace('globalThis["__DSH_BOOT__"] = ', 'globalThis["__SOMETHING_ELSE__"] = ')
  const result = rewriteIndex(noBoot, { lite })

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'boot-marker-missing')
  assert.equal(result.html, noBoot, '一个字都不能改')
})

test('rewriteIndex：<head> 找不到时原样返回（补不上 preload 就没有意义）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const noHead = sampleIndex().replace('<head>', '<nope>')
  const result = rewriteIndex(noHead, { lite })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'head-missing')
  assert.equal(result.html, noHead)
})

test('rewriteIndex：没有精简图时原样返回', () => {
  const html = sampleIndex()
  const result = rewriteIndex(html, { lite: undefined })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'no-lite-graph')
  assert.equal(result.html, html)
  assert.equal(rewriteIndex(html, {}).changed, false)
})

test('rewriteIndex：没找到任何 preload 也照样换图（不靠预载行是否存在）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const bare = '<html><head><script>globalThis["__DSH_BOOT__"] = {}</script></head></html>'
  const result = rewriteIndex(bare, { lite })
  assert.equal(result.changed, true)
  assert.equal(result.removed, 0)
  assert.ok(result.html.includes('"entries"'), '图仍然必须被换掉')
})

// —— 界面裁剪与压缩 ————————————————————————————————————————————————————————

test('精简种子不含那几项（设置页 / 轨迹 / 附件 / 引用 / 快捷键 UI）', () => {
  const dropped = [
    '@deepseek-ai/dsh-client-ui-settings-general',
    '@deepseek-ai/dsh-client-ui-trajectory',
    '@deepseek-ai/dsh-client-ui-attachment',
    '@deepseek-ai/dsh-client-ui-reference',
    '@deepseek-ai/dsh-client-ui-shortcuts',
  ]
  for (const id of dropped) assert.ok(!LITE_SEEDS.includes(id), `${id} 不该在种子里`)
  // 但 ui-settings（服务）必须留：它 provide configForms，locale/theme/chat 硬依赖它。
  assert.ok(LITE_SEEDS.includes('@deepseek-ai/dsh-client-ui-settings'), 'ui-settings 是服务，必须留')
  assert.ok(!LITE_REQUIRED.includes('@deepseek-ai/dsh-client-ui-settings-general'), '设置页界面不再是必需')
})

test('ui-tool **必须**留（删了工具调用会退化成「未知 Surface 事件」+ 原始 JSON）', () => {
  // 它往 `conversation.chat.node` 注册 `key: "tool-call"`；ui-chat 里那条
  // `renderSlot("conversation.chat.node", ..., { entryKey: routedNode.kind,
  // fallback: JsonBlock(t("message.unknownSurface")) })` 找不到注册就会落到兜底。
  assert.ok(LITE_SEEDS.includes('@deepseek-ai/dsh-client-ui-tool'), 'ui-tool 必须在种子里')
  // 它不 provide 任何服务，所以加回来不会连带别的包（只多它自己一个）。
  assert.ok(!LITE_SEEDS.includes('@deepseek-ai/dsh-client-ui-trajectory'), '轨迹仍然不要')
})

test('sidebar-right 仍会被图边带回来（不能从图里删，只能藏界面）', () => {
  const full = graphOf([
    ...LITE_SEEDS.map((id) => ({ id })),
    { id: '@deepseek-ai/dsh-client-ui-chat', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right'] },
    { id: '@deepseek-ai/dsh-client-ui-sidebar-right' },
  ])
  const lite = composeLiteGraph(full)
  assert.ok(lite.ids.includes('@deepseek-ai/dsh-client-ui-sidebar-right'), '它必须还在图里（否则 boot 审计会挂）')
})

test('rewriteIndex 注入隐藏样式，把右侧栏 / 轨迹藏掉', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  assert.equal(result.changed, true)

  assert.ok(result.html.includes('<style data-dsh-tailscale-remote-hide>'), '必须注入隐藏样式')
  assert.ok(result.html.includes('[data-slot="rightbar"]'), '要藏右侧栏')
  assert.ok(result.html.includes('button[aria-label="打开右侧边栏"]'), '要藏右侧栏开关')
  assert.ok(result.html.includes('button[aria-label="收起右侧边栏"]'), '收起态也要藏')
  // 必须 display:none !important，否则 DSH 自己的类名优先级会盖过去。
  assert.match(result.html, /\[data-slot="rightbar"\][^{]*\{display:none !important\}/)
})

test('**绝不**藏掉设置入口（那是手机上唯一能进设置页的地方）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  // `sidebar.settings` 是 single 插槽、由 ui-settings 注册在侧边栏底部；藏了之后
  // 手机上就再也进不去设置页了。精简图标是加在旁边的，不是替换它。
  assert.equal(result.html.includes('[data-slot="sidebar.settings"]'), false, '设置入口必须留着')
  assert.equal(LITE_HIDE.includes('[data-slot="sidebar.settings"]'), false)
})

test('rewriteIndex 允许调用方传自己的隐藏列表（config.liteHide）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite, hide: ['[data-test-only]'] })
  assert.ok(result.html.includes('[data-test-only]'))
  assert.ok(!result.html.includes('[data-slot="sidebar.settings"]'), '传了列表就用传的，不再用默认')
})

test('encodeComboBody：br 优先、其次 gzip、都不支持就发原文', () => {
  const raw = Buffer.from('abcdefg'.repeat(2000), 'utf8')

  const br = encodeComboBody(raw, 'gzip, deflate, br, zstd')
  assert.equal(br.encoding, 'br')
  assert.ok(br.body.length < raw.length)

  const gz = encodeComboBody(raw, 'gzip, deflate')
  assert.equal(gz.encoding, 'gzip')
  assert.ok(gz.body.length < raw.length)
  assert.ok(br.body.length < gz.body.length, `br ${br.body.length} 应小于 gzip ${gz.body.length}`)

  const none = encodeComboBody(raw, undefined)
  assert.equal(none.encoding, undefined)
  assert.equal(none.body, raw, '没协商就原样发')

  const identity = encodeComboBody(raw, 'identity')
  assert.equal(identity.encoding, undefined, 'identity 不该被当成支持压缩')
})

test('encodeComboBody：解回来必须与原文逐字一致（否则手机拿到坏脚本）', async () => {
  const { gunzipSync, brotliDecompressSync } = await import('node:zlib')
  const raw = Buffer.from('window.__ModuleLoader__.load({id:"x"});\n'.repeat(500), 'utf8')
  assert.equal(brotliDecompressSync(encodeComboBody(raw, 'br').body).toString('utf8'), raw.toString('utf8'))
  assert.equal(gunzipSync(encodeComboBody(raw, 'gzip').body).toString('utf8'), raw.toString('utf8'))
})


test('搜索那一格整个藏掉（用户不要搜索；只藏按钮会留一片空白）', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  assert.equal(result.changed, true)
  assert.ok(result.html.includes('[class*="_searchSlot"]'), 'searchSlot 必须整格藏掉')
})

test('布局修正与隐藏规则在同一段 <style> 里，且总共只注入一段', () => {
  const lite = composeLiteGraph(sampleGraph())
  const result = rewriteIndex(sampleIndex(), { lite })
  const styles = result.html.match(/<style data-dsh-tailscale-remote-hide>/g) ?? []
  assert.equal(styles.length, 1, '只该注入一段 style')
})