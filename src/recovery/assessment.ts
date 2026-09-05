import type { FactoryReadSnapshot, ReadWorkItemSnapshot } from "../application/status.js";
import type { GitHubControlStore } from "../control/github-store.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import {
  assertAuthenticatedGraphProjection,
  assertSnapshotMatchesCompiledGraph,
} from "../control/graph-evidence.js";
import { attemptRef } from "../control/attempts.js";
import { loadReviewCheckpoint, type ReviewIdentity } from "../control/reviews.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { parseRunPolicy, policyDigest } from "../protocol/policy.js";
import type { GitHubStack } from "../publication/github-stacks.js";
import {
  planDelivery,
  type DeliveryItemPlan,
  type DeliveryPlan,
  type DeliveryUnit,
} from "../publication/delivery.js";
import { branchRuleBlockers, missingRequiredChecks } from "../publication/branch-policy.js";
import { publicationBranch } from "../publication/publisher.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import { assessRecoveryAccounting, type RecoveryAccountingAssessment } from "./accounting.js";

/** Only read ports are accepted; assessment cannot obtain mutation or execution authority. */
export type RecoveryReadStore = Pick<
  GitHubControlStore,
  | "readRef"
  | "readCommit"
  | "readBlob"
  | "readTreeEntry"
  | "listRefs"
  | "readPullRequest"
  | "getRepositoryFacts"
  | "getBranchHead"
  | "readBranchRules"
  | "readChecks"
> & { readStack?: (number: number) => Promise<GitHubStack> };

export interface RecoveryBlocker {
  code: string;
  reason: string;
  runId?: string;
  workItem?: number;
}
export type RecoveryClassification =
  | "already-integrated"
  | "reusable-publication"
  | "recoverable-artifact"
  | "unfinished"
  | "reconciliation-required"
  | "blocked";
export interface RecoveryWorkItem {
  number: number;
  classification: RecoveryClassification;
  runId?: string;
  attempt?: number;
  pullRequest?: number;
  headSha?: string;
  baseSha?: string;
  artifactDigest?: string;
  requiresRevalidation: boolean;
  resourceState: "unavailable" | "not-observed";
  resourceReconciliationRequired: boolean;
  reasons: string[];
  blockerCode?: string;
}
export interface RecoveryRun {
  runId: string;
  state: "active" | "completed" | "cancelled" | "escalated";
  policyDigest: string;
  graph: {
    status: "verified" | "absent" | "unavailable";
    digest?: string;
    ref?: string;
    projectionRef?: string;
  };
}
export interface RecoveryAssessment {
  operation: "recovery-plan";
  repository: string;
  objective: number;
  executionAuthorized: false;
  successorAvailable: false;
  availability: "observed" | "incomplete";
  blockers: RecoveryBlocker[];
  runs: RecoveryRun[];
  workItems: RecoveryWorkItem[];
  orphanReservations: Array<{ ref: string; runId?: string; workItem?: number; reason: string }>;
  accounting?: RecoveryAccountingAssessment;
  reads: { performed: number; limit: number };
}

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Attempt = Extract<FactoryEvent, { kind: "attempt" }>;
const LIMIT = 512;
const TERMINALS = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const EXECUTION_KINDS = new Set(["attempt", "capacity", "validation", "publication"]);

class RecoveryEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Input must come from GitHubReader's actor-authenticated history. Recheck identity and
 * immutable bindings here; raw user-supplied envelopes are not authenticated by this function.
 * Candidate classifications describe evidence, never permission to reuse or integrate it.
 */
export async function assessRecovery(input: {
  repository: string;
  snapshot: FactoryReadSnapshot;
  store: RecoveryReadStore;
}): Promise<RecoveryAssessment> {
  const { snapshot, repository, store } = input;
  const report: RecoveryAssessment = {
    operation: "recovery-plan",
    repository,
    objective: snapshot.number,
    executionAuthorized: false,
    successorAvailable: false,
    availability: "observed",
    blockers: [
      {
        code: "successor-unavailable",
        reason:
          "Evidence-preserving successor execution is not implemented; this assessment grants no authority or additional allowance.",
      },
    ],
    runs: [],
    workItems: [],
    orphanReservations: [],
    reads: { performed: 0, limit: LIMIT },
  };
  const block = (
    code: string,
    reason: string,
    scope: { runId?: string; workItem?: number } = {},
  ) => {
    report.availability = "incomplete";
    if (report.blockers.length < 200) report.blockers.push({ code, reason, ...scope });
  };
  const cache = new Map<string, Promise<unknown>>();
  const read = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const prior = cache.get(key);
    if (prior) return prior as Promise<T>;
    if (report.reads.performed >= LIMIT) return Promise.reject(new Error("assessment read bound"));
    report.reads.performed += 1;
    const result = operation();
    cache.set(key, result);
    return result;
  };
  const port: RecoveryReadStore = {
    readRef: (ref) => read(`ref:${ref}`, () => store.readRef(ref)),
    readCommit: (oid) => read(`commit:${oid}`, () => store.readCommit(oid)),
    readBlob: (oid) => read(`blob:${oid}`, () => store.readBlob(oid)),
    readTreeEntry: (oid, path) => read(`tree:${oid}:${path}`, () => store.readTreeEntry(oid, path)),
    listRefs: (prefix) => read(`refs:${prefix}`, () => store.listRefs(prefix)),
    readPullRequest: (number) => read(`pr:${number}`, () => store.readPullRequest(number)),
    getRepositoryFacts: () => read("repository", () => store.getRepositoryFacts()),
    getBranchHead: (branch) => read(`branch:${branch}`, () => store.getBranchHead(branch)),
    readBranchRules: (branch) => read(`rules:${branch}`, () => store.readBranchRules(branch)),
    readChecks: (sha) => read(`checks:${sha}`, () => store.readChecks(sha)),
    ...(store.readStack
      ? { readStack: (number: number) => read(`stack:${number}`, () => store.readStack!(number)) }
      : {}),
  };
  let events: FactoryEvent[] = [];
  const starts = new Map<string, Start>();
  const verifiedGraphs = new Map<string, Map<number, string>>();
  const graphParents = new Map<string, Map<number, string[]>>();
  const deliveryPlans = new Map<string, Extract<DeliveryPlan, { result: "supported" }>>();
  const reservations = new Map<string, Attempt>();
  const reservationKey = (runId: string, workItem: number, attempt: number) =>
    `${runId}:${workItem}:${attempt}`;
  let repositoryValid = false;
  let historyValid = true;
  let refsValid = true;
  let baseSha: string | undefined;
  const items = snapshot.workItems.slice(0, 100);
  try {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(snapshot.number) ||
      snapshot.number <= 0 ||
      !snapshot.id
    )
      throw new Error("identity");
    if (
      snapshot.workItems.length > 100 ||
      new Set(items.map((item) => item.number)).size !== items.length
    )
      throw new Error("cardinality");
    if (
      !Array.isArray(snapshot.factoryEvents) ||
      items.some(
        (item) =>
          !Array.isArray(item.factoryEvents) ||
          !Array.isArray(item.linkedPullRequests) ||
          !Array.isArray(item.copilotAssignments) ||
          typeof item.closed !== "boolean",
      )
    )
      throw new Error("incomplete observed history");
    const raw = [
      ...(snapshot.factoryEvents ?? []),
      ...items.flatMap((item) => item.factoryEvents ?? []),
    ];
    if (raw.length > 10_000) throw new Error("history bound");
    events = deduplicateFactoryEvents(raw.map(parseFactoryEvent)).sort(
      (a, b) => a.sequence - b.sequence,
    );
    for (const item of items) {
      if (
        (item.factoryEvents ?? []).some(
          (event) => "workItem" in event && event.workItem !== item.number,
        )
      )
        throw new Error("receipt issue binding");
    }
    const facts = await port.getRepositoryFacts();
    if (
      facts.fullName.toLowerCase() !== repository.toLowerCase() ||
      facts.defaultBranch !== snapshot.defaultBranch
    )
      throw new Error("repository mismatch");
    baseSha = (await port.getBranchHead(snapshot.defaultBranch)).oid;
    repositoryValid = true;
    for (const event of [...(snapshot.factoryEvents ?? [])].sort(
      (a, b) => a.sequence - b.sequence,
    )) {
      if (event.kind !== "run" || event.event !== "FactoryRunStarted") continue;
      const policy = parseRunPolicy(event.policy);
      if (
        event.objective !== snapshot.number ||
        event.repository.toLowerCase() !== repository.toLowerCase() ||
        event.baseBranch !== snapshot.defaultBranch ||
        event.fork !== facts.fork ||
        !snapshot.authorLogin ||
        event.objectiveAuthor.toLowerCase() !== snapshot.authorLogin.toLowerCase() ||
        policyDigest(policy) !== event.policyDigest
      )
        throw new Error("run binding");
      const previous = starts.get(event.runId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event))
        throw new Error("conflicting starts");
      starts.set(event.runId, event);
    }
    if (starts.size > 100) throw new Error("run bound");
    for (const start of starts.values()) {
      const terminals = events.filter(
        (event) => event.runId === start.runId && TERMINALS.has(event.event),
      );
      if (terminals.length > 1 || terminals.some((event) => event.sequence <= start.sequence))
        throw new Error("conflicting terminal history");
    }
    for (const event of events) {
      if (event.objective !== snapshot.number) throw new Error("foreign event");
      if (!EXECUTION_KINDS.has(event.kind) && event.kind !== "graph" && event.kind !== "budget")
        continue;
      const start = starts.get(event.runId);
      if (
        !start ||
        event.sequence <= start.sequence ||
        ("policyDigest" in event && event.policyDigest !== start.policyDigest)
      )
        throw new Error("unauthenticated evidence binding");
    }
  } catch {
    historyValid = false;
    block(
      "history-unavailable",
      "Repository identity or authenticated run history is incomplete, conflicting, or outside assessment bounds.",
    );
  }
  for (const start of starts.values()) {
    const runEvents = events.filter((event) => event.runId === start.runId);
    const terminal = runEvents.filter((event) => TERMINALS.has(event.event)).at(-1);
    const run: RecoveryRun = {
      runId: start.runId,
      state:
        terminal?.event === "FactoryRunCompleted"
          ? "completed"
          : terminal?.event === "FactoryRunCancelled"
            ? "cancelled"
            : terminal?.event === "FactoryRunEscalated"
              ? "escalated"
              : "active",
      policyDigest: start.policyDigest,
      graph: { status: "absent" },
    };
    report.runs.push(run);
    if (!historyValid) {
      run.graph.status = "unavailable";
      continue;
    }
    try {
      const graph = await loadCompiledGraph(port, snapshot.number, start.runId);
      const receipts = runEvents.filter(
        (event) => event.kind === "graph" && event.event === "GraphCompiled",
      );
      if (!graph) {
        if (receipts.length || runEvents.some((event) => EXECUTION_KINDS.has(event.kind)))
          throw new Error("missing graph");
        continue;
      }
      const receipt = receipts[0];
      if (
        receipts.length !== 1 ||
        receipt?.kind !== "graph" ||
        receipt.event !== "GraphCompiled" ||
        receipt.graphDigest !== graph.graphDigest ||
        receipt.graphSize !== graph.graphSize ||
        receipt.graphRef !== graph.ref ||
        receipt.graphBlobSha !== graph.blobOid
      )
        throw new Error("graph binding");
      const graphCommit = await port.readCommit(graph.commitOid);
      if (
        graphCommit.parentOids.length !== 1 ||
        graphCommit.parentOids[0] !== receipt.baseSha ||
        graph.objective.workItems.some((item) => item.baseSha !== receipt.baseSha)
      )
        throw new Error("graph base binding");
      const projection = await loadCompiledGraphProjection(
        port,
        snapshot.number,
        start.runId,
        graph,
      );
      if (!projection) throw new Error("missing projection");
      assertAuthenticatedGraphProjection(events, snapshot.number, start.runId, projection);
      const current = {
        workItems: items.map((item) => {
          if (!item.id || !item.title || item.body === undefined || item.blockedBy === undefined)
            throw new Error("incomplete projection");
          return {
            id: item.id,
            number: item.number,
            title: item.title,
            body: item.body,
            blockedBy: item.blockedBy,
          };
        }),
      };
      assertSnapshotMatchesCompiledGraph(graph.objective, current, projection.bindings);
      const selections = runEvents.filter((event) => event.kind === "delivery");
      if (selections.length > 1) throw new Error("conflicting delivery selection");
      const selection = selections[0];
      if (selection?.kind === "delivery" && selection.selected === "native-stacks") {
        if (
          selection.requested !== "stacked-prs" ||
          start.policy.delivery?.mode !== "stacked-prs" ||
          selection.sequence <= start.sequence
        )
          throw new Error("native delivery authority");
        const planned = planDelivery(
          graph.objective.workItems.map((item) => {
            if (!item.delivery) throw new Error("missing native delivery hint");
            return {
              id: item.id,
              dependsOn: item.dependsOn,
              delivery: {
                group: item.delivery.group,
                relationship: item.delivery.relationship,
                ...(item.delivery.parentWorkItem
                  ? { parentWorkItem: item.delivery.parentWorkItem }
                  : {}),
              },
            };
          }),
        );
        if (planned.result !== "supported") throw new Error("unsupported delivery plan");
        deliveryPlans.set(start.runId, planned);
      }
      verifiedGraphs.set(
        start.runId,
        new Map(projection.bindings.map((binding) => [binding.issueNumber, binding.compilerId])),
      );
      graphParents.set(
        start.runId,
        new Map(
          projection.bindings.map((binding) => [
            binding.issueNumber,
            graph.objective.workItems.find((item) => item.id === binding.compilerId)!.dependsOn,
          ]),
        ),
      );
      run.graph = {
        status: "verified",
        digest: graph.graphDigest,
        ref: graph.ref,
        projectionRef: projection.ref,
      };
    } catch {
      run.graph.status = "unavailable";
      block(
        "graph-unavailable",
        "Immutable graph, authenticated projection, or exact current issue mapping is unavailable or inconsistent.",
        { runId: start.runId },
      );
    }
  }
  try {
    if (!Number.isSafeInteger(snapshot.number) || snapshot.number <= 0) throw new Error("identity");
    const refs = await port.listRefs(
      `refs/clockgrove-factory/attempts/objective-${snapshot.number}/`,
    );
    if (refs.length > 1_000) throw new Error("reservation bound");
    for (const ref of refs) {
      let reservation: Attempt | undefined;
      try {
        const commit = await port.readCommit(ref.oid);
        const trailer = decodeEventTrailer(commit.message);
        if (trailer?.kind !== "attempt" || trailer.event !== "AttemptReserved")
          throw new Error("reservation trailer");
        reservation = trailer;
        const start = starts.get(trailer.runId);
        const receipt = events.find(
          (event) =>
            event.kind === "attempt" &&
            event.event === "AttemptReserved" &&
            event.runId === trailer.runId &&
            event.workItem === trailer.workItem &&
            event.attempt === trailer.attempt,
        );
        if (
          !historyValid ||
          !start ||
          !receipt ||
          JSON.stringify(receipt) !== JSON.stringify(trailer) ||
          trailer.objective !== snapshot.number ||
          trailer.policyDigest !== start.policyDigest ||
          ref.ref !== attemptRef(snapshot.number, trailer.workItem, trailer.attempt) ||
          commit.oid !== ref.oid ||
          commit.parentOids.length !== 1 ||
          commit.parentOids[0] !== trailer.baseSha
        )
          throw new Error("reservation binding");
        const base = await port.readCommit(trailer.baseSha);
        if (
          base.treeOid !== commit.treeOid ||
          !verifiedGraphs.get(trailer.runId)?.has(trailer.workItem)
        )
          throw new Error("reservation graph or base");
        const key = reservationKey(trailer.runId, trailer.workItem, trailer.attempt);
        if (reservations.has(key)) throw new Error("duplicate reservation");
        reservations.set(key, trailer);
      } catch {
        refsValid = false;
        if (report.orphanReservations.length < 100)
          report.orphanReservations.push({
            ref: /^refs\/clockgrove-factory\/attempts\/objective-\d+\/work-item-\d+\/attempt-\d+$/.test(
              ref.ref,
            )
              ? ref.ref.slice(0, 300)
              : "unrecognized-reservation-ref",
            ...(reservation ? { runId: reservation.runId, workItem: reservation.workItem } : {}),
            reason:
              "Reservation ref lacks matching authenticated history, immutable base, or current graph binding; resource ownership cannot be inferred.",
          });
      }
    }
    if (!refsValid)
      block(
        "reservation-unbound",
        "One or more reservation refs cannot be authenticated against their source run and current issue projection.",
      );
  } catch {
    refsValid = false;
    block(
      "reservation-unavailable",
      "Complete Objective reservation enumeration is unavailable or exceeds the assessment bound.",
    );
  }
  for (const item of items) {
    const assessment: RecoveryWorkItem = {
      number: item.number,
      classification: "blocked",
      requiresRevalidation: false,
      resourceState: "not-observed",
      resourceReconciliationRequired: false,
      reasons: [],
    };
    report.workItems.push(assessment);
    const itemEvents = events.filter(
      (event) => "workItem" in event && event.workItem === item.number,
    );
    const attemptEvents = itemEvents.filter((event): event is Attempt => event.kind === "attempt");
    if (attemptEvents.length || (item.copilotAssignments?.length ?? 0) > 0) {
      assessment.resourceState = "unavailable";
      assessment.resourceReconciliationRequired = true;
      assessment.reasons.push(
        "No provider or local process cleanup is inferred from GitHub execution receipts; resource reconciliation remains required.",
      );
    }
    let stage = "history";
    try {
      if (!repositoryValid || !historyValid || !refsValid) throw new Error("history");
      stage = "graph";
      const latest = attemptEvents.at(-1);
      const source = latest?.runId ?? [...verifiedGraphs.keys()].at(-1);
      if (!source || !verifiedGraphs.get(source)?.has(item.number)) throw new Error("graph");
      assessment.runId = source;
      if (!latest) {
        if (item.closed || item.linkedPullRequests === undefined || item.linkedPullRequests.length)
          throw new Error("unbound prior delivery");
        assessment.classification = assessment.resourceReconciliationRequired
          ? "reconciliation-required"
          : "unfinished";
        assessment.reasons.push(
          "No authenticated artifact or publication is available for this exact graph member.",
        );
        continue;
      }
      assessment.attempt = latest.attempt;
      stage = "reservation";
      const reservation = reservations.get(reservationKey(source, item.number, latest.attempt));
      if (!reservation) throw new Error("missing reservation");
      const sameAttempt = itemEvents.filter(
        (event) => event.runId === source && "attempt" in event && event.attempt === latest.attempt,
      );
      stage = "artifact";
      const publication = sameAttempt
        .filter((event) => event.kind === "publication" && event.event === "PublicationRecorded")
        .at(-1);
      if (
        publication &&
        sameAttempt.some(
          (event) =>
            event.kind === "publication" &&
            event.sequence > publication.sequence &&
            [
              "ValidationInvalidated",
              "IntegrationPending",
              "IntegrationFailed",
              "IntegrationCancelled",
              "IntegrationRolledBack",
            ].includes(event.event),
        )
      ) {
        assessment.requiresRevalidation = true;
        throw new RecoveryEvidenceError(
          "publication-unresolved",
          "Publication was invalidated or integration remains pending/failed; reconcile delivery and revalidate affected heads before reuse.",
        );
      }
      const validation = sameAttempt
        .filter((event) => event.kind === "validation" && event.event === "ValidationRecorded")
        .at(-1);
      const accepted = sameAttempt
        .filter((event) => event.kind === "attempt" && event.event === "AttemptValidated")
        .at(-1);
      const collected = sameAttempt
        .filter((event) => event.kind === "attempt" && Boolean(event.artifactDigest))
        .at(-1);
      const digest = collected?.kind === "attempt" ? collected.artifactDigest : undefined;
      if (digest) assessment.artifactDigest = digest;
      if (
        !validation ||
        validation.kind !== "validation" ||
        !validation.passed ||
        !accepted ||
        !digest
      ) {
        if ((item.linkedPullRequests?.length ?? 0) || publication)
          throw new Error("publication validation missing");
        assessment.classification = "reconciliation-required";
        assessment.reasons.push(
          "Execution was reserved or observed without a complete validated, semantically accepted durable artifact.",
        );
        continue;
      }
      const branch =
        publication?.kind === "publication"
          ? publication.branch
          : publicationBranch(snapshot.number, item.number, latest.attempt);
      const head =
        publication?.kind === "publication"
          ? publication.headSha
          : await port.readRef(`refs/heads/${branch}`);
      if (!head) {
        assessment.classification = "reconciliation-required";
        assessment.reasons.push(
          "The validated artifact has no observable durable commit; local or provider collection must be reconciled.",
        );
        continue;
      }
      const commit = await port.readCommit(head);
      if (commit.parentOids.length !== 1) {
        assessment.requiresRevalidation = true;
        throw new RecoveryEvidenceError(
          "commit-parentage-unsupported",
          "Multi-parent or parentless publication ancestry is not proven by this assessment; independent ancestry and validation reconciliation are required.",
        );
      }
      if (
        commit.oid !== head ||
        commit.parentOids.length !== 1 ||
        commit.parentOids[0] !== validation.baseSha ||
        commit.treeOid !== validation.outputTreeSha
      )
        throw new Error("commit identity");
      stage = "semantic-review";
      if (accepted.kind !== "attempt" || accepted.artifactDigest !== digest)
        throw new Error("stale acceptance");
      const reviewIdentity: ReviewIdentity = {
        kind: "artifact",
        runId: source,
        objective: snapshot.number,
        workItem: item.number,
        attempt: latest.attempt,
        artifactDigest: digest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.evidenceDigest,
      };
      const review =
        (await loadReviewCheckpoint(port, reviewIdentity)) ??
        (await loadReviewCheckpoint(port, { ...reviewIdentity, kind: "rebase", headSha: head }));
      if (!review || !review.review.accepted || review.review.unmetCriteria.length)
        throw new Error("semantic acceptance checkpoint");
      if (review.identity.kind === "artifact" && accepted.sequence <= validation.sequence)
        throw new Error("stale artifact acceptance");
      const reviewCommit = await port.readCommit(review.commitOid);
      if (reviewCommit.parentOids.length !== 1 || reviewCommit.parentOids[0] !== validation.baseSha)
        throw new Error("review commit base");
      const usageId = `${review.identity.kind === "rebase" ? "rebase-review" : "review"}-${review.identityDigest}`;
      const reviewUsage = sameAttempt.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === usageId,
      );
      const reviewTokens = review.usage.inputTokens + review.usage.outputTokens;
      if (
        !Number.isSafeInteger(reviewTokens) ||
        !reviewUsage.length ||
        reviewUsage.some(
          (event) =>
            event.amount !== reviewTokens ||
            event.sequence >=
              (review.identity.kind === "rebase"
                ? (publication?.sequence ?? accepted.sequence)
                : accepted.sequence),
        )
      )
        throw new Error("review receipt binding");
      const managed = reservation.backend.endsWith("/github-managed");
      if (
        !managed &&
        review.identity.kind !== "rebase" &&
        (!commit.message.split(/\r?\n/).includes(`Factory-Artifact: ${digest}`) ||
          !commit.message
            .split(/\r?\n/)
            .includes(`Factory-Validation: ${validation.evidenceDigest}`))
      )
        throw new Error("artifact trailers");
      assessment.headSha = head;
      assessment.baseSha = validation.baseSha;
      assessment.requiresRevalidation = validation.baseSha !== baseSha;
      if (!publication || publication.kind !== "publication") {
        if (item.linkedPullRequests === undefined || item.linkedPullRequests.length || item.closed)
          throw new Error("partial publication ambiguous");
        assessment.classification = "recoverable-artifact";
        assessment.reasons.push(
          "A pinned, independently validated commit is available; it has not been adopted or published by a successor.",
        );
        if (assessment.requiresRevalidation)
          assessment.reasons.push(
            "The repository base advanced; scope, validation, and semantic review must be repeated against the new base.",
          );
        continue;
      }
      assessment.pullRequest = publication.pullRequest;
      stage = "publication";
      const binding = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: validation.evidenceDigest,
          baseSha: validation.baseSha,
          outputTreeSha: validation.outputTreeSha,
        },
        publishedHeadSha: head,
        publishedTreeSha: commit.treeOid,
        publishedBaseSha: publication.baseSha,
      });
      if (
        publication.itemId !== verifiedGraphs.get(source)?.get(item.number) ||
        publication.sequence <= accepted.sequence ||
        publication.validationDigest !== validation.evidenceDigest ||
        publication.exactHeadValidationDigest !== binding.digest
      )
        throw new Error("exact publication binding");
      if (publication.mode === "native-stacks" && publication.position > 0) {
        const parents = graphParents.get(source)?.get(item.number);
        if (parents?.length !== 1 || parents[0] !== publication.parentItemId)
          throw new RecoveryEvidenceError(
            "stack-parent-mismatch",
            "Native stack parent does not match the immutable Work Item dependency.",
          );
      }
      let delivery: { unit: DeliveryUnit; item: DeliveryItemPlan } | undefined;
      if (publication.mode === "native-stacks") {
        const planned = deliveryPlans.get(source);
        const deliveryItem = planned?.items.find(
          (candidate) => candidate.itemId === publication.itemId,
        );
        const unit = planned?.units.find((candidate) => candidate.id === deliveryItem?.unitId);
        const selection = events.find(
          (event) => event.kind === "delivery" && event.runId === source,
        );
        if (
          !unit ||
          !deliveryItem ||
          selection?.kind !== "delivery" ||
          selection.sequence >= publication.sequence ||
          selection.capabilityVersion !== publication.capabilityVersion ||
          deliveryItem.unitId !== publication.unitId ||
          deliveryItem.position !== publication.position ||
          deliveryItem.parentItemId !== publication.parentItemId
        ) {
          throw new RecoveryEvidenceError(
            "delivery-plan-mismatch",
            "Native publication does not match the authenticated delivery selection and immutable graph-derived unit.",
          );
        }
        delivery = { unit, item: deliveryItem };
      }
      await inspectPublication(
        item,
        assessment,
        publication,
        port,
        repository,
        snapshot.defaultBranch,
        baseSha,
        events,
        delivery,
      );
    } catch (error) {
      assessment.classification = "blocked";
      const code = error instanceof RecoveryEvidenceError ? error.code : `${stage}-unavailable`;
      const reason =
        error instanceof RecoveryEvidenceError
          ? error.message
          : `The ${stage} evidence is missing, conflicting, changed, or unreadable; verify that evidence before requesting successor recovery.`;
      assessment.blockerCode = code;
      assessment.reasons.push(reason);
      block(code, reason, {
        workItem: item.number,
        ...(assessment.runId ? { runId: assessment.runId } : {}),
      });
    }
  }
  const selectedStarts = [...starts.values()];
  const policy = selectedStarts.at(-1)?.policy;
  if (
    historyValid &&
    policy &&
    selectedStarts.every(
      (start) => report.runs.find((run) => run.runId === start.runId)?.state !== "active",
    )
  ) {
    report.accounting = assessRecoveryAccounting({
      objective: snapshot.number,
      repository,
      events,
      runIds: selectedStarts.map((start) => start.runId),
      policy,
    });
    for (const blocker of report.accounting.blockers)
      block(`accounting-${blocker.code}`, blocker.reason, {
        ...(blocker.runId ? { runId: blocker.runId } : {}),
        ...(blocker.workItem ? { workItem: blocker.workItem } : {}),
      });
  }
  if (report.reads.performed >= LIMIT)
    block(
      "read-bound",
      "Assessment reached its read limit; unavailable evidence must not be treated as absent.",
    );
  return report;
}

async function inspectPublication(
  item: ReadWorkItemSnapshot,
  assessment: RecoveryWorkItem,
  publication: Extract<FactoryEvent, { kind: "publication" }>,
  port: RecoveryReadStore,
  repository: string,
  defaultBranch: string,
  baseSha: string | undefined,
  events: readonly FactoryEvent[],
  delivery: { unit: DeliveryUnit; item: DeliveryItemPlan } | undefined,
): Promise<void> {
  const linked = item.linkedPullRequests?.filter((pull) => pull.number === publication.pullRequest);
  if (
    linked?.length !== 1 ||
    item
      .linkedPullRequests!.filter((pull) => pull.state === "OPEN")
      .some((pull) => pull.number !== publication.pullRequest)
  )
    throw new RecoveryEvidenceError(
      "linked-pr-mismatch",
      "The Work Item does not have exactly one matching publication link, or another open PR makes recovery ambiguous.",
    );
  const pull = await port.readPullRequest(publication.pullRequest);
  if (
    pull.number !== publication.pullRequest ||
    !pull.nodeId ||
    pull.nodeId !== linked[0]!.id ||
    pull.baseRepository?.toLowerCase() !== repository.toLowerCase() ||
    pull.headRepository?.toLowerCase() !== repository.toLowerCase() ||
    !pull.headRef ||
    (!publication.branch.startsWith("github-managed/") && pull.headRef !== publication.branch)
  )
    throw new RecoveryEvidenceError(
      "pr-identity-mismatch",
      "Current PR number, node, repository, or source branch differs from its authenticated publication binding.",
    );
  if (
    pull.headSha !== publication.headSha ||
    pull.baseSha !== publication.baseSha ||
    pull.baseRef !== publication.baseBranch
  ) {
    assessment.requiresRevalidation = true;
    throw new RecoveryEvidenceError(
      "pr-head-base-changed",
      "PR head or base changed since validation. Revalidation is required; merged PRs whose historical base cannot be proven remain blocked rather than assumed integrated.",
    );
  }
  if (
    linked[0]!.headSha !== pull.headSha ||
    (pull.merged ? linked[0]!.state !== "MERGED" : linked[0]!.state.toLowerCase() !== pull.state)
  )
    throw new RecoveryEvidenceError(
      "pr-observation-changed",
      "PR linkage snapshot and current PR head or state disagree; re-read before planning recovery.",
    );
  if (publication.mode === "native-stacks" && delivery?.unit.kind === "stack") {
    if (!publication.stackNumber || !port.readStack)
      throw new RecoveryEvidenceError(
        "stack-unavailable",
        "Current native-stack membership cannot be observed through the read-only store.",
      );
    const stack = await port.readStack(publication.stackNumber);
    const position = stack.pullRequests.findIndex(
      (member) => member.number === publication.pullRequest,
    );
    const member = stack.pullRequests[position];
    if (
      stack.number !== publication.stackNumber ||
      position !== publication.position ||
      !member ||
      member.headSha !== pull.headSha ||
      member.headRef !== pull.headRef ||
      member.baseSha !== pull.baseSha ||
      member.baseRef !== pull.baseRef ||
      member.draft !== pull.draft ||
      (!pull.merged && (!stack.open || member.state.toLowerCase() !== pull.state)) ||
      stack.baseRef !== defaultBranch
    )
      throw new RecoveryEvidenceError(
        "stack-topology-mismatch",
        "Current stack membership, position, head, base, or state differs from the authenticated publication.",
      );
    if (position > 0 && stack.pullRequests[position - 1]?.headRef !== pull.baseRef)
      throw new RecoveryEvidenceError(
        "stack-parent-mismatch",
        "Current stack predecessor is not the PR's recorded base branch.",
      );
    if (
      position > 0 &&
      !events.some(
        (event) =>
          event.kind === "publication" &&
          event.event === "PublicationRecorded" &&
          event.runId === publication.runId &&
          event.unitId === publication.unitId &&
          event.itemId === publication.parentItemId &&
          event.pullRequest === stack.pullRequests[position - 1]!.number &&
          event.headSha === stack.pullRequests[position - 1]!.headSha,
      )
    ) {
      throw new RecoveryEvidenceError(
        "stack-parent-unbound",
        "The observed stack predecessor lacks a matching authenticated source publication.",
      );
    }
  } else if (
    publication.mode === "native-stacks" &&
    (delivery?.unit.kind !== "sibling" ||
      publication.position !== 0 ||
      publication.parentItemId !== undefined ||
      publication.stackNumber !== undefined ||
      delivery.unit.items.length !== 1 ||
      pull.baseRef !== defaultBranch)
  ) {
    throw new RecoveryEvidenceError(
      "sibling-delivery-mismatch",
      "Independent native-mode sibling must match its single-item unit and default-branch base without a stack identity.",
    );
  } else if (pull.baseRef !== defaultBranch)
    throw new RecoveryEvidenceError(
      "ordinary-base-mismatch",
      "Ordinary publication no longer targets the recorded default branch.",
    );
  if (pull.merged) {
    if (!pull.mergeCommitSha || !item.closed)
      throw new RecoveryEvidenceError(
        "integration-incomplete",
        "PR merge identity or Work Item closure is missing; do not mark this work integrated.",
      );
    const merge = await port.readCommit(pull.mergeCommitSha);
    if (
      merge.oid !== pull.mergeCommitSha ||
      merge.treeOid !== (await port.readCommit(publication.headSha)).treeOid
    )
      throw new RecoveryEvidenceError(
        "merge-tree-mismatch",
        "Observed merge commit does not match the independently validated publication tree.",
      );
    assessment.classification = "already-integrated";
    assessment.requiresRevalidation = false;
    assessment.reasons.push(
      "Exact publication and merge tree plus issue closure are observed; provider cleanup and successor authority remain separate.",
    );
    return;
  }
  if (
    pull.state !== "open" ||
    item.closed ||
    pull.draft ||
    pull.mergeable !== true ||
    (pull.baseSha !== baseSha &&
      (publication.mode === "regular-prs" || delivery?.unit.kind === "sibling"))
  )
    throw new RecoveryEvidenceError(
      "delivery-not-ready",
      "PR is closed without merge, draft, unmergeable, paired with a closed issue, or based on an advanced trunk; reconcile delivery before reuse.",
    );
  if (linked[0]!.checks === "FAILURE")
    throw new RecoveryEvidenceError(
      "checks-failed",
      "Observed PR check suites include a failure, even when no check run or status was created; resolve the failed suite before reuse.",
    );
  if (linked[0]!.checks === "PENDING")
    throw new RecoveryEvidenceError(
      "checks-pending",
      "Observed PR check suites remain pending, even when no check run or status exists; wait for a terminal suite result before reuse.",
    );
  if (linked[0]!.checks !== null && linked[0]!.checks !== "SUCCESS")
    throw new RecoveryEvidenceError(
      "checks-unavailable",
      "The linked PR check-suite rollup was not observed; missing check evidence is not equivalent to no checks.",
    );
  const rules = await port.readBranchRules(defaultBranch);
  const checks = await port.readChecks(pull.headSha);
  if (branchRuleBlockers(rules).length)
    throw new RecoveryEvidenceError(
      "branch-policy-blocked",
      "Current branch policy requires human action or has unsupported rules.",
    );
  if (checks.failed.length)
    throw new RecoveryEvidenceError(
      "checks-failed",
      "Current PR checks include failures; optional external review does not bypass them.",
    );
  if (checks.pending.length)
    throw new RecoveryEvidenceError(
      "checks-pending",
      "Current PR checks are still pending; completed validation is not established.",
    );
  if (missingRequiredChecks(rules, checks).length)
    throw new RecoveryEvidenceError(
      "required-checks-missing",
      "Required branch checks have no matching observed result for this head.",
    );
  assessment.classification = "reusable-publication";
  assessment.reasons.push(
    "Unchanged publication, validation, checks, and current topology are observed; candidate evidence only, not adopted or executable.",
  );
}
