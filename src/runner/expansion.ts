import { readPinnedWorkflowRecipe } from "../workflow-recipes.js";
import type {
  ContentRef,
  ContentStore,
  GitHubGateway,
  WorkGraph,
} from "../contracts.js";
import type { FactoryConfig } from "../config.js";
import { buildAdaptiveContext } from "../adaptive-context.js";
import {
  authenticateDiscoveryOutput,
  type DiscoveryBody,
} from "../discovery.js";
import {
  executionProfileChoices,
  verifyExecutionProfiles,
} from "../execution-profiles.js";
import { attachFault, decision, StepFault } from "../fault.js";
import { graphDigest } from "../graph-amendments.js";
import { graphProjectionControl } from "../graph-projection-control.js";
import {
  assertGraphExpansions,
  graphExpansionEnvelopeDigest,
  materializeGraphExpansion,
} from "../graph-expansion.js";
import { assertExpansionCoverage } from "../qa.js";
import { assertWorkDiscoveryOutput, type FactoryState } from "../state.js";
import { assertDiscoveryAdmission } from "./discovery.js";
import { canHandoff } from "./ownership.js";
import { assertExpansionsSettled } from "../expansion-readiness.js";
import { step, type StepOptions } from "../step.js";

interface GraphExpansionReceipt {
  schemaVersion: 1;
  id: string;
  envelopeId: string;
  parentGraphDigest: string;
  graphDigest: string;
  envelopeDigest: string;
  materializationDigest: string;
  inputPacketRef: ContentRef;
  childIds: string[];
}
export interface PendingGraphExpansion extends GraphExpansionReceipt {
  graph: WorkGraph;
  phase: "admitted" | "projected";
  issueByItemId: Record<string, number>;
}
export interface GraphExpansionSettlement extends GraphExpansionReceipt {
  acceptedAt: string;
}
function held(detail: string): Error {
  return attachFault(
    new Error(detail),
    decision(
      "Expansion cannot consume its retained inputs or project safely. Restore the exact retained facts or use supported reviewed recovery; do not regenerate or replay the request.",
      detail,
    ),
  );
}
function receipt(value: GraphExpansionReceipt): void {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.envelopeId !== "string" ||
    !value.envelopeId ||
    value.id !== `${value.envelopeId}-${value.materializationDigest}` ||
    ![
      value.parentGraphDigest,
      value.graphDigest,
      value.envelopeDigest,
      value.materializationDigest,
      value.inputPacketRef?.digest,
    ].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    ) ||
    value.inputPacketRef.digest !== value.materializationDigest ||
    !Number.isSafeInteger(value.inputPacketRef.bytes) ||
    value.inputPacketRef.bytes < 1 ||
    value.inputPacketRef.mediaType !== "application/json" ||
    !Array.isArray(value.childIds) ||
    new Set(value.childIds).size !== value.childIds.length ||
    value.childIds.some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id),
    )
  )
    throw new Error("Invalid retained expansion receipt");
}
/** Shape/lineage validation; content availability remains an explicit runtime fact. */
export function assertExpansionState(state: FactoryState): void {
  const expansions = state.graph.expansions;
  if (expansions !== undefined) assertGraphExpansions(state.graph);
  if (
    state.schemaVersion !== 11 &&
    state.schemaVersion !== 13 &&
    state.schemaVersion !== 15 &&
    ![17, 19].includes(state.schemaVersion) &&
    (expansions !== undefined ||
      state.pendingExpansion !== undefined ||
      state.expansionHistory !== undefined)
  )
    throw new Error(
      "Expansion semantics require execution snapshot version 11",
    );
  if (state.schemaVersion === 11 && !expansions?.length)
    throw new Error("Expansion snapshot lacks reviewed envelopes");
  const history = state.expansionHistory ?? [];
  if (!Array.isArray(history)) throw new Error("Invalid expansion history");
  const settled = new Set<string>();
  for (const entry of history) {
    receipt(entry);
    const revision = state.graphRevisions?.find(
      (revision) => revision.expansion?.id === entry.id,
    );
    const unchanged =
      entry.graphDigest === entry.parentGraphDigest &&
      (entry.graphDigest === graphDigest(state.graph) ||
        state.graphRevisions?.some(
          (revision) => revision.digest === entry.graphDigest,
        ));
    if (
      settled.has(entry.envelopeId) ||
      !Number.isFinite(Date.parse(entry.acceptedAt)) ||
      (!unchanged &&
        (!revision ||
          revision.parentDigest !== entry.parentGraphDigest ||
          JSON.stringify(revision.expansion) !== JSON.stringify(entry)))
    )
      throw new Error(
        "Expansion settlement lacks its immutable graph revision",
      );
    settled.add(entry.envelopeId);
  }
  const pending = state.pendingExpansion;
  if (pending && state.pendingAmendment)
    throw new Error(
      "Expansion and amendment cannot stage concurrent graph mutations",
    );
  if (pending) {
    receipt(pending);
    if (
      !expansions?.some(
        (envelope) =>
          envelope.id === pending.envelopeId &&
          graphExpansionEnvelopeDigest(envelope) === pending.envelopeDigest,
      ) ||
      settled.has(pending.envelopeId) ||
      pending.parentGraphDigest !== graphDigest(state.graph) ||
      pending.graphDigest !== graphDigest(pending.graph) ||
      !["admitted", "projected"].includes(pending.phase) ||
      !pending.issueByItemId ||
      typeof pending.issueByItemId !== "object" ||
      Array.isArray(pending.issueByItemId) ||
      Object.entries(pending.issueByItemId).some(
        ([id, issue]) =>
          !pending.graph.items.some((item) => item.id === id) ||
          !Number.isSafeInteger(issue) ||
          issue < 1,
      ) ||
      new Set(Object.values(pending.issueByItemId)).size !==
        Object.values(pending.issueByItemId).length
    )
      throw new Error("Pending expansion graph or projection identity differs");
    for (const [id, issue] of Object.entries(state.issueByItemId))
      if (pending.issueByItemId[id] !== issue)
        throw new Error("Expansion changed an existing projected identity");
  }
}
function parentGraph(state: FactoryState, digest: string): WorkGraph {
  if (graphDigest(state.graph) === digest) return state.graph;
  const parent = state.graphRevisions?.find(
    (revision) => revision.digest === digest,
  )?.graph;
  if (!parent) throw held("Expansion parent graph is unavailable");
  return parent;
}
async function materialization(
  state: FactoryState,
  config: FactoryConfig,
  store: ContentStore,
  graph: WorkGraph,
  envelopeId: string,
  immutableItemIds: string[] = [],
  authenticatedBodies = new Map<string, DiscoveryBody>(),
) {
  const envelope = graph.expansions?.find((entry) => entry.id === envelopeId);
  if (!envelope) throw held("Expansion envelope is unavailable");
  const producer = graph.items.find(
    (item) => item.id === envelope.input.producerItemId,
  );
  const work = state.work[envelope.input.producerItemId];
  const manifest = work?.discoveryOutput;
  if (
    producer?.kind !== "discovery" ||
    !producer.discovery ||
    work?.status !== "done" ||
    !work.attempt ||
    !manifest ||
    manifest.status !== "complete" ||
    manifest.producer.objective !== state.objective ||
    manifest.producer.runId !== state.runId ||
    manifest.producer.itemId !== producer.id ||
    manifest.producer.attemptId !== work.attempt ||
    manifest.source.commitSha !== work.baseSha
  )
    throw held(
      "Expansion requires its exact complete accepted discovery producer",
    );
  const bodyIdentity = JSON.stringify({
    specification: producer.discovery,
    manifest,
  });
  let body = authenticatedBodies.get(bodyIdentity);
  if (!body) {
    body = await authenticateDiscoveryOutput({
      checkout: config.checkout,
      specification: producer.discovery,
      manifest,
      store,
    });
    authenticatedBodies.set(bodyIdentity, body);
  }
  return materializeGraphExpansion({
    graph,
    envelopeId,
    manifest,
    body,
    runId: state.runId,
    immutableItemIds,
    executionProfiles: executionProfileChoices(config),
  });
}
/** Reuse exact immutable packets; absent/stale/tampered evidence never resolves a barrier. */
export async function authenticateExpansionInputs(args: {
  state: FactoryState;
  config: FactoryConfig;
  contentStore: ContentStore;
}): Promise<ReadonlySet<string>> {
  const { state, config, contentStore } = args;
  assertExpansionState(state);
  const ids = new Set<string>();
  const authenticatedBodies = new Map<string, DiscoveryBody>();
  for (const retained of [
    ...(state.expansionHistory ?? []),
    ...(state.pendingExpansion ? [state.pendingExpansion] : []),
  ]) {
    try {
      const parent = parentGraph(state, retained.parentGraphDigest);
      const result = await materialization(
        state,
        config,
        contentStore,
        parent,
        retained.envelopeId,
        [],
        authenticatedBodies,
      );
      await contentStore.verify(retained.inputPacketRef);
      const text = await new Response(
        await contentStore.open(retained.inputPacketRef),
      ).text();
      if (
        text !== JSON.stringify(result.inputPacket) ||
        result.digest !== retained.materializationDigest ||
        result.envelopeDigest !== retained.envelopeDigest ||
        graphDigest(result.graph) !== retained.graphDigest ||
        JSON.stringify(result.childIds) !== JSON.stringify(retained.childIds)
      )
        throw new Error("Retained expansion input or materialization changed");
      const current = state.graph.expansions?.find(
        (entry) => entry.id === retained.envelopeId,
      );
      if (
        !current ||
        graphExpansionEnvelopeDigest(current) !== retained.envelopeDigest
      )
        throw new Error("Settled expansion envelope changed");
      if ("acceptedAt" in retained) ids.add(retained.envelopeId);
    } catch (error) {
      throw held(error instanceof Error ? error.message : String(error));
    }
  }
  return ids;
}
/** One current acceptance-phase authentication shared by fresh and resumed finalization. */
export async function authenticateObjectiveInputs(args: {
  state: FactoryState;
  config: FactoryConfig;
  contentStore: ContentStore;
}): Promise<ReadonlySet<string>> {
  if (args.state.workflowRecipePin)
    await readPinnedWorkflowRecipe(
      args.state.workflowRecipePin,
      args.contentStore,
    );
  const resolved = await authenticateExpansionInputs(args);
  assertExpansionsSettled(args.state.graph, resolved);
  const authenticatedProducers = new Set(
    (args.state.graph.expansions ?? [])
      .filter((envelope) => resolved.has(envelope.id))
      .map((envelope) => envelope.input.producerItemId),
  );
  for (const item of args.state.graph.items.filter(
    (item) => item.kind === "discovery",
  )) {
    assertDiscoveryAdmission(args.config, args.state, item);
    assertWorkDiscoveryOutput(args.state, item.id, args.state.work[item.id]!);
    if (!authenticatedProducers.has(item.id))
      await authenticateDiscoveryOutput({
        checkout: args.config.checkout,
        specification: item.discovery!,
        manifest: args.state.work[item.id]!.discoveryOutput!,
        store: args.contentStore,
      });
  }
  return resolved;
}
/** True only when a completed producer can yield a new immutable graph pass. */
export function graphExpansionPending(state: FactoryState): boolean {
  return (
    !!state.pendingExpansion ||
    (state.graph.expansions ?? []).some(
      (envelope) =>
        !state.expansionHistory?.some(
          (entry) => entry.envelopeId === envelope.id,
        ) && state.work[envelope.input.producerItemId]?.status === "done",
    )
  );
}
export async function applyPendingGraphExpansion(
  args: {
    state: FactoryState;
    config: FactoryConfig;
    contentStore: ContentStore;
    github: GitHubGateway;
  } & StepOptions,
): Promise<boolean> {
  const { state, config, contentStore, github, save } = args;
  if (state.workflowRecipePin) {
    try {
      await readPinnedWorkflowRecipe(state.workflowRecipePin, contentStore);
    } catch (error) {
      throw new StepFault(
        decision(
          "Restore the retained recipe before graph expansion; preserve its original admission",
        ),
        { cause: error },
      );
    }
  }
  if (
    !state.graph.expansions?.length ||
    state.pendingAmendment ||
    !graphExpansionPending(state)
  )
    return false;
  // An immutable graph pass drains every owned item before new barrier dependencies exist.
  if (
    Object.values(state.work).some(
      (work) => work.status === "running" || work.status === "published",
    )
  )
    return false;
  const unsettledWorker = Object.entries(state.work).find(
    ([, work]) =>
      work.execution &&
      (["failed", "waiting", "pending", "cancelled"].includes(work.status) ||
        work.step === "execute" ||
        !work.changeRef ||
        !work.treeSha),
  );
  if (unsettledWorker || !canHandoff(state))
    throw held(
      unsettledWorker
        ? `Work Item ${unsettledWorker[0]} retains unresolved worker ${unsettledWorker[1].execution!.identity}; preserve its handle and settle it through supported recovery before expansion`
        : "Expansion retains an unresolved controller process, provider invocation or session resource; settle that recorded owner through supported recovery before projection",
    );
  if (github.projectionMutationAdmission !== "controller-checkpoint-v1")
    throw held(
      "GitHub adapter cannot preserve exact expansion projection effects",
    );
  return step(
    state,
    { scope: "objective", name: "expand" },
    async (context) => {
      await authenticateExpansionInputs(args);
      if (!state.pendingExpansion) {
        const envelope = state.graph.expansions!.find(
          (entry) =>
            !state.expansionHistory?.some(
              (history) => history.envelopeId === entry.id,
            ) && state.work[entry.input.producerItemId]?.status === "done",
        )!;
        const immutable = Object.entries(state.work)
          .filter(
            ([, work]) =>
              work.status !== "pending" ||
              !!work.attempt ||
              !!work.execution ||
              !!work.pullRequest,
          )
          .map(([id]) => id);
        const result = await materialization(
          state,
          config,
          contentStore,
          state.graph,
          envelope.id,
          immutable,
        );
        assertExpansionCoverage(state.graph, result.graph);
        verifyExecutionProfiles(result.graph, executionProfileChoices(config));
        const bytes = new TextEncoder().encode(
          JSON.stringify(result.inputPacket),
        );
        const inputPacketRef = await contentStore.put(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { mediaType: "application/json" },
        );
        if (inputPacketRef.digest !== result.digest)
          throw held("Materialization packet content identity differs");
        await buildAdaptiveContext({
          state,
          role: "expansion",
          item: state.graph.items.find(
            (item) => item.id === envelope.input.producerItemId,
          ),
          baseSha: result.inputPacket.manifest.source.commitSha,
          checkout: config.checkout,
          store: contentStore,
          config,
          required: {
            envelopeId: envelope.id,
            materializationDigest: result.digest,
            inputPacketRef,
            childIds: result.childIds,
            interpretation:
              "The complete authenticated discovery and reviewed work shape reside in the retained materialization input packet. Advisory memory cannot change its deterministic batches or grant ownership.",
          },
          requiredSelections: [
            {
              id: `expansion:${result.digest}`,
              kind: "discovery",
              disposition: "current",
              required: true,
              refs: [inputPacketRef],
            },
          ],
          save,
        });
        if (state.pendingAmendment)
          throw held(
            "A reviewed amendment now owns the next graph transition; expansion was not submitted",
          );
        state.pendingExpansion = {
          schemaVersion: 1,
          id: `${envelope.id}-${result.digest}`,
          envelopeId: envelope.id,
          parentGraphDigest: graphDigest(state.graph),
          graphDigest: graphDigest(result.graph),
          envelopeDigest: result.envelopeDigest,
          materializationDigest: result.digest,
          inputPacketRef,
          childIds: result.childIds,
          graph: result.graph,
          phase: "admitted",
          issueByItemId: { ...state.issueByItemId },
        };
        save();
      }
      const pending = state.pendingExpansion;
      if (pending.phase === "admitted") {
        const projected = await github.projectGraph({
          graph: pending.graph,
          previousGraph: state.graph,
          objectiveIssue: state.objective,
          knownIssues: pending.issueByItemId,
          author: state.issueAuthor,
          completedItems: Object.keys(state.work).filter(
            (id) => state.work[id]!.status === "done",
          ),
          expansionControl: graphProjectionControl(state, pending.graph, save),
          authored(login) {
            state.issueAuthor = login;
            save();
          },
          projected(id, issue) {
            pending.issueByItemId[id] = issue;
            save();
            context.progress();
          },
        });
        pending.issueByItemId = projected.issueByItemId;
        pending.phase = "projected";
        save();
      }
      await authenticateExpansionInputs(args);
      const { graph, phase: _phase, issueByItemId, ...retained } = pending;
      const settlement: GraphExpansionSettlement = {
        ...retained,
        acceptedAt: new Date().toISOString(),
      };
      if (pending.graphDigest !== pending.parentGraphDigest) {
        state.graphRevisions ??= [
          {
            graph: structuredClone(state.graph),
            digest: state.planGraphDigest,
          },
        ];
        state.graphRevisions.push({
          graph: structuredClone(graph),
          digest: pending.graphDigest,
          parentDigest: pending.parentGraphDigest,
          expansion: settlement,
          acceptedAt: settlement.acceptedAt,
        });
      }
      state.graph = graph;
      state.issueByItemId = issueByItemId;
      for (const item of graph.items)
        state.work[item.id] ??= { status: "pending" };
      state.expansionHistory ??= [];
      state.expansionHistory.push(settlement);
      delete state.pendingExpansion;
      save();
      return true;
    },
    args,
  );
}
