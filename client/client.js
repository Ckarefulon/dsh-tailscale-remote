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
			rotateWarning: '换完之后旧链接立刻失效，需要把新链接重新存一次书签。已经登录过的手机不受影响。',
			rotateDone: '已更换。请重新保存下面的链接。',
			rotateFailed: '更换失败',
			noLogin: '登录入口已关闭（loginRoute=false），下面的直连地址需要先在本机用一次性令牌登录。',
			keepBookmark: '存一次书签即可，跨重启不变。',
			cookieHint: (days) => `登录状态有效期 ${days} 天。`,
			retry: '重试',
			phaseStarting: '还在启动中（拉起 Tailscale / 建立 Serve 路由）。',
			phaseUnavailable: 'Tailscale 没在运行，远程访问暂时不可用。',
			phaseError: '远程访问没能建起来。',
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
			rotateWarning: 'The old link stops working immediately; bookmark the new one. Phones already signed in are unaffected.',
			rotateDone: 'Changed. Save the link below again.',
			rotateFailed: 'Change failed',
			noLogin: 'The login entry is off (loginRoute=false); the direct address needs a one-time token login from this machine first.',
			keepBookmark: 'Bookmark it once — it survives restarts.',
			cookieHint: (days) => `Sign-in stays valid for ${days} days.`,
			retry: 'Retry',
			phaseStarting: 'Still starting up (bringing up Tailscale / the Serve route).',
			phaseUnavailable: 'Tailscale is not running, so remote access is unavailable.',
			phaseError: 'Remote access could not be established.',
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
				setNotice(t.rotateDone)
			}, [t])

			const canRotate = state !== null && state.canRotate === true && !busy

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
				confirming ? h('div', { style: styles.warn }, t.rotateWarning) : null,
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
		 * 注册这一行。
		 *
		 * `slots.inject` 而不是 `slots.register` 直调：`settings.general.item` 由
		 * ui-settings-general 声明，它和本包的激活顺序没有保证。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
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
		}

		exports.name = 'dsh-tailscale-remote'
		// 只要 slots；locale 走 ctx.get 可选读取（写进 inject 会在它缺席时 park 掉整包）。
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports
	},
})
