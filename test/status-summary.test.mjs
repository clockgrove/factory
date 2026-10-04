import assert from "node:assert/strict";
import test from "node:test";
import {
  preparationStatusDocument,
  statusDocument,
} from "../dist/diagnostics.js";
import { renderStatusText, summarizeStatus } from "../dist/status-summary.js";

const tree = "a".repeat(40);

const item = (id, overrides = {}) => ({
  id,
  status: "pending",
  step: null,
  requestedPhase: null,
  blockedReason: null,
  pullRequest: null,
  acceptancePending: null,
  candidateAssetSets: [],
  lastError: null,
  authentication: null,
  ...overrides,
});

const execution = (work, overrides = {}) => ({
  objective: 7,
  state: "active",
  runActive: true,
  coordinator: { mode: "running", phase: "active" },
  pendingAmendment: null,
  repairs: {},
  finalValidation: false,
  finalAcceptancePending: null,
  objectiveClosure: null,
  lastError: null,
  work,
  ...overrides,
});

const preparing = (overrides = {}) => ({
  objective: 7,
  state: "preparing",
  runActive: true,
  coordinator: { mode: "running", phase: "planning" },
  planReview: null,
  planningStopped: false,
  cancelledAt: null,
  error: null,
  ...overrides,
});

const pending = {
  criterion: "The page renders offline",
  treeSha: tree,
  question: "Does the cached page count as offline?",
  detail: "review finding: README.md#Offline",
};

test("not started points at run", () => {
  assert.deepEqual(summarizeStatus({ objective: 7, state: "not-started" }), {
    phase: "not-started",
    summary: "no Factory run recorded",
    nextAction: {
      command: "factory run --objective 7",
      reason: "Plans the Objective and starts delivery",
    },
  });
});

test("not started shows a wait or outage that no state could hold, and points at run", () => {
  const decision = summarizeStatus({
    objective: 7,
    state: "not-started",
    runActive: false,
    wait: {
      kind: "decision",
      detail: "Predecessor #6 lacks bound accepted candidate evidence",
      step: "objective/prerequisites",
    },
    outage: null,
  });
  assert.equal(decision.phase, "needs-decision");
  assert.match(decision.summary, /Predecessor #6 lacks/);
  assert.equal(decision.nextAction.command, "factory run --objective 7");
  // No state exists, so `factory retry` has nothing to clear.
  assert.doesNotMatch(JSON.stringify(decision), /factory retry/);

  const outage = {
    step: "observe",
    since: "2026-10-03T10:00:00.000Z",
    tries: 4,
    last: "fetch failed",
    escalated: false,
  };
  const down = summarizeStatus({
    objective: 7,
    state: "not-started",
    runActive: false,
    wait: null,
    outage,
  });
  assert.equal(down.phase, "waiting");
  assert.match(down.summary, /on outage for the Objective \(observe\)/);
  assert.equal(down.nextAction.command, "factory run --objective 7");
  // A live run already retries the failing step.
  assert.equal(
    summarizeStatus({
      objective: 7,
      state: "not-started",
      runActive: true,
      wait: null,
      outage,
    }).nextAction,
    null,
  );
});

test("preparation reports planning, a plan decision, pause and failure", () => {
  const planning = summarizeStatus(preparing());
  assert.equal(planning.phase, "planning");
  assert.equal(planning.summary, "compiling and reviewing the plan");
  assert.equal(planning.nextAction, null);
  assert.equal(
    summarizeStatus(preparing({ runActive: false })).nextAction.command,
    "factory run --objective 7",
  );
  assert.equal(
    summarizeStatus(
      preparing({ coordinator: { mode: "running", phase: "projection" } }),
    ).summary,
    "creating Work Item issues from the accepted plan",
  );
  const decision = summarizeStatus(
    preparing({
      planReview: {
        status: "needs-human",
        question: "Split the API item?",
        digest: "0123456789ab",
      },
    }),
  );
  assert.equal(decision.phase, "needs-plan-decision");
  assert.equal(
    decision.nextAction.command,
    'factory decide --objective 7 --outcome accept|refuse --answer "ANSWER" --reason "WHY"',
  );
  // Planning that stopped before producing a plan names the way out.
  const stopped = summarizeStatus(
    preparing({
      planningStopped: true,
      coordinator: {
        mode: "running",
        phase: "waiting",
        waitReason: "Planning stopped for a decision: owner unstated",
      },
    }),
  );
  assert.equal(stopped.phase, "needs-plan-decision");
  assert.equal(
    stopped.nextAction.command,
    'factory decide --objective 7 --outcome refuse --reason "WHY"',
  );
  const paused = summarizeStatus(
    preparing({
      coordinator: { mode: "paused", phase: "planning", waitReason: "held" },
    }),
  );
  assert.equal(paused.phase, "waiting");
  assert.equal(paused.summary, "paused: held");
  assert.equal(paused.nextAction.command, "factory resume --objective 7");
  const failed = summarizeStatus(preparing({ error: "identity changed" }));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.summary, "planning failed: identity changed");
  assert.equal(
    summarizeStatus(preparing({ cancelledAt: "2026-10-03T00:00:00Z" })).phase,
    "cancelled",
  );
});

test("running names active items and needs no action while a run owns it", () => {
  const view = execution([
    item("A", { status: "done" }),
    item("B", { status: "running", step: "execute" }),
    item("C", { blockedReason: "dependency:B" }),
  ]);
  assert.deepEqual(summarizeStatus(view), {
    phase: "running",
    summary: "1/3 done; B (execute)",
    nextAction: null,
  });
  assert.deepEqual(summarizeStatus({ ...view, runActive: false }).nextAction, {
    command: "factory run --objective 7",
    reason: "No run is active; this resumes it",
  });
});

test("waiting says on what: CI check, capacity, dependency", () => {
  const ci = summarizeStatus(
    execution([
      item("A", {
        status: "running",
        step: "deliver",
        pullRequest: 12,
        wait: {
          kind: "ci",
          detail:
            "Awaiting exact published head checks or target protection readiness",
        },
      }),
      item("B", { blockedReason: "dependency:A" }),
    ]),
  );
  assert.equal(ci.phase, "waiting");
  assert.match(ci.summary, /^on CI check for A: Awaiting exact published head/);
  assert.equal(ci.nextAction, null);
  const capacity = summarizeStatus(
    execution([
      item("A", { blockedReason: "capacity" }),
      item("B", { blockedReason: "dependency:A" }),
    ]),
  );
  assert.equal(capacity.phase, "waiting");
  assert.equal(capacity.summary, "on worker capacity for A; 0/2 done");
  const dependency = summarizeStatus(
    execution([item("B", { blockedReason: "resource:X" })]),
  );
  assert.equal(
    dependency.summary,
    "on dependency for B: shares paths with X; 0/1 done",
  );
  const published = summarizeStatus(
    execution([item("A", { status: "published", pullRequest: 4 })]),
  );
  assert.equal(
    published.summary,
    "on CI check for A: PR #4 awaiting checks and merge; 0/1 done",
  );
});

test("decisions name the exact command with real values", () => {
  const criterion = summarizeStatus(
    execution([
      item("A", {
        status: "waiting",
        step: "approve-result",
        acceptancePending: pending,
      }),
    ]),
  );
  assert.equal(criterion.phase, "needs-decision");
  assert.equal(
    criterion.summary,
    `criterion decision for A at tree ${"a".repeat(12)}`,
  );
  assert.equal(
    criterion.nextAction.command,
    'factory decide --objective 7 --item A --outcome accept|refuse --reason "WHY"',
  );
  const asset = summarizeStatus(
    execution([
      item("M", {
        status: "waiting",
        step: "approve-asset",
        candidateAssetSets: ["set-1"],
      }),
    ]),
  );
  assert.equal(asset.summary, "asset selection for M (1 candidate set)");
  assert.equal(
    asset.nextAction.command,
    "factory select --objective 7 --item M --set set-1",
  );
  const final = summarizeStatus(
    execution([item("A", { status: "done" })], {
      state: "waiting",
      finalValidation: true,
      finalAcceptancePending: pending,
    }),
  );
  assert.equal(
    final.nextAction.command,
    'factory decide --objective 7 --outcome accept|refuse --reason "WHY"',
  );
  const repair = summarizeStatus(
    execution([item("A", { status: "failed", lastError: "tests failed" })], {
      repairs: { A: { phase: "stopped", nextDecision: "Narrow the fix" } },
    }),
  );
  assert.equal(repair.summary, "repair decision for A");
  assert.deepEqual(repair.nextAction, {
    command: "factory repair --objective 7 --proposal FILE",
    reason: "Narrow the fix",
  });
  const amendment = summarizeStatus(
    execution([item("A", { status: "running", step: "execute" })], {
      pendingAmendment: { phase: "rejected", error: "coverage gap" },
    }),
  );
  assert.equal(amendment.phase, "needs-decision");
  assert.equal(amendment.nextAction.reason, "coverage gap");
});

test("failures point at retry, logs, authentication or diagnostics", () => {
  const retry = summarizeStatus(
    execution([item("A", { status: "failed", lastError: "tests failed" })], {
      state: "failed",
      lastError: "Work Item A failed",
      runActive: false,
    }),
  );
  assert.deepEqual(retry, {
    phase: "failed",
    summary: "A failed: tests failed",
    nextAction: {
      command: "factory retry --objective 7 --item A",
      reason: "Starts a new attempt; then factory run --objective 7",
    },
  });
  const published = summarizeStatus(
    execution([item("A", { status: "failed", pullRequest: 9 })], {
      state: "failed",
    }),
  );
  // A published item keeps its PR: retry resumes its delivery.
  assert.equal(
    published.nextAction.command,
    "factory retry --objective 7 --item A",
  );
  assert.match(published.nextAction.reason, /^Resumes delivery of PR #9\b/);
  // A published wrong result (a failed check, a conflict) gets a new attempt.
  const wrong = summarizeStatus(
    execution([item("A", { status: "failed", pullRequest: 9 })], {
      state: "failed",
      repairs: {
        A: {
          phase: null,
          failureClass: "implementation",
          failureEvent: "A:await-ci:0",
          nextDecision: null,
        },
      },
    }),
  );
  assert.match(wrong.nextAction.reason, /^Starts a new attempt\b/);
  // A failure blamed on a merged predecessor is not resumed either: the same
  // head would be blamed again, so retry starts a new attempt after the fix.
  const blamed = summarizeStatus(
    execution([item("A", { status: "failed", pullRequest: 9 })], {
      state: "failed",
      repairs: {
        A: {
          phase: "stopped",
          failureClass: "decision",
          failureEvent: null,
          blamedPredecessor: "lib",
          blamedPath: "lib.sh",
          nextDecision: null,
        },
      },
    }),
  );
  // The reason carries the amendment that fixes it, not only the retry.
  assert.match(
    blamed.nextAction.reason,
    /^Only after lib's lib\.sh is fixed: factory propose-amendment --objective 7 --proposal FILE adds a Work Item after lib that owns it; then this retry starts a new attempt on the integrated head$/,
  );
  assert.equal(
    blamed.nextAction.command,
    "factory retry --objective 7 --item A",
  );
  // With no planning revision left, an amendment cannot be taken: cancel.
  const used = summarizeStatus(
    execution([item("A", { status: "failed" })], {
      state: "failed",
      allowanceRemaining: { objective: { planningRevisions: 0 } },
      repairs: {
        A: {
          phase: "stopped",
          failureClass: "decision",
          failureEvent: null,
          blamedPredecessor: "lib",
          blamedPath: "lib.sh",
          nextDecision: null,
        },
      },
    }),
  );
  assert.equal(used.nextAction.command, "factory cancel --objective 7");
  assert.doesNotMatch(used.nextAction.reason, /propose-amendment/);
  // The blame is judged in order: a pending amendment, whether the graph
  // changed since, then the allowance. The amendment that fixes the file takes
  // the last planning revision itself, so zero left must not mean cancel.
  const blame = (digest) => ({
    A: {
      phase: "stopped",
      failureClass: "decision",
      failureEvent: null,
      blamedPredecessor: "lib",
      blamedPath: "lib.sh",
      blamedGraphDigest: digest,
      nextDecision: null,
    },
  });
  const none = { objective: { planningRevisions: 0 } };
  const pendingAmendment = summarizeStatus(
    execution([item("A", { status: "failed" })], {
      state: "failed",
      runActive: false,
      graphDigest: "g1",
      allowanceRemaining: none,
      pendingAmendment: { phase: "ready", error: null },
      repairs: blame("g1"),
    }),
  );
  assert.equal(
    pendingAmendment.nextAction.command,
    "factory run --objective 7",
  );
  assert.match(pendingAmendment.nextAction.reason, /amendment .* is pending/);
  const owned = summarizeStatus(
    execution([item("A", { status: "failed" })], {
      state: "failed",
      runActive: true,
      graphDigest: "g1",
      allowanceRemaining: none,
      pendingAmendment: { phase: "reviewed", error: null },
      repairs: blame("g1"),
    }),
  );
  assert.equal(owned.nextAction, null);
  assert.match(owned.summary, /amendment .* is pending/);
  const rejected = summarizeStatus(
    execution([item("A", { status: "failed" })], {
      state: "failed",
      graphDigest: "g1",
      allowanceRemaining: none,
      pendingAmendment: { phase: "rejected", error: "bad graph" },
      repairs: blame("g1"),
    }),
  );
  assert.match(rejected.nextAction.command, /^factory propose-amendment /);
  const landed = summarizeStatus(
    execution(
      [item("A", { status: "failed" }), item("fix", { status: "done" })],
      {
        state: "failed",
        runActive: false,
        graphDigest: "g2",
        allowanceRemaining: none,
        repairs: blame("g1"),
      },
    ),
  );
  assert.equal(
    landed.nextAction.command,
    "factory retry --objective 7 --item A",
  );
  // The fix is not merged yet: it merges first. Items waiting on A do not count.
  const unmerged = summarizeStatus(
    execution(
      [
        item("A", { status: "failed" }),
        item("fix", { status: "pending" }),
        item("after", { status: "pending", blockedReason: "dependency:A" }),
        item("later", { status: "pending", blockedReason: "dependency:after" }),
      ],
      {
        state: "failed",
        runActive: false,
        graphDigest: "g2",
        allowanceRemaining: none,
        repairs: blame("g1"),
      },
    ),
  );
  assert.equal(unmerged.nextAction.command, "factory run --objective 7");
  const waitingOnly = summarizeStatus(
    execution(
      [
        item("A", { status: "failed" }),
        item("fix", { status: "done" }),
        item("after", { status: "pending", blockedReason: "dependency:A" }),
        item("later", { status: "pending", blockedReason: "dependency:after" }),
      ],
      {
        state: "failed",
        runActive: false,
        graphDigest: "g2",
        allowanceRemaining: none,
        repairs: blame("g1"),
      },
    ),
  );
  assert.equal(
    waitingOnly.nextAction.command,
    "factory retry --objective 7 --item A",
  );
  const authentication = summarizeStatus(
    execution([
      item("A", {
        status: "failed",
        authentication: { provider: "codex", command: "codex login" },
      }),
    ]),
  );
  assert.equal(authentication.phase, "waiting");
  assert.equal(
    authentication.summary,
    "on external prerequisite: codex authentication for A",
  );
  assert.equal(authentication.nextAction.command, "codex login");
  const objectiveFailure = summarizeStatus(
    execution([item("A", { status: "done" })], {
      state: "failed",
      lastError: "final validation failed",
    }),
  );
  assert.equal(objectiveFailure.summary, "final validation failed");
  // A stop outside any Work Item names the command that runs it again.
  assert.equal(
    objectiveFailure.nextAction.command,
    "factory retry --objective 7",
  );
  // A failed item waits for running work to settle before retry is offered.
  const settling = summarizeStatus(
    execution([
      item("A", { status: "failed" }),
      item("B", { status: "running", step: "validate" }),
    ]),
  );
  assert.equal(settling.phase, "running");
  assert.equal(settling.nextAction, null);
});

test("terminal, paused, cancellation and finalization states", () => {
  assert.equal(
    summarizeStatus(execution([], { state: "cancelled" })).phase,
    "cancelled",
  );
  assert.deepEqual(summarizeStatus(execution([], { state: "complete" })), {
    phase: "complete",
    summary: "final validation passed; Objective closed",
    nextAction: null,
  });
  const paused = summarizeStatus(
    execution([item("A", { status: "running", step: "execute" })], {
      coordinator: { mode: "paused", phase: "waiting" },
      runActive: false,
    }),
  );
  assert.equal(paused.phase, "waiting");
  assert.deepEqual(paused.nextAction, {
    command: "factory resume --objective 7",
    reason: "Resumes the Objective; then factory run --objective 7",
  });
  const cancelling = summarizeStatus(
    execution([], {
      coordinator: { mode: "running", phase: "waiting", cancelError: "pid 4" },
    }),
  );
  assert.equal(cancelling.phase, "needs-decision");
  assert.equal(cancelling.nextAction.command, "factory cancel --objective 7");
  assert.equal(
    summarizeStatus(execution([item("A", { status: "done" })])).summary,
    "1/1 done; final validation and review",
  );
  const closing = summarizeStatus(
    execution([item("A", { status: "done" })], { finalValidation: true }),
  );
  assert.equal(closing.phase, "running");
  assert.equal(closing.summary, "1/1 done; closing the Objective on GitHub");
});

test("text leads with the phase line, the next command, then the item table", () => {
  const view = execution([
    item("A", { status: "done", pullRequest: 11 }),
    item("B", {
      status: "waiting",
      step: "approve-result",
      pullRequest: 12,
      acceptancePending: pending,
    }),
    item("C", { blockedReason: "dependency:B" }),
  ]);
  const lines = renderStatusText({ ...view, ...summarizeStatus(view) });
  assert.equal(
    lines[0],
    `Objective #7: needs decision — criterion decision for B at tree ${"a".repeat(12)}`,
  );
  assert.match(lines[1], /^Next: factory decide --objective 7 --item B /);
  assert.equal(lines[2], "      Answer the question below");
  assert.deepEqual(lines.slice(4, 8), [
    "  ITEM  STATUS                    PR   REASON",
    "  A     done                      #11",
    "  B     waiting (approve-result)  #12  criterion decision",
    "  C     pending                   -    waits for B",
  ]);
  assert.ok(lines.includes(`  Question: ${pending.question}`));
  assert.ok(lines.includes(`  Evidence: ${pending.detail}`));
  const running = execution([
    item("A", { status: "running", step: "execute" }),
  ]);
  const quiet = renderStatusText({ ...running, ...summarizeStatus(running) });
  assert.equal(quiet[0], "Objective #7: running — 0/1 done; A (execute)");
  assert.equal(quiet[1], "");
});

test("status documents carry the same phase, summary and next action", () => {
  const empty = statusDocument(undefined, "example/repo", 7, "regular");
  assert.equal(empty.phase, "not-started");
  assert.equal(empty.nextAction.command, "factory run --objective 7");
  const prepared = preparationStatusDocument(
    {
      schemaVersion: 8,
      kind: "preparing",
      repository: "example/repo",
      objective: 7,
      runId: "run",
      configDigest: "b".repeat(64),
      baseSha: "c".repeat(40),
      objectiveBodyDigest: "d".repeat(64),
      issueByItemId: {},
      plan: {
        reviewDigest: "e".repeat(64),
        review: {
          status: "needs-human",
          revisions: 1,
          findings: [{ question: "Keep secret-value?" }],
        },
      },
      coordinator: {
        mode: "running",
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
      },
    },
    ["secret-value"],
    false,
  );
  assert.equal(prepared.phase, "needs-plan-decision");
  assert.equal(prepared.planReview.question, "Keep [REDACTED]?");
  assert.equal(prepared.planReview.digest, "e".repeat(12));
  assert.doesNotMatch(prepared.nextAction.command, /--plan/);
  const text = renderStatusText(prepared);
  assert.equal(
    text[0],
    "Objective #7: needs plan decision — plan review needs a human decision",
  );
  assert.ok(text.includes("Question: Keep [REDACTED]?"));
});
