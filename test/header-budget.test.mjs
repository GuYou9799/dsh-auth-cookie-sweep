import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  DEFAULT_MAX_HEADER_BYTES,
  applyHeaderBudget,
  restoreHeaderBudget,
} from "../lib/header-budget.js";
import { normalizeConfig } from "../lib/purge.js";

test("the default rescue budget is 128 KiB", () => {
  assert.equal(DEFAULT_MAX_HEADER_BYTES, 131072);
});

test("applying raises the parser budget and reports the previous value", () => {
  const server = createServer();
  const before = applyHeaderBudget(server, 65536);
  assert.equal(before.previous, undefined, "Node's default is reported as undefined");
  assert.equal(before.applied, true);
  assert.equal(server.maxHeaderSize, 65536);

  const second = applyHeaderBudget(server, 131072);
  assert.equal(second.previous, 65536);
  assert.equal(server.maxHeaderSize, 131072);
  server.close();
});

test("restoring an undefined previous value returns to Node's default", () => {
  const server = createServer();
  const budget = applyHeaderBudget(server, 65536);
  restoreHeaderBudget(server, budget.previous);
  assert.equal(server.maxHeaderSize, undefined, "absent property means Node's 16 KiB default");
  server.close();
});

test("restoring an explicit previous value puts it back", () => {
  const server = createServer();
  server.maxHeaderSize = 32768;
  const budget = applyHeaderBudget(server, 131072);
  restoreHeaderBudget(server, budget.previous);
  assert.equal(server.maxHeaderSize, 32768);
  server.close();
});

test("0 and non-integer budgets leave the server alone", () => {
  const server = createServer();
  for (const value of [0, -1, 1.5, Number.NaN, "131072", null, undefined]) {
    const budget = applyHeaderBudget(server, value);
    assert.equal(budget.applied, false, `${String(value)} is not applied`);
    assert.equal(server.maxHeaderSize, undefined);
  }
  server.close();
});

test("restoring tolerates a server that no longer accepts the property", () => {
  const frozen = Object.freeze({ maxHeaderSize: 65536 });
  assert.doesNotThrow(() => restoreHeaderBudget(frozen, undefined));
  assert.equal(frozen.maxHeaderSize, 65536);
});

test("normalizeConfig bounds and defaults the header budget", () => {
  assert.equal(normalizeConfig({}).maxHeaderBytes, 131072);
  assert.equal(normalizeConfig({ maxHeaderBytes: 0 }).maxHeaderBytes, 0, "0 disables the rescue");
  assert.equal(normalizeConfig({ maxHeaderBytes: 65536 }).maxHeaderBytes, 65536);
  assert.equal(normalizeConfig({ maxHeaderBytes: 8 * 1024 * 1024 }).maxHeaderBytes, 8 * 1024 * 1024);
  assert.equal(normalizeConfig({ maxHeaderBytes: 128 * 1024 * 1024 }).maxHeaderBytes, 64 * 1024 * 1024);
  assert.equal(normalizeConfig({ maxHeaderBytes: -5 }).maxHeaderBytes, 0);
  assert.equal(normalizeConfig({ maxHeaderBytes: 1.5 }).maxHeaderBytes, 131072);
  assert.equal(normalizeConfig({ maxHeaderBytes: "65536" }).maxHeaderBytes, 131072);
});