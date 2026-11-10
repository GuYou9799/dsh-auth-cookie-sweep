/**
 * dsh-auth-cookie-sweep — stop `dsh-auth-*` browser-session cookies from
 * accumulating one per DeepSeek Harness launch, and rescue a profile that is
 * already locked out by them.
 *
 * The plugin rides on the Host's HTTP server. It first raises the parser's
 * request-header budget (an already-poisoned jar never reaches a listener
 * otherwise), then, for every request, inspects the `Cookie` header and, when
 * the jar holds cookies minted for an older authority, answers with
 * `Set-Cookie: <name>=; Max-Age=0` alongside the response the Host was already
 * going to send. The browser deletes them, the header stops growing, and
 * launching DSH hundreds of times stays safe.
 *
 * It is a plain Cordis plugin: no client half, no storage, no tools.
 */

import { applyHeaderBudget, restoreHeaderBudget } from "./header-budget.js";
import { attachCookiePurge, normalizeConfig } from "./purge.js";

/** Plugin name shown in the profile tree. */
export const name = "dsh-auth-cookie-sweep";

/** The listener belongs to the web server; without one the plugin stays idle. */
export const inject = ["webServer"];

/**
 * Activate the sweeper on the bound listener.
 *
 * `webServer` is only injected once its fiber is active, i.e. after
 * `[Service.init]` has created and bound the `node:http` server, so
 * `ctx.webServer.server` is always present here.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - the plugin context.
 * @param {unknown} config - optional user config from the profile.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const server = ctx.webServer?.server;
  if (!server || typeof server.prependListener !== "function") {
    ctx.logger?.warn?.("dsh-auth-cookie-sweep: webServer has no bound listener; nothing to do");
    return;
  }

  // Rescue an already-poisoned jar BEFORE installing the listener: Node parses
  // (and rejects) the headers before any listener runs, so a profile stuck at
  // 431 would otherwise never get a response to carry the expiries.
  let budget;
  if (settings.maxHeaderBytes > 0) {
    budget = applyHeaderBudget(server, settings.maxHeaderBytes);
    if (budget.applied) {
      const was = budget.previous === undefined ? "Node's default" : `${budget.previous} bytes`;
      ctx.logger?.info?.(
        `dsh-auth-cookie-sweep: request-header budget raised from ${was} to ${settings.maxHeaderBytes} bytes`,
      );
    } else {
      ctx.logger?.warn?.(
        `dsh-auth-cookie-sweep: could not raise the request-header budget; an already-poisoned jar may still fail with 431`,
      );
    }
  }

  /** Expire stale browser-session cookies on the response the Host is about to write. */
  const listener = (request, response) => {
    try {
      const secure = settings.secure ?? ctx.webServer.protocol === "https:";
      const expired = attachCookiePurge(request, response, { ...settings, secure });
      if (expired > 0) {
        ctx.logger?.info?.(`dsh-auth-cookie-sweep: expiring ${expired} stale dsh-auth-* cookie(s)`);
      }
    } catch (error) {
      // A sweep failure must never break a request: the Host's own handler
      // still owns the response and would fail closed with a 500 without it.
      ctx.logger?.warn?.(`dsh-auth-cookie-sweep: skipped cookie purge: ${String(error)}`);
    }
  };

  server.prependListener("request", listener);
  ctx.effect(
    () => () => {
      server.off("request", listener);
      if (budget?.applied) restoreHeaderBudget(server, budget.previous);
    },
    "dsh-auth-cookie-sweep: stale-session-cookie purge",
  );
}