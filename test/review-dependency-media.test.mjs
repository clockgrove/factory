// An item's result review gets its delivered dependencies' candidate
// receipts, so it has digest-checked copies of the media they selected. In
// 0.5.9 qualification (run 2026-10-28T190035PDT-aa02, Codex) the plan split
// the cube's assets and their test into two items; the test item's tree held
// the selected preview only as a Git LFS pointer, its review had no copy of
// the bytes, and its reviewer held asking the operator "Can you provide the
// hydrated preview image bytes or a digest-checked review copy".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidateReceipts } from "../dist/media.js";
import { itemInstructions, reviewResult } from "../dist/review/item.js";
import { reviewCandidates } from "../dist/work/step-review.js";
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

function workItem(id, acceptance, ownedPaths, dependencies = []) {
  return {
    kind: "work",
    id,
    title: `Item ${id}`,
    goal: "Deliver the change.",
    acceptance,
    nonGoals: ["Nothing else."],
    citations: [],
    dependencies,
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Deliver the change.",
    priority: 1,
  };
}

const ASSETS = workItem(
  "cube-assets",
  ["Offer two candidate sets in different colours; deliver the selected one."],
  ["assets/cubeQazja.glb", "assets/cubeQazja-preview.png"],
);
const TEST_ITEM = workItem(
  "cube-asset-test",
  [
    "The new test verifies `assets/cubeQazja-preview.png` is a 64x64 PNG containing non-background cube image content.",
  ],
  ["test/cube-assets.test.js"],
  ["cube-assets"],
);

/** The two staged candidate sets of `cube-assets`, with their bytes on disk. */
function stagedSets() {
  const staged = tempDir("factory-dep-media-staged-");
  const member = (set, role, destination, mediaType, content) => {
    const bytes = Buffer.from(content);
    const directory = join(staged, `${set}-${role}`);
    mkdirSync(directory);
    const file = join(directory, destination.split("/").pop());
    writeFileSync(file, bytes);
    return {
      role,
      destination,
      mediaType,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file,
    };
  };
  const set = (id, colour) => ({
    id,
    provenance: {
      source: "generated",
      rights: "owned",
      visibility: "private",
      lineage: "test",
    },
    members: [
      member(
        id,
        "model",
        "assets/cubeQazja.glb",
        "model/gltf-binary",
        `glTF ${colour}`,
      ),
      member(
        id,
        "preview-image",
        "assets/cubeQazja-preview.png",
        "image/png",
        `PNG ${colour}`,
      ),
    ],
  });
  return [set("candidate-c", "red"), set("candidate-d", "blue")];
}

function selected(sets, commitSha, tree) {
  return {
    commit: commitSha,
    tree,
    set: sets[0],
    bound: [],
    by: "kirk",
    at: "2026-10-29T02:05:40.480Z",
  };
}

test("an item's review candidates are its own selection, then each dependency's in the reviewed base", () => {
  const sets = stagedSets();
  const other = workItem("other-media", ["Another set."], ["assets/other.png"]);
  const state = {
    done: {
      "item:cube-assets:work": { sets },
      "item:cube-assets:select": selected(sets, "c1", "t1"),
      "item:other-media:work": { sets },
      "item:other-media:select": selected(sets, "c2", "t2"),
    },
  };
  const items = [ASSETS, TEST_ITEM, other];
  const records = reviewCandidates(state, items, TEST_ITEM, [
    { id: "cube-assets", title: "", status: "merged", inReviewedBase: true },
    {
      id: "other-media",
      title: "",
      status: "published-unmerged",
      inReviewedBase: false,
    },
  ]);
  assert.deepEqual(
    records.map((record) => [
      record.item.id,
      record.selection.set.id,
      record.dependency,
    ]),
    [["cube-assets", "candidate-c", true]],
  );
  // The selecting item's own review: its record alone, not a dependency's.
  assert.deepEqual(
    reviewCandidates(state, items, ASSETS, []).map((record) => [
      record.item.id,
      record.dependency,
    ]),
    [["cube-assets", undefined]],
  );
  // An item with no media and no delivered media dependency: none.
  assert.deepEqual(reviewCandidates(state, items, TEST_ITEM, []), []);
});

test("a dependent test item's review holds the dependency's selected preview bytes, and a question about them goes back to the reviewer", async () => {
  const checkout = tempDir("factory-dep-media-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, ".gitattributes"),
    "*.glb filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n",
  );
  commit(checkout, "init");
  // cube-assets merged: the selected set's pointers are on the base.
  const sets = stagedSets();
  mkdirSync(join(checkout, "assets"));
  for (const member of sets[0].members)
    writeFileSync(
      join(checkout, member.destination),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${member.sha256}\nsize ${member.bytes}\n`,
    );
  const base = commit(checkout, "cube-assets");
  const baseTree = git(checkout, "rev-parse", `${base}^{tree}`);
  mkdirSync(join(checkout, "test"));
  writeFileSync(
    join(checkout, "test/cube-assets.test.js"),
    'import { readFileSync } from "node:fs";\nreadFileSync("assets/cubeQazja-preview.png");\n',
  );
  const head = commit(checkout, "cube-asset-test");
  const tree = git(checkout, "rev-parse", `${head}^{tree}`);
  const state = {
    done: {
      "item:cube-assets:work": { sets },
      "item:cube-assets:select": selected(sets, base, baseTree),
    },
  };
  const candidates = reviewCandidates(state, [ASSETS, TEST_ITEM], TEST_ITEM, [
    { id: "cube-assets", title: "", status: "merged", inReviewedBase: true },
  ]);
  const preview = "media-sets/cube-assets/candidate-c/cubeQazja-preview.png";
  const calls = [];
  const events = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      // The preview's bytes are in the evidence root beside its pointer.
      assert.equal(
        readFileSync(join(call.readDir, preview), "utf8"),
        "PNG red",
      );
      // The dependency's unselected alternative stays out of this review.
      assert.equal(
        existsSync(join(call.readDir, "media-sets/cube-assets/candidate-d")),
        false,
      );
      assert.ok(!call.prompt.includes("candidate-d"));
      assert.match(
        readFileSync(
          join(call.readDir, "candidate/assets/cubeQazja-preview.png"),
          "utf8",
        ),
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/,
      );
      if (calls.length === 1)
        return {
          value: {
            findings: [
              {
                criterionIndex: 0,
                verdict: "question",
                evidenceIndices: [1],
                detail:
                  "The supplied preview is an LFS pointer (candidate/assets/cubeQazja-preview.png), not the PNG bytes.",
                question:
                  "Can you provide the hydrated preview image bytes so the asserted mask can be compared to the actual preview?",
              },
            ],
          },
        };
      return {
        value: {
          findings: [
            {
              criterionIndex: 0,
              verdict: "pass",
              evidenceIndices: [1],
              detail: "The test checks the preview's bytes.",
            },
          ],
        },
      };
    },
  };
  const outcome = await reviewResult({
    planner,
    plan: {
      base,
      items: [ASSETS, TEST_ITEM],
      coverage: [],
      finalCommands: [],
      decisions: [],
    },
    item: TEST_ITEM,
    checkout,
    base,
    commit: head,
    validation: { tree, commands: ["npm test"] },
    sources: [],
    dir: tempDir("factory-dep-media-root-"),
    ...NO_WORKSPACE,
    candidates,
    signal: AbortSignal.timeout(60_000),
    log: (event) => events.push(event),
  });
  assert.ok(
    calls[0].prompt.includes("Controller candidate receipt: cube-assets"),
  );
  // The receipt says whose it is; the guidance how to judge from it.
  assert.ok(calls[0].prompt.includes("deliveredDependency"));
  assert.ok(
    calls[0].prompt.includes(
      itemInstructions(
        {
          unreachable: false,
          artifacts: false,
          candidates: true,
          inputs: false,
          knowledge: false,
          memory: false,
        },
        NO_WORKSPACE.limits,
      )
        .split("\n")
        .at(-1),
    ),
  );
  // The question went back once, naming the review copy, and never held.
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.slice(calls[0].prompt.length).includes(preview));
  assert.ok(
    events.some((event) => event.event === "result-review-evidence-sendback"),
  );
  assert.equal(outcome.kind, "pass");
});

test("a dependency's receipt copies only its selected set, and selected members are copied before any alternative spends the bound", async () => {
  const MIB = 1024 * 1024;
  const sets = stagedSets();
  // The reviewed item's own 64 one-MiB alternatives come before its
  // selected set and would spend the whole 64 MiB bound on their own.
  const staged = tempDir("factory-dep-media-big-");
  const big = Buffer.alloc(MIB, 7);
  writeFileSync(join(staged, "alt.png"), big);
  const altMember = {
    role: "preview-image",
    destination: "assets/own.png",
    mediaType: "image/png",
    bytes: MIB,
    sha256: createHash("sha256").update(big).digest("hex"),
    file: join(staged, "alt.png"),
  };
  const ownSet = (id, member) => ({ ...sets[0], id, members: [member] });
  const alternatives = Array.from({ length: 64 }, (_, n) =>
    ownSet(`alt-${String(n).padStart(2, "0")}`, altMember),
  );
  const chosenOwn = ownSet("chosen", {
    ...sets[0].members[1],
    destination: "assets/own.png",
  });
  const own = workItem("own-media", ["Offer sets."], ["assets/own.png"]);
  const root = tempDir("factory-dep-media-receipts-");
  const receipts = await candidateReceipts(root, [
    {
      item: own,
      sets: [...alternatives, chosenOwn],
      selection: { ...selected(sets, "c0", "t0"), set: chosenOwn },
    },
    {
      item: ASSETS,
      sets,
      selection: selected(sets, "c1", "t1"),
      dependency: true,
    },
  ]);
  const [ownReceipt, depReceipt] = receipts.map((r) => JSON.parse(r.content));
  // The own item's selected member has its copy despite the alternatives.
  const ownChosen = ownReceipt.sets.find((set) => set.id === "chosen");
  assert.equal(
    ownChosen.members[0].reviewCopy,
    "media-sets/own-media/chosen/cubeQazja-preview.png",
  );
  assert.equal(ownReceipt.capturedSets, 65);
  assert.equal(ownReceipt.deliveredDependency, undefined);
  // The dependency: its selected set alone, both members copied.
  assert.equal(depReceipt.capturedSets, 2);
  assert.match(depReceipt.deliveredDependency, /only its selected set/);
  assert.deepEqual(
    depReceipt.sets.map((set) => [set.id, set.selected]),
    [["candidate-c", true]],
  );
  for (const member of depReceipt.sets[0].members) {
    assert.ok(
      member.reviewCopy?.startsWith("media-sets/cube-assets/candidate-c/"),
    );
    assert.equal(existsSync(join(root, member.reviewCopy)), true);
  }
  assert.equal(
    existsSync(join(root, "media-sets/cube-assets/candidate-d")),
    false,
  );
  // The alternatives share what is left of the bound, in order.
  const copiedAlternatives = ownReceipt.sets.filter(
    (set) => set.id !== "chosen" && set.members[0].reviewCopy !== null,
  );
  assert.ok(copiedAlternatives.length < 64);
  assert.equal(ownReceipt.sets.at(-2).members[0].reviewCopy, null);
});
