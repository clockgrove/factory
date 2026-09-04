import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents, latestSupportedRun } from "./receipts.js";

export interface RecoverySnapshot {
  number: number;
  closed?: boolean;
  factoryEvents?: FactoryEvent[];
  workItems: Array<{
    number: number;
    closed?: boolean;
    factoryEvents?: FactoryEvent[];
    linkedPullRequests?: unknown[];
    copilotAssignments?: unknown[];
  }>;
}

export const TERMINAL_RECOVERY_REQUIRED =
  "Existing Objective execution requires explicit evidence-preserving successor-run recovery, " +
  "which is not implemented. A new activation cannot adopt its attempts or pull requests; " +
  "do not restart with a fresh budget or delete the existing work.";

function needsSuccessorInspection(snapshot: RecoverySnapshot): boolean {
  // A missing/deleted start causes authenticated readers to omit its subsequent
  // comments. Surviving refs and PRs must still prevent an apparent fresh start.
  return !snapshot.closed && !latestSupportedRun(snapshot.factoryEvents ?? []);
}

/** Cheap rejection at command entry. The Supervisor additionally checks reservation refs. */
export function implicitRestartBlocker(snapshot: RecoverySnapshot): string | null {
  if (!needsSuccessorInspection(snapshot)) return null;
  const events = deduplicateFactoryEvents([
    ...(snapshot.factoryEvents ?? []),
    ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ]);
  const execution = events.some(
    (event) =>
      event.kind === "attempt" ||
      event.kind === "capacity" ||
      event.kind === "validation" ||
      event.kind === "publication" ||
      (event.kind === "budget" && (event.phase !== "management" || event.workItem !== undefined)),
  );
  const delivered = snapshot.workItems.some(
    (item) =>
      item.closed ||
      (item.linkedPullRequests?.length ?? 0) > 0 ||
      (item.copilotAssignments?.length ?? 0) > 0,
  );
  return execution || delivered ? TERMINAL_RECOVERY_REQUIRED : null;
}

/**
 * Fail closed before a new lease/run/budget exists. A reservation ref can survive a lost
 * comment response, including for a child removed from the current projection. One bounded
 * Objective-prefix read catches that case without an N+1 per-Work-Item scan.
 * Graph-only retries remain supported; this does not authorize or perform adoption.
 */
export async function inspectImplicitRestart(
  snapshot: RecoverySnapshot,
  listRefs: (prefix: string) => Promise<readonly unknown[]>,
): Promise<string | null> {
  const blocker = implicitRestartBlocker(snapshot);
  if (blocker || !needsSuccessorInspection(snapshot)) return blocker;
  if (!Number.isSafeInteger(snapshot.number) || snapshot.number <= 0) {
    throw new Error("invalid Objective number for recovery inspection");
  }
  const refs = await listRefs(`refs/clockgrove-factory/attempts/objective-${snapshot.number}/`);
  return refs.length > 0 ? TERMINAL_RECOVERY_REQUIRED : null;
}
