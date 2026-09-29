import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  readDiagnostics,
  statusDocument,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";
import { selectAssetSetFromCli } from "../dist/runner.js";
import { parseFactoryState } from "../dist/state.js";
import { readContinuation, readState, statePath } from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
  waitFor,
  waitForFile,
  writeDescriptor,
} from "./support/integration-fixture.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";

const objective = 1;

function item(id, options = {}) {
  const command = options.command ?? `test -s ${options.path}`;
  return {
    id,
    title: `Implement ${id}`,
    goal: `Create ${options.path}`,
    acceptance: [`${options.path} has the scripted result`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies: options.dependencies ?? [],
    ownedPaths: options.ownedPaths ?? [options.path],
    resources: options.resources ?? [],
    validation: [
      { command, provenance: "source-declared", source: "OBJECTIVE" },
    ],
    brief: `Make only the ${id} fixture change.`,
    sourceAssets: options.sourceAssets ?? [],
    expectedOutputRoles: options.expectedOutputRoles ?? [],
    minimumAssetSets: options.minimumAssetSets ?? 0,
    requiredLfsRoles: options.requiredLfsRoles ?? [],
  };
}

function body(commands, finalCommands = commands) {
  return `# Deterministic Objective

## Acceptance
${commands.map((command) => `- \`${command}\``).join("\n")}

## Final validation
${finalCommands.map((command) => `- \`${command}\``).join("\n")}
`;
}

function encodeCodexCitationIndexes(graph, citationChoiceIndex = 2) {
  return {
    ...graph,
    items: graph.items.map((workItem) => ({
      ...workItem,
      citations: [{ choiceIndex: citationChoiceIndex }],
    })),
  };
}

async function fixture(name, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    return await callback(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("regular application path runs a source-grounded concurrent DAG with stable identities", async () => {
  await fixture("regular-integration", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "roots.go");
    const commands = [
      'test "$(cat alpha.txt)" = alpha',
      'test "$(cat beta.txt)" = beta',
      'test "$(cat conflict.txt)" = conflict',
      "test -s joined.txt && grep -q alpha joined.txt && grep -q beta joined.txt",
    ];
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [
        item("alpha", {
          path: "alpha.txt",
          command: commands[0],
          resources: ["shared-fixture"],
        }),
        item("beta", { path: "beta.txt", command: commands[1] }),
        item("conflict", {
          path: "conflict.txt",
          command: commands[2],
          resources: ["shared-fixture"],
        }),
        item("join", {
          path: "joined.txt",
          command: commands[3],
          dependencies: ["alpha", "beta"],
        }),
      ],
    };
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/regular-integration",
        "regular",
        3,
      ),
      graph,
      objectiveBody: body(commands),
      fakeRoot,
      actions: {
        alpha: { barrier, files: [{ path: "alpha.txt", text: "alpha\n" }] },
        beta: { barrier, files: [{ path: "beta.txt", text: "beta\n" }] },
        conflict: { files: [{ path: "conflict.txt", text: "conflict\n" }] },
        join: {
          files: [{ path: "joined.txt", text: "alpha\nbeta\n" }],
        },
      },
    };
    const runStatus = [];
    descriptor.reportRunStatus = (message) => runStatus.push(message);
    const { application, eventsPath, github } = makeApplication(descriptor);
    const acceptedPlan = await application.planObjective(objective);
    assert.equal(acceptedPlan.review.status, "clean");
    assert.equal(Object.keys(github.state().issues).length, 0);
    const running = application.runObjective(objective, acceptedPlan);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return starts.some((event) => event.item === "alpha") &&
          starts.some((event) => event.item === "beta")
          ? starts
          : undefined;
      },
      fakeRoot,
      "independent root attempts",
    );
    const initialStarts = readEvents(eventsPath).filter(
      (event) => event.type === "start",
    );
    assert.deepEqual(
      new Set(initialStarts.map((event) => event.item)),
      new Set(["alpha", "beta"]),
    );
    const inProgress = readState(descriptor.config.repository, objective);
    const snapshot = statusDocument(
      inProgress,
      descriptor.config.repository,
      objective,
      "regular",
    );
    assert.equal(
      snapshot.work.find((work) => work.id === "conflict").blockedReason,
      "resource:alpha",
    );
    assert.equal(
      snapshot.work.find((work) => work.id === "join").blockedReason,
      "dependency:alpha",
    );
    assert.equal(
      snapshot.work.find((work) => work.id === "alpha").providerProgress,
      "unavailable",
    );
    const capacityState = structuredClone(inProgress);
    capacityState.graph.items.find((item) => item.id === "conflict").resources =
      [];
    const capacitySnapshot = statusDocument(
      capacityState,
      descriptor.config.repository,
      objective,
      "regular",
      [],
      2,
    );
    const capacityWork = capacitySnapshot.work.find(
      (work) => work.id === "conflict",
    );
    assert.equal(capacityWork.eligible, true);
    assert.equal(capacityWork.ready, false);
    assert.equal(capacityWork.blockedReason, "capacity");
    assert.equal(capacitySnapshot.configuredSlots, 0);
    mkdirSync(join(root, "barriers"), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.deepEqual(runStatus, ["Factory: activating the accepted plan"]);
    assert.equal(state.finalValidation.passed, true);
    assert.ok(
      Object.values(state.work).every((work) => work.status === "done"),
    );
    for (const work of Object.values(state.work)) {
      assert.equal(work.validation.treeSha, work.treeSha);
      assert.ok(work.validation.commands.every((check) => check.passed));
    }
    assert.equal(
      state.finalValidation.treeSha,
      git(target.checkout, "rev-parse", `${state.integratedSha}^{tree}`),
    );
    const modelInvocations = readDiagnostics(
      descriptor.config.repository,
      objective,
    ).filter(
      (event) =>
        event.operation === "model-invocation" &&
        event.metadata.observationType === "completed",
    );
    assert.deepEqual(
      modelInvocations.map((event) => event.metadata.phase).sort(),
      [
        "compile",
        "graph-review",
        "objective-review",
        "result-review",
        "result-review",
        "result-review",
        "result-review",
      ].sort(),
    );
    assert.ok(
      modelInvocations.every(
        (event) =>
          event.metadata.model === "scripted-test-model" &&
          event.metadata.inputTokens === 10 &&
          event.metadata.cachedInputTokens === 4,
      ),
    );
    const events = readEvents(eventsPath);
    const joinStart = events.findIndex(
      (event) => event.type === "start" && event.item === "join",
    );
    for (const dependency of ["alpha", "beta"])
      assert.ok(
        joinStart >
          events.findIndex(
            (event) => event.type === "complete" && event.item === dependency,
          ),
      );
    const remote = github.state();
    assert.equal(Object.keys(remote.issues).length, 4);
    assert.equal(Object.keys(remote.pullRequests).length, 4);
    assert.deepEqual(remote.projections.join.dependencies, ["alpha", "beta"]);
    assert.deepEqual(remote.projections.join.citations, [
      { path: "OBJECTIVE", heading: "Acceptance" },
    ]);
    assert.equal(remote.projections.join.validation[0].command, commands[3]);
    const identities = {
      issues: structuredClone(remote.issues),
      pulls: Object.values(remote.pullRequests).map((pull) => pull.number),
      starts: events.filter((event) => event.type === "start").length,
    };
    const rerun = await application.runObjective(objective);
    assert.deepEqual(runStatus, [
      "Factory: activating the accepted plan",
      "Factory: resuming the existing run from atomic state",
    ]);
    assert.equal(rerun.integratedSha, state.integratedSha);
    assert.deepEqual(github.state().issues, identities.issues);
    assert.deepEqual(
      Object.values(github.state().pullRequests).map((pull) => pull.number),
      identities.pulls,
    );
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      identities.starts,
    );
    const planning = readEvents(join(fakeRoot, "planning.ndjson"));
    assert.deepEqual(planning[0].sources, [
      "OBJECTIVE",
      "AGENTS.md",
      "README.md",
    ]);
    assert.equal(planning[0].baseSha, target.baseSha);
    const timeline = readDiagnostics(descriptor.config.repository, objective);
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "planning" && event.outcome === "completed",
      ),
    );
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "github-projection" &&
          event.outcome === "completed",
      ),
    );
    for (const id of ["alpha", "beta", "conflict", "join"]) {
      const attempt = state.work[id].attempt;
      assert.ok(
        timeline.some(
          (event) =>
            event.itemId === id &&
            event.attemptId === attempt &&
            event.operation === "execute",
        ),
      );
      assert.ok(
        timeline.some(
          (event) =>
            event.itemId === id &&
            event.operation === "validation-command" &&
            event.outcome === "completed",
        ),
      );
      assert.ok(
        timeline.some(
          (event) => event.itemId === id && event.metadata?.pullRequest,
        ),
      );
      for (const operation of ["github-publication", "github-merge"])
        assert.ok(
          timeline.some(
            (event) =>
              event.itemId === id &&
              event.operation === operation &&
              event.outcome === "completed" &&
              event.durationMs >= 0,
          ),
        );
      assert.ok(
        timeline.some(
          (event) =>
            event.itemId === id &&
            event.operation === "acceptance-review" &&
            event.outcome === "completed" &&
            event.durationMs >= 0,
        ),
      );
    }
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "objective-finalization" &&
          event.outcome === "completed",
      ),
    );
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "objective-validation" &&
          event.outcome === "completed" &&
          event.durationMs >= 0,
      ),
    );
  });
});

test("pnpm Work Item and final review auto-pass from exact-tree command receipts", async () => {
  await fixture("pnpm-receipt-integration", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      '#!/bin/sh\nif [ "$1" = install ]; then test -f pnpm-lock.yaml && test -f pnpm-workspace.yaml; exit $?; fi\nexec npm run "$1" --ignore-scripts\n',
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    const commands = [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm check",
      "pnpm test",
    ];
    const criterion =
      "The ordered frozen, lifecycle-disabled install, check, and test commands pass at the exact result tree.";
    const bootstrap = item("pnpm-workspace-bootstrap", {
      path: "package.json",
      command: commands[0],
    });
    bootstrap.acceptance = [criterion];
    bootstrap.ownedPaths = [
      ".gitignore",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "src/index.js",
      "test/index.test.js",
    ];
    bootstrap.validation = commands.map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    }));
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [bootstrap],
    };
    const objectiveBody = `# Exact-tree pnpm receipt integration

## Work Item

- ${criterion}
- ${commands.map((command) => `\`${command}\``).join("\n- ")}

## Acceptance

- ${criterion}

## Final validation

${commands.map((command) => `- \`${command}\``).join("\n")}
`;
    const reviewedScopes = new Set();
    const planningModel = {
      async generateStructured(request) {
        return withCoverage(request, structuredClone(graph));
      },
      async reviewGraph() {
        return { findings: [] };
      },
      async reviewResult(request) {
        assert.deepEqual(
          request.commands.map((receipt) => receipt.index),
          [0, 1, 2],
        );
        assert.deepEqual(
          request.commands.map((receipt) => receipt.command),
          commands,
        );
        assert.ok(
          request.commands.every(
            (receipt) =>
              receipt.passed === true &&
              receipt.exitCode === 0 &&
              receipt.treeSha === request.treeSha,
          ),
        );
        const observations = JSON.parse(request.observations);
        if (observations.reviewedItemId) {
          reviewedScopes.add("work-item");
          const attempt = observations.attempts[0];
          assert.match(attempt.resultCommitSha, /^[0-9a-f]{40}$/);
          assert.equal(attempt.resultTreeSha, request.treeSha);
          assert.equal(
            git(
              target.checkout,
              "rev-parse",
              `${attempt.resultCommitSha}^{tree}`,
            ),
            attempt.resultTreeSha,
          );
        } else {
          reviewedScopes.add("objective");
          assert.match(observations.integratedCommitSha, /^[0-9a-f]{40}$/);
          assert.equal(observations.integratedTreeSha, request.treeSha);
          assert.equal(
            git(
              target.checkout,
              "rev-parse",
              `${observations.integratedCommitSha}^{tree}`,
            ),
            observations.integratedTreeSha,
          );
          assert.equal(
            observations.work[0].resultTreeSha,
            request.commands[0].treeSha,
          );
          assert.match(observations.work[0].resultCommitSha, /^[0-9a-f]{40}$/);
          assert.deepEqual(
            observations.work[0].validationCommands,
            request.commands,
          );
          assert.equal(observations.work[0].validation, undefined);
          assert.ok(request.evidence.length >= 2);
          const inventory = request.evidence.find(
            (source) => source.path === "Exact result tree inventory",
          );
          assert.equal(inventory.complete, true);
          assert.equal(JSON.parse(inventory.content).treeSha, request.treeSha);
          const delta = request.evidence.find(
            (source) =>
              source.path === "Work Item Git delta: pnpm-workspace-bootstrap",
          );
          assert.equal(
            delta.path,
            "Work Item Git delta: pnpm-workspace-bootstrap",
          );
          assert.equal(delta.complete, true);
          assert.match(delta.content, /Factory supervisor exact Git evidence/);
          assert.doesNotMatch(delta.content, /"criteria":/);
          assert.doesNotMatch(request.observations, /"criteria":/);
        }
        return {
          findings: resultFindings(
            request,
            request.criteria.map((reviewedCriterion) => ({
              criterion: reviewedCriterion,
              verdict: "pass",
              source: "Command pass evidence",
              quote: request.commands[0].command,
              detail:
                "The canonical receipts prove the ordered commands passed at the exact result tree.",
              question: "",
            })),
          ),
        };
      },
    };
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/pnpm-receipt-integration",
        "regular",
        1,
      ),
      graph,
      objectiveBody,
      fakeRoot,
      planningModel,
      actions: {
        "pnpm-workspace-bootstrap": {
          files: [
            { path: ".gitignore", text: "node_modules/\n" },
            {
              path: "package.json",
              text: `${JSON.stringify(
                {
                  name: "factory-pnpm-receipt-fixture",
                  private: true,
                  type: "module",
                  scripts: {
                    check: "node --check src/index.js",
                    test: "node --test",
                  },
                },
                null,
                2,
              )}\n`,
            },
            {
              path: "pnpm-lock.yaml",
              text: "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
            },
            { path: "pnpm-workspace.yaml", text: "packages: []\n" },
            { path: "src/index.js", text: "export const value = 42;\n" },
            {
              path: "test/index.test.js",
              text: "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/index.js';\ntest('value', () => assert.equal(value, 42));\n",
            },
          ],
        },
      },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const { application } = makeApplication(descriptor);
      const acceptedPlan = await application.planObjective(objective);
      const completed = await application.runObjective(objective, acceptedPlan);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.finalAcceptancePending, undefined);
      assert.equal(
        completed.work["pnpm-workspace-bootstrap"].acceptancePending,
        undefined,
      );
      assert.deepEqual(reviewedScopes, new Set(["work-item", "objective"]));
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

test("application retries capacity for exact Work Item and final review requests without replaying work", async () => {
  await fixture("review-capacity-retry", async (root) => {
    const original = Codex.prototype.startThread;
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const command = 'test "$(cat review.txt)" = reviewed';
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [item("review-capacity", { path: "review.txt", command })],
    };
    const prompts = { work: [], final: [] };
    const successes = { work: false, final: false };
    let threadIndex = 0;
    Codex.prototype.startThread = function () {
      const id = `application-capacity-${threadIndex++}`;
      return {
        id,
        async runStreamed(prompt) {
          async function* events() {
            yield { type: "thread.started", thread_id: id };
            if (prompt.startsWith("Compile this human Objective")) {
              yield {
                type: "item.completed",
                item: {
                  id: `${id}-message`,
                  type: "agent_message",
                  text: JSON.stringify(
                    encodeCodexCitationIndexes(
                      withCoverage(
                        {
                          coverageObligations: JSON.parse(
                            prompt
                              .split("Controller obligations: ")[1]
                              .split(". Use parallel")[0],
                          ),
                        },
                        graph,
                      ),
                    ),
                  ),
                },
              };
              yield { type: "turn.completed", usage: null };
              return;
            }
            if (
              prompt.startsWith(
                "Independently review this complete proposed Factory plan",
              )
            ) {
              yield {
                type: "item.completed",
                item: {
                  id: `${id}-message`,
                  type: "agent_message",
                  text: JSON.stringify({ findings: [] }),
                },
              };
              yield { type: "turn.completed", usage: null };
              return;
            }
            const scope = packetFromPrompt(prompt).evidence.some(
              (e) =>
                e.path === "Delivery observations" &&
                e.content.includes('"reviewedItemId":"review-capacity"'),
            )
              ? "work"
              : "final";
            prompts[scope].push(prompt);
            if (!successes[scope]) {
              successes[scope] = true;
              yield {
                type: "turn.failed",
                error: { message: "Selected model is at capacity" },
              };
              return;
            }
            const packet = packetFromPrompt(prompt);
            yield {
              type: "item.completed",
              item: {
                id: `${id}-message`,
                type: "agent_message",
                text: JSON.stringify({
                  findings: packet.criteria.map(({ id: criterionId }) => ({
                    criterionId,
                    verdict: "pass",
                    evidenceIds: [
                      packet.evidence.find((e) => e.path === "OBJECTIVE").id,
                    ],
                    detail:
                      "The exact validated result satisfies the criterion.",
                    question: "",
                  })),
                }),
              },
            };
            yield { type: "turn.completed", usage: null };
          }
          return { events: events() };
        },
      };
    };
    try {
      const waits = [];
      const planningModel = new CodexPlanningModel(
        target.checkout,
        { model: "planner-choice", reasoningEffort: "medium" },
        { model: "reviewer-choice", reasoningEffort: "high" },
        undefined,
        {
          reviewCapacityRetryDelaysMs: [0, 0],
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
      );
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          "example/review-capacity-retry",
          "regular",
          1,
        ),
        graph,
        objectiveBody: body([command]),
        fakeRoot,
        planningModel,
        actions: {
          "review-capacity": {
            files: [{ path: "review.txt", text: "reviewed\n" }],
          },
        },
      };
      const { application, eventsPath } = makeApplication(descriptor);
      const plan = await application.planObjective(objective);
      assert.equal(plan.review.status, "clean");
      const completed = await application.runObjective(objective, plan);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.finalAcceptancePending, undefined);
      assert.equal(
        completed.work["review-capacity"].acceptancePending,
        undefined,
      );
      assert.equal(
        readEvents(eventsPath).filter(
          (event) => event.type === "start" && event.item === "review-capacity",
        ).length,
        1,
      );
      assert.deepEqual(waits, [0, 0]);
      assert.equal(prompts.work.length, 2);
      assert.equal(prompts.work[0], prompts.work[1]);
      assert.equal(prompts.final.length, 2);
      assert.equal(prompts.final[0], prompts.final[1]);
      const summary = summarizeModelInvocations(
        readDiagnostics(descriptor.config.repository, objective),
      );
      assert.equal(summary.byPhase["result-review"].invocationCount, 2);
      assert.equal(summary.byPhase["result-review"].failedCount, 1);
      assert.equal(summary.byPhase["result-review"].completedCount, 1);
      assert.equal(summary.byPhase["objective-review"].invocationCount, 2);
      assert.equal(summary.byPhase["objective-review"].failedCount, 1);
      assert.equal(summary.byPhase["objective-review"].completedCount, 1);
    } finally {
      Codex.prototype.startThread = original;
    }
  });
});

test("application fails closed once after exhausted result-review capacity without replaying work", async () => {
  await fixture("review-capacity-exhausted", async (root) => {
    const original = Codex.prototype.startThread;
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const command = 'test "$(cat exhausted.txt)" = validated';
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [item("review-exhausted", { path: "exhausted.txt", command })],
    };
    const resultPrompts = [];
    let threadIndex = 0;
    Codex.prototype.startThread = function () {
      const id = `application-exhausted-${threadIndex++}`;
      return {
        id,
        async runStreamed(prompt) {
          async function* events() {
            if (prompt.startsWith("Compile this human Objective")) {
              yield {
                type: "item.completed",
                item: {
                  id: `${id}-message`,
                  type: "agent_message",
                  text: JSON.stringify(
                    encodeCodexCitationIndexes(
                      withCoverage(
                        {
                          coverageObligations: JSON.parse(
                            prompt
                              .split("Controller obligations: ")[1]
                              .split(". Use parallel")[0],
                          ),
                        },
                        graph,
                      ),
                    ),
                  ),
                },
              };
              yield { type: "turn.completed", usage: null };
              return;
            }
            if (
              prompt.startsWith(
                "Independently review this complete proposed Factory plan",
              )
            ) {
              yield {
                type: "item.completed",
                item: {
                  id: `${id}-message`,
                  type: "agent_message",
                  text: JSON.stringify({ findings: [] }),
                },
              };
              yield { type: "turn.completed", usage: null };
              return;
            }
            resultPrompts.push(prompt);
            yield {
              type: "turn.failed",
              error: { message: "reviewer capacity unavailable" },
            };
          }
          return { events: events() };
        },
      };
    };
    try {
      const planningModel = new CodexPlanningModel(
        target.checkout,
        { model: "planner-choice", reasoningEffort: "medium" },
        { model: "reviewer-choice", reasoningEffort: "high" },
        undefined,
        {
          reviewCapacityRetryDelaysMs: [0, 0],
          wait: async () => {},
        },
      );
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          "example/review-capacity-exhausted",
          "regular",
          1,
        ),
        graph,
        objectiveBody: body([command]),
        fakeRoot,
        planningModel,
        actions: {
          "review-exhausted": {
            files: [{ path: "exhausted.txt", text: "validated\n" }],
          },
        },
      };
      const { application, eventsPath, github } = makeApplication(descriptor);
      const plan = await application.planObjective(objective);
      const waiting = await application.runObjective(objective, plan);
      assert.equal(waiting.work["review-exhausted"].status, "waiting");
      assert.equal(waiting.work["review-exhausted"].step, "approve-result");
      assert.match(
        waiting.work["review-exhausted"].acceptancePending.detail,
        /Independent review transport was invalid: reviewer capacity unavailable/,
      );
      assert.equal(resultPrompts.length, 3);
      assert.ok(resultPrompts.every((prompt) => prompt === resultPrompts[0]));
      assert.equal(
        readEvents(eventsPath).filter(
          (event) =>
            event.type === "start" && event.item === "review-exhausted",
        ).length,
        1,
      );
      assert.equal(Object.keys(github.state().pullRequests).length, 0);
      const summary = summarizeModelInvocations(
        readDiagnostics(descriptor.config.repository, objective),
      );
      assert.equal(summary.byPhase["result-review"].invocationCount, 3);
      assert.equal(summary.byPhase["result-review"].failedCount, 3);
      assert.equal(summary.byPhase["result-review"].completedCount, 0);
    } finally {
      Codex.prototype.startThread = original;
    }
  });
});

test("Work Item review receives exact concurrent-attempt provenance from run state", async () => {
  await fixture("result-provenance", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "roots.go");
    const commands = [
      'test "$(cat left.txt)" = left',
      'test "$(cat right.txt)" = right',
    ];
    const leftCriterion = `rc-left has no dependencies, starts at ${target.baseSha} independently of rc-right, and both attempts start before either result is integrated.`;
    const rightCriterion = `rc-right has no dependencies, starts at ${target.baseSha} independently of rc-left, and both attempts start before either result is integrated.`;
    const left = item("rc-left", {
      path: "left.txt",
      command: commands[0],
    });
    left.acceptance = ["left.txt has the scripted result", leftCriterion];
    left.citations = [{ path: "OBJECTIVE", heading: "Work Items" }];
    const right = item("rc-right", {
      path: "right.txt",
      command: commands[1],
    });
    right.acceptance = ["right.txt has the scripted result", rightCriterion];
    right.citations = [{ path: "OBJECTIVE", heading: "Work Items" }];
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [left, right],
    };
    const objectiveBody = `# Concurrent result provenance

## Work Items

- left.txt has the scripted result
- ${leftCriterion}
- right.txt has the scripted result
- ${rightCriterion}
- \`${commands[0]}\`
- \`${commands[1]}\`

## Acceptance

- The final tree contains both scripted results.

## Final validation

- \`${commands[0]}\`
- \`${commands[1]}\`
`;
    const reviewed = new Set();
    const planningModel = {
      async generateStructured(request) {
        return withCoverage(request, structuredClone(graph));
      },
      async reviewGraph() {
        return { findings: [] };
      },
      async reviewResult(request) {
        const source = request.sources.find(
          (candidate) => candidate.path === "OBJECTIVE",
        );
        const provenanceCriterion = request.criteria.find(
          (criterion) =>
            criterion === leftCriterion || criterion === rightCriterion,
        );
        let observations;
        if (provenanceCriterion) {
          observations = JSON.parse(request.observations);
          assert.equal(observations.objectiveBaseCommitSha, target.baseSha);
          const attempts = Object.fromEntries(
            observations.attempts.map((attempt) => [attempt.id, attempt]),
          );
          assert.deepEqual(Object.keys(attempts).sort(), [
            "rc-left",
            "rc-right",
          ]);
          assert.deepEqual(attempts["rc-left"].declaredDependencies, []);
          assert.deepEqual(attempts["rc-right"].declaredDependencies, []);
          for (const id of ["rc-left", "rc-right"]) {
            assert.deepEqual(Object.keys(attempts[id]).sort(), [
              "attemptId",
              "declaredDependencies",
              "executionBaseCommitSha",
              "id",
              "integratedCommitSha",
              "integrationAtStart",
              "ownedPaths",
              "resources",
              "resultCommitSha",
              "resultTreeSha",
              "startedAt",
            ]);
            assert.match(attempts[id].attemptId, /^[0-9a-f-]{36}$/);
            assert.equal(attempts[id].executionBaseCommitSha, target.baseSha);
            assert.deepEqual(attempts[id].integrationAtStart, {
              recorded: true,
              integratedCommitSha: null,
            });
            assert.match(attempts[id].resultCommitSha, /^[0-9a-f]{40}$/);
            assert.match(attempts[id].resultTreeSha, /^[0-9a-f]{40}$/);
            assert.ok(Number.isFinite(Date.parse(attempts[id].startedAt)));
          }
          if (observations.reviewedItemId === "rc-left") {
            assert.equal(observations.currentIntegratedCommitSha, null);
            assert.equal(attempts["rc-left"].integratedCommitSha, null);
            assert.equal(attempts["rc-right"].integratedCommitSha, null);
          } else {
            assert.equal(observations.reviewedItemId, "rc-right");
            assert.match(
              observations.currentIntegratedCommitSha,
              /^[0-9a-f]{40}$/,
            );
            assert.equal(
              attempts["rc-left"].integratedCommitSha,
              observations.currentIntegratedCommitSha,
            );
            assert.equal(attempts["rc-right"].integratedCommitSha, null);
          }
          reviewed.add(observations.reviewedItemId);
        }
        return {
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => {
              if (criterion === leftCriterion || criterion === rightCriterion) {
                return {
                  criterion,
                  verdict: "pass",
                  source: "Delivery observations",
                  quote: request.observations,
                  detail:
                    "The atomic snapshot proves both named dependency-free attempts started at the Objective base while the integrated head at each start was empty.",
                  question: "",
                };
              }
              assert.ok(source.content.includes(criterion));
              return {
                criterion,
                verdict: "pass",
                source: "OBJECTIVE",
                quote: criterion,
                detail:
                  "The pinned Objective and exact result prove this criterion.",
                question: "",
              };
            }),
          ),
        };
      },
    };
    const runStatus = [];
    const { application, eventsPath } = makeApplication({
      config: factoryConfig(
        target.checkout,
        "example/result-provenance",
        "native-stack",
        2,
      ),
      graph,
      objectiveBody,
      fakeRoot,
      planningModel,
      actions: {
        "rc-left": {
          barrier,
          files: [{ path: "left.txt", text: "left\n" }],
        },
        "rc-right": {
          barrier,
          files: [{ path: "right.txt", text: "right\n" }],
        },
      },
      reportRunStatus: (message) => runStatus.push(message),
    });
    const running = application.runObjective(objective);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return starts.length === 2 ? starts : undefined;
      },
      fakeRoot,
      "both provenance roots",
    );
    mkdirSync(dirname(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const completed = await running;
    assert.deepEqual(runStatus, [
      "Factory: compiling and independently reviewing a fresh plan",
    ]);
    assert.ok(completed.finalValidation, JSON.stringify(completed, null, 2));
    assert.equal(completed.finalValidation.passed, true);
    assert.deepEqual(reviewed, new Set(["rc-left", "rc-right"]));
    assert.equal(completed.work["rc-left"].executionBaseSha, target.baseSha);
    assert.equal(completed.work["rc-right"].executionBaseSha, target.baseSha);
    assert.equal(completed.work["rc-left"].integratedShaAtStart, null);
    assert.equal(completed.work["rc-right"].integratedShaAtStart, null);
    assert.equal(
      completed.work["rc-right"].baseSha,
      completed.work["rc-left"].integratedSha,
    );
    assert.notEqual(completed.work["rc-right"].baseSha, target.baseSha);
    for (const id of reviewed)
      assert.equal(
        completed.work[id].validation.criteria.at(-1).verdict,
        "pass",
      );
  });
});

test("native successor review receives its exact predecessor result head", async () => {
  await fixture("native-predecessor-provenance", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const commands = [
      'test "$(cat foundation.txt)" = foundation',
      'test "$(cat successor.txt)" = successor',
      'test "$(cat top.txt)" = top',
    ];
    const predecessorCriterion =
      "successor is the second native stack layer and uses foundation as its exact predecessor base";
    const topCriterion =
      "top is the third native stack layer and completes the maximal three-layer stack after successor";
    const foundation = item("foundation", {
      path: "foundation.txt",
      command: commands[0],
    });
    const successor = item("successor", {
      path: "successor.txt",
      command: commands[1],
      dependencies: ["foundation"],
    });
    successor.acceptance = [
      "successor.txt has the scripted result",
      predecessorCriterion,
    ];
    const top = item("top", {
      path: "top.txt",
      command: commands[2],
      dependencies: ["successor"],
    });
    top.acceptance = ["top.txt has the scripted result", topCriterion];
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [foundation, successor, top],
    };
    const objectiveBody = `# Native predecessor provenance

## Work Items

- foundation.txt has the scripted result
- successor.txt has the scripted result
- ${predecessorCriterion}
- top.txt has the scripted result
- ${topCriterion}
- \`${commands[0]}\`
- \`${commands[1]}\`
- \`${commands[2]}\`

## Acceptance

- The final tree contains all three scripted results.

## Final validation

- \`${commands[0]}\`
- \`${commands[1]}\`
- \`${commands[2]}\`
`;
    const observedProofs = new Set();
    const planningModel = {
      async generateStructured(request) {
        return withCoverage(request, structuredClone(graph));
      },
      async reviewGraph() {
        return { findings: [] };
      },
      async reviewResult(request) {
        return {
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => {
              if (
                criterion === predecessorCriterion ||
                criterion === topCriterion
              ) {
                const observations = JSON.parse(request.observations);
                const attempts = Object.fromEntries(
                  observations.attempts.map((attempt) => [attempt.id, attempt]),
                );
                const isMiddle = criterion === predecessorCriterion;
                const currentId = isMiddle ? "successor" : "top";
                const predecessorId = isMiddle ? "foundation" : "successor";
                assert.equal(observations.reviewedItemId, currentId);
                assert.deepEqual(observations.delivery, {
                  kind: "native-stack",
                  unitId: "foundation",
                  layerNumber: isMiddle ? 2 : 3,
                  layerCount: 3,
                  predecessorItemId: predecessorId,
                });
                assert.deepEqual(
                  Object.keys(attempts).sort(),
                  [currentId, predecessorId].sort(),
                );
                assert.match(
                  attempts[predecessorId].resultCommitSha,
                  /^[0-9a-f]{40}$/,
                );
                assert.equal(
                  attempts[currentId].executionBaseCommitSha,
                  attempts[predecessorId].resultCommitSha,
                );
                assert.equal(attempts[predecessorId].integratedCommitSha, null);
                observedProofs.add(criterion);
                return {
                  criterion,
                  verdict: "pass",
                  source: "Delivery observations",
                  quote: request.observations,
                  detail:
                    "The native layer position is explicit and the predecessor result head exactly equals the successor execution base.",
                  question: "",
                };
              }
              return {
                criterion,
                verdict: "pass",
                source: "OBJECTIVE",
                quote: criterion,
                detail: "The pinned Objective states this exact criterion.",
                question: "",
              };
            }),
          ),
        };
      },
    };
    const { application } = makeApplication({
      config: factoryConfig(
        target.checkout,
        "example/native-predecessor-provenance",
        "native-stack",
        1,
      ),
      graph,
      objectiveBody,
      fakeRoot,
      planningModel,
      actions: {
        foundation: {
          files: [{ path: "foundation.txt", text: "foundation\n" }],
        },
        successor: {
          files: [{ path: "successor.txt", text: "successor\n" }],
        },
        top: { files: [{ path: "top.txt", text: "top\n" }] },
      },
    });
    const completed = await application.runObjective(objective);
    assert.ok(completed.finalValidation, JSON.stringify(completed, null, 2));
    assert.equal(completed.finalValidation.passed, true);
    assert.deepEqual(
      observedProofs,
      new Set([predecessorCriterion, topCriterion]),
    );
    assert.equal(completed.work.successor.acceptancePending, undefined);
    assert.equal(completed.work.successor.acceptanceDecisions, undefined);
    assert.equal(completed.work.top.acceptancePending, undefined);
    assert.equal(completed.work.top.acceptanceDecisions, undefined);
  });
});

test("an explicitly accepted malformed graph review runs the same pinned graph without re-review", async () => {
  await fixture("malformed-graph-integration", async (root) => {
    const target = createTarget(root);
    const command = 'test "$(cat alpha.txt)" = alpha';
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [item("alpha", { path: "alpha.txt", command })],
    };
    let reviewCount = 0;
    const planningModel = {
      async generateStructured(request) {
        return withCoverage(request, structuredClone(graph));
      },
      async reviewGraph() {
        reviewCount += 1;
        return {
          findings: [
            {
              source: "invented",
              quote: "not in any pinned source",
              detail: "Malformed source citation",
              question: "Approve?",
            },
          ],
        };
      },
      async reviewResult(request) {
        return {
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              verdict: "pass",
              source: "OBJECTIVE",
              quote: "## Acceptance",
              detail:
                "The scripted result and command evidence prove this criterion",
              question: "",
            })),
          ),
        };
      },
    };
    const { application, github } = makeApplication({
      config: factoryConfig(
        target.checkout,
        "example/malformed-graph-integration",
        "regular",
        1,
      ),
      graph,
      objectiveBody: body([command]),
      fakeRoot: join(root, "fake"),
      planningModel,
      actions: { alpha: { files: [{ path: "alpha.txt", text: "alpha\n" }] } },
    });
    const candidate = await application.planObjective(objective);
    assert.equal(candidate.review.status, "needs-human");
    assert.equal(Object.keys(github.state().issues).length, 0);
    assert.equal(
      existsSync(statePath("example/malformed-graph-integration", objective)),
      false,
    );
    await assert.rejects(
      application.runObjective(objective, {
        ...candidate,
        review: {
          ...candidate.review,
          status: "clean",
          findings: [],
          failure: undefined,
        },
      }),
      /differs from the current Objective/,
    );
    assert.equal(Object.keys(github.state().issues).length, 0);
    assert.equal(
      existsSync(statePath("example/malformed-graph-integration", objective)),
      false,
    );
    assert.equal(reviewCount, 1);
    const accepted = await application.decidePlan(objective, candidate, {
      actor: "test operator",
      outcome: "accept",
      answer: "I inspected the exact graph and accept its sole item",
      reason: "Pinned Objective and graph match",
    });
    assert.equal(accepted.review.status, "human-accepted");
    assert.equal(reviewCount, 1);
    const completed = await application.runObjective(objective, accepted);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(reviewCount, 1);
  });
});

test("clean accepted plan activates without planning calls and rejects config drift", async () => {
  await fixture("clean-plan-activation", async (root) => {
    const target = createTarget(root);
    const command = 'test "$(cat clean.txt)" = clean';
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [item("clean", { path: "clean.txt", command })],
    };
    const config = factoryConfig(
      target.checkout,
      "example/clean-plan-activation",
      "regular",
      1,
    );
    let generationCount = 0;
    let reviewCount = 0;
    let reviewedPacket;
    const planningModel = {
      async generateStructured(request) {
        generationCount += 1;
        return withCoverage(request, structuredClone(graph));
      },
      async reviewGraph(request) {
        reviewCount += 1;
        const { invocation: _invocation, ...packet } = request;
        reviewedPacket = structuredClone(packet);
        return { findings: [] };
      },
      async reviewResult(request) {
        return {
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              verdict: "pass",
              source: "OBJECTIVE",
              quote: "## Acceptance",
              detail: "The scripted result proves the exact criterion",
              question: "",
            })),
          ),
        };
      },
    };
    const { application, github } = makeApplication({
      config,
      graph,
      objectiveBody: body([command]),
      fakeRoot: join(root, "fake"),
      planningModel,
      actions: { clean: { files: [{ path: "clean.txt", text: "clean\n" }] } },
    });
    const candidate = await application.planObjective(objective);
    assert.equal(candidate.review.status, "clean");
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);
    assert.deepEqual(reviewedPacket.commands, candidate.commands);
    assert.deepEqual(reviewedPacket.finalCommands, [command]);

    config.planning.reviewer.reasoningEffort = "high";
    await assert.rejects(
      application.runObjective(objective, candidate),
      /differs from the current Objective/,
    );
    assert.equal(Object.keys(github.state().issues).length, 0);
    assert.equal(existsSync(statePath(config.repository, objective)), false);
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);

    config.planning.reviewer.reasoningEffort = "medium";
    config.execution.harness.model = "worker-choice";
    await assert.rejects(
      application.runObjective(objective, candidate),
      /differs from the current Objective/,
    );
    assert.equal(Object.keys(github.state().issues).length, 0);
    assert.equal(existsSync(statePath(config.repository, objective)), false);
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);

    config.execution.harness.model = "gpt-5.6-sol";
    const completed = await application.runObjective(objective, candidate);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);
  });
});

test("application lifecycle reattaches once, cancels owned work, and retries only explicitly", async () => {
  await fixture("lifecycle-restart", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "restart.go");
    const command = 'test "$(cat restart.txt)" = resumed';
    const descriptor = {
      config: factoryConfig(target.checkout, "example/lifecycle-restart"),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("restart", { path: "restart.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        restart: {
          barrier,
          files: [{ path: "restart.txt", text: "resumed\n" }],
        },
      },
    };
    const descriptorPath = join(root, "restart.json");
    writeDescriptor(descriptorPath, descriptor);
    const restartStatePath = statePath(descriptor.config.repository, objective);
    mkdirSync(dirname(restartStatePath), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "support", "restart-controller.mjs"),
        descriptorPath,
        String(objective),
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, XDG_STATE_HOME: process.env.XDG_STATE_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childOutput = "";
    child.stdout.on("data", (chunk) => (childOutput += chunk));
    child.stderr.on("data", (chunk) => (childOutput += chunk));
    try {
      await waitForFile(
        () => {
          const state = existsSync(restartStatePath)
            ? readContinuation(descriptor.config.repository, objective)
            : undefined;
          return state?.schemaVersion === 2 && state.work.restart.execution
            ? state
            : undefined;
        },
        restartStatePath,
        "persisted restart handle",
      );
    } catch (error) {
      const detail = `${error.message}; child=${child.exitCode ?? "running"}; output=${childOutput}; events=${JSON.stringify(readEvents(join(fakeRoot, "harness.ndjson")))}`;
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      throw new Error(detail);
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const runStatus = [];
    descriptor.reportRunStatus = (message) => runStatus.push(message);
    const { application, eventsPath, github } = makeApplication(descriptor);
    const resumed = await application.runObjective(objective);
    assert.deepEqual(runStatus, [
      "Factory: resuming the existing run from atomic state",
    ]);
    assert.equal(resumed.finalValidation.passed, true);
    assert.equal(Object.keys(github.state().pullRequests).length, 1);
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "restart",
      ).length,
      1,
    );
    const restartTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(
      restartTimeline.filter(
        (event) =>
          event.operation === "objective-run" && event.outcome === "started",
      ).length >= 2,
    );
    assert.ok(
      restartTimeline.some(
        (event) =>
          event.operation === "harness" &&
          event.attemptId === resumed.work.restart.attempt,
      ),
    );
  });

  await fixture("lifecycle-cancel", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "cancel.go");
    const command = 'test "$(cat retry.txt)" = retried';
    const descriptor = {
      config: factoryConfig(target.checkout, "example/lifecycle-cancel"),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("retry", { path: "retry.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        retry: {
          barrier,
          files: [{ path: "retry.txt", text: "retried\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    const unrelated = join(root, "unrelated-process-sentinel");
    writeFileSync(unrelated, "untouched\n");
    const running = application.runObjective(objective);
    await waitFor(
      () =>
        readEvents(eventsPath).some(
          (event) => event.type === "start" && event.item === "retry",
        ),
      fakeRoot,
      "cancellable owned attempt",
    );
    assert.equal(await application.cancelObjective(objective), "requested");
    await assert.rejects(running, /cancel/i);
    assert.equal(readFileSync(unrelated, "utf8"), "untouched\n");
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      1,
    );
    const cancelled = readState(descriptor.config.repository, objective);
    assert.equal(cancelled.work.retry.status, "cancelled");
    assert.ok(
      readDiagnostics(descriptor.config.repository, objective).some(
        (event) => event.itemId === "retry" && event.outcome === "failed",
      ),
    );
    application.retryWorkItem(objective, "retry");
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      1,
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const retried = await application.runObjective(objective);
    assert.equal(retried.finalValidation.passed, true);
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      2,
    );
    const retryTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(retryTimeline.some((event) => event.operation === "work-retry"));
    assert.ok(
      retryTimeline.some(
        (event) =>
          event.operation === "objective-finalization" &&
          event.outcome === "completed",
      ),
    );
  });
});

test("native application path runs a linear stack beside an independent replayed lane", async () => {
  await fixture("native-integration", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "native-roots.go");
    const commands = [
      'test "$(cat stack-a.txt)" = A',
      'test "$(cat stack-b.txt)" = B',
      'test "$(cat lane.txt)" = lane',
    ];
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-integration",
        "native-stack",
        2,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("stack-a", { path: "stack-a.txt", command: commands[0] }),
          item("stack-b", {
            path: "stack-b.txt",
            command: commands[1],
            dependencies: ["stack-a"],
          }),
          item("lane", { path: "lane.txt", command: commands[2] }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot,
      actions: {
        "stack-a": {
          barrier,
          files: [{ path: "stack-a.txt", text: "A\n" }],
        },
        "stack-b": { files: [{ path: "stack-b.txt", text: "B\n" }] },
        lane: { barrier, files: [{ path: "lane.txt", text: "lane\n" }] },
      },
    };
    const { application, eventsPath, github } = makeApplication(descriptor);
    const running = application.runObjective(objective);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return starts.some((event) => event.item === "stack-a") &&
          starts.some((event) => event.item === "lane")
          ? starts
          : undefined;
      },
      fakeRoot,
      "native independent roots",
    );
    assert.ok(
      !readEvents(eventsPath).some(
        (event) => event.type === "start" && event.item === "stack-b",
      ),
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.equal(state.finalValidation.passed, true);
    const starts = readEvents(eventsPath).filter(
      (event) => event.type === "start",
    );
    assert.equal(
      starts.find((event) => event.item === "stack-a").baseSha,
      target.baseSha,
    );
    assert.equal(
      starts.find((event) => event.item === "lane").baseSha,
      target.baseSha,
    );
    assert.equal(
      starts.find((event) => event.item === "stack-b").baseSha,
      state.work["stack-a"].changeRef,
    );
    const remote = github.state();
    const stackEvent = remote.events.find(
      (event) => event.type === "merge-stack",
    );
    assert.ok(stackEvent);
    assert.equal(state.work.lane.baseSha, stackEvent.integratedSha);
    assert.equal(state.work.lane.validation.treeSha, state.work.lane.treeSha);
    assert.equal(
      git(target.checkout, "rev-parse", `${state.work.lane.changeRef}^`),
      stackEvent.integratedSha,
    );
    const stackPulls = [
      state.work["stack-a"].pullRequest,
      state.work["stack-b"].pullRequest,
    ];
    assert.equal(remote.pullRequests[stackPulls[0]].base, "main");
    assert.equal(
      remote.pullRequests[stackPulls[1]].base,
      "factory/objective-1/stack-a",
    );
    const timeline = readDiagnostics(descriptor.config.repository, objective);
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "github-stack" &&
          event.outcome === "completed" &&
          event.durationMs >= 0,
      ),
    );
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "github-stack-merge" &&
          event.outcome === "completed" &&
          event.durationMs >= 0 &&
          event.metadata?.integratedSha === stackEvent.integratedSha,
      ),
    );
  });
});

test("native delivery admits a later dependency wave while serializing a conflicting sibling", async () => {
  await fixture("native-wave", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "children.go");
    const ids = ["foundation", "left", "right", "conflict", "join"];
    const commands = ids.map((id) => `test -s ${id}.txt`);
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-wave",
        "native-stack",
        3,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("foundation", { path: "foundation.txt", command: commands[0] }),
          item("left", {
            path: "left.txt",
            command: commands[1],
            dependencies: ["foundation"],
            resources: ["shared"],
          }),
          item("right", {
            path: "right.txt",
            command: commands[2],
            dependencies: ["foundation"],
          }),
          item("conflict", {
            path: "conflict.txt",
            command: commands[3],
            dependencies: ["foundation"],
            resources: ["shared"],
          }),
          item("join", {
            path: "join.txt",
            command: commands[4],
            dependencies: ["left", "right"],
          }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot,
      actions: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ...(id === "left" || id === "right" ? { barrier } : {}),
            files: [{ path: `${id}.txt`, text: `${id}\n` }],
          },
        ]),
      ),
    };
    const { application, eventsPath } = makeApplication(descriptor);
    const running = application.runObjective(objective);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return (
          starts.some((event) => event.item === "left") &&
          starts.some((event) => event.item === "right")
        );
      },
      fakeRoot,
      "concurrent post-foundation children",
    );
    const beforeRelease = readEvents(eventsPath);
    assert.ok(
      beforeRelease.some(
        (event) => event.type === "complete" && event.item === "foundation",
      ),
    );
    assert.ok(
      !beforeRelease.some(
        (event) => event.type === "start" && event.item === "conflict",
      ),
    );
    assert.ok(
      !beforeRelease.some(
        (event) => event.type === "start" && event.item === "join",
      ),
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.equal(state.finalValidation.passed, true);
    const events = readEvents(eventsPath);
    const start = (id) =>
      events.findIndex((event) => event.type === "start" && event.item === id);
    const complete = (id) =>
      events.findIndex(
        (event) => event.type === "complete" && event.item === id,
      );
    assert.ok(start("left") > complete("foundation"));
    assert.ok(start("right") > complete("foundation"));
    assert.ok(start("conflict") > complete("left"));
    assert.ok(start("join") > complete("left"));
    assert.ok(start("join") > complete("right"));
    assert.equal(state.work.right.validation.treeSha, state.work.right.treeSha);
  });
});

test("native execution failure is terminal until an explicit safe retry", async () => {
  await fixture("native-retry", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const command = "test -s retry.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-retry",
        "native-stack",
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("retry", { path: "retry.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        retry: {
          failAttempts: 1,
          files: [{ path: "retry.txt", text: "retried\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(objective),
      /Scripted failure for retry/,
    );
    const failed = readState(descriptor.config.repository, objective);
    assert.equal(failed.work.retry.status, "failed");
    assert.match(failed.work.retry.error, /Scripted failure for retry/);
    assert.equal(failed.work.retry.pullRequest, undefined);
    const failureTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(
      failureTimeline.some(
        (event) =>
          event.itemId === "retry" &&
          event.attemptId === failed.work.retry.attempt &&
          event.outcome === "failed" &&
          /Scripted failure/.test(event.detail),
      ),
    );
    await assert.rejects(application.runObjective(objective), /explicit retry/);
    application.retryWorkItem(objective, "retry");
    const done = await application.runObjective(objective);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "retry",
      ).length,
      2,
    );
    const retryTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(retryTimeline.some((event) => event.operation === "work-retry"));
    assert.ok(
      retryTimeline.some(
        (event) =>
          event.itemId === "retry" &&
          event.attemptId === done.work.retry.attempt &&
          event.outcome === "completed",
      ),
    );
  });
});

test("native retry stops when its stack already has a published layer", async () => {
  await fixture("native-published-retry", async (root) => {
    const target = createTarget(root);
    const commands = ["test -s first.txt", "test -s second.txt"];
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-published-retry",
        "native-stack",
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("first", { path: "first.txt", command: commands[0] }),
          item("second", {
            path: "second.txt",
            command: commands[1],
            dependencies: ["first"],
          }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot: join(root, "fake"),
      actions: {
        first: { files: [{ path: "first.txt", text: "first\n" }] },
        second: {
          failAttempts: 1,
          files: [{ path: "second.txt", text: "second\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(objective),
      /Scripted failure for second/,
    );
    const state = readState(descriptor.config.repository, objective);
    assert.ok(state.work.first.pullRequest);
    assert.equal(state.work.second.status, "failed");
    assert.throws(
      () => application.retryWorkItem(objective, "second"),
      /Published PR requires operator direction/,
    );
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "second",
      ).length,
      1,
    );
  });
});

test("regular and native asset selection preserve a complete set and hydrate target-owned LFS bytes", async () => {
  for (const delivery of ["regular", "native-stack"])
    await fixture(`asset-integration-${delivery}`, async (root) => {
      const selectedModel = Buffer.concat([
        Buffer.from("selected model bytes", "utf8"),
        Buffer.from([0, 1, 2]),
      ]);
      const target = createTarget(root, {
        "approved/model.bin": selectedModel,
      });
      writeFileSync(
        join(target.checkout, ".gitattributes"),
        "approved/*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      git(target.checkout, "add", ".gitattributes");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Require LFS for approved binaries",
      );
      git(target.checkout, "push", "origin", "main");
      target.baseSha = git(target.checkout, "rev-parse", "HEAD");
      git(target.checkout, "lfs", "install", "--local");
      const fakeRoot = join(root, "fake");
      const selectedDigest = createHash("sha256")
        .update(selectedModel)
        .digest("hex");
      const command = `sha256sum approved/model.bin | grep -qx '${selectedDigest}  approved/model.bin' && test "$(cat approved/metadata.json)" = '{"candidate":"b"}'`;
      const consumerCommand = "test -s approved/consumed.txt";
      const media = item("media", {
        path: "approved/model.bin",
        command,
        ownedPaths: ["approved/model.bin", "approved/metadata.json"],
        sourceAssets: [
          {
            kind: "repository",
            path: "approved/model.bin",
            role: "source",
            mediaType: "application/octet-stream",
            visibility: "repository",
          },
        ],
        expectedOutputRoles: ["model", "metadata"],
        minimumAssetSets: 2,
        requiredLfsRoles: ["model"],
      });
      const provenanceCriterion =
        "The selected set's source, rights basis, repository visibility, and lineage are declared in .factory-assets.json.";
      const sourceIdentityCriterion =
        "The selected model is copied byte-for-byte from the repository source approved/model.bin and bound back to that destination.";
      const materializationCriterion =
        "The worker does not write, remove, or change the final destination; Factory materializes only the human-selected candidate to approved/model.bin and approved/metadata.json.";
      media.acceptance.push(
        provenanceCriterion,
        sourceIdentityCriterion,
        materializationCriterion,
      );
      const provenance = {
        source: "approved/model.bin",
        rights: "public integration fixture",
        visibility: "repository",
        lineage: ["approved/model.bin"],
      };
      const consumer = item("consumer", {
        path: "approved/consumed.txt",
        command: consumerCommand,
        dependencies: ["media"],
      });
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          `example/asset-integration-${delivery}`,
          delivery,
        ),
        graph: { objective, baseSha: target.baseSha, items: [media, consumer] },
        objectiveBody: `# Deterministic Objective

## Acceptance
- Fresh-clone hydration preserves the selected bytes at approved/model.bin.
- \`${command}\`
- \`${consumerCommand}\`

## Final validation
- \`${command}\`
- \`${consumerCommand}\`
`,
        fakeRoot,
        actions: {
          media: {
            assets: [
              {
                id: "candidate-a",
                members: [
                  {
                    role: "model",
                    file: "model.bin",
                    mediaType: "application/octet-stream",
                    destination: "approved/model.bin",
                    text: "other model bytes",
                  },
                  {
                    role: "metadata",
                    file: "metadata.json",
                    mediaType: "application/json",
                    destination: "approved/metadata.json",
                    text: '{"candidate":"a"}\n',
                  },
                ],
                provenance,
              },
              {
                id: "candidate-b",
                members: [
                  {
                    role: "model",
                    file: "model.bin",
                    mediaType: "application/octet-stream",
                    destination: "approved/model.bin",
                    base64: selectedModel.toString("base64"),
                  },
                  {
                    role: "metadata",
                    file: "metadata.json",
                    mediaType: "application/json",
                    destination: "approved/metadata.json",
                    text: '{"candidate":"b"}\n',
                  },
                ],
                relationships: [
                  {
                    from: "approved/model.bin",
                    toRole: "model",
                    kind: "derived-from",
                  },
                ],
                provenance,
              },
            ],
          },
          consumer: {
            consumeSelected: {
              roles: ["model", "metadata"],
              output: "approved/consumed.txt",
            },
          },
        },
      };
      const { application, github, planningPath, contentStore } =
        makeApplication(descriptor);
      const publish = github.publish.bind(github);
      let lfsObjectObservedBeforePublication = false;
      github.publish = async (request) => {
        const pointer = git(
          target.checkout,
          "show",
          `origin/${request.branch}:approved/model.bin`,
        );
        const digest = pointer.match(/oid sha256:([a-f0-9]{64})/)?.[1];
        if (digest) {
          assert.equal(
            existsSync(
              join(
                target.origin,
                "lfs",
                "objects",
                digest.slice(0, 2),
                digest.slice(2, 4),
                digest,
              ),
            ),
            true,
          );
          lfsObjectObservedBeforePublication = true;
        }
        return publish(request);
      };
      const waiting = await application.runObjective(objective);
      assert.equal(waiting.work.media.status, "waiting");
      assert.equal(waiting.work.media.assets.length, 2);
      assert.equal(waiting.work.media.assets[1].members.length, 2);
      const review = join(root, "review");
      await application.exportAssetSetForReview(
        objective,
        "media",
        "candidate-b",
        review,
      );
      assert.deepEqual(
        readFileSync(join(review, "model-model.bin")),
        selectedModel,
      );
      assert.equal(
        readFileSync(join(review, "metadata-metadata.json"), "utf8"),
        '{"candidate":"b"}\n',
      );
      const selection = {
        actor: "test-operator",
        reason: "reviewed opaque pair",
        downstreamItems: ["consumer"],
      };
      if (delivery === "regular")
        await selectAssetSetFromCli(
          descriptor.config,
          objective,
          "media",
          "candidate-b",
          contentStore,
          selection,
        );
      else
        await application.selectAssetSet(objective, "media", "candidate-b", {
          ...selection,
          surface: "factory-cli",
        });
      const completed = await application.runObjective(objective);
      assert.equal(lfsObjectObservedBeforePublication, true);
      assert.ok(
        github
          .state()
          .events.some((event) =>
            delivery === "native-stack"
              ? event.type === "merge-stack"
              : event.type === "merge",
          ),
      );
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.finalValidation.hydrationReceipt.passed, true);
      assert.equal(
        completed.finalValidation.hydrationReceipt.integratedSha,
        completed.integratedSha,
      );
      assert.equal(
        completed.finalValidation.hydrationReceipt.members[0].observedDigest,
        completed.work.media.assets[1].members[0].ref.digest,
      );
      assert.equal(completed.work.media.selectedAssetSet, "candidate-b");
      assert.equal(completed.work.media.selection.actor, "test-operator");
      const mediaReview = readEvents(planningPath)
        .filter(
          (event) =>
            event.type === "result-review" &&
            event.observations?.reviewedItemId === "media",
        )
        .at(-1);
      const consumerReview = readEvents(planningPath).find(
        (event) =>
          event.type === "result-review" &&
          event.observations?.reviewedItemId === "consumer",
      );
      const dependencyProof = JSON.parse(
        consumerReview.evidence.find(
          (entry) => entry.path === "Completed dependency results",
        ).content,
      );
      assert.equal(dependencyProof.work.length, 1);
      const priorMedia = dependencyProof.work[0];
      assert.equal(priorMedia.id, "media");
      assert.equal(priorMedia.resultTreeSha, completed.work.media.treeSha);
      assert.equal(
        priorMedia.validationCommands[0].treeSha,
        priorMedia.resultTreeSha,
      );
      assert.equal(
        priorMedia.integratedCommitSha,
        delivery === "regular" ? completed.work.media.integratedSha : null,
      );
      assert.equal(
        priorMedia.status,
        delivery === "regular" ? "done" : "published",
      );
      assert.ok(
        consumerReview.evidence.some(
          (entry) => entry.path === "Work Item Git delta: media",
        ),
      );
      assert.ok(
        consumerReview.evidence.some(
          (entry) =>
            entry.path ===
            "Work Item Git delta: media controller materialization",
        ),
      );
      assert.equal(mediaReview.observations.delivery.kind, delivery);
      assert.equal(mediaReview.observations.assetCaptureReceipts.length, 2);
      assert.ok(
        mediaReview.observations.assetCaptureReceipts.every(
          (receipt) =>
            receipt.authority === "factory-controller" &&
            receipt.declarationPath === ".factory-assets.json" &&
            JSON.stringify(receipt.declarationProvenance) ===
              JSON.stringify(provenance) &&
            receipt.inputs?.length === 1 &&
            receipt.inputs[0].binding.path === "approved/model.bin" &&
            receipt.inputs[0].ref.digest === selectedDigest &&
            receipt.mediaRoot === ".factory-media" &&
            receipt.complete === true,
        ),
      );
      const selectedReceipt =
        mediaReview.observations.assetCaptureReceipts.find(
          (receipt) => receipt.setId === "candidate-b",
        );
      assert.equal(
        selectedReceipt.inputs[0].ref.digest,
        selectedReceipt.members.find(
          (member) => member.destination === "approved/model.bin",
        ).digest,
      );
      assert.equal(
        mediaReview.observations.assetSelectionReceipt.setId,
        "candidate-b",
      );
      assert.equal(
        mediaReview.observations.assetSelectionReceipt.surface,
        delivery === "regular" ? "factory-cli" : "application",
      );
      const materializationEvidence = mediaReview.evidence.find((entry) =>
        entry.path.endsWith("controller materialization"),
      );
      assert.equal(materializationEvidence.complete, true);
      const materializationChunks = mediaReview.evidence.filter((entry) =>
        entry.path.startsWith(
          `${materializationEvidence.path} controller result file `,
        ),
      );
      assert.ok(materializationChunks.length > 0);
      assert.ok(
        materializationChunks.every((entry) =>
          entry.content.includes("\ndiff --git "),
        ),
      );
      const materializationPacket = JSON.parse(
        materializationEvidence.content.split("\n")[0],
      );
      assert.equal(
        materializationPacket.authority,
        "Factory supervisor controller materialization evidence",
      );
      assert.deepEqual(materializationPacket.workerDestinationChanges, []);
      assert.deepEqual(
        materializationPacket.destinations.map((entry) => entry.path),
        ["approved/model.bin", "approved/metadata.json"],
      );
      assert.deepEqual(
        materializationPacket.materializationChange.changes.map(
          (entry) => entry.path,
        ),
        ["approved/metadata.json", "approved/model.bin"],
      );
      assert.ok(
        materializationPacket.workerResultCommitSha ===
          materializationPacket.resultBaseCommitSha ||
          materializationPacket.workerChange.changes.length > 0,
      );
      const finalReview = readEvents(planningPath)
        .filter(
          (event) =>
            event.type === "result-review" &&
            event.observations?.integratedCommitSha,
        )
        .at(-1);
      assert.ok(
        finalReview.evidence.some(
          (entry) => entry.path === materializationEvidence.path,
        ),
      );
      assert.deepEqual(completed.work.media.selection.downstreamItems, [
        "consumer",
      ]);
      const mediaTimeline = readDiagnostics(
        descriptor.config.repository,
        objective,
      );
      assert.ok(
        mediaTimeline.some(
          (event) =>
            event.itemId === "media" &&
            event.operation === "media-review-export" &&
            event.outcome === "completed",
        ),
      );
      const hydrationIndex = mediaTimeline.findIndex(
        (event) =>
          event.operation === "media-hydration-verification" &&
          event.outcome === "completed",
      );
      const reviewIndex = mediaTimeline.findIndex(
        (event) =>
          event.operation === "objective-acceptance-review" &&
          event.outcome === "started",
      );
      assert.ok(hydrationIndex >= 0 && hydrationIndex < reviewIndex);
      const hydrationEvent = mediaTimeline[hydrationIndex];
      assert.deepEqual(Object.keys(hydrationEvent.metadata).sort(), [
        "integratedSha",
        "members",
        "treeSha",
      ]);
      assert.equal(hydrationEvent.detail, undefined);
      assert.ok(
        mediaTimeline.some(
          (event) =>
            event.itemId === "media" &&
            event.operation === "media-selection" &&
            event.metadata?.setId === "candidate-b",
        ),
      );
      assert.ok(
        mediaTimeline.some(
          (event) =>
            event.itemId === "media" &&
            event.operation === "media-materialization" &&
            event.outcome === "completed" &&
            event.durationMs >= 0,
        ),
      );
      assert.deepEqual(
        completed.work.media.selection.destinations.map((entry) => entry.role),
        ["model", "metadata"],
      );
      git(target.checkout, "fetch", "origin", "main");
      const pointer = git(
        target.checkout,
        "show",
        `${completed.integratedSha}:approved/model.bin`,
      );
      assert.match(pointer, /oid sha256:/);
      const clone = join(root, "hydrated");
      execFileSync("git", ["clone", "--no-checkout", target.origin, clone], {
        stdio: "ignore",
      });
      git(clone, "lfs", "install", "--local");
      git(clone, "checkout", "--detach", completed.integratedSha);
      git(clone, "lfs", "pull");
      assert.deepEqual(
        readFileSync(join(clone, "approved/model.bin")),
        selectedModel,
      );
      assert.equal(
        readFileSync(join(clone, "approved/metadata.json"), "utf8"),
        '{"candidate":"b"}\n',
      );
      assert.equal(
        readFileSync(join(clone, "approved/consumed.txt"), "utf8"),
        `model:${selectedModel.toString("hex")}\nmetadata:${Buffer.from('{"candidate":"b"}\n').toString("hex")}\n`,
      );
      const tampered = structuredClone(completed);
      tampered.finalValidation.hydrationReceipt.members[0].observedDigest =
        "0".repeat(64);
      assert.throws(
        () =>
          parseFactoryState(tampered, descriptor.config.repository, objective),
        /hydration receipt differs/,
      );
    });
});

for (const delivery of ["regular", "native-stack"])
  test(`${delivery} selected-LFS acceptance keeps delivery and final hydration after Work Item review`, async () => {
    await fixture("same-path-lfs-release-gate", async (root) => {
      const source = readFileSync(
        join(
          import.meta.dirname,
          "fixtures",
          "disposable-target",
          "assets",
          "source.png",
        ),
      );
      const digest = createHash("sha256").update(source).digest("hex");
      assert.equal(
        digest,
        "886eca293713dd0dc77ee8c492c64e81359f6e0286b79d5f6df20c506466d1e2",
      );
      const target = createTarget(root, { "assets/source.png": source });
      const policyCommand =
        "grep -Fxq 'assets/source.png filter=lfs diff=lfs merge=lfs -text' .gitattributes";
      const hashCommand = `sha256sum assets/source.png | grep -qx '${digest}  assets/source.png'`;
      const lfsCommand = "git lfs ls-files | grep -q 'assets/source.png'";
      const policy = item("same-path-lfs-policy", {
        path: ".gitattributes",
        command: policyCommand,
      });
      const migration = item("same-path-lfs-migration", {
        path: "assets/source.png",
        command: hashCommand,
        dependencies: ["same-path-lfs-policy"],
        sourceAssets: [
          {
            kind: "repository",
            path: "assets/source.png",
            role: "image",
            mediaType: "image/png",
            visibility: "repository",
          },
        ],
        expectedOutputRoles: ["image"],
        minimumAssetSets: 1,
        requiredLfsRoles: ["image"],
      });
      migration.validation.push({
        command: lfsCommand,
        provenance: "source-declared",
        source: "OBJECTIVE",
      });
      migration.acceptance.push(
        "The candidate is copied byte-for-byte from the repository source assets/source.png and bound back to that destination.",
        "The selected set's source, rights basis, repository visibility, and lineage are declared in .factory-assets.json.",
        "The worker does not write, remove, or change the final destination; Factory materializes only the human-selected candidate to assets/source.png.",
      );
      const materializationCriterion = migration.acceptance.at(-1);
      const objectiveBody = `# Same-path LFS release gate

## Acceptance
Work Item acceptance uses the selected materialized bytes and exact validation before delivery. Required-object upload belongs to delivery before publication; fresh-clone hydration belongs after integration and final commands, before final Objective acceptance. Preserve each obligation at its actual phase.
- ${materializationCriterion}
- Fresh-clone hydration preserves the selected bytes at assets/source.png.
- \`${hashCommand}\`
- \`${lfsCommand}\`

## Final validation
- \`${policyCommand}\`
- \`${hashCommand}\`
- \`${lfsCommand}\`
`;
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          "example/same-path-lfs-release-gate",
          delivery,
        ),
        graph: {
          objective,
          baseSha: target.baseSha,
          items: [policy, migration],
        },
        objectiveBody,
        fakeRoot: join(root, "fake"),
        actions: {
          "same-path-lfs-policy": {
            files: [
              {
                path: ".gitattributes",
                text: "assets/source.png filter=lfs diff=lfs merge=lfs -text\n",
              },
            ],
          },
          "same-path-lfs-migration": {
            assets: [
              {
                id: "candidate-a",
                members: [
                  {
                    role: "image",
                    file: "source.png",
                    mediaType: "image/png",
                    destination: "assets/source.png",
                    base64: source.toString("base64"),
                  },
                ],
                provenance: {
                  source: "assets/source.png",
                  rights: "public repository fixture",
                  visibility: "repository",
                  lineage: ["assets/source.png"],
                },
              },
            ],
          },
        },
      };
      // The bare remote rejects the branch unless its selected LFS bytes have
      // already arrived, so the PR fake cannot conceal reversed upload ordering.
      const uploadBeforeBranch = join(root, "upload-before-branch");
      const receiveHook = join(target.origin, "hooks/pre-receive");
      writeFileSync(
        receiveHook,
        `#!/bin/sh
set -eu
while read old new ref; do
  pointer=$(git show "$new:assets/source.png")
  case "$pointer" in
    *"oid sha256:${digest}"*)
      test "$(sha256sum 'lfs/objects/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}' | cut -d ' ' -f 1)" = '${digest}'
      touch '${uploadBeforeBranch}'
      ;;
  esac
done
`,
      );
      chmodSync(receiveHook, 0o755);
      const { application, planningPath, contentStore, github } =
        makeApplication(descriptor);
      let mediaPublished = false;
      const publish = github.publish.bind(github);
      github.publish = async (request) => {
        if (
          git(
            target.checkout,
            "show",
            `origin/${request.branch}:assets/source.png`,
          ).includes(`oid sha256:${digest}`)
        ) {
          const review = readEvents(planningPath).find(
            (event) =>
              event.type === "result-review" &&
              event.observations?.reviewedItemId === migration.id,
          );
          assert.ok(review, "media acceptance precedes publication");
          assert.equal(
            review.evidence.some(
              (entry) => entry.path === "Controller hydration receipt",
            ),
            false,
          );
          assert.deepEqual(
            readFileSync(
              join(
                target.origin,
                "lfs/objects",
                digest.slice(0, 2),
                digest.slice(2, 4),
                digest,
              ),
            ),
            source,
            "exact selected object uploaded before PR publication",
          );
          mediaPublished = true;
        }
        return publish(request);
      };
      const waiting = await application.runObjective(objective);
      assert.equal(
        waiting.work["same-path-lfs-migration"].step,
        "approve-asset",
      );
      await selectAssetSetFromCli(
        descriptor.config,
        objective,
        "same-path-lfs-migration",
        "candidate-a",
        contentStore,
        {
          actor: "test-operator",
          reason: "verified complete exact-byte candidate",
          downstreamItems: [],
        },
      );
      const completed = await application.runObjective(objective);
      assert.equal(completed.objectiveClosure, "complete");
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.finalValidation.hydrationReceipt.passed, true);
      const reviews = readEvents(planningPath).filter(
        (event) => event.type === "result-review",
      );
      const workReview = reviews.find(
        (event) =>
          event.observations?.reviewedItemId === "same-path-lfs-migration",
      );
      const finalReview = reviews.find(
        (event) => event.observations?.integratedCommitSha,
      );
      assert.equal(mediaPublished, true);
      assert.equal(existsSync(uploadBeforeBranch), true);
      assert.deepEqual(workReview.criteria, migration.acceptance);
      assert.equal(
        workReview.criteria.some((criterion) =>
          /upload|publication|hydration/.test(criterion),
        ),
        false,
      );
      assert.equal(
        workReview.evidence.some(
          (entry) => entry.path === "Controller hydration receipt",
        ),
        false,
      );
      const hydration = finalReview.evidence.find(
        (entry) => entry.path === "Controller hydration receipt",
      );
      assert.ok(hydration);
      assert.deepEqual(
        JSON.parse(hydration.content),
        completed.finalValidation.hydrationReceipt,
      );
      assert.equal(
        completed.finalValidation.hydrationReceipt.integratedSha,
        completed.integratedSha,
      );
      const timeline = readDiagnostics(descriptor.config.repository, objective);
      const operations = [
        ["media-materialization", "completed"],
        ["validation-command", "completed"],
        ["acceptance-review", "completed"],
        ["github-publication", "completed"],
        ["github-merge", "completed"],
        ["objective-validation-command", "completed"],
        ["media-hydration-verification", "completed"],
        ["objective-acceptance-review", "started"],
      ];
      // Native-stack diagnostics use their own publication operation; the real
      // publication hook above checks upload/review ordering for both routes.
      if (delivery === "regular") {
        let previous = -1;
        for (const [operation, outcome] of operations) {
          const index = timeline.findIndex(
            (event, index) =>
              index > previous &&
              event.operation === operation &&
              event.outcome === outcome &&
              (operation.startsWith("objective-") ||
                operation === "media-hydration-verification" ||
                event.itemId === migration.id),
          );
          assert.ok(
            index > previous,
            `${operation} follows prior lifecycle boundary`,
          );
          previous = index;
        }
      }
      for (const review of [workReview, finalReview]) {
        const evidence = review.evidence.find((entry) =>
          entry.path.endsWith("controller materialization"),
        );
        assert.equal(evidence.complete, true);
        const chunks = review.evidence.filter((entry) =>
          entry.path.startsWith(`${evidence.path} controller result file `),
        );
        assert.ok(chunks.length > 0);
        assert.ok(
          chunks.every((entry) => entry.content.includes("\ndiff --git ")),
        );
        const packet = JSON.parse(evidence.content.split("\n")[0]);
        assert.deepEqual(packet.workerDestinationChanges, []);
        assert.deepEqual(
          packet.materializationChange.changes.map((entry) => entry.path),
          ["assets/source.png"],
        );
        assert.deepEqual(
          packet.destinations.map((entry) => entry.digest),
          [digest],
        );
      }
      assert.ok(
        completed.finalValidation.criteria.some(
          (entry) => entry.criterion === materializationCriterion,
        ),
      );
    });
  });

test("hydration failure is URL-free and blocks final review, evidence, and closure on replay", async () => {
  await fixture("hydration-failure", async (root) => {
    const selectedModel = Buffer.from([0, 7, 0, 8, 255]);
    const privateOrigin = join(
      root,
      "private-origin-arbitrary-secret-missing.git",
    );
    const target = createTarget(root, {
      "approved/model.bin": selectedModel,
      "sabotage.mjs": `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["remote", "set-url", "origin", ${JSON.stringify(privateOrigin)}]);\n`,
    });
    writeFileSync(
      join(target.checkout, ".gitattributes"),
      "approved/*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    git(target.checkout, "add", ".gitattributes");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Require LFS for approved binaries",
    );
    git(target.checkout, "push", "origin", "main");
    target.baseSha = git(target.checkout, "rev-parse", "HEAD");
    git(target.checkout, "lfs", "install", "--local");
    const command = "test -s approved/model.bin";
    const media = item("media", {
      path: "approved/model.bin",
      command,
      sourceAssets: [
        {
          kind: "repository",
          path: "approved/model.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["model"],
      minimumAssetSets: 1,
      requiredLfsRoles: ["model"],
    });
    const descriptor = {
      config: factoryConfig(target.checkout, "example/hydration-failure"),
      graph: { objective, baseSha: target.baseSha, items: [media] },
      objectiveBody: `# Deterministic Objective

## Acceptance
- Fresh-clone hydration preserves the selected bytes at approved/model.bin.
- \`${command}\`

## Final validation
- \`${command}\`
- \`node sabotage.mjs\`
`,
      fakeRoot: join(root, "fake"),
      actions: {
        media: {
          assets: [
            {
              id: "byte-identical",
              members: [
                {
                  role: "model",
                  file: "model.bin",
                  mediaType: "application/octet-stream",
                  destination: "approved/model.bin",
                  base64: selectedModel.toString("base64"),
                },
              ],
              provenance: {
                source: "approved/model.bin",
                rights: "public integration fixture",
                visibility: "repository",
                lineage: ["approved/model.bin"],
              },
            },
          ],
        },
      },
    };
    const { application, github } = makeApplication(descriptor);
    const waiting = await application.runObjective(objective);
    assert.equal(waiting.work.media.status, "waiting");
    await application.selectAssetSet(objective, "media", "byte-identical", {
      actor: "test-operator",
      reason: "failure-path fixture",
      downstreamItems: [],
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt)
        git(
          target.checkout,
          "remote",
          "set-url",
          "origin",
          `https://github.com/${descriptor.config.repository}.git`,
        );
      await assert.rejects(application.runObjective(objective), (error) => {
        assert.equal(
          error.message,
          attempt
            ? "Objective stopped: Fresh-clone hydration verification failed during clone. Use explicit retry or operator direction."
            : "Fresh-clone hydration verification failed during clone",
        );
        assert.doesNotMatch(error.message, /arbitrary-secret|private-origin/);
        return true;
      });
      const failed = readState(descriptor.config.repository, objective);
      assert.equal(failed.finalAcceptancePending, undefined);
      assert.equal(failed.finalAcceptanceDecisions, undefined);
      assert.equal(failed.finalValidation, undefined);
      assert.equal(failed.objectiveClosure, undefined);
      assert.equal(
        failed.error,
        attempt
          ? "Objective stopped: Fresh-clone hydration verification failed during clone. Use explicit retry or operator direction."
          : "Fresh-clone hydration verification failed during clone",
      );
      assert.equal(github.state().closedIssues[objective], undefined);
      assert.doesNotMatch(
        JSON.stringify(failed),
        /arbitrary-secret|private-origin/,
      );
      const timeline = readDiagnostics(descriptor.config.repository, objective);
      assert.ok(
        timeline.some(
          (event) =>
            event.operation === "media-hydration-verification" &&
            event.outcome === "failed",
        ),
      );
      assert.equal(
        timeline.some(
          (event) => event.operation === "objective-acceptance-review",
        ),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(timeline),
        /arbitrary-secret|private-origin/,
      );
    }
  });
});

function dirnameFor(path) {
  return path.slice(0, path.lastIndexOf("/"));
}

test("partial projection reuses issues and dependency relationships", async () => {
  await fixture("projection-replay", async (root) => {
    const target = createTarget(root);
    const command = "test -s first.txt && test -s second.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/projection-replay",
        "regular",
        1,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("first", { path: "first.txt" }),
          item("second", { path: "second.txt", dependencies: ["first"] }),
        ],
      },
      objectiveBody: body([command, "test -s first.txt", "test -s second.txt"]),
      fakeRoot: join(root, "fake"),
      actions: {
        first: { files: [{ path: "first.txt", text: "first\n" }] },
        second: { files: [{ path: "second.txt", text: "second\n" }] },
      },
    };
    const { application, github } = makeApplication(descriptor);
    github.failProjectionAfter = 1;
    await assert.rejects(
      application.runObjective(objective),
      /partial projection/,
    );
    assert.ok(
      readDiagnostics(descriptor.config.repository, objective).some(
        (event) =>
          event.operation === "github-projection" &&
          event.outcome === "failed" &&
          event.durationMs >= 0 &&
          /partial projection/.test(event.detail),
      ),
    );
    const firstIssue = github.state().issues.first;
    assert.equal(github.state().issues.second, undefined);
    const completed = await application.runObjective(objective);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(github.state().issues.first, firstIssue);
    assert.equal(Object.keys(github.state().issues).length, 2);
    assert.deepEqual(github.state().dependencies.second, ["first"]);
    assert.equal(github.state().closedIssues[firstIssue], true);
  });
});

test("close failures replay after merge and final validation without worker or PR replay", async () => {
  await fixture("closure-replay", async (root) => {
    const target = createTarget(root);
    const command = "test -s result.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/closure-replay",
        "regular",
        1,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("result", { path: "result.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "complete\n" }] },
      },
    };
    const { application, github, eventsPath } = makeApplication(descriptor);
    github.failCloseAfterComment = 100;
    await assert.rejects(application.runObjective(objective), /close failure/);
    const afterMerge = readState(descriptor.config.repository, objective);
    assert.equal(afterMerge.work.result.status, "done");
    assert.equal(afterMerge.work.result.githubClosure, "pending");
    assert.equal(afterMerge.error, undefined);
    assert.match(afterMerge.githubClosureError, /close failure/);
    const mergedPr = afterMerge.work.result.pullRequest;
    const expectedHead = github.state().pullRequests[mergedPr].headSha;
    github.update((state) => {
      state.pullRequests[mergedPr].headSha = target.baseSha;
    });
    await assert.rejects(
      application.runObjective(objective),
      /identity changed/,
    );
    github.update((state) => {
      state.pullRequests[mergedPr].headSha = expectedHead;
    });
    const counts = () => ({
      starts: readEvents(eventsPath).filter((event) => event.type === "start")
        .length,
      publishes: github
        .state()
        .events.filter((event) => event.type === "publish").length,
      merges: github.state().events.filter((event) => event.type === "merge")
        .length,
    });
    const beforeReplay = counts();
    github.failCloseAfterComment = objective;
    await assert.rejects(application.runObjective(objective), /close failure/);
    const afterValidation = readState(descriptor.config.repository, objective);
    assert.equal(afterValidation.finalValidation.passed, true);
    assert.equal(afterValidation.work.result.githubClosure, "complete");
    assert.equal(afterValidation.objectiveClosure, "pending");
    assert.equal(
      readDiagnostics(descriptor.config.repository, objective).filter(
        (event) => event.operation === "objective-finalization",
      ).length,
      0,
    );
    const completed = await application.runObjective(objective);
    assert.equal(completed.objectiveClosure, "complete");
    assert.equal(
      readDiagnostics(descriptor.config.repository, objective).filter(
        (event) =>
          event.operation === "objective-finalization" &&
          event.outcome === "completed",
      ).length,
      1,
    );
    assert.deepEqual(counts(), beforeReplay);
    assert.equal(github.state().issueComments[100].length, 1);
    assert.equal(github.state().issueComments[objective].length, 1);
  });
});

for (const strategy of ["regular", "native-stack"]) {
  test(`${strategy} collection diagnostics distinguish positive, empty and unavailable original observations`, async () => {
    await fixture(`collection-${strategy}`, async (root) => {
      const target = createTarget(root, { ".gitignore": "node_modules/\n" });
      const items = [
        item("positive", { path: "positive.txt" }),
        item("unavailable", { path: "unavailable.txt" }),
        item("empty", { path: "empty.txt", dependencies: ["positive"] }),
      ];
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          `example/collection-${strategy}`,
          strategy,
          2,
        ),
        graph: { objective, baseSha: target.baseSha, items },
        objectiveBody: body(
          items.flatMap((entry) => entry.validation.map((v) => v.command)),
        ),
        fakeRoot: join(root, "fake"),
        actions: {
          positive: {
            files: [
              { path: "positive.txt", text: "positive\n" },
              { path: "node_modules/value", text: "ignored\n" },
            ],
            commands: [
              ["ln", "-s", "value", 'node_modules/private-"name'],
              [
                "ln",
                "-s",
                "value",
                "node_modules/ghp_abcdefghijklmnopqrstuvwxyz0123456789",
              ],
            ],
          },
          unavailable: {
            files: [{ path: "unavailable.txt", text: "unavailable\n" }],
          },
          empty: { files: [{ path: "empty.txt", text: "empty\n" }] },
        },
      };
      const { application, driver } = makeApplication(descriptor);
      const collect = driver.collect.bind(driver);
      const originals = new Map();
      driver.collect = async (handle) => {
        const result = await collect(handle);
        originals.set(handle.identity, {
          treeSha: result.treeSha,
          changeRef: result.changeRef,
        });
        // A custom driver is allowed not to supply collection observations.
        if (handle.data.request.item.id === "unavailable")
          delete result.collection;
        return result;
      };
      const state = await application.runObjective(objective);
      assert.equal(state.finalValidation.passed, true);
      const events = readDiagnostics(
        descriptor.config.repository,
        objective,
      ).filter((event) => event.operation === "collection-ignored-links");
      assert.deepEqual(events.map((event) => event.itemId).sort(), [
        "empty",
        "positive",
      ]);
      for (const event of events) {
        assert.equal(event.runId, state.runId);
        assert.equal(event.attemptId, state.work[event.itemId].attempt);
        assert.equal(
          event.metadata.treeSha,
          originals.get(event.attemptId).treeSha,
        );
        assert.equal(
          event.metadata.headSha,
          originals.get(event.attemptId).changeRef,
        );
        assert.equal(event.metadata.observation, "original-worktree-scan");
        assert.equal(event.outcome, "completed");
        const paths =
          event.itemId === "positive"
            ? ["node_modules/[REDACTED]", 'node_modules/private-"name']
            : [];
        assert.deepEqual(JSON.parse(event.detail), {
          acceptedIgnoredLinks: paths,
        });
        assert.equal(event.metadata.acceptedIgnoredLinkCount, paths.length);
        assert.ok(!JSON.stringify(event.metadata).includes("node_modules"));
      }
    });
  });

  test(`${strategy} failed collection emits no completed link observation`, async () => {
    await fixture(`failed-collection-${strategy}`, async (root) => {
      const target = createTarget(root, { ".gitignore": "node_modules/\n" });
      const work = item("failed", { path: "safe.txt" });
      const descriptor = {
        config: factoryConfig(
          target.checkout,
          `example/failed-collection-${strategy}`,
          strategy,
        ),
        graph: { objective, baseSha: target.baseSha, items: [work] },
        objectiveBody: body([work.validation[0].command]),
        fakeRoot: join(root, "fake"),
        actions: {
          failed: {
            files: [
              { path: "safe.txt", text: "safe\n" },
              { path: "node_modules/value", text: "ignored\n" },
              { path: "unowned.txt", text: "refuse\n" },
            ],
            commands: [["ln", "-s", "value", "node_modules/link"]],
          },
        },
      };
      const { application } = makeApplication(descriptor);
      await assert.rejects(
        application.runObjective(objective),
        /outside ownership/,
      );
      const state = readState(descriptor.config.repository, objective);
      assert.equal(state.work.failed.status, "failed");
      assert.match(state.work.failed.error, /outside ownership/);
      assert.equal(
        readDiagnostics(descriptor.config.repository, objective).filter(
          (event) => event.operation === "collection-ignored-links",
        ).length,
        0,
      );
    });
  });
}
