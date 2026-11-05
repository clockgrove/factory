// bench/judge.mjs on two commits of a throwaway repository with a stand-in
// judge (fixtures/judge-stub.mjs): blind order, unblinded answer, and the
// kept lib/judge.mjs contract (no .git in the trees it is given).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BENCH = join(import.meta.dirname, "..");
const STUB = join(import.meta.dirname, "fixtures", "judge-stub.mjs");

test("judge.mjs: blind pair, unblinded to refs; the judge prefers the quoting tree on intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-judge-test-"));
  const repo = join(dir, "repo");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "plain\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");
  writeFileSync(join(repo, "f.txt"), "quoted\n");
  git("commit", "-qam", "candidate");
  git("tag", "cand");
  writeFileSync(join(dir, "objective.md"), "Quote CSV values\n");
  const out = JSON.parse(execFileSync("node", [join(BENCH, "judge.mjs"), "--repo", repo, "--a", "cand", "--b", "base", "--objective", join(dir, "objective.md"), "--judge", `node ${JSON.stringify(STUB)}`], { encoding: "utf8" }));
  assert.equal(out.judgeVersion, "stub 1");
  assert.equal(out.intent.ref, "cand");
  assert.equal(out.quality.ref, "tie");
  assert.deepEqual(new Set([out.A.ref, out.B.ref]), new Set(["cand", "base"]));
  assert.equal(out[out.intent.choice].ref, "cand");
});
