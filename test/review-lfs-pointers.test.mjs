// Review reads Git LFS files as pointers, and is told validation read the
// bytes. In run 2026-10-27T035432PDT-5093 (#2108) Codex's result reviewer
// found "LFS pointer text" in candidate/ where validation had read the
// hydrated model, refused the tests that read it twice and then held.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewResult } from "../dist/review/item.js";
import { LFS_GUIDANCE, REVIEW_GUIDANCE } from "../dist/review/result.js";
import { NO_WORKSPACE, tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(directory, message) {
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  );
  return git(directory, "rev-parse", "HEAD");
}

test("result and final review are told that Git LFS pointers in the evidence root stand for the bytes validation read", () => {
  assert.equal(
    LFS_GUIDANCE,
    'Git LFS files are exported as Git stores them, as pointers. A file in candidate/ or base/ at a path the tree\'s .gitattributes routes through Git LFS (filter=lfs), whose text is a Git LFS pointer (a "version https://git-lfs.github.com/spec/v1" line, then "oid sha256:" and "size" lines), stands for the object it names, whose sha256 and byte count those lines give; its patch in changes/ changes those lines, and the exact-tree inventory gives the pointer\'s byte size, not the object\'s. Every validation command ran on the real bytes of such a file, which Factory restores in each validation checkout before any command runs, so its pointer text in the evidence root is never a defect and never shows that a command or test read a pointer. Judge its content from the validation that passed on this tree and from any digest-checked copy of its bytes Factory supplies, such as a candidate set member\'s reviewCopy under media-sets/. Pointer text at a path .gitattributes does not route through Git LFS is that file\'s real content, and validation read it as it is.',
  );
  // Result, QA and final review all give the evidence-root guidance.
  assert.ok(REVIEW_GUIDANCE.evidenceRoot.includes(LFS_GUIDANCE));
});

test("a result review's candidate/ holds an LFS file's pointer, and its prompt says validation read the bytes", async () => {
  const checkout = tempDir("factory-review-lfs-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, ".gitattributes"),
    "*.glb filter=lfs diff=lfs merge=lfs -text\n",
  );
  const base = commit(checkout, "base");
  // The delivered model: its pointer is committed and its object is in the
  // local store, as validation hydrated it.
  const bytes = Buffer.from("glTF cube bytes");
  const oid = createHash("sha256").update(bytes).digest("hex");
  const store = join(
    checkout,
    ".git/lfs/objects",
    oid.slice(0, 2),
    oid.slice(2, 4),
  );
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, oid), bytes);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
  mkdirSync(join(checkout, "assets"));
  writeFileSync(join(checkout, "assets/cube.glb"), pointer);
  mkdirSync(join(checkout, "test"));
  writeFileSync(
    join(checkout, "test/cube.test.js"),
    'import { readFileSync } from "node:fs";\nreadFileSync("assets/cube.glb");\n',
  );
  const head = commit(checkout, "cube");
  const tree = git(checkout, "rev-parse", `${head}^{tree}`);
  const item = {
    kind: "work",
    id: "cube",
    title: "Deliver the cube model",
    goal: "Deliver the cube model with a test.",
    acceptance: ["assets/cube.glb is a binary glTF file."],
    nonGoals: ["No other assets."],
    citations: [],
    dependencies: [],
    ownedPaths: ["assets/cube.glb", "test/cube.test.js"],
    validation: [{ command: "npm test" }],
    brief: "Deliver the cube model.",
    priority: 1,
  };
  const seen = [];
  const planner = {
    async answer(call) {
      seen.push({
        prompt: call.prompt,
        exported: readFileSync(
          join(call.readDir, "candidate/assets/cube.glb"),
          "utf8",
        ),
      });
      throw new Error("seen");
    },
  };
  await assert.rejects(
    reviewResult({
      planner,
      plan: {
        base,
        items: [item],
        coverage: [],
        finalCommands: [],
        decisions: [],
      },
      item,
      checkout,
      base,
      commit: head,
      validation: { tree, commands: ["npm test"] },
      sources: [],
      dir: tempDir("factory-review-lfs-root-"),
      ...NO_WORKSPACE,
      signal: AbortSignal.timeout(60_000),
      log: () => {},
    }),
    /^Error: seen$/,
  );
  assert.equal(seen.length, 1);
  // Review exports Git objects: it does not hydrate, so it is told.
  assert.equal(seen[0].exported, pointer);
  assert.ok(seen[0].prompt.includes(LFS_GUIDANCE));
});
