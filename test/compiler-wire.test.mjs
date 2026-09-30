import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { compilerWire } from "../dist/compiler-wire.js";
import {
  CodexPlanningModel,
  MalformedPlannerOutput,
  compilerCitationChoices,
  compileObjective,
  compilePlan,
  hydrateWorkerInputSources,
  objectiveCriteria,
  verifyPlanCandidate,
  planReviewPacket,
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
  coverageObligations,
} from "../dist/qa.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { createTarget } from "./support/integration-fixture.mjs";
const Ajv = createRequire(import.meta.url)("ajv");
const body =
  '# Objective\n\n## Acceptance\n- Source-defined result exists.\n\n## Validation\n- `test -d .`\n\n## Worker implementation\nUse node:assert/strict and assert process.versions.node.split(".")[0] equals "24".\n';
const sources = [{ path: "OBJECTIVE", content: body }];
function request(extra = {}) {
  return {
    objective: body,
    compileContext: { objectiveNumber: 17, instructions: "" },
    baseSha: "a".repeat(40),
    sources,
    coverageObligations: coverageObligations(body, objectiveCriteria(body)),
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
    items: [item({ coverage: [entry()] })],
  };
  return {
    input,
    wire,
    value,
    conforms: new Ajv({ strict: false, allErrors: true }).compile(wire.schema),
  };
}

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
    ["qa", { kind: "integrated-ci", checkName: "required-check" }],
    [
      "qa",
      { kind: "published-ci", checkName: "required-check", dependencyIndex: 0 },
    ],
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
        category: "coverage",
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
    const { prompt, schema, value } = captured.at(-1);
    assert(
      prompt.includes(
        "source-required execution resource available before the owning item runs",
      ),
    );
    assert(
      prompt.includes(
        "configured native MCP capability do not by themselves authorize real/prepare",
      ),
    );
    assert(prompt.includes("retaining every later proof obligation"));
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
      "One independent review found these sourced defects",
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
        items: [item({ coverage: [entry()] })],
      };
      if (mode === "invalid") value.items[0].coverage[0].obligationIndex = 999;
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
  mode = "invalid";
  await assert.rejects(
    compileObjective(17, body, target.baseSha, target.checkout, model),
    (error) =>
      error instanceof MalformedPlannerOutput &&
      /obligationIndex/.test(error.message),
  );
});

test("completed SDK decoder failure enters the admitted bounded planning repair and never remains ambiguously submitted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-wire-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root);
  const calls = { compile: 0, diagnosis: 0, review: 0 };
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      let response;
      if (options.outputSchema.properties.contextId) {
        calls.compile++;
        const choices = JSON.parse(
          prompt.split("\nCompiler choices (JSON data):\n")[1],
        );
        response = {
          contextId: choices.contextId,
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
    authority: {
      schemaVersion: 1,
      actor: "fixture",
      reason: "One bounded planning-output correction",
      executionConsent: true,
      serviceConsent: false,
      objectives: [17],
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
      resources: { maxConcurrency: 1 },
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
    [],
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
  assert.equal(state.allowanceConsumption.planningRevisions, 1);
  assert.equal(state.planningRecovery.history.length, 1);
  assert.equal(state.planningRecovery.history[0].kind, "planning-output");
  assert(
    state.planningRecovery.history[0].invocations.every(
      (invocation) => invocation.resultDigest,
    ),
  );
});

test("aggregate choices derive the child join while preserving real QA semantics and final coverage", () => {
  const { input, wire, value, conforms } = setup();
  const aggregate = item({
    kind: "aggregate",
    id: "parent",
    children: ["implementation", "qa"],
    dependencies: ["implementation", "qa"],
    coverage: [entry()],
  });
  for (const field of [
    "acceptance",
    "ownedPaths",
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
    acceptance: [
      "The integrated negative control passes without mutating input.",
    ],
    coverage: [],
  });
  for (const field of [
    "ownedPaths",
    "sourceAssets",
    "expectedOutputRoles",
    "requiredLfsRoles",
    "minimumAssetSets",
  ])
    delete qa[field];
  value.items = [item(), qa, aggregate];
  assert(conforms(value), JSON.stringify(conforms.errors));
  const graph = wire.decode(value);
  assert.deepEqual(
    graph.items[2].acceptance,
    aggregateAcceptance({ id: "parent" }),
  );
  assert.deepEqual(graph.items[1].acceptance, qa.acceptance);
  assert.deepEqual(graph.coverage[0].proof, { kind: "final-review" });
  assert.equal(
    graph.coverage[0].source.text,
    input.coverageObligations[0].source.text,
  );
  // Final coverage never becomes an earlier parent criterion.
  assert(!graph.items[2].acceptance.includes(graph.coverage[0].source.text));
  const future = structuredClone(value);
  future.items[2].acceptance = [
    "Successful final Objective review proves the published check before parent acceptance.",
  ];
  assert.equal(conforms(future), false);
  assert.throws(() => wire.decode(future), /unexpected or missing fields/);
  const direct = structuredClone(graph);
  direct.coverage.push({
    ...coverageObligations(body, [
      "Independent integrated negative control",
    ])[0],
    itemId: "qa",
    proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
    environment: {
      kind: "local",
      readiness: "available",
      preparedBy: "",
      probe: "",
    },
  });
  assert.doesNotThrow(() =>
    validateGraph(direct, 17, input.baseSha, new Set(["OBJECTIVE"])),
  );
  direct.items[2].acceptance = future.items[2].acceptance;
  assert.throws(
    () => validateGraph(direct, 17, input.baseSha, new Set(["OBJECTIVE"])),
    /Aggregate acceptance/,
  );
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
