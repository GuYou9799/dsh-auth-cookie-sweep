/**
 * Header-budget rescue for an already-poisoned cookie jar.
 *
 * The sweep in `purge.js` stops the jar from growing, but it cannot help a
 * profile that is already locked out: the Cookie header is parsed *before* any
 * `request` listener runs, so Node answers 431 and the desktop shell reports
 * `desktop welcome: Web authentication failed` — the Host never gets a chance
 * to expire anything.
 *
 * Node reads `server.maxHeaderSize` when it builds a connection's parser, and
 * the property can be set on a server that is already listening (verified on
 * Node 24.21: set after `listen()`, a 20 KB header that was answered with 431
 * becomes a normal 200). Raising it once, at plugin activation, is therefore
 * enough to let the poisoned request through — and the sweep then expires every
 * foreign cookie in that same response, so the jar is back to one cookie.
 *
 * The budget is bounded and configurable, and the previous value is restored on
 * dispose: this never becomes an unlimited header parser.
 */

/** 128 KiB — roughly 600 launches of slack, the same order as the failure mode. */
export const DEFAULT_MAX_HEADER_BYTES = 128 * 1024;

/**
 * Raise one server's header budget.
 *
 * @param {{ maxHeaderSize?: number }} server - the Host's `node:http(s)` server.
 * @param {number} bytes - the new budget; `0` or less leaves the server alone.
 * @returns {{ previous: number | undefined, applied: boolean }} what to restore.
 */
export function applyHeaderBudget(server, bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) return { previous: undefined, applied: false };
  const previous = server.maxHeaderSize;
  server.maxHeaderSize = bytes;
  return { previous, applied: server.maxHeaderSize === bytes };
}

/**
 * Put the server back the way it was.
 *
 * Node's default applies when the property is absent, so an undefined previous
 * value is restored by deleting it rather than assigning undefined.
 *
 * @param {{ maxHeaderSize?: number }} server - the same server.
 * @param {number | undefined} previous - the value returned by `applyHeaderBudget`.
 * @returns {void}
 */
export function restoreHeaderBudget(server, previous) {
  try {
    if (previous === undefined) delete server.maxHeaderSize;
    else server.maxHeaderSize = previous;
  } catch {
    // A frozen or replaced server is not worth failing a dispose over.
  }
}