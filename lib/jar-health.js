/**
 * Live view of the auth-cookie jar, from the only place that can see it
 * without opening a browser database: the request headers arriving at the
 * Host.
 *
 * The tracker records what each request carried (how many `dsh-auth-*`
 * cookies, how many bytes), keeps the peak it has seen, and projects how many
 * launches are left before the header would cross the parser's budget. That
 * projection is what the health page shows — no SQLite, no file locks, works
 * while DSH is running, on every platform.
 */

const DEFAULT_HEADER_BYTES = 16 * 1024;

/** Cookie names in a `Cookie` header, in order. */
export function cookieNames(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return [];
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      return (separator === -1 ? pair : pair.slice(0, separator)).trim();
    });
}

/**
 * Track jar sizes as requests arrive.
 *
 * Kept deliberately small: the last sample, the peak, and per-authority
 * bookkeeping for the page's table. Nothing here is persisted.
 *
 * @returns {{
 *   observe: (sample: { cookieHeader?: string, authority?: string, budget?: number, now?: number }) => object,
 *   snapshot: (options?: { budget?: number }) => object,
 * }}
 */
export function createJarTracker() {
  let last = null;
  let peak = null;
  let observed = 0;
  const authorities = new Map();

  /** Bytes of the header that the `dsh-auth-*` cookies contribute. */
  const authBytes = (cookieHeader) => {
    if (typeof cookieHeader !== "string") return 0;
    let bytes = 0;
    for (const pair of cookieHeader.split(";")) {
      const trimmed = pair.trim();
      if (trimmed.startsWith("dsh-auth-")) bytes += Buffer.byteLength(trimmed);
    }
    return bytes;
  };

  return {
    observe({ cookieHeader = "", authority = "", now = Date.now() } = {}) {
      const names = cookieNames(cookieHeader).filter((name) => name.startsWith("dsh-auth-"));
      const sample = {
        bytes: Buffer.byteLength(cookieHeader),
        authBytes: authBytes(cookieHeader),
        cookies: names.length,
        authority,
        at: now,
      };
      last = sample;
      observed += 1;
      if (peak === null || sample.bytes > peak.bytes) peak = sample;
      if (authority) {
        const previous = authorities.get(authority);
        authorities.set(authority, {
          authority,
          cookies: sample.cookies,
          bytes: sample.bytes,
          firstSeen: previous?.firstSeen ?? now,
          lastSeen: now,
        });
        // A long-running page would otherwise grow this map with every reload.
        if (authorities.size > 64) {
          const oldest = [...authorities.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
          authorities.delete(oldest.authority);
        }
      }
      return sample;
    },

    snapshot({ budget = 0 } = {}) {
      const sample = last ?? { bytes: 0, authBytes: 0, cookies: 0, authority: null, at: null };
      const capacity = Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_HEADER_BYTES;
      const perCookie = peak !== null && peak.cookies > 0 ? Math.round(peak.bytes / peak.cookies) : null;
      const headroom = Math.max(0, capacity - sample.bytes);
      const launchesRemaining = perCookie !== null && perCookie > 0 ? Math.floor(headroom / perCookie) : null;
      return {
        budget: capacity,
        raised: sample.bytes > DEFAULT_HEADER_BYTES,
        current: {
          authority: sample.authority,
          cookies: sample.cookies,
          headerBytes: sample.bytes,
          authCookieBytes: sample.authBytes,
          at: sample.at,
        },
        peak: peak === null ? null : { cookies: peak.cookies, headerBytes: peak.bytes, at: peak.at },
        estimatedBytesPerCookie: perCookie,
        launchesRemaining,
        requestsObserved: observed,
        authoritiesObserved: authorities.size,
        recentAuthorities: [...authorities.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8),
      };
    },
  };
}