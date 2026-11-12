import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  budgetFor,
  defaultStateFile,
  MAX_BUDGET_BYTES,
  readPeakHeaderBytes,
  writePeakHeaderBytes,
} from "../lib/budget-state.js";
import { apply } from "../lib/index.js";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-sweep-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the default state file follows DSH_HOME and falls back to the home directory", () => {
  assert.equal(
    defaultStateFile({ DSH_HOME: "C:\\profiles\\desktop" }, "C:\\Users\\micro"),
    join("C:\\profiles\\desktop", "auth-cookie-sweep-state.json"),
  );
  assert.equal(
    defaultStateFile({}, "C:\\Users\\micro"),
    join("C:\\Users\\micro", ".dsh", "auth-cookie-sweep-state.json"),
  );
  assert.equal(
    defaultStateFile({ DSH_HOME: "" }, "/home/micro"),
    join("/home/micro", ".dsh", "auth-cookie-sweep-state.json"),
  );
});

test("a missing, corrupt, or empty state file reads as no peak", (t) => {
  const dir = scratch(t);
  assert.equal(readPeakHeaderBytes(join(dir, "missing.json")), 0);

  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{not json");
  assert.equal(readPeakHeaderBytes(corrupt), 0);

  const wrongShape = join(dir, "wrong.json");
  writeFileSync(wrongShape, JSON.stringify({ peakHeaderBytes: "huge" }));
  assert.equal(readPeakHeaderBytes(wrongShape), 0);

  const negative = join(dir, "negative.json");
  writeFileSync(negative, JSON.stringify({ peakHeaderBytes: -1 }));
  assert.equal(readPeakHeaderBytes(negative), 0);
});

test("the peak round-trips and the file stores only the number", (t) => {
  const dir = scratch(t);
  const file = join(dir, "nested", "state.json");

  assert.equal(writePeakHeaderBytes(file, 17_698), true);
  assert.equal(readPeakHeaderBytes(file), 17_698);

  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /dsh-auth-/u);
  assert.match(text, /"peakHeaderBytes": 17698/u);
});

test("persisting refuses nonsense without throwing", (t) => {
  const dir = scratch(t);
  assert.equal(writePeakHeaderBytes("", 1024), false);
  assert.equal(writePeakHeaderBytes(join(dir, "state.json"), 0), false);
  assert.equal(writePeakHeaderBytes(join(dir, "state.json"), 1.5), false);

  // A file where a directory is expected must not escape as an exception.
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "x");
  assert.equal(writePeakHeaderBytes(join(blocked, "state.json"), 1024), false);
});

test("the budget grows past the configured floor but never past the ceiling", () => {
  assert.equal(budgetFor(128 * 1024, 0), 128 * 1024);
  assert.equal(budgetFor(128 * 1024, 17_698), 128 * 1024, "a small jar keeps the floor");
  assert.equal(budgetFor(128 * 1024, 2 * 1024 * 1024), 8 * 1024 * 1024);
  assert.equal(budgetFor(128 * 1024, 3 * 1024 * 1024), 12 * 1024 * 1024);
  assert.equal(budgetFor(128 * 1024, 3 * 1024 * 1024 + 1), 12 * 1024 * 1024 + 64 * 1024, "rounded up to 64 KiB");
  assert.equal(budgetFor(128 * 1024, 32 * 1024 * 1024), MAX_BUDGET_BYTES);
  assert.equal(budgetFor(0, 50 * 1024 * 1024), 0, "0 still disables the rescue");
  assert.equal(budgetFor(32 * 1024 * 1024, 1024), 32 * 1024 * 1024, "the floor can exceed the growth");
  assert.equal(budgetFor(128 * 1024, Number.NaN), 128 * 1024);
});

test("the plugin sizes this launch from the last launch's peak and records a new one", async (t) => {
  const dir = scratch(t);
  const stateFile = join(dir, "state.json");
  writePeakHeaderBytes(stateFile, 32 * 1024 * 1024);

  const server = createServer((_request, response) => response.writeHead(204).end());
  const disposers = [];
  const ctx = {
    webServer: { server, protocol: "http:" },
    logger: { info() {}, warn() {} },
    effect(callback) {
      disposers.push(callback());
    },
  };

  apply(ctx, { stateFile, minStaleCookies: 3 });
  assert.equal(server.maxHeaderSize, MAX_BUDGET_BYTES, "a 32 MiB peak reaches the 64 MiB guard");

  // A request larger than the recorded peak raises the record for next launch.
  const listener = server.listeners("request")[0];
  const request = { headers: { host: "127.0.0.1:41999", cookie: `pad=${"x".repeat(64)}` } };
  const response = {
    getHeader() {
      return undefined;
    },
    writeHead() {
      return this;
    },
    end() {},
  };
  listener(request, response);

  assert.equal(server.maxHeaderSize, MAX_BUDGET_BYTES);
  assert.ok(readPeakHeaderBytes(stateFile) > 0);

  for (const dispose of disposers) dispose();
  assert.equal(server.maxHeaderSize, undefined);
  server.close();
});
