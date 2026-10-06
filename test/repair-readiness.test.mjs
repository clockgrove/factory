import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import { consumption, resolveAutonomy } from "../dist/repair-policy.js";
import { parseFactoryState } from "../dist/state.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  CandidateValidationFailure,
  diagnoseWorkRepair,
} from "../dist/work-repair.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
  ScriptedPlanningModel,
} from "./support/integration-fixture.mjs";
import {
  actionableDiagnosis,
  diagnosisInput,
} from "./support/repair-diagnosis.mjs";

// Complete generic analogue of the retained contradictory answer. No private capture is shipped.
const conditionalAnswer = {
  diagnosis:
    "The operator-owned prerequisite failed. The implementation already satisfies its functional requirement. Restoration has not been established.",
  correction:
    "The operator restores the condition, then the controller admits the bounded repair from the accepted base. Reimplement only the owned result and run both unchanged commands. Workers must not restore the condition. Do not admit the repair while the known failing condition remains unchanged; stop if the same failure recurs.",
  decision: "repair",
  predecessor: "",
  path: "result.txt",
};

async function failedFixture(
  t,
  answer,
  {
    localDefect = false,
    content = "correct",
    delivery = "regular",
    adapter = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "factory-repair-ready-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const target = createTarget(root);
  const marker = join(root, "operator-ready");
  const functional = "test -s result.txt";
  const probe = localDefect
    ? "node -e \"process.exit(require('node:fs').readFileSync('result.txt','utf8') === 'correct' ? 0 : 23)\""
    : `node -e "process.exit(require('node:fs').existsSync('${marker}') ? 0 : 23)"`;
  const item = {
    id: "result",
    kind: "work",
    title: "result",
    goal: "Produce the required result",
    acceptance: ["The owned implementation and unchanged validation pass"],
    nonGoals: ["No operator prerequisite restoration or unrelated changes"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: ["result.txt"],
    resources: [],
    validation: [functional, probe].map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    })),
    brief: "Implement only result.txt",
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
  const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
  const body = `# Repair readiness\n## Acceptance\n- Produce the required owned result without changing operator conditions.\n- \`${functional}\`\n## Commands\n- \`${functional}\`\n- \`${probe}\`\n`;
  const config = factoryConfig(
    target.checkout,
    `example/readiness-${delivery}`,
    delivery,
    1,
  );
  config.autonomy = resolveAutonomy();
  const requests = [];
  const prompts = [];
  const schemas = [];
  const model = new ScriptedPlanningModel(graph, join(root, "planning.ndjson"));
  const generate = model.generateStructured.bind(model);
  const selection = { model: "gpt-6.1-sol", reasoningEffort: "high" };
  const renderer = new CodexPlanningModel(
    target.checkout,
    selection,
    selection,
  );
  if (adapter)
    t.mock.method(Codex.prototype, "startThread", () => ({
      runStreamed: async (prompt, options) => {
        prompts.push(prompt);
        schemas.push(options.outputSchema);
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "diagnosis",
                type: "agent_message",
                text: JSON.stringify(answer(requests.at(-1))),
              },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        };
      },
    }));
  model.generateStructured = async (request) => {
    if (request.purpose !== "diagnosis") return generate(request);
    requests.push(request);
    return adapter ? renderer.generateStructured(request) : answer(request);
  };
  const actions = {
    result: {
      files: [{ path: "result.txt", text: localDefect ? "wrong" : content }],
    },
  };
  const fixture = makeApplication({
    config,
    graph,
    objectiveBody: body,
    fakeRoot: join(root, "fake"),
    actions,
    planningModel: model,
  });
  try {
    await fixture.application.runObjective(1);
  } catch (error) {
    assert.ok(error instanceof CandidateValidationFailure);
  }
  const state = readState(config.repository, 1);
  const failed = state.work.result;
  assert.equal(failed.status, "failed");
  assert.deepEqual(
    failed.failedValidation.evidence.commands.map(
      ({ index, passed, exitCode }) => ({ index, passed, exitCode }),
    ),
    [
      { index: 0, passed: true, exitCode: 0 },
      { index: 1, passed: false, exitCode: 23 },
    ],
  );
  assert.equal(consumption(state).implementationRepairs, 1);
  assert.equal(
    readEvents(fixture.eventsPath).filter((event) => event.type === "start")
      .length,
    1,
  );
  assert.equal(failed.recovery.history, undefined);
  return {
    root,
    target,
    marker,
    config,
    item,
    state,
    fixture,
    actions,
    requests,
    prompts,
    schemas,
  };
}

test("actual rendered schema/adapter refuses the complete contradictory legacy response without another attempt", async (t) => {
  const f = await failedFixture(t, () => conditionalAnswer, { adapter: true });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  const input = diagnosisInput(request);
  assert.equal(new Ajv().compile(request.schema)(conditionalAnswer), false);
  assert.deepEqual(
    input.repairEvidence[1].record,
    f.state.work.result.failedValidation,
  );
  const owned = input.repairEvidence.find(
    (entry) => entry.path === "result.txt",
  );
  assert.equal(owned.content, "correct");
  assert.equal(owned.complete, true);
  assert.ok(f.prompts.length, f.state.work.result.recovery.failure.decision);
  assert.ok(f.prompts[0].includes(JSON.stringify(input.repairEvidence)));
  assert.deepEqual(f.schemas[0], request.schema);
  assert.ok(f.schemas[0].required.includes("readiness"));
  assert.equal(f.state.work.result.recovery.phase, "stopped");
  assert.match(
    f.state.work.result.recovery.failure.decision,
    /What concrete correction or operator prerequisite/,
  );
  parseFactoryState(f.state, f.config.repository, 1);
  // Restart neither diagnoses again nor grants an implementation attempt.
  await f.fixture.application.runObjective(1);
  assert.equal(f.requests.length, 1);
  assert.equal(
    readEvents(f.fixture.eventsPath).filter((event) => event.type === "start")
      .length,
    1,
  );
  assert.equal(
    consumption(readState(f.config.repository, 1)).implementationRepairs,
    1,
  );
});

for (const [label, change, question] of [
  [
    "operator required",
    {
      readiness: "operator-required",
      question: "Has the operator restored the declared condition?",
      prerequisites: [
        {
          status: "unmet",
          question: "Has the operator restored the declared condition?",
        },
      ],
    },
    /restored/,
  ],
  [
    "unknown readiness",
    {
      readiness: "unknown",
      question:
        "Which original receipt establishes that the condition is ready?",
    },
    /receipt/,
  ],
  [
    "actionable with unmet prerequisite",
    {
      prerequisites: [
        {
          status: "unmet",
          question: "Has the operator restored the condition?",
        },
      ],
    },
    /restored/,
  ],
  ["omitted failed command", { commandAssessments: [] }, /omits or misbinds/],
  [
    "passed command as failure",
    { commandAssessments: [{ commandIndex: 0, disposition: "owned-change" }] },
    /omits or misbinds/,
  ],
  [
    "failed operator command",
    {
      commandAssessments: [
        { commandIndex: 1, disposition: "operator-required" },
      ],
    },
    /operator prerequisite/,
  ],
  [
    "failed unknown command",
    { commandAssessments: [{ commandIndex: 1, disposition: "unknown" }] },
    /operator prerequisite/,
  ],
  ["missing original grounding", { evidenceIndices: [1] }, /grounding/],
  [
    "missing owned candidate grounding",
    { evidenceIndices: [0, 1] },
    /missing or truncated/,
  ],
  ["unowned change", { path: "operator.txt" }, /owned file/],
])
  test(`repair decision with ${label} waits under the same charge`, async (t) => {
    const f = await failedFixture(t, (request) =>
      actionableDiagnosis(request, { ...conditionalAnswer, ...change }),
    );
    assert.match(f.state.work.result.recovery.failure.decision, question);
    assert.equal(f.state.work.result.recovery.correction, undefined);
    assert.equal(f.requests.length, 1);
    parseFactoryState(f.state, f.config.repository, 1);
  });

test("truncated owned candidate content cannot establish readiness", async (t) => {
  const f = await failedFixture(t, (request) => actionableDiagnosis(request), {
    content: "x".repeat(17_000),
  });
  const file = diagnosisInput(f.requests[0]).repairEvidence.find(
    (entry) => entry.path === "result.txt",
  );
  assert.equal(file.complete, false);
  assert.match(
    f.state.work.result.recovery.failure.decision,
    /missing or truncated/,
  );
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery}: an owned defect admits once after a saved-ready restart, preserving original receipts`, async (t) => {
    const f = await failedFixture(
      t,
      () => ({
        decision: "operator",
        question: "What owned correction resolves the failed result?",
      }),
      { localDefect: true, delivery },
    );
    const original = structuredClone(f.state.work.result);
    const charges = structuredClone(f.state.charges);
    let calls = 0;
    let saved;
    const due = JSON.parse(JSON.stringify(f.state));
    const args = {
      state: due,
      item: f.item,
      checkout: f.target.checkout,
      model: {
        generateStructured: async (request) => {
          calls++;
          const answer = actionableDiagnosis(request);
          assert.equal(new Ajv().compile(request.schema)(answer), true);
          return answer;
        },
      },
      save: () => {
        saved = structuredClone(due);
      },
      stopped: () => due.work.result.recovery.phase === "ready",
    };
    assert.equal(await diagnoseWorkRepair(args), false);
    assert.equal(calls, 1);
    assert.equal(saved.work.result.recovery.phase, "ready");
    parseFactoryState(saved, f.config.repository, 1);
    for (const [key, value] of [
      ["attemptId", "other"],
      ["ownedPath", "outside.txt"],
      ["graphDigest", "a".repeat(64)],
      ["validationCaptureDigest", "b".repeat(64)],
      ["contextDigest", "c".repeat(64)],
    ]) {
      const bad = structuredClone(saved);
      bad.work.result.recovery.correction.readiness[key] = value;
      assert.throws(
        () => parseFactoryState(bad, f.config.repository, 1),
        /readiness/,
      );
    }
    const legacy = structuredClone(saved);
    delete legacy.work.result.recovery.correction.readiness;
    parseFactoryState(legacy, f.config.repository, 1);
    assert.equal(
      await diagnoseWorkRepair({
        ...args,
        state: legacy,
        stopped: () => false,
      }),
      false,
    );
    assert.equal(legacy.work.result.status, "failed");
    assert.match(
      legacy.work.result.recovery.failure.decision,
      /readiness is unavailable/,
    );
    assert.deepEqual(legacy.charges, charges);
    const changed = structuredClone(saved);
    changed.work.result.recovery.correction.readiness.inputDigest = "d".repeat(
      64,
    );
    assert.throws(
      () => parseFactoryState(changed, f.config.repository, 1),
      /readiness/,
    );
    assert.equal(
      await diagnoseWorkRepair({
        ...args,
        state: changed,
        stopped: () => false,
      }),
      false,
    );
    assert.match(
      changed.work.result.recovery.failure.decision,
      /readiness does not bind/,
    );
    assert.deepEqual(changed.charges, charges);
    assert.equal(calls, 1);
    const resumed = JSON.parse(JSON.stringify(saved));
    assert.equal(
      await diagnoseWorkRepair({
        ...args,
        state: resumed,
        stopped: () => false,
        save: () => {},
      }),
      true,
    );
    assert.equal(calls, 1);
    assert.deepEqual(resumed.charges, charges);
    assert.deepEqual(
      resumed.work.result.recovery.history[0].work.failedValidation,
      original.failedValidation,
    );
    assert.deepEqual(
      resumed.work.result.recovery.history[0].failure,
      original.recovery.failure,
    );
    parseFactoryState(resumed, f.config.repository, 1);
    for (const records of ["current", "archived", "both"]) {
      // The records are the real supported admission's retained attempt,
      // with independent JSON copies as they have in persisted state.
      const altered = JSON.parse(JSON.stringify(resumed));
      if (records !== "archived")
        altered.work.result.recovery.correction.readiness.inputDigest =
          "e".repeat(64);
      if (records !== "current")
        altered.work.result.recovery.history[0].correction.readiness.inputDigest =
          "e".repeat(64);
      assert.throws(
        () => parseFactoryState(altered, f.config.repository, 1),
        /readiness/,
        records,
      );
      assert.deepEqual(altered.charges, charges);
      assert.deepEqual(
        altered.work.result.recovery.history[0].work.failedValidation,
        original.failedValidation,
      );
      assert.deepEqual(
        altered.work.result.recovery.history[0].failure,
        original.recovery.failure,
      );
    }
    saveState(statePath(f.config.repository, 1), resumed);
    f.actions.result.files[0].text = "correct";
    const completed = await f.fixture.application.runObjective(1);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(consumption(completed).implementationRepairs, 1);
    assert.equal(
      readEvents(f.fixture.eventsPath).filter((event) => event.type === "start")
        .length,
      2,
    );
    assert.deepEqual(
      completed.work.result.recovery.history[0].work.failedValidation,
      original.failedValidation,
    );
    parseFactoryState(completed, f.config.repository, 1);
  });

test("missing legacy validation facts wait; explicit operator correction retains declared provenance", async (t) => {
  const f = await failedFixture(t, () => ({
    decision: "operator",
    question: "Has the operator restored the condition?",
  }));
  const legacy = structuredClone(f.state);
  delete legacy.work.result.failedValidation;
  delete legacy.work.result.recovery.failure.validationCaptureDigest;
  parseFactoryState(legacy, f.config.repository, 1);
  assert.equal(
    await diagnoseWorkRepair({
      state: legacy,
      item: f.item,
      checkout: f.target.checkout,
      model: {
        generateStructured: async (request) => actionableDiagnosis(request),
      },
      save: () => {},
      stopped: () => false,
    }),
    false,
  );
  assert.match(
    legacy.work.result.recovery.failure.decision,
    /outcomes are unavailable/,
  );
  const correction = {
    kind: "implementation",
    failureDigest: f.state.work.result.recovery.failure.digest,
    diagnosis: "The operator restores the declared condition",
    correction:
      "The operator has restored the condition; implement only the original owned result",
    actor: "fixture-operator",
  };
  assert.throws(
    () =>
      f.fixture.application.repairWorkItem(1, {
        item: "result",
        correction: { ...correction, actor: "factory-controller" },
      }),
    /provenance/,
  );
  writeFileSync(f.marker, "ready");
  f.fixture.application.repairWorkItem(1, { item: "result", correction });
  const ready = readState(f.config.repository, 1);
  assert.equal(ready.work.result.recovery.correction.readiness, undefined);
  assert.equal(ready.work.result.recovery.correction.actor, "fixture-operator");
  const completed = await f.fixture.application.runObjective(1);
  assert.equal(completed.finalValidation.passed, true);
  assert.equal(consumption(completed).implementationRepairs, 1);
});
