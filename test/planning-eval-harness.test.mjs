import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { planningSources } from "../dist/compiler.js";
import { validateConfig } from "../dist/index.js";
import {
  loadCases,
  materializeFixture,
  prepareCheckout,
} from "../scripts/eval-planning/cases.mjs";
import {
  CODEX_JUDGE_CONFIG,
  decodeJudge,
  JUDGE_DIMENSIONS,
  judgeInput,
  loadJudge,
  loadJudges,
  providerContext,
  runJudge,
} from "../scripts/eval-planning/judge.mjs";
import {
  ciCheckNames,
  criticalPath,
  expectation,
  finalReviewInsteadOfCommand,
  firstTry,
  proofKinds,
  requiredCommandLine,
  workflowCheckNames,
} from "../scripts/eval-planning/metrics.mjs";
import { DEFECTS, planVariants } from "../scripts/eval-planning/mutations.mjs";
import {
  compareReports,
  reviewRunMetrics,
  summarizePlanRuns,
  summarizeReviewRuns,
} from "../scripts/eval-planning/report.mjs";
import {
  loadReviewFixtures,
  prepareVariants,
} from "../scripts/eval-planning/review.mjs";
import {
  byCluster,
  clusteredRate,
  cohensKappa,
  holm,
  pairedBootstrap,
  signFlipTest,
  wilson,
} from "../scripts/eval-planning/stats.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * Frozen judges: a new judge is a new file; these digests never change. A
 * digest covers the spec, prompt, schema, input builder and provider system
 * prompt, so editing any of them fails here.
 */
const FROZEN_JUDGES = {
  "strict-rubric-v1-claude":
    "67e2905f15a5a41a87ca35de2d91fa813551bc28bf071f4c8fc61677be20c30c",
  "strict-rubric-v1-codex":
    "e9388e9240f3517faf890bbedb91643f040b25616703c5fee74aef3a2142d997",
};

/** Fixture commits are the same on every machine. */
const FIXTURE_COMMITS = {
  "node-lib": "0352589ab58ba7bdd7d107cb57177115b5e1a327",
  "media-site": "7186b56a9183a47e93c2ef83f5f4a26b976b2112",
  "pnpm-workspace": "922895b31ceaa71edbe065ea3e1284707c1566e4",
};

const config = {
  schemaVersion: 1,
  repository: "example/planning-eval",
  checkout: "/unused",
  planning: {
    kind: "codex-sdk",
    planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    reviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  },
  execution: {
    kind: "local",
    concurrency: 2,
    harness: {
      kind: "codex-sdk",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
  },
  delivery: { kind: "regular" },
  contentStore: { kind: "local" },
  policy: { network: "off", allowedSecretNames: [], deployments: "denied" },
};

function authored() {
  return {
    requiredPreIntegrationChecks: [
      {
        checkName: "unit-tests",
        source: { path: "CONTRIBUTING.md", text: "x" },
      },
    ],
    items: [
      {
        id: "a",
        acceptance: ["a works", "a rejects a non-integer"],
        dependencies: [],
        ownedPaths: ["src/a.mjs", "test/a.test.mjs"],
        validation: [
          {
            command: "node check.mjs a",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
          {
            command: "npm test",
            provenance: "base-observed",
            source: "package.json",
          },
        ],
        brief: "Write src/a.mjs and test/a.test.mjs.",
      },
      {
        id: "b",
        acceptance: ["b works"],
        dependencies: ["a"],
        ownedPaths: ["src/b.mjs"],
        validation: [
          {
            command: "node check.mjs b",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: "Write src/b.mjs.",
      },
    ],
    coverage: [
      {
        criterion: 0,
        itemId: "a",
        proof: { kind: "result-command", validationIndex: 0 },
      },
      {
        criterion: 1,
        itemId: "a",
        proof: { kind: "result-command", validationIndex: 1 },
      },
      {
        criterion: 2,
        itemId: "b",
        proof: { kind: "result-command", validationIndex: 0 },
      },
      {
        criterion: 3,
        itemId: "a",
        proof: { kind: "result-semantic", acceptanceIndex: 1 },
      },
    ],
  };
}

const workerTest = {
  command: "npm test",
  provenance: "base-observed",
  source: "package.json",
  directory: "test/",
};

/** Objective criteria for authored(): criterion 1 is exactly a command line. */
const context = {
  native: true,
  workerTest,
  sourceText: "unit-tests",
  criteria: [
    "`node check.mjs a` passes",
    "`npm test`",
    "`node check.mjs b` passes",
    "`a` throws for a non-integer",
  ],
  finalCommands: ["node check.mjs a", "node check.mjs b"],
  isCommand: (command) =>
    ["node check.mjs a", "node check.mjs b", "npm test"].includes(command),
};

test("each seeded defect changes exactly its rule in the authored plan", () => {
  const graph = authored();
  const variants = planVariants(graph, context);
  assert.deepEqual(
    variants.map((variant) => variant.variant),
    ["good", ...DEFECTS.map((defect) => defect.id)],
  );
  assert.deepEqual(graph, authored(), "the input plan is not mutated");
  const by = Object.fromEntries(
    variants.map((variant) => [variant.variant, variant]),
  );
  assert.deepEqual(by.good.graph, authored());

  assert.equal(
    by["invented-ci-name"].graph.requiredPreIntegrationChecks[0].checkName,
    "ci / build-and-test",
  );
  assert.match(
    by["acceptance-needs-own-merge"].graph.items[0].acceptance.at(-1),
    /merged into main/,
  );
  const native = by["native-dependency-assumed-merged"];
  assert.equal(native.itemId, "b");
  assert.match(native.graph.items[1].brief, /after `a` has merged/);

  // Only the criterion that is exactly a command line outside Final
  // validation loses its command to final review.
  const replaced = by["final-review-replaces-command"];
  assert.deepEqual(
    replaced.graph.items[0].validation.map((v) => v.command),
    ["node check.mjs a"],
  );
  assert.deepEqual(replaced.graph.coverage[1].proof, { kind: "final-review" });
  assert.deepEqual(replaced.graph.coverage[0].proof, {
    kind: "result-command",
    validationIndex: 0,
  });

  assert.deepEqual(by["missing-ownership"].graph.items[0].ownedPaths, [
    "src/a.mjs",
  ]);
  assert.deepEqual(by["missing-dependency"].graph.items[1].dependencies, []);

  // The worker-test defect keeps every command and only moves the
  // semantic proof onto the item's own tests.
  const workerOnly = by["worker-test-only-proof"].graph;
  assert.deepEqual(
    workerOnly.items[0].validation,
    authored().items[0].validation,
  );
  assert.deepEqual(workerOnly.coverage[3].proof, {
    kind: "result-command",
    validationIndex: 1,
  });
  assert.deepEqual(
    workerOnly.coverage.slice(0, 3),
    authored().coverage.slice(0, 3),
  );

  // Defects that need missing context are skipped, not faked.
  const regular = planVariants(graph, { native: false, sourceText: "" });
  assert.deepEqual(
    regular
      .map((variant) => variant.variant)
      .filter((id) =>
        [
          "native-dependency-assumed-merged",
          "worker-test-only-proof",
          "final-review-replaces-command",
        ].includes(id),
      ),
    [],
  );
  // A command line that Final validation runs anyway is exempt.
  assert.equal(
    planVariants(graph, {
      ...context,
      finalCommands: [...context.finalCommands, "npm test"],
    }).some((variant) => variant.variant === "final-review-replaces-command"),
    false,
  );
  const plain = authored();
  delete plain.requiredPreIntegrationChecks;
  assert.equal(
    planVariants(plain, { sourceText: "" }).some(
      (variant) => variant.variant === "invented-ci-name",
    ),
    false,
  );
  // When the usual invented names appear in the sources, another one is used.
  const crowded = planVariants(graph, {
    sourceText: "ci / build-and-test build-and-test (ubuntu)",
  }).find((variant) => variant.variant === "invented-ci-name");
  assert.equal(
    crowded.graph.requiredPreIntegrationChecks[0].checkName,
    "ci / build-and-test-2",
  );
});

test("Wilson intervals and the paired bootstrap match known values", () => {
  const half = wilson(5, 10);
  assert.equal(half.rate, 0.5);
  assert.ok(
    Math.abs(half.low - 0.2366) < 1e-3 && Math.abs(half.high - 0.7634) < 1e-3,
  );
  const none = wilson(0, 10);
  assert.equal(none.low, 0);
  assert.ok(Math.abs(none.high - 0.2775) < 1e-3);
  assert.deepEqual(wilson(0, 0), {
    successes: 0,
    total: 0,
    rate: null,
    low: null,
    high: null,
  });

  const pairs = [
    { a: 0, b: 1 },
    { a: 0.5, b: 1 },
    { a: 1, b: 1 },
    { a: 0, b: 0.5 },
  ];
  const first = pairedBootstrap(pairs, { iterations: 2000, seed: 7 });
  assert.deepEqual(
    first,
    pairedBootstrap(pairs, { iterations: 2000, seed: 7 }),
  );
  assert.equal(first.n, 4);
  assert.equal(first.delta, 0.5);
  assert.ok(first.low > 0 && first.low <= first.delta && first.high <= 1);
  const flat = pairedBootstrap([
    { a: 1, b: 1 },
    { a: 0, b: 0 },
  ]);
  assert.deepEqual([flat.delta, flat.low, flat.high], [0, 0, 0]);
  assert.equal(pairedBootstrap([]).delta, null);

  // Ten repeats of two cases are two units of evidence, not twenty.
  const repeated = clusteredRate(
    new Map([
      ["a", Array(10).fill(true)],
      ["b", Array(10).fill(true)],
    ]),
  );
  assert.equal(repeated.rate, 1);
  assert.equal(repeated.clusters, 2);
  assert.ok(Math.abs(repeated.low - wilson(2, 2).low) < 1e-9);
  assert.ok(repeated.low < wilson(20, 20).low);
  const mixed = clusteredRate(
    byCluster(
      [
        ...Array(5).fill({ c: "a", ok: true }),
        ...Array(5).fill({ c: "b", ok: false }),
        ...Array(5).fill({ c: "c", ok: true }),
      ],
      (run) => run.c,
      (run) => run.ok,
    ),
  );
  assert.deepEqual([mixed.successes, mixed.total, mixed.clusters], [10, 15, 3]);
  assert.ok(mixed.low < 0.2 && mixed.high === 1);
  assert.equal(clusteredRate(new Map()).rate, null);
});

test("judge-free metrics count structured fields only", () => {
  const plan = {
    sources: [
      {
        path: "OBJECTIVE",
        content:
          "## Acceptance\n\n- `node check.mjs a`\n- `npm test`\n- `node check.mjs a` passes\n",
      },
      { path: "README.md", content: "Run `pnpm lint` to lint.\n" },
    ],
    finalCommands: ["npm test"],
    graph: {
      requiredPreIntegrationChecks: [{ checkName: "unit-tests" }],
      items: [
        { id: "a", dependencies: [], acceptance: [], validation: [] },
        { id: "b", dependencies: ["a"], acceptance: [], validation: [] },
        { id: "c", dependencies: ["b", "a"], acceptance: [], validation: [] },
        {
          id: "q",
          kind: "qa",
          dependencies: ["c"],
          acceptance: [],
          validation: [],
        },
      ],
      coverage: [
        // Exactly one source-declared command line: counted.
        {
          proof: { kind: "final-review" },
          source: { text: "`node check.mjs a`" },
        },
        // A Final validation command runs anyway: exempt.
        { proof: { kind: "final-review" }, source: { text: "`npm test`" } },
        // Prose around a command is not a command-line criterion.
        {
          proof: { kind: "final-review" },
          source: { text: "`node check.mjs a` passes" },
        },
        // A code span that production's rule does not treat as a command.
        {
          proof: { kind: "final-review" },
          source: { text: "`pnpm lint`" },
        },
        {
          proof: { kind: "result-command", validationIndex: 0 },
          source: { text: "node check.mjs a" },
        },
        {
          proof: { kind: "integrated-ci", checkName: "ci / invented" },
          source: { text: "" },
        },
      ],
    },
  };
  assert.equal(criticalPath(plan.graph), 4);
  const isCommand = (command) =>
    ["node check.mjs a", "npm test"].includes(command);
  assert.deepEqual(finalReviewInsteadOfCommand(plan, isCommand), {
    count: 1,
    criteria: ["`node check.mjs a`"],
  });
  assert.deepEqual(proofKinds(plan.graph), {
    "final-review": 4,
    "result-command": 1,
    "integrated-ci": 1,
  });
  const jobs = workflowCheckNames([
    {
      path: ".github/workflows/ci.yml",
      content:
        "jobs:\n  test:\n    name: unit-tests\n    runs-on: x\n  lint:\n    runs-on: x\n",
    },
    { path: ".github/workflows/bad.yml", content: "jobs: [unclosed" },
  ]);
  assert.deepEqual([...jobs], ["unit-tests", "lint"]);
  // A name that appears only in prose is not a workflow job.
  assert.deepEqual(ciCheckNames(plan.graph, jobs), {
    total: 2,
    grounded: 1,
    ungrounded: ["ci / invented"],
  });

  const event = (invocationId, phase, observationType, extra = {}) => ({
    operation: "model-invocation",
    metadata: { invocationId, phase, observationType, ...extra },
  });
  assert.equal(
    firstTry(
      [
        event("1", "compile", "completed"),
        event("2", "graph-review", "completed"),
      ],
      true,
    ),
    "accepted",
  );
  assert.equal(
    firstTry(
      [
        event("1", "compile", "completed"),
        event("2", "graph-review", "completed"),
        event("3", "diagnosis", "completed"),
      ],
      true,
    ),
    "review-findings",
  );
  assert.equal(
    firstTry(
      [
        event("1", "compile", "response-invalid", {
          failureClass: "semantic-validation",
          failureField: "coverage",
        }),
      ],
      false,
    ),
    "semantic:coverage",
  );
  assert.equal(
    firstTry(
      [
        event("1", "compile", "response-invalid", {
          failureClass: "structured-output-parse",
        }),
      ],
      false,
    ),
    "parse",
  );
  assert.equal(firstTry([event("1", "compile", "failed")], false), "provider");
  // A provider-capacity retry under the same invocation id ends as its last attempt.
  assert.equal(
    firstTry(
      [
        event("1", "compile", "completed"),
        event("2", "graph-review", "failed", {
          providerAttempt: 1,
          failureClass: "provider-capacity",
        }),
        event("2", "graph-review", "completed", { providerAttempt: 2 }),
      ],
      true,
    ),
    "accepted",
  );
  assert.equal(firstTry([], false), "none");

  assert.deepEqual(
    expectation(
      {
        outcome: "plan",
        requiredChecks: ["unit-tests", "lint"],
        maxCriticalPath: 2,
      },
      { outcome: "plan", planned: true },
      plan.graph,
    ),
    {
      met: false,
      failed: [
        "missing required check lint",
        "critical path 4, expected at most 2",
      ],
    },
  );
  // Outcomes come from the run's structured stop, never from prose.
  assert.equal(
    expectation({ outcome: "question" }, { outcome: "question" }, undefined)
      .met,
    true,
  );
  assert.deepEqual(
    expectation(
      { outcome: "question" },
      { outcome: "plan", planned: true },
      plan.graph,
    ).failed,
    ["expected outcome question, got plan"],
  );
  // An infrastructure error says nothing about the plan.
  assert.equal(
    expectation({ outcome: "question" }, { outcome: "error" }, undefined),
    null,
  );
  assert.equal(expectation(undefined, { outcome: "plan" }, plan.graph), null);
});

test("the frozen judges load only with their pinned prompt and grade all dimensions", async () => {
  const judges = loadJudges(
    ["claude", "codex"].map((provider) =>
      join(root, `evals/judges/strict-rubric-v1-${provider}.json`),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(judges.map((judge) => [judge.name, judge.digest])),
    FROZEN_JUDGES,
    "a frozen judge changed; add a new judge file instead of editing one",
  );
  assert.deepEqual(
    judges.map((judge) => judge.model.kind),
    ["claude-agent-sdk", "codex-sdk"],
  );
  assert.equal(judges[0].prompt, judges[1].prompt);
  const [judge] = judges;
  assert.doesNotMatch(
    judge.prompt,
    /Independently review this complete proposed Factory plan/,
  );
  assert.throws(
    () => loadJudges([judges[0].path, judges[0].path]),
    /listed twice/,
  );

  const work = mkdtempSync(join(tmpdir(), "factory-judge-"));
  try {
    copyFileSync(judge.path, join(work, "judge.json"));
    writeFileSync(
      join(work, "strict-rubric-v1.md"),
      `${judge.prompt}\nEdited.\n`,
    );
    assert.throws(
      () => loadJudge(join(work, "judge.json")),
      /Frozen judges are never edited/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const all = (verdict) => ({
    dimensions: JUDGE_DIMENSIONS.map((name) => ({
      name,
      verdict,
      evidence: name,
    })),
  });
  assert.equal(decodeJudge(all("pass")).verdict, "pass");
  const failing = all("pass");
  failing.dimensions[1].verdict = "fail";
  assert.deepEqual(decodeJudge(failing).failed, ["ownership"]);
  assert.throws(
    () => decodeJudge({ dimensions: all("pass").dimensions.slice(1) }),
    /omitted coverage/,
  );
  assert.throws(
    () =>
      decodeJudge({
        dimensions: [
          ...all("pass").dimensions,
          { name: "coverage", verdict: "pass" },
        ],
      }),
    /repeated/,
  );

  const input = judgeInput(
    {
      sources: [
        { path: "OBJECTIVE", content: "# Objective" },
        { path: "docs/SPEC.md", heading: "Wrap", content: "## Wrap" },
      ],
      graph: {
        items: [
          { id: "a", inputSources: [{ content: "large" }], dependencies: [] },
        ],
        coverage: [
          {
            itemId: "a",
            proof: { kind: "final-review" },
            environment: {},
            source: { text: "criterion" },
          },
        ],
      },
      commands: [],
      finalCommands: [],
      review: { findings: [{ detail: "production finding" }] },
    },
    { files: ["a"], workflows: [] },
  );
  assert.equal(input.objective, "# Objective");
  assert.deepEqual(
    input.sources.map((source) => source.path),
    ["docs/SPEC.md"],
  );
  assert.equal("inputSources" in input.plan.items[0], false);
  assert.doesNotMatch(JSON.stringify(input), /production finding/);

  const transport = (respond) => ({
    async run({ turn }) {
      turn.usage = { inputTokens: 3, outputTokens: 1 };
      respond(turn);
    },
  });
  const passed = await runJudge(
    judge,
    input,
    transport((turn) => {
      turn.response = JSON.stringify(all("pass"));
    }),
  );
  assert.equal(passed.verdict, "pass");
  assert.equal(passed.digest, judge.digest);
  assert.deepEqual(passed.tokens, { inputTokens: 3, outputTokens: 1 });
  const broken = await runJudge(
    judge,
    input,
    transport((turn) => {
      turn.response = "{}";
    }),
  );
  assert.equal(broken.verdict, "error");
  assert.match(broken.error, /no dimensions/);
});

test("public cases are pinned, cover every required scenario and pass source checks", () => {
  const targets = mkdtempSync(join(tmpdir(), "factory-eval-cases-"));
  const again = mkdtempSync(join(tmpdir(), "factory-eval-cases-"));
  try {
    const cases = loadCases([join(root, "evals/cases")], [], { targets });
    assert.ok(cases.length >= 16, `${cases.length} public cases`);
    const tags = new Set(cases.flatMap((entry) => entry.tags));
    for (const tag of [
      "single-item",
      "multi-item",
      "dependencies",
      "native-stack",
      "media",
      "lfs",
      "discovery",
      "predecessor",
      "ask-operator",
      "required-ci",
      "workspace",
      "baseline-qa",
    ])
      assert.ok(tags.has(tag), `a public case covers ${tag}`);
    for (const entry of cases) {
      const sources = planningSources(entry.body, entry.commit, entry.target);
      assert.ok(sources.length > 1, entry.name);
    }
    for (const [name, commit] of Object.entries(FIXTURE_COMMITS))
      assert.ok(
        cases.some(
          (entry) =>
            entry.commit === commit &&
            entry.target.startsWith(join(targets, `${name}-`)),
        ),
        name,
      );

    // User-level Git ignore and attribute files cannot change a fixture.
    const xdg = join(again, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "ignore"), "*.png\n*.md\n");
    writeFileSync(join(xdg, "git", "attributes"), "* text eol=crlf\n");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      for (const [name, commit] of Object.entries(FIXTURE_COMMITS))
        assert.equal(
          materializeFixture(
            join(root, "evals/targets", name),
            join(again, name),
          ),
          commit,
        );
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }

    // Two fixtures with one directory name never share a target repository.
    const other = join(again, "other", "cases", "solo");
    mkdirSync(other, { recursive: true });
    cpSync(
      join(root, "evals/targets/node-lib"),
      join(again, "other", "node-lib"),
      {
        recursive: true,
      },
    );
    writeFileSync(
      join(again, "other", "node-lib", "README.md"),
      "# Different tree\n",
    );
    writeFileSync(
      join(other, "case.json"),
      JSON.stringify({ fixture: "../../node-lib" }),
    );
    writeFileSync(join(other, "objective.md"), "# Solo\n");
    const [solo] = loadCases([join(again, "other", "cases")], [], { targets });
    assert.notEqual(solo.commit, FIXTURE_COMMITS["node-lib"]);
  } finally {
    rmSync(targets, { recursive: true, force: true });
    rmSync(again, { recursive: true, force: true });
  }
});

test("review fixtures compile; each defect reaches the reviewer or production refuses it", async () => {
  const targets = mkdtempSync(join(tmpdir(), "factory-eval-review-"));
  try {
    const fixtures = loadReviewFixtures(join(root, "evals/review"), [], {
      targets,
    });
    const outcomes = {};
    for (const fixture of fixtures) {
      const checkout = prepareCheckout(
        fixture.case,
        join(targets, `checkout-${fixture.name}`),
      );
      const variants = await prepareVariants(
        fixture,
        validateConfig({
          ...config,
          repository: fixture.case.repository,
          checkout,
        }),
      );
      for (const variant of variants) {
        if (variant.refused === undefined)
          assert.ok(variant.packet.graph.items.length);
        if (!variant.defect) {
          assert.equal(variant.refused, undefined, fixture.name);
          continue;
        }
        outcomes[variant.defect] ??= [];
        outcomes[variant.defect].push(
          `${fixture.name}:${variant.refused === undefined ? "review" : "refused"}`,
        );
      }
    }
    // Every defect applies somewhere. Production now refuses invented CI
    // names and command criteria proved by final review, so those never
    // reach the reviewer; the media command criterion has no command
    // authority once the plan drops it, so it does.
    assert.deepEqual(outcomes, {
      "invented-ci-name": [
        "native-stack-chain:refused",
        "required-ci-check-qa:refused",
      ],
      "acceptance-needs-own-merge": [
        "media-lfs-thumbnail:review",
        "native-stack-chain:review",
        "required-ci-check-qa:review",
      ],
      "native-dependency-assumed-merged": ["native-stack-chain:review"],
      "final-review-replaces-command": [
        "media-lfs-thumbnail:review",
        "native-stack-chain:refused",
        "required-ci-check-qa:refused",
      ],
      "missing-ownership": [
        "media-lfs-thumbnail:review",
        "native-stack-chain:review",
        "required-ci-check-qa:review",
      ],
      "missing-dependency": [
        "media-lfs-thumbnail:review",
        "native-stack-chain:review",
        "required-ci-check-qa:review",
      ],
      "worker-test-only-proof": [
        "native-stack-chain:review",
        "required-ci-check-qa:review",
      ],
    });
  } finally {
    rmSync(targets, { recursive: true, force: true });
  }
});

test("compare pairs units on identical inputs, tests them exactly and adjusts secondary metrics", () => {
  const unit = (id, digest, clean, claude, codex, tokens) => ({
    id,
    digest,
    metrics: {
      productionClean: clean,
      "judgePass:claude": claude,
      "judgePass:codex": codex,
      planningTokens: tokens,
      revisions: 0,
    },
  });
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
  const a = {
    mode: "plan",
    judges: [
      { name: "claude", digest: "j1" },
      { name: "codex", digest: "x1" },
    ],
    units: [
      ...ids.map((id) => unit(id, `d-${id}`, 0, 0, 0, 100)),
      unit("only-a", "d", 0, 0, 0, 100),
      unit("moved", "old", 0, 0, 0, 100),
    ],
  };
  const b = {
    mode: "plan",
    judges: [
      { name: "claude", digest: "j1" },
      { name: "codex", digest: "x2" },
    ],
    units: [
      ...ids.map((id) => unit(id, `d-${id}`, 1, 1, 1, 90)),
      unit("moved", "new", 1, 1, 1, 90),
    ],
  };
  const result = compareReports(a, b, { iterations: 500 });
  assert.equal(result.units, 6);
  assert.deepEqual(result.onlyInA, ["only-a"]);
  // A unit whose Objective or commit changed is not a pair.
  assert.deepEqual(result.mismatched, ["moved"]);
  const rows = Object.fromEntries(result.rows.map((row) => [row.metric, row]));
  assert.equal(rows["judgePass:codex"], undefined);
  assert.match(result.notes[0], /codex are not compared/);
  // Six identical improvements: exact sign-flip p = 2/2^6.
  assert.equal(rows.productionClean.primary, true);
  assert.equal(rows.productionClean.delta, 1);
  assert.equal(rows.productionClean.p, 2 / 64);
  assert.equal(rows.productionClean.pFloor, 2 / 64);
  assert.equal(rows.productionClean.pHolm, undefined);
  // productionClean is the one primary; judge pass is adjusted with the rest.
  assert.equal(rows["judgePass:claude"].primary, false);
  assert.equal(rows["judgePass:claude"].pHolm, Math.min(1, 3 * (2 / 64)));
  // Secondary metrics are Holm-adjusted; a metric with no change has p = 1.
  assert.equal(rows.planningTokens.primary, false);
  assert.equal(rows.planningTokens.pHolm, Math.min(1, 3 * (2 / 64)));
  assert.equal(rows.revisions.p, 1);
  assert.throws(
    () => compareReports(a, { ...b, mode: "review" }),
    /Cannot compare a plan report with a review report/,
  );

  // Fewer than five paired units: no interval and no p-value.
  const small = compareReports(
    { ...a, units: a.units.slice(0, 3) },
    { ...b, units: b.units.slice(0, 3) },
  );
  const smallRow = small.rows.find((row) => row.metric === "productionClean");
  assert.equal(smallRow.insufficient, true);
  assert.deepEqual(
    [smallRow.low, smallRow.high, smallRow.p],
    [null, null, null],
  );
  assert.equal(smallRow.delta, 1);
});

test("exact sign-flip test, Holm adjustment and Cohen's kappa", () => {
  assert.deepEqual(signFlipTest([1, 1, 1]), {
    p: 0.25,
    floor: 0.25,
    exact: true,
  });
  assert.deepEqual(signFlipTest([0, 0]), { p: 1, floor: 1, exact: true });
  assert.equal(signFlipTest([1, -1, 1, -1]).p, 1);
  const large = signFlipTest(Array(25).fill(1), { samples: 2000 });
  assert.equal(large.exact, false);
  assert.ok(large.p < 0.01);
  assert.deepEqual(holm([0.01, 0.04, null, 0.03]), [0.03, 0.06, null, 0.06]);
  assert.equal(
    cohensKappa([
      ["pass", "pass"],
      ["fail", "fail"],
      ["pass", "pass"],
      ["fail", "fail"],
    ]),
    1,
  );
  assert.equal(
    cohensKappa([
      ["pass", "pass"],
      ["pass", "fail"],
      ["fail", "pass"],
      ["fail", "fail"],
    ]),
    0,
  );
  assert.equal(cohensKappa([["pass", "pass"]]), null);
  assert.equal(cohensKappa([]), null);
});

test("review metrics keep false positives apart from recall and skip invalid reviews", () => {
  const good = reviewRunMetrics({ review: "findings", flagged: true });
  const hit = reviewRunMetrics({
    review: "findings",
    flagged: true,
    defect: "missing-dependency",
  });
  assert.deepEqual(
    [good.falsePositive, good.recall, hit.falsePositive, hit.recall],
    [1, undefined, undefined, 1],
  );
  // An invalid or errored review has no verdict.
  for (const review of ["invalid", "error"]) {
    const metrics = reviewRunMetrics({ review, flagged: false, defect: "d" });
    assert.equal("recall" in metrics, false);
  }
  const summary = summarizeReviewRuns(
    [
      {
        fixture: "f",
        variant: "good",
        defect: null,
        review: "invalid",
        flagged: false,
      },
      {
        fixture: "f",
        variant: "good",
        defect: null,
        review: "clean",
        flagged: false,
      },
      {
        fixture: "f",
        variant: "d",
        defect: "missing-dependency",
        review: "invalid",
        flagged: false,
      },
      {
        fixture: "f",
        variant: "d",
        defect: "missing-dependency",
        review: "findings",
        flagged: true,
      },
    ],
    [],
  );
  assert.deepEqual(
    [
      summary.good.falsePositive.successes,
      summary.good.falsePositive.total,
      summary.good.invalid,
    ],
    [0, 1, 1],
  );
  const [row] = summary.defects;
  assert.deepEqual(
    [row.recall.successes, row.recall.total, row.invalid],
    [1, 1, 1],
  );

  // Review compare clusters by fixture: a reviewer that adds false
  // positives shows a worse falsePositive row, never a better recall row.
  const unit = (id, defect, flagged) => ({
    id,
    digest: id,
    metrics: reviewRunMetrics({ review: "findings", flagged, defect }),
  });
  const fixtures = ["f1", "f2", "f3", "f4", "f5"];
  const before = {
    mode: "review",
    judges: [],
    units: fixtures.flatMap((f) => [
      unit(`${f}/good`, null, false),
      unit(`${f}/d1`, "d1", true),
      unit(`${f}/d2`, "d2", false),
    ]),
  };
  const after = {
    mode: "review",
    judges: [],
    units: fixtures.flatMap((f) => [
      unit(`${f}/good`, null, true),
      unit(`${f}/d1`, "d1", true),
      unit(`${f}/d2`, "d2", false),
    ]),
  };
  const result = compareReports(before, after, { iterations: 100 });
  assert.equal(result.clusteredBy, "fixture");
  assert.equal(result.units, 5);
  const rows = Object.fromEntries(result.rows.map((row) => [row.metric, row]));
  assert.equal(rows.falsePositive.delta, 1);
  assert.equal(rows.recall.delta, 0);
  assert.equal(rows.recall.meanA, 0.5);
});

test("plan summaries exclude infrastructure errors and report each judge and their agreement", () => {
  const run = (name, claude, codex) => ({
    case: name,
    outcome: "plan",
    planned: true,
    judges: [
      { judge: "claude", verdict: claude, passed: 7, failed: [] },
      { judge: "codex", verdict: codex, passed: 6, failed: ["scope"] },
    ],
  });
  const summary = summarizePlanRuns([
    run("a", "pass", "pass"),
    run("a", "pass", "fail"),
    run("b", "fail", "fail"),
    run("b", "pass", "error"),
    { case: "b", outcome: "question", planned: false },
    { case: "c", outcome: "error", error: "provider outage" },
  ]);
  const { overall } = summary;
  assert.equal(overall.errors, 1);
  assert.equal(overall.judgeErrors, 1);
  assert.deepEqual(
    [overall.productionClean.successes, overall.productionClean.total],
    [4, 5],
  );
  assert.deepEqual(
    [overall.question.successes, overall.question.total],
    [1, 5],
  );
  assert.deepEqual(summary.cases.find((unit) => unit.id === "c").metrics, {});
  const judges = Object.fromEntries(
    overall.judges.map((judge) => [judge.name, judge]),
  );
  assert.deepEqual(
    [judges.claude.pass.successes, judges.claude.pass.total],
    [3, 4],
  );
  assert.deepEqual(
    [judges.codex.pass.successes, judges.codex.pass.total, judges.codex.errors],
    [1, 3, 1],
  );
  const [pair] = overall.agreement;
  assert.deepEqual(pair.judges, ["claude", "codex"]);
  assert.deepEqual(
    [pair.agree.successes, pair.agree.total, pair.onlySecondFails],
    [2, 3, 1],
  );
  // po = 2/3; claude passes 2/3, codex 1/3; pe = 2/9 + 2/9 = 4/9.
  assert.ok(Math.abs(pair.kappa - (2 / 3 - 4 / 9) / (1 - 4 / 9)) < 1e-12);
});

test("command criteria follow production's commandObligation rule", () => {
  // Like commandAuthority, which compares normalized commands.
  const isCommand = (command) =>
    command.trim().replace(/\s+/g, " ") === "npm test";
  assert.equal(requiredCommandLine("`npm test`", [], isCommand), "npm test");
  assert.equal(requiredCommandLine("npm  test", [], isCommand), "npm test");
  assert.equal(
    requiredCommandLine("`npm test`", ["npm test"], isCommand),
    null,
  );
  assert.equal(requiredCommandLine("`npm test` passes", [], isCommand), null);
  assert.equal(requiredCommandLine("`npm run lint`", [], isCommand), null);
});

test("the Claude judge runs with no tools, MCP servers, agents, plugins or settings", () => {
  const { options } = providerContext({
    kind: "claude-agent-sdk",
    model: "claude-opus-5-5",
    reasoningEffort: "high",
    maxOutputTokens: 32000,
  });
  assert.deepEqual(
    {
      tools: options.tools,
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      strictMcpConfig: options.strictMcpConfig,
      agents: options.agents,
      plugins: options.plugins,
      skills: options.skills,
      settingSources: options.settingSources,
      permissionMode: options.permissionMode,
    },
    {
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      agents: {},
      plugins: [],
      skills: [],
      settingSources: [],
      permissionMode: "dontAsk",
    },
  );
  // The Codex judge's own configuration turns its tools off.
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "view_image",
    "multi_agent",
  ])
    assert.match(CODEX_JUDGE_CONFIG, new RegExp(`^${feature} = false$`, "m"));
  assert.match(CODEX_JUDGE_CONFIG, /^web_search = "disabled"$/m);
});
