// bench/skills.mjs --check, the CI gate: a SKILL.md over the one-page cap fails it. Runs the real script on an invented
// plugin tree.
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
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-skills-"));
  mkdirSync(join(dir, "plugin", "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "plugin", "skills", "demo", "SKILL.md"), skillText);
  return { dir, args: ["--plugin", join(dir, "plugin"), "--out", join(dir, "skills.json")] };
}

test("--check still enforces the one-page cap", () => {
  const { args } = tree(`---\nname: demo\n---\n${"line\n".repeat(80)}`);
  assert.equal(skills([...args, "--check"]).status, 2);
});
