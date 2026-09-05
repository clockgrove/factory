import { randomUUID } from "node:crypto";
import type { GitHubControlStore, DurableObjectiveActivation } from "../control/github-store.js";
import { LeaseManager } from "../control/lease.js";
import { GitHubReader } from "../github.js";
import { RecoveryCoordinator } from "../recovery/coordinator.js";
import { recoveryReadPort } from "../recovery/github-read-port.js";
import { loadRecoveryPlan } from "../recovery/plan.js";
import { loadRecoveryRuntime } from "../recovery/runtime.js";
import type { RepositoryLeaseManager, RepositoryLeaseState } from "./repository-lease.js";
import { ControllerGenerationRetirement, shouldRetireController } from "./retirement.js";

export interface RecoveryRepositoryOwnership {
  leases: Pick<RepositoryLeaseManager, "assertCurrent">;
  current(): RepositoryLeaseState;
}

/** Complete adoption under both real leases before constructing an execution Supervisor. */
export async function adoptRecoveryActivation(input: {
  token: string;
  owner: string;
  repo: string;
  activation: DurableObjectiveActivation;
  store: GitHubControlStore;
  ownership: RecoveryRepositoryOwnership;
  signal: AbortSignal;
  checkout: string;
}): Promise<void> {
  const recovery = input.activation.recovery;
  if (!recovery) throw new Error("Recovery activation identity is required");
  const read = recoveryReadPort(input.store, input.owner, input.repo);
  const reader = new GitHubReader({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    recoveryInspection: true,
  });
  const readSnapshot = async () => ({
    snapshot: await reader.readObjective(input.activation.objective),
    historyComplete: true,
  });
  await input.ownership.leases.assertCurrent(input.ownership.current());
  if (input.signal.aborted) throw new Error("Recovery adoption cancelled before mutation");
  const runtime = await loadRecoveryRuntime({
    objective: input.activation.objective,
    runId: recovery.successorRunId,
    store: read,
    readSnapshot,
  });
  if (runtime.status === "verified") {
    if (
      runtime.planRecord.digest !== recovery.planDigest ||
      runtime.planRecord.plan.requestId !== recovery.requestId
    )
      throw new Error("Observed successor runtime does not match controller discovery");
    return; // Execution will reload runtime and independently recheck resources/admission.
  }
  const record = await loadRecoveryPlan(read, input.activation.objective, recovery.planDigest);
  if (
    !record ||
    record.plan.successorRunId !== recovery.successorRunId ||
    record.plan.requestId !== recovery.requestId ||
    record.plan.policyDigest !== input.activation.policyDigest ||
    record.plan.expectedBaseSha !== input.activation.baseSha
  )
    throw new Error("Recovery activation changed before adoption");
  const objectiveLeases = new LeaseManager({ store: input.store });
  await input.ownership.leases.assertCurrent(input.ownership.current());
  if (input.signal.aborted) throw new Error("Recovery adoption cancelled before lease acquisition");
  const objectiveLease = await objectiveLeases.acquire(
    {
      objective: input.activation.objective,
      runId: recovery.successorRunId,
      holder: `recovery-adoption-${randomUUID()}`,
      policyDigest: record.plan.policyDigest,
    },
    await input.store.readCommit(record.plan.expectedBaseSha),
  );
  try {
    const coordinator = new RecoveryCoordinator({
      store: {
        ...read,
        createBlob: input.store.createBlob.bind(input.store),
        createTree: input.store.createTree.bind(input.store),
        createCommit: input.store.createCommit.bind(input.store),
        createRef: input.store.createRef.bind(input.store),
        serverTime: input.store.serverTime.bind(input.store),
        addIssueComment: input.store.addIssueComment.bind(input.store),
      },
      readSnapshot,
      objectiveLeases: {
        assertCurrent: async (lease) => {
          if (input.signal.aborted) throw new Error("Recovery adoption cancelled");
          await objectiveLeases.assertCurrent(lease);
        },
      },
      repositoryLeases: input.ownership.leases,
    });
    const result = await coordinator.adopt({
      objective: input.activation.objective,
      planDigest: recovery.planDigest,
      objectiveLease,
      repositoryLease: input.ownership.current(),
    });
    if (result.status === "blocked" && result.blockers.includes("resource-absence-unverified")) {
      const observed = await readSnapshot();
      if (
        await shouldRetireController({
          plan: record.plan,
          snapshot: observed.snapshot,
          checkout: input.checkout,
        })
      )
        throw new ControllerGenerationRetirement();
    }
    if (result.status !== "adopted")
      throw new Error(`Recovery adoption ${result.status}: ${result.blockers.join(", ")}`);
  } finally {
    await objectiveLeases.release(objectiveLease).catch(() => undefined);
  }
}
