#!/usr/bin/env node
// Copy each vendored library's published files from tools/vendor/node_modules (installed from this directory's
// lockfile: `npm ci --ignore-scripts --prefix tools/vendor`) into plugin/vendor/<name>/, byte for byte.
// `--check` changes nothing and exits 1 when plugin/vendor differs from what the lockfile installs (CI runs it).
//
// Why vendored: the plugin runs with nothing installed, from a Claude Code plugin install and from the Action's
// checkout, so a runtime library has to ship inside it (docs/PLAN.md, "Dependencies"). Only files the library
// itself published are copied, never rebuilt, so each copy can be compared with the registry's tarball.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "plugin", "vendor");
/** Per library: the published paths Factory imports (an ES module tree), its licence and its package.json. */
export const VENDORED = {
  yaml: (p) => p === "LICENSE" || p === "package.json" || p.startsWith("browser/"),
  "smol-toml": (p) => p === "LICENSE" || p === "package.json" || /^dist\/[^/]+\.js$/.test(p),
};

function files(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), base) : [relative(base, join(dir, n)).split("\\").join("/")]));
}

const check = process.argv.includes("--check");
const lock = JSON.parse(readFileSync(join(here, "package-lock.json"), "utf8"));
const problems = [];
for (const [name, keep] of Object.entries(VENDORED)) {
  const src = join(here, "node_modules", name);
  const want = lock.packages?.[`node_modules/${name}`]?.version;
  const got = existsSync(join(src, "package.json")) ? JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version : null;
  if (!want || got !== want) {
    problems.push(`${name}: the lockfile pins ${want ?? "nothing"}, node_modules holds ${got ?? "nothing"}; run npm ci --ignore-scripts --prefix tools/vendor`);
    continue;
  }
  const dest = join(out, name);
  const from = files(src).filter(keep).sort();
  if (check) {
    const have = existsSync(dest) ? files(dest).sort() : [];
    for (const f of new Set([...from, ...have])) {
      if (!from.includes(f)) problems.push(`${name}: plugin/vendor has ${f}, which ${name} ${want} does not publish`);
      else if (!have.includes(f)) problems.push(`${name}: plugin/vendor lacks ${f}`);
      else if (!readFileSync(join(src, f)).equals(readFileSync(join(dest, f)))) problems.push(`${name}: plugin/vendor/${name}/${f} differs from ${name} ${want}`);
    }
  } else {
    rmSync(dest, { recursive: true, force: true });
    for (const f of from) {
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      cpSync(join(src, f), join(dest, f));
    }
    console.log(`${name} ${want}: ${from.length} files`);
  }
}
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error("run node tools/vendor/sync.mjs and commit plugin/vendor");
  process.exit(1);
}
if (check) console.log("plugin/vendor matches tools/vendor/package-lock.json");
