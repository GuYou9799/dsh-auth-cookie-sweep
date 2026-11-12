import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { apply, HEALTH_JSON_PATH, HEALTH_PATH, REPAIR_PATH } from "../lib/index.js";
import { authCookieName } from "../lib/purge.js";

const get = (port, path, headers = {}, method = "GET") =>
  new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    call.on("error", reject);
    call.end();
  });

/**
 * A Cordis-shaped context around a real HTTP server: `webServer.register`
 * stores handlers, `connection.authorizeIndex` demands the launch cookie, and
 * `effect` runs its callback immediately (as the real kernel does).
 */
function harness() {
  const routes = new Map();
  const disposers = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://placeholder");
    const handler = routes.get(pathname);
    if (!handler) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    handler(request, response);
  });

  const ctx = {
    webServer: {
      server,
      protocol: "http:",
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    get: (name) =>
      name === "connection"
        ? {
            authorizeIndex(request, response) {
              const authority = `127.0.0.1:${server.address().port}`;
              if ((request.headers.cookie ?? "").includes(authCookieName(authority))) return true;
              response.writeHead(401, { "content-type": "text/plain" });
              response.end("dsh web authentication required\n");
              return false;
            },
          }
        : undefined,
    effect(callback) {
      disposers.push(callback());
    },
    logger: { info() {}, warn() {} },
  };

  return { ctx, routes, disposers, server };
}

test("the health routes are authenticated, readable, and repairable", async (t) => {
  const { ctx, routes, disposers, server } = harness();
  apply(ctx, { minStaleCookies: 3, maxCookieHeaderBytes: 4096, maxDeletions: 256, stateFile: "" });
  assert.deepEqual([...routes.keys()].sort(), [HEALTH_JSON_PATH, HEALTH_PATH, REPAIR_PATH].sort());

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => {
    for (const dispose of disposers) dispose();
    server.close();
  });

  const authority = `127.0.0.1:${port}`;
  const current = `${authCookieName(authority)}=v1.current`;
  const foreign = Array.from({ length: 6 }, (_, index) => `${authCookieName(`127.0.0.1:${41000 + index}`)}=v1.old`).join("; ");

  // Unauthenticated callers get the Host's own 401, not the page.
  const anonymous = await get(port, HEALTH_PATH);
  assert.equal(anonymous.status, 401);

  // The page: authenticated, self-contained HTML.
  const page = await get(port, HEALTH_PATH, { cookie: `${foreign}; ${current}` });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.match(page.body, /登录 Cookie 体检/);
  assert.match(page.body, /action="auth-cookie-sweep\/repair"/);

  // The JSON twin reports what the request carried.
  const json = JSON.parse((await get(port, HEALTH_JSON_PATH, { cookie: `${foreign}; ${current}` })).body);
  assert.equal(json.plugin, "dsh-auth-cookie-sweep");
  assert.equal(json.current.cookies, 7);
  assert.equal(json.verdict, "healthy");

  // Repair: every foreign cookie expires, the current one survives.
  const repaired = await get(port, REPAIR_PATH, { cookie: `${foreign}; ${current}` }, "POST");
  assert.equal(repaired.status, 303);
  assert.equal(repaired.headers.location, "./");
  assert.equal(repaired.headers["x-dsh-auth-cookie-sweep"], "6");
  const deleted = [].concat(repaired.headers["set-cookie"] ?? []);
  assert.equal(deleted.length, 6);
  assert.ok(deleted.every((value) => value.includes("Max-Age=0") && !value.startsWith(current)));

  // GET on the repair endpoint is rejected.
  const wrongMethod = await get(port, REPAIR_PATH, { cookie: current });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");

  // Disposing the plugin removes the routes and restores the parser budget.
  for (const dispose of disposers) dispose();
  assert.equal((await get(port, HEALTH_PATH, { cookie: current })).status, 404);
  assert.equal(server.maxHeaderSize, undefined);
});

test("health can be disabled without touching the sweep", async (t) => {
  const { ctx, routes, disposers, server } = harness();
  apply(ctx, { health: false, maxHeaderBytes: 0, minStaleCookies: 3, stateFile: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const dispose of disposers) dispose();
    server.close();
  });

  assert.equal(routes.size, 0);
  assert.equal(server.listenerCount("request"), 2); // the harness router + the sweep
  assert.equal(server.maxHeaderSize, undefined); // maxHeaderBytes: 0 disables the rescue
});