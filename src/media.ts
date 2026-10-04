import { ownsPath } from "./ownership.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type {
  AssetCaptureReceipt,
  CapturedAssetSet,
  ContentRef,
  ContentStore,
  ProducedAssetSet,
  SelectedAssetInput,
  SourceAssetBinding,
  ValidationLfsMember,
  WorkItem,
} from "./contracts.js";
import { CONTROLLER_CAPABILITIES_DIGEST } from "./controller-capabilities.js";
import { checkStagedCandidate } from "./execution/staged-candidate.js";
import {
  addWorktree,
  command,
  currentProcessSignal,
  gitAsync,
  hasUnresolvedSubprocesses,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitRaw,
  removeWorktree,
} from "./process.js";
import type { FactoryState } from "./state.js";

const LFS_POINTER_HEADER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\n",
);

export function recognizedObjectiveAttachment(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (/^\/user-attachments\/assets\/[0-9a-fA-F-]{36}$/.test(url.pathname) ||
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/assets\/\d+\/[^/]+$/.test(
          url.pathname,
        ))
    );
  } catch {
    return false;
  }
}

function attachmentHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".githubusercontent.com");
}

async function importAttachment(
  store: ContentStore,
  binding: SourceAssetBinding,
  objectiveBody: string,
  tokenProvider: () => string,
): Promise<ContentRef> {
  if (
    !recognizedObjectiveAttachment(binding.path) ||
    !objectiveBody.includes(binding.path)
  )
    throw new Error(
      "Attachment must be a recognized URL in the Objective body",
    );
  const token = tokenProvider();
  let url = binding.path;
  for (let redirect = 0; redirect < 5; redirect++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: url === binding.path ? { Authorization: `Bearer ${token}` } : {},
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Attachment redirect has no location");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || !attachmentHost(next.hostname))
        throw new Error("Attachment redirected outside GitHub content hosts");
      url = next.href;
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`GitHub attachment download failed (${response.status})`);
    const kind = response.headers.get("content-type") ?? "";
    if (kind.startsWith("text/html"))
      throw new Error("GitHub attachment returned HTML instead of content");
    return store.put(response.body, { mediaType: binding.mediaType });
  }
  throw new Error("GitHub attachment redirect limit exceeded");
}

function safeRelative(path: string, staging = false): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path
      .split(/[\\/]/)
      .some((part) => part === ".." || part === "." || part === "") &&
    !path.includes("\\") &&
    path !== ".git" &&
    !path.startsWith(".git/") &&
    path !== ".factory-assets.json" &&
    path !== ".factory-media" &&
    (staging || !path.startsWith(".factory-media/"))
  );
}

function assertSafeMaterializationDestination(
  worktree: string,
  relative: string,
): { destination: string; exists: boolean } {
  const parts = relative.split("/");
  let current = worktree;
  let prefix = "";
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    if (
      pinnedGit(worktree, "ls-tree", "HEAD", "--", prefix).startsWith(
        "160000 commit ",
      )
    )
      throw new Error(
        `Selected asset destination crosses a submodule: ${relative}`,
      );
    let type;
    try {
      type = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { destination: join(worktree, relative), exists: false };
      throw error;
    }
    if (type.isSymbolicLink())
      throw new Error(
        `Selected asset destination crosses a symlink: ${relative}`,
      );
    if (index < parts.length - 1) {
      if (!type.isDirectory())
        throw new Error(
          `Selected asset destination has a non-directory parent: ${relative}`,
        );
    } else if (!type.isFile()) {
      throw new Error(
        `Selected asset destination is not a regular file: ${relative}`,
      );
    }
  }
  return { destination: join(worktree, relative), exists: true };
}

async function putFile(
  store: ContentStore,
  path: string,
  mediaType: string,
): Promise<ContentRef> {
  if (
    !isAbsolute(path) ||
    !lstatSync(path).isFile() ||
    realpathSync(path) !== resolve(path) ||
    realpathSync(dirname(path)) !== resolve(dirname(path))
  )
    throw new Error("Content source must be a regular file without symlinks");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = createReadStream(path, { fd: descriptor, autoClose: true });
  try {
    return await store.put(
      Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      { mediaType },
    );
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function readRegularStagingFile(path: string, label: string): Buffer {
  if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
    throw new Error(`${label} is not a regular staging file`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile())
      throw new Error(`${label} is not a regular staging file`);
    const bytes = readFileSync(descriptor);
    const linked = lstatSync(path);
    if (
      !linked.isFile() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      realpathSync(path) !== resolve(path)
    )
      throw new Error(`${label} changed while Factory read it`);
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** One ingress check for the worker manifest and controller collection. */
export function parseProducedAssetSets(value: unknown): ProducedAssetSet[] {
  if (!Array.isArray(value))
    throw new Error("AssetSet manifest must contain a sets array");
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("AssetSet entry must be an object");
    const set = raw as Record<string, unknown>;
    if (
      typeof set.id !== "string" ||
      !Array.isArray(set.members) ||
      !set.members.length
    )
      throw new Error("AssetSet entry needs an ID and members");
    const provenance = set.provenance as Record<string, unknown> | undefined;
    if (
      !provenance ||
      typeof provenance.source !== "string" ||
      typeof provenance.rights !== "string" ||
      !["private", "repository"].includes(String(provenance.visibility)) ||
      !Array.isArray(provenance.lineage) ||
      !provenance.lineage.every((part) => typeof part === "string")
    )
      throw new Error(`AssetSet ${set.id} provenance is invalid`);
    const declaredRoles = new Set<string>();
    for (const rawMember of set.members) {
      if (
        !rawMember ||
        typeof rawMember !== "object" ||
        Array.isArray(rawMember)
      )
        throw new Error(`AssetSet ${set.id} member is invalid`);
      const member = rawMember as Record<string, unknown>;
      if (
        ["role", "path", "mediaType", "destination"].some(
          (key) => typeof member[key] !== "string",
        )
      )
        throw new Error(`AssetSet ${set.id} member binding is incomplete`);
      declaredRoles.add(member.role as string);
      if (member.formatMetadata !== undefined) {
        const metadata = member.formatMetadata;
        if (
          !metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata)
        )
          throw new Error(`AssetSet ${set.id} format metadata is invalid`);
        const detail = metadata as Record<string, unknown>;
        if (
          typeof detail.source !== "string" ||
          !detail.source ||
          !detail.values ||
          typeof detail.values !== "object" ||
          Array.isArray(detail.values)
        )
          throw new Error(`AssetSet ${set.id} format metadata is invalid`);
      }
    }
    if (set.relationships !== undefined) {
      if (
        !Array.isArray(set.relationships) ||
        !set.relationships.every(
          (edge) =>
            edge &&
            typeof edge === "object" &&
            typeof edge.from === "string" &&
            !!edge.from &&
            typeof edge.toRole === "string" &&
            declaredRoles.has(edge.toRole) &&
            typeof edge.kind === "string" &&
            !!edge.kind,
        )
      )
        throw new Error(`AssetSet ${set.id} relationships are invalid`);
    }
    if (set.production !== undefined) {
      if (
        !set.production ||
        typeof set.production !== "object" ||
        Array.isArray(set.production)
      )
        throw new Error(`AssetSet ${set.id} production evidence is invalid`);
      const production = set.production as Record<string, unknown>;
      for (const key of ["model", "tool"])
        if (
          production[key] !== undefined &&
          (typeof production[key] !== "string" || !production[key])
        )
          throw new Error(`AssetSet ${set.id} production ${key} is invalid`);
    }
  }
  return value as ProducedAssetSet[];
}

export async function importSourceAssets(
  store: ContentStore,
  worktree: string,
  item: WorkItem,
  objectiveBody = "",
  tokenProvider: () => string = () => command("gh", ["auth", "token"]),
): Promise<{ binding: SourceAssetBinding; ref: ContentRef }[]> {
  const result: { binding: SourceAssetBinding; ref: ContentRef }[] = [];
  for (const binding of item.sourceAssets ?? []) {
    const { path } = binding;
    let ref: ContentRef;
    if (binding.kind === "github-attachment") {
      ref = await importAttachment(
        store,
        binding,
        objectiveBody,
        tokenProvider,
      );
    } else {
      if (binding.kind === "local") {
        if (
          binding.visibility !== "private" ||
          !isAbsolute(path) ||
          !objectiveBody.includes(path)
        )
          throw new Error("Local source must be an absolute private file");
      } else if (!safeRelative(path)) {
        throw new Error(`Invalid source asset path: ${path}`);
      }
      const absolute = binding.kind === "local" ? path : join(worktree, path);
      if (!existsSync(absolute))
        throw new Error(`Source asset does not exist: ${path}`);
      ref = await putFile(store, absolute, binding.mediaType);
    }
    result.push({ binding, ref });
  }
  return result;
}

export async function captureAssetSets(
  store: ContentStore,
  worktree: string,
  item: WorkItem,
  sets: ProducedAssetSet[],
  evidence: unknown,
  inputs: { binding: SourceAssetBinding; ref: ContentRef }[] = [],
): Promise<CapturedAssetSet[]> {
  parseProducedAssetSets(sets);
  if (new Set(sets.map((set) => set.id)).size !== sets.length)
    throw new Error("Produced AssetSet identifiers must be unique");
  if (sets.length && !evidence)
    throw new Error("Produced AssetSets require harness evidence");
  if (
    sets.length &&
    (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
  )
    throw new Error("Produced AssetSets require structured harness evidence");
  const evidenceObject = (
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? evidence
      : {}
  ) as Record<string, unknown>;
  const harnessIdentity = evidenceObject.threadId ?? evidenceObject.harness;
  if (sets.length && (typeof harnessIdentity !== "string" || !harnessIdentity))
    throw new Error("Produced AssetSets require a harness identity");
  const evidenceRef = {
    harnessIdentity: harnessIdentity as string,
    resultDigest: createHash("sha256")
      .update(JSON.stringify(evidence ?? {}))
      .digest("hex"),
  };
  const declaration = join(worktree, ".factory-assets.json");
  let declarationDigest = "";
  if (sets.length && existsSync(declaration)) {
    const declarationBytes = readRegularStagingFile(
      declaration,
      "AssetSet manifest",
    );
    const value: unknown = JSON.parse(declarationBytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("AssetSet manifest must be an object with sets");
    const declared = parseProducedAssetSets(
      (value as Record<string, unknown>).sets,
    );
    if (!isDeepStrictEqual(declared, sets))
      throw new Error("Harness AssetSets differ from .factory-assets.json");
    declarationDigest = createHash("sha256")
      .update(declarationBytes)
      .digest("hex");
  }
  const mediaRoot = join(worktree, ".factory-media");
  if (
    sets.length &&
    (!existsSync(mediaRoot) || realpathSync(mediaRoot) !== resolve(mediaRoot))
  )
    throw new Error("Produced media root is missing or redirected");
  const captured: CapturedAssetSet[] = [];
  const receiptInputs: NonNullable<AssetCaptureReceipt["inputs"]> = inputs.map(
    (input) => ({
      binding: {
        kind: input.binding.kind ?? "repository",
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
    }),
  );
  for (const set of sets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(set.id) || !set.members.length)
      throw new Error(
        "Produced AssetSet has an invalid identity or no members",
      );
    const provenance = set.provenance;
    if (
      !provenance ||
      typeof provenance.source !== "string" ||
      !provenance.source ||
      typeof provenance.rights !== "string" ||
      !provenance.rights ||
      !["private", "repository"].includes(provenance.visibility) ||
      !Array.isArray(provenance.lineage) ||
      !provenance.lineage.every((entry) => typeof entry === "string")
    )
      throw new Error(
        "Produced AssetSet lacks provenance, rights, visibility, or lineage",
      );
    const roles = new Set<string>();
    const destinations = new Set<string>();
    const members: CapturedAssetSet["members"] = [];
    const receiptMembers: AssetCaptureReceipt["members"] = [];
    for (const member of set.members) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(member.role) ||
        roles.has(member.role) ||
        !member.destination ||
        !safeRelative(member.destination) ||
        !ownsPath(member.destination, item.ownedPaths) ||
        destinations.has(member.destination)
      )
        throw new Error(
          "Produced AssetSet has duplicate or unowned member bindings",
        );
      roles.add(member.role);
      destinations.add(member.destination);
      if (
        !safeRelative(member.path, true) ||
        !member.path.startsWith(".factory-media/")
      )
        throw new Error("Produced asset must be inside .factory-media");
      const path = resolve(worktree, member.path);
      if (
        !existsSync(path) ||
        !lstatSync(path).isFile() ||
        !realpathSync(path).startsWith(`${realpathSync(mediaRoot)}${sep}`)
      )
        throw new Error(
          "Produced asset path is missing or escapes the media root",
        );
      const ref = await putFile(store, path, member.mediaType);
      members.push({
        role: member.role,
        ref,
        destination: member.destination,
        ...(member.formatMetadata && { formatMetadata: member.formatMetadata }),
      });
      receiptMembers.push({
        role: member.role,
        stagingPath: member.path,
        destination: member.destination,
        digest: ref.digest,
        bytes: ref.bytes,
        mediaType: ref.mediaType,
      });
    }
    for (const role of item.expectedOutputRoles ?? [])
      if (!roles.has(role))
        throw new Error(`AssetSet ${set.id} lacks expected role ${role}`);
    captured.push({
      id: set.id,
      ...(inputs.length && { inputs }),
      members,
      ...(set.relationships && { relationships: set.relationships }),
      provenance,
      ...(set.production && { production: set.production }),
      evidence: evidenceRef,
      capture: {
        authority: "factory-controller",
        ...(declarationDigest && {
          declarationPath: ".factory-assets.json" as const,
          declarationDigest,
          declarationProvenance: {
            source: provenance.source,
            rights: provenance.rights,
            visibility: provenance.visibility,
            lineage: [...provenance.lineage],
          },
        }),
        mediaRoot: ".factory-media",
        complete: true,
        setId: set.id,
        ...(receiptInputs.length && { inputs: receiptInputs }),
        members: receiptMembers,
      },
    });
  }
  rmSync(mediaRoot, { recursive: true, force: true });
  if (
    new Set(
      captured.map((set) =>
        JSON.stringify(
          set.members.map((member) => [member.role, member.ref.digest]),
        ),
      ),
    ).size !== captured.length
  )
    throw new Error("Candidate AssetSets must have distinct content");
  return captured;
}

/** Reject persisted capture evidence that no longer matches its captured set. */
export function assertAssetCaptureReceipt(set: CapturedAssetSet): void {
  const receipt = set.capture;
  if (!receipt) throw new Error("AssetSet lacks a controller capture receipt");
  if (
    receipt.authority !== "factory-controller" ||
    receipt.mediaRoot !== ".factory-media" ||
    receipt.complete !== true ||
    receipt.setId !== set.id ||
    !Array.isArray(receipt.members) ||
    receipt.members.length !== set.members.length
  )
    throw new Error("AssetSet controller capture receipt is invalid");
  const expectedInputs: NonNullable<AssetCaptureReceipt["inputs"]> = (
    set.inputs ?? []
  ).map((input) => ({
    binding: {
      kind: input.binding.kind ?? "repository",
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
  }));
  if (
    (receipt.inputs === undefined) !== (expectedInputs.length === 0) ||
    (receipt.inputs !== undefined &&
      !isDeepStrictEqual(receipt.inputs, expectedInputs))
  )
    throw new Error("AssetSet controller input receipt differs from inputs");
  const declarationFieldCount = [
    receipt.declarationPath,
    receipt.declarationDigest,
    receipt.declarationProvenance,
  ].filter((value) => value !== undefined).length;
  const declarationProvenance = receipt.declarationProvenance;
  const expectedProvenance = {
    source: set.provenance.source,
    rights: set.provenance.rights,
    visibility: set.provenance.visibility,
    lineage: [...set.provenance.lineage],
  };
  if (
    (declarationFieldCount !== 0 && declarationFieldCount !== 3) ||
    (receipt.declarationPath !== undefined &&
      (receipt.declarationPath !== ".factory-assets.json" ||
        !/^[0-9a-f]{64}$/.test(receipt.declarationDigest ?? "") ||
        !declarationProvenance ||
        !isDeepStrictEqual(Object.keys(declarationProvenance).sort(), [
          "lineage",
          "rights",
          "source",
          "visibility",
        ]) ||
        !isDeepStrictEqual(declarationProvenance, expectedProvenance)))
  )
    throw new Error("AssetSet controller declaration receipt is invalid");
  for (const [index, member] of set.members.entries()) {
    const captured = receipt.members[index];
    if (
      !captured ||
      !safeRelative(captured.stagingPath, true) ||
      !captured.stagingPath.startsWith(".factory-media/") ||
      captured.role !== member.role ||
      captured.destination !== member.destination ||
      captured.digest !== member.ref.digest ||
      captured.bytes !== member.ref.bytes ||
      captured.mediaType !== member.ref.mediaType
    )
      throw new Error(
        "AssetSet controller capture receipt differs from members",
      );
  }
}

export async function materializeAssetSet(args: {
  checkout: string;
  workRoot: string;
  baseCommit: string;
  item: WorkItem;
  set: CapturedAssetSet;
  store: ContentStore;
}): Promise<{ changeRef: string; treeSha: string }> {
  const worktree = join(args.workRoot, `selected-${randomUUID()}`);
  mkdirSync(args.workRoot, { recursive: true });
  await addWorktree(args.checkout, worktree, args.baseCommit);
  try {
    await gitAsync(worktree, "lfs", "install", "--local", "--skip-repo");
    const destinations = new Set<string>();
    for (const member of args.set.members) {
      if (
        !safeRelative(member.destination) ||
        !ownsPath(member.destination, args.item.ownedPaths) ||
        destinations.has(member.destination)
      )
        throw new Error("Selected AssetSet destination is invalid or unowned");
      destinations.add(member.destination);
      const destinationState = assertSafeMaterializationDestination(
        worktree,
        member.destination,
      );
      const { destination } = destinationState;
      const filter = await pinnedGitAsync(
        worktree,
        "check-attr",
        "filter",
        "--",
        member.destination,
      );
      if (destinationState.exists) {
        const source = args.set.inputs?.find(
          (input) =>
            (input.binding.kind ?? "repository") === "repository" &&
            input.binding.path === member.destination,
        );
        const tracked = await pinnedGitAsync(
          worktree,
          "ls-tree",
          "HEAD",
          "--",
          member.destination,
        );
        const entry = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(
          tracked,
        );
        const baseBytes = entry
          ? pinnedGitRaw(worktree, "cat-file", "blob", entry[2]!)
          : undefined;
        if (
          !source ||
          !args.item.requiredLfsRoles?.includes(member.role) ||
          !filter.endsWith(": lfs") ||
          source.ref.digest !== member.ref.digest ||
          source.ref.bytes !== member.ref.bytes ||
          source.ref.mediaType !== member.ref.mediaType ||
          !entry ||
          entry[3] !== member.destination ||
          !baseBytes ||
          baseBytes.length !== source.ref.bytes ||
          createHash("sha256").update(baseBytes).digest("hex") !==
            source.ref.digest ||
          baseBytes
            .subarray(0, LFS_POINTER_HEADER.length)
            .equals(LFS_POINTER_HEADER) ||
          !lstatSync(destination).isFile() ||
          realpathSync(destination) !== resolve(destination)
        )
          throw new Error(
            `Selected asset would overwrite ${member.destination}`,
          );
        const current = await putFile(
          args.store,
          destination,
          source.binding.mediaType,
        );
        if (
          current.digest !== source.ref.digest ||
          current.bytes !== source.ref.bytes ||
          current.mediaType !== source.ref.mediaType
        )
          throw new Error(
            `Existing selected destination differs from its captured repository source: ${member.destination}`,
          );
        rmSync(destination);
        await args.store.materialize(member.ref, destination);
        if (entry[1] === "100755") chmodSync(destination, 0o755);
      } else {
        await args.store.materialize(member.ref, destination);
      }
      if (
        args.item.requiredLfsRoles?.includes(member.role) &&
        !filter.endsWith(": lfs")
      )
        throw new Error(
          `Repository LFS policy does not cover ${member.destination}`,
        );
    }
    await pinnedGitAsync(worktree, "add", "--", ...[...destinations]);
    const staged = await checkStagedCandidate(
      worktree,
      args.checkout,
      args.item.ownedPaths,
    );
    if (
      staged.length !== destinations.size ||
      staged.some((path) => !destinations.has(path))
    )
      throw new Error(
        "Selected AssetSet staged paths differ from approved destinations",
      );
    await pinnedGitAsync(
      worktree,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@users.noreply.github.com",
      "commit",
      "-m",
      `Factory: selected ${args.set.id} assets`,
    );
    const changeRef = await pinnedGitAsync(worktree, "rev-parse", "HEAD");
    for (const member of args.set.members) {
      const filter = await pinnedGitAsync(
        worktree,
        "check-attr",
        "filter",
        "--",
        member.destination,
      );
      if (!filter.endsWith(": lfs")) continue;
      const pointer = await pinnedGitAsync(
        worktree,
        "show",
        `${changeRef}:${member.destination}`,
      );
      const expected = `oid sha256:${member.ref.digest}\nsize ${member.ref.bytes}`;
      if (
        !pointer.startsWith("version https://git-lfs.github.com/spec/v1\n") ||
        !pointer.includes(expected)
      )
        throw new Error(
          `LFS pointer for ${member.destination} differs from selected bytes`,
        );
    }
    return {
      changeRef,
      treeSha: await pinnedGitAsync(worktree, "rev-parse", "HEAD^{tree}"),
    };
  } finally {
    if (!hasUnresolvedSubprocesses())
      await removeWorktree(args.checkout, worktree);
  }
}

export function assetSelectionDigest(set: CapturedAssetSet): string {
  return createHash("sha256").update(JSON.stringify(set)).digest("hex");
}

export function selectedInputsForItem(
  state: FactoryState,
  item: WorkItem,
): SelectedAssetInput[] {
  const inputs: SelectedAssetInput[] = [];
  for (const dependency of item.dependencies) {
    const work = state.work[dependency];
    if (!work?.selection?.downstreamItems.includes(item.id)) continue;
    const set = work.assets?.find(
      (asset) => asset.id === work.selectedAssetSet,
    );
    if (!set || work.selectionDigest !== assetSelectionDigest(set))
      throw new Error(`Selected asset binding from ${dependency} is invalid`);
    for (const member of set.members) {
      inputs.push({
        fromItem: dependency,
        setId: set.id,
        role: member.role,
        ref: member.ref,
        visibility: set.provenance.visibility,
        destination: member.destination,
        provenance: set.provenance,
        ...(member.formatMetadata && { formatMetadata: member.formatMetadata }),
      });
    }
  }
  return inputs;
}

function selectedRequiredLfsMembers(
  state: FactoryState,
  itemIds: ReadonlySet<string>,
): ValidationLfsMember[] {
  const members: ValidationLfsMember[] = [];
  for (const item of state.graph.items) {
    if (!itemIds.has(item.id)) continue;
    const work = state.work[item.id];
    if (!work?.selectedAssetSet) continue;
    const set = work.assets?.find(
      (candidate) => candidate.id === work.selectedAssetSet,
    );
    if (!set || work.selectionDigest !== assetSelectionDigest(set))
      throw new Error(`Selected asset binding from ${item.id} is invalid`);
    const requiredRoles = new Set(item.requiredLfsRoles ?? []);
    for (const member of set.members) {
      if (!requiredRoles.has(member.role)) continue;
      members.push({
        itemId: item.id,
        setId: set.id,
        role: member.role,
        destination: member.destination,
        digest: member.ref.digest,
        bytes: member.ref.bytes,
        mediaType: member.ref.mediaType,
      });
    }
  }
  return members;
}

/** Required dependency bytes plus matching selected pointers already in this exact tree. */
export function validationLfsMembersForItem(
  state: FactoryState,
  item: WorkItem,
  checkout: string,
  commit: string,
): ValidationLfsMember[] {
  const items = new Map(state.graph.items.map((entry) => [entry.id, entry]));
  const relevant = new Set<string>();
  const visit = (id: string): void => {
    if (relevant.has(id)) return;
    relevant.add(id);
    for (const dependency of items.get(id)?.dependencies ?? [])
      visit(dependency);
  };
  visit(item.id);
  const all = selectedRequiredLfsMembers(
    state,
    new Set(state.graph.items.map((entry) => entry.id)),
  );
  return all.filter((member) => {
    if (relevant.has(member.itemId)) return true;
    const expected = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${member.digest}\nsize ${member.bytes}\n`,
      "utf8",
    );
    try {
      return pinnedGitRaw(
        checkout,
        "show",
        `${commit}:${member.destination}`,
      ).equals(expected);
    } catch {
      return false;
    }
  });
}

/** Every selected required-LFS member expected in the integrated Objective tree. */
export function finalValidationLfsMembers(
  state: FactoryState,
): ValidationLfsMember[] {
  return selectedRequiredLfsMembers(
    state,
    new Set(state.graph.items.map((item) => item.id)),
  );
}

export interface HydrationReceipt {
  schemaVersion: 1;
  controllerCapabilitiesDigest: string;
  integratedSha: string;
  integratedTreeSha: string;
  members: {
    itemId: string;
    setId: string;
    role: string;
    destination: string;
    expectedBytes: number;
    observedBytes: number;
    expectedDigest: string;
    observedDigest: string;
    passed: true;
  }[];
  passed: true;
}

export interface SelectedAssetSet {
  itemId: string;
  set: CapturedAssetSet;
}

function expectedHydrationReceipt(
  integratedSha: string,
  integratedTreeSha: string,
  selections: SelectedAssetSet[],
): HydrationReceipt {
  return {
    schemaVersion: 1,
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    integratedSha,
    integratedTreeSha,
    members: selections.flatMap(({ itemId, set }) =>
      set.members.map((member) => ({
        itemId,
        setId: set.id,
        role: member.role,
        destination: member.destination,
        expectedBytes: member.ref.bytes,
        observedBytes: member.ref.bytes,
        expectedDigest: member.ref.digest,
        observedDigest: member.ref.digest,
        passed: true as const,
      })),
    ),
    passed: true,
  };
}

export function assertHydrationReceipt(
  receipt: unknown,
  integratedSha: string,
  integratedTreeSha: string,
  selections: SelectedAssetSet[],
): asserts receipt is HydrationReceipt {
  if (
    JSON.stringify(receipt) !==
    JSON.stringify(
      expectedHydrationReceipt(integratedSha, integratedTreeSha, selections),
    )
  )
    throw new Error(
      "Final hydration receipt differs from the exact integrated selections",
    );
}

export async function verifyHydratedAssets(args: {
  checkout: string;
  workRoot: string;
  integratedSha: string;
  selections: SelectedAssetSet[];
}): Promise<HydrationReceipt | undefined> {
  if (!args.selections.length) return undefined;
  mkdirSync(args.workRoot, { recursive: true });
  const clone = join(args.workRoot, `fresh-${randomUUID()}`);
  let phase = "origin-resolution";
  let receipt: HydrationReceipt | undefined;
  let failure: Error | undefined;
  try {
    const remote = pinnedGit(args.checkout, "remote", "get-url", "origin");
    phase = "tree-resolution";
    const integratedTreeSha = pinnedGit(
      args.checkout,
      "rev-parse",
      `${args.integratedSha}^{tree}`,
    );
    phase = "clone";
    await gitAsync(
      args.workRoot,
      "clone",
      "--no-checkout",
      remote,
      resolve(clone),
    );
    phase = "lfs-setup";
    await gitAsync(clone, "lfs", "install", "--local", "--skip-repo");
    phase = "integrated-checkout";
    await gitAsync(clone, "checkout", "--detach", args.integratedSha);
    phase = "lfs-pull";
    await gitAsync(clone, "lfs", "pull");
    phase = "integrated-identity";
    if (pinnedGit(clone, "rev-parse", "HEAD") !== args.integratedSha)
      throw new Error("Fresh clone resolved a different integrated commit");
    phase = "selected-byte-verification";
    for (const { set } of args.selections)
      for (const member of set.members) {
        const path = join(clone, member.destination);
        if (!existsSync(path) || !lstatSync(path).isFile())
          throw new Error(`Hydrated asset is missing: ${member.destination}`);
        const fd = openSync(path, "r");
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          const expectedBytes = fstatSync(fd).size;
          for await (const chunk of createReadStream(path, {
            fd,
            autoClose: false,
          })) {
            currentProcessSignal()?.throwIfAborted();
            hash.update(chunk);
            bytes += chunk.length;
          }
          if (bytes !== expectedBytes)
            throw new Error("Hydrated file changed during verification");
        } finally {
          closeSync(fd);
        }
        if (
          bytes !== member.ref.bytes ||
          hash.digest("hex") !== member.ref.digest
        )
          throw new Error(
            `Hydrated asset differs from selected bytes: ${member.destination}`,
          );
      }
    currentProcessSignal()?.throwIfAborted();
    receipt = expectedHydrationReceipt(
      args.integratedSha,
      integratedTreeSha,
      args.selections,
    );
  } catch (cause) {
    failure = new Error(
      `Fresh-clone hydration verification failed during ${phase}`,
      { cause },
    );
  }
  try {
    if (!hasUnresolvedSubprocesses())
      rmSync(clone, { recursive: true, force: true });
    else
      failure ??= new Error(
        "Fresh-clone hydration subprocess ownership unresolved; clone retained",
      );
  } catch {
    failure ??= new Error(
      "Fresh-clone hydration verification failed during cleanup",
    );
  }
  if (failure) throw failure;
  return receipt;
}
