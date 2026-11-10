import assert from "node:assert/strict";
import test from "node:test";

import { cookieNames, createJarTracker } from "../lib/jar-health.js";

const AUTH = (authority) =>
  `dsh-auth-${Buffer.from(authority).toString("base64url")}`;

test("cookieNames splits a Cookie header into names", () => {
  assert.deepEqual(cookieNames("a=1; b=2;c=3"), ["a", "b", "c"]);
  assert.deepEqual(cookieNames("  spaced = x ;  other=y "), ["spaced", "other"]);
  assert.deepEqual(cookieNames(""), []);
  assert.deepEqual(cookieNames(undefined), []);
});

test("a tracker reports the current jar and its peak", () => {
  const tracker = createJarTracker();
  const current = `${AUTH("127.0.0.1:5000")}=v1.abc`;
  tracker.observe({ cookieHeader: current, authority: "127.0.0.1:5000", now: 1000 });
  tracker.observe({
    cookieHeader: `${AUTH("127.0.0.1:4000")}=v1.old; ${current}`,
    authority: "127.0.0.1:5000",
    now: 2000,
  });

  const snapshot = tracker.snapshot({ budget: 131072 });
  assert.equal(snapshot.budget, 131072);
  assert.equal(snapshot.requestsObserved, 2);
  assert.equal(snapshot.current.cookies, 2);
  assert.equal(snapshot.current.authority, "127.0.0.1:5000");
  assert.ok(snapshot.current.authCookieBytes > 0);
  assert.ok(snapshot.current.authCookieBytes <= snapshot.current.headerBytes);
  assert.equal(snapshot.peak.cookies, 2);
  assert.equal(snapshot.estimatedBytesPerCookie, Math.round(snapshot.peak.headerBytes / 2));
  assert.equal(snapshot.launchesRemaining, Math.floor((131072 - snapshot.current.headerBytes) / snapshot.estimatedBytesPerCookie));
});

test("an empty tracker has no peak and no projection", () => {
  const snapshot = createJarTracker().snapshot();
  assert.equal(snapshot.peak, null);
  assert.equal(snapshot.launchesRemaining, null);
  assert.equal(snapshot.estimatedBytesPerCookie, null);
  assert.equal(snapshot.current.headerBytes, 0);
  assert.equal(snapshot.budget, 16 * 1024);
});

test("a jar at the budget has no launches left", () => {
  const tracker = createJarTracker();
  const header = Array.from({ length: 80 }, (_, index) => `dsh-auth-${index}=x`.padEnd(220, "x")).join("; ");
  tracker.observe({ cookieHeader: header, authority: "127.0.0.1:1" });
  const snapshot = tracker.snapshot({ budget: 4096 });
  assert.equal(snapshot.launchesRemaining, 0);
  assert.equal(snapshot.raised, true);
});

test("only the most recent authorities are kept for the page", () => {
  const tracker = createJarTracker();
  for (let index = 0; index < 80; index += 1) {
    tracker.observe({ cookieHeader: `dsh-auth-${index}=x`, authority: `127.0.0.1:${index}`, now: index });
  }
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.recentAuthorities.length, 8);
  assert.equal(snapshot.recentAuthorities[0].authority, "127.0.0.1:79");
  assert.ok(snapshot.authoritiesObserved <= 64);
});