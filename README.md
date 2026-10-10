# dsh-tailscale-remote

打开 DSH 就把本机 Web GUI 通过 **Tailscale Serve** 暴露到你的 tailnet 上，手机在任何网络下
打开一个网址就能用；DSH 退出时把这条路由撤掉。

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件。
> 只需要「随时随地用手机连上自己电脑上的 DSH」这一件事，不引入任何第三方中转。

## 安装

```sh
dsh plugin --profile <你的 profile> add github:Ckarefulon/dsh-tailscale-remote
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
**进程级**的、每次重启都换。所以本插件做了两件事，让你**只需要拿一次链接**：

### ① 稳定登录入口（推荐，存一次书签就够）

插件会在 DSH 自己的 webserver 上注册一条路由：

```
https://<你的机器>.<tailnet>.ts.net:7259/remote/<持久密钥>
```

打开它就会 **302 跳转**到带令牌的地址、种下 cookie，然后你就进 GUI 了。

这条链接的密钥存在状态文件里，**跨重启不变** —— 所以手机上存一次书签，以后点一下就进。

> 密钥本身就是访问门槛：不知道它的人拿不到会话（和 DSH 自己的令牌同一级别）。
> 不需要的话可以设 `loginRoute: false` 关掉。

### ② 状态文件（永远可以查到）

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

> 注意：DSH 0.2.0-rc.2 的 Web 前端**没有响应式布局**（JS 无 `matchMedia`，CSS 里只有
> `prefers-reduced-motion`，没有宽度断点），所以在手机上打开是桌面三栏挤在一起 ——
> 能操作，但不精致。想要手机专属界面需要自己写客户端插件。

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
| `loginRoute` | `true` | 是否注册 `/remote/<持久密钥>` 这个稳定登录入口。 |
| `cookieMaxAgeDays` | `3650` | 登录 cookie 有效期（天）。`0` = 不插手 DSH 的 30 天默认值。 |
| `binaryPath` | 自动探测 | `tailscale` CLI 可执行文件路径。 |
| `guiPath` | 自动探测 | Tailscale **桌面客户端**路径（Windows 默认 `tailscale-ipn.exe`）。 |
| `readyTimeoutMs` | `8000` | 等 `tailscale up` 生效的预算。 |
| `guiReadyTimeoutMs` | `25000` | 启动桌面客户端后等 backend 就绪的预算。 |
| `stateFile` | `$DSH_HOME/tailscale-remote.json` | 状态文件位置。 |

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

## 安全边界

这条路由**只对你的 tailnet 可见**（Tailscale Serve 的默认范围，不是 Funnel），也就是说
只有登录到你这个 tailnet 的设备能连上。DSH 自己的浏览器鉴权（30 天签名 cookie）仍然
生效，两层是叠加的。

插件**不会覆盖** 7259 上已有的、指向别处的 Serve 配置：检测到冲突就只记日志、不动手。
唯一会接管的情况是发现一条指向**另一个回环端口**的陈旧路由（通常是上次 DSH 换了端口
留下的）。
