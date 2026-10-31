// Workers edit through their provider's structured edit tool (#2283). Live
// (0.5.12), a Codex worker made every change through Python heredocs doing
// `open(p).read().replace(old, new)`: a replace that matched nothing changed
// nothing and said nothing, and no edit was counted. Each worker is told to
// use its edit tool, Factory notices a scripted rewrite that changed none
// of the files it names, and edits count from the worktree too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_EDITS, shellPrompt } from "../dist/providers/claude-worker.js";
import {
  CODEX_EDIT_CALL,
  codexShellNote,
} from "../dist/providers/codex-worker.js";
import {
  HeadRewrites,
  namedFiles,
  rewriteSnapshot,
  SCRIPTED_EDITS,
  scriptedRewrite,
  unchangedRewrite,
} from "../dist/work/scripted-edits.js";
import { ActivityLog } from "../dist/work/worker.js";
import { changedFiles } from "../dist/worktree.js";
import { item, tempDir } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A committed checkout with src/a.js and src/b.js. */
function checkout() {
  const worktree = tempDir("factory-scripted-");
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(worktree, "src", "b.js"), "export const b = 2;\n");
  git(worktree, "init", "--quiet");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  return worktree;
}

/** Run a shell command in the checkout, as a worker's shell would. */
function sh(worktree, command) {
  const result = spawnSync("sh", ["-c", command], {
    cwd: worktree,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

/** A Node rewrite of src/a.js: replace `from` with `to`, write it back. */
const nodeRewrite = (from, to) =>
  `node -e 'const fs=require("fs");const p="src/a.js";fs.writeFileSync(p, fs.readFileSync(p,"utf8").replace(${JSON.stringify(from)}, ${JSON.stringify(to)}))'`;

/** The live shape: a Python heredoc's str.replace, written back. */
const PYTHON_REWRITE = `python3 - <<'PY'
from pathlib import Path
p = Path("src/a.js")
p.write_text(p.read_text().replace("const a = 1", "const a = 3"))
PY`;

test("each worker is told to edit through its provider's structured edit tool, and to make a script fail when its pattern matches nothing (#2283)", () => {
  const feature = item("feature", { ownedPaths: ["src/a.js"] });
  for (const network of [false, true])
    for (const validating of [false, true]) {
      const note = codexShellNote(network, validating, feature);
      assert.ok(note.endsWith(`\n\n${CODEX_EDIT_CALL}`), note);
    }
  // Codex 0.160's apply_patch is a nested tool of code mode's exec.
  for (const fact of [
    "Edit files with Codex's apply_patch tool: it fails when a patch's context lines don't match the file, instead of changing nothing.",
    'Inside exec, call it as `text(await tools.apply_patch("*** Begin Patch\\n*** Update File: path/to/file\\n@@\\n-old line\\n+new line\\n*** End Patch"));`',
    SCRIPTED_EDITS,
  ])
    assert.ok(CODEX_EDIT_CALL.includes(fact), fact);
  for (const network of ["off", "host"]) {
    const prompt = shellPrompt({ network });
    assert.ok(prompt.endsWith(CLAUDE_EDITS), prompt);
  }
  assert.ok(
    CLAUDE_EDITS.startsWith(
      "Edit files with Edit and Write: Edit fails when its old_string doesn't match the file, instead of changing nothing.",
    ),
  );
  assert.ok(CLAUDE_EDITS.includes(SCRIPTED_EDITS));
  assert.ok(
    SCRIPTED_EDITS.includes(
      "only for a mechanical change across many files, and make the script fail when a pattern matches nothing",
    ),
  );
});

test("a scripted rewrite is a replace and a file write, or an in-place sed or perl; reads, prints and plain commands are none (#2283)", () => {
  for (const command of [
    PYTHON_REWRITE,
    nodeRewrite("a", "b"),
    "python3 -c \"t=open('src/a.js').read().replace('1','2'); open('src/a.js', 'w').write(t)\"",
    "python3 -c \"import re; p='src/a.js'; open(p, mode='w').write(re.sub('1', '2', open(p).read()))\"",
    "sed -i 's/1/2/' src/a.js",
    "sed -E -i.bak 's/1/2/' src/a.js",
    "perl -pi -e 's/1/2/' src/a.js",
    "/bin/bash -lc \"sed --in-place 's/1/2/' src/a.js\"",
  ])
    assert.equal(scriptedRewrite(command), true, command);
  for (const command of [
    "cat src/a.js",
    "git diff -- src/a.js",
    "sed -n '1,5p' src/a.js",
    "sed 's/1/2/' src/a.js | grep -i export",
    "perl -pe 's/1/2/' src/a.js",
    "python3 -c \"print(open('src/a.js').read().replace('1','2'))\"",
    "cat > src/c.js <<'EOF'\nexport const c = 3;\nEOF",
  ])
    assert.equal(scriptedRewrite(command), false, command);
});

test("a rewrite's files are the worktree's regular files it names, never .git, a directory or a path outside (#2283)", () => {
  const worktree = checkout();
  assert.deepEqual(
    namedFiles(
      `${PYTHON_REWRITE}; cat ./src/b.js src/missing.js src ../outside.js /etc/hostname .git/HEAD`,
      worktree,
    ),
    ["src/a.js", "src/b.js"],
  );
});

test("a Claude worker's scripted rewrite that matched nothing gets the note in its command's result, and one that changed its file doesn't (#2283)", () => {
  const worktree = checkout();
  // A no-op: the pattern matches nothing, the file is written back as it was.
  const missing = nodeRewrite("const a = 9", "const a = 3");
  const before = rewriteSnapshot(missing, worktree);
  assert.deepEqual([...before.files.keys()], ["src/a.js"]);
  sh(worktree, missing);
  assert.equal(
    unchangedRewrite(before, "Edit"),
    "Factory check: your command reads as a scripted rewrite (a replace, then a file write), but it left src/a.js unchanged. If it was meant to change that file, its pattern matched nothing: check the file and make the change with Edit.",
  );
  // The same file edited already, then a no-op: still noticed.
  sh(worktree, nodeRewrite("const a = 1", "const a = 2"));
  const again = rewriteSnapshot(missing, worktree);
  sh(worktree, missing);
  assert.match(unchangedRewrite(again, "Edit"), /left src\/a\.js unchanged\./);
  // A real rewrite.
  const real = nodeRewrite("const a = 2", "const a = 3");
  const changing = rewriteSnapshot(real, worktree);
  sh(worktree, real);
  assert.equal(unchangedRewrite(changing, "Edit"), undefined);
  assert.equal(
    readFileSync(join(worktree, "src", "a.js"), "utf8"),
    "export const a = 3;\n",
  );
  // An in-place sed that matches nothing; one that changes one of two files.
  const sed = "sed -i 's/nothing/x/' src/a.js src/b.js";
  const both = rewriteSnapshot(sed, worktree);
  sh(worktree, sed);
  assert.match(
    unchangedRewrite(both, "Edit"),
    /left src\/a\.js, src\/b\.js unchanged\. If it was meant to change them, its pattern matched nothing: check each file/,
  );
  const one = "sed -i 's/const b/let b/' src/a.js src/b.js";
  const partly = rewriteSnapshot(one, worktree);
  sh(worktree, one);
  assert.equal(unchangedRewrite(partly, "Edit"), undefined);
  // Not a rewrite: nothing is read.
  assert.equal(rewriteSnapshot("cat src/a.js", worktree), undefined);
});

test("a Codex worker's scripted rewrite that left its files as HEAD has them is told in its next request; a real one, or a miss it fixed before then, is not (#2283)", async () => {
  const worktree = checkout();
  const signal = AbortSignal.timeout(60_000);
  const rewrites = new HeadRewrites(worktree, signal);
  // Codex ran it; Factory sees the finished command.
  const missing = nodeRewrite("const a = 9", "const a = 3");
  sh(worktree, missing);
  rewrites.ran(`/bin/bash -lc '${missing.replaceAll("'", "'\\''")}'`);
  assert.equal(
    await rewrites.note("apply_patch"),
    "Factory check: your command reads as a scripted rewrite (a replace, then a file write), but it left src/a.js unchanged (as your checkout's HEAD has it). If it was meant to change that file, its pattern matched nothing: check the file and make the change with apply_patch.",
  );
  // Told once.
  assert.equal(await rewrites.note("apply_patch"), undefined);
  // A real rewrite.
  const real = nodeRewrite("const a = 1", "const a = 2");
  sh(worktree, real);
  rewrites.ran(real);
  assert.equal(await rewrites.note("apply_patch"), undefined);
  // A miss on a file changed since HEAD isn't seen: never a wrong note.
  sh(worktree, nodeRewrite("const a = 9", "x"));
  rewrites.ran(nodeRewrite("const a = 9", "x"));
  assert.equal(await rewrites.note("apply_patch"), undefined);
  // A miss on src/b.js, then fixed by the worker before its turn ended.
  const missB = "sed -i 's/nothing/x/' src/b.js";
  sh(worktree, missB);
  rewrites.ran(missB);
  sh(worktree, "sed -i 's/const b/let b/' src/b.js");
  assert.equal(await rewrites.note("apply_patch"), undefined);
  // An untracked file reads as changed.
  writeFileSync(join(worktree, "src", "c.js"), "export const c = 3;\n");
  rewrites.ran("sed -i 's/nothing/x/' src/c.js");
  assert.equal(await rewrites.note("apply_patch"), undefined);
});

test("edits count from the worktree: in a run where every edit goes through the shell, the edit count matches the changed files, an earlier attempt's changes aside (#2283)", async () => {
  const worktree = checkout();
  // An earlier attempt's change the worktree starts with.
  writeFileSync(join(worktree, "src", "b.js"), "export const b = 5;\n");
  const events = [];
  const activity = new ActivityLog(
    "a",
    worktree,
    (event) => events.push(event),
    [],
    {
      changes: () => changedFiles(worktree, AbortSignal.timeout(30_000)),
      intervalMs: 0,
    },
  );
  // The run begins.
  await activity.sample();
  // Shell edits only: a Python rewrite, a sed and a new file; no edit tool.
  activity.report({ kind: "command", command: "sed -i s/1/2/ src/a.js" });
  sh(worktree, "sed -i 's/1/2/' src/a.js");
  sh(worktree, "printf 'export const c = 3;\\n' > src/c.js");
  writeFileSync(join(worktree, "src", "b.js"), "export const b = 6;\n");
  await activity.sample();
  // An edit tool's file is counted by its report, not again by the tree.
  activity.report({ kind: "edit", path: join(worktree, "src", "d.js") });
  writeFileSync(join(worktree, "src", "d.js"), "export const d = 4;\n");
  // The same files again: counted once.
  sh(worktree, "sed -i 's/2/7/' src/a.js");
  await activity.sample();
  activity.close();
  const activities = events.filter((e) => e.event === "worker-activity");
  const edits = activities.reduce((sum, e) => sum + e.counts.edits, 0);
  const paths = activities.flatMap((e) => e.paths);
  assert.equal(edits, 3);
  assert.deepEqual(paths.sort(), ["src/a.js", "src/c.js", "src/d.js"]);
  assert.deepEqual(
    (await changedFiles(worktree, AbortSignal.timeout(30_000))).sort(),
    ["src/a.js", "src/b.js", "src/c.js", "src/d.js"],
  );
});
