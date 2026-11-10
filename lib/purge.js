/**
 * Host-side stale-cookie sweeper for DeepSeek Harness.
 *
 * Why this exists: `dsh-host-webserver` binds an OS-assigned port on every
 * launch, and the browser-session cookie from `dsh-client-connection` is bound
 * to `<host>:<port>` in both its deterministic name and its signed payload.
 * A new port therefore means a new cookie *name*, so every launch adds one more
 * `dsh-auth-*` cookie to the browser jar. Cookies are not port-scoped, so the
 * jar keeps sending all of them and the Cookie request header grows until
 * Node's 16 KiB header limit rejects the request with 431.
 *
 * The sweep cannot live in the request path alone: Node parses (and rejects)
 * the headers before any JavaScript listener runs. It lives in the *response*
 * path: expire the cookies this launch does not need with `Max-Age=0`, so the
 * browser drops them and the header stops growing. Reaching that response once
 * the header is already over the limit is `header-budget.js`'s job — it raises
 * the parser's budget so this sweep gets to run on the poisoned request.
 *
 * This module is deliberately dependency-free and side-effect-free outside the
 * supplied `response`, so it can be unit-tested without a running Host.
 */

import { createHash } from "node:crypto";

/** The prefix `dsh-client-connection` uses for browser-session cookies. */
export const AUTH_COOKIE_PREFIX = "dsh-auth-";

/** The `Expires` value every browser already treats as "in the past". */
const DELETION_EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";

/**
 * Derive the cookie audience exactly as the Host does: the `host[:port]` for
 * plain HTTP and the full `scheme://host[:port]` origin for TLS. Keeping this
 * byte-identical to `requestAudience()` in `dsh-client-connection` is what
 * makes the current launch's own cookie recognizable.
 *
 * @param {{ headers?: Record<string, unknown> }} request - the incoming request.
 * @param {boolean} secure - whether the listener serves TLS.
 * @returns {string | undefined} the authority, or undefined when unusable.
 */
export function authorityFrom(request, secure) {
  const raw = request?.headers?.host;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const url = new URL(`${secure ? "https:" : "http:"}//${raw}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}

/**
 * Compute the cookie name the Host mints for one authority.
 *
 * Mirrors `cookieName()` in `dsh-client-connection`: SHA-256 over the authority
 * text, base64url without padding, behind the shared prefix.
 *
 * @param {string} authority - the normalized authority.
 * @returns {string} the cookie name.
 */
export function authCookieName(authority) {
  const digest = createHash("sha256").update(authority).digest("base64");
  return AUTH_COOKIE_PREFIX + digest.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * List the `dsh-auth-*` cookies in one Cookie header that the current launch
 * cannot use, in header order, without duplicates.
 *
 * @param {string | undefined} cookieHeader - the raw `Cookie` header.
 * @param {string | undefined} authority - the authority of the current listener.
 * @returns {string[]} names to expire.
 */
export function staleAuthCookies(cookieHeader, authority) {
  if (typeof cookieHeader !== "string" || authority === undefined) return [];
  if (!cookieHeader.includes(AUTH_COOKIE_PREFIX)) return [];
  const current = authCookieName(authority);
  const stale = [];
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    const name = segment.slice(0, separator).trim();
    if (!name.startsWith(AUTH_COOKIE_PREFIX) || name === current) continue;
    if (!stale.includes(name)) stale.push(name);
  }
  return stale;
}

/**
 * Serialize one cookie-expiry header. The attributes mirror the Host's own
 * cookie (`Path=/`, `HttpOnly`, `SameSite=Strict`, plus `Secure` on TLS) so the
 * browser matches and removes the exact cookie rather than creating a variant.
 *
 * @param {string} name - the cookie name.
 * @param {boolean} secure - whether the listener serves TLS.
 * @returns {string} the `Set-Cookie` value.
 */
export function deletionCookie(name, secure) {
  const attributes = `${name}=; Max-Age=0; Path=/; Expires=${DELETION_EXPIRES}; HttpOnly; SameSite=Strict`;
  return secure ? `${attributes}; Secure` : attributes;
}

/**
 * Decide whether this request should carry cookie expiries.
 *
 * Two independent triggers keep concurrent Hosts working: a small number of
 * foreign cookies is tolerated (they may belong to another instance running on
 * its own port right now), while a large jar or an already-dangerous header is
 * cleaned regardless. That way one extra `dsh web` never logs the other one
 * out, but months of launches still cannot accumulate.
 *
 * @param {string[]} stale - foreign cookie names seen in this request.
 * @param {string | undefined} cookieHeader - the raw `Cookie` header.
 * @param {{ minStaleCookies: number, maxCookieHeaderBytes: number }} options - thresholds.
 * @returns {boolean} whether to install the expiries.
 */
export function shouldExpire(stale, cookieHeader, options) {
  if (stale.length === 0) return false;
  if (stale.length >= options.minStaleCookies) return true;
  const bytes = typeof cookieHeader === "string" ? Buffer.byteLength(cookieHeader) : 0;
  return bytes >= options.maxCookieHeaderBytes;
}

/**
 * Normalize the plugin config: unknown values fall back to safe defaults and
 * every clamp keeps the sweeper from ever running unbounded.
 *
 * `maxDeletions` defaults high enough to clear a fully poisoned jar in one
 * response (the observed failure was ~72 cookies), while `maxHeaderBytes` is
 * the rescue budget from `header-budget.js`; `0` disables the rescue.
 *
 * @param {unknown} config - raw plugin config from the profile.
 * @returns {{ minStaleCookies: number, maxCookieHeaderBytes: number, maxDeletions: number, maxHeaderBytes: number, secure: boolean | undefined }} settings.
 */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === "object" ? config : {};
  const integer = (value, fallback, minimum, maximum) =>
    Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  return {
    minStaleCookies: integer(source.minStaleCookies, 3, 1, 256),
    maxCookieHeaderBytes: integer(source.maxCookieHeaderBytes, 4096, 512, 16384),
    maxDeletions: integer(source.maxDeletions, 256, 1, 512),
    maxHeaderBytes: Number.isInteger(source.maxHeaderBytes)
      ? Math.min(1024 * 1024, Math.max(0, source.maxHeaderBytes))
      : 128 * 1024,
    secure: typeof source.secure === "boolean" ? source.secure : undefined,
  };
}

/** Read a `set-cookie` value as an array. */
function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/** Find the `set-cookie` key regardless of its casing, as Node accepts both. */
function findSetCookieKey(headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "set-cookie") return key;
  }
  return undefined;
}

/** Copy caller headers into a mutable object (arrays of pairs included). */
function headerObject(headers) {
  if (headers === undefined || headers === null) return {};
  if (Array.isArray(headers)) {
    const object = {};
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const key = String(entry[0]);
      const previous = object[key];
      object[key] = previous === undefined ? String(entry[1]) : [].concat(previous, String(entry[1]));
    }
    return object;
  }
  if (typeof headers === "object") return { ...headers };
  return {};
}

/**
 * Install the expiries on one response.
 *
 * The Host writes its session cookie through `res.writeHead(status, headers)`
 * (and also through the `(status, statusMessage, headers)` form), so wrapping
 * `writeHead` is where extra `Set-Cookie` values can still be added. The
 * wrapper merges with whatever the handler already set instead of replacing
 * it: the launch redirect keeps its minted cookie, and the stale ones ride
 * along in the same response.
 *
 * @param {{ headers?: Record<string, any> }} request - the incoming request.
 * @param {import("node:http").ServerResponse} response - the response to decorate.
 * @param {{ minStaleCookies: number, maxCookieHeaderBytes: number, maxDeletions: number, secure?: boolean }} options - settings.
 * @returns {number} how many cookies this response expires (0 = untouched).
 */
export function attachCookiePurge(request, response, options) {
  const cookieHeader = request?.headers?.cookie;
  const secure = options.secure === true;
  const stale = staleAuthCookies(cookieHeader, authorityFrom(request, secure));
  if (!shouldExpire(stale, cookieHeader, options)) return 0;

  const names = stale.slice(0, options.maxDeletions);
  const deletions = names.map((name) => deletionCookie(name, secure));
  const writeHead = response.writeHead;

  response.writeHead = function writeHeadWithCookiePurge(statusCode, statusMessage, headers) {
    const hasMessage = typeof statusMessage === "string";
    const message = hasMessage ? statusMessage : undefined;
    const explicit = headerObject(hasMessage ? headers : statusMessage);
    const key = findSetCookieKey(explicit);
    const existing = key === undefined ? asList(response.getHeader("set-cookie")) : asList(explicit[key]);
    if (key !== undefined) delete explicit[key];
    explicit["set-cookie"] = existing.concat(deletions);
    return message === undefined
      ? writeHead.call(this, statusCode, explicit)
      : writeHead.call(this, statusCode, message, explicit);
  };

  return names.length;
}