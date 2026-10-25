// Selected media travels in Git LFS: the plan check refuses a media item
// with no way to LFS-routed destinations, the select step writes a chosen
// set only through LFS, in a real repository with git-lfs, and validation
// refuses a destination that holds plain bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hydrateTree, materializeSelection } from "../dist/media.js";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles } from "../dist/planning/facts.js";
import { repairPath } from "../dist/repair.js";
import { aboutMedia } from "../dist/work/step-deliver.js";

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

function item(ownedPaths, fields = {}) {
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
    brief: "Add the badge.",
    expectedOutputRoles: ["image-0", "image-1"],
    minimumAssetSets: 1,
    ...fields,
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

test("a member .gitattributes doesn't route through LFS is the item's repair when it owns .gitattributes, else new candidates, replan or cancel", async () => {
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
    ["repair", "replan", "cancel"],
  );
  // Nothing was committed or kept.
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "refs/factory/test/select"], {
      cwd: target.directory,
    }).status,
    128,
  );
});

test("the plan check refuses a media item whose destinations can't reach Git LFS", async () => {
  // The base routes *.png through LFS, and no rule covers a whole directory.
  const target = checkout();
  const facts = {
    objective: 1,
    body: "",
    blocks: [],
    base: target.commit,
    sources: [],
    authorizedCommands: [],
    ciOnlyCommands: [],
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    localAssetRoots: [],
    lfsRules: [".gitattributes: *.png filter=lfs diff=lfs merge=lfs -text"],
  };
  const lfs = async (...items) =>
    (
      await checkPlan(
        {
          base: target.commit,
          items,
          coverage: [],
          finalCommands: [],
          decisions: [],
        },
        facts,
        new BaseFiles(target.directory, target.commit),
      )
    )
      .filter((finding) => /stored in Git LFS/.test(finding.message))
      .map((finding) => finding.message);

  const [directory] = await lfs(item(["assets/"]));
  assert.match(directory, /routes none of its owned paths through LFS/);
  assert.match(directory, /Add \.gitattributes to its owned paths/);
  const [short] = await lfs(item(["assets/a.png", "src/gallery.ts"]));
  assert.match(short, /routes only assets\/a\.png through LFS/);

  // One routed file per role, ownership of .gitattributes, or depending on
  // the item that owns it each pass.
  assert.deepEqual(await lfs(item(["assets/a.png", "assets/b.png"])), []);
  assert.deepEqual(await lfs(item(["assets/", ".gitattributes"])), []);
  const rules = item([".gitattributes"], {
    id: "rules",
    expectedOutputRoles: [],
  });
  assert.deepEqual(
    await lfs(rules, item(["assets/"], { dependencies: ["rules"] })),
    [],
  );
  // A sibling that owns it is no help: its rule isn't in this item's tree.
  assert.equal((await lfs(rules, item(["assets/"]))).length, 1);
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

test("a refused candidate set is repaired from its staging or receipt, and only cited evidence drops the selection", () => {
  const media = item(["assets/badge/"]);
  const receipt = "Controller candidate receipt: badge";
  // Candidates are staged outside the owned paths (#1922).
  for (const path of [
    ".factory-assets.json",
    ".factory-media/candidate-a/badge.png",
    receipt,
    "assets/badge/a.png",
  ])
    assert.equal(repairPath(media, path), true, path);
  for (const path of ["src/app.ts", "assets/badge/"])
    assert.equal(repairPath(media, path), false, path);
  const code = item(["src"], { expectedOutputRoles: undefined });
  assert.equal(repairPath(code, ".factory-assets.json"), false);
  assert.equal(repairPath(code, receipt), false);

  const set = candidateSet(mkdtempSync(join(tmpdir(), "factory-set-")), [
    "assets/badge/a.png",
  ]);
  const refused = (evidence) => ({
    kind: "review",
    tree: "t",
    refused: [
      {
        source: "model",
        criterion: "c",
        detail: "assets/badge/a.png looks wrong",
        evidence,
      },
    ],
  });
  assert.equal(
    aboutMedia(media, set, refused([{ path: receipt, origin: "controller" }])),
    true,
  );
  assert.equal(
    aboutMedia(
      media,
      set,
      refused([{ path: "patch", file: "assets/badge/a.png", origin: "git" }]),
    ),
    true,
  );
  // Prose that names a destination is not evidence.
  assert.equal(
    aboutMedia(media, set, refused([{ path: "src/app.ts", origin: "git" }])),
    false,
  );
  assert.equal(
    aboutMedia(media, set, {
      kind: "failure",
      detail: "CI failed on assets/badge/a.png",
    }),
    false,
  );
});
