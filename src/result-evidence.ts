import { objectiveCandidate } from "./qa.js";
import { nativePrerequisiteReviewEvidence } from "./native-prerequisite-evidence.js";
import { assertGraphRevisions } from "./graph-amendments.js";
import {
  allowanceKey,
  assertRepairLedger,
  consumption,
  failureDigest,
  itemEvent,
  repairScopes,
} from "./repair-policy.js";
import { ownsPath } from "./ownership.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import type {
  CapturedAssetSet,
  ResultReviewEvidenceSource,
  ValidationCommandReceipt,
  WorkItem,
  WorkDiscovery,
} from "./contracts.js";
import { assetSelectionDigest } from "./media.js";
import { pinnedGit, pinnedGitEnvironment, pinnedGitRaw } from "./process.js";
import type { FactoryState, WorkState } from "./state.js";
import { assertFailedValidationRecord } from "./failed-validation.js";
import { deliveredHead } from "./delivery/branch-update.js";
import {
  type ValidationEvidence,
  assertSelectedLfsValidation,
} from "./validation-evidence.js";

/** Read only tracked attribute files on selected paths, never arbitrary tree blobs. */
export function selectedLfsReviewEvidence(
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

export function resultChangePacket(
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

export function configuredResultReviewTextBudget(): number {
  const configured = Number(
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES ?? 48_000,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 48_000;
}

/**
 * Write the exact tree's files into a private directory the reviewer reads.
 * Git alone decides the bytes: a throwaway index, no filters or hooks, and
 * LFS pointers stay pointers. The directory holds no repository.
 */
export function materializeResultTree(
  checkout: string,
  treeSha: string,
): { directory: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), "factory-result-tree-"));
  const directory = join(root, "tree");
  const remove = () => rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(directory);
    const env = {
      ...pinnedGitEnvironment(),
      GIT_INDEX_FILE: join(root, "index"),
    };
    for (const args of [
      ["read-tree", treeSha],
      ["--work-tree", directory, "checkout-index", "--all", "--force"],
    ]) {
      const result = spawnSync("git", ["-C", checkout, ...args], {
        env,
        maxBuffer: 1 << 20,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `Cannot materialize exact result tree for independent review: ${result.stderr.toString("utf8")}`,
        );
    }
    return { directory, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/** Observe complete raw bytes, not just equal Git object names or filtered checkout files. */
export function unchangedResultByteEvidence(
  checkout: string,
  comparisonBaseSha: string,
  resultCommitSha: string,
  limit: number,
): {
  sources: ResultReviewEvidenceSource[];
  textBytes: number;
  rawBytes: number;
} {
  const sources: ResultReviewEvidenceSource[] = [];
  const budget = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
  let remaining = budget;
  const rawBudget = configuredResultReviewTextBudget();
  let rawRemaining = rawBudget;
  // Retain serialized room for an unavailable outcome after a bounded raw read.
  const available = () => Math.max(0, remaining - 512);
  const emit = (
    path: string,
    facts: Record<string, unknown>,
    complete: boolean,
    useReserve = false,
  ) => {
    const source = { path, content: JSON.stringify(facts), complete };
    const bytes = Buffer.byteLength(JSON.stringify(source));
    if (bytes > (useReserve ? remaining : available())) return false;
    remaining -= bytes;
    sources.push(source);
    return true;
  };
  const unavailable = (reason: string) => {
    emit(
      "Named-base raw-byte comparison unavailable",
      { availability: "unavailable", reason },
      false,
      true,
    );
    return {
      sources,
      textBytes: budget - remaining,
      rawBytes: rawBudget - rawRemaining,
    };
  };
  if (
    !/^[0-9a-f]{40}$/.test(comparisonBaseSha) ||
    !/^[0-9a-f]{40}$/.test(resultCommitSha)
  )
    return unavailable(
      "Commit identities are not exact supported Git object names",
    );
  const read = (args: string[], maximum: number): Buffer | undefined => {
    maximum = Math.min(maximum, rawRemaining);
    if (maximum < 1) return undefined;
    const result = spawnSync("git", ["-C", checkout, ...args], {
      env: pinnedGitEnvironment(),
      maxBuffer: maximum,
    });
    const output = result.stdout ?? Buffer.alloc(0);
    rawRemaining -= Math.min(output.length, maximum);
    if (result.error || result.status !== 0 || output.length > maximum)
      return undefined;
    return output;
  };
  let identity: {
    comparisonBaseCommitSha: string;
    comparisonBaseTreeSha: string;
    resultCommitSha: string;
    resultTreeSha: string;
  };
  try {
    identity = {
      comparisonBaseCommitSha: pinnedGit(
        checkout,
        "rev-parse",
        `${comparisonBaseSha}^{commit}`,
      ),
      comparisonBaseTreeSha: pinnedGit(
        checkout,
        "rev-parse",
        `${comparisonBaseSha}^{tree}`,
      ),
      resultCommitSha: pinnedGit(
        checkout,
        "rev-parse",
        `${resultCommitSha}^{commit}`,
      ),
      resultTreeSha: pinnedGit(
        checkout,
        "rev-parse",
        `${resultCommitSha}^{tree}`,
      ),
    };
  } catch {
    return unavailable("Named comparison base or result commit unavailable");
  }
  type Entry = { mode: string; kind: string; blobOid: string };
  const entries = (tree: string): Map<string, Entry> | undefined => {
    const output = read(["ls-tree", "-r", "-z", tree], rawRemaining);
    if (!output || (output.length && output.at(-1) !== 0)) return undefined;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        output,
      );
    } catch {
      return undefined;
    }
    const map = new Map<string, Entry>();
    for (const record of text.split("\0").slice(0, -1)) {
      const match = record.match(
        /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/,
      );
      if (!match) return undefined;
      map.set(match[4]!, {
        mode: match[1]!,
        kind: match[2]!,
        blobOid: match[3]!,
      });
    }
    return map;
  };
  const base = entries(identity.comparisonBaseTreeSha);
  const result = entries(identity.resultTreeSha);
  if (!base || !result)
    return unavailable("Complete bounded tracked-object inventory unavailable");
  for (const path of new Set([...base.keys(), ...result.keys()])) {
    const before = base.get(path);
    const after = result.get(path);
    const facts = {
      ...identity,
      path,
      base: before ?? null,
      result: after ?? null,
    };
    const label = `Named-base raw-byte comparison: ${JSON.stringify(path)}`;
    if (
      !before ||
      !after ||
      before.kind !== "blob" ||
      after.kind !== "blob" ||
      !["100644", "100755"].includes(before.mode) ||
      !["100644", "100755"].includes(after.mode) ||
      before.mode !== after.mode ||
      before.blobOid !== after.blobOid
    ) {
      if (
        !emit(
          label,
          {
            ...facts,
            availability: "unavailable",
            reason:
              "Not an unchanged regular tracked file; use separate exact change evidence. No symlink target or submodule content is compared.",
          },
          false,
        )
      )
        return unavailable(
          "Remaining serialized comparison evidence exceeds budget",
        );
      continue;
    }
    const sizeOutput = read(
      ["cat-file", "-s", before.blobOid],
      Math.min(64, rawRemaining),
    );
    const size =
      sizeOutput && /^\d+\n$/.test(sizeOutput.toString("ascii"))
        ? Number(sizeOutput.toString("ascii"))
        : NaN;
    // Reserve receipt space before reading; serialized binary expansion is charged by emit.
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size * 2 > rawRemaining ||
      1024 > available()
    ) {
      if (
        !emit(
          label,
          {
            ...facts,
            availability: "unavailable",
            reason:
              "Complete raw blob reads or receipt exceed their bounded review budgets",
          },
          false,
        )
      )
        return unavailable(
          "Remaining serialized comparison evidence exceeds budget",
        );
      continue;
    }
    const baseBytes = read(
      ["cat-file", "blob", before.blobOid],
      Math.max(1, size),
    );
    const resultBytes = read(
      ["cat-file", "blob", after.blobOid],
      Math.max(1, size),
    );
    if (
      !baseBytes ||
      !resultBytes ||
      baseBytes.length !== size ||
      resultBytes.length !== size
    ) {
      if (
        !emit(
          label,
          {
            ...facts,
            availability: "unavailable",
            reason: "Complete raw blob bytes unavailable",
          },
          false,
        )
      )
        return unavailable(
          "Remaining serialized comparison evidence exceeds budget",
        );
      continue;
    }
    let binary = baseBytes.includes(0);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(baseBytes);
    } catch {
      binary = true;
    }
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const equal = baseBytes.equals(resultBytes);
    if (
      !emit(
        label,
        {
          ...facts,
          availability: "available",
          comparison: "complete-raw-Git-blob-Buffer.equals",
          byteEqual: equal,
          base: {
            ...before,
            byteCount: baseBytes.length,
            sha256: digest(baseBytes),
          },
          result: {
            ...after,
            byteCount: resultBytes.length,
            sha256: digest(resultBytes),
          },
          ...(binary
            ? {
                baselineContent: {
                  encoding: "base64",
                  complete: true,
                  content: baseBytes.toString("base64"),
                },
              }
            : {}),
          scope:
            "Raw tracked blob bytes only, including LFS pointers; no opaque semantics, host conditions, symlink/submodule targets or hydrated/uploaded/published media.",
        },
        true,
      )
    )
      return unavailable(
        "Complete comparison observed but serialized receipt exceeds budget",
      );
  }
  return {
    sources,
    textBytes: budget - remaining,
    rawBytes: rawBudget - rawRemaining,
  };
}

/** Inventory Git paths, not checkout files, blob contents or submodule contents. */
export function resultTreeInventory(
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
      const prefix = `${JSON.stringify({
        ...identity.metadata,
        evidenceScope:
          "This exact file delta only; unchanged file content and sibling deltas are not supplied here.",
        file,
        patch: {
          path: patch.path,
          lineStats: patch.lineStats,
          truncated: patch.truncated,
        },
      })}\n`;
      const body = literalGitPatches({ ...packet, patches: [patch] });
      return {
        path: `${identity.path} file ${JSON.stringify(patch.path)}`,
        complete: !patch.truncated,
        content: prefix + body,
        reusableBody: {
          start: prefix.length,
          length: body.length,
          digest: createHash("sha256").update(body).digest("hex"),
        },
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
    /** The PR head that was merged: `resultCommitSha` or GitHub's update of it. */
    deliveredHeadSha: string;
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
    const top = group.at(-1)!;
    const parents = commitParents(checkout, integratedCommitSha);
    if (parents.length !== 2 || parents[1] !== top.deliveredHeadSha)
      throw new Error(
        `Integrated commit ${integratedCommitSha} is not bound to the exact delivered result head`,
      );
    assertBranchUpdateChain(
      checkout,
      top.deliveredHeadSha,
      top.resultCommitSha,
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

/**
 * A delivered head other than the result is GitHub's update of the PR
 * branch with its base (#576): a chain of two-parent merges whose first
 * parents lead to the validated result.
 */
function assertBranchUpdateChain(
  checkout: string,
  deliveredHeadSha: string,
  resultCommitSha: string,
): void {
  let head = deliveredHeadSha;
  for (let step = 0; head !== resultCommitSha; step++) {
    const parents = commitParents(checkout, head);
    if (step >= 100 || parents.length !== 2)
      throw new Error(
        `Delivered head ${deliveredHeadSha} is not a branch update of result ${resultCommitSha}`,
      );
    head = parents[0]!;
  }
}

export function assertCommandReceipts(
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
  assertGraphRevisions(state);
  assertRepairLedger(state);
  const history = current.recovery?.history ?? [];
  let priorIndex = -1;
  for (const [index, entry] of history.entries())
    if (entry.failure?.event === correction.event) priorIndex = index;
  const prior = history[priorIndex];
  if (
    !prior?.failure ||
    prior.failure.digest !== failureDigest(prior.failure.detail) ||
    prior.failure.digest !== correction.failureDigest ||
    prior.failure.classification !== "implementation" ||
    correction.kind !== "implementation" ||
    !prior.work.attempt ||
    prior.work.status !== "failed" ||
    prior.failure.event !==
      itemEvent(item.id, prior.work.step ?? "execute", priorIndex) ||
    correction.event !== prior.failure.event
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
  const scopes = repairScopes(state, item.id);
  const candidateRevision =
    candidate.graphRevisionDigest ??
    candidate.failedValidation?.graphRevisionDigest;
  const candidateGraph =
    state.graphRevisions?.find((entry) => entry.digest === candidateRevision)
      ?.graph ??
    (candidateRevision === state.planGraphDigest && !state.graphRevisions
      ? state.graph
      : undefined);
  if (candidateRevision && !candidateGraph)
    throw new Error(
      `Work Item ${item.id} retained failure graph is unavailable`,
    );
  const derivedScopes = repairScopes(
    {
      ...state,
      graph: candidateGraph ?? state.graph,
      work: { ...state.work, [item.id]: { ...current, recovery: undefined } },
    },
    item.id,
  );
  const charged = state.charges?.[prior.failure.event!];
  // A wrong result is charged under its event; assertRepairLedger above
  // refuses a wrong result that lost its event.
  if (
    !state.autonomy.repairClasses.includes(correction.kind) ||
    !charged?.allowances.includes(key) ||
    new Set(scopes).size !== scopes.length ||
    new Set(charged.scopes).size !== charged.scopes.length ||
    !isDeepStrictEqual([...scopes].sort(), [...derivedScopes].sort()) ||
    !isDeepStrictEqual([...scopes].sort(), [...charged.scopes].sort()) ||
    !/^[a-f0-9]{64}$/.test(state.configDigest)
  )
    throw new Error(
      `Work Item ${item.id} correction lacks charged consumption`,
    );
  assertFailedValidationRecord(
    candidate.failedValidation,
    state,
    item.id,
    candidate,
    prior.failure,
  );
  return {
    controllerFacts: {
      policyBinding: {
        origin: "objective-autonomy-snapshot",
        repository: state.repository,
        objective: state.objective,
        runId: state.runId,
        configDigest: state.configDigest,
        acceptedBaseCommitSha: state.baseSha,
        failedGraphRevisionDigest: candidateRevision ?? null,
        permittedRepairClasses: [...state.autonomy.repairClasses],
        failureEvent: prior.failure.event,
        chargedAllowances: [...charged.allowances],
        chargedScopes: [...charged.scopes],
      },
      failedAttempt: {
        attemptId: candidate.attempt,
        status: candidate.status,
        phase: candidate.step ?? null,
        graphRevisionDigest: candidate.graphRevisionDigest ?? null,
        executionBaseCommitSha: candidate.executionBaseSha ?? null,
        resultBaseCommitSha: candidate.baseSha ?? null,
        resultCommitSha: candidate.changeRef ?? null,
        resultTreeSha: candidate.treeSha ?? null,
        validation: candidate.failedValidation
          ? { availability: "available", ...candidate.failedValidation }
          : { availability: "unavailable" },
        failure: {
          event: prior.failure.event,
          digest: prior.failure.digest,
          validationCaptureDigest:
            prior.failure.validationCaptureDigest ?? null,
          classification: prior.failure.classification,
          at: prior.failure.at,
          continuation: prior.failure.continuation,
        },
      },
      currentAttemptId: current.attempt ?? null,
      currentExecutionBaseCommitSha: current.executionBaseSha ?? null,
      currentResultBaseCommitSha: current.baseSha ?? null,
      currentResultCommitSha: current.changeRef ?? null,
      currentResultTreeSha: current.treeSha ?? null,
      repairClass: correction.kind,
      automaticReadiness:
        correction.actor === "factory-controller"
          ? correction.readiness
            ? { availability: "available", ...correction.readiness }
            : { availability: "unavailable" }
          : { availability: "not-applicable", origin: "operator-declaration" },
      snapshotConsumption: {
        allowance: key,
        objective: {
          consumed: consumption(state)[key],
          limit: state.autonomy.allowances[key],
        },
        paths: scopes.map((scope) => ({
          scope,
          consumed: consumption(state, scope)[key],
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
  evidence.push(
    ...nativePrerequisiteReviewEvidence({
      state,
      checkout,
      candidateCommitSha: current.changeRef,
      candidateTreeSha: current.treeSha,
    }),
  );
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
              deliveredHeadSha: deliveredHead(work)!,
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
  const evidence: ResultReviewEvidenceSource[] =
    nativePrerequisiteReviewEvidence(args);
  const integrationRecords: Parameters<typeof assertIntegrationBindings>[1] =
    [];
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
        deliveredHeadSha: deliveredHead(current)!,
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
      integratedTreeSha: state.integratedSha
        ? pinnedGit(checkout, "rev-parse", `${state.integratedSha}^{tree}`)
        : null,
      // Commits others pushed on top of the integration, now the candidate.
      followedHeads:
        candidate.commitSha === state.integratedSha
          ? []
          : (state.finalHead?.heads ?? []),
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
