import { randomUUID } from "node:crypto";
import type { FactoryConfig } from "../config.js";
import { assertDiscoveryContextScope } from "../compiler/context.js";
import type {
  ContentStore,
  ExecutionDriver,
  GitHubGateway,
  WorkItem,
} from "../contracts.js";
import { closeWorkItem } from "../completion.js";
import {
  authenticateDiscoveryOutput,
  discoverRepository,
  selectDiscoveryOutputFields,
} from "../discovery.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import { cancelledFault, StepFault, workFault } from "../fault.js";
import { graphDigest } from "../graph-amendments.js";
import { executeItem } from "../item-steps.js";
import type { PhaseAdmission } from "../phase-admission.js";
import { ownsPath } from "../ownership.js";
import type { FactoryState } from "../state.js";
import { step } from "../step.js";

/** Accepted model selectors stay within the operator's immutable read ceiling. */
export function assertDiscoveryAdmission(
  config: FactoryConfig,
  state: FactoryState,
  item: WorkItem,
): void {
  if (item.kind !== "discovery") return;
  assertDiscoveryContextScope(
    { ...state.graph, items: [item] },
    state.planningRecovery?.contextLookup?.packet,
  );
  const admitted = config.planningContext?.selectors;
  if (
    (state.schemaVersion !== 9 && state.schemaVersion !== 11) ||
    !config.planningContext?.enabled ||
    !admitted ||
    !item.discovery ||
    item.discovery.selectors.some((selector) => !ownsPath(selector, admitted))
  )
    throw new StepFault({
      kind: "config",
      detail:
        "Discovery selectors exceed the recorded adaptive source authority",
      fix: "Use discovery selectors within the approved planningContext selector ceiling",
    });
}

/** Discovery uses the ordinary Work Item ownership, step allowance and phase admission. */
export async function runDiscoveryItem(args: {
  config: FactoryConfig;
  state: FactoryState;
  item: WorkItem;
  driver: ExecutionDriver;
  github: GitHubGateway;
  store: ContentStore;
  phases: PhaseAdmission;
  save: () => void;
  cancelled: () => boolean;
  signal?: AbortSignal;
  pause?: AbortSignal;
  diagnostics?: DiagnosticEmitter;
}): Promise<void> {
  const { state, item, phases, save } = args;
  assertDiscoveryAdmission(args.config, state, item);
  const spec = item.discovery;
  if (item.kind !== "discovery" || !spec)
    throw new Error("Discovery execution requires its accepted specification");
  if (
    spec.mode === "semantic" &&
    (args.driver.readonlyDiscovery !== "selector-bound-read-only-v1" ||
      !args.driver.preflight)
  )
    throw new StepFault({
      kind: "config",
      detail:
        "Semantic discovery requires a declared selector-bound read-only driver with preflight",
      fix: "Select an eligible read-only discovery execution adapter and profile",
    });
  const work = state.work[item.id]!;
  if (work.status === "pending") {
    work.status = "running";
    work.step = "execute";
    work.attempt = randomUUID();
    work.graphRevisionDigest = graphDigest(state.graph);
    work.startedAt = new Date().toISOString();
    work.baseSha = state.integratedSha ?? state.baseSha;
    work.executionBaseSha = work.baseSha;
    work.integratedShaAtStart = state.integratedSha ?? null;
    save();
  }
  if (!work.attempt || !work.baseSha)
    throw new Error(
      "Discovery lacks its recorded execution identity and source",
    );
  const stopped = () => Boolean(args.signal?.aborted || args.cancelled());
  if (stopped()) throw cancelledFault();
  if (!work.discoveryOutput) {
    await phases.reserve(item.id, "validation");
    work.discoveryOutput = await step(
      state,
      { scope: { item: item.id }, name: "discovery-inventory" },
      () =>
        discoverRepository({
          checkout: args.config.checkout,
          baseSha: work.baseSha!,
          specification: spec,
          producer: {
            objective: state.objective,
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt!,
          },
          store: args.store,
          cancelled: stopped,
        }),
      { save, signal: args.signal, pause: args.pause },
    );
    save();
  }
  if (
    spec.mode === "semantic" &&
    work.discoveryOutput.disposition === "observation" &&
    work.discoveryOutput.status === "complete"
  ) {
    // Binding/capability checks in driver preflight precede any paid start.
    await args.driver.preflight?.({ ...state.graph, items: [item] });
    await phases.reserve(item.id, "coding");
    const result = await executeItem({
      state,
      item,
      driver: args.driver,
      save,
      signal: args.signal,
      pause: args.pause,
      cancelled: stopped,
      diagnostics: args.diagnostics,
      request: (attemptId) => ({
        item,
        baseSha: work.baseSha!,
        attemptId,
        captureContext: { objective: state.objective, runId: state.runId },
        discovery: { manifest: work.discoveryOutput! },
      }),
    });
    if (!result.discoveryOutput)
      throw workFault("Semantic discovery returned no typed output");
    // Driver transport source identities never become a change or Git acceptance receipt.
    work.discoveryOutput = result.discoveryOutput;
    delete work.execution;
    save();
  }
  await phases.reserve(item.id, "validation");
  const manifest = work.discoveryOutput;
  if (
    manifest.producer.objective !== state.objective ||
    manifest.producer.runId !== state.runId ||
    manifest.producer.itemId !== item.id ||
    manifest.producer.attemptId !== work.attempt ||
    manifest.source.commitSha !== work.baseSha
  )
    throw workFault("Discovery output differs from its exact execution scope");
  await authenticateDiscoveryOutput({
    checkout: args.config.checkout,
    specification: spec,
    manifest,
    store: args.store,
  });
  if (stopped()) throw cancelledFault();
  if (
    manifest.status !== "complete" ||
    (spec.mode === "semantic" && manifest.disposition !== "advisory")
  )
    throw workFault(
      `Discovery output is ${manifest.status}; complete ${spec.mode} output is required`,
    );
  work.status = "done";
  work.completedAt = new Date().toISOString();
  delete work.step;
  save();
  try {
    await closeWorkItem(
      state,
      item.id,
      args.github,
      save,
      args.config.delivery.kind === "native-stack",
      args.signal,
      args.pause,
    );
  } finally {
    phases.release(item.id);
  }
}

/** Only declared direct dependency roles/fields reach the next worker conversation. */
export async function selectedDiscoveryInputs(args: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  store: ContentStore;
}): Promise<object[]> {
  const selected: object[] = [];
  for (const selection of args.item.discoveryInputs ?? []) {
    const producer = args.state.graph.items.find(
      (peer) => peer.id === selection.producerItemId,
    );
    const work = args.state.work[selection.producerItemId];
    const manifest = work?.discoveryOutput;
    if (
      !producer?.discovery ||
      producer.kind !== "discovery" ||
      !args.item.dependencies.includes(producer.id) ||
      work?.status !== "done" ||
      !manifest ||
      manifest.status !== "complete" ||
      manifest.role !== selection.role
    )
      throw new Error(
        "Selected discovery dependency is absent, incomplete or has another role",
      );
    const body = await authenticateDiscoveryOutput({
      checkout: args.checkout,
      specification: producer.discovery,
      manifest,
      store: args.store,
    });
    const entries: Record<string, unknown>[] = selectDiscoveryOutputFields(
      body,
      selection.fields,
    );
    if (selection.fields.includes("contentRef")) {
      for (const [index, entry] of body.entries.entries()) {
        await args.store.verify(entry.content);
        const bytes = Buffer.from(
          await new Response(
            await args.store.open(entry.content),
          ).arrayBuffer(),
        );
        // Full retained bytes accompany selected refs; summaries and pointers alone supply no source body.
        entries[index]!.contentBody = {
          encoding: "base64",
          bytes: bytes.toString("base64"),
        };
      }
    }
    selected.push({
      producer: manifest.producer,
      role: manifest.role,
      schema: manifest.schema,
      source: manifest.source,
      status: manifest.status,
      disposition: manifest.disposition,
      body: manifest.body,
      fields: selection.fields,
      entries,
      authority:
        "Authenticated selected source observations; classifications are advisory and transfer no acceptance or mutation authority.",
    });
  }
  return selected;
}
