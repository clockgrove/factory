import type { GitCommitObject } from "./lease.js";
import type { CompiledGraphRecord } from "./graphs.js";
import {
  isModelInvocationMarker,
  modelInvocationKey,
  unresolvedModelInvocations,
  type ModelInvocationIdentity,
} from "./budget.js";
import { deduplicateFactoryEvents } from "./receipts.js";
import type { FactoryEvent } from "../protocol/events.js";
import { reportedModelUsage, type ReportedModelUsage } from "../protocol/model-usage.js";

/**
 * Authenticate the narrow restart window after a paid compiler result and its
 * actual usage were durably checkpointed but before GraphCompiled was written.
 * A custom ref or dispatch marker alone does not attest to model output.
 */
export function assertAuthenticatedCompilationCheckpoint(args: {
  graph: CompiledGraphRecord;
  graphCommit: GitCommitObject;
  events: FactoryEvent[];
  objective: number;
  runId: string;
  expectedBaseSha: string;
  expectedInvocationId: string;
  expectedPolicyDigest: string;
}): void {
  const compilation = args.graph.compilation;
  if (
    !compilation ||
    compilation.invocationId !== args.expectedInvocationId ||
    compilation.graphDigest !== args.graph.graphDigest ||
    args.graphCommit.oid !== args.graph.commitOid ||
    args.graphCommit.parentOids.length !== 1 ||
    args.graphCommit.parentOids[0] !== args.expectedBaseSha
  )
    throw new Error("pre-receipt compiled graph lacks its exact compilation checkpoint");

  const events = deduplicateFactoryEvents(
    args.events.filter((event) => event.objective === args.objective && event.runId === args.runId),
  );
  // Validate all marker/closure relationships in the scoped run before
  // selecting this call, so a conflicting duplicate cannot be ignored.
  unresolvedModelInvocations(events);
  const identity: ModelInvocationIdentity = {
    objective: args.objective,
    runId: args.runId,
    phase: "management",
    modelInvocationId: args.expectedInvocationId,
  };
  const key = modelInvocationKey(identity);
  const markers = events.filter(
    (event) => isModelInvocationMarker(event) && modelInvocationKey(event) === key,
  );
  const closures = events.filter(
    (event) =>
      event.kind === "budget" &&
      event.event === "BudgetReconciled" &&
      event.unit === "model_tokens" &&
      event.modelInvocationId !== undefined &&
      modelInvocationKey({ ...event, modelInvocationId: event.modelInvocationId }) === key,
  );
  const marker = markers[0];
  const expectedReportedUsage = reportedModelUsage(compilation);
  const expectedAmount = compilation.inputTokens + compilation.outputTokens;
  const sameReportedUsage = (closure: (typeof closures)[number]) => {
    const usage = closure.reportedModelUsage as ReportedModelUsage | undefined;
    return (
      usage?.inputTokens === expectedReportedUsage?.inputTokens &&
      usage?.outputTokens === expectedReportedUsage?.outputTokens &&
      usage?.cachedInputTokens === expectedReportedUsage?.cachedInputTokens
    );
  };
  if (
    markers.length !== 1 ||
    !marker ||
    !Number.isSafeInteger(expectedAmount) ||
    marker.workItem !== undefined ||
    marker.attempt !== undefined ||
    marker.amount !== 0 ||
    marker.usageId !== `invocation-${args.expectedInvocationId}` ||
    marker.policyDigest !== args.expectedPolicyDigest ||
    closures.length !== 1 ||
    closures.some(
      (closure) =>
        closure.workItem !== undefined ||
        closure.attempt !== undefined ||
        closure.policyDigest !== marker.policyDigest ||
        closure.directorEpoch !== marker.directorEpoch ||
        closure.sequence <= marker.sequence ||
        closure.usageId !== `compile-${args.graph.graphDigest}` ||
        closure.amount !== expectedAmount ||
        !sameReportedUsage(closure),
    )
  )
    throw new Error("pre-receipt compiled graph lacks its authenticated actual-usage checkpoint");
}
