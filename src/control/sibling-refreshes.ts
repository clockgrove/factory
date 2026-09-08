import { createHash } from "node:crypto";
import { z } from "zod";
import { parseFactoryEvent } from "../protocol/events.js";
import { assertNoSecretMaterial, gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import { publicationBranch } from "../publication/publisher.js";
import { verifyExactHeadValidation, type ExactHeadValidationEvidence } from "../validation/plan.js";
import { attemptRef, readAttemptReservationRef, type AttemptStore } from "./attempts.js";
import type { CompiledGraphReadStore, CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";

export const MAX_SIBLING_REFRESH_CHECKPOINT_BYTES = 64 * 1024;
export const MAX_SIBLING_REFRESH_LINEAGE = 100;
const PATH = ".clockgrove-factory/control/sibling-refresh.json";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdentitySchema = z
  .object({
    repository: z
      .string()
      .max(201)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    runId: safeId,
    sourceRunId: safeId,
    controllingPolicyDigest: sha256Digest,
    objective: positive,
    workItem: positive,
    attempt: positive,
    pullRequest: positive,
    pullRequestNodeId: safeId,
    branch: z.string().min(1).max(500),
    reservationRef: z.string().min(1).max(500),
    reservationOid: gitSha,
    /** Original reservation epoch; takeover does not rewrite source identity. */
    leaseEpoch: positive,
    policyDigest: sha256Digest,
    sourcePublicationDigest: sha256Digest,
    sourceHeadSha: gitSha,
    sourceExactHeadValidationDigest: sha256Digest,
    targetBaseSha: gitSha,
  })
  .strict();
const SourceSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/exact-head-validation-v1"),
    validationDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    publishedHeadSha: gitSha,
    digest: sha256Digest,
  })
  .strict();
const PreviousSchema = z
  .object({
    ref: z.string().min(1).max(500),
    commitOid: gitSha,
    identityDigest: sha256Digest,
  })
  .strict();
const CheckpointSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/sibling-refresh-v1"),
    identity: IdentitySchema,
    identityDigest: sha256Digest,
    source: SourceSchema,
    expectedOldHeadSha: gitSha,
    outputTreeSha: gitSha,
    plannedHeadSha: gitSha,
    previous: PreviousSchema.optional(),
  })
  .strict();

export type SiblingRefreshIdentity = z.infer<typeof IdentitySchema>;
export type SiblingRefreshPrevious = z.infer<typeof PreviousSchema>;
type Checkpoint = z.infer<typeof CheckpointSchema>;
export interface SiblingRefreshRecord extends Omit<Checkpoint, "protocol"> {
  ref: string;
  commitOid: string;
  blobOid: string;
}

function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Invalid sibling-refresh checkpoint: ${reason}`);
}
function parseIdentity(input: SiblingRefreshIdentity): SiblingRefreshIdentity {
  const identity = IdentitySchema.parse(input);
  requireProof(
    identity.runId !== identity.sourceRunId ||
      identity.controllingPolicyDigest === identity.policyDigest,
    "same-run policy changed",
  );
  requireProof(
    identity.branch === publicationBranch(identity.objective, identity.workItem, identity.attempt),
    "non-Factory branch",
  );
  requireProof(
    identity.reservationRef === attemptRef(identity.objective, identity.workItem, identity.attempt),
    "reservation ref scope mismatch",
  );
  return identity;
}
export function siblingRefreshIdentityDigest(input: SiblingRefreshIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(parseIdentity(input)))
    .digest("hex");
}
export function siblingRefreshRef(input: SiblingRefreshIdentity): string {
  const identity = parseIdentity(input);
  return `refs/clockgrove-factory/sibling-refreshes/objective-${identity.objective}/work-item-${identity.workItem}/attempt-${identity.attempt}/refresh-${siblingRefreshIdentityDigest(identity)}`;
}
function parseCheckpoint(input: unknown): Checkpoint {
  requireProof(
    Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_SIBLING_REFRESH_CHECKPOINT_BYTES,
    "document exceeds byte bound",
  );
  const value = CheckpointSchema.parse(input);
  const identity = parseIdentity(value.identity);
  requireProof(
    value.identityDigest === siblingRefreshIdentityDigest(identity),
    "identity digest mismatch",
  );
  verifyExactHeadValidation(value.source, identity.sourceHeadSha);
  requireProof(
    value.source.digest === identity.sourceExactHeadValidationDigest,
    "source validation mismatch",
  );
  requireProof(
    identity.targetBaseSha !== value.source.baseSha &&
      value.expectedOldHeadSha !== identity.targetBaseSha &&
      value.plannedHeadSha !== value.expectedOldHeadSha &&
      value.plannedHeadSha !== identity.targetBaseSha,
    "refresh must advance distinct parents",
  );
  requireProof(
    value.previous || value.expectedOldHeadSha === identity.sourceHeadSha,
    "unbound previous head",
  );
  assertNoSecretMaterial(value, "sibling-refresh checkpoint");
  return value;
}
function document(record: SiblingRefreshRecord): Checkpoint {
  return parseCheckpoint({
    protocol: "clockgrove.factory/sibling-refresh-v1",
    identity: record.identity,
    identityDigest: record.identityDigest,
    source: record.source,
    expectedOldHeadSha: record.expectedOldHeadSha,
    outputTreeSha: record.outputTreeSha,
    plannedHeadSha: record.plannedHeadSha,
    ...(record.previous ? { previous: record.previous } : {}),
  });
}
function sourceIdentity(identity: SiblingRefreshIdentity): string {
  const { targetBaseSha: _, runId: _run, controllingPolicyDigest: _policy, ...source } = identity;
  return JSON.stringify(source);
}
async function readRecord(
  store: CompiledGraphReadStore,
  ref: string,
): Promise<SiblingRefreshRecord | null> {
  requireProof(
    /^refs\/clockgrove-factory\/sibling-refreshes\/objective-[1-9][0-9]*\/work-item-[1-9][0-9]*\/attempt-[1-9][0-9]*\/refresh-[a-f0-9]{64}$/.test(
      ref,
    ),
    "invalid checkpoint ref",
  );
  const oid = await store.readRef(ref);
  if (!oid) return null;
  gitSha.parse(oid);
  const commit = await store.readCommit(oid);
  requireProof(commit.oid === oid, "checkpoint commit mismatch");
  const blobOid = await store.readTreeEntry(commit.treeOid, PATH);
  requireProof(blobOid, "missing checkpoint document");
  gitSha.parse(blobOid);
  const bytes = await store.readBlob(blobOid);
  requireProof(
    bytes.byteLength <= MAX_SIBLING_REFRESH_CHECKPOINT_BYTES,
    "document exceeds byte bound",
  );
  const value = parseCheckpoint(JSON.parse(bytes.toString("utf8")));
  requireProof(siblingRefreshRef(value.identity) === ref, "reference identity mismatch");
  requireProof(
    commit.parentOids.length === 1 && commit.parentOids[0] === value.identity.targetBaseSha,
    "checkpoint target parent mismatch",
  );
  requireProof(bytes.toString("utf8") === JSON.stringify(value), "noncanonical document");
  return { ref, commitOid: oid, blobOid, ...value };
}
async function verifySource(
  store: CompiledGraphReadStore & Pick<AttemptStore, "listRefs">,
  record: Pick<SiblingRefreshRecord, "identity" | "source">,
): Promise<void> {
  const { identity, source } = record;
  requireProof(
    (await readAttemptReservationRef(
      store,
      identity.objective,
      identity.workItem,
      identity.attempt,
    )) === identity.reservationOid,
    "source reservation ref changed",
  );
  const reservation = await store.readCommit(identity.reservationOid);
  requireProof(reservation.oid === identity.reservationOid, "source reservation commit mismatch");
  const trailers = reservation.message
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Factory-Event: "));
  requireProof(
    trailers.length === 1 &&
      Buffer.byteLength(trailers[0]!, "utf8") <= MAX_SIBLING_REFRESH_CHECKPOINT_BYTES * 2,
    "reservation trailer missing or unbounded",
  );
  const event = parseFactoryEvent(
    JSON.parse(
      Buffer.from(trailers[0]!.slice("Factory-Event: ".length), "base64url").toString("utf8"),
    ),
  );
  requireProof(
    event.kind === "attempt" && event.event === "AttemptReserved",
    "not a source reservation",
  );
  requireProof(
    event.runId === identity.sourceRunId &&
      event.objective === identity.objective &&
      event.workItem === identity.workItem &&
      event.attempt === identity.attempt &&
      event.directorEpoch === identity.leaseEpoch &&
      event.policyDigest === identity.policyDigest &&
      event.baseSha === source.baseSha,
    "source reservation identity mismatch",
  );
  const base = await store.readCommit(source.baseSha);
  requireProof(
    base.oid === source.baseSha &&
      reservation.treeOid === base.treeOid &&
      reservation.parentOids.length === 1 &&
      reservation.parentOids[0] === source.baseSha,
    "source reservation base mismatch",
  );
  const head = await store.readCommit(identity.sourceHeadSha);
  requireProof(
    head.oid === identity.sourceHeadSha &&
      head.treeOid === source.outputTreeSha &&
      head.parentOids.length === 1 &&
      head.parentOids[0] === source.baseSha,
    "original publication commit mismatch",
  );
}
async function verifyCommit(
  store: CompiledGraphReadStore,
  record: Pick<
    SiblingRefreshRecord,
    "plannedHeadSha" | "outputTreeSha" | "expectedOldHeadSha" | "identity"
  >,
): Promise<void> {
  const head = await store.readCommit(record.plannedHeadSha);
  requireProof(
    head.oid === record.plannedHeadSha &&
      head.treeOid === record.outputTreeSha &&
      head.parentOids.length === 2 &&
      head.parentOids[0] === record.expectedOldHeadSha &&
      head.parentOids[1] === record.identity.targetBaseSha,
    "planned commit parents or tree mismatch",
  );
}

/** Re-read immutable refs and all bounded links; returns oldest to newest. This
 * proves planned Git identity, NOT authenticated publication, cleanup or merge authority. */
export async function loadSiblingRefreshLineage(
  store: CompiledGraphReadStore & Pick<AttemptStore, "listRefs">,
  record: SiblingRefreshRecord,
): Promise<SiblingRefreshRecord[]> {
  const current = await readRecord(store, record.ref);
  requireProof(
    current &&
      current.commitOid === record.commitOid &&
      current.blobOid === record.blobOid &&
      JSON.stringify(document(current)) === JSON.stringify(document(record)),
    "checkpoint ownership mismatch",
  );
  await verifySource(store, current);
  const lineage: SiblingRefreshRecord[] = [];
  const seen = new Set<string>();
  let child = current;
  for (;;) {
    requireProof(
      lineage.length < MAX_SIBLING_REFRESH_LINEAGE && !seen.has(child.identityDigest),
      "lineage exceeds bound or cycles",
    );
    seen.add(child.identityDigest);
    await verifyCommit(store, child);
    lineage.push(child);
    if (!child.previous) break;
    const previous = await readRecord(store, child.previous.ref);
    requireProof(
      previous &&
        previous.commitOid === child.previous.commitOid &&
        previous.identityDigest === child.previous.identityDigest,
      "previous checkpoint ownership mismatch",
    );
    requireProof(
      sourceIdentity(previous.identity) === sourceIdentity(current.identity) &&
        JSON.stringify(previous.source) === JSON.stringify(current.source),
      "foreign source lineage",
    );
    requireProof(
      child.expectedOldHeadSha === previous.plannedHeadSha &&
        child.identity.targetBaseSha !== previous.identity.targetBaseSha,
      "previous head or target mismatch",
    );
    child = previous;
  }
  return lineage.reverse();
}
export async function verifyPlannedSiblingRefreshCommit(
  store: CompiledGraphReadStore & Pick<AttemptStore, "listRefs">,
  record: SiblingRefreshRecord,
): Promise<void> {
  await loadSiblingRefreshLineage(store, record);
}
export async function loadSiblingRefresh(
  store: CompiledGraphReadStore & Pick<AttemptStore, "listRefs">,
  input: SiblingRefreshIdentity,
): Promise<SiblingRefreshRecord | null> {
  const identity = parseIdentity(input);
  const record = await readRecord(store, siblingRefreshRef(identity));
  if (!record) return null;
  requireProof(
    record.identityDigest === siblingRefreshIdentityDigest(identity),
    "requested identity mismatch",
  );
  await loadSiblingRefreshLineage(store, record);
  return record;
}

/** Immutable write-ahead intent only. Caller authenticates original publication,
 * proves the permitted trunk advance and fences subsequent non-force branch CAS. */
export class SiblingRefreshStore {
  constructor(
    private readonly store: CompiledGraphStore & Pick<AttemptStore, "listRefs">,
    private readonly leases: LeaseManager,
  ) {}
  load(identity: SiblingRefreshIdentity): Promise<SiblingRefreshRecord | null> {
    return loadSiblingRefresh(this.store, identity);
  }
  async persist(args: {
    lease: LeaseState;
    identity: SiblingRefreshIdentity;
    source: ExactHeadValidationEvidence;
    expectedOldHeadSha: string;
    outputTreeSha: string;
    previous?: SiblingRefreshPrevious;
  }): Promise<SiblingRefreshRecord> {
    const identity = parseIdentity(args.identity);
    requireProof(
      args.lease.objective === identity.objective &&
        args.lease.runId === identity.runId &&
        args.lease.policyDigest === identity.controllingPolicyDigest &&
        (identity.runId !== identity.sourceRunId || args.lease.epoch >= identity.leaseEpoch),
      "lease scope mismatch",
    );
    await this.leases.assertMutationAuthorized(args.lease);
    const source = SourceSchema.parse(args.source);
    verifyExactHeadValidation(source, identity.sourceHeadSha);
    requireProof(
      source.digest === identity.sourceExactHeadValidationDigest,
      "source validation mismatch",
    );
    const expectedOldHeadSha = gitSha.parse(args.expectedOldHeadSha);
    const outputTreeSha = gitSha.parse(args.outputTreeSha);
    const previous = args.previous ? PreviousSchema.parse(args.previous) : undefined;
    const same = (record: SiblingRefreshRecord | null): SiblingRefreshRecord => {
      requireProof(
        record &&
          JSON.stringify(record.source) === JSON.stringify(source) &&
          record.expectedOldHeadSha === expectedOldHeadSha &&
          record.outputTreeSha === outputTreeSha &&
          JSON.stringify(record.previous) === JSON.stringify(previous),
        "conflicting immutable refresh",
      );
      return record;
    };
    // No new Git objects if a complete intent already exists, including takeover.
    const existing = await this.load(identity);
    if (existing) return same(existing);
    if (previous) {
      const prior = await readRecord(this.store, previous.ref);
      requireProof(
        prior &&
          prior.commitOid === previous.commitOid &&
          prior.identityDigest === previous.identityDigest,
        "previous checkpoint ownership mismatch",
      );
      const lineage = await loadSiblingRefreshLineage(this.store, prior);
      requireProof(lineage.length < MAX_SIBLING_REFRESH_LINEAGE, "lineage exceeds bound");
      requireProof(
        sourceIdentity(prior.identity) === sourceIdentity(identity) &&
          JSON.stringify(prior.source) === JSON.stringify(source) &&
          prior.plannedHeadSha === expectedOldHeadSha &&
          prior.identity.targetBaseSha !== identity.targetBaseSha,
        "foreign source lineage or previous head",
      );
    } else requireProof(expectedOldHeadSha === identity.sourceHeadSha, "unbound previous head");
    requireProof(
      expectedOldHeadSha !== identity.targetBaseSha && identity.targetBaseSha !== source.baseSha,
      "refresh requires an advanced base and distinct parents",
    );
    // The provisional record is used only to verify the immutable original source.
    await verifySource(this.store, { identity, source });
    const target = await this.store.readCommit(identity.targetBaseSha);
    requireProof(target.oid === identity.targetBaseSha, "target base unavailable");
    assertNoSecretMaterial({ identity, source, previous }, "sibling-refresh intent");
    const identityDigest = siblingRefreshIdentityDigest(identity);
    await this.leases.assertMutationAuthorized(args.lease);
    const plannedHeadSha = await this.store.createCommit({
      treeOid: outputTreeSha,
      parentOids: [expectedOldHeadSha, identity.targetBaseSha],
      message: `Factory sibling refresh for Work Item #${identity.workItem}\n\nFactory-Sibling-Refresh: ${identityDigest}`,
    });
    const value = parseCheckpoint({
      protocol: "clockgrove.factory/sibling-refresh-v1",
      identity,
      identityDigest,
      source,
      expectedOldHeadSha,
      outputTreeSha,
      plannedHeadSha,
      ...(previous ? { previous } : {}),
    });
    await verifyCommit(this.store, value);
    await this.leases.assertMutationAuthorized(args.lease);
    const blobOid = await this.store.createBlob(Buffer.from(JSON.stringify(value), "utf8"));
    await this.leases.assertMutationAuthorized(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    await this.leases.assertMutationAuthorized(args.lease);
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.targetBaseSha],
      message: `Factory sibling refresh intent\n\nFactory-Sibling-Refresh: ${identityDigest}`,
    });
    await this.leases.assertMutationAuthorized(args.lease);
    try {
      await this.store.createRef(siblingRefreshRef(identity), commitOid);
    } catch (error) {
      const observed = await this.load(identity);
      if (observed) return same(observed);
      throw error;
    }
    return same(await this.load(identity));
  }
}
