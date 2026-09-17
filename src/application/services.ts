import { publishLocalWake } from "../control/local-wake.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { attemptRef } from "../control/attempts.js";
import { decodeEventTrailer } from "../control/receipts.js";
import type { DiscoveryLocatorStore } from "../control/discovery-locators.js";
import {
  parseFactoryEvent,
  type AttemptEvent,
  type FactoryEvent,
  type MediaEvent,
} from "../protocol/events.js";
import { boundedText, PROTOCOL_V2, safeId, sha256Digest } from "../protocol/limits.js";
import { implicitRestartBlocker } from "../control/recovery.js";
import {
  activationCancellation,
  activationRejection,
  latestActivation,
} from "../control/activations.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../protocol/policy.js";
import { assertNewRunBudgetIntent } from "../protocol/budget-intent.js";
import {
  deduplicateFactoryEvents,
  encodeEventComment,
  latestSupportedRun,
  hasCurrentWriterAuthority,
  nextEventSequence,
} from "../control/receipts.js";
import { buildExplanationReport } from "./explain.js";
import { buildReplayReport } from "./replay.js";
import { parseSuppliedReplaySnapshots } from "../replay/supplied.js";
import { buildStatusReport, type FactoryReadSnapshot } from "./status.js";
import type { RecoveryAssessment } from "../recovery/assessment.js";
import type {
  RecoveryRequestService,
  RecoveryProposalInput,
  RecoveryRequestInput,
} from "../recovery/requests.js";
import { buildDoctorReport, type DoctorChecks } from "./doctor.js";
import { buildPlanReport, type PlanInput, type PlanningContext } from "./plan.js";
import type { GitHubMutationTelemetry } from "../platform.js";
import { inspectCompilerEvaluation } from "./compiler-eval.js";
import type { CompiledGraphReadStore } from "../control/graphs.js";
import type { ObjectiveAssetStore } from "../assets/storage.js";
import {
  persistObjectiveAssetManifest,
  readObjectiveAssetManifest,
  readObjectiveAssetManifestByRequest,
} from "../assets/storage.js";
import {
  importObjectiveAsset,
  type ObjectiveAssetImport,
  type ObjectiveAssetImportMetadata,
} from "../assets/import.js";
import { withArtifactContentScope } from "../execution/artifact-content-scope.js";
import {
  canonicalAssetJson,
  MAX_OBJECTIVE_ASSETS,
  MAX_OBJECTIVE_ASSET_TOTAL_BYTES,
} from "../assets/contracts.js";
import { createAssetDecision } from "../media/lifecycle.js";
import type { AssetActivation, AssetDecision, AssetSet } from "../media/contracts.js";
import {
  createAssetActivation,
  persistAssetActivation,
  persistAssetDecision,
  readAssetActivation,
  readAssetDecisionByAssetSet,
  readAssetSet,
} from "../media/storage.js";

const uniqueDigests = z
  .array(sha256Digest)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, "descriptor digests must be unique");

const AssetDecisionInputCommon = {
  objective: z.number().int().positive(),
  requestId: safeId,
  assetSetDigest: sha256Digest,
};

export const AssetStatusInputSchema = z
  .object({
    objective: z.number().int().positive(),
    assetSetDigest: sha256Digest,
  })
  .strict();

export const AssetApprovalInputSchema = z
  .object({
    ...AssetDecisionInputCommon,
    kind: z.literal("approved"),
    selectedDescriptorDigests: uniqueDigests,
  })
  .strict();

export const AssetRejectionInputSchema = z
  .object({
    ...AssetDecisionInputCommon,
    kind: z.literal("rejected"),
    reason: boundedText(8_000),
  })
  .strict();

export const AssetRevisionInputSchema = z
  .object({
    ...AssetDecisionInputCommon,
    kind: z.literal("revision-requested"),
    reason: boundedText(8_000),
  })
  .strict();

export const AssetDecisionInputSchema = z.discriminatedUnion("kind", [
  AssetApprovalInputSchema,
  AssetRejectionInputSchema,
  AssetRevisionInputSchema,
]);
export type AssetDecisionInput = z.infer<typeof AssetDecisionInputSchema>;

export const APPLICATION_OPERATIONS = [
  "doctor",
  "assets-import",
  "assets-inspect",
  "asset-status",
  "asset-approve",
  "asset-reject",
  "asset-revise",
  "plan",
  "compiler-eval",
  "recovery-plan",
  "recovery-propose",
  "recovery-request",
  "status",
  "explain",
  "activate",
  "pause",
  "resume",
  "drain",
  "cloud-pause",
  "retry",
  "priority",
  "replay",
  "cancel",
  "controller-start",
  "controller-stop",
  "controller-restart",
  "controller-status",
  "controller-install",
  "controller-uninstall",
] as const;
export type ApplicationOperation = (typeof APPLICATION_OPERATIONS)[number];

export type ApplicationSnapshot = FactoryReadSnapshot;

export interface ApplicationReader {
  readObjective(number: number): Promise<ApplicationSnapshot>;
}

export interface ApplicationCommandStore extends Partial<DiscoveryLocatorStore> {
  /** Required for activation; other command-only ports may omit discovery repair. */
  ensureObjectiveLabel?(objective: number): Promise<void>;
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
  getAuthenticatedLogin(): Promise<string>;
}

export interface ControllerLifecycle {
  start(input: ControllerInput): Promise<unknown>;
  stop(input: ControllerInput): Promise<unknown>;
  restart(input: ControllerInput): Promise<unknown>;
  status(input: ControllerInput): Promise<unknown>;
  install(input: ControllerInput): Promise<unknown>;
  uninstall(input: ControllerInput): Promise<unknown>;
}
export interface ControllerInput {
  repository: string;
  checkout: string;
  requestId: string;
}

export interface ControllerLifecycleReceipt {
  operation: "start" | "stop" | "restart" | "status" | "install" | "uninstall";
  repository: string;
  checkout: string;
  requestId: string;
  accepted: false;
  status: "controller-implementation-pending";
}

/**
 * Phase 1's usable lifecycle boundary.  It gives every transport the same
 * deterministic, idempotent response without pretending that the Phase 2
 * repository controller or a system service has been installed.
 */
export class PendingControllerLifecycle implements ControllerLifecycle {
  private receipt(
    operation: ControllerLifecycleReceipt["operation"],
    input: ControllerInput,
  ): Promise<ControllerLifecycleReceipt> {
    return Promise.resolve({
      operation,
      ...input,
      accepted: false,
      status: "controller-implementation-pending",
    });
  }
  start(input: ControllerInput) {
    return this.receipt("start", input);
  }
  stop(input: ControllerInput) {
    return this.receipt("stop", input);
  }
  restart(input: ControllerInput) {
    return this.receipt("restart", input);
  }
  status(input: ControllerInput) {
    return this.receipt("status", input);
  }
  install(input: ControllerInput) {
    return this.receipt("install", input);
  }
  uninstall(input: ControllerInput) {
    return this.receipt("uninstall", input);
  }
}

export interface ServiceContext {
  owner: string;
  repo: string;
  reader: ApplicationReader;
  store?: ApplicationCommandStore;
  controller?: ControllerLifecycle;
  readBaseSha?: (defaultBranch: string) => Promise<string>;
  assessRecovery?: (snapshot: ApplicationSnapshot) => Promise<RecoveryAssessment>;
  recovery?: RecoveryRequestService;
  diagnostics?: DoctorChecks;
  planning?: PlanningContext;
  compilerEvaluationStore?: CompiledGraphReadStore;
  assetStore?: ObjectiveAssetStore;
  platformTelemetry?: () => GitHubMutationTelemetry;
}

export type ReadOperation =
  | "doctor"
  | "assets-inspect"
  | "asset-status"
  | "plan"
  | "compiler-eval"
  | "recovery-plan"
  | "status"
  | "explain"
  | "replay";
export type CommandOperation =
  | "pause"
  | "resume"
  | "drain"
  | "cloud-pause"
  | "retry"
  | "priority"
  | "cancel";

/** A single, injectable boundary used by transports. Reads can never reach a command store. */
export class FactoryApplicationService {
  constructor(private readonly context: ServiceContext) {}

  recoveryPropose(input: RecoveryProposalInput) {
    if (!this.context.recovery) throw new Error("recovery proposal service is not configured");
    return this.context.recovery.propose(input);
  }

  recoveryRequest(input: RecoveryRequestInput) {
    if (!this.context.recovery) throw new Error("recovery request service is not configured");
    return this.context.recovery.request(input);
  }

  async inspect(
    operation: ReadOperation,
    objective: number,
    workItem?: number,
    suppliedSnapshots?: unknown,
    causalAnnotations?: unknown,
  ): Promise<unknown> {
    if (causalAnnotations !== undefined && operation !== "compiler-eval")
      throw new Error("Causal annotations are accepted only by compiler-eval inspection.");
    if (suppliedSnapshots !== undefined && operation !== "replay") {
      throw new Error("Supplied admission snapshots are accepted only by replay inspection.");
    }
    const pinnedAdmissionSnapshots = parseSuppliedReplaySnapshots(suppliedSnapshots, objective);
    if (operation === "doctor") return this.doctor(objective);
    if (operation === "plan") return this.plan({ objective });
    if (operation === "recovery-plan") {
      if (workItem !== undefined) throw new Error("recovery-plan assesses the whole Objective");
      if (!this.context.assessRecovery) {
        throw new Error("recovery assessment reader is not configured");
      }
      try {
        const snapshot = await this.context.reader.readObjective(objective);
        return await this.context.assessRecovery(snapshot);
      } catch {
        throw new Error(
          "Recovery assessment unavailable: complete authenticated GitHub observations could not be obtained within inspection bounds. No execution was authorized; raw provider and issue content is suppressed.",
        );
      }
    }
    const snapshot = await this.context.reader.readObjective(objective);
    const repository = `${this.context.owner}/${this.context.repo}`;
    if (operation === "compiler-eval") {
      if (workItem !== undefined) throw new Error("compiler-eval assesses the whole Objective");
      if (!this.context.compilerEvaluationStore)
        throw new Error("compiler evaluation reader is not configured");
      return inspectCompilerEvaluation({
        repository,
        snapshot,
        store: this.context.compilerEvaluationStore,
        ...(causalAnnotations === undefined ? {} : { annotations: causalAnnotations }),
      });
    }
    if (operation === "status") {
      const status = buildStatusReport({
        repository,
        snapshot,
        ...(this.context.platformTelemetry
          ? { platformTelemetry: this.context.platformTelemetry() }
          : {}),
      });
      if (!status.compilerEvaluation || !this.context.compilerEvaluationStore) return status;
      try {
        const evaluation = await inspectCompilerEvaluation({
          repository,
          snapshot,
          store: this.context.compilerEvaluationStore,
        });
        return {
          ...status,
          compilerEvaluation: {
            availability: "observed" as const,
            policy: status.compilerEvaluation.policy,
            invocations: evaluation.invocationStatus,
            cumulativeUsage: evaluation.cumulativeUsage,
          },
        };
      } catch {
        return {
          ...status,
          compilerEvaluation: {
            ...status.compilerEvaluation,
            reason: "immutable compiler draft status could not be validated",
          },
        };
      }
    }
    if (operation === "explain") {
      return buildExplanationReport({ repository, snapshot, ...(workItem ? { workItem } : {}) });
    }
    if (operation === "replay") {
      return buildReplayReport({
        repository,
        snapshot,
        ...(pinnedAdmissionSnapshots === undefined ? {} : { pinnedAdmissionSnapshots }),
      });
    }
    return {
      operation,
      repository,
      objective: snapshot,
      ...(workItem ? { workItem } : {}),
    };
  }

  async importAssets(input: {
    objective: number;
    requestId: string;
    baseSha?: string;
    revision: number;
    assets: Array<{ source: ObjectiveAssetImport; metadata: ObjectiveAssetImportMetadata }>;
  }) {
    if (
      !this.context.assetStore ||
      !this.context.readBaseSha ||
      !this.context.diagnostics?.repositoryFacts
    )
      throw new Error("Objective asset storage is not configured");
    const snapshot = await this.context.reader.readObjective(input.objective);
    if (snapshot.closed) throw new Error("cannot bind assets to a closed Objective");
    const baseSha = input.baseSha ?? (await this.context.readBaseSha(snapshot.defaultBranch));
    const facts = await this.context.diagnostics.repositoryFacts();
    const authority = {
      repository: `${this.context.owner}/${this.context.repo}`,
      objective: input.objective,
      baseSha,
    };
    const replay = await readObjectiveAssetManifestByRequest({
      store: this.context.assetStore,
      authority,
      requestId: input.requestId,
    });
    if (replay) return this.assetImportResult(input.objective, baseSha, replay);
    if (!input.assets.length || input.assets.length > MAX_OBJECTIVE_ASSETS)
      throw new Error(`Objective asset batch must contain 1-${MAX_OBJECTIVE_ASSETS} entries`);
    const captured: Array<Awaited<ReturnType<typeof importObjectiveAsset>>> = [];
    let capturedBytes = 0;
    for (const { source, metadata } of input.assets) {
      const asset = await importObjectiveAsset(source, metadata, {
        repositoryPrivate: facts.private,
      });
      capturedBytes += asset.bytes.length;
      if (capturedBytes > MAX_OBJECTIVE_ASSET_TOTAL_BYTES)
        throw new Error("Objective asset batch exceeds the aggregate byte limit");
      captured.push(asset);
    }
    const assertCurrent = async () => {
      const current = await this.context.reader.readObjective(input.objective);
      if (current.closed || (await this.context.readBaseSha!(current.defaultBranch)) !== baseSha)
        throw new Error("Objective asset authority changed before publication");
    };
    const result = await withArtifactContentScope(() =>
      persistObjectiveAssetManifest({
        store: this.context.assetStore!,
        authority,
        requestId: input.requestId,
        revision: input.revision,
        assets: captured,
        assertCurrent,
      }),
    );
    return this.assetImportResult(input.objective, baseSha, result);
  }

  private assetImportResult(
    objective: number,
    baseSha: string,
    result: Awaited<ReturnType<typeof persistObjectiveAssetManifest>>,
  ) {
    return {
      operation: "assets-import",
      repository: `${this.context.owner}/${this.context.repo}`,
      objective,
      baseSha,
      manifestDigest: result.manifest.digest,
      manifestRef: result.ref,
      manifestCommit: result.commit,
      assets: result.manifest.assets.map(({ descriptor, storage }) => ({
        descriptorDigest: descriptor.digest,
        contentDigest: descriptor.content.digest,
        bytes: descriptor.content.bytes,
        mediaType: descriptor.content.inspection.mediaType,
        validation: descriptor.content.inspection.status,
        visibility: descriptor.visibility,
        path: descriptor.materializationPath,
        storageReceiptDigest: storage.digest,
      })),
    } as const;
  }

  async inspectAssets(input: { objective: number; baseSha: string; manifestDigest: string }) {
    if (!this.context.assetStore) throw new Error("Objective asset storage is not configured");
    const manifest = await readObjectiveAssetManifest({
      store: this.context.assetStore,
      authority: {
        repository: `${this.context.owner}/${this.context.repo}`,
        objective: input.objective,
        baseSha: input.baseSha,
      },
      digest: input.manifestDigest,
    });
    if (!manifest) throw new Error("Objective asset manifest was not found");
    return { operation: "assets-inspect", manifest };
  }

  async assetStatus(input: { objective: number; assetSetDigest: string }) {
    const command = AssetStatusInputSchema.parse(input);
    if (!this.context.assetStore) throw new Error("media asset storage is not configured");
    const snapshot = await this.context.reader.readObjective(command.objective);
    const resolved = await this.resolveReadyAssetSet(snapshot, command.assetSetDigest);
    const events = this.allEvents(snapshot);
    const decisionEvents = events.filter(
      (event) =>
        event.kind === "media" &&
        event.assetSetDigest === command.assetSetDigest &&
        event.event === "AssetDecisionRecorded",
    ) as MediaEvent[];
    if (decisionEvents.length > 1)
      throw new Error("asset set has multiple authenticated review decisions");
    const storedDecision = await readAssetDecisionByAssetSet({
      store: this.context.assetStore,
      authority: resolved.authority,
      runId: resolved.ready.runId,
      assetSetDigest: resolved.assetSet.digest,
    });
    const decisionEvent = decisionEvents[0];
    if (decisionEvent && !storedDecision)
      throw new Error("authenticated media decision has no durable record");
    if (storedDecision) {
      this.assertDecisionBinding(storedDecision.decision, resolved);
      await this.assertCommitParents(storedDecision.commit, [resolved.stored.commit]);
      if (decisionEvent) this.assertDecisionEvent(decisionEvent, storedDecision.decision, resolved);
    }
    const activationEvents = events.filter(
      (event) =>
        event.kind === "media" &&
        event.event === "AssetActivated" &&
        event.assetSetDigest === resolved.assetSet.digest,
    ) as MediaEvent[];
    if (activationEvents.length > 1)
      throw new Error("asset set has multiple authenticated activation receipts");
    let activation: {
      record: AssetActivation;
      ref: string;
      commit: string;
    } | null = null;
    if (storedDecision?.decision.kind === "approved") {
      const expected = createAssetActivation({
        assetSet: resolved.assetSet,
        decision: storedDecision.decision,
        producerReservationOid: resolved.ready.reservationOid,
      });
      activation = await readAssetActivation({
        store: this.context.assetStore,
        authority: resolved.authority,
        runId: resolved.ready.runId,
        digest: expected.digest,
      });
      if (activation && canonicalAssetJson(activation.record) !== canonicalAssetJson(expected))
        throw new Error("durable media activation differs from the approved selection");
      if (activation)
        await this.assertCommitParents(activation.commit, [
          storedDecision.commit,
          ...activation.record.selected.map(({ storage }) => storage.readyCommit),
        ]);
      if (activationEvents[0] && !activation)
        throw new Error("authenticated media activation has no durable record");
      if (activation && activationEvents[0])
        this.assertActivationEvent(
          activationEvents[0],
          activation.record,
          activation.commit,
          resolved,
        );
    } else if (activationEvents.length) {
      throw new Error("non-approved asset set has an authenticated activation receipt");
    }
    const state = !storedDecision
      ? "for-review"
      : !decisionEvent
        ? "decision-publication-pending"
        : storedDecision.decision.kind !== "approved"
          ? storedDecision.decision.kind
          : !activation || !activationEvents[0]
            ? "activation-publication-pending"
            : "approved";
    return {
      operation: "asset-status" as const,
      repository: resolved.authority.repository,
      objective: command.objective,
      runId: resolved.ready.runId,
      producer: {
        workItem: resolved.ready.workItem,
        attempt: resolved.ready.attempt,
        reservationOid: resolved.ready.reservationOid,
      },
      assetSet: {
        digest: resolved.assetSet.digest,
        ref: resolved.stored.ref,
        commit: resolved.stored.commit,
        variants: resolved.assetSet.variants.map(({ descriptor }) => ({
          descriptorDigest: descriptor.digest,
          name: descriptor.displayName,
          mediaType: descriptor.content.inspection.mediaType,
          bytes: descriptor.content.bytes,
          path: descriptor.materializationPath,
        })),
      },
      review: {
        state,
        decision: storedDecision
          ? {
              digest: storedDecision.decision.digest,
              ref: storedDecision.ref,
              commit: storedDecision.commit,
              kind: storedDecision.decision.kind,
              requestId: storedDecision.decision.requestId,
              requestedBy: storedDecision.decision.requestedBy,
              selectedDescriptorDigests: storedDecision.decision.selectedDescriptorDigests,
              ...(decisionEvent?.reason ? { reason: decisionEvent.reason } : {}),
            }
          : null,
        activation: activation
          ? {
              digest: activation.record.digest,
              ref: activation.ref,
              commit: activation.commit,
              selectedDescriptorDigests: activation.record.selected.map(
                ({ descriptor }) => descriptor.digest,
              ),
            }
          : null,
      },
    };
  }

  async assetDecision(input: AssetDecisionInput) {
    const command = AssetDecisionInputSchema.parse(input);
    if (!this.context.assetStore || !this.context.store)
      throw new Error("media decision storage is not configured");
    return this.serialize(command.objective, async () => {
      const snapshot = await this.context.reader.readObjective(command.objective);
      const events = this.allEvents(snapshot);
      const resolved = await this.resolveReadyAssetSet(snapshot, command.assetSetDigest);
      const runId = resolved.ready.runId;
      const actor = await this.context.store!.getAuthenticatedLogin();
      if (resolved.start.actor.toLowerCase() !== actor.toLowerCase())
        throw new Error("only the activating actor may decide produced media");
      const workItem = snapshot.workItems.find(({ number }) => number === resolved.ready.workItem);
      if (!workItem) throw new Error("media producer does not belong to this Objective");
      if (!workItem.id) throw new Error("media producer issue identity is unavailable");
      const { authority, assetSet, stored: storedSet } = resolved;
      const reason = command.kind === "approved" ? undefined : command.reason;
      const reasonDigest = reason ? createHash("sha256").update(reason).digest("hex") : undefined;
      const decision = createAssetDecision({
        kind: command.kind,
        requestId: command.requestId,
        requestedBy: actor,
        assetSet,
        producerReservationOid: resolved.ready.reservationOid,
        ...(command.kind === "approved"
          ? { selectedDescriptorDigests: command.selectedDescriptorDigests }
          : {}),
        ...(command.kind === "rejected" && reasonDigest ? { reasonDigest } : {}),
        ...(command.kind === "revision-requested" && reasonDigest
          ? { feedbackDigest: reasonDigest }
          : {}),
      });
      const requestEvents = events.filter(
        (event) =>
          event.kind === "media" &&
          event.event === "AssetDecisionRecorded" &&
          event.requestId === command.requestId,
      ) as MediaEvent[];
      if (requestEvents.some((event) => !this.isExactDecisionEvent(event, decision, resolved)))
        throw new Error(
          `idempotency key ${command.requestId} was already used for a different request`,
        );
      const setEvents = events.filter(
        (event) =>
          event.kind === "media" &&
          event.event === "AssetDecisionRecorded" &&
          event.assetSetDigest === assetSet.digest,
      ) as MediaEvent[];
      if (setEvents.some((event) => !this.isExactDecisionEvent(event, decision, resolved)))
        throw new Error("this asset set already has an immutable review decision");
      const existingEvent = setEvents[0];
      const priorBySet = await readAssetDecisionByAssetSet({
        store: this.context.assetStore!,
        authority,
        runId,
        assetSetDigest: assetSet.digest,
      });
      if (priorBySet && priorBySet.decision.digest !== decision.digest)
        throw new Error("this asset set already has an immutable review decision");
      if (priorBySet) {
        this.assertDecisionBinding(priorBySet.decision, resolved);
        await this.assertCommitParents(priorBySet.commit, [storedSet.commit]);
      }
      const exactReplay = Boolean(existingEvent || priorBySet);
      const assertCurrent = async () => {
        const current = await this.context.reader.readObjective(command.objective);
        const currentEvents = this.allEvents(current);
        if (!exactReplay) {
          const active = latestSupportedRun(
            current.factoryEvents ?? [],
            current.objectiveAuthority,
          );
          if (active?.runId !== runId)
            throw new Error("Factory run authority changed before media decision publication");
        }
        const currentResolved = await this.resolveReadyAssetSet(current, command.assetSetDigest);
        if (currentResolved.start.actor.toLowerCase() !== actor.toLowerCase())
          throw new Error("media decision actor authority changed before publication");
        if (
          currentEvents.some(
            (event) =>
              event.kind === "media" &&
              event.event === "AssetDecisionRecorded" &&
              event.assetSetDigest === assetSet.digest &&
              (event.decisionDigest !== decision.digest || event.requestId !== decision.requestId),
          )
        )
          throw new Error("this asset set already has another authenticated review decision");
        const durableDecision = await readAssetDecisionByAssetSet({
          store: this.context.assetStore!,
          authority,
          runId,
          assetSetDigest: assetSet.digest,
        });
        if (durableDecision && durableDecision.decision.digest !== decision.digest)
          throw new Error("this asset set already has another durable review decision");
        if (durableDecision) {
          this.assertDecisionBinding(durableDecision.decision, currentResolved);
          await this.assertCommitParents(durableDecision.commit, [currentResolved.stored.commit]);
        }
      };
      if (!exactReplay) {
        const active = latestSupportedRun(
          snapshot.factoryEvents ?? [],
          snapshot.objectiveAuthority,
        );
        if (active?.runId !== runId)
          throw new Error(
            `Objective #${snapshot.number} has no active Factory run for this asset set`,
          );
      }
      const storedDecision = await persistAssetDecision({
        store: this.context.assetStore!,
        authority,
        decision,
        parentOids: [storedSet.commit],
        assertCurrent,
      });
      let activationRecord: AssetActivation | undefined;
      let activationResult:
        | { digest: string; ref: string; commit: string; selectedDescriptorDigests: string[] }
        | undefined;
      if (decision.kind === "approved") {
        const activation = createAssetActivation({
          assetSet,
          decision,
          producerReservationOid: resolved.ready.reservationOid,
        });
        const existingActivation = await readAssetActivation({
          store: this.context.assetStore!,
          authority,
          runId,
          digest: activation.digest,
        });
        if (
          existingActivation &&
          canonicalAssetJson(existingActivation.record) !== canonicalAssetJson(activation)
        )
          throw new Error("durable media activation differs from the approved selection");
        if (existingActivation)
          await this.assertCommitParents(existingActivation.commit, [
            storedDecision.commit,
            ...activation.selected.map(({ storage }) => storage.readyCommit),
          ]);
        const storedActivation =
          existingActivation ??
          (await persistAssetActivation({
            store: this.context.assetStore!,
            authority,
            activation,
            parentOids: [
              storedDecision.commit,
              ...activation.selected.map(({ storage }) => storage.readyCommit),
            ],
            assertCurrent,
          }));
        activationRecord = activation;
        activationResult = {
          digest: activation.digest,
          ref: storedActivation.ref,
          commit: storedActivation.commit,
          selectedDescriptorDigests: activation.selected.map(({ descriptor }) => descriptor.digest),
        };
      }
      const now = await this.context.store!.serverTime();
      const event =
        existingEvent ??
        parseFactoryEvent({
          protocol: PROTOCOL_V2,
          kind: "media",
          event: "AssetDecisionRecorded",
          objective: command.objective,
          runId,
          sequence: nextEventSequence(events),
          at: now.toISOString(),
          workItem: resolved.ready.workItem,
          attempt: assetSet.attempt,
          reservationOid: resolved.ready.reservationOid,
          invocationDigest: assetSet.invocationDigest,
          assetSetDigest: assetSet.digest,
          decisionDigest: decision.digest,
          decisionKind: decision.kind,
          requestId: command.requestId,
          requestedBy: actor,
          ...(reason ? { reason } : {}),
        });
      if (!existingEvent) {
        await assertCurrent();
        await this.context.store!.addIssueComment(
          workItem.id,
          encodeEventComment(`Factory recorded media decision \`${decision.kind}\`.`, event),
        );
      }
      if (decision.kind === "approved" && activationResult && activationRecord) {
        const activationSnapshot = await this.context.reader.readObjective(command.objective);
        const activationEvents = this.allEvents(activationSnapshot);
        const priorActivation = activationEvents.find(
          (candidate) =>
            candidate.kind === "media" &&
            candidate.event === "AssetActivated" &&
            candidate.decisionDigest === decision.digest,
        );
        if (priorActivation && priorActivation.activationDigest !== activationResult.digest)
          throw new Error("media approval activation identity changed");
        if (priorActivation)
          this.assertActivationEvent(
            priorActivation as MediaEvent,
            activationRecord,
            activationResult.commit,
            resolved,
          );
        if (!priorActivation) {
          await assertCurrent();
          const fresh = await this.context.reader.readObjective(command.objective);
          const activationEvent = parseFactoryEvent({
            protocol: PROTOCOL_V2,
            kind: "media",
            event: "AssetActivated",
            objective: command.objective,
            runId,
            sequence: nextEventSequence(this.allEvents(fresh)),
            at: now.toISOString(),
            workItem: resolved.ready.workItem,
            attempt: assetSet.attempt,
            reservationOid: resolved.ready.reservationOid,
            invocationDigest: assetSet.invocationDigest,
            assetSetDigest: assetSet.digest,
            decisionDigest: decision.digest,
            activationDigest: activationResult.digest,
            activationCommitOid: activationResult.commit,
          });
          await this.context.store!.addIssueComment(
            workItem.id,
            encodeEventComment(
              "Factory activated the approved immutable asset selection.",
              activationEvent,
            ),
          );
        }
      }
      await this.notifyRequest(event);
      return {
        operation: this.assetDecisionOperation(decision.kind),
        repository: authority.repository,
        objective: command.objective,
        runId,
        producer: {
          workItem: resolved.ready.workItem,
          attempt: resolved.ready.attempt,
          reservationOid: resolved.ready.reservationOid,
        },
        assetSetDigest: assetSet.digest,
        decision: {
          digest: decision.digest,
          ref: storedDecision.ref,
          commit: storedDecision.commit,
          kind: decision.kind,
          requestId: decision.requestId,
          requestedBy: actor,
          selectedDescriptorDigests: decision.selectedDescriptorDigests,
          ...(reason ? { reason } : {}),
        },
        ...(activationResult ? { activation: activationResult } : {}),
      };
    });
  }

  private assetDecisionOperation(kind: AssetDecision["kind"]) {
    if (kind === "approved") return "asset-approve" as const;
    if (kind === "rejected") return "asset-reject" as const;
    return "asset-revise" as const;
  }

  private assertDecisionBinding(
    decision: AssetDecision,
    resolved: {
      ready: MediaEvent;
      assetSet: AssetSet;
    },
  ) {
    const { ready, assetSet } = resolved;
    if (
      decision.runId !== ready.runId ||
      decision.intentId !== assetSet.intentId ||
      decision.intentDigest !== assetSet.intentDigest ||
      decision.producerWorkItem !== ready.workItem ||
      decision.producerAttempt !== ready.attempt ||
      decision.producerReservationOid !== ready.reservationOid ||
      decision.assetSetDigest !== assetSet.digest ||
      decision.invocationDigest !== ready.invocationDigest ||
      decision.storageManifestDigest !== assetSet.storageManifestDigest
    )
      throw new Error("durable media decision differs from authenticated asset-set authority");
  }

  private isExactDecisionEvent(
    event: MediaEvent,
    decision: AssetDecision,
    resolved: { ready: MediaEvent; assetSet: AssetSet },
  ) {
    const reasonDigest = event.reason
      ? createHash("sha256").update(event.reason).digest("hex")
      : null;
    return (
      event.event === "AssetDecisionRecorded" &&
      event.objective === resolved.ready.objective &&
      event.runId === decision.runId &&
      event.workItem === decision.producerWorkItem &&
      event.attempt === decision.producerAttempt &&
      event.reservationOid === decision.producerReservationOid &&
      event.invocationDigest === decision.invocationDigest &&
      event.assetSetDigest === decision.assetSetDigest &&
      event.decisionDigest === decision.digest &&
      event.decisionKind === decision.kind &&
      event.requestId === decision.requestId &&
      event.requestedBy?.toLowerCase() === decision.requestedBy.toLowerCase() &&
      (decision.kind === "approved"
        ? event.reason === undefined
        : decision.kind === "rejected"
          ? reasonDigest === decision.reasonDigest
          : reasonDigest === decision.feedbackDigest)
    );
  }

  private assertDecisionEvent(
    event: MediaEvent,
    decision: AssetDecision,
    resolved: { ready: MediaEvent; assetSet: AssetSet },
  ) {
    if (!this.isExactDecisionEvent(event, decision, resolved))
      throw new Error("authenticated media decision differs from its durable record");
  }

  private assertActivationEvent(
    event: MediaEvent,
    activation: AssetActivation,
    activationCommit: string,
    resolved: { ready: MediaEvent; assetSet: AssetSet },
  ) {
    if (
      event.event !== "AssetActivated" ||
      event.objective !== resolved.ready.objective ||
      event.runId !== activation.runId ||
      event.workItem !== activation.producerWorkItem ||
      event.attempt !== activation.producerAttempt ||
      event.reservationOid !== activation.producerReservationOid ||
      event.invocationDigest !== resolved.assetSet.invocationDigest ||
      event.assetSetDigest !== activation.assetSetDigest ||
      event.decisionDigest !== activation.decisionDigest ||
      event.activationDigest !== activation.digest ||
      event.activationCommitOid !== activationCommit
    )
      throw new Error("authenticated media activation differs from its durable record");
  }

  private async assertCommitParents(commitOid: string, expectedParentOids: string[]) {
    if (!this.context.assetStore) throw new Error("media asset storage is not configured");
    const commit = await this.context.assetStore.readCommit(commitOid);
    const observed = [...commit.parentOids].sort();
    const expected = [...new Set(expectedParentOids)].sort();
    if (commit.oid !== commitOid || canonicalAssetJson(observed) !== canonicalAssetJson(expected))
      throw new Error("immutable media record has changed parent authority");
  }

  private async resolveReadyAssetSet(snapshot: ApplicationSnapshot, digest: string) {
    if (!this.context.assetStore) throw new Error("media asset storage is not configured");
    const events = this.allEvents(snapshot);
    const readyEvents = events.filter(
      (event) =>
        event.kind === "media" &&
        event.event === "AssetSetReady" &&
        event.assetSetDigest === digest,
    ) as MediaEvent[];
    if (readyEvents.length !== 1)
      throw new Error("asset set requires exactly one authenticated ready event");
    const ready = readyEvents[0]!;
    const starts = events.filter(
      (event) =>
        event.kind === "run" && event.event === "FactoryRunStarted" && event.runId === ready.runId,
    );
    if (starts.length !== 1) throw new Error("asset set run authority is ambiguous");
    const start = starts[0]!;
    const reservations = events.filter(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptReserved" &&
        event.runId === ready.runId &&
        event.workItem === ready.workItem &&
        event.attempt === ready.attempt &&
        event.mediaInvocation?.digest === ready.invocationDigest,
    ) as AttemptEvent[];
    if (reservations.length !== 1)
      throw new Error("asset set producer reservation is missing or ambiguous");
    const reservation = reservations[0]!;
    const ref = attemptRef(snapshot.number, ready.workItem, ready.attempt);
    if ((await this.context.assetStore.readRef(ref)) !== ready.reservationOid)
      throw new Error("asset set ready event differs from the immutable producer reservation");
    const reservationCommit = await this.context.assetStore.readCommit(ready.reservationOid);
    const committedReservation = decodeEventTrailer(reservationCommit.message);
    if (
      reservationCommit.oid !== ready.reservationOid ||
      reservationCommit.parentOids.length !== 1 ||
      reservationCommit.parentOids[0] !== reservation.baseSha ||
      committedReservation?.kind !== "attempt" ||
      committedReservation.event !== "AttemptReserved" ||
      canonicalAssetJson(committedReservation) !== canonicalAssetJson(reservation) ||
      committedReservation.objective !== snapshot.number ||
      committedReservation.runId !== ready.runId ||
      committedReservation.workItem !== ready.workItem ||
      committedReservation.attempt !== ready.attempt ||
      committedReservation.mediaInvocation?.digest !== ready.invocationDigest
    )
      throw new Error("asset set producer reservation commit differs from authenticated evidence");
    const authority = {
      repository: `${this.context.owner}/${this.context.repo}`,
      objective: snapshot.number,
      baseSha: reservation.baseSha,
    };
    const stored = await readAssetSet({
      store: this.context.assetStore,
      authority,
      runId: ready.runId,
      digest,
    });
    if (!stored) throw new Error("authenticated asset set record is unavailable");
    const assetSet = stored.record;
    if (
      stored.commit !== ready.assetSetCommitOid ||
      canonicalAssetJson(assetSet.authority) !== canonicalAssetJson(authority) ||
      assetSet.runId !== ready.runId ||
      assetSet.workItem !== ready.workItem ||
      assetSet.attempt !== ready.attempt ||
      assetSet.invocationDigest !== ready.invocationDigest ||
      reservation.mediaInvocation?.digest !== assetSet.invocationDigest ||
      reservation.mediaInvocation.intentDigest !== assetSet.intentDigest
    )
      throw new Error("asset set differs from its authenticated ready evidence");
    await this.assertCommitParents(
      stored.commit,
      assetSet.variants.map(({ storage }) => storage.readyCommit),
    );
    if (start.kind !== "run" || start.event !== "FactoryRunStarted")
      throw new Error("asset set run authority is invalid");
    return { ready, reservation, start, authority, stored, assetSet };
  }

  doctor(objective: number, checkout?: string) {
    checkout ??= this.context.planning?.repositoryPath;
    return buildDoctorReport({
      repository: `${this.context.owner}/${this.context.repo}`,
      objective,
      ...(checkout ? { checkout } : {}),
      readObjective: () => this.context.reader.readObjective(objective),
      checks: {
        ...this.context.diagnostics,
        ...((this.context.diagnostics?.controller ?? this.context.controller)
          ? { controller: this.context.diagnostics?.controller ?? this.context.controller! }
          : {}),
      },
    });
  }
  async plan(input: number | PlanInput) {
    const request = typeof input === "number" ? { objective: input } : input;
    const snapshot = await this.context.reader.readObjective(request.objective);
    return buildPlanReport({
      repository: `${this.context.owner}/${this.context.repo}`,
      request,
      snapshot,
      ...(this.context.planning ? { planning: this.context.planning } : {}),
    });
  }
  status(objective: number) {
    return this.inspect("status", objective);
  }
  explain(objective: number, workItem?: number) {
    return this.inspect("explain", objective, workItem);
  }
  replay(objective: number, pinnedAdmissionSnapshots?: unknown) {
    return this.inspect("replay", objective, undefined, pinnedAdmissionSnapshots);
  }

  async activate(input: {
    objective: number;
    requestId: string;
    baseSha?: string;
    assetManifestDigest?: string;
    policy?: unknown;
  }): Promise<FactoryEvent> {
    if (!this.context.store?.ensureObjectiveLabel)
      throw new Error("activation requires Objective discovery-label support");
    const snapshot = await this.context.reader.readObjective(input.objective);
    return this.append(snapshot, input.requestId, async (current) => {
      const prior = this.allEvents(current).find(
        (event) =>
          event.kind === "run" &&
          event.event === "ActivationRequested" &&
          event.requestId === input.requestId,
      );
      const activation =
        prior?.kind === "run" && prior.event === "ActivationRequested" ? prior : undefined;
      // Omitted fields on exact replay mean the accepted immutable binding,
      // not today's branch head or defaults. Resolve under the request gate.
      const policy = parseRunPolicy(input.policy ?? activation?.policy ?? DEFAULT_RUN_POLICY);
      // An exact old request may return its original receipt; it cannot grant a
      // different activation today's implicit legacy budget interpretation.
      if (!activation || policyDigest(policy) !== activation.policyDigest)
        assertNewRunBudgetIntent(policy);
      const baseSha =
        input.baseSha ?? activation?.baseSha ?? (await this.requireBaseSha(current.defaultBranch));
      const assetManifestDigest = input.assetManifestDigest ?? activation?.assetManifestDigest;
      return {
        event: "ActivationRequested",
        runId: input.requestId,
        repository: `${this.context.owner}/${this.context.repo}`,
        baseSha,
        ...(assetManifestDigest ? { assetManifestDigest } : {}),
        policy,
        policyDigest: policyDigest(policy),
        controllerProtocolMin: PROTOCOL_V2,
        controllerProtocolMax: PROTOCOL_V2,
      };
    });
  }

  async command(
    operation: CommandOperation,
    input: {
      objective: number;
      requestId: string;
      reason?: string;
      workItem?: number;
      priorityRank?: number;
    },
  ): Promise<FactoryEvent> {
    const snapshot = await this.context.reader.readObjective(input.objective);
    if (operation === "cancel")
      return this.append(snapshot, input.requestId, async (current) => {
        const events = this.allEvents(current);
        const prior = events.find(
          (event) => "requestId" in event && event.requestId === input.requestId,
        );
        if (prior?.kind === "run" && prior.event === "ActivationCancellationRequested")
          return {
            event: prior.event,
            runId: prior.runId,
            activationRequestId: prior.activationRequestId,
            repository: prior.repository,
            baseSha: prior.baseSha,
            policyDigest: prior.policyDigest,
            ...(prior.assetManifestDigest
              ? { assetManifestDigest: prior.assetManifestDigest }
              : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          };
        const active = latestSupportedRun(current.factoryEvents ?? [], current.objectiveAuthority);
        if (active || prior)
          return {
            event: "FactoryRunCancellationRequested",
            runId: prior?.runId ?? active!.runId,
            ...(input.reason ? { reason: input.reason } : {}),
          };
        const activation = latestActivation(events, current.number);
        if (
          !activation ||
          events.some(
            (event) =>
              event.kind === "run" &&
              ((event.event === "FactoryRunStarted" &&
                event.activationRequestId === activation.requestId) ||
                (event.event === "ActivationRejected" &&
                  event.activationRequestId === activation.requestId &&
                  event.runId === activation.runId &&
                  event.requestedBy.toLowerCase() === activation.requestedBy.toLowerCase() &&
                  event.baseSha === activation.baseSha &&
                  event.policyDigest === activation.policyDigest &&
                  event.assetManifestDigest === activation.assetManifestDigest)),
          )
        )
          throw new Error(
            `Objective #${current.number} has no active Factory run or pending activation`,
          );
        return {
          event: "ActivationCancellationRequested",
          runId: activation.runId,
          activationRequestId: activation.requestId,
          repository: activation.repository,
          baseSha: activation.baseSha,
          policyDigest: activation.policyDigest,
          ...(activation.assetManifestDigest
            ? { assetManifestDigest: activation.assetManifestDigest }
            : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        };
      });
    if ((operation === "retry" || operation === "priority") && !input.workItem) {
      throw new Error(`${operation} requires a Work Item number`);
    }
    if (operation === "priority" && input.priorityRank === undefined) {
      throw new Error("priority requires a priority rank");
    }
    const event =
      operation === "pause"
        ? "RunPauseRequested"
        : operation === "resume"
          ? "RunResumeRequested"
          : operation === "drain"
            ? "RunDrainRequested"
            : operation === "cloud-pause"
              ? "CloudPauseRequested"
              : operation === "retry"
                ? "WorkItemRetryRequested"
                : operation === "priority"
                  ? "WorkItemPriorityChanged"
                  : "FactoryRunCancellationRequested";
    // Durable receipts remain replayable after a run becomes terminal or a
    // Work Item leaves the live snapshot. appendLocked still compares every
    // material field before returning the original receipt.
    const existingRequest = this.allEvents(snapshot).find(
      (candidate) => "requestId" in candidate && candidate.requestId === input.requestId,
    );
    const activeRun = latestSupportedRun(snapshot.factoryEvents ?? [], snapshot.objectiveAuthority);
    if (!activeRun && !existingRequest) {
      throw new Error(`Objective #${snapshot.number} has no active Factory run`);
    }
    if (
      !existingRequest &&
      input.workItem &&
      !snapshot.workItems.some((item) => item.number === input.workItem)
    ) {
      throw new Error(
        `Work Item #${input.workItem} does not belong to Objective #${snapshot.number}`,
      );
    }
    return this.append(snapshot, input.requestId, {
      event,
      runId: existingRequest?.runId ?? activeRun!.runId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.workItem ? { workItem: input.workItem } : {}),
      ...(input.priorityRank !== undefined ? { priorityRank: input.priorityRank } : {}),
      ...(operation === "priority" ? { prioritySource: "operator-command" } : {}),
    });
  }

  async controller(
    operation: "start" | "stop" | "restart" | "status" | "install" | "uninstall",
    input: ControllerInput,
  ): Promise<unknown> {
    const lifecycle = this.context.controller;
    if (!lifecycle) throw new Error("controller lifecycle is unavailable on this host");
    const key = `${input.repository.toLowerCase()}:${input.requestId}`;
    const fingerprint = JSON.stringify({
      operation,
      repository: input.repository,
      checkout: input.checkout,
    });
    const prior = FactoryApplicationService.controllerRequests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error(
          `idempotency key ${input.requestId} was already used for a different request`,
        );
      return prior.receipt;
    }
    const receipt = lifecycle[operation](input);
    FactoryApplicationService.controllerRequests.set(key, {
      fingerprint,
      receipt,
    });
    receipt.catch(() => {
      if (FactoryApplicationService.controllerRequests.get(key)?.receipt === receipt) {
        FactoryApplicationService.controllerRequests.delete(key);
      }
    });
    return receipt;
  }

  private async requireBaseSha(defaultBranch: string): Promise<string> {
    if (!this.context.readBaseSha) throw new Error("activation requires a base SHA");
    return this.context.readBaseSha(defaultBranch);
  }

  private allEvents(snapshot: ApplicationSnapshot): FactoryEvent[] {
    return deduplicateFactoryEvents([
      ...(snapshot.factoryEvents ?? []),
      ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
    ]);
  }

  private async append(
    snapshot: ApplicationSnapshot,
    requestId: string,
    fields:
      | Record<string, unknown>
      | ((current: ApplicationSnapshot) => Promise<Record<string, unknown>>),
  ): Promise<FactoryEvent> {
    return this.serialize(snapshot.number, async () => {
      // A request may have waited behind an equivalent request. Reconstruct
      // from GitHub while holding the process-wide repository/objective gate;
      // never decide idempotency from the caller's stale snapshot.
      snapshot = await this.context.reader.readObjective(snapshot.number);
      return this.appendLocked(
        snapshot,
        requestId,
        typeof fields === "function" ? await fields(snapshot) : fields,
      );
    });
  }

  private async appendLocked(
    snapshot: ApplicationSnapshot,
    requestId: string,
    fields: Record<string, unknown>,
  ): Promise<FactoryEvent> {
    const store = this.context.store;
    if (!store) throw new Error("this application service is read-only");
    const existing = this.allEvents(snapshot).find(
      (event) => "requestId" in event && event.requestId === requestId,
    );
    if (fields.event === "ActivationCancellationRequested") {
      const activation = this.allEvents(snapshot).find(
        (event) =>
          event.kind === "run" &&
          event.event === "ActivationRequested" &&
          event.requestId === fields.activationRequestId,
      );
      const actor = await store.getAuthenticatedLogin();
      if (
        activation?.kind !== "run" ||
        activation.event !== "ActivationRequested" ||
        activation.requestedBy.toLowerCase() !== actor.toLowerCase()
      )
        throw new Error("only the activating actor may withdraw this activation");
      if (
        activation.objective !== snapshot.number ||
        activation.runId !== activation.requestId ||
        activation.repository.toLowerCase() !==
          `${this.context.owner}/${this.context.repo}`.toLowerCase() ||
        policyDigest(activation.policy) !== activation.policyDigest ||
        fields.runId !== activation.runId ||
        fields.repository !== activation.repository ||
        fields.baseSha !== activation.baseSha ||
        fields.policyDigest !== activation.policyDigest ||
        fields.assetManifestDigest !== activation.assetManifestDigest
      )
        throw new Error("activation cancellation differs from its immutable activation binding");
    }
    if (existing) {
      const comparableKeys = [
        "event",
        "operation",
        "repository",
        "activationRequestId",
        "baseSha",
        "assetManifestDigest",
        "policyDigest",
        "workItem",
        "priorityRank",
        "prioritySource",
        "reason",
      ];
      if (fields.runId !== undefined) comparableKeys.push("runId");
      const conflict = comparableKeys.some(
        (key) => (existing as unknown as Record<string, unknown>)[key] !== fields[key],
      );
      if (conflict)
        throw new Error(`idempotency key ${requestId} was already used for a different request`);
      await this.reconcileRequestDiscovery(snapshot, existing);
      if (fields.event === "ActivationRequested")
        await store.ensureObjectiveLabel!(snapshot.number);
      await this.notifyRequest(existing);
      return existing;
    }
    if (fields.event === "ActivationRequested") {
      const blocker = implicitRestartBlocker(snapshot);
      if (blocker) throw new Error(blocker);
    }
    const actor = await store.getAuthenticatedLogin();
    const activeStart = latestSupportedRun(
      snapshot.factoryEvents ?? [],
      snapshot.objectiveAuthority,
    );
    if (
      new Set([
        "FactoryRunCancellationRequested",
        "RunPauseRequested",
        "RunResumeRequested",
        "RunDrainRequested",
        "CloudPauseRequested",
        "WorkItemRetryRequested",
        "WorkItemPriorityChanged",
      ]).has(String(fields.event))
    ) {
      if (!activeStart || activeStart.runId !== fields.runId) {
        throw new Error(`Objective #${snapshot.number} has no active Factory run`);
      }
      if (
        activeStart.kind === "run" &&
        activeStart.event === "FactoryRunStarted" &&
        activeStart.actor.toLowerCase() !== actor.toLowerCase()
      ) {
        throw new Error(`only activating actor ${activeStart.actor} may control this run`);
      }
      if (
        typeof fields.workItem === "number" &&
        !snapshot.workItems.some((item) => item.number === fields.workItem)
      ) {
        throw new Error(
          `Work Item #${fields.workItem} does not belong to Objective #${snapshot.number}`,
        );
      }
    }
    const now = await store.serverTime();
    const run = [...(snapshot.factoryEvents ?? [])].reverse().find((event) => event.kind === "run");
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: fields.event,
      objective: snapshot.number,
      runId: typeof fields.runId === "string" ? fields.runId : (run?.runId ?? requestId),
      sequence: nextEventSequence(this.allEvents(snapshot)),
      at: now.toISOString(),
      requestedBy: actor,
      requestId,
      ...fields,
    });
    await store.addIssueComment(
      snapshot.id,
      encodeEventComment(`Factory accepted ${String(fields.event)} from ${actor}.`, event),
    );
    await this.reconcileRequestDiscovery(snapshot, event);
    if (fields.event === "ActivationRequested") await store.ensureObjectiveLabel!(snapshot.number);
    await this.notifyRequest(event);
    return event;
  }

  private async notifyRequest(event: FactoryEvent): Promise<void> {
    if (!("requestId" in event) || typeof event.requestId !== "string") return;
    const repository = `${this.context.owner}/${this.context.repo}`;
    const publishedAt = Date.now();
    // Discovery also observes commands for runs with no active local Supervisor.
    await publishLocalWake({ repository }, event.requestId, publishedAt);
    if (event.event !== "ActivationRequested" && event.event !== "ActivationCancellationRequested")
      await publishLocalWake(
        { repository, objective: event.objective },
        event.requestId,
        publishedAt,
      );
  }

  /** A request disposition retires only request retrieval hints. It never
   * certifies resource/accounting settlement or deletes a run generation. */
  private async reconcileRequestDiscovery(
    snapshot: ApplicationSnapshot,
    request: FactoryEvent,
  ): Promise<void> {
    if (!("requestId" in request) || typeof request.requestId !== "string") return;
    const store = this.context.store!;
    const events = deduplicateFactoryEvents([...this.allEvents(snapshot), request]);
    const activation =
      request.event === "ActivationRequested"
        ? request
        : request.event === "ActivationCancellationRequested"
          ? events.find(
              (event) =>
                event.event === "ActivationRequested" &&
                event.requestId === request.activationRequestId,
            )
          : undefined;
    const start = events.find(
      (event) =>
        event.event === "FactoryRunStarted" &&
        (activation?.event === "ActivationRequested"
          ? event.activationRequestId === activation.requestId &&
            event.baseSha === activation.baseSha &&
            event.policyDigest === activation.policyDigest &&
            event.assetManifestDigest === activation.assetManifestDigest &&
            event.actor.toLowerCase() === activation.requestedBy.toLowerCase()
          : event.runId === request.runId),
    );
    if (activation?.event === "ActivationRequested" && !start) {
      const binding = {
        objective: activation.objective,
        requestId: activation.requestId,
        requestedBy: activation.requestedBy,
        repository: activation.repository,
        baseSha: activation.baseSha,
        policyDigest: activation.policyDigest,
        ...(activation.assetManifestDigest
          ? { assetManifestDigest: activation.assetManifestDigest }
          : {}),
      };
      const withdrawal = activationCancellation(events, binding);
      if (withdrawal || activationRejection(events, binding)) {
        for (const requestId of new Set([
          activation.requestId,
          ...(withdrawal ? [withdrawal.requestId] : []),
        ]))
          await store.retireDiscoveryLocator?.({
            kind: "request",
            objective: snapshot.number,
            requestId,
          });
        return;
      }
    }
    const disposed = events.some(
      (event) =>
        start !== undefined &&
        event.runId === start.runId &&
        event.sequence > start.sequence &&
        hasCurrentWriterAuthority(event, events, snapshot.objectiveAuthority) &&
        (["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
          event.event,
        ) ||
          ((event.event === "RunPauseAcknowledged" || event.event === "RunDrainCompleted") &&
            event.commandRequestId === request.requestId &&
            event.sequence > request.sequence)),
    );
    if (disposed)
      await store.retireDiscoveryLocator?.({
        kind: "request",
        objective: snapshot.number,
        requestId: request.requestId,
      });
    else
      await store.ensureDiscoveryLocator?.({
        kind: "request",
        objective: snapshot.number,
        requestId: request.requestId,
      });
  }

  private static readonly queues = new Map<string, Promise<void>>();
  private static readonly controllerRequests = new Map<
    string,
    { fingerprint: string; receipt: Promise<unknown> }
  >();

  private async serialize<T>(objective: number, action: () => Promise<T>): Promise<T> {
    const key = `${this.context.owner.toLowerCase()}/${this.context.repo.toLowerCase()}#${objective}`;
    const previous = FactoryApplicationService.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    FactoryApplicationService.queues.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (FactoryApplicationService.queues.get(key) === current)
        FactoryApplicationService.queues.delete(key);
    }
  }
}
