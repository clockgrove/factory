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
 * plugin does not hold (unshippedRefs), 5 when a skill breaks a rule of how it is shown and loaded (skillRules), and 6 when
 * this checkout's plugin holds other skills than the pinned set (skillSet).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseYaml } from "../plugin/scripts/lib/yaml.mjs";

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
 * not Pendulum's checkout, even where the checkout has one too.
 */
const ADOPTER_NAMES = new Set([".github", ".agents", "AGENTS.md"]);
/** A full link into Pendulum's repository: its ref, path and heading. */
const PENDULUM_LINK = /https:\/\/github\.com\/clockgrove\/pendulum\/(?:blob|tree)\/([^/\s]+)\/([^\s#)>`'"]+)(?:#([^\s)>`'"]+))?/g;
/** A path-shaped word: a `<placeholder>` (which may hold spaces) or any run of characters prose does not end a path with. */
const WORD = /(?:<[^<>\s][^<>\n]*>|[^\s`'"()[\]{},;<>|*])+/g;
/** The roots a skill may write a path from, and the tree each one names: the installed plugin, or a clone of Pendulum. */
const ROOTS = [
  ["${CLAUDE_PLUGIN_ROOT}/", "plugin"],
  ["<plugin root>/", "plugin"],
  ["<pendulum clone>/", "checkout"],
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
 * - a path in a clone of Pendulum (`<pendulum clone>/…`), for a tool the plugin does not ship, which must exist in the checkout;
 * - a full link into Pendulum's repository at a release tag, to a file of the checkout and, with an anchor, one of its headings;
 * - anything else in the repository it works in.
 * A path that starts with a top-level entry of Pendulum's checkout (`docs/`, `bench/`, `plugin/`, `README.md`), the bare
 * name of a top-level file or of a file in `docs/`, or a top-level file's upper-case name without its extension (`README`)
 * names Pendulum's checkout instead, which an installed plugin does not have, unless it is a name every adopter has
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
    for (const [link, ref, path, anchor] of text.matchAll(PENDULUM_LINK)) {
      const target = join(checkout, path.replace(/\/$/, ""));
      if (!/^v\d+\.\d+\.\d+$/.test(ref)) flag(link, "a link into Pendulum's repository pins a release tag (vX.Y.Z)");
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
        flag(word, "a file of Pendulum's checkout");
      }
    }
  }
  return out;
}

/**
 * The stage skills Pendulum's own runs load: the worker's four, by the task card, and the reviewer's, by the review job,
 * its reviewer agents and the pendulum-review-here skill. No user asks for them, and one that fires in a user's session works
 * without the run around it (the reviewer's without the trust check and the posting step), so each is hidden in every
 * harness that can hide a skill, and says it is internal where none can (Copilot).
 */
export const INTERNAL_SKILLS = ["pendulum-objective-plan", "pendulum-implement-split", "pendulum-prove-acceptance", "pendulum-deliver-pr", "pendulum-review-pr"];

/**
 * The skills a user sees, one verb each: write, refine and start an Objective (file), see where they stand and what a
 * Blocked one or a Question needs (status), stop, restart, run one here, serve the queue here, review a PR here, kick the
 * Action's dispatcher, apply a workflow hand-over, score, check the setup (doctor) and install (setup). Every other skill
 * is internal (INTERNAL_SKILLS); skillSet holds the plugin to exactly these.
 */
export const USER_SKILLS = [
  "pendulum-file",
  "pendulum-status",
  "pendulum-stop",
  "pendulum-restart",
  "pendulum-run",
  "pendulum-serve",
  "pendulum-review-here",
  "pendulum-kick",
  "pendulum-handover",
  "pendulum-score",
  "pendulum-doctor",
  "pendulum-setup",
];

/** The one sentence, word for word, by which every skill that runs a plugin command finds the plugin in each harness. */
export const PLUGIN_ROOT_SENTENCE =
  "`<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.";

/** A SKILL.md's frontmatter, parsed as the YAML 1.2 core schema reads it; null when it has none or it does not parse. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  try {
    const fm = parseYaml(m[1], { typed: true });
    return fm && typeof fm === "object" && !Array.isArray(fm) ? fm : null;
  } catch {
    return null;
  }
}

/**
 * Every break of how the plugin's skills are shown and loaded, as `{skill, why}`:
 * - an internal skill (INTERNAL_SKILLS) is out of Claude Code's `/` menu (`user-invocable: false`) but still loaded by
 *   the model (no `disable-model-invocation`), out of Codex's implicit loading (`agents/openai.yaml`'s
 *   `policy.allow_implicit_invocation: false`; the task card's `$name` mention still loads it), and its description
 *   starts `Internal`, which is all Copilot has;
 * - a user skill's description starts with what it does, never a `/command` line, which only Claude Code reads as one
 *   (its listing shows `<issue>` escaped) and the other harnesses show as text, and it sets no `user-invocable`;
 * - a skill that names a plugin path (from `<plugin root>/` or `${CLAUDE_PLUGIN_ROOT}/`) in any of its files says how to
 *   find the plugin in its SKILL.md, in PLUGIN_ROOT_SENTENCE.
 */
export function skillRules(pluginDir) {
  const dir = join(pluginDir, "skills");
  const out = [];
  for (const skill of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const file = join(dir, skill, "SKILL.md");
    if (!existsSync(file)) continue;
    const flag = (why) => out.push({ skill, why });
    const text = readFileSync(file, "utf8");
    const fm = frontmatter(text) ?? {};
    const description = typeof fm.description === "string" ? fm.description : "";
    if (INTERNAL_SKILLS.includes(skill)) {
      if (fm["user-invocable"] !== false) flag("an internal skill sets `user-invocable: false` (out of Claude Code's / menu)");
      if (Object.hasOwn(fm, "disable-model-invocation")) flag("an internal skill sets no `disable-model-invocation`: a worker loads it itself");
      const policy = join(dir, skill, "agents", "openai.yaml");
      let codex = null;
      try {
        codex = existsSync(policy) ? parseYaml(readFileSync(policy, "utf8"), { typed: true }) : null;
      } catch {}
      if (codex?.policy?.allow_implicit_invocation !== false) flag("an internal skill has agents/openai.yaml with `policy: allow_implicit_invocation: false` (out of Codex's implicit loading)");
      if (!/^Internal\b/.test(description)) flag("an internal skill's description starts with `Internal`");
    } else {
      if (description.startsWith("/")) flag("a user skill's description starts with what it does and when to use it, not a /command line");
      if (Object.hasOwn(fm, "user-invocable")) flag("a user skill sets no `user-invocable`: only the internal skills are hidden");
    }
    const files = [file, ...skillFiles(join(dir, skill)).map((f) => join(dir, skill, f))];
    if (files.some((f) => /(?:<plugin root>|\$\{CLAUDE_PLUGIN_ROOT\})\//.test(readFileSync(f, "utf8").replaceAll(PLUGIN_ROOT_SENTENCE, ""))) && !text.includes(PLUGIN_ROOT_SENTENCE)) {
      flag("a skill that names a plugin path says how to find the plugin, in the shared sentence (PLUGIN_ROOT_SENTENCE), in its SKILL.md");
    }
  }
  return out;
}

/**
 * Every difference between the plugin's skills and the pinned set, as `{skill, why}`: a pinned skill (USER_SKILLS,
 * INTERNAL_SKILLS) the plugin lacks, a skill it has that is pinned as neither, and a user skill whose description does
 * not say when to use it (`Use when`) and what it is not for, against its nearest neighbour (`Not for`). The CLI holds
 * this checkout's own plugin to it; a plugin tree made for a test has skills of its own.
 */
export function skillSet(pluginDir, { user = USER_SKILLS, internal = INTERNAL_SKILLS } = {}) {
  const dir = join(pluginDir, "skills");
  const have = existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "SKILL.md"))).sort() : [];
  const out = [];
  for (const skill of [...user, ...internal].filter((n) => !have.includes(n)).sort()) out.push({ skill, why: "a pinned skill the plugin does not have" });
  for (const skill of have) {
    if (internal.includes(skill)) continue;
    if (!user.includes(skill)) {
      out.push({ skill, why: "a skill pinned as neither a user skill (USER_SKILLS) nor an internal one (INTERNAL_SKILLS)" });
      continue;
    }
    const description = frontmatter(readFileSync(join(dir, skill, "SKILL.md"), "utf8"))?.description;
    if (typeof description !== "string" || !/\bUse when\b/.test(description) || !/\bNot for\b/.test(description)) {
      out.push({ skill, why: "a user skill's description says what it does, when to use it (`Use when`) and what it is not for (`Not for`)" });
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
    process.stderr.write(`skills name what an installed plugin does not hold (an install copies plugin/ alone):\n${refs.map((r) => `  ${r.file}: ${r.ref} (${r.why})`).join("\n")}\nWrite a plugin file from <plugin root>/, a tool the plugin does not ship from <pendulum clone>/ (and say up front that the skill needs a clone), and a page a person reads as a link at a release tag.\n`);
    process.exit(4);
  }
  const rules = skillRules(plugin);
  if (rules.length) {
    process.stderr.write(`skills break how they are shown and loaded:\n${rules.map((r) => `  ${r.skill}: ${r.why}`).join("\n")}\n`);
    process.exit(5);
  }
  // The pinned set is this checkout's plugin's: a tree made for a test has skills of its own.
  const set = plugin === resolve(import.meta.dirname, "..", "plugin") ? skillSet(plugin) : [];
  if (set.length) {
    process.stderr.write(`skills differ from the pinned set (USER_SKILLS, INTERNAL_SKILLS in bench/skills.mjs):\n${set.map((r) => `  ${r.skill}: ${r.why}`).join("\n")}\n`);
    process.exit(6);
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
