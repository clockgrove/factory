// tools/deps/sync.mjs, the vendored libraries' copy and its CI check, run as the real script on a small tree of its own:
// a lockfile, node_modules holding each pinned library's published files, and the plugin/vendor it fills and checks.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SYNC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "deps", "sync.mjs");
// Each library sync.mjs vendors, with one file it keeps besides its LICENSE and package.json.
const LIBS = { "@actions/expressions": "dist/index.js", yaml: "browser/index.js", "smol-toml": "dist/index.js" };

/** A tree with tools/deps (sync.mjs, its lockfile, node_modules) and plugin/vendor filled by a first sync. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "vendor-sync-"));
  const deps = join(root, "tools", "deps");
  mkdirSync(deps, { recursive: true });
  cpSync(SYNC, join(deps, "sync.mjs"));
  const packages = {};
  for (const [name, kept] of Object.entries(LIBS)) {
    const dir = join(deps, "node_modules", name);
    mkdirSync(dirname(join(dir, kept)), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    writeFileSync(join(dir, "LICENSE"), "MIT");
    writeFileSync(join(dir, kept), `export const name = ${JSON.stringify(name)};\n`);
    packages[`node_modules/${name}`] = { version: "1.0.0" };
  }
  writeFileSync(join(deps, "package-lock.json"), JSON.stringify({ packages }));
  const run = (...args) => spawnSync(process.execPath, [join(deps, "sync.mjs"), ...args], { encoding: "utf8" });
  assert.equal(run().status, 0);
  return { root, vendor: join(root, "plugin", "vendor"), check: () => run("--check") };
}

test("sync --check: a copy byte for byte passes; a scope folder or a library folder that is a link fails, even to an identical copy", () => {
  const t = tree();
  assert.equal(t.check().status, 0, t.check().stderr);
  // The same files behind a link: a byte check alone would pass them, and an installed copy would read the link's target.
  for (const linked of ["@actions", "yaml", "@actions/expressions"]) {
    const t2 = tree();
    const at = join(t2.vendor, linked);
    const elsewhere = join(t2.root, "elsewhere");
    renameSync(at, elsewhere);
    symlinkSync(elsewhere, at);
    const r = t2.check();
    assert.equal(r.status, 1, `${linked}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`plugin/vendor/${linked.replace(/\//g, "\\/")} is not a real directory`), r.stderr);
  }
});
