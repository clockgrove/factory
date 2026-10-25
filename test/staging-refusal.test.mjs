// A refused handoff manifest goes back to the worker as its correction:
// the diagnosis can only name owned paths and never sees the manifest, so
// it asked a person (the crash lane's ChainBase item held on "note 8 …
// consumerIndices"). The same refusal again still goes to the diagnosis.
import assert from "node:assert/strict";
import { test } from "node:test";
import { correction } from "../dist/repair.js";

const refused = {
  kind: "failure",
  staging: "handoff",
  detail:
    "Handoff manifest is invalid:\n- note 8: consumerIndices must be [] (this Work Item has no peers)",
};

function input(prior, asked, finding = refused) {
  return {
    planner: new Proxy(
      {},
      {
        get: () => () => {
          asked.push(true);
          throw new Error("diagnosis called");
        },
      },
    ),
    plan: { items: [] },
    item: { id: "ChainBase", ownedPaths: ["src/chainBase.js"], acceptance: [] },
    finding,
    checkout: "/nonexistent",
    base: "0".repeat(40),
    commit: "1".repeat(40),
    sources: [],
    prior,
    signal: new AbortController().signal,
    log() {},
  };
}

test("a refused handoff manifest is the correction, and the same refusal again is diagnosed", async () => {
  const asked = [];
  const first = await correction(input([], asked));
  assert.equal(first.kind, "correction", JSON.stringify(first));
  assert.equal(first.correction.source, "staging-refusal");
  assert.match(first.correction.correction, /note 8: consumerIndices/);
  assert.equal(asked.length, 0);
  const again = await correction(input([first.correction], asked)).catch(
    (error) => ({ kind: "error", error }),
  );
  assert.notEqual(again.correction?.source, "staging-refusal");
});

// The media case: a repair after a refused handoff captured again and found
// the staged sets gone; the diagnosis can't see staging and asked a person.
test("a capture refusal of the candidate sets is the correction: stage them again and finish the item", async () => {
  const asked = [];
  const result = await correction(
    input([], asked, {
      kind: "failure",
      staging: "candidates",
      detail:
        "Candidate sets refused: .factory-media/candidate-a/cube.glb does not exist.",
    }),
  );
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(result.correction.source, "staging-refusal");
  assert.match(result.correction.correction, /stage every candidate set again/);
  assert.match(result.correction.correction, /owned files and tests/);
  // The destinations are owned too, but Factory writes the selected set
  // there: a worker told only to finish its owned files wrote them.
  assert.match(
    result.correction.correction,
    /Leave each candidate destination as it is/,
  );
  assert.equal(asked.length, 0);
});

// The media case: the operator's `repair` at selection went to the
// diagnosis, which can't see the candidates and asked a person for them.
test("the operator's repair at selection is the correction, quoting their text, every time", async () => {
  const asked = [];
  const sentBack = {
    kind: "failure",
    detail:
      "The operator asked for new candidates: Make both candidate sets again, with different colours.",
    newCandidates: {
      text: "Make both candidate sets again, with different colours.",
    },
  };
  const first = await correction(input([], asked, sentBack));
  assert.equal(first.kind, "correction", JSON.stringify(first));
  assert.equal(first.correction.source, "selection");
  assert.match(first.correction.correction, /with different colours/);
  const again = await correction(input([first.correction], asked, sentBack));
  assert.equal(again.kind, "correction", JSON.stringify(again));
  assert.equal(asked.length, 0);
});
