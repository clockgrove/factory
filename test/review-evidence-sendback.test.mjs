// A needs-human question about what the evidence root holds goes back to
// the reviewer once before it reaches the operator (#2124). In 0.5.4
// qualification a low-effort Codex reviewer asked the operator what
// `sharedQwfwq("ab")` returns when a conflict repair had kept main's
// src/sharedQwfwq.js (so the change index listed only the test; run
// 2026-10-27T085451PDT-1503), and for the selected GLB's and preview's
// bytes that media-sets/ held as digest-checked copies (run
// 2026-10-27T094535PDT-9729).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewResult } from "../dist/review/item.js";
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

function workItem(id, acceptance, ownedPaths) {
  return {
    kind: "work",
    id,
    title: `Item ${id}`,
    goal: "Deliver the change with a test.",
    acceptance,
    nonGoals: ["Nothing else."],
    citations: [],
    dependencies: [],
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Deliver the change.",
    priority: 1,
  };
}

/**
 * The shared-main case: main already holds src/sharedQwfwq.js, and the
 * candidate adds only its test, so the change index omits the source.
 */
function sharedMain() {
  const checkout = tempDir("factory-sendback-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  mkdirSync(join(checkout, "src"));
  writeFileSync(
    join(checkout, "src/sharedQwfwq.js"),
    "export function sharedQwfwq(s) {\n  return s + s;\n}\n",
  );
  writeFileSync(join(checkout, "README.md"), "# Shared\n");
  const base = commit(checkout, "main's shared helper");
  mkdirSync(join(checkout, "test"));
  writeFileSync(
    join(checkout, "test/sharedQwfwq.test.js"),
    'import assert from "node:assert";\nimport { sharedQwfwq } from "../src/sharedQwfwq.js";\nassert.equal(sharedQwfwq("ab"), "abab");\n',
  );
  const head = commit(checkout, "test");
  return {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", `${head}^{tree}`),
  };
}

function review(repo, item, planner, extra = {}) {
  const events = [];
  return {
    events,
    run: reviewResult({
      planner,
      plan: {
        base: repo.base,
        items: [item],
        coverage: [],
        finalCommands: [],
        decisions: [],
      },
      item,
      checkout: repo.checkout,
      base: repo.base,
      commit: repo.head,
      validation: { tree: repo.tree, commands: ["npm test"] },
      sources: [],
      dir: tempDir("factory-sendback-root-"),
      ...NO_WORKSPACE,
      signal: AbortSignal.timeout(60_000),
      log: (event) => events.push(event),
      ...extra,
    }),
  };
}

/** A complete controller row's index: the change index, after the design row. */
const CHANGE_INDEX_ROW = 1;

function finding(criterionIndex, verdict, question = "") {
  return {
    criterionIndex,
    verdict,
    evidenceIndices: [CHANGE_INDEX_ROW],
    detail: `${verdict} detail`,
    question,
  };
}

/**
 * A planner answering each criterion's own finder call (review/item.ts):
 * `answer(index, n, call)` is criterion `index`'s finding, in the item's
 * numbering, on its `n`th call, or none. `asked(index)` is its calls.
 */
function perCriterion(item, answer) {
  const calls = [];
  const judged = (call) =>
    item.acceptance.indexOf(
      JSON.parse(
        call.prompt.split("\n").find((line) => line.startsWith('{"criteria"')),
      ).criteria[0].criterion,
    );
  return {
    calls,
    asked: (index) => calls.filter((call) => judged(call) === index),
    async answer(call) {
      const index = judged(call);
      const n = calls.filter((each) => judged(each) === index).length;
      calls.push(call);
      const found = await answer(index, n, call);
      return {
        value: { findings: found ? [{ ...found, criterionIndex: 0 }] : [] },
      };
    },
  };
}

test("a question about an unchanged source file the evidence root holds goes back to the reviewer, naming the file, and its pass stands", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    ['`sharedQwfwq("ab")` returns `"abab"`.', "The test runs under npm test."],
    ["test/sharedQwfwq.test.js"],
  );
  const planner = perCriterion(item, (index, n, call) => {
    if (index === 1) return finding(1, "pass");
    if (n === 0)
      return finding(
        0,
        "needs-human",
        'Can you provide current-tree source evidence showing what `sharedQwfwq("ab")` returns?',
      );
    // The send-back names the unchanged source, which the root holds.
    assert.ok(existsSync(join(call.readDir, "candidate/src/sharedQwfwq.js")));
    return finding(0, "pass");
  });
  const { run, events } = review(repo, item, planner);
  const outcome = await run;
  const [first, second] = planner.asked(0);
  assert.equal(planner.asked(0).length, 2);
  assert.equal(planner.asked(1).length, 1);
  const note = second.prompt.slice(first.prompt.length);
  assert.match(note, /^\n\nEvidence check: /);
  assert.ok(note.includes("candidate/src/sharedQwfwq.js"));
  assert.ok(note.includes("candidate/test/sharedQwfwq.test.js"));
  assert.ok(note.includes("Give one finding for each of criteria 0,"));
  // One paragraph: a continuing conversation sends it as the delta.
  assert.ok(!note.trim().includes("\n\n"));
  assert.ok(!note.includes("README.md"));
  assert.equal(outcome.kind, "pass");
  assert.deepEqual(
    outcome.verdicts.map((verdict) => verdict.criterionIndex).sort(),
    [0, 1],
  );
  assert.deepEqual(
    events.find((event) => event.event === "result-review-evidence-sendback"),
    {
      event: "result-review-evidence-sendback",
      criteria: [0],
      paths: 2,
    },
  );
});

test("a question still asked after the send-back reaches the operator, once", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    ['`sharedQwfwq("ab")` returns `"abab"`.'],
    ["test/sharedQwfwq.test.js"],
  );
  let calls = 0;
  const planner = {
    async answer() {
      calls += 1;
      return {
        value: {
          findings: [
            finding(
              0,
              "needs-human",
              calls === 1
                ? "What does `sharedQwfwq` return?"
                : "Is doubling the intended product behaviour for empty input?",
            ),
          ],
        },
      };
    },
  };
  const outcome = await review(repo, item, planner).run;
  assert.equal(calls, 2);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(
    outcome.questions.map((question) => question.question),
    ["Is doubling the intended product behaviour for empty input?"],
  );
});

test("an invalid answer to the send-back keeps the reviewer's question for the operator", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    ['`sharedQwfwq("ab")` returns `"abab"`.'],
    ["test/sharedQwfwq.test.js"],
  );
  let calls = 0;
  const planner = {
    async answer() {
      calls += 1;
      return calls === 1
        ? {
            value: {
              findings: [
                finding(0, "needs-human", "What does src/sharedQwfwq.js do?"),
              ],
            },
          }
        : { value: { verdict: "pass" } };
    },
  };
  const outcome = await review(repo, item, planner).run;
  assert.equal(calls, 2);
  assert.equal(outcome.kind, "needs-human");
  assert.equal(
    outcome.questions[0].question,
    "What does src/sharedQwfwq.js do?",
  );
});

test("a question that names nothing the evidence root holds reaches the operator with no send-back", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    ["Doubling matches what the product owner wants."],
    ["test/sharedQwfwq.test.js"],
  );
  let calls = 0;
  const planner = {
    async answer() {
      calls += 1;
      return {
        value: {
          findings: [
            finding(
              0,
              "needs-human",
              "Has the product owner approved doubling, per docs/decisions/doubling.md?",
            ),
          ],
        },
      };
    },
  };
  const { run, events } = review(repo, item, planner);
  const outcome = await run;
  assert.equal(calls, 1);
  assert.equal(outcome.kind, "needs-human");
  assert.ok(
    !events.some((event) => event.event === "result-review-evidence-sendback"),
  );
});

test("a question about a selected media member's bytes goes back naming its digest-checked review copy, and says the selection settles appearance", async () => {
  const checkout = tempDir("factory-sendback-media-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, ".gitattributes"),
    "*.glb filter=lfs diff=lfs merge=lfs -text\n",
  );
  const base = commit(checkout, "base");
  const bytes = Buffer.from("glTF cube bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(checkout, "assets"));
  writeFileSync(
    join(checkout, "assets/cubeQgwqx.glb"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${bytes.length}\n`,
  );
  const head = commit(checkout, "cube");
  const repo = {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", `${head}^{tree}`),
  };
  const staged = tempDir("factory-sendback-staged-");
  const file = join(staged, "model-cube.glb");
  writeFileSync(file, bytes);
  const set = {
    id: "a",
    provenance: {
      source: "generated",
      rights: "owned",
      visibility: "private",
      lineage: "test",
    },
    members: [
      {
        role: "model",
        destination: "assets/cubeQgwqx.glb",
        mediaType: "model/gltf-binary",
        bytes: bytes.length,
        sha256,
        file,
      },
    ],
  };
  const item = workItem(
    "cube_assets",
    [
      "The selected `assets/cubeQgwqx.glb` is a valid glTF 2.0 binary containing exactly one mesh.",
    ],
    ["assets/cubeQgwqx.glb"],
  );
  const calls = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      return {
        value: {
          findings: [
            calls.length === 1
              ? finding(
                  0,
                  "needs-human",
                  "Can the selected GLB's hydrated bytes or a digest-checked review copy be made available?",
                )
              : finding(0, "pass"),
          ],
        },
      };
    },
  };
  const outcome = await review(repo, item, planner, {
    candidates: [
      {
        item,
        sets: [set],
        selection: {
          commit: head,
          tree: repo.tree,
          set,
          bound: [],
          by: "kirk",
          at: "2026-10-27T16:50:00.000Z",
        },
      },
    ],
  }).run;
  assert.equal(calls.length, 2);
  const note = calls[1].prompt.slice(calls[0].prompt.length);
  assert.ok(note.includes("media-sets/cube_assets/a/model-cube.glb"));
  assert.ok(note.includes("candidate/assets/cubeQgwqx.glb"));
  assert.ok(
    note.includes(
      "the selection is the human judgment of their appearance: never ask the operator to confirm it again",
    ),
  );
  assert.equal(outcome.kind, "pass");
});

test("the send-back keeps the file a question names by its path when more than 12 files share its stem", async () => {
  const checkout = tempDir("factory-sendback-stems-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  const names = [
    ...["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"],
    ...["hotel", "india", "juliet", "kilo", "lima", "mike", "zeta"],
  ];
  for (const name of names) {
    mkdirSync(join(checkout, `packages/${name}/src`), { recursive: true });
    writeFileSync(
      join(checkout, `packages/${name}/src/index.ts`),
      `export const ${name} = 0;\n`,
    );
  }
  const base = commit(checkout, "packages");
  writeFileSync(
    join(checkout, "packages/zeta/src/index.ts"),
    "export const zeta = 1;\n",
  );
  const head = commit(checkout, "zeta");
  const repo = {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", `${head}^{tree}`),
  };
  const item = workItem(
    "Zeta",
    ["`packages/zeta/src/index.ts` exports `zeta` equal to 1."],
    ["packages/zeta/src/index.ts"],
  );
  const calls = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      return {
        value: {
          findings: [
            calls.length === 1
              ? finding(
                  0,
                  "needs-human",
                  "What does packages/zeta/src/index.ts export?",
                )
              : finding(0, "pass"),
          ],
        },
      };
    },
  };
  const outcome = await review(repo, item, planner).run;
  assert.equal(calls.length, 2);
  const note = calls[1].prompt.slice(calls[0].prompt.length);
  assert.ok(
    note.includes('"candidate/packages/zeta/src/index.ts"'),
    "exact path missing from send-back",
  );
  // The directory and file names inside a backticked path are not stems.
  assert.ok(!note.includes("packages/alpha/src/index.ts"));
  assert.equal(outcome.kind, "pass");
});

test("the send-back keeps the file a question names by its exact path when more than 12 files end with that path", async () => {
  const checkout = tempDir("factory-sendback-suffix-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  const names = [
    ...["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"],
    ...["hotel", "india", "juliet", "kilo", "lima", "mike", "november"],
  ];
  for (const name of names) {
    mkdirSync(join(checkout, `packages/${name}/src`), { recursive: true });
    writeFileSync(
      join(checkout, `packages/${name}/src/index.ts`),
      `export const ${name} = 0;\n`,
    );
  }
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "src/index.ts"), "export const root = 0;\n");
  const base = commit(checkout, "packages");
  writeFileSync(join(checkout, "src/index.ts"), "export const root = 1;\n");
  const head = commit(checkout, "root");
  const repo = {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", `${head}^{tree}`),
  };
  const item = workItem(
    "Root",
    ["The root module exports root equal to 1."],
    ["src/index.ts"],
  );
  const calls = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      return {
        value: {
          findings: [
            calls.length === 1
              ? finding(0, "needs-human", "What does src/index.ts export?")
              : finding(0, "pass"),
          ],
        },
      };
    },
  };
  const outcome = await review(repo, item, planner).run;
  assert.equal(calls.length, 2);
  const note = calls[1].prompt.slice(calls[0].prompt.length);
  assert.ok(
    note.includes('"candidate/src/index.ts"'),
    "exact path missing from send-back",
  );
  assert.equal(outcome.kind, "pass");
});

test("one criterion's question goes back while another's, naming nothing held, reaches the operator", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    [
      '`sharedQwfwq("ab")` returns `"abab"`.',
      "Product approves the release wording.",
    ],
    ["test/sharedQwfwq.test.js"],
  );
  const planner = perCriterion(item, (index, n) =>
    index === 1
      ? finding(1, "needs-human", "Has product approved the wording?")
      : n === 0
        ? finding(0, "needs-human", "What does `sharedQwfwq` return?")
        : finding(0, "pass"),
  );
  const { run, events } = review(repo, item, planner);
  const outcome = await run;
  assert.equal(planner.asked(0).length, 2);
  assert.equal(planner.asked(1).length, 1);
  assert.deepEqual(
    events
      .filter((event) => event.event === "result-review-evidence-sendback")
      .map((event) => event.criteria),
    [[0]],
  );
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(
    outcome.questions.map((question) => [
      question.criterionIndex,
      question.question,
    ]),
    [[1, "Has product approved the wording?"]],
  );
  assert.deepEqual(
    outcome.verdicts.map((verdict) => verdict.criterionIndex),
    [0],
  );
});

test("a criterion's refusal beside another's sent-back question is a suspicion to prove", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    [
      '`sharedQwfwq("ab")` returns `"abab"`.',
      "The test file covers the empty string.",
    ],
    ["test/sharedQwfwq.test.js"],
  );
  const planner = perCriterion(item, (index, n) =>
    index === 1
      ? finding(1, "refuse", "The test never calls it with ''.")
      : n === 0
        ? finding(0, "needs-human", "What does `sharedQwfwq` return?")
        : finding(0, "pass"),
  );
  // Find only: the refusal is a suspicion no proof confirms.
  const { run, events } = review(repo, item, planner, {
    limits: { ...NO_WORKSPACE.limits, proofs: 0 },
  });
  const outcome = await run;
  assert.equal(planner.calls.length, 3);
  assert.equal(
    events.find(
      (event) =>
        event.event === "result-review-find" && event.criterionIndex === 1,
    )?.outcome,
    "refused",
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === "result-review-suspicion")
      .map(({ criterionIndex, outcome }) => [criterionIndex, outcome]),
    [[1, "unproved"]],
  );
  assert.equal(outcome.kind, "pass");
});

test("a question an earlier review of the same tree asked, which the operator is answering, is not sent back again", async () => {
  const repo = sharedMain();
  const item = workItem(
    "SharedQwfwq",
    ['`sharedQwfwq("ab")` returns `"abab"`.', "The test runs under npm test."],
    ["test/sharedQwfwq.test.js"],
  );
  const question = {
    criterionIndex: 0,
    criterion: item.acceptance[0],
    detail: "earlier",
    question: "What does `sharedQwfwq` return?",
  };
  const planner = perCriterion(item, (index) => finding(index, "pass"));
  const outcome = await review(repo, item, planner, {
    earlier: {
      kind: "needs-human",
      tree: repo.tree,
      questions: [question],
      verdicts: [],
    },
  }).run;
  // Criterion 0 stays the earlier question; only criterion 1 was judged.
  assert.deepEqual(
    planner.calls.map((call) => planner.asked(1).includes(call)),
    [true],
  );
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(outcome.questions, [question]);
});

/**
 * Two captured candidate sets with the same model and different previews,
 * set `a` selected and committed as LFS pointers (run
 * 2026-10-27T142211PDT-8f9f). `bigPreview` makes set `b`'s preview larger
 * than a review copy may be, so the evidence root holds none of it.
 */
function twoColourSets({ bigPreview = false } = {}) {
  const checkout = tempDir("factory-sendback-sets-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, ".gitattributes"),
    "*.glb filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n",
  );
  const base = commit(checkout, "base");
  const staged = tempDir("factory-sendback-sets-staged-");
  const member = (set, role, destination, mediaType, content) => {
    const bytes = Buffer.from(content);
    const file = join(staged, `${set}-${role}`);
    mkdirSync(file);
    const path = join(file, destination.split("/").pop());
    writeFileSync(path, bytes);
    return {
      role,
      destination,
      mediaType,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file: path,
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
      member(id, "model", "assets/cubeQdjpn.glb", "model/gltf-binary", "glTF"),
      member(
        id,
        "preview-image",
        "assets/cubeQdjpn-preview.png",
        "image/png",
        `PNG ${colour}`,
      ),
    ],
  });
  const sets = [
    set("a", "red"),
    set("b", bigPreview ? `blue${" ".repeat(1024 * 1024)}` : "blue"),
  ];
  mkdirSync(join(checkout, "assets"));
  for (const selected of sets[0].members)
    writeFileSync(
      join(checkout, selected.destination),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${selected.sha256}\nsize ${selected.bytes}\n`,
    );
  const head = commit(checkout, "cube");
  const tree = git(checkout, "rev-parse", `${head}^{tree}`);
  const item = workItem(
    "CubeAssets",
    [
      "Two complete candidate sets in different colours are offered, and only the selected set is delivered.",
    ],
    ["assets/cubeQdjpn.glb", "assets/cubeQdjpn-preview.png"],
  );
  return {
    repo: { checkout, base, head, tree },
    item,
    candidates: [
      {
        item,
        sets,
        selection: {
          commit: head,
          tree,
          set: sets[0],
          bound: [],
          by: "kirk",
          at: "2026-10-27T21:30:12.289Z",
        },
      },
    ],
  };
}

/** The index of the evidence row whose path starts with `prefix`, from the prompt. */
function rowIndex(prompt, prefix) {
  for (const paragraph of prompt.split("\n\n")) {
    if (!paragraph.startsWith('{"evidenceIndex"')) continue;
    const row = JSON.parse(paragraph);
    if (row.path.startsWith(prefix)) return row.evidenceIndex;
  }
  assert.fail(`no evidence row ${prefix}`);
}

/** The reviewer's question of run 2026-10-27T142211PDT-8f9f, citing `indices`. */
function colourQuestion(indices) {
  return {
    criterionIndex: 0,
    verdict: "needs-human",
    evidenceIndices: indices,
    detail:
      "The controller receipt establishes two complete captured sets, but says only the preview-image bytes differ; both sets have identical model bytes. The alternative's colour cannot be inferred from the receipt's digest or size.",
    question:
      "Do the two offered candidate sets visibly use different cube colours?",
  };
}

test("a question citing the candidate receipt, naming no file, goes back with every set's review copies", async () => {
  const { repo, item, candidates } = twoColourSets();
  const calls = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      const receipt = rowIndex(call.prompt, "Controller candidate receipt:");
      if (calls.length === 1)
        return { value: { findings: [colourQuestion([receipt])] } };
      for (const set of ["a", "b"])
        assert.ok(
          existsSync(
            join(
              call.readDir,
              `media-sets/CubeAssets/${set}/cubeQdjpn-preview.png`,
            ),
          ),
        );
      return {
        value: {
          findings: [
            {
              criterionIndex: 0,
              verdict: "pass",
              evidenceIndices: [receipt],
              detail: "The two previews differ: red and blue.",
              question: "",
            },
          ],
        },
      };
    },
  };
  const { run, events } = review(repo, item, planner, { candidates });
  const outcome = await run;
  assert.equal(calls.length, 2);
  const note = calls[1].prompt.slice(calls[0].prompt.length);
  for (const set of ["a", "b"]) {
    assert.ok(note.includes(`media-sets/CubeAssets/${set}/cubeQdjpn.glb`));
    assert.ok(
      note.includes(`media-sets/CubeAssets/${set}/cubeQdjpn-preview.png`),
    );
  }
  assert.ok(
    note.includes(
      "the selection is the human judgment of their appearance: never ask the operator to confirm it again",
    ),
  );
  assert.deepEqual(
    events.find((event) => event.event === "result-review-evidence-sendback"),
    { event: "result-review-evidence-sendback", criteria: [0], paths: 4 },
  );
  assert.equal(outcome.kind, "pass");
});

test("a cited receipt adds only the copies the evidence root holds, after the files the text names", async () => {
  const { repo, item, candidates } = twoColourSets({ bigPreview: true });
  const calls = [];
  const planner = {
    async answer(call) {
      calls.push(call);
      const receipt = rowIndex(call.prompt, "Controller candidate receipt:");
      if (calls.length === 1)
        return {
          value: {
            findings: [
              {
                ...colourQuestion([receipt]),
                detail: `${colourQuestion([]).detail} candidate/.gitattributes routes both destinations through Git LFS.`,
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
              evidenceIndices: [receipt],
              detail: "Set a's preview is red; set b's differs by its digest.",
              question: "",
            },
          ],
        },
      };
    },
  };
  const { run, events } = review(repo, item, planner, { candidates });
  const outcome = await run;
  assert.equal(calls.length, 2);
  const note = calls[1].prompt.slice(calls[0].prompt.length);
  assert.match(note, /questions name or cite files the evidence root holds/);
  assert.ok(
    note.includes(
      `the evidence root holds ${[
        "candidate/.gitattributes",
        "media-sets/CubeAssets/a/cubeQdjpn.glb",
        "media-sets/CubeAssets/a/cubeQdjpn-preview.png",
        "media-sets/CubeAssets/b/cubeQdjpn.glb",
      ]
        .map((path) => JSON.stringify(path))
        .join(", ")}\n`,
    ),
    note,
  );
  assert.ok(!note.includes("media-sets/CubeAssets/b/cubeQdjpn-preview.png"));
  assert.deepEqual(
    events.find((event) => event.event === "result-review-evidence-sendback"),
    { event: "result-review-evidence-sendback", criteria: [0], paths: 4 },
  );
  assert.equal(outcome.kind, "pass");
});

test("a question citing the candidate receipt that is still asked after the send-back reaches the operator, once", async () => {
  const { repo, item, candidates } = twoColourSets();
  let calls = 0;
  const planner = {
    async answer(call) {
      calls += 1;
      const receipt = rowIndex(call.prompt, "Controller candidate receipt:");
      return { value: { findings: [colourQuestion([receipt])] } };
    },
  };
  const outcome = await review(repo, item, planner, { candidates }).run;
  assert.equal(calls, 2);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(
    outcome.questions.map((question) => question.question),
    ["Do the two offered candidate sets visibly use different cube colours?"],
  );
});

test("the same question citing no receipt still reaches the operator with no send-back", async () => {
  const { repo, item, candidates } = twoColourSets();
  let calls = 0;
  const planner = {
    async answer() {
      calls += 1;
      return { value: { findings: [colourQuestion([CHANGE_INDEX_ROW])] } };
    },
  };
  const { run, events } = review(repo, item, planner, { candidates });
  const outcome = await run;
  assert.equal(calls, 1);
  assert.equal(outcome.kind, "needs-human");
  assert.ok(
    !events.some((event) => event.event === "result-review-evidence-sendback"),
  );
});
