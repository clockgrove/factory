// The integration suite's media case answers a person's judgment of the
// binary assets (the model and the preview) by the suite operator's fixture
// decisions. Live (Codex, main media.select-repair, run
// 2026-10-27T134216PDT-aabc), the item's result review, which judges a
// perceptual quality of candidate media, asked about criterion 2 ("Can you
// confirm whether the selected candidate-a preview visibly depicts a
// cube?"), after its evidence send-back. The case's decisions named only
// final-review, so the hold stood unanswered and the case gave up. A Work
// Item's review numbers the plan's criteria, not the Objective's, so its
// decisions name the criterion by its text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { criterionOffers, REFUSES_ITEM } from "../dist/work/step-review.js";

const SUITE = join(import.meta.dirname, "..", "integration");
const DECISIONS = readFileSync(
  join(SUITE, "fixtures", "media-review-decisions.json"),
  "utf8",
);
const REASON = JSON.parse(DECISIONS)[0].text;

const MODEL =
  "The delivered assets/cubeQname.glb is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.";
const PREVIEW =
  "The delivered assets/cubeQname-preview.png is a 64x64 PNG preview of the cube.";
const LFS =
  "The delivered GLB and PNG destinations are routed through Git LFS.";
const TEST = "A new test checks the delivered model and preview files.";
const TEST_CUBE =
  "A new test verifies that the delivered model is a valid glTF 2.0 binary containing exactly one mesh representing a unit cube centred at the origin, and the preview is a 64x64 PNG preview.";
const COLOURS =
  "Two complete candidate sets in different colours are offered, and only the selected set is delivered.";

/** A needs-human review asking about `asked` (criterion texts by index). */
function needsHuman(asked, criteria = [MODEL, PREVIEW, LFS, TEST]) {
  return {
    kind: "needs-human",
    tree: "78fa7726f1f7d11dd384206e8d71132920536401",
    questions: asked.map((criterionIndex) => ({
      criterionIndex,
      criterion: criteria[criterionIndex],
      detail: "The available inspection here does not establish it.",
      question: "Can you confirm it?",
    })),
    verdicts: [],
  };
}

/** The suite's auto-answers for one open review hold at `step`. */
function autoAnswers(step, review, keptKey) {
  const root = mkdtempSync(join(tmpdir(), "factory-review-decisions-"));
  mkdirSync(join(root, "objectives"));
  const id = `${step}@2026-10-27T20:49:37.547Z`;
  writeFileSync(
    join(root, "objectives", "8.json"),
    JSON.stringify({
      issue: 8,
      status: "holding",
      holds: [
        {
          id,
          step,
          cause: "question",
          question: "The reviewer needs your judgment on this result.",
          options: [
            ...criterionOffers(review, REFUSES_ITEM),
            {
              answer: "cancel",
              family: "cancel",
              consequence: "Cancels the Objective.",
            },
          ],
        },
      ],
      kept: { [keptKey]: review },
    }),
  );
  const run = spawnSync(
    "python3",
    [
      join(SUITE, "lib", "st.py"),
      root,
      "auto-answers",
      "8",
      "d2 review decide more",
      DECISIONS,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the media case's operator accepts the preview criterion at the item's result review", () => {
  const step = "item:cube-assets:review";
  assert.deepEqual(
    autoAnswers(step, needsHuman([1]), "item:cube-assets:held"),
    [
      {
        id: `${step}@2026-10-27T20:49:37.547Z`,
        step,
        answer: "accept",
        arg: "2",
        text: REASON,
      },
    ],
  );
  // The model criterion too, wherever the plan numbers it.
  const [choice] = autoAnswers(
    "item:CubeAssets:review",
    needsHuman([3], [LFS, TEST, COLOURS, MODEL]),
    "item:CubeAssets:held",
  );
  assert.equal(choice.answer, "accept");
  assert.equal(choice.arg, "4");
});

// Live (Codex, main media, run 2026-10-28T191001PDT-2b02, #2193), the plan
// named the delivered assets "the selected": the reviewer asked about
// criterion 2, purely perceptual, and the fixture refused it for the word
// alone, so the hold stood. "Selected" naming the asset is no claim about
// the selection; criterion 4, about the new test, stays with a person.
test("the media case's operator accepts a perceptual criterion that names the selected asset", () => {
  const criteria = [
    "The delivered model and preview destinations are routed through Git LFS, as reported by `git check-attr filter -- assets/cubeQiczx.glb assets/cubeQiczx-preview.png`.",
    "The selected `assets/cubeQiczx-preview.png` is a 64x64 PNG preview depicting the cube.",
    "The selected `assets/cubeQiczx.glb` is a valid glTF 2.0 binary containing exactly one mesh that is a unit cube centred at the origin.",
    "A new automated test verifies the delivered model and preview meet the specified format, geometry and image-size requirements.",
  ];
  const answers = (asked) =>
    autoAnswers(
      "item:cube-assets-test:review",
      needsHuman(asked, criteria),
      "item:cube-assets-test:held",
    ).map((choice) => [choice.answer, choice.arg]);
  assert.deepEqual(answers([1, 3]), [["accept", "2"]]);
  assert.deepEqual(answers([2]), [["accept", "3"]]);
});

test("the media case's operator decides nothing else at a Work Item's review", () => {
  // LFS, the new test (even one naming the cube and the preview) and the
  // alternatives are the case's own checks: their questions stay with a
  // person, so the case reports the hold.
  // So are the same checks in other words: the pick, LFS spelled out, the
  // item's validation, a test in another tense.
  const criteria = [
    MODEL,
    PREVIEW,
    LFS,
    TEST,
    TEST_CUBE,
    COLOURS,
    "Only the picked colour's unit cube model and PNG preview are delivered.",
    "The chosen unit cube model and its PNG preview are the only assets delivered.",
    "The unit cube model and its PNG preview are stored in Git Large File Storage.",
    "The repository's .gitattributes routes the unit cube model and its PNG preview.",
    "The item's validation confirms the delivered model is a unit cube and the preview a 64x64 PNG preview.",
    "The delivered unit cube model and PNG preview are tested when CI runs.",
    // The selection itself, however the asset is named.
    "Only the selected unit cube model and PNG preview are delivered.",
    "The selected unit cube model and PNG preview are the only assets delivered.",
    "The operator's selection of the unit cube model and PNG preview is delivered.",
    "Factory selects the unit cube model and PNG preview to deliver.",
  ];
  for (let index = 2; index < criteria.length; index++) {
    assert.deepEqual(
      autoAnswers(
        "item:cube-assets:review",
        needsHuman([index], criteria),
        "item:cube-assets:held",
      ),
      [],
      `criterion ${index + 1}: ${criteria[index]}`,
    );
  }
  // Without the kept review there is no criterion text to match.
  assert.deepEqual(
    autoAnswers("item:cube-assets:review", needsHuman([1]), "unrelated"),
    [],
  );
});

test("final review's decisions still name the Objective's criteria by number", () => {
  const objective = [
    "`assets/cubeQname.glb` is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.",
    "`assets/cubeQname-preview.png` is a 64x64 PNG preview of the cube.",
    "Both are stored in Git LFS.",
    "`npm test` passes.",
  ];
  const answers = (asked) =>
    autoAnswers(
      "final-review",
      needsHuman(asked, objective),
      "final-review:held",
    ).map((choice) => choice.arg);
  assert.deepEqual(answers([0]), ["1"]);
  assert.deepEqual(answers([1]), ["2"]);
  assert.deepEqual(answers([2]), []);
  assert.deepEqual(answers([3]), []);
});
