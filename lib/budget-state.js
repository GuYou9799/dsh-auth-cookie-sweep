/**
 * Remember the biggest jar the Host has ever seen, so the next launch's rescue
 * budget can be sized from it instead of from a constant.
 *
 * A fixed budget always has a ceiling: a jar that grew past it while the plugin
 * was absent (or while its sweep was disabled) would need a manual clean. The
 * peak recorded here removes that ceiling in practice — each launch opens with
 * a budget several times larger than the worst jar observed so far, and the
 * sweep then shrinks the jar back to one cookie. The plugin therefore never
 * needs "clear it by hand once".
 *
 * The file is tiny and user-scoped (`$DSH_HOME/auth-cookie-sweep-state.json` by
 * default). It contains one number and a timestamp: no cookie names, no values.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** File name inside `$DSH_HOME`. */
export const STATE_FILE_NAME = "auth-cookie-sweep-state.json";

/**
 * Hard ceiling on any budget (64 MiB). This guards against a hand-edited state
 * file, not against a real jar: at the observed ~215 bytes per cookie it is
 * ~300,000 cookies, far beyond any browser's per-domain limit.
 */
export const MAX_BUDGET_BYTES = 64 * 1024 * 1024;

/** Granularity the grown budget is rounded up to (64 KiB). */
const BUDGET_GRANULARITY = 64 * 1024;

/** How many times the observed peak the effective budget aims for. */
const PEAK_MULTIPLIER = 4;

/**
 * Where the state lives when the profile does not say otherwise.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {string} [home] - home directory fallback.
 * @returns {string} absolute path.
 */
export function defaultStateFile(env = process.env, home = homedir()) {
  const dshHome =
    typeof env.DSH_HOME === "string" && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, ".dsh");
  return join(dshHome, STATE_FILE_NAME);
}

/**
 * Read the recorded peak, tolerating a missing, corrupt, or unreadable file.
 *
 * @param {string} file - state file path.
 * @returns {number} bytes, or `0` when nothing usable was recorded.
 */
export function readPeakHeaderBytes(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const peak = parsed?.peakHeaderBytes;
    return Number.isInteger(peak) && peak > 0 ? peak : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist a new peak. Failures are reported to the caller, never thrown: a
 * read-only home must not stop the sweep.
 *
 * @param {string} file - state file path.
 * @param {number} bytes - the peak to store.
 * @returns {boolean} whether the write succeeded.
 */
export function writePeakHeaderBytes(file, bytes) {
  if (typeof file !== "string" || file.length === 0) return false;
  if (!Number.isInteger(bytes) || bytes <= 0) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ version: 1, peakHeaderBytes: bytes, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The budget to apply this launch.
 *
 * `configured` is the user's floor and `0` still disables the rescue; the peak
 * only ever grows the number, never shrinks it, and the 64 MiB guard keeps a
 * corrupted state file from turning the parser unbounded.
 *
 * @param {number} configured - `maxHeaderBytes` from the config.
 * @param {number} peakHeaderBytes - peak recorded on a previous launch.
 * @returns {number} bytes to give the server (`0` = leave it alone).
 */
export function budgetFor(configured, peakHeaderBytes) {
  if (!Number.isInteger(configured) || configured <= 0) return 0;
  if (!Number.isInteger(peakHeaderBytes) || peakHeaderBytes <= 0) return configured;
  const wanted = Math.ceil((peakHeaderBytes * PEAK_MULTIPLIER) / BUDGET_GRANULARITY) * BUDGET_GRANULARITY;
  return Math.min(MAX_BUDGET_BYTES, Math.max(configured, wanted));
}
