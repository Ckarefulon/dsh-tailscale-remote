// dsh-tailscale-remote 的浏览器半边：在「设置 → 通用」里加一行「手机连接」，
// 显示手机可用的登录链接，并允许更换密钥。
//
// 手写，没有构建步骤：元素一律用 React.createElement 构造，样式全部内联，
// 颜色走 DSH 主题变量（真名前缀是 --dsw-alias-，深浅色自动跟随）并各带一个
// 浅色兜底值，变量缺失时界面仍然可读。
//
// 数据来自同源的两个 /api 路由（host 侧 index.js 注册在 connection.fetch 上，
// 因此白拿 DSH 自己的 Host/Origin fence 与 cookie 鉴权）：
//   GET  /api/dsh-tailscale-remote/state   → { ok, phase, error, plainUrl, loginUrl, ... }
//   POST /api/dsh-tailscale-remote/rotate  → { ok, loginUrl } | { ok:false, error }
// 注意失败时状态码不是 200 但响应体仍是 JSON，所以先解析 body 再看 body.ok，
// 不拿状态码覆盖原文。
//
// 这一行**不轮询、不挂后台定时器**：只在挂载时取一次，另有窗口重新获得焦点时
// 刷新一次。设置页关掉就什么都不剩。

window.__ModuleLoader__.load({
	id: 'dsh-tailscale-remote',
	factory: (require) => {
		// loader 只传 require、不传 module，所以每个 bundle 自带这一对，
		// 和宿主自己的 bundle 写法一致。
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const useState = React.useState
		const useEffect = React.useEffect
		const useCallback = React.useCallback
		const useRef = React.useRef

		/** 这一行的插槽 id；同时是设置页里这一行的定位键。 */
		const ROW_ID = 'dsh-tailscale-remote'

		const STATE_PATH = '/api/dsh-tailscale-remote/state'
		const ROTATE_PATH = '/api/dsh-tailscale-remote/rotate'
		const LITE_PATH = '/api/dsh-tailscale-remote/lite'

		/**
		 * 行内字典。
		 *
		 * 宿主有 locale 服务时优先用它（见 pickLanguage），这里这份是兜底：
		 * 拿不到 locale 服务时（浏览器 harness、精简组合）界面仍然是中文/英文，
		 * 而不是一堆字面量 key。
		 */
		const ZH = {
			title: '手机连接',
			description: '开 DSH 时把网页发布到你的 Tailscale 网络（tailnet），手机在任何网络下打开下面的链接就能连上；关掉 DSH 会自动撤掉这条路由。',
			loading: '正在读取…',
			urlLabel: '手机登录链接',
			plainLabel: '直连地址',
			copy: '复制',
			copied: '已复制',
			copyFailed: '复制失败，请手动选中输入框里的内容复制',
			rotate: '更换密钥',
			rotateConfirm: '确认更换',
			rotateCancel: '取消',
			rotateWarningRevoke: '换完之后旧链接立刻失效，所有已登录的设备都会退出（包括你的手机），需要用新链接重新登录一次。这台设备会被自动保留登录状态。',
			rotateWarningLinkOnly: '换完之后旧链接立刻失效，需要把新链接重新存一次书签。已经登录过的设备不受影响。',
			rotateDoneRevoke: '已更换。旧密钥与所有旧登录都已失效，请把新链接重新存一次书签。',
			rotateDoneLinkOnly: '已更换。请重新保存下面的链接。',
			rotateFailed: '更换失败',
			noLogin: '登录入口已关闭（loginRoute=false），下面的直连地址需要先在本机用一次性令牌登录。',
			keepBookmark: '存一次书签即可，跨重启不变。',
			cookieHint: (days) => `登录状态有效期 ${days} 天。`,
			retry: '重试',
			phaseStarting: '还在启动中（拉起 Tailscale / 建立 Serve 路由）。',
			phaseUnavailable: 'Tailscale 没在运行，远程访问暂时不可用。',
			phaseError: '远程访问没能建起来。',
			liteEnable: '切至完整模式',
			liteDisable: '切至精简模式',
			liteSwitchToFull: '切至完整模式',
			liteSwitchToLite: '切至精简模式',
		}

		const EN = {
			title: 'Phone access',
			description: 'While DSH runs, its Web GUI is published to your Tailscale network (tailnet), so a phone anywhere can open the link below. Quitting DSH removes the route.',
			loading: 'Loading…',
			urlLabel: 'Phone login link',
			plainLabel: 'Direct address',
			copy: 'Copy',
			copied: 'Copied',
			copyFailed: 'Copy failed — select the field and copy manually',
			rotate: 'Change key',
			rotateConfirm: 'Confirm change',
			rotateCancel: 'Cancel',
			rotateWarningRevoke: 'The old link stops working immediately and every signed-in device is signed out, including your phone — sign in again with the new link. This device stays signed in.',
			rotateWarningLinkOnly: 'The old link stops working immediately; bookmark the new one. Devices already signed in are unaffected.',
			rotateDoneRevoke: 'Changed. The old key and every old session are now invalid; save the new link again.',
			rotateDoneLinkOnly: 'Changed. Save the link below again.',
			rotateFailed: 'Change failed',
			noLogin: 'The login entry is off (loginRoute=false); the direct address needs a one-time token login from this machine first.',
			keepBookmark: 'Bookmark it once — it survives restarts.',
			cookieHint: (days) => `Sign-in stays valid for ${days} days.`,
			retry: 'Retry',
			phaseStarting: 'Still starting up (bringing up Tailscale / the Serve route).',
			phaseUnavailable: 'Tailscale is not running, so remote access is unavailable.',
			phaseError: 'Remote access could not be established.',
			liteEnable: 'Switch to full',
			liteDisable: 'Switch to lite',
			liteSwitchToFull: 'Switch to full mode',
			liteSwitchToLite: 'Switch to lite mode',
		}

		/**
		 * 当前该说中文还是英文。
		 *
		 * 只读 `ctx.get('locale')`（可选服务，**不写进 inject**：写进去会在
		 * locale 缺席时把整个包 park 掉）。拿不到就退回浏览器语言。
		 * @param ctx - 客户端根上下文。
		 * @returns 'zh' 或 'en'。
		 */
		function pickLanguage(ctx) {
			let active
			try {
				active = ctx.get('locale')?.getSnapshot?.().active
			} catch {
				active = undefined
			}
			if (typeof active === 'string' && active !== '') {
				return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
			}
			const nav = typeof navigator === 'undefined' ? '' : navigator.language
			return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en'
		}

		/** 行内样式。token 名照抄宿主，括号里是浅色兜底。 */
		const styles = {
			row: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				padding: '16px 0',
				borderBottom: '.5px solid var(--dsw-alias-border-l2,#e5e7eb)',
			},
			head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '24px' },
			title: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary,#111827)' },
			description: {
				marginTop: 4,
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-secondary,#6b7280)',
			},
			actions: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
			field: { display: 'flex', alignItems: 'center', gap: 8 },
			label: {
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-secondary,#6b7280)',
				flex: 'none',
			},
			input: {
				flex: '1 1 auto',
				minWidth: 0,
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				padding: '5px 8px',
				borderRadius: 'var(--dsw-radius-sm,8px)',
				border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
				background: 'var(--dsw-alias-bg-base,#fff)',
				color: 'var(--dsw-alias-label-primary,#111827)',
			},
			button: {
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				padding: '5px 10px',
				borderRadius: 'var(--dsw-radius-sm,8px)',
				border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary,#111827)',
				cursor: 'pointer',
				whiteSpace: 'nowrap',
				flex: 'none',
			},
			buttonPrimary: {
				borderColor: 'transparent',
				background: 'var(--dsw-alias-state-warn-primary,#b45309)',
				color: '#fff',
			},
			hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#6b7280)' },
			// 侧边栏底部那个图标按钮：28px 见方，与宿主自己那几个图标按钮同尺寸同重量。
			iconButton: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: 28,
				height: 28,
				padding: 0,
				border: 'none',
				borderRadius: 'var(--dsw-radius-sm,8px)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary,#6b7280)',
				cursor: 'pointer',
				flex: 'none',
			},
			liteBox: {
				display: 'flex',
				flexDirection: 'column',
				gap: 8,
				paddingTop: 12,
				borderTop: '.5px solid var(--dsw-alias-border-l2,#e5e7eb)',
			},
			warn: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary,#b45309)' },
			error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary,#dc2626)' },
			ok: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary,#16a34a)' },
		}

		/**
		 * 读一个 JSON 端点。
		 *
		 * 失败时状态码不是 200，但 body 仍是 JSON 且带着真正的原因，所以这里
		 * 先解析、再看 `ok`，不拿状态码覆盖原文（照抄 dsh-mini-remote 的经验）。
		 * @param path - 同源路径。
		 * @param options - fetch 选项。
		 * @returns `{ ok: true, data }` 或 `{ ok: false, error }`。
		 */
		async function readJson(path, options) {
			let response
			try {
				response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options })
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error) }
			}
			let body
			try {
				body = await response.json()
			} catch {
				return { ok: false, error: `HTTP ${response.status}` }
			}
			if (body === null || typeof body !== 'object') return { ok: false, error: `HTTP ${response.status}` }
			if (body.ok !== true) {
				return { ok: false, error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` }
			}
			return { ok: true, data: body }
		}

		/** 把文案里的阶段/错误翻成人话；认不出来就把原文附在后面。 */
		function describePhase(t, state) {
			if (state === null) return t.loading
			if (state.phase === 'starting') return t.phaseStarting
			if (state.phase === 'unavailable') return t.phaseUnavailable
			if (state.phase === 'error') return t.phaseError
			return undefined
		}

		/**
		 * 「设置 → 通用」里的这一行。
		 *
		 * 只在挂载时取一次状态；另有 window focus 时刷新一次（桌面 App 里
		 * 用户切走再切回来很常见，这时 Tailscale 可能刚好起来了）。
		 * @param props - 注入面给的 `ctx`（见 apply 里的 `inject`）。
		 */
		function RemoteRow(props) {
			const ctx = props.ctx
			// 语言变化时强制重渲染；字典本身是行内常量，不需要订阅字典。
			const [, setTick] = useState(0)
			const [state, setState] = useState(null)
			const [error, setError] = useState(null)
			const [busy, setBusy] = useState(false)
			const [copied, setCopied] = useState(false)
			const [confirming, setConfirming] = useState(false)
			const [notice, setNotice] = useState(null)
			const inputRef = useRef(null)

			const t = pickLanguage(ctx) === 'zh' ? ZH : EN

			const load = useCallback(async () => {
				const result = await readJson(STATE_PATH)
				if (result.ok) {
					setState(result.data)
					setError(null)
				} else {
					setError(result.error)
				}
			}, [])

			useEffect(() => {
				void load()
			}, [load])

			useEffect(() => {
				const locale = (() => {
					try {
						return ctx.get('locale')
					} catch {
						return undefined
					}
				})()
				if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
				return locale.subscribe(() => setTick((n) => n + 1))
			}, [ctx])

			useEffect(() => {
				const onFocus = () => {
					void load()
				}
				window.addEventListener('focus', onFocus)
				return () => window.removeEventListener('focus', onFocus)
			}, [load])

			const url = state === null ? null : state.loginUrl || state.plainUrl
			const usesLoginUrl = state !== null && state.loginUrl !== null && state.loginUrl !== undefined

			const copy = useCallback(async () => {
				if (url === null || url === undefined) return
				let done = false
				try {
					if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
						await navigator.clipboard.writeText(url)
						done = true
					}
				} catch {
					done = false
				}
				if (!done) {
					// 非安全上下文里 clipboard 不可用（tailnet 的 https 和 localhost 都算安全，
					// 但用户可能从 http 的局域网地址进来）。退回选中输入框内容，让人手动复制。
					try {
						inputRef.current?.select?.()
						done = document.execCommand('copy')
					} catch {
						done = false
					}
				}
				setNotice(done ? null : t.copyFailed)
				setCopied(done)
				if (done) setTimeout(() => setCopied(false), 1600)
			}, [url, t])

			const rotate = useCallback(async () => {
				setBusy(true)
				setNotice(null)
				const result = await readJson(ROTATE_PATH, { method: 'POST' })
				setBusy(false)
				setConfirming(false)
				if (!result.ok) {
					setNotice(`${t.rotateFailed}：${result.error}`)
					return
				}
				setState((previous) => ({ ...(previous ?? {}), ...result.data }))
				setNotice(result.data.revokesSessions === false ? t.rotateDoneLinkOnly : t.rotateDoneRevoke)
			}, [t])

			const canRotate = state !== null && state.canRotate === true && !busy

			// 文案必须跟着实际行为走：吊销会话时警告要说清「所有设备都会退出」，
			// 否则用户以为只是换个链接，结果手机被踢下线、还不知道为什么。
			const revokes = state !== null && state.revokesSessions === true
			const warningText = revokes ? t.rotateWarningRevoke : t.rotateWarningLinkOnly

			// 首帧：还没拿到状态，也没出错。这时不要摆一个空输入框配一个会误导的标签，
			// 直接说「正在读取」。
			if (state === null && error === null) {
				return h(
					'div',
					{ style: styles.row, 'data-dsh-tailscale-remote-row': '' },
					h('div', { style: styles.title }, t.title),
					h('div', { style: styles.description }, t.description),
					h('div', { style: styles.hint }, t.loading),
				)
			}

			const hint = describePhase(t, state)

			/**
			 * 「这份页面跑的是哪一版」。
			 *
			 * 读的是宿主在改写 index 时种下的标记，**不是** `__DSH_BOOT__` 的行数：
			 * 后者是拿数字当契约，DSH 一升级就骗人。标记只说明这一份页面是不是精简版，
			 * 与整图长什么样无关。拿不到标记（桌面端、或完整版页面）时为 undefined。
			 */
			const thisPageIsLite =
				typeof globalThis !== 'undefined' && globalThis.__DSH_TAILSCALE_REMOTE_LITE__ === 'lite'

			return h(
				'div',
				{ style: styles.row, 'data-dsh-tailscale-remote-row': '' },
				h(
					'div',
					{ style: styles.head },
					h(
						'div',
						null,
						h('div', { style: styles.title }, t.title),
						h('div', { style: styles.description }, t.description),
					),
					h(
						'div',
						{ style: styles.actions },
						confirming
							? [
									h(
										'button',
										{
											key: 'go',
											type: 'button',
											style: { ...styles.button, ...styles.buttonPrimary },
											disabled: busy,
											onClick: () => void rotate(),
										},
										t.rotateConfirm,
									),
									h(
										'button',
										{ key: 'no', type: 'button', style: styles.button, disabled: busy, onClick: () => setConfirming(false) },
										t.rotateCancel,
									),
								]
							: h(
									'button',
									{
										type: 'button',
										style: styles.button,
										disabled: !canRotate,
										onClick: () => {
											setNotice(null)
											setConfirming(true)
										},
									},
									t.rotate,
								),
					),
				),
				h(
					'div',
					{ style: styles.field },
					h('span', { style: styles.label }, usesLoginUrl ? t.urlLabel : t.plainLabel),
					h('input', {
						ref: inputRef,
						readOnly: true,
						spellCheck: false,
						value: url ?? '',
						'aria-label': usesLoginUrl ? t.urlLabel : t.plainLabel,
						style: styles.input,
						onFocus: (event) => {
							try {
								event.target.select()
							} catch {
								/* 选中失败无所谓 */
							}
						},
					}),
					h(
						'button',
						{ type: 'button', style: styles.button, disabled: url === null || url === undefined, onClick: () => void copy() },
						copied ? t.copied : t.copy,
					),
				),
				confirming ? h('div', { style: styles.warn }, warningText) : null,
				notice === null ? null : h('div', { style: styles.warn }, notice),
				error !== null
					? h(
							'div',
							{ style: styles.error, role: 'alert' },
							`${error} `,
							h(
								'button',
								{ type: 'button', style: styles.button, onClick: () => void load() },
								t.retry,
							),
						)
					: null,
				state === null || state.phase === 'ready'
					? h(
							'div',
							{ style: styles.hint },
							usesLoginUrl ? `${t.keepBookmark}${t.cookieHint(state?.cookieMaxAgeDays ?? 0)}` : t.noLogin,
						)
					: h('div', { style: styles.hint }, hint),
			)
		}

		/**
		 * 这个页面是不是**桌面 App 窗口**。
		 *
		 * 判据是 Electron preload 暴露的 `dshDesktopBoot` —— 它只由
		 * `preload-app.cjs` 用 `contextBridge.exposeInMainWorld` 注入，只有桌面窗口里有；
		 * 手机浏览器走 HTTP、没有 preload，所以这个字段不存在。
		 *
		 * 为什么必须判它：用户要求「电脑端一个字节都不准动」。本插件在桌面窗口里
		 * **什么都不注册**（既没有设置页那一行、也没有底部这个图标），因此桌面上
		 * 看到的 DSH 与没装这个插件时完全一致。
		 *
		 * 注意用 `in globalThis` 而不是 `typeof x !== 'undefined'`：后者对未声明标识符
		 * 静默返回 'undefined' 且不报错，是这类判断最容易踩的坑。
		 */
		function isDesktopWindow() {
			return typeof globalThis !== 'undefined' && 'dshDesktopBoot' in globalThis
		}

		/**
		 * 同一枚图标，渲染成 SVG **字符串**。
		 *
		 * 为什么要有字符串版：DOM 增强那段是直接往宿主节点里塞东西，**不在 React 树里**，
		 * 用 `innerHTML` 最省事 —— 也避免为了这一枚图标去 `require('react-dom')`
		 * （客户端 bundle 只被允许 `require('react')`）。
		 *
		 * 画法与 `LiteSwitchIcon`、以及 DSH 图标规范完全一致。
		 * @param size - 边长。
		 * @param strokeWidth - 线重（DSH Regular = 1，Medium = 1.3）。
		 */
		function LITE_ICON_SVG(size, strokeWidth) {
			return (
				`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
				`xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="${strokeWidth}">` +
				`<path d="M3 5.5h8.5M9.5 3.5 11.5 5.5 9.5 7.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path>` +
				`<path d="M13 10.5H4.5M6.5 8.5 4.5 10.5 6.5 12.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path>` +
				`</svg>`
			)
		}

		/**
		 * 按当前语言取一条文案。
		 *
		 * DOM 增强那段拿不到 React 侧的 `t`，只能自己查字典。这里只认存在
		 * localStorage 的语言偏好；读不到就用中文（本机默认），读不到也不抛。
		 * @param pick - `(dict) => string`。
		 */
		function pickLanguageText(pick) {
			try {
				if (typeof localStorage !== 'undefined') {
					const stored = localStorage.getItem('dsh.language') ?? localStorage.getItem('dsh-locale')
					if (typeof stored === 'string' && stored.toLowerCase().startsWith('en')) return pick(EN)
					if (typeof stored === 'string' && stored.toLowerCase().startsWith('zh')) return pick(ZH)
				}
			} catch {
				/* localStorage 可能被策略禁用，忽略 */
			}
			return pick(ZH)
		}

		/**
		 * 精简模式的那个图标长什么样（16×16，DSH 图标规范）。
		 *
		 * 图形是双向箭头（⇄），表示「在精简 / 完整之间切换」。画法照 DSH 自己的图标：
		 * `viewBox="0 0 16 16"`、`fill="none"`、`strokeWidth` 放 `<svg>` 上、每条 path 上
		 * 写 `stroke="currentColor"`、`aria-hidden="true"`。
		 *
		 * 用户明确要求这一处**用图标、不要文字**（文字用 DSH 自己的那个 label 位）。
		 * @param props - `{ size, strokeWidth }`。
		 */
		function LiteSwitchIcon(props) {
			const size = props?.size ?? 16
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 16 16',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true',
					strokeWidth: props?.strokeWidth ?? 1,
				},
				h('path', {
					d: 'M3 5.5h8.5M9.5 3.5 11.5 5.5 9.5 7.5',
					stroke: 'currentColor',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'M13 10.5H4.5M6.5 8.5 4.5 10.5 6.5 12.5',
					stroke: 'currentColor',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			)
		}

		/**
		 * 把「切换精简 / 完整」这个动作**挂到宿主已有的那两个位置上**。
		 *
		 * 用户要的效果（原话）：
		 *   - **精简模式**下：把侧边栏左下角那个「设置」**换成**切换控件 ——
		 *     设置图标的位置变成切换图标，「设置」两个字变成「切至完整模式」。
		 *   - **完整模式**下：那一栏照旧是设置，**另外**在用户名那一行的最右侧放一个图标。
		 *
		 * 为什么不能靠插槽做到：
		 *   - 「设置」那一格是 `settings.launcher` / `settings.trigger`，两者都是 **single**
		 *     插槽且 `replaceRisk: shadows-shipped-ui`。注册进去会**整个盖掉** DSH 的设置
		 *     按钮（连点击打开设置一起没了）—— 那是既有功能，不能动。
		 *   - 「用户名那一行」是 `settings.launcher` 里的账号按钮，同样被占。
		 *
		 * 所以走 **DOM 增强**：在宿主渲染出来的节点上就地改内容 / 追加一个兄弟节点。
		 * 每步都能失败、失败就保持原样（功能不变，只是没有这个开关）。
		 *
		 * 具体两件事：
		 *   1. 精简模式下，把 `[data-slot="settings.trigger"]` 里的 svg 换成我们的图标，
		 *      把 `.triggerLabel` 的文字换成「切至完整模式」；点这一格 → 切到完整模式。
		 *   2. 完整模式下，在账号按钮（`aria-haspopup="menu"`）所在行的最右侧插入图标，
		 *      点它 → 切到精简模式。
		 *
		 * 恢复：一旦离开该模式 / 组件卸载，把改过的东西**逐字还原**（记下原始 svg 与文字）。
		 * @param state - 状态端点给的 `{ lite, liteAvailable }`；null 表示还没拿到。
		 * @param onToggle - 点击时要执行的动作。
		 */
		function useSwitchHook(state, onToggle) {
			// onToggle 每次渲染都是新函数，用 ref 存着，避免 effect 反复重跑。
			const toggleRef = useRef(onToggle)
			toggleRef.current = onToggle
			const lite = state?.lite
			const available = state?.liteAvailable === true

			useEffect(() => {
				if (typeof document === 'undefined') return undefined
				if (!available) return undefined

				/** 记下被我们改过的节点，卸载时逐字还原。 */
				const touched = []
				let injected = null

				const restoreAll = () => {
					for (const entry of touched) {
						try {
							entry.restore()
						} catch {
							/* 节点可能已经没了，忽略 */
						}
					}
					touched.length = 0
					if (injected !== null && injected.parentElement !== null) {
						injected.parentElement.removeChild(injected)
					}
					injected = null
				}

				/**
				 * 精简模式：把「设置」那一格换成切换控件。
				 *
				 * **必须幂等**：React 会随时重建这一块 DOM（展开/收起、语言切换、
				 * 设置页开关都会触发），而且图标与文字**不是同时挂上**的 —— 实测
				 * 第一次跑到这里时图标在、label 还没渲染出来。所以每次 sync 都要来
				 * 这里补齐，只补缺的那部分，不去重复改已经改好的。
				 * @returns 是否已经全部处理完。
				 */
				const hookSettingsSeat = () => {
					const trigger = document.querySelector('[data-slot="settings.trigger"]')
					const button = trigger?.closest('button')
					if (trigger === undefined || trigger === null || button === null) return false

					const wantText = pickLanguageText((dict) => dict.liteSwitchToFull)
					let done = true

					// 1) 换图标：把原来的 svg 摘下来存好，塞我们的。
					//    判据是「里头有没有我们那两条 path」而不是「有没有标记」——
					//    React 重建会把我塞的 span 连同标记一起丢掉，但标记在 button 上
					//    会留下来，用标记判断就会漏掉重建后的那一份。
					const mineAlready = [...trigger.querySelectorAll('path')].some((p) =>
						(p.getAttribute('d') ?? '').includes('5.5h8.5'),
					)
					if (!mineAlready) {
						const originalSvg = trigger.querySelector('svg')
						if (originalSvg !== null) {
							const parent = originalSvg.parentElement
							const nextSibling = originalSvg.nextSibling
							parent.removeChild(originalSvg)
							// 我们的图标用一个占位容器，方便整体移除。
							const holder = document.createElement('span')
							holder.style.display = 'contents'
							parent.insertBefore(holder, nextSibling)
							// 直接写 SVG 字符串：这里不在 React 树里，用 innerHTML 最省事，
							// 也避免为了这一个图标去 require('react-dom')。
							holder.innerHTML = LITE_ICON_SVG(16, 1.3)
							touched.push({
								restore() {
									if (holder.parentElement !== null) holder.parentElement.removeChild(holder)
									if (parent.isConnected && originalSvg.parentElement === null) {
										parent.insertBefore(originalSvg, nextSibling)
									}
								},
							})
						} else {
							// 图标还没渲染出来，下一轮再来。
							done = false
						}
					}

					// 2) 换文字：「设置」→「切至完整模式」。
					const label = button.querySelector('[class*="triggerLabel"]')
					if (label === null) {
						// 文字还没挂上，下一轮再来（实测首屏就是这种情况）。
						done = false
					} else if (label.textContent !== wantText) {
						const originalText = label.textContent
						label.textContent = wantText
						// 收起态下这个 label 是视觉隐藏的（DSH 用 clip 隐藏），交给 CSS 处理，
						// 我们只换文字，不动它的显示方式。
						touched.push({
							restore() {
								if (label.isConnected) label.textContent = originalText
							},
						})
					}

					// 3) 无障碍名字也跟着走（否则读屏还念「设置」）。
					if (button.getAttribute('aria-label') !== wantText) {
						const originalAria = button.getAttribute('aria-label')
						button.setAttribute('aria-label', wantText)
						touched.push({
							restore() {
								if (originalAria === null) button.removeAttribute('aria-label')
								else button.setAttribute('aria-label', originalAria)
							},
						})
					}

					// 4) 点击改成切换，而不是打开设置。
					if (button.dataset.dshLiteSeat !== '1') {
						const handler = (event) => {
							event.preventDefault()
							event.stopPropagation()
							toggleRef.current?.()
						}
						button.addEventListener('click', handler, true)
						button.dataset.dshLiteSeat = '1'
						touched.push({
							restore() {
								button.removeEventListener('click', handler, true)
								delete button.dataset.dshLiteSeat
							},
						})
					}

					return done
				}

				/** 完整模式：在用户名那一行的最右侧放一个图标。 */
				const hookAccountRow = () => {
					const accountButton = document.querySelector('button[aria-haspopup="menu"]')
					if (accountButton === null) return false
					// 往上找**真正有尺寸**的那一层当容器。实测这条链路上有若干
					// `display: contents` 的空壳（宽高为 0），按固定层数取会拿到空壳，
					// 于是宽度检查永远不通过、图标插不进去。
					let row = accountButton.parentElement
					while (row !== null && row !== document.body) {
						const rect = row.getBoundingClientRect()
						if (rect.width >= 80 && rect.height > 0) break
						row = row.parentElement
					}
					if (row === null || row === document.body) return false
					if (document.querySelector('[data-dsh-tailscale-remote-floating]') !== null) {
						return true
					}

					const button = document.createElement('button')
					button.type = 'button'
					button.setAttribute('data-dsh-tailscale-remote-floating', '')
					button.setAttribute('aria-label', pickLanguageText((t) => t.liteSwitchToLite))
					button.title = pickLanguageText((t) => t.liteSwitchToLite)
					button.style.cssText = [
						'position:absolute',
						'right:10px',
						'top:50%',
						'transform:translateY(-50%)',
						'width:28px',
						'height:28px',
						'display:flex',
						'align-items:center',
						'justify-content:center',
						'padding:0',
						'border:none',
						'background:transparent',
						'color:var(--dsw-alias-label-secondary,#6b7280)',
						'cursor:pointer',
						'z-index:2',
						'border-radius:var(--dsw-radius-sm,8px)',
					].join(';')
					button.innerHTML = LITE_ICON_SVG(16, 1)
					button.addEventListener('click', (event) => {
						event.preventDefault()
						event.stopPropagation()
						toggleRef.current?.()
					})
					// 行本身要能当定位参照（实测是 position: relative，这里兜底）。
					if (getComputedStyle(row).position === 'static') row.style.position = 'relative'
					row.appendChild(button)
					injected = button
					return true
				}

				/** 按当前模式执行对应那一件事；顺手把另一件撤掉。 */
				const sync = () => {
					if (lite === true) {
						// 精简模式：占用设置那一格。先把完整模式那个浮动图标撤掉。
						if (injected !== null && injected.parentElement !== null) {
							injected.parentElement.removeChild(injected)
							injected = null
						}
						const ok = hookSettingsSeat()
						// 没找到设置按钮（例如页面还在加载）就不算完成，等下一轮。
						return ok
					}
					if (lite === false) {
						// 完整模式：设置那一格**保持原样**（把之前的改动还原），另放一个图标。
						const seat = document.querySelector('button[data-dsh-lite-seat="1"]')
						if (seat !== null) {
							// 有残留的改动 → 全部还原，下一轮重新按完整模式处理。
							restoreAll()
							return false
						}
						return hookAccountRow()
					}
					return false
				}

				if (sync() === true) {
					// 已经处理完，挂个 observer 以便 DOM 重建后重做。
				}

				// DOM 会被 React 重建（展开/收起、进出设置页），所以要跟着重做。
				// 没有 MutationObserver 的环境（node 测试夹具）就只做一次。
				let observer = null
				let frame = 0
				let tries = 0
				const retry = () => {
					if (sync() === true) return
					if (tries++ > 300) return
					frame = requestAnimationFrame(retry)
				}
				if (typeof MutationObserver === 'function') {
					observer = new MutationObserver(() => {
						sync()
					})
					observer.observe(document.body, { childList: true, subtree: true })
				}
				if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(retry)

				return () => {
					if (observer !== null) observer.disconnect()
					if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
					restoreAll()
				}
			}, [lite, available])
		}

		/**
		 * 侧边栏底部那个「精简 / 完整」开关图标。
		 *
		 * 位置：`sidebar.footer.action` —— DSH 自己声明在侧边栏底部、原「设置」图标
		 * 旁边的那一格。精简页面把原生设置入口藏掉了（见 lite.js 的 LITE_HIDE），
		 * 于是这里就是那个位置的唯一控件。
		 *
		 * 只在**手机（远程）页面**渲染：
		 *   - 桌面窗口里直接返回 null（用户要求桌面端一个字节都不动）；
		 *   - 完整模式页面里也返回 null（那时原生设置入口还在，用户不需要它）。
		 * @param props - 插槽注入面给的 `ctx`。
		 */
		function LiteSwitch(props) {
			const ctx = props.ctx
			const [state, setState] = useState(null)
			const [busy, setBusy] = useState(false)

			const t = pickLanguage(ctx) === 'zh' ? ZH : EN

			const load = useCallback(async () => {
				const result = await readJson(STATE_PATH)
				if (result.ok) setState(result.data)
			}, [])

			useEffect(() => {
				void load()
			}, [load])

			const toggle = useCallback(async () => {
				if (state === null) return
				const next = state.lite !== true
				setBusy(true)
				const result = await readJson(LITE_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ enabled: next }),
				})
				setBusy(false)
				if (!result.ok) return
				setState((previous) => ({ ...(previous ?? {}), lite: result.data.lite }))
			}, [state])

			// 真正干活的是这个 hook：它把切换动作挂到宿主已有的那两个位置上
			// （精简模式 → 占用「设置」那一格；完整模式 → 用户名行最右侧加一个图标）。
			useSwitchHook(state, () => void toggle())

			// 桌面窗口：什么都不渲染（apply 里其实一开始就不会注册）。
			if (isDesktopWindow()) return null
			// 这个组件**本身不渲染任何可见内容**：界面全部由 useSwitchHook 挂到宿主
			// 已有的节点上。这里返回 null 是为了不往 sidebar.footer.action 里多塞东西
			// （那个容器在上方、默认左对齐，塞进去反而多出一个位置不对的按钮）。
			void busy
			void t
			return null
		}

		/**
		 * 注册这个插件的界面。
		 *
		 * 两处，规则不同：
		 *
		 *   1. **设置页那一行（手机连接 + 换密钥）** —— 条件注册，桌面与手机**都有**。
		 *      这是插件原本就有的功能，不是这次新加的东西，任何时候都不该消失。
		 *
		 *   2. **侧边栏底部的精简/完整图标** —— 只在**手机的远程页面**上出现。
		 *      桌面窗口里不注册、完整模式页面里也不渲染（见 LiteSwitch）。
		 *
		 * 用 `slots.inject` 而不是 `slots.register` 直调：插槽由别的包声明，它和本包的
		 * 激活顺序没有保证。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// 设置页那一行：桌面和手机都注册（原本就有的功能，不能因为「精简模式只在
			// 远程端」而被连带删掉）。
			ctx.slots.inject('settings.general.item', () =>
				ctx.slots.register(
					{
						name: 'settings.general.item',
						id: ROW_ID,
						// 排在 performance-usage(30) 之后、current-version(100) 之前。
						order: 95,
						// 组件从注入面上拿 ctx（插槽的 standard props 里没有 ctx）。
						inject: () => ({ ctx }),
					},
					RemoteRow,
				),
			)

			// 侧边栏底部的精简/完整图标：**只**在手机的远程页面上有。
			// 桌面窗口里直接不注册 —— 用户要求桌面端一个字节都不动。
			if (isDesktopWindow()) return
			ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{
						name: 'sidebar.footer.action',
						id: ROW_ID,
						order: 10,
						inject: () => ({ ctx }),
					},
					LiteSwitch,
				),
			)
		}

		exports.name = 'dsh-tailscale-remote'
		// 只要 slots；locale 走 ctx.get 可选读取（写进 inject 会在它缺席时 park 掉整包）。
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports
	},
})
