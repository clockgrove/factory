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
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  CapturedAssetSet,
  ContentStore,
  ModelInvocationContext,
  PlanningModel,
  ResultReviewCandidate,
  ResultReviewEvidenceSource,
  ResultReviewFinding,
  ValidationCommandReceipt,
  ValidationLfsMember,
  WorkItem,
} from "./contracts.js";
import type {
  AcceptancePending,
  FactoryState,
  ReviewRejectionReason,
  WorkState,
} from "./state.js";
import {
  pinnedGit,
  pinnedGitRaw,
  pinnedGitEnvironment,
  localValidationEnvironment,
  localValidationShellArguments,
} from "./process.js";
import { assetSelectionDigest, type HydrationReceipt } from "./media.js";

export interface CriterionEvidence {
  criterion: string;
  verdict: "pass" | "human-accept";
  source: string;
  quote: string;
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
  constructor(public readonly pending: AcceptancePending) {
    super(
      `Acceptance decision required for ${pending.criterion}: ${pending.question}`,
    );
  }
}

export interface ValidationEvidence {
  treeSha: string;
  commands: ValidationCommandReceipt[];
  hydrationReceipt?: HydrationReceipt;
  criteria?: CriterionEvidence[];
}

export type ReviewDeliveryObservation =
  | { kind: "regular" }
  | {
      kind: "native-stack";
      unitId: string;
      layerNumber: number;
      layerCount: number;
      predecessorItemId: string | null;
    };

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
    reviewedItemId: item.id,
    delivery,
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
  textBudgetPerBoundary?: number;
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
  const perBoundaryBudget =
    args.textBudgetPerBoundary ??
    Math.floor(configuredResultReviewTextBudget() / 2);
  const worker = resultChangePacket(
    checkout,
    current.baseSha,
    workerResultCommitSha,
    perBoundaryBudget,
  );
  const materialization = resultChangePacket(
    checkout,
    workerResultCommitSha,
    current.changeRef,
    perBoundaryBudget,
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

  return [
    {
      path: `Work Item Git delta: ${item.id} controller materialization`,
      complete:
        worker.truncatedPaths.length === 0 &&
        materialization.truncatedPaths.length === 0,
      content: JSON.stringify({
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
        workerChange: workerPacket,
        materializationChange: materializationPacket,
      }),
    },
  ];
}

function resultChangePacket(
  checkout: string,
  baseSha: string,
  commit: string,
  textBudgetOverride?: number,
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
    textBudgetOverride ??
    Number(process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES ?? 48_000);
  const textBudget =
    Number.isSafeInteger(configured) && configured >= 0 ? configured : 48_000;
  let remaining = textBudget;
  const patches = changes.map(({ path }, index) => {
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
    const limit = Math.ceil(remaining / (changes.length - index));
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
    const excerpt = output.subarray(0, limit).toString("utf8");
    const truncated = Boolean(result.error) || output.length > limit;
    remaining -= Buffer.byteLength(excerpt, "utf8");
    return { path, lineStats, excerpt, truncated };
  });
  return {
    change: JSON.stringify({ changes, textBudget, patches }),
    truncatedPaths: patches
      .filter((patch) => patch.truncated)
      .map((patch) => patch.path),
  };
}

function configuredResultReviewTextBudget(): number {
  const configured = Number(
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES ?? 48_000,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 48_000;
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
  return item.ownedPaths.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope,
  );
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
      receipt.treeSha !== expectedTree
    )
      throw new Error(
        `${label} command receipt ${index} is not bound to the exact result tree and order`,
      );
}

function workItemDeltaContent(args: {
  item: WorkItem;
  state: FactoryState;
  executionBaseSha: string;
  resultBaseSha: string;
  resultCommitSha: string;
  resultTreeSha: string;
  integratedCommitSha: string;
  integratedTreeSha: string;
  change: string;
}): string {
  const packet = parseResultChangePacket(args.change);
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
    changes: packet.changes,
    textBudget: packet.textBudget,
    patches: packet.patches.map(({ path, lineStats, truncated }) => ({
      path,
      lineStats,
      truncated,
    })),
  };
  const patches = packet.patches
    .map(
      (patch) =>
        `--- Exact patch ${JSON.stringify({ path: patch.path, lineStats: patch.lineStats, truncated: patch.truncated })} ---\n${patch.excerpt}`,
    )
    .join("\n");
  return `${JSON.stringify(identity)}\n${patches}`;
}

/**
 * Build final-review authority from supervisor state and exact Git objects.
 * Previous model verdicts and quotes are intentionally excluded.
 */
export function objectiveReviewEvidence(args: {
  state: FactoryState;
  checkout: string;
  integratedCommitSha: string;
  integratedTreeSha: string;
}): {
  observations: string;
  evidence: ResultReviewEvidenceSource[];
} {
  const { state, checkout, integratedCommitSha, integratedTreeSha } = args;
  if (state.integratedSha !== integratedCommitSha)
    throw new Error(
      "Final integrated commit differs from the atomic supervisor snapshot",
    );
  assertCommitTree(
    checkout,
    integratedCommitSha,
    integratedTreeSha,
    "Final integrated",
  );
  const evidence: ResultReviewEvidenceSource[] = [];
  const integrationRecords: {
    item: WorkItem;
    resultBaseSha: string;
    resultCommitSha: string;
    integratedCommitSha: string;
  }[] = [];
  const materializationPacketCount = state.graph.items.filter(
    (item) => state.work[item.id]?.selectedAssetSet,
  ).length;
  // Every item contributes one ordinary delta packet. A selected-asset item
  // adds separate worker and controller-boundary packets to the same budget.
  const finalReviewPatchPacketCount =
    state.graph.items.length + materializationPacketCount * 2;
  const perPatchTextBudget = Math.floor(
    configuredResultReviewTextBudget() /
      Math.max(1, finalReviewPatchPacketCount),
  );
  const work = state.graph.items.map((item) => {
    const current = state.work[item.id];
    if (
      !current ||
      current.status !== "done" ||
      !current.executionBaseSha ||
      !current.baseSha ||
      !current.changeRef ||
      !current.treeSha ||
      !current.integratedSha ||
      !current.validation
    )
      throw new Error(
        `Work Item ${item.id} lacks complete final-review identity`,
      );
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
    const itemIntegratedTreeSha = pinnedGit(
      checkout,
      "rev-parse",
      `${current.integratedSha}^{tree}`,
    );
    assertAncestor(
      checkout,
      current.changeRef,
      current.integratedSha,
      `Work Item ${item.id} result integration`,
    );
    assertAncestor(
      checkout,
      current.integratedSha,
      integratedCommitSha,
      `Work Item ${item.id} integration`,
    );
    assertCommandReceipts(
      current.validation,
      current.treeSha,
      `Work Item ${item.id} validation`,
    );
    const { change, truncatedPaths } = resultChangePacket(
      checkout,
      current.baseSha,
      current.changeRef,
      perPatchTextBudget,
    );
    const changePacket = parseResultChangePacket(change);
    const unownedChanges = changePacket.changes
      .map((entry) => entry.path)
      .filter((path) => !itemOwnsPath(item, path));
    if (unownedChanges.length)
      throw new Error(
        `Work Item ${item.id} final delta contains paths outside accepted ownership: ${unownedChanges.join(", ")}`,
      );
    integrationRecords.push({
      item,
      resultBaseSha: current.baseSha,
      resultCommitSha: current.changeRef,
      integratedCommitSha: current.integratedSha,
    });
    const evidencePath = `Work Item Git delta: ${item.id}`;
    evidence.push({
      path: evidencePath,
      complete: truncatedPaths.length === 0,
      content: workItemDeltaContent({
        item,
        state,
        executionBaseSha: current.executionBaseSha,
        resultBaseSha: current.baseSha,
        resultCommitSha: current.changeRef,
        resultTreeSha: current.treeSha,
        integratedCommitSha: current.integratedSha,
        integratedTreeSha: itemIntegratedTreeSha,
        change,
      }),
    });
    evidence.push(
      ...workItemMaterializationEvidence({
        state,
        item,
        checkout,
        textBudgetPerBoundary: perPatchTextBudget,
      }),
    );
    return {
      id: item.id,
      status: current.status,
      executionBaseCommitSha: current.executionBaseSha,
      resultBaseCommitSha: current.baseSha,
      resultCommitSha: current.changeRef,
      resultTreeSha: current.treeSha,
      validationTreeSha: current.validation.treeSha,
      validationCommands: current.validation.commands,
      pullRequest: current.pullRequest,
      integratedCommitSha: current.integratedSha,
      integratedTreeSha: itemIntegratedTreeSha,
      evidenceSource: evidencePath,
      selectedAssetSet: current.selectedAssetSet,
      selectedAsset: current.assets?.find(
        (set) => set.id === current.selectedAssetSet,
      ),
      selection: current.selection,
    };
  });
  assertIntegrationBindings(checkout, integrationRecords);
  return {
    observations: JSON.stringify({
      integratedCommitSha,
      integratedTreeSha,
      work,
    }),
    evidence,
  };
}

function boundedReviewText(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13
        ? " "
        : code === 127
          ? " "
          : character;
    })
    .join("")
    .slice(0, 4_096);
}

function capturedReviewFinding(
  candidate: ResultReviewFinding,
): ResultReviewCandidate {
  return {
    criterion: boundedReviewText(candidate.criterion),
    verdict: boundedReviewText(candidate.verdict),
    source: boundedReviewText(candidate.source),
    quote: boundedReviewText(candidate.quote),
    detail: boundedReviewText(candidate.detail),
    question: boundedReviewText(candidate.question),
  };
}

function reviewFindingRejection(
  candidate: ResultReviewFinding | undefined,
  criterion: string,
  groundedSources: ResultReviewEvidenceSource[],
  patchExcerpts: string[],
):
  | {
      field:
        | "finding"
        | "criterion"
        | "verdict"
        | "detail"
        | "source"
        | "quote";
      reason: ReviewRejectionReason;
    }
  | undefined {
  if (!candidate) return { field: "finding", reason: "missing-finding" };
  if (candidate.criterion !== criterion)
    return { field: "criterion", reason: "criterion-mismatch" };
  if (!["pass", "needs-human", "refuse"].includes(candidate.verdict))
    return { field: "verdict", reason: "invalid-verdict" };
  if (!candidate.detail?.trim())
    return { field: "detail", reason: "empty-detail" };
  const source = groundedSources.find(
    (entry) => entry.path === candidate.source,
  );
  if (!source) return { field: "source", reason: "unknown-source" };
  if (candidate.verdict === "pass" && source.complete === false)
    return { field: "source", reason: "source-truncated" };
  if (!candidate.quote?.trim())
    return { field: "quote", reason: "empty-quote" };
  if (
    !source.content.includes(candidate.quote) &&
    !(
      source.path === "Exact Git change packet" &&
      patchExcerpts.some((excerpt) => excerpt.includes(candidate.quote))
    )
  )
    return { field: "quote", reason: "quote-not-found" };
  return undefined;
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
}): Promise<ValidationEvidence> {
  const { model, checkout, baseSha, commit, evidence, criteria, sources } =
    args;
  if (!criteria.length) throw new Error("No acceptance criteria to prove");
  const observedTree = pinnedGit(checkout, "rev-parse", `${commit}^{tree}`);
  if (observedTree !== evidence.treeSha)
    throw new Error("Acceptance result tree differs from command evidence");
  assertCommandReceipts(evidence, evidence.treeSha, "Acceptance");
  const { change, truncatedPaths } = resultChangePacket(
    checkout,
    baseSha,
    commit,
  );
  const evidenceSources: ResultReviewEvidenceSource[] = [
    { path: "Exact Git change packet", content: change },
    {
      path: "Command pass evidence",
      content: JSON.stringify(evidence.commands),
    },
    {
      path: "Delivery observations",
      content: args.observations ?? "",
    },
    ...(args.evidenceSources ?? []),
  ];
  const groundedSources = [...sources, ...evidenceSources];
  if (
    new Set(groundedSources.map((source) => source.path)).size !==
    groundedSources.length
  )
    throw new Error("Result review evidence paths must be unique");
  const patchExcerpts = parseResultChangePacket(change).patches.map(
    (patch) => patch.excerpt,
  );
  let findings: Awaited<
    ReturnType<NonNullable<PlanningModel["reviewResult"]>>
  >["findings"] = [];
  let reviewFailure: string | undefined;
  let reviewFindingsAvailable = false;
  if (model.reviewResult) {
    try {
      const reviewed = await model.reviewResult({
        reviewPhase: args.reviewPhase ?? "result-review",
        criteria,
        baseSha,
        treeSha: evidence.treeSha,
        sources,
        change,
        commands: evidence.commands,
        ...(args.evidenceSources?.length
          ? { evidence: args.evidenceSources }
          : {}),
        ...(args.observations ? { observations: args.observations } : {}),
        invocation: args.invocation,
      });
      if (!Array.isArray(reviewed.findings)) {
        observeInvalidReview(args.invocation, "findings", "not-an-array");
        throw new Error("review response has no findings array");
      }
      findings = reviewed.findings;
      reviewFindingsAvailable = true;
    } catch (error) {
      reviewFailure = error instanceof Error ? error.message : String(error);
    }
  } else reviewFailure = "No independent result reviewer is configured";
  const proven: CriterionEvidence[] = [];
  for (const [index, criterion] of criteria.entries()) {
    const decision = args.decisions?.find(
      (item) =>
        item.criterion === criterion && item.treeSha === evidence.treeSha,
    );
    if (decision?.outcome === "refuse")
      throw new Error(
        `Acceptance criterion refused by ${decision.actor}: ${criterion}`,
      );
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
    const candidate = findings[index];
    const rejection = reviewFindingRejection(
      candidate,
      criterion,
      groundedSources,
      patchExcerpts,
    );
    if (rejection && reviewFindingsAvailable)
      observeInvalidReview(args.invocation, rejection.field, rejection.reason);
    const finding = rejection ? undefined : candidate;
    if (finding?.verdict === "pass" && truncatedPaths.length === 0) {
      proven.push({
        criterion,
        verdict: "pass",
        source: finding.source,
        quote: finding.quote,
        detail: finding.detail,
      });
      continue;
    }
    if (finding?.verdict === "refuse")
      throw new Error(
        `Acceptance criterion disproved: ${criterion}: ${finding.detail}`,
      );
    throw new AcceptanceDecisionRequired({
      criterion,
      treeSha: evidence.treeSha,
      source:
        finding?.source ??
        (boundedReviewText(candidate?.source).trim() || "OBJECTIVE"),
      quote:
        finding?.quote ??
        (boundedReviewText(candidate?.quote).trim() || criterion),
      detail:
        finding?.verdict === "pass" && truncatedPaths.length > 0
          ? `Independent review cannot auto-pass because text excerpts were truncated for ${truncatedPaths.slice(0, 3).join(", ")}${truncatedPaths.length > 3 ? ` and ${truncatedPaths.length - 3} more path(s)` : ""}; a source quote and partial patch do not prove the full result.`
          : (finding?.detail ??
            (reviewFailure
              ? `Independent result review failed: ${reviewFailure}`
              : candidate
                ? `Independent result review returned invalid evidence for this criterion (${rejection?.field}: ${rejection?.reason})`
                : "Independent result review omitted this criterion")),
      question:
        finding?.verdict === "pass" && truncatedPaths.length > 0
          ? `Inspect tree ${evidence.treeSha} and decide this criterion, or retry with a larger FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES and reviewer context: ${criterion}`
          : finding?.question?.trim() ||
            boundedReviewText(candidate?.question).trim() ||
            `Inspect tree ${evidence.treeSha} and decide whether it satisfies this criterion, or retry with a reviewer able to read the change packet: ${criterion}`,
      ...(candidate ? { reviewFinding: capturedReviewFinding(candidate) } : {}),
      ...(rejection ? { reviewRejection: rejection } : {}),
    });
  }
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
      failureClass: "semantic-validation",
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
): void {
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
): Promise<void> {
  if (!members.length) return;
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
  for (const member of selected) assertSelectedLfsPointer(worktree, member);
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
  mkdirSync(root, { recursive: true });
  const emptyCredentials = join(root, "empty-gh-config");
  mkdirSync(emptyCredentials, { recursive: true, mode: 0o700 });
  const worktree = join(root, randomUUID());
  pinnedGit(checkout, "worktree", "add", "--detach", worktree, commit);
  try {
    const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
    if (treeSha !== expectedTree)
      throw new Error(
        `Validation tree mismatch: expected ${expectedTree}, got ${treeSha}`,
      );
    if (pinnedGit(worktree, "status", "--porcelain"))
      throw new Error("Validation worktree is not initially clean");
    await hydrateSelectedLfsBytes(worktree, lfsMembers, contentStore);
    const hydratedStatus = pinnedGit(worktree, "status", "--porcelain");
    const evidence: ValidationEvidence = { treeSha, commands: [] };
    for (const [index, check] of commands.entries()) {
      const started = Date.now();
      const child = spawn("sh", localValidationShellArguments(check), {
        cwd: worktree,
        env: localValidationEnvironment(emptyCredentials),
      });
      let stdout = "";
      let stderr = "";
      const watch = (stream: "stdout" | "stderr") => {
        const decoder = new StringDecoder("utf8");
        child[stream].on("data", (chunk: Buffer) => {
          const text = decoder.write(chunk);
          if (stream === "stdout") stdout += text;
          else stderr += text;
          if (text)
            observeOutput?.({ index, stream, output: text, final: false });
        });
        return () => {
          const trailing = decoder.end();
          if (stream === "stdout") stdout += trailing;
          else stderr += trailing;
          observeOutput?.({ index, stream, output: trailing, final: true });
        };
      };
      const flushStdout = watch("stdout");
      const flushStderr = watch("stderr");
      const result = await new Promise<{
        status: number | null;
        error?: Error;
      }>((resolve) => {
        let error: Error | undefined;
        child.on("error", (cause: Error) => {
          error = cause;
        });
        child.on("close", (status: number | null) =>
          resolve({ status, error }),
        );
      });
      flushStdout();
      flushStderr();
      const output = `${stdout}${stderr}`;
      observe?.({
        index,
        passed: !result.error && result.status === 0,
        exitCode: result.status ?? -1,
        durationMs: Date.now() - started,
        output,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `Validation command failed (${result.status}): ${check}: ${output}`,
        );
      evidence.commands.push({
        index,
        command: check,
        passed: true,
        exitCode: 0,
        treeSha,
      });
    }
    for (const member of lfsMembers) assertSelectedLfsBytes(worktree, member);
    if (pinnedGit(worktree, "status", "--porcelain") !== hydratedStatus)
      throw new Error("Validation command modified the result tree");
    return evidence;
  } finally {
    try {
      pinnedGit(checkout, "worktree", "remove", "--force", worktree);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

/** Package managers resolve scripts and lifecycle hooks from the result tree.
 * Pin the selected entrypoint and execution config to the accepted base. */
export const PINNED_PNPM_BOOTSTRAP =
  "pnpm install --frozen-lockfile --ignore-scripts";

export interface PackageScriptAuthority {
  /** Commands literally declared by a pinned source, not inferred by the model. */
  sourceDeclared?: readonly string[];
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
