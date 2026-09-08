import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { gitSha } from "../protocol/limits.js";
import type { LeaseStore } from "./lease.js";
import type { PublicationStore } from "../publication/publisher.js";

const identitySchema = z
  .object({
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
    branch: z.string().min(1).max(1024),
    objective: z.number().int().positive(),
    runId: z.string().min(1).max(256),
    epoch: z.number().int().positive(),
    pullRequest: z.number().int().positive(),
    headSha: gitSha,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    members: z
      .array(
        z
          .object({
            pullRequest: z.number().int().positive(),
            headSha: gitSha,
            outputTreeSha: gitSha,
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .refine((identity) => {
    if (!identity.members) return true;
    const last = identity.members.at(-1)!;
    return (
      new Set(identity.members.map((member) => member.pullRequest)).size ===
        identity.members.length &&
      last.pullRequest === identity.pullRequest &&
      last.headSha === identity.headSha &&
      last.outputTreeSha === identity.outputTreeSha
    );
  }, "integration members must be unique and end at the exact requested head");
export type IntegrationAdmissionIdentity = z.infer<typeof identitySchema>;
const dispatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("regular"),
      pullRequest: z.number().int().positive(),
      expectedHeadSha: gitSha,
    })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      pullRequest: z.number().int().positive(),
      expectedHeadSha: gitSha,
      asynchronousMergeUuid: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);
export type IntegrationDispatch = z.infer<typeof dispatchSchema>;
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-dispatched") }).strict(),
  z
    .object({
      kind: z.literal("confirmed"),
      mergeCommitShas: z.array(gitSha).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("regular-http-rejection"),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-request-rejection"),
      reason: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-terminal-failure"),
      asynchronousMergeUuid: z.string().min(1).max(200),
      reason: z.string().min(1).max(4096),
    })
    .strict(),
]);
export type IntegrationNonExecution = Extract<
  z.infer<typeof outcomeSchema>,
  { kind: "regular-http-rejection" | "native-request-rejection" | "native-terminal-failure" }
>;
const recordSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/integration-admission-v1"),
    identity: identitySchema,
    nonce: z.string().uuid(),
    preparedAt: z.string().datetime().optional(),
    state: z.enum(["prepared", "dispatched", "released"]),
    dispatch: dispatchSchema.optional(),
    outcome: outcomeSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.dispatch) {
      if (
        record.dispatch.pullRequest !== record.identity.pullRequest ||
        record.dispatch.expectedHeadSha !== record.identity.headSha
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "dispatch identity changed" });
      }
    }
    if (record.state === "prepared" && (record.dispatch || record.outcome)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "prepared claim has an outcome" });
    }
    if (record.state === "dispatched" && record.outcome) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "dispatched claim has an outcome" });
    }
    if (record.state === "released" && record.dispatch && !record.outcome) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "released dispatch lacks outcome" });
    }
  });
type Record = z.infer<typeof recordSchema>;
type Store = Pick<
  LeaseStore,
  "readRef" | "readCommit" | "createCommit" | "createRef" | "compareAndSwapRef"
> & {
  withMutationFence?<T>(fence: () => Promise<void>, operation: () => Promise<T>): Promise<T>;
  readPullRequest(number: number): Promise<
    Awaited<ReturnType<PublicationStore["readPullRequest"]>> & {
      baseRepository?: string;
      headRepository?: string | null;
    }
  >;
};

/** Only serializes the irreversible default-branch boundary. It grants no Objective,
 * worker, validation, spending or publication authority. No expiry can steal a dispatch. */
export function integrationAdmissionRef(repository: string, branch: string): string {
  const key = createHash("sha256").update(`${repository.toLowerCase()}\0${branch}`).digest("hex");
  return `refs/clockgrove-factory/integration-admissions/${key}`;
}

export class IntegrationAdmissionPendingError extends Error {
  constructor(
    readonly objective: number,
    readonly pullRequest: number,
  ) {
    super(
      `default-branch integration requires exact reconciliation of Objective #${objective} PR #${pullRequest}`,
    );
    this.name = "IntegrationAdmissionPendingError";
  }
}

/** Final readiness and mechanical integration must finish within this prepared-only
 * window. Once it elapses, another fenced Objective may replace the preparation by
 * CAS. A dispatched claim never expires. */
export const INTEGRATION_PREPARATION_TIMEOUT_MS = 120_000;

function parse(message: string): Record {
  if (Buffer.byteLength(message) > 65536) throw Error("integration admission record exceeds bound");
  const lines = message.split(/\r?\n/).filter((line) => line.startsWith("Factory-Integration: "));
  if (lines.length !== 1) throw Error("integration admission record is missing or ambiguous");
  return recordSchema.parse(
    JSON.parse(Buffer.from(lines[0]!.slice(21), "base64url").toString("utf8")),
  );
}

async function confirmedOutcome(
  store: Store,
  identity: IntegrationAdmissionIdentity,
): Promise<Extract<z.infer<typeof outcomeSchema>, { kind: "confirmed" }> | null> {
  let parent = identity.baseSha;
  const mergeCommitShas: string[] = [];
  for (const member of identity.members ?? [identity]) {
    const pull = await store.readPullRequest(member.pullRequest);
    if (!pull.merged || !pull.mergeCommitSha) return null;
    if (
      pull.headSha !== member.headSha ||
      (!identity.members && pull.baseRef !== identity.branch) ||
      pull.baseRepository?.toLowerCase() !== identity.repository.toLowerCase() ||
      pull.headRepository?.toLowerCase() !== identity.repository.toLowerCase()
    )
      throw Error("dispatched integration PR identity changed");
    const commit = await store.readCommit(pull.mergeCommitSha);
    if (
      commit.oid !== pull.mergeCommitSha ||
      commit.parentOids.length !== 1 ||
      commit.parentOids[0] !== parent ||
      commit.treeOid !== member.outputTreeSha
    )
      throw Error("dispatched integration did not preserve the validated base and tree");
    parent = commit.oid;
    mergeCommitShas.push(commit.oid);
  }
  return { kind: "confirmed", mergeCommitShas };
}

export interface IntegrationAdmission {
  /** A prior exact native request is recoverable only by polling this UUID. */
  readonly dispatch: IntegrationDispatch | null;
  /** Persist uncertain-send ownership before handing the request to GitHub. */
  markDispatched(kind: IntegrationDispatch["kind"]): Promise<void>;
  /** Bind the UUID returned by the one native request before journaling or polling it. */
  bindAsynchronousMerge(uuid: string): Promise<void>;
  /** Persist exact authoritative non-execution and retire only this claim by CAS. */
  authoritativeNonExecution(outcome: IntegrationNonExecution): Promise<void>;
}

export interface IntegrationAdmissionOptions {
  /** Upgrade a legacy dispatched claim from an authenticated exact IntegrationPending event. */
  recoverNativeRequestUuid?: string;
}

export async function withIntegrationAdmission<T>(
  store: Store,
  identity: IntegrationAdmissionIdentity,
  assertObjective: () => Promise<void>,
  operation: (admission: IntegrationAdmission) => Promise<T>,
  options: IntegrationAdmissionOptions = {},
): Promise<T> {
  const run = () => integrationAdmission(store, identity, assertObjective, operation, options);
  return store.withMutationFence ? store.withMutationFence(assertObjective, run) : run();
}

async function integrationAdmission<T>(
  store: Store,
  identity: IntegrationAdmissionIdentity,
  assertObjective: () => Promise<void>,
  operation: (admission: IntegrationAdmission) => Promise<T>,
  options: IntegrationAdmissionOptions,
): Promise<T> {
  // A concrete store that supplies withMutationFence performs this exact
  // captured check after queueing and immediately before every mutation. Keep
  // the explicit checks only for standalone stores without that guarantee.
  const assertBeforeMutation = store.withMutationFence ? async () => {} : assertObjective;
  identity = identitySchema.parse(identity);
  const ref = integrationAdmissionRef(identity.repository, identity.branch);
  let oid = await store.readRef(ref);
  let prior: Record | undefined;
  let priorTreeOid: string | undefined;
  let priorObservedAt: Date | undefined;
  let legacyPreparedAt: Date | undefined;
  let record: Record;
  const sameOperation = (left: IntegrationAdmissionIdentity, right: IntegrationAdmissionIdentity) =>
    left.objective === right.objective &&
    left.runId === right.runId &&
    left.pullRequest === right.pullRequest &&
    left.headSha === right.headSha &&
    left.baseSha === right.baseSha &&
    left.outputTreeSha === right.outputTreeSha &&
    JSON.stringify(left.members) === JSON.stringify(right.members);
  if (oid) {
    const commit = await store.readCommit(oid);
    if (commit.oid !== oid) throw Error("integration admission OID changed");
    prior = parse(commit.message);
    priorTreeOid = commit.treeOid;
    priorObservedAt = commit.serverTime;
    legacyPreparedAt = commit.committedAt;
    if (
      prior.identity.repository.toLowerCase() !== identity.repository.toLowerCase() ||
      prior.identity.branch !== identity.branch
    )
      throw Error("integration admission scope changed");
  }

  const append = async (next: Record, treeOid: string): Promise<void> => {
    await assertBeforeMutation();
    const nextOid = await store.createCommit({
      treeOid,
      parentOids: oid ? [oid] : [identity.baseSha],
      message: `Factory default-branch integration\n\nFactory-Integration: ${Buffer.from(JSON.stringify(next)).toString("base64url")}`,
    });
    await assertBeforeMutation();
    const changed = oid
      ? await store.compareAndSwapRef({ ref, beforeOid: oid, afterOid: nextOid })
      : await store.createRef(ref, nextOid);
    if (!changed)
      throw new IntegrationAdmissionPendingError(identity.objective, identity.pullRequest);
    oid = nextOid;
  };

  if (prior) {
    // The same operation may recover preparation immediately after an Objective epoch
    // takeover. Any otherwise eligible Objective may reclaim only an aged preparation.
    // Its CAS races the old actor's mandatory prepared-to-dispatched CAS: exactly one wins.
    const sameOperationRecovery =
      prior.state === "prepared" &&
      identity.epoch > prior.identity.epoch &&
      sameOperation(prior.identity, identity);
    const preparedAbandoned =
      prior.state === "prepared" &&
      priorObservedAt !== undefined &&
      priorObservedAt.getTime() -
        (prior.preparedAt
          ? Date.parse(prior.preparedAt)
          : (legacyPreparedAt?.getTime() ?? Infinity)) >=
        INTEGRATION_PREPARATION_TIMEOUT_MS;
    const recoveringPrepared = sameOperationRecovery || preparedAbandoned;
    if (recoveringPrepared) await assertBeforeMutation();
    if (prior.state === "dispatched") {
      const confirmed = await confirmedOutcome(store, prior.identity);
      if (confirmed) {
        const released = { ...prior, state: "released" as const, outcome: confirmed };
        await append(recordSchema.parse(released), priorTreeOid!);
        prior = released;
      } else if (sameOperation(prior.identity, identity)) {
        const legacyUuid = options.recoverNativeRequestUuid;
        if (legacyUuid) {
          const upgradedDispatch = dispatchSchema.parse({
            kind: "native",
            pullRequest: prior.identity.pullRequest,
            expectedHeadSha: prior.identity.headSha,
            asynchronousMergeUuid: legacyUuid,
          });
          if (
            prior.dispatch &&
            (prior.dispatch.kind !== "native" ||
              prior.dispatch.pullRequest !== upgradedDispatch.pullRequest ||
              prior.dispatch.expectedHeadSha !== upgradedDispatch.expectedHeadSha ||
              (prior.dispatch.asynchronousMergeUuid &&
                prior.dispatch.asynchronousMergeUuid !== legacyUuid))
          )
            throw Error("native recovery request differs from the dispatched integration claim");
          if (!prior.dispatch || !prior.dispatch.asynchronousMergeUuid) {
            prior = recordSchema.parse({ ...prior, dispatch: upgradedDispatch });
            await append(prior, priorTreeOid!);
          }
        }
        if (prior.dispatch?.kind === "native" && prior.dispatch.asynchronousMergeUuid) {
          return runOwnedClaim(prior, priorTreeOid!, true);
        }
      }
    }
    if (prior.state !== "released" && !recoveringPrepared)
      throw new IntegrationAdmissionPendingError(
        prior.identity.objective,
        prior.identity.pullRequest,
      );
  }
  const base = await store.readCommit(identity.baseSha);
  if (base.oid !== identity.baseSha) throw Error("integration base OID changed");
  record = {
    protocol: "clockgrove.factory/integration-admission-v1",
    identity,
    nonce: randomUUID(),
    preparedAt: base.serverTime.toISOString(),
    state: "prepared",
  };
  await append(record, base.treeOid);
  return runOwnedClaim(record, base.treeOid, false);

  async function runOwnedClaim(
    initial: Record,
    treeOid: string,
    recoveringDispatch: boolean,
  ): Promise<T> {
    record = initial;
    let dispatchAttempted = recoveringDispatch;
    const write = async (next: Record): Promise<void> => {
      next = recordSchema.parse(next);
      await append(next, treeOid);
      record = next;
    };
    const assertNoIntegratedMember = async (): Promise<void> => {
      for (const member of record.identity.members ?? [record.identity]) {
        const pull = await store.readPullRequest(member.pullRequest);
        if (pull.merged) {
          throw Error("authoritative non-execution conflicts with an integrated member");
        }
      }
    };
    try {
      const result = await operation({
        get dispatch() {
          return record.dispatch ?? null;
        },
        markDispatched: async (kind) => {
          if (dispatchAttempted || record.state !== "prepared")
            throw Error("integration request already dispatched");
          // Set before awaiting: marker-write uncertainty must never release ownership.
          dispatchAttempted = true;
          await write({
            ...record,
            state: "dispatched",
            dispatch: dispatchSchema.parse({
              kind,
              pullRequest: record.identity.pullRequest,
              expectedHeadSha: record.identity.headSha,
            }),
          });
          await assertBeforeMutation();
          if ((await store.readRef(ref)) !== oid)
            throw Error("integration admission lost before dispatch");
        },
        bindAsynchronousMerge: async (uuid) => {
          uuid = z.string().min(1).max(200).parse(uuid);
          if (record.state !== "dispatched" || record.dispatch?.kind !== "native")
            throw Error("native request UUID cannot bind before dispatch");
          if (record.dispatch.asynchronousMergeUuid === uuid) return;
          if (record.dispatch.asynchronousMergeUuid)
            throw Error("native integration request UUID changed");
          await write({
            ...record,
            dispatch: { ...record.dispatch, asynchronousMergeUuid: uuid },
          });
        },
        authoritativeNonExecution: async (outcome) => {
          const parsed = outcomeSchema.parse(outcome);
          if (parsed.kind === "not-dispatched" || parsed.kind === "confirmed")
            throw Error("non-execution outcome is not authoritative rejection evidence");
          outcome = parsed;
          if (record.state !== "dispatched" || !record.dispatch)
            throw Error("non-execution requires one exact dispatched request");
          if (outcome.kind === "regular-http-rejection" && record.dispatch.kind !== "regular")
            throw Error("regular rejection differs from the dispatched request");
          if (outcome.kind === "native-request-rejection" && record.dispatch.kind !== "native")
            throw Error("native rejection differs from the dispatched request");
          if (outcome.kind === "native-terminal-failure") {
            if (
              record.dispatch.kind !== "native" ||
              record.dispatch.asynchronousMergeUuid !== outcome.asynchronousMergeUuid
            )
              throw Error("native terminal outcome differs from the dispatched request UUID");
          }
          await assertNoIntegratedMember();
          await write({ ...record, state: "released", outcome });
        },
      });
      if (record.state === "released") return result;
      if (dispatchAttempted) {
        const confirmed = await confirmedOutcome(store, record.identity);
        if (!confirmed)
          throw new IntegrationAdmissionPendingError(
            record.identity.objective,
            record.identity.pullRequest,
          );
        await write({ ...record, state: "released", outcome: confirmed });
      } else {
        await write({ ...record, state: "released", outcome: { kind: "not-dispatched" } });
      }
      return result;
    } catch (error) {
      // Only a callback failure before any marker attempt is safely releasable. A
      // failed/stale marker CAS may have dispatched elsewhere and stays uncertain.
      if (!dispatchAttempted && record.state === "prepared") {
        await write({ ...record, state: "released", outcome: { kind: "not-dispatched" } });
      }
      throw error;
    }
  }
}
