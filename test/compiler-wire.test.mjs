import { consumption } from "../dist/repair-policy.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { compilerWire, PlannerChoiceError } from "../dist/compiler-wire.js";
import {
  CodexPlanningModel,
  MalformedPlannerOutput,
  PlanValidationError,
  PlanningNeedsDecision,
  compilerCitationChoices,
  compileObjective,
  hydrateWorkerInputSources,
  objectiveCriteria,
  verifyPlanCandidate,
  planReviewPacket,
  planningReviewEvidence,
  validateGraph,
  validateGraphSources,
} from "../dist/compiler.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../dist/controller-capabilities.js";
import {
  aggregateAcceptance,
  assertCoverageShape,
  assertCoverageSources,
  assertCompletedCoverage,
  coverageObligations,
} from "../dist/qa.js";
import { decodeGraphReview, reviewPacket } from "../dist/review-evidence.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";
import { compilePlan, planningDiagnosis } from "./support/plan.mjs";
import { packetFromPrompt } from "./support/review-protocol.mjs";
const Ajv = createRequire(import.meta.url)("ajv");
const body =
  '# Objective\n\n## Acceptance\n- Source-defined result exists.\n\n## Validation\n- `test -d .`\n\n## Worker implementation\nUse node:assert/strict and assert process.versions.node.split(".")[0] equals "24".\n';
const sources = [{ path: "OBJECTIVE", content: body }];
// Workflow jobs are the only CI check names a plan may use.
const ciWorkflow = {
  ".github/workflows/ci.yml":
    "name: CI\non: pull_request\njobs:\n  required-check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
};
function request(extra = {}) {
  return {
    objective: body,
    compileContext: { objectiveNumber: 17, instructions: "" },
    baseSha: "a".repeat(40),
    sources,
    coverageObligations: coverageObligations(body, objectiveCriteria(body)),
    checkNames: ["required-check", "quality"],
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    ...extra,
  };
}
function item(overrides = {}) {
  return {
    kind: "work",
    id: "implementation",
    title: "Implement",
    goal: "Create result",
    brief: "Implement the selected source.",
    acceptance: ["Source-defined result exists."],
    nonGoals: ["No deployment"],
    citations: [{ choiceIndex: 0 }],
    children: [],
    dependencies: [],
    ownedPaths: ["result.txt"],
    newPackages: [],
    priority: 0,
    resources: [],
    validation: [{ kind: "source-line", sourceIndex: 0, lineIndex: 6 }],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    coverage: [],
    ...overrides,
  };
}
function entry(proof = { kind: "final-review" }) {
  return {
    obligationIndex: 0,
    proof,
    environment: {
      kind: "local",
      readiness: "available",
      probeValidationIndex: null,
      preparedBy: "",
    },
  };
}
function setup(extra = {}) {
  const input = request(extra);
  const wire = compilerWire(input, compilerCitationChoices(input.sources));
  const value = {
    contextId: wire.data.contextId,
    requiredPreIntegrationChecks: [],
    items: [item({ coverage: [entry()] })],
  };
  return {
    input,
    wire,
    value,
    conforms: new Ajv({ strict: false, allErrors: true }).compile(wire.schema),
  };
}

test("QA choices require source-owned coverage while work and aggregates may leave coverage to QA", () => {
  const objective =
    "# Objective\n\n## Acceptance\n- result.txt exists.\n\n## Validation\n- `test -f result.txt`\n";
  const pinnedSources = [{ path: "OBJECTIVE", content: objective }];
  const obligations = coverageObligations(
    objective,
    objectiveCriteria(objective),
  );
  const { wire, value, conforms } = setup({
    objective,
    sources: pinnedSources,
    coverageObligations: obligations,
  });
  const implementation = item({ acceptance: ["result.txt exists."] });
  const qa = item({
    kind: "qa",
    id: "verify-result",
    title: "Verify the integrated result",
    goal: "Check the source-required file against the integrated candidate.",
    acceptance: ["result.txt exists."],
    dependencies: [implementation.id],
    coverage: [entry({ kind: "integrated-command", validationIndex: 0 })],
  });
  const parent = item({
    kind: "aggregate",
    id: "accepted-result",
    children: [implementation.id, qa.id],
    dependencies: [implementation.id, qa.id],
    validation: [],
  });
  for (const readOnly of [qa, parent]) {
    for (const field of [
      "ownedPaths",
      "newPackages",
      "sourceAssets",
      "expectedOutputRoles",
      "requiredLfsRoles",
      "minimumAssetSets",
    ])
      delete readOnly[field];
  }
  delete parent.acceptance;
  value.items = [implementation, qa, parent];
  assert(conforms(value), JSON.stringify(conforms.errors));
  const graph = wire.decode(value);
  hydrateWorkerInputSources(graph, pinnedSources);
  assert.doesNotThrow(() =>
    validateGraph(graph, 17, graph.baseSha, new Set(["OBJECTIVE"])),
  );
  assert.doesNotThrow(() =>
    assertCoverageSources(graph, pinnedSources, obligations),
  );
  assert.equal(graph.coverage[0].itemId, qa.id);
  assert.deepEqual(graph.coverage[0].proof, {
    kind: "integrated-command",
    validationIndex: 0,
  });
  assert.deepEqual(implementation.coverage, []);
  assert.deepEqual(parent.coverage, []);

  // Overall coverage stays complete, but the required QA cannot be ornamental.
  const unmappedQa = structuredClone(value);
  unmappedQa.items[0].coverage = [entry()];
  unmappedQa.items[1].coverage = [];
  assert.equal(conforms(unmappedQa), false);
  assert(conforms.errors.some((error) => error.keyword === "minItems"));
  assert.throws(
    () => wire.decode(unmappedQa),
    /Planner QA node has no acceptance coverage/,
  );
});

test("planning wire retains one whole compound proof and substantive review refusal", async (t) => {
  const criterion =
    "Every delivered result has a separate automatic independent review and successful source-check on its exact published head before protected integration.";
  const commandCriterion = "Source-defined result command passes.";
  const objective = body.replace(
    "- Source-defined result exists.",
    `- ${criterion}\n- ${commandCriterion}`,
  );
  const input = request({
    objective,
    sources: [{ path: "OBJECTIVE", content: objective }],
    coverageObligations: coverageObligations(
      objective,
      objectiveCriteria(objective),
    ),
  });
  const { wire, value, conforms } = setup(input);
  value.items[0].validation[0].lineIndex = 7;
  value.items[0].coverage = [
    entry(),
    {
      ...entry({ kind: "result-command", validationIndex: 0 }),
      obligationIndex: 1,
    },
  ];
  const captured = [];
  let response = value;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      captured.push({ prompt, schema: options.outputSchema });
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(
    "/tmp/planning-proof-test",
    selection,
    selection,
  );
  const graph = await model.generateStructured(input);
  assert(conforms(value), JSON.stringify(conforms.errors));
  hydrateWorkerInputSources(graph, input.sources);
  validateGraph(graph, 17, input.baseSha, new Set(["OBJECTIVE"]));
  assertCoverageSources(graph, input.sources, input.coverageObligations);
  assert.equal(graph.coverage[0].source.text, criterion);
  assert.deepEqual(graph.coverage[0].proof, { kind: "final-review" });
  assert.deepEqual(graph.coverage[1].proof, {
    kind: "result-command",
    validationIndex: 0,
  });
  const duplicated = structuredClone(value);
  duplicated.items[0].coverage.push(
    entry({ kind: "final-controller", guaranteeIndex: 0 }),
  );
  assert.throws(() => wire.decode(duplicated), /obligationIndex is duplicated/);

  // A mechanically valid single guarantee can still receive a substantive refusal.
  const incomplete = structuredClone(value);
  incomplete.items[0].coverage[0].proof = {
    kind: "final-controller",
    guaranteeIndex: 2,
  };
  const incompleteGraph = wire.decode(incomplete);
  const packet = reviewPacket(
    [],
    [{ origin: "source", path: "OBJECTIVE", content: objective }],
  );
  const finding = {
    itemIds: [],
    evidenceIndices: [0],
    detail:
      "The integration guarantee does not cover the independent automatic review clause; retain the whole criterion once with final-review.",
    question: "Can the whole criterion be covered once with final-review?",
  };
  response = { packetId: packet.id, findings: [finding] };
  const refusal = await model.reviewGraph({
    objective,
    baseSha: input.baseSha,
    sources: input.sources,
    graph: incompleteGraph,
    commands: [],
    finalCommands: [],
    controllerCapabilities: input.controllerCapabilities,
    controllerCapabilitiesDigest: input.controllerCapabilitiesDigest,
    reviewPacket: packet,
  });
  assert.equal(decodeGraphReview(refusal, packet, []).length, 1);
  assert.deepEqual(refusal.findings, [finding]);
  response = { diagnosis: finding.detail };
  await model.generateStructured({
    ...input,
    purpose: "diagnosis",
    objective: finding.detail,
    schema: {
      type: "object",
      properties: { diagnosis: { type: "string" } },
      required: ["diagnosis"],
      additionalProperties: false,
    },
  });
  assert.equal(captured.length, 3);

  const treeSha = "b".repeat(40);
  const state = {
    graph,
    work: {
      implementation: {
        status: "done",
        treeSha,
        validation: {
          treeSha,
          commands: [{ command: "test -d .", treeSha, passed: true }],
        },
      },
    },
    finalValidation: { passed: true, criteria: [] },
  };
  assert.throws(() => assertCompletedCoverage(state), /exact criterion proof/);
  state.finalValidation.criteria = [{ criterion, verdict: "fail" }];
  assert.throws(() => assertCompletedCoverage(state), /exact criterion proof/);
  state.finalValidation.criteria = [{ criterion, verdict: "pass" }];
  assert.doesNotThrow(() => assertCompletedCoverage(state));
  state.work.implementation.validation.commands = [];
  assert.throws(
    () => assertCompletedCoverage(state),
    /command proof is missing/,
  );
});

test("compile choices derive bound identities, source commands and canonical proof without transcription", () => {
  const { wire, value, conforms } = setup();
  assert(conforms(value), JSON.stringify(conforms.errors));
  const graph = wire.decode(value);
  assert.equal(graph.objective, 17);
  assert.equal(graph.baseSha, "a".repeat(40));
  assert.deepEqual(graph.coverage[0].proof, { kind: "final-review" });
  assert.equal(graph.coverage[0].itemId, "implementation");
  assert.equal(
    graph.coverage[0].criterionId,
    request().coverageObligations[0].criterionId,
  );
  assert.deepEqual(graph.items[0].validation, [
    {
      command: "test -d .",
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
  ]);
  assert(!("objective" in value));
  assert(!("baseSha" in value));
  assert(!("coverage" in value));
  assert(!JSON.stringify(wire.data).includes(graph.coverage[0].criterionId));
  const baseline = structuredClone(value);
  baseline.items[0].validation = [
    {
      kind: "base-observed",
      command: "test -d .",
      source: "unselected-checks.sh",
    },
  ];
  assert(conforms(baseline));
  assert.equal(
    wire.decode(baseline).items[0].validation[0].source,
    "unselected-checks.sh",
  );
});

test("actual choice schema and decoder admit supported proof forms and refuse owner/phase cross-products", () => {
  const { wire, value, conforms } = setup();
  for (const [kind, proof] of [
    ["work", { kind: "result-command", validationIndex: 0 }],
    ["work", { kind: "result-semantic", acceptanceIndex: 0 }],
    ["work", { kind: "final-review" }],
    ["work", { kind: "final-controller", guaranteeIndex: 0 }],
    ["qa", { kind: "integrated-command", validationIndex: 0 }],
    ["qa", { kind: "integrated-semantic", acceptanceIndex: 0 }],
    ["qa", { kind: "integrated-ci", checkIndex: 0 }],
    ["qa", { kind: "published-ci", checkIndex: 0, dependencyIndex: 0 }],
    ["aggregate", { kind: "result-command", validationIndex: 0 }],
    ["aggregate", { kind: "result-semantic", acceptanceIndex: 0 }],
    ["aggregate", { kind: "integrated-command", validationIndex: 0 }],
    ["aggregate", { kind: "integrated-semantic", acceptanceIndex: 0 }],
    ["aggregate", { kind: "final-review" }],
    ["aggregate", { kind: "final-controller", guaranteeIndex: 0 }],
  ]) {
    const choice = structuredClone(value);
    choice.items[0].kind = kind;
    if (kind === "aggregate") delete choice.items[0].acceptance;
    choice.items[0].coverage = [entry(proof)];
    if (kind !== "work") {
      for (const field of [
        "ownedPaths",
        "newPackages",
        "sourceAssets",
        "expectedOutputRoles",
        "requiredLfsRoles",
        "minimumAssetSets",
        "executionProfile",
      ])
        delete choice.items[0][field];
      choice.items[0].dependencies = ["dependency"];
      choice.items.push(item({ id: "dependency", coverage: [] }));
      if (kind === "aggregate") choice.items[0].children = ["dependency"];
    }
    assert(conforms(choice), JSON.stringify(conforms.errors));
    const graph = wire.decode(choice);
    assert.equal(graph.coverage[0].proof.kind, proof.kind);
    if (kind !== "work") {
      for (const field of [
        "ownedPaths",
        "sourceAssets",
        "expectedOutputRoles",
        "requiredLfsRoles",
      ])
        assert.deepEqual(graph.items[0][field], []);
      assert.equal(graph.items[0].minimumAssetSets, 0);
      assert.equal(graph.items[0].executionProfile, undefined);
      const invented = structuredClone(choice);
      invented.items[0].ownedPaths = ["invented.txt"];
      assert.equal(conforms(invented), false);
      assert.throws(() => wire.decode(invented), /fields/);
    }
    if (proof.kind === "published-ci")
      assert.equal(graph.coverage[0].proof.targetItem, "dependency");
  }
  for (const proof of [
    { kind: "integrated-semantic", acceptanceIndex: 0 },
    { kind: "published-command", validationIndex: 0 },
    { kind: "published-semantic", acceptanceIndex: 0 },
  ]) {
    const choice = structuredClone(value);
    choice.items[0].coverage = [entry(proof)];
    assert.equal(conforms(choice), false);
    assert.throws(() => wire.decode(choice), /proof form/);
  }
  const independentPhase = structuredClone(value);
  independentPhase.items[0].coverage[0].phase = "integrated";
  assert.equal(conforms(independentPhase), false);
  assert.throws(() => wire.decode(independentPhase), /fields/);
});

test("invalid bound choices fail closed without repairing output or inventing command authority", () => {
  const { wire, value, conforms } = setup();
  for (const [mutate, pattern] of [
    [
      (v) => {
        v.contextId = "old-context";
      },
      /context identity/,
    ],
    [
      (v) => {
        v.items[0].coverage[0].obligationIndex = 99;
      },
      /obligationIndex/,
    ],
    [
      (v) => {
        v.items[0].coverage.push(structuredClone(v.items[0].coverage[0]));
      },
      /duplicated/,
    ],
    [
      (v) => {
        v.items[0].coverage = [];
      },
      /omitted/,
    ],
    [
      (v) => {
        v.items[0].validation[0].sourceIndex = 999;
      },
      /sourceIndex/,
    ],
    [
      (v) => {
        v.items[0].validation[0].lineIndex = 999;
      },
      /lineIndex/,
    ],
    [
      (v) => {
        v.items[0].coverage[0].environment.probeValidationIndex =
          "Review is available";
      },
      /probeValidationIndex/,
    ],
    [
      (v) => {
        v.items[0].coverage[0].proof = {
          kind: "result-command",
          validationIndex: 99,
        };
      },
      /validationIndex/,
    ],
    [
      (v) => {
        v.items[0].coverage[0].proof = {
          kind: "final-controller",
          guaranteeIndex: 99,
        };
      },
      /guaranteeIndex/,
    ],
    [
      (v) => {
        v.items[0].inputSources = [{ path: "OBJECTIVE", content: "forged" }];
      },
      /fields/,
    ],
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.throws(() => wire.decode(invalid), pattern);
  }
  const old = {
    objective: 17,
    baseSha: "a".repeat(40),
    coverage: [
      {
        phase: "integrated",
        oracle: { kind: "semantic", reference: "0", targetItem: "" },
      },
    ],
    items: value.items,
  };
  assert.equal(conforms(old), false);
  assert.throws(() => wire.decode(old), /fields/);
});

test("actual initial and revision SDK schemas require real probes without inventing late-proof prerequisites", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-readiness-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  const captured = [];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      const choices = JSON.parse(
        prompt.split("\nCompiler choices (JSON data):\n")[1],
      );
      const value = {
        contextId: choices.contextId,
        requiredPreIntegrationChecks: [],
        items: [item({ coverage: [entry()] })],
      };
      captured.push({ prompt, schema: options.outputSchema, value });
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(value),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  for (const findings of [
    [],
    [
      {
        source: "independent review",
        detail: "Preserve final evidence at its proper phase.",
      },
    ],
  ]) {
    const graph = await compileObjective(
      17,
      body,
      target.baseSha,
      target.checkout,
      model,
      [],
      findings,
    );
    assertCoverageShape(graph);
    const { schema, value } = captured.at(-1);
    const conforms = new Ajv({ strict: false, allErrors: true }).compile(
      schema,
    );
    assert(conforms(value));
    for (const readiness of ["available", "prepare", "missing"]) {
      const choice = structuredClone(value);
      const environment = choice.items[0].coverage[0].environment;
      Object.assign(environment, {
        kind: "real",
        readiness,
        preparedBy: readiness === "prepare" ? "media" : "",
      });
      assert.equal(
        conforms(choice),
        false,
        `real/${readiness}/null must be excluded`,
      );
      environment.probeValidationIndex = 0;
      assert(conforms(choice), JSON.stringify(conforms.errors));
    }
    const real = structuredClone(graph);
    real.coverage[0].environment.kind = "real";
    assert.throws(
      () => assertCoverageShape(real),
      /Real environment requires an exact authorized readiness probe/,
    );
    real.coverage[0].environment.probe = real.items[0].validation[0].command;
    assertCoverageShape(real);
    real.coverage[0].environment.probe = "invented readiness command";
    assert.throws(
      () => assertCoverageShape(real),
      /exact authorized readiness probe/,
    );
    const localProbe = structuredClone(value);
    localProbe.items[0].coverage[0].environment.probeValidationIndex = 0;
    assert(conforms(localProbe));
  }
  assert.equal(captured.length, 2);
  assert(
    captured[1].prompt.includes(
      "Revise the complete graph once to fix these findings",
    ),
  );
  // The instructions reach the model inside the JSON choices.
  assert(
    captured[1].prompt.includes(
      JSON.stringify('"source":"independent review"').slice(1, -1),
    ),
  );
});

test("controller hydration supplies exact selected literals and remains stable across revisions and source reselection", () => {
  const { input, wire, value } = setup();
  const graph = wire.decode(value);
  const originalBrief = graph.items[0].brief;
  hydrateWorkerInputSources(graph, input.sources);
  assert.equal(graph.items[0].brief, originalBrief);
  assert.equal(graph.items[0].inputSources[0].content, body);
  const once = structuredClone(graph.items[0]);
  hydrateWorkerInputSources(graph, input.sources);
  assert.deepEqual(graph.items[0], once);
  const worker = compilerCitationChoices(input.sources).find(
    (choice) => choice.heading === "Worker implementation",
  );
  graph.items[0].citations = [{ path: worker.path, heading: worker.heading }];
  hydrateWorkerInputSources(graph, input.sources);
  assert.deepEqual(graph.items[0].inputSources, [worker]);
  assert.equal(graph.items[0].brief, originalBrief);
  const prompt = workItemPrompt({
    item: graph.items[0],
    worktree: "/public-target",
  });
  assert(prompt.includes("node:assert/strict"));
  assert(prompt.includes(JSON.stringify(worker.content)));
});

test("actual SDK boundary classifies completed invalid choices and compiled graphs validate hydrated inputs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-compile-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  let mode = "valid";
  let captured;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      const choices = JSON.parse(
        prompt.split("\nCompiler choices (JSON data):\n")[1],
      );
      captured = { prompt, schema: options.outputSchema };
      const value = {
        contextId: choices.contextId,
        requiredPreIntegrationChecks: [],
        items: [item({ coverage: [entry()] })],
      };
      if (mode === "invalid") value.items[0].coverage[0].obligationIndex = 999;
      if (mode === "malformed") value.items[0].coverage[0].unexpected = true;
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(value),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const graph = await compileObjective(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
  );
  assert.equal(graph.items[0].inputSources[0].content, body);
  validateGraphSources(
    graph,
    [{ path: "OBJECTIVE", content: body }, ...[]],
    target.checkout,
    body,
    target.baseSha,
  );
  const tampered = structuredClone(graph);
  tampered.items[0].inputSources[0].content = "invented";
  assert.throws(
    () =>
      validateGraphSources(
        tampered,
        [{ path: "OBJECTIVE", content: body }],
        target.checkout,
        body,
        target.baseSha,
      ),
    /inputs differ/,
  );
  assert.equal(captured.prompt.split("# Objective").length - 1, 1);
  assert(captured.schema.properties.contextId.enum.length === 1);
  // A refused choice is revisable; a response of the wrong shape is not.
  mode = "invalid";
  await assert.rejects(
    compileObjective(17, body, target.baseSha, target.checkout, model),
    (error) =>
      error instanceof PlanValidationError &&
      /obligationIndex/.test(error.message),
  );
  mode = "malformed";
  await assert.rejects(
    compileObjective(17, body, target.baseSha, target.checkout, model),
    (error) =>
      error instanceof MalformedPlannerOutput &&
      !(error instanceof PlanValidationError) &&
      /unexpected or missing fields/.test(error.message),
  );
});

test("completed SDK decoder failure enters the admitted bounded planning repair and never remains ambiguously submitted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-wire-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  const calls = { compile: 0, diagnosis: 0, review: 0 };
  let revisionPrompt;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        calls.compile++;
        if (calls.compile === 2) revisionPrompt = prompt;
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [],
          items: [item({ coverage: [entry()] })],
        };
        if (calls.compile === 1)
          response.items[0].coverage[0].obligationIndex = 999;
        assert(
          calls.compile <= 2,
          "only the admitted single corrected compilation",
        );
      } else if (options.outputSchema.properties.packetId) {
        calls.review++;
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: [],
        };
      } else {
        calls.diagnosis++;
        assert.match(prompt, /obligationIndex/);
        assert.match(
          prompt,
          /Rejected canonical graph \(null when unavailable\):\nnull/,
        );
        response = {
          kind: "planning-output",
          diagnosis:
            "The completed response selected an obligation outside the supplied choices.",
          correction:
            "Select the supplied obligationIndex 0 exactly once under its proof owner.",
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const state = {
    autonomy: {
      allowances: {
        planningRevisions: 1,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
      repairClasses: ["planning-output"],
      repairPolicy: {
        perPath: {
          planningRevisions: 1,
          implementationRepairs: 0,
          resultRereviews: 0,
        },
      },
      requiredEnvironment: [],
    },
  };
  const snapshots = [];
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const candidate = await compilePlan(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
    undefined,
    undefined,
    undefined,
    { state, save: () => snapshots.push(structuredClone(state)) },
  );
  assert.equal(candidate.review.status, "clean");
  assert.deepEqual(calls, { compile: 2, diagnosis: 1, review: 1 });
  assert(
    snapshots.some(
      (snapshot) =>
        snapshot.planningRecovery?.phase === "ready" &&
        /obligationIndex/.test(snapshot.planningRecovery.responseFailure),
    ),
  );
  assert.equal(state.planningRecovery.phase, "complete");
  assert.equal(consumption(state).planningRevisions, 1);
  assert.equal(state.planningRecovery.history.length, 1);
  assert.equal(state.planningRecovery.history[0].kind, "planning-output");
  // The planner sees the correction as a diagnosis, not an independent review.
  assert(
    revisionPrompt.includes(
      JSON.stringify(
        '{"source":"diagnosis","detail":"Select the supplied obligationIndex 0',
      ).slice(1, -1),
    ),
  );
  assert(!revisionPrompt.includes("independent review found"));
  assert(
    state.planningRecovery.history[0].invocations.every(
      (invocation) => invocation.resultDigest,
    ),
  );
});

test("aggregate choices derive the child join while preserving real QA semantics and final coverage", () => {
  const qaCriterion =
    "The integrated negative control passes without mutating input.";
  const objective = body.replace(
    "- Source-defined result exists.",
    `- Source-defined result exists.\n- ${qaCriterion}`,
  );
  const { input, wire, value, conforms } = setup({
    objective,
    sources: [{ path: "OBJECTIVE", content: objective }],
    coverageObligations: coverageObligations(
      objective,
      objectiveCriteria(objective),
    ),
  });
  const validation = [{ kind: "source-line", sourceIndex: 0, lineIndex: 7 }];
  const aggregate = item({
    kind: "aggregate",
    id: "parent",
    children: ["implementation", "qa"],
    dependencies: ["implementation", "qa"],
    coverage: [entry()],
    validation,
  });
  for (const field of [
    "acceptance",
    "ownedPaths",
    "newPackages",
    "sourceAssets",
    "expectedOutputRoles",
    "requiredLfsRoles",
    "minimumAssetSets",
  ])
    delete aggregate[field];
  const qa = item({
    kind: "qa",
    id: "qa",
    dependencies: ["implementation"],
    acceptance: [qaCriterion],
    validation,
    coverage: [
      {
        ...entry({ kind: "integrated-semantic", acceptanceIndex: 0 }),
        obligationIndex: 1,
      },
    ],
  });
  for (const field of [
    "ownedPaths",
    "newPackages",
    "sourceAssets",
    "expectedOutputRoles",
    "requiredLfsRoles",
    "minimumAssetSets",
  ])
    delete qa[field];
  value.items = [item({ validation }), qa, aggregate];
  assert(conforms(value), JSON.stringify(conforms.errors));
  const graph = wire.decode(value);
  assert.deepEqual(
    graph.items[2].acceptance,
    aggregateAcceptance({ id: "parent" }),
  );
  assert.deepEqual(graph.items[1].acceptance, qa.acceptance);
  assert.match(graph.items[2].acceptance[0], /Implementation child results/);
  assert.match(
    graph.items[2].acceptance[0],
    /read-only QA and aggregate children have accepted proof/,
  );
  assert.doesNotMatch(
    graph.items[2].acceptance[0],
    /Every explicit child.*its result is integrated/,
  );
  const finalCoverage = graph.coverage.find(
    (coverage) => coverage.itemId === "parent",
  );
  assert.deepEqual(finalCoverage.proof, { kind: "final-review" });
  assert.equal(
    finalCoverage.source.text,
    input.coverageObligations[0].source.text,
  );
  // Final coverage never becomes an earlier parent criterion.
  assert(!graph.items[2].acceptance.includes(finalCoverage.source.text));
  const future = structuredClone(value);
  future.items[2].acceptance = [
    "Successful final Objective review proves the published check before parent acceptance.",
  ];
  assert.equal(conforms(future), false);
  assert.throws(() => wire.decode(future), /unexpected or missing fields/);
  const direct = structuredClone(graph);
  assert.doesNotThrow(() =>
    assertCoverageSources(direct, input.sources, input.coverageObligations),
  );
  assert.doesNotThrow(() =>
    validateGraph(direct, 17, input.baseSha, new Set(["OBJECTIVE"])),
  );
  direct.items[2].acceptance = future.items[2].acceptance;
  assert.throws(
    () => validateGraph(direct, 17, input.baseSha, new Set(["OBJECTIVE"])),
    /Aggregate acceptance/,
  );
  // An aggregate may itself be a read-only child, with no new delivery identity.
  const nested = structuredClone(value);
  nested.items.push({
    ...structuredClone(aggregate),
    id: "outer-parent",
    children: ["parent"],
    dependencies: ["parent"],
    coverage: [],
  });
  assert(conforms(nested), JSON.stringify(conforms.errors));
  const nestedGraph = wire.decode(nested);
  assert.doesNotThrow(() =>
    validateGraph(nestedGraph, 17, input.baseSha, new Set(["OBJECTIVE"])),
  );
  assert.match(
    nestedGraph.items[3].acceptance[0],
    /read-only QA and aggregate children have accepted proof/,
  );
  assert.deepEqual(nestedGraph.items[3].ownedPaths, []);
});

test("trusted prior graph retains aggregate and decomposed work acceptance exactly", () => {
  for (const kind of ["aggregate", "work"]) {
    const previousGraph = {
      objective: 17,
      baseSha: "a".repeat(40),
      items: [
        item({
          id: "parent",
          kind,
          acceptance: [
            "Original accepted semantic requirement",
            "Second original criterion",
          ],
        }),
      ],
    };
    const { wire, value, conforms } = setup({
      compileContext: {
        objectiveNumber: 17,
        instructions: "Amend the trusted graph",
        previousGraph,
      },
    });
    const parent = item({
      kind: "aggregate",
      id: "parent",
      children: ["implementation"],
      dependencies: ["implementation"],
      coverage: [entry()],
    });
    for (const field of [
      "acceptance",
      "ownedPaths",
      "newPackages",
      "sourceAssets",
      "expectedOutputRoles",
      "requiredLfsRoles",
      "minimumAssetSets",
    ])
      delete parent[field];
    value.items = [item(), parent];
    assert(conforms(value), JSON.stringify(conforms.errors));
    const graph = wire.decode(value);
    assert.deepEqual(
      graph.items[1].acceptance,
      previousGraph.items[0].acceptance,
    );
    assert.doesNotThrow(() =>
      validateGraph(
        graph,
        17,
        graph.baseSha,
        new Set(["OBJECTIVE"]),
        previousGraph,
      ),
    );
    graph.items[1].acceptance.push(
      "An invented future final-review obligation",
    );
    assert.throws(
      () =>
        validateGraph(
          graph,
          17,
          graph.baseSha,
          new Set(["OBJECTIVE"]),
          previousGraph,
        ),
      /Aggregate acceptance/,
    );
    assert.equal(previousGraph.items[0].acceptance.length, 2);
  }
});

test("unchanged historical aggregate review receipts remain verifiable without relaxing new candidate checks", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "factory-historical-aggregate-review-"),
  );
  try {
    const target = createTarget(root);
    const { wire, value } = setup({ baseSha: target.baseSha });
    const parent = item({
      kind: "aggregate",
      id: "parent",
      children: ["implementation"],
      dependencies: ["implementation"],
      coverage: [],
    });
    for (const field of [
      "acceptance",
      "ownedPaths",
      "newPackages",
      "sourceAssets",
      "expectedOutputRoles",
      "requiredLfsRoles",
      "minimumAssetSets",
    ])
      delete parent[field];
    value.items.push(parent);
    const candidate = await compilePlan(
      17,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured() {
          return wire.decode(value);
        },
        async reviewGraph(request) {
          return { packetId: request.reviewPacket.id, findings: [] };
        },
      },
    );
    // Reconstruct immutable pre-correction fixture receipts for a valid source
    // semantic parent. This is historical test data, never runtime output repair.
    const historical = structuredClone(candidate);
    historical.graph.items[1].acceptance = ["Source-defined result exists."];
    const hash = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    historical.graphDigest = hash(historical.graph);
    historical.packetDigest = hash(
      planReviewPacket(
        body,
        target.baseSha,
        historical.sources,
        historical.graph,
        target.checkout,
      ),
    );
    historical.reviewDigest = hash({
      packetDigest: historical.packetDigest,
      revisions: historical.review.revisions,
      findings: historical.review.findings,
    });
    assert.doesNotThrow(() =>
      verifyPlanCandidate(
        historical,
        17,
        body,
        target.baseSha,
        target.checkout,
      ),
    );
    const changed = structuredClone(historical);
    changed.graph.items[1].acceptance.push("Unreviewed future obligation");
    assert.throws(
      () =>
        verifyPlanCandidate(changed, 17, body, target.baseSha, target.checkout),
      /Plan candidate differs/,
    );
    await assert.rejects(
      compileObjective(17, body, target.baseSha, target.checkout, {
        async generateStructured() {
          return historical.graph;
        },
        async reviewGraph() {
          assert.fail("invalid new graph must fail before review");
        },
      }),
      /Aggregate acceptance/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("amendment references retain exact started definitions while moving source coverage to QA", () => {
  const pinned = [
    ...sources,
    {
      path: "README.md",
      content: "# Usage\n\nKeep the existing source unchanged.\n",
    },
  ];
  const initial = setup({ sources: pinned });
  const whole = initial.wire.data.citations.find(
    (x) => x.path === "README.md" && x.heading === "",
  );
  initial.value.items[0].citations.push({ choiceIndex: whole.choiceIndex });
  const previousGraph = initial.wire.decode(initial.value);
  hydrateWorkerInputSources(previousGraph, pinned);
  const trusted = structuredClone(previousGraph.items[0]);
  const next = setup({
    sources: pinned,
    compileContext: {
      objectiveNumber: 17,
      instructions: "Amend required QA",
      previousGraph,
      immutableItemIds: [trusted.id],
    },
  });
  const qa = item({
    kind: "qa",
    id: "verify",
    dependencies: [trusted.id],
    coverage: [entry({ kind: "integrated-command", validationIndex: 0 })],
  });
  for (const field of [
    "ownedPaths",
    "newPackages",
    "sourceAssets",
    "expectedOutputRoles",
    "requiredLfsRoles",
    "minimumAssetSets",
  ])
    delete qa[field];
  const value = {
    contextId: next.wire.data.contextId,
    requiredPreIntegrationChecks: [],
    items: [{ kind: "retained", id: trusted.id, coverage: [] }, qa],
  };
  assert(next.conforms(value), JSON.stringify(next.conforms.errors));
  const graph = next.wire.decode(value);
  hydrateWorkerInputSources(graph, pinned);
  assert.deepEqual(graph.items[0], trusted);
  assert.deepEqual(previousGraph.items[0], trusted);
  assert.doesNotThrow(() =>
    validateGraph(
      graph,
      17,
      graph.baseSha,
      new Set(pinned.map((x) => x.path)),
      previousGraph,
    ),
  );
  assert.doesNotThrow(() =>
    assertCoverageSources(graph, pinned, next.input.coverageObligations),
  );
  assert.equal(graph.coverage[0].itemId, "verify");
  assert.deepEqual(graph.coverage[0].proof, {
    kind: "integrated-command",
    validationIndex: 0,
  });
  assert.equal(graph.items[0].citations.at(-1).heading, "");
  const defaultKindGraph = structuredClone(previousGraph);
  delete defaultKindGraph.items[0].kind;
  const defaultKind = setup({
    sources: pinned,
    compileContext: {
      objectiveNumber: 17,
      instructions: "Amend",
      previousGraph: defaultKindGraph,
      immutableItemIds: [trusted.id],
    },
  });
  const defaultValue = {
    contextId: defaultKind.wire.data.contextId,
    requiredPreIntegrationChecks: [],
    items: [{ kind: "retained", id: trusted.id, coverage: [entry()] }],
  };
  assert(
    defaultKind.conforms(defaultValue),
    JSON.stringify(defaultKind.conforms.errors),
  );
  assert.deepEqual(
    defaultKind.wire.decode(defaultValue).items[0],
    defaultKindGraph.items[0],
  );

  // Reproduce the observed equivalent-heading edit as a submitted definition.
  const redefined = structuredClone(value);
  const named = next.wire.data.citations.find(
    (x) => x.path === "README.md" && x.heading === "Usage",
  );
  redefined.items[0] = item({
    citations: [{ choiceIndex: 0 }, { choiceIndex: named.choiceIndex }],
    coverage: [],
  });
  assert.throws(
    () => next.wire.decode(redefined),
    /must reference started Work Items/,
  );
  const changedReference = structuredClone(value);
  changedReference.items[0].brief = "Change historical result";
  assert.equal(next.conforms(changedReference), false);
  assert.throws(
    () => next.wire.decode(changedReference),
    /retained item has unexpected/,
  );
  const unknown = structuredClone(value);
  unknown.items[0].id = "unknown";
  assert.equal(next.conforms(unknown), false);
  assert.throws(
    () => next.wire.decode(unknown),
    /retained item is unavailable/,
  );
  const duplicate = structuredClone(value);
  duplicate.items.push(structuredClone(value.items[0]));
  assert.throws(
    () => next.wire.decode(duplicate),
    /retained item is unavailable or duplicated/,
  );
  const omitted = structuredClone(value);
  omitted.items.shift();
  assert.throws(() => next.wire.decode(omitted), /omitted retained Work Items/);
  const wrongPhase = structuredClone(value);
  wrongPhase.items[0].coverage = [
    entry({ kind: "integrated-command", validationIndex: 0 }),
  ];
  wrongPhase.items[1].coverage = [];
  assert.equal(next.conforms(wrongPhase), false);
  assert.throws(
    () => next.wire.decode(wrongPhase),
    /proof form is not supported/,
  );
  const stale = structuredClone(value);
  stale.contextId = initial.wire.data.contextId;
  assert.equal(next.conforms(stale), false);
  assert.throws(() => next.wire.decode(stale), /context identity differs/);
});

test("compileObjective supplies trusted retained identity and keeps pending items editable", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-retained-compiler-"));
  try {
    const target = createTarget(root);
    let calls = 0;
    const model = {
      async generateStructured(input) {
        const wire = compilerWire(
          input,
          compilerCitationChoices(input.sources),
        );
        calls++;
        if (calls === 1)
          return wire.decode({
            contextId: wire.data.contextId,
            requiredPreIntegrationChecks: [],
            items: [
              item({ coverage: [entry()] }),
              item({
                id: "pending",
                ownedPaths: ["pending.txt"],
                brief: "Original pending brief",
                coverage: [],
              }),
            ],
          });
        assert.deepEqual(input.compileContext.immutableItemIds, [
          "implementation",
        ]);
        const qa = item({
          kind: "qa",
          id: "verify",
          dependencies: ["implementation", "pending"],
          coverage: [entry({ kind: "integrated-command", validationIndex: 0 })],
        });
        for (const field of [
          "ownedPaths",
          "newPackages",
          "sourceAssets",
          "expectedOutputRoles",
          "requiredLfsRoles",
          "minimumAssetSets",
        ])
          delete qa[field];
        const pending = item({
          id: "pending",
          ownedPaths: ["pending.txt"],
          brief: "An eligible revised brief",
          coverage: [],
        });
        return wire.decode({
          contextId: wire.data.contextId,
          requiredPreIntegrationChecks: [],
          items: [
            { kind: "retained", id: "implementation", coverage: [] },
            pending,
            qa,
          ],
        });
      },
    };
    const previous = await compileObjective(
      17,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    const graph = await compileObjective(
      17,
      body,
      target.baseSha,
      target.checkout,
      model,
      [],
      [],
      undefined,
      undefined,
      {
        currentGraph: previous,
        discovery: { reason: "required QA" },
        immutableItemIds: ["implementation"],
      },
    );
    assert.deepEqual(graph.items[0], previous.items[0]);
    assert.equal(
      graph.items.find((x) => x.id === "pending").brief,
      "An eligible revised brief",
    );
    assert.equal(graph.coverage[0].itemId, "verify");
    const invalid = request({
      compileContext: {
        objectiveNumber: 17,
        instructions: "",
        previousGraph: previous,
        immutableItemIds: ["unknown"],
      },
      baseSha: target.baseSha,
    });
    assert.throws(
      () => compilerWire(invalid, compilerCitationChoices(invalid.sources)),
      /lacks trusted current-graph identity/,
    );
    invalid.compileContext.immutableItemIds = [
      "implementation",
      "implementation",
    ];
    assert.throws(
      () => compilerWire(invalid, compilerCitationChoices(invalid.sources)),
      /lacks trusted current-graph identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual SDK binds source-required quality independently of compound final proof and rejects reconstructed source authority", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-source-ci-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, ciWorkflow);
  const compound = body.replace(
    "Source-defined result exists.",
    "Source-defined result exists and Quality workflow job `quality` succeeds on every exact PR head before integration; workflow files remain intact.",
  );
  let captured;
  let invalid = false;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      const choices = JSON.parse(
        prompt.split("\nCompiler choices (JSON data):\n")[1],
      );
      captured = { prompt, schema: options.outputSchema };
      const value = {
        contextId: choices.contextId,
        requiredPreIntegrationChecks: [
          {
            checkIndex: 1,
            sourceIndex: invalid ? 999 : 0,
          },
        ],
        items: [
          item({
            coverage: [entry()],
            acceptance: ["Source-defined result exists"],
          }),
        ],
      };
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(value),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const graph = await compileObjective(
    17,
    compound,
    target.baseSha,
    target.checkout,
    model,
  );
  assert(captured.schema.required.includes("requiredPreIntegrationChecks"));
  assert.deepEqual(graph.coverage[0].proof, { kind: "final-review" });
  assert.deepEqual(graph.requiredPreIntegrationChecks, [
    {
      checkName: "quality",
      source: {
        path: "OBJECTIVE",
        digest: createHash("sha256").update(compound).digest("hex"),
        text: compound,
      },
    },
  ]);
  assert.doesNotThrow(() =>
    validateGraphSources(
      graph,
      [{ path: "OBJECTIVE", content: compound }],
      target.checkout,
      compound,
      target.baseSha,
    ),
  );
  const tampered = structuredClone(graph);
  tampered.requiredPreIntegrationChecks[0].source.text =
    "Reconstructed authority";
  assert.throws(
    () =>
      validateGraphSources(
        tampered,
        [{ path: "OBJECTIVE", content: compound }],
        target.checkout,
        compound,
        target.baseSha,
      ),
    /pinned source/,
  );
  const dropped = structuredClone(graph);
  dropped.requiredPreIntegrationChecks = [];
  assert.throws(
    () =>
      validateGraph(dropped, 17, target.baseSha, new Set(["OBJECTIVE"]), graph),
    /preserve.*pre-integration/,
  );
  const duplicated = structuredClone(graph);
  duplicated.requiredPreIntegrationChecks.push(
    structuredClone(duplicated.requiredPreIntegrationChecks[0]),
  );
  assert.throws(
    () => validateGraph(duplicated, 17, target.baseSha, new Set(["OBJECTIVE"])),
    /unique name/,
  );
  invalid = true;
  await assert.rejects(
    compileObjective(17, compound, target.baseSha, target.checkout, model),
    /sourceIndex/,
  );
});

test("strict CI choices hydrate complete pinned sources and bind actual execution bounds without model bookkeeping", () => {
  const executionBounds = { configuredConcurrency: 2 };
  const input = request({ executionBounds });
  const { wire, value, conforms } = setup(input);
  value.requiredPreIntegrationChecks = [{ checkIndex: 1, sourceIndex: 0 }];
  assert(conforms(value), JSON.stringify(conforms.errors));
  assert.deepEqual(
    wire.schema.properties.requiredPreIntegrationChecks.items.required,
    ["checkIndex", "sourceIndex"],
  );
  const graph = wire.decode(value);
  assert.equal(graph.requiredPreIntegrationChecks[0].checkName, "quality");
  assert.equal(graph.requiredPreIntegrationChecks[0].source.text, body);
  assert.deepEqual(wire.data.executionBounds, executionBounds);
  for (const mutation of [
    (entry) => {
      entry.firstLine = 3;
      entry.lastLine = 3;
    },
    (entry) => {
      entry.sourceIndex = 999;
    },
    (entry) => {
      entry.sourceIndex = "0";
    },
    (entry) => {
      entry.checkIndex = 2;
    },
    (entry) => {
      delete entry.checkIndex;
      entry.checkName = "quality";
    },
  ]) {
    const invalid = structuredClone(value);
    mutation(invalid.requiredPreIntegrationChecks[0]);
    assert.equal(conforms(invalid), false);
    assert.throws(() => wire.decode(invalid), /Planner/);
  }
  const changed = compilerWire(
    {
      ...input,
      executionBounds: { configuredConcurrency: 3 },
    },
    compilerCitationChoices(input.sources),
  );
  assert.notEqual(changed.data.contextId, wire.data.contextId);
  assert.throws(() => changed.decode(value), /context identity/);
  for (const bounds of [
    { ...executionBounds, configuredConcurrency: "2" },
    { configuredConcurrency: 0 },
    [2, 2],
    { ...executionBounds, admitted: true },
  ])
    assert.throws(
      () =>
        compilerWire(
          { ...input, executionBounds: bounds },
          compilerCitationChoices(input.sources),
        ),
      /execution bounds/,
    );
});

test("planner and reviewer state the restored phase, command and test rules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-restored-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, ciWorkflow);
  const prompts = { compile: [], review: [] };
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        prompts.compile.push(prompt);
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [],
          items: [item({ coverage: [entry()] })],
        };
      } else {
        prompts.review.push(prompt);
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: [],
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  await compilePlan(17, body, target.baseSha, target.checkout, model);
  const [planner] = prompts.compile;
  const [reviewer] = prompts.review;
  const phases =
    "An item's acceptance is judged before its own LFS upload, publication, merge and hydration, and a native-stack dependency is not yet merged when its dependent runs.";
  for (const prompt of [planner, reviewer]) {
    assert(prompt.includes(phases));
    assert(
      prompt.includes(
        "is exactly one backticked command is run by Factory on the integrated result, so any proof covers it; a criterion that requires another command to pass is proved by that exact command.",
      ),
    );
  }
  assert(
    reviewer.includes(
      "a test the worker writes is not by itself proof of that control or of a golden or baseline change",
    ),
  );
  // A required check missing from the known names is kept for the operator.
  assert(
    planner.includes(
      "If a source requires a check that is not in checkNames, never drop the requirement: leave it for review to ask the operator.",
    ),
  );
  assert(
    reviewer.includes(
      "A source-required check missing from the known CI check names is an unresolved source decision: ask the operator.",
    ),
  );
  assert(
    reviewer.includes(
      'Known CI check names (check runs the base\'s pull-request workflows report):\n["lint","quality","required-check"]',
    ),
  );
});

test("CI checks are chosen by index from known names, so an invented name cannot be expressed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-check-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The base's workflow defines the jobs.
  const target = createTarget(root, ciWorkflow);
  let indices = [];
  const prompts = [];
  const diagnoses = [];
  let reviews = 0;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.correction) {
        diagnoses.push(prompt);
        response = planningDiagnosis(
          "Choose a checkIndex from the known names",
        );
      } else if (options.outputSchema.properties.contextId) {
        prompts.push(prompt);
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        assert.deepEqual(choices.checkNames, [
          { checkIndex: 0, name: "lint" },
          { checkIndex: 1, name: "quality" },
          { checkIndex: 2, name: "required-check" },
        ]);
        const gate =
          options.outputSchema.properties.requiredPreIntegrationChecks.items;
        assert.deepEqual(gate.required, ["checkIndex", "sourceIndex"]);
        assert.equal(gate.properties.checkIndex.maximum, 2);
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [
            { checkIndex: indices.shift(), sourceIndex: 0 },
          ],
          items: [item({ coverage: [entry()] })],
        };
      } else {
        reviews++;
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: [],
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "scripted",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  // A provider that ignores the schema's bound is refused, and that spends
  // the revision instead of producing a clean plan.
  indices = [7, 0];
  const candidate = await compilePlan(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
  );
  assert.equal(prompts.length, 2);
  assert.equal(reviews, 1);
  assert.equal(candidate.review.revisions, 1);
  assert.equal(candidate.review.status, "clean");
  assert.equal(
    candidate.graph.requiredPreIntegrationChecks[0].checkName,
    "lint",
  );
  assert.equal(diagnoses.length, 1);
  assert.match(diagnoses[0], /Planner checkIndex is invalid/);
  assert(
    prompts[1].includes(JSON.stringify('"source":"diagnosis"').slice(1, -1)),
  );
  verifyPlanCandidate(candidate, 17, body, target.baseSha, target.checkout);

  // Admission re-checks a canonical graph's names against the same sources.
  const tampered = structuredClone(candidate);
  tampered.graph.requiredPreIntegrationChecks[0].checkName = "Lint";
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  tampered.graphDigest = hash(tampered.graph);
  tampered.packetDigest = hash(
    planReviewPacket(
      body,
      target.baseSha,
      tampered.sources,
      tampered.graph,
      target.checkout,
    ),
  );
  tampered.reviewDigest = hash({
    packetDigest: tampered.packetDigest,
    revisions: tampered.review.revisions,
    findings: tampered.review.findings,
  });
  assert.throws(
    () =>
      verifyPlanCandidate(
        tampered,
        17,
        body,
        target.baseSha,
        target.checkout,
        undefined,
        true,
      ),
    /"Lint" is not a job/,
  );

  // Refused twice: planning stops for a decision and is never reviewed.
  indices = [7, 7];
  prompts.length = 0;
  reviews = 0;
  await assert.rejects(
    compilePlan(17, body, target.baseSha, target.checkout, model),
    (error) =>
      error instanceof PlanningNeedsDecision &&
      /Unchanged planning failure/.test(error.message),
  );
  assert.equal(prompts.length, 2);
  assert.equal(reviews, 0);
});

test("with no known check names the planner cannot create a gate or CI proof", () => {
  const input = request({ checkNames: [] });
  const wire = compilerWire(input, compilerCitationChoices(input.sources));
  const conforms = new Ajv({ strict: false, allErrors: true }).compile(
    wire.schema,
  );
  assert.equal(wire.schema.properties.requiredPreIntegrationChecks.maxItems, 0);
  assert.deepEqual(wire.data.checkNames, []);
  const value = {
    contextId: wire.data.contextId,
    requiredPreIntegrationChecks: [{ checkIndex: 0, sourceIndex: 0 }],
    items: [item({ coverage: [entry()] })],
  };
  assert.equal(conforms(value), false);
  assert.throws(
    () => wire.decode(value),
    (error) =>
      error instanceof PlannerChoiceError &&
      /checkIndex is invalid/.test(error.message),
  );
  const qa = {
    contextId: wire.data.contextId,
    requiredPreIntegrationChecks: [],
    items: [
      item({ id: "dependency" }),
      item({
        kind: "qa",
        id: "qa",
        dependencies: ["dependency"],
        coverage: [entry({ kind: "integrated-ci", checkIndex: 0 })],
      }),
    ],
  };
  for (const field of [
    "ownedPaths",
    "newPackages",
    "sourceAssets",
    "expectedOutputRoles",
    "requiredLfsRoles",
    "minimumAssetSets",
  ])
    delete qa.items[1][field];
  assert.equal(conforms(qa), false);
  assert.throws(() => wire.decode(qa), /proof form is not supported/);
});

test("actual compiler, canonical review and bounded diagnosis receive complete CI evidence and controller ceilings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-canonical-ci-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pinned =
    "# Rules\nUse two independent configured slots.\nBefore every ordinary delivery PR integration, check `quality` must succeed on that exact published head.\nKeep the workflow unchanged.\n";
  const target = createTarget(root, { "AGENTS.md": pinned, ...ciWorkflow });
  const config = factoryConfig(target.checkout, "example/planning-bounds");
  config.execution.concurrency = 2;
  const autonomy = {
    allowances: {
      planningRevisions: 1,
      implementationRepairs: 0,
      resultRereviews: 0,
    },
    repairClasses: ["planning-evidence"],
    repairPolicy: {
      perPath: {
        planningRevisions: 1,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
    },
    requiredEnvironment: [],
  };
  const executionBounds = {
    configuredConcurrency: config.execution.concurrency,
  };
  const captured = [];
  let reviewCalls = 0;
  let rejectedGraph;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      captured.push({ prompt, schema: options.outputSchema });
      let response;
      if (options.outputSchema.properties.contextId) {
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        assert.deepEqual(choices.executionBounds, executionBounds);
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [
            {
              checkIndex: choices.checkNames.findIndex(
                (entry) => entry.name === "quality",
              ),
              sourceIndex: choices.sources.findIndex(
                (source) => source.path === "AGENTS.md",
              ),
            },
          ],
          items: [
            item({
              coverage: [entry()],
              brief:
                reviewCalls === 0
                  ? "The controller admitted concurrency 999"
                  : "Implement within actual configured ceilings; runtime overlap remains later evidence.",
            }),
          ],
        };
      } else if (options.outputSchema.properties.packetId) {
        reviewCalls++;
        const packet = packetFromPrompt(prompt);
        const boundsIndex = packet.evidence.findIndex(
          (entry) => entry.path === "FACTORY_EXECUTION_BOUNDS",
        );
        assert.equal(packet.evidence[boundsIndex].origin, "controller");
        assert.deepEqual(
          JSON.parse(packet.evidence[boundsIndex].content),
          executionBounds,
        );
        const graph = JSON.parse(
          prompt
            .split("\nGraph:\n")[1]
            .split("\nCommand authority receipts:")[0],
        );
        if (reviewCalls <= 2) {
          assert.equal(
            graph.requiredPreIntegrationChecks[0].source.text,
            pinned,
          );
          assert.equal(
            "sourceIndex" in graph.requiredPreIntegrationChecks[0],
            false,
          );
        }
        const gate = graph.requiredPreIntegrationChecks[0];
        const invalidGate =
          !gate ||
          gate.checkName !== "quality" ||
          gate.source.path !== "AGENTS.md" ||
          gate.source.text !== pinned;
        rejectedGraph = graph;
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: invalidGate
            ? [
                {
                  itemIds: [],
                  evidenceIndices: [
                    packet.evidence.findIndex(
                      (entry) => entry.path === "AGENTS.md",
                    ),
                  ],
                  detail:
                    "The canonical gate omits, misnames or incompletely grounds the required quality check before every integration.",
                  question:
                    "Does the gate retain the exact supported named check and complete pre-integration scope?",
                },
              ]
            : reviewCalls === 1
              ? [
                  {
                    itemIds: [],
                    evidenceIndices: [boundsIndex],
                    detail:
                      "Authored prose claims 999 although the actual configured ceiling is two.",
                    question: "",
                  },
                ]
              : [],
        };
      } else {
        const actual = JSON.parse(
          prompt.split(
            "\nRejected canonical graph (null when unavailable):\n",
          )[1],
        );
        assert.deepEqual(actual, rejectedGraph);
        assert.match(
          prompt,
          /Controller execution bounds:\n\{"configuredConcurrency":2\}/,
        );
        response = {
          kind: "planning-evidence",
          diagnosis: "Worker prose cannot override actual controller ceilings.",
          correction:
            "Retain full pinned CI evidence and plan within two configured slots.",
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "fixture",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const state = { autonomy };
  const candidate = await compilePlan(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
    undefined,
    undefined,
    undefined,
    { state, save() {} },
    undefined,
    undefined,
    executionBounds,
  );
  assert.equal(candidate.review.status, "clean");
  assert.equal(candidate.review.revisions, 1);
  assert.deepEqual(candidate.executionBounds, executionBounds);
  assert.equal(consumption(state).planningRevisions, 1);
  assert.deepEqual(
    captured.map(({ schema }) =>
      schema.properties.contextId
        ? "compile"
        : schema.properties.packetId
          ? "review"
          : "diagnosis",
    ),
    ["compile", "review", "diagnosis", "compile", "review"],
  );
  verifyPlanCandidate(candidate, 17, body, target.baseSha, target.checkout);
  for (const mutate of [
    (graph) => {
      graph.requiredPreIntegrationChecks = [];
    },
    (graph) => {
      graph.requiredPreIntegrationChecks[0].checkName = "invented-check";
    },
    (graph) => {
      graph.requiredPreIntegrationChecks[0].source = {
        path: "OBJECTIVE",
        digest: createHash("sha256").update(body).digest("hex"),
        text: body,
      };
    },
    (graph) => {
      graph.requiredPreIntegrationChecks[0].source.text =
        "Keep the workflow unchanged.\n";
    },
  ]) {
    const graph = structuredClone(candidate.graph);
    mutate(graph);
    const request = planReviewPacket(
      body,
      target.baseSha,
      candidate.sources,
      graph,
      target.checkout,
      undefined,
      undefined,
      undefined,
      executionBounds,
    );
    request.reviewPacket = reviewPacket([], planningReviewEvidence(request));
    const refusal = await model.reviewGraph(request);
    assert.equal(
      decodeGraphReview(refusal, request.reviewPacket, []).length,
      1,
      "Substantive grounded refusals stay refusals through the actual SDK contract",
    );
  }
});

test("complete SDK responses reject malformed native item primitives and collections before review", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-native-planner-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  let mutation;
  let captured;
  let reviews = 0;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [],
          items: [item({ coverage: [entry()] })],
        };
        if (mutation)
          response.items[0][mutation[0]] = structuredClone(mutation[1]);
        const conforms = new Ajv({ strict: false, allErrors: true }).compile(
          options.outputSchema,
        );
        captured = {
          response,
          conforms: conforms(response),
          schema: options.outputSchema,
        };
      } else {
        reviews++;
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: [],
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "fixture",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const valid = await compilePlan(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
  );
  assert.equal(captured.conforms, true);
  assert.equal(valid.review.status, "clean");
  assert.equal(reviews, 1);
  for (mutation of [
    ...["id", "title", "goal", "brief"].flatMap((field) =>
      [42, null, [], {}].map((value) => [field, value]),
    ),
    ...[
      "acceptance",
      "nonGoals",
      "dependencies",
      "children",
      "ownedPaths",
      "resources",
      "expectedOutputRoles",
      "requiredLfsRoles",
    ].flatMap((field) => [42, null, {}, [42]].map((value) => [field, value])),
    ...["priority", "minimumAssetSets"].flatMap((field) =>
      ["0", null, [], 0.5].map((value) => [field, value]),
    ),
    ["resources", "resource"],
    ["priority", "1"],
    ["sourceAssets", 42],
    ["sourceAssets", [42]],
    ...["role", "mediaType"].map((field) => [
      "sourceAssets",
      [
        {
          kind: "repository",
          path: "README.md",
          role: "source",
          mediaType: "text/plain",
          visibility: "repository",
          [field]: 42,
        },
      ],
    ]),
    [
      "sourceAssets",
      [
        {
          kind: ["repository"],
          path: "README.md",
          role: "fixture",
          mediaType: "text/plain",
          visibility: "repository",
        },
      ],
    ],
  ]) {
    await assert.rejects(
      compileObjective(17, body, target.baseSha, target.checkout, model),
      (error) => {
        assert(error instanceof MalformedPlannerOutput);
        assert.match(error.message, /Work Item|Planner source.?asset/i);
        assert.doesNotMatch(
          error.message,
          /is not a function|Cannot read properties|Cannot convert undefined/,
        );
        return true;
      },
      mutation[0],
    );
    assert.equal(captured.conforms, false, mutation[0]);
    assert.equal(
      reviews,
      1,
      "No independent review call after malformed response",
    );
    const invalidCanonical = structuredClone(valid.graph);
    invalidCanonical.items[0][mutation[0]] = structuredClone(mutation[1]);
    assert.throws(
      () =>
        validateGraph(
          invalidCanonical,
          17,
          target.baseSha,
          new Set(["OBJECTIVE", "AGENTS.md"]),
        ),
      /Work Item/,
      mutation[0],
    );
  }
});

test("semantic validation rejection retains the actual decoded graph for bounded diagnosis", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-decoded-rejection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  let compiles = 0;
  let diagnoses = 0;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        compiles++;
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        response = {
          contextId: choices.contextId,
          requiredPreIntegrationChecks: [],
          items: [item({ coverage: [entry()] })],
        };
        if (compiles === 1)
          response.items[0].sourceAssets = [
            {
              kind: "repository",
              path: "missing.png",
              role: "fixture",
              mediaType: "image/png",
              visibility: "repository",
            },
          ];
      } else if (options.outputSchema.properties.packetId) {
        response = {
          packetId: options.outputSchema.properties.packetId.enum[0],
          findings: [],
        };
      } else {
        diagnoses++;
        const graph = JSON.parse(
          prompt.split(
            "\nRejected canonical graph (null when unavailable):\n",
          )[1],
        );
        assert.equal(graph.baseSha, target.baseSha);
        assert.deepEqual(graph.items[0].sourceAssets, [
          {
            kind: "repository",
            path: "missing.png",
            role: "fixture",
            mediaType: "image/png",
            visibility: "repository",
          },
        ]);
        assert.equal(graph.items[0].inputSources[0].content, body);
        response = {
          kind: "planning-output",
          diagnosis:
            "The decoded graph invented an unavailable repository source asset.",
          correction:
            "Retain the supplied ordinary-work contract without inventing unavailable source assets.",
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "fixture",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const state = {
    autonomy: {
      allowances: {
        planningRevisions: 1,
        implementationRepairs: 0,
        resultRereviews: 0,
      },
      repairClasses: ["planning-output"],
      repairPolicy: {
        perPath: {
          planningRevisions: 1,
          implementationRepairs: 0,
          resultRereviews: 0,
        },
      },
      requiredEnvironment: [],
    },
  };
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const model = new CodexPlanningModel(target.checkout, selection, selection);
  const candidate = await compilePlan(
    17,
    body,
    target.baseSha,
    target.checkout,
    model,
    undefined,
    undefined,
    undefined,
    { state, save() {} },
  );
  assert.equal(candidate.review.status, "clean");
  assert.equal(diagnoses, 1);
  assert.equal(compiles, 2);
  assert.equal(consumption(state).planningRevisions, 1);
});
