import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  compilePlan,
  compilerCitationChoices,
  validateCommandProvenance,
  validateGraph,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { coverageObligations, hydrateCoverageSources } from "../dist/qa.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  encodeCompilerWire,
  compilerRequest,
} from "./support/compiler-wire.mjs";
import { compilerWire } from "../dist/compiler-wire.js";
import { createTarget } from "./support/integration-fixture.mjs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const command = "test -d .";
const body = `# Objective\n\n## Acceptance\n- result.txt exists\n\n## Validation\n- \`${command}\`\n`;
const sources = [{ path: "OBJECTIVE", content: body }];
const obligations = coverageObligations(body, ["result.txt exists"]);

function graph(baseSha) {
  return withCoverage(
    { coverageObligations: obligations },
    {
      objective: 1,
      baseSha,
      items: [
        {
          id: "one",
          priority: 0,
          title: "One",
          goal: "Write result",
          brief: "Write result.txt",
          acceptance: ["result.txt exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "" }],
          children: [],
          dependencies: [],
          ownedPaths: ["result.txt"],
          resources: [],
          validation: [
            { command, provenance: "source-declared", source: "OBJECTIVE" },
          ],
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    },
  );
}
function request(baseSha) {
  return compilerRequest({
    objective: body,
    baseSha,
    sources,
    coverageObligations: obligations,
  });
}
function wire(input) {
  return encodeCompilerWire(
    input,
    compilerWire(request(input.baseSha), compilerCitationChoices(sources)).data,
  );
}
function validate(value, target) {
  hydrateCoverageSources(value, obligations);
  validateGraph(value, 1, target.baseSha, new Set(["OBJECTIVE"]));
  validateCommandProvenance(value, sources, target.checkout);
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-probe-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createTarget(root, { "checks.sh": `${command}\n` });
}
function transport(t, target) {
  let response;
  const calls = [];
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      calls.push({ prompt, schema: options.outputSchema });
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "answer",
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
  return {
    calls,
    async decode(value) {
      response = value;
      return model.generateStructured(request(target.baseSha));
    },
  };
}

test("actual Codex schema selects owning readiness commands", async (t) => {
  const target = await fixture(t);
  const sdk = transport(t, target);
  for (const kind of ["local", "real"]) {
    const value = graph(target.baseSha);
    value.coverage[0].environment = {
      kind,
      readiness: "available",
      probe: command,
      preparedBy: "",
    };
    const encoded = wire(value);
    assert.equal(
      encoded.items[0].coverage[0].environment.probeValidationIndex,
      0,
    );
    const decoded = await sdk.decode(encoded);
    assert.deepEqual(
      decoded.coverage[0].environment,
      value.coverage[0].environment,
    );
    validate(decoded, target);
  }
  const absent = await sdk.decode(wire(graph(target.baseSha)));
  assert.equal(absent.coverage[0].environment.probe, "");
  validate(absent, target);
  const schema = sdk.calls[0].schema;
  const conforms = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(conforms(wire(graph(target.baseSha))), true);
  assert.equal(conforms(graph(target.baseSha)), false);
  const environment =
    schema.properties.items.items.anyOf[0].properties.coverage.items.properties
      .environment;
  assert.equal(environment.anyOf.length, 2);
  for (const alternative of environment.anyOf) {
    const kind = alternative.properties.kind.enum[0];
    assert.deepEqual(
      alternative.properties.probeValidationIndex.type,
      kind === "real" ? "integer" : ["integer", "null"],
    );
    assert.equal(alternative.additionalProperties, false);
    assert.equal(alternative.properties.preparedBy.type, "string");
  }
  assert.match(sdk.calls[0].prompt, /before work/);
  assert.match(sdk.calls[0].prompt, /future result.*not a readiness probe/);
});

test("decoded base-observed probe may cite an unselected immutable file but cannot invent authority", async (t) => {
  const target = await fixture(t);
  const sdk = transport(t, target);
  const value = graph(target.baseSha);
  value.items[0].validation[0] = {
    command,
    provenance: "base-observed",
    source: "checks.sh",
  };
  value.coverage[0].environment.probe = command;
  value.coverage[0].environment.kind = "real";
  validate(await sdk.decode(wire(value)), target);
  value.items[0].validation[0].command = "test -f unavailable-secret";
  value.coverage[0].environment.probe = "test -f unavailable-secret";
  const decoded = await sdk.decode(wire(value));
  assert.throws(() => validate(decoded, target), /no exact/);
});

test("preparation requires an actual dependency and missing readiness remains a refusal", async (t) => {
  const target = await fixture(t);
  const sdk = transport(t, target);
  const value = graph(target.baseSha);
  value.items.push({
    ...structuredClone(value.items[0]),
    id: "prepare",
    ownedPaths: ["prepared.txt"],
  });
  value.items[0].dependencies = ["prepare"];
  value.coverage[0].environment = {
    kind: "real",
    readiness: "prepare",
    probe: command,
    preparedBy: "prepare",
  };
  validate(await sdk.decode(wire(value)), target);
  for (const [change, message] of [
    [{ preparedBy: "The operator prepared it" }, /authorized dependency/],
    [{ preparedBy: "not-a-dependency" }, /authorized dependency/],
    [{ readiness: "available", preparedBy: "prepare" }, /cannot be inferred/],
    [{ readiness: "missing", preparedBy: "" }, /Missing external prerequisite/],
    [
      { readiness: "available", preparedBy: "", probe: "" },
      /exact authorized readiness probe/,
    ],
  ]) {
    const invalid = structuredClone(value);
    Object.assign(invalid.coverage[0].environment, change);
    const decoded = await sdk.decode(wire(invalid));
    assert.throws(() => validate(decoded, target), message);
  }
});

test("Codex decoder rejects prose, invalid selectors, unknown owners and old or extra fields", async (t) => {
  const target = await fixture(t);
  const sdk = transport(t, target);
  const original = wire(graph(target.baseSha));
  await sdk.decode(original);
  const conforms = new Ajv({ allErrors: true }).compile(sdk.calls[0].schema);
  for (const index of [
    "test -d .",
    "Final review is available",
    -1,
    0.5,
    1,
    99,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const value = structuredClone(original);
    value.items[0].coverage[0].environment.probeValidationIndex = index;
    if (typeof index !== "number" || index < 0 || !Number.isInteger(index))
      assert.equal(conforms(value), false);
    await assert.rejects(sdk.decode(value), /probeValidationIndex/);
  }
  for (const mutate of [
    (value) => {
      value.items[0].coverage[0].itemId = "unknown";
    },
    (value) => {
      value.items[0].coverage[0].environment.probe = "test -d .";
    },
    (value) => {
      delete value.items[0].coverage[0].environment.probeValidationIndex;
    },
    (value) => {
      value.items[0].coverage[0].environment = "Use final review";
    },
  ]) {
    const value = structuredClone(original);
    mutate(value);
    await assert.rejects(sdk.decode(value), /fields|environment/);
  }
  const wrongOwner = structuredClone(original);
  wrongOwner.items.push({
    ...structuredClone(wrongOwner.items[0]),
    id: "other",
    validation: [],
  });
  wrongOwner.items[1].coverage = wrongOwner.items[0].coverage;
  wrongOwner.items[0].coverage = [];
  wrongOwner.items[1].coverage[0].environment.probeValidationIndex = 0;
  await assert.rejects(sdk.decode(wrongOwner), /probeValidationIndex/);
});

for (const phase of ["provider", "invalid-probe"]) {
  test(`failed sole revision at ${phase} retains the original graph, findings and cause with exactly three calls`, async (t) => {
    const target = await fixture(t);
    const calls = [];
    let original;
    const model = {
      async generateStructured() {
        calls.push("compile");
        if (calls.length === 1) {
          original = graph(target.baseSha);
          return original;
        }
        if (phase === "provider")
          throw new Error("Exact readiness revision failure");
        const changed = graph(target.baseSha);
        changed.items[0].brief =
          "This rejected revision must never replace the original";
        changed.coverage[0].environment.probe = "Final review is ready";
        return changed;
      },
      async reviewGraph(request) {
        calls.push("review");
        assert.equal(
          calls.length,
          2,
          "a failed revision must not reach another review",
        );
        return {
          packetId: request.reviewPacket.id,
          findings: [
            {
              evidenceIndices: [
                request.reviewPacket.evidence.findIndex(
                  (entry) => entry.path === "OBJECTIVE",
                ),
              ],
              detail: "The original graph needs an explicit readiness decision",
              question: "Which approved readiness command is required?",
            },
          ],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.deepEqual(calls, ["compile", "review", "compile"]);
    assert.equal(candidate.review.revisions, 1);
    assert.equal(candidate.review.status, "needs-human");
    assert.deepEqual(candidate.graph, original);
    assert.equal(candidate.review.findings.length, 1);
    assert.equal(
      candidate.review.findings[0].detail,
      "The original graph needs an explicit readiness decision",
    );
    assert.equal(
      candidate.review.findings[0].question,
      "Which approved readiness command is required?",
    );
    const cause =
      phase === "provider"
        ? /Exact readiness revision failure/
        : /Environment probe lacks command authority/;
    assert.match(candidate.review.failure.detail, cause);
    assert.match(candidate.review.failure.question, cause);
    assert.equal(candidate.commands[0].command, command);
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /review|accept|decision/i,
    );
  });
}
