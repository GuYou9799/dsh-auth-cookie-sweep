import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";

import { DEFAULT_MAX_HEADER_BYTES, applyHeaderBudget, restoreHeaderBudget } from "../lib/header-budget.js";
import { attachCookiePurge, authCookieName, normalizeConfig } from "../lib/purge.js";

const VALUE = `v1.${"B".repeat(60)}`;
const SETTINGS = normalizeConfig({});

/** A Host that behaves like DSH: mints one authority-bound cookie per launch. */
async function startHost() {
  const server = createServer((request, response) => {
    const minted = `dsh-auth-${authCookieName(request.headers.host)}=${VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`;
    attachCookiePurge(request, response, { ...SETTINGS, secure: false });
    response.writeHead(303, { "cache-control": "no-store", location: "./", "set-cookie": minted });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

/** A jar full of cookies minted for ports this launch will never use again. */
function poisonedJar(count) {
  const jar = new Map();
  for (let index = 0; index < count; index += 1) {
    jar.set(`dsh-auth-${authCookieName(`127.0.0.1:${30000 + index}`)}`, VALUE);
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.keys()].map((name) => `${name}=${VALUE}`).join("; ");
}

/** One launch, as the browser sees it: the whole jar for 127.0.0.1, whatever the port. */
function launch(port, authority, jar) {
  const cookie = cookieHeader(jar);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/?token=launch-token",
        // Browsers accept far larger response headers than Node's 16 KiB
        // client default; the rescue answers with one Set-Cookie per stale
        // cookie, so the test client must model a browser, not Node.
        maxHeaderSize: 256 * 1024,
        // Every launch opens a fresh connection, and so does a browser after a
        // restart; Node's keep-alive pool would otherwise reuse a socket whose
        // parser was built with the old budget.
        agent: false,
        headers: { host: authority, cookie },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode, setCookies: response.headers["set-cookie"] ?? [] }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Apply the Set-Cookie lines the browser would apply, then store the minted cookie. */
function settle(jar, authority, result) {
  for (const raw of result.setCookies) {
    if (raw.includes("Max-Age=0")) jar.delete(raw.slice(0, raw.indexOf("=")));
  }
  jar.set(`dsh-auth-${authCookieName(authority)}`, VALUE);
}

test("a jar already over the 16 KiB limit gets 431, then is rescued back to one cookie", async (t) => {
  const { server, port } = await startHost();
  t.after(() => server.close());

  const authority = "127.0.0.1:54326";
  const jar = poisonedJar(150);
  assert.ok(cookieHeader(jar).length > 16384, `jar is over Node's default limit: ${cookieHeader(jar).length} bytes`);

  // 1. Locked out: the parser answers 431 before the Host's handler runs.
  const locked = await launch(port, authority, jar);
  assert.equal(locked.status, 431);
  assert.equal(locked.setCookies.length, 0, "no handler ran, so no expiries were offered");

  // 2. The plugin raises the budget; the same jar now reaches the handler.
  const budget = applyHeaderBudget(server, DEFAULT_MAX_HEADER_BYTES);
  assert.equal(budget.applied, true);

  const rescued = await launch(port, authority, jar);
  assert.equal(rescued.status, 303);
  const deletions = rescued.setCookies.filter((raw) => raw.includes("Max-Age=0"));
  assert.equal(deletions.length, 150, "every foreign cookie is expired in the very first response");
  assert.ok(
    rescued.setCookies.some((raw) => raw.startsWith(`dsh-auth-${authCookieName(authority)}=`)),
    "the current launch's cookie is kept",
  );

  // 3. The next launch's jar is small again, and the sweeper stays quiet.
  settle(jar, authority, rescued);
  assert.equal(jar.size, 1);
  const nextJar = new Map([[`dsh-auth-${authCookieName(authority)}`, VALUE]]);
  const healthy = await launch(port, authority, nextJar);
  assert.equal(healthy.status, 303);
  assert.equal(healthy.setCookies.filter((raw) => raw.includes("Max-Age=0")).length, 0);
});

test("dispose puts Node's default limit back, so the budget never stays open", async (t) => {
  const { server, port } = await startHost();
  t.after(() => server.close());

  const budget = applyHeaderBudget(server, DEFAULT_MAX_HEADER_BYTES);
  const rescued = await launch(port, "127.0.0.1:54326", poisonedJar(150));
  assert.equal(rescued.status, 303);

  restoreHeaderBudget(server, budget.previous);
  const lockedAgain = await launch(port, "127.0.0.1:54327", poisonedJar(150));
  assert.equal(lockedAgain.status, 431);
});

test("a disabled budget leaves the locked-out jar locked out", async (t) => {
  const { server, port } = await startHost();
  t.after(() => server.close());

  const budget = applyHeaderBudget(server, 0);
  assert.equal(budget.applied, false);
  const locked = await launch(port, "127.0.0.1:54326", poisonedJar(150));
  assert.equal(locked.status, 431);
});