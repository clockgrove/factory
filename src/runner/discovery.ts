import { randomUUID } from "node:crypto";
import {
  readAdaptiveContextBytes,
  type AdaptiveContextSelection,
} from "../adaptive-context.js";
import type { GraphExpansionInputPacket } from "../graph-expansion.js";
import type { FactoryConfig } from "../config.js";
import { assertDiscoveryContextScope } from "../compiler/context.js";
import type {
  ContentStore,
  ContentRef,
  ExecutionDriver,
  GitHubGateway,
  WorkItem,
} from "../contracts.js";
import type { DiscoveryOutputManifest } from "../discovery.js";
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
    (state.schemaVersion !== 9 &&
      state.schemaVersion !== 11 &&
      state.schemaVersion !== 13 &&
      state.schemaVersion !== 15 &&
      ![17, 19].includes(state.schemaVersion)) ||
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
        captureContext: {
          configDigest: state.configDigest,
          objective: state.objective,
          runId: state.runId,
          attemptId: work.attempt,
        },
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
export interface SelectedDiscoveryInput {
  producer: DiscoveryOutputManifest["producer"];
  role: DiscoveryOutputManifest["role"];
  schema: DiscoveryOutputManifest["schema"];
  source: DiscoveryOutputManifest["source"];
  status: DiscoveryOutputManifest["status"];
  disposition: DiscoveryOutputManifest["disposition"];
  body: ContentRef;
  fields: string[];
  entries: Record<string, unknown>[];
  selectionScope?: {
    kind: "materialized-batch";
    receiptId: string;
    paths: string[];
    complete: boolean;
  };
  authority: string;
}
export function discoveryContextSelections(
  inputs: SelectedDiscoveryInput[],
): AdaptiveContextSelection[] {
  return inputs.map((input) => ({
    id: `discovery:${input.producer.itemId}:${input.body.digest}:${JSON.stringify(input.selectionScope?.paths ?? input.fields)}`,
    kind: "discovery",
    disposition: input.status === "complete" ? "current" : "incomplete",
    required: true,
    refs: [
      input.body,
      ...input.entries.flatMap((entry) =>
        entry.contentRef ? [entry.contentRef as ContentRef] : [],
      ),
    ],
  }));
}
export function discoveryContextBodies(
  inputs: SelectedDiscoveryInput[],
): { ref: ContentRef; bytes: Uint8Array }[] {
  const bodies = new Map<string, { ref: ContentRef; bytes: Uint8Array }>();
  for (const input of inputs)
    for (const entry of input.entries) {
      const ref = entry.contentRef as ContentRef | undefined;
      const body = entry.contentBody as
        | { encoding: string; bytes: string }
        | undefined;
      if (ref && body?.encoding === "base64")
        bodies.set(ref.digest, {
          ref,
          bytes: Buffer.from(body.bytes, "base64"),
        });
    }
  return [...bodies.values()];
}
/** Final review consumes each declared output role once, with the union of accepted fields. */
export async function objectiveDiscoveryInputs(args: {
  state: FactoryState;
  checkout: string;
  store: ContentStore;
}): Promise<SelectedDiscoveryInput[]> {
  const inputs: NonNullable<WorkItem["discoveryInputs"]> = [];
  for (const item of args.state.graph.items)
    for (const input of item.discoveryInputs ?? []) {
      const existing = inputs.find(
        (candidate) =>
          candidate.producerItemId === input.producerItemId &&
          candidate.role === input.role,
      );
      if (existing)
        existing.fields = [...new Set([...existing.fields, ...input.fields])];
      else inputs.push({ ...input, fields: [...input.fields] });
    }
  if (!inputs.length) return [];
  const item: WorkItem = {
    ...args.state.graph.items[0]!,
    id: "__controller-objective-review",
    dependencies: [...new Set(inputs.map((input) => input.producerItemId))],
    discoveryInputs: inputs,
    ownedPaths: [],
  };
  return selectedDiscoveryInputs({ ...args, item });
}
export async function selectedDiscoveryInputs(args: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  store: ContentStore;
}): Promise<SelectedDiscoveryInput[]> {
  const selected: SelectedDiscoveryInput[] = [];
  const expansion = args.state.expansionHistory?.find((receipt) =>
    receipt.childIds.includes(args.item.id),
  );
  let batch: string[] | undefined;
  let batchProducer: string | undefined;
  if (expansion) {
    const bytes = await readAdaptiveContextBytes(
      args.store,
      expansion.inputPacketRef,
    );
    const packet = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as GraphExpansionInputPacket;
    const index = expansion.childIds.indexOf(args.item.id);
    batch = packet.batches?.[index];
    if (
      packet.schemaVersion !== 1 ||
      packet.runId !== args.state.runId ||
      packet.parentGraphDigest !== expansion.parentGraphDigest ||
      packet.envelope?.id !== expansion.envelopeId ||
      expansion.inputPacketRef.digest !== expansion.materializationDigest ||
      !batch?.length ||
      JSON.stringify(batch) !== JSON.stringify(args.item.ownedPaths)
    )
      throw new Error(
        "Selected discovery batch differs from retained expansion scope",
      );
    batchProducer = packet.envelope.input.producerItemId;
  }
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
    // Only an authenticated materialization may reduce a declared complete inventory.
    // Ordinary declared consumers retain their full role/field contract.
    const relevantBody =
      batch && batchProducer === selection.producerItemId
        ? {
            ...body,
            entries: body.entries.filter((entry) =>
              batch!.includes(entry.path),
            ),
          }
        : body;
    if (
      batch &&
      batchProducer === selection.producerItemId &&
      relevantBody.entries.length !== batch.length
    )
      throw new Error(
        "Selected discovery batch lacks complete required entries",
      );
    const entries: Record<string, unknown>[] = selectDiscoveryOutputFields(
      relevantBody,
      selection.fields,
    );
    if (selection.fields.includes("contentRef")) {
      for (const [index, entry] of relevantBody.entries.entries()) {
        const bytes = await readAdaptiveContextBytes(args.store, entry.content);
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
      ...(batch && batchProducer === selection.producerItemId
        ? {
            selectionScope: {
              kind: "materialized-batch",
              receiptId: expansion!.id,
              paths: batch,
              complete: true,
            },
          }
        : {}),
      fields: selection.fields,
      entries,
      authority:
        "Authenticated selected source observations; classifications are advisory and transfer no acceptance or mutation authority.",
    });
  }
  return selected;
}
