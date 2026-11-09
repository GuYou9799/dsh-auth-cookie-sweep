import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  attachCookiePurge,
  authorityFrom,
  authCookieName,
  deletionCookie,
  normalizeConfig,
  shouldExpire,
  staleAuthCookies,
} from "../lib/purge.js";
import { apply, inject, name as pluginName } from "../lib/index.js";

/** Build the cookie the Host mints for one authority (shape matches the real one). */
function mintedCookie(authority) {
  return `${authCookieName(authority)}=v1.${"A".repeat(60)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`;
}

/** A request-like object with just the headers the sweeper reads. */
function requestWith(headers) {
  return { headers };
}

/** Minimal ServerResponse stand-in: records the headers writeHead receives. */
function responseStub({ pending } = {}) {
  const seen = {};
  const stub = {
    seen,
    getHeader(key) {
      return key.toLowerCase() === "set-cookie" ? pending : undefined;
    },
    writeHead(statusCode, statusMessage, headers) {
      seen.statusCode = statusCode;
      if (typeof statusMessage === "string") {
        seen.statusMessage = statusMessage;
        seen.headers = headers;
      } else {
        seen.headers = statusMessage;
      }
      seen.headersSent = true;
      return stub;
    },
  };
  return stub;
}

test("authorityFrom matches the Host's HTTP and TLS spelling", () => {
  assert.equal(authorityFrom(requestWith({ host: "127.0.0.1:54326" }), false), "127.0.0.1:54326");
  assert.equal(authorityFrom(requestWith({ host: "127.0.0.1:54326" }), true), "https://127.0.0.1:54326");
  assert.equal(authorityFrom(requestWith({}), false), undefined);
  assert.equal(authorityFrom(requestWith({ host: "not a host" }), false), undefined);
});

test("authCookieName reproduces the Host's deterministic name", () => {
  const authority = "127.0.0.1:54326";
  const digest = createHash("sha256").update(authority).digest("base64")
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  assert.equal(authCookieName(authority), `dsh-auth-${digest}`);
  assert.equal(authCookieName(authority).length, 52);
  assert.match(authCookieName(authority), /^dsh-auth-[A-Za-z0-9_-]{43}$/u);
});

test("staleAuthCookies keeps the current cookie and dedupes the rest", () => {
  const currentAuthority = "127.0.0.1:54326";
  const current = authCookieName(currentAuthority);
  const older = authCookieName("127.0.0.1:41000");
  const older2 = authCookieName("127.0.0.1:42000");
  const header = [
    `${older}=v1.a`,
    `${current}=v1.b`,
    `${older2}=v1.c`,
    `${older}=v1.d`,
    "dsh_account=someone",
    "sessionid=abc",
    "untouched",
  ].join("; ");

  assert.deepEqual(staleAuthCookies(header, currentAuthority), [older, older2]);
  assert.equal(staleAuthCookies(undefined, currentAuthority).length, 0);
  assert.equal(staleAuthCookies(header, undefined).length, 0);
  assert.equal(staleAuthCookies(`${current}=v1.b`, currentAuthority).length, 0);
});

test("shouldExpire tolerates a little drift but cleans a big jar", () => {
  const options = { minStaleCookies: 3, maxCookieHeaderBytes: 4096 };
  assert.equal(shouldExpire([], "dsh-auth-x=1", options), false);
  assert.equal(shouldExpire(["a", "b"], "dsh-auth-x=1", options), false);
  assert.equal(shouldExpire(["a", "b", "c"], "dsh-auth-x=1", options), true);
  assert.equal(shouldExpire(["a"], "x".repeat(4096), options), true);
});

test("normalizeConfig clamps nonsense and keeps sane values", () => {
  assert.deepEqual(normalizeConfig(undefined), {
    minStaleCookies: 3,
    maxCookieHeaderBytes: 4096,
    maxDeletions: 64,
    secure: undefined,
  });
  assert.deepEqual(normalizeConfig({ minStaleCookies: 0, maxCookieHeaderBytes: 1, maxDeletions: 9999, secure: true }), {
    minStaleCookies: 1,
    maxCookieHeaderBytes: 512,
    maxDeletions: 512,
    secure: true,
  });
  assert.equal(normalizeConfig("nonsense").minStaleCookies, 3);
  assert.equal(normalizeConfig({ minStaleCookies: 12 }).minStaleCookies, 12);
});

test("deletionCookie mirrors the Host's cookie attributes", () => {
  const plain = deletionCookie("dsh-auth-x", false);
  assert.match(plain, /^dsh-auth-x=; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/u);
  assert.match(deletionCookie("dsh-auth-x", true), /; Secure$/u);
});

test("attachCookiePurge adds expiries beside the cookie the Host mints", () => {
  const authority = "127.0.0.1:54326";
  const current = authCookieName(authority);
  const older = authCookieName("127.0.0.1:41000");
  const request = requestWith({
    host: authority,
    cookie: `${older}=v1.a; ${current}=v1.b`,
  });
  const response = responseStub();
  const expired = attachCookiePurge(request, response, { minStaleCookies: 1, maxCookieHeaderBytes: 4096, maxDeletions: 64 });

  assert.equal(expired, 1);
  response.writeHead(303, { location: "./", "set-cookie": mintedCookie(authority) });
  assert.equal(response.seen.statusCode, 303);
  assert.deepEqual(response.seen.headers["set-cookie"], [
    mintedCookie(authority),
    deletionCookie(older, false),
  ]);
  assert.equal(response.seen.headers.location, "./");
});

test("attachCookiePurge keeps the (status, message, headers) form working", () => {
  const authority = "127.0.0.1:54326";
  const staleName = authCookieName("127.0.0.1:41000");
  const request = requestWith({ host: authority, cookie: `${staleName}=v1.a` });
  const response = responseStub();
  assert.equal(attachCookiePurge(request, response, { minStaleCookies: 1, maxCookieHeaderBytes: 4096, maxDeletions: 64 }), 1);

  response.writeHead(200, "OK", { "content-type": "text/plain" });
  assert.equal(response.seen.statusMessage, "OK");
  assert.equal(response.seen.headers["content-type"], "text/plain");
  assert.deepEqual(response.seen.headers["set-cookie"], [deletionCookie(staleName, false)]);
});

test("attachCookiePurge merges a cookie set earlier with setHeader", () => {
  const authority = "127.0.0.1:54326";
  const minted = mintedCookie(authority);
  const staleName = authCookieName("127.0.0.1:41000");
  const request = requestWith({ host: authority, cookie: `${staleName}=v1.a` });
  const response = responseStub({ pending: minted });
  attachCookiePurge(request, response, { minStaleCookies: 1, maxCookieHeaderBytes: 4096, maxDeletions: 64 });

  response.writeHead(200, { "content-type": "text/html" });
  assert.deepEqual(response.seen.headers["set-cookie"], [minted, deletionCookie(staleName, false)]);
});

test("attachCookiePurge leaves responses alone below the threshold", () => {
  const authority = "127.0.0.1:54326";
  const staleName = authCookieName("127.0.0.1:41000");
  const request = requestWith({ host: authority, cookie: `${staleName}=v1.a` });
  const response = responseStub();
  assert.equal(attachCookiePurge(request, response, { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 64 }), 0);

  const headers = { "set-cookie": "other=1" };
  response.writeHead(200, headers);
  assert.deepEqual(response.seen.headers, headers);
});

test("attachCookiePurge honors maxDeletions", () => {
  const authority = "127.0.0.1:54326";
  const names = Array.from({ length: 5 }, (_, index) => authCookieName(`127.0.0.1:${41000 + index}`));
  const request = requestWith({ host: authority, cookie: names.map((name) => `${name}=v1.a`).join("; ") });
  const response = responseStub();
  assert.equal(attachCookiePurge(request, response, { minStaleCookies: 1, maxCookieHeaderBytes: 4096, maxDeletions: 2 }), 2);

  response.writeHead(200, {});
  assert.deepEqual(response.seen.headers["set-cookie"], names.slice(0, 2).map((name) => deletionCookie(name, false)));
});

test("plugin metadata and listener wiring", () => {
  assert.equal(pluginName, "dsh-auth-cookie-sweep");
  assert.deepEqual(inject, ["webServer"]);

  const listeners = new Map();
  const server = {
    prependListener(event, listener) {
      listeners.set(event, listener);
    },
    off(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  let cleanup;
  const warnings = [];
  const ctx = {
    webServer: { server, protocol: "http:" },
    logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    effect(callback) {
      cleanup = callback();
    },
  };

  apply(ctx, { minStaleCookies: 1 });
  const listener = listeners.get("request");
  assert.equal(typeof listener, "function");

  const staleName = authCookieName("127.0.0.1:41000");
  const request = requestWith({ host: "127.0.0.1:54326", cookie: `${staleName}=v1.a` });
  const response = responseStub();
  listener(request, response);
  response.writeHead(303, {});
  assert.deepEqual(response.seen.headers["set-cookie"], [deletionCookie(staleName, false)]);

  cleanup();
  assert.equal(listeners.has("request"), false);
  assert.deepEqual(warnings, []);
});

test("plugin apply refuses to crash a Host without a listener", () => {
  const warnings = [];
  const ctx = {
    webServer: { protocol: "http:" },
    logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    effect() {},
  };
  apply(ctx, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no bound listener/u);
});