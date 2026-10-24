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
			/**
			 * 侧边栏底部那个「精简 / 完整」切换按钮。
			 *
			 * 只有图标、没有文字（用户明确要求这一处用图标）。28px 见方，与宿主
			 * 自己那几个图标按钮同尺寸；颜色走主题变量，深浅色自动跟随，变量缺失时
			 * 退回一个中性灰，界面仍然可读。
			 */
			footerSwitch: {
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
		 * 「这一份页面跑的是哪一版」。
		 *
		 * 读的是宿主在改写 index 时种下的标记（`globalThis.__DSH_TAILSCALE_REMOTE_LITE__`），
		 * **不是** `__DSH_BOOT__` 的行数：后者是拿数字当契约，DSH 一升级就骗人；也不是
		 * 状态端点里的 `lite` —— 那个说的是「宿主下一次渲染会不会裁」，而按钮必须按
		 * **正在看的这份页面**说话，否则点下去会发生「文案说切到完整、页面本来就完整」。
		 *
		 * 拿不到标记（桌面端、配置关了精简、或本来就是完整版页面）时返回 false。
		 * @returns 这一份页面是不是精简版。
		 */
		function pageIsLite() {
			try {
				return typeof globalThis === 'undefined' ? false : globalThis.__DSH_TAILSCALE_REMOTE_LITE__ === 'lite'
			} catch {
				return false
			}
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
		 * 「精简 / 完整」切换控件。
		 *
		 * ## 它长在哪儿（这是整个设计里唯一定死的决定）
		 *
		 * 它长在 **`sidebar.footer.action`** 插槽里 —— 侧边栏最底下、设定那一行
		 * 所在的那个脚区，由 `ui-sidebar` 声明。
		 *
		 * 为什么必须是这里，而不是别的地方：
		 *
		 *   1. **它有自己的一格，不寄生任何别人的按钮。** 我早先几版把它挂到 DSH 的
		 *      设置按钮上（换它的图标/文字、接管它的点击）。那种做法要求设置按钮
		 *      必须存在 —— 而设置按钮是 `ui-settings-general` 注册的，恰好就是
		 *      「精简模式不该传的那个组件」。于是「不传那个组件」和「有个切换按钮」
		 *      直接互相打架：包一抽掉，按钮跟着没了。**这是之前那些 bug 的总根因。**
		 *   2. `ui-sidebar` 的 `inject` 是 `["slots","layout","uiWorkspace","locale",
		 *      "shortcuts"]` —— **不含** `ui-settings-general`，所以在精简图里它也
		 *      一定在，座位一定存在。
		 *
		 * ## 它在两种模式下怎么表现
		 *
		 * 只有一条规则：**这个按钮永远在，点它就在两种模式之间切**。
		 *
		 *   - 精简页  → 文案/提示是「切至完整模式」，点完 → 这一次的完整页
		 *   - 完整页  → 文案/提示是「切至精简模式」，点完 → 精简页
		 *
		 * 但**「完整」不保留**（用户定下的规则）：远程端每次连上来都是精简模式，
		 * 按按钮只是让**紧接着的那一次加载**变成完整页；关掉页面、重新连、过一会儿再
		 * 刷新，都是精简页。宿主那边对应的实现是 `FULL_PAGE_GRANT_MS` 那个一次性窗口，
		 * 状态不写盘、也没有「上次的选择」。
		 *
		 * 因此这个按钮**必须按「正在看的这份页面」说话**（`pageIsLite()`），不能按状态
		 * 端点里的 `lite` 说话 —— 后者说的是「宿主下一次渲染会不会裁」，两者在切完、
		 * 重载前的那一刻恰好是相反的，照它说话就会点出「切至完整模式 → 还是完整页」。
		 *
		 * 不做「精简模式下才显示」这种条件 —— 那会造成「切到完整模式后没有入口切回
		 * 来」的死角（我犯过这个错，用户明确报过）。
		 *
		 * 侧边栏收起成 56px 竖条时仍然显示（那时 `wide === false`，宿主自己会把
		 * 文字视觉隐藏，只剩图标，这是宿主的既有行为，不用我处理）。
		 *
		 * ## 位置微调
		 *
		 * 宿主把这个插槽的容器放在脚区的**上方**且左对齐（实测 `_footerActions`
		 * 在头像行上面 4px、宽度铺满）。用户要的是「在头像那一行的右侧」，所以
		 * 渲染完后用 transform 把**按钮自己**平移过去 —— 平移按钮而不是容器，因为
		 * 容器宽度铺满、平移它只会改垂直位置。
		 *
		 * 为什么用 transform 而不是 absolute：容器的定位包含块是整个 frame
		 * （实测 `offsetParent` 宽 1879px），absolute 会把按钮甩到窗口右边去。
		 *
		 * @param props - 插槽注入面给的 `{ ctx }`，加上宿主传的 `{ wide }`。
		 */
		function LiteSwitch(props) {
			const ctx = props.ctx
			const [state, setState] = useState(null)
			const [busy, setBusy] = useState(false)

			const t = pickLanguage(ctx) === 'zh' ? ZH : EN

			// 读当前状态（只读一次）。它现在**只**用来判断「这台 DSH 有没有精简模式可用」；
			// 按钮说切到哪一边、以及点下去 POST 什么，都按**这份页面**是哪一版来定。
			const load = useCallback(async () => {
				const result = await readJson(STATE_PATH)
				if (result.ok) setState(result.data)
			}, [])

			useEffect(() => {
				void load()
			}, [load])

			// 这份页面是精简版吗？每次渲染重读一次全局标记（宿主改写 index 时种下的），
			// 不缓存：切模式会整页刷新，那份标记跟着换。
			const lite = pageIsLite()

			const toggle = useCallback(async () => {
				if (state === null) return
				// 切到「另一边」：这份页面是精简 → 要完整（enabled=false 开授权窗口）；
				// 这份页面是完整 → 要精简（enabled=true 立刻撤销窗口）。
				//
				// 后端的语义是**一次性授权**，不是记住选择：只有紧接着的那次加载会拿到
				// 完整页（窗口见宿主 FULL_PAGE_GRANT_MS），过了窗口或下一次连接又回精简。
				setBusy(true)
				const result = await readJson(LITE_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ enabled: !lite }),
				})
				setBusy(false)
				// 失败就什么都不做：按钮留在原地，下次点还在。
				if (!result.ok) return
				// **必须刷新**：这个开关只决定「宿主下一次渲染 index 时发哪一版」，
				// 已经加载的页面不会自己变。不刷新的话用户点完只看到状态变了、
				// 界面还是原样 —— 就是「点了没切过来」。
				// 用 replace() 不是 reload()：不往历史里塞一条，返回键不会被卡住。
				try {
					globalThis.location.replace(globalThis.location.href)
				} catch {
					/* 拿不到 location 就算了，下次刷新自然生效 */
				}
			}, [state, lite])

			// 桌面窗口：不渲染（apply 里其实一开始就不会注册）。
			if (isDesktopWindow()) return null
			// 还没有状态就不渲染（避免先闪一个文案不对的按钮）。
			if (state === null || state.liteAvailable !== true) return null

			// 文案说的是「点下去会发生什么」：精简页 → 切至完整模式；完整页 → 切至精简模式。
			const label = lite ? t.liteEnable : t.liteDisable
			return h(
				'button',
				{
					type: 'button',
					style: styles.footerSwitch,
					disabled: busy,
					title: label,
					'aria-label': label,
					'data-dsh-tailscale-remote-switch': '',
					onClick: () => void toggle(),
				},
				h(LiteSwitchIcon, { size: 16, strokeWidth: 1 }),
			)
		}
		/**
		 * 注册这个插件的两处界面。
		 *
		 * 它们的**命运是分开的**，这是关键：
		 *
		 *   1. **设置页那一行（手机连接 + 换密钥）** —— 注册在 `settings.general.item`
		 *      上，那个插槽由 `ui-settings-general` 声明。
		 *      精简图里没有 `ui-settings-general`（`package.json` 的
		 *      `dsh.client.inject` 不再声明它），于是这里什么也不注册 —— 那 16.6 KB
		 *      的组件不用传给手机。完整模式里它照常有。
		 *
		 *   2. **精简/完整切换按钮** —— 注册在 `sidebar.footer.action` 上，那个插槽
		 *      由 `ui-sidebar` 声明，**与 `ui-settings-general` 无关**，所以两种模式下
		 *      它都在。（早先几版把它寄生在设置按钮上，于是「抽掉设置组件」时它跟着
		 *      消失 —— 那是个设计错误，不是巧合。）
		 *
		 * 桌面窗口里第 1 项照旧注册（那是插件原本就有的功能），第 2 项不注册。
		 *
		 * 用 `slots.inject` 而不是 `slots.register` 直调：插槽由别的包声明，它和本包的
		 * 激活顺序没有保证。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// 设置页那一行：插槽在就注册，不在（精简图里）就自然什么也不做。
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

			// 精简/完整切换按钮：只在手机的远程页面上有；桌面窗口不注册。
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
