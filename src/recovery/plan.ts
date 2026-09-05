import { createHash } from "node:crypto";
import { z } from "zod";

import { attemptRef } from "../control/attempts.js";
import {
  compiledGraphRef,
  compiledGraphProjectionRef,
  type CompiledGraphReadStore,
  type CompiledGraphStore,
} from "../control/graphs.js";
import type { LeaseManager, LeaseState } from "../control/lease.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { RunPolicySchema, parseRunPolicy, policyDigest } from "../protocol/policy.js";

export const RECOVERY_PLAN_PROTOCOL = "clockgrove.factory/recovery-plan-v1" as const;
export const MAX_RECOVERY_PLAN_BYTES = 256 * 1024;
const PLAN_PATH = ".clockgrove-factory/control/recovery-plan.json";
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/+-]+$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const branch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock"),
    "invalid branch identity",
  );
const reference = z
  .string()
  .min(1)
  .max(512)
  .regex(/^refs\/[A-Za-z0-9._/-]+$/)
  .refine(
    (value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"),
    "invalid control reference",
  );
const repository = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const terminalEvent = z.enum(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);

const predecessorSchema = z
  .object({
    runId: identifier,
    startDigest: digest,
    terminalDigest: digest,
    terminalEvent,
    terminalSequence: positive,
  })
  .strict();
const historyEntrySchema = predecessorSchema.extend({ policyDigest: digest }).strict();
export type RecoveryHistoryEntry = z.infer<typeof historyEntrySchema>;

const allowanceSchema = z
  .object({
    modelTokens: integer.nullable(),
    sandboxMinutes: integer,
    managedSessions: integer,
    implementationAttemptsPerItem: positive,
  })
  .strict();
const incrementSchema = allowanceSchema
  .extend({ modelTokens: integer, implementationAttemptsPerItem: integer })
  .strict();
export type RecoveryAllowance = z.infer<typeof allowanceSchema>;
export type RecoveryAllowanceIncrement = z.infer<typeof incrementSchema>;

const sourceSchema = z
  .object({
    runId: identifier,
    attempt: positive,
    reservationRef: reference,
    reservationCommitOid: sha,
    reservationReceiptDigest: digest,
    artifactDigest: digest.nullable(),
    artifactHead: z.object({ branch, headSha: sha, treeSha: sha }).strict().optional(),
    // Descriptive lineage only; outcomes.ts independently loads and verifies the ancestor.
    priorDelivery: z
      .object({
        runId: identifier,
        planDigest: digest,
        integrationReceiptDigest: digest,
        deliveryHeadSha: sha.optional(),
      })
      .strict()
      .optional(),
    validation: z
      .object({ receiptDigest: digest, evidenceDigest: digest, baseSha: sha, outputTreeSha: sha })
      .strict()
      .nullable(),
    review: z
      .object({ ref: reference, commitOid: sha, blobOid: sha, identityDigest: digest })
      .strict()
      .nullable(),
    publication: z
      .object({
        receiptDigest: digest,
        mode: z.enum(["regular-prs", "native-stacks"]),
        pullRequest: positive,
        pullRequestNodeId: identifier,
        branch,
        baseBranch: branch,
        baseSha: sha,
        headSha: sha,
        baseRepository: repository,
        headRepository: repository,
        stackNumber: positive.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const itemSchema = z
  .object({
    workItem: positive,
    issueNodeId: identifier,
    compilerId: identifier,
    action: z.enum([
      "integrated",
      "reuse-publication",
      "reuse-artifact",
      "revalidate",
      "execute",
      "reconcile",
    ]),
    source: sourceSchema.nullable(),
    observedPullRequest: z
      .object({
        number: positive,
        nodeId: identifier,
        headSha: sha,
        baseSha: sha,
        treeSha: sha,
        headRef: branch,
        baseRef: branch,
        headRepository: repository.nullable(),
        baseRepository: repository,
        state: z.enum(["open", "closed", "merged"]),
      })
      .strict()
      .nullable(),
    resources: z
      .object({
        state: z.enum(["not-required", "verified-clean", "reconciliation-required", "unknown"]),
        receiptDigest: digest.nullable(),
        identities: z
          .array(
            z
              .object({
                backend: identifier,
                identityDigest: digest,
                handleDigest: digest.nullable(),
              })
              .strict(),
          )
          .max(32),
      })
      .strict(),
  })
  .strict();
export type RecoveryPlanItem = z.infer<typeof itemSchema>;

const planSchema = z
  .object({
    protocol: z.literal(RECOVERY_PLAN_PROTOCOL),
    repository,
    repositoryId: identifier,
    objective: positive,
    objectiveNodeId: identifier,
    requestId: identifier,
    successorRunId: identifier,
    predecessor: predecessorSchema,
    history: z.array(historyEntrySchema).min(1).max(100),
    historyDigest: digest,
    sourceEventsDigest: digest,
    sourceEventMaxSequence: positive,
    priorPlanDigest: digest.nullable(),
    expectedBaseSha: sha,
    baseBranch: branch,
    graph: z
      .object({
        sourceRunId: identifier,
        ref: reference,
        commitOid: sha,
        blobOid: sha,
        digest,
        projection: z
          .object({ ref: reference, commitOid: sha, blobOid: sha, bindingDigest: digest })
          .strict(),
      })
      .strict(),
    acceptedPolicy: RunPolicySchema.strict(),
    policyDigest: digest,
    allowance: z
      .object({ before: allowanceSchema, increment: incrementSchema, after: allowanceSchema })
      .strict(),
    unknownUsageAcknowledgementDigest: digest.nullable(),
    items: z.array(itemSchema).min(1).max(100),
  })
  .strict();

/** Immutable proposal only. Neither this document nor its ref authorizes execution. */
export type RecoveryPlan = z.infer<typeof planSchema>;
export interface RecoveryPlanRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  digest: string;
  plan: RecoveryPlan;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function recoveryHistoryDigest(history: readonly RecoveryHistoryEntry[]): string {
  return hash(z.array(historyEntrySchema).min(1).max(100).parse(history));
}

export function recoveryPlanBindingDigest(
  items: readonly Pick<RecoveryPlanItem, "compilerId" | "issueNodeId" | "workItem">[],
): string {
  return hash(
    items.map((item) => ({
      compilerId: item.compilerId,
      issueNodeId: item.issueNodeId,
      issueNumber: item.workItem,
    })),
  );
}

function requirePlan(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid recovery plan: ${message}`);
}

export function parseRecoveryPlan(input: unknown): RecoveryPlan {
  // Bound the unparsed document too: strict schemas must not silently discard large extensions.
  const originalBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  requirePlan(originalBytes <= MAX_RECOVERY_PLAN_BYTES, "document exceeds 256 KiB");
  const plan = planSchema.parse(input);
  const policy = parseRunPolicy(plan.acceptedPolicy);
  requirePlan(policyDigest(policy) === plan.policyDigest, "accepted policy digest mismatch");
  const runIds = new Set(plan.history.map((entry) => entry.runId));
  requirePlan(runIds.size === plan.history.length, "duplicate history run");
  requirePlan(!runIds.has(plan.successorRunId), "successor cannot be a source run");
  requirePlan(
    plan.historyDigest === recoveryHistoryDigest(plan.history),
    "history digest mismatch",
  );
  requirePlan(
    plan.history.every(
      (entry, index) =>
        entry.terminalSequence <= plan.sourceEventMaxSequence &&
        (index === 0 || entry.terminalSequence > plan.history[index - 1]!.terminalSequence),
    ),
    "history order or source cutoff mismatch",
  );
  const last = plan.history.at(-1)!;
  requirePlan(
    Object.entries(plan.predecessor).every(
      ([key, value]) => last[key as keyof RecoveryHistoryEntry] === value,
    ),
    "predecessor must match final source run",
  );
  requirePlan(runIds.has(plan.graph.sourceRunId), "graph source is outside history");
  requirePlan(
    plan.graph.ref === compiledGraphRef(plan.objective, plan.graph.sourceRunId),
    "graph reference scope mismatch",
  );
  requirePlan(
    plan.graph.projection.ref ===
      compiledGraphProjectionRef(plan.objective, plan.graph.sourceRunId),
    "projection reference scope mismatch",
  );
  requirePlan(
    plan.graph.projection.bindingDigest === recoveryPlanBindingDigest(plan.items),
    "projection binding digest mismatch",
  );
  requirePlan(
    new Set(plan.items.map((item) => item.workItem)).size === plan.items.length &&
      new Set(plan.items.map((item) => item.issueNodeId)).size === plan.items.length &&
      new Set(plan.items.map((item) => item.compilerId)).size === plan.items.length,
    "duplicate Work Item identity",
  );
  const { before, increment, after } = plan.allowance;
  for (const unit of [
    "sandboxMinutes",
    "managedSessions",
    "implementationAttemptsPerItem",
  ] as const) {
    requirePlan(
      Number.isSafeInteger(before[unit] + increment[unit]) &&
        after[unit] === before[unit] + increment[unit],
      "allowance arithmetic mismatch",
    );
  }
  requirePlan(
    before.modelTokens === null
      ? after.modelTokens === null && increment.modelTokens === 0
      : after.modelTokens !== null &&
          Number.isSafeInteger(before.modelTokens + increment.modelTokens) &&
          after.modelTokens === before.modelTokens + increment.modelTokens,
    "model-token allowance arithmetic mismatch",
  );
  requirePlan(
    after.modelTokens === (policy.economics?.maxModelTokens ?? null) &&
      after.sandboxMinutes === policy.maxSandboxMinutes &&
      after.managedSessions === policy.maxManagedAgentSessions &&
      after.implementationAttemptsPerItem === policy.maxAttemptsPerItem,
    "resulting allowance differs from accepted policy",
  );
  for (const item of plan.items) {
    requirePlan(
      item.workItem !== plan.objective && item.issueNodeId !== plan.objectiveNodeId,
      "Objective cannot be its own Work Item",
    );
    const source = item.source;
    if (source) {
      if (source.artifactHead)
        requirePlan(
          source.validation &&
            source.artifactHead.treeSha === source.validation.outputTreeSha &&
            source.artifactHead.branch ===
              `factory/objective-${plan.objective}/work-item-${item.workItem}/attempt-${source.attempt}`,
          "artifact head must bind its deterministic source branch and validated tree",
        );
      if (!source.publication && ["reuse-artifact", "revalidate"].includes(item.action))
        requirePlan(
          source.artifactHead && source.validation && source.review,
          "artifact-only recovery requires an acknowledged immutable source head",
        );
      requirePlan(runIds.has(source.runId), "item source is outside history");
      requirePlan(
        source.reservationRef === attemptRef(plan.objective, item.workItem, source.attempt),
        "reservation reference scope mismatch",
      );
      requirePlan(
        !source.validation || source.artifactDigest !== null,
        "validation needs an artifact identity",
      );
      requirePlan(!source.review || source.validation !== null, "review needs validation identity");
      if (source.review) {
        const prefix =
          `refs/clockgrove-factory/reviews/objective-${plan.objective}/` +
          `work-item-${item.workItem}/attempt-${source.attempt}/`;
        requirePlan(
          ["artifact", "rebase"].some(
            (kind) => source.review!.ref === `${prefix}${kind}-${source.review!.identityDigest}`,
          ),
          "review reference scope mismatch",
        );
      }
      if (source.publication) {
        requirePlan(
          source.artifactDigest && source.validation && source.review,
          "publication needs artifact, validation and semantic-review identities",
        );
        requirePlan(
          source.validation.baseSha === source.publication.baseSha,
          "publication base differs from source validation",
        );
        requirePlan(
          source.publication.baseRepository.toLowerCase() === plan.repository.toLowerCase() &&
            source.publication.headRepository.toLowerCase() === plan.repository.toLowerCase(),
          "publication repository scope mismatch",
        );
        requirePlan(
          source.publication.mode === "native-stacks" || source.publication.stackNumber === null,
          "ordinary publication cannot name a native stack",
        );
      }
    }
    if (["integrated", "reuse-publication", "reuse-artifact", "revalidate"].includes(item.action))
      requirePlan(source?.artifactDigest, "reuse requires source artifact provenance");
    if (item.action === "reuse-artifact")
      requirePlan(
        source?.validation && source.review,
        "artifact reuse needs validation and semantic-review identities",
      );
    if (["integrated", "reuse-publication"].includes(item.action))
      requirePlan(
        source?.publication && item.observedPullRequest,
        "publication reuse needs exact source and observed PR identities",
      );
    if (item.observedPullRequest) {
      requirePlan(
        source?.publication &&
          item.observedPullRequest.number === source.publication.pullRequest &&
          item.observedPullRequest.nodeId === source.publication.pullRequestNodeId,
        "observed PR identity mismatch",
      );
      requirePlan(
        item.observedPullRequest.baseRepository.toLowerCase() === plan.repository.toLowerCase(),
        "observed PR repository mismatch",
      );
    }
    if (item.action === "integrated")
      requirePlan(
        item.observedPullRequest?.state === "merged",
        "integrated action needs merged observation",
      );
    if (item.action === "reuse-publication")
      requirePlan(
        item.observedPullRequest?.state === "open",
        "publication reuse needs open observation",
      );
    if (["integrated", "reuse-publication"].includes(item.action)) {
      const observed = item.observedPullRequest!;
      const publication = source!.publication!;
      requirePlan(
        observed.headSha === (source!.priorDelivery?.deliveryHeadSha ?? publication.headSha) &&
          // This is a descriptive plan, not admission. Prior candidate integration
          // is independently verified by verifyPriorRecoveryDelivery in BOTH the
          // proposal builder and evidence resolver before it becomes usable.
          (observed.baseSha === publication.baseSha ||
            (item.action === "integrated" && source!.priorDelivery !== undefined)) &&
          observed.headRef === publication.branch &&
          observed.baseRef === publication.baseBranch &&
          observed.headRepository?.toLowerCase() === publication.headRepository.toLowerCase() &&
          observed.treeSha === source!.validation!.outputTreeSha,
        "publication reuse needs unchanged validated PR identities",
      );
    }
    if (source?.priorDelivery)
      requirePlan(
        item.action === "integrated" &&
          source.publication &&
          plan.history.some((entry) => entry.runId === source.priorDelivery!.runId) &&
          source.priorDelivery.runId !== plan.successorRunId &&
          plan.priorPlanDigest !== null,
        "prior delivery requires an integrated historical source and explicit plan chain",
      );
    requirePlan(
      item.resources.state !== "verified-clean" || item.resources.receiptDigest !== null,
      "resource cleanup needs evidence identity",
    );
    requirePlan(
      item.resources.state !== "not-required" ||
        (item.resources.identities.length === 0 && item.resources.receiptDigest === null),
      "absent resources cannot carry resource identities",
    );
    requirePlan(
      new Set(
        item.resources.identities.map(
          (resource) => `${resource.backend}:${resource.identityDigest}`,
        ),
      ).size === item.resources.identities.length,
      "duplicate resource identity",
    );
  }
  assertNoSecretMaterial(canonical(plan), "recovery plan");
  return plan;
}

export function recoveryPlanDigest(input: RecoveryPlan): string {
  return hash(parseRecoveryPlan(input));
}

export function recoveryPlanRef(objective: number, planDigest: string): string {
  positive.parse(objective);
  digest.parse(planDigest);
  return `refs/clockgrove-factory/recovery-plans/objective-${objective}/plan-${planDigest}`;
}

export async function loadRecoveryPlan(
  store: CompiledGraphReadStore,
  objective: number,
  planDigest: string,
): Promise<RecoveryPlanRecord | null> {
  const ref = recoveryPlanRef(objective, planDigest);
  const commitOid = await store.readRef(ref);
  if (!commitOid) return null;
  const commit = await store.readCommit(commitOid);
  requirePlan(commit.oid === commitOid, "stored commit identity mismatch");
  const blobOid = await store.readTreeEntry(commit.treeOid, PLAN_PATH);
  requirePlan(blobOid, "stored plan blob is missing");
  const bytes = await store.readBlob(blobOid);
  requirePlan(bytes.byteLength <= MAX_RECOVERY_PLAN_BYTES, "stored document exceeds 256 KiB");
  const plan = parseRecoveryPlan(JSON.parse(bytes.toString("utf8")));
  requirePlan(
    plan.objective === objective && recoveryPlanDigest(plan) === planDigest,
    "stored plan scope or digest mismatch",
  );
  requirePlan(
    commit.parentOids.length === 1 && commit.parentOids[0] === plan.expectedBaseSha,
    "stored plan parent does not bind expected base",
  );
  requirePlan(bytes.toString("utf8") === canonical(plan), "stored plan is not canonically encoded");
  return { ref, commitOid, blobOid, digest: planDigest, plan };
}

/** Persists a proposal, not operator authorization or a successor claim. */
export class RecoveryPlanManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: Pick<LeaseManager, "assertCurrent">,
  ) {}

  load(objective: number, planDigest: string): Promise<RecoveryPlanRecord | null> {
    return loadRecoveryPlan(this.store, objective, planDigest);
  }

  async persist(args: { lease: LeaseState; plan: RecoveryPlan }): Promise<RecoveryPlanRecord> {
    const plan = parseRecoveryPlan(args.plan);
    requirePlan(
      args.lease.objective === plan.objective &&
        args.lease.runId === plan.successorRunId &&
        args.lease.policyDigest === plan.policyDigest,
      "proposal lease scope mismatch",
    );
    await this.leases.assertCurrent(args.lease);
    const planDigest = recoveryPlanDigest(plan);
    const existing = await this.load(plan.objective, planDigest);
    if (existing) return existing;
    const base = await this.store.readCommit(plan.expectedBaseSha);
    requirePlan(base.oid === plan.expectedBaseSha, "expected base commit is unavailable");
    await this.leases.assertCurrent(args.lease);
    const blobOid = await this.store.createBlob(Buffer.from(canonical(plan), "utf8"));
    await this.leases.assertCurrent(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: PLAN_PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    await this.leases.assertCurrent(args.lease);
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [plan.expectedBaseSha],
      message: `Factory recovery proposal for Objective #${plan.objective}\n\nFactory-Recovery-Plan: ${planDigest}`,
    });
    const ref = recoveryPlanRef(plan.objective, planDigest);
    await this.leases.assertCurrent(args.lease);
    try {
      await this.store.createRef(ref, commitOid);
    } catch (error) {
      const observed = await this.load(plan.objective, planDigest);
      if (observed) return observed;
      throw error;
    }
    const observed = await this.load(plan.objective, planDigest);
    requirePlan(observed, "proposal ref creation was not observed");
    return observed;
  }
}
