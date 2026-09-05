import { createHash } from "node:crypto";
import type { FactoryReadSnapshot } from "../application/status.js";
import { attemptRef } from "../control/attempts.js";
import {
  assertAuthenticatedGraphProjection,
  assertSnapshotMatchesCompiledGraph,
} from "../control/graph-evidence.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { loadReviewCheckpoint, type ReviewIdentity } from "../control/reviews.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { policyDigest } from "../protocol/policy.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import {
  createRecoveryEventDigest,
  recoveryEventDigest,
  recoverySourceEventsDigest,
} from "./identity.js";
import { verifyPriorRecoveryDelivery } from "./outcomes.js";
import { recoveryAdoptionEvents } from "./transaction.js";
import {
  loadRecoveryPlan,
  parseRecoveryPlan,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "./plan.js";

export interface RecoveryReceiptIdentity {
  runId: string;
  event: string;
  sequence: number;
  digest: string;
  workItem?: number;
  attempt?: number;
}
export interface ResolvedRecoveryItem {
  workItem: number;
  action: RecoveryPlan["items"][number]["action"];
  sourceBindings: "verified" | "incomplete";
  sourceAttempt: {
    runId: string;
    attempt: number;
    backend: string;
    baseSha: string;
    policyDigest: string;
  } | null;
  reservation: { ref: string; commitOid: string; receipt: RecoveryReceiptIdentity } | null;
  validation: {
    evidenceDigest: string;
    baseSha: string;
    outputTreeSha: string;
    receipt: RecoveryReceiptIdentity;
  } | null;
  review: { ref: string; commitOid: string; blobOid: string; identityDigest: string } | null;
  publication: {
    pullRequest: number;
    branch: string;
    baseSha: string;
    headSha: string;
    receipt: RecoveryReceiptIdentity;
  } | null;
  successorEffects: RecoveryReceiptIdentity[];
  successorEffectCount: number;
  successorEffectsTruncated: boolean;
  current: {
    head: "unchanged" | "changed" | "not-required" | "unavailable";
    resources: "not-required" | "unavailable";
    publication: RecoveryPlan["items"][number]["observedPullRequest"];
  };
}
export interface RecoveryEvidenceResolution {
  controllingRunId: string;
  sourcePlanDigest: string;
  currentSourceEventsDigest: string | null;
  sourceBindings: "verified" | "incomplete";
  executionAuthorized: false;
  adoptionVerified: false;
  claimBinding: "verified" | "unavailable" | "mismatch";
  currentBase: "unchanged" | "changed" | "unavailable";
  currentBaseSha: string | null;
  items: ResolvedRecoveryItem[];
  blockers: Array<{ code: string; workItem?: number }>;
  reads: { performed: number; limit: number };
}

function receiptIdentity(event: FactoryEvent): RecoveryReceiptIdentity {
  return {
    runId: event.runId,
    event: event.event,
    sequence: event.sequence,
    digest: recoveryEventDigest(event),
    ...("workItem" in event && typeof event.workItem === "number"
      ? { workItem: event.workItem }
      : {}),
    ...("attempt" in event && typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
  };
}

/** Stable evidence identity across pre/post-claim reads; unavailable resources never become authority. */
export function recoveryEvidenceDigest(resolution: RecoveryEvidenceResolution): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const {
    reads: _reads,
    claimBinding: _claim,
    adoptionVerified: _adoption,
    executionAuthorized: _authority,
    ...evidence
  } = resolution;
  return createHash("sha256").update(canonical(evidence)).digest("hex");
}

/** Resolve original immutable evidence without copying attempts into, or authorizing, the controlling run. */
export async function resolveRecoveryEvidence(input: {
  planRecord: RecoveryPlanRecord;
  events: readonly FactoryEvent[];
  claim: RecoveryClaimRecord | null;
  store: RecoveryReadStore;
  snapshot: FactoryReadSnapshot;
}): Promise<RecoveryEvidenceResolution> {
  const recoveryEventDigest = createRecoveryEventDigest();
  const output: RecoveryEvidenceResolution = {
    controllingRunId: input.planRecord.plan.successorRunId,
    sourcePlanDigest: input.planRecord.digest,
    currentSourceEventsDigest: null,
    sourceBindings: "incomplete",
    executionAuthorized: false,
    adoptionVerified: false,
    claimBinding: "unavailable",
    currentBase: "unavailable",
    currentBaseSha: null,
    items: [],
    blockers: [],
    reads: { performed: 0, limit: 512 },
  };
  const block = (code: string, workItem?: number) => {
    if (output.blockers.length < 200)
      output.blockers.push({ code, ...(workItem === undefined ? {} : { workItem }) });
  };
  const requireEvidence = (condition: unknown) => {
    if (!condition) throw new Error("source identity unavailable");
  };
  const cache = new Map<string, Promise<unknown>>();
  const read = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = cache.get(key);
    if (previous) return previous as Promise<T>;
    if (output.reads.performed >= output.reads.limit)
      return Promise.reject(new Error("source read bound"));
    output.reads.performed++;
    const promise = operation();
    cache.set(key, promise);
    return promise;
  };
  const store: RecoveryReadStore = {
    readRef: (ref: string) => read(`ref:${ref}`, () => input.store.readRef(ref)),
    readCommit: (oid: string) => read(`commit:${oid}`, () => input.store.readCommit(oid)),
    readBlob: (oid: string) => read(`blob:${oid}`, () => input.store.readBlob(oid)),
    readTreeEntry: (oid: string, path: string) =>
      read(`tree:${oid}:${path}`, () => input.store.readTreeEntry(oid, path)),
    readPullRequest: (number) => read(`pull:${number}`, () => input.store.readPullRequest(number)),
    listRefs: (prefix) => read(`refs:${prefix}`, () => input.store.listRefs(prefix)),
    getRepositoryFacts: () => read("facts", () => input.store.getRepositoryFacts()),
    getBranchHead: (branch) => read(`base:${branch}`, () => input.store.getBranchHead(branch)),
    readBranchRules: (branch) => read(`rules:${branch}`, () => input.store.readBranchRules(branch)),
    readChecks: (head) => read(`checks:${head}`, () => input.store.readChecks(head)),
    ...(input.store.readStack
      ? {
          readStack: (number: number) =>
            read(`stack:${number}`, () => input.store.readStack!(number)),
        }
      : {}),
  };
  try {
    requireEvidence(input.events.length <= 10_000);
    const plan = parseRecoveryPlan(input.planRecord.plan);
    requireEvidence(
      input.planRecord.digest === recoveryPlanDigest(plan) &&
        input.planRecord.ref === recoveryPlanRef(plan.objective, input.planRecord.digest),
    );
    const loaded = await loadRecoveryPlan(store, plan.objective, input.planRecord.digest);
    requireEvidence(
      loaded &&
        loaded.ref === input.planRecord.ref &&
        loaded.commitOid === input.planRecord.commitOid &&
        loaded.blobOid === input.planRecord.blobOid &&
        loaded.digest === input.planRecord.digest,
    );
    const snapshot = input.snapshot;
    requireEvidence(
      snapshot.number === plan.objective &&
        snapshot.id === plan.objectiveNodeId &&
        snapshot.repositoryId === plan.repositoryId &&
        snapshot.defaultBranch === plan.baseBranch &&
        snapshot.workItems.length === plan.items.length,
    );
    requireEvidence(
      Array.isArray(snapshot.factoryEvents) &&
        snapshot.workItems.every(
          (item) =>
            Array.isArray(item.factoryEvents) &&
            Array.isArray(item.linkedPullRequests) &&
            Array.isArray(item.copilotAssignments) &&
            typeof item.closed === "boolean",
        ),
    );
    const events = deduplicateFactoryEvents(input.events.map(parseFactoryEvent));
    requireEvidence(events.every((event) => event.objective === plan.objective));
    const sourceRunIds = plan.history.map((entry) => entry.runId);
    requireEvidence(
      recoverySourceEventsDigest({
        objective: plan.objective,
        runIds: sourceRunIds,
        events,
        maxSequence: plan.sourceEventMaxSequence,
      }) === plan.sourceEventsDigest,
    );
    output.currentSourceEventsDigest = recoverySourceEventsDigest({
      objective: plan.objective,
      runIds: sourceRunIds,
      events,
      maxSequence: Number.MAX_SAFE_INTEGER,
    });
    if (output.currentSourceEventsDigest !== plan.sourceEventsDigest)
      block("source-history-changed");
    const starts = new Map<string, Extract<FactoryEvent, { event: "FactoryRunStarted" }>>();
    for (const event of events)
      if (event.event === "FactoryRunStarted") {
        requireEvidence(
          !starts.has(event.runId) &&
            event.repository.toLowerCase() === plan.repository.toLowerCase() &&
            policyDigest(event.policy) === event.policyDigest,
        );
        starts.set(event.runId, event);
      }
    for (const entry of plan.history) {
      const start = starts.get(entry.runId);
      requireEvidence(
        start &&
          recoveryEventDigest(start) === entry.startDigest &&
          start.policyDigest === entry.policyDigest,
      );
    }
    const controllingStart = starts.get(plan.successorRunId);
    if (controllingStart)
      requireEvidence(
        controllingStart.recoveryPlanDigest === input.planRecord.digest &&
          controllingStart.recoveryRequestId === plan.requestId &&
          controllingStart.predecessorRunId === plan.predecessor.runId &&
          controllingStart.policyDigest === plan.policyDigest,
      );
    const graphCache = new Map<string, Promise<void>>();
    const verifyGraph = (runId: string): Promise<void> => {
      const previous = graphCache.get(runId);
      if (previous) return previous;
      const promise = (async () => {
        const graph = await loadCompiledGraph(store, plan.objective, runId);
        if (!graph) {
          const start = starts.get(runId);
          requireEvidence(start?.recoveryPlanDigest);
          const adopted = await loadRecoveryPlan(store, plan.objective, start!.recoveryPlanDigest!);
          requireEvidence(
            adopted &&
              adopted.plan.successorRunId === runId &&
              adopted.plan.graph.sourceRunId !== runId &&
              adopted.plan.graph.digest === plan.graph.digest &&
              adopted.plan.graph.projection.bindingDigest === plan.graph.projection.bindingDigest &&
              adopted.plan.history.length < plan.history.length,
          );
          const claim = await loadRecoveryClaim(
            store,
            plan.objective,
            adopted!.plan.predecessor.runId,
          );
          const request = events.find(
            (event) =>
              event.event === "RecoveryRequested" && event.requestId === adopted!.plan.requestId,
          );
          const predecessor = starts.get(adopted!.plan.predecessor.runId);
          requireEvidence(claim && request?.event === "RecoveryRequested" && predecessor);
          if (!claim || request?.event !== "RecoveryRequested" || !predecessor)
            throw new Error("missing graph adoption");
          const expected = recoveryAdoptionEvents({
            planRecord: adopted!,
            claim,
            authenticatedRequest: request,
            predecessorStart: predecessor,
          });
          requireEvidence(
            expected
              .map(recoveryEventDigest)
              .every((expectedDigest) =>
                events.some((event) => recoveryEventDigest(event) === expectedDigest),
              ),
          );
          await verifyGraph(adopted!.plan.graph.sourceRunId);
          return;
        }
        requireEvidence(
          graph && graph.graphDigest === plan.graph.digest && graph.graphSize === plan.items.length,
        );
        if (!graph) throw new Error("missing graph");
        const compiled = events.filter(
          (event) => event.runId === runId && event.event === "GraphCompiled",
        );
        requireEvidence(
          compiled.length === 1 &&
            compiled[0]!.kind === "graph" &&
            compiled[0]!.event === "GraphCompiled" &&
            compiled[0]!.graphRef === graph.ref &&
            compiled[0]!.graphBlobSha === graph.blobOid &&
            compiled[0]!.graphDigest === graph.graphDigest &&
            compiled[0]!.graphSize === graph.graphSize,
        );
        const projection = await loadCompiledGraphProjection(store, plan.objective, runId, graph);
        requireEvidence(projection);
        if (!projection) throw new Error("missing projection");
        assertAuthenticatedGraphProjection(events, plan.objective, runId, projection);
        requireEvidence(
          recoveryPlanBindingDigest(
            projection.bindings.map((binding) => ({
              compilerId: binding.compilerId,
              issueNodeId: binding.issueNodeId,
              workItem: binding.issueNumber,
            })),
          ) === plan.graph.projection.bindingDigest,
        );
        assertSnapshotMatchesCompiledGraph(
          graph.objective,
          {
            workItems: snapshot.workItems.map((item) => {
              requireEvidence(
                item.id && item.title && item.body !== undefined && item.blockedBy !== undefined,
              );
              return {
                id: item.id!,
                number: item.number,
                title: item.title!,
                body: item.body ?? null,
                blockedBy: item.blockedBy!,
              };
            }),
          },
          projection.bindings,
        );
        if (runId === plan.graph.sourceRunId)
          requireEvidence(
            graph.ref === plan.graph.ref &&
              graph.commitOid === plan.graph.commitOid &&
              graph.blobOid === plan.graph.blobOid &&
              projection.ref === plan.graph.projection.ref &&
              projection.commitOid === plan.graph.projection.commitOid &&
              projection.blobOid === plan.graph.projection.blobOid,
          );
      })();
      graphCache.set(runId, promise);
      return promise;
    };
    await verifyGraph(plan.graph.sourceRunId);
    const facts = await read("facts", () => input.store.getRepositoryFacts());
    requireEvidence(
      facts.fullName.toLowerCase() === plan.repository.toLowerCase() &&
        facts.defaultBranch === plan.baseBranch,
    );
    try {
      output.currentBaseSha = (
        await read("base", () => input.store.getBranchHead(plan.baseBranch))
      ).oid;
      output.currentBase = output.currentBaseSha === plan.expectedBaseSha ? "unchanged" : "changed";
      if (output.currentBase === "changed") block("current-base-changed");
    } catch {
      block("current-base-unavailable");
    }
    if (input.claim) {
      try {
        const claim = await loadRecoveryClaim(store, plan.objective, plan.predecessor.runId);
        requireEvidence(
          claim &&
            claim.ref === input.claim.ref &&
            claim.oid === input.claim.oid &&
            claim.blobOid === input.claim.blobOid &&
            claim.planDigest === input.planRecord.digest &&
            claim.requestId === plan.requestId &&
            claim.successorRunId === plan.successorRunId,
        );
        const request = events.find(
          (event) =>
            event.event === "RecoveryRequested" &&
            recoveryEventDigest(event) === claim!.requestDigest,
        );
        requireEvidence(
          request &&
            request.event === "RecoveryRequested" &&
            request.requestId === plan.requestId &&
            request.planDigest === input.planRecord.digest,
        );
        output.claimBinding = "verified";
      } catch {
        output.claimBinding = "mismatch";
        block("claim-binding-unavailable");
      }
    }
    for (const item of plan.items) {
      const resolved: ResolvedRecoveryItem = {
        workItem: item.workItem,
        action: item.action,
        sourceBindings: "incomplete",
        sourceAttempt: null,
        reservation: null,
        validation: null,
        review: null,
        publication: null,
        successorEffects: [],
        successorEffectCount: 0,
        successorEffectsTruncated: false,
        current: {
          head: "not-required",
          resources: item.source ? "unavailable" : "not-required",
          publication: null,
        },
      };
      output.items.push(resolved);
      try {
        const successor = events.filter(
          (event) =>
            event.runId === plan.successorRunId &&
            "workItem" in event &&
            event.workItem === item.workItem,
        );
        requireEvidence(!successor.length || controllingStart);
        resolved.successorEffectCount = successor.length;
        resolved.successorEffectsTruncated = successor.length > 100;
        resolved.successorEffects = successor.slice(0, 100).map(receiptIdentity);
        const source = item.source;
        const currentItem = snapshot.workItems.find(
          (candidate) => candidate.number === item.workItem,
        )!;
        if (!source) {
          requireEvidence(
            !events.some(
              (event) =>
                sourceRunIds.includes(event.runId) &&
                "workItem" in event &&
                event.workItem === item.workItem &&
                ["attempt", "publication", "capacity", "validation"].includes(event.kind),
            ) &&
              currentItem.linkedPullRequests?.length === 0 &&
              currentItem.copilotAssignments?.length === 0,
          );
          resolved.sourceBindings = "verified";
          continue;
        }
        await verifyGraph(source.runId);
        const sourceEvents = events.filter(
          (event) =>
            event.runId === source.runId &&
            "workItem" in event &&
            event.workItem === item.workItem &&
            "attempt" in event &&
            event.attempt === source.attempt,
        );
        requireEvidence(
          sourceEvents.every(
            (event) =>
              !("policyDigest" in event) ||
              event.policyDigest === starts.get(source.runId)?.policyDigest,
          ),
        );
        const exact = (digest: string) => {
          const matches = sourceEvents.filter(
            (event) =>
              event.sequence <= plan.sourceEventMaxSequence &&
              recoveryEventDigest(event) === digest,
          );
          requireEvidence(matches.length === 1);
          return matches[0]!;
        };
        const reservation = exact(source.reservationReceiptDigest);
        requireEvidence(
          reservation.kind === "attempt" &&
            reservation.event === "AttemptReserved" &&
            reservation.policyDigest === starts.get(source.runId)?.policyDigest,
        );
        if (reservation.kind !== "attempt") throw new Error("reservation kind");
        requireEvidence(
          source.reservationRef === attemptRef(plan.objective, item.workItem, source.attempt) &&
            (await store.readRef(source.reservationRef)) === source.reservationCommitOid,
        );
        const commit = await store.readCommit(source.reservationCommitOid);
        const trailer = decodeEventTrailer(commit.message);
        requireEvidence(
          commit.oid === source.reservationCommitOid &&
            trailer &&
            recoveryEventDigest(trailer) === source.reservationReceiptDigest &&
            commit.parentOids.length === 1 &&
            commit.parentOids[0] === reservation.baseSha &&
            (await store.readCommit(reservation.baseSha)).treeOid === commit.treeOid,
        );
        resolved.sourceAttempt = {
          runId: source.runId,
          attempt: source.attempt,
          backend: reservation.backend,
          baseSha: reservation.baseSha,
          policyDigest: reservation.policyDigest,
        };
        resolved.reservation = {
          ref: source.reservationRef,
          commitOid: source.reservationCommitOid,
          receipt: receiptIdentity(reservation),
        };
        if (source.artifactDigest)
          requireEvidence(
            sourceEvents.some(
              (event) =>
                event.kind === "attempt" &&
                event.sequence <= plan.sourceEventMaxSequence &&
                event.artifactDigest === source.artifactDigest &&
                event.policyDigest === reservation.policyDigest,
            ),
          );
        if (source.validation) {
          const validation = exact(source.validation.receiptDigest);
          requireEvidence(
            validation.kind === "validation" &&
              validation.passed &&
              validation.baseSha === source.validation.baseSha &&
              validation.outputTreeSha === source.validation.outputTreeSha &&
              validation.evidenceDigest === source.validation.evidenceDigest,
          );
          resolved.validation = { ...source.validation, receipt: receiptIdentity(validation) };
        }
        if (source.review) {
          requireEvidence(source.validation && source.artifactDigest);
          const baseIdentity: ReviewIdentity = {
            kind: "artifact",
            runId: source.runId,
            objective: plan.objective,
            workItem: item.workItem,
            attempt: source.attempt,
            artifactDigest: source.artifactDigest!,
            baseSha: source.validation!.baseSha,
            outputTreeSha: source.validation!.outputTreeSha,
            evidenceDigest: source.validation!.evidenceDigest,
          };
          const artifact = await loadReviewCheckpoint(store, baseIdentity);
          const review =
            artifact?.ref === source.review.ref
              ? artifact
              : source.publication
                ? await loadReviewCheckpoint(store, {
                    ...baseIdentity,
                    kind: "rebase",
                    headSha: source.publication.headSha,
                  })
                : null;
          requireEvidence(
            review &&
              review.ref === source.review.ref &&
              review.commitOid === source.review.commitOid &&
              review.blobOid === source.review.blobOid &&
              review.identityDigest === source.review.identityDigest &&
              review.review.accepted &&
              review.review.unmetCriteria.length === 0,
          );
          if (!review) throw new Error("review unavailable");
          const reviewCommit = await store.readCommit(review.commitOid);
          requireEvidence(
            reviewCommit.parentOids.length === 1 &&
              reviewCommit.parentOids[0] === source.validation!.baseSha,
          );
          const accepted = sourceEvents.find(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptValidated" &&
              event.artifactDigest === source.artifactDigest &&
              event.sequence <= plan.sourceEventMaxSequence,
          );
          requireEvidence(review.identity.kind === "rebase" || accepted);
          const usageId = `${review.identity.kind === "rebase" ? "rebase-review" : "review"}-${review.identityDigest}`;
          const usage = sourceEvents.filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.phase === "management" &&
              event.unit === "model_tokens" &&
              event.usageId === usageId &&
              event.sequence <= plan.sourceEventMaxSequence,
          );
          requireEvidence(
            Number.isSafeInteger(review.usage.inputTokens + review.usage.outputTokens) &&
              usage.length > 0 &&
              usage.every(
                (event) => event.amount === review.usage.inputTokens + review.usage.outputTokens,
              ),
          );
          resolved.review = { ...source.review };
        }
        if (source.priorDelivery) {
          const prior = await verifyPriorRecoveryDelivery({ plan, item, events, store });
          const publication = source.publication!;
          const receipt = events.find(
            (event) => recoveryEventDigest(event) === publication.receiptDigest,
          );
          requireEvidence(receipt);
          resolved.publication = { ...publication, receipt: receiptIdentity(receipt!) };
          const pull = await store.readPullRequest(publication.pullRequest);
          const head = await store.readCommit(pull.headSha);
          const observed = item.observedPullRequest;
          requireEvidence(
            observed &&
              pull.merged &&
              pull.mergeCommitSha === prior.outcome.mergeCommitSha &&
              pull.number === observed.number &&
              pull.nodeId === observed.nodeId &&
              pull.headSha === observed.headSha &&
              head.treeOid === observed.treeSha &&
              pull.baseSha === observed.baseSha &&
              pull.headRef === observed.headRef &&
              pull.baseRef === observed.baseRef &&
              pull.headRepository === observed.headRepository &&
              pull.baseRepository === observed.baseRepository,
          );
          resolved.current.publication = { ...observed! };
          resolved.current.head = "unchanged";
        } else if (source.publication) {
          const publication = exact(source.publication.receiptDigest);
          requireEvidence(
            publication.kind === "publication" &&
              publication.event === "PublicationRecorded" &&
              publication.itemId === item.compilerId &&
              publication.mode === source.publication.mode &&
              publication.pullRequest === source.publication.pullRequest &&
              publication.branch === source.publication.branch &&
              publication.baseBranch === source.publication.baseBranch &&
              publication.baseSha === source.publication.baseSha &&
              publication.headSha === source.publication.headSha &&
              (publication.stackNumber ?? null) === source.publication.stackNumber,
          );
          if (publication.kind !== "publication" || !source.validation)
            throw new Error("publication validation");
          const published = await store.readCommit(publication.headSha);
          const binding = bindValidationToPublishedHead({
            validation: {
              passed: true,
              digest: source.validation.evidenceDigest,
              baseSha: source.validation.baseSha,
              outputTreeSha: source.validation.outputTreeSha,
            },
            publishedHeadSha: publication.headSha,
            publishedTreeSha: published.treeOid,
            publishedBaseSha: publication.baseSha,
          });
          requireEvidence(
            published.oid === publication.headSha &&
              published.parentOids.length === 1 &&
              published.parentOids[0] === source.validation.baseSha &&
              publication.validationDigest === source.validation.evidenceDigest &&
              publication.exactHeadValidationDigest === binding.digest,
          );
          resolved.publication = {
            pullRequest: publication.pullRequest,
            branch: publication.branch,
            baseSha: publication.baseSha,
            headSha: publication.headSha,
            receipt: receiptIdentity(publication),
          };
          try {
            const pull = await read(`pull:${publication.pullRequest}`, () =>
              input.store.readPullRequest(publication.pullRequest),
            );
            requireEvidence(
              pull.number &&
                pull.nodeId &&
                pull.headRef &&
                pull.baseRepository &&
                ["open", "closed"].includes(pull.state),
            );
            const headCommit = await store.readCommit(pull.headSha);
            requireEvidence(headCommit.oid === pull.headSha);
            resolved.current.publication = {
              number: pull.number!,
              nodeId: pull.nodeId!,
              headSha: pull.headSha,
              baseSha: pull.baseSha,
              treeSha: headCommit.treeOid,
              headRef: pull.headRef!,
              baseRef: pull.baseRef,
              headRepository: pull.headRepository ?? null,
              baseRepository: pull.baseRepository!,
              state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
            };
            const observed = item.observedPullRequest;
            resolved.current.head =
              observed &&
              pull.number === observed.number &&
              pull.nodeId === source.publication.pullRequestNodeId &&
              pull.nodeId === observed.nodeId &&
              pull.baseRepository?.toLowerCase() ===
                source.publication.baseRepository.toLowerCase() &&
              pull.headRepository?.toLowerCase() ===
                source.publication.headRepository.toLowerCase() &&
              pull.headSha === observed.headSha &&
              headCommit.treeOid === observed.treeSha &&
              pull.baseSha === observed.baseSha &&
              pull.headRef === observed.headRef &&
              pull.baseRef === observed.baseRef &&
              (pull.merged ? "merged" : pull.state) === observed.state
                ? "unchanged"
                : "changed";
            if (resolved.current.head === "changed")
              block("current-publication-changed", item.workItem);
          } catch {
            resolved.current.head = "unavailable";
            block("current-publication-unavailable", item.workItem);
          }
        } else if (item.observedPullRequest) {
          resolved.current.head = "unavailable";
          block("current-publication-unbound", item.workItem);
        }
        if (source) block("resource-cleanup-unverified", item.workItem);
        resolved.sourceBindings = "verified";
      } catch {
        block("source-item-unavailable", item.workItem);
      }
    }
    output.sourceBindings = output.items.every((item) => item.sourceBindings === "verified")
      ? "verified"
      : "incomplete";
  } catch {
    block("source-plan-or-graph-unavailable");
  }
  return output;
}
