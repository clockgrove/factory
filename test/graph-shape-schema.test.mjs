import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  graphSchema,
  graphSchemaForSources,
  validateCommandProvenance,
  validateGraph as validateCanonicalGraph,
} from "../dist/compiler.js";
import { coverageObligations, hydrateCoverageSources } from "../dist/qa.js";
import { createTarget } from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { encodeCodexReadiness } from "./support/codex-readiness.mjs";

function validateGraph(graph, ...args) {
  const canonical = structuredClone(graph);
  hydrateCoverageSources(
    canonical,
    coverageObligations(sources[0].content, ["Public result exists."]),
  );
  return validateCanonicalGraph(canonical, ...args);
}

// Use the existing locked ESLint development dependency's JSON-schema validator.
const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true });
const baseSha = "a".repeat(40);
const sources = [
  { path: "OBJECTIVE", content: "## Acceptance\nPublic result exists.\n" },
];
const requiredArrays = ["acceptance", "nonGoals", "citations"];
const requiredStrings = ["title", "goal", "brief"];
const optionalArrays = [
  "children",
  "dependencies",
  "resources",
  "validation",
  "sourceAssets",
  "expectedOutputRoles",
  "requiredLfsRoles",
];

function graph(indexed = false) {
  const result = withCoverage(
    {
      coverageObligations: coverageObligations(sources[0].content, [
        "Public result exists.",
      ]),
    },
    {
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
          citations: indexed
            ? [{ choiceIndex: 0 }]
            : [{ path: "OBJECTIVE", heading: "" }],
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
    },
  );
  result.coverage[0].oracle = {
    kind: "controller",
    reference: "post-integration-hydration",
    targetItem: "",
  };
  return indexed ? encodeCodexReadiness(result) : result;
}

function emptyCases(indexed = false) {
  return [
    ["items", { ...graph(indexed), items: [] }],
    ...[...requiredArrays, ...requiredStrings].map((field) => {
      const value = graph(indexed);
      value.items[0][field] = requiredArrays.includes(field) ? [] : "";
      return [field, value];
    }),
  ];
}

function assertBounds(schema) {
  const strictObjects = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.properties)
      assert.deepEqual(
        [...value.required].sort(),
        Object.keys(value.properties).sort(),
      );
    for (const child of Object.values(value)) strictObjects(child);
  };
  strictObjects(schema);
  assert.deepEqual(schema.properties.items.items.properties.kind.enum, [
    "work",
    "qa",
    "aggregate",
  ]);

  assert.equal(schema.properties.items.minItems, 1);
  assert.equal(schema.properties.items.maxItems, undefined);
  const properties = schema.properties.items.items.properties;
  for (const field of requiredArrays) {
    assert.equal(properties[field].minItems, 1, field);
    assert.equal(properties[field].maxItems, undefined, field);
  }
  for (const field of requiredStrings)
    assert.equal(properties[field].minLength, 1, field);
  for (const field of optionalArrays)
    assert.equal(properties[field].minItems, undefined, field);
  for (const field of ["acceptance", "nonGoals"])
    assert.equal(properties[field].items.minLength, undefined, field);
  assert.equal(properties.id.minLength, undefined);
  assert.equal(properties.id.pattern, undefined);
  assert.equal(properties.dependencies.items.minLength, undefined);
  for (const entry of properties.validation.items.anyOf ?? [
    properties.validation.items,
  ])
    assert.equal(entry.properties.command.minLength, undefined);
  assert.equal(properties.ownedPaths.items.minLength, undefined);
}

function assertCoverageAndSources(schema, indexed, sourceAware) {
  const conforms = ajv.compile(schema);
  for (const kind of ["command", "semantic", "controller", "ci"]) {
    const value = graph(indexed);
    value.coverage[0].oracle = { kind, reference: "proof", targetItem: "" };
    assert.equal(conforms(value), true, `${kind} without CI target`);
    value.coverage[0].oracle.targetItem = "policy";
    assert.equal(conforms(value), kind === "ci", `${kind} with CI target`);
  }
  if (!sourceAware) return;
  for (const source of [
    "OBJECTIVE",
    "OBJECTIVE#Acceptance",
    "unselected.txt",
  ]) {
    for (const provenance of ["source-declared", "base-observed"]) {
      const value = graph(indexed);
      value.items[0].validation = [
        { command: "test -s result.txt", provenance, source },
      ];
      assert.equal(
        conforms(value),
        provenance === "base-observed" || source === "OBJECTIVE",
        `${provenance} ${source}`,
      );
    }
  }
}

test("coverage schema constrains CI-only targets and exact source-declared identities", () => {
  assertCoverageAndSources(graphSchema, false, false);
  assertCoverageAndSources(graphSchemaForSources(sources), false, true);
});

test("generic and source-specific schemas reject provider-supported required-shape constraints", () => {
  for (const schema of [graphSchema, graphSchemaForSources(sources)]) {
    assertBounds(schema);
    const conforms = ajv.compile(schema);
    assert.equal(conforms(graph()), true);
    for (const [field, value] of emptyCases()) {
      assert.equal(conforms(value), false, field);
      assert.ok(
        conforms.errors.some(
          (error) =>
            error.keyword ===
            (requiredStrings.includes(field) ? "minLength" : "minItems"),
        ),
        field,
      );
      assert.throws(
        () => validateGraph(value, 1, baseSha, new Set(["OBJECTIVE"])),
        field === "items"
          ? /at least one Work Item/
          : /lacks acceptance, non-goals, ownership, or source citations/,
      );
    }
    for (const field of schema.properties.items.items.required) {
      const value = graph();
      delete value.items[0][field];
      assert.equal(conforms(value), false, `missing ${field}`);
    }
  }
});

test("required shape does not constrain legitimate empty arrays, whole-source headings or text entries", () => {
  const ordinary = graph();
  for (const field of optionalArrays)
    assert.deepEqual(ordinary.items[0][field], []);
  const textEntries = graph();
  textEntries.items[0].acceptance = [""];
  textEntries.items[0].nonGoals = [""];
  textEntries.coverage[0].oracle.reference = "Public result exists.";
  textEntries.coverage = graph().coverage;
  const media = graph();
  media.items[0].sourceAssets = [
    {
      kind: "repository",
      path: "assets/source.png",
      role: "image",
      mediaType: "image/png",
      visibility: "repository",
    },
  ];
  media.items[0].expectedOutputRoles = ["image"];
  media.items[0].minimumAssetSets = 2;
  media.items[0].requiredLfsRoles = ["image"];
  for (const schema of [graphSchema, graphSchemaForSources(sources)]) {
    const conforms = ajv.compile(schema);
    for (const value of [ordinary, textEntries, media]) {
      assert.equal(conforms(value), true, JSON.stringify(conforms.errors));
      validateGraph(value, 1, baseSha, new Set(["OBJECTIVE"]));
      assert.equal(value.items[0].citations[0].heading, "");
    }
  }
});

test("production Codex indexed schema retains all lower bounds and decoder cannot waive deterministic guards", async () => {
  const original = Codex.prototype.startThread;
  let response;
  const captured = [];
  Codex.prototype.startThread = function () {
    return {
      id: "scripted-public-schema",
      async runStreamed(_prompt, options) {
        captured.push(options.outputSchema);
        async function* events() {
          yield { type: "thread.started", thread_id: "scripted-public-schema" };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              id: "public-graph",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          };
        }
        return { events: events() };
      },
    };
  };
  try {
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
    const model = new CodexPlanningModel(
      "/unused-no-target",
      selection,
      selection,
    );
    const request = {
      objective: "Public synthetic schema regression",
      baseSha,
      sources,
      schema: graphSchemaForSources(sources),
    };
    response = graph(true);
    const valid = await model.generateStructured(request);
    const schema = captured[0];
    assertBounds(schema);
    assertCoverageAndSources(schema, true, true);
    assert.deepEqual(
      schema.properties.items.items.properties.citations.items.properties
        .choiceIndex,
      {
        type: "integer",
        minimum: 0,
        maximum: 1,
        description:
          "Exact zero-based index from the supplied citation choice list.",
      },
    );
    const conforms = ajv.compile(schema);
    assert.equal(conforms(response), true);
    assert.deepEqual(valid.items[0].citations, [
      { path: "OBJECTIVE", heading: "" },
    ]);
    validateGraph(valid, 1, baseSha, new Set(["OBJECTIVE"]));
    for (const [field, value] of emptyCases(true)) {
      response = value;
      assert.equal(conforms(response), false, field);
      // The scripted transport deliberately ignores schema. Runtime must still refuse.
      if (field === "items") {
        await assert.rejects(
          model.generateStructured(request),
          /readiness probe owner/,
        );
        continue;
      }
      const decoded = await model.generateStructured(request);
      assertBounds(captured.at(-1));
      assert.throws(
        () => validateGraph(decoded, 1, baseSha, new Set(["OBJECTIVE"])),
        field === "items"
          ? /at least one Work Item/
          : /lacks acceptance, non-goals, ownership, or source citations/,
      );
    }
    for (const [mutate, expected] of [
      [
        (value) => {
          value.coverage[0].oracle.targetItem = "policy";
        },
        /Only CI coverage/,
      ],
      [
        (value) => {
          value.items[0].validation = [
            {
              command: "test -s result.txt",
              provenance: "source-declared",
              source: "OBJECTIVE#Acceptance",
            },
          ];
        },
        /command provenance/,
      ],
    ]) {
      response = graph(true);
      mutate(response);
      assert.equal(conforms(response), false);
      const decoded = await model.generateStructured(request);
      assert.throws(
        () => validateGraph(decoded, 1, baseSha, new Set(["OBJECTIVE"])),
        expected,
      );
    }
    response = graph(true);
    response.items[0].acceptance = [""];
    response.items[0].nonGoals = [""];
    assert.equal(conforms(response), true);
    validateGraph(
      await model.generateStructured(request),
      1,
      baseSha,
      new Set(["OBJECTIVE"]),
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("provider schema avoids unsupported conditionals while runtime rejects empty implementation ownership", () => {
  for (const schema of [graphSchema, graphSchemaForSources(sources)]) {
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
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
    const value = graph();
    value.items[0].ownedPaths = [];
    assert.equal(ajv.compile(schema)(value), true);
    assert.throws(
      () => validateGraph(value, 1, baseSha, new Set(["OBJECTIVE"])),
      /ownership/,
    );
  }
});

test("source schema preserves unselected baseline command files and runtime literal checks", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-schema-provenance-"));
  try {
    const target = createTarget(root, { "checks.sh": "test -s result.txt\n" });
    const commandSources = [
      ...sources,
      {
        path: "docs/plan.md",
        heading: "Checks",
        content: "## Checks\n- test -s result.txt\n",
      },
      {
        path: "docs/plan.md",
        heading: "Other",
        content: "## Other\nAdditional context\n",
      },
    ];
    const conforms = ajv.compile(graphSchemaForSources(commandSources));
    for (const [provenance, source] of [
      ["base-observed", "checks.sh"],
      ["source-declared", "docs/plan.md"],
    ]) {
      const value = graph();
      value.baseSha = target.baseSha;
      value.items[0].validation = [
        { command: "test -s result.txt", provenance, source },
      ];
      assert.equal(conforms(value), true);
      assert.doesNotThrow(() =>
        validateCommandProvenance(value, commandSources, target.checkout),
      );
      value.items[0].validation[0].command = "test -s invented.txt";
      assert.throws(
        () => validateCommandProvenance(value, commandSources, target.checkout),
        /no exact/,
      );
    }
    const bad = graph();
    bad.baseSha = target.baseSha;
    bad.items[0].validation = [
      {
        command: "test -s result.txt",
        provenance: "source-declared",
        source: "docs/plan.md#Checks",
      },
    ];
    assert.equal(conforms(bad), false);
    assert.throws(
      () => validateCommandProvenance(bad, commandSources, target.checkout),
      /no exact/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
