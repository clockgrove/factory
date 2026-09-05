/** Opt-in, installed-plugin provider Objectives. Importing this module performs no I/O. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona } from "@daytona/sdk";
import {
  assertCompletion,
  boundedPolicy,
  main as runInstalledObjective,
  objectiveBody,
} from "./verify-live-objective.mjs";

const DAYTONA = "codex-cli/daytona";
const LOCAL = ["codex-sdk/local-worktree", "codex-cli/local-worktree"];
const PROFILES = {
  "daytona-burst": DAYTONA,
  "github-copilot": "github-copilot/github-managed",
  "openai-codex": "openai-codex/github-managed",
};

function integer(value, name, min, max) {
  assert.match(value ?? "", /^[1-9]\d*$/, `${name} requires an explicit positive integer`);
  const result = Number(value);
  assert.ok(
    Number.isSafeInteger(result) && result >= min && result <= max,
    `${name} outside bounded qualification limits`,
  );
  return result;
}

export function providerAuthority(env) {
  if (env.FACTORY_LIVE_PROVIDER !== "1") return null;
  assert.equal(env.FACTORY_LIVE_OBJECTIVE, "1", "installed Objective opt-in is also required");
  const profile = env.FACTORY_LIVE_PROVIDER_PROFILE;
  assert.ok(Object.hasOwn(PROFILES, profile ?? ""), "select exactly one provider profile");
  const repository = env.FACTORY_LIVE_OBJECTIVE_REPOSITORY;
  assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
  assert.equal(
    env.FACTORY_LIVE_PROVIDER_PAID_ACK,
    `${profile}:${repository}`,
    "acknowledge exact paid provider and disposable target",
  );
  assert.equal(
    env.FACTORY_LIVE_PROVIDER_CLEANUP_ACK,
    `${repository}:cancel-and-reconcile`,
    "acknowledge scoped cancellation and resource reconciliation",
  );
  const sandboxMinutes = integer(
    env.FACTORY_LIVE_PROVIDER_MAX_SANDBOX_MINUTES,
    "sandbox minutes",
    10,
    120,
  );
  const modelTokens = integer(
    env.FACTORY_LIVE_PROVIDER_MAX_MODEL_TOKENS,
    "model tokens",
    1000,
    500000,
  );
  const managedSessions =
    profile === "daytona-burst"
      ? 0
      : integer(env.FACTORY_LIVE_PROVIDER_MAX_MANAGED_SESSIONS, "managed sessions", 3, 3);
  return { profile, repository, sandboxMinutes, modelTokens, managedSessions };
}

export function providerPolicy(authority) {
  const burst = authority.profile === "daytona-burst";
  const provider = PROFILES[authority.profile];
  assert.ok(provider, "unknown provider profile");
  const baseline = boundedPolicy(burst ? "stacked-prs" : "regular-prs");
  return {
    ...baseline,
    backendOrder: burst ? [...LOCAL, DAYTONA] : [provider, DAYTONA],
    maxParallel: burst ? 2 : 1,
    maxAttemptsPerItem: 1,
    workItemTimeoutMinutes: 4,
    allowedPaidBackends: burst ? [DAYTONA] : [provider, DAYTONA],
    cloudFallback: "explicit",
    maxSandboxMinutes: authority.sandboxMinutes,
    maxManagedAgentSessions: authority.managedSessions,
    allowedNetworkDestinations: [
      "api.openai.com",
      "registry.npmjs.org",
      "*.npmjs.org",
      "github.com",
      "api.github.com",
    ],
    economics: {
      ...baseline.economics,
      maxModelTokens: authority.modelTokens,
      maxSandboxMinutes: authority.sandboxMinutes,
      maxManagedSessions: authority.managedSessions,
    },
    capacity: { ...baseline.capacity, local: { ...baseline.capacity.local, maxWorkers: 1 } },
    burst: {
      mode: "saturation",
      backendOrder: [provider],
      maxCloudParallel: 1,
      queueDelaySeconds: 0,
      deadlineReserveMinutes: 1,
      maxPriorityRank: 1000,
    },
    delivery: {
      mode: burst ? "stacked-prs" : "regular-prs",
      onUnavailable: "escalate",
      merge: "bottom-up",
    },
  };
}

export function providerObjective(profile) {
  return (
    objectiveBody.replace("cloud workers, ", "") +
    (profile === "daytona-burst"
      ? "\nThe two foundations must be independent root sibling delivery units; the final unit must join-after-merge. Their code is trusted_local. Factory may overflow one concurrent worker to the explicitly authorized Daytona sandbox; independent provider validation must remain isolated."
      : `\nEvery Work Item must declare managed execution trust and use only the ${PROFILES[profile]} managed profile. Daytona is authorized only for independent validation. Do not substitute local execution or a different managed profile.`)
  );
}

export function assessProviderCompletion(evidence, authority) {
  const scope =
    authority.profile === "daytona-burst"
      ? "installed-daytona-burst-objective-happy-path"
      : "installed-managed-objective-happy-path";
  try {
    const provider = PROFILES[authority.profile];
    const allowed = authority.profile === "daytona-burst" ? [...LOCAL, DAYTONA] : [provider];
    assertCompletion(evidence, allowed);
    assert.ok(
      Number.isSafeInteger(evidence.actor?.id) && evidence.actor.id > 0,
      "missing authenticated actor ID",
    );
    const events = evidence.events.filter((event) => event.runId === evidence.runResult.runId);
    assert.ok(
      events.every((event) => event.authorId === evidence.actor.id),
      "unauthenticated run receipt author",
    );
    const runStarts = events.filter((event) => event.event === "FactoryRunStarted");
    assert.equal(runStarts.length, 1, "exact authenticated run start required");
    assert.deepEqual(
      runStarts[0].policy?.backendOrder,
      providerPolicy(authority).backendOrder,
      "run policy changed provider selection",
    );
    assert.equal(
      runStarts[0].policy?.maxSandboxMinutes,
      authority.sandboxMinutes,
      "run sandbox authority differs",
    );
    assert.equal(
      runStarts[0].policy?.maxManagedAgentSessions,
      authority.managedSessions,
      "run managed authority differs",
    );
    const starts = events.filter((event) => event.event === "AttemptStarted");
    assert.ok(
      starts.some((event) => event.backend === provider),
      "selected provider never executed a Work Item",
    );
    if (authority.profile === "daytona-burst") {
      assert.ok(
        starts.some(
          (cloud) =>
            cloud.backend === DAYTONA &&
            starts.some(
              (local) =>
                LOCAL.includes(local.backend) &&
                local.workItem !== cloud.workItem &&
                events.some(
                  (terminal) =>
                    terminal.workItem === cloud.workItem &&
                    terminal.attempt === cloud.attempt &&
                    terminal.event === "AttemptSucceeded" &&
                    terminal.sequence > local.sequence,
                ) &&
                events.some(
                  (terminal) =>
                    terminal.workItem === local.workItem &&
                    terminal.attempt === local.attempt &&
                    terminal.event === "AttemptSucceeded" &&
                    terminal.sequence > cloud.sequence,
                ),
            ),
        ),
        "no evidenced local-to-cloud execution overlap; sequential fallback does not qualify burst",
      );
    } else {
      assert.equal(starts.length, 3, "managed scenario requires exactly three bounded sessions");
    }
    for (const start of starts.filter((event) => event.backend === provider)) {
      const unit =
        authority.profile === "daytona-burst" ? "sandbox_milliseconds" : "managed_sessions";
      assert.ok(
        events.some(
          (event) =>
            event.event === "BudgetReserved" &&
            event.phase === "execution" &&
            event.unit === unit &&
            event.workItem === start.workItem &&
            event.attempt === start.attempt &&
            event.sequence < start.sequence &&
            event.amount > 0,
        ),
        "provider start lacks prior native budget authority",
      );
      assert.ok(
        events.some(
          (event) =>
            event.event === "CapacityReserved" &&
            event.phase === "validation" &&
            event.backend === DAYTONA &&
            event.workItem === start.workItem &&
            event.attempt === start.attempt,
        ),
        "provider worker lacks independent Daytona validation admission",
      );
    }
    const native = events.filter((event) => event.event === "BudgetReconciled");
    assert.ok(
      native
        .filter((event) => event.unit === "sandbox_milliseconds")
        .reduce((sum, event) => sum + event.amount, 0) <=
        authority.sandboxMinutes * 60000,
      "observed sandbox duration exceeded authorized ceiling",
    );
    assert.ok(
      native
        .filter((event) => event.unit === "managed_sessions")
        .reduce((sum, event) => sum + event.amount, 0) <= authority.managedSessions,
      "observed managed sessions exceeded authorized ceiling",
    );
    assert.equal(
      evidence.cleanupObservation?.state,
      "absent",
      "Daytona cleanup is not independently observed absent",
    );
    if (authority.profile !== "daytona-burst") {
      return {
        result: "incomplete",
        scope,
        reason:
          "Objective orchestration passed; provider session absence and billing are not qualified by a merged PR",
      };
    }
    return {
      result: "passed",
      scope,
      excludes: [
        "provider billing accuracy",
        "crash/TTL/egress fault qualification",
        "managed agents",
      ],
    };
  } catch (error) {
    return {
      result: "incomplete",
      scope,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    };
  }
}

/** Read-only listing. A label match is never permission to delete a resource. */
export async function observeProviderAbsence(daytona, evidence) {
  const runId = evidence.status?.run?.runId ?? evidence.runResult?.runId;
  if (!runId || !evidence.objective?.number)
    return { state: "unknown", reason: "run identity unavailable" };
  try {
    const labels = {
      factory: "v2",
      objective: String(evidence.objective.number),
      run: runId.slice(0, 48),
    };
    const resources = [];
    for await (const sandbox of daytona.list({ labels, limit: 100 })) {
      if (resources.length >= 100)
        return { state: "unknown", reason: "resource observation bound exceeded" };
      if (!Object.entries(labels).every(([key, value]) => sandbox.labels?.[key] === value))
        return {
          state: "unknown",
          reason: "provider returned a resource outside exact query labels",
        };
      resources.push({
        id: String(sandbox.id).slice(0, 200),
        name: String(sandbox.name).slice(0, 200),
      });
    }
    return {
      state: resources.length ? "present" : "absent",
      observedAt: new Date().toISOString(),
      resources,
      scope: "exact Objective and original run label query; not provider billing evidence",
    };
  } catch {
    return { state: "unknown", reason: "provider resource observation unavailable" };
  }
}

export async function main() {
  const authority = providerAuthority(process.env);
  if (!authority) {
    console.log(
      "Not exercised: explicit FACTORY_LIVE_PROVIDER=1 and provider/target/budget/cleanup authority are required.",
    );
    return;
  }
  // This installed profile deliberately has no provider-published stable actor mapping yet.
  assert.notEqual(
    authority.profile,
    "openai-codex",
    "Not exercised: Codex managed profile lacks qualified stable provider actor identity; no Objective or session was created",
  );
  const policy = providerPolicy(authority);
  const observe = async ({ evidence }) => {
    evidence.cleanupObservation = await observeProviderAbsence(new Daytona(), evidence);
  };
  await runInstalledObjective({
    scope:
      authority.profile === "daytona-burst"
        ? "installed-daytona-burst-objective-happy-path"
        : "installed-managed-objective-happy-path",
    policy,
    objectiveBody: providerObjective(authority.profile),
    assessCompletion: (evidence) => assessProviderCompletion(evidence, authority),
    beforeRun: async ({ call, checkout, evidence }) => {
      evidence.providerAuthority = authority;
      assert.ok(process.env.DAYTONA_API_KEY, "Daytona validation credentials are unavailable");
      if (authority.profile === "daytona-burst") {
        const probes = await call("probe_execution_backends", { repository: checkout });
        assert.ok(
          probes.some(
            (row) => row.id === DAYTONA && row.probe.available && row.probe.authenticated,
          ),
          "Daytona worker preflight failed before Objective creation",
        );
      }
    },
    afterRun: observe,
    onFailure: async (context) => {
      const { evidence, call, owner, repo, checkout } = context;
      if (
        evidence.objective &&
        ["active", "paused", "draining"].includes(evidence.status?.run?.state)
      ) {
        evidence.cancellationRequest = await call("factory_cancel", {
          owner,
          repo,
          objectiveNumber: evidence.objective.number,
          repository: checkout,
          requestId: randomUUID(),
          reason: "Explicitly authorized disposable provider qualification cleanup",
        });
      }
      await observe(context);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
