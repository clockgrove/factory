import type { GitCommitObject, LeaseStore } from "./lease.js";
import { attemptRef, attemptRefPrefix } from "./attempts.js";
import { parseFactoryEvent } from "../protocol/events.js";

export type AdmissionCompatibilityStore = Pick<
  LeaseStore,
  "readRef" | "readCommit" | "createCommit" | "createRef" | "compareAndSwapRef" | "serverTime"
> & { listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>> };

const MARKER = "Factory-Admission-Compatibility: ";
const BARRIER = "Factory-Admission-Barrier: ";
interface Marker {
  protocol: "clockgrove.factory/admission-compatibility-v1";
  workItem: number;
  workItemNodeId: string;
  legacy?: { objective: number; claimOid: string };
}
function trailer(commit: GitCommitObject, prefix: string): unknown {
  const line = commit.message
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(prefix));
  return line
    ? JSON.parse(Buffer.from(line.slice(prefix.length), "base64url").toString("utf8"))
    : undefined;
}
function encoded(prefix: string, value: unknown): string {
  return prefix + Buffer.from(JSON.stringify(value)).toString("base64url");
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function marker(commit: GitCommitObject): Marker | undefined {
  const value = trailer(commit, MARKER) as Marker | undefined;
  if (!value) return undefined;
  if (
    value.protocol !== "clockgrove.factory/admission-compatibility-v1" ||
    !positive(value.workItem) ||
    !value.workItemNodeId ||
    (value.legacy &&
      (!positive(value.legacy.objective) || !/^[a-f0-9]{40}$/.test(value.legacy.claimOid)))
  )
    throw new Error("invalid admission compatibility marker");
  return value;
}

/** Only exact, supported barriers are excluded from historical attempt readers. */
export function isAdmissionBarrier(ref: string, commit: GitCommitObject): boolean {
  const value = trailer(commit, BARRIER) as
    | { protocol?: string; objective?: number; workItem?: number; attempt?: number }
    | undefined;
  if (!value) return false;
  if (
    value.protocol !== "clockgrove.factory/admission-barrier-v1" ||
    !positive(value.objective) ||
    !positive(value.workItem) ||
    !positive(value.attempt) ||
    ref !== attemptRef(value.objective, value.workItem, value.attempt)
  ) {
    throw new Error("invalid admission compatibility barrier binding");
  }
  return true;
}

/**
 * Permanently close both entry points used by historical binaries before a new
 * arbiter can admit. The old claim parser rejects this marker; old attempt list
 * parsing rejects the barrier. A producer already past list can only create an
 * occupied slot. Historical reservations remain liabilities, including any
 * producer whose backend dispatch is delayed until after this function returns.
 */
export async function ensureAdmissionCompatibility(
  store: AdmissionCompatibilityStore,
  args: {
    workItem: number;
    workItemNodeId: string;
    objective: number;
    base: GitCommitObject;
    assertCurrent: () => Promise<void>;
  },
): Promise<{
  claimOid: string;
  legacy: Array<{ ref: string; oid: string }>;
  barrierRef?: string;
  legacyObjective?: number;
}> {
  if (!positive(args.workItem) || !positive(args.objective) || !args.workItemNodeId)
    throw new Error("invalid admission compatibility issue identity");
  const ref = `refs/clockgrove-factory/repository/work-items/work-item-${args.workItem}`;
  let currentMarker: Marker | undefined;
  let claimOid: string | undefined;
  for (let retry = 0; retry < 32; retry++) {
    await args.assertCurrent();
    const before = await store.readRef(ref);
    const commit = before ? await store.readCommit(before) : undefined;
    currentMarker = commit ? marker(commit) : undefined;
    if (currentMarker) {
      if (
        currentMarker.workItem !== args.workItem ||
        currentMarker.workItemNodeId !== args.workItemNodeId
      )
        throw new Error("admission compatibility issue identity mismatch");
      if (currentMarker.legacy) {
        if (
          commit!.parentOids.length !== 1 ||
          commit!.parentOids[0] !== currentMarker.legacy.claimOid
        )
          throw new Error("compatibility marker lost original claim parent");
        const original = trailer(
          await store.readCommit(currentMarker.legacy.claimOid),
          "Factory-Repository-Claim: ",
        ) as { objective?: number; workItem?: number } | undefined;
        if (
          !original ||
          original.objective !== currentMarker.legacy.objective ||
          original.workItem !== args.workItem
        )
          throw new Error("compatibility marker contradicts original claim");
      }
      claimOid = before!;
      break;
    }
    let legacy: Marker["legacy"];
    if (commit) {
      const old = trailer(commit, "Factory-Repository-Claim: ") as
        | {
            objective?: number;
            workItem?: number;
            runId?: string;
            directorEpoch?: number;
          }
        | undefined;
      if (
        !old ||
        !positive(old.objective) ||
        old.workItem !== args.workItem ||
        !positive(old.directorEpoch) ||
        typeof old.runId !== "string" ||
        !old.runId
      )
        throw new Error(
          "legacy Work Item claim is invalid; reconcile original evidence before admission",
        );
      if (old.objective !== args.objective)
        throw new Error(
          `Work Item #${args.workItem} is already claimed by Objective #${old.objective}`,
        );
      legacy = { objective: old.objective, claimOid: before! };
    }
    currentMarker = {
      protocol: "clockgrove.factory/admission-compatibility-v1",
      workItem: args.workItem,
      workItemNodeId: args.workItemNodeId,
      ...(legacy ? { legacy } : {}),
    };
    const oid = await store.createCommit({
      treeOid: args.base.treeOid,
      parentOids: [before ?? args.base.oid],
      message: `Factory issue admission compatibility boundary\n\n${encoded(MARKER, currentMarker)}`,
    });
    await args.assertCurrent();
    const won = before
      ? await store.compareAndSwapRef({ ref, beforeOid: before, afterOid: oid })
      : await store.createRef(ref, oid);
    if (won) {
      claimOid = oid;
      break;
    }
  }
  if (!claimOid || !currentMarker)
    throw new Error("admission compatibility claim contention; retry");
  if (!currentMarker.legacy) return { claimOid, legacy: [] };
  const objective = currentMarker.legacy.objective;
  const prefix = attemptRefPrefix(objective, args.workItem);
  for (let retry = 0; retry < 32; retry++) {
    await args.assertCurrent();
    const refs = await store.listRefs(prefix);
    const legacy: Array<{ ref: string; oid: string; attempt: number }> = [];
    let barrierRef: string | undefined;
    let barrierAttempt: number | undefined;
    for (const entry of refs) {
      const commit = await store.readCommit(entry.oid);
      if (isAdmissionBarrier(entry.ref, commit)) {
        if (commit.parentOids.length !== 1 || commit.parentOids[0] !== claimOid)
          throw new Error("admission compatibility barrier lost its claim binding");
        if (barrierRef) throw new Error("multiple admission compatibility barriers");
        barrierRef = entry.ref;
        barrierAttempt = Number(entry.ref.slice(entry.ref.lastIndexOf("-") + 1));
        continue;
      }
      const event = parseFactoryEvent(trailer(commit, "Factory-Event: "));
      if (
        event.kind !== "attempt" ||
        event.event !== "AttemptReserved" ||
        event.objective !== objective ||
        event.workItem !== args.workItem ||
        entry.ref !== attemptRef(objective, args.workItem, event.attempt)
      )
        throw new Error(
          "legacy attempt ownership is inconsistent; reconcile original evidence before admission",
        );
      legacy.push({ ...entry, attempt: event.attempt });
    }
    legacy.sort((a, b) => a.attempt - b.attempt);
    if (
      legacy.some((entry, index) => entry.attempt !== index + 1) ||
      (barrierAttempt !== undefined && barrierAttempt !== legacy.length + 1)
    )
      throw new Error("legacy attempt history is not contiguous; admission remains blocked");
    if (barrierRef)
      return {
        claimOid,
        legacy: legacy.map(({ ref, oid }) => ({ ref, oid })),
        barrierRef,
        legacyObjective: objective,
      };
    const next = legacy.length + 1;
    const barrier = attemptRef(objective, args.workItem, next);
    const oid = await store.createCommit({
      treeOid: args.base.treeOid,
      parentOids: [claimOid],
      message: `Factory permanently sealed historical attempt namespace\n\n${encoded(BARRIER, {
        protocol: "clockgrove.factory/admission-barrier-v1",
        objective,
        workItem: args.workItem,
        attempt: next,
      })}`,
    });
    await args.assertCurrent();
    // Always rescan after create, including a lost race: a prior legacy producer
    // may have won this slot and can still dispatch using its original identity.
    await store.createRef(barrier, oid);
  }
  throw new Error(
    "legacy attempt sealing contention; admission remains blocked, retry reconciliation",
  );
}
