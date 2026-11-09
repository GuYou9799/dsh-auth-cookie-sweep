import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";

import { attachCookiePurge, authCookieName, deletionCookie } from "../lib/purge.js";
import { normalizeConfig } from "../lib/purge.js";

const VALUE = `v1.${"B".repeat(60)}`;

/** A Host that behaves like DSH: mints one authority-bound cookie per launch. */
async function startHost() {
  const settings = normalizeConfig({});
  const server = createServer((request, response) => {
    const authority = request.headers.host;
    const minted = `dsh-auth-${authCookieName(authority)}=${VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`;
    attachCookiePurge(request, response, { ...settings, secure: false });
    response.writeHead(303, {
      "cache-control": "no-store",
      location: "./",
      "set-cookie": minted,
    });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

/** One launch: the browser sends its whole jar for 127.0.0.1, whatever the port. */
function launch(port, authority, jar) {
  const cookie = [...jar.keys()].map((name) => `${name}=${VALUE}`).join("; ");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/?token=launch-token",
        headers: { host: authority, cookie },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            location: response.headers.location,
            setCookies: response.headers["set-cookie"] ?? [],
            cookieHeaderBytes: Buffer.byteLength(cookie),
          }),
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
    const name = raw.slice(0, raw.indexOf("="));
    if (raw.includes("Max-Age=0")) jar.delete(name);
  }
  jar.set(`dsh-auth-${authCookieName(authority)}`, VALUE);
}

test("the launch jar stays bounded over hundreds of launches", async (t) => {
  const { server, port } = await startHost();
  t.after(() => server.close());

  const jar = new Map();
  let largestHeader = 0;
  let purges = 0;

  for (let launchIndex = 0; launchIndex < 300; launchIndex += 1) {
    // Each launch binds a fresh ephemeral port, hence a fresh authority.
    const authority = `127.0.0.1:${41000 + launchIndex}`;
    const result = await launch(port, authority, jar);
    assert.equal(result.status, 303);
    assert.equal(result.location, "./");

    const deletions = result.setCookies.filter((raw) => raw.includes("Max-Age=0"));
    if (deletions.length > 0) purges += 1;
    const minted = `dsh-auth-${authCookieName(authority)}`;
    for (const raw of result.setCookies) {
      if (!raw.includes("Max-Age=0")) assert.ok(raw.startsWith(`${minted}=`), "the minted cookie is never dropped");
    }

    settle(jar, authority, result);
    largestHeader = Math.max(largestHeader, result.cookieHeaderBytes);

    // Without the sweeper this would be 300 cookies (~64 KiB header).
    assert.ok(jar.size <= 4, `jar stayed small at launch ${launchIndex + 1}: ${jar.size}`);
  }

  assert.ok(purges > 0, "the sweeper actually fired");
  assert.ok(largestHeader < 2048, `cookie header stayed small: ${largestHeader} bytes`);
  assert.ok(jar.size <= 4);
});

test("a poisoned jar above the byte threshold is rehabilitated in one response", async (t) => {
  const { server, port } = await startHost();
  t.after(() => server.close());

  const jar = new Map();
  for (let index = 0; index < 20; index += 1) {
    jar.set(`dsh-auth-${authCookieName(`127.0.0.1:${41000 + index}`)}`, VALUE);
  }
  assert.equal(jar.size, 20);

  const authority = "127.0.0.1:54326";
  const result = await launch(port, authority, jar);
  const deletions = result.setCookies.filter((raw) => raw.includes("Max-Age=0"));
  assert.equal(deletions.length, 20, "every foreign cookie is expired at once");

  settle(jar, authority, result);
  assert.equal(jar.size, 1, "only the current launch's cookie survives");
  assert.ok(result.setCookies.some((raw) => raw.startsWith(`dsh-auth-${authCookieName(authority)}=`)));
});

test("deletions carry the same attributes as the Host cookie", () => {
  assert.equal(
    deletionCookie("dsh-auth-abc", false),
    "dsh-auth-abc=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict",
  );
});