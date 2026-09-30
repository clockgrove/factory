import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  compilerCitationChoices,
  validateCommandProvenance,
  validateGraph,
} from "../dist/compiler.js";
import { compilerWire } from "../dist/compiler-wire.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../dist/controller-capabilities.js";
import { coverageObligations } from "../dist/qa.js";
import { createTarget } from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { encodeCompilerWire } from "./support/compiler-wire.mjs";
const Ajv = createRequire(import.meta.url)("ajv");
const ajv = new Ajv({ allErrors: true });
const baseSha = "a".repeat(40);
const sources = [
  { path: "OBJECTIVE", content: "## Acceptance\nPublic result exists.\n" },
];
function request(selected = sources, base = baseSha) {
  return {
    objective: sources[0].content,
    baseSha: base,
    sources: selected,
    compileContext: { objectiveNumber: 1, instructions: "" },
    coverageObligations: coverageObligations(sources[0].content, [
      "Public result exists.",
    ]),
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
  };
}
function graph() {
  return withCoverage(request(), {
    objective: 1,
    baseSha,
    items: [
      {
        id: "policy",
        priority: 0,
        title: "Public policy",
        goal: "Create public result",
        brief: "Create only result.txt",
        acceptance: ["Public result exists."],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE", heading: "" }],
        children: [],
        dependencies: [],
        ownedPaths: ["result.txt"],
        resources: [],
        validation: [],
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  });
}
function wireFor(req = request()) {
  return compilerWire(req, compilerCitationChoices(req.sources));
}
function assertSchema(schema) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.properties)
      assert.deepEqual(
        [...value.required].sort(),
        Object.keys(value.properties).sort(),
      );
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        [
          "not",
          "allOf",
          "if",
          "then",
          "else",
          "dependentRequired",
          "dependentSchemas",
        ].includes(key),
        false,
        key,
      );
      visit(child);
    }
  };
  visit(schema);
  assert.equal(schema.properties.items.minItems, 1);
  assert.equal(schema.properties.items.maxItems, undefined);
  for (const variant of schema.properties.items.items.anyOf) {
    const aggregate = variant.properties.kind.enum[0] === "aggregate";
    assert.equal("acceptance" in variant.properties, !aggregate);
    assert.equal(variant.required.includes("acceptance"), !aggregate);
    for (const field of [
      ...(aggregate ? [] : ["acceptance"]),
      "nonGoals",
      "citations",
    ]) {
      assert.equal(variant.properties[field].minItems, 1);
      assert.equal(variant.properties[field].maxItems, undefined);
    }
    for (const field of ["title", "goal", "brief"])
      assert.equal(variant.properties[field].minLength, 1);
  }
}
test("actual Codex schema preserves required shape and deterministic guards", async (t) => {
  const req = request();
  let response;
  let schema;
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(_prompt, options) {
      schema = options.outputSchema;
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
  const model = new CodexPlanningModel(
    "/unused",
    { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    { model: "gpt-5.6-sol", reasoningEffort: "medium" },
  );
  const wire = wireFor(req);
  response = encodeCompilerWire(graph(), wire.data);
  const decoded = await model.generateStructured(req);
  assertSchema(schema);
  const conforms = ajv.compile(schema);
  assert.equal(conforms(response), true);
  validateGraph(decoded, 1, baseSha, new Set(["OBJECTIVE"]));
  assert.deepEqual(decoded.items[0].citations, [
    { path: "OBJECTIVE", heading: "" },
  ]);
  for (const field of [
    "items",
    "acceptance",
    "nonGoals",
    "citations",
    "title",
    "goal",
    "brief",
  ]) {
    response = encodeCompilerWire(graph(), wire.data);
    if (field === "items") response.items = [];
    else
      response.items[0][field] = ["title", "goal", "brief"].includes(field)
        ? ""
        : [];
    assert.equal(conforms(response), false, field);
    await assert.rejects(
      async () =>
        validateGraph(
          await model.generateStructured(req),
          1,
          baseSha,
          new Set(["OBJECTIVE"]),
        ),
      /at least one|requires at least one|needs citations|nonempty|lacks acceptance/,
    );
  }
  for (const field of schema.properties.items.items.anyOf[0].required) {
    response = encodeCompilerWire(graph(), wire.data);
    delete response.items[0][field];
    assert.equal(conforms(response), false, field);
    await assert.rejects(model.generateStructured(req), /fields|kind/);
  }
});
test("current schema preserves legitimate empty arrays and text entries, with runtime ownership refusal", () => {
  const wire = wireFor();
  const conforms = ajv.compile(wire.schema);
  for (const mutate of [
    () => {},
    (value) => {
      value.items[0].acceptance = [""];
      value.items[0].nonGoals = [""];
    },
    (value) => {
      value.items[0].sourceAssets = [
        {
          kind: "repository",
          path: "assets/source.png",
          role: "image",
          mediaType: "image/png",
          visibility: "repository",
        },
      ];
      value.items[0].expectedOutputRoles = ["image"];
      value.items[0].minimumAssetSets = 2;
      value.items[0].requiredLfsRoles = ["image"];
    },
  ]) {
    const value = graph();
    mutate(value);
    const encoded = encodeCompilerWire(value, wire.data);
    assert.equal(conforms(encoded), true, JSON.stringify(conforms.errors));
    validateGraph(wire.decode(encoded), 1, baseSha, new Set(["OBJECTIVE"]));
  }
  const value = graph();
  value.items[0].ownedPaths = [];
  const encoded = encodeCompilerWire(value, wire.data);
  assert.equal(conforms(encoded), true);
  assert.throws(
    () =>
      validateGraph(wire.decode(encoded), 1, baseSha, new Set(["OBJECTIVE"])),
    /ownership/,
  );
});
test("source-line selections and unselected base-observed files retain exact command authority", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-schema-provenance-"));
  try {
    const target = createTarget(root, { "checks.sh": "test -s result.txt\n" });
    const selected = [
      ...sources,
      {
        path: "docs/plan.md",
        heading: "Checks",
        content: "## Checks\n- test -s result.txt\n",
      },
    ];
    const wire = wireFor(request(selected, target.baseSha));
    const conforms = ajv.compile(wire.schema);
    for (const [provenance, source] of [
      ["base-observed", "checks.sh"],
      ["source-declared", "docs/plan.md"],
    ]) {
      const value = graph();
      value.baseSha = target.baseSha;
      value.items[0].validation = [
        { command: "test -s result.txt", provenance, source },
      ];
      const encoded = encodeCompilerWire(value, wire.data);
      assert.equal(conforms(encoded), true);
      const decoded = wire.decode(encoded);
      validateCommandProvenance(decoded, selected, target.checkout);
      decoded.items[0].validation[0].command = "test -s invented.txt";
      assert.throws(
        () => validateCommandProvenance(decoded, selected, target.checkout),
        /no exact/,
      );
    }
    const invalid = encodeCompilerWire(graph(), wire.data);
    invalid.items[0].validation = [
      { kind: "source-line", sourceIndex: 99, lineIndex: 0 },
    ];
    assert.equal(conforms(invalid), false);
    assert.throws(() => wire.decode(invalid), /sourceIndex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
