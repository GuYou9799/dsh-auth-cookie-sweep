# dsh-auth-cookie-sweep

[![npm version](https://img.shields.io/npm/v/dsh-auth-cookie-sweep.svg)](https://www.npmjs.com/package/dsh-auth-cookie-sweep)
[![CI](https://github.com/GuYou9799/dsh-auth-cookie-sweep/actions/workflows/test.yml/badge.svg)](https://github.com/GuYou9799/dsh-auth-cookie-sweep/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[简体中文](#简体中文simplified-chinese) · [English](#english)

---

## 简体中文（Simplified Chinese）

一个用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的宿主端小插件：
阻止 `dsh-auth-*` 浏览器会话 cookie 每次启动都多存一条，直到 `Cookie` 请求头越过 Node 的
16 KiB 上限、所有请求被 `431 Request Header Fields Too Large` 拒绝（有时表现为 `401`）的问题。

它修复的现象：启动几十次之后 DSH 再也打不开，网页提示 `Web authentication failed` /
`dsh web authentication required`，重启、重装、删会话都没有用。

- 不需要改 app.asar，不需要重新打包 Electron
- 没有存储、没有前端 bundle、不联网
- DSH 升级后依然有效（只依赖公开的 `webServer` 服务）
- 已经卡死在 `431` 的 profile 也能救回来：放宽请求头额度，在同一次启动里清完旧 cookie
- 测试套件零依赖

### cookie 为什么会累积

| 组件 | 行为 |
| --- | --- |
| `@deepseek-ai/dsh-desktop-host` | 用 `--port 0` 启动 Host（`lib/index.js`，参数 `["--no-open","--host","127.0.0.1","--port","0"]`），**每次启动端口都不同** |
| `@deepseek-ai/dsh-client-connection` | 浏览器 cookie 的**名字**是 `dsh-auth-` + `sha256(authority)`（`lib/index.js` 的 `cookieName()`），签名载荷同样绑定这个 authority（`authorizeIndex()` 在 `303` 换取时下发 `Set-Cookie`） |
| 浏览器 | cookie **不按端口隔离**：`127.0.0.1:41000` 与 `127.0.0.1:54326` 共用一个 jar，每次请求都会全部发送 |
| 有效期 | 30 天（`cookieMaxAgeDays`），且没有登出流程会删除旧 cookie |

于是每次启动都为新 authority 生成一条 cookie，jar 只增不减，`Cookie` 头每次启动大约增长
200 字节。到第 72 次左右跨过 16 KiB，Node 的 HTTP 解析器会在任何 handler（包括 DSH 自己的）
运行之前就拒绝请求。这就是故障会「永久」且删会话也无效的原因。

### 插件做了什么

它挂在 **Host 进程**里，分两步：先放宽请求头的额度，让「已经中毒」的 jar 能进得来人，再在这一次
响应里把旧 cookie 全部清掉。

**1. 救援额度。** Node 在解析阶段就按默认 16 KiB 拒绝请求，此时任何 JavaScript（Host 自己的 handler
和插件）都还没运行。插件在 `webServer` 已监听之后（`inject` 保证的顺序）把
`server.maxHeaderSize` 提到 128 KiB，于是那条原本会被 `431` 拒绝的启动请求能抵达 Host。

**2. 响应侧清理。** 包装响应路径上最后一处还能动手的地方：`ServerResponse.writeHead`。
对每个进来的请求它

1. 读取 `Cookie` 头与请求的 authority（HTTP 为 `host[:port]`，HTTPS 为
   `scheme://host[:port]`，与 Host 的归一化方式一致）；
2. 找出属于**其它 authority**（即旧启动）的 `dsh-auth-*` cookie；
3. 当 jar 明显陈旧时，在 Host 本来要写的响应之外追加
   `Set-Cookie: <name>=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`。

浏览器收到响应后删除这些 cookie，请求头不再增长。当前这次启动自己的 cookie 永远不会被动，
Host 的 `303` 换取响应也依旧会在同一条响应里下发新 cookie：

```http
HTTP/1.1 303 See Other
location: ./
set-cookie: dsh-auth-yLH9IP…=v1.eyJ2ZXJzaW9uIjox…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
set-cookie: dsh-auth-fkJh9Q9…=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict
set-cookie: dsh-auth-Cv1vmX3…=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict
```

#### 并发保护

单独一条「外来」`dsh-auth-*` 可能属于**另一个正在运行**的 DSH 实例（它有自己的端口）。
删掉它会让那个实例掉线，并再生成一条新 cookie。所以只在两种情况下清理：

- 外来会话 cookie 数量 ≥ `minStaleCookies`（默认 **3**），或
- 整个 `Cookie` 头已经达到/超过 `maxCookieHeaderBytes`（默认 **4096** 字节）。

多开一个实例只会多一条 cookie，不受影响；长期反复启动也不可能再累积。

### 体检页：随时看 jar 有多满（0.3.0 起）

插件在**同一个 Host、同一个 origin**上开了一页只读体检：

```
http://127.0.0.1:<本次端口>/auth-cookie-sweep
```

和 DSH 本身一样需要登录 cookie，未认证时返回 Host 的 `401`。页面直接来自 Host 收到的请求，
**不读取浏览器 cookie 数据库**，所以 DSH 运行时也能看、任何平台都能用，也不会被文件锁挡住。
它显示：

- 当前请求头占用 / 额度（含进度条）、`dsh-auth-*` 占了多少字节；
- 当前 cookie 条数、历史峰值、单条平均大小，以及**按当前速度还能启动多少次**；
- 最近见到的各个 `authority`（端口）及其 cookie 数；
- 一个「立即清理旧 Cookie（保留当前会话）」按钮：POST 到 `auth-cookie-sweep/repair`，
  清掉所有外来会话 cookie 后 `303` 回到应用。

机器可读版本在同一 origin 的 `/auth-cookie-sweep/health.json`，适合脚本或监控：

```bash
curl -s -b "dsh-auth-……=……" http://127.0.0.1:<端口>/auth-cookie-sweep/health.json
```

```json
{
  "plugin": "dsh-auth-cookie-sweep",
  "verdict": "healthy",
  "headerBudget": 131072,
  "current": { "cookies": 1, "headerBytes": 214 },
  "launchesRemaining": 595
}
```

`verdict` 为 `healthy` / `nearly-full`（< 10 次）/ `locked-out-or-close`（已满）/ `unknown`
（还没有观测到请求）。不想暴露这一页就在配置里写 `health: false`。

### 安装

本插件就是普通的 profile bundle（`dsh.bundle.patch` → `cordis.patch.yml` → 一行 `insert`）。

```bash
# 从 npm / git 安装
dsh plugin --profile web add dsh-auth-cookie-sweep
# 或者在克隆下来的目录里
dsh plugin --profile web add file:/插件的绝对路径/dsh-auth-cookie-sweep
```

`dsh plugin add` 只添加依赖，随后还需把包名加进 `~/.dsh/profiles/<profile>/package.json` 的
`dsh.profile.bundles`（如果你的插件管理器会自动维护则不用手工加）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-auth-cookie-sweep"]
    }
  }
}
```

不启动也能校验组合结果：

```bash
dsh --profile web --dump-config | grep -A2 auth-cookie-sweep
# # == dsh-auth-cookie-sweep
# - id: dsh-auth-cookie-sweep
#   name: dsh-auth-cookie-sweep
```

**桌面版：** `desktop` profile 由 Electron 应用管理（CLI 会拒绝 `dsh --profile desktop`）。
请通过应用内的插件管理器 / 插件市场安装，或自行把依赖与 bundle 条目加到
`~/.dsh/profiles/desktop/package.json` 后重启 DSH。

#### 已经打不开了怎么办（431 / `Web authentication failed`）

**0.2.0 起不用再手工清。** 上面的救援额度会让那条原本被拒的请求进到 Host，清理又在同一个响应里
完成，所以装好插件、重启一次 DSH，jar 就回到 1 条。

只有这两种情况还需要手工处理：用的是 0.2.0 之前的版本，或者把 `maxHeaderBytes` 设成了 `0`。
做法是清一次 cookie，之后由插件长期压住：

- **浏览器：** 开发者工具 → Application → Cookies → `http://127.0.0.1:<端口>` → 删除所有
  `dsh-auth-*`（或对该 origin 执行「清除站点数据」）。
- **桌面版（Electron）：** 退出 DeepSeek Harness，删除
  `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 与 `Network\Cookies-journal`，再启动。
  DSH 不依赖该存储里的其它 cookie。

### 配置

在 bundle 的 `insert` 行上加可选 `config`：

```yaml
- insert:
    - id: dsh-auth-cookie-sweep
      name: dsh-auth-cookie-sweep
      config:
        minStaleCookies: 3         # 1..256，达到多少条外来 cookie 才清理
        maxCookieHeaderBytes: 4096 # 512..16384，请求头多大就立刻清理
        maxDeletions: 256          # 1..512，单次响应最多下发多少条过期指令
        maxHeaderBytes: 131072     # 0..1048576，救援额度；0 关闭（不再修已锁死的 jar）
        health: true               # false 关闭 /auth-cookie-sweep 体检页
        secure: false              # 省略则自动跟随 Host 协议
```

非法或越界取值会被收敛到安全范围，未知字段忽略。

### 内部实现

- `lib/index.js` —— Cordis 插件：`name`、`inject: ["webServer"]`、`apply(ctx, config)`。
  `inject` 保证插件只在 `webServer[Service.init]` 创建并绑定 `node:http` 服务器**之后**激活，
  因此 `ctx.webServer.server` 一定已存在。它先调 `applyHeaderBudget(...)`，再用 `prependListener`
  挂 `request` 监听；`ctx.effect(...)` 在插件卸载时移除监听并**还原**原来的 `maxHeaderSize`，
  额度不会永久留在进程里。
- `lib/header-budget.js` —— 救援额度。Node 在构造每个连接的解析器时读取
  `server.maxHeaderSize`，因此对一个已经 `listen()` 的服务器赋值同样生效（Node 24 实测）。
  默认 128 KiB，有界、可配置、可还原。
- `lib/purge.js` —— 零依赖工具函数：authority 推导、cookie 名推导（与
  `dsh-client-connection` 逐字节一致）、陈旧判定、阈值策略，以及 `writeHead` 包装（兼容
  `(status, headers)`、`(status, message, headers)`、数组对形式的 headers，并合并
  `setHeader("set-cookie", …)` 已写入的 cookie）。
- `lib/jar-health.js` —— 只保留「最后一次请求 / 峰值 / 最近 8 个 authority」的轻量记账，
  用峰值条数估算单条大小，再按当前额度推算还能启动多少次；不持久化、不读 cookie 值。
- `lib/health-page.js` —— 体检页与 `health.json` 的渲染，以及「立即清理」的 `303` 响应。
  页面自带内联样式、`default-src 'none'` CSP、无脚本、无外部资源；authority 等插值一律 HTML 转义。
- `lib/index.js` 用 `ctx.webServer.register({ kind: "exact", path, handler })` 挂三条精确路由，
  每条都先过 `ctx.get("connection").authorizeIndex(request, response)`；卸载时随 effect 一并移除。
- 除清理时的一行计数外不输出日志；cookie 的值不会被读取、保存或打印。

#### 局限

- 救援额度的上限是 1 MiB（默认 128 KiB）。若 jar 大到连放宽后的额度都超过（约 600 次连续
  启动、且从未清理过），仍需按上一节手工清一次。
- 只能过期到达本 Host 的 cookie；其它 origin / profile 的 jar 归它们自己管理。
- 浏览器对单域名的 cookie 数量也有上限；本插件会把数量压得足够低，使该上限不会成为新的症状。

### 开发

```bash
npm test        # 零依赖的单元 + 集成 + 包清单测试（45 项）
```

`test/purge.test.mjs` 覆盖工具函数与 `writeHead` 合并的各种形态；
`test/header-budget.test.mjs` 覆盖额度的设置、还原（删除属性即回到 Node 默认）与非法取值；
`test/recovery.test.mjs` 用真实 `node:http` 服务器复现完整故障：150 条 cookie（约 17.7 KiB）
先拿到 `431`，放宽额度后同一条请求变成 `303` + 150 条 `Max-Age=0`，下一次启动只剩 1 条，
而卸载插件后同样的请求又回到 `431`；
`test/integration.test.mjs` 用真实 `node:http` 服务器模拟 300 次启动（每次一个新 authority），
断言 jar 始终 ≤ 4 条、请求头始终 < 2 KiB，并在单个响应内修复一个 20 条 cookie 的中毒 jar；
`test/package-manifest.test.mjs` 用与插件市场相同的严格解析器校验 `cordis.patch.yml`
（只允许纯 `id`/`name` 的 `- insert:` 行），防止打包后再出现“已安装但重启也不生效”；
`test/jar-health.test.mjs` 覆盖体检记账（当前 / 峰值 / 预计次数 / authority 窗口）；
`test/health-page.test.mjs` 覆盖 `verdict` 分档、HTML 转义与 CSP 形态、以及 `repair` 的有界过期；
`test/health-routes.test.mjs` 用真实 `node:http` 服务器验证三条路由：未认证 `401`、页面与
JSON `200`、`repair` `303` + 外来 cookie 过期且当前 cookie 保留、错误方法 `405`、卸载后路由消失。

已在 DeepSeek Harness `0.2.2-rc.1` 上做过实际验证（真实 `dsh-host-webserver`、固定端口）：

| 请求 | 结果 |
| --- | --- |
| 1 条外来 cookie | `401`，不清理（并发保护） |
| 3 条外来 cookie | `401` + 3 条 `Max-Age=0` |
| 合法 `?token=` + 3 条外来 | `303`，**保留**新签发 cookie + 3 条 `Max-Age=0` |
| 已认证的后续请求 | `200` |
| 合法 cookie + 20 条外来 | `200` + 20 条 `Max-Age=0` |
| 1 条外来 + 5 KiB 请求头 | 触发清理（字节阈值） |
| 150 条 cookie（17.7 KiB）+ 合法 `?token=` | `303` + 150 条 `Max-Age=0`，下一次请求 `200`（已锁死恢复） |
| 已认证 `GET /auth-cookie-sweep` | `200`，自带 CSP 的 HTML，显示当前条数 / 额度 / 预计还能启动多少次 |
| 已认证 `POST /auth-cookie-sweep/repair` | `303` + 外来 cookie 的 `Max-Age=0`，当前会话保留 |
| 未认证请求体检页 | Host 的 `401`（与其它页面一致） |

### 许可证

MIT

---

## English

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that stops
`dsh-auth-*` browser-session cookies from piling up, one per launch, until the browser's `Cookie`
request header crosses Node's 16 KiB limit and every request is rejected with
`431 Request Header Fields Too Large` (or a plain `401` once the Host gives up).

Symptom it fixes: after a few dozen launches, DSH stops opening — the web UI reports
`Web authentication failed` / `dsh web authentication required`, and no amount of restarting helps.

- No app.asar surgery, no patched Electron build
- No storage, no client bundle, no network access
- Keeps working across DSH updates (it only uses the public `webServer` service)
- Rescues a profile already stuck at `431`: the request-header budget is raised and the old cookies
  are expired during that same launch
- Shows the jar live at `/auth-cookie-sweep` — no cookie database, works while DSH is running
- Test suite has no dependencies

### Why the cookies accumulate

| Piece | Behaviour |
| --- | --- |
| `@deepseek-ai/dsh-desktop-host` | starts the Host with `--port 0` (`lib/index.js`, args `["--no-open","--host","127.0.0.1","--port","0"]`), so **every launch gets a different port** |
| `@deepseek-ai/dsh-client-connection` | the browser cookie's *name* is `dsh-auth-` + `sha256(authority)` (`lib/index.js` — `cookieName()`), and its signed payload binds the same authority (`authorizeIndex()` → `Set-Cookie` on the `303` token exchange) |
| Browsers | cookies are **not port-scoped**: `127.0.0.1:41000` and `127.0.0.1:54326` share one cookie jar, so every entry is sent on every request |
| Cookie lifetime | 30 days (`cookieMaxAgeDays`), and there is no logout path that removes old ones |

So each launch mints a cookie for a new authority, the jar never shrinks, and the `Cookie` header
grows by roughly 200 bytes per launch. Around launch 72 it passes 16 KiB and Node's HTTP parser
rejects the request before any handler (including DSH's) runs. That is why the failure is
permanent and why deleting the session does not help.

### What the plugin does

It mounts in the **Host** process and works in two steps: first it raises the request-header budget so
an already-poisoned jar can reach the Host at all, then it cleans that jar up in the very response.

**1. Rescue budget.** Node rejects the request at parse time — before any JavaScript (the Host's own
handlers and this plugin alike) runs. Once `webServer` is listening (guaranteed by `inject`), the
plugin sets `server.maxHeaderSize` to 128 KiB, so the launch request that used to die with `431`
reaches the Host.

**2. Response-side sweep.** It wraps the one place where a response is still under our control:
`ServerResponse.writeHead`. For every incoming request it

1. reads the `Cookie` header and the request's authority (`host[:port]` for HTTP,
   `scheme://host[:port]` for HTTPS — the same normalisation the Host uses),
2. computes which `dsh-auth-*` cookies belong to a *different* authority, i.e. to an older launch,
3. when the jar is clearly stale, adds `Set-Cookie: <name>=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
   next to whatever cookie the Host itself was already setting.

The browser drops those cookies on the response, and the header stops growing. The current
launch's own cookie is never touched, and the Host's `303` token exchange still sets its freshly
minted cookie in the same response:

```http
HTTP/1.1 303 See Other
location: ./
set-cookie: dsh-auth-yLH9IP…=v1.eyJ2ZXJzaW9uIjox…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
set-cookie: dsh-auth-fkJh9Q9…=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict
set-cookie: dsh-auth-Cv1vmX3…=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict
```

#### Concurrency guard

A single foreign `dsh-auth-*` cookie may belong to **another DSH instance that is running right
now** on its own port. Deleting it would log that instance out (and it would then mint yet another
cookie). The sweeper therefore cleans in two cases only:

- at least `minStaleCookies` (default **3**) foreign session cookies are present, or
- the whole `Cookie` header is already at/over `maxCookieHeaderBytes` (default **4096**).

One extra instance drifts by one cookie and is left alone; months of launches can never accumulate.

### Health page (since 0.3.0)

On the **same Host and origin** the plugin serves a read-only check-up:

```
http://127.0.0.1:<this-launch-port>/auth-cookie-sweep
```

It requires the same login cookie as DSH itself; unauthenticated callers get the Host's `401`. The
numbers come straight from the requests the Host receives — **no browser cookie database is opened**
— so it works while DSH is running, on every platform, with no file locks. It shows:

- the current `Cookie` header usage against the budget (with a meter) and how many bytes are
  `dsh-auth-*`;
- current cookie count, all-time peak, average bytes per cookie, and **how many launches are left**
  at the current rate;
- the authorities (ports) seen recently, with their cookie counts;
- a "sweep old cookies now (keep this session)" button: POSTs to `auth-cookie-sweep/repair`, expires
  every foreign session cookie, and `303`s back to the app.

A machine-readable twin lives at `/auth-cookie-sweep/health.json` for scripts and monitoring:

```bash
curl -s -b "dsh-auth-…=…" http://127.0.0.1:<port>/auth-cookie-sweep/health.json
```

```json
{
  "plugin": "dsh-auth-cookie-sweep",
  "verdict": "healthy",
  "headerBudget": 131072,
  "current": { "cookies": 1, "headerBytes": 214 },
  "launchesRemaining": 595
}
```

`verdict` is `healthy`, `nearly-full` (< 10 launches), `locked-out-or-close` (none left), or
`unknown` (no request observed yet). Set `health: false` to stop serving the page.

### Install

The plugin is a normal profile bundle (`dsh.bundle.patch` → `cordis.patch.yml` → one `insert` row).

```bash
# from npm / a git checkout
dsh plugin --profile web add dsh-auth-cookie-sweep
# or, in a cloned checkout
dsh plugin --profile web add file:/absolute/path/to/dsh-auth-cookie-sweep
```

Then make sure the bundle is composed. `dsh plugin add` only adds the dependency, so add the name
to `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json` unless your plugin manager
does it for you:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-auth-cookie-sweep"]
    }
  }
}
```

Verify without booting anything:

```bash
dsh --profile web --dump-config | grep -A2 auth-cookie-sweep
# # == dsh-auth-cookie-sweep
# - id: dsh-auth-cookie-sweep
#   name: dsh-auth-cookie-sweep
```

**Desktop app:** the `desktop` profile is managed by the Electron app (`dsh --profile desktop` is
refused by the CLI). Install through the app's plugin manager / marketplace, or add the dependency
and the bundle entry to `~/.dsh/profiles/desktop/package.json` yourself and restart DSH.

#### Already broken?

**Since 0.2.0 you do not have to clear anything by hand.** The rescue budget lets the rejected
request through, and the sweep finishes in that same response, so one restart after installing the
plugin brings the jar back to a single cookie.

Two cases still need a manual clean: a version before 0.2.0, or `maxHeaderBytes` set to `0`. Clear
the cookies once — after that the sweeper keeps the jar small:

- **Browser:** DevTools → Application → Cookies → `http://127.0.0.1:<port>` → delete every
  `dsh-auth-*` entry (or "Clear site data" for that origin).
- **Desktop app (Electron):** quit DeepSeek Harness, delete
  `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` and `Network\Cookies-journal`, start it
  again. DSH does not depend on any other cookie in that store.

### Configuration

Optional `config` on the bundle's `insert` row:

```yaml
- insert:
    - id: dsh-auth-cookie-sweep
      name: dsh-auth-cookie-sweep
      config:
        minStaleCookies: 3        # 1..256, foreign cookies before cleaning
        maxCookieHeaderBytes: 4096 # 512..16384, clean as soon as the header is this big
        maxDeletions: 256         # 1..512, expiries per response
        maxHeaderBytes: 131072    # 0..1048576, rescue budget; 0 disables rescue
        health: true              # false stops serving /auth-cookie-sweep
        secure: false             # omit to follow the Host protocol automatically
```

Wrong or out-of-range values are clamped; unknown keys are ignored.

### How it works internally

- `lib/index.js` — the Cordis plugin: `name`, `inject: ["webServer"]`, `apply(ctx, config)`.
  `inject` guarantees the plugin only activates **after** `webServer[Service.init]` created and
  bound the `node:http` server, so `ctx.webServer.server` is present. It calls
  `applyHeaderBudget(...)` first, then adds a `request` listener with `prependListener`; one
  `ctx.effect(...)` disposer removes the listener and **restores** the previous `maxHeaderSize`, so
  the budget never lingers in the process.
- `lib/header-budget.js` — the rescue budget. Node reads `server.maxHeaderSize` when it builds a
  connection's parser, so assigning it on a server that is already listening takes effect (verified
  on Node 24). 128 KiB by default: bounded, configurable, restorable.
- `lib/purge.js` — dependency-free helpers: authority derivation, cookie-name derivation
  (byte-compatible with `dsh-client-connection`), stale detection, threshold policy, and the
  `writeHead` wrapper (handles `(status, headers)`, `(status, message, headers)`, array-of-pairs
  headers, and merges a cookie already staged with `setHeader("set-cookie", …)`).
- `lib/jar-health.js` — tiny bookkeeping: last request, peak, and the recent-8 authorities. Average
  bytes per cookie times the current budget yields the launches-left estimate. Nothing persisted,
  no cookie value read.
- `lib/health-page.js` — renders the page and `health.json`, and builds the `303` repair response.
  Inline styles only, `default-src 'none'` CSP, no scripts, no external assets; the authority is
  HTML-escaped.
- `lib/index.js` registers three `kind: "exact"` routes with `ctx.webServer.register(...)`, each
  guarded by `ctx.get("connection").authorizeIndex(request, response)`; disposal follows the
  plugin's effects.
- Nothing is logged beyond a one-line count when cookies are expired; cookie values are never
  read, stored, or printed.

#### Limitations

- The rescue budget tops out at 1 MiB (128 KiB by default). A jar larger than even the raised budget
  (~600 launches in a row, never cleaned) still needs the manual clear above.
- Only expires cookies that arrive at this Host; other origins/profiles keep their own jars.
- Browsers also cap the number of cookies per domain; the sweeper keeps the count low enough that
  this cap never becomes the new symptom.

### Development

```bash
npm test        # dependency-free unit + integration + package-manifest tests (45 cases)
```

`test/purge.test.mjs` covers the helpers and the `writeHead` merge variants;
`test/header-budget.test.mjs` covers raising the budget, restoring it (deleting the property returns
to Node's default) and rejecting invalid values;
`test/recovery.test.mjs` reproduces the whole failure against a real `node:http` server: 150 cookies
(~17.7 KiB) first get `431`, the same request becomes `303` + 150 × `Max-Age=0` once the budget is
raised, the next launch carries one cookie, and unloading the plugin puts the request back to `431`;
`test/integration.test.mjs` runs a real `node:http` server and simulates 300 launches with a fresh
authority each time, asserting the jar stays ≤ 4 cookies and the header stays < 2 KiB — then
rehabilitates a 20-cookie poisoned jar in a single response.
`test/package-manifest.test.mjs` validates `cordis.patch.yml` with the same strict parser the plugin
market uses (plain `id`/`name` insert rows only), so a published tarball can never again install as
"installed, but still waiting for a restart".
`test/jar-health.test.mjs` covers the bookkeeping (current, peak, launches-left, authority window);
`test/health-page.test.mjs` covers the verdict thresholds, HTML escaping and CSP shape, and the
bounded repair expiries;
`test/health-routes.test.mjs` runs a real `node:http` server through the plugin and asserts the three
routes: `401` unauthenticated, `200` for the page and JSON, `303` + foreign expiries (current cookie
kept) for repair, `405` on a wrong method, and routes gone after disposal.

Live check performed against DeepSeek Harness `0.2.2-rc.1` (Host on a fixed port, real
`dsh-host-webserver`):

| Request | Result |
| --- | --- |
| 1 foreign cookie | `401`, no expiry (concurrency guard) |
| 3 foreign cookies | `401` + 3 × `Max-Age=0` |
| valid `?token=` + 3 foreign | `303`, minted cookie **kept** + 3 × `Max-Age=0` |
| authenticated follow-up | `200` |
| valid cookie + 20 foreign | `200` + 20 × `Max-Age=0` |
| 1 foreign + 5 KiB header | expiry (byte threshold) |
| 150 cookies (17.7 KiB) + valid `?token=` | `303` + 150 × `Max-Age=0`, follow-up `200` (locked-out rescue) |
| authenticated `GET /auth-cookie-sweep` | `200`, self-contained HTML with CSP, current count / budget / launches left |
| authenticated `POST /auth-cookie-sweep/repair` | `303` + foreign `Max-Age=0`, current session kept |
| unauthenticated health request | Host's `401` (same as its other pages) |

### License

MIT