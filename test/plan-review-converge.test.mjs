import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderGraphReviewCall } from "../dist/compiler/model.js";
import { PlanningNeedsDecision } from "../dist/compiler/planning.js";
import {
  compilePlan,
  grantPlanningRevisions,
  PLANNING_REVISION_GRANT,
} from "../dist/compiler/recovery.js";
import {
  GRAPH_REVIEW_FIRST_ROUND,
  GRAPH_REVIEW_REVISION_ROUND,
} from "../dist/compiler/work-item-rubric.js";
import {
  assertRepairLedger,
  consumption,
  resolveAutonomy,
} from "../dist/repair-policy.js";
import { planningRevisionGrantable } from "../dist/state.js";
import { summarizeStatus } from "../dist/status-summary.js";

const BODY =
  "## Outcome\nWrite the two notes.\n\n## Acceptance\n- Both notes exist.\n\n## Sources\n- README.md\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-converge-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Integration");
  git("config", "user.email", "integration@example.invalid");
  writeFileSync(join(root, "README.md"), "# Notes\nKeep two notes.\n");
  git("add", ".");
  git("commit", "-m", "base");
  return { root, baseSha: git("rev-parse", "HEAD") };
}

function item(id, acceptance) {
  return {
    id,
    kind: "work",
    title: `Note ${id}`,
    goal: `Write ${id}.txt`,
    brief: `Write ${id}.txt with one line.`,
    acceptance,
    nonGoals: ["No other files change"],
    dependencies: [],
    ownedPaths: [`${id}.txt`],
    resources: [],
    expectedOutputRoles: [],
    requiredLfsRoles: [],
    sourceAssets: [],
    minimumAssetSets: 0,
    citations: [{ path: "README.md", heading: "Notes" }],
    validation: [],
  };
}

/**
 * A planner that returns `graphs[n]` on its nth compile, and a reviewer that
 * answers `reviews[n]` (fix findings by item id) on its nth review.
 */
function scriptedModel(baseSha, graphs, reviews) {
  const compiles = [];
  const reviewRequests = [];
  return {
    compiles,
    reviewRequests,
    model: {
      approvedPlaybookPin: undefined,
      generateStructured: async (request) => {
        const items = graphs[compiles.length];
        compiles.push(request);
        return {
          objective: 1,
          baseSha,
          items: structuredClone(items),
          coverage: request.coverageObligations.map((obligation) => ({
            ...obligation,
            itemId: items[0].id,
            proof: { kind: "final-review" },
            environment: {
              kind: "local",
              readiness: "available",
              probe: "",
              prerequisites: [],
              preparedBy: "",
            },
          })),
        };
      },
      reviewGraph: async (request) => {
        const findings = reviews[reviewRequests.length] ?? [];
        reviewRequests.push(request);
        const evidence = request.reviewPacket.evidence.findIndex(
          (entry) => entry.path === "README.md",
        );
        return {
          packetId: request.reviewPacket.id,
          findings: findings.map(([itemId, detail]) => ({
            kind: "fix",
            itemIds: [itemId],
            evidenceIndices: [evidence],
            detail,
            question: "",
          })),
        };
      },
    },
  };
}

function plan(checkout, baseSha, model, state) {
  return compilePlan(
    1,
    BODY,
    baseSha,
    checkout,
    model,
    "c".repeat(64),
    undefined,
    undefined,
    { state, save: () => {} },
  );
}

test("revision reviews are scoped, and a revision grant continues the retained draft", async () => {
  const { root, baseSha } = fixture();
  try {
    const first = [
      item("alpha", ["alpha.txt exists"]),
      item("beta", ["beta.txt exists"]),
    ];
    const second = [
      item("alpha", ["alpha.txt exists", "alpha.txt has one line"]),
      first[1],
    ];
    const third = [
      second[0],
      item("beta", ["beta.txt exists", "beta.txt has one line"]),
    ];
    const scripted = scriptedModel(
      baseSha,
      [first, second, third],
      [
        [["alpha", "Name the line alpha.txt must hold."]],
        [["beta", "Name the line beta.txt must hold."]],
        [],
      ],
    );
    const state = {
      kind: "preparing",
      schemaVersion: 18,
      autonomy: resolveAutonomy({ allowances: { planningRevisions: 1 } }),
    };

    // Round 1 fixes alpha; round 2 finds beta and the allowance (1) is used up.
    await assert.rejects(
      plan(root, baseSha, scripted.model, state),
      (error) =>
        error instanceof PlanningNeedsDecision &&
        /allowance is exhausted with 1 plan review fix finding left/.test(
          error.message,
        ),
    );
    const [firstReview, secondReview] = scripted.reviewRequests;
    // The first review is the one full review.
    assert.equal(firstReview.revisionScope, undefined);
    const firstPrompt = renderGraphReviewCall(firstReview).prompt;
    assert.ok(firstPrompt.includes(GRAPH_REVIEW_FIRST_ROUND));
    assert.ok(!firstPrompt.includes(GRAPH_REVIEW_REVISION_ROUND));
    // The revision's review verifies the previous finding and the change.
    assert.deepEqual(secondReview.revisionScope, {
      round: 2,
      previousFindings: [
        {
          kind: "fix",
          itemIds: ["alpha"],
          detail: "Name the line alpha.txt must hold.",
        },
      ],
      changedItemIds: ["alpha"],
      addedItemIds: [],
      removedItemIds: [],
      changedFields: [],
    });
    const secondPrompt = renderGraphReviewCall(secondReview).prompt;
    assert.ok(secondPrompt.includes(GRAPH_REVIEW_REVISION_ROUND));
    assert.ok(secondPrompt.includes("Review scope (round 2)"));
    assert.ok(!secondPrompt.includes(GRAPH_REVIEW_FIRST_ROUND));
    // The scope follows the graph, so the rounds share their cached prefix.
    const prefix = (prompt) => prompt.slice(0, prompt.indexOf("\nBase: "));
    assert.equal(prefix(secondPrompt), prefix(firstPrompt));
    // The scope never enters the packet that the candidate digests.
    assert.equal(
      Object.hasOwn(state.planningRecovery.review, "revisionScope"),
      false,
    );

    const record = state.planningRecovery;
    assert.equal(record.phase, "stopped");
    assert.equal(record.stoppedFor, "revision-allowance");
    assert.equal(record.history.length, 1);
    assert.deepEqual(Object.keys(record.history[0].reviewedGraph.items), [
      "alpha",
      "beta",
    ]);
    assert.ok(planningRevisionGrantable(state));
    assert.throws(
      () => grantPlanningRevisions(state, { actor: "operator", reason: " " }),
      /actor and reason/,
    );

    grantPlanningRevisions(state, {
      actor: "operator",
      reason: "The findings are real and narrow",
    });
    assert.equal(record.phase, "ready");
    assert.equal(record.stoppedFor, undefined);
    assert.deepEqual(
      record.grants.map(({ actor, rounds, round }) => ({
        actor,
        rounds,
        round,
      })),
      [{ actor: "operator", rounds: PLANNING_REVISION_GRANT, round: 1 }],
    );
    assert.equal(planningRevisionGrantable(state), false);
    assert.throws(
      () => grantPlanningRevisions(state, { actor: "operator", reason: "x" }),
      /did not stop at its revision allowance/,
    );

    // The retained round-2 compile and review are reused, not repeated.
    const candidate = await plan(root, baseSha, scripted.model, state);
    assert.equal(candidate.review.status, "clean");
    assert.equal(scripted.compiles.length, 3);
    assert.equal(scripted.reviewRequests.length, 3);
    assert.deepEqual(scripted.reviewRequests[2].revisionScope, {
      round: 3,
      previousFindings: [
        {
          kind: "fix",
          itemIds: ["beta"],
          detail: "Name the line beta.txt must hold.",
        },
      ],
      changedItemIds: ["beta"],
      addedItemIds: [],
      removedItemIds: [],
      changedFields: [],
    });
    assert.equal(consumption(state).planningRevisions, 2);
    // Charges beyond the snapshot are valid only through the recorded grant.
    assertRepairLedger(state);
    const ungranted = structuredClone(state);
    delete ungranted.planningRecovery.grants;
    assert.throws(() => assertRepairLedger(ungranted), /exceed/);
    const forged = structuredClone(state);
    forged.planningRecovery.grants[0].rounds = 0;
    assert.throws(() => assertRepairLedger(forged), /revision grant/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status offers the revision grant beside refusal, with each round's findings", () => {
  const view = {
    objective: 7,
    state: "preparing",
    runActive: false,
    coordinator: { mode: "running", phase: "waiting" },
    planned: false,
    planReview: null,
    planningStopped: true,
    planningQuestion: false,
    planningRevisionGrant: PLANNING_REVISION_GRANT,
    planningStep: {
      call: "graph-review",
      revision: 4,
      rounds: [
        { source: "review", fixes: 1 },
        { source: "review", fixes: 2 },
        { source: "check", fixes: 0 },
        { source: "review", fixes: 3 },
        { source: "review", fixes: 3 },
      ],
      refused: null,
      issues: null,
    },
    cancelledAt: null,
  };
  const summary = summarizeStatus(view);
  assert.equal(summary.phase, "needs-plan-decision");
  assert.match(summary.summary, /fix findings per round: 1, 2, check, 3, 3/);
  assert.equal(
    summary.nextAction.command,
    'factory decide --objective 7 --outcome accept --reason "WHY"',
  );
  assert.match(summary.nextAction.reason, /Grants 2 more plan revisions/);
  assert.match(summary.nextAction.reason, /refuse discards the planning/);
  // Without a grant, a stopped planning still offers only refusal.
  const refusal = summarizeStatus({ ...view, planningRevisionGrant: null });
  assert.match(refusal.nextAction.command, /--outcome refuse/);
});
