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
import { LFS_GUIDANCE, reviewResult } from "../dist/review/result.js";
import { tempDir } from "./helpers.mjs";

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
