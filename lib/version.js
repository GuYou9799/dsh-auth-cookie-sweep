/**
 * Single source of the version shown on the health page.
 *
 * Kept in code rather than imported from `package.json` so the module works in
 * any ESM runtime without JSON import attributes; `test/package-manifest.test.mjs`
 * fails if this drifts from `package.json`.
 */
export const VERSION = "1.1.0";