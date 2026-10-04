import { consumption } from "../dist/repair-policy.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  paidPlanningModel,
  planReviewPacket,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { step } from "../dist/step.js";
import { decodeGraphReview } from "../dist/review-evidence.js";
import { createTarget } from "./support/integration-fixture.mjs";
import { compilePlan } from "./support/plan.mjs";

const Ajv = createRequire(import.meta.url)("ajv");
const body =
  "# Continuation\n\n## Acceptance\n- result.txt exists\n\n## Validation\n- `test -s result.txt`\n";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function autonomy(limit = 1) {
  return {
    allowances: {
      planningRevisions: limit,
      implementationRepairs: 0,
      resultRereviews: 0,
    },
    repairClasses: ["planning-output"],
    repairPolicy: {
      perPath: {
        planningRevisions: limit,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
    },
    requiredEnvironment: [],
  };
}

async function fixture(
  t,
  {
    rejected = false,
    limit = 1,
    pauseBeforeReview = false,
    malformed = false,
    executionBounds,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "factory-retained-plan-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  const file = join(root, "preparation.json");
  const emitted = [];
  let reviews = 0;
  let paused = false;
  let retained;
  const state = { autonomy: autonomy(limit) };
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        const source = choices.sources.find(
          (entry) => entry.path === "OBJECTIVE",
        );
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [],
          items: [
            {
              kind: "work",
              id: "result",
              title: "Produce result",
              goal: "Create result.txt",
              brief: reviews
                ? "Preserve the source-defined complete criterion."
                : "Create result.",
              acceptance: ["result.txt exists"],
              nonGoals: ["No deployment"],
              citations: [
                {
                  choiceIndex: choices.citations.find(
                    (entry) => entry.path === "OBJECTIVE" && !entry.heading,
                  ).choiceIndex,
                },
              ],
              children: [],
              dependencies: [],
              ownedPaths: ["result.txt"],
              priority: 0,
              resources: [],
              validation: [
                {
                  kind: "source-line",
                  sourceIndex: source.sourceIndex,
                  lineIndex: source.lines.find(
                    (line) => line.text === "- `test -s result.txt`",
                  ).lineIndex,
                },
              ],
              sourceAssets: [],
              expectedOutputRoles: [],
              minimumAssetSets: 0,
              requiredLfsRoles: [],
              coverage: [
                {
                  obligationIndex: 0,
                  proof: { kind: "final-review" },
                  environment: {
                    kind: "local",
                    readiness: "available",
                    probeValidationIndex: null,
                    preparedBy: "",
                  },
                },
              ],
            },
          ],
        };
      } else if (options.outputSchema.properties.packetId) {
        reviews++;
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings:
            (rejected || malformed) && reviews === 1
              ? [
                  {
                    evidenceIndices: [malformed ? 999 : 0],
                    detail:
                      "The generated task does not retain the complete result criterion.",
                    question:
                      "Will the corrected task retain the source-defined criterion?",
                  },
                ]
              : [],
        };
      } else {
        assert(rejected);
        const resolved = decodeGraphReview(
          retained.planningRecovery.review.response,
          retained.planningRecovery.review.packet,
        );
        assert(prompt.includes(JSON.stringify(resolved)));
        assert(!prompt.includes("could not be validated"));
        response = {
          kind: "planning-output",
          diagnosis: "Retain the source criterion in task prose.",
          correction:
            "Preserve the complete result criterion without changing its source.",
        };
      }
      assert.equal(
        new Ajv({ strict: false }).compile(options.outputSchema)(response),
        !(
          malformed &&
          reviews === 1 &&
          options.outputSchema.properties.packetId
        ),
      );
      const raw = JSON.stringify(response);
      emitted.push({ prompt, schema: options.outputSchema, raw });
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: { id: "fixture", type: "agent_message", text: raw },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  function save() {
    writeFileSync(file, JSON.stringify(state));
    if (
      !retained &&
      state.planningRecovery.review &&
      (pauseBeforeReview ||
        state.planningRecovery.review.response !== undefined)
    ) {
      retained = JSON.parse(readFileSync(file, "utf8"));
      paused = true;
    }
  }
  const args = [
    1,
    body,
    target.baseSha,
    target.checkout,
    model,
    "fixture-config",
    undefined,
    undefined,
  ];
  // A malformed review is planned as the run does: inside the plan step,
  // whose paid bound alone decides how often it is asked again.
  let planned;
  if (malformed)
    planned = await step(
      state,
      { scope: "objective", name: "plan", paid: true },
      (context) =>
        compilePlan(
          ...args.slice(0, 4),
          paidPlanningModel(model, context),
          ...args.slice(5),
          { state, save, stopped: () => paused },
          undefined,
          undefined,
          executionBounds,
        ),
      { save, clock: { now: () => 0, sleep: async () => {} } },
    );
  else {
    const initial = compilePlan(
      ...args,
      { state, save, stopped: () => paused },
      undefined,
      undefined,
      executionBounds,
    );
    // With a planning allowance a finding stops before the paused diagnosis.
    if (pauseBeforeReview || (rejected && limit))
      await assert.rejects(initial, /paused or cancelled/);
    else await initial;
  }
  return {
    planned,
    target,
    state,
    retained,
    model,
    emitted,
    args,
    get reviews() {
      return reviews;
    },
  };
}

test("completed clean review survives persisted pause and repeated completion with exact packet and no calls or correction charge", async (t) => {
  const f = await fixture(t, { limit: 0 });
  const state = JSON.parse(JSON.stringify(f.retained));
  const original = structuredClone(state.planningRecovery.review);
  const before = f.emitted.length;
  const candidate = await compilePlan(...f.args, { state, save() {} });
  assert.equal(candidate.review.status, "clean");
  assert.equal(f.emitted.length, before);
  assert.deepEqual(state.planningRecovery.review, original);
  assert.equal(consumption(state).planningRevisions, 0);
  verifyPlanCandidate(
    candidate,
    1,
    body,
    f.target.baseSha,
    f.target.checkout,
    "fixture-config",
  );
  assert.deepEqual(
    await compilePlan(...f.args, { state, save() {} }),
    candidate,
  );
  assert.equal(f.emitted.length, before);
});

test("known rejected review keeps exact resolved identities across pause and one evidenced correction", async (t) => {
  const f = await fixture(t, { rejected: true });
  const state = JSON.parse(JSON.stringify(f.retained));
  const original = structuredClone(state.planningRecovery.review);
  const resolved = decodeGraphReview(original.response, original.packet);
  const candidate = await compilePlan(...f.args, { state, save() {} });
  assert.equal(candidate.review.status, "clean");
  assert.equal(consumption(state).planningRevisions, 1);
  assert.equal(state.planningRecovery.history.length, 1);
  assert.deepEqual(state.planningRecovery.history[0].review, original);
  assert.deepEqual(
    JSON.parse(state.planningRecovery.history[0].detail).findings,
    resolved,
  );
  assert.notEqual(state.planningRecovery.review.packet.id, original.packet.id);
  assert.equal(f.reviews, 2);
  assert.equal(f.emitted.length, 5);
});

test("pause after packet retention and before submission reuses that packet for the first actual review", async (t) => {
  const f = await fixture(t, { pauseBeforeReview: true });
  const state = structuredClone(f.retained);
  assert.equal(f.reviews, 0);
  assert.equal(state.planningRecovery.review.response, undefined);
  const packet = structuredClone(state.planningRecovery.review.packet);
  const candidate = await compilePlan(...f.args, { state, save() {} });
  assert.equal(candidate.review.status, "clean");
  assert.deepEqual(state.planningRecovery.review.packet, packet);
  assert.equal(f.reviews, 1);
  assert.equal(state.planningRecovery.review.response.packetId, packet.id);
  assert.equal(consumption(state).planningRevisions, 0);
});

test("changed reviewed context, damaged request and old missing binding refuse before calls or consumption", async (t) => {
  const f = await fixture(t);
  for (const variant of [
    "config",
    "source",
    "graph",
    "invalid-graph",
    "local-facts",
    "packet",
    "old-format",
  ]) {
    const state = structuredClone(f.retained);
    const args = [...f.args];
    if (variant === "config") args[5] = "changed-config";
    if (variant === "source")
      args[1] = body + "\nAdditional pinned source prose.\n";
    if (variant === "graph")
      state.planningRecovery.response.items[0].brief = "Changed reviewed task";
    if (variant === "invalid-graph")
      state.planningRecovery.response.items[0].dependencies = ["result"];
    if (variant === "packet")
      state.planningRecovery.review.packet.evidence[0].id = "changed";
    if (variant === "old-format") {
      state.planningRecovery.reviewResponse =
        state.planningRecovery.review.response;
      delete state.planningRecovery.review;
    }
    const before = JSON.stringify(state);
    const calls = f.emitted.length;
    await assert.rejects(
      compilePlan(
        ...args,
        { state, save() {} },
        undefined,
        variant === "local-facts"
          ? {
              provenance: "controller-local-validation-executable-preflight",
              baseSha: f.target.baseSha,
              finalCommands: [],
              observations: [],
            }
          : undefined,
      ),
      /review (context changed|evidence changed|lacks its original request binding|compiled input cannot be validated)/,
    );
    assert.equal(JSON.stringify(state), before);
    assert.equal(f.emitted.length, calls);
  }
});

test("a malformed review is asked again by the plan step, keeps its receipts and is never charged", async (t) => {
  const f = await fixture(t, { malformed: true, limit: 0 });
  assert.equal(f.planned.review.status, "clean");
  assert.equal(f.state.planningRecovery.phase, "complete");
  // The compile was asked once; the review twice, the first answer invalid.
  assert.equal(f.emitted.length, 3);
  const phases = f.state.planningRecovery.invocations.map(
    (entry) => entry.phase,
  );
  assert.deepEqual(phases, ["compile", "graph-review", "graph-review"]);
  assert.equal(consumption(f.state).planningRevisions, 0);
  // The step's repeat record ends with the step.
  assert.equal(f.state.repeats, undefined);
});

test("a review that stays malformed is the plan step's decision, not a second counter", async (t) => {
  const f = await fixture(t, { limit: 0 });
  const state = { autonomy: f.state.autonomy };
  let asked = 0;
  const malformedModel = {
    generateStructured: (request) => f.model.generateStructured(request),
    reviewGraph: async () => {
      asked++;
      return { packetId: "wrong", findings: [] };
    },
  };
  await assert.rejects(
    step(
      state,
      { scope: "objective", name: "plan", paid: true },
      (context) =>
        compilePlan(
          ...f.args.slice(0, 4),
          paidPlanningModel(malformedModel, context),
          ...f.args.slice(5),
          { state, save() {} },
        ),
      { save() {}, clock: { now: () => 0, sleep: async () => {} } },
    ),
    /plan failed 4 times with an unknown outcome/,
  );
  // Every ask is a paid fault of the step, so its bound of three repeats is
  // the only one: four asks, not the three of a second counter.
  assert.equal(asked, 4);
  assert.equal(consumption(state).planningRevisions, 0);
});

test("an interrupted review is reissued, or its retained response reused", async (t) => {
  const f = await fixture(t);
  for (const responsePresent of [false, true]) {
    const state = structuredClone(f.retained);
    state.planningRecovery.phase = "submitted";
    if (!responsePresent) delete state.planningRecovery.review.response;
    const calls = f.emitted.length;
    const candidate = await compilePlan(...f.args, { state, save() {} });
    assert.equal(candidate.review.status, "clean");
    assert.equal(state.planningRecovery.phase, "complete");
    // Reviews have no side effects: a lost one is simply asked again.
    if (responsePresent) assert.equal(f.emitted.length, calls);
    else assert.ok(f.emitted.length > calls);
  }
});

test("exhausted allowance and repeated failures keep real findings for a human decision without diagnosis calls", async (t) => {
  const f = await fixture(t, { rejected: true, limit: 0 });
  for (const repeated of [false, true]) {
    const state = structuredClone(f.retained);
    const findings = decodeGraphReview(
      state.planningRecovery.review.response,
      state.planningRecovery.review.packet,
    );
    if (repeated)
      state.planningRecovery.history.push({
        failure: hash(JSON.stringify({ findings })),
        detail: JSON.stringify({ findings }),
        invocations: [],
        kind: "planning-output",
        diagnosis: "Known same failure",
        correction: "Unchanged correction",
      });
    const calls = f.emitted.length;
    // Both keep the reviewed plan for a human decision.
    const candidate = await compilePlan(...f.args, { state, save() {} });
    assert.equal(candidate.review.status, "needs-human");
    assert.deepEqual(candidate.review.findings, findings);
    assert.deepEqual(state.plan, candidate);
    assert.equal(state.planningRecovery.phase, "stopped");
    assert.equal(f.emitted.length, calls);
    assert.equal(consumption(state).planningRevisions, 0);
    assert.deepEqual(
      decodeGraphReview(
        state.planningRecovery.review.response,
        state.planningRecovery.review.packet,
      ),
      findings,
    );
  }
});

test("retained clean review binds actual execution ceilings across unchanged and changed continuation", async (t) => {
  const executionBounds = {
    configuredConcurrency: 1,
  };
  const f = await fixture(t, { limit: 0, executionBounds });
  const state = structuredClone(f.state);
  assert.equal(state.planningRecovery.phase, "complete");
  const original = JSON.stringify(state);
  const evidence = state.planningRecovery.review.packet.evidence.find(
    (entry) => entry.path === "FACTORY_EXECUTION_BOUNDS",
  );
  assert.equal(evidence.origin, "controller");
  assert.deepEqual(JSON.parse(evidence.content), executionBounds);
  const before = f.emitted.length;
  let saves = 0;
  const candidate = await compilePlan(
    ...f.args,
    {
      state,
      save() {
        saves++;
      },
    },
    undefined,
    undefined,
    executionBounds,
  );
  assert.deepEqual(candidate.executionBounds, executionBounds);
  assert.equal(f.emitted.length, before);
  assert.equal(saves, 0);
  assert.equal(JSON.stringify(state), original);
  await assert.rejects(
    compilePlan(
      ...f.args,
      {
        state,
        save() {
          saves++;
        },
      },
      undefined,
      undefined,
      { configuredConcurrency: 2 },
    ),
    /review (context changed|evidence changed)/,
  );
  assert.equal(f.emitted.length, before);
  assert.equal(saves, 0);
  assert.equal(JSON.stringify(state), original);
});
