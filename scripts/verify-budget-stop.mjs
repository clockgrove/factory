/** Explicit negative installed qualification. No import-time I/O or live pass. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assertQualificationNamespace,
  boundedPolicy,
  main as installedMain,
  qualificationNamespace,
} from "./verify-live-objective.mjs";
import { authenticatedFaultEvents } from "./verify-local-faults.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import {
  changeSchedulingService,
  observeSchedulingService,
  schedulingRequest,
  schedulingTransport,
  schedulingUnit,
} from "./verify-local-scheduling.mjs";

const scope = "installed-local-observed-budget-stop-no-worker";
const terminals = ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"];

export function budgetStopPolicy() {
  const policy = boundedPolicy("regular-prs", 500000);
  // A separate, strictly smaller initial authority, not an exception to the
  // happy-path 250k–500k policy parser and never a mid-run policy mutation.
  return { ...policy, economics: { ...policy.economics, maxModelTokens: 1 } };
}

export function budgetStopAuthority(env) {
  if (env.FACTORY_LIVE_BUDGET_STOP !== "1") return null;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"])
    assert.ok(
      env[key] === undefined,
      "budget-stop qualifier requires default local GitHub authentication",
    );
  assert.ok(
    env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1" || env.FACTORY_LIVE_OBJECTIVE === "1",
    "explicit shared phase required",
  );
  assert.equal(
    env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS,
    "1",
    "negative case requires exactly one initial observed token",
  );
  const repository = env.FACTORY_LIVE_OBJECTIVE_REPOSITORY;
  assert.match(repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(repository, "clockgrove/factory");
  if (env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT !== "1")
    assert.equal(
      env.FACTORY_LIVE_BUDGET_STOP_ACK,
      `${repository}:compile-once-budget-stop-no-worker`,
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

function finalEvents(evidence) {
  assert.ok(Array.isArray(evidence.events) && evidence.events.length <= 400);
  for (const event of evidence.events) {
    assert.equal(event.objective, evidence.objective.number);
    assert.equal(event.authorId, evidence.actor.id);
    assert.equal(event.author?.toLowerCase(), evidence.actor.login.toLowerCase());
    assert.ok(event.receiptUrl?.startsWith(`https://github.com/${evidence.repository}/issues/`));
  }
  return deduplicateQualificationReceipts(
    evidence.events.map((event) => {
      const envelope = { ...event };
      delete envelope.author;
      delete envelope.authorId;
      delete envelope.receiptUrl;
      return { event: envelope };
    }),
  ).map(({ event }) => event);
}

function noWork(events, status) {
  assert.ok(
    !events.some(
      (event) =>
        event.kind === "attempt" ||
        event.kind === "capacity" ||
        event.kind === "validation" ||
        event.kind === "publication" ||
        event.event === "BudgetReserved",
    ),
    "worker or native resource was admitted; do not cancel through this qualifier",
  );
  assert.equal(status.summary?.attempts.active, 0);
  assert.deepEqual(status.capacity?.activeReservations, []);
  assert.equal(status.capacity.observed.active, 0);
}

/** Input receipts must already be authenticated by the bounded GitHub reader.
 * null means compilation/projection is still in progress, never eligibility. */
export function assessBudgetStopObservation({ receipts, status, unit, context }) {
  assert.equal(unit.state, "active");
  assert.equal(unit.effectiveCpu, 4);
  for (const receipt of receipts) {
    assert.equal(receipt.actorId, context.actor.id);
    assert.ok(Number.isSafeInteger(receipt.commentId) && receipt.commentId > 0);
    assert.equal(receipt.event.objective, context.objective);
  }
  const events = receipts.map((receipt) => receipt.event);
  assert.ok(events.length <= 400);
  assert.ok(
    !events.some(
      (event) =>
        terminals.includes(event.event) || event.event === "FactoryRunCancellationRequested",
    ),
    "original outcome changed before observed budget stop",
  );
  assert.ok(
    !events.some(
      (event) =>
        event.kind === "attempt" ||
        event.kind === "capacity" ||
        event.kind === "validation" ||
        event.kind === "publication" ||
        event.event === "BudgetReserved",
    ),
    "worker or resource admission is not a no-worker budget stop",
  );
  const starts = events.filter((event) => event.event === "FactoryRunStarted");
  if (starts.length === 0) return null;
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert.equal(start.objective, context.objective);
  assert.equal(start.repository, context.repository);
  assert.equal(start.actor.toLowerCase(), context.actor.login.toLowerCase());
  assert.deepEqual(start.policy, budgetStopPolicy());
  assert.equal(start.activationRequestId, undefined);
  assert.equal(start.recoveryRequestId, undefined);
  assert.ok(
    events.every((event) => event.runId === start.runId),
    "mixed run evidence",
  );
  assert.equal(status.operation, "status");
  assert.equal(status.repository, context.repository);
  assert.equal(status.objective.number, context.objective);
  assert.equal(status.run.availability, "observed");
  assert.equal(status.run.runId, start.runId);
  assert.equal(status.run.state, "active");
  assert.equal(status.run.policyDigest, start.policyDigest);
  assert.equal(status.summary.runId, start.runId);
  noWork(events, status);
  const projected = events.filter((event) => event.event === "GraphProjected");
  if (projected.length === 0) return null;
  assert.equal(projected.length, 1);
  const compiled = events.filter((event) => event.event === "GraphCompiled");
  assert.equal(compiled.length, 1);
  const graph = compiled[0];
  assert.equal(graph.baseSha, context.base);
  assert.equal(graph.graphSize, 3);
  assert.match(graph.graphDigest, /^[a-f0-9]{64}$/);
  assert.equal(projected[0].graphDigest, graph.graphDigest);
  assert.equal(projected[0].graphSize, 3);
  assert.ok(projected[0].sequence > graph.sequence);
  const usage = events.filter((event) => event.kind === "budget");
  assert.equal(usage.length, 1, "exactly one known compiler call required");
  const compiler = usage[0];
  assert.equal(compiler.event, "BudgetReconciled");
  assert.equal(compiler.phase, "management");
  assert.equal(compiler.unit, "model_tokens");
  assert.equal(compiler.workItem, undefined);
  assert.equal(compiler.attempt, undefined);
  assert.equal(compiler.usageId, `compile-${graph.graphDigest}`);
  assert.ok(compiler.sequence > start.sequence && compiler.sequence < projected[0].sequence);
  assert.ok(
    Number.isSafeInteger(compiler.amount) && compiler.amount > 1,
    "compiler overshoot must be observed, not assumed",
  );
  for (const key of ["inputTokens", "outputTokens"])
    assert.ok(
      Number.isSafeInteger(compiler.reportedModelUsage?.[key]) &&
        compiler.reportedModelUsage[key] >= 0,
      "compiler usage breakdown unavailable",
    );
  assert.equal(
    compiler.reportedModelUsage.inputTokens + compiler.reportedModelUsage.outputTokens,
    compiler.amount,
  );
  const economics = status.summary.economics;
  assert.equal(economics.usage.model_tokens?.availability, "observed");
  assert.equal(economics.usage.model_tokens.value, compiler.amount);
  assert.equal(economics.budgets.modelTokens?.value?.configured, 1);
  assert.equal(economics.budgets.modelTokens.value.committed, compiler.amount);
  assert.equal(status.workItems.length, 3);
  const roots = status.workItems.filter((item) => item.openDependencies.length === 0);
  assert.equal(roots.length, 2);
  if (
    !roots.every((item) =>
      events.some(
        (event) =>
          event.event === "WorkItemQueued" &&
          event.workItem === item.number &&
          event.policyDigest === start.policyDigest &&
          event.reasonCode === "budget-exhausted" &&
          event.sequence > compiler.sequence,
      ),
    )
  )
    return null;
  return {
    runId: start.runId,
    policyDigest: start.policyDigest,
    graphDigest: graph.graphDigest,
    compilerUsageId: compiler.usageId,
    compilerTokens: compiler.amount,
    roots: roots.map((item) => item.number),
  };
}

/** One cancellation is allowed only after repeated exact no-worker observations.
 * Errors preserve the original outcome: there is no cancellation/retry fallback. */
export async function observeBudgetStopThenCancel({
  read,
  cancel,
  context,
  cancelRequestId,
  assertRunning,
  saveObservation,
  saveCancelRequested,
  wait = (milliseconds) => sleep(milliseconds),
  now = () => new Date().toISOString(),
}) {
  let first;
  let firstAt;
  for (let index = 0; index < 48; index++) {
    assertRunning();
    const observation = await read();
    const proof = assessBudgetStopObservation({ ...observation, context });
    if (proof) {
      if (!first) {
        first = { ...observation, proof, observedAt: now() };
        firstAt = Date.parse(first.observedAt);
        saveObservation(first);
      } else {
        assert.deepEqual(
          proof,
          first.proof,
          "budget authority or usage changed between observations",
        );
        for (const key of ["unit", "invocationId", "pid", "startTicks", "bootDigest"])
          assert.equal(observation.unit[key], first.unit[key]);
        const at = now();
        assert.ok(
          Date.parse(at) - firstAt >= 10000,
          "budget gate was not observed across a real polling interval",
        );
        saveObservation({ ...observation, proof, observedAt: at });
        // Independent final read immediately before the one durable request.
        assertRunning();
        const latest = await read();
        assert.deepEqual(assessBudgetStopObservation({ ...latest, context }), first.proof);
        for (const key of ["unit", "invocationId", "pid", "startTicks", "bootDigest"])
          assert.equal(latest.unit[key], first.unit[key]);
        assertRunning();
        saveCancelRequested({ ...latest, observedAt: now() });
        const result = await cancel(cancelRequestId);
        assert.equal(result.event, "FactoryRunCancellationRequested");
        assert.equal(result.runId, proof.runId);
        assert.equal(result.objective, context.objective);
        assert.equal(result.requestId, cancelRequestId);
        assert.equal(result.requestedBy.toLowerCase(), context.actor.login.toLowerCase());
        return result;
      }
    }
    await wait(10000);
  }
  throw Error("bounded observed budget-stop gate unavailable");
}

function assertTerminal(evidence) {
  assert.equal(evidence.scope, scope);
  assert.deepEqual(evidence.policy, budgetStopPolicy());
  assertQualificationNamespace(evidence);
  assert.equal(
    evidence.preflight.harness.candidateInventorySha256,
    evidence.installedArtifact.inventorySha256,
  );
  assert.deepEqual(evidence.finishedInstalledArtifact, evidence.installedArtifact);
  const context = {
    repository: evidence.repository,
    objective: evidence.objective.number,
    actor: evidence.actor,
    base: evidence.base,
  };
  const proof = evidence.budgetStop;
  assert.equal(proof.observations.length, 2);
  for (const observation of [...proof.observations, proof.beforeCancel])
    for (const key of ["unit", "invocationId", "pid", "startTicks", "bootDigest"])
      assert.equal(observation.unit[key], proof.primary[key]);
  const first = assessBudgetStopObservation({ ...proof.observations[0], context });
  assert.ok(first);
  assert.deepEqual(assessBudgetStopObservation({ ...proof.observations[1], context }), first);
  assert.ok(
    Date.parse(proof.observations[1].observedAt) - Date.parse(proof.observations[0].observedAt) >=
      10000,
  );
  assert.deepEqual(assessBudgetStopObservation({ ...proof.beforeCancel, context }), first);
  const events = finalEvents(evidence);
  noWork(events, evidence.status);
  assert.equal(evidence.runRequest.tool, "factory_run");
  assert.deepEqual(evidence.runRequest.arguments.policy, evidence.policy);
  assert.equal(evidence.runRequest.arguments.objectiveNumber, evidence.objective.number);
  assert.equal(
    `${evidence.runRequest.arguments.owner}/${evidence.runRequest.arguments.repo}`,
    evidence.repository,
  );
  assert.equal(evidence.runRequest.arguments.untilTerminal, true);
  assert.equal(evidence.runRequest.arguments.repository, proof.primary.checkout);
  assert.equal(evidence.runResult.runId, first.runId);
  assert.equal(evidence.runResult.status, "cancelled");
  assert.equal(evidence.status.run.runId, first.runId);
  assert.equal(evidence.status.run.state, "cancelled");
  assert.equal(events.filter((event) => event.event === "FactoryRunStarted").length, 1);
  const originalEvents = proof.observations[0].receipts.map(({ event }) => event);
  assert.deepEqual(
    events.find((event) => event.event === "FactoryRunStarted"),
    originalEvents.find((event) => event.event === "FactoryRunStarted"),
  );
  assert.ok(events.every((event) => event.runId === first.runId));
  const terminalsSeen = events.filter((event) => terminals.includes(event.event));
  assert.equal(terminalsSeen.length, 1);
  assert.equal(terminalsSeen[0].event, "FactoryRunCancelled");
  const requests = events.filter((event) => event.event === "FactoryRunCancellationRequested");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestId, proof.cancelRequestId);
  assert.equal(requests[0].requestedBy.toLowerCase(), evidence.actor.login.toLowerCase());
  assert.equal(proof.cancelReceipt.requestId, requests[0].requestId);
  assert.equal(proof.cancelReceipt.runId, requests[0].runId);
  assert.ok(requests[0].sequence < terminalsSeen[0].sequence);
  const usage = events.filter((event) => event.kind === "budget");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].usageId, first.compilerUsageId);
  assert.equal(usage[0].amount, first.compilerTokens);
  assert.deepEqual(
    usage[0],
    originalEvents.find((event) => event.kind === "budget"),
  );
  assert.equal(evidence.status.summary.economics.usage.model_tokens.value, first.compilerTokens);
  assert.equal(evidence.status.summary.economics.budgets.modelTokens.value.configured, 1);
  assert.equal(
    evidence.status.summary.economics.budgets.modelTokens.value.committed,
    first.compilerTokens,
  );
  assert.deepEqual(evidence.pulls, []);
}

export function assertBudgetStopCompletion(evidence) {
  assertTerminal(evidence);
  const { primary, cleanup } = evidence.budgetStop;
  assert.equal(cleanup.state, "absent");
  assert.equal(cleanup.unit, primary.unit);
  assert.equal(cleanup.bootDigest, primary.bootDigest);
}

async function snapshot(hooks, primary, port) {
  const children = (
    await schedulingRequest(
      hooks,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      { issue_number: hooks.evidence.objective.number, per_page: 100 },
      hooks.signal,
    )
  ).data;
  assert.ok(Array.isArray(children) && children.length <= 3);
  const comments = [];
  for (const number of [hooks.evidence.objective.number, ...children.map((item) => item.number)]) {
    const rows = (
      await schedulingRequest(
        hooks,
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: number, per_page: 100 },
        hooks.signal,
      )
    ).data;
    assert.ok(Array.isArray(rows) && rows.length < 100, "receipt page incomplete");
    comments.push(...rows);
  }
  return {
    receipts: authenticatedFaultEvents(
      comments,
      hooks.evidence.actor,
      hooks.evidence.objective.number,
    ),
    status: await hooks.call("factory_status", {
      owner: hooks.owner,
      repo: hooks.repo,
      objectiveNumber: hooks.evidence.objective.number,
    }),
    unit: observeSchedulingService(primary, port),
  };
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
          "observed no-worker budget-stop boundary unavailable; inspect private evidence",
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
      context.evidence.budgetStop = {
        kind: "observed-compiler-budget-stop-no-worker",
        primary,
        observations: [],
        cancelRequestId: `${authority.namespace}-cancel`,
      };
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
    duringRun: safe(async (hooks) => {
      let settled = false;
      void hooks.run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const proof = hooks.evidence.budgetStop;
      proof.cancelReceipt = await observeBudgetStopThenCancel({
        context: {
          repository: authority.repository,
          objective: hooks.evidence.objective.number,
          base: hooks.evidence.base,
          actor: hooks.evidence.actor,
        },
        cancelRequestId: proof.cancelRequestId,
        assertRunning: () =>
          assert.ok(
            !settled && !hooks.signal.aborted,
            "original outcome uncertain; no cancellation authorized by this qualifier",
          ),
        read: () => snapshot(hooks, primary, port),
        cancel: (requestId) =>
          hooks.call("factory_cancel", {
            owner: hooks.owner,
            repo: hooks.repo,
            objectiveNumber: hooks.evidence.objective.number,
            requestId,
            reason: "Observed initial model-token budget exhausted before any worker admission",
          }),
        saveObservation: (observation) => {
          proof.observations.push(observation);
          hooks.save();
        },
        saveCancelRequested: (observation) => {
          proof.beforeCancel = observation;
          proof.cancelRequested = true;
          hooks.save();
        },
        ...(port ? { wait: port.wait, now: port.now } : {}),
      });
      hooks.save();
    }),
    afterRun: safe(async (hooks) => {
      assertTerminal(hooks.evidence);
      hooks.evidence.budgetStop.cleanup = await changeSchedulingService(primary, "stop", port);
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
            "Known compiler usage, no-worker budget stop, cancelled terminal and owned cleanup not all established",
        };
      }
    },
    verifyFinalArtifact: safe(async (hooks) => {
      assertBudgetStopCompletion(hooks.evidence);
      const start = finalEvents(hooks.evidence).find(
        (event) => event.event === "FactoryRunStarted",
      );
      assert.ok(
        typeof start.baseBranch === "string" &&
          start.baseBranch.length > 0 &&
          start.baseBranch.length <= 500,
        "recorded default branch unavailable",
      );
      const head = (
        await schedulingRequest(hooks, "GET /repos/{owner}/{repo}/commits/{ref}", {
          ref: start.baseBranch,
        })
      ).data.sha;
      assert.equal(
        head,
        hooks.evidence.base,
        "default branch changed in a no-worker qualification",
      );
      hooks.evidence.noArtifactObservation = {
        defaultSha: head,
        unchanged: true,
        workerAttempts: 0,
        pullRequests: 0,
        mergedTests: "not applicable: no worker or artifact",
      };
    }),
    onFailure: async (hooks) => {
      hooks.evidence.failure =
        "observed no-worker budget-stop boundary incomplete; no automatic reinjection";
      hooks.evidence.budgetStop ??= {};
      hooks.evidence.budgetStop.failure = {
        code: "budget-stop-evidence-incomplete",
        automaticRetry: false,
        automaticCancellationFallback: false,
      };
    },
  };
}

export async function main(env = process.env, run = installedMain) {
  const authority = budgetStopAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit no-worker budget-stop opt-in required.");
    return;
  }
  await run(createBudgetStopQualification(authority, env));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "No-worker budget-stop qualification incomplete; preserve private evidence. No automatic reinjection.",
    );
    process.exitCode = 2;
  }
}
