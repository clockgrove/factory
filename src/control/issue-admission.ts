import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ArtifactConsumerBindingSchema } from "../protocol/events.js";
import { ManagedRuntimeActivationSchema } from "../protocol/worker-packet.js";
import { gitSha } from "../protocol/limits.js";
import type { GitCommitObject, LeaseStore } from "./lease.js";

const text = z.string().min(1).max(1024);
const positive = z.number().int().positive();
const reservationSchema = z
  .object({ ref: text, oid: gitSha, attempt: positive, backend: text, baseSha: gitSha })
  .strict();
const identitySchema = z
  .object({
    workItem: positive,
    workItemNodeId: text,
    objective: positive,
    runId: text,
    directorEpoch: positive,
    writerHolder: text,
    policyDigest: text,
    graphDigest: text,
    graphCommitOid: gitSha,
    projectionCommitOid: gitSha,
    reservation: reservationSchema,
    capacityReservationId: text,
    budgetReservationId: text,
    resourceIdentity: text,
    compatibilityClaimOid: gitSha,
    artifactConsumer: ArtifactConsumerBindingSchema.optional(),
    managedRuntimeActivation: ManagedRuntimeActivationSchema.optional(),
  })
  .strict();
const evidenceSchema = z
  .object({
    reservationOid: gitSha,
    resourceIdentity: text,
    capacityReservationId: text,
    budgetReservationId: text,
    producerStopped: z.literal(true),
    resourcesReleased: z.literal(true),
    capacityReleased: z.literal(true),
    accountingSettled: z.boolean(),
    unknownModelUsageRetained: z.literal(true).optional(),
    evidenceOid: gitSha,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.accountingSettled === Boolean(evidence.unknownModelUsageRetained))
      context.addIssue({
        code: "custom",
        message: "settlement must either prove accounting or explicitly retain unknown model usage",
      });
  });
const successorSchema = z
  .object({
    objective: positive,
    runId: text,
    directorEpoch: positive,
    writerHolder: text,
    policyDigest: text,
    graphDigest: text,
    graphCommitOid: gitSha,
    projectionCommitOid: gitSha,
    authorityReceiptOid: gitSha,
  })
  .strict();
export type IssueAdmissionSuccessorAuthority = z.infer<typeof successorSchema>;
const entrySchema = identitySchema
  .extend({
    disposition: z.enum(["prepared", "dispatching", "terminal", "reconciled", "released"]),
    writerEpoch: positive,
    currentWriterHolder: text,
    dispatchPossible: z.boolean(),
    evidence: evidenceSchema.optional(),
    imported: z.boolean().optional(),
    reassignmentReceiptOid: gitSha.optional(),
    settledBySuccessor: successorSchema.optional(),
  })
  .strict();
const recordSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/issue-admission-v1"),
    workItem: positive,
    workItemNodeId: text,
    revision: positive,
    operationId: z.string().uuid().optional(),
    priorRevisionOid: gitSha.nullable(),
    history: z.array(entrySchema).min(1).max(4096),
  })
  .strict();
export type IssueAdmissionIdentity = z.infer<typeof identitySchema>;
export type IssueAdmissionEvidence = z.infer<typeof evidenceSchema>;
export type IssueAdmissionEntry = z.infer<typeof entrySchema>;
export type IssueAdmissionRecord = z.infer<typeof recordSchema> & { oid: string; ref: string };
type Store = Pick<
  LeaseStore,
  | "readRef"
  | "readCommit"
  | "createCommit"
  | "createRef"
  | "compareAndSwapRef"
  | "withMutationFence"
>;
type Fence = { assertCurrent: () => Promise<void> };
export function issueAdmissionRef(workItem: number): string {
  return `refs/clockgrove-factory/admission/work-item-${positive.parse(workItem)}`;
}
const marker = "Factory-Issue-Admission: ";
function sameOwner(a: IssueAdmissionIdentity, b: IssueAdmissionIdentity): boolean {
  return (
    a.objective === b.objective &&
    a.runId === b.runId &&
    a.policyDigest === b.policyDigest &&
    a.graphDigest === b.graphDigest &&
    a.graphCommitOid === b.graphCommitOid &&
    a.projectionCommitOid === b.projectionCommitOid
  );
}

/** Durable per-issue CAS. No expiration, election lease or missing process releases a liability.
 * Callers must hold the compatibility claim before admission: this ledger does not fence old binaries. */
export class IssueAdmissionLedger {
  constructor(readonly store: Store) {}

  async read(workItem: number): Promise<IssueAdmissionRecord | null> {
    const ref = issueAdmissionRef(workItem);
    const oid = await this.store.readRef(ref);
    if (!oid) return null;
    const commit = await this.store.readCommit(oid);
    if (commit.oid !== oid) throw Error("issue admission OID changed");
    return parseIssueAdmissionCommit(commit, workItem);
  }

  async admit(args: IssueAdmissionIdentity & Fence): Promise<IssueAdmissionRecord> {
    return this.#admit(args);
  }

  /** Explicit accepted-new-run authority, never inferred from changed issue relationships. */
  async reassign(
    args: IssueAdmissionIdentity & Fence & { authorityReceiptOid: string },
  ): Promise<IssueAdmissionRecord> {
    gitSha.parse(args.authorityReceiptOid);
    return this.#admit(args, args.authorityReceiptOid);
  }

  async #admit(
    args: IssueAdmissionIdentity & Fence,
    reassignmentReceiptOid?: string,
  ): Promise<IssueAdmissionRecord> {
    const { assertCurrent, ...raw } = args;
    const identity = identitySchema.parse(
      Object.fromEntries(
        Object.keys(identitySchema.shape).map((key) => [key, raw[key as keyof typeof raw]]),
      ),
    );
    return this.#fenced(assertCurrent, async () => {
      await assertCurrent();
      const prior = await this.read(identity.workItem);
      const last = prior?.history.at(-1);
      if (prior?.workItemNodeId !== undefined && prior.workItemNodeId !== identity.workItemNodeId)
        throw Error("issue node identity changed");
      const existing = prior?.history.find(
        (entry) => entry.reservation.oid === identity.reservation.oid,
      );
      if (existing) {
        const original = identitySchema.parse(
          Object.fromEntries(
            Object.keys(identitySchema.shape).map((key) => [
              key,
              existing[key as keyof typeof existing],
            ]),
          ),
        );
        if (
          existing.disposition === "prepared" &&
          JSON.stringify(original) === JSON.stringify(identity)
        )
          return prior!;
        throw Error("admission identity cannot be rearmed");
      }
      if (prior?.history.some((entry) => entry.disposition !== "released"))
        throw Error("issue admission occupied; exact reconciliation required");
      if (last && identity.reservation.attempt !== last.reservation.attempt + 1)
        throw Error("issue attempt must advance monotonically");
      if (!last && identity.reservation.attempt !== 1)
        throw Error("first issue attempt must be one or imported");
      if (
        last &&
        !sameOwner(last, identity) &&
        (!reassignmentReceiptOid || last.runId === identity.runId)
      )
        throw Error("issue reassignment requires explicit accepted new run authority");
      const entry: IssueAdmissionEntry = {
        ...identity,
        disposition: "prepared",
        dispatchPossible: false,
        writerEpoch: identity.directorEpoch,
        currentWriterHolder: identity.writerHolder,
        ...(reassignmentReceiptOid ? { reassignmentReceiptOid } : {}),
      };
      return this.#write(prior, [...(prior?.history ?? []), entry], assertCurrent);
    });
  }

  /** Atomically withdraw launch permission, including a delayed original writer's CAS.
   * A prepared record is positive non-dispatch evidence only after this CAS wins.
   * Imported records and any possible dispatch require ordinary resource reconciliation. */
  async closeUndispatched(
    args: Fence & {
      workItem: number;
      reservationOid: string;
      objective: number;
      runId: string;
      directorEpoch: number;
      writerHolder: string;
      policyDigest: string;
    },
  ): Promise<IssueAdmissionRecord | null> {
    return this.#fenced(args.assertCurrent, async () => {
      await args.assertCurrent();
      const prior = await this.read(args.workItem);
      const entry = prior?.history.find((item) => item.reservation.oid === args.reservationOid);
      if (!prior || !entry) throw Error("issue admission identity not found");
      const owner = prior.history.at(-1)!;
      if (
        entry.objective !== args.objective ||
        entry.runId !== args.runId ||
        owner.runId !== args.runId ||
        owner.objective !== args.objective ||
        entry.policyDigest !== args.policyDigest ||
        args.directorEpoch < entry.writerEpoch ||
        (args.directorEpoch === entry.writerEpoch &&
          args.writerHolder !== entry.currentWriterHolder)
      )
        throw Error("issue admission authority changed");
      if (
        entry.imported ||
        entry.dispatchPossible ||
        entry.disposition === "released" ||
        entry.disposition === "reconciled"
      )
        return null;
      if (entry.disposition === "terminal" && entry.writerEpoch === args.directorEpoch)
        return prior;
      const closed: IssueAdmissionEntry = {
        ...entry,
        disposition: "terminal",
        writerEpoch: args.directorEpoch,
        currentWriterHolder: args.writerHolder,
      };
      return this.#write(
        prior,
        prior.history.map((item) => (item === entry ? closed : item)),
        args.assertCurrent,
      );
    });
  }

  async transition(
    args: Fence & {
      workItem: number;
      reservationOid: string;
      objective: number;
      runId: string;
      directorEpoch: number;
      writerHolder: string;
      policyDigest: string;
      disposition: Exclude<IssueAdmissionEntry["disposition"], "prepared">;
      evidence?: IssueAdmissionEvidence;
    },
  ): Promise<IssueAdmissionRecord> {
    return this.#fenced(args.assertCurrent, async () => {
      await args.assertCurrent();
      const prior = await this.read(args.workItem);
      const entry = prior?.history.find((item) => item.reservation.oid === args.reservationOid);
      if (!prior || !entry) throw Error("issue admission identity not found");
      if (
        entry.objective !== args.objective ||
        entry.runId !== args.runId ||
        args.policyDigest !== entry.policyDigest ||
        (args.directorEpoch === entry.writerEpoch &&
          args.writerHolder !== entry.currentWriterHolder) ||
        args.directorEpoch < entry.writerEpoch
      )
        throw Error("issue admission authority changed");
      if (
        args.disposition !== "dispatching" &&
        entry.disposition === args.disposition &&
        (entry.disposition === "released" || args.directorEpoch === entry.writerEpoch) &&
        JSON.stringify(entry.evidence) === JSON.stringify(args.evidence)
      )
        return prior;
      if (entry.disposition === "released") throw Error("released admission cannot be rearmed");
      if (entry.disposition === "reconciled" && args.disposition !== "released")
        throw Error("reconciled admission cannot regress");
      if (
        args.disposition === "dispatching" &&
        (entry.disposition !== "prepared" || args.directorEpoch !== entry.directorEpoch)
      )
        throw Error("dispatch cannot be replayed");
      if (args.disposition === "released" || args.disposition === "reconciled")
        this.#settlement(entry, args.evidence);
      const next: IssueAdmissionEntry = {
        ...entry,
        disposition: args.disposition,
        dispatchPossible: entry.dispatchPossible || args.disposition === "dispatching",
        writerEpoch: args.directorEpoch,
        currentWriterHolder: args.writerHolder,
        ...(args.evidence ? { evidence: evidenceSchema.parse(args.evidence) } : {}),
      };
      return this.#write(
        prior,
        prior.history.map((item) => (item === entry ? next : item)),
        args.assertCurrent,
      );
    });
  }

  /** Called only after authenticated accepted-successor runtime and exact settlement verification.
   * Destination authority is retained separately; its epoch never becomes source-run authority. */
  async transitionForSuccessor(
    args: Fence & {
      workItem: number;
      reservationOid: string;
      authority: IssueAdmissionSuccessorAuthority;
      evidence: IssueAdmissionEvidence;
    },
  ): Promise<IssueAdmissionRecord> {
    const authority = successorSchema.parse(args.authority);
    return this.#fenced(args.assertCurrent, async () => {
      await args.assertCurrent();
      const prior = await this.read(args.workItem);
      const entry = prior?.history.find((item) => item.reservation.oid === args.reservationOid);
      if (
        !prior ||
        !entry ||
        entry.objective !== authority.objective ||
        entry.runId === authority.runId
      )
        throw Error("successor settlement scope changed");
      this.#settlement(entry, args.evidence);
      if (entry.disposition === "released") {
        if (
          JSON.stringify(entry.settledBySuccessor) === JSON.stringify(authority) &&
          JSON.stringify(entry.evidence) === JSON.stringify(args.evidence)
        )
          return prior;
        throw Error("released successor settlement cannot change authority");
      }
      return this.#write(
        prior,
        prior.history.map((item) =>
          item !== entry
            ? item
            : {
                ...entry,
                disposition: "released",
                evidence: args.evidence,
                settledBySuccessor: authority,
              },
        ),
        args.assertCurrent,
      );
    });
  }

  /** Authenticated historical identities are retained occupied, including unknown dispatch/accounting.
   * Compatibility ownership must already exclude every legacy producer for these issues. */
  async importLegacy(
    args: Fence & {
      workItem: number;
      workItemNodeId: string;
      compatibilityClaimOid: string;
      history: IssueAdmissionIdentity[];
    },
  ): Promise<IssueAdmissionRecord> {
    return this.#fenced(args.assertCurrent, async () => {
      await args.assertCurrent();
      const prior = await this.read(args.workItem);
      if (prior) {
        const supplied = args.history.map((entry) => identitySchema.parse(entry));
        const existing = prior.history.map((entry) =>
          identitySchema.parse(
            Object.fromEntries(
              Object.keys(identitySchema.shape).map((key) => [
                key,
                entry[key as keyof typeof entry],
              ]),
            ),
          ),
        );
        if (
          prior.history.every((entry) => entry.imported) &&
          JSON.stringify(existing) === JSON.stringify(supplied)
        )
          return prior;
        throw Error("issue ledger already initialized");
      }
      const history = args.history.map((raw): IssueAdmissionEntry => {
        const entry = identitySchema.parse(raw);
        if (
          entry.workItem !== args.workItem ||
          entry.workItemNodeId !== args.workItemNodeId ||
          entry.compatibilityClaimOid !== args.compatibilityClaimOid
        )
          throw Error("legacy admission identity mismatch");
        return {
          ...entry,
          disposition: "dispatching",
          dispatchPossible: true,
          writerEpoch: entry.directorEpoch,
          currentWriterHolder: entry.writerHolder,
          imported: true,
        };
      });
      return this.#write(null, history, args.assertCurrent);
    });
  }

  #settlement(entry: IssueAdmissionEntry, evidence?: IssueAdmissionEvidence): void {
    validateSettlement(entry, evidence);
  }

  async #fenced<T>(fence: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
    return this.store.withMutationFence
      ? this.store.withMutationFence(fence, operation)
      : operation();
  }

  async #write(
    prior: IssueAdmissionRecord | null,
    history: IssueAdmissionEntry[],
    fence: () => Promise<void>,
  ): Promise<IssueAdmissionRecord> {
    const first = history[0];
    if (!first) throw Error("empty issue admission history");
    const record = recordSchema.parse({
      protocol: "clockgrove.factory/issue-admission-v1",
      workItem: first.workItem,
      workItemNodeId: first.workItemNodeId,
      revision: (prior?.revision ?? 0) + 1,
      // Distinguish concurrent identical transitions even with content-addressed
      // commits created in the same second: readback authorizes only this call.
      operationId: randomUUID(),
      priorRevisionOid: prior?.oid ?? null,
      history,
    });
    let attempt = 0;
    for (const entry of history) {
      if (
        entry.workItem !== first.workItem ||
        entry.workItemNodeId !== first.workItemNodeId ||
        entry.reservation.attempt <= attempt
      )
        throw Error("invalid imported admission history");
      attempt = entry.reservation.attempt;
    }
    const base = await this.store.readCommit(first.reservation.baseSha);
    if (base.oid !== first.reservation.baseSha) throw Error("admission base identity changed");
    await fence();
    const oid = await this.store.createCommit({
      treeOid: base.treeOid,
      parentOids: [
        prior?.oid ?? base.oid,
        ...history.slice(prior?.history.length ?? 0).map((entry) => entry.reservation.oid),
        ...history
          .slice(prior?.history.length ?? 0)
          .flatMap((entry) => (entry.reassignmentReceiptOid ? [entry.reassignmentReceiptOid] : [])),
        ...new Set(
          history.flatMap((entry) => {
            const authority = entry.settledBySuccessor?.authorityReceiptOid;
            return authority &&
              !prior?.history.some(
                (old) => old.settledBySuccessor?.authorityReceiptOid === authority,
              )
              ? [authority]
              : [];
          }),
        ),
        ...new Set(
          history.flatMap((entry) => {
            const proof = entry.evidence?.evidenceOid;
            return proof && !prior?.history.some((old) => old.evidence?.evidenceOid === proof)
              ? [proof]
              : [];
          }),
        ),
      ],
      message: `Factory issue admission\n\n${marker}${Buffer.from(JSON.stringify(record)).toString("base64url")}`,
    });
    const ref = issueAdmissionRef(first.workItem);
    await fence();
    let changed: boolean;
    try {
      changed = prior
        ? await this.store.compareAndSwapRef({ ref, beforeOid: prior.oid, afterOid: oid })
        : await this.store.createRef(ref, oid);
    } catch (error) {
      // An accepted GitHub write can lose its response. Recover only this exact
      // immutable commit while it is still current, never a matching-looking owner.
      let observed: IssueAdmissionRecord | null;
      try {
        observed = await this.read(first.workItem);
      } catch {
        throw error;
      }
      if (observed?.oid !== oid) throw error;
      await fence();
      return observed;
    }
    if (!changed) {
      const observed = await this.read(first.workItem);
      if (observed?.oid !== oid) throw Error("issue admission contention; reread required");
      await fence();
      return observed;
    }
    return { ...record, oid, ref };
  }
}

export function parseIssueAdmissionCommit(
  commit: GitCommitObject,
  workItem: number,
): IssueAdmissionRecord {
  const oid = commit.oid;
  const ref = issueAdmissionRef(workItem);

  if (Buffer.byteLength(commit.message) > 8 * 1024 * 1024)
    throw Error("invalid issue admission commit");
  const lines = commit.message.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) throw Error("missing or ambiguous issue admission record");
  const record = recordSchema.parse(
    JSON.parse(Buffer.from(lines[0]!.slice(marker.length), "base64url").toString("utf8")),
  );
  if (
    record.workItem !== workItem ||
    commit.parentOids.length < 1 ||
    commit.parentOids[0] !== (record.priorRevisionOid ?? record.history[0]!.reservation.baseSha) ||
    (record.revision === 1) !== (record.priorRevisionOid === null)
  )
    throw Error("issue admission scope or ancestry changed");
  if (
    record.revision === 1 &&
    (commit.parentOids.length < record.history.length + 1 ||
      record.history.some((entry, index) => commit.parentOids[index + 1] !== entry.reservation.oid))
  )
    throw Error("initial admission metadata is not retained");
  let attempt = 0;
  const identities = new Set<string>();
  for (const entry of record.history) {
    if (
      entry.settledBySuccessor &&
      (entry.disposition !== "released" ||
        entry.settledBySuccessor.objective !== entry.objective ||
        entry.settledBySuccessor.runId === entry.runId)
    )
      throw Error("successor settlement identity changed");
    if (
      (entry.disposition === "prepared" && entry.dispatchPossible) ||
      (entry.disposition === "dispatching" && !entry.dispatchPossible) ||
      (entry.imported && !entry.dispatchPossible)
    )
      throw Error("issue admission dispatch evidence changed");
    if (
      entry.workItem !== workItem ||
      entry.workItemNodeId !== record.workItemNodeId ||
      entry.reservation.attempt <= attempt ||
      identities.has(entry.reservation.oid) ||
      entry.writerEpoch < entry.directorEpoch
    )
      throw Error("invalid issue admission history");
    if (entry.disposition === "released") validateSettlement(entry, entry.evidence);
    attempt = entry.reservation.attempt;
    identities.add(entry.reservation.oid);
  }
  return { ...record, oid, ref };
}

function validateSettlement(entry: IssueAdmissionEntry, evidence?: IssueAdmissionEvidence): void {
  const proof = evidenceSchema.parse(evidence);
  if (
    proof.reservationOid !== entry.reservation.oid ||
    proof.resourceIdentity !== entry.resourceIdentity ||
    proof.capacityReservationId !== entry.capacityReservationId ||
    proof.budgetReservationId !== entry.budgetReservationId
  )
    throw Error("settlement proof does not bind exact admission liabilities");
}
