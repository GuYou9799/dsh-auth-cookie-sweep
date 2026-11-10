/**
 * The health page: a self-contained HTML document plus the response the repair
 * button produces.
 *
 * It exists because every other jar counter has to read the browser's cookie
 * database — locked while DSH runs, Windows-only in practice, and one of them
 * moves the database. The Host already sees every request, so the same numbers
 * are available here with no file access at all.
 */

import { authorityFrom, deletionCookie, REPAIR_HEADER, staleAuthCookies } from "./purge.js";

export { REPAIR_HEADER };

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
};

const formatAge = (at, now) => {
  if (!Number.isFinite(at)) return "-";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

/**
 * The JSON document served to tooling.
 *
 * @param {object} snapshot - from `createJarTracker().snapshot()`.
 * @param {{ version?: string, now?: number }} [options]
 * @returns {object} serialisable status.
 */
export function healthDocument(snapshot, { version = "0.0.0", now = Date.now() } = {}) {
  const remaining = snapshot.launchesRemaining;
  return {
    plugin: "dsh-auth-cookie-sweep",
    version,
    checkedAt: new Date(now).toISOString(),
    headerBudget: snapshot.budget,
    usage: snapshot.budget > 0 ? Math.min(1, snapshot.current.headerBytes / snapshot.budget) : 0,
    current: snapshot.current,
    peak: snapshot.peak,
    estimatedBytesPerCookie: snapshot.estimatedBytesPerCookie,
    launchesRemaining: remaining,
    verdict:
      remaining === null
        ? "unknown"
        : remaining <= 0
          ? "locked-out-or-close"
          : remaining < 10
            ? "nearly-full"
            : "healthy",
    requestsObserved: snapshot.requestsObserved,
    authoritiesObserved: snapshot.authoritiesObserved,
  };
}

/**
 * The page itself: one file, no scripts, no network, inline styles only.
 *
 * @param {object} snapshot - from `createJarTracker().snapshot()`.
 * @param {{ version?: string, now?: number }} [options]
 * @returns {string} HTML.
 */
export function renderHealthPage(snapshot, { version = "0.0.0", now = Date.now() } = {}) {
  const document = healthDocument(snapshot, { version, now });
  const usagePercent = Math.round(document.usage * 100);
  const barWidth = Math.min(100, usagePercent);
  const barColour = usagePercent >= 80 ? "#c2410c" : usagePercent >= 50 ? "#a16207" : "#15803d";
  const remaining =
    document.launchesRemaining === null ? "—" : String(document.launchesRemaining);
  const rows = snapshot.recentAuthorities
    .map(
      (entry) => `<tr>
        <td><code>${escapeHtml(entry.authority)}</code></td>
        <td>${entry.cookies}</td>
        <td>${formatBytes(entry.bytes)}</td>
        <td>${formatAge(entry.lastSeen, now)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-auth-cookie-sweep · 登录 Cookie 体检</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 2rem auto; max-width: 46rem; padding: 0 1rem;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  p.lede { margin-top: 0; opacity: .7; }
  .card { border: 1px solid rgba(127,127,127,.35); border-radius: .6rem; padding: 1rem; margin: 1rem 0; }
  .meter { height: .6rem; background: rgba(127,127,127,.2); border-radius: .3rem; overflow: hidden; margin: .5rem 0 .25rem; }
  .meter > span { display: block; height: 100%; width: ${barWidth}%; background: ${barColour}; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: .5rem 0 0; }
  dt { opacity: .7; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid rgba(127,127,127,.25); }
  form { margin-top: 1rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: .45rem; border: 1px solid rgba(127,127,127,.5); cursor: pointer; }
  footer { opacity: .6; font-size: .85rem; margin-top: 2rem; }
  code { font-size: .85em; }
</style>
</head>
<body>
<h1>登录 Cookie 体检</h1>
<p class="lede">由 Host 在请求里直接观测，不读取浏览器数据库，DSH 运行时也能看。 ·
  Observed from the Host's own requests — no cookie database is opened.</p>

<div class="card">
  <div class="meter"><span></span></div>
  <dl>
    <dt>请求头占用 / budget</dt><dd>${formatBytes(document.current.headerBytes)} / ${formatBytes(document.budget)}（${usagePercent}%）</dd>
    <dt>当前 cookie 条数 / cookies</dt><dd>${document.current.cookies}</dd>
    <dt>其中 dsh-auth 字节 / auth bytes</dt><dd>${formatBytes(document.current.authCookieBytes)}</dd>
    <dt>预计还能启动 / launches left</dt><dd>${remaining}</dd>
    <dt>历史峰值 / peak</dt><dd>${document.peak ? `${document.peak.cookies} 条 · ${formatBytes(document.peak.headerBytes)}` : "—"}</dd>
    <dt>单条平均 / per cookie</dt><dd>${document.estimatedBytesPerCookie === null ? "—" : formatBytes(document.estimatedBytesPerCookie)}</dd>
    <dt>观测到的请求数 / requests</dt><dd>${document.requestsObserved}</dd>
  </dl>
  <form method="post" action="auth-cookie-sweep/repair">
    <button type="submit">立即清理旧 Cookie（保留当前会话）/ Sweep old cookies now</button>
  </form>
</div>

<div class="card">
  <h2 style="font-size:1rem;margin:0 0 .5rem">最近的 authority / recent authorities</h2>
  <table>
    <thead><tr><th>authority</th><th>cookies</th><th>header</th><th>last seen</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>

<footer>dsh-auth-cookie-sweep ${escapeHtml(version)} · 插件会继续阻止 cookie 累积，本页只用于查看与手动清理。</footer>
</body>
</html>`;
}

/**
 * The repair response: expire every `dsh-auth-*` cookie that this request does
 * not need, then send the browser back to the app.
 *
 * `force` semantics differ from the automatic sweep only in that the caller
 * asked for it: no threshold applies, every foreign cookie goes (still bounded
 * by `maxDeletions`).
 *
 * @param {import("node:http").IncomingMessage} request - the request being answered.
 * @param {{ maxDeletions: number, maxCookieHeaderBytes: number, minStaleCookies: number, secure?: boolean }} settings
 * @param {{ secure?: boolean, now?: number }} [options]
 * @returns {{ status: number, headers: Record<string, string | string[]>, expired: number }}
 */
export function repairResponse(request, settings, { secure = settings.secure ?? false } = {}) {
  const authority = authorityFrom(request, secure);
  const cookieHeader = typeof request.headers.cookie === "string" ? request.headers.cookie : "";
  const stale = cookieHeader === "" ? [] : staleAuthCookies(cookieHeader, authority);
  const chosen = stale.slice(0, Math.max(1, settings.maxDeletions));
  const headers = {
    "cache-control": "no-store",
    location: "./",
    referrer_policy: "no-referrer",
    [REPAIR_HEADER]: String(chosen.length),
  };
  if (chosen.length > 0) headers["set-cookie"] = chosen.map((name) => deletionCookie(name, secure));
  return { status: 303, headers, expired: chosen.length };
}