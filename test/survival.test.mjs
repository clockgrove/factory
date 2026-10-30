// `factory diagnostics ISSUE --survival` on a synthetic Git history: what
// became of the lines an Objective's merge added, from local Git alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, configured, installation, seed } from "./helpers.mjs";

test("survival: rewritten share, no revert, the fix-up and a human baseline", () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const checkout = join(inst.root, "checkout");
  const git = (args, env = {}) => {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["config", "user.name", "Someone"]);
  git(["config", "user.email", "someone@example.com"]);
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const commit = (day, subject, files) => {
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(checkout, name), `${text.join("\n")}\n`);
    git(["add", "-A"]);
    const date = new Date(
      Date.parse("2026-01-01T12:00:00Z") + (day - 1) * 86_400_000,
    ).toISOString();
    git(["commit", "--quiet", "-m", subject], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return { sha: git(["rev-parse", "HEAD"]), date };
  };
  commit(1, "Start", { "a.txt": ["a"] });
  // Factory's squash merge adds ten lines.
  const merge = commit(11, "Add f (#2)", { "f.txt": lines });
  // A human fixes two of them, and re-indents another (whitespace only).
  const fixed = [...lines];
  fixed[1] = "line 2 fixed";
  fixed[2] = "line 3 fixed";
  const fixup = commit(13, "Fix f", { "f.txt": fixed });
  const indented = [...fixed];
  indented[3] = "    line 4";
  commit(16, "Indent f", { "f.txt": indented });
  // After 30 days: one more of Factory's lines and one of the human's.
  const late = [...indented];
  late[4] = "line 5 changed";
  late[1] = "line 2 changed again";
  commit(51, "Change f", { "f.txt": late });
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  seed(inst, 7, "done", {
    done: {
      "item:a:merge": {
        mergeSha: merge.sha,
        integratedSha: merge.sha,
        at: merge.date,
      },
    },
  });

  const result = cli(inst, "diagnostics", "7", "--survival", "--json");
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  const [objective] = report.objectives;
  const shares = (survival) =>
    survival.map(({ days, added, unchanged }) => [days, unchanged, added]);
  assert.deepEqual(shares(objective.survival), [
    [7, 8, 10],
    [30, 8, 10],
    [90, 7, 10],
  ]);
  assert.equal(objective.reverted, false);
  assert.deepEqual(
    objective.fixups.map(({ sha, subject, lines, by }) => [
      sha,
      subject,
      lines,
      by,
    ]),
    [[fixup.sha, "Fix f", 2, "human"]],
  );
  assert.deepEqual(shares(report.baseline.survival), [
    [7, 2, 2],
    [30, 2, 2],
    [90, 1, 2],
  ]);
  assert.deepEqual(report.capped, []);
  const text = cli(inst, "diagnostics", "7", "--survival");
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /#7: 1 merge, not reverted/);
  assert.match(text.out, /fix-ups within 30 d: 1/);
});
