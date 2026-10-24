// Selected media travels in Git LFS: the select step writes a chosen set
// only through LFS, in a real repository with git-lfs, and validation
// refuses a destination that holds plain bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hydrateTree, materializeSelection } from "../dist/media.js";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A checkout whose work commit has `.gitattributes` routing PNGs through LFS. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "factory-media-"));
  const directory = join(root, "checkout");
  mkdirSync(directory);
  git(directory, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n",
  );
  writeFileSync(join(directory, "README.md"), "target\n");
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { root, directory, commit: git(directory, "rev-parse", "HEAD") };
}

/** A captured set: each member's private copy, with its digest. */
function candidateSet(root, destinations) {
  const members = destinations.map((destination, index) => {
    const bytes = Buffer.from(`\x89PNG candidate ${index} for ${destination}`);
    const file = join(root, `member-${index}`);
    writeFileSync(file, bytes);
    return {
      role: `image-${index}`,
      mediaType: "image/png",
      destination,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  });
  return {
    id: "candidate-a",
    members,
    provenance: {
      source: "generated",
      rights: "test",
      visibility: "repository",
      lineage: [],
    },
  };
}

function item(ownedPaths) {
  return {
    kind: "work",
    id: "badge",
    title: "Badge",
    goal: "Add a badge.",
    acceptance: [],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths,
    validation: [],
    brief: "",
    expectedOutputRoles: ["image-0", "image-1"],
    minimumAssetSets: 1,
  };
}

function select(target, ownedPaths, set) {
  return materializeSelection({
    checkout: target.directory,
    directory: join(target.root, "select"),
    item: item(ownedPaths),
    commit: target.commit,
    set,
    ref: "refs/factory/test/select",
    signal: new AbortController().signal,
    log: () => {},
  });
}

test("every selected member is committed as its Git LFS pointer, whatever its format", async () => {
  const target = checkout();
  const set = candidateSet(target.root, ["assets/badge.png"]);
  const made = await select(target, ["assets/"], set);
  assert.equal(made.kind, "done", JSON.stringify(made));
  const [member] = set.members;
  const pointer = git(
    target.directory,
    "cat-file",
    "blob",
    `${made.value.commit}:assets/badge.png`,
  );
  assert.match(pointer, /^version https:\/\/git-lfs\.github\.com\/spec\/v1$/m);
  assert.match(pointer, new RegExp(`^oid sha256:${member.sha256}$`, "m"));
  assert.match(pointer, new RegExp(`^size ${member.bytes}$`, "m"));
});

test("a member .gitattributes doesn't route through LFS is the item's repair when it owns .gitattributes, else replan or cancel", async () => {
  const target = checkout();
  // A small file in a format no rule names: it would otherwise ship as a
  // plain blob.
  const set = candidateSet(target.root, ["assets/badge.png", "assets/a.bin"]);
  const repair = await select(target, ["assets/", ".gitattributes"], set);
  assert.equal(repair.kind, "repair", JSON.stringify(repair));
  assert.equal(repair.keepsSelection, true);
  assert.match(repair.finding, /assets\/a\.bin \(image-1\)/);
  assert.doesNotMatch(repair.finding, /badge\.png/);

  const held = await select(target, ["assets/"], set);
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(held.question, /assets\/a\.bin/);
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["replan", "cancel"],
  );
  // Nothing was committed or kept.
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "refs/factory/test/select"], {
      cwd: target.directory,
    }).status,
    128,
  );
});

test("validation holds when a selected destination holds plain bytes instead of its LFS pointer", async () => {
  const target = checkout();
  const set = candidateSet(target.root, ["assets/badge.bin"]);
  const [member] = set.members;
  // Someone committed the selected bytes outside LFS.
  mkdirSync(join(target.directory, "assets"));
  copyFileSync(member.file, join(target.directory, "assets/badge.bin"));
  git(target.directory, "add", "assets/badge.bin");
  git(
    target.directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "plain",
  );
  const held = await hydrateTree({
    directory: target.directory,
    repository: "drill/target",
    commit: git(target.directory, "rev-parse", "HEAD"),
    members: [
      {
        item: "badge",
        set: set.id,
        role: member.role,
        destination: member.destination,
        sha256: member.sha256,
        bytes: member.bytes,
      },
    ],
    link: false,
    signal: new AbortController().signal,
  });
  assert.equal(held.kind, "hold", JSON.stringify(held));
  assert.match(held.question, /not the Git LFS pointer of the selected bytes/);
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["retry", "replan", "cancel"],
  );
});
