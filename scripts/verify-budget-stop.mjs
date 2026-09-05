/** Prospective pre-projection refusal qualifier; never rewrites earlier exercises. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQualificationNamespace,
  boundedPolicy,
  main as installedMain,
  qualificationNamespace,
} from "./verify-live-objective.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import {
  changeSchedulingService,
  observeSchedulingService,
  schedulingRequest,
  schedulingTransport,
  schedulingUnit,
} from "./verify-local-scheduling.mjs";

const scope = "installed-local-pre-projection-budget-refusal";
export const budgetRefusalReason =
  "no execution backend satisfies policy and requirements: codex-sdk/local-worktree (model-token budget exhausted), codex-cli/local-worktree (model-token budget exhausted)";

export function budgetStopPolicy() {
  const policy = boundedPolicy("regular-prs", 500000);
  return { ...policy, economics: { ...policy.economics, maxModelTokens: 1 } };
}

export function budgetStopAuthority(env) {
  if (env.FACTORY_LIVE_BUDGET_STOP !== "1") return null;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"])
    assert.equal(env[key], undefined, "default local GitHub authentication required");
  assert.ok(env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1" || env.FACTORY_LIVE_OBJECTIVE === "1");
  assert.equal(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS, "1");
  const repository = env.FACTORY_LIVE_OBJECTIVE_REPOSITORY;
  assert.match(repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(repository, "clockgrove/factory");
  if (env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT !== "1")
    assert.equal(
      env.FACTORY_LIVE_BUDGET_STOP_ACK,
      `${repository}:pre-projection-refusal-no-cancel`,
    );
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "regular-prs",
  );
  assert.ok(
    !env.FACTORY_LIVE_REGULAR_BACKEND || env.FACTORY_LIVE_REGULAR_BACKEND === "local-default",
  );
  return {
    repository,
    namespace: qualificationNamespace(env.FACTORY_LIVE_OBJECTIVE_NAMESPACE),
    policy: budgetStopPolicy(),
  };
}

function noWork(events, status) {
  assert.ok(
    !events.some(
      (event) =>
        ["attempt", "capacity", "validation", "publication", "graph", "scheduling"].includes(
          event.kind,
        ) || event.event === "BudgetReserved",
    ),
    "projection or worker/resource admission is not pre-projection refusal",
  );
  assert.deepEqual(status.workItems, []);
  assert.equal(status.summary?.attempts.active, 0);
  assert.deepEqual(status.capacity?.activeReservations, []);
  assert.equal(status.capacity.observed.active, 0);
}

/** Pure read-only observation, not a qualification result or authority. The caller
 * supplies pinned-actor authenticated receipts and independently observed status.
 * This can describe an earlier failed exercise without changing that exercise. */
export function assessBudgetStopObservation({ receipts, status, context }) {
  assert.ok(Array.isArray(receipts) && receipts.length > 0 && receipts.length <= 400);
  for (const receipt of receipts) {
    assert.equal(receipt.actorId, context.actor.id);
    assert.ok(Number.isSafeInteger(receipt.commentId) && receipt.commentId > 0);
    assert.equal(receipt.event.protocol, "clockgrove.factory/v2");
    assert.equal(receipt.event.objective, context.objective);
  }
  const events = deduplicateQualificationReceipts(receipts).map(({ event }) => event);
  const expectedKinds = {
    FactoryRunStarted: "run",
    ControllerObserved: "controller",
    DeliverySelected: "delivery",
    BudgetReconciled: "budget",
    FactoryRunEscalated: "run",
  };
  assert.ok(
    events.every(
      (event) =>
        Object.hasOwn(expectedKinds, event.event) && expectedKinds[event.event] === event.kind,
    ),
    "unexpected event outside pre-projection refusal",
  );
  const starts = events.filter((event) => event.event === "FactoryRunStarted");
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert.equal(start.repository, context.repository);
  assert.equal(start.actor.toLowerCase(), context.actor.login.toLowerCase());
  assert.deepEqual(start.policy, budgetStopPolicy());
  assert.match(start.policyDigest, /^[a-f0-9]{64}$/);
  assert.equal(start.activationRequestId, undefined);
  assert.equal(start.recoveryRequestId, undefined);
  assert.ok(events.every((event) => event.runId === start.runId));
  assert.ok(
    !events.some((event) =>
      [
        "FactoryRunCancellationRequested",
        "RunPauseRequested",
        "RunResumeRequested",
        "ActivationCancellationRequested",
      ].includes(event.event),
    ),
    "no operator cancellation or restart belongs to this observation",
  );
  const terminals = events.filter((event) =>
    ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
  );
  assert.equal(terminals.length, 1);
  const terminal = terminals[0];
  assert.equal(terminal.event, "FactoryRunEscalated");
  assert.equal(terminal.reason, budgetRefusalReason);
  const usage = events.filter((event) => event.kind === "budget");
  assert.equal(usage.length, 1);
  const compiler = usage[0];
  assert.equal(compiler.event, "BudgetReconciled");
  assert.equal(compiler.phase, "management");
  assert.equal(compiler.unit, "model_tokens");
  assert.equal(compiler.workItem, undefined);
  assert.equal(compiler.attempt, undefined);
  assert.match(compiler.usageId, /^compile-[a-f0-9]{64}$/);
  assert.ok(start.sequence < compiler.sequence && compiler.sequence < terminal.sequence);
  const deliveries = events.filter((event) => event.event === "DeliverySelected");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].requested, "regular-prs");
  assert.equal(deliveries[0].selected, "regular-prs");
  assert.ok(start.sequence < deliveries[0].sequence && deliveries[0].sequence < compiler.sequence);
  assert.ok(Number.isSafeInteger(compiler.amount) && compiler.amount > 1);
  for (const key of ["inputTokens", "outputTokens"])
    assert.ok(
      Number.isSafeInteger(compiler.reportedModelUsage?.[key]) &&
        compiler.reportedModelUsage[key] >= 0,
      "known compiler counters required",
    );
  assert.equal(
    compiler.reportedModelUsage.inputTokens + compiler.reportedModelUsage.outputTokens,
    compiler.amount,
  );
  if (compiler.reportedModelUsage.cachedInputTokens !== undefined)
    assert.ok(
      Number.isSafeInteger(compiler.reportedModelUsage.cachedInputTokens) &&
        compiler.reportedModelUsage.cachedInputTokens >= 0 &&
        compiler.reportedModelUsage.cachedInputTokens <= compiler.reportedModelUsage.inputTokens,
    );
  assert.equal(status.operation, "status");
  assert.equal(status.repository, context.repository);
  assert.equal(status.objective.number, context.objective);
  assert.equal(status.run.availability, "observed");
  assert.equal(status.run.runId, start.runId);
  assert.equal(status.run.policyDigest, start.policyDigest);
  assert.equal(status.run.state, "escalated");
  assert.equal(status.summary.runId, start.runId);
  noWork(events, status);
  const economics = status.summary.economics;
  assert.equal(economics.usage.model_tokens?.availability, "observed");
  assert.equal(economics.usage.model_tokens.value, compiler.amount);
  assert.equal(economics.budgets.modelTokens?.value?.configured, 1);
  assert.equal(economics.budgets.modelTokens.value.committed, compiler.amount);
  return {
    observationScope: "observed-pre-projection-budget-refusal",
    runId: start.runId,
    start,
    compiler,
    terminal,
    compilerTokens: compiler.amount,
    durableGraph: "uninspected",
    originalExerciseResultChanged: false,
  };
}

function finalReceipts(evidence) {
  assert.ok(Array.isArray(evidence.events) && evidence.events.length <= 400);
  return evidence.events.map((event) => {
    assert.equal(event.authorId, evidence.actor.id);
    assert.equal(event.author?.toLowerCase(), evidence.actor.login.toLowerCase());
    const prefix = `https://github.com/${evidence.repository}/issues/${evidence.objective.number}#issuecomment-`;
    assert.ok(event.receiptUrl?.startsWith(prefix));
    const commentId = Number(event.receiptUrl.slice(prefix.length));
    assert.ok(Number.isSafeInteger(commentId) && commentId > 0);
    const envelope = { ...event };
    delete envelope.author;
    delete envelope.authorId;
    delete envelope.receiptUrl;
    return { event: envelope, actorId: event.authorId, commentId };
  });
}

function assertTerminal(evidence) {
  assert.equal(evidence.scope, scope);
  assertQualificationNamespace(evidence);
  assert.deepEqual(evidence.policy, budgetStopPolicy());
  assert.equal(
    evidence.preflight.harness.candidateInventorySha256,
    evidence.installedArtifact.inventorySha256,
  );
  assert.deepEqual(evidence.finishedInstalledArtifact, evidence.installedArtifact);
  const proof = evidence.budgetStop;
  assert.equal(proof.kind, "pre-projection-budget-refusal-no-cancel");
  assert.equal(evidence.runRequest.tool, "factory_run");
  assert.equal(evidence.runRequest.arguments.repository, proof.primary.checkout);
  assert.equal(
    `${evidence.runRequest.arguments.owner}/${evidence.runRequest.arguments.repo}`,
    evidence.repository,
  );
  assert.equal(evidence.runRequest.arguments.objectiveNumber, evidence.objective.number);
  assert.equal(evidence.runRequest.arguments.untilTerminal, true);
  assert.deepEqual(evidence.runRequest.arguments.policy, evidence.policy);
  const observation = assessBudgetStopObservation({
    receipts: finalReceipts(evidence),
    status: evidence.status,
    context: {
      repository: evidence.repository,
      objective: evidence.objective.number,
      actor: evidence.actor,
    },
  });
  assert.equal(evidence.runResult.runId, observation.runId);
  assert.equal(evidence.runResult.status, "escalated");
  assert.deepEqual(evidence.children, []);
  assert.deepEqual(evidence.pulls, []);
  assert.equal(proof.cancelRequested, undefined);
  assert.equal(proof.cancelReceipt, undefined);
  return observation;
}

export function assertBudgetStopCompletion(evidence) {
  const observation = assertTerminal(evidence);
  assert.deepEqual(evidence.budgetStop.terminalObservation, observation);
  const { primary, cleanup } = evidence.budgetStop;
  assert.equal(cleanup.state, "absent");
  assert.equal(cleanup.unit, primary.unit);
  assert.equal(cleanup.bootDigest, primary.bootDigest);
}

export function createBudgetStopQualification(authority, env = process.env, port) {
  let primary;
  const nonce = randomUUID();
  const safe =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch {
        throw Error(
          "pre-projection budget refusal incomplete; preserve evidence without reinjection",
        );
      }
    };
  return {
    scope,
    policy: authority.policy,
    namespace: authority.namespace,
    privateEvidence: true,
    wrapTransport: safe(async (parameters, context) => {
      assert.deepEqual(parameters.args, [join(context.pluginRoot, "dist/mcp-server.js")]);
      const user = userInfo();
      primary = {
        unit: schedulingUnit({
          repository: authority.repository,
          namespace: authority.namespace,
          inventory: context.evidence.installedArtifact.inventorySha256,
          nonce,
          role: "primary",
        }),
        node: realpathSync(process.execPath),
        bundle: realpathSync(parameters.args[0]),
        checkout: realpathSync(parameters.cwd),
      };
      assert.equal(observeSchedulingService(primary, port).state, "absent");
      context.evidence.budgetStop = { kind: "pre-projection-budget-refusal-no-cancel", primary };
      context.save();
      const transport = schedulingTransport({
        ...primary,
        path: env.PATH,
        home: homedir(),
        uid: user.uid,
        username: user.username,
      });
      assert.equal(transport.args.filter((arg) => arg === "--property=CPUQuota=50%").length, 1);
      return {
        ...transport,
        args: transport.args.map((arg) =>
          arg === "--property=CPUQuota=50%" ? "--property=CPUQuota=400%" : arg,
        ),
      };
    }),
    beforeRun: safe(async (hooks) => {
      primary = observeSchedulingService(primary, port);
      assert.equal(primary.state, "active");
      assert.equal(primary.effectiveCpu, 4);
      hooks.evidence.budgetStop.primary = primary;
      hooks.save();
    }),
    // No duringRun control hook: await the original terminal without cancelling,
    // assuming queue projection, retrying admission or invoking another model.
    afterRun: safe(async (hooks) => {
      hooks.evidence.budgetStop.terminalObservation = assertTerminal(hooks.evidence);
      hooks.save();
      const observed = observeSchedulingService(primary, port);
      hooks.evidence.budgetStop.cleanup =
        observed.state === "absent"
          ? observed
          : await changeSchedulingService(primary, "stop", port);
      hooks.save();
    }),
    assessCompletion: (evidence) => {
      try {
        assertBudgetStopCompletion(evidence);
        return { result: "passed", scope };
      } catch {
        return {
          result: "incomplete",
          scope,
          reason:
            "Exact no-worker pre-projection refusal, accounting and owned absence not all established",
        };
      }
    },
    verifyFinalArtifact: safe(async (hooks) => {
      assertBudgetStopCompletion(hooks.evidence);
      const start = hooks.evidence.budgetStop.terminalObservation.start;
      assert.ok(
        typeof start.baseBranch === "string" &&
          start.baseBranch.length > 0 &&
          start.baseBranch.length <= 500,
      );
      const head = (
        await schedulingRequest(hooks, "GET /repos/{owner}/{repo}/commits/{ref}", {
          ref: start.baseBranch,
        })
      ).data.sha;
      assert.equal(head, hooks.evidence.base);
      hooks.evidence.noArtifactObservation = {
        defaultSha: head,
        unchanged: true,
        workerAttempts: 0,
        pullRequests: 0,
        durableGraph: "uninspected",
        mergedTests: "not applicable: no worker or implementation artifact",
      };
    }),
    onFailure: async (hooks) => {
      hooks.evidence.failure = "pre-projection budget refusal incomplete; no automatic reinjection";
      hooks.evidence.budgetStop ??= {};
      hooks.evidence.budgetStop.failure = {
        code: "pre-projection-refusal-incomplete",
        automaticRetry: false,
        automaticCancellationFallback: false,
      };
    },
  };
}

export async function main(env = process.env, run = installedMain) {
  const authority = budgetStopAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit pre-projection budget refusal opt-in required.");
    return;
  }
  await run(createBudgetStopQualification(authority, env));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "Pre-projection budget refusal incomplete; preserve private evidence. No reinjection.",
    );
    process.exitCode = 2;
  }
}
