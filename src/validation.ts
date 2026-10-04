import { objectiveCandidate } from "./qa.js";
import { installedControllerCapabilities } from "./controller-capabilities.js";
import { assertGraphRevisions } from "./graph-amendments.js";
import {
  allowanceKey,
  assertRepairLedger,
  failureDigest,
  repairScopes,
} from "./repair-policy.js";
import { ownsPath } from "./ownership.js";
import {
  CandidateValidationFailure,
  CandidateEnvironmentFailure,
} from "./work-repair.js";
import { assertWorkspacePackageChange } from "./workspace-membership.js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import type {
  CapturedAssetSet,
  ContentStore,
  ModelInvocationContext,
  PlanningModel,
  ResultReviewEvidenceSource,
  ValidationCommandReceipt,
  ValidationLfsMember,
  WorkItem,
  WorkDiscovery,
} from "./contracts.js";
import { CompletedModelInvocationError, Interruption } from "./contracts.js";
import {
  attachedFault,
  attachFault,
  decision as askOperator,
} from "./fault.js";
import { assetSelectionDigest, type HydrationReceipt } from "./media.js";
import {
  addWorktree,
  hasUnresolvedSubprocesses,
  localValidationEnvironment,
  localValidationShellArguments,
  pinnedGit,
  pinnedGitEnvironment,
  pinnedGitRaw,
  removeWorktree,
  subprocessAsync,
} from "./process.js";
import {
  decodeReview,
  type ReviewEvidenceReference,
  resolveReviewReferences,
  reviewPacket,
} from "./review-evidence.js";
import type { AcceptancePending, FactoryState, WorkState } from "./state.js";

export interface CriterionEvidence {
  criterion: string;
  verdict: "pass" | "human-accept";
  source?: string;
  quote?: string;
  evidence?: ReviewEvidenceReference[];
  detail: string;
}

export interface AcceptanceDecision {
  criterion: string;
  treeSha: string;
  actor: string;
  at: string;
  outcome: "accept" | "refuse";
  reason: string;
}

export class AcceptanceDecisionRequired extends Error {
  constructor(
    public readonly pending: AcceptancePending,
    options?: ErrorOptions,
  ) {
    super(
      `Acceptance decision required for ${pending.criterion}: ${pending.question}`,
      options,
    );
  }
}

export interface ValidationEvidence {
  treeSha: string;
  commands: ValidationCommandReceipt[];
  selectedLfs?: SelectedLfsValidation[];
  hydrationReceipt?: HydrationReceipt;
  worktreeObservation?: ValidationWorktreeObservation;
  criteria?: CriterionEvidence[];
}

export interface ValidationWorktreeObservation {
  treeSha: string;
  initialStatus: "clean";
  /** Status may differ from empty only because selected bytes were hydrated. */
  postHydrationStatus: { porcelainSha256: string; empty: boolean };
  postCommandStatus: "unchanged";
  selectedLfsMembers: number;
  subprocessOwnership: "settled";
}

/** Retained absence is not a fabricated successful observation. */
export function assertValidationWorktreeObservation(
  value: unknown,
  treeSha: string,
  selectedLfs: SelectedLfsValidation[] = [],
): asserts value is ValidationWorktreeObservation | undefined {
  if (value === undefined) return;
  const observation = value as ValidationWorktreeObservation;
  const emptyDigest = createHash("sha256").update("").digest("hex");
  if (
    !observation ||
    typeof observation !== "object" ||
    Array.isArray(observation) ||
    Object.keys(observation).sort().join() !==
      [
        "treeSha",
        "initialStatus",
        "postHydrationStatus",
        "postCommandStatus",
        "selectedLfsMembers",
        "subprocessOwnership",
      ]
        .sort()
        .join() ||
    observation.treeSha !== treeSha ||
    !/^[a-f0-9]{40}$/.test(observation.treeSha) ||
    observation.initialStatus !== "clean" ||
    observation.postCommandStatus !== "unchanged" ||
    observation.subprocessOwnership !== "settled" ||
    !Number.isSafeInteger(observation.selectedLfsMembers) ||
    observation.selectedLfsMembers !== selectedLfs.length ||
    !observation.postHydrationStatus ||
    typeof observation.postHydrationStatus !== "object" ||
    Array.isArray(observation.postHydrationStatus) ||
    Object.keys(observation.postHydrationStatus).sort().join() !==
      "empty,porcelainSha256" ||
    typeof observation.postHydrationStatus.empty !== "boolean" ||
    typeof observation.postHydrationStatus.porcelainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(observation.postHydrationStatus.porcelainSha256) ||
    observation.postHydrationStatus.empty !==
      (observation.postHydrationStatus.porcelainSha256 === emptyDigest) ||
    (!observation.postHydrationStatus.empty && !selectedLfs.length)
  )
    throw new Error(
      "Validator worktree observation differs from its canonical exact-tree evidence",
    );
}

export interface SelectedLfsValidation {
  treeSha: string;
  destination: string;
  digest: string;
  bytes: number;
  filter: "lfs";
}

export function assertSelectedLfsValidation(
  value: unknown,
  treeSha: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new Error("Invalid selected LFS validation evidence");
  const destinations = new Set<string>();
  for (const receipt of value) {
    if (
      !receipt ||
      receipt.treeSha !== treeSha ||
      typeof receipt.destination !== "string" ||
      !safeValidationPath(receipt.destination) ||
      destinations.has(receipt.destination) ||
      typeof receipt.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.digest) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.filter !== "lfs"
    )
      throw new Error(
        "Selected LFS validation evidence differs from the exact tree or member",
      );
    destinations.add(receipt.destination);
  }
}

/** Read only tracked attribute files on selected paths, never arbitrary tree blobs. */
function selectedLfsReviewEvidence(
  checkout: string,
  evidence: ValidationEvidence,
): { sources: ResultReviewEvidenceSource[]; textBytes: number } {
  assertSelectedLfsValidation(evidence.selectedLfs, evidence.treeSha);
  if (!evidence.selectedLfs?.length) return { sources: [], textBytes: 0 };
  const sources: ResultReviewEvidenceSource[] = [
    {
      path: "Validated selected LFS pointers",
      content: JSON.stringify(evidence.selectedLfs),
    },
  ];
  const paths = new Set<string>();
  for (const receipt of evidence.selectedLfs) {
    const segments = receipt.destination.split("/");
    for (let i = 0; i < segments.length; i++)
      paths.add([...segments.slice(0, i), ".gitattributes"].join("/"));
  }
  const limit = Math.floor(configuredResultReviewTextBudget() / 2);
  let remaining = limit;
  for (const path of paths) {
    const entry = pinnedGit(checkout, "ls-tree", evidence.treeSha, "--", path);
    if (!entry) continue;
    const [mode, kind, oid] = entry.split(/[\s\t]+/);
    const bytes = Number(pinnedGit(checkout, "cat-file", "-s", oid!));
    let content: string | undefined;
    if (
      kind === "blob" &&
      (mode === "100644" || mode === "100755") &&
      bytes <= remaining
    ) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          pinnedGitRaw(checkout, "cat-file", "blob", oid!),
        );
      } catch {
        content = undefined;
      }
    }
    if (content !== undefined) remaining -= bytes;
    sources.push({
      path: `Selected LFS tracked attributes: ${path}`,
      complete: content !== undefined,
      content: JSON.stringify({
        treeSha: evidence.treeSha,
        path,
        oid,
        bytes,
        complete: content !== undefined,
        ...(content !== undefined ? { text: content } : {}),
      }),
    });
  }
  return { sources, textBytes: limit - remaining };
}

export type ReviewDeliveryObservation =
  | { kind: "regular" }
  | { kind: "read-only-proof" }
  | {
      kind: "native-stack";
      unitId: string;
      layerNumber: number;
      layerCount: number;
      predecessorItemId: string | null;
    };

/** Project the existing attempt-bound proposal and its matching accepted revision. */
function retainedHarnessDiscovery(state: FactoryState, item: WorkItem) {
  const current = state.work[item.id];
  if (
    !current?.discovery ||
    !current.attempt ||
    current.discovery.attempt !== current.attempt ||
    !current.changeRef ||
    !current.treeSha
  )
    return null;
  const proposalFields = (proposal: WorkDiscovery) => ({
    scope: proposal.scope,
    reason: proposal.reason,
    evidence: proposal.evidence,
    ownership: proposal.ownership,
    acceptance: proposal.acceptance,
    dependencies: proposal.dependencies,
  });
  const proposal = proposalFields(current.discovery);
  assertGraphRevisions(state);
  const revisions = state.graphRevisions ?? [];
  const index = revisions.findIndex(
    (revision, index) =>
      index > 0 &&
      current.discoveryDisposition === "accepted" &&
      revision.proposal?.worker?.itemId === item.id &&
      revision.proposal.worker.attempt === current.attempt &&
      revision.proposal.scope === "in-scope" &&
      isDeepStrictEqual(proposalFields(revision.proposal), proposal),
  );
  const revision = index > 0 ? revisions[index]! : undefined;
  const previous = index > 0 ? revisions[index - 1]!.graph : undefined;
  return {
    itemId: item.id,
    attemptId: current.attempt,
    resultCommitSha: current.changeRef,
    resultTreeSha: current.treeSha,
    contentOrigin: "harness-declared-proposal",
    proposal,
    acceptedAmendment:
      revision && previous
        ? {
            parentGraphDigest: revision.parentDigest,
            graphDigest: revision.digest,
            reviewDigest: revision.reviewDigest,
            acceptedAt: revision.acceptedAt,
            worker: revision.proposal!.worker,
            addedItems: revision.graph.items
              .filter(
                (added) =>
                  !previous.items.some((entry) => entry.id === added.id),
              )
              .map((added) => ({
                id: added.id,
                kind: added.kind ?? "work",
                children: added.children ?? [],
                dependencies: added.dependencies,
                ownedPaths: added.ownedPaths,
                acceptance: added.acceptance,
                validation: added.validation,
              })),
          }
        : null,
  };
}

/**
 * Give result review the minimum authoritative run facts needed to evaluate
 * source-declared scheduling and predecessor criteria. The atomic snapshot and
 * accepted graph are lifecycle authority; diagnostics and worker prose are not.
 */
export function workItemReviewObservations(
  state: FactoryState,
  item: WorkItem,
  delivery: ReviewDeliveryObservation,
  selectedAsset?: CapturedAssetSet,
): string {
  const current = state.work[item.id]!;
  const captureReceipt = (asset: CapturedAssetSet) =>
    asset.capture
      ? {
          authority: "factory-controller" as const,
          ...(asset.capture.declarationPath &&
            asset.capture.declarationDigest &&
            asset.capture.declarationProvenance && {
              declarationPath: asset.capture.declarationPath,
              declarationDigest: asset.capture.declarationDigest,
              declarationProvenance: {
                source: asset.capture.declarationProvenance.source,
                rights: asset.capture.declarationProvenance.rights,
                visibility: asset.capture.declarationProvenance.visibility,
                lineage: [...asset.capture.declarationProvenance.lineage],
              },
            }),
          mediaRoot: ".factory-media" as const,
          complete: true as const,
          setId: asset.id,
          ...(asset.capture.inputs && {
            inputs: asset.capture.inputs.map((input) => ({
              binding: {
                kind: input.binding.kind,
                path: input.binding.path,
                role: input.binding.role,
                mediaType: input.binding.mediaType,
                visibility: input.binding.visibility,
              },
              ref: {
                digest: input.ref.digest,
                bytes: input.ref.bytes,
                mediaType: input.ref.mediaType,
              },
            })),
          }),
          members: asset.capture.members.map((member) => ({
            role: member.role,
            stagingPath: member.stagingPath,
            destination: member.destination,
            digest: member.digest,
            bytes: member.bytes,
            mediaType: member.mediaType,
          })),
        }
      : null;
  const contentRef = (ref: CapturedAssetSet["members"][number]["ref"]) => ({
    digest: ref.digest,
    bytes: ref.bytes,
    mediaType: ref.mediaType,
  });
  const provenance = (asset: CapturedAssetSet) => ({
    source: asset.provenance.source,
    rights: asset.provenance.rights,
    visibility: asset.provenance.visibility,
    lineage: asset.provenance.lineage,
  });
  const selectedAssetObservation = (asset: CapturedAssetSet) => ({
    id: asset.id,
    ...(asset.inputs && {
      inputs: asset.inputs.map((input) => ({
        binding: {
          ...(input.binding.kind && { kind: input.binding.kind }),
          path: input.binding.path,
          role: input.binding.role,
          mediaType: input.binding.mediaType,
          visibility: input.binding.visibility,
        },
        ref: contentRef(input.ref),
      })),
    }),
    members: asset.members.map((member) => ({
      role: member.role,
      ref: contentRef(member.ref),
      destination: member.destination,
      ...(member.formatMetadata && {
        formatMetadata: {
          source: member.formatMetadata.source,
          values: member.formatMetadata.values,
        },
      }),
    })),
    ...(asset.relationships && {
      relationships: asset.relationships.map((relationship) => ({
        from: relationship.from,
        toRole: relationship.toRole,
        kind: relationship.kind,
      })),
    }),
    provenance: provenance(asset),
    ...(asset.production && {
      production: {
        ...(asset.production.model && { model: asset.production.model }),
        ...(asset.production.tool && { tool: asset.production.tool }),
        ...(asset.production.request !== undefined && {
          request: asset.production.request,
        }),
        ...(asset.production.parameters !== undefined && {
          parameters: asset.production.parameters,
        }),
      },
    }),
    evidence: {
      harnessIdentity: asset.evidence.harnessIdentity,
      resultDigest: asset.evidence.resultDigest,
    },
    ...(asset.capture && { capture: captureReceipt(asset) }),
  });
  const criterionText = item.acceptance.join("\n");
  const namedByCriterion = (id: string): boolean => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`,
    ).test(criterionText);
  };
  const relevant = state.graph.items.filter((candidate) => {
    return (
      candidate.id === item.id ||
      item.dependencies.includes(candidate.id) ||
      namedByCriterion(candidate.id)
    );
  });
  return JSON.stringify({
    ...(current.recovery?.correction?.kind === "review-evidence"
      ? {
          reviewTransportCorrection: {
            diagnosis: current.recovery.correction.diagnosis,
            correction: current.recovery.correction.correction,
            acceptanceOverride: false,
          },
        }
      : {}),
    objectiveBaseCommitSha: state.baseSha,
    currentIntegratedCommitSha: state.integratedSha ?? null,
    candidateBasis: objectiveCandidate(state)?.basis ?? null,
    selectedCandidateCommitSha: objectiveCandidate(state)?.commitSha ?? null,
    reviewedItemId: item.id,
    delivery,
    ...(item.kind === "qa" || item.kind === "aggregate"
      ? {
          validationPhase: {
            kind:
              objectiveCandidate(state)?.basis === "pinned-baseline"
                ? "pinned-baseline-read-only"
                : "post-integration-read-only",
            candidateBasis: objectiveCandidate(state)?.basis,
            selectedCandidateCommitSha: current.changeRef,
            selectedCandidateTreeSha: current.treeSha,
            attemptId: current.attempt,
            selectedIntegratedCommitSha:
              objectiveCandidate(state)?.basis === "pinned-baseline"
                ? null
                : current.changeRef,
            selectedIntegratedTreeSha:
              objectiveCandidate(state)?.basis === "pinned-baseline"
                ? null
                : current.treeSha,
            validationTreeSha: current.validation?.treeSha,
            commands: current.validation?.commands,
            worker: false,
            pullRequest: false,
          },
        }
      : {}),
    harnessDiscovery: retainedHarnessDiscovery(state, item),
    attempts: relevant.map((candidate) => {
      const work = state.work[candidate.id]!;
      return {
        id: candidate.id,
        declaredDependencies: candidate.dependencies,
        ownedPaths: candidate.ownedPaths,
        resources: candidate.resources ?? [],
        attemptId: work.attempt ?? null,
        startedAt: work.startedAt ?? null,
        executionBaseCommitSha: work.executionBaseSha ?? null,
        integrationAtStart:
          work.integratedShaAtStart === undefined
            ? { recorded: false }
            : {
                recorded: true,
                integratedCommitSha: work.integratedShaAtStart,
              },
        resultCommitSha: work.changeRef ?? null,
        resultTreeSha: work.treeSha ?? null,
        integratedCommitSha: work.integratedSha ?? null,
      };
    }),
    assetCaptureReceipts: (current.assets ?? []).map(captureReceipt),
    selectedAsset: selectedAsset
      ? selectedAssetObservation(selectedAsset)
      : null,
    assetSelectionReceipt:
      selectedAsset && current.selection
        ? {
            authority: "factory-controller",
            setId: selectedAsset.id,
            selectionDigest: current.selectionDigest ?? null,
            actor: current.selection.actor,
            at: current.selection.at,
            ...(current.selection.reason && {
              reason: current.selection.reason,
            }),
            ...(current.selection.surface && {
              surface: current.selection.surface,
            }),
            destinations: current.selection.destinations.map((destination) => ({
              role: destination.role,
              path: destination.path,
              digest: destination.digest,
            })),
            downstreamItems: current.selection.downstreamItems,
          }
        : null,
  });
}

/**
 * Describe the exact worker/controller boundary for a selected AssetSet from
 * immutable Git objects and the validated atomic snapshot. The controller's
 * materialization commit retains the worker result as its sole parent, so a
 * restart does not require a second receipt or diagnostic history.
 */
export function workItemMaterializationEvidence(args: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  textBudget?: ReviewTextBudget;
}): ResultReviewEvidenceSource[] {
  const { state, item, checkout } = args;
  const current = state.work[item.id];
  if (!current?.selectedAssetSet) return [];
  if (
    !current.executionBaseSha ||
    !current.baseSha ||
    !current.changeRef ||
    !current.treeSha ||
    !current.selection ||
    !current.selectionDigest
  )
    throw new Error(
      `Work Item ${item.id} lacks complete materialization identity`,
    );
  const selected = current.assets?.find(
    (candidate) => candidate.id === current.selectedAssetSet,
  );
  if (!selected || assetSelectionDigest(selected) !== current.selectionDigest)
    throw new Error(`Work Item ${item.id} selected AssetSet is not bound`);

  assertCommitTree(
    checkout,
    current.changeRef,
    current.treeSha,
    `Work Item ${item.id} materialized result`,
  );
  assertResultCommitShape(checkout, item, {
    ...current,
    executionBaseSha: current.executionBaseSha,
    baseSha: current.baseSha,
    changeRef: current.changeRef,
  });
  const workerResultCommitSha = commitParents(checkout, current.changeRef)[0]!;
  const workerResultTreeSha = pinnedGit(
    checkout,
    "rev-parse",
    `${workerResultCommitSha}^{tree}`,
  );
  const textBudget = args.textBudget ?? newReviewTextBudget();
  const worker = resultChangePacket(
    checkout,
    current.baseSha,
    workerResultCommitSha,
    textBudget,
  );
  const materialization = resultChangePacket(
    checkout,
    workerResultCommitSha,
    current.changeRef,
    textBudget,
  );
  const workerPacket = parseResultChangePacket(worker.change);
  const materializationPacket = parseResultChangePacket(materialization.change);
  const destinations = current.selection.destinations.map(
    ({ role, path, digest }) => ({ role, path, digest }),
  );
  const destinationPaths = new Set(destinations.map(({ path }) => path));
  const workerDestinationChanges = workerPacket.changes
    .map(({ path }) => path)
    .filter((path) => destinationPaths.has(path));
  if (workerDestinationChanges.length)
    throw new Error(
      `Work Item ${item.id} worker result changed controller-owned destinations: ${workerDestinationChanges.join(", ")}`,
    );
  const materializedPaths = materializationPacket.changes.map(
    ({ path }) => path,
  );
  if (
    materializedPaths.length !== destinationPaths.size ||
    materializedPaths.some((path) => !destinationPaths.has(path))
  )
    throw new Error(
      `Work Item ${item.id} controller materialization differs from selected destinations`,
    );

  const path = `Work Item Git delta: ${item.id} controller materialization`;
  const identity = {
    authority: "Factory supervisor controller materialization evidence",
    workItemId: item.id,
    selectedSetId: selected.id,
    selectionDigest: current.selectionDigest,
    destinations,
    resultBaseCommitSha: current.baseSha,
    workerResultCommitSha,
    workerResultTreeSha,
    materializationCommitSha: current.changeRef,
    materializationTreeSha: current.treeSha,
    workerDestinationChanges,
  };
  return [
    {
      path,
      complete: true,
      content: JSON.stringify({
        ...identity,
        evidenceScope:
          "Complete boundary identities and changed-path descriptors only; file contents are separate evidence chunks.",
        contentComplete:
          worker.truncatedPaths.length === 0 &&
          materialization.truncatedPaths.length === 0,
        workerChange: gitChangeMetadata(workerPacket),
        materializationChange: gitChangeMetadata(materializationPacket),
      }),
    },
    ...gitChangeEvidenceSources(worker.change, {
      path: `${path} worker result`,
      metadata: {
        ...identity,
        boundary: "worker",
        baseCommitSha: current.baseSha,
        resultCommitSha: workerResultCommitSha,
        resultTreeSha: workerResultTreeSha,
      },
    }).slice(1),
    ...gitChangeEvidenceSources(materialization.change, {
      path: `${path} controller result`,
      metadata: {
        ...identity,
        boundary: "controller",
        baseCommitSha: workerResultCommitSha,
        resultCommitSha: current.changeRef,
        resultTreeSha: current.treeSha,
      },
    }).slice(1),
  ];
}

function resultChangePacket(
  checkout: string,
  baseSha: string,
  commit: string,
  textBudgetOverride?: number | ReviewTextBudget,
): { change: string; truncatedPaths: string[] } {
  const raw = pinnedGitRaw(
    checkout,
    "diff",
    "--raw",
    "--no-renames",
    "--abbrev=40",
    "-z",
    baseSha,
    commit,
    "--",
  )
    .toString("utf8")
    .split("\0");
  const changes: {
    path: string;
    status: string;
    oldMode: string;
    newMode: string;
    oldObject: string;
    newObject: string;
    oldBytes?: number;
    newBytes?: number;
  }[] = [];
  for (let index = 0; index + 1 < raw.length && raw[index]; index += 2) {
    const header = raw[index]!.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/,
    );
    if (!header)
      throw new Error(
        "Cannot describe exact result change for independent review",
      );
    const size = (oid: string): number | undefined =>
      /^0{40}$/.test(oid)
        ? undefined
        : Number(pinnedGit(checkout, "cat-file", "-s", oid));
    const oldBytes = size(header[3]!);
    const newBytes = size(header[4]!);
    changes.push({
      path: raw[index + 1]!,
      status: header[5]!,
      oldMode: header[1]!,
      newMode: header[2]!,
      oldObject: header[3]!,
      newObject: header[4]!,
      ...(oldBytes === undefined ? {} : { oldBytes }),
      ...(newBytes === undefined ? {} : { newBytes }),
    });
  }
  // Leave room in the reviewer context for sources, criteria, and observations.
  // The operator can raise this limit for a model with a larger context window.
  const configured =
    (typeof textBudgetOverride === "object"
      ? textBudgetOverride.remaining
      : textBudgetOverride) ?? configuredResultReviewTextBudget();
  const textBudget =
    Number.isSafeInteger(configured) && configured >= 0 ? configured : 48_000;
  let remaining = textBudget;
  const patches = changes.map(({ path }) => {
    const lineStats = pinnedGit(
      checkout,
      "diff",
      "--numstat",
      "--no-renames",
      baseSha,
      commit,
      "--",
      path,
    );
    if (remaining === 0)
      return { path, lineStats, excerpt: "", truncated: true };
    const limit = remaining;
    const result = spawnSync(
      "git",
      [
        "-C",
        checkout,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--unified=2",
        baseSha,
        commit,
        "--",
        path,
      ],
      { env: pinnedGitEnvironment(), maxBuffer: limit },
    );
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code !== "ENOBUFS"
    )
      throw result.error;
    if (!result.error && result.status !== 0)
      throw new Error(`Cannot describe text change for ${path}`);
    const output = result.stdout ?? Buffer.alloc(0);
    const decoded = new StringDecoder("utf8").write(output.subarray(0, limit));
    const excerpt = new StringDecoder("utf8").write(
      Buffer.from(decoded).subarray(0, limit),
    );
    const truncated =
      Boolean(result.error) ||
      output.length > limit ||
      Buffer.byteLength(decoded) !== Math.min(output.length, limit);
    remaining -= Buffer.byteLength(excerpt, "utf8");
    return { path, lineStats, excerpt, truncated };
  });
  if (typeof textBudgetOverride === "object")
    textBudgetOverride.remaining = remaining;
  return {
    change: JSON.stringify({ changes, textBudget, patches }),
    truncatedPaths: patches
      .filter((patch) => patch.truncated)
      .map((patch) => patch.path),
  };
}

interface ReviewTextBudget {
  remaining: number;
}

function newReviewTextBudget(): ReviewTextBudget {
  return { remaining: configuredResultReviewTextBudget() };
}

function configuredResultReviewTextBudget(): number {
  const configured = Number(
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES ?? 48_000,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 48_000;
}

/** Inventory Git paths, not checkout files, blob contents or submodule contents. */
function resultTreeInventory(
  checkout: string,
  treeSha: string,
  limit: number,
): ResultReviewEvidenceSource {
  const source = { path: "Exact result tree inventory", complete: false };
  const paths: string[] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({ treeSha, complete: false, paths }),
  );
  if (bytes > limit) return { ...source, content: "" };
  const result = spawnSync(
    "git",
    ["-C", checkout, "ls-tree", "-r", "--name-only", "-z", treeSha],
    { env: pinnedGitEnvironment(), maxBuffer: limit },
  );
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code !== "ENOBUFS"
  )
    throw result.error;
  if (!result.error && result.status !== 0)
    throw new Error(
      "Cannot inventory exact result tree for independent review",
    );
  const output = (result.stdout ?? Buffer.alloc(0)).subarray(0, limit);
  const end = output.lastIndexOf(0) + 1;
  let complete = !result.error && end === output.length;
  let names: string[];
  try {
    names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(output.subarray(0, end))
      .split("\0")
      .slice(0, -1);
  } catch {
    names = [];
    complete = false;
  }
  for (const path of names) {
    const size =
      Buffer.byteLength(JSON.stringify(path)) + (paths.length ? 1 : 0);
    if (bytes + size > limit) {
      complete = false;
      break;
    }
    paths.push(path);
    bytes += size;
  }
  return {
    ...source,
    complete,
    content: JSON.stringify({ treeSha, complete, paths }),
  };
}

interface ResultChangePacket {
  changes: {
    path: string;
    status: string;
    oldMode: string;
    newMode: string;
    oldObject: string;
    newObject: string;
    oldBytes?: number;
    newBytes?: number;
  }[];
  textBudget: number;
  patches: {
    path: string;
    lineStats: string;
    excerpt: string;
    truncated: boolean;
  }[];
}

function parseResultChangePacket(change: string): ResultChangePacket {
  return JSON.parse(change) as ResultChangePacket;
}

function gitChangeMetadata(packet: ResultChangePacket) {
  return {
    changes: packet.changes,
    textBudget: packet.textBudget,
    patches: packet.patches.map(({ path, lineStats, truncated }) => ({
      path,
      lineStats,
      truncated,
    })),
  };
}

function literalGitPatches(packet: ResultChangePacket): string {
  return packet.patches
    .map(
      (patch) =>
        `--- Exact patch ${JSON.stringify({ path: patch.path, lineStats: patch.lineStats, truncated: patch.truncated })} ---\n${patch.excerpt}`,
    )
    .join("\n");
}

/** Same transient current-result text for the prompt and exact citation source. */
export function gitChangeEvidence(change: string): string {
  const packet = parseResultChangePacket(change);
  return `${JSON.stringify(gitChangeMetadata(packet))}\n${literalGitPatches(packet)}`;
}

/** Exact descriptors and independently bounded file deltas; metadata never proves file contents. */
export function gitChangeEvidenceSources(
  change: string,
  identity: { path: string; metadata?: Record<string, unknown> } = {
    path: "Exact Git change packet",
  },
): ResultReviewEvidenceSource[] {
  const packet = parseResultChangePacket(change);
  return [
    {
      path: identity.path,
      complete: true,
      content: JSON.stringify({
        ...identity.metadata,
        evidenceScope:
          "Complete changed-path and blob descriptors only; file contents are separate evidence chunks.",
        contentComplete: packet.patches.every((patch) => !patch.truncated),
        ...gitChangeMetadata(packet),
      }),
    },
    ...packet.patches.map((patch) => {
      const file = packet.changes.find((entry) => entry.path === patch.path);
      return {
        path: `${identity.path} file ${JSON.stringify(patch.path)}`,
        complete: !patch.truncated,
        content: `${JSON.stringify({
          ...identity.metadata,
          evidenceScope:
            "This exact file delta only; unchanged file content and sibling deltas are not supplied here.",
          file,
          patch: {
            path: patch.path,
            lineStats: patch.lineStats,
            truncated: patch.truncated,
          },
        })}\n${literalGitPatches({ ...packet, patches: [patch] })}`,
      };
    }),
  ];
}

function assertCommitTree(
  checkout: string,
  commit: string,
  expectedTree: string,
  label: string,
): void {
  let observed: string;
  try {
    observed = pinnedGit(checkout, "rev-parse", `${commit}^{tree}`);
  } catch {
    throw new Error(`${label} commit is unavailable: ${commit}`);
  }
  if (observed !== expectedTree)
    throw new Error(
      `${label} commit/tree mismatch: ${commit} resolves to ${observed}, not ${expectedTree}`,
    );
}

function assertAncestor(
  checkout: string,
  ancestor: string,
  descendant: string,
  label: string,
): void {
  try {
    pinnedGit(checkout, "merge-base", "--is-ancestor", ancestor, descendant);
  } catch {
    throw new Error(
      `${label} is not an ancestor relationship: ${ancestor} -> ${descendant}`,
    );
  }
}

function commitParents(checkout: string, commit: string): string[] {
  return pinnedGit(checkout, "rev-list", "--parents", "-n", "1", commit)
    .split(" ")
    .slice(1);
}

function commitMessage(checkout: string, commit: string): string {
  return pinnedGit(checkout, "log", "-1", "--format=%B", commit);
}

function assertResultCommitShape(
  checkout: string,
  item: WorkItem,
  current: WorkState & {
    executionBaseSha: string;
    baseSha: string;
    changeRef: string;
  },
): void {
  const parents = commitParents(checkout, current.changeRef);
  if (parents.length !== 1)
    throw new Error(
      `Work Item ${item.id} result is not a single-parent commit`,
    );
  const parent = parents[0]!;
  if (current.selectedAssetSet) {
    if (current.executionBaseSha !== current.baseSha)
      throw new Error(`Work Item ${item.id} replayed selected assets`);
    if (
      commitMessage(checkout, current.changeRef) !==
      `Factory: selected ${current.selectedAssetSet} assets`
    )
      throw new Error(
        `Work Item ${item.id} selected-asset result has an unexpected commit identity`,
      );
    if (parent === current.baseSha) return;
    const workerParents = commitParents(checkout, parent);
    if (
      workerParents.length !== 1 ||
      workerParents[0] !== current.baseSha ||
      commitMessage(checkout, parent) !== `Factory: ${item.title}`
    )
      throw new Error(
        `Work Item ${item.id} selected-asset result is not rooted at its recorded result base`,
      );
    return;
  }
  if (parent !== current.baseSha)
    throw new Error(
      `Work Item ${item.id} result commit is not rooted at its recorded result base`,
    );
  const expectedMessage =
    current.executionBaseSha === current.baseSha
      ? `Factory: ${item.title}`
      : "Factory: replay independently prepared Work Item";
  if (commitMessage(checkout, current.changeRef) !== expectedMessage)
    throw new Error(
      `Work Item ${item.id} result has an unexpected controller commit identity`,
    );
}

function itemOwnsPath(item: WorkItem, path: string): boolean {
  return ownsPath(path, item.ownedPaths);
}

function assertIntegrationBindings(
  checkout: string,
  records: {
    item: WorkItem;
    resultBaseSha: string;
    resultCommitSha: string;
    integratedCommitSha: string;
  }[],
): void {
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const group = groups.get(record.integratedCommitSha) ?? [];
    group.push(record);
    groups.set(record.integratedCommitSha, group);
  }
  for (const [integratedCommitSha, group] of groups) {
    const parents = commitParents(checkout, integratedCommitSha);
    if (parents.length !== 2 || parents[1] !== group.at(-1)!.resultCommitSha)
      throw new Error(
        `Integrated commit ${integratedCommitSha} is not bound to the exact delivered result head`,
      );
    if (group.length === 1) continue;
    if (parents[0] !== group[0]!.resultBaseSha)
      throw new Error(
        `Native integration group ${integratedCommitSha} is not rooted at its first result base`,
      );
    for (let index = 1; index < group.length; index++)
      if (group[index]!.resultBaseSha !== group[index - 1]!.resultCommitSha)
        throw new Error(
          `Native integration group ${integratedCommitSha} has a non-exact layer base`,
        );
  }
}

function assertCommandReceipts(
  evidence: ValidationEvidence,
  expectedTree: string,
  label: string,
): void {
  if (evidence.treeSha !== expectedTree)
    throw new Error(`${label} is not bound to the exact result tree`);
  for (const [index, receipt] of evidence.commands.entries())
    if (
      receipt.index !== index ||
      !receipt.command ||
      receipt.passed !== true ||
      receipt.exitCode !== 0 ||
      receipt.treeSha !== expectedTree ||
      !validStoppedLeftovers(receipt.stoppedLeftovers)
    )
      throw new Error(
        `${label} command receipt ${index} is not bound to the exact result tree and order`,
      );
}

/** Absent, or a positive count of stopped leftover processes. */
export function validStoppedLeftovers(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

function workItemDeltaSources(args: {
  item: WorkItem;
  state: FactoryState;
  executionBaseSha: string;
  resultBaseSha: string;
  resultCommitSha: string;
  resultTreeSha: string;
  integratedCommitSha: string | null;
  integratedTreeSha: string | null;
  change: string;
}): ResultReviewEvidenceSource[] {
  const identity = {
    authority: "Factory supervisor exact Git evidence",
    workItemId: args.item.id,
    executionBaseCommitSha: args.executionBaseSha,
    resultBaseCommitSha: args.resultBaseSha,
    resultCommitSha: args.resultCommitSha,
    resultTreeSha: args.resultTreeSha,
    integratedCommitSha: args.integratedCommitSha,
    integratedTreeSha: args.integratedTreeSha,
    declaredDependencies: args.item.dependencies,
    acceptedPathOwnership: args.state.graph.items
      .filter(
        (candidate) =>
          candidate.id === args.item.id ||
          args.item.dependencies.includes(candidate.id),
      )
      .map((item) => ({
        workItemId: item.id,
        ownedPaths: item.ownedPaths,
      })),
  };
  return gitChangeEvidenceSources(args.change, {
    path: `Work Item Git delta: ${args.item.id}`,
    metadata: identity,
  });
}

/** Project one established result without copying prior model verdicts. */
function workItemResultEvidence(args: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  textBudget: ReviewTextBudget;
}) {
  const { state, item, checkout, textBudget } = args;
  const current = state.work[item.id];
  if (
    !current?.executionBaseSha ||
    !current.baseSha ||
    !current.changeRef ||
    !current.treeSha ||
    !current.validation
  )
    throw new Error(
      `Work Item ${item.id} lacks complete result-review identity`,
    );
  const evidence: ResultReviewEvidenceSource[] = [];
  const repair = retainedRepairProof(state, item, checkout);
  assertCommitTree(
    checkout,
    current.changeRef,
    current.treeSha,
    `Work Item ${item.id} result`,
  );
  if (item.kind === "qa" || item.kind === "aggregate") {
    if (
      current.changeRef !== current.baseSha ||
      current.execution ||
      current.pullRequest ||
      item.ownedPaths.length
    )
      throw new Error(`QA ${item.id} contains a worker or delivery identity`);
    assertCommandReceipts(
      current.validation,
      current.treeSha,
      `QA ${item.id} validation`,
    );
    if (
      current.validation.commands.length !== item.validation.length ||
      current.validation.commands.some(
        (receipt, index) => receipt.command !== item.validation[index]?.command,
      )
    )
      throw new Error(
        `QA ${item.id} command proof differs from accepted coverage`,
      );
    const record = {
      id: item.id,
      kind: item.kind,
      attemptId: current.attempt,
      validationPhase:
        objectiveCandidate(state)?.basis === "pinned-baseline"
          ? "pinned-baseline-read-only"
          : "post-integration-read-only",
      candidateBasis: objectiveCandidate(state)?.basis,
      selectedCandidateCommitSha: current.changeRef,
      selectedCandidateTreeSha: current.treeSha,
      selectedIntegratedCommitSha:
        objectiveCandidate(state)?.basis === "pinned-baseline"
          ? null
          : current.changeRef,
      selectedIntegratedTreeSha:
        objectiveCandidate(state)?.basis === "pinned-baseline"
          ? null
          : current.treeSha,
      status: current.status,
      resultCommitSha: current.changeRef,
      resultTreeSha: current.treeSha,
      validationTreeSha: current.validation.treeSha,
      validationCommands: current.validation.commands,
      namedChecks: current.qaChecks ?? [],
      harnessDiscovery: retainedHarnessDiscovery(state, item),
      integratedCommitSha: current.integratedSha ?? null,
      ...(repair && { repair }),
    };
    return {
      record,
      evidence: [
        {
          path: `Read-only QA proof: ${item.id}`,
          content: JSON.stringify(record),
        },
      ],
    };
  }
  assertAncestor(
    checkout,
    current.baseSha,
    current.changeRef,
    `Work Item ${item.id} result base`,
  );
  assertAncestor(
    checkout,
    current.executionBaseSha,
    current.baseSha,
    `Work Item ${item.id} execution base`,
  );
  const startSnapshot = current.integratedShaAtStart ?? state.baseSha;
  const dependencyResults = item.dependencies.map(
    (dependency) => state.work[dependency]?.changeRef,
  );
  if (
    current.executionBaseSha !== startSnapshot &&
    !dependencyResults.includes(current.executionBaseSha)
  )
    throw new Error(
      `Work Item ${item.id} execution base is not bound to its recorded start snapshot or a declared dependency result`,
    );
  if (
    current.executionBaseSha !== current.baseSha &&
    current.executionBaseSha !== startSnapshot
  )
    throw new Error(
      `Work Item ${item.id} replay base is not bound to its recorded start snapshot`,
    );
  assertResultCommitShape(checkout, item, {
    ...current,
    executionBaseSha: current.executionBaseSha,
    baseSha: current.baseSha,
    changeRef: current.changeRef,
  });
  assertCommandReceipts(
    current.validation,
    current.treeSha,
    `Work Item ${item.id} validation`,
  );
  const { change } = resultChangePacket(
    checkout,
    current.baseSha,
    current.changeRef,
    textBudget,
  );
  const changePacket = parseResultChangePacket(change);
  const unownedChanges = changePacket.changes
    .map((entry) => entry.path)
    .filter((path) => !itemOwnsPath(item, path));
  if (unownedChanges.length)
    throw new Error(
      `Work Item ${item.id} final delta contains paths outside accepted ownership: ${unownedChanges.join(", ")}`,
    );

  if (
    current.validation.commands.length !== item.validation.length ||
    current.validation.commands.some(
      (receipt, index) => receipt.command !== item.validation[index]?.command,
    )
  )
    throw new Error(
      `Work Item ${item.id} validation commands differ from the accepted item`,
    );
  const checks = current.preIntegrationChecks ?? [];
  const checkNames = new Set<string>();
  for (const check of checks) {
    if (
      check.headSha !== current.changeRef ||
      !Number.isSafeInteger(check.id) ||
      check.id <= 0 ||
      !check.name ||
      !check.detailsUrl ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      checkNames.has(check.name)
    )
      throw new Error(
        `Work Item ${item.id} pre-integration check lacks successful exact-result identity`,
      );
    checkNames.add(check.name);
  }
  const itemIntegratedTreeSha = current.integratedSha
    ? pinnedGit(checkout, "rev-parse", `${current.integratedSha}^{tree}`)
    : null;
  const evidencePath = `Work Item Git delta: ${item.id}`;
  evidence.push(
    ...workItemDeltaSources({
      item,
      state,
      executionBaseSha: current.executionBaseSha,
      resultBaseSha: current.baseSha,
      resultCommitSha: current.changeRef,
      resultTreeSha: current.treeSha,
      integratedCommitSha: current.integratedSha ?? null,
      integratedTreeSha: itemIntegratedTreeSha,
      change,
    }),
  );
  evidence.push(
    ...workItemMaterializationEvidence({
      state,
      item,
      checkout,
      textBudget,
    }),
  );
  const record = {
    id: item.id,
    status: current.status,
    executionBaseCommitSha: current.executionBaseSha,
    resultBaseCommitSha: current.baseSha,
    resultCommitSha: current.changeRef,
    resultTreeSha: current.treeSha,
    validationTreeSha: current.validation.treeSha,
    validationCommands: current.validation.commands,
    independentReview: {
      resultCommitSha: current.changeRef,
      resultTreeSha: current.treeSha,
      automaticPass:
        Boolean(current.pullRequest) &&
        item.acceptance.length > 0 &&
        current.validation.criteria?.length === item.acceptance.length &&
        current.validation.criteria.every(
          (criterion, index) =>
            criterion.criterion === item.acceptance[index] &&
            criterion.verdict === "pass",
        ),
    },
    preIntegrationChecks: current.preIntegrationChecks ?? [],
    pullRequest: current.pullRequest,
    integratedCommitSha: current.integratedSha ?? null,
    integratedTreeSha: itemIntegratedTreeSha,
    evidenceSource: evidencePath,
    harnessDiscovery: retainedHarnessDiscovery(state, item),
    selectedAssetSet: current.selectedAssetSet,
    selectedAsset: current.assets?.find(
      (set) => set.id === current.selectedAssetSet,
    ),
    selection: current.selection,
    ...(repair && { repair }),
  };
  evidence.push({
    path: `Delivery lifecycle proof: ${item.id}`,
    complete: true,
    content: JSON.stringify({
      itemId: item.id,
      pullRequest: current.pullRequest ?? null,
      independentReview: record.independentReview,
      preIntegrationChecks: record.preIntegrationChecks,
      integratedCommitSha: current.integratedSha ?? null,
    }),
  });
  return { record, evidence };
}

/** Retained controller facts and declared correction, never a copy of worker or review prose. */
function retainedRepairProof(
  state: FactoryState,
  item: WorkItem,
  checkout: string,
) {
  const current = state.work[item.id]!;
  const correction = current.recovery?.correction;
  if (!correction) return undefined;
  assertRepairLedger(state);
  const prior = [...(current.recovery?.history ?? [])]
    .reverse()
    .find((entry) => entry.failure?.digest === correction.failureDigest);
  if (
    !prior?.failure ||
    prior.failure.digest !== failureDigest(prior.failure.detail) ||
    !prior.work.attempt
  )
    throw new Error(
      `Work Item ${item.id} correction lacks its retained failure`,
    );
  const candidate = prior.work;
  if (candidate.changeRef || candidate.treeSha) {
    if (!candidate.changeRef || !candidate.treeSha)
      throw new Error(`Work Item ${item.id} retained candidate is incomplete`);
    assertCommitTree(
      checkout,
      candidate.changeRef,
      candidate.treeSha,
      `Work Item ${item.id} retained failure candidate`,
    );
  }
  const key = allowanceKey(correction.kind);
  const consumed = state.allowanceConsumption?.[key];
  const scopes = repairScopes(state, item.id);
  if (
    !state.autonomy.repairClasses.includes(correction.kind) ||
    !consumed ||
    scopes.some((scope) => !state.repairConsumption?.[scope]?.[key])
  )
    throw new Error(
      `Work Item ${item.id} correction lacks charged consumption`,
    );
  let candidatePreservation;
  if (correction.kind === "validation-environment") {
    if (
      !candidate.baseSha ||
      !candidate.executionBaseSha ||
      !candidate.changeRef ||
      !candidate.treeSha ||
      !current.baseSha ||
      !current.executionBaseSha ||
      !current.changeRef ||
      !current.treeSha ||
      !isDeepStrictEqual(
        item,
        state.graph.items.find((entry) => entry.id === item.id),
      )
    )
      throw new Error(
        `Work Item ${item.id} retained candidate lacks preservation bindings`,
      );
    assertCommitTree(
      checkout,
      current.changeRef,
      current.treeSha,
      `Work Item ${item.id} corrected candidate`,
    );
    if (item.kind === "qa" || item.kind === "aggregate") {
      if (
        candidate.baseSha !== candidate.changeRef ||
        candidate.executionBaseSha !== candidate.changeRef ||
        candidate.execution ||
        candidate.pullRequest ||
        current.baseSha !== current.changeRef ||
        current.executionBaseSha !== current.changeRef ||
        current.execution ||
        current.pullRequest ||
        item.ownedPaths.length
      )
        throw new Error(
          `QA ${item.id} retained candidate contains a worker or delivery identity`,
        );
    } else {
      assertResultCommitShape(checkout, item, {
        ...candidate,
        executionBaseSha: candidate.executionBaseSha,
        baseSha: candidate.baseSha,
        changeRef: candidate.changeRef,
      });
      const failedCandidateChanges = parseResultChangePacket(
        resultChangePacket(checkout, candidate.baseSha, candidate.changeRef, 0)
          .change,
      ).changes;
      if (
        failedCandidateChanges.some(
          (change) => !itemOwnsPath(item, change.path),
        )
      )
        throw new Error(
          `Work Item ${item.id} retained candidate differs from accepted ownership`,
        );
      const ownedPathChanges = parseResultChangePacket(
        resultChangePacket(checkout, candidate.changeRef, current.changeRef, 0)
          .change,
      ).changes.filter((change) => itemOwnsPath(item, change.path));
      const sameAttempt = candidate.attempt === current.attempt;
      const sameExecutionBase =
        candidate.executionBaseSha === current.executionBaseSha;
      candidatePreservation = {
        evidenceScope:
          "Committed paths within accepted ownership only; not whole-tree equality, transient conduct or LFS hydration",
        acceptedOwnedPaths: item.ownedPaths,
        failedExecutionBaseCommitSha: candidate.executionBaseSha,
        failedResultBaseCommitSha: candidate.baseSha,
        currentExecutionBaseCommitSha: current.executionBaseSha,
        currentResultBaseCommitSha: current.baseSha,
        failedCandidateChanges,
        ownedPathChanges,
        sameAttempt,
        sameExecutionBase,
        unchangedOwnedPaths: ownedPathChanges.length === 0,
        preserved:
          sameAttempt && sameExecutionBase && ownedPathChanges.length === 0,
      };
    }
  }
  return {
    controllerFacts: {
      failedAttempt: {
        attemptId: candidate.attempt,
        status: candidate.status,
        phase: candidate.step ?? null,
        resultCommitSha: candidate.changeRef ?? null,
        resultTreeSha: candidate.treeSha ?? null,
        failure: {
          digest: prior.failure.digest,
          classification: prior.failure.classification,
          at: prior.failure.at,
          continuation: prior.failure.continuation,
          ...(correction.kind === "validation-environment" && {
            recordedError: prior.failure.detail,
          }),
        },
      },
      currentAttemptId: current.attempt ?? null,
      currentResultCommitSha: current.changeRef ?? null,
      currentResultTreeSha: current.treeSha ?? null,
      ...(candidatePreservation && { candidatePreservation }),
      repairClass: correction.kind,
      snapshotConsumption: {
        allowance: key,
        objective: { consumed, limit: state.autonomy.allowances[key] },
        paths: scopes.map((scope) => ({
          scope,
          consumed: state.repairConsumption![scope]![key],
          limit: state.autonomy.repairPolicy.perPath[key],
        })),
      },
    },
    declaredCorrection: {
      contentOrigin: "declared-diagnosis-and-correction",
      ...correction,
    },
  };
}

/** Current materialization and declared dependency ancestry, never unrelated work. */
export function workItemReviewEvidence(args: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  delivery: "regular" | "native-stack";
}): ResultReviewEvidenceSource[] {
  const { state, item, checkout, delivery } = args;
  const current = state.work[item.id];
  if (!current?.baseSha || !current.changeRef || !current.treeSha)
    throw new Error(`Work Item ${item.id} lacks a reviewed result identity`);
  assertCommitTree(
    checkout,
    current.changeRef,
    current.treeSha,
    `Work Item ${item.id} result`,
  );
  assertAncestor(
    checkout,
    current.baseSha,
    current.changeRef,
    `Work Item ${item.id} result base`,
  );
  const dependencies: WorkItem[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    if (id === item.id)
      throw new Error("Dependency ancestry contains the reviewed item");
    const dependency = state.graph.items.find((entry) => entry.id === id);
    if (!dependency) throw new Error(`Unknown dependency ${id}`);
    seen.add(id);
    for (const parent of dependency.dependencies) visit(parent);
    dependencies.push(dependency);
  };
  for (const id of item.dependencies) visit(id);
  const textBudget = newReviewTextBudget();
  const evidence = workItemMaterializationEvidence({
    state,
    item,
    checkout,
    textBudget,
  });
  if (item.kind === "qa" || item.kind === "aggregate") {
    if (current.changeRef !== objectiveCandidate(state)?.commitSha)
      throw new Error(`QA ${item.id} selected integration is stale`);
    evidence.push(
      ...workItemResultEvidence({ state, item, checkout, textBudget }).evidence,
    );
  }
  const repair = retainedRepairProof(state, item, checkout);
  if (repair)
    evidence.push({
      path: `Retained repair proof: ${item.id}`,
      content: JSON.stringify(repair),
    });
  const records = dependencies.map((dependency) => {
    const work = state.work[dependency.id];
    if (
      !work ||
      (work.status !== "done" &&
        !(delivery === "native-stack" && work.status === "published")) ||
      !work.changeRef ||
      (work.status === "done" &&
        !work.integratedSha &&
        !(
          objectiveCandidate(state)?.basis === "pinned-baseline" &&
          dependency.kind === "qa" &&
          work.changeRef === state.baseSha
        )) ||
      (work.status === "published" && (!work.pullRequest || work.integratedSha))
    )
      throw new Error(
        `Dependency ${dependency.id} lacks a completed delivery result`,
      );
    assertAncestor(
      checkout,
      work.changeRef,
      current.baseSha!,
      `Dependency ${dependency.id} result in reviewed base`,
    );
    if (work.integratedSha) {
      assertAncestor(
        checkout,
        work.changeRef,
        work.integratedSha,
        `Dependency ${dependency.id} integration`,
      );
      assertAncestor(
        checkout,
        work.integratedSha,
        current.baseSha!,
        `Dependency ${dependency.id} integration in reviewed base`,
      );
    }
    const proof = workItemResultEvidence({
      state,
      item: dependency,
      checkout,
      textBudget,
    });
    evidence.push(...proof.evidence);
    return proof.record;
  });
  assertIntegrationBindings(
    checkout,
    dependencies.flatMap((dependency) => {
      const work = state.work[dependency.id]!;
      return work.integratedSha &&
        dependency.kind !== "qa" &&
        dependency.kind !== "aggregate"
        ? [
            {
              item: dependency,
              resultBaseSha: work.baseSha!,
              resultCommitSha: work.changeRef!,
              integratedCommitSha: work.integratedSha,
            },
          ]
        : [];
    }),
  );
  if (records.length)
    evidence.push({
      path: "Completed dependency results",
      content: JSON.stringify({
        reviewedItemId: item.id,
        reviewedBaseCommitSha: current.baseSha,
        work: records,
      }),
    });
  return evidence;
}
/**
 * Build final-review authority from supervisor state and exact Git objects.
 * Previous model verdicts and quotes are intentionally excluded.
 */
export function objectiveReviewEvidence(args: {
  state: FactoryState;
  checkout: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
}): {
  observations: string;
  evidence: ResultReviewEvidenceSource[];
} {
  const { state, checkout, candidateCommitSha, candidateTreeSha } = args;
  const candidate = objectiveCandidate(state);
  if (candidate?.commitSha !== candidateCommitSha)
    throw new Error(
      "Final candidate commit differs from the atomic supervisor snapshot",
    );
  assertCommitTree(
    checkout,
    candidateCommitSha,
    candidateTreeSha,
    "Final candidate",
  );
  const evidence: ResultReviewEvidenceSource[] = [];
  const integrationRecords: {
    item: WorkItem;
    resultBaseSha: string;
    resultCommitSha: string;
    integratedCommitSha: string;
  }[] = [];
  const textBudget = newReviewTextBudget();
  const work = state.graph.items.map((item) => {
    const current = state.work[item.id];
    if (
      !current ||
      current.status !== "done" ||
      !current.executionBaseSha ||
      !current.baseSha ||
      !current.changeRef ||
      !current.treeSha ||
      (!current.integratedSha && candidate.basis !== "pinned-baseline") ||
      !current.validation
    )
      throw new Error(
        `Work Item ${item.id} lacks complete final-review identity`,
      );
    const proof = workItemResultEvidence({
      state,
      item,
      checkout,
      textBudget,
    });
    if (current.integratedSha) {
      assertAncestor(
        checkout,
        current.changeRef,
        current.integratedSha,
        `Work Item ${item.id} result integration`,
      );
      assertAncestor(
        checkout,
        current.integratedSha,
        candidateCommitSha,
        `Work Item ${item.id} integration`,
      );
    } else if (
      current.changeRef !== candidateCommitSha ||
      current.baseSha !== candidateCommitSha
    ) {
      throw new Error(`QA ${item.id} does not qualify the pinned baseline`);
    }
    if (item.kind !== "qa" && item.kind !== "aggregate")
      integrationRecords.push({
        item,
        resultBaseSha: current.baseSha,
        resultCommitSha: current.changeRef,
        integratedCommitSha: current.integratedSha!,
      });
    evidence.push(...proof.evidence);
    return proof.record;
  });
  assertIntegrationBindings(checkout, integrationRecords);
  return {
    observations: JSON.stringify({
      candidateBasis: candidate.basis,
      candidateCommitSha,
      candidateTreeSha,
      integratedCommitSha: state.integratedSha ?? null,
      integratedTreeSha: state.integratedSha ? candidateTreeSha : null,
      work,
    }),
    evidence,
  };
}

/** Readable canonical command receipts, referenced by packet-local IDs. */
export function commandPassEvidence(
  commands: ValidationCommandReceipt[],
): ResultReviewEvidenceSource {
  return {
    path: "Command pass evidence",
    content: commands
      .map(
        ({ command, ...identity }) =>
          `Receipt: ${JSON.stringify(identity)}\nCommand:\n${command}`,
      )
      .join("\n\n"),
  };
}

/** A separate read-only review evaluates each criterion on an exact-tree packet. */
export async function reviewAcceptance(args: {
  model: PlanningModel;
  reviewPhase?: "result-review" | "objective-review";
  checkout: string;
  baseSha: string;
  commit: string;
  evidence: ValidationEvidence;
  criteria: string[];
  sources: { path: string; content: string }[];
  evidenceSources?: ResultReviewEvidenceSource[];
  decisions?: AcceptanceDecision[];
  observations?: string;
  invocation?: ModelInvocationContext;
  beforeSubmit?: () => void;
}): Promise<ValidationEvidence> {
  const { model, checkout, baseSha, commit, evidence, criteria, sources } =
    args;
  if (!criteria.length) throw new Error("No acceptance criteria to prove");
  const observedTree = pinnedGit(checkout, "rev-parse", `${commit}^{tree}`);
  if (observedTree !== evidence.treeSha)
    throw new Error("Acceptance result tree differs from command evidence");
  assertCommandReceipts(evidence, evidence.treeSha, "Acceptance");
  const selectedLfsEvidence = selectedLfsReviewEvidence(checkout, evidence);
  assertValidationWorktreeObservation(
    evidence.worktreeObservation,
    evidence.treeSha,
    evidence.selectedLfs,
  );
  const worktreeEvidence = evidence.worktreeObservation
    ? [
        {
          path: "Validator worktree observation",
          content: JSON.stringify(evidence.worktreeObservation),
          complete: true,
        },
      ]
    : [];
  const remainingBudget =
    configuredResultReviewTextBudget() - selectedLfsEvidence.textBytes;
  const inventory = resultTreeInventory(
    checkout,
    evidence.treeSha,
    Math.floor(remainingBudget / 2),
  );
  const { change } = resultChangePacket(
    checkout,
    baseSha,
    commit,
    // Only emitted inventory and attribute bytes reduce patch capacity.
    remainingBudget - Buffer.byteLength(inventory.content),
  );
  const suppliedEvidence = [
    inventory,
    ...selectedLfsEvidence.sources,
    ...worktreeEvidence,
    ...(args.evidenceSources ?? []),
  ];
  const evidenceSources: ResultReviewEvidenceSource[] = [
    ...gitChangeEvidenceSources(change, {
      path: "Exact Git change packet",
      metadata: {
        baseCommitSha: baseSha,
        resultCommitSha: commit,
        resultTreeSha: evidence.treeSha,
      },
    }),
    commandPassEvidence(evidence.commands),
    {
      path: "Factory controller capabilities",
      content: JSON.stringify(installedControllerCapabilities()),
    },
    {
      path: "Delivery observations",
      content: args.observations ?? "",
    },
    ...suppliedEvidence,
  ];
  const packet = reviewPacket(criteria, [
    ...sources.map((source) => ({ ...source, origin: "source" as const })),
    ...evidenceSources.map((source) => ({
      ...source,
      origin: "controller" as const,
    })),
  ]);
  const request = {
    reviewPhase: args.reviewPhase ?? ("result-review" as const),
    criteria,
    reviewPacket: packet,
    baseSha,
    treeSha: evidence.treeSha,
    sources,
    change,
    commands: evidence.commands,
    evidence: suppliedEvidence,
    observations: args.observations,
    invocation: args.invocation,
  };
  let decoded: ReturnType<typeof decodeReview> | undefined;
  let reviewFailure: string | undefined;
  let reviewError: unknown;
  let responseReceived = false;
  args.beforeSubmit?.();
  try {
    if (!model.reviewResult)
      throw attachFault(
        new CompletedModelInvocationError(
          "No independent result reviewer is configured",
        ),
        {
          kind: "config",
          detail: "No independent result reviewer is configured",
          fix: "Configure a reviewer model, then `factory run`",
        },
      );
    const response = await model.reviewResult(request);
    responseReceived = true;
    decoded = decodeReview(response, packet);
  } catch (error) {
    // No completed answer arrived: the review did not happen, so ask again.
    if (!responseReceived && !(error instanceof CompletedModelInvocationError))
      throw new Interruption(error);
    reviewError = error;
    reviewFailure = error instanceof Error ? error.message : String(error);
  }
  const proven: CriterionEvidence[] = [];
  let pending: AcceptancePending | undefined;
  let refused: string | undefined;
  for (const [index, criterion] of criteria.entries()) {
    const decision = args.decisions?.find(
      (item) =>
        item.criterion === criterion && item.treeSha === evidence.treeSha,
    );
    if (decision?.outcome === "refuse") {
      refused ??= `Acceptance criterion refused by ${decision.actor}: ${criterion}`;
      continue;
    }
    if (decision?.outcome === "accept") {
      proven.push({
        criterion,
        verdict: "human-accept",
        source: "OPERATOR",
        quote: decision.reason,
        detail: `${decision.actor} at ${decision.at}`,
      });
      continue;
    }
    const finding = decoded?.findings[index];
    const invalid = reviewFailure ?? decoded?.errors[index];
    if (invalid && responseReceived)
      observeInvalidReview(args.invocation, "finding", "invalid-response");
    if (finding?.verdict === "pass") {
      proven.push({
        criterion,
        verdict: "pass",
        evidence: resolveReviewReferences(finding.evidenceIds, packet, true),
        detail: finding.detail,
      });
      continue;
    }
    if (finding?.verdict === "refuse") {
      refused ??= `Acceptance criterion disproved: ${criterion}: ${finding.detail}`;
      continue;
    }
    pending ??= {
      criterion,
      treeSha: evidence.treeSha,
      detail: invalid
        ? `Independent review transport was invalid: ${invalid}`
        : (finding?.detail ?? "Independent review omitted this criterion"),
      question:
        finding?.question ||
        `Inspect the preserved review for ${criterion}; transport failure is not a substantive product decision or approval.`,
      ...(invalid
        ? {
            reviewRejection: {
              field: "finding" as const,
              reason: "invalid-response" as const,
            },
          }
        : {}),
    };
  }
  // Preserve independent valid assessments on existing item evidence; final raw
  // response remains in existing diagnostics rather than a second durable store.
  evidence.criteria = proven;
  if (decoded) {
    const protocolInvalid = Boolean(
      decoded.packetError || decoded.errors.some(Boolean),
    );
    const observeOutcome = (stage: "protocol" | "semantic", status: string) => {
      try {
        args.invocation?.observe?.({
          invocationId: args.invocation.invocationId,
          phase: args.invocation.phase,
          ordinal: args.invocation.ordinal,
          providerAttempt: args.invocation.providerAttempt,
          type: "progress",
          capture: {
            event: { kind: "outcome", outcome: { stage, status } },
            content: () => ({
              criteria: proven,
              findings: decoded?.findings,
              errors: decoded?.errors,
              packetError: decoded?.packetError,
            }),
          },
        });
      } catch {
        /* best-effort observations cannot affect acceptance */
      }
    };
    observeOutcome("protocol", protocolInvalid ? "invalid" : "valid");
    if (!protocolInvalid)
      observeOutcome(
        "semantic",
        refused ? "refuse" : pending ? "needs-human" : "pass",
      );
  }

  // A valid review that refuses a criterion judges the work, not the call.
  if (refused)
    throw attachFault(new CompletedModelInvocationError(refused), {
      kind: "work",
      evidence: { detail: refused },
    });
  const automaticCriterion = criteria.find(
    (criterion) =>
      !proven.some(
        (item) =>
          item.criterion === criterion && item.verdict === "human-accept",
      ),
  );
  if (decoded?.packetError && automaticCriterion !== undefined) {
    observeInvalidReview(args.invocation, "finding", "invalid-response");
    pending ??= {
      criterion: automaticCriterion,
      treeSha: evidence.treeSha,
      detail: decoded.packetError,
      question:
        "Inspect the invalid review response; an unknown criterion ID cannot grant acceptance.",
      reviewRejection: { field: "finding", reason: "invalid-response" },
    };
  }
  if (pending)
    // A failed review call keeps its own fault (configuration, a limit, a
    // lost response) through `cause`; otherwise the operator decides.
    throw attachFault(
      new AcceptanceDecisionRequired(pending, { cause: reviewError }),
      attachedFault(reviewError)
        ? undefined
        : askOperator(pending.question, pending.detail),
    );
  return { ...evidence, criteria: proven };
}

function observeInvalidReview(
  invocation: ModelInvocationContext | undefined,
  field: string,
  reason: string,
): void {
  try {
    invocation?.observe?.({
      invocationId: invocation.invocationId,
      phase: invocation.phase,
      ordinal: invocation.ordinal,
      ...(invocation.providerAttempt === undefined
        ? {}
        : { providerAttempt: invocation.providerAttempt }),
      ...(invocation.providerMaxAttempts === undefined
        ? {}
        : { providerMaxAttempts: invocation.providerMaxAttempts }),
      type: "response-invalid",
      failureClass: "review-protocol",
      failureField: field,
      detail: reason,
    });
  } catch (error) {
    process.stderr.write(
      `Factory model diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export interface ValidationObservation {
  index: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface ValidationOutputObservation {
  index: number;
  stream: "stdout" | "stderr";
  output: string;
  final: boolean;
}

function safeValidationPath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    path !== ".git" &&
    !path.startsWith(".git/")
  );
}

function assertSelectedLfsPointer(
  worktree: string,
  member: ValidationLfsMember,
): SelectedLfsValidation {
  if (!safeValidationPath(member.destination))
    throw new Error("Validation LFS destination is invalid");
  if (
    !/^[a-f0-9]{64}$/.test(member.digest) ||
    !Number.isSafeInteger(member.bytes) ||
    member.bytes < 0
  )
    throw new Error(
      `Validation LFS identity is invalid: ${member.destination}`,
    );
  const filter = pinnedGit(
    worktree,
    "check-attr",
    "filter",
    "--",
    member.destination,
  );
  if (!filter.endsWith(": lfs"))
    throw new Error(
      `Validation LFS policy does not cover ${member.destination}`,
    );
  let pointer: string;
  try {
    pointer = pinnedGitRaw(
      worktree,
      "show",
      `HEAD:${member.destination}`,
    ).toString("utf8");
  } catch {
    throw new Error(
      `Validation tree is missing selected LFS path: ${member.destination}`,
    );
  }
  const expected = `version https://git-lfs.github.com/spec/v1\noid sha256:${member.digest}\nsize ${member.bytes}\n`;
  if (pointer !== expected)
    throw new Error(
      `Validation LFS pointer differs from selected bytes: ${member.destination}`,
    );
  return {
    treeSha: pinnedGit(worktree, "rev-parse", "HEAD^{tree}"),
    destination: member.destination,
    digest: member.digest,
    bytes: member.bytes,
    filter: "lfs",
  };
}

function assertSelectedLfsBytes(
  worktree: string,
  member: ValidationLfsMember,
): void {
  const path = join(worktree, member.destination);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
      throw new Error("unsafe file type");
    fd = openSync(path, "r");
    const expectedBytes = fstatSync(fd).size;
    const hash = createHash("sha256");
    let bytes = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      bytes += count;
    }
    if (
      bytes !== expectedBytes ||
      bytes !== member.bytes ||
      hash.digest("hex") !== member.digest
    )
      throw new Error("identity mismatch");
  } catch {
    throw new Error(
      `Validation could not restore selected LFS bytes: ${member.destination}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function hydrateSelectedLfsBytes(
  worktree: string,
  members: ValidationLfsMember[],
  contentStore?: ContentStore,
): Promise<SelectedLfsValidation[]> {
  if (!members.length) return [];
  if (!contentStore)
    throw new Error("Validation LFS content store is unavailable");
  const byDestination = new Map<string, ValidationLfsMember>();
  for (const member of members) {
    const existing = byDestination.get(member.destination);
    if (
      existing &&
      (existing.digest !== member.digest || existing.bytes !== member.bytes)
    )
      throw new Error(
        `Validation has conflicting LFS selections: ${member.destination}`,
      );
    byDestination.set(member.destination, member);
  }
  const selected = [...byDestination.values()];
  const receipts = selected.map((member) =>
    assertSelectedLfsPointer(worktree, member),
  );
  for (const member of selected) {
    const path = join(worktree, member.destination);
    try {
      if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
        throw new Error("unsafe file type");
      const ref = {
        digest: member.digest,
        bytes: member.bytes,
        mediaType: member.mediaType,
      };
      await contentStore.verify(ref);
      rmSync(path);
      await contentStore.materialize(ref, path);
    } catch {
      throw new Error(
        `Validation could not restore selected LFS bytes: ${member.destination}`,
      );
    }
    assertSelectedLfsBytes(worktree, member);
  }
  return receipts;
}

/** Diagnostic-only projection: compare complete Git records before bounding display. */
function validationMutationDetail(before: Buffer, after: Buffer): string {
  const records = (output: Buffer) => {
    const result: {
      identity: string;
      status: string;
      path: Buffer;
      from?: Buffer;
    }[] = [];
    let offset = 0;
    while (offset < output.length) {
      const start = offset;
      const end = output.indexOf(0, offset);
      if (end < 0) throw new Error("Incomplete validation status observation");
      const record = output.subarray(offset, end);
      const status = record.subarray(0, 2).toString("ascii");
      offset = end + 1;
      let from: Buffer | undefined;
      if (/[RC]/.test(status)) {
        const fromEnd = output.indexOf(0, offset);
        if (fromEnd < 0)
          throw new Error("Incomplete validation rename observation");
        from = output.subarray(offset, fromEnd);
        offset = fromEnd + 1;
      }
      result.push({
        identity: output.subarray(start, offset).toString("hex"),
        status,
        path: record.subarray(3),
        ...(from ? { from } : {}),
      });
    }
    return result;
  };
  const initial = records(before);
  const final = records(after);
  const initialIds = new Set(initial.map((entry) => entry.identity));
  const finalIds = new Set(final.map((entry) => entry.identity));
  const changed = [
    ...initial
      .filter((entry) => !finalIds.has(entry.identity))
      .map((entry) => ({ ...entry, phase: "before" })),
    ...final
      .filter((entry) => !initialIds.has(entry.identity))
      .map((entry) => ({ ...entry, phase: "after" })),
  ];
  const displayPath = (bytes: Buffer) => {
    const text = bytes.toString("utf8");
    const utf8 = Buffer.from(text).equals(bytes);
    const value = utf8 ? text : bytes.toString("hex");
    return {
      path: value.slice(0, 256),
      ...(!utf8 ? { pathEncoding: "hex" } : {}),
      ...(value.length > 256 ? { pathTruncated: true } : {}),
    };
  };
  const paths: (ReturnType<typeof displayPath> & {
    phase: string;
    status: string;
    from?: ReturnType<typeof displayPath>;
  })[] = [];
  const detail = (entries: typeof paths) =>
    JSON.stringify({
      paths: entries,
      omittedRecords: changed.length - entries.length,
    });
  for (const entry of changed) {
    const display = {
      phase: entry.phase,
      status: entry.status,
      ...displayPath(entry.path),
      ...(entry.from ? { from: displayPath(entry.from) } : {}),
    };
    if (paths.length === 20 || detail([...paths, display]).length > 8192) break;
    paths.push(display);
  }
  return detail(paths);
}

export async function validateTree(
  checkout: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  lfsMembers: ValidationLfsMember[] = [],
  contentStore?: ContentStore,
): Promise<ValidationEvidence> {
  const emptyCredentials = join(root, "empty-gh-config");
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(emptyCredentials, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CandidateEnvironmentFailure(
      `Validation environment unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const worktree = join(root, randomUUID());
  await addWorktree(checkout, worktree, commit);
  try {
    const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
    if (treeSha !== expectedTree)
      throw new Error(
        `Validation tree mismatch: expected ${expectedTree}, got ${treeSha}`,
      );
    if (pinnedGitRaw(worktree, "status", "--porcelain").length)
      throw new Error("Validation worktree is not initially clean");
    const selectedLfs = await hydrateSelectedLfsBytes(
      worktree,
      lfsMembers,
      contentStore,
    );
    const hydratedStatus = pinnedGitRaw(worktree, "status", "--porcelain");
    const hydratedPaths = pinnedGitRaw(
      worktree,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    );
    const evidence: ValidationEvidence = {
      treeSha,
      commands: [],
      ...(selectedLfs.length ? { selectedLfs } : {}),
    };
    for (const [index, check] of commands.entries()) {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      const decoders = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      };
      const result = await subprocessAsync(
        "sh",
        localValidationShellArguments(check),
        {
          cwd: worktree,
          env: localValidationEnvironment(emptyCredentials),
        },
        undefined,
        (stream, chunk) => {
          const text = decoders[stream].write(chunk);
          if (stream === "stdout") stdout += text;
          else stderr += text;
          if (text)
            observeOutput?.({ index, stream, output: text, final: false });
        },
      );
      for (const stream of ["stdout", "stderr"] as const) {
        const trailing = decoders[stream].end();
        if (stream === "stdout") stdout += trailing;
        else stderr += trailing;
        observeOutput?.({ index, stream, output: trailing, final: true });
      }
      const output = `${stdout}${stderr}`;
      observe?.({
        index,
        passed: result.status === 0,
        exitCode: result.status ?? -1,
        durationMs: Date.now() - started,
        output,
      });
      if (result.status !== 0)
        throw new CandidateValidationFailure(
          `Validation command failed (${result.status}): ${check}: ${output}`,
        );
      evidence.commands.push({
        index,
        command: check,
        passed: true,
        exitCode: 0,
        treeSha,
        ...(result.stoppedLeftovers && {
          stoppedLeftovers: result.stoppedLeftovers,
        }),
      });
    }
    for (const member of lfsMembers) {
      assertSelectedLfsPointer(worktree, member);
      assertSelectedLfsBytes(worktree, member);
    }
    if (hasUnresolvedSubprocesses())
      throw new Error(
        "Validation subprocess ownership unresolved; checkout retained",
      );
    if (!pinnedGitRaw(worktree, "status", "--porcelain").equals(hydratedStatus))
      throw new CandidateValidationFailure(
        `Validation command modified the result tree: ${validationMutationDetail(
          hydratedPaths,
          pinnedGitRaw(
            worktree,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ),
        )}`,
      );
    evidence.worktreeObservation = {
      treeSha,
      initialStatus: "clean",
      postHydrationStatus: {
        porcelainSha256: createHash("sha256")
          .update(hydratedStatus)
          .digest("hex"),
        empty: hydratedStatus.length === 0,
      },
      postCommandStatus: "unchanged",
      selectedLfsMembers: selectedLfs.length,
      subprocessOwnership: "settled",
    };
    return evidence;
  } finally {
    if (!hasUnresolvedSubprocesses()) await removeWorktree(checkout, worktree);
  }
}

/** Package managers resolve scripts and lifecycle hooks from the result tree.
 * Pin the selected entrypoint and execution config to the accepted base. */
export const PINNED_PNPM_BOOTSTRAP =
  "pnpm install --frozen-lockfile --ignore-scripts";

export interface PackageScriptAuthority {
  /** Commands literally declared by a pinned source, not inferred by the model. */
  sourceDeclared?: readonly string[];
  /** Exact package directories admitted by the pinned Objective. */
  workspacePackageAdditions?: readonly string[];
  /** A plan may authorize creation of an entrypoint it cannot inspect yet. */
  preview?: boolean;
  /** Pin newly established scripts against the exact Work Item predecessor. */
  predecessorSha?: string;
}

export function assertPinnedNpmScripts(
  checkout: string,
  acceptedBaseSha: string,
  commit: string,
  commands: string[],
  authority: PackageScriptAuthority = {},
): void {
  assertWorkspacePackageChange(
    checkout,
    acceptedBaseSha,
    commit,
    authority.workspacePackageAdditions,
    authority.predecessorSha,
  );
  const managerToken = /\b(?:npm|pnpm)\b/;
  const selected = commands.filter((check) => managerToken.test(check));
  if (!selected.length) return;
  const declared = new Set(authority.sourceDeclared ?? []);
  const bootstrap = selected.some(
    (check) => check.trim() === PINNED_PNPM_BOOTSTRAP,
  );
  if (
    bootstrap &&
    commands.findIndex((check) => check.trim() === PINNED_PNPM_BOOTSTRAP) >
      commands.findIndex((check) => managerToken.test(check))
  )
    throw new Error(
      "Package script validation blocked: script-disabled bootstrap must run first",
    );
  const scriptCommands = selected.filter(
    (check) => check.trim() !== PINNED_PNPM_BOOTSTRAP,
  );
  const requests = scriptCommands.map(packageScriptInvocation);
  if (requests.some((request) => !request))
    throw new Error(
      "Package script validation blocked: only root npm/pnpm test, pnpm check, or npm/pnpm run NAME can be pinned",
    );

  const file = (revision: string, path: string): string | undefined => {
    try {
      const entry = pinnedGit(checkout, "ls-tree", revision, "--", path);
      if (!entry) return undefined;
      if (!/^100(?:644|755) blob /.test(entry))
        throw new Error(
          `Package script validation blocked: ${path} is not a regular file`,
        );
      return pinnedGitRaw(checkout, "show", `${revision}:${path}`).toString(
        "utf8",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("not a regular file")
      )
        throw error;
      return undefined;
    }
  };
  const packageFile = (
    revision: string,
  ): Record<string, unknown> | undefined => {
    const raw = file(revision, "package.json");
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid package");
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(
        "Package script validation blocked: package.json is invalid",
      );
    }
  };
  const original = packageFile(acceptedBaseSha);
  const predecessor = packageFile(authority.predecessorSha ?? acceptedBaseSha);
  const after = packageFile(commit);
  if (!original && selected.some((command) => !declared.has(command)))
    throw new Error(
      "Package script validation blocked: a new package.json needs exact source-declared command authority",
    );
  if (!after && !authority.preview)
    throw new Error(
      "Package script validation blocked: package.json is absent from the result tree",
    );
  for (const key of ["packageManager", "config", "pnpm"])
    if (
      (original ?? predecessor) &&
      !isDeepStrictEqual((original ?? predecessor)?.[key], after?.[key])
    )
      throw new Error(
        `Package script validation blocked: ${key} differs from the accepted base`,
      );
  const scripts = (pkg: Record<string, unknown>): Record<string, unknown> => {
    const value = pkg.scripts;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Package script validation blocked: scripts are unavailable",
      );
    return value as Record<string, unknown>;
  };
  const originalScripts =
    requests.length && original?.scripts ? scripts(original) : {};
  const predecessorScripts =
    requests.length && predecessor?.scripts ? scripts(predecessor) : {};
  const afterScripts = requests.length && after?.scripts ? scripts(after) : {};
  const usesPnpm =
    bootstrap || requests.some((request) => request!.manager === "pnpm");
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const command = scriptCommands[index]!;
    const name = request.name;
    const beforeScripts =
      typeof originalScripts[name] === "string"
        ? originalScripts
        : predecessorScripts;
    const body = beforeScripts[name];
    if (typeof body !== "string" && !declared.has(command))
      throw new Error(
        `Package script validation blocked: new script ${name} needs exact source-declared command authority`,
      );
    if (
      (typeof body === "string" && afterScripts[name] !== body) ||
      (!authority.preview && typeof afterScripts[name] !== "string")
    )
      throw new Error(
        `Package script validation blocked: script ${name} differs from the accepted base`,
      );
    for (const scriptName of [name, `pre${name}`, `post${name}`]) {
      if (
        scriptName !== name &&
        typeof body !== "string" &&
        afterScripts[scriptName] !== undefined
      )
        throw new Error(
          `Package script validation blocked: new script ${name} cannot add lifecycle hook ${scriptName}`,
        );
      if (
        scriptName !== name &&
        beforeScripts[scriptName] !== afterScripts[scriptName]
      )
        throw new Error(
          `Package script validation blocked: lifecycle hook ${scriptName} differs from the accepted base`,
        );
      const scriptBody = afterScripts[scriptName] ?? beforeScripts[scriptName];
      if (typeof scriptBody !== "string") continue;
      if (/\b(?:npm|pnpm)\b/.test(scriptBody))
        throw new Error(
          `Package script validation blocked: nested package-manager invocation in ${scriptName} needs separate authority`,
        );
    }
  }
  if (
    usesPnpm &&
    (file(acceptedBaseSha, "package.yaml") !== undefined ||
      file(commit, "package.yaml") !== undefined)
  )
    throw new Error(
      "Package script validation blocked: pnpm package.yaml manifests are not supported",
    );
  if (bootstrap) {
    if (
      (!file(acceptedBaseSha, "pnpm-lock.yaml") &&
        !declared.has(PINNED_PNPM_BOOTSTRAP)) ||
      (!file(commit, "pnpm-lock.yaml") && !authority.preview)
    )
      throw new Error(
        "Package script validation blocked: frozen pnpm bootstrap needs a tracked lockfile",
      );
    for (const path of [".pnpmfile.cjs", ".pnpmfile.js", ".pnpmfile.mjs"])
      if (
        file(acceptedBaseSha, path) !== undefined ||
        file(commit, path) !== undefined
      )
        throw new Error(
          "Package script validation blocked: pnpmfile hooks need separate authority",
        );
  }
  for (const path of [".npmrc", ...(usesPnpm ? ["pnpm-workspace.yaml"] : [])]) {
    const original = file(acceptedBaseSha, path);
    const predecessor = file(authority.predecessorSha ?? acceptedBaseSha, path);
    if (
      (original ?? predecessor) !== file(commit, path) &&
      !(
        path === "pnpm-workspace.yaml" &&
        original === undefined &&
        predecessor === undefined &&
        selected.every((command) => declared.has(command))
      ) &&
      !(
        path === "pnpm-workspace.yaml" &&
        authority.workspacePackageAdditions?.length
      )
    )
      throw new Error(
        `Package script validation blocked: ${path} differs from the accepted base`,
      );
  }
  if (
    bootstrap &&
    [file(commit, ".npmrc"), file(commit, "pnpm-workspace.yaml")].some(
      (content) => /pnpmfile/i.test(content ?? ""),
    )
  )
    throw new Error(
      "Package script validation blocked: configured pnpmfile hooks need separate authority",
    );
}

/** Supported root script forms; shell wrappers and package-manager flags are ambiguous. */
export function packageScriptInvocation(
  check: string,
): { manager: "npm" | "pnpm"; name: string } | undefined {
  const match = check
    .trim()
    .match(/^(npm|pnpm) (?:(run) )?([A-Za-z0-9][A-Za-z0-9:_-]*)$/);
  if (!match) return undefined;
  const manager = match[1] as "npm" | "pnpm";
  const name = match[3]!;
  if (manager === "npm" && !match[2] && name !== "test") return undefined;
  if (manager === "pnpm" && !match[2] && !["check", "test"].includes(name))
    return undefined;
  return { manager, name };
}

export async function validateWorkItem(
  checkout: string,
  root: string,
  item: WorkItem,
  commit: string,
  treeSha: string,
  acceptedBaseSha: string,
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  predecessorSha?: string,
  lfsMembers: ValidationLfsMember[] = [],
  contentStore?: ContentStore,
  workspacePackageAdditions: readonly string[] = [],
): Promise<ValidationEvidence> {
  assertPinnedNpmScripts(
    checkout,
    acceptedBaseSha,
    commit,
    item.validation.map((v) => v.command),
    {
      sourceDeclared: item.validation
        .filter((v) => v.provenance === "source-declared")
        .map((v) => v.command),
      predecessorSha,
      workspacePackageAdditions,
    },
  );
  return validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
    observe,
    observeOutput,
    lfsMembers,
    contentStore,
  );
}
