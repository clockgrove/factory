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
import { skillsDigest } from "../skills.mjs";

const SCRIPT = join(import.meta.dirname, "..", "skills.mjs");
const skills = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function tree(skillText) {
  const dir = mkdtempSync(join(tmpdir(), "factory-bench-skills-"));
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
