#!/usr/bin/env node
// Copy each vendored library's published files from tools/deps/node_modules (installed from this directory's
// lockfile: `npm ci --ignore-scripts --prefix tools/deps`) into plugin/vendor/<name>/, byte for byte.
// `--check` changes nothing and exits 1 when plugin/vendor differs from what the lockfile installs (CI runs it).
//
// Why vendored: the plugin runs with nothing installed, from a Claude Code plugin install and from the Action's
// checkout, so a runtime library has to ship inside it (docs/PLAN.md, "Dependencies"). Only files the library
// itself published are copied, never rebuilt, so each copy can be compared with the registry's tarball.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "plugin", "vendor");
/** Per library: the published paths Pendulum imports (an ES module tree), its licence and its package.json. */
export const VENDORED = {
  "@actions/expressions": (p) => p === "LICENSE" || p === "package.json" || /^dist\/.+\.js$/.test(p),
  yaml: (p) => p === "LICENSE" || p === "package.json" || p.startsWith("browser/"),
  "smol-toml": (p) => p === "LICENSE" || p === "package.json" || /^dist\/[^/]+\.js$/.test(p),
  unbash: (p) => p === "LICENSE" || p === "package.json" || /^dist\/[^/]+\.js$/.test(p),
  // Its one self-contained build, the Public Suffix List and tldts-core bundled in: the CommonJS one, which Node loads
  // as its package.json says (no `type`), where the ES module build would be reparsed with a warning on every start.
  // And the list's rules as it publishes them (dist/cjs/src/data/trie.js, data only): its API answers for one name, never
  // whether a rule lies below one, which a host label's wildcard needs (lib/local.mjs suffixRuleUnder).
  // RFC 8785 JSON canonicalization (JCS), by one of the RFC's authors: the canonical form of the usage record a sealed session binds (lib/seal.mjs).
  canonicalize: (p) => p === "LICENSE" || p === "package.json" || p === "lib/canonicalize.js",
  tldts: (p) => p === "LICENSE" || p === "package.json" || p === "dist/index.cjs.min.js" || p === "dist/cjs/src/data/trie.js",
};

/** Every file under `dir`, relative; a link or anything but a directory or a regular file throws (a link would pass a byte check and break every installed copy). */
function files(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) return files(p, base);
    if (!st.isFile()) throw new Error(`${relative(base, p)} is not a regular file`);
    return [relative(base, p).split("\\").join("/")];
  });
}

/** What is at `p`, never following a link: "dir" (a real directory), "none", or "other" (a link, a file, anything else). */
function kind(p) {
  try {
    return lstatSync(p).isDirectory() ? "dir" : "other";
  } catch (e) {
    if (e.code === "ENOENT") return "none";
    throw e;
  }
}

const check = process.argv.includes("--check");
const lock = JSON.parse(readFileSync(join(here, "package-lock.json"), "utf8"));
const problems = [];
for (const [name, keep] of Object.entries(VENDORED)) {
  const src = join(here, "node_modules", name);
  const want = lock.packages?.[`node_modules/${name}`]?.version;
  const got = existsSync(join(src, "package.json")) ? JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version : null;
  if (!want || got !== want) {
    problems.push(`${name}: the lockfile pins ${want ?? "nothing"}, node_modules holds ${got ?? "nothing"}; run npm ci --ignore-scripts --prefix tools/deps`);
    continue;
  }
  const dest = join(out, name);
  const from = files(src).filter(keep).sort();
  if (check) {
    // plugin/vendor, a scope folder and the library's own folder must each be a real folder: a link there would pass the
    // byte check against wherever it leads, and every installed copy would read something else.
    const linked = [out, ...(name.includes("/") ? [join(out, name.split("/")[0])] : []), dest].find((d) => kind(d) === "other");
    if (linked) {
      problems.push(`${name}: ${relative(join(out, "..", ".."), linked).split("\\").join("/")} is not a real directory (a link?)`);
      continue;
    }
    const have = kind(dest) === "dir" ? files(dest).sort() : [];
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
// A scoped library sits one folder deeper (plugin/vendor/@scope/name): each name under a scope folder is checked too.
if (check && kind(out) === "dir")
  for (const n of readdirSync(out).flatMap((d) => (d.startsWith("@") && kind(join(out, d)) === "dir" ? readdirSync(join(out, d)).map((m) => `${d}/${m}`) : [d]))) if (!Object.hasOwn(VENDORED, n)) problems.push(`plugin/vendor/${n} is no library tools/deps pins`);
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error("run node tools/deps/sync.mjs and commit plugin/vendor");
  process.exit(1);
}
if (check) console.log("plugin/vendor matches tools/deps/package-lock.json");
