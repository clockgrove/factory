import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
  validateTree,
} from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
} from "./support/integration-fixture.mjs";

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-heading-review-"));
  try {
    const target = createTarget(root, { "base.txt": "public base\n" });
    writeFileSync(join(target.checkout, "result.txt"), "public result\n");
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.invalid",
      "commit",
      "-m",
      "public result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const evidence = await validateTree(
      target.checkout,
      join(root, "validation"),
      commit,
      treeSha,
      ["test -f result.txt"],
    );
    const sources = [
      {
        path: "docs/public-plan.md",
        section: "Foundation",
        content: "## Foundation\nFoundation obligation.\n",
      },
      {
        path: "docs/public-plan.md",
        section: "Toolchain",
        content: "## Toolchain\nToolchain obligation.\n",
      },
      {
        path: "docs/public-plan.md",
        section: "Delivery",
        content: "## Delivery\nDelivery obligation.\n",
      },
      { path: "docs/unique.md", content: "Unique obligation.\n" },
    ];
    await run({
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence,
      sources,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Work Item and final review preserve repeated selected sections and ground each exact-path quote", async () => {
  await fixture(async (request) => {
    for (const reviewPhase of ["result-review", "objective-review"]) {
      const criteria = [
        "Foundation obligation.",
        "Toolchain obligation.",
        "Delivery obligation.",
        "Unique obligation.",
      ];
      const result = await reviewAcceptance({
        ...request,
        reviewPhase,
        criteria,
        model: {
          async reviewResult(packet) {
            assert.equal(packet.reviewPhase, reviewPhase);
            assert.deepEqual(packet.sources, request.sources);
            assert.deepEqual(packet.commands, request.evidence.commands);
            assert.equal(packet.treeSha, request.evidence.treeSha);
            return {
              findings: criteria.map((criterion, index) => ({
                criterion,
                verdict: "pass",
                source: request.sources[index].path,
                quote: criterion,
                detail: "Exact supplied section grounds this criterion.",
                question: "",
              })),
            };
          },
        },
      });
      assert.deepEqual(result.commands, request.evidence.commands);
      assert.equal(result.treeSha, request.evidence.treeSha);
      assert.deepEqual(
        result.criteria.map((entry) => entry.verdict),
        ["pass", "pass", "pass", "pass"],
      );
    }
  });
});

test("repeated source paths do not relax quote, exact-path, criterion or refusal checks", async () => {
  await fixture(async (request) => {
    const criterion = "Toolchain obligation.";
    const valid = {
      criterion,
      verdict: "pass",
      source: "docs/public-plan.md",
      quote: criterion,
      detail: "Grounded public requirement.",
      question: "",
    };
    for (const reviewPhase of ["result-review", "objective-review"]) {
      for (const [override, rejection] of [
        [
          { source: "docs/unknown.md" },
          { field: "source", reason: "unknown-source" },
        ],
        [{ source: undefined }, { field: "source", reason: "unknown-source" }],
        [{ quote: undefined }, { field: "quote", reason: "empty-quote" }],
        [
          { source: "docs/unique.md" },
          { field: "quote", reason: "quote-not-found" },
        ],
        [{ quote: "" }, { field: "quote", reason: "empty-quote" }],
        [
          { quote: "not in any supplied section" },
          { field: "quote", reason: "quote-not-found" },
        ],
        [
          { quote: "Foundation obligation.\n## Toolchain" },
          { field: "quote", reason: "quote-not-found" },
        ],
        [
          { criterion: "another criterion" },
          { field: "criterion", reason: "criterion-mismatch" },
        ],
      ]) {
        await assert.rejects(
          reviewAcceptance({
            ...request,
            reviewPhase,
            criteria: [criterion],
            model: {
              async reviewResult() {
                return { findings: [{ ...valid, ...override }] };
              },
            },
          }),
          (error) => {
            assert.ok(error instanceof AcceptanceDecisionRequired);
            assert.deepEqual(error.pending.reviewRejection, rejection);
            return true;
          },
        );
      }
      await assert.rejects(
        reviewAcceptance({
          ...request,
          reviewPhase,
          criteria: [criterion],
          model: {
            async reviewResult() {
              return { findings: [{ ...valid, verdict: "refuse" }] };
            },
          },
        }),
        /Acceptance criterion disproved/,
      );
    }
  });
});

test("actual application Work Item and final review accept later selected headings without decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-heading-application-"));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root, {
      "docs/public-plan.md":
        "# Plan\n\n## Foundation\nFoundation obligation.\n\n## Toolchain\nToolchain obligation.\n\n## Delivery\nDelivery obligation.\n",
    });
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "one",
          title: "Public result",
          goal: "Create result.txt",
          acceptance: ["Toolchain obligation."],
          nonGoals: ["No deployment"],
          citations: [{ path: "docs/public-plan.md", heading: "Toolchain" }],
          dependencies: [],
          ownedPaths: ["result.txt"],
          resources: [],
          validation: [
            {
              command: "test -f result.txt",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          brief: "Create result.txt only",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    };
    const phases = [];
    const planningModel = {
      async generateStructured() {
        return structuredClone(graph);
      },
      async reviewGraph() {
        return { findings: [] };
      },
      async reviewResult(packet) {
        phases.push(packet.reviewPhase);
        assert.equal(
          packet.sources.filter(
            (source) => source.path === "docs/public-plan.md",
          ).length,
          3,
        );
        return {
          findings: packet.criteria.map((criterion) => ({
            criterion,
            verdict: "pass",
            source: "docs/public-plan.md",
            quote: criterion,
            detail: "Exact later selected heading grounds this criterion.",
            question: "",
          })),
        };
      },
    };
    const { application } = makeApplication({
      config: factoryConfig(
        target.checkout,
        "example/heading-selected",
        "regular",
        1,
      ),
      fakeRoot: join(root, "fake"),
      objectiveBody:
        "# Public Objective\n\n## Planning sources\n- `docs/public-plan.md#Foundation`\n- `docs/public-plan.md#Toolchain`\n- `docs/public-plan.md#Delivery`\n\n## Acceptance\n- Delivery obligation.\n\n## Validation\n- `test -f result.txt`\n\n## Final validation\n- `test -f result.txt`\n",
      graph,
      planningModel,
      actions: {
        one: { files: [{ path: "result.txt", text: "public result\n" }] },
      },
    });
    const plan = await application.planObjective(1);
    assert.equal(plan.review.status, "clean");
    const result = await application.runObjective(1, plan);
    assert.equal(result.work.one.status, "done");
    assert.equal(result.finalValidation.passed, true);
    assert.equal(result.objectiveClosure, "complete");
    assert.deepEqual(phases, ["result-review", "objective-review"]);
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("authoritative evidence labels remain unique, disjoint and complete in both review phases", async () => {
  await fixture(async (request) => {
    const labels = [
      "Exact Git change packet",
      "Command pass evidence",
      "Delivery observations",
      "Controller materialization evidence",
    ];
    for (const reviewPhase of ["result-review", "objective-review"]) {
      let calls = 0;
      const model = {
        async reviewResult() {
          calls++;
          return { findings: [] };
        },
      };
      const common = { ...request, reviewPhase, criteria: ["proof"], model };
      for (const path of labels) {
        const extra = { path, content: "public evidence", complete: true };
        await assert.rejects(
          reviewAcceptance({ ...common, evidenceSources: [extra, extra] }),
          /Result review evidence paths must be unique/,
        );
        await assert.rejects(
          reviewAcceptance({
            ...common,
            sources: [
              ...request.sources,
              { path, content: "planning collision" },
            ],
            evidenceSources: path === labels[3] ? [extra] : [],
          }),
          /Result review evidence paths must be unique/,
        );
      }
      assert.equal(calls, 0);
      for (const complete of [true, false]) {
        const path = "Controller materialization evidence";
        const invoke = () =>
          reviewAcceptance({
            ...common,
            evidenceSources: [
              { path, content: "public controller proof", complete },
            ],
            model: {
              async reviewResult() {
                return {
                  findings: [
                    {
                      criterion: "proof",
                      verdict: "pass",
                      source: path,
                      quote: "public controller proof",
                      detail: "Exact authoritative evidence.",
                      question: "",
                    },
                  ],
                };
              },
            },
          });
        if (complete)
          assert.equal((await invoke()).criteria[0].verdict, "pass");
        else
          await assert.rejects(invoke(), (error) => {
            assert.ok(error instanceof AcceptanceDecisionRequired);
            assert.deepEqual(error.pending.reviewRejection, {
              field: "source",
              reason: "source-truncated",
            });
            return true;
          });
      }
    }
  });
});
