// bench/skills.mjs --check, the CI gate: a skill changed without a re-recorded bench/skills.json fails and names the fix;
// a SKILL.md over the one-page cap fails too. Runs the real script on an invented plugin tree.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
