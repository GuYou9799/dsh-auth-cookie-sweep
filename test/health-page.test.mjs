import assert from "node:assert/strict";
import test from "node:test";

import { authCookieName } from "../lib/purge.js";
import { healthDocument, renderHealthPage, repairResponse } from "../lib/health-page.js";

const current = authCookieName("127.0.0.1:5000");
const older = authCookieName("127.0.0.1:4000");

const snapshot = (overrides = {}) => ({
  budget: 131072,
  raised: false,
  current: { authority: "127.0.0.1:5000", cookies: 2, headerBytes: 440, authCookieBytes: 440, at: 1000 },
  peak: { cookies: 2, headerBytes: 440, at: 1000 },
  estimatedBytesPerCookie: 220,
  launchesRemaining: 594,
  requestsObserved: 3,
  authoritiesObserved: 2,
  recentAuthorities: [{ authority: "127.0.0.1:4000", cookies: 1, bytes: 220, firstSeen: 0, lastSeen: 500 }],
  ...overrides,
});

test("the document classifies headroom into verdicts", () => {
  assert.equal(healthDocument(snapshot(), { version: "9.9.9" }).verdict, "healthy");
  assert.equal(healthDocument(snapshot({ launchesRemaining: 5 })).verdict, "nearly-full");
  assert.equal(healthDocument(snapshot({ launchesRemaining: 0 })).verdict, "locked-out-or-close");
  assert.equal(healthDocument(snapshot({ launchesRemaining: null })).verdict, "unknown");
});

test("the document reports the plugin identity and usage", () => {
  const document = healthDocument(snapshot(), { version: "0.3.0", now: 2000 });
  assert.equal(document.plugin, "dsh-auth-cookie-sweep");
  assert.equal(document.version, "0.3.0");
  assert.equal(document.headerBudget, 131072);
  assert.equal(document.checkedAt, new Date(2000).toISOString());
  assert.equal(document.usage, 440 / 131072);
});

test("the page is self-contained, bilingual, and escapes the authority", () => {
  const html = renderHealthPage(
    snapshot({
      recentAuthorities: [
        { authority: "<img src=x onerror=alert(1)>", cookies: 1, bytes: 10, firstSeen: 0, lastSeen: 0 },
      ],
    }),
    { version: "0.3.0" },
  );
  assert.match(html, /登录 Cookie 体检/);
  assert.match(html, /Observed from the Host's own requests/);
  assert.match(html, /<form method="post" action="auth-cookie-sweep\/repair">/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("<img src=x"));
  // No external references: the page must work with no network access.
  assert.ok(!/src="http|href="http/.test(html));
  assert.match(html, /dsh-auth-cookie-sweep 0\.3\.0/);
});

test("repair expires every foreign cookie and keeps the current one", () => {
  const request = {
    headers: { host: "127.0.0.1:5000", cookie: `${older}=v1.old; ${current}=v1.new` },
  };
  const result = repairResponse(request, { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 256 });
  assert.equal(result.status, 303);
  assert.equal(result.expired, 1);
  assert.equal(result.headers.location, "./");
  assert.equal(result.headers["x-dsh-auth-cookie-sweep"], "1");
  assert.equal(result.headers["set-cookie"].length, 1);
  assert.match(result.headers["set-cookie"][0], /^dsh-auth-[^=]+=; Max-Age=0; Path=\//);
  assert.ok(!result.headers["set-cookie"][0].includes(current));
});

test("repair is bounded by maxDeletions and can be empty", () => {
  const many = Array.from({ length: 300 }, (_, index) => `${authCookieName(`127.0.0.1:${4000 + index}`)}=v1.x`).join("; ");
  const bounded = repairResponse(
    { headers: { host: "127.0.0.1:5000", cookie: many } },
    { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 256 },
  );
  assert.equal(bounded.expired, 256);
  assert.equal(bounded.headers["set-cookie"].length, 256);

  const clean = repairResponse(
    { headers: { host: "127.0.0.1:5000", cookie: `${current}=v1.new` } },
    { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 256 },
  );
  assert.equal(clean.expired, 0);
  assert.equal(clean.headers["set-cookie"], undefined);
});

test("repair marks cookies Secure on a TLS listener", () => {
  const result = repairResponse(
    { headers: { host: "dsh.example:8443", cookie: `${older}=v1.old` } },
    { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 256 },
    { secure: true },
  );
  assert.match(result.headers["set-cookie"][0], /; Secure$/);
});