#!/usr/bin/env node
/**
 * `node bench/skills.mjs [--plugin DIR] [--out bench/skills.json] [--check]`: record the
 * skills as versioned text. One entry per skill with its SKILL.md's SHA-256, line and word
 * counts, plus `files` for every other file in the skill's directory (its reference files,
 * loaded on demand). The file holds only those per-skill entries, each on lines of its own, so two
 * changes to different skills merge without a conflict; the one digest over all of them is
 * computed from the entries wherever it is read (skillsDigest), and the scorecard carries it so
 * every row names the skills it ran on (PLAN.md: skills are versioned in the bench, one page
 * each, and no line is added without a scored Objective). The one-page cap applies to SKILL.md
 * only. `--check` exits 3 when the recorded entries differ from the tree (a skill or one of its
 * files changed without a new record). Both forms exit 4 when a skill or agent definition names something an installed
 * plugin does not hold (unshippedRefs).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SKILL_PAGE = { lines: 60, words: 700 };

const measure = (bytes) => {
  const text = bytes.toString("utf8");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), lines: text.split("\n").length, words: text.split(/\s+/).filter(Boolean).length };
};

/** Every file under a skill's directory but its SKILL.md, by path relative to it with `/` separators, sorted. */
function skillFiles(skillDir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(skillDir, p).split(sep).join("/"));
    }
  };
  walk(skillDir);
  return out.filter((f) => f !== "SKILL.md").sort();
}

export function recordSkills(pluginDir) {
  const dir = join(pluginDir, "skills");
  const skills = {};
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    skills[name] = measure(readFileSync(file));
    const files = skillFiles(join(dir, name));
    if (files.length) skills[name].files = Object.fromEntries(files.map((f) => [f, measure(readFileSync(join(dir, name, f)))]));
  }
  return { version: 2, skills };
}

/**
 * Names an adopter repository has by its own conventions: a skill that names one means the repository it works in,
 * not Factory's checkout, even where the checkout has one too.
 */
const ADOPTER_NAMES = new Set([".github", ".agents", "AGENTS.md"]);
/** A full link into Factory's repository: its ref, path and heading. */
const FACTORY_LINK = /https:\/\/github\.com\/clockgrove\/factory\/(?:blob|tree)\/([^/\s]+)\/([^\s#)>`'"]+)(?:#([^\s)>`'"]+))?/g;
/** A path-shaped word: a `<placeholder>` (which may hold spaces) or any run of characters prose does not end a path with. */
const WORD = /(?:<[^<>\s][^<>\n]*>|[^\s`'"()[\]{},;<>|*])+/g;
/** The roots a skill may write a path from, and the tree each one names: the installed plugin, or a clone of Factory. */
const ROOTS = [
  ["${CLAUDE_PLUGIN_ROOT}/", "plugin"],
  ["<plugin root>/", "plugin"],
  ["<factory clone>/", "checkout"],
];
/** GitHub's anchor for a heading. */
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function textFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!name.endsWith(".mjs")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Every reference in the plugin's skills and agent definitions to something an installed plugin does not hold. An install
 * copies the plugin directory alone (every marketplace entry is a git-subdir of `plugin`), so a skill can name:
 * - a path in the installed plugin, from its root (`${CLAUDE_PLUGIN_ROOT}/…` or `<plugin root>/…`), which must exist there;
 * - a path in a clone of Factory (`<factory clone>/…`), for a tool the plugin does not ship, which must exist in the checkout;
 * - a full link into Factory's repository at a release tag, to a file of the checkout and, with an anchor, one of its headings;
 * - anything else in the repository it works in.
 * A path that starts with a top-level entry of Factory's checkout (`docs/`, `bench/`, `plugin/`, `README.md`), the bare
 * name of a top-level file or of a file in `docs/`, or a top-level file's upper-case name without its extension (`README`)
 * names Factory's checkout instead, which an installed plugin does not have, unless it is a name every adopter has
 * (ADOPTER_NAMES). Returns `{file, ref, why}` per reference, file relative to the checkout.
 */
export function unshippedRefs(pluginDir) {
  const plugin = resolve(pluginDir);
  const checkout = dirname(plugin);
  const top = new Set(readdirSync(checkout).filter((n) => n !== ".git"));
  const files = [...top].filter((n) => statSync(join(checkout, n)).isFile());
  const docs = existsSync(join(checkout, "docs")) ? readdirSync(join(checkout, "docs")).filter((n) => statSync(join(checkout, "docs", n)).isFile()) : [];
  const bare = new Set([...files, ...docs].flatMap((n) => [n, n.replace(/\.[^.]+$/, "")].filter((x) => x === n || /^[A-Z][A-Z0-9_-]*$/.test(x))));
  const trees = { plugin, checkout };
  const out = [];
  for (const file of [...textFiles(join(plugin, "skills")), ...textFiles(join(plugin, "agents"))]) {
    const rel = relative(checkout, file).split(sep).join("/");
    const flag = (ref, why) => out.push({ file: rel, ref, why });
    let text = readFileSync(file, "utf8");
    for (const [link, ref, path, anchor] of text.matchAll(FACTORY_LINK)) {
      const target = join(checkout, path.replace(/\/$/, ""));
      if (!/^v\d+\.\d+\.\d+$/.test(ref)) flag(link, "a link into Factory's repository pins a release tag (vX.Y.Z)");
      else if (!existsSync(target)) flag(link, `the checkout has no ${path}`);
      else if (anchor && (statSync(target).isDirectory() || !readFileSync(target, "utf8").split("\n").some((l) => /^#{1,6}\s/.test(l) && slug(l.replace(/^#+\s+/, "")) === anchor))) flag(link, `${path} has no heading #${anchor}`);
    }
    text = text.replace(/https?:\/\/\S+/g, " ");
    for (let [word] of text.matchAll(WORD)) {
      word = word.replace(/[.:!?]+$/, "").replace(/^\.\//, "");
      if (!word) continue;
      const root = ROOTS.find(([prefix]) => word.startsWith(prefix));
      if (root) {
        // The fixed part of the path: up to a placeholder or a glob.
        const fixed = word.slice(root[0].length).split("/").filter(Boolean);
        const end = fixed.findIndex((s) => /[<$]/.test(s));
        const path = (end < 0 ? fixed : fixed.slice(0, end)).join("/");
        if (!existsSync(join(trees[root[1]], path))) flag(word, `${root[0]} has no ${path}`);
        continue;
      }
      const first = word.split("/")[0];
      if (word.includes("/") ? top.has(first) && !ADOPTER_NAMES.has(first) : bare.has(word) && !ADOPTER_NAMES.has(word)) {
        flag(word, "a file of Factory's checkout");
      }
    }
  }
  return out;
}

/** The one digest over a record's skills (sorted by name, as recordSkills writes them). */
export function skillsDigest(skills) {
  // One line per SKILL.md and one per other file, so a tree without reference files keeps the digest it had before them.
  const lines = Object.entries(skills).flatMap(([n, s]) => [`${n}:${s.sha256}`, ...Object.entries(s.files || {}).map(([f, m]) => `${n}/${f}:${m.sha256}`)]);
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { plugin: { type: "string" }, out: { type: "string" }, check: { type: "boolean" } } });
  const plugin = resolve(values.plugin ?? join(import.meta.dirname, "..", "plugin"));
  const out = resolve(values.out ?? join(import.meta.dirname, "skills.json"));
  const rec = recordSkills(plugin);
  const digest = skillsDigest(rec.skills);
  const over = Object.entries(rec.skills).filter(([, s]) => s.lines > SKILL_PAGE.lines || s.words > SKILL_PAGE.words);
  if (over.length) {
    process.stderr.write(`over the one-page cap (${SKILL_PAGE.lines} lines, ${SKILL_PAGE.words} words): ${over.map(([n, s]) => `${n} (${s.lines} lines, ${s.words} words)`).join(", ")}\n`);
    process.exit(2);
  }
  const refs = unshippedRefs(plugin);
  if (refs.length) {
    process.stderr.write(`skills name what an installed plugin does not hold (an install copies plugin/ alone):\n${refs.map((r) => `  ${r.file}: ${r.ref} (${r.why})`).join("\n")}\nWrite a plugin file from <plugin root>/, a tool the plugin does not ship from <factory clone>/ (and say up front that the skill needs a clone), and a page a person reads as a link at a release tag.\n`);
    process.exit(4);
  }
  if (values.check) {
    const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).skills ?? null : null;
    if (JSON.stringify(prev) !== JSON.stringify(rec.skills)) {
      process.stderr.write(`skills changed without a new record in ${out} (recorded ${prev ? skillsDigest(prev) : "none"}, tree ${digest}): run node bench/skills.mjs and commit bench/skills.json with the skill change\n`);
      process.exit(3);
    }
    process.stdout.write(`skills unchanged: ${digest}\n`);
  } else {
    writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`);
    process.stdout.write(`${out}: ${Object.keys(rec.skills).length} skills, digest ${digest}\n`);
  }
}
