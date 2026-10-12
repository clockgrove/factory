import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  type AccountingSeal,
  assertAccountingSealBinding,
  assertAccountingSealContent,
  decodeAccountingRecord,
} from "./accounting.js";
import type { FactoryConfig } from "./config.js";
import { stateRoot } from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  CapturedAssetSet,
  ContentRef,
  ContentStore,
  ExecutionRequest,
  ExecutionResult,
  HarnessRequest,
} from "./contracts.js";
import {
  assertDiscoveryOutputManifest,
  type DiscoveryOutputManifest,
  parseDiscoveryBody,
} from "./discovery.js";
import {
  assertRejectedCollectionReceipt,
  authenticateRejectedCollectionReceipt,
  type RejectedCollectionReceipt,
} from "./execution/local.js";
import {
  assertProcessActive,
  pinnedGit,
  pinnedGitEnvironment,
  subprocessAsync,
} from "./process.js";
import type {
  RecoveryCheckpointClosure,
  RecoveryCheckpointFile,
} from "./recovery-checkpoint.js";
import {
  assertRecoveryCheckpointManifest,
  cachedRecoveryCheckpointGitPack,
  retainRecoveryCheckpointGitPack,
} from "./recovery-checkpoint.js";
import type { RepositoryMemoryBinding } from "./repository-memory.js";
import { decodeRepositoryMemoryManifest } from "./repository-memory.js";
import { isPreparationState, type WorkState } from "./state.js";
import { parsePortableContinuation } from "./state-store.js";
import type { ValidationEvidence } from "./validation-evidence.js";
import type { WorkflowRecipePin } from "./workflow-recipes.js";

export interface RecoveryGitObject {
  sha: string;
  kind: "commit" | "tree" | "blob";
  role: string;
}
export interface RecoveryClosureGap {
  path: string;
  availability: "missing-legacy" | "unavailable" | "transient";
  reason: string;
  required?: boolean;
}
interface BodyRoot {
  ref: ContentRef;
  kind:
    | "discovery"
    | "expansion"
    | "memory"
    | "accounting"
    | "restoration-original"
    | "restoration-archive";
  identity?: {
    repository: string;
    objective?: number;
    runId?: string;
    configDigest?: string;
    schemaVersion?: number;
  };
  binding?: RepositoryMemoryBinding;
  accounting?: AccountingSeal;
}
export interface ContinuationReferences {
  contentRefs: ContentRef[];
  gitObjects: RecoveryGitObject[];
  gaps: RecoveryClosureGap[];
}
const refKey = (ref: ContentRef) =>
  JSON.stringify([ref.digest, ref.bytes, ref.mediaType]);

function assertRef(ref: ContentRef): void {
  if (
    !ref ||
    !/^[a-f0-9]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    typeof ref.mediaType !== "string" ||
    !ref.mediaType
  )
    throw new Error(
      "Recovery checkpoint has an invalid typed content reference",
    );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Recovery checkpoint has an invalid typed record");
  return value as Record<string, unknown>;
}

function assetReferences(
  sets: CapturedAssetSet[] | undefined,
  add: (ref: ContentRef | undefined) => void,
  gaps: RecoveryClosureGap[],
  excludedManifestDigests?: ReadonlySet<string>,
): void {
  for (const set of sets ?? []) {
    if (
      set.capture?.declarationDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(set.capture.declarationDigest)
    )
      throw new Error("Asset declaration digest is invalid");
    if (set.manifestRef) {
      assertRef(set.manifestRef);
      if (
        set.manifestRef.mediaType !== "application/json" ||
        (set.capture?.declarationDigest !== undefined &&
          set.manifestRef.digest !== set.capture.declarationDigest)
      )
        throw new Error("Asset manifest differs from its original declaration");
      if (!excludedManifestDigests?.has(set.manifestRef.digest))
        add(set.manifestRef);
    } else if (set.capture?.declarationDigest) {
      gaps.push({
        path: `media/manifests/${set.capture.declarationDigest}.json`,
        availability: "missing-legacy",
        required: false,
        reason:
          "Historical asset receipt retained a declaration digest without its original bytes",
      });
    }
    for (const input of set.inputs ?? []) add(input.ref);
    for (const member of set.members) add(member.ref);
    for (const input of set.capture?.inputs ?? []) add(input.ref);
  }
}

function rejectedManifestDigests(
  receipt: RejectedCollectionReceipt | undefined,
): ReadonlySet<string> {
  return new Set(
    (receipt?.staging ?? []).flatMap((entry) =>
      entry.path === ".factory-assets.json" &&
      entry.availability === "unavailable" &&
      entry.digest !== undefined
        ? [entry.digest]
        : [],
    ),
  );
}

function accountingReferences(
  usage: unknown,
  add: (ref: ContentRef | undefined) => void,
  roots: BodyRoot[],
): void {
  if (usage === undefined) return;
  const value = object(usage);
  if (value.source !== "durable-accounting") return;
  const seal = object(value.accounting) as unknown as AccountingSeal;
  if (typeof value.runId !== "string")
    throw new Error("Accounting observation lacks its original run binding");
  assertAccountingSealBinding(
    seal.repository,
    seal.objective,
    value.runId,
    seal,
  );
  for (const ref of seal.records) add(ref);
  if (seal.records[0])
    roots.push({ ref: seal.records[0], kind: "accounting", accounting: seal });
}

/** Only declared record fields supply reads; opaque evidence and session data do not. */
function continuationReferences(value: unknown): ContinuationReferences & {
  roots: BodyRoot[];
} {
  const identity = object(value);
  if (
    typeof identity.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository) ||
    !Number.isSafeInteger(identity.objective) ||
    Number(identity.objective) < 1
  )
    throw new Error("Recovery checkpoint snapshot identity is invalid");
  const state = parsePortableContinuation(
    value,
    identity.repository,
    Number(identity.objective),
  );
  const refs = new Map<string, ContentRef>();
  const objects = new Map<string, RecoveryGitObject>();
  const roots: BodyRoot[] = [];
  const gaps: RecoveryClosureGap[] = [];
  const add = (ref: ContentRef | undefined) => {
    if (!ref) return;
    assertRef(ref);
    refs.set(refKey(ref), structuredClone(ref));
  };
  const git = (
    sha: string | undefined | null,
    kind: RecoveryGitObject["kind"],
    role: string,
  ) => {
    if (!sha) return;
    if (!/^[a-f0-9]{40,64}$/.test(sha))
      throw new Error("Recovery checkpoint has an invalid Git object identity");
    objects.set(`${kind}:${sha}`, { sha, kind, role });
  };
  if (state.restoration) {
    const receipt = state.restoration;
    add(receipt.original.snapshot);
    add(receipt.archive);
    roots.push({
      ref: receipt.original.snapshot,
      kind: "restoration-original",
      identity: {
        repository: state.repository,
        objective: state.objective,
        runId: state.runId,
        configDigest: state.configDigest,
        schemaVersion: receipt.original.schemaVersion,
      },
    });
    roots.push({
      ref: receipt.archive,
      kind: "restoration-archive",
      identity: { repository: state.repository },
    });
  }
  const recipe = (pin: WorkflowRecipePin | undefined) => {
    if (!pin) return;
    add(pin.definitionRef);
    add(pin.resolvedRef);
    if (pin.origin.kind === "repository") {
      git(pin.origin.baseSha, "commit", "recipe-source");
      git(pin.origin.blobSha, "blob", "recipe-definition");
    }
  };
  const discovery = (manifest: DiscoveryOutputManifest | undefined) => {
    if (!manifest) return;
    assertDiscoveryOutputManifest(manifest);
    add(manifest.body);
    roots.push({ ref: manifest.body, kind: "discovery" });
    git(manifest.source.commitSha, "commit", "discovery-source");
    git(manifest.source.treeSha, "tree", "discovery-source-tree");
  };
  const assets = (sets: CapturedAssetSet[] | undefined) => {
    assetReferences(sets, add, gaps);
  };
  const rejectedCollection = (
    value: unknown,
    admitted: ExecutionRequest | undefined,
    identity: string,
  ): RejectedCollectionReceipt | undefined => {
    if (value === undefined) return undefined;
    if (!admitted)
      throw new Error("Rejected collection lacks its admitted request");
    assertRejectedCollectionReceipt(value, admitted, identity);
    const path = `rejections/${value.requestDigest}`;
    for (const [role, body] of [
      ["raw-return", value.rawReturn],
      ...value.staging.map((entry) => [entry.path, entry] as const),
    ] as const) {
      if (body.availability === "available") add(body.ref);
      else
        gaps.push({
          path: `${path}/${role}`,
          availability: "unavailable",
          required: false,
          reason: `Authenticated rejected output is ineligible for retention: ${body.reason}`,
        });
    }
    git(value.candidate.baseSha, "commit", "rejected-source-base");
    if (value.candidate.availability === "available") {
      git(value.candidate.commitSha, "commit", "rejected-source-observation");
      git(value.candidate.treeSha, "tree", "rejected-source-tree");
    } else
      gaps.push({
        path: `${path}/candidate`,
        availability: "unavailable",
        required: false,
        reason:
          "Authenticated rejected source candidate failed its collector safety admission",
      });
    if (value.media.availability === "available")
      assetReferences(
        value.media.sets,
        add,
        gaps,
        rejectedManifestDigests(value),
      );
    else
      gaps.push({
        path: `${path}/media`,
        availability: "unavailable",
        required: false,
        reason:
          "Rejected media was not collected; member bytes have no authenticated portable references",
      });
    return value;
  };
  const validation = (evidence: ValidationEvidence | undefined) => {
    if (!evidence) return;
    git(evidence.treeSha, "tree", "validation-candidate");
    for (const ref of evidence.nativeReturns ?? []) add(ref);
    for (const artifact of evidence.reviewArtifacts ?? []) {
      add(artifact.receipt.ref);
      add(artifact.image.ref);
    }
  };
  const result = (entry: ExecutionResult | undefined) => {
    if (!entry) return;
    git(entry.changeRef, "commit", "returned-result");
    git(entry.treeSha, "tree", "returned-result-tree");
    assets(entry.assets);
    discovery(entry.discoveryOutput);
    for (const source of entry.handoff?.sources ?? []) add(source.ref);
  };
  const request = (entry: ExecutionRequest | undefined) => {
    if (!entry) return;
    git(entry.baseSha, "commit", "execution-input");
    git(entry.retainedFailedResult?.commitSha, "commit", "failed-result-input");
    git(
      entry.retainedFailedResult?.treeSha,
      "tree",
      "failed-result-input-tree",
    );
    git(
      entry.environmentReadiness?.acceptedBaseSha,
      "commit",
      "readiness-base",
    );
    for (const asset of entry.sourceAssets ?? []) add(asset.ref);
    for (const asset of entry.selectedAssets ?? []) add(asset.ref);
    for (const member of entry.environmentReadiness?.lfsMembers ?? [])
      add({
        digest: member.digest,
        bytes: member.bytes,
        mediaType: member.mediaType,
      });
    discovery(entry.discovery?.manifest);
  };
  const work = (entry: Omit<WorkState, "recovery"> | WorkState) => {
    for (const [role, sha] of [
      ["execution-base", entry.executionBaseSha],
      ["observed-integration", entry.integratedShaAtStart],
      ["result-base", entry.baseSha],
      ["result", entry.changeRef],
      ["delivered-head", entry.deliveredHead],
      ["requested-branch-update", entry.branchUpdateFrom],
      ["integration", entry.integratedSha],
    ] as const)
      git(sha, "commit", role);
    for (const sha of entry.replacedHeads ?? [])
      git(sha, "commit", "replaced-head");
    git(entry.treeSha, "tree", "result-tree");
    assets(entry.assets);
    discovery(entry.discoveryOutput);
    validation(entry.validation);
    if (entry.failedValidation) {
      git(
        entry.failedValidation.acceptedBaseSha,
        "commit",
        "failed-accepted-base",
      );
      git(
        entry.failedValidation.executionBaseSha,
        "commit",
        "failed-execution-base",
      );
      git(entry.failedValidation.resultBaseSha, "commit", "failed-result-base");
      git(
        entry.failedValidation.evidence.treeSha,
        "tree",
        "failed-validation-tree",
      );
    }
    if (entry.knowledge) {
      add(entry.knowledge.recordRef);
      for (const source of entry.knowledge.sources) add(source.ref);
      git(entry.knowledge.commitSha, "commit", "knowledge-source");
      git(entry.knowledge.treeSha, "tree", "knowledge-source-tree");
    }
    if (entry.execution) {
      if (
        !["local", "openai-agents", "claude-managed-agents"].includes(
          entry.execution.provider,
        )
      )
        gaps.push({
          path: `execution/${entry.execution.identity}`,
          availability: "unavailable",
          reason:
            "Opaque execution adapter has no authenticated portable payload contract",
        });
      else {
        const active = object(entry.execution.data);
        const admitted = active.request as ExecutionRequest | undefined;
        request(admitted);
        result(active.result as ExecutionResult | undefined);
        const rejected = rejectedCollection(
          active.rejectedCollection,
          admitted,
          entry.execution.identity,
        );
        const excludedManifestDigests = rejectedManifestDigests(rejected);
        assetReferences(
          active.collectedAssets as CapturedAssetSet[] | undefined,
          add,
          gaps,
          excludedManifestDigests,
        );
        if (active.assetManifest !== undefined) {
          const manifest = object(active.assetManifest);
          if (
            manifest.path !== ".factory-assets.json" ||
            object(manifest.ref).mediaType !== "application/json"
          )
            throw new Error(
              "Retained asset manifest has an invalid declaration path",
            );
          const ref = manifest.ref as ContentRef;
          assertRef(ref);
          if (!excludedManifestDigests.has(ref.digest)) add(ref);
        }
        const prepared = active.preparedHarnessRequest as
          | HarnessRequest
          | undefined;
        for (const asset of prepared?.sourceAssets ?? []) add(asset.ref);
        for (const asset of prepared?.selectedAssets ?? []) add(asset.ref);
        discovery(prepared?.discovery?.manifest);
        for (const entry of prepared?.discovery?.body.entries ?? [])
          add(entry.content);
      }
    }
    const diagnosis = (
      value: import("./repair-policy.js").WorkRecovery["diagnosisInvocation"],
    ) => {
      for (const ref of value?.nativeReturns ?? []) add(ref);
      for (const rejected of value?.rejected ?? [])
        for (const ref of rejected.nativeReturns ?? []) add(ref);
    };
    if ("recovery" in entry) {
      diagnosis(entry.recovery?.diagnosisInvocation);
      for (const prior of entry.recovery?.history ?? []) {
        diagnosis(prior.diagnosisInvocation);
        work(prior.work);
      }
    }
  };
  git(state.baseSha, "commit", "objective-base");
  recipe(state.workflowRecipePin);
  add(state.planningRecovery?.contextLookup?.packetRef);
  for (const receipt of [
    ...(state.planningRecovery?.invocations ?? []),
    ...(state.planningRecovery?.history ?? []).flatMap(
      (entry) => entry.invocations,
    ),
  ])
    for (const ref of receipt.nativeReturns ?? []) add(ref);
  for (const binding of state.memoryBindings ?? []) {
    add(binding.manifestRef);
    roots.push({ ref: binding.manifestRef, kind: "memory", binding });
  }
  if (isPreparationState(state)) {
    git(state.plan?.baseSha, "commit", "planned-base");
    recipe(state.plan?.workflowRecipe?.pin);
    for (const predecessor of state.plan?.prerequisites?.predecessors ?? []) {
      git(predecessor.acceptance.commit, "commit", "prerequisite-result");
      git(predecessor.acceptance.tree, "tree", "prerequisite-tree");
    }
  } else {
    recipe(state.workflowRecipeAdmission?.workflowRecipePin);
    git(state.integratedSha, "commit", "objective-integration");
    git(state.finalAcceptance?.commit, "commit", "accepted-result");
    git(state.finalAcceptance?.tree, "tree", "accepted-tree");
    accountingReferences(state.finalAcceptance?.usage, add, roots);
    git(state.finalHead?.integratedSha, "commit", "final-integrated-base");
    git(state.finalHead?.asked, "commit", "pending-final-head");
    for (const sha of state.finalHead?.heads ?? [])
      git(sha, "commit", "final-head");
    validation(state.finalValidation);
    for (const predecessor of state.prerequisites?.predecessors ?? []) {
      git(predecessor.acceptance.commit, "commit", "prerequisite-result");
      git(predecessor.acceptance.tree, "tree", "prerequisite-tree");
    }
    for (const entry of Object.values(state.work)) work(entry);
    for (const original of [
      ...(state.pendingAmendment ? [state.pendingAmendment] : []),
      ...(state.rejectedAmendments ?? []),
      ...(state.graphRevisions ?? []),
    ])
      for (const ref of [
        ...(original.planningInvocation?.nativeReturns ?? []),
        ...(original.reviewInvocation?.nativeReturns ?? []),
        ...(original.reviewRejectedNativeReturns ?? []),
      ])
        add(ref);
    for (const packet of Object.values(state.adaptiveContexts ?? {})) {
      add(packet.contentRef);
      git(packet.binding.baseSha, "commit", "context-base");
      for (const selection of packet.selections)
        for (const ref of selection.refs) add(ref);
    }
    for (const expansion of [
      ...(state.pendingExpansion ? [state.pendingExpansion] : []),
      ...(state.expansionHistory ?? []),
      ...(state.graphRevisions ?? []).flatMap((revision) =>
        revision.expansion ? [revision.expansion] : [],
      ),
    ]) {
      add(expansion.inputPacketRef);
      roots.push({ ref: expansion.inputPacketRef, kind: "expansion" });
    }
    for (const condition of Object.values(state.conditionFacts ?? {})) {
      add(condition.inputPacketRef);
      discovery(condition.inputPacket.manifest);
      for (const entry of condition.inputPacket.body.entries)
        add(entry.content);
      git(condition.inputPacket.sourceCommitSha, "commit", "condition-source");
    }
    for (const record of state.workflowReflection?.records ?? []) {
      add(record.bodyRef);
      git(record.binding.baseSha, "commit", "reflection-base");
    }
    for (const stack of Object.values(state.stackNumbers ?? {}))
      if (typeof stack !== "number")
        for (const layer of stack.request.layers)
          git(layer.headSha, "commit", "native-stack-publication");
    for (const merge of Object.values(state.stackMerges ?? {})) {
      git(merge.expectedHeadSha, "commit", "native-stack-merge-head");
      for (const layer of merge.request?.layers ?? [])
        git(layer.headSha, "commit", "native-stack-merge-layer");
    }
    for (const intents of Object.values(state.publicationIntents ?? {}))
      for (const intent of intents) {
        git(intent.headSha, "commit", "publication-result");
        git(intent.treeSha, "tree", "publication-tree");
      }
  }
  return {
    contentRefs: [...refs.values()],
    gitObjects: [...objects.values()],
    gaps,
    roots,
  };
}

/** Schema-checked portable references, also used by original learning snapshots. */
export function describeContinuationReferences(
  value: unknown,
): ContinuationReferences {
  const { roots: _roots, ...description } = continuationReferences(value);
  return description;
}

/** A verified archive cache can supply bytes before any installation writes. */
export interface RecoveryReferenceReader {
  readBytes(ref: ContentRef): Uint8Array | Promise<Uint8Array>;
}
async function readReference(
  source: ContentStore | RecoveryReferenceReader,
  ref: ContentRef,
): Promise<Uint8Array> {
  assertRef(ref);
  let bytes: Uint8Array;
  if ("readBytes" in source) bytes = await source.readBytes(ref);
  else {
    await source.verify(ref);
    bytes = new Uint8Array(
      await new Response(await source.open(ref)).arrayBuffer(),
    );
  }
  if (
    bytes.length !== ref.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== ref.digest
  )
    throw new Error("Recovery reference differs from its exact original bytes");
  return bytes;
}

/** Only known producer roles admit typed references from observation JSON. */
function memoryReferences(
  role: string,
  bytes: Uint8Array,
): ContinuationReferences & { roots: BodyRoot[] } {
  if (
    ![
      "attempt-observation",
      "objective-observation",
      "handoff",
      "original-snapshot",
      "discovery-manifest",
    ].includes(role)
  )
    return { contentRefs: [], gitObjects: [], gaps: [], roots: [] };
  const value = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (role === "original-snapshot") return continuationReferences(value);
  const refs = new Map<string, ContentRef>();
  const gitObjects: RecoveryGitObject[] = [];
  const roots: BodyRoot[] = [];
  const gaps: RecoveryClosureGap[] = [];
  const add = (ref: ContentRef | undefined) => {
    if (!ref) return;
    assertRef(ref);
    refs.set(refKey(ref), structuredClone(ref));
  };
  const git = (sha: unknown, kind: RecoveryGitObject["kind"], role: string) => {
    if (sha === undefined || sha === null) return;
    if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/.test(sha))
      throw new Error("Invalid observation Git identity");
    gitObjects.push({ sha, kind, role });
  };
  const validation = (entry: unknown) => {
    if (entry === undefined) return;
    const evidence = object(entry) as unknown as ValidationEvidence;
    git(evidence.treeSha, "tree", "memory-validation");
    for (const ref of evidence.nativeReturns ?? []) add(ref);
    for (const artifact of evidence.reviewArtifacts ?? []) {
      add(artifact.receipt.ref);
      add(artifact.image.ref);
    }
  };
  if (role === "attempt-observation") {
    git(value.executionBaseSha, "commit", "memory-execution-base");
    git(value.changeRef, "commit", "memory-result");
    git(value.treeSha, "tree", "memory-result-tree");
    validation(value.validation);
    if (value.failedValidation !== undefined) {
      const failed = object(value.failedValidation);
      for (const key of [
        "acceptedBaseSha",
        "executionBaseSha",
        "resultBaseSha",
      ])
        git(failed[key], "commit", "memory-failed-base");
      validation(failed.evidence);
    }
    assetReferences(value.assets as CapturedAssetSet[] | undefined, add, gaps);
  } else if (role === "objective-observation") {
    if (value.planningRecovery !== undefined) {
      const recovery = object(value.planningRecovery);
      if (recovery.contextLookup !== undefined)
        add(object(recovery.contextLookup).packetRef as ContentRef);
      for (const receipt of [
        ...((recovery.invocations as
          | { nativeReturns?: ContentRef[] }[]
          | undefined) ?? []),
        ...(
          (recovery.history as
            | { invocations: { nativeReturns?: ContentRef[] }[] }[]
            | undefined) ?? []
        ).flatMap((entry) => entry.invocations),
      ])
        for (const ref of receipt.nativeReturns ?? []) add(ref);
    }
    if (value.acceptance !== undefined) {
      const acceptance = object(value.acceptance);
      git(acceptance.commit, "commit", "memory-acceptance");
      git(acceptance.tree, "tree", "memory-acceptance-tree");
      accountingReferences(acceptance.usage, add, roots);
    }
  } else if (role === "handoff") {
    add(value.recordRef as ContentRef | undefined);
    for (const source of (value.sources as
      | { ref?: ContentRef }[]
      | undefined) ?? [])
      add(source.ref);
  } else if (role === "discovery-manifest") {
    assertDiscoveryOutputManifest(value);
    add(value.body);
    roots.push({ ref: value.body, kind: "discovery" });
    git(value.source.commitSha, "commit", "memory-discovery-source");
    git(value.source.treeSha, "tree", "memory-discovery-tree");
  }
  return { contentRefs: [...refs.values()], gitObjects, gaps, roots };
}
export function describeMemoryBodyReferences(
  role: string,
  bytes: Uint8Array,
): ContinuationReferences {
  const { roots: _roots, ...description } = memoryReferences(role, bytes);
  return description;
}
async function verifyDescription(
  description: ContinuationReferences & { roots: BodyRoot[] },
  source: ContentStore | RecoveryReferenceReader,
  bounds: { maxBytes: number; maxFiles: number } = {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxFiles: Number.MAX_SAFE_INTEGER,
  },
): Promise<ContinuationReferences> {
  const refs = new Map(
    description.contentRefs.map((ref) => [refKey(ref), ref]),
  );
  const objects = new Map(
    description.gitObjects.map((entry) => [
      `${entry.kind}:${entry.sha}`,
      entry,
    ]),
  );
  const gaps = [...description.gaps];
  const roots = [...description.roots];
  const visited = new Set<string>();
  const add = (ref: ContentRef) => {
    assertRef(ref);
    refs.set(refKey(ref), structuredClone(ref));
  };
  const merge = (entry: ContinuationReferences & { roots: BodyRoot[] }) => {
    for (const ref of entry.contentRefs) add(ref);
    for (const item of entry.gitObjects)
      objects.set(`${item.kind}:${item.sha}`, item);
    gaps.push(...entry.gaps);
    roots.push(...entry.roots);
  };
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index]!;
    const key =
      root.kind === "accounting"
        ? `accounting:${root.accounting!.digest}`
        : `${root.kind}:${refKey(root.ref)}:${JSON.stringify(root.identity ?? null)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const bytes = await readReference(source, root.ref);
    if (root.kind === "restoration-original") {
      const value = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const identity = root.identity!;
      if (
        value.repository !== identity.repository ||
        (identity.objective !== undefined &&
          value.objective !== identity.objective) ||
        (identity.runId !== undefined && value.runId !== identity.runId) ||
        (identity.configDigest !== undefined &&
          value.configDigest !== identity.configDigest) ||
        (identity.schemaVersion !== undefined &&
          value.schemaVersion !== identity.schemaVersion)
      )
        throw new Error(
          "Restoration original snapshot differs from its immutable identity",
        );
      merge(continuationReferences(value));
    } else if (root.kind === "restoration-archive") {
      const value = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const binding =
        value.binding as import("./recovery-checkpoint.js").RecoveryCheckpointBinding;
      assertRecoveryCheckpointManifest(value, binding, {
        maxBytes: bounds.maxBytes,
        maxFiles: bounds.maxFiles,
      });
      if (value.binding.repository !== root.identity!.repository)
        throw new Error(
          "Restoration archive repository differs from its continuation",
        );
      for (const ref of value.contentRefs) add(ref);
      for (const file of value.files) {
        add(file.ref);
        if (file.kind === "continuation") {
          const match = /^objectives\/([1-9][0-9]*)\/state\.json$/.exec(
            file.path,
          );
          if (!match)
            throw new Error("Restoration archive continuation path is invalid");
          roots.push({
            ref: file.ref,
            kind: "restoration-original",
            identity: {
              repository: binding.repository,
              objective: Number(match[1]),
            },
          });
        }
      }
      for (const entry of value.gitObjects ?? [])
        objects.set(`commit:${entry.commitSha}`, {
          sha: entry.commitSha,
          kind: "commit",
          role: entry.role,
        });
      gaps.push(...(value.gaps as RecoveryClosureGap[]));
    } else if (root.kind === "accounting") {
      const seal = root.accounting!;
      await assertAccountingSealContent(
        seal.repository,
        seal.objective,
        seal.runId,
        seal,
        (ref) => readReference(source, ref),
      );
      for (const ref of seal.records) {
        const record = decodeAccountingRecord(
          seal.repository,
          `accounting/${ref.digest}.json`,
          await readReference(source, ref),
        );
        if (record.kind === "interaction") {
          const payload = record.capture.content.reference?.payload;
          if (payload) add(payload);
        }
      }
    } else if (root.kind === "discovery")
      for (const entry of parseDiscoveryBody(bytes).entries) add(entry.content);
    else if (root.kind === "memory") {
      const record = decodeRepositoryMemoryManifest(root.binding!, bytes);
      for (const body of record.bodies)
        if (body.ref) {
          add(body.ref);
          merge(
            memoryReferences(body.role, await readReference(source, body.ref)),
          );
        }
      for (const entry of record.sources) if (entry.ref) add(entry.ref);
    } else {
      const packet = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        packet.schemaVersion !== 1 ||
        packet.iteration !== 1 ||
        Object.keys(packet).sort().join() !==
          "batches,body,envelope,iteration,manifest,parentGraphDigest,runId,schemaVersion"
      )
        throw new Error("Recovery expansion input has an unsupported schema");
      const manifest = packet.manifest as DiscoveryOutputManifest;
      assertDiscoveryOutputManifest(manifest);
      add(manifest.body);
      roots.push({ ref: manifest.body, kind: "discovery" });
      for (const entry of parseDiscoveryBody(
        Buffer.from(JSON.stringify(packet.body)),
      ).entries)
        add(entry.content);
      objects.set(`commit:${manifest.source.commitSha}`, {
        sha: manifest.source.commitSha,
        kind: "commit",
        role: "expansion-source",
      });
      objects.set(`tree:${manifest.source.treeSha}`, {
        sha: manifest.source.treeSha,
        kind: "tree",
        role: "expansion-source-tree",
      });
    }
  }
  for (const ref of refs.values()) await readReference(source, ref);
  return {
    contentRefs: [...refs.values()],
    gitObjects: [...objects.values()],
    gaps,
  };
}
/** Open only declared nested schemas; digest-looking opaque evidence never supplies reads. */
export async function verifyContinuationReferenceClosure(
  value: unknown,
  source: ContentStore | RecoveryReferenceReader,
  bounds?: { maxBytes: number; maxFiles: number },
): Promise<ContinuationReferences> {
  return verifyDescription(continuationReferences(value), source, bounds);
}
export async function verifyMemoryBodyReferenceClosure(
  role: string,
  bytes: Uint8Array,
  source: ContentStore | RecoveryReferenceReader,
): Promise<ContinuationReferences> {
  return verifyDescription(memoryReferences(role, bytes), source);
}

function privateBytes(path: string, root: string): Buffer {
  const bound = relative(resolve(root), resolve(path));
  if (
    !bound ||
    bound.startsWith(`..${sep}`) ||
    bound === ".." ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error("Recovery checkpoint original is outside its private root");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error(
      "Recovery checkpoint original must be an owned private regular file",
    );
  return readFileSync(path);
}
async function retainBytes(
  store: LocalContentStore,
  bytes: Uint8Array,
  mediaType = "application/json",
): Promise<ContentRef> {
  return store.putBytes(bytes, { mediaType });
}

/** Capture only authenticated original roots; installations, owners and native homes are excluded. */
export async function buildRecoveryCheckpointClosure(input: {
  config: FactoryConfig;
  scope?: "private-history" | "repository-knowledge";
  store?: ContentStore;
}): Promise<RecoveryCheckpointClosure> {
  const { config } = input;
  const scope =
    input.scope ?? config.gitPersistence?.scope ?? "private-history";
  const root = stateRoot(config.repository);
  const store = new LocalContentStore(join(root, "content"));
  const reader: RecoveryReferenceReader = {
    readBytes: async (ref) => {
      try {
        return await readReference(store, ref);
      } catch (error) {
        if (!input.store) throw error;
        return readReference(input.store, ref);
      }
    },
  };
  const files: RecoveryCheckpointFile[] = [];
  const refs = new Map<string, ContentRef>();
  const objects = new Map<string, RecoveryGitObject>();
  const gaps: RecoveryClosureGap[] = [];
  const include = async (
    path: string,
    kind: RecoveryCheckpointFile["kind"],
    bytes: Uint8Array,
  ) => {
    const ref = await retainBytes(store, bytes);
    files.push({ kind, path, ref, visibility: "private" });
    refs.set(refKey(ref), ref);
  };
  const { buildMemoryLearningClosure } = await import(
    "./repository-memory-transfer.js"
  );
  const memory = await buildMemoryLearningClosure({
    repository: config.repository,
    access: {
      repository: config.repository,
      visibility:
        scope === "private-history"
          ? ["private", "repository"]
          : ["repository"],
    },
    learning: { includeUnapproved: true },
  });
  files.push(...memory.files);
  for (const ref of memory.contentRefs) refs.set(refKey(ref), ref);
  gaps.push(...(memory.gaps as RecoveryClosureGap[]));
  if (scope === "private-history") {
    const { accountingPersistenceClosure } = await import("./accounting.js");
    const accounting = accountingPersistenceClosure(config.repository);
    files.push(...accounting.files);
    for (const ref of accounting.contentRefs) refs.set(refKey(ref), ref);
    gaps.push(...(accounting.gaps as RecoveryClosureGap[]));
    for (const entry of memory.typedGitObjects ?? [])
      objects.set(`${entry.kind}:${entry.sha}`, entry);
    for (const entry of memory.gitObjects ?? [])
      objects.set(`commit:${entry.commitSha}`, {
        sha: entry.commitSha,
        kind: "commit",
        role: entry.role,
      });
    const { proposalPersistenceClosure } = await import("./proposals.js");
    const proposals = proposalPersistenceClosure(config, root);
    files.push(...proposals.files);
    for (const ref of proposals.contentRefs) refs.set(refKey(ref), ref);
    gaps.push(...(proposals.gaps as RecoveryClosureGap[]));
    const { projectQueuePersistenceClosure } = await import(
      "./project-queue-state.js"
    );
    const queueHistory = projectQueuePersistenceClosure(config, root);
    files.push(...queueHistory.files);
    for (const ref of queueHistory.contentRefs) refs.set(refKey(ref), ref);
    gaps.push(...(queueHistory.gaps as RecoveryClosureGap[]));
    for (const entry of proposals.gitObjects ?? [])
      objects.set(`commit:${entry.commitSha}`, {
        sha: entry.commitSha,
        kind: "commit",
        role: entry.role,
      });
    const objectiveDirectory = join(root, "objectives");
    for (const id of existsSync(objectiveDirectory)
      ? readdirSync(objectiveDirectory)
          .filter((name) => /^\d+$/.test(name))
          .sort()
      : []) {
      for (const name of ["state.json", "pre-state.json"] as const) {
        const path = join(objectiveDirectory, id, name);
        if (!existsSync(path)) continue;
        const bytes = privateBytes(path, root);
        if (name === "state.json") {
          const state = parsePortableContinuation(
            JSON.parse(bytes.toString("utf8")),
            config.repository,
            Number(id),
          );
          const description = await verifyContinuationReferenceClosure(
            state,
            reader,
            config.gitPersistence,
          );
          for (const ref of description.contentRefs) refs.set(refKey(ref), ref);
          for (const entry of description.gitObjects)
            objects.set(`${entry.kind}:${entry.sha}`, entry);
          gaps.push(...description.gaps);
          if (input.store)
            for (const ref of description.contentRefs)
              await retainBytes(
                store,
                await readReference(reader, ref),
                ref.mediaType,
              );
          if (!isPreparationState(state)) {
            for (const work of Object.values(state.work).flatMap((work) => [
              work,
              ...(work.recovery?.history ?? []).map((entry) => entry.work),
            ])) {
              if (
                !work.execution ||
                !["local", "openai-agents", "claude-managed-agents"].includes(
                  work.execution.provider,
                )
              )
                continue;
              const active = object(work.execution.data);
              let rejected: RejectedCollectionReceipt | undefined;
              if (active.rejectedCollection !== undefined) {
                const request = active.request as ExecutionRequest;
                assertRejectedCollectionReceipt(
                  active.rejectedCollection,
                  request,
                  work.execution.identity,
                );
                rejected = active.rejectedCollection;
                await authenticateRejectedCollectionReceipt(
                  rejected,
                  request,
                  work.execution.identity,
                  config.checkout,
                  store,
                );
              }
              // A returned result is evidence, not a restored native process.
              if (work.execution.provider === "local") {
                const handle = active.handle
                  ? object(active.handle)
                  : undefined;
                const worker = handle?.data ? object(handle.data) : undefined;
                const resultPath = worker?.resultPath;
                if (typeof resultPath === "string" && existsSync(resultPath)) {
                  if (
                    !resolve(resultPath).startsWith(
                      `${join(root, "harness")}${sep}`,
                    ) ||
                    !resultPath.endsWith(".result.json")
                  )
                    throw new Error(
                      "Returned worker evidence is outside its authenticated root",
                    );
                  const returnedBytes = privateBytes(resultPath, root);
                  if (
                    rejected &&
                    (rejected.rawReturn.provenance !==
                      "controller-worker-result" ||
                      rejected.rawReturn.identity !== work.execution.identity ||
                      rejected.rawReturn.digest !==
                        createHash("sha256")
                          .update(returnedBytes)
                          .digest("hex") ||
                      rejected.rawReturn.bytes !== returnedBytes.length)
                  )
                    throw new Error(
                      "Rejected collection differs from its original returned worker bytes",
                    );
                  if (
                    !rejected ||
                    rejected.rawReturn.availability === "available"
                  )
                    await include(
                      relative(root, resultPath),
                      "historical",
                      returnedBytes,
                    );
                  const returned = object(
                    JSON.parse(returnedBytes.toString("utf8")),
                  );
                  if (
                    returned.state === "complete" &&
                    active.result === undefined &&
                    rejected === undefined
                  )
                    gaps.push({
                      path: relative(root, resultPath),
                      availability: "unavailable",
                      reason:
                        "Authenticated completed worker output has not been frozen by its existing collector; source changes and staged bodies remain in the preserved owned checkout",
                    });
                }
              } else if (typeof active.root === "string") {
                if (
                  !resolve(active.root).startsWith(
                    `${join(root, "managed")}${sep}`,
                  )
                )
                  throw new Error(
                    "Managed evidence is outside its authenticated root",
                  );
                const returned =
                  work.execution.provider === "openai-agents"
                    ? "result.tar"
                    : "result.json";
                const resultPath = join(active.root, returned);
                if (existsSync(resultPath)) {
                  const bytes = privateBytes(resultPath, root);
                  const artifact = active.artifact
                    ? object(active.artifact)
                    : undefined;
                  const digest = createHash("sha256")
                    .update(bytes)
                    .digest("hex");
                  if (
                    !artifact ||
                    artifact.bytes !== bytes.length ||
                    (artifact.digest ?? artifact.sha256) !== digest
                  )
                    throw new Error(
                      "Returned provider evidence differs from its recorded artifact",
                    );
                  if (
                    rejected &&
                    (rejected.rawReturn.provenance !==
                      "managed-original-artifact" ||
                      rejected.rawReturn.digest !== digest ||
                      rejected.rawReturn.bytes !== bytes.length)
                  )
                    throw new Error(
                      "Rejected collection differs from its original provider artifact",
                    );
                  if (rejected?.rawReturn.availability === "unavailable")
                    continue;
                  const ref = await retainBytes(
                    store,
                    bytes,
                    returned.endsWith(".tar")
                      ? "application/x-tar"
                      : "application/json",
                  );
                  files.push({
                    kind: "historical",
                    path: relative(root, resultPath),
                    ref,
                    visibility: "private",
                  });
                  refs.set(refKey(ref), ref);
                }
              }
            }
          }
        } else {
          const pre = object(JSON.parse(bytes.toString("utf8")));
          const { assertRepeats, assertWait } = await import("./fault.js");
          if (
            Object.keys(pre).some((key) => key !== "repeats" && key !== "wait")
          )
            throw new Error(
              "Unsupported pre-state fields in recovery checkpoint",
            );
          assertRepeats(pre.repeats, "repeats");
          assertWait(pre.wait, "wait");
        }
        await include(
          `objectives/${id}/${name}`,
          name === "state.json" ? "continuation" : "pre-state",
          bytes,
        );
      }
    }
  }
  if (objects.size) {
    const roots = [...objects.values()].sort((left, right) =>
      left.sha.localeCompare(right.sha),
    );
    const inventory = await subprocessAsync(
      "git",
      [
        "-C",
        config.checkout,
        "cat-file",
        "--batch-check=%(objectname) %(objecttype)",
      ],
      { env: pinnedGitEnvironment() },
      `${roots.map((entry) => entry.sha).join("\n")}\n`,
    );
    if (
      inventory.status !== 0 ||
      inventory.stdout !==
        `${roots.map((entry) => `${entry.sha} ${entry.kind}`).join("\n")}\n`
    )
      throw new Error(
        "Required recovery Git object is missing or has another type",
      );
    // Git finalizes its pack from the repository object directory by rename.
    // Keep our owned output on that filesystem, including linked worktrees.
    const objectDirectory = realpathSync(
      pinnedGit(
        config.checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ),
    );
    if (!lstatSync(objectDirectory).isDirectory())
      throw new Error("Recovery Git object storage is not a directory");
    const identity = createHash("sha256").update(JSON.stringify(roots));
    const inspect = (path: string, relativePath = "") => {
      assertProcessActive();
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink())
        throw new Error("Recovery Git object cache contains a symlink");
      identity.update(
        JSON.stringify([
          relativePath,
          stat.dev.toString(),
          stat.ino.toString(),
          stat.mode.toString(),
          ...(stat.isFile()
            ? [
                stat.size.toString(),
                stat.mtimeNs.toString(),
                stat.ctimeNs.toString(),
              ]
            : []),
        ]),
      );
      if (stat.isDirectory())
        for (const name of readdirSync(path).sort())
          inspect(join(path, name), `${relativePath}/${name}`);
      else if (!stat.isFile())
        throw new Error(
          "Recovery Git object cache contains an unsupported entry",
        );
    };
    inspect(objectDirectory);
    const key = identity.digest("hex");
    let ref = cachedRecoveryCheckpointGitPack(key);
    if (ref) await readReference(reader, ref);
    else {
      const temporary = mkdtempSync(
        join(objectDirectory, "factory-checkpoint-objects-"),
      );
      try {
        const packed = await subprocessAsync(
          "git",
          [
            "-C",
            config.checkout,
            "pack-objects",
            "--revs",
            "--threads=1",
            join(temporary, "objects"),
          ],
          { env: pinnedGitEnvironment() },
          `${roots.map((entry) => entry.sha).join("\n")}\n`,
        );
        if (
          packed.status !== 0 ||
          !/^[a-f0-9]{40,64}$/.test(packed.stdout.trim())
        )
          throw new Error("Required recovery Git objects could not be packed");
        const packPath = join(
          temporary,
          `objects-${packed.stdout.trim()}.pack`,
        );
        ref = await retainBytes(
          store,
          readFileSync(packPath),
          "application/x-git-packed-objects",
        );
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      retainRecoveryCheckpointGitPack(key, ref!);
    }
    refs.set(refKey(ref!), ref!);
    files.push({
      kind: "git-pack",
      path: `git/objects-${ref!.digest}.pack`,
      ref: ref!,
      visibility: scope === "private-history" ? "private" : "repository",
    });
  }
  for (const ref of refs.values()) {
    const bytes = await readReference(reader, ref);
    await retainBytes(store, bytes, ref.mediaType);
  }
  return {
    files,
    contentRefs: [...refs.values()],
    gitObjects: [...objects.values()]
      .filter((entry) => entry.kind === "commit")
      .map((entry) => ({ commitSha: entry.sha, role: entry.role })),
    gaps,
  };
}
