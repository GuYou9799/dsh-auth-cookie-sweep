/**
 * dsh-auth-cookie-sweep — stop `dsh-auth-*` browser-session cookies from
 * accumulating one per DeepSeek Harness launch, rescue a profile that is
 * already locked out by them, and show the jar's health from the Host's own
 * request view.
 *
 * The plugin rides on the Host's HTTP server. It first raises the parser's
 * request-header budget (an already-poisoned jar never reaches a listener
 * otherwise), then, for every request, inspects the `Cookie` header and, when
 * the jar holds cookies minted for an older authority, answers with
 * `Set-Cookie: <name>=; Max-Age=0` alongside the response the Host was already
 * going to send. The browser deletes them, the header stops growing, and
 * launching DSH hundreds of times stays safe.
 *
 * Because the same requests are the only trustworthy view of the jar while the
 * app runs, the plugin also serves a small authenticated page at
 * `/auth-cookie-sweep` (plus `health.json` and a `repair` POST) — no browser
 * database is ever opened, so it works on every platform and while DSH is
 * running.
 *
 * It is a plain Cordis plugin: no client half, no storage, no tools.
 */

import { applyHeaderBudget, restoreHeaderBudget } from "./header-budget.js";
import { healthDocument, renderHealthPage, repairResponse } from "./health-page.js";
import { createJarTracker } from "./jar-health.js";
import { attachCookiePurge, authorityFrom, normalizeConfig } from "./purge.js";
import { VERSION } from "./version.js";

/** Plugin name shown in the profile tree. */
export const name = "dsh-auth-cookie-sweep";

/** The listener belongs to the web server; without one the plugin stays idle. */
export const inject = ["webServer"];

/** Where the health page lives. */
export const HEALTH_PATH = "/auth-cookie-sweep";
/** Machine-readable twin of the page. */
export const HEALTH_JSON_PATH = "/auth-cookie-sweep/health.json";
/** POST target of the page's repair button. */
export const REPAIR_PATH = "/auth-cookie-sweep/repair";

const HTML_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

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

  const tracker = createJarTracker();
  const secureFor = () => settings.secure ?? ctx.webServer.protocol === "https:";

  /** Expire stale browser-session cookies on the response the Host is about to write. */
  const listener = (request, response) => {
    try {
      const secure = secureFor();
      tracker.observe({
        cookieHeader: request.headers.cookie,
        authority: authorityFrom(request, secure),
      });
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

  /**
   * Serve one route, refusing unauthenticated callers the same way the Host's
   * own pages do. `authorizeIndex` writes the 401 itself and returns false.
   */
  const guarded = (handler) => (request, response) => {
    try {
      const connection = ctx.get?.("connection") ?? ctx.connection;
      if (connection && typeof connection.authorizeIndex === "function") {
        if (!connection.authorizeIndex(request, response)) return;
      }
      handler(request, response);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-auth-cookie-sweep: health route failed: ${String(error)}`);
      if (!response.headersSent && !response.writableEnded) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("dsh-auth-cookie-sweep: internal error\n");
      }
    }
  };

  if (config?.health !== false) {
    const routes = [
      {
        kind: "exact",
        path: HEALTH_PATH,
        handler: guarded((request, response) => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { allow: "GET, HEAD" });
            response.end();
            return;
          }
          const snapshot = tracker.snapshot({ budget: settings.maxHeaderBytes });
          response.writeHead(200, HTML_HEADERS);
          response.end(
            request.method === "HEAD" ? undefined : renderHealthPage(snapshot, { version: VERSION }),
          );
        }),
      },
      {
        kind: "exact",
        path: HEALTH_JSON_PATH,
        handler: guarded((request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          const snapshot = tracker.snapshot({ budget: settings.maxHeaderBytes });
          response.writeHead(200, JSON_HEADERS);
          response.end(`${JSON.stringify(healthDocument(snapshot, { version: VERSION }), null, 2)}\n`);
        }),
      },
      {
        kind: "exact",
        path: REPAIR_PATH,
        handler: guarded((request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          const result = repairResponse(request, settings, { secure: secureFor() });
          ctx.logger?.info?.(
            `dsh-auth-cookie-sweep: manual repair expired ${result.expired} stale cookie(s)`,
          );
          response.writeHead(result.status, result.headers);
          response.end();
        }),
      },
    ];

    const register = typeof ctx.webServer.register === "function"
      ? ctx.webServer.register.bind(ctx.webServer)
      : undefined;
    if (register !== undefined) {
      for (const route of routes) {
        try {
          ctx.effect(() => register(route), `dsh-auth-cookie-sweep: ${route.path}`);
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-auth-cookie-sweep: could not register ${route.path}: ${String(error)}`,
          );
        }
      }
    }
  }

  ctx.effect(
    () => () => {
      server.off("request", listener);
      if (budget?.applied) restoreHeaderBudget(server, budget.previous);
    },
    "dsh-auth-cookie-sweep: stale-session-cookie purge",
  );
}