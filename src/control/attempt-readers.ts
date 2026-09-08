import { attemptRef, attemptRefPrefix, type AttemptStore } from "./attempts.js";
import { isAdmissionBarrier } from "./admission-compatibility.js";
import { issueAdmissionRef, parseIssueAdmissionCommit } from "./issue-admission.js";
import { decodeEventTrailer } from "./receipts.js";
import type { GitCommitObject } from "./lease.js";

type ReadStore = Pick<AttemptStore, "listRefs" | "readCommit">;
type Observation = { ref: string; oid: string };
const LEDGER_PREFIX = "refs/clockgrove-factory/admission/work-item-";
const MAX_OBSERVATIONS = 4096;
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid reservation scope");
}
function reservation(observation: Observation, commit: GitCommitObject) {
  const event = decodeEventTrailer(commit.message);
  if (
    commit.oid !== observation.oid ||
    event?.kind !== "attempt" ||
    event.event !== "AttemptReserved" ||
    observation.ref !== attemptRef(event.objective, event.workItem, event.attempt) ||
    commit.parentOids.length !== 1 ||
    commit.parentOids[0] !== event.baseSha
  )
    throw new Error("invalid reservation identity or immutable metadata");
  return event;
}

/** Resolve historical logical attempt identities across the permanent legacy bridge
 * and issue ledger. Ledger revision commits are never returned as reservations. */
export async function listAttemptReservationRefs(
  store: ReadStore,
  objective: number,
  workItem?: number,
): Promise<Observation[]> {
  positive(objective);
  if (workItem !== undefined) positive(workItem);
  const legacyPrefix =
    workItem === undefined
      ? `refs/clockgrove-factory/attempts/objective-${objective}/`
      : attemptRefPrefix(objective, workItem);
  const observations = await store.listRefs(legacyPrefix);
  const ledgers = await store.listRefs(
    workItem === undefined ? LEDGER_PREFIX : issueAdmissionRef(workItem),
  );
  if (observations.length > MAX_OBSERVATIONS || ledgers.length > MAX_OBSERVATIONS)
    throw new Error("reservation observation bound exceeded");
  const merged = new Map<string, string>();
  const add = ({ ref, oid }: Observation) => {
    const prior = merged.get(ref);
    if (prior !== undefined && prior !== oid) throw new Error("conflicting reservation evidence");
    merged.set(ref, oid);
    if (merged.size > MAX_OBSERVATIONS) throw new Error("reservation observation bound exceeded");
  };
  for (const observation of observations) {
    if (!observation.ref.startsWith(legacyPrefix))
      throw new Error("foreign legacy reservation scope");
    const commit = await store.readCommit(observation.oid);
    if (commit.oid !== observation.oid) throw new Error("reservation commit identity changed");
    if (isAdmissionBarrier(observation.ref, commit)) continue;
    const event = reservation(observation, commit);
    if (event.objective !== objective || (workItem !== undefined && event.workItem !== workItem))
      throw new Error("foreign legacy reservation scope");
    add(observation);
  }
  const seenLedgers = new Set<string>();
  for (const observation of ledgers) {
    // Git prefix enumeration for issue 12 also returns issue 120.
    if (workItem !== undefined && observation.ref !== issueAdmissionRef(workItem)) continue;
    const match = /^refs\/clockgrove-factory\/admission\/work-item-([1-9][0-9]*)$/.exec(
      observation.ref,
    );
    if (!match || seenLedgers.has(observation.ref))
      throw new Error("invalid issue ledger observation");
    seenLedgers.add(observation.ref);
    const commit = await store.readCommit(observation.oid);
    if (commit.oid !== observation.oid) throw new Error("issue ledger commit identity changed");
    const ledger = parseIssueAdmissionCommit(commit, Number(match[1]));
    for (const entry of ledger.history) {
      if (entry.objective !== objective) continue;
      const metadata = await store.readCommit(entry.reservation.oid);
      const event = reservation(entry.reservation, metadata);
      if (
        event.objective !== entry.objective ||
        event.workItem !== entry.workItem ||
        event.attempt !== entry.reservation.attempt ||
        event.backend !== entry.reservation.backend ||
        event.baseSha !== entry.reservation.baseSha ||
        event.runId !== entry.runId ||
        event.directorEpoch !== entry.directorEpoch ||
        event.policyDigest !== entry.policyDigest
      )
        throw new Error("issue ledger reservation identity mismatch");
      add(entry.reservation);
    }
  }
  return [...merged].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => a.ref.localeCompare(b.ref));
}

export async function readAttemptReservationRef(
  store: ReadStore,
  objective: number,
  workItem: number,
  attempt: number,
): Promise<string | null> {
  positive(attempt);
  const ref = attemptRef(objective, workItem, attempt);
  const observations = await listAttemptReservationRefs(store, objective, workItem);
  return observations.find((entry) => entry.ref === ref)?.oid ?? null;
}
