/** Explicit regular delivery qualification; never a substitute for native concurrency. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQualificationCompletion,
  boundedPolicy,
  main as installedMain,
  modelTokenLimit,
} from "./verify-live-objective.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";

const scope = "installed-local-explicit-regular-objective";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function eventsOf(evidence) {
  return deduplicateQualificationReceipts(
    evidence.events
      .filter((event) => event.runId === evidence.runResult.runId)
      .map((event) => {
        const envelope = { ...event };
        delete envelope.author;
        delete envelope.authorId;
        delete envelope.receiptUrl;
        return { event: envelope };
      }),
  ).map(({ event }) => event);
}

export function regularQualification(env) {
  if (env.FACTORY_LIVE_REGULAR_OBJECTIVE !== "1") return null;
  assert.ok(
    env.FACTORY_LIVE_OBJECTIVE === "1" || env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1",
    "explicit shared preflight or execution opt-in required",
  );
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "regular-prs",
    "regular qualifier cannot override another delivery selection",
  );
  const policy = boundedPolicy(
    "regular-prs",
    modelTokenLimit(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS),
  );
  return {
    scope,
    policy,
    privateEvidence: true,
    assessCompletion: assessRegularCompletion,
    afterRun: observeRegularCommits,
  };
}

/** Only immutable exact Git commit reads, after the installed Supervisor returns. */
export async function observeRegularCommits({ evidence, request }) {
  const events = eventsOf(evidence);
  const shas = [
    ...new Set(
      events
        .filter((event) => ["AttemptIntegrated", "PublicationRecorded"].includes(event.event))
        .map((event) => event.headSha),
    ),
  ];
  assert.ok(
    shas.length >= 3 && shas.length <= 12 && shas.every((sha) => /^[a-f0-9]{40}$/.test(sha)),
    "unbounded or malformed regular commit identities",
  );
  evidence.regularCommits = [];
  for (const sha of shas) {
    const { data } = await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      commit_sha: sha,
    });
    assert.equal(data.sha, sha, "commit read returned another identity");
    evidence.regularCommits.push({
      sha: data.sha,
      treeSha: data.tree.sha,
      parents: data.parents.map((parent) => parent.sha),
    });
  }
}

export function assertRegularCompletion(evidence) {
  assertQualificationCompletion(evidence, "regular-prs");
  assert.equal(evidence.scope, scope, "qualification scope differs");
  const expected = boundedPolicy(
    "regular-prs",
    modelTokenLimit(String(evidence.policy.economics.maxModelTokens)),
  );
  assert.deepEqual(evidence.policy, expected, "requested bounded regular policy differs");
  const events = eventsOf(evidence);
  const start = events.find((event) => event.event === "FactoryRunStarted");
  assert.deepEqual(start.policy, expected, "durable policy changed from exact request");
  assert.equal(start.policyDigest, hash(canonical(start.policy)), "durable policy digest changed");
  // Foreground runs do not carry an ActivationRequested/baseSha envelope.
  // The authenticated compilation receipt independently pins their initial base.
  assert.equal(start.activationRequestId, undefined, "unexpected controller activation");
  assert.equal(start.recoveryRequestId, undefined, "unexpected successor activation");
  const graphs = events.filter((event) => event.event === "GraphCompiled");
  assert.equal(graphs.length, 1, "exactly one fresh compilation required");
  assert.equal(graphs[0].baseSha, evidence.base, "compiled base differs from preflight");
  assert.equal(evidence.preflight.base, evidence.base, "preflight base differs");
  assert.equal(evidence.runRequest?.tool, "factory_run", "foreground request missing");
  const args = evidence.runRequest.arguments;
  assert.equal(`${args.owner}/${args.repo}`, evidence.repository, "request repository differs");
  assert.equal(args.objectiveNumber, evidence.objective.number, "request Objective differs");
  assert.equal(args.untilTerminal, true, "request terminal boundary differs");
  assert.deepEqual(args.policy, expected, "captured request policy differs");
  assert.ok(
    events.every(
      (event) =>
        !["StackLinked", "RecoverySourceIntegrated", "RecoverySourcePublished"].includes(
          event.event,
        ),
    ),
    "unexpected native or successor delivery",
  );
  assert.ok(
    events
      .filter((event) => event.kind === "publication")
      .every(
        (event) =>
          event.mode === "regular-prs" &&
          event.position === 0 &&
          !event.stackNumber &&
          !event.parentItemId,
      ),
    "hidden native publication topology",
  );
  assert.ok(
    Array.isArray(evidence.regularCommits) && evidence.regularCommits.length <= 12,
    "bounded exact commit observations required",
  );
  const commits = new Map(evidence.regularCommits.map((commit) => [commit.sha, commit]));
  assert.equal(commits.size, evidence.regularCommits.length, "duplicate commit observations");
  const integrated = events.filter((event) => event.event === "AttemptIntegrated");
  assert.equal(integrated.length, 3, "exactly three integration outcomes required");
  let base = evidence.base;
  for (const integration of integrated) {
    const sameAttempt = (event) =>
      event.workItem === integration.workItem && event.attempt === integration.attempt;
    const publication = events.find(
      (event) => sameAttempt(event) && event.event === "PublicationRecorded",
    );
    const validation = events.find(
      (event) =>
        sameAttempt(event) &&
        event.event === "ValidationRecorded" &&
        event.passed &&
        event.evidenceDigest === publication.validationDigest,
    );
    assert.ok(validation, "publication lacks its independent validation receipt");
    for (const sha of [base, publication.headSha, integration.headSha, validation.outputTreeSha])
      assert.match(sha, /^[a-f0-9]{40}$/, "malformed exact commit/tree identity");
    assert.equal(
      publication.baseSha,
      base,
      "regular publication did not build on previous integration",
    );
    assert.equal(validation.baseSha, base, "validation base differs from publication");
    assert.ok(
      validation.sequence < publication.sequence && publication.sequence < integration.sequence,
      "validation/publication/integration ordering differs",
    );
    assert.match(publication.validationDigest, /^[a-f0-9]{64}$/);
    const exact = {
      protocol: "clockgrove.factory/exact-head-validation-v1",
      validationDigest: publication.validationDigest,
      baseSha: base,
      outputTreeSha: validation.outputTreeSha,
      publishedHeadSha: publication.headSha,
    };
    assert.equal(
      publication.exactHeadValidationDigest,
      hash(JSON.stringify(exact)),
      "exact-head proof differs",
    );
    for (const sha of [publication.headSha, integration.headSha]) {
      const commit = commits.get(sha);
      assert.ok(commit, "exact commit missing");
      assert.deepEqual(commit.parents, [base], "commit is not the exact singleton-parent squash");
      assert.equal(
        commit.treeSha,
        validation.outputTreeSha,
        "commit tree differs from independent validation",
      );
    }
    base = integration.headSha;
  }
  const attempts = events.filter((event) => event.event === "AttemptStarted");
  assert.equal(
    new Set(attempts.map((event) => JSON.stringify([event.workItem, event.attempt]))).size,
    attempts.length,
    "duplicate worker launch identity",
  );
  const completion = events.find((event) => event.event === "FactoryRunCompleted");
  const usages = events.filter(
    (event) => event.event === "BudgetReconciled" && event.unit === "model_tokens",
  );
  const usageIdentity = new Map();
  for (const event of usages) {
    assert.ok(
      Number.isSafeInteger(event.amount) &&
        event.amount > 0 &&
        event.sequence > start.sequence &&
        event.sequence < completion.sequence,
      "model usage amount or chronology invalid",
    );
    const key = JSON.stringify([event.workItem, event.attempt, event.phase, event.usageId]);
    const value = canonical({
      amount: event.amount,
      reportedModelUsage: event.reportedModelUsage ?? null,
    });
    assert.ok(
      !usageIdentity.has(key) || usageIdentity.get(key) === value,
      "conflicting model call totals",
    );
    usageIdentity.set(key, value);
  }
  for (const attempt of attempts) {
    assert.equal(attempt.policyDigest, start.policyDigest, "worker policy binding differs");
    const outcome = integrated.find((event) => event.workItem === attempt.workItem);
    assert.ok(
      outcome && attempt.sequence < outcome.sequence,
      "worker launched after its integration",
    );
    assert.ok(
      Number.isSafeInteger(attempt.attempt) && attempt.attempt >= 1 && attempt.attempt <= 2,
      "attempt ceiling exceeded",
    );
    assert.ok(
      usages.some(
        (event) =>
          event.workItem === attempt.workItem &&
          event.attempt === attempt.attempt &&
          event.phase === "execution" &&
          event.usageId === `worker-${attempt.workItem}-${attempt.attempt}` &&
          event.sequence > attempt.sequence &&
          event.sequence < completion.sequence &&
          event.amount > 0,
      ),
      "worker model usage unavailable or unbound",
    );
  }
  for (const item of integrated)
    assert.ok(
      usages.some(
        (event) =>
          event.workItem === item.workItem &&
          event.attempt === item.attempt &&
          event.phase === "management" &&
          /^review-[a-f0-9]{64}$/.test(event.usageId) &&
          event.sequence < item.sequence,
      ),
      "accepted artifact review usage unavailable",
    );
  assert.ok(
    usages.some(
      (event) =>
        event.workItem === undefined &&
        event.attempt === undefined &&
        event.phase === "management" &&
        event.usageId === `compile-${graphs[0].graphDigest}`,
    ),
    "compilation usage unavailable",
  );
}

export function assessRegularCompletion(evidence) {
  try {
    assertRegularCompletion(evidence);
    return { result: "passed", scope };
  } catch {
    return {
      result: ["cancelled", "escalated"].includes(evidence?.status?.run?.state)
        ? "failed"
        : "incomplete",
      scope,
      reason:
        "Explicit regular delivery evidence is incomplete or conflicting; inspect private receipts",
    };
  }
}

export async function main(env = process.env, run = installedMain) {
  const qualification = regularQualification(env);
  if (!qualification) {
    console.log(
      "Not exercised: set FACTORY_LIVE_REGULAR_OBJECTIVE=1 with shared explicit qualification guards.",
    );
    return;
  }
  await run(qualification);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "Regular Objective qualification incomplete; inspect the private evidence file. No automatic retry performed.",
    );
    process.exitCode = 2;
  }
}
