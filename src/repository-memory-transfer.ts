import { createHash } from "node:crypto";
import { join } from "node:path";
import { stateRoot } from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import {
  assertDiscoveryOutputManifest,
  parseDiscoveryBody,
} from "./discovery.js";
import {
  assertLearningOriginalDestination,
  type DreamInputCheckpoint,
  decodeLearningOriginal,
  installLearningOriginal,
  LEARNING_ORIGINAL_KINDS,
  type LearningOriginal,
  learningOriginals,
  snapshotStateRef,
  validateDreamInputOriginal,
  validateLearningOriginals,
} from "./learning.js";
import type {
  RecoveryCheckpointClosure,
  RecoveryCheckpointFile,
  RecoveryCheckpointGap,
} from "./recovery-checkpoint.js";
import {
  checkpointClosureOriginals,
  checkpointClosureOriginalsDuring,
  checkpointOriginalInventory,
} from "./recovery-checkpoint.js";
import type { RecoveryGitObject } from "./recovery-checkpoint-closure.js";
import {
  assertRepositoryMemoryBindings,
  decodeRepositoryMemoryManifest,
  LocalRepositoryMemory,
  type MemoryAccess,
  type MemoryLookup,
  type RepositoryMemoryBinding,
  type RepositoryMemoryRecord,
} from "./repository-memory.js";

export interface MemoryLearningClosure extends RecoveryCheckpointClosure {
  typedGitObjects: RecoveryGitObject[];
}

export interface MemoryLearningSelection {
  repository: string;
  root?: string;
  access: MemoryAccess;
  memoryIds?: string[];
  scope?: MemoryLookup["scope"];
  learning?: { includeUnapproved: true };
}

function refIdentity(ref: ContentRef): string {
  return JSON.stringify([ref.digest, ref.bytes, ref.mediaType]);
}
function assertRef(value: unknown): asserts value is ContentRef {
  const ref = value as ContentRef | null;
  if (
    !ref ||
    typeof ref !== "object" ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join() !== "bytes,digest,mediaType" ||
    !/^[a-f0-9]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    typeof ref.mediaType !== "string" ||
    !ref.mediaType
  )
    throw new Error("Invalid portable content reference");
}
function verifyBytes(ref: ContentRef, bytes: Uint8Array): Buffer {
  assertRef(ref);
  const body = Buffer.from(bytes);
  if (
    body.length !== ref.bytes ||
    createHash("sha256").update(body).digest("hex") !== ref.digest
  )
    throw new Error(
      "Portable content differs from its exact original reference",
    );
  return body;
}
function decodeJSON(bytes: Uint8Array): Record<string, unknown> {
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (!Buffer.from(raw).equals(Buffer.from(bytes)))
    throw new Error("Portable JSON is not exact UTF8");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Portable original must be an object");
  return value as Record<string, unknown>;
}
function assertAccess(repository: string, access: MemoryAccess): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    access.repository !== repository ||
    !Array.isArray(access.visibility) ||
    access.visibility.some(
      (visibility) => !["private", "repository"].includes(visibility),
    )
  )
    throw new Error(
      "Portable memory access differs from its authorized repository",
    );
}

/** Known producer roles only. JSON-shaped source bytes never grant another private read. */
async function memoryBodyReferences(
  record: RepositoryMemoryRecord,
  role: string,
  bytes: Uint8Array,
  readBytes: (ref: ContentRef) => Uint8Array | Promise<Uint8Array>,
  gitObjects?: RecoveryGitObject[],
  localStore?: LocalContentStore,
): Promise<ContentRef[]> {
  if (role === "discovery-manifest" && record.kind === "discovery") {
    const manifest = decodeJSON(bytes);
    assertDiscoveryOutputManifest(manifest);
    if (
      !record.sources.some(
        (source) =>
          source.ref && refIdentity(source.ref) === refIdentity(manifest.body),
      )
    )
      throw new Error(
        "Original discovery body differs from its retained source binding",
      );
    gitObjects?.push(
      {
        sha: manifest.source.commitSha,
        kind: "commit",
        role: "discovery-source",
      },
      {
        sha: manifest.source.treeSha,
        kind: "tree",
        role: "discovery-source-tree",
      },
    );
    return [manifest.body];
  }
  if (
    record.kind === "discovery" &&
    record.sources[0]?.identity.startsWith("discovery:") &&
    record.bodies.find((body) => body.role === role)?.ref?.digest ===
      record.sources[0].ref?.digest
  )
    return parseDiscoveryBody(bytes).entries.map((entry) => {
      if (
        !record.sources.some(
          (source) =>
            source.identity === `repository:${entry.path}` &&
            source.ref &&
            refIdentity(source.ref) === refIdentity(entry.content),
        )
      )
        throw new Error(
          "Original discovery entry differs from its retained source binding",
        );
      gitObjects?.push({
        sha: entry.blobSha,
        kind: "blob",
        role: `discovery:${entry.path}`,
      });
      return entry.content;
    });
  if (role === "handoff" && record.kind === "handoff") {
    const handoff = decodeJSON(bytes);
    if (!Array.isArray(handoff.sources))
      throw new Error("Invalid original handoff sources");
    return handoff.sources.map((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source))
        throw new Error("Invalid original handoff source");
      // An original worker record cites each source by its exact reference; the
      // filtered memory body cites it by digest. Either binds to one retained
      // source whose exact reference the record holds.
      const retained = source as {
        path?: string;
        ref?: unknown;
        digest?: unknown;
      };
      if ("ref" in retained) assertRef(retained.ref);
      else if (
        Object.keys(retained).sort().join() !== "digest,path" ||
        typeof retained.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(retained.digest)
      )
        throw new Error("Invalid original handoff source");
      const bound = record.sources.find(
        (source) =>
          source.identity === `repository:${retained.path}` &&
          source.ref &&
          (retained.ref
            ? refIdentity(source.ref) ===
              refIdentity(retained.ref as ContentRef)
            : source.ref.digest === retained.digest),
      )?.ref;
      if (!bound)
        throw new Error(
          "Original handoff source differs from its retained binding",
        );
      assertRef(bound);
      return bound;
    });
  }
  const {
    verifyMemoryBodyReferenceClosure,
    verifyLocalMemoryBodyReferenceClosure,
  } = await import("./recovery-checkpoint-closure.js");
  const description = localStore
    ? await verifyLocalMemoryBodyReferenceClosure(role, bytes, localStore)
    : await verifyMemoryBodyReferenceClosure(role, bytes, { readBytes });
  gitObjects?.push(...description.gitObjects);
  return description.contentRefs;
}

/** Exact originals for the single recovery archive, without transport or lifecycle effects. */
export async function buildMemoryLearningClosure(
  selection: MemoryLearningSelection,
): Promise<MemoryLearningClosure> {
  assertAccess(selection.repository, selection.access);
  const root = selection.root ?? stateRoot(selection.repository);
  const store = new LocalContentStore(join(root, "content"));
  const priorOriginals = checkpointClosureOriginals();
  const bindings = checkpointOriginalInventory(
    [join(root, "memory", "records")],
    "memory",
  );
  const learning =
    selection.learning && selection.access.visibility.includes("private")
      ? checkpointOriginalInventory(
          LEARNING_ORIGINAL_KINDS.map((kind) => join(root, "learning", kind)),
          "learning",
        )
      : [];
  const signature =
    priorOriginals?.length === 0 &&
    !selection.scope &&
    bindings &&
    learning &&
    JSON.stringify(["memory-learning-producer", selection, bindings, learning]);
  const cached = signature ? store.checkpointReferences(signature) : undefined;
  if (cached?.files && cached.typedGitObjects) {
    for (const ref of [...cached.contentRefs, ...cached.originals])
      store.verifyPrivateBytes(ref);
    return {
      files: cached.files,
      contentRefs: cached.contentRefs,
      gitObjects: cached.gitObjects.map((object) => ({
        commitSha: object.sha,
        role: object.role,
      })),
      typedGitObjects: cached.typedGitObjects,
      gaps: cached.gaps,
    };
  }
  const result = await buildMemoryLearningClosureLocal(
    selection,
    !selection.scope && bindings && learning ? { learning } : undefined,
  );
  if (
    signature &&
    result.gaps.length === 0 &&
    signature ===
      JSON.stringify([
        "memory-learning-producer",
        selection,
        bindings,
        learning,
      ])
  ) {
    const retained = new Set(result.contentRefs.map(refIdentity));
    store.retainCheckpointReferences(
      signature,
      {
        files: result.files,
        contentRefs: result.contentRefs,
        gitObjects: (result.gitObjects ?? []).map((object) => ({
          sha: object.commitSha,
          kind: "commit",
          role: object.role,
        })),
        typedGitObjects: result.typedGitObjects,
        gaps: result.gaps as import("./recovery-checkpoint-closure.js").RecoveryClosureGap[],
        originals: (checkpointClosureOriginals() ?? []).filter(
          (ref) => !retained.has(refIdentity(ref)),
        ),
      },
      // Any new record or learning original supersedes this summary.
      JSON.stringify(["memory-learning-producer", selection]),
    );
  }
  return result;
}

/** One producer step's contribution, in its original order. */
interface ClosurePart {
  files: RecoveryCheckpointFile[];
  contentRefs: ContentRef[];
  gitObjects: NonNullable<RecoveryCheckpointClosure["gitObjects"]>;
  typedGitObjects: RecoveryGitObject[];
  gaps: (RecoveryCheckpointGap & { required?: boolean })[];
}

/**
 * Reuse one step's summary in an owned closure build: its exact signature
 * names immutable inputs, and every reference and original the step touched
 * is verified again. A step with a gap is rebuilt every time.
 */
async function reusableClosurePart(
  store: LocalContentStore,
  signature: string | undefined,
  build: () => Promise<ClosurePart>,
  slot?: string,
): Promise<ClosurePart> {
  if (!signature) return build();
  const cached = store.checkpointReferences(signature);
  if (cached?.files && cached.typedGitObjects) {
    for (const ref of [...cached.contentRefs, ...cached.originals])
      store.verifyPrivateBytes(ref);
    return {
      files: cached.files,
      contentRefs: cached.contentRefs,
      gitObjects: cached.gitObjects.map((object) => ({
        commitSha: object.sha,
        role: object.role,
      })),
      typedGitObjects: cached.typedGitObjects,
      gaps: cached.gaps,
    };
  }
  const { value: part, originals } =
    await checkpointClosureOriginalsDuring(build);
  if (originals && part.gaps.length === 0) {
    const retained = new Set(part.contentRefs.map(refIdentity));
    store.retainCheckpointReferences(
      signature,
      {
        files: part.files,
        contentRefs: part.contentRefs,
        gitObjects: part.gitObjects.map((object) => ({
          sha: object.commitSha,
          kind: "commit",
          role: object.role,
        })),
        typedGitObjects: part.typedGitObjects,
        gaps: [],
        originals: originals.filter((ref) => !retained.has(refIdentity(ref))),
      },
      slot,
    );
  }
  return part;
}

async function buildMemoryLearningClosureLocal(
  selection: MemoryLearningSelection,
  /**
   * Set only in an owned closure build of the whole history: each memory
   * record and the learning originals then keep their own summaries, so one
   * new record does not re-derive every other one (#1549).
   */
  reuse?: { learning: { path: string; fingerprint: string }[] },
): Promise<MemoryLearningClosure> {
  assertAccess(selection.repository, selection.access);
  const root = selection.root ?? stateRoot(selection.repository);
  const store = new LocalContentStore(join(root, "content"));
  const memory = new LocalRepositoryMemory(root, selection.repository, store);
  const verified = new Map<string, Buffer>();
  const readBytes = (ref: ContentRef) => {
    const previous = verified.get(ref.digest);
    // An owned build reads through its store, which shares verified bytes and
    // records every original each reusable step touches.
    if (previous && !reuse) return verifyBytes(ref, previous);
    const bytes = store.readBytes(ref);
    verified.set(ref.digest, bytes);
    return bytes;
  };
  const files: RecoveryCheckpointFile[] = [];
  const refs = new Map<string, ContentRef>();
  const gaps: (RecoveryCheckpointGap & { required?: boolean })[] = [];
  const gitObjects: NonNullable<RecoveryCheckpointClosure["gitObjects"]> = [];
  const typedGitObjects: RecoveryGitObject[] = [];
  const add = (ref: ContentRef) => {
    assertRef(ref);
    refs.set(refIdentity(ref), ref);
  };
  const merge = (part: ClosurePart) => {
    files.push(...part.files);
    for (const ref of part.contentRefs) add(ref);
    gitObjects.push(...part.gitObjects);
    typedGitObjects.push(...part.typedGitObjects);
    gaps.push(...part.gaps);
  };
  const emptyPart = (): ClosurePart & { refs: Map<string, ContentRef> } => ({
    files: [],
    contentRefs: [],
    gitObjects: [],
    typedGitObjects: [],
    gaps: [],
    refs: new Map(),
  });
  const complete = (part: ReturnType<typeof emptyPart>): ClosurePart => ({
    files: part.files,
    contentRefs: [...part.refs.values()],
    gitObjects: part.gitObjects,
    typedGitObjects: part.typedGitObjects,
    gaps: part.gaps,
  });
  const retainFile = (
    part: ReturnType<typeof emptyPart>,
    kind: "memory-binding" | "learning-original",
    path: string,
    bytes: Uint8Array,
    visibility: "private" | "repository",
  ) => {
    const ref = store.putBytes(bytes, { mediaType: "application/json" });
    part.files.push({ kind, path, ref, visibility });
    assertRef(ref);
    part.refs.set(refIdentity(ref), ref);
  };
  const retained = memory.recordsForTransfer({
    access: selection.access,
    ids: selection.memoryIds,
    scope: selection.scope,
  });
  for (const unavailable of retained.unavailable)
    gaps.push({
      path: "memory/records",
      availability: "unavailable",
      reason: unavailable,
    });
  for (const { binding, record, bindingBytes } of retained.entries) {
    // The binding names its content-addressed manifest, which names every
    // body and source: its exact bytes determine this record's contribution.
    const signature =
      reuse &&
      JSON.stringify([
        "memory-record",
        selection.repository,
        createHash("sha256").update(bindingBytes).digest("hex"),
        bindingBytes.length,
      ]);
    merge(
      await reusableClosurePart(store, signature, async () => {
        const part = emptyPart();
        const add = (ref: ContentRef) => {
          assertRef(ref);
          part.refs.set(refIdentity(ref), ref);
        };
        retainFile(
          part,
          "memory-binding",
          `memory/records/${binding.id}.json`,
          bindingBytes,
          record.visibility,
        );
        add(binding.manifestRef);
        for (const body of record.bodies) {
          if (!body.ref) {
            part.gaps.push({
              path: `memory/records/${binding.id}.json:${body.role}`,
              availability: body.availability,
              reason: "Original producer retained no body",
              required: false,
            });
            continue;
          }
          add(body.ref);
          // A claimed immutable reference remains required even when historically unavailable.
          const bytes = readBytes(body.ref);
          for (const ref of await memoryBodyReferences(
            record,
            body.role,
            bytes,
            readBytes,
            part.typedGitObjects,
            store,
          ))
            add(ref);
        }
        for (const source of record.sources) {
          if (source.ref) add(source.ref);
          if (source.commitSha)
            part.gitObjects.push({
              commitSha: source.commitSha,
              role: `memory:${binding.id}:${source.identity}`,
            });
          if (source.treeSha)
            part.typedGitObjects.push({
              sha: source.treeSha,
              kind: "tree",
              role: `memory:${binding.id}:${source.identity}`,
            });
        }
        if (record.bindings.commitSha)
          part.gitObjects.push({
            commitSha: record.bindings.commitSha,
            role: `memory:${binding.id}:original`,
          });
        if (record.bindings.treeSha)
          part.typedGitObjects.push({
            sha: record.bindings.treeSha,
            kind: "tree",
            role: `memory:${binding.id}:tree`,
          });
        return complete(part);
      }),
    );
  }
  if (selection.learning && selection.access.visibility.includes("private")) {
    if (selection.scope?.paths !== undefined)
      throw new Error(
        "Original private learning requires repository-wide authorized history scope",
      );
    // Learning originals are validated as one set, so they share one summary
    // keyed by every original's exact fingerprint.
    const signature =
      reuse &&
      JSON.stringify([
        "learning-producer",
        selection.repository,
        reuse.learning,
      ]);
    merge(
      await reusableClosurePart(
        store,
        signature,
        async () => {
          const part = emptyPart();
          const add = (ref: ContentRef) => {
            assertRef(ref);
            part.refs.set(refIdentity(ref), ref);
          };
          const originals = learningOriginals(selection.repository, root);
          validateLearningOriginals(selection.repository, originals);
          const { verifyLocalContinuationReferenceClosure } = await import(
            "./recovery-checkpoint-closure.js"
          );
          for (const original of originals) {
            retainFile(
              part,
              "learning-original",
              original.path,
              original.bytes,
              "private",
            );
            const { kind, value, history } = decodeLearningOriginal(
              selection.repository,
              original.path,
              original.bytes,
            );
            if (kind === "snapshots" && !history) {
              const stateRef = snapshotStateRef(value);
              add(stateRef);
              const described = await verifyLocalContinuationReferenceClosure(
                JSON.parse(Buffer.from(readBytes(stateRef)).toString("utf8")),
                store,
              );
              for (const ref of described.contentRefs) add(ref);
              part.gaps.push(...described.gaps);
              part.typedGitObjects.push(...described.gitObjects);
              for (const object of described.gitObjects)
                if (object.kind === "commit")
                  part.gitObjects.push({
                    commitSha: object.sha,
                    role: object.role,
                  });
            } else if (kind === "returns") {
              add(value.responseRef as ContentRef);
            } else if (kind === "checkpoints") {
              const checkpoint = value as unknown as DreamInputCheckpoint;
              validateDreamInputOriginal(
                selection.repository,
                checkpoint,
                readBytes(checkpoint.inputPacketRef),
                originals,
              );
              add(checkpoint.inputPacketRef);
              for (const included of checkpoint.included) {
                add(included.episodeRef);
                for (const ref of included.supporting) add(ref);
              }
            }
          }
          return complete(part);
        },
        JSON.stringify(["learning-producer", selection.repository]),
      ),
    );
  }
  // Verify every selected body, including binary originals, without text
  // conversion or allocating bytes an earlier hash of the same file covers.
  for (const ref of refs.values()) store.verifyPrivateBytes(ref);
  return {
    files,
    contentRefs: [...refs.values()],
    gitObjects,
    typedGitObjects,
    gaps,
  };
}

export interface ExactMemoryLearningInstall {
  repository: string;
  root?: string;
  access: MemoryAccess;
  files: RecoveryCheckpointFile[];
  contentRefs: ContentRef[];
  readVerifiedBlob(ref: ContentRef): Promise<Uint8Array>;
}

/** Validate all selected bytes before installing immutable replicas. No foreign state is resumed. */
export async function installExactMemoryLearning(
  input: ExactMemoryLearningInstall,
): Promise<{
  memoryRecords: number;
  learningRecords: number;
  catalog: "ready" | "unavailable";
}> {
  assertAccess(input.repository, input.access);
  const bytes = new Map<string, Buffer>();
  const refs = new Map<string, ContentRef>();
  for (const ref of input.contentRefs) {
    assertRef(ref);
    refs.set(refIdentity(ref), ref);
  }
  const files = input.files.filter((file) =>
    ["memory-binding", "learning-original"].includes(file.kind),
  );
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path))
      throw new Error("Duplicate portable original path");
    paths.add(file.path);
    if (!input.access.visibility.includes(file.visibility))
      throw new Error("Portable original visibility is not authorized");
    if (file.kind === "learning-original" && file.visibility !== "private")
      throw new Error("Learning originals must remain private");
    assertRef(file.ref);
    refs.set(refIdentity(file.ref), file.ref);
  }
  const selectedRefs = new Map<string, ContentRef>();
  const load = async (ref: ContentRef) => {
    assertRef(ref);
    if (!refs.has(refIdentity(ref)))
      throw new Error(
        "Required portable reference is absent from the declared closure",
      );
    selectedRefs.set(refIdentity(ref), ref);
    const value = bytes.get(refIdentity(ref));
    if (value) return value;
    const verified = verifyBytes(ref, await input.readVerifiedBlob(ref));
    bytes.set(refIdentity(ref), verified);
    return verified;
  };
  const root = input.root ?? stateRoot(input.repository);
  const store = new LocalContentStore(join(root, "content"));
  const memory = new LocalRepositoryMemory(root, input.repository, store);
  const originals: LearningOriginal[] = [];
  const memories: {
    binding: RepositoryMemoryBinding;
    bytes: Buffer;
    record: RepositoryMemoryRecord;
  }[] = [];
  for (const file of files) {
    const data = await load(file.ref);
    if (file.kind === "learning-original") {
      decodeLearningOriginal(input.repository, file.path, data);
      originals.push({ path: file.path, bytes: data });
    } else {
      const binding = decodeJSON(data) as unknown as RepositoryMemoryBinding;
      assertRepositoryMemoryBindings([binding]);
      if (file.path !== `memory/records/${binding.id}.json`)
        throw new Error(
          "Portable memory path differs from its original binding",
        );
      const manifestBytes = await load(binding.manifestRef);
      const record = decodeRepositoryMemoryManifest(binding, manifestBytes);
      if (
        record.repository !== input.repository ||
        record.visibility !== file.visibility
      )
        throw new Error("Portable memory manifest scope changed");
      memory.assertExactDestination(binding, manifestBytes, input.access);
      memories.push({ binding, bytes: manifestBytes, record });
    }
  }
  // Metadata scope is authenticated before opening any supporting body.
  for (const { record } of memories) {
    for (const retained of record.bodies)
      if (retained.ref) {
        const data = await load(retained.ref);
        for (const ref of await memoryBodyReferences(
          record,
          retained.role,
          data,
          load,
        ))
          await load(ref);
      }
    for (const source of record.sources) if (source.ref) await load(source.ref);
  }
  if (originals.length) validateLearningOriginals(input.repository, originals);
  const { verifyContinuationReferenceClosure } = await import(
    "./recovery-checkpoint-closure.js"
  );
  for (const original of originals)
    assertLearningOriginalDestination(input.repository, original, root);
  for (const original of originals) {
    const { kind, value, history } = decodeLearningOriginal(
      input.repository,
      original.path,
      original.bytes,
    );
    if (kind === "snapshots" && !history) {
      await verifyContinuationReferenceClosure(
        JSON.parse(
          Buffer.from(await load(snapshotStateRef(value))).toString("utf8"),
        ),
        { readBytes: load },
      );
    } else if (kind === "returns") await load(value.responseRef as ContentRef);
    else if (kind === "checkpoints") {
      const checkpoint = value as unknown as DreamInputCheckpoint;
      validateDreamInputOriginal(
        input.repository,
        checkpoint,
        await load(checkpoint.inputPacketRef),
        originals,
      );
      for (const included of checkpoint.included) {
        await load(included.episodeRef);
        for (const ref of included.supporting) await load(ref);
      }
    }
  }
  for (const ref of selectedRefs.values())
    store.putBytes(bytes.get(refIdentity(ref))!, { mediaType: ref.mediaType });
  // Approval originals precede versions; no approval action or pin update is performed.
  for (const original of originals.sort(
    (a, b) =>
      Number(a.path.startsWith("learning/versions/")) -
        Number(b.path.startsWith("learning/versions/")) ||
      a.path.localeCompare(b.path),
  ))
    installLearningOriginal(input.repository, original, root);
  for (const original of memories)
    memory.installExact(original.binding, original.bytes, input.access);
  memory.rebuild();
  return {
    memoryRecords: memories.length,
    learningRecords: originals.length,
    catalog: memory.catalogStatus,
  };
}
