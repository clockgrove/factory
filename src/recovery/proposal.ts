import type { FactoryReadSnapshot } from "../application/status.js";
import { attemptRef } from "../control/attempts.js";
import {
  assertAuthenticatedGraphProjection,
  assertSnapshotMatchesCompiledGraph,
} from "../control/graph-evidence.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { loadReviewCheckpoint, type ReviewIdentity } from "../control/reviews.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { parseRunPolicy, policyDigest } from "../protocol/policy.js";
import { planDelivery } from "../publication/delivery.js";
import { branchRuleBlockers, missingRequiredChecks } from "../publication/branch-policy.js";
import { publicationBranch } from "../publication/publisher.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import { assessRecoveryAccounting } from "./accounting.js";
import type { RecoveryBlocker, RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import { recoveryUnknownUsageDigest, verifyRecoveryChain } from "./chain.js";
import { recoveryClaimRef, recoveryEventDigest, recoverySourceEventsDigest } from "./identity.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  loadRecoveryPlan,
  parseRecoveryPlan,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  type RecoveryAllowance,
  type RecoveryAllowanceIncrement,
  type RecoveryHistoryEntry,
  type RecoveryPlan,
  type RecoveryPlanItem,
  type RecoveryPlanRecord,
} from "./plan.js";

export const RECOVERY_PROPOSAL_READ_LIMIT = 512;
export interface RecoveryProposalResult {
  status: "proposed" | "blocked";
  executionAuthorized: false;
  plan: RecoveryPlan | null;
  planDigest: string | null;
  /** An observed acknowledgement identity, never an automatic acknowledgement. */
  unknownUsageDigest: string | null;
  blockers: RecoveryBlocker[];
  reads: { performed: number; limit: number };
}
type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Reserved = Extract<FactoryEvent, { kind: "attempt" }>;
const TERMINALS = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const EXECUTION = new Set(["attempt", "capacity", "validation", "publication", "budget", "graph"]);
const ZERO_INCREMENT: RecoveryAllowanceIncrement = {
  modelTokens: 0,
  sandboxMinutes: 0,
  managedSessions: 0,
  implementationAttemptsPerItem: 0,
};
const allowanceFor = (start: Start): RecoveryAllowance => ({
  modelTokens: start.policy.economics?.maxModelTokens ?? null,
  sandboxMinutes: start.policy.maxSandboxMinutes,
  managedSessions: start.policy.maxManagedAgentSessions,
  implementationAttemptsPerItem: start.policy.maxAttemptsPerItem,
});

/**
 * Builds a proposal only from complete GitHubReader-authenticated history and read ports.
 * There is deliberately no policy override, item-action override, resource verdict, writer,
 * worker, or model hook. The caller must separately persist and acknowledge this exact plan.
 */
export async function buildRecoveryProposal(input: {
  repository: string;
  snapshot: FactoryReadSnapshot;
  historyComplete: boolean;
  store: RecoveryReadStore;
  requestId: string;
  successorRunId: string;
  allowanceIncrement?: RecoveryAllowanceIncrement;
  unknownUsageAcknowledgementDigest?: string | null;
}): Promise<RecoveryProposalResult> {
  const result: RecoveryProposalResult = {
    status: "blocked",
    executionAuthorized: false,
    plan: null,
    planDigest: null,
    unknownUsageDigest: null,
    blockers: [],
    reads: { performed: 0, limit: RECOVERY_PROPOSAL_READ_LIMIT },
  };
  let stage = "input";
  let currentWorkItem: number | undefined;
  function require(condition: unknown): asserts condition {
    if (!condition) throw new Error("unavailable evidence");
  }
  const cache = new Map<string, Promise<unknown>>();
  let bytesRead = 0;
  const read = <T>(name: string, args: unknown[], operation: () => Promise<T>): Promise<T> => {
    const key = JSON.stringify([name, args]);
    const existing = cache.get(key);
    if (existing) return existing as Promise<T>;
    if (result.reads.performed >= RECOVERY_PROPOSAL_READ_LIMIT) {
      stage = "read-bound";
      throw new Error("read bound");
    }
    result.reads.performed++;
    const pending = operation().then((value) => {
      bytesRead += Buffer.isBuffer(value)
        ? value.byteLength
        : Buffer.byteLength(JSON.stringify(value));
      if (bytesRead > 32 * 1024 * 1024) {
        stage = "read-byte-bound";
        throw new Error("byte bound");
      }
      return value;
    });
    cache.set(key, pending);
    return pending;
  };
  const port: RecoveryReadStore = {
    readRef: (ref) => read("ref", [ref], () => input.store.readRef(ref)),
    readCommit: (oid) => read("commit", [oid], () => input.store.readCommit(oid)),
    readBlob: (oid) => read("blob", [oid], () => input.store.readBlob(oid)),
    readTreeEntry: (tree, path) =>
      read("entry", [tree, path], () => input.store.readTreeEntry(tree, path)),
    listRefs: (prefix) => read("refs", [prefix], () => input.store.listRefs(prefix)),
    readPullRequest: (number) => read("pull", [number], () => input.store.readPullRequest(number)),
    getRepositoryFacts: () => read("facts", [], () => input.store.getRepositoryFacts()),
    getBranchHead: (branch) => read("base", [branch], () => input.store.getBranchHead(branch)),
    readBranchRules: (branch) => read("rules", [branch], () => input.store.readBranchRules(branch)),
    readChecks: (head) => read("checks", [head], () => input.store.readChecks(head)),
    ...(input.store.readStack
      ? {
          readStack: (number: number) =>
            read("stack", [number], () => input.store.readStack!(number)),
        }
      : {}),
  };
  try {
    const { snapshot, repository } = input;
    require(
      input.historyComplete === true &&
        /^[\w.-]+\/[\w.-]+$/.test(repository) &&
        snapshot.repositoryId &&
        snapshot.id &&
        snapshot.defaultBranch &&
        !snapshot.closed &&
        Array.isArray(snapshot.factoryEvents) &&
        Array.isArray(snapshot.workItems) &&
        snapshot.workItems.length > 0 &&
        snapshot.workItems.length <= 100,
    );
    for (const item of snapshot.workItems)
      require(
        item.id &&
          item.title &&
          item.body !== undefined &&
          Array.isArray(item.blockedBy) &&
          Array.isArray(item.factoryEvents) &&
          Array.isArray(item.linkedPullRequests) &&
          Array.isArray(item.copilotAssignments),
      );
    const raw = [
      ...snapshot.factoryEvents,
      ...snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ];
    require(raw.length <= 50_000 && Buffer.byteLength(JSON.stringify(raw)) <= 16 * 1024 * 1024);
    stage = "history";
    const events = deduplicateFactoryEvents(raw.map(parseFactoryEvent)).sort(
      (a, b) => a.sequence - b.sequence,
    );
    require(events.every((event) => event.objective === snapshot.number));
    const starts = events.filter((event): event is Start => event.event === "FactoryRunStarted");
    require(
      starts.length > 0 &&
        starts.length <= 100 &&
        new Set(starts.map((start) => start.runId)).size === starts.length,
    );
    const byRun = new Map(starts.map((start) => [start.runId, start]));
    require(!byRun.has(input.successorRunId));
    const history: RecoveryHistoryEntry[] = starts.map((start) => {
      const terminals = events.filter(
        (event) => event.runId === start.runId && TERMINALS.has(event.event),
      );
      require(
        terminals.length === 1 &&
          terminals[0]!.sequence > start.sequence &&
          start.repository.toLowerCase() === repository.toLowerCase() &&
          start.policyDigest === policyDigest(start.policy) &&
          start.baseBranch === snapshot.defaultBranch,
      );
      const terminal = terminals[0]!;
      return {
        runId: start.runId,
        startDigest: recoveryEventDigest(start),
        terminalDigest: recoveryEventDigest(terminal),
        terminalEvent: terminal.event as RecoveryHistoryEntry["terminalEvent"],
        terminalSequence: terminal.sequence,
        policyDigest: start.policyDigest,
      };
    });
    require(
      history.every(
        (entry, index) =>
          index === 0 || entry.terminalSequence > history[index - 1]!.terminalSequence,
      ),
    );
    require(
      events.every(
        (event) =>
          !EXECUTION.has(event.kind) ||
          (byRun.has(event.runId) && event.sequence > byRun.get(event.runId)!.sequence),
      ),
    );
    for (const item of snapshot.workItems)
      require(
        item.factoryEvents!.every(
          (event) => !("workItem" in event) || event.workItem === item.number,
        ),
      );
    const predecessorStart = starts.at(-1)!;
    const { policyDigest: _sourcePolicyDigest, ...predecessor } = history.at(-1)!;
    stage = "repository";
    const facts = await port.getRepositoryFacts();
    require(
      facts.fullName.toLowerCase() === repository.toLowerCase() &&
        facts.defaultBranch === snapshot.defaultBranch &&
        starts.every((start) => start.fork === facts.fork),
    );
    const base = await port.getBranchHead(snapshot.defaultBranch);
    require((await port.readCommit(base.oid)).oid === base.oid);

    stage = "prior-plan-chain";
    const priorPlans: Record<string, RecoveryPlanRecord> = {};
    const priorDigest: string | null = predecessorStart.recoveryPlanDigest ?? null;
    let cursor = priorDigest;
    while (cursor) {
      require(!priorPlans[cursor] && Object.keys(priorPlans).length < 100);
      const record = await loadRecoveryPlan(port, snapshot.number, cursor);
      require(record);
      priorPlans[cursor] = record;
      cursor = record.plan.priorPlanDigest;
    }
    const claims: RecoveryClaimRecord[] = [];
    const observedClaims = await port.listRefs(
      `refs/clockgrove-factory/recovery-claims/objective-${snapshot.number}/`,
    );
    require(
      observedClaims.length <= 100 &&
        new Set(observedClaims.map((entry) => entry.ref)).size === observedClaims.length,
    );
    for (const observed of observedClaims) {
      const start = starts.find(
        (candidate) => recoveryClaimRef(snapshot.number, candidate.runId) === observed.ref,
      );
      require(start);
      const claim = await loadRecoveryClaim(port, snapshot.number, start.runId);
      require(claim && claim.oid === observed.oid);
      claims.push(claim);
    }
    // Probe every named predecessor too: an incomplete prefix response must not hide a claim.
    for (const start of starts)
      require(
        (await port.readRef(recoveryClaimRef(snapshot.number, start.runId))) ===
          (claims.find((claim) => claim.predecessorRunId === start.runId)?.oid ?? null),
      );

    stage = "graph";
    const graphs = new Map<
      string,
      {
        graph: NonNullable<Awaited<ReturnType<typeof loadCompiledGraph>>>;
        projection: NonNullable<Awaited<ReturnType<typeof loadCompiledGraphProjection>>>;
      }
    >();
    for (const start of starts) {
      const graph = await loadCompiledGraph(port, snapshot.number, start.runId);
      const runEvents = events.filter((event) => event.runId === start.runId);
      const compiled = runEvents.filter((event) => event.event === "GraphCompiled");
      if (!graph) {
        require(
          compiled.length === 0 &&
            !runEvents.some((event) =>
              ["attempt", "capacity", "validation", "publication"].includes(event.kind),
            ),
        );
        continue;
      }
      require(compiled.length === 1);
      const receipt = compiled[0]!;
      require(
        receipt.kind === "graph" &&
          receipt.event === "GraphCompiled" &&
          receipt.graphRef === graph.ref &&
          receipt.graphBlobSha === graph.blobOid &&
          receipt.graphDigest === graph.graphDigest &&
          receipt.graphSize === graph.graphSize,
      );
      const commit = await port.readCommit(graph.commitOid);
      require(
        commit.parentOids.length === 1 &&
          commit.parentOids[0] === receipt.baseSha &&
          graph.objective.workItems.every((item) => item.baseSha === receipt.baseSha),
      );
      const projection = await loadCompiledGraphProjection(
        port,
        snapshot.number,
        start.runId,
        graph,
      );
      require(projection);
      assertAuthenticatedGraphProjection(events, snapshot.number, start.runId, projection);
      assertSnapshotMatchesCompiledGraph(
        graph.objective,
        {
          workItems: snapshot.workItems.map((item) => ({
            id: item.id!,
            number: item.number,
            title: item.title!,
            body: item.body ?? null,
            blockedBy: item.blockedBy!,
          })),
        },
        projection.bindings,
      );
      graphs.set(start.runId, { graph, projection });
    }
    const graphSource = [...graphs.entries()].at(-1);
    require(graphSource);
    const [graphRunId, { graph, projection }] = graphSource;
    require([...graphs.values()].every((value) => value.graph.graphDigest === graph.graphDigest));

    stage = "reservation";
    const reservations = new Map<string, { event: Reserved; ref: string; oid: string }>();
    const refs = await port.listRefs(
      `refs/clockgrove-factory/attempts/objective-${snapshot.number}/`,
    );
    require(refs.length <= 1_000 && new Set(refs.map((entry) => entry.ref)).size === refs.length);
    for (const ref of refs) {
      const commit = await port.readCommit(ref.oid);
      const reserved = decodeEventTrailer(commit.message);
      require(
        reserved?.kind === "attempt" &&
          reserved.event === "AttemptReserved" &&
          reserved.objective === snapshot.number &&
          reserved.policyDigest === byRun.get(reserved.runId)?.policyDigest &&
          graphs.has(reserved.runId),
      );
      const matching = events.filter(
        (event) =>
          event.event === "AttemptReserved" &&
          event.runId === reserved.runId &&
          "workItem" in event &&
          event.workItem === reserved.workItem &&
          "attempt" in event &&
          event.attempt === reserved.attempt,
      );
      require(
        matching.length === 1 &&
          recoveryEventDigest(matching[0]!) === recoveryEventDigest(reserved) &&
          ref.ref === attemptRef(snapshot.number, reserved.workItem, reserved.attempt) &&
          (await port.readRef(ref.ref)) === ref.oid &&
          commit.oid === ref.oid &&
          commit.parentOids.length === 1 &&
          commit.parentOids[0] === reserved.baseSha &&
          commit.treeOid === (await port.readCommit(reserved.baseSha)).treeOid &&
          projection.bindings.some((binding) => binding.issueNumber === reserved.workItem),
      );
      reservations.set(`${reserved.workItem}:${reserved.attempt}`, {
        event: reserved,
        ref: ref.ref,
        oid: ref.oid,
      });
    }
    require(
      events
        .filter((event) => event.event === "AttemptReserved")
        .every(
          (event) =>
            "workItem" in event &&
            "attempt" in event &&
            reservations.get(`${event.workItem}:${event.attempt}`)?.event.runId === event.runId,
        ),
    );
    // Global attempt numbers are not cross-run authority. Every historical effect,
    // not just the latest selected artifact, must bind its own immutable reservation.
    for (const event of events) {
      if (!["attempt", "capacity", "validation", "publication"].includes(event.kind)) continue;
      const reservation = reservations.get(`${event.workItem}:${event.attempt}`)?.event;
      require(
        reservation &&
          reservation.runId === event.runId &&
          event.sequence >= reservation.sequence &&
          (!("policyDigest" in event) || event.policyDigest === reservation.policyDigest),
      );
      if (event.kind === "attempt")
        require(
          event.backend === reservation.backend &&
            event.baseSha === reservation.baseSha &&
            event.directorEpoch === reservation.directorEpoch,
        );
    }

    const items: RecoveryPlanItem[] = [];
    for (const binding of projection.bindings) {
      currentWorkItem = binding.issueNumber;
      stage = "item-history";
      const item = snapshot.workItems.find((value) => value.number === binding.issueNumber)!;
      const itemEvents = events.filter(
        (event) => "workItem" in event && event.workItem === item.number,
      );
      const selected = [...reservations.values()]
        .filter((value) => value.event.workItem === item.number)
        .sort((a, b) => a.event.attempt - b.event.attempt)
        .at(-1);
      const planItem: RecoveryPlanItem = {
        workItem: item.number,
        issueNodeId: binding.issueNodeId,
        compilerId: binding.compilerId,
        action: "execute",
        source: null,
        observedPullRequest: null,
        resources: { state: "not-required", receiptDigest: null, identities: [] },
      };
      items.push(planItem);
      if (!selected) {
        require(
          !item.closed &&
            item.copilotAssignments!.length === 0 &&
            item.linkedPullRequests!.length === 0 &&
            !itemEvents.some((event) => EXECUTION.has(event.kind)),
        );
        continue;
      }
      const reserved = selected.event;
      require(
        itemEvents.every(
          (event) =>
            !["attempt", "capacity", "validation", "publication"].includes(event.kind) ||
            ("attempt" in event && reservations.has(`${item.number}:${event.attempt}`)),
        ),
      );
      const sourceEvents = itemEvents.filter(
        (event) =>
          event.runId === reserved.runId &&
          "attempt" in event &&
          event.attempt === reserved.attempt,
      );
      require(
        sourceEvents.every(
          (event) =>
            event.sequence >= reserved.sequence &&
            (!("policyDigest" in event) || event.policyDigest === reserved.policyDigest) &&
            (event.kind !== "attempt" ||
              (event.backend === reserved.backend &&
                event.baseSha === reserved.baseSha &&
                event.directorEpoch === reserved.directorEpoch)),
        ),
      );
      const source: NonNullable<RecoveryPlanItem["source"]> = {
        runId: reserved.runId,
        attempt: reserved.attempt,
        reservationRef: selected.ref,
        reservationCommitOid: selected.oid,
        reservationReceiptDigest: recoveryEventDigest(reserved),
        artifactDigest: null,
        validation: null,
        review: null,
        publication: null,
      };
      planItem.source = source;
      planItem.action = "reconcile";
      planItem.resources = { state: "unknown", receiptDigest: null, identities: [] };
      const publication = sourceEvents
        .filter((event) => event.kind === "publication" && event.event === "PublicationRecorded")
        .at(-1);
      const validation = sourceEvents.filter((event) => event.kind === "validation").at(-1);
      const accepted = sourceEvents
        .filter((event) => event.kind === "attempt" && event.event === "AttemptValidated")
        .at(-1);
      const artifact = sourceEvents
        .filter((event) => event.kind === "attempt" && event.artifactDigest)
        .at(-1);
      if (artifact?.kind === "attempt" && artifact.artifactDigest)
        source.artifactDigest = artifact.artifactDigest;
      if (
        !validation ||
        validation.kind !== "validation" ||
        !validation.passed ||
        !source.artifactDigest
      ) {
        require(!publication && !item.closed && item.linkedPullRequests!.length === 0);
        continue;
      }
      stage = "artifact";
      const head =
        publication?.kind === "publication"
          ? publication.headSha
          : await port.readRef(
              `refs/heads/${publicationBranch(snapshot.number, item.number, reserved.attempt)}`,
            );
      if (!head) {
        require(!publication && !item.closed && item.linkedPullRequests!.length === 0);
        continue;
      }
      const commit = await port.readCommit(head);
      require(
        commit.oid === head &&
          commit.parentOids.length === 1 &&
          commit.parentOids[0] === validation.baseSha &&
          commit.treeOid === validation.outputTreeSha,
      );
      source.validation = {
        receiptDigest: recoveryEventDigest(validation),
        evidenceDigest: validation.evidenceDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
      };
      stage = "semantic-review";
      const identity: ReviewIdentity = {
        kind: "artifact",
        runId: reserved.runId,
        objective: snapshot.number,
        workItem: item.number,
        attempt: reserved.attempt,
        artifactDigest: source.artifactDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.evidenceDigest,
      };
      const review =
        (await loadReviewCheckpoint(port, identity)) ??
        (await loadReviewCheckpoint(port, { ...identity, kind: "rebase", headSha: head }));
      if (!review || !review.review.accepted || review.review.unmetCriteria.length) {
        require(!publication && !item.closed && item.linkedPullRequests!.length === 0);
        planItem.action = "revalidate";
        continue;
      }
      require(
        accepted?.kind === "attempt" &&
          accepted.artifactDigest === source.artifactDigest &&
          (review.identity.kind === "rebase" || accepted.sequence > validation.sequence),
      );
      const reviewCommit = await port.readCommit(review.commitOid);
      require(
        reviewCommit.parentOids.length === 1 && reviewCommit.parentOids[0] === validation.baseSha,
      );
      const usageId = `${review.identity.kind === "rebase" ? "rebase-review" : "review"}-${review.identityDigest}`;
      const usage = sourceEvents.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === usageId,
      );
      require(
        usage.length > 0 &&
          usage.every(
            (event) =>
              event.amount === review.usage.inputTokens + review.usage.outputTokens &&
              event.sequence <
                (review.identity.kind === "rebase"
                  ? (publication?.sequence ?? accepted.sequence)
                  : accepted.sequence),
          ),
      );
      source.review = {
        ref: review.ref,
        commitOid: review.commitOid,
        blobOid: review.blobOid,
        identityDigest: review.identityDigest,
      };
      if (!reserved.backend.endsWith("/github-managed") && review.identity.kind !== "rebase")
        require(
          commit.message.split(/\r?\n/).includes(`Factory-Artifact: ${source.artifactDigest}`) &&
            commit.message
              .split(/\r?\n/)
              .includes(`Factory-Validation: ${validation.evidenceDigest}`),
        );
      if (!publication || publication.kind !== "publication") {
        require(!item.closed && item.linkedPullRequests!.length === 0);
        planItem.action = validation.baseSha === base.oid ? "reuse-artifact" : "revalidate";
        continue;
      }
      stage = "publication";
      require(
        !sourceEvents.some(
          (event) => event.kind === "publication" && event.sequence > publication.sequence,
        ),
      );
      const exact = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: validation.evidenceDigest,
          baseSha: validation.baseSha,
          outputTreeSha: validation.outputTreeSha,
        },
        publishedBaseSha: publication.baseSha,
        publishedTreeSha: commit.treeOid,
        publishedHeadSha: publication.headSha,
      });
      require(
        publication.itemId === binding.compilerId &&
          publication.sequence > accepted.sequence &&
          publication.validationDigest === validation.evidenceDigest &&
          publication.exactHeadValidationDigest === exact.digest,
      );
      const linked = item.linkedPullRequests!.filter(
        (pull) => pull.number === publication.pullRequest,
      );
      require(
        linked.length === 1 &&
          !item.linkedPullRequests!.some(
            (pull) => pull.number !== publication.pullRequest && pull.state === "OPEN",
          ),
      );
      const pull = await port.readPullRequest(publication.pullRequest);
      require(
        pull.number === publication.pullRequest &&
          pull.nodeId === linked[0]!.id &&
          pull.headRef &&
          pull.baseRepository?.toLowerCase() === repository.toLowerCase() &&
          pull.headRepository?.toLowerCase() === repository.toLowerCase() &&
          pull.headSha === linked[0]!.headSha &&
          (pull.merged
            ? linked[0]!.state === "MERGED"
            : linked[0]!.state.toLowerCase() === pull.state) &&
          ["open", "closed"].includes(pull.state),
      );
      require(pull.headRef === publication.branch && pull.baseRef === publication.baseBranch);
      const observedHead = await port.readCommit(pull.headSha);
      require(observedHead.oid === pull.headSha);
      source.publication = {
        receiptDigest: recoveryEventDigest(publication),
        mode: publication.mode,
        pullRequest: publication.pullRequest,
        pullRequestNodeId: pull.nodeId!,
        branch: publication.branch,
        baseBranch: publication.baseBranch,
        baseSha: publication.baseSha,
        headSha: publication.headSha,
        baseRepository: pull.baseRepository!,
        headRepository: pull.headRepository!,
        stackNumber: publication.stackNumber ?? null,
      };
      planItem.observedPullRequest = {
        number: pull.number!,
        nodeId: pull.nodeId!,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        treeSha: observedHead.treeOid,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        headRepository: pull.headRepository!,
        baseRepository: pull.baseRepository!,
        state: pull.merged ? "merged" : (pull.state as "open" | "closed"),
      };
      stage = "delivery";
      if (publication.mode === "native-stacks") {
        const selections = events.filter(
          (event) => event.kind === "delivery" && event.runId === reserved.runId,
        );
        const selection = selections[0];
        require(
          selections.length === 1 &&
            selection?.kind === "delivery" &&
            selection.selected === "native-stacks" &&
            selection.requested === "stacked-prs" &&
            byRun.get(reserved.runId)!.policy.delivery?.mode === "stacked-prs" &&
            selection.sequence < publication.sequence &&
            selection.capabilityVersion === publication.capabilityVersion,
        );
        const delivery = planDelivery(
          graph.objective.workItems.map((entry) => {
            require(entry.delivery);
            return {
              id: entry.id,
              dependsOn: entry.dependsOn,
              delivery: {
                group: entry.delivery.group,
                relationship: entry.delivery.relationship,
                ...(entry.delivery.parentWorkItem
                  ? { parentWorkItem: entry.delivery.parentWorkItem }
                  : {}),
              },
            };
          }),
        );
        require(delivery.result === "supported");
        const planned = delivery.items.find((entry) => entry.itemId === publication.itemId);
        const unit = delivery.units.find((entry) => entry.id === planned?.unitId);
        require(
          planned &&
            unit &&
            planned.unitId === publication.unitId &&
            planned.position === publication.position &&
            planned.parentItemId === publication.parentItemId,
        );
        if (unit.kind === "stack") {
          require(publication.stackNumber && port.readStack);
          const stack = await port.readStack(publication.stackNumber);
          const member = stack.pullRequests[publication.position];
          require(
            stack.number === publication.stackNumber &&
              stack.baseRef === snapshot.defaultBranch &&
              (pull.merged || stack.open) &&
              member?.number === pull.number &&
              member.headSha === pull.headSha &&
              member.headRef === pull.headRef &&
              member.baseSha === pull.baseSha &&
              member.baseRef === pull.baseRef,
          );
          if (publication.position > 0)
            require(stack.pullRequests[publication.position - 1]?.headRef === pull.baseRef);
        } else
          require(
            publication.position === 0 &&
              !publication.parentItemId &&
              !publication.stackNumber &&
              pull.baseRef === snapshot.defaultBranch,
          );
      } else require(pull.baseRef === snapshot.defaultBranch && !publication.stackNumber);
      const unchanged =
        pull.headSha === publication.headSha &&
        pull.baseSha === publication.baseSha &&
        observedHead.treeOid === validation.outputTreeSha;
      if (pull.merged) {
        stage = "merge-candidate-source-unsupported";
        require(item.closed && pull.mergeCommitSha && unchanged);
        const merged = await port.readCommit(pull.mergeCommitSha);
        require(
          merged.oid === pull.mergeCommitSha &&
            merged.treeOid === validation.outputTreeSha &&
            merged.parentOids.length === 1 &&
            merged.parentOids[0] === validation.baseSha,
        );
        planItem.action = "integrated";
      } else {
        stage = "delivery-state";
        require(!item.closed && pull.state === "open");
        planItem.action = "revalidate";
        if (unchanged && validation.baseSha === base.oid) {
          stage = "checks";
          require(linked[0]!.checks === null || linked[0]!.checks === "SUCCESS");
          const rules = await port.readBranchRules(pull.baseRef);
          const checks = await port.readChecks(pull.headSha);
          require(
            branchRuleBlockers(rules).length === 0 &&
              missingRequiredChecks(rules, checks).length === 0 &&
              checks.failed.length === 0 &&
              checks.pending.length === 0 &&
              !pull.draft &&
              pull.mergeable === true &&
              !["blocked", "behind", "unstable", "unknown", "dirty"].includes(pull.mergeableState),
          );
          planItem.action = "reuse-publication";
        }
      }
    }
    currentWorkItem = undefined;
    stage = "allowance";
    const before = priorDigest
      ? priorPlans[priorDigest]!.plan.allowance.after
      : allowanceFor(predecessorStart);
    const increment = input.allowanceIncrement ?? ZERO_INCREMENT;
    require(
      Object.keys(increment).length === 4 &&
        Object.values(increment).every((value) => Number.isSafeInteger(value) && value >= 0),
    );
    require(before.modelTokens !== null || increment.modelTokens === 0);
    const after: RecoveryAllowance = {
      modelTokens: before.modelTokens === null ? null : before.modelTokens + increment.modelTokens,
      sandboxMinutes: before.sandboxMinutes + increment.sandboxMinutes,
      managedSessions: before.managedSessions + increment.managedSessions,
      implementationAttemptsPerItem:
        before.implementationAttemptsPerItem + increment.implementationAttemptsPerItem,
    };
    const policy = parseRunPolicy({
      ...predecessorStart.policy,
      maxSandboxMinutes: after.sandboxMinutes,
      maxManagedAgentSessions: after.managedSessions,
      maxAttemptsPerItem: after.implementationAttemptsPerItem,
      ...(after.modelTokens === null
        ? {}
        : {
            economics: { ...predecessorStart.policy.economics, maxModelTokens: after.modelTokens },
          }),
    });
    const runIds = history.map((entry) => entry.runId);
    const sourceEventMaxSequence = events
      .filter((event) => event.kind !== "recovery" && byRun.has(event.runId))
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
    const sourceEventsDigest = recoverySourceEventsDigest({
      objective: snapshot.number,
      runIds,
      events,
      maxSequence: sourceEventMaxSequence,
    });
    const accounting = assessRecoveryAccounting({
      objective: snapshot.number,
      repository,
      events,
      runIds,
      policy,
    });
    require(accounting.usage !== null);
    result.unknownUsageDigest = accounting.unknownModelUsageCount
      ? recoveryUnknownUsageDigest(sourceEventsDigest, accounting)
      : null;
    const plan = parseRecoveryPlan({
      protocol: RECOVERY_PLAN_PROTOCOL,
      repository,
      repositoryId: snapshot.repositoryId,
      objective: snapshot.number,
      objectiveNodeId: snapshot.id,
      requestId: input.requestId,
      successorRunId: input.successorRunId,
      predecessor,
      history,
      historyDigest: recoveryHistoryDigest(history),
      sourceEventsDigest,
      sourceEventMaxSequence,
      priorPlanDigest: priorDigest,
      expectedBaseSha: base.oid,
      baseBranch: snapshot.defaultBranch,
      graph: {
        sourceRunId: graphRunId,
        ref: graph.ref,
        commitOid: graph.commitOid,
        blobOid: graph.blobOid,
        digest: graph.graphDigest,
        projection: {
          ref: projection.ref,
          commitOid: projection.commitOid,
          blobOid: projection.blobOid,
          bindingDigest: recoveryPlanBindingDigest(items),
        },
      },
      acceptedPolicy: policy,
      policyDigest: policyDigest(policy),
      allowance: { before, increment, after },
      unknownUsageAcknowledgementDigest: input.unknownUsageAcknowledgementDigest ?? null,
      items,
    });
    stage = "chain";
    const chain = verifyRecoveryChain({
      repository,
      repositoryId: snapshot.repositoryId,
      objective: snapshot.number,
      objectiveNodeId: snapshot.id,
      historyComplete: true,
      events,
      plansByDigest: priorPlans,
      claims,
      candidatePlan: plan,
    });
    if (chain.status !== "verified") {
      result.blockers.push(...chain.blockers);
      return result;
    }
    result.status = "proposed";
    result.plan = plan;
    result.planDigest = recoveryPlanDigest(plan);
  } catch {
    result.blockers.push({
      code: stage,
      reason: `Recovery proposal ${stage} evidence is missing, conflicting, unsupported, or outside its bound; re-observe that evidence before acknowledgement.`,
      ...(currentWorkItem === undefined ? {} : { workItem: currentWorkItem }),
    });
  }
  return result;
}
