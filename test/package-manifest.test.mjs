// Guards the shipped bundle patch. The plugin market only hot-mounts a package
// whose bundle patch parses as plain `id`/`name` insert rows; anything else
// (a config block, a disable expression, a stray key such as the `ndme:` typo
// that shipped in 0.1.0-0.1.3) demotes activation to "restart required" and,
// because the row then names a package that does not exist, the plugin never
// comes up at all. This file makes that failure impossible to publish again.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * Mirror of dshmarket's `parseSimplePatch`.
 *
 * The real implementation lives in the market plugin, not in this package, so
 * it is reproduced here byte-for-byte in behaviour: strip trailing comments,
 * accept `- insert:` headers, `- id:` rows and `name:` rows, and reject
 * anything else. Keep this in sync with
 * https://github.com/GuYou9799/dsh-auth-cookie-sweep/issues if the market
 * ever loosens or tightens the rule.
 */
function parseSimplePatch(patchText) {
    const rows = [];
    let pending = null;
    for (const raw of patchText.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trimEnd();
        if (line.trim() === "")
            continue;
        if (/^-\s+insert:\s*$/.test(line))
            continue;
        const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line);
        if (id !== null) {
            if (pending !== null)
                return null;
            pending = id[1];
            continue;
        }
        const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
        if (name !== null && pending !== null) {
            rows.push({ id: pending, name: name[1] });
            pending = null;
            continue;
        }
        return null;
    }
    if (pending !== null || rows.length === 0)
        return null;
    return rows;
}

function readPatch() {
    const declared = manifest.dsh?.bundle?.patch;
    assert.equal(typeof declared, "string", "package.json must declare dsh.bundle.patch");
    return { declared, text: readFileSync(join(root, declared), "utf8") };
}

test("package.json declares the bundle patch it ships", () => {
    const { declared } = readPatch();
    assert.equal(declared, "./cordis.patch.yml");
    assert.ok(manifest.files.includes("cordis.patch.yml"), "npm `files` must include the bundle patch");
});

test("bundle patch is a plain insert of this package", () => {
    const rows = parseSimplePatch(readPatch().text);
    assert.notEqual(rows, null, "bundle patch must contain only plain id/name insert rows");
    assert.deepEqual(rows, [{ id: manifest.name, name: manifest.name }], "the row must mount this exact package");
});

test("bundle patch carries no config, disable or expression constructs", () => {
    const { text } = readPatch();
    assert.doesNotMatch(text, /^\s+config:/m, "row-level `config:` forces restart activation");
    assert.doesNotMatch(text, /^\s+disabled:/m, "`disabled:` rows are not plain inserts");
    assert.doesNotMatch(text, /!!js/, "`!!js` expressions are not plain inserts");
    const topLevel = text
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, "").trimEnd())
        .filter((line) => line.trim() !== "" && !line.startsWith(" "));
    assert.deepEqual(topLevel, ["- insert:"], "the only top-level operation may be one `- insert:` block");
});

test("the hot-mount parser rejects a config row (guards the guard)", () => {
    const broken = "- insert:\n    - id: x\n      name: x\n      config:\n        a: 1\n";
    assert.equal(parseSimplePatch(broken), null);
});

test("the hot-mount parser rejects a misspelled key (the 0.1.3 regression)", () => {
    const broken = "- insert:\n    - id: dsh-auth-cookie-sweep\n      ndme: dsh-auth-cookie-sweep\n";
    assert.equal(parseSimplePatch(broken), null);
});