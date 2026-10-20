# dsh-tailscale-remote

打开 DSH 就把本机 Web GUI 通过 **Tailscale Serve** 暴露到你的 tailnet 上，手机在任何网络下
打开一个网址就能用；DSH 退出时把这条路由撤掉。手机链接直接显示在
**「设置 → 通用 → 手机连接」**里，点一下就能复制。

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件。
> 只需要「随时随地用手机连上自己电脑上的 DSH」这一件事，不引入任何第三方中转。

## 先看这个：手机怎么进

**最省事的办法：DSH 里打开「设置 → 通用」，往下找到「手机连接」那一行，里面就有链接，
点一下「复制」，发到手机上打开一次即可。** 那一行还能随时「更换密钥」——万一链接泄露，
换了之后旧链接和所有旧登录一起失效。

不想开 DSH 界面时，读状态文件也一样（字段是 `loginUrl`）：

```sh
# 装好并重启 DSH 后，执行（Windows 用 PowerShell 见下）
cat ~/.dsh/tailscale-remote.json
```

读里面 **`loginUrl`** 那个值，形如：

```
https://<你的机器>.<tailnet>.ts.net:7259/remote/<持久密钥>
```

**在手机浏览器打开它一次**（会自动跳转并登录），然后**存成书签/主屏幕图标** ——
这条链接跨重启不变，以后点一下就进。

Windows PowerShell 读法：

```powershell
Get-Content "$env:USERPROFILE\.dsh\tailscale-remote.json"
```

就这么两步：**拿到 `loginUrl` → 手机打开一次并存书签**。下面都是细节。

> DSH 的 Web GUI 要求一次**登录令牌**，没令牌只显示一句
> `dsh web authentication required; ...`。DSH Desktop 又**从不打印**那行链接，令牌还每次重启都换 ——
> 所以插件给你一条**存一次就永久用**的入口。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-tailscale-remote
```

装完**重启 DSH**（新包需要重启才会加载）。之后每次开 DSH 它都会自己跑起来。

也可以从本地目录装：

```sh
dsh plugin --profile <profile> add -w /path/to/dsh-tailscale-remote
```

## 它做什么

启动时：

1. 确认 `tailscale` 真的在跑（**用 `tailscale status --json` 验证 `BackendState`，
   不是相信 `tailscale up` 的退出码** —— 见下文）。
2. 把 `https://<你的机器>.<tailnet>.ts.net:7259` 代理到 DSH 自己的 Web 端口
   （端口从 `webServer` 服务上读，不写死）。
3. 把 `<你的机器>.<tailnet>.ts.net:7259` 加进 DSH `/api` 的 Host 信任列表。
4. 打印手机可用的网址，并写一份到 `$DSH_HOME/tailscale-remote.json`。
5. **精简手机那个页面**（默认开，见下文）：只发手机真正需要的客户端插件，首屏插件
   从约 5.3 MB gzip 降到约 1.3 MB。桌面端不受影响。

退出时：只回滚**本次运行自己做过的事**——撤掉 7259 的路由、移除信任项；只有 tailscale
本来就是关着、由 DSH 拉起来的情况下才 `tailscale down`。

> 例外：如果 7259 上已经有一条**精确指向本实例 DSH 端口**的路由（几乎只可能是上次
> DSH 崩溃/被强杀留下的），插件会把它**认领**下来，退出时一并撤掉 —— 否则崩溃恢复
> 之后「关 DSH 就关掉」会永远失效，路由一直留在那儿。

## 为什么必须动信任列表

`tailscale serve` **保留客户端的 Host 头**（实测：从 tailnet 地址访问时，后端收到的
`host` 就是 `xxx.ts.net:7259`）。而 DSH 的 `/api` fence 要求 Host 是回环地址或命中
`trustedHosts`，否则一律 403 —— 表现为**手机上页面能打开、但一发消息就报错**。
插件在运行时把该 authority 推进 `connection.trustedHosts`（这是个可变数组，fence 每次
请求都读它），所以不需要改 profile 的 `cordis.yml`。

## 手机上怎么用（重点：怎么拿到登录链接）

DSH 的 Web GUI 默认要求一次**登录令牌**才让你进去，没有令牌就只显示一句话：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

麻烦的地方在于：**DSH Desktop 从不打印这行链接**（它走 IPC，不走 `dsh web`），而令牌又是
**进程级**的、每次重启都换。所以本插件给你三个拿链接的地方，任选其一。

### ① 设置页里的「手机连接」行（推荐）

**设置 → 通用**，滚到下面有「手机连接」这一行：

- 里面是**手机登录链接**，一个只读输入框 + 「复制」按钮，点一下就能发到手机上。
- 旁边有「更换密钥」：点一下会先让你确认，确认后**旧密钥与所有旧登录一起失效**。
  - **换的到底是什么**：登录链接（`/remote/<密钥>`）只负责**换取**一张会话 cookie。
    密钥泄露后，如果对方已经用它登录过，他手里那张 cookie 是另一把签名密钥签的、
    有效期 10 年 —— 只换登录密钥完全不影响它。所以这里的「更换密钥」会**同时**换掉
    登录密钥**和**会话签名密钥，让泄露的密钥真正失效。
  - **代价**：所有设备（包括你自己的手机）都会被登出，需要用新链接重新登录一次。
    **点按钮的这台设备会被自动补发一张新 cookie、不掉线**，所以在电脑上操作最顺手。
  - 想只换链接、不踢设备？设 `revokeSessionsOnRotate: false`（此时泄露的旧 cookie
    仍然有效，只适合「我确定没人用过那条链接」的情况）。
- 还没就绪时会直接告诉你卡在哪一步（比如「Tailscale 没在运行」），而不是给你一个空框。

> 这一行只在你**打开设置页**时才请求一次状态（外加窗口重新获得焦点时刷新一次），
> 不轮询、不挂定时器。它注册在 DSH 自己的 `/api` 上，所以**只有已登录的浏览器**能读。

### ② 稳定登录入口（存一次书签就够）

插件会在 DSH 自己的 webserver 上注册一条路由：

```
https://<你的机器>.<tailnet>.ts.net:7259/remote/<持久密钥>
```

打开它就会 **302 跳转**到带令牌的地址、种下 cookie，然后你就进 GUI 了。

这条链接的密钥存在状态文件里，**跨重启不变** —— 所以手机上存一次书签，以后点一下就进。

> 密钥本身就是访问门槛：不知道它的人拿不到会话（和 DSH 自己的令牌同一级别）。
> 不需要的话可以设 `loginRoute: false` 关掉。

### ③ 状态文件（永远可以查到）

任何一次启动后，下面这个文件里都有**当前**可用的链接：

```sh
# 三个字段：loginUrl（稳定入口）、url（一次性令牌链接）、plainUrl（干净地址）
cat ~/.dsh/tailscale-remote.json
```

Windows PowerShell：

```powershell
Get-Content "$env:USERPROFILE\.dsh\tailscale-remote.json"
```

拿 `loginUrl` 那个值，在手机上打开即可。它同时也会打到 DSH 的日志里。

### 登录之后

cookie 种下后，直接访问干净地址 `https://<机器>.<tailnet>.ts.net:7259/` 就能进，
可以「添加到主屏幕」当 App 用。

**cookie 有效期默认 10 年**（见下面的 `cookieMaxAgeDays`）—— DSH 原版是 30 天，对
「手机随时连」太短，插件启动时会把 `connection` 上那个活的 `maxAgeMilliseconds`
直接改长。所以正常情况下你**只需要登录一次**。

> 手机上好不好用：**实测可用**。DSH 0.2.0-rc.2 的 Web 前端确实**没有专门的移动端外壳**
> （JS 无 `matchMedia`，CSS 里只有 `prefers-reduced-motion`、没有宽度断点），但它的三栏是
> 弹性布局，在手机宽度下会自然收窄，日常查看会话、发消息、看结果都没问题，不会挤成一条。
> 想要更像 App 的体验（抽屉侧栏、底部导航）需要另外写客户端插件。

## 前置条件

- 本机已安装并登录 Tailscale。
- 该 tailnet 已启用 HTTPS 证书（Tailscale 管理台 → DNS → HTTPS Certificates）。
  没启用时 `tailscale serve` 会失败，日志里会提示。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则插件完全不动作。 |
| `httpsPort` | `7259` | tailnet 上的 HTTPS 端口。 |
| `connectOnStart` | `true` | tailscale 没在跑时是否把它拉起来。 |
| `serveOnStart` | `true` | 是否建立 Serve 路由。 |
| `teardownOnExit` | `true` | 退出时是否回滚。 |
| `trustedHosts` | `true` | 是否把该 authority 加进 `/api` 信任列表。 |
| `loginRoute` | `true` | 是否注册 `/remote/<持久密钥>` 这个稳定登录入口（设置页那一行的「更换密钥」也依赖它）。 |
| `revokeSessionsOnRotate` | `true` | 换密钥时是否**同时吊销所有已登录的会话**。默认开：密钥泄露时对方可能已用旧密钥换到一张 10 年 cookie，只换登录密钥拦不住他。关掉则只换链接、所有设备继续登录。 |
| `cookieMaxAgeDays` | `3650` | 登录 cookie 有效期（天）。`0` = 不插手 DSH 的 30 天默认值。 |
| `binaryPath` | 自动探测 | `tailscale` CLI 可执行文件路径。 |
| `guiPath` | 自动探测 | Tailscale **桌面客户端**路径（Windows 默认 `tailscale-ipn.exe`）。 |
| `readyTimeoutMs` | `8000` | 等 `tailscale up` 生效的预算。 |
| `guiReadyTimeoutMs` | `25000` | 启动桌面客户端后等 backend 就绪的预算。 |
| `stateFile` | `$DSH_HOME/tailscale-remote.json` | 状态文件位置。 |
| `lite` | `true` | **精简模式**默认值：手机那个页面只带基础插件（首屏插件从约 5.3 MB gzip 降到约 1.1 MB）。**桌面端不受影响**。侧边栏底部的图标点一下可以随时改，改了就以那个持久选择为准。 |
| `liteSeeds` | 内置白名单 | 精简模式保留哪些插件（闭包种子）。只在 DSH 升级改包名、你想自己补几个包时才需要。 |
| `liteHide` | 内置列表 | 精简页面上要藏掉的界面锚点（CSS 选择器）。默认藏掉右侧栏与轨迹页签。**设置入口永远不藏**（手机上进设置页只有那一个地方）。 |
| `websocketCompression` | `true` | 给 DSH 那条 WebSocket（`/api/remote.mux`，会话历史走它）开 `permessage-deflate`。**惰性**挂钩：启动期零开销，第一次握手时才 patch。 |

### 精简模式（手机流量省 79%）

DSH 的 Web 首屏会把插件图里**每一个**客户端包 preload 下来，本机实测约 **5.3 MB（gzip）**。
其中大半手机根本用不到：设置里的账号插画单个包就 2.4 MB，还有插件管理器、模型设置、
各种第三方面板。手机走 Tailscale 时带宽窄，这些字节是纯粹的负担。

插件的做法是**不动 DSH 一行代码**，只在**渲染出来的 index.html** 上做手术：

1. 用一份白名单在活的插件图上求**闭包**，得到精简图（实测 30/86 个包）；
2. 把 `globalThis["__DSH_BOOT__"]` 换成精简图 —— 客户端于是只认这些包；
3. 把整图那些首屏 preload 换成精简版，由插件自己的路由服务，并用 **brotli** 压
   （比 webserver 默认的 gzip level 1 再省约 32%）；
4. 在 head 里补一段 `<style>`，把右侧栏、轨迹页签藏掉，顺手把
   「工作区」标题行里搜索按钮前面那段硬编码空白归零。

**桌面端一个字节都不会变。** Electron 不走这条路：它直接读磁盘上的 index.html，
再经 IPC 把注入表交给客户端；而 `tapIndex` 只参与 `webServer.renderIndex()`，
也就是 HTTP 那条回退路径。所以「不动桌面 DSH」是结构保证，不是小心翼翼。
另外**客户端半边在桌面窗口里一个插槽都不注册**（判据是 preload 注入的
`dshDesktopBoot`，只有桌面窗口才有），所以桌面上的 DSH 与没装本插件时完全一致。

实测（真浏览器 + 真宿主）：精简页面的插件请求只有**两个** —— 一个 bootstrap 小包加一个
合并请求，首屏不再有那条约 5 MB 的 `/plugins/??...`；页面照常启动、连接正常、
工作区与会话列表、输入框全部可用，控制台零报错。

**怎么切换**：精简页面上，侧边栏底部「设置」图标**旁边**多了一个**图标按钮**
（16×16 的双向箭头，与 DSH 自己的图标同规格）。点一下在「精简 / 完整」之间切换：

- 关掉后**刷新手机上的页面**，就会发完整版（所有插件）。
- 站点本身立刻记录这个选择，但**页面是在下一次渲染 index 时变的** —— 所以按钮的
  `title` / `aria-label` 会写清「刷新后生效」，否则看起来像按钮坏了。
- 完整模式页面里**不显示这个图标**（那时完整模式页面跟手机上没区别，用不着它）。
- **桌面窗口里根本没有这个图标**（连插槽都不注册）。
- 设置图标本身**始终保留**：`sidebar.settings` 是 single 插槽、由 `ui-settings` 注册在
  侧边栏底部，是手机上进设置页的唯一入口，藏了就没法改模型/账号/插件了。

> 为什么不能简单地「把不要的包从图里删掉就算完」：`exports.inject` 是**服务级**
> 门禁。像 `ui-sidebar-right` 提供的 `sidebarRight` 被 `ui-chat` 硬依赖，删了它
> `ui-chat` 的 fiber 会停在 `pending`，而 shell 的 boot 审计把 `pending` 算失败，
> **整页白屏**。所以这类包留着、只藏界面；真正能删的是那些没人依赖其服务的。

安全阀：如果白名单在活图上失配（DSH 升级拆包/改名），插件**原样发完整页面**并记一条日志
—— 宁可多发几 MB，也绝不发一个进不去设置页的残缺页面给手机（那里用户没有任何自救手段）。

### 手机中途连接为什么快了很多

「刷新页面」只是第一段。手机真正难熬的是**中途操作**：载入历史会话、发命令、收流式回复。
这两件事走的是完全不同的两条路，插件各修了一处：

**① 拉会话历史 / 收事件 = 一条 WebSocket，而 DSH 默认完全不压它。**
会话历史不走 HTTP，走 `/api/remote.mux`；DSH 用 `new WebSocketServer({ noServer: true })`
建它，而 `ws` 的 `perMessageDeflate` 默认是 `false`。实测握手响应里**没有**
`sec-websocket-extensions` —— 那些高度重复的 JSON 事件是明文过的（一个界面 12 KB 的会话，
背后收进了 22.5 MB 下行文本）。

插件在 `ws.WebSocketServer.prototype.handleUpgrade` 上补一层：把 `this.options.perMessageDeflate`
打开。位置很关键 —— `ws` 在 `handleUpgrade` 内部**同步**用 `this.options` 构造 socket，
所以在这里改一定生效，没有竞态。打的又是 DSH 自己那一个 `ws` 模块实例（从 `process.resourcesPath`
下的 `app.asar` 解析），所以对已经建好的 mux 也生效，**不用重启、不碰 DSH 一行代码**。

**② 启动开销为零。** `require('ws')` 要从 asar 里读并编译，实测 **159 ms** —— 花在启动路径上
就是「插件拖慢了启动」。所以这个 patch 是**惰性**的：启动期只挂一个一次性钩子
（`server.prependListener('upgrade')`，只观察不消费事件），等**第一次** WS 握手路过时再 patch。
那 159 ms 于是落在手机那条连接上，而不是你的启动路径上（实测装配耗时 0.04 ms）。

**③ 首屏合并请求自己压。** webserver 的 gzip 是 level 1（约 1.30 MB），同一份字节用
brotli q5 约 0.89 MB、gzip level 6 约 1.06 MB。插件自己压并**缓存**结果（只算一次），
按 `Accept-Encoding` 协商 `br` → `gzip` → 原文，并带 `Vary: Accept-Encoding`。

### 关于「永久不过期」

DSH 把 cookie 有效期上限写死在 `connection` 的 `cookieMaxAgeDays` 里，并且校验时要求
`expiresAt - issuedAt <= maxAgeMilliseconds` —— 所以**自己造一个超长 cookie 是无效的**，
必须改这个上限。本插件启动时会直接改 `connection.browserAuth.maxAgeMilliseconds`，
默认给 10 年（`3650` 天），够用且不会溢出 JS 安全整数范围。

想更长就把它调大（比如 `36500` = 100 年）；`0` 表示完全不动 DSH 的默认 30 天。

## 为什么不能只调 `tailscale up`

在 Windows 上，如果你从托盘把 Tailscale **完全退出**，tailscaled 服务还在跑，但 backend
处于 `NoState`（`tailscale status` 报 `Tailscale is starting. Please wait.`）。此时
**`tailscale up` 会「立刻 exit 0、不输出任何东西、也什么都不做」**（实测），backend 永远
不会变成 `Running` —— 只看退出码就会误判成功，然后因为读不到 DNS 名而静默放弃。

所以插件**每一步都用 `tailscale status --json` 验证 `BackendState`，而不是相信退出码**：
`tailscale up` 之后 backend 还不是 `Running`，就改为启动**桌面客户端**
（`tailscale-ipn.exe`），它才会真正初始化 backend（实测启动后立刻 `Running` + `Online`）。
桌面客户端以 detached 方式启动，不会随 DSH 退出而被带走。

如果连客户端都拉不起来（例如需要交互式登录），插件会留下明确提示让你手动打开 Tailscale，
并且**不会**谎报成功去配一条连不上的路由。

## 发布（维护者）

包名 `dsh-tailscale-remote` 已发布到 npm。`package.json` 里写了 `publishConfig`
（`access: public` + `registry: https://registry.npmjs.org/`），所以**直接 `npm publish`
不带任何参数**就会发到正确的地方——即使本机 `~/.npmrc` 指向的是镜像站。

后续版本**自动发布**：推送到 `main` 时 `.github/workflows/publish.yml` 会先跑测试再
`npm publish`——但**只有 `package.json` 里的 `version` 是 registry 上还没有的版本时才发**。
所以发版流程就是两步：

1. 改 `package.json` 的 `version`。
2. 推送到 `main`。

这次运行要么发出这个版本，要么报告「该版本已在线上」并以成功结束。
**没改版本号的推送是 no-op，不是失败**——所以每个要发出去的改动都必须自己带一次版本号
变更；只改文档的提交同样会触发工作流，同样 no-op。

认证用 npm **Trusted Publishing（OIDC）**：GitHub 给这个 job 签一个短时 token，npm 拿它换
一个只对这一个包有效的发布 token。**仓库里没有任何 `NPM_TOKEN` secret。** 工作流刻意
**不用** `actions/setup-node` 的 `registry-url` 输入——它会往 `~/.npmrc` 写
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`，而该变量没定义时这个占位符会
原样留下、被 npm 当作 token 发出去。registry 交给 `publishConfig` 就够了。

<details>
<summary>一次性配置：绑定 Trusted Publisher</summary>

Trusted Publisher **只能绑到 registry 上已存在的包**，所以**首次发布是手工做的**
（在检出目录里跑了一次 `npm publish`），从第二个版本起才轮到工作流接管。在 npmjs.com 上：
包 → Settings → Trusted Publisher → GitHub Actions，填

| 字段 | 值 |
|---|---|
| Repository | `Ckarefulon/dsh-tailscale-remote` |
| Workflow filename | `publish.yml` |
| Environment | *留空* |

文件名必须**逐字一致**——npm 把授权绑在它上面，写错会表现为发布报 `ENEEDAUTH`。

</details>

## 安全边界

这条路由**只对你的 tailnet 可见**（Tailscale Serve 的默认范围，不是 Funnel），也就是说
只有登录到你这个 tailnet 的设备能连上。DSH 自己的浏览器鉴权（30 天签名 cookie）仍然
生效，两层是叠加的。

设置页那一行背后的两个端点注册在 DSH 自己的 `/api` 前缀路由上
（`connection.fetch`），因此**直接白拿 DSH 的 Host/Origin fence 与浏览器 cookie 鉴权**：
未登录的请求在到达插件之前就被 401 挡掉了。它们也刻意**不用**
`webServer.register({ kind: 'exact', path: '/api/...' })` —— `webserver` 的 `match()`
先查 exact 表，那样会**抢先命中**并遮掉整条 `/api` 路由，把 fence 和鉴权一起绕过去。

| 端点 | 作用 |
| --- | --- |
| `GET /api/dsh-tailscale-remote/state` | 当前阶段、手机链接、能否换密钥、换密钥会不会踢设备、精简模式开着没有、这份页面是不是精简版。不缓存。 |
| `POST /api/dsh-tailscale-remote/rotate` | 换一把新登录密钥，并（默认）吊销所有已登录的会话；给发起方补发一张新 cookie。 |
| `POST /api/dsh-tailscale-remote/lite` | 切换精简模式（`{ enabled: true|false }`）。写进状态文件，跨重启保留。只有真的有 Web 渲染路径时才可用。 |

精简模式的合并请求走插件自己的前缀路由 `/remote-lite-plugins/...`，**不是** `/plugins` ——
后者已经是 `@deepseek-ai/dsh-client-modules` 的前缀路由，重复注册会直接抛错。

该路由刻意**不**走 DSH 的浏览器鉴权：它服务的正是**尚未登录**的那一次首屏请求
（页面必须先拿到脚本才能种 cookie），而且里面只有「这个插件图里本来就会发给该页面的字节」。
`/api` 那三个端点则完全依赖 DSH 的 fence 与鉴权。

### 「更换密钥」到底吊销了什么

DSH 的浏览器鉴权有两把独立的密钥，别把它们混为一谈：

| | 作用 | 换了它会怎样 |
| --- | --- | --- |
| **登录密钥**（本插件的 `/remote/<密钥>`） | 换取会话 cookie 的入口 | 旧链接立刻 404 |
| **会话签名密钥**（`connection.browserAuth.secret`，存在 credentials 的 `client-connection/browser-session` 记录里） | 给会话 cookie 签名 | 所有已发出的 cookie 立刻验不过 |

**只换登录密钥是不够的**：泄露的链接如果已经被用过，对方手里那张 cookie 由第二把密钥
签名、有效期 10 年，换第一把对它毫无影响。所以默认两把一起换（`revokeSessionsOnRotate`）。

实现上两处都要改，缺一不可：credentials 记录（**持久**，否则 DSH 一重启就把旧密钥读回来、
旧 cookie 复活）和活着的 `browserAuth.secret`（**立即生效**，它按引用逐字比较签名）。
写入后会**回读确认**：写错记录键或被只读来源遮蔽时 `modifyRecord` 会「成功返回但记录没变」，
不校验的话就是「报成功、实则没换」。

想彻底踢掉已登录设备也可以直接去改 DSH 自己的凭据 —— 那等于把第二把密钥换掉，效果一样，
但会一并影响其它依赖它的东西；用本插件这一行更精确，而且会顺手把新链接给你。

插件**不会覆盖** 7259 上已有的、指向别处的 Serve 配置：检测到冲突就只记日志、不动手。
唯一会接管的情况是发现一条指向**另一个回环端口**的陈旧路由（通常是上次 DSH 换了端口
留下的）。
