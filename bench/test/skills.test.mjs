// bench/skills.mjs --check, the CI gate: a skill changed without a re-recorded bench/skills.json fails and names the fix;
// a SKILL.md over the one-page cap fails too. Two branches that re-record changes to different skills merge cleanly.
// Runs the real script (and real git) on invented plugin trees.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INTERNAL_SKILLS, PLUGIN_ROOT_SENTENCE, skillRules, skillsDigest, unshippedRefs } from "../skills.mjs";

const SCRIPT = join(import.meta.dirname, "..", "skills.mjs");
const skills = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function tree(skillText) {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-skills-"));
  mkdirSync(join(dir, "plugin", "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "plugin", "skills", "demo", "SKILL.md"), skillText);
  return { dir, args: ["--plugin", join(dir, "plugin"), "--out", join(dir, "skills.json")] };
}

test("--check passes on a fresh record, then fails with the fix once a skill changes without a new record", () => {
  const { dir, args } = tree("---\nname: demo\n---\nOne line.\n");
  assert.equal(skills(args).status, 0);
  assert.equal(skills([...args, "--check"]).status, 0);
  writeFileSync(join(dir, "plugin", "skills", "demo", "reference.md"), "Looked up on demand.\n");
  const r = skills([...args, "--check"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /run node bench\/skills\.mjs and commit bench\/skills\.json/);
});

test("--check still enforces the one-page cap", () => {
  const { args } = tree(`---\nname: demo\n---\n${"line\n".repeat(80)}`);
  const r = skills([...args, "--check"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /over the one-page cap/);
});

test("the record holds only per-skill entries, and the digest computed from them is the one the stored digest was", () => {
  const { dir, args } = tree("---\nname: demo\n---\nAlpha.\n");
  writeFileSync(join(dir, "plugin", "skills", "demo", "reference.md"), "Looked up on demand.\n");
  mkdirSync(join(dir, "plugin", "skills", "beta"));
  writeFileSync(join(dir, "plugin", "skills", "beta", "SKILL.md"), "---\nname: beta\n---\nBeta.\n");
  const r = skills(args);
  assert.equal(r.status, 0);
  // 09e96df9617a: what this tree's record stored as its top-level digest before the digest was computed instead.
  assert.match(r.stdout, /2 skills, digest 09e96df9617a$/m);
  const rec = JSON.parse(readFileSync(join(dir, "skills.json"), "utf8"));
  assert.deepEqual(Object.keys(rec), ["version", "skills"]);
  assert.equal(skillsDigest(rec.skills), "09e96df9617a");
  assert.match(skills([...args, "--check"]).stdout, /^skills unchanged: 09e96df9617a$/m);
});

test("two branches that change different skills and re-record merge with no conflict, and --check still catches a stale record", () => {
  const { dir, args } = tree("---\nname: demo\n---\nDemo.\n");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(dir, "plugin", "skills", name));
    writeFileSync(join(dir, "plugin", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nOne line.\n`);
  }
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const change = (name, text) => {
    writeFileSync(join(dir, "plugin", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n${text}\n`);
    assert.equal(skills(args).status, 0);
    git("commit", "-qam", `change ${name}`);
  };
  git("init", "-q", "-b", "main");
  assert.equal(skills(args).status, 0);
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "a");
  change("alpha", "Alpha changed.");
  git("checkout", "-q", "main");
  git("checkout", "-qb", "b");
  change("beta", "Beta changed, with a reference file.");
  writeFileSync(join(dir, "plugin", "skills", "beta", "reference.md"), "Looked up on demand.\n");
  assert.equal(skills(args).status, 0);
  git("add", ".");
  git("commit", "-qm", "beta reference");
  git("merge", "-q", "--no-edit", "a"); // throws on a conflict
  assert.equal(skills([...args, "--check"]).status, 0, "the merged record matches the merged tree");
  writeFileSync(join(dir, "plugin", "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\nChanged again.\n");
  const r = skills([...args, "--check"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /run node bench\/skills\.mjs and commit bench\/skills\.json/);
});

// An install copies plugin/ alone (every marketplace entry is a git-subdir of `plugin`), so a skill that names Pendulum's
// docs, bench or README, or a path written from the checkout's root, points at nothing in an installed plugin (#454).
const CHECKOUT = join(import.meta.dirname, "..", "..");

test("every skill and agent definition names only what an installed plugin holds", () => {
  assert.deepEqual(unshippedRefs(join(CHECKOUT, "plugin")), []);
});

test("unshippedRefs: Pendulum's checkout by path or bare name is refused; the plugin's root, a Pendulum clone, a tagged link and the adopter's own files are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-refs-"));
  const files = {
    "README.md": "# Pendulum\n\n## To stop everything\n",
    "AGENTS.md": "rules\n",
    "action.yml": "name: x\n",
    "docs/LOCAL.md": "# Local mode\n\n## Set it up\n",
    "bench/score.mjs": "",
    ".github/workflows/ci.yml": "",
    "plugin/scripts/local.mjs": "",
    "plugin/skills/demo/reference.md": "As `bench/score.mjs` applies it; see INSTALL.md and the README's heading.\n",
    "plugin/agents/claude/a.md": "Read docs/LOCAL.md first.\n",
    "plugin/agents/render.mjs": "import x from '../../docs/LOCAL.md';\n",
    "docs/INSTALL.md": "# Install\n",
  };
  files["plugin/skills/demo/SKILL.md"] = [
    "---\nname: demo\n---",
    "Walk docs/LOCAL.md, then plugin/scripts/local.mjs; the README.md says more (action.yml).",
    'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/local.mjs" serve` or `node <plugin root>/scripts/local.mjs serve`; `node <plugin root>/scripts/gone.mjs` is gone.',
    "With a clone, `node <pendulum clone>/bench/score.mjs --repo <owner/name>`; `<pendulum clone>/bench/judge.mjs` is not there.",
    "[Set it up](https://github.com/clockgrove/pendulum/blob/v0.9.37/docs/LOCAL.md#set-it-up), [gone](https://github.com/clockgrove/pendulum/blob/v0.9.37/docs/LOCAL.md#accounts), [main](https://github.com/clockgrove/pendulum/blob/main/docs/LOCAL.md), [no file](https://github.com/clockgrove/pendulum/tree/v0.9.37/docs/GONE.md).",
    "The adopter's own: AGENTS.md, `.github/workflows/pendulum.yml`, `.agents/skills/`, `src/a.ts`, `$PENDULUM_IN/plan.md`, `~/.config/pendulum/accounts.json`, reference.md, the bench, the docs.",
  ].join("\n");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const refs = unshippedRefs(join(dir, "plugin")).map((r) => `${r.file}: ${r.ref}`);
  assert.deepEqual(refs, [
    "plugin/skills/demo/SKILL.md: https://github.com/clockgrove/pendulum/blob/v0.9.37/docs/LOCAL.md#accounts",
    "plugin/skills/demo/SKILL.md: https://github.com/clockgrove/pendulum/blob/main/docs/LOCAL.md",
    "plugin/skills/demo/SKILL.md: https://github.com/clockgrove/pendulum/tree/v0.9.37/docs/GONE.md",
    "plugin/skills/demo/SKILL.md: docs/LOCAL.md",
    "plugin/skills/demo/SKILL.md: plugin/scripts/local.mjs",
    "plugin/skills/demo/SKILL.md: README.md",
    "plugin/skills/demo/SKILL.md: action.yml",
    "plugin/skills/demo/SKILL.md: <plugin root>/scripts/gone.mjs",
    "plugin/skills/demo/SKILL.md: <pendulum clone>/bench/judge.mjs",
    "plugin/skills/demo/reference.md: bench/score.mjs",
    "plugin/skills/demo/reference.md: INSTALL.md",
    "plugin/skills/demo/reference.md: README",
    "plugin/agents/claude/a.md: docs/LOCAL.md",
  ]);
  const r = skills(["--plugin", join(dir, "plugin"), "--out", join(dir, "skills.json"), "--check"]);
  assert.equal(r.status, 4, "the CI gate fails on them");
  assert.match(r.stderr, /plugin\/skills\/demo\/SKILL\.md: docs\/LOCAL\.md \(a file of Pendulum's checkout\)/);
});

// The setup skill walks local mode from its own reference file; docs/LOCAL.md is the guide a person reads. Every command,
// path, setting and example the skill's file gives is one the guide gives too, so neither changes alone.
test("the setup skill's local-mode steps give only commands, paths and examples docs/LOCAL.md gives", () => {
  const guide = readFileSync(join(CHECKOUT, "docs", "LOCAL.md"), "utf8");
  const steps = readFileSync(join(CHECKOUT, "plugin", "skills", "pendulum-setup", "local.md"), "utf8");
  const fence = /^([ \t]*)```[^\n]*\n([\s\S]*?)\n\1```/gm;
  const blocks = [...steps.matchAll(fence)].map(([, indent, body]) => body.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n"));
  assert.ok(blocks.length > 0, "the accounts example");
  for (const b of blocks) assert.ok(guide.includes(b), `an example docs/LOCAL.md does not give:\n${b}`);
  const spans = [...steps.replace(fence, "").matchAll(/`[^`\n]+`/g)].map(([s]) => s);
  assert.ok(spans.length > 20);
  assert.deepEqual(spans.filter((s) => !guide.includes(s)), [], "code docs/LOCAL.md does not give");
  assert.match(readFileSync(join(CHECKOUT, "plugin", "skills", "pendulum-setup", "SKILL.md"), "utf8"), /walk \[local\.md\]\(local\.md\)/);
});

// How a skill is shown and loaded (#456): the internal stage skills stay out of every harness's user menu and implicit
// loading but load when Pendulum names them; a user skill's description opens with what it does, never a Claude-only
// /command line; a skill that names a plugin path says how each harness finds the plugin.
test("every skill follows the rules of how it is shown and loaded", () => {
  assert.deepEqual(skillRules(join(CHECKOUT, "plugin")), []);
});

test("skillRules: an internal skill without each harness's hide setting, a user skill opening with a /command and a plugin path with no plugin-root sentence are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-rules-"));
  const [internal, other] = INTERNAL_SKILLS;
  const skill = (name, fm, body = "Body.", files = {}) => {
    mkdirSync(join(dir, "plugin", "skills", name), { recursive: true });
    writeFileSync(join(dir, "plugin", "skills", name, "SKILL.md"), `---\nname: ${name}\n${fm}\n---\n${body}\n`);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, "plugin", "skills", name, f, ".."), { recursive: true });
      writeFileSync(join(dir, "plugin", "skills", name, f), text);
    }
  };
  const hidden = { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n" };
  // Hidden in every harness, and a user skill as it should be: no break.
  skill(internal, 'description: "Internal: a stage."\nuser-invocable: false', "Body.", hidden);
  skill("user-ok", "description: Does a thing. Use when asked. Not for the other thing.", `Run it. ${PLUGIN_ROOT_SENTENCE} Then \`node <plugin root>/scripts/x.mjs\`.`);
  const rules = () => skillRules(join(dir, "plugin")).map((r) => `${r.skill}: ${r.why}`);
  assert.deepEqual(rules(), []);
  // Each break on its own.
  skill(other, 'description: "Internal: a stage."', "Body.", hidden);
  skill("user-slash", 'description: "/pendulum:pendulum-x <issue>. Does a thing."');
  skill("user-hidden", "description: Does a thing.\nuser-invocable: false");
  skill("user-root", "description: Does a thing.", 'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs"`.');
  skill("user-ref", "description: Does a thing.", "Body.", { "reference.md": "Read `<plugin root>/templates/task-card.md`.\n" });
  assert.deepEqual(rules(), [
    `${other}: an internal skill sets \`user-invocable: false\` (out of Claude Code's / menu)`,
    "user-hidden: a user skill sets no `user-invocable`: only the internal skills are hidden",
    "user-ref: a skill that names a plugin path says how to find the plugin, in the shared sentence (PLUGIN_ROOT_SENTENCE), in its SKILL.md",
    "user-root: a skill that names a plugin path says how to find the plugin, in the shared sentence (PLUGIN_ROOT_SENTENCE), in its SKILL.md",
    "user-slash: a user skill's description starts with what it does and when to use it, not a /command line",
  ]);
  // The internal skill's other settings: Codex's implicit loading on, model invocation blocked, a description that hides nothing.
  skill(internal, "description: The first stage.\nuser-invocable: false\ndisable-model-invocation: true", "Body.", { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n" });
  assert.deepEqual(
    rules().filter((r) => r.startsWith(`${internal}:`)),
    [
      `${internal}: an internal skill sets no \`disable-model-invocation\`: a worker loads it itself`,
      `${internal}: an internal skill has agents/openai.yaml with \`policy: allow_implicit_invocation: false\` (out of Codex's implicit loading)`,
      `${internal}: an internal skill's description starts with \`Internal\``,
    ],
  );
  // The plugin files they name exist, so the gate fails on these rules alone.
  mkdirSync(join(dir, "plugin", "scripts"));
  mkdirSync(join(dir, "plugin", "templates"));
  for (const f of ["x.mjs", "local.mjs"]) writeFileSync(join(dir, "plugin", "scripts", f), "");
  writeFileSync(join(dir, "plugin", "templates", "task-card.md"), "");
  const r = skills(["--plugin", join(dir, "plugin"), "--out", join(dir, "skills.json")]);
  assert.equal(r.status, 5, "the CI gate fails on them");
  assert.match(r.stderr, /user-slash: a user skill's description starts with what it does/);
});

// Codex loads a skill whose implicit invocation is off only when the prompt names it as `$name`; Claude Code and Copilot
// read the same mention as the skill's name. Every prompt Pendulum gives a worker or reviewer names its stage skills so.
test("the task card and the review job's prompts name each internal skill they load as a $ mention", () => {
  const card = readFileSync(join(CHECKOUT, "plugin", "templates", "task-card.md"), "utf8");
  for (const s of ["pendulum-objective-plan", "pendulum-implement-split", "pendulum-prove-acceptance", "pendulum-deliver-pr"]) assert.ok(card.includes(`$${s}`), s);
  assert.match(card, /each is the `SKILL\.md` in `\.agents\/skills\/<name>\/` and `\.claude\/skills\/<name>\/` of this checkout/, "and by path, for a session whose first prompt was compacted away");
  const review = readFileSync(join(CHECKOUT, "plugin", "scripts", "review.mjs"), "utf8");
  assert.equal(review.match(/Follow the \$pendulum-review-pr skill/g)?.length, 2, "the reviewer and the foundation pass");
  assert.match(review, /Load the \$pendulum-deliver-pr skill's "Reviewer comments" section/);
});
