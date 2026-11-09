# dsh-auth-cookie-sweep

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

它挂在 **Host 进程**里，包装响应路径上最后一处还能动手的地方：`ServerResponse.writeHead`。
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

#### 已经打不开了怎么办

插件无法拯救**已经**超过 16 KiB 的 jar：Node 在解析阶段就拒绝了请求，任何 JavaScript（无论
插件还是 Host）都不会被执行。需要先手工清一次 cookie，之后插件会把它长期压住：

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
        maxDeletions: 64           # 1..512，单次响应最多下发多少条过期指令
        secure: false              # 省略则自动跟随 Host 协议
```

非法或越界取值会被收敛到安全范围，未知字段忽略。

### 内部实现

- `lib/index.js` —— Cordis 插件：`name`、`inject: ["webServer"]`、`apply(ctx, config)`。
  `inject` 保证插件只在 `webServer[Service.init]` 创建并绑定 `node:http` 服务器**之后**激活，
  因此 `ctx.webServer.server` 一定已存在。它用 `prependListener` 挂 `request` 监听，并通过
  `ctx.effect(...)` 在插件卸载时移除。
- `lib/purge.js` —— 零依赖工具函数：authority 推导、cookie 名推导（与
  `dsh-client-connection` 逐字节一致）、陈旧判定、阈值策略，以及 `writeHead` 包装（兼容
  `(status, headers)`、`(status, message, headers)`、数组对形式的 headers，并合并
  `setHeader("set-cookie", …)` 已写入的 cookie）。
- 除清理时的一行计数外不输出日志；cookie 的值不会被读取、保存或打印。

#### 局限

- 对已经被 Node 以 `431` 拒绝的请求无能为力（见「已经打不开了怎么办」）。
- 只能过期到达本 Host 的 cookie；其它 origin / profile 的 jar 归它们自己管理。
- 浏览器对单域名的 cookie 数量也有上限；本插件会把数量压得足够低，使该上限不会成为新的症状。

### 开发

```bash
node --test test/        # 零依赖的单元 + 集成测试
```

`test/purge.test.mjs` 覆盖工具函数与 `writeHead` 合并的各种形态；
`test/integration.test.mjs` 用真实 `node:http` 服务器模拟 300 次启动（每次一个新 authority），
断言 jar 始终 ≤ 4 条、请求头始终 < 2 KiB，并在单个响应内修复一个 20 条 cookie 的中毒 jar。

已在 DeepSeek Harness `0.2.2-rc.1` 上做过实际验证（真实 `dsh-host-webserver`、固定端口）：

| 请求 | 结果 |
| --- | --- |
| 1 条外来 cookie | `401`，不清理（并发保护） |
| 3 条外来 cookie | `401` + 3 条 `Max-Age=0` |
| 合法 `?token=` + 3 条外来 | `303`，**保留**新签发 cookie + 3 条 `Max-Age=0` |
| 已认证的后续请求 | `200` |
| 合法 cookie + 20 条外来 | `200` + 20 条 `Max-Age=0` |
| 1 条外来 + 5 KiB 请求头 | 触发清理（字节阈值） |

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

It mounts in the **Host** process and wraps the one place where a response is still under our
control: `ServerResponse.writeHead`. For every incoming request it

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

The plugin cannot rescue a jar that is **already** over 16 KiB: Node parses and rejects the header
before any handler runs, so no JavaScript (plugin or Host) ever sees the request. Clear the
cookies once — after that the sweeper keeps the jar small:

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
        maxDeletions: 64          # 1..512, expiries per response
        secure: false             # omit to follow the Host protocol automatically
```

Wrong or out-of-range values are clamped; unknown keys are ignored.

### How it works internally

- `lib/index.js` — the Cordis plugin: `name`, `inject: ["webServer"]`, `apply(ctx, config)`.
  `inject` guarantees the plugin only activates **after** `webServer[Service.init]` created and
  bound the `node:http` server, so `ctx.webServer.server` is present. It adds a `request` listener
  with `prependListener` and removes it through `ctx.effect(...)` when the plugin unloads.
- `lib/purge.js` — dependency-free helpers: authority derivation, cookie-name derivation
  (byte-compatible with `dsh-client-connection`), stale detection, threshold policy, and the
  `writeHead` wrapper (handles `(status, headers)`, `(status, message, headers)`, array-of-pairs
  headers, and merges a cookie already staged with `setHeader("set-cookie", …)`).
- Nothing is logged beyond a one-line count when cookies are expired; cookie values are never
  read, stored, or printed.

#### Limitations

- Cannot help a request whose header Node already rejected with `431` (see *Already broken?*).
- Only expires cookies that arrive at this Host; other origins/profiles keep their own jars.
- Browsers also cap the number of cookies per domain; the sweeper keeps the count low enough that
  this cap never becomes the new symptom.

### Development

```bash
node --test test/        # dependency-free unit + integration tests
```

`test/purge.test.mjs` covers the helpers and the `writeHead` merge variants;
`test/integration.test.mjs` runs a real `node:http` server and simulates 300 launches with a fresh
authority each time, asserting the jar stays ≤ 4 cookies and the header stays < 2 KiB — then
rehabilitates a 20-cookie poisoned jar in a single response.

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

### License

MIT