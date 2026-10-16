import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AccountingSeal,
  assertAccountingSealBinding,
  assertAccountingSealContent,
} from "./accounting.js";
import {
  assertAgentSessionRef,
  assertAgentSessionScope,
} from "./agent-session.js";
import type { FactoryConfig } from "./config.js";
import {
  ARCHIVED_EVIDENCE,
  type RetirementRecord,
  retiredEvidence,
  stateDigest,
} from "./checkpoint-retention.js";
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
  retainedFailedResultBriefs,
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
  acknowledgedArchiveCommit,
  assertRecoveryCheckpointManifest,
  cachedRecoveryCheckpointGitPack,
  recoveryCheckpointGitPackObservation,
  retainRecoveryCheckpointGitPack,
  withRecoveryCheckpointClosureReads,
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
  availability: "missing-legacy" | "unavailable" | "transient" | "archived";
  reason: string;
  required?: boolean;
  /** For an `archived` gap: the commit that holds the complete evidence. */
  evidenceCommit?: string;
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
      if ("text" in artifact) {
        for (const body of artifact.text.bodies) add(body.ref);
        continue;
      }
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
    git(
      entry.discoveryDecline?.resultCommitSha,
      "commit",
      "declined-discovery-result",
    );
    git(
      entry.discoveryDecline?.resultTreeSha,
      "tree",
      "declined-discovery-result-tree",
    );
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
        // A planner question's compilation keeps its originals (#1296).
        ...("decisions" in original
          ? (original.decisions ?? []).flatMap(
              (entry) => entry.invocation?.nativeReturns ?? [],
            )
          : []),
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
  knownStore?: LocalContentStore,
): Promise<Uint8Array> {
  assertRef(ref);
  // The concrete store verifies its opened owned file and exact content before
  // returning bytes; repeating the same hash here adds no independent fact.
  if (
    knownStore &&
    source === knownStore &&
    Object.getPrototypeOf(source) === LocalContentStore.prototype &&
    knownStore.readBytes === LocalContentStore.prototype.readBytes
  )
    return knownStore.readBytes(ref);
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
      if ("text" in artifact) {
        for (const body of artifact.text.bodies) add(body.ref);
        continue;
      }
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
  knownStore?: LocalContentStore,
): Promise<ContinuationReferences> {
  const concrete =
    knownStore &&
    source === knownStore &&
    Object.getPrototypeOf(source) === LocalContentStore.prototype &&
    knownStore.readBytes === LocalContentStore.prototype.readBytes;
  const signature = concrete && JSON.stringify([description, bounds]);
  const cached = signature && knownStore.checkpointReferences(signature);
  if (cached) {
    for (const ref of [...cached.contentRefs, ...cached.originals])
      knownStore!.verifyPrivateBytes(ref);
    return {
      contentRefs: cached.contentRefs,
      gitObjects: cached.gitObjects,
      gaps: cached.gaps,
    };
  }
  const originals = new Map<string, ContentRef>();
  const read = (ref: ContentRef) => {
    originals.set(refKey(ref), { ...ref });
    return readReference(source, ref, knownStore);
  };
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
    const bytes = await read(root.ref);
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
      const records = await assertAccountingSealContent(
        seal.repository,
        seal.objective,
        seal.runId,
        seal,
        read,
      );
      for (const record of records) {
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
          merge(memoryReferences(body.role, await read(body.ref)));
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
  for (const ref of refs.values()) {
    originals.set(refKey(ref), { ...ref });
    if (
      knownStore &&
      source === knownStore &&
      Object.getPrototypeOf(source) === LocalContentStore.prototype &&
      knownStore.readBytes === LocalContentStore.prototype.readBytes
    )
      knownStore.verifyPrivateBytes(ref);
    else await read(ref);
  }
  const result = {
    contentRefs: [...refs.values()],
    gitObjects: [...objects.values()],
    gaps,
  };
  if (signature)
    knownStore!.retainCheckpointReferences(signature, {
      ...result,
      originals: [...originals]
        .filter(([key]) => !refs.has(key))
        .map(([, ref]) => ref),
    });
  return result;
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

/** The normal local memory producer owns this concrete store; imports stay strict. */
export async function verifyLocalMemoryBodyReferenceClosure(
  role: string,
  bytes: Uint8Array,
  store: LocalContentStore,
): Promise<ContinuationReferences> {
  return verifyDescription(
    memoryReferences(role, bytes),
    store,
    undefined,
    store,
  );
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
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const fingerprint = (value: typeof stat) =>
      [
        value.dev,
        value.ino,
        value.mode,
        value.uid,
        value.size,
        value.mtimeNs,
        value.ctimeNs,
      ].join(":");
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid!()) ||
      stat.mode & 0o077n ||
      fingerprint(stat) !== fingerprint(lstatSync(path, { bigint: true }))
    )
      throw new Error(
        "Recovery checkpoint original must be an owned private regular file",
      );
    const bytes = readFileSync(fd);
    if (
      fingerprint(stat) !== fingerprint(fstatSync(fd, { bigint: true })) ||
      fingerprint(stat) !== fingerprint(lstatSync(path, { bigint: true })) ||
      realpathSync(path) !== resolve(path)
    )
      throw new Error("Recovery checkpoint original changed during its read");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Authenticate one recorded worker return, never enumerate its native storage. */
export function localWorkerReturn(
  root: string,
  execution: NonNullable<WorkState["execution"]>,
  scope: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
  },
):
  | { path: string; bytes: Buffer; returned: Record<string, unknown> }
  | undefined {
  const active = object(execution.data);
  if (!active.handle) return undefined;
  const handle = object(active.handle);
  if (!handle.data) return undefined;
  const worker = object(handle.data);
  if (typeof worker.resultPath !== "string") return undefined;
  if (!existsSync(worker.resultPath)) return undefined;
  const identity = execution.identity;
  const workerRoot = dirname(resolve(worker.resultPath));
  const request = object(active.request) as unknown as ExecutionRequest;
  if (
    !/^[A-Za-z0-9_-]{1,160}$/.test(identity) ||
    handle.identity !== identity ||
    request.attemptId !== identity ||
    !workerRoot.startsWith(`${resolve(root)}${sep}`) ||
    worker.requestPath !== join(workerRoot, `${identity}.request.json`) ||
    worker.resultPath !== join(workerRoot, `${identity}.result.json`) ||
    worker.logPath !== join(workerRoot, `${identity}.log`) ||
    realpathSync(workerRoot) !== workerRoot
  )
    throw new Error(
      "Returned worker evidence is outside its authenticated root",
    );
  const directory = lstatSync(workerRoot);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error("Returned worker evidence root must be owned and private");
  const input = object(
    JSON.parse(
      privateBytes(worker.requestPath as string, root).toString("utf8"),
    ),
  );
  const originalRequest = object(input.request) as unknown as HarnessRequest;
  if (
    originalRequest.attemptId !== identity ||
    originalRequest.worktree !== active.worktree ||
    // The local driver appends retained failed-result context to the brief.
    !retainedFailedResultBriefs(request.retainedFailedResult).some(
      (suffix) => originalRequest.item?.brief === request.item.brief + suffix,
    ) ||
    !isDeepStrictEqual(
      { ...originalRequest.item, brief: request.item.brief },
      request.item,
    ) ||
    !isDeepStrictEqual(originalRequest.session, request.session)
  )
    throw new Error(
      "Returned worker original differs from its execution request",
    );
  const bytes = privateBytes(worker.resultPath, root);
  const returned = object(JSON.parse(bytes.toString("utf8")));
  const collected =
    active.result === undefined ? undefined : object(active.result);
  if (collected?.session !== undefined && returned.session === undefined)
    throw new Error("Collected worker conversation has no original return");
  if (request.session) {
    assertAgentSessionScope(request.session.scope);
    if (
      request.session.scope.repository !== scope.repository ||
      request.session.scope.objective !== scope.objective ||
      request.session.scope.runId !== scope.runId ||
      request.session.scope.configDigest !== scope.configDigest ||
      request.session.scope.role !== "implementation" ||
      request.session.scope.itemId !== request.item.id
    )
      throw new Error(
        "Returned worker session differs from its continuation scope",
      );
    if (returned.session !== undefined) {
      assertAgentSessionRef(returned.session, request.session.scope);
      if (
        returned.session.identity !== request.session.identity ||
        returned.session.executionIdentity !== identity
      )
        throw new Error(
          "Returned worker conversation differs from its execution owner",
        );
      const admitted = object(input.session);
      assertAgentSessionRef(admitted.ref, request.session.scope);
      if (
        admitted.ref.identity !== returned.session.identity ||
        admitted.ref.executionIdentity !== identity ||
        admitted.ref.adapter !== returned.session.adapter ||
        admitted.ref.turn !== returned.session.turn ||
        admitted.ref.currentTurn?.requestDigest !==
          returned.session.currentTurn?.requestDigest
      )
        throw new Error(
          "Returned worker conversation differs from its original admission",
        );
      const native =
        returned.session.data === undefined
          ? undefined
          : object(returned.session.data);
      const admittedData =
        admitted.ref.data === undefined ? undefined : object(admitted.ref.data);
      if (
        typeof native?.selectionDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(native.selectionDigest) ||
        native.selectionDigest !== admittedData?.selectionDigest ||
        (admitted.data !== undefined &&
          native.selectionDigest !== object(admitted.data).selectionDigest)
      )
        throw new Error(
          "Returned worker selection differs from its original admission",
        );
      if (
        native?.root !== undefined &&
        (native.root !==
          join(workerRoot, "sessions", request.session.identity) ||
          native.root !== admittedData?.root)
      )
        throw new Error(
          "Returned worker native storage differs from its private root",
        );
      if (collected && collected.session !== undefined) {
        assertAgentSessionRef(collected.session, request.session.scope);
        const original = returned.session;
        const frozen = collected.session;
        if (
          frozen.identity !== original.identity ||
          frozen.executionIdentity !== identity ||
          frozen.adapter !== original.adapter ||
          frozen.turn !== original.turn ||
          frozen.currentTurn?.requestDigest !==
            original.currentTurn?.requestDigest
        )
          throw new Error(
            "Collected worker conversation differs from its original return",
          );
        const data =
          frozen.data === undefined ? undefined : object(frozen.data);
        if (
          data?.root !== native?.root ||
          data?.selectionDigest !== native?.selectionDigest
        )
          throw new Error(
            "Collected worker native storage differs from its original return",
          );
        if (data?.worker && !isDeepStrictEqual(data.worker, worker))
          throw new Error(
            "Collected worker paths differ from their original handle",
          );
      }
    }
  } else if (returned.session !== undefined)
    throw new Error("Returned worker has an unsolicited conversation receipt");
  return { path: worker.resultPath, bytes, returned };
}
async function retainBytes(
  store: LocalContentStore,
  bytes: Uint8Array,
  mediaType = "application/json",
): Promise<ContentRef> {
  return store.putBytes(bytes, { mediaType });
}

/** Called only after every original has been authenticated by its producer. */
export function uniqueRecoveryCheckpointFiles(
  files: RecoveryCheckpointFile[],
): RecoveryCheckpointFile[] {
  const declared = new Map<string, RecoveryCheckpointFile>();
  for (const file of files) {
    const previous = declared.get(file.path);
    if (previous && !isDeepStrictEqual(previous, file))
      throw new Error(
        "Checkpoint producer has conflicting declarations for one original path",
      );
    declared.set(file.path, file);
  }
  return [...declared.values()];
}

/** Capture only authenticated original roots; installations, owners and native homes are excluded. */
export async function buildRecoveryCheckpointClosure(input: {
  config: FactoryConfig;
  scope?: "private-history" | "repository-knowledge";
  store?: ContentStore;
}): Promise<RecoveryCheckpointClosure> {
  return withRecoveryCheckpointClosureReads(
    input.config,
    () => buildRecoveryCheckpointClosureLocal(input),
    !input.store,
  );
}

async function buildRecoveryCheckpointClosureLocal(input: {
  config: FactoryConfig;
  scope?: "private-history" | "repository-knowledge";
  store?: ContentStore;
}): Promise<RecoveryCheckpointClosure> {
  const { config } = input;
  const scope =
    input.scope ?? config.gitPersistence?.scope ?? "private-history";
  const root = stateRoot(config.repository);
  const store = new LocalContentStore(join(root, "content"));
  const reader: LocalContentStore | RecoveryReferenceReader = input.store
    ? {
        readBytes: async (ref) => {
          try {
            return await readReference(store, ref, store);
          } catch (error) {
            if (!input.store) throw error;
            return readReference(input.store, ref);
          }
        },
      }
    : store;
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
    // Terminal Objectives whose complete evidence an acknowledged checkpoint
    // already holds keep only their snapshot here (#1307).
    const objectiveDirectory = join(root, "objectives");
    const objectiveIds = existsSync(objectiveDirectory)
      ? readdirSync(objectiveDirectory)
          .filter((name) => /^\d+$/.test(name))
          .sort()
      : [];
    const retired = new Map<number, RetirementRecord>();
    for (const id of objectiveIds) {
      const path = join(objectiveDirectory, id, "state.json");
      if (!existsSync(path)) continue;
      const bytes = privateBytes(path, root);
      const record = retiredEvidence(
        config.repository,
        Number(id),
        bytes,
        JSON.parse(bytes.toString("utf8")),
        (commit) => acknowledgedArchiveCommit(config, commit),
      );
      if (record) retired.set(Number(id), record);
    }
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
    for (const id of objectiveIds) {
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
          // Retire only the exact bytes the retirement check read; a snapshot
          // that changed since (for example, a retry) takes the full path.
          const retirement = retired.get(Number(id));
          if (retirement && stateDigest(bytes) !== retirement.stateDigest)
            retired.delete(Number(id));
          if (retired.has(Number(id))) {
            // A restored record keeps its receipt's original snapshot and
            // source manifest: they authenticate the snapshot itself.
            if (state.restoration)
              for (const ref of [
                state.restoration.original.snapshot,
                state.restoration.archive,
              ]) {
                store.verifyPrivateBytes(ref);
                refs.set(refKey(ref), ref);
              }
            gaps.push({
              path: `objectives/${id}/state.json`,
              availability: ARCHIVED_EVIDENCE,
              required: false,
              reason:
                "Retired terminal Objective: its complete evidence is in the archive history",
              evidenceCommit: retirement!.evidenceCommit,
            });
            await include(`objectives/${id}/${name}`, "continuation", bytes);
            continue;
          }
          const description = await verifyDescription(
            continuationReferences(state),
            reader,
            config.gitPersistence,
            input.store ? undefined : store,
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
                const original = localWorkerReturn(root, work.execution, state);
                if (original) {
                  const {
                    path: resultPath,
                    bytes: returnedBytes,
                    returned,
                  } = original;
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
                  if (
                    returned.state === "complete" &&
                    active.result === undefined &&
                    rejected === undefined
                  )
                    // Required until its collector freezes it; transient marks
                    // that publication can follow collection (#1276).
                    gaps.push({
                      path: relative(root, resultPath),
                      availability: "transient",
                      required: true,
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
    // Accounting after the snapshots: only the exact originals each retired
    // Objective's evidence commit holds leave; everything else stays live.
    const { accountingPersistenceClosure } = await import("./accounting.js");
    const accounting = accountingPersistenceClosure(
      config.repository,
      new Set([...retired.values()].flatMap((record) => record.accounting)),
    );
    files.push(...accounting.files);
    for (const ref of accounting.contentRefs) refs.set(refKey(ref), ref);
    gaps.push(...(accounting.gaps as RecoveryClosureGap[]));
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
    const material: { path: string; identity: string }[] = [];
    const inspect = (path: string, relativePath = "") => {
      assertProcessActive();
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink())
        throw new Error("Recovery Git object cache contains a symlink");
      material.push({
        path: relativePath,
        identity: JSON.stringify([
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
      });
      if (stat.isDirectory())
        for (const name of readdirSync(path).sort())
          inspect(
            join(path, name),
            relativePath ? `${relativePath}/${name}` : name,
          );
      else if (!stat.isFile())
        throw new Error(
          "Recovery Git object cache contains an unsupported entry",
        );
    };
    inspect(objectDirectory);
    const cached = cachedRecoveryCheckpointGitPack();
    let unchangedMaterial = true;
    if (cached) {
      for (const ref of cached.refs) await readReference(store, ref, store);
      const currentMaterial = new Map(
        material.map((entry) => [entry.path, entry.identity]),
      );
      for (const entry of cached.material)
        if (currentMaterial.get(entry.path) !== entry.identity)
          unchangedMaterial = false;
    }
    const currentRoots = new Set(
      roots.map((entry) => `${entry.kind}:${entry.sha}`),
    );
    // The admitted owner remembers coverage, never acceptance or live Git
    // authority. A smaller/different source scope needs a fresh full capture.
    const reusable =
      cached &&
      cached.roots.every((entry) =>
        currentRoots.has(`${entry.kind}:${entry.sha}`),
      );
    const observed = recoveryCheckpointGitPackObservation(config, () => ({
      cache: !cached
        ? "absent"
        : !reusable
          ? "scope-changed"
          : unchangedMaterial
            ? "unchanged"
            : "material-changed",
      roots: roots.length,
      baselinePacks: reusable ? cached.refs.length : 0,
    }));
    if (reusable && !unchangedMaterial) {
      // Git freshens existing packs when it writes a result. Stat changes do
      // not invalidate authenticated retained bytes, but current source objects
      // must still be genuine before excluding their covered reachable set.
      observed.start("source-integrity");
      try {
        const verified = await subprocessAsync(
          "git",
          [
            "-C",
            config.checkout,
            "fsck",
            "--strict",
            "--no-reflogs",
            "--no-dangling",
            ...roots.map((entry) => entry.sha),
          ],
          { env: pinnedGitEnvironment() },
        );
        if (verified.status !== 0)
          throw new Error(
            "Recovery Git source failed exact reachable-object verification",
          );
        observed.complete();
      } catch (error) {
        observed.fail(error);
        throw error;
      }
    }
    const packs = reusable ? cached.refs : [];
    const coveredRoots = new Set(
      (reusable ? cached.roots : []).map(
        (entry) => `${entry.kind}:${entry.sha}`,
      ),
    );
    const addedRoots = roots.filter(
      (entry) => !coveredRoots.has(`${entry.kind}:${entry.sha}`),
    );
    observed.start(addedRoots.length ? "capture" : "reuse");
    if (addedRoots.length) {
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
          `${[
            ...addedRoots.map((entry) => entry.sha),
            ...(reusable ? cached.roots.map((entry) => `^${entry.sha}`) : []),
          ].join("\n")}\n`,
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
        const bytes = readFileSync(packPath);
        if (cached) {
          // Authenticate expanded coverage in an owned scratch database, never
          // in the archive's remote-only verifier. An unchanged baseline cannot
          // supply integrity for newly reachable local objects. Changed source
          // storage was separately authenticated before retaining its baseline.
          const verified = join(temporary, "verified.git");
          const format = pinnedGit(
            config.checkout,
            "rev-parse",
            "--show-object-format",
          );
          if (format !== "sha1" && format !== "sha256")
            throw new Error("Recovery Git object format is unsupported");
          const initialized = await subprocessAsync(
            "git",
            ["init", "--bare", `--object-format=${format}`, verified],
            { env: pinnedGitEnvironment() },
          );
          if (initialized.status !== 0)
            throw new Error("Recovery Git pack verifier could not initialize");
          const index = async (originalBytes: Uint8Array) => {
            const identity = Buffer.from(
              originalBytes.subarray(
                originalBytes.length - (format === "sha1" ? 20 : 32),
              ),
            ).toString("hex");
            const original = join(
              verified,
              "objects",
              "pack",
              `pack-${identity}.pack`,
            );
            writeFileSync(original, originalBytes, { mode: 0o600 });
            const indexed = await subprocessAsync(
              "git",
              ["-C", verified, "index-pack", "--strict", original],
              { env: pinnedGitEnvironment() },
            );
            if (indexed.status !== 0)
              throw new Error(
                "Recovery Git pack union failed exact reachable-object verification",
              );
          };
          for (const ref of packs)
            await index(await readReference(store, ref, store));
          await index(bytes);
          const connectivity = await subprocessAsync(
            "git",
            [
              "-C",
              verified,
              "fsck",
              "--strict",
              "--no-reflogs",
              "--no-dangling",
            ],
            { env: pinnedGitEnvironment() },
          );
          const verifiedRoots = await subprocessAsync(
            "git",
            [
              "-C",
              verified,
              "cat-file",
              "--batch-check=%(objectname) %(objecttype)",
            ],
            { env: pinnedGitEnvironment() },
            `${roots.map((entry) => entry.sha).join("\n")}\n`,
          );
          if (
            connectivity.status !== 0 ||
            verifiedRoots.status !== 0 ||
            verifiedRoots.stdout !==
              `${roots.map((entry) => `${entry.sha} ${entry.kind}`).join("\n")}\n`
          )
            throw new Error(
              "Recovery Git pack union failed exact reachable-object verification",
            );
        }
        // No --thin: each new pack indexes independently. Its reachable-set
        // exclusions are supplied only by authenticated retained originals,
        // and the current manifest always carries their complete pack union.
        const ref = await retainBytes(
          store,
          bytes,
          "application/x-git-packed-objects",
        );
        if (!packs.some((retained) => refKey(retained) === refKey(ref)))
          packs.push(ref);
      } catch (error) {
        observed.fail(error);
        throw error;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    retainRecoveryCheckpointGitPack(roots, packs, material);
    observed.complete();
    for (const ref of packs) {
      refs.set(refKey(ref), ref);
      files.push({
        kind: "git-pack",
        path: `git/objects-${ref.digest}.pack`,
        ref,
        visibility: scope === "private-history" ? "private" : "repository",
      });
    }
  }
  for (const ref of refs.values()) {
    // Existing local originals already occupy their durable content address.
    // Only a supplied import store needs to copy missing originals into it.
    if (!input.store) {
      store.verifyPrivateBytes(ref);
      continue;
    }
    const bytes = await readReference(reader, ref);
    await retainBytes(store, bytes, ref.mediaType);
  }
  return {
    files: uniqueRecoveryCheckpointFiles(files),
    contentRefs: [...refs.values()],
    gitObjects: [...objects.values()]
      .filter((entry) => entry.kind === "commit")
      .map((entry) => ({ commitSha: entry.sha, role: entry.role })),
    gaps,
  };
}
