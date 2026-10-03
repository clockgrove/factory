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
  decodeJudge,
  JUDGE_DIMENSIONS,
  judgeInput,
  loadJudge,
  loadJudges,
  runJudge,
} from "../scripts/eval-planning/judge.mjs";
import {
  ciCheckNames,
  criticalPath,
  expectation,
  finalReviewInsteadOfCommand,
  firstTry,
  proofKinds,
  workflowCheckNames,
} from "../scripts/eval-planning/metrics.mjs";
import { DEFECTS, planVariants } from "../scripts/eval-planning/mutations.mjs";
import {
  compareReports,
  reviewRunMetrics,
  summarizePlanRuns,
} from "../scripts/eval-planning/report.mjs";
import {
  loadReviewFixtures,
  prepareVariants,
} from "../scripts/eval-planning/review.mjs";
import {
  byCluster,
  clusteredRate,
  pairedBootstrap,
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
    "3655ea73b0c58533305c165f089d62788e83b4ddc7480b8e46d038f1c38f559d",
  "strict-rubric-v1-codex":
    "0981e23ed039f08541f350c3906ace79c09fd0fe61ff33d8ae00cb3b259307b7",
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
        acceptance: ["a works"],
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
    ],
  };
}

const workerTest = {
  command: "npm test",
  provenance: "base-observed",
  source: "package.json",
  directory: "test/",
};

test("each seeded defect changes exactly its rule in the authored plan", () => {
  const graph = authored();
  const variants = planVariants(graph, {
    native: true,
    workerTest,
    sourceText: "unit-tests",
  });
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

  const replaced = by["final-review-replaces-command"].graph;
  assert.deepEqual(
    replaced.items[0].validation.map((v) => v.command),
    ["npm test"],
  );
  assert.deepEqual(replaced.coverage[0].proof, { kind: "final-review" });
  assert.deepEqual(replaced.coverage[1].proof, {
    kind: "result-command",
    validationIndex: 0,
  });

  assert.deepEqual(by["missing-ownership"].graph.items[0].ownedPaths, [
    "src/a.mjs",
  ]);
  assert.deepEqual(by["missing-dependency"].graph.items[1].dependencies, []);

  const workerOnly = by["worker-test-only-proof"].graph.items[0];
  assert.deepEqual(
    workerOnly.validation.map((v) => v.command),
    ["npm test"],
  );
  assert.equal(
    by["worker-test-only-proof"].graph.coverage[0].proof.validationIndex,
    0,
  );

  // Defects that need missing context are skipped, not faked.
  const regular = planVariants(graph, { native: false, sourceText: "" });
  assert.equal(
    regular.some((variant) =>
      ["native-dependency-assumed-merged", "worker-test-only-proof"].includes(
        variant.variant,
      ),
    ),
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
    commands: [
      { command: "node check.mjs a", hostExecution: "authorized" },
      { command: "pnpm lint", hostExecution: "blocked" },
    ],
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
        {
          proof: { kind: "final-review" },
          source: { text: "`node check.mjs a` passes" },
        },
        // Not an authorized command line, so not a command-line obligation.
        {
          proof: { kind: "final-review" },
          source: { text: "`pnpm lint` passes" },
        },
        { proof: { kind: "final-review" }, source: { text: "Docs read well" } },
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
  assert.deepEqual(finalReviewInsteadOfCommand(plan), {
    count: 1,
    criteria: ["`node check.mjs a` passes"],
  });
  assert.deepEqual(proofKinds(plan.graph), {
    "final-review": 3,
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
      { planned: true, review: "clean" },
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
  // A question outcome is a structural stop; whether it asked the right
  // question is the judges' scope dimension.
  assert.equal(
    expectation(
      { outcome: "question" },
      { planned: true, review: "question" },
      plan.graph,
    ).met,
    true,
  );
  assert.equal(
    expectation(
      { outcome: "question" },
      {
        planned: false,
        error: "Planning needs an undelegated decision: no bench script",
      },
      undefined,
    ).met,
    true,
  );
  assert.equal(
    expectation(
      { outcome: "question" },
      { planned: false, error: "Provider timed out" },
      undefined,
    ).met,
    false,
  );
  assert.equal(expectation(undefined, { planned: true }, plan.graph), null);
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
    false,
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

test("review fixtures pass compile validation and every defect reaches the reviewer", async () => {
  const targets = mkdtempSync(join(tmpdir(), "factory-eval-review-"));
  try {
    const fixtures = loadReviewFixtures(join(root, "evals/review"), [], {
      targets,
    });
    const reached = new Set();
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
        assert.equal(
          variant.refused,
          undefined,
          `${fixture.name}/${variant.variant}`,
        );
        assert.ok(variant.packet.graph.items.length);
        if (variant.defect) reached.add(variant.defect);
      }
    }
    assert.deepEqual(
      [...reached].sort(),
      DEFECTS.map((defect) => defect.id).sort(),
    );
  } finally {
    rmSync(targets, { recursive: true, force: true });
  }
});

test("compare pairs units, compares only identical judges and refuses mixed modes", () => {
  const report = (judges, values) => ({
    mode: "plan",
    judges: Object.entries(judges).map(([name, digest]) => ({ name, digest })),
    units: Object.entries(values).map(([id, [clean, a, b]]) => ({
      id,
      metrics: {
        productionClean: clean,
        "judgePass:claude": a,
        "judgePass:codex": b,
      },
    })),
  });
  const a = report(
    { claude: "c1", codex: "x1" },
    { x: [0, 0, 1], y: [1, 1, 1], z: [0, 1, 1] },
  );
  const b = report(
    { claude: "c1", codex: "x2" },
    { x: [1, 1, 1], y: [1, 1, 1], w: [1, 1, 1] },
  );
  const result = compareReports(a, b, { iterations: 500 });
  assert.equal(result.units, 2);
  assert.deepEqual(result.onlyInA, ["z"]);
  assert.deepEqual(result.onlyInB, ["w"]);
  assert.deepEqual(
    result.rows.map((row) => [row.metric, row.delta]),
    [
      ["productionClean", 0.5],
      ["judgePass:claude", 0.5],
    ],
  );
  assert.match(result.notes[0], /codex are not compared/);
  assert.throws(
    () => compareReports(a, { ...b, mode: "review" }),
    /Cannot compare a plan report with a review report/,
  );
});

test("review metrics keep false positives apart from recall", () => {
  const good = reviewRunMetrics({ review: "findings", flagged: true });
  const hit = reviewRunMetrics({
    review: "findings",
    flagged: true,
    defect: "missing-dependency",
  });
  assert.deepEqual(
    [good.falsePositive, good.recall, hit.falsePositive, hit.recall],
    [1, null, null, 1],
  );
  // A reviewer that adds false positives shows a worse falsePositive row,
  // never a better recall row.
  const unit = (id, defect, flagged) => ({
    id,
    metrics: reviewRunMetrics({
      review: "x",
      flagged,
      defect,
    }),
  });
  const before = {
    mode: "review",
    judges: [],
    units: [unit("f/good", null, false), unit("f/d", "d", true)],
  };
  const after = {
    mode: "review",
    judges: [],
    units: [unit("f/good", null, true), unit("f/d", "d", true)],
  };
  const rows = Object.fromEntries(
    compareReports(before, after, { iterations: 100 }).rows.map((row) => [
      row.metric,
      row.delta,
    ]),
  );
  assert.equal(rows.falsePositive, 1);
  assert.equal(rows.recall, 0);
});

test("plan summaries report each judge separately and their agreement", () => {
  const run = (name, claude, codex) => ({
    case: name,
    planned: true,
    review: "clean",
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
  ]);
  const judges = Object.fromEntries(
    summary.overall.judges.map((judge) => [judge.name, judge]),
  );
  assert.deepEqual(
    [judges.claude.pass.successes, judges.claude.pass.total],
    [3, 4],
  );
  assert.deepEqual(
    [judges.codex.pass.successes, judges.codex.pass.total, judges.codex.errors],
    [1, 3, 1],
  );
  const [pair] = summary.overall.agreement;
  assert.deepEqual(pair.judges, ["claude", "codex"]);
  assert.deepEqual(
    [pair.agree.successes, pair.agree.total, pair.onlySecondFails],
    [2, 3, 1],
  );
  assert.deepEqual(
    Object.keys(summary.cases[0].metrics).filter((key) => key.includes(":")),
    [
      "judgePass:claude",
      "judgeScore:claude",
      "judgePass:codex",
      "judgeScore:codex",
    ],
  );
});
