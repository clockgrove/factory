import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkWorkHandoff,
  runDeclaredValidation,
  workerFilesTree,
} from "../dist/execution/claude-validation.js";

const status = (worktree) =>
  execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
    encoding: "utf8",
  });

test("declared validation runs on a snapshot and leaves the worktree unchanged", async () => {
  const worktree = join(
    mkdtempSync(join(tmpdir(), "factory-worker-validation-")),
    "worktree",
  );
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "a.txt"), "original\n");
  execFileSync("git", ["-C", worktree, "add", "a.txt"]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  writeFileSync(join(worktree, "a.txt"), "changed\n");
  writeFileSync(join(worktree, "new.txt"), "new\n");
  // Private staging stays out of the snapshot, as it does in collection.
  mkdirSync(join(worktree, ".factory-inputs"));
  writeFileSync(join(worktree, ".factory-inputs", "source-0"), "private\n");
  writeFileSync(join(worktree, ".factory-handoff.json"), "{}\n");
  const before = status(worktree);
  const passed = await runDeclaredValidation(
    worktree,
    [
      "grep -q changed a.txt",
      "test -f new.txt",
      "test ! -e .factory-inputs",
      "test ! -e .factory-handoff.json",
      // Each run gets its own empty TMPDIR, as a capture run does.
      'case "$TMPDIR" in */factory-validation-*) test -z "$(ls -A "$TMPDIR")" ;; *) exit 1 ;; esac',
    ],
    1,
  );
  assert.equal(passed.passed, true, passed.text);
  assert.equal(passed.tree, await workerFilesTree(worktree));
  const failed = await runDeclaredValidation(
    worktree,
    ["echo marker-output; exit 3"],
    2,
  );
  assert.equal(failed.passed, false);
  assert.match(failed.text, /marker-output/);
  assert.equal(status(worktree), before);
  // An edit after the passing run leaves the final files unvalidated.
  writeFileSync(join(worktree, "new.txt"), "edited\n");
  assert.notEqual(await workerFilesTree(worktree), passed.tree);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "changed\n");
  assert.equal(existsSync(`${worktree}.validation/1`), false);
  // Validation decodes the handoff as collection will and names what is wrong.
  const handoff = { peers: [], acceptance: ["a.txt holds the change"] };
  writeFileSync(
    join(worktree, ".factory-handoff.json"),
    JSON.stringify({
      summary: "done",
      notes: [{ kind: "verification", criterionIndex: 0, text: "a.txt:1" }],
    }),
  );
  const rejected = checkWorkHandoff(worktree, handoff);
  assert.equal(rejected.passed, false);
  assert.match(rejected.text, /unexpected top-level key "summary"/);
  assert.match(
    rejected.text,
    /note 0: unexpected key "text"; missing key summary, paths, consumerIndices\n/,
  );
  writeFileSync(
    join(worktree, ".factory-handoff.json"),
    JSON.stringify({
      notes: [
        {
          kind: "verification",
          criterionIndex: 0,
          summary: "changed: a.txt:1",
          paths: ["a.txt"],
          consumerIndices: [],
        },
      ],
    }),
  );
  const decoded = checkWorkHandoff(worktree, handoff);
  assert.equal(decoded.passed, true);
  // Self-review sees the exact criterion beside the note for its index.
  assert.match(
    decoded.criteria,
    /\n\[0\] a\.txt holds the change\nnote \[0\]: changed: a\.txt:1$/,
  );
});
