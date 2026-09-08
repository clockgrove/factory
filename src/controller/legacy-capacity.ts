import { GitHubReader } from "../github.js";
import type { GitHubControlStore } from "../control/github-store.js";
import { CompiledGraphManager } from "../control/graphs.js";
import { LeaseManager } from "../control/lease.js";
import { unresolvedModelInvocations } from "../control/budget.js";
import { normalizeSchedulingPolicy } from "../protocol/policy.js";
import { workerPacketFromCompiled } from "../graph.js";
import { deriveCapacityReservations } from "../scheduling/capacity-ledger.js";
import { observeLocalScopeBatch } from "../recovery/scope-resources.js";
import type { SharedCapacityImport } from "./shared-capacity.js";

/** Called only under short legacy-election fencing, before the shared ledger exists. */
export async function importLegacyCapacity(input: {
  store: GitHubControlStore;
  token: string;
  owner: string;
  repo: string;
  assertCurrent(): Promise<void>;
}): Promise<SharedCapacityImport[]> {
  const refs = await input.store.listRefs("refs/clockgrove-factory/leases/objective-");
  if (refs.length >= 1000)
    throw new Error("legacy Objective enumeration requires bounded explicit reconciliation");
  const reader = new GitHubReader({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    recoveryInspection: true,
  });
  const graphs = new CompiledGraphManager(input.store, new LeaseManager({ store: input.store }));
  const imported: SharedCapacityImport[] = [];
  for (const ref of refs) {
    const match = /^refs\/clockgrove-factory\/leases\/objective-([1-9]\d*)$/.exec(ref.ref);
    if (!match) throw new Error("unknown legacy Objective ownership ref");
    const objective = Number(match[1]);
    await input.assertCurrent();
    const snapshot = await reader.readObjective(objective);
    const events = [
      ...(snapshot.factoryEvents ?? []),
      ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
    ];
    const starts = events.filter(
      (event) => event.kind === "run" && event.event === "FactoryRunStarted",
    );
    if (starts.length === 0) {
      // Missing/deleted activation history cannot prove no worker was launched.
      throw new Error(
        `Objective #${objective} needs authenticated legacy run history for capacity migration`,
      );
    }
    for (const start of starts) {
      if (start.kind !== "run" || start.event !== "FactoryRunStarted") continue;
      const runEvents = events.filter((event) => event.runId === start.runId);
      const recordedGraphs = runEvents.filter(
        (event) => event.kind === "graph" && event.event === "GraphCompiled",
      );
      const historicalGraph =
        recordedGraphs.length > 0 ? await graphs.load(objective, start.runId) : null;
      const historicalProjection = historicalGraph
        ? await graphs.loadProjection(objective, start.runId, historicalGraph)
        : null;
      if (recordedGraphs.length > 0 && !historicalGraph)
        throw new Error(
          `Objective #${objective} requires its original compiled graph for capacity migration`,
        );
      if (
        historicalProjection?.bindings.some(
          (binding) =>
            !snapshot.workItems.some(
              (item) => item.number === binding.issueNumber && item.id === binding.issueNodeId,
            ),
        )
      )
        throw new Error(
          `Objective #${objective} needs missing historical Work Item evidence for capacity migration`,
        );
      const scheduling = normalizeSchedulingPolicy(start.policy);
      const inputs = snapshot.workItems.map((item) => ({
        objective,
        workItem: item.number,
        events: runEvents.filter((event) => "workItem" in event && event.workItem === item.number),
        defaultCpu: scheduling.capacity.local.defaultCpu,
        defaultMemoryMb: scheduling.capacity.local.defaultMemoryMb,
        isLocalBackend: (id: string) =>
          id.endsWith("/local-worktree") || id.startsWith("factory/integration-validation-"),
      }));
      const outstanding = deriveCapacityReservations(inputs);
      if (outstanding.length > 0) {
        const graph = historicalGraph;
        const recorded = recordedGraphs;
        if (
          !graph ||
          recorded.length !== 1 ||
          recorded[0]?.kind !== "graph" ||
          recorded[0].event !== "GraphCompiled" ||
          recorded[0].graphDigest !== graph.graphDigest ||
          recorded[0].graphBlobSha !== graph.blobOid
        )
          throw new Error(
            `Objective #${objective} needs exact historical graph proof for retained capacity`,
          );
        const projection = historicalProjection;
        if (!projection)
          throw new Error(`Objective #${objective} needs historical capacity projection`);
        for (const reservation of outstanding) {
          const binding = projection.bindings.find(
            (row) => row.issueNumber === reservation.workItem,
          );
          const item = graph.objective.workItems.find((row) => row.id === binding?.compilerId);
          if (!item) throw new Error(`Objective #${objective} has unbound retained capacity`);
          const packet = workerPacketFromCompiled(item);
          const receipt = runEvents.find(
            (event) =>
              "workItem" in event &&
              event.workItem === reservation.workItem &&
              "attempt" in event &&
              event.attempt === reservation.attempt &&
              ((reservation.phase === "execution" &&
                event.kind === "attempt" &&
                event.event === "AttemptReserved" &&
                event.backend === reservation.backendId) ||
                (reservation.phase === "validation" &&
                  event.kind === "capacity" &&
                  event.event === "CapacityReserved" &&
                  event.backend === reservation.backendId)),
          );
          if (
            !receipt ||
            (receipt.kind !== "attempt" && receipt.kind !== "capacity") ||
            !receipt.directorEpoch ||
            !("policyDigest" in receipt) ||
            !receipt.policyDigest
          )
            throw new Error(`Objective #${objective} retained capacity lacks original ownership`);
          imported.push({
            owner: {
              objective,
              runId: start.runId,
              directorEpoch: receipt.directorEpoch,
              policyDigest: receipt.policyDigest,
            },
            reservation: {
              ...reservation,
              paths: packet.allowedPaths,
              exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
            },
          });
        }
      }
      for (const invocation of unresolvedModelInvocations(runEvents)) {
        // Unknown tokens remain unknown in the Objective ledger. For migration,
        // only an uncontained producer is a repository resource concern.
        if (
          invocation.phase === "execution" &&
          imported.some(
            (claim) =>
              claim.owner.objective === objective &&
              claim.owner.runId === invocation.runId &&
              claim.owner.directorEpoch === invocation.directorEpoch &&
              claim.owner.policyDigest === invocation.policyDigest &&
              claim.reservation.workItem === invocation.workItem &&
              claim.reservation.attempt === invocation.attempt &&
              claim.reservation.phase === "execution",
          )
        )
          continue; // The exact producer retains its occupied slot, not an invented zero.
        const batches = runEvents.flatMap((event) =>
          (event.kind === "attempt" || event.kind === "capacity") &&
          event.localScopeBatch &&
          event.directorEpoch === invocation.directorEpoch
            ? [event.localScopeBatch]
            : [],
        );
        if (batches.length === 0)
          throw new Error(
            `Objective #${objective} invocation ${invocation.modelInvocationId} needs exact producer-absence proof before capacity migration`,
          );
        for (const batch of batches) {
          if ((await observeLocalScopeBatch(batch)).status !== "absent")
            throw new Error(
              `Objective #${objective} invocation ${invocation.modelInvocationId} has an unresolved producer resource during capacity migration`,
            );
        }
      }
    }
  }
  await input.assertCurrent();
  return imported;
}
