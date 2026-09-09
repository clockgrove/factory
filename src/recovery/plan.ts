import { createHash } from "node:crypto";
import { PlatformUnavailableError } from "../platform.js";
import { z } from "zod";

import { attemptRef } from "../control/attempts.js";
import {
  compiledGraphRef,
  compiledGraphProjectionRef,
  loadCompiledGraph,
  loadCompiledGraphProjection,
  type CompiledGraphReadStore,
  type CompiledGraphRecord,
  type CompiledGraphProjectionRecord,
  type CompiledGraphStore,
} from "../control/graphs.js";
import type { LeaseManager, LeaseState } from "../control/lease.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { RunPolicySchema, parseRunPolicy, policyDigest } from "../protocol/policy.js";
import { publicationBranch } from "../publication/publisher.js";
import {
  assertCompiledObjectiveAdoptsLegacyConstraints,
  legacyGraphConstraintsDigest,
  parseLegacyGraphConstraints,
  renderLegacyWorkItemCore,
  type LegacyGraphConstraints,
} from "../graph.js";
import { assertAuthenticatedGraphProjection } from "../control/graph-evidence.js";
import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";

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
    // Descriptive only: readers independently verify the immutable refresh lineage.
    siblingRefresh: z
      .object({
        ref: reference,
        commitOid: sha,
        identityDigest: digest,
        deliveryHeadSha: sha,
        targetBaseSha: sha,
        outputTreeSha: sha,
        candidateRunId: identifier,
      })
      .strict()
      .optional(),
    // Descriptive lineage only; outcomes.ts independently loads and verifies the ancestor.
    priorDelivery: z
      .object({
        runId: identifier,
        planDigest: digest,
        integrationReceiptDigest: digest,
        deliveryHeadSha: sha.optional(),
        outputTreeSha: sha.optional(),
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

const persistedGraphSchema = z
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
  .strict();

const legacyConstraintItemSchema = z
  .object({
    compilerId: identifier,
    issueNodeId: identifier,
    issueNumber: positive,
    title: z.string().min(1).max(256),
    goal: z.string().min(1).max(4_000),
    acceptance: z.array(z.string().min(1).max(2_000)).min(1).max(64),
    scope: z.array(z.string().min(1).max(1_000)).min(1).max(64),
    preconditions: z.array(z.string().min(1).max(2_000)).max(64),
    outOfScope: z.array(z.string().min(1).max(2_000)).max(64),
    conventions: z.array(z.string().min(1).max(2_000)).max(64),
    blockedByNumbers: z.array(positive).max(50),
  })
  .strict();
const legacyConstraintsSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/legacy-graph-constraints-v1"),
    objectiveTitle: z.string().min(1).max(256),
    workItems: z.array(legacyConstraintItemSchema).min(1).max(100),
  })
  .strict();
const adoptionGraphSchema = z
  .object({
    mode: z.literal("adopt-existing"),
    sourceRunId: identifier,
    ref: reference,
    objectiveInputDigest: digest,
    constraintDigest: digest,
    constraints: legacyConstraintsSchema,
    projection: z.object({ ref: reference, bindingDigest: digest }).strict(),
  })
  .strict();

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
    graph: z.union([persistedGraphSchema, adoptionGraphSchema]),
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
export type RecoveryPlanGraph = RecoveryPlan["graph"];
export type RecoveryAdoptionGraph = z.infer<typeof adoptionGraphSchema>;
export function isRecoveryAdoptionGraph(graph: RecoveryPlanGraph): graph is RecoveryAdoptionGraph {
  return "mode" in graph && graph.mode === "adopt-existing";
}
export function isRecoveryPersistedGraph(
  graph: RecoveryPlanGraph,
): graph is z.infer<typeof persistedGraphSchema> {
  return !isRecoveryAdoptionGraph(graph);
}

export function recoveryGraphIdentity(graph: RecoveryPlanGraph): string {
  return hash(
    isRecoveryAdoptionGraph(graph)
      ? {
          mode: graph.mode,
          sourceRunId: graph.sourceRunId,
          objectiveInputDigest: graph.objectiveInputDigest,
          constraintDigest: graph.constraintDigest,
          bindingDigest: graph.projection.bindingDigest,
        }
      : {
          mode: "persisted",
          sourceRunId: graph.sourceRunId,
          digest: graph.digest,
          bindingDigest: graph.projection.bindingDigest,
        },
  );
}

/**
 * Resolve the immutable graph authorized by a recovery plan. A normal plan
 * binds exact Git objects. An adoption plan instead binds the complete legacy
 * core and GitHub identities before the model is called; once the successor
 * has compiled the enrichment, its own authenticated graph/projection receipts
 * make those newly persisted records immutable.
 */
export async function loadRecoveryPlanGraph(
  store: CompiledGraphReadStore,
  plan: RecoveryPlan,
  events: readonly FactoryEvent[],
): Promise<{
  graph: CompiledGraphRecord;
  projection: CompiledGraphProjectionRecord;
} | null> {
  const uniqueEvents = deduplicateFactoryEvents([...events]);
  const graph = await loadCompiledGraph(store, plan.objective, plan.graph.sourceRunId);
  if (!graph) return null;
  const projection = await loadCompiledGraphProjection(
    store,
    plan.objective,
    plan.graph.sourceRunId,
    graph,
  );
  if (!projection) return null;
  if (
    graph.ref !== plan.graph.ref ||
    projection.ref !== plan.graph.projection.ref ||
    projection.bindings.length !== plan.items.length ||
    recoveryPlanBindingDigest(
      projection.bindings.map((binding) => ({
        compilerId: binding.compilerId,
        issueNodeId: binding.issueNodeId,
        workItem: binding.issueNumber,
      })),
    ) !== plan.graph.projection.bindingDigest
  )
    return null;
  if (isRecoveryPersistedGraph(plan.graph)) {
    if (
      graph.commitOid !== plan.graph.commitOid ||
      graph.blobOid !== plan.graph.blobOid ||
      graph.graphDigest !== plan.graph.digest ||
      projection.commitOid !== plan.graph.projection.commitOid ||
      projection.blobOid !== plan.graph.projection.blobOid
    )
      return null;
  } else {
    try {
      assertCompiledObjectiveAdoptsLegacyConstraints(graph.objective, plan.graph.constraints);
    } catch {
      return null;
    }
  }
  const compiled = uniqueEvents.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphCompiled" &&
      event.objective === plan.objective &&
      event.runId === plan.graph.sourceRunId,
  );
  if (
    compiled.length !== 1 ||
    compiled[0]!.graphRef !== graph.ref ||
    compiled[0]!.graphBlobSha !== graph.blobOid ||
    compiled[0]!.graphDigest !== graph.graphDigest ||
    compiled[0]!.graphSize !== graph.graphSize
  )
    return null;
  const projected = uniqueEvents.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphProjected" &&
      event.objective === plan.objective &&
      event.runId === plan.graph.sourceRunId,
  );
  if (projected.length !== 1 || projected[0]!.sequence <= compiled[0]!.sequence) return null;
  try {
    assertAuthenticatedGraphProjection(
      uniqueEvents,
      plan.objective,
      plan.graph.sourceRunId,
      projection,
    );
  } catch {
    return null;
  }
  return { graph, projection };
}
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
  requirePlan(
    runIds.has(plan.graph.sourceRunId) ||
      (isRecoveryAdoptionGraph(plan.graph) && plan.graph.sourceRunId === plan.successorRunId),
    "graph source is outside history or the bound adoption successor",
  );
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
  if (isRecoveryAdoptionGraph(plan.graph)) {
    const constraints = parseLegacyGraphConstraints({
      objectiveTitle: plan.graph.constraints.objectiveTitle,
      workItems: plan.graph.constraints.workItems.map((item) => ({
        id: item.issueNodeId,
        number: item.issueNumber,
        title: item.title,
        body: renderLegacyWorkItemCore(item),
        blockedByNumbers: item.blockedByNumbers,
      })),
    });
    requirePlan(
      legacyGraphConstraintsDigest(constraints) === plan.graph.constraintDigest,
      "legacy graph constraint digest mismatch",
    );
    requirePlan(
      canonical(constraints) === canonical(plan.graph.constraints as LegacyGraphConstraints),
      "legacy graph constraints are not canonical",
    );
    requirePlan(
      constraints.workItems.length === plan.items.length &&
        constraints.workItems.every((constraint, index) => {
          const item = plan.items[index];
          return (
            item?.workItem === constraint.issueNumber &&
            item.issueNodeId === constraint.issueNodeId &&
            item.compilerId === constraint.compilerId
          );
        }),
      "legacy graph plan items differ from their authenticated constraints",
    );
    if (plan.graph.sourceRunId === plan.successorRunId)
      requirePlan(
        plan.items.every(
          (item) =>
            item.action === "execute" &&
            item.source === null &&
            item.observedPullRequest === null &&
            item.resources.state === "not-required",
        ),
        "graph bootstrap cannot adopt historical execution effects",
      );
  }
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
      if (source.siblingRefresh)
        requirePlan(
          source.publication &&
            (source.publication.mode === "native-stacks" ||
              source.publication.branch ===
                publicationBranch(plan.objective, item.workItem, source.attempt)) &&
            source.publication.stackNumber === null &&
            source.validation &&
            source.siblingRefresh.deliveryHeadSha !== source.publication.headSha &&
            plan.history.some((entry) => entry.runId === source.siblingRefresh!.candidateRunId),
          "sibling refresh requires an exact historical sibling source",
        );
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
        observed.headSha ===
          (source!.priorDelivery?.deliveryHeadSha ??
            source!.siblingRefresh?.deliveryHeadSha ??
            publication.headSha) &&
          // This is a descriptive plan, not admission. Prior candidate integration
          // is independently verified by verifyPriorRecoveryDelivery in BOTH the
          // proposal builder and evidence resolver before it becomes usable.
          (observed.baseSha === (source!.siblingRefresh?.targetBaseSha ?? publication.baseSha) ||
            (item.action === "integrated" && source!.priorDelivery !== undefined)) &&
          observed.headRef === publication.branch &&
          observed.baseRef === publication.baseBranch &&
          observed.headRepository?.toLowerCase() === publication.headRepository.toLowerCase() &&
          observed.treeSha ===
            (source!.priorDelivery?.outputTreeSha ??
              source!.siblingRefresh?.outputTreeSha ??
              source!.validation!.outputTreeSha),
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
      if (error instanceof PlatformUnavailableError) throw error;
      const observed = await this.load(plan.objective, planDigest);
      if (observed) return observed;
      throw error;
    }
    const observed = await this.load(plan.objective, planDigest);
    requirePlan(observed, "proposal ref creation was not observed");
    return observed;
  }
}
