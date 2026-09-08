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
const recordSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/integration-admission-v1"),
    identity: identitySchema,
    nonce: z.string().uuid(),
    state: z.enum(["prepared", "dispatched", "released"]),
  })
  .strict();
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

function parse(message: string): Record {
  if (Buffer.byteLength(message) > 65536) throw Error("integration admission record exceeds bound");
  const lines = message.split(/\r?\n/).filter((line) => line.startsWith("Factory-Integration: "));
  if (lines.length !== 1) throw Error("integration admission record is missing or ambiguous");
  return recordSchema.parse(
    JSON.parse(Buffer.from(lines[0]!.slice(21), "base64url").toString("utf8")),
  );
}

async function settled(store: Store, identity: IntegrationAdmissionIdentity): Promise<boolean> {
  let parent = identity.baseSha;
  for (const member of identity.members ?? [identity]) {
    const pull = await store.readPullRequest(member.pullRequest);
    if (!pull.merged || !pull.mergeCommitSha) return false;
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
  }
  return true;
}

export interface IntegrationAdmission {
  /** Persist uncertain-send ownership before handing the request to GitHub. */
  dispatch(): Promise<void>;
}

export async function withIntegrationAdmission<T>(
  store: Store,
  identity: IntegrationAdmissionIdentity,
  assertObjective: () => Promise<void>,
  operation: (admission: IntegrationAdmission) => Promise<T>,
): Promise<T> {
  const run = () => integrationAdmission(store, identity, assertObjective, operation);
  return store.withMutationFence ? store.withMutationFence(assertObjective, run) : run();
}

async function integrationAdmission<T>(
  store: Store,
  identity: IntegrationAdmissionIdentity,
  assertObjective: () => Promise<void>,
  operation: (admission: IntegrationAdmission) => Promise<T>,
): Promise<T> {
  // A concrete store that supplies withMutationFence performs this exact
  // captured check after queueing and immediately before every mutation. Keep
  // the explicit checks only for standalone stores without that guarantee.
  const assertBeforeMutation = store.withMutationFence ? async () => {} : assertObjective;
  identity = identitySchema.parse(identity);
  const ref = integrationAdmissionRef(identity.repository, identity.branch);
  let oid = await store.readRef(ref);
  let prior: Record | undefined;
  if (oid) {
    const commit = await store.readCommit(oid);
    if (commit.oid !== oid) throw Error("integration admission OID changed");
    prior = parse(commit.message);
    if (
      prior.identity.repository.toLowerCase() !== identity.repository.toLowerCase() ||
      prior.identity.branch !== identity.branch
    )
      throw Error("integration admission scope changed");
    // A higher, currently fenced Objective epoch can replace only a proven pre-send
    // record for the same operation. The CAS races the old producer's dispatched marker:
    // exactly one wins. A dispatched record is never recovered by age or epoch alone.
    const recoveringPrepared =
      prior.state === "prepared" &&
      prior.identity.objective === identity.objective &&
      prior.identity.runId === identity.runId &&
      identity.epoch > prior.identity.epoch &&
      prior.identity.pullRequest === identity.pullRequest &&
      prior.identity.headSha === identity.headSha &&
      prior.identity.baseSha === identity.baseSha &&
      prior.identity.outputTreeSha === identity.outputTreeSha &&
      JSON.stringify(prior.identity.members) === JSON.stringify(identity.members);
    if (recoveringPrepared) await assertBeforeMutation();
    if (
      prior.state !== "released" &&
      !recoveringPrepared &&
      !(prior.state === "dispatched" && (await settled(store, prior.identity)))
    )
      throw new IntegrationAdmissionPendingError(
        prior.identity.objective,
        prior.identity.pullRequest,
      );
  }
  const base = await store.readCommit(identity.baseSha);
  if (base.oid !== identity.baseSha) throw Error("integration base OID changed");
  let record: Record = {
    protocol: "clockgrove.factory/integration-admission-v1",
    identity,
    nonce: randomUUID(),
    state: "prepared",
  };
  const write = async (next: Record): Promise<void> => {
    await assertBeforeMutation();
    const nextOid = await store.createCommit({
      treeOid: base.treeOid,
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
    record = next;
  };
  await write(record);
  let dispatched = false;
  try {
    const result = await operation({
      dispatch: async () => {
        if (dispatched) throw Error("integration request already dispatched");
        // Set before awaiting: an uncertain marker write must never release ownership.
        dispatched = true;
        await write({ ...record, state: "dispatched" });
        await assertBeforeMutation();
        if ((await store.readRef(ref)) !== oid)
          throw Error("integration admission lost before dispatch");
      },
    });
    if (dispatched && !(await settled(store, identity)))
      throw new IntegrationAdmissionPendingError(identity.objective, identity.pullRequest);
    await write({ ...record, state: "released" });
    return result;
  } catch (error) {
    // After transport/marker uncertainty, only exact GitHub outcome proof can retire the claim.
    if (!dispatched) await write({ ...record, state: "released" });
    throw error;
  }
}
