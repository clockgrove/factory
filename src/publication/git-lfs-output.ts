import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  canonicalLfsPointer,
  lfsObjectReceiptDigest,
  LfsObjectReceiptSchema,
  normalizeArtifact,
  verifyArtifact,
  type LfsObjectReceipt,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import {
  materializePayload,
  regularContentPath,
  sha256,
  verifyPayload,
} from "../execution/artifact-content.js";
import {
  contentTransferRef,
  persistContentTransfer,
  recoverContentTransfer,
  resumeContentTransfer,
  type ContentTransferIdentity,
  type ContentTransferStore,
} from "../control/content-transfers.js";
import { runContainedProcess } from "../runtime/process-group.js";
import { resolveGitLfsTool } from "../repository-profiles/git-lfs.js";
import {
  artifactFromGitRange,
  type CollectedArtifact,
  type PendingLfsObject,
} from "../runtime/artifact-patch.js";
import { destinationAllowedByPolicy } from "../protocol/policy.js";

const gitOid = (value: Buffer) =>
  createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface LfsObjectStore extends ContentTransferStore {}

export interface LfsOutputTransport {
  preflight(
    repository: string,
    expectedRepository?: string,
    allowedNetworkDestinations?: string[],
  ): Promise<{
    toolVersion: string;
    remoteDigest: string;
    remoteHost: string;
    endpoint: string;
  }>;
  upload(args: {
    repository: string;
    object: PendingLfsObject;
    endpoint: string;
  }): Promise<"uploaded" | "already-present">;
  read(args: {
    repository: string;
    object: Pick<PendingLfsObject, "path" | "oid" | "size">;
    resultTreeSha: string;
    baseSha: string;
    endpoint: string;
  }): Promise<Buffer>;
}

export interface LfsArtifactAuthority {
  repository: string;
  objective: number;
  workItem: number;
  attempt: number;
  runId: string;
  directorEpoch: number;
  policyDigest: string;
}

const receiptRef = (args: {
  authority: LfsArtifactAuthority;
  baseSha: string;
  path: string;
  oid: string;
}) =>
  `refs/clockgrove-factory/lfs-object-receipts/${digest({
    repository: args.authority.repository.toLowerCase(),
    objective: args.authority.objective,
    workItem: args.authority.workItem,
    attempt: args.authority.attempt,
    runId: args.authority.runId,
    directorEpoch: args.authority.directorEpoch,
    policyDigest: args.authority.policyDigest,
    baseSha: args.baseSha,
    path: args.path,
    oid: args.oid,
  })}`;

function transferIdentity(args: {
  authority: LfsArtifactAuthority;
  baseSha: string;
  object: PendingLfsObject;
}): ContentTransferIdentity & { domain: "worker-artifact" } {
  return {
    domain: "worker-artifact",
    repository: args.authority.repository,
    objective: args.authority.objective,
    baseSha: args.baseSha,
    requestId: `lfs-${args.authority.workItem}-${args.authority.attempt}-${digest({
      runId: args.authority.runId,
      directorEpoch: args.authority.directorEpoch,
      policyDigest: args.authority.policyDigest,
      path: args.object.path,
      oid: args.object.oid,
    }).slice(0, 32)}`,
    subjectDigest: args.object.oid,
  };
}

async function readReceipt(args: {
  store: LfsObjectStore;
  ref: string;
  expected: { path: string; oid: string; assignmentDigest: string; baseSha: string };
}): Promise<LfsObjectReceipt | null> {
  const commitOid = await args.store.readRef(args.ref);
  if (!commitOid) return null;
  const commit = await args.store.readCommit(commitOid);
  if (commit.oid !== commitOid || commit.parentOids.length !== 0)
    throw new Error("LFS object receipt commit identity differs");
  const blobOid = await args.store.readTreeEntry(commit.treeOid, "lfs-object-receipt.json");
  if (!blobOid) throw new Error("LFS object receipt is missing");
  const bytes = await args.store.readBlob(blobOid);
  if (gitOid(bytes) !== blobOid) throw new Error("LFS object receipt Git identity differs");
  const receipt = LfsObjectReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    receipt.receiptRef !== args.ref ||
    receipt.path !== args.expected.path ||
    receipt.oid !== args.expected.oid ||
    receipt.assignmentDigest !== args.expected.assignmentDigest ||
    receipt.rawTransfer.identity.baseSha !== args.expected.baseSha ||
    commit.message !== `Factory LFS object receipt\n\nFactory-LFS-Object: ${receipt.digest}`
  )
    throw new Error("LFS object receipt authority differs");
  return receipt;
}

async function persistReceipt(args: {
  store: LfsObjectStore;
  receipt: LfsObjectReceipt;
  assertCurrent(): Promise<void>;
}): Promise<LfsObjectReceipt> {
  const bytes = Buffer.from(JSON.stringify(args.receipt));
  await args.assertCurrent();
  const blobOid = await args.store.createBlob(bytes);
  if (blobOid !== gitOid(bytes)) throw new Error("LFS object receipt upload identity differs");
  await args.assertCurrent();
  const treeOid = await args.store.createTree({
    entries: [{ path: "lfs-object-receipt.json", mode: "100644", type: "blob", sha: blobOid }],
  });
  await args.assertCurrent();
  const commitOid = await args.store.createCommit({
    treeOid,
    parentOids: [],
    message: `Factory LFS object receipt\n\nFactory-LFS-Object: ${args.receipt.digest}`,
  });
  await args.assertCurrent();
  let created = false;
  try {
    created = await args.store.createRef(args.receipt.receiptRef, commitOid);
  } catch {
    /* Reconcile an ambiguous immutable ref creation below. */
  }
  const winner = created ? commitOid : await args.store.readRef(args.receipt.receiptRef);
  if (!winner) throw new Error("LFS object receipt publication is unresolved");
  const observed = await readReceipt({
    store: args.store,
    ref: args.receipt.receiptRef,
    expected: {
      path: args.receipt.path,
      oid: args.receipt.oid,
      assignmentDigest: args.receipt.assignmentDigest,
      baseSha: args.receipt.rawTransfer.identity.baseSha,
    },
  });
  if (!observed || observed.digest !== args.receipt.digest)
    throw new Error("LFS object receipt publication conflicted");
  return observed;
}

/** Finalize raw worker output before the ordinary artifact checkpoint is made durable. */
export async function finalizeLfsArtifact(args: {
  store: LfsObjectStore;
  artifact: CollectedArtifact;
  authority: LfsArtifactAuthority;
  repositoryPath: string;
  allowedNetworkDestinations: string[];
  assertCurrent(): Promise<void>;
  transport?: LfsOutputTransport;
}): Promise<NormalizedArtifact> {
  const pending = args.artifact.pendingLfsObjects;
  if (!pending?.length) return verifyArtifact(args.artifact);
  const transport = args.transport ?? new GitLfsOutputTransport();
  const receipts: LfsObjectReceipt[] = [];
  let preflight:
    | {
        toolVersion: string;
        remoteDigest: string;
        remoteHost: string;
        endpoint: string;
      }
    | undefined;
  for (const object of [...pending].sort((left, right) => left.path.localeCompare(right.path))) {
    const identity = transferIdentity({
      authority: args.authority,
      baseSha: args.artifact.baseSha,
      object,
    });
    const ref = receiptRef({
      authority: args.authority,
      baseSha: args.artifact.baseSha,
      path: object.path,
      oid: object.oid,
    });
    let receipt = await readReceipt({
      store: args.store,
      ref,
      expected: {
        path: object.path,
        oid: object.oid,
        assignmentDigest: object.assignmentDigest,
        baseSha: args.artifact.baseSha,
      },
    });
    let transfer;
    if (!receipt) {
      await verifyPayload(object.payload);
      if (!preflight) {
        await args.assertCurrent();
        preflight = await transport.preflight(
          args.repositoryPath,
          args.authority.repository.toLowerCase(),
          args.allowedNetworkDestinations,
        );
      }
      const remote = preflight;
      if (!destinationAllowedByPolicy(remote.remoteHost, args.allowedNetworkDestinations))
        throw new Error(
          `Git LFS endpoint ${remote.remoteHost} is outside the immutable run-policy egress authority`,
        );
      transfer = await resumeContentTransfer({
        store: args.store,
        identity,
        assertCurrent: args.assertCurrent,
      });
      transfer ??= await persistContentTransfer({
        store: args.store,
        identity,
        payload: object.payload,
        assertCurrent: args.assertCurrent,
      });
      await args.assertCurrent();
      const uploadOutcome = await transport.upload({
        repository: args.repositoryPath,
        object,
        endpoint: remote.endpoint,
      });
      await args.assertCurrent();
      const downloaded = await transport.read({
        repository: args.repositoryPath,
        object,
        resultTreeSha: args.artifact.fileManifest!.resultTreeSha,
        baseSha: args.artifact.baseSha,
        endpoint: remote.endpoint,
      });
      if (downloaded.length !== object.size || sha256(downloaded) !== object.oid)
        throw new Error("independently downloaded LFS object differs from uploaded raw bytes");
      const core = {
        protocol: "clockgrove.factory/lfs-object-receipt" as const,
        path: object.path,
        mode: object.mode,
        oid: object.oid,
        size: object.size,
        assignmentDigest: object.assignmentDigest,
        payload: object.payload,
        rawTransfer: {
          identity,
          ref: transfer.transferRef,
          intentCommit: transfer.intentCommit,
          readyCommit: transfer.readyCommit,
        },
        toolVersion: remote.toolVersion,
        remoteDigest: remote.remoteDigest,
        uploadOutcome,
        readVerified: true as const,
        receiptRef: ref,
      };
      receipt = await persistReceipt({
        store: args.store,
        receipt: LfsObjectReceiptSchema.parse({
          ...core,
          digest: lfsObjectReceiptDigest(core),
        }),
        assertCurrent: args.assertCurrent,
      });
    } else {
      transfer = await recoverContentTransfer({ store: args.store, identity });
    }
    if (
      !transfer ||
      transfer.transferRef !== contentTransferRef(identity) ||
      transfer.intentCommit !== receipt.rawTransfer.intentCommit ||
      transfer.readyCommit !== receipt.rawTransfer.readyCommit ||
      transfer.payload.digest !== object.oid ||
      transfer.payload.bytes !== object.size ||
      receipt.rawTransfer.ref !== transfer.transferRef
    )
      throw new Error("LFS raw content transfer identity differs");
    receipts.push(receipt);
  }
  const { pendingLfsObjects: _pending, ...artifact } = args.artifact;
  return normalizeArtifact({
    baseSha: artifact.baseSha,
    patch: artifact.patch,
    ...(artifact.payload ? { payload: artifact.payload } : {}),
    ...(artifact.fileManifest ? { fileManifest: artifact.fileManifest } : {}),
    lfsObjects: receipts,
    changedPaths: artifact.changedPaths,
    commands: artifact.commands,
    logs: artifact.logs,
    outcome: artifact.outcome,
    ...(artifact.reason ? { reason: artifact.reason } : {}),
    ...(artifact.findings ? { findings: artifact.findings } : {}),
    createdAt: new Date(artifact.createdAt),
  });
}

/** Reconstruct a native rebase/sibling candidate from committed pointers only
 * after the source artifact's durable raw transfers have been authenticated.
 * The result is finalized again so every receipt names the target base. */
export async function reconstructNativeLfsArtifact(args: {
  store: LfsObjectStore;
  authority: LfsArtifactAuthority;
  repositoryPath: string;
  allowedNetworkDestinations: string[];
  assertCurrent(): Promise<void>;
  loadSourceArtifact(): Promise<NormalizedArtifact>;
  range: {
    sourceBaseSha: string;
    headSha: string;
    baseSha: string;
    changedPaths: string[];
    emptyReason?: string;
  };
  transport?: LfsOutputTransport;
}): Promise<NormalizedArtifact> {
  let sourceArtifact: Promise<NormalizedArtifact> | undefined;
  const collected = await artifactFromGitRange({
    repository: args.repositoryPath,
    ...args.range,
    resolveSourceLfsObjects: async () => {
      await args.assertCurrent();
      sourceArtifact ??= args.loadSourceArtifact();
      const artifact = verifyArtifact(await sourceArtifact);
      await args.assertCurrent();
      await restoreLfsArtifactContent({ store: args.store, artifact });
      return artifact.lfsObjects ?? [];
    },
  });
  if (collected.pendingLfsObjects?.length) await args.assertCurrent();
  return finalizeLfsArtifact({
    store: args.store,
    artifact: collected,
    authority: args.authority,
    repositoryPath: args.repositoryPath,
    allowedNetworkDestinations: args.allowedNetworkDestinations,
    assertCurrent: args.assertCurrent,
    ...(args.transport ? { transport: args.transport } : {}),
  });
}

export async function restoreLfsArtifactContent(args: {
  store: LfsObjectStore;
  artifact: NormalizedArtifact;
}): Promise<void> {
  for (const receipt of args.artifact.lfsObjects ?? []) {
    const observedReceipt = await readReceipt({
      store: args.store,
      ref: receipt.receiptRef,
      expected: {
        path: receipt.path,
        oid: receipt.oid,
        assignmentDigest: receipt.assignmentDigest,
        baseSha: args.artifact.baseSha,
      },
    });
    if (
      !observedReceipt ||
      observedReceipt.digest !== receipt.digest ||
      JSON.stringify(observedReceipt) !== JSON.stringify(receipt)
    )
      throw new Error("durable LFS upload receipt differs from its artifact binding");
    const transfer = await recoverContentTransfer({
      store: args.store,
      identity: receipt.rawTransfer.identity,
    });
    if (
      !transfer ||
      transfer.transferRef !== receipt.rawTransfer.ref ||
      transfer.intentCommit !== receipt.rawTransfer.intentCommit ||
      transfer.readyCommit !== receipt.rawTransfer.readyCommit ||
      JSON.stringify(transfer.payload) !== JSON.stringify(receipt.payload)
    )
      throw new Error("durable LFS raw content transfer differs from its artifact receipt");
  }
}

export async function materializeLfsArtifactContent(
  root: string,
  artifact: NormalizedArtifact,
): Promise<void> {
  for (const receipt of artifact.lfsObjects ?? []) {
    const target = await regularContentPath(root, receipt.path);
    const pointer = await readFile(target);
    if (!pointer.equals(canonicalLfsPointer(receipt.oid, receipt.size)))
      throw new Error(`materialized LFS pointer identity differs: ${receipt.path}`);
    const temporary = `${target}.factory-lfs-${process.pid}`;
    await materializePayload(receipt.payload, temporary);
    await chmod(temporary, receipt.mode === "100755" ? 0o700 : 0o600);
    await rm(target);
    await import("node:fs/promises").then(({ rename }) => rename(temporary, target));
  }
}

export async function verifyMaterializedLfsContent(
  root: string,
  artifact: NormalizedArtifact,
): Promise<void> {
  for (const receipt of artifact.lfsObjects ?? []) {
    const path = await regularContentPath(root, receipt.path);
    const info = await lstat(path);
    if (!info.isFile() || info.size !== receipt.size)
      throw new Error(`materialized LFS object size differs: ${receipt.path}`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (bytes <= receipt.size) {
        const read = await file.read(buffer, 0, Math.min(buffer.length, receipt.size + 1 - bytes));
        if (!read.bytesRead) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        bytes += read.bytesRead;
      }
      if (bytes !== receipt.size || hash.digest("hex") !== receipt.oid)
        throw new Error(`materialized LFS object digest differs: ${receipt.path}`);
    } finally {
      await file.close();
    }
  }
}

function lfsEnvironment(storage?: string, endpoint?: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name === "GIT_DIR" ||
      name === "GIT_WORK_TREE" ||
      name === "GIT_INDEX_FILE" ||
      name === "GIT_OBJECT_DIRECTORY" ||
      name === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
      name === "GIT_CONFIG_PARAMETERS" ||
      name === "GIT_CONFIG_COUNT" ||
      /^GIT_CONFIG_(?:KEY|VALUE)_/.test(name)
    )
      delete environment[name];
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GIT_LFS_SKIP_SMUDGE = "1";
  delete environment.GIT_LFS_SKIP_PUSH;
  const overrides = [
    ...(storage ? [["lfs.storage", storage] as const] : []),
    ...(endpoint ? [["lfs.url", endpoint] as const, ["lfs.pushurl", endpoint] as const] : []),
  ];
  if (overrides.length) environment.GIT_CONFIG_COUNT = String(overrides.length);
  for (const [index, [key, value]] of overrides.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}

async function runLfs(args: {
  repository: string;
  executable: string;
  command: string[];
  storage?: string;
  endpoint?: string;
}): Promise<string> {
  const result = await runContainedProcess({
    command: args.executable,
    args: args.command,
    cwd: resolve(args.repository),
    env: lfsEnvironment(args.storage, args.endpoint),
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error("authenticated Git LFS operation failed; verify remote access and credentials");
  return result.stdout;
}

/** Resolve the effective origin endpoint reported by Git LFS, including .lfsconfig. */
export function resolvedGitLfsEndpoint(args: {
  environment: string;
  expectedHost: string;
  expectedRepository: string;
}): string {
  const endpointLines = [
    ...args.environment.matchAll(/^Endpoint(?: \(origin\))?=(\S+)(?: \([^\n]*\))?$/gm),
  ];
  const endpoint =
    endpointLines.find((match) => match[0].startsWith("Endpoint (origin)="))?.[1] ??
    endpointLines.find((match) => match[0].startsWith("Endpoint="))?.[1];
  if (!endpoint) throw new Error("Git LFS origin endpoint is unavailable");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Git LFS origin endpoint is invalid");
  }
  const host = args.expectedHost.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hostname.toLowerCase() !== host
  )
    throw new Error("Git LFS origin endpoint is outside the authenticated repository authority");
  const escapedRepository = args.expectedRepository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^/${escapedRepository}(?:\\.git)?/info/lfs/?$`, "i").test(parsed.pathname))
    throw new Error("Git LFS origin endpoint does not match the authenticated repository");
  return endpoint;
}

export function assertLfsReceiptRemoteIdentity(
  artifact: NormalizedArtifact,
  remote: { toolVersion: string; remoteDigest: string },
): void {
  if (
    (artifact.lfsObjects ?? []).some(
      (receipt) =>
        receipt.toolVersion !== remote.toolVersion || receipt.remoteDigest !== remote.remoteDigest,
    )
  )
    throw new Error("Git LFS remote identity changed after artifact verification");
}

/** Recheck the exact authenticated remote objects at the mutable ref boundary.
 * Upload receipts remain immutable historical evidence; this assertion proves
 * that their objects are still readable immediately before publication. */
export async function assertRemoteLfsObjectsCurrent(args: {
  artifacts: readonly NormalizedArtifact[];
  repositoryPath: string;
  allowedNetworkDestinations: string[];
  transport?: LfsOutputTransport;
}): Promise<void> {
  const artifacts = args.artifacts.map((artifact) => verifyArtifact(artifact));
  const withLfs = artifacts.filter((artifact) => artifact.lfsObjects?.length);
  if (withLfs.length === 0) return;

  const repositories = new Set(
    withLfs.flatMap((artifact) =>
      artifact.lfsObjects!.map((receipt) => receipt.rawTransfer.identity.repository.toLowerCase()),
    ),
  );
  if (repositories.size !== 1)
    throw new Error("Git LFS receipts name conflicting authenticated repositories");
  const expectedRepository = [...repositories][0]!;
  const transport = args.transport ?? new GitLfsOutputTransport();
  const remote = await transport.preflight(
    args.repositoryPath,
    expectedRepository,
    args.allowedNetworkDestinations,
  );
  if (!destinationAllowedByPolicy(remote.remoteHost, args.allowedNetworkDestinations))
    throw new Error("Git LFS publication endpoint is outside run-policy egress");

  const checked = new Set<string>();
  for (const artifact of withLfs) {
    assertLfsReceiptRemoteIdentity(artifact, remote);
    const resultTreeSha = artifact.fileManifest?.resultTreeSha;
    if (!resultTreeSha) throw new Error("LFS publication artifact lacks its exact result tree");
    for (const receipt of artifact.lfsObjects!) {
      const objectIdentity = JSON.stringify({
        repository: expectedRepository,
        remoteDigest: receipt.remoteDigest,
        oid: receipt.oid,
        size: receipt.size,
      });
      if (checked.has(objectIdentity)) continue;
      checked.add(objectIdentity);
      const bytes = await transport.read({
        repository: args.repositoryPath,
        object: receipt,
        resultTreeSha,
        baseSha: artifact.baseSha,
        endpoint: remote.endpoint,
      });
      if (bytes.length !== receipt.size || sha256(bytes) !== receipt.oid)
        throw new Error("remote LFS object changed before pointer publication");
    }
  }
}

/** Direct Git LFS CLI adapter. It never invokes clean/smudge filters or hooks. */
export class GitLfsOutputTransport implements LfsOutputTransport {
  #tool: Awaited<ReturnType<typeof resolveGitLfsTool>> | undefined;

  async preflight(
    repository: string,
    expectedRepository?: string,
    allowedNetworkDestinations: string[] = [],
  ) {
    this.#tool ??= await resolveGitLfsTool();
    const remote = await runContainedProcess({
      command: "git",
      args: [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "config",
        "--get",
        "remote.origin.url",
      ],
      cwd: resolve(repository),
      env: lfsEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
    });
    const url = remote.stdout.trim();
    if (remote.exitCode !== 0 || !url || /^(?:file:|\/|\.\.?\/)/.test(url))
      throw new Error("Git LFS output requires a configured non-local origin remote");
    const host = (process.env.GH_HOST || "github.com").toLowerCase();
    const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remoteMatch = new RegExp(
      `^(?:https://${escapedHost}/|ssh://git@${escapedHost}/|git@${escapedHost}:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?$`,
      "i",
    ).exec(url);
    if (
      !remoteMatch ||
      (expectedRepository && remoteMatch[1]!.toLowerCase() !== expectedRepository)
    )
      throw new Error("Git LFS origin does not match the authenticated Factory repository");
    if (!destinationAllowedByPolicy(host, allowedNetworkDestinations))
      throw new Error(
        `Git LFS endpoint ${host} is outside the immutable run-policy egress authority`,
      );
    const custom = await runContainedProcess({
      command: "git",
      args: [
        "--no-optional-locks",
        "config",
        "--get-regexp",
        "^(lfs\\.(url|pushurl|storage|standalonetransferagent)|remote\\.origin\\.lfs(push)?url|lfs\\.customtransfer\\.)",
      ],
      cwd: resolve(repository),
      env: lfsEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
    });
    if (custom.timedOut || (custom.exitCode !== 0 && custom.exitCode !== 1))
      throw new Error("Git LFS configuration inspection failed");
    if (custom.exitCode === 0 && custom.stdout.trim())
      throw new Error(
        "custom Git LFS endpoints or transfer agents are outside the output capability",
      );
    const readable = await runContainedProcess({
      command: "git",
      args: [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "ls-remote",
        "--heads",
        "origin",
      ],
      cwd: resolve(repository),
      env: lfsEnvironment(),
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (readable.exitCode !== 0 || readable.timedOut)
      throw new Error("authenticated Git LFS origin read preflight failed");
    const environment = await runLfs({
      repository,
      executable: this.#tool.path,
      command: ["env"],
    });
    const repositoryName = remoteMatch[1]!;
    const endpoint = resolvedGitLfsEndpoint({
      environment,
      expectedHost: host,
      expectedRepository: repositoryName,
    });
    return {
      toolVersion: this.#tool.version,
      remoteDigest: digest({ remote: url, endpoint, tool: this.#tool.version }),
      remoteHost: host,
      endpoint,
    };
  }

  async upload(args: { repository: string; object: PendingLfsObject; endpoint: string }) {
    this.#tool ??= await resolveGitLfsTool();
    const root = await mkdtemp(join(tmpdir(), "factory-lfs-upload-"));
    try {
      const storage = join(root, "storage");
      const objectPath = join(
        storage,
        "objects",
        args.object.oid.slice(0, 2),
        args.object.oid.slice(2, 4),
        args.object.oid,
      );
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(dirname(objectPath), { recursive: true }),
      );
      await materializePayload(args.object.payload, objectPath);
      await runLfs({
        repository: args.repository,
        executable: this.#tool.path,
        command: ["push", "--object-id", "origin", args.object.oid],
        storage,
        endpoint: args.endpoint,
      });
      return "uploaded" as const;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async read(args: {
    repository: string;
    object: Pick<PendingLfsObject, "path" | "oid" | "size">;
    resultTreeSha: string;
    baseSha: string;
    endpoint: string;
  }) {
    this.#tool ??= await resolveGitLfsTool();
    const root = await mkdtemp(join(tmpdir(), "factory-lfs-read-"));
    try {
      const storage = join(root, "storage");
      const committed = await runContainedProcess({
        command: "git",
        args: [
          "--no-optional-locks",
          "-c",
          "core.hooksPath=/dev/null",
          "commit-tree",
          args.resultTreeSha,
          "-p",
          args.baseSha,
        ],
        cwd: resolve(args.repository),
        env: {
          ...lfsEnvironment(),
          GIT_AUTHOR_NAME: "Factory",
          GIT_AUTHOR_EMAIL: "factory@invalid",
          GIT_COMMITTER_NAME: "Factory",
          GIT_COMMITTER_EMAIL: "factory@invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
        stdin: { text: "Factory LFS verification\n", maxBytes: 1024 },
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      const commit = committed.stdout.trim();
      if (committed.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit))
        throw new Error("LFS verification commit construction failed");
      await runLfs({
        repository: args.repository,
        executable: this.#tool.path,
        command: ["fetch", `--include=${args.object.path}`, "--exclude=", "origin", commit],
        storage,
        endpoint: args.endpoint,
      });
      const path = join(
        storage,
        "objects",
        args.object.oid.slice(0, 2),
        args.object.oid.slice(2, 4),
        args.object.oid,
      );
      const absolute = await realpath(path);
      if (!isAbsolute(absolute) || !absolute.startsWith(`${realpathSyncSafe(storage)}/`))
        throw new Error("downloaded LFS object escaped isolated storage");
      return readFile(absolute);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function realpathSyncSafe(path: string): string {
  return resolve(path);
}
