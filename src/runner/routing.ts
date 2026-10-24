import { reflectWorkflow } from "../workflow-reflection.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import { createHash } from "node:crypto";
import {
  assertDeclaredConditions,
  evaluateAuthenticatedWorkCondition,
  evaluateWorkCondition,
  workConditionDigest,
  type WorkConditionInputPacket,
} from "../adaptive-routing.js";
import { closeWorkItem } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import type { ContentRef, ContentStore, GitHubGateway } from "../contracts.js";
import { assertDiscoveryBody } from "../discovery.js";
import { attachFault, cancelledFault, decision } from "../fault.js";
import type { FactoryState, WorkState } from "../state.js";
import { awaitsOperator, clearWait, setWait } from "../step.js";
import { assertDiscoveryAdmission } from "./discovery.js";

export interface WorkConditionSettlement {
  schemaVersion: 1;
  conditionDigest: string;
  resultDigest: string;
  inputPacket: WorkConditionInputPacket;
  inputPacketRef: ContentRef;
  settledAt: string;
}
interface RoutingBinding {
  schemaVersion: 1;
  conditionId: string;
  conditionDigest: string;
  when: boolean;
}
export type WorkRoutingDisposition = RoutingBinding &
  (
    | { disposition: "selected" | "skipped"; resultDigest: string }
    | { disposition: "held"; detail: string }
  );
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const exactKeys = (
  value: Record<string, unknown>,
  keys: string[],
  label: string,
) => {
  if (Object.keys(value).sort().join() !== keys.sort().join())
    throw new Error(`${label} has missing or unsupported fields`);
};

/** A skipped branch has no implementation attempt or accepted result to inherit. */
export function assertSkippedWork(state: FactoryState, itemId: string): void {
  const work = state.work[itemId];
  if (
    !work ||
    work.status !== "skipped" ||
    work.routing?.disposition !== "skipped" ||
    !work.completedAt ||
    !Number.isFinite(Date.parse(work.completedAt)) ||
    work.attempt ||
    work.startedAt ||
    work.execution ||
    work.worker ||
    work.baseSha ||
    work.executionBaseSha ||
    work.changeRef ||
    work.treeSha ||
    work.validation ||
    work.failedValidation ||
    work.pullRequest ||
    work.integratedSha ||
    work.deliveredHead ||
    work.branchUpdateFrom ||
    work.replacedHeads?.length ||
    work.phaseReservation ||
    work.requestedPhase ||
    work.assets?.length ||
    work.selectedAssetSet ||
    work.selection ||
    work.selectionDigest ||
    work.closedPullRequest ||
    work.integratedShaAtStart !== undefined ||
    work.qaChecks?.length ||
    work.preIntegrationChecks?.length ||
    work.acceptancePending ||
    work.acceptanceDecisions?.length ||
    work.knowledge ||
    work.recovery ||
    work.discovery ||
    work.discoveryOutput ||
    work.step ||
    state.publicationIntents?.[itemId]?.length ||
    [
      ...Object.values(state.agentSessions ?? {}),
      ...(state.agentSessionHistory ?? []),
    ].some(
      (session) =>
        session.scope.itemId === itemId && session.status === "in-flight",
    )
  )
    throw new Error(
      `Skipped Work Item ${itemId} cannot carry an owned attempt, uncertain effect or implementation acceptance`,
    );
}

/** Cancellation records an unstarted branch without resolving its unknown predicate. */
function unownedCancellation(
  state: FactoryState,
  itemId: string,
  work: WorkState,
): boolean {
  return (
    work.status === "cancelled" &&
    (state.cancelRequested === true ||
      (typeof state.cancelledAt === "string" &&
        Number.isFinite(Date.parse(state.cancelledAt)))) &&
    !state.finalAcceptance &&
    !state.coordinator?.processes?.length &&
    !work.attempt &&
    !work.startedAt &&
    !work.execution &&
    !work.worker &&
    !work.step &&
    !work.phaseReservation &&
    !work.requestedPhase &&
    !work.baseSha &&
    !work.executionBaseSha &&
    !work.changeRef &&
    !work.treeSha &&
    !work.validation &&
    !work.failedValidation &&
    !work.pullRequest &&
    !work.integratedSha &&
    !work.deliveredHead &&
    !work.branchUpdateFrom &&
    !work.replacedHeads?.length &&
    !work.closedPullRequest &&
    work.integratedShaAtStart === undefined &&
    !work.qaChecks?.length &&
    !work.preIntegrationChecks?.length &&
    !work.assets?.length &&
    !work.selectedAssetSet &&
    !work.selection &&
    !work.selectionDigest &&
    !work.acceptancePending &&
    !work.acceptanceDecisions?.length &&
    !work.knowledge &&
    !work.recovery &&
    !work.discovery &&
    !work.discoveryOutput &&
    !state.publicationIntents?.[itemId]?.length &&
    ![
      ...Object.values(state.agentSessions ?? {}),
      ...(state.agentSessionHistory ?? []),
    ].some(
      (session) =>
        session.scope.itemId === itemId && session.status === "in-flight",
    )
  );
}

/** Restore identities and literal predicates only; artifact availability is a runtime gate. */
export function assertWorkRoutingState(state: FactoryState): void {
  assertDeclaredConditions(state.graph);
  if (
    (state.pendingAmendment?.graph?.conditions?.length ||
      state.pendingAmendment?.proposal.graph?.conditions?.length ||
      (state.schemaVersion === 9 &&
        (state.pendingAmendment?.graph?.expansions?.length ||
          state.pendingAmendment?.proposal.graph?.expansions?.length))) &&
    state.schemaVersion !== 13 &&
    state.schemaVersion !== 15 &&
    ![17, 19].includes(state.schemaVersion)
  )
    throw new Error(
      "Pending declared routing requires execution snapshot version 13",
    );
  const routed = Object.values(state.work).some(
    (work) => work.routing !== undefined || work.status === "skipped",
  );
  if (
    (state.graph.conditions !== undefined ||
      state.conditionFacts !== undefined ||
      routed) &&
    state.schemaVersion !== 13 &&
    state.schemaVersion !== 15 &&
    ![17, 19].includes(state.schemaVersion)
  )
    throw new Error("Declared routing requires execution snapshot version 13");
  const facts = state.conditionFacts ?? {};
  object(facts, "Condition facts");
  for (const [id, raw] of Object.entries(facts)) {
    const fact = object(raw, "Condition settlement");
    exactKeys(
      fact,
      [
        "schemaVersion",
        "conditionDigest",
        "resultDigest",
        "inputPacket",
        "inputPacketRef",
        "settledAt",
      ],
      "Condition settlement",
    );
    const condition = state.graph.conditions?.find((entry) => entry.id === id);
    if (!condition)
      throw new Error(
        "Retained condition identity is absent from the admitted graph",
      );
    const entry = raw as WorkConditionSettlement;
    const producer = state.work[condition.input.producerItemId];
    const packet = entry.inputPacket;
    assertDiscoveryBody(packet.body);
    const evaluated = evaluateWorkCondition({
      graph: state.graph,
      conditionId: id,
      manifest: packet.manifest,
      body: packet.body,
      expectedProducer: packet.expectedProducer,
      sourceCommitSha: packet.sourceCommitSha,
    });
    if (
      entry.schemaVersion !== 1 ||
      entry.conditionDigest !== workConditionDigest(condition) ||
      !same(packet.condition, condition) ||
      evaluated.status !== "known" ||
      evaluated.digest !== entry.resultDigest ||
      !same(evaluated.inputPacket, packet) ||
      packet.expectedProducer.objective !== state.objective ||
      packet.expectedProducer.runId !== state.runId ||
      packet.expectedProducer.itemId !== condition.input.producerItemId ||
      producer?.status !== "done" ||
      packet.expectedProducer.attemptId !== producer.attempt ||
      packet.sourceCommitSha !== producer.baseSha ||
      !same(packet.manifest, producer.discoveryOutput) ||
      entry.inputPacketRef?.digest !== entry.resultDigest ||
      entry.resultDigest !== hash(packet) ||
      entry.inputPacketRef.bytes !==
        Buffer.byteLength(JSON.stringify(packet)) ||
      entry.inputPacketRef.mediaType !== "application/json" ||
      !Number.isFinite(Date.parse(entry.settledAt))
    )
      throw new Error(
        "Condition settlement differs from its exact attributable output and predicate",
      );
  }
  for (const item of state.graph.items) {
    const work = state.work[item.id];
    const routing = work?.routing;
    if (!item.condition) {
      if (routing || work?.status === "skipped")
        throw new Error(
          "Unconditional work cannot carry a routing disposition",
        );
      continue;
    }
    const condition = state.graph.conditions!.find(
      (entry) => entry.id === item.condition!.conditionId,
    )!;
    if (!routing) {
      if (
        work &&
        ((work.status !== "pending" &&
          !unownedCancellation(state, item.id, work)) ||
          work.attempt ||
          work.execution ||
          work.startedAt)
      )
        throw new Error(
          "Conditional owner started without settled selected facts",
        );
      continue;
    }
    const fields = object(routing, "Work routing disposition");
    exactKeys(
      fields,
      [
        "schemaVersion",
        "conditionId",
        "conditionDigest",
        "when",
        "disposition",
        routing.disposition === "held" ? "detail" : "resultDigest",
      ],
      "Work routing disposition",
    );
    if (
      routing.schemaVersion !== 1 ||
      routing.conditionId !== condition.id ||
      routing.conditionDigest !== workConditionDigest(condition) ||
      routing.when !== item.condition.when
    )
      throw new Error("Work routing differs from the admitted branch binding");
    if (routing.disposition === "held") {
      if (
        (work.status !== "pending" &&
          !unownedCancellation(state, item.id, work)) ||
        typeof routing.detail !== "string" ||
        !routing.detail ||
        work.attempt ||
        work.execution
      )
        throw new Error("Unknown condition cannot start or skip an owner");
      continue;
    }
    const fact = facts[condition.id];
    const disposition =
      fact?.inputPacket.value === routing.when ? "selected" : "skipped";
    if (
      !fact ||
      routing.resultDigest !== fact.resultDigest ||
      routing.disposition !== disposition ||
      (routing.disposition === "skipped" && work.status !== "skipped") ||
      (routing.disposition === "selected" && work.status === "skipped")
    )
      throw new Error(
        "Work disposition lacks its unchanged known predicate result",
      );
    if (work.status === "skipped") assertSkippedWork(state, item.id);
  }
}
function held(detail: string): Error {
  return attachFault(
    new Error(detail),
    decision(
      "Restore the exact retained condition inputs or use supported reviewed recovery; unknown facts cannot select or skip a branch.",
      detail,
    ),
  );
}

export async function authenticateWorkRouting(args: {
  config: FactoryConfig;
  state: FactoryState;
  store: ContentStore;
}): Promise<void> {
  assertWorkRoutingState(args.state);
  for (const [id, fact] of Object.entries(args.state.conditionFacts ?? {})) {
    const producerId = fact.inputPacket.condition.input.producerItemId;
    const producer = args.state.graph.items.find(
      (item) => item.id === producerId,
    )!;
    assertDiscoveryAdmission(args.config, args.state, producer);
    try {
      await args.store.verify(fact.inputPacketRef);
      const bytes = Buffer.from(
        await new Response(
          await args.store.open(fact.inputPacketRef),
        ).arrayBuffer(),
      );
      if (!bytes.equals(Buffer.from(JSON.stringify(fact.inputPacket))))
        throw new Error("Condition packet bytes differ");
      const evaluated = await evaluateAuthenticatedWorkCondition({
        graph: args.state.graph,
        conditionId: id,
        expectedProducer: fact.inputPacket.expectedProducer,
        sourceCommitSha: fact.inputPacket.sourceCommitSha,
        manifest: fact.inputPacket.manifest,
        checkout: args.config.checkout,
        store: args.store,
      });
      if (
        evaluated.status !== "known" ||
        evaluated.digest !== fact.resultDigest
      )
        throw new Error("Condition input is unavailable or changed");
    } catch {
      throw held(
        "Retained condition facts are unavailable, incomplete or differ from their authenticated output",
      );
    }
  }
}

/** Only pending, unowned branches are routed; a missing fact remains a dependency hold. */
export async function settleWorkRouting(args: {
  config: FactoryConfig;
  state: FactoryState;
  store: ContentStore;
  save: () => void;
  cancelled: () => boolean;
}): Promise<void> {
  const { state } = args;
  assertWorkRoutingState(state);
  if (
    !state.graph.conditions?.length ||
    state.coordinator?.mode !== "running" ||
    state.pendingAmendment ||
    state.pendingExpansion ||
    args.cancelled() ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalAcceptance
  )
    return;
  await authenticateWorkRouting(args);
  for (const condition of state.graph.conditions) {
    if (args.cancelled()) throw cancelledFault();
    const consumers = state.graph.items.filter(
      (item) =>
        item.condition?.conditionId === condition.id &&
        state.work[item.id]?.status === "pending" &&
        !awaitsOperator(state.work[item.id]?.wait) &&
        !["decision", "prerequisite"].includes(
          state.work[item.id]?.wait?.kind ?? "",
        ),
    );
    if (!consumers.length) continue;
    let fact = state.conditionFacts?.[condition.id];
    let unknown: string | undefined;
    if (!fact) {
      const producer = state.work[condition.input.producerItemId];
      const sourceItem = state.graph.items.find(
        (item) => item.id === condition.input.producerItemId,
      )!;
      assertDiscoveryAdmission(args.config, state, sourceItem);
      if (producer?.status !== "done" || !producer.attempt || !producer.baseSha)
        unknown = `Condition ${condition.id} awaits its producer's complete attributable output`;
      else {
        const evaluated = await evaluateAuthenticatedWorkCondition({
          graph: state.graph,
          conditionId: condition.id,
          expectedProducer: {
            objective: state.objective,
            runId: state.runId,
            itemId: sourceItem.id,
            attemptId: producer.attempt,
          },
          sourceCommitSha: producer.baseSha,
          manifest: producer.discoveryOutput,
          checkout: args.config.checkout,
          store: args.store,
        });
        if (evaluated.status === "unknown") unknown = evaluated.detail;
        else {
          const bytes = Buffer.from(JSON.stringify(evaluated.inputPacket));
          const ref = await args.store.put(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            { mediaType: "application/json" },
          );
          fact = {
            schemaVersion: 1,
            conditionDigest: workConditionDigest(condition),
            resultDigest: evaluated.digest,
            inputPacket: evaluated.inputPacket,
            inputPacketRef: ref,
            settledAt: new Date().toISOString(),
          };
          state.conditionFacts = {
            ...state.conditionFacts,
            [condition.id]: fact,
          };
          args.save();
        }
      }
    }
    for (const item of consumers) {
      const work = state.work[item.id]!;
      if (work.routing?.disposition === "selected") continue;
      if (
        work.attempt ||
        work.execution ||
        work.startedAt ||
        work.recovery ||
        state.publicationIntents?.[item.id]?.length
      )
        throw held(
          "A conditional owner or uncertain effect cannot be changed by routing",
        );
      const binding: RoutingBinding = {
        schemaVersion: 1,
        conditionId: condition.id,
        conditionDigest: workConditionDigest(condition),
        when: item.condition!.when,
      };
      if (!fact) {
        work.routing = { ...binding, disposition: "held", detail: unknown! };
        setWait(
          state,
          { item: item.id },
          { kind: "dependency", detail: unknown! },
        );
      } else {
        clearWait(state, { item: item.id });
        const disposition =
          fact.inputPacket.value === item.condition!.when
            ? "selected"
            : "skipped";
        work.routing = {
          ...binding,
          disposition,
          resultDigest: fact.resultDigest,
        };
        if (disposition === "skipped") {
          work.status = "skipped";
          work.completedAt = new Date().toISOString();
        }
      }
      args.save();
    }
  }
}

/** Existing issue closure is the only external effect of a skipped disposition. */
export async function reconcileWorkRouting(
  args: Parameters<typeof settleWorkRouting>[0] & {
    github: GitHubGateway;
    signal?: AbortSignal;
    pause?: AbortSignal;
    diagnostics?: DiagnosticEmitter;
    resolvedExpansionIds?: ReadonlySet<string>;
  },
): Promise<void> {
  await settleWorkRouting(args);
  if (
    args.state.coordinator?.mode !== "running" ||
    args.state.pendingAmendment ||
    args.state.pendingExpansion ||
    args.cancelled()
  )
    return;
  for (const item of args.state.graph.items) {
    if (
      args.state.work[item.id]?.status !== "skipped" ||
      args.state.work[item.id]?.githubClosure === "complete"
    )
      continue;
    if (args.cancelled()) throw cancelledFault();
    await closeWorkItem(
      args.state,
      item.id,
      args.github,
      args.save,
      args.config.delivery.kind === "native-stack",
      args.signal,
      args.pause,
    );
    await observeWorkflowReflection({
      state: args.state,
      event: { kind: "completion", itemId: item.id },
      store: args.store,
      save: args.save,
      diagnostics: args.diagnostics,
      resolvedExpansionIds: args.resolvedExpansionIds,
    });
  }
}

/** Optional advisory observation cannot change the outcome of a lifecycle checkpoint. */
export async function observeWorkflowReflection(
  args: Parameters<typeof reflectWorkflow>[0] & {
    diagnostics?: DiagnosticEmitter;
  },
): Promise<void> {
  const previous = args.state.workflowReflection;
  let checkpointStarted = false;
  try {
    await reflectWorkflow({
      ...args,
      save: () => {
        checkpointStarted = true;
        if (
          args.state.schemaVersion !== 15 &&
          ![17, 19].includes(args.state.schemaVersion)
        )
          args.state.schemaVersion = 13;
        args.save();
      },
    });
  } catch {
    // No rollback after an uncertain atomic save; retain the exact record and format.
    if (!checkpointStarted) {
      if (previous === undefined) delete args.state.workflowReflection;
      else args.state.workflowReflection = previous;
    }
    try {
      args.diagnostics?.emit({
        runId: args.state.runId,
        operation: "workflow-reflection",
        outcome: "failed",
        detail: "Optional workflow observation unavailable",
      });
    } catch {
      // Optional diagnostic reporting also cannot alter lifecycle.
    }
  }
}
