/** Explicit installed native refresh qualification; no fallback or successor claims. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQualificationCompletion,
  boundedPolicy,
  main as installedMain,
  modelTokenLimit,
} from "./verify-live-objective.mjs";
import {
  assertNativeMergeProof,
  nativeQualificationEvents,
  observeNativeMergeProofs,
} from "./qualification-sibling-refresh-proof.mjs";
import { assertNativeScopes, observeNativeScopes } from "./qualification-native-scopes.mjs";

const scope = "installed-local-native-sibling-refresh-objective";
const files = [
  "verify-native-refresh-objective.mjs",
  "qualification-sibling-refresh-proof.mjs",
  "qualification-merge-proof.mjs",
  "qualification-receipts.mjs",
  "verify-live-objective.mjs",
  "qualification-native-scopes.mjs",
  "verify-local-faults.mjs",
];
function harnessIdentity() {
  return files.map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest("hex"),
  }));
}
function assertCommittedHarness(evidence) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    assert.ok(!result.error && result.status === 0, "committed qualifier source unavailable");
    return result.stdout;
  };
  assert.equal(
    git(["rev-parse", "HEAD"]).trim(),
    evidence.preflight.harness.sourceCommit,
    "qualifier source commit changed",
  );
  for (const entry of harnessIdentity())
    assert.equal(
      createHash("sha256")
        .update(git(["show", `HEAD:scripts/${entry.file}`]))
        .digest("hex"),
      entry.sha256,
      "qualifier source is not the committed candidate",
    );
}
export function nativeRefreshQualification(env) {
  if (env.FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE !== "1") return null;
  assert.ok(
    env.FACTORY_LIVE_OBJECTIVE === "1" || env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1",
    "shared explicit preflight or execution opt-in required",
  );
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "stacked-prs",
    "native refresh qualification cannot select regular delivery",
  );
  return {
    scope,
    privateEvidence: true,
    policy: boundedPolicy(
      "stacked-prs",
      modelTokenLimit(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS),
    ),
    beforeRun: async ({ evidence, request }) => {
      assertCommittedHarness(evidence);
      const { data } = await request("GET /repos/{owner}/{repo}", {
        request: { signal: AbortSignal.timeout(15000) },
      });
      assert.equal(data.full_name, evidence.repository);
      assert.ok(typeof data.default_branch === "string" && data.default_branch.length > 0);
      evidence.nativeDefaultBranch = data.default_branch;
      evidence.nativeHarness = harnessIdentity();
    },
    observeMergeProofs: observeNativeMergeProofs,
    afterRun: async ({ evidence }) => {
      assertCommittedHarness(evidence);
      assert.deepEqual(
        harnessIdentity(),
        evidence.nativeHarness,
        "native qualifier changed during run",
      );
      observeNativeScopes(evidence);
    },
    assessCompletion: assessNativeRefreshCompletion,
  };
}
export function assertNativeRefreshCompletion(evidence) {
  assertQualificationCompletion(evidence, "stacked-prs", undefined, (proof, input) =>
    assertNativeMergeProof(evidence, proof, input),
  );
  assert.equal(evidence.scope, scope);
  assertNativeScopes(evidence);
  assert.equal(evidence.preflight.harness.sourceTreeClean, true);
  assert.match(evidence.preflight.harness.sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    evidence.nativeHarness.map((entry) => entry.file),
    files,
  );
  for (const entry of evidence.nativeHarness) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    evidence.policy,
    boundedPolicy("stacked-prs", modelTokenLimit(String(evidence.policy.economics.maxModelTokens))),
  );
  const events = nativeQualificationEvents(evidence);
  const start = events.find((event) => event.event === "FactoryRunStarted");
  assert.deepEqual(
    start.policy,
    evidence.policy,
    "durable native policy differs from exact request",
  );
  assert.equal(evidence.runRequest?.tool, "factory_run");
  const args = evidence.runRequest.arguments;
  assert.equal(`${args.owner}/${args.repo}`, evidence.repository);
  assert.equal(args.objectiveNumber, evidence.objective.number);
  assert.equal(args.untilTerminal, true);
  assert.deepEqual(args.policy, evidence.policy);
  const graphs = events.filter((event) => event.event === "GraphCompiled");
  assert.equal(graphs.length, 1);
  assert.equal(graphs[0].baseSha, evidence.base);
  assert.equal(evidence.preflight.base, evidence.base);
  const attempts = events.filter((event) => event.event === "AttemptStarted");
  assert.equal(attempts.length, 3, "fresh fixture requires one execution per Work Item");
  assert.equal(new Set(attempts.map((event) => event.workItem)).size, 3);
  for (const attempt of attempts) {
    assert.equal(attempt.attempt, 1);
    assert.equal(attempt.policyDigest, start.policyDigest);
    assert.ok(
      events.some(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.unit === "model_tokens" &&
          event.phase === "execution" &&
          event.workItem === attempt.workItem &&
          event.attempt === attempt.attempt &&
          event.usageId === `worker-${attempt.workItem}-${attempt.attempt}` &&
          event.amount > 0,
      ),
      "worker model usage unavailable",
    );
  }
  const roots = evidence.dependencies.filter((entry) => entry.blockedBy.length === 0);
  for (const root of roots)
    assert.equal(
      events.find(
        (event) => event.event === "PublicationRecorded" && event.workItem === root.workItem,
      ).baseSha,
      evidence.base,
      "siblings did not originate at the same pinned base",
    );
  assert.ok(
    evidence.nativeMergeEvidence.some(
      (record) => roots.some((root) => root.workItem === record.workItem) && record.refreshed > 0,
    ),
    "no independent native sibling refresh was exercised",
  );
}
export function assessNativeRefreshCompletion(evidence) {
  try {
    assertNativeRefreshCompletion(evidence);
    return { result: "passed", scope };
  } catch {
    return {
      result: ["cancelled", "escalated"].includes(evidence?.status?.run?.state)
        ? "failed"
        : "incomplete",
      scope,
      reason:
        "Native refresh evidence is missing or conflicting; inspect private receipts. No historical publication was relabelled.",
    };
  }
}
export async function main(env = process.env, run = installedMain) {
  const qualification = nativeRefreshQualification(env);
  if (!qualification) {
    console.log(
      "Not exercised: set FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE=1 with the shared explicit qualification guards.",
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
      "Native refresh qualification incomplete; inspect private evidence. No automatic retry performed.",
    );
    process.exitCode = 2;
  }
}
