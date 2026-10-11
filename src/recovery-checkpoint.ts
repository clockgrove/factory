import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type FactoryConfig,
  factoryAuthorityDigest,
  factoryConfigDigest,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import { attachFault, decision } from "./fault.js";
import {
  linuxProcessIdentity,
  pinnedGitCommand,
  pinnedGitEnvironment,
  releaseGuard,
  subprocessAsync,
  takeGuard,
  UnsettledSubprocessError,
} from "./process.js";
import type { ControllerLock } from "./state-store.js";

export interface GitPersistenceConfig {
  remote: string;
  ref: string;
  visibility: "private" | "public";
  scope: "private-history" | "repository-knowledge";
  maxBytes: number;
  maxFiles: number;
  timeoutMs: number;
  coalesceMs: number;
}
export type RecoveryCheckpointFileKind =
  | "continuation"
  | "pre-state"
  | "memory-binding"
  | "learning-original"
  | "content"
  | "git-pack"
  | "historical";
export interface RecoveryCheckpointFile {
  kind: RecoveryCheckpointFileKind;
  path: string;
  ref: ContentRef;
  visibility: "private" | "repository";
}
export interface RecoveryCheckpointGap {
  path: string;
  reason: string;
  availability: string;
  required?: boolean;
}
export interface RecoveryCheckpointClosure {
  files: RecoveryCheckpointFile[];
  contentRefs: ContentRef[];
  gitObjects?: { commitSha: string; role: string }[];
  gaps: RecoveryCheckpointGap[];
}
export interface RecoveryCheckpointBinding {
  repository: string;
  remoteDigest: string;
  ref: string;
  visibility: GitPersistenceConfig["visibility"];
  scope: GitPersistenceConfig["scope"];
}
export interface RecoveryCheckpointManifest extends RecoveryCheckpointClosure {
  schemaVersion: 1;
  binding: RecoveryCheckpointBinding;
  createdAt: string;
  sequence: number;
  /** Publisher authority; individual historical records retain their original bindings. */
  authority?: RecoveryCheckpointAuthority;
}
export interface RecoveryCheckpointHostLayout {
  checkout: string;
  stateRoot: string;
}
export interface RecoveryCheckpointAuthority {
  schemaVersion: 1;
  authorityDigest: string;
  configDigest: string;
  hostLayout: RecoveryCheckpointHostLayout;
}
export interface VerifiedRecoveryCheckpoint {
  manifest: RecoveryCheckpointManifest;
  commitSha: string;
  remoteTip: string;
  payloadDigest: string;
  manifestBytes: Uint8Array;
  readVerifiedBlob(ref: ContentRef): Promise<Uint8Array>;
  /** Exact first-dispatch ancestry, requested only by supported cancellation. */
  queueOwnerLineage?: VerifiedQueueOwnerLineage;
}
export interface QueueCheckpointWitness {
  commitSha: string;
  manifest: ContentRef;
}
export interface VerifiedQueueOwnerLineage {
  checkpoints: {
    before: QueueCheckpointWitness;
    claimed: QueueCheckpointWitness;
    initial: QueueCheckpointWitness;
  };
  originalClaim: ContentRef;
  initialSnapshot: ContentRef;
  bodies: { ref: ContentRef; bytes: Uint8Array }[];
}
export interface QueueOwnerLineageRequest {
  objective: number;
  claimId: string;
  runId: string;
}
export interface RecoveryCheckpointRestoredBaseline {
  schemaVersion: 1;
  source: "verified-restoration";
  commitSha: string;
  payloadDigest: string;
  closureDigest: string;
  sequence: number;
  at: string;
  authority: RecoveryCheckpointAuthority;
  localConfigDigest: string;
  localHostLayout: RecoveryCheckpointHostLayout;
  transportOutcome: "unavailable";
  priorHold?: { kind: "needs-restore"; error?: string };
}
interface CheckpointAttempt {
  base?: string;
  candidate: string;
  payloadDigest: string;
  sequence: number;
  preparedAt: string;
  submittedAt?: string;
  status: "prepared" | "submitted" | "acknowledged" | "unknown" | "conflict";
  transportOutcome: "not-dispatched" | "response-success" | "unknown";
}
interface CheckpointJournal {
  schemaVersion: 1;
  binding: RecoveryCheckpointBinding;
  sequence: number;
  acknowledgedSequence: number;
  dirtySince?: string;
  changed: { path: string; kind: string }[];
  attempts: CheckpointAttempt[];
  lastAcknowledged?: {
    commitSha: string;
    payloadDigest: string;
    at: string;
    sequence: number;
  };
  error?: string;
  hold?: "conflict" | "needs-restore";
  retentionGaps?: CheckpointRetentionGap[];
  restoredBaseline?: RecoveryCheckpointRestoredBaseline;
}
export interface CheckpointRetentionGap {
  kind: "accounting-receipt";
  path: string;
  digest: string;
  reason: "local-retention-unavailable";
  observedAt: string;
}
export interface RecoveryCheckpointInspection {
  binding: RecoveryCheckpointBinding;
  commitSha: string;
  remoteTip: string;
  current: {
    manifestBytes: number;
    logicalFileBytes: number;
    uniqueBodyBytes: number;
    uniqueBodies: number;
    logicalFiles: number;
  };
  reachableHistory:
    | { availability: "available"; logicalObjectBytes: number; objects: number }
    | {
        availability: "unavailable";
        reason: "bounded-inspection-unavailable";
      };
  storage: "git-logical-bytes";
  capacity: {
    limits: { maxBytes: number; maxFiles: number; manifestBufferBytes: number };
    current: {
      bytes: number;
      files: number;
      byteHeadroom: number;
      fileHeadroom: number;
    };
    cancellationAncestry:
      | { availability: "available"; traversals: QueueLineageCapacity[] }
      | { availability: "unavailable"; reason: "not-traversed" };
  };
}
interface QueueLineageCapacity {
  commits: number;
  manifestTransportBytes: number;
  retainedOriginalBytes: number;
  chargedBytes: number;
  byteHeadroom: number;
  commitHeadroom: number;
  manifestBufferHeadroom: number;
}
export interface RecoveryCheckpointStatus {
  enabled: boolean;
  durability: "local-only" | "verified-git";
  status:
    | "local-only"
    | "pending"
    | "acknowledged"
    | "unknown"
    | "conflict"
    | "needs-restore"
    | "failed";
  pendingChanges: boolean;
  unsyncedSince?: string;
  lastAcknowledged?: CheckpointJournal["lastAcknowledged"];
  attemptedCommit?: string;
  attemptedBase?: string;
  attemptedTransportOutcome?: CheckpointAttempt["transportOutcome"];
  error?: string;
  coalesceMs?: number;
  overdue?: boolean;
  scope?: GitPersistenceConfig["scope"];
  protectedContinuation: boolean;
  retentionGaps?: CheckpointRetentionGap[];
  restoredBaseline?: RecoveryCheckpointRestoredBaseline;
}
export class CheckpointAdmissionFailure extends Error {
  knownNotDispatched: boolean;
  constructor(
    message: string,
    readonly boundary:
      | "before-effect"
      | "settled"
      | "explicit" = "before-effect",
  ) {
    super(message);
    this.knownNotDispatched = boundary === "before-effect";
    attachFault(
      this,
      decision(
        "Recovery checkpoint admission or retention is unavailable; preserve the retained owner and receipt",
        `Checkpoint boundary: ${boundary}`,
      ),
    );
  }
}
export function markCheckpointEffectDispatched(
  error: CheckpointAdmissionFailure,
): void {
  error.knownNotDispatched = false;
}
class CheckpointConflict extends Error {}
class CheckpointRestoreRequired extends Error {}
export function isCheckpointAdmissionFailure(
  error: unknown,
): error is CheckpointAdmissionFailure {
  return error instanceof CheckpointAdmissionFailure;
}
interface HistoricalManifestSummary {
  sequence: number;
  files: readonly RecoveryCheckpointFile[];
}
interface QueueVerificationContext {
  key: string;
  directory?: string;
  serial: Promise<void>;
  closed: boolean;
  quarantined: boolean;
  summaries: Map<string, HistoricalManifestSummary>;
  summaryBytes: number;
}
const scopes = new AsyncLocalStorage<{
  config: FactoryConfig;
  buildClosure: () => Promise<RecoveryCheckpointClosure>;
  operation?: {
    completion?: string;
    activeChildren: number;
    closed: boolean;
  };
  verification?: QueueVerificationContext;
}>();
export function hasPrivateCheckpointScope(): boolean {
  const scope = scopes.getStore();
  return Boolean(scope && settings(scope.config)?.scope === "private-history");
}
export function privateCheckpointBounds():
  | { maxBytes: number; maxFiles: number; timeoutMs: number }
  | undefined {
  const scope = scopes.getStore();
  const options = scope ? settings(scope.config) : undefined;
  return options?.scope === "private-history"
    ? {
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
        timeoutMs: options.timeoutMs,
      }
    : undefined;
}
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function keys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key))
  )
    throw new Error("Invalid recovery checkpoint fields");
}
function safePath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Checkpoint paths must be literal relative identities");
}
function assertRef(ref: unknown): asserts ref is ContentRef {
  keys(ref, ["digest", "bytes", "mediaType"]);
  if (
    typeof ref.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    (ref.bytes as number) < 0 ||
    typeof ref.mediaType !== "string" ||
    !ref.mediaType
  )
    throw new Error("Invalid checkpoint content reference");
}
function assertCheckpointRef(ref: unknown): asserts ref is string {
  if (
    typeof ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new Error("Git persistence requires one literal branch ref");
}
export function assertGitPersistenceConfig(
  value: unknown,
): asserts value is GitPersistenceConfig {
  keys(value, [
    "remote",
    "ref",
    "visibility",
    "scope",
    "maxBytes",
    "maxFiles",
    "timeoutMs",
    "coalesceMs",
  ]);
  if (
    typeof value.remote !== "string" ||
    !value.remote ||
    value.remote.startsWith("-") ||
    [...value.remote].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (!isAbsolute(value.remote) && /\s/.test(value.remote)) ||
    !(
      isAbsolute(value.remote) ||
      /^(https:\/\/|ssh:\/\/|git@)/.test(value.remote)
    )
  )
    throw new Error(
      "Git persistence requires an explicit Git URL or absolute local destination",
    );
  assertCheckpointRef(value.ref);
  if (
    !["private", "public"].includes(String(value.visibility)) ||
    !["private-history", "repository-knowledge"].includes(
      String(value.scope),
    ) ||
    (value.scope === "private-history" && value.visibility !== "private")
  )
    throw new Error(
      "Private recovery history requires an explicitly private destination",
    );
  for (const name of ["maxBytes", "maxFiles", "timeoutMs", "coalesceMs"])
    if (
      !Number.isSafeInteger(value[name]) ||
      (value[name] as number) < (name === "coalesceMs" ? 0 : 1)
    )
      throw new Error("Checkpoint bounds must be finite integers");
}
function settings(config: FactoryConfig): GitPersistenceConfig | undefined {
  const value = (
    config as FactoryConfig & { gitPersistence?: GitPersistenceConfig }
  ).gitPersistence;
  if (value) assertGitPersistenceConfig(value);
  return value;
}
function binding(
  config: FactoryConfig,
  options: GitPersistenceConfig,
): RecoveryCheckpointBinding {
  return {
    repository: config.repository,
    remoteDigest: hash(options.remote),
    ref: options.ref,
    visibility: options.visibility,
    scope: options.scope,
  };
}
function hostLayout(config: FactoryConfig): RecoveryCheckpointHostLayout {
  return { checkout: config.checkout, stateRoot: stateRoot(config.repository) };
}
function checkpointAuthority(
  config: FactoryConfig,
): RecoveryCheckpointAuthority {
  return {
    schemaVersion: 1,
    authorityDigest: factoryAuthorityDigest(config),
    configDigest: factoryConfigDigest(config),
    hostLayout: hostLayout(config),
  };
}
function assertHostLayout(
  value: unknown,
): asserts value is RecoveryCheckpointHostLayout {
  keys(value, ["checkout", "stateRoot"]);
  if (
    typeof value.checkout !== "string" ||
    !isAbsolute(value.checkout) ||
    typeof value.stateRoot !== "string" ||
    !isAbsolute(value.stateRoot)
  )
    throw new Error(
      "Checkpoint host layout must retain absolute original paths",
    );
}
export function assertRecoveryCheckpointAuthority(
  value: unknown,
): asserts value is RecoveryCheckpointAuthority {
  keys(value, [
    "schemaVersion",
    "authorityDigest",
    "configDigest",
    "hostLayout",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.authorityDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.authorityDigest) ||
    typeof value.configDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.configDigest)
  )
    throw new Error("Checkpoint publisher authority metadata is invalid");
  assertHostLayout(value.hostLayout);
}
function paths(repository: string) {
  const root = join(stateRoot(repository), "recovery");
  return {
    root,
    journal: join(root, "checkpoint.json"),
    git: join(root, "git.git"),
    mutationGuard: join(root, ".checkpoint.guard"),
    publicationGuard: join(root, ".publication.guard"),
  };
}
function privateFile(path: string): Buffer {
  if (realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new Error("Checkpoint metadata parent resolves through a symlink");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077)
      throw new Error("Checkpoint metadata must be an owned private file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new Error("Checkpoint directory resolves through a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonical(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function journal(
  config: FactoryConfig,
  options: GitPersistenceConfig,
): CheckpointJournal {
  const expected = binding(config, options);
  const path = paths(config.repository).journal;
  if (!existsSync(path))
    return {
      schemaVersion: 1,
      binding: expected,
      sequence: 0,
      acknowledgedSequence: -1,
      changed: [],
      attempts: [],
    };
  const value: CheckpointJournal = JSON.parse(
    privateFile(path).toString("utf8"),
  );
  keys(
    value,
    [
      "schemaVersion",
      "binding",
      "sequence",
      "acknowledgedSequence",
      "changed",
      "attempts",
    ],
    [
      "dirtySince",
      "lastAcknowledged",
      "error",
      "hold",
      "retentionGaps",
      "restoredBaseline",
    ],
  );
  if (
    value.schemaVersion !== 1 ||
    canonical(value.binding) !== canonical(expected) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.acknowledgedSequence) ||
    value.acknowledgedSequence < -1 ||
    value.acknowledgedSequence > value.sequence ||
    !Array.isArray(value.changed) ||
    !Array.isArray(value.attempts)
  )
    throw new Error(
      "Checkpoint journal binding or sequence differs from admitted configuration",
    );
  for (const attempt of value.attempts) {
    keys(
      attempt,
      [
        "candidate",
        "payloadDigest",
        "sequence",
        "preparedAt",
        "status",
        "transportOutcome",
      ],
      ["base", "submittedAt"],
    );
    if (
      !/^[a-f0-9]{40,64}$/.test(attempt.candidate) ||
      (attempt.base !== undefined && !/^[a-f0-9]{40,64}$/.test(attempt.base)) ||
      !/^[a-f0-9]{64}$/.test(attempt.payloadDigest) ||
      ![
        "prepared",
        "submitted",
        "acknowledged",
        "unknown",
        "conflict",
      ].includes(attempt.status) ||
      !["not-dispatched", "response-success", "unknown"].includes(
        attempt.transportOutcome,
      ) ||
      !Number.isSafeInteger(attempt.sequence) ||
      attempt.sequence < 0 ||
      attempt.sequence > value.sequence ||
      (attempt.submittedAt !== undefined &&
        !Number.isFinite(Date.parse(attempt.submittedAt))) ||
      !Number.isFinite(Date.parse(attempt.preparedAt))
    )
      throw new Error("Checkpoint attempted publication identity is invalid");
  }
  for (const changed of value.changed) {
    keys(changed, ["path", "kind"]);
    safePath(changed.path);
    if (typeof changed.kind !== "string" || !changed.kind)
      throw new Error("Invalid pending checkpoint mutation");
  }
  if (value.retentionGaps !== undefined) {
    if (
      !Array.isArray(value.retentionGaps) ||
      value.retentionGaps.length > options.maxFiles
    )
      throw new Error("Invalid required checkpoint retention gaps");
    const identities = new Set<string>();
    for (const gap of value.retentionGaps) {
      keys(gap, ["kind", "path", "digest", "reason", "observedAt"]);
      assertAccountingGapIdentity(gap);
      if (
        gap.kind !== "accounting-receipt" ||
        gap.reason !== "local-retention-unavailable" ||
        !Number.isFinite(Date.parse(gap.observedAt)) ||
        identities.has(gap.path)
      )
        throw new Error("Invalid required checkpoint retention gap identity");
      identities.add(gap.path);
    }
  }
  if (
    value.hold !== undefined &&
    !["conflict", "needs-restore"].includes(value.hold)
  )
    throw new Error("Invalid checkpoint conflict hold");
  if (
    value.dirtySince !== undefined &&
    !Number.isFinite(Date.parse(value.dirtySince))
  )
    throw new Error("Invalid checkpoint loss window");
  if (value.restoredBaseline !== undefined) {
    const restored = value.restoredBaseline;
    keys(
      restored,
      [
        "schemaVersion",
        "source",
        "commitSha",
        "payloadDigest",
        "closureDigest",
        "sequence",
        "at",
        "authority",
        "localConfigDigest",
        "localHostLayout",
        "transportOutcome",
      ],
      ["priorHold"],
    );
    if (
      restored.schemaVersion !== 1 ||
      restored.source !== "verified-restoration" ||
      restored.transportOutcome !== "unavailable" ||
      !/^[a-f0-9]{40,64}$/.test(restored.commitSha) ||
      !/^[a-f0-9]{64}$/.test(restored.payloadDigest) ||
      !/^[a-f0-9]{64}$/.test(restored.closureDigest) ||
      !/^[a-f0-9]{64}$/.test(restored.localConfigDigest) ||
      !Number.isSafeInteger(restored.sequence) ||
      restored.sequence < 0 ||
      restored.sequence > value.sequence ||
      !Number.isFinite(Date.parse(restored.at))
    )
      throw new Error("Invalid verified checkpoint restoration baseline");
    assertRecoveryCheckpointAuthority(restored.authority);
    assertHostLayout(restored.localHostLayout);
    if (restored.priorHold !== undefined) {
      keys(restored.priorHold, ["kind"], ["error"]);
      if (
        restored.priorHold.kind !== "needs-restore" ||
        (restored.priorHold.error !== undefined &&
          typeof restored.priorHold.error !== "string")
      )
        throw new Error("Invalid settled missing-baseline observation");
    }
  }
  if (value.lastAcknowledged) {
    keys(value.lastAcknowledged, [
      "commitSha",
      "payloadDigest",
      "at",
      "sequence",
    ]);
    const acknowledgement = value.lastAcknowledged;
    if (
      !/^[a-f0-9]{40,64}$/.test(acknowledgement.commitSha) ||
      !/^[a-f0-9]{64}$/.test(acknowledgement.payloadDigest) ||
      !Number.isFinite(Date.parse(acknowledgement.at)) ||
      acknowledgement.sequence !== value.acknowledgedSequence ||
      !(
        value.attempts.some(
          (attempt) =>
            attempt.status === "acknowledged" &&
            attempt.candidate === acknowledgement.commitSha &&
            attempt.payloadDigest === acknowledgement.payloadDigest &&
            attempt.sequence === acknowledgement.sequence,
        ) ||
        (value.restoredBaseline?.commitSha === acknowledgement.commitSha &&
          value.restoredBaseline.payloadDigest ===
            acknowledgement.payloadDigest &&
          value.restoredBaseline.sequence === acknowledgement.sequence)
      )
    )
      throw new Error(
        "Checkpoint acknowledgement lacks its exact attempted publication",
      );
  } else if (value.acknowledgedSequence !== -1)
    throw new Error("Checkpoint acknowledged sequence has no verified receipt");
  return value;
}
function mutate(
  config: FactoryConfig,
  options: GitPersistenceConfig,
  update: (record: CheckpointJournal) => void,
): CheckpointJournal {
  const p = paths(config.repository);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  takeGuard(p.mutationGuard);
  try {
    const record = journal(config, options);
    update(record);
    writeAtomic(p.journal, record);
    return record;
  } finally {
    releaseGuard(p.mutationGuard);
  }
}
function status(
  record: CheckpointJournal,
  options?: GitPersistenceConfig,
): RecoveryCheckpointStatus {
  const last = record.attempts.at(-1);
  const hasRetentionGap = Boolean(record.retentionGaps?.length);
  const pendingChanges =
    record.sequence > record.acknowledgedSequence || hasRetentionGap;
  return {
    enabled: true,
    durability: record.lastAcknowledged ? "verified-git" : "local-only",
    status:
      record.hold === "needs-restore"
        ? "needs-restore"
        : record.hold === "conflict" || last?.status === "conflict"
          ? "conflict"
          : last && ["submitted", "prepared", "unknown"].includes(last.status)
            ? "unknown"
            : record.error || hasRetentionGap
              ? "failed"
              : pendingChanges
                ? "pending"
                : "acknowledged",
    pendingChanges,
    ...(hasRetentionGap
      ? { retentionGaps: structuredClone(record.retentionGaps) }
      : {}),
    protectedContinuation:
      options?.scope === "private-history" &&
      Boolean(record.lastAcknowledged) &&
      !pendingChanges &&
      !record.hold &&
      !record.error,
    ...(options ? { scope: options.scope } : {}),
    ...(record.dirtySince ? { unsyncedSince: record.dirtySince } : {}),
    ...(record.lastAcknowledged
      ? { lastAcknowledged: record.lastAcknowledged }
      : {}),
    ...(record.restoredBaseline
      ? { restoredBaseline: structuredClone(record.restoredBaseline) }
      : {}),
    ...(last
      ? {
          attemptedCommit: last.candidate,
          attemptedTransportOutcome: last.transportOutcome,
          ...(last.base ? { attemptedBase: last.base } : {}),
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(options
      ? {
          coalesceMs: options.coalesceMs,
          overdue:
            pendingChanges &&
            (!record.dirtySince ||
              Date.now() - Date.parse(record.dirtySince) >= options.coalesceMs),
        }
      : {}),
  };
}
export function gitPersistenceStatus(
  config: FactoryConfig,
): RecoveryCheckpointStatus {
  const options = settings(config);
  if (!options)
    return {
      enabled: false,
      durability: "local-only",
      status: "local-only",
      pendingChanges: false,
      protectedContinuation: false,
    };
  return status(journal(config, options), options);
}
function assertAccountingGapIdentity(value: {
  path: string;
  digest: string;
}): void {
  if (
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    value.path !== `accounting/${value.digest}.json`
  )
    throw new Error(
      "Required accounting retention gap has an invalid identity",
    );
}
function accountingGapScope(repository: string) {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (scope.config.repository !== repository)
    throw new CheckpointAdmissionFailure(
      "Accounting retention scope differs from its admitted repository",
    );
  const options = settings(scope.config);
  if (!options || options.scope !== "private-history") return undefined;
  return { ...scope, options };
}
function accountingGapIdentity(
  repository: string,
  value: { path: string; digest: string },
) {
  const identity = {
    path: isAbsolute(value.path)
      ? relative(stateRoot(repository), value.path)
      : value.path,
    digest: value.digest,
  };
  assertAccountingGapIdentity(identity);
  return identity;
}
export function checkpointRetentionGaps(
  repository: string,
): CheckpointRetentionGap[] {
  const scope = accountingGapScope(repository);
  return scope
    ? structuredClone(journal(scope.config, scope.options).retentionGaps ?? [])
    : [];
}
export function markAccountingGap(
  repository: string,
  descriptor: {
    path: string;
    digest: string;
    reason: "local-retention-unavailable";
  },
): void {
  const scope = accountingGapScope(repository);
  if (!scope) return;
  const identity = accountingGapIdentity(repository, descriptor);
  if (descriptor.reason !== "local-retention-unavailable")
    throw new Error("Accounting retention gap reason must be sanitized");
  mutate(scope.config, scope.options, (record) => {
    if (record.retentionGaps?.some((gap) => gap.path === identity.path)) return;
    if ((record.retentionGaps?.length ?? 0) >= scope.options.maxFiles)
      throw new Error(
        "Required accounting retention gaps exceed admitted bound",
      );
    record.sequence++;
    if (!Number.isSafeInteger(record.sequence))
      throw new Error("Checkpoint sequence overflow");
    const observedAt = new Date().toISOString();
    record.dirtySince ??= observedAt;
    record.retentionGaps ??= [];
    record.retentionGaps.push({
      kind: "accounting-receipt",
      ...identity,
      reason: descriptor.reason,
      observedAt,
    });
  });
}
export function resolveAccountingGap(
  repository: string,
  descriptor: { path: string; digest: string },
): void {
  const scope = accountingGapScope(repository);
  if (!scope) return;
  const identity = accountingGapIdentity(repository, descriptor);
  const path = join(stateRoot(repository), identity.path);
  if (lstatSync(path).size > scope.options.maxBytes)
    throw new Error(
      "Accounting original exceeds admitted checkpoint byte bound",
    );
  const bytes = privateFile(path);
  if (hash(bytes) !== identity.digest)
    throw new Error(
      "Accounting original differs from its required retention gap",
    );
  new LocalContentStore(join(stateRoot(repository), "content")).readBytes({
    digest: identity.digest,
    bytes: bytes.length,
    mediaType: "application/json",
  });
  mutate(scope.config, scope.options, (record) => {
    record.retentionGaps = record.retentionGaps?.filter(
      (gap) => gap.path !== identity.path,
    );
    if (!record.retentionGaps?.length) delete record.retentionGaps;
  });
}
function assertRetentionResolved(record: CheckpointJournal): void {
  if (record.retentionGaps?.length)
    throw new Error(
      "Required accounting original retention remains unavailable; checkpoint acknowledgement is held",
    );
}
export function markCheckpointDirty(
  repository: string,
  descriptor: { path: string; kind: string },
): void {
  const scope = scopes.getStore();
  if (!scope) return;
  if (scope.config.repository !== repository)
    throw new Error("Checkpoint scope repository differs from mutation");
  if (scope.operation) delete scope.operation.completion;
  const options = settings(scope.config);
  if (!options) return;
  if (
    options.scope === "repository-knowledge" &&
    descriptor.kind !== "memory-binding"
  )
    return;
  descriptor = {
    ...descriptor,
    path: isAbsolute(descriptor.path)
      ? relative(stateRoot(repository), descriptor.path)
      : descriptor.path,
  };
  safePath(descriptor.path);
  mutate(scope.config, options, (record) => {
    record.sequence++;
    if (!Number.isSafeInteger(record.sequence))
      throw new Error("Checkpoint sequence overflow");
    record.dirtySince ??= new Date().toISOString();
    if (
      !record.changed.some(
        (entry) =>
          entry.path === descriptor.path && entry.kind === descriptor.kind,
      )
    )
      record.changed.push(descriptor);
    if (record.changed.length > options.maxFiles)
      throw new Error("Pending checkpoint file count exceeds admitted bound");
  });
}
export function withRecoveryCheckpointScope<T>(
  input: {
    config: FactoryConfig;
    buildClosure: () => Promise<RecoveryCheckpointClosure>;
  },
  task: () => T,
): T {
  const admitted = scopes.getStore();
  if (admitted) {
    if (
      admitted.config.repository !== input.config.repository ||
      factoryConfigDigest(admitted.config) !== factoryConfigDigest(input.config)
    )
      throw new CheckpointAdmissionFailure(
        "Nested checkpoint configuration differs from its admitted repository binding",
      );
    return task();
  }
  return scopes.run(input, task);
}
/** Own only a finite queue-control verifier lifetime; this adds no durability barrier. */
export function withQueueControlVerification<T>(
  input: {
    config: FactoryConfig;
    buildClosure: () => Promise<RecoveryCheckpointClosure>;
  },
  task: () => Promise<T>,
): Promise<T> {
  return withRecoveryCheckpointScope(input, async () => {
    const scope = scopes.getStore();
    if (!scope) throw new Error("Queue verifier has no admitted scope");
    const assertCaptured = (
      owner: QueueVerificationContext,
      closing = false,
    ) => {
      const current = settings(input.config);
      if (
        (owner.closed && !closing) ||
        owner.quarantined ||
        !current ||
        owner.key !== verificationKey(input.config, current)
      )
        throw new Error(
          "Queue verifier is closed, uncertain or has a different admitted binding",
        );
    };
    if (scope.verification) {
      assertCaptured(scope.verification);
      const result = await task();
      assertCaptured(scope.verification);
      return result;
    }
    const options = settings(input.config);
    if (!options) return task();
    const verification: QueueVerificationContext = {
      key: verificationKey(input.config, options),
      serial: Promise.resolve(),
      closed: false,
      quarantined: false,
      summaries: new Map(),
      summaryBytes: 0,
    };
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await scopes.run({ ...scope, verification }, task);
      assertCaptured(verification);
    } catch (error) {
      failed = true;
      failure = error;
    }
    verification.closed = true;
    try {
      await verification.serial;
      if (verification.directory && !verification.quarantined)
        rmSync(verification.directory, { recursive: true, force: true });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      verification.summaries.clear();
    }
    if (failed) throw failure;
    assertCaptured(verification, true);
    return result as T;
  });
}
/** A producer completes durability before returning; an explicit forwarding caller may reuse it. */
export function withRecoveryCheckpointOperation<T>(
  input: {
    config: FactoryConfig;
    buildClosure: () => Promise<RecoveryCheckpointClosure>;
  },
  task: () => Promise<T>,
  options: {
    /** Only a caller forwarding the terminal result without later durable work may opt in. */
    forwardCompletedBarrier?: boolean;
    /** Only explicitly bounded queue pause/resume/drain operations may opt in. */
    queueControlVerification?: boolean;
  } = {},
): Promise<T> {
  if (options.queueControlVerification)
    return withQueueControlVerification(input, () =>
      withRecoveryCheckpointOperation(input, task, {
        ...options,
        queueControlVerification: false,
      }),
    );
  return withRecoveryCheckpointScope(input, () => {
    const scope = scopes.getStore();
    if (!scope) throw new Error("Checkpoint operation has no admitted scope");
    const parent = scope.operation?.closed ? undefined : scope.operation;
    if (parent) {
      delete parent.completion;
      parent.activeChildren++;
    }
    const operation: NonNullable<typeof scope.operation> = {
      activeChildren: 0,
      closed: false,
    };
    // A fingerprint is an in-process completion witness, never a cached archive
    // or a newer acknowledgement manufactured from an older manifest.
    const fingerprint = () => {
      const persistence = settings(input.config);
      if (!persistence)
        return `local-only:${factoryConfigDigest(input.config)}`;
      const record = journal(input.config, persistence);
      if (
        record.sequence !== record.acknowledgedSequence ||
        !record.lastAcknowledged ||
        record.hold ||
        record.error ||
        record.changed.length ||
        record.retentionGaps?.length ||
        (record.attempts.at(-1) &&
          record.attempts.at(-1)?.status !== "acknowledged")
      )
        return undefined;
      return `${factoryConfigDigest(input.config)}:${canonical(record)}`;
    };
    return scopes.run({ ...scope, operation }, async () => {
      let completion: string | undefined;
      try {
        let result: T;
        try {
          result = await task();
        } catch (error) {
          // Preserve the lifecycle error; the journal retains any sync failure.
          try {
            await synchronizeRecoveryCheckpoint(input.config, {
              reason: "explicit",
            });
          } catch {
            // Durability status retains the failure alongside the original error.
          }
          throw error;
        }
        if (
          !options.forwardCompletedBarrier ||
          operation.activeChildren !== 0 ||
          !operation.completion ||
          operation.completion !== fingerprint()
        )
          await synchronizeRecoveryCheckpoint(input.config, {
            reason: "explicit",
          });
        completion = fingerprint();
        return result;
      } finally {
        operation.closed = true;
        if (parent) {
          parent.activeChildren--;
          if (!parent.closed && parent.activeChildren === 0)
            parent.completion = completion;
        }
      }
    });
  });
}
export async function awaitCheckpointAdmission(
  repository: string | undefined,
  reason: "before-effect" | "settled" | "explicit",
): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  if (repository !== undefined && scope.config.repository !== repository)
    throw new CheckpointAdmissionFailure(
      "Checkpoint scope differs from external-effect repository",
    );
  if (
    reason === "before-effect" &&
    settings(scope.config)?.scope === "repository-knowledge"
  )
    return;
  await synchronizeRecoveryCheckpoint(scope.config, {
    reason,
    buildClosure: scope.buildClosure,
  });
}
function git(
  directory: string,
  options: GitPersistenceConfig,
  args: string[],
  input?: Uint8Array | string,
  cwd?: string,
): Buffer {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=always",
      `--git-dir=${directory}`,
      ...args,
    ],
    {
      env: pinnedGitEnvironment(),
      cwd,
      input,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBytes + 65536,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}
async function boundedCommand(
  file: string,
  args: string[],
  options: GitPersistenceConfig,
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let bytes = 0;
  try {
    const result = await subprocessAsync(
      file,
      args,
      { env, signal: controller.signal },
      input,
      (_stream, chunk) => {
        bytes += chunk.length;
        if (bytes > options.maxBytes + 65536) controller.abort();
      },
    );
    if (result.status !== 0)
      throw new Error("Bounded Git archive transport command failed");
    return result.stdout;
  } finally {
    clearTimeout(timer);
  }
}
async function gitRemote(
  directory: string,
  options: GitPersistenceConfig,
  args: string[],
  input?: string,
): Promise<string> {
  const command = pinnedGitCommand(directory, [
    "-c",
    "protocol.file.allow=always",
    ...args,
  ]);
  return boundedCommand("git", command.args, options, command.env, input);
}
function githubRepository(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    remote,
  )?.[1];
}
async function githubVisibility(
  repository: string,
  options: GitPersistenceConfig,
): Promise<boolean> {
  const bytes = await boundedCommand(
    "gh",
    ["api", "--hostname", "github.com", `repos/${repository}`],
    options,
  );
  const value = JSON.parse(bytes);
  if (
    typeof value.private !== "boolean" ||
    String(value.full_name).toLowerCase() !== repository.toLowerCase() ||
    value.html_url !== `https://github.com/${value.full_name}`
  )
    throw new Error("Git destination visibility could not be authenticated");
  return value.private;
}
async function verifyDestination(
  config: FactoryConfig,
  options: GitPersistenceConfig,
): Promise<void> {
  if (isAbsolute(options.remote)) {
    if (options.scope !== "private-history" || options.visibility !== "private")
      throw new Error(
        "Local Git archive destinations support private history only",
      );
    const target = realpathSync(options.remote);
    if (target !== resolve(options.remote))
      throw new Error("Local archive destination resolves through a symlink");
    if (!lstatSync(target).isDirectory())
      throw new Error("Local Git destination must already exist");
    let ancestor = target;
    let privateAncestor = false;
    for (;;) {
      const st = lstatSync(ancestor);
      if (st.uid === process.getuid?.() && (st.mode & 0o077) === 0) {
        privateAncestor = true;
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (!privateAncestor)
      throw new Error(
        "Local archive must be within an owned private directory",
      );
    const bare = execFileSync(
      "git",
      [`--git-dir=${target}`, "rev-parse", "--is-bare-repository"],
      {
        env: pinnedGitEnvironment(),
        timeout: options.timeoutMs,
        encoding: "utf8",
      },
    ).trim();
    if (bare !== "true")
      throw new Error(
        "Local archive destination must be an existing bare Git repository",
      );
    return;
  }
  const destination = githubRepository(options.remote);
  if (!destination)
    throw new Error(
      "Archive host visibility cannot be verified; no publication is admitted",
    );
  const destinationPrivate = await githubVisibility(destination, options);
  if (destinationPrivate !== (options.visibility === "private"))
    throw new Error(
      "Git destination actual visibility differs from its explicit binding",
    );
  if (
    options.visibility === "public" &&
    (await githubVisibility(config.repository, options))
  )
    throw new Error(
      "Private source repository knowledge cannot be published to a public archive",
    );
}
async function remoteTip(
  directory: string,
  options: GitPersistenceConfig,
): Promise<string | undefined> {
  const lines = (
    await gitRemote(directory, options, [
      "ls-remote",
      "--refs",
      "--",
      options.remote,
      options.ref,
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!lines.length) return undefined;
  if (lines.length !== 1)
    throw new Error("Archive ref observation is ambiguous");
  const [sha, ref] = lines[0]!.split("\t");
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || ref !== options.ref)
    throw new Error("Archive ref observation differs from exact binding");
  return sha;
}
function initializeGit(directory: string, options: GitPersistenceConfig): void {
  if (existsSync(directory)) {
    if (
      realpathSync(directory) !== resolve(directory) ||
      !lstatSync(directory).isDirectory()
    )
      throw new Error("Checkpoint Git replica must be a real directory");
    return;
  }
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--bare", directory], {
    env: pinnedGitEnvironment(),
    timeout: options.timeoutMs,
    stdio: "pipe",
  });
}
function assertManifest(
  value: unknown,
  expected: RecoveryCheckpointBinding,
  options: Pick<GitPersistenceConfig, "scope" | "maxBytes" | "maxFiles">,
): asserts value is RecoveryCheckpointManifest {
  keys(
    value,
    [
      "schemaVersion",
      "binding",
      "createdAt",
      "sequence",
      "files",
      "contentRefs",
      "gaps",
    ],
    ["gitObjects", "authority"],
  );
  if (
    value.schemaVersion !== 1 ||
    canonical(value.binding) !== canonical(expected) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.contentRefs) ||
    !Array.isArray(value.gaps) ||
    value.gaps.some((gap: RecoveryCheckpointGap) => gap.required !== false)
  )
    throw new Error(
      "Checkpoint manifest is incomplete or outside its admitted binding",
    );
  if (value.authority !== undefined) {
    if (options.scope !== "private-history")
      throw new Error(
        "Publisher host authority is private-history metadata only",
      );
    assertRecoveryCheckpointAuthority(value.authority);
  }
  const pathsSeen = new Set<string>();
  for (const gap of value.gaps) {
    keys(gap, ["path", "reason", "availability"], ["required"]);
    safePath(gap.path);
    if (
      typeof gap.reason !== "string" ||
      !gap.reason ||
      typeof gap.availability !== "string" ||
      !gap.availability ||
      (gap.required !== undefined && typeof gap.required !== "boolean")
    )
      throw new Error("Invalid declared checkpoint historical gap");
  }
  for (const raw of value.files) {
    keys(raw, ["kind", "path", "ref", "visibility"]);
    safePath(raw.path);
    assertRef(raw.ref);
    if (
      ![
        "continuation",
        "pre-state",
        "memory-binding",
        "learning-original",
        "content",
        "git-pack",
        "historical",
      ].includes(String(raw.kind)) ||
      !["private", "repository"].includes(String(raw.visibility)) ||
      pathsSeen.has(raw.path)
    )
      throw new Error("Checkpoint file contract is invalid or duplicate");
    pathsSeen.add(raw.path);
    if (
      options.scope === "repository-knowledge" &&
      (raw.visibility !== "repository" ||
        !["memory-binding", "content"].includes(String(raw.kind)))
    )
      throw new Error(
        "Repository knowledge archives cannot contain operational or private history",
      );
  }
  for (const ref of value.contentRefs) assertRef(ref);
  if (value.gitObjects !== undefined) {
    if (!Array.isArray(value.gitObjects))
      throw new Error("Invalid checkpoint Git roots");
    for (const root of value.gitObjects) {
      keys(root, ["commitSha", "role"]);
      if (
        typeof root.commitSha !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(root.commitSha) ||
        typeof root.role !== "string" ||
        !root.role
      )
        throw new Error("Invalid checkpoint exact Git identity");
    }
    if (
      value.gitObjects.length &&
      !value.files.some((file) => file.kind === "git-pack")
    )
      throw new Error("Git identities require complete retained Git objects");
  }
  const refs = allRefs(value as unknown as RecoveryCheckpointManifest);
  const files = value.files.length + refs.length + 1;
  const bytes = refs.reduce(
    (sum, ref) => sum + ref.bytes,
    Buffer.byteLength(canonical(value)),
  );
  if (files > options.maxFiles || bytes > options.maxBytes)
    throw new Error(
      `Current materialized checkpoint exceeds admitted bounds: files=${files}, maxFiles=${options.maxFiles}, bytes=${bytes}, maxBytes=${options.maxBytes}`,
    );
}
/** Validates a retained manifest against an explicit binding and whole-closure bounds.
 * Publisher metadata describes its original host; it does not authorize restoration.
 */
export function assertRecoveryCheckpointManifest(
  value: unknown,
  expectedBinding: RecoveryCheckpointBinding,
  bounds: { maxBytes: number; maxFiles: number },
): asserts value is RecoveryCheckpointManifest {
  keys(expectedBinding, [
    "repository",
    "remoteDigest",
    "ref",
    "visibility",
    "scope",
  ]);
  if (
    typeof expectedBinding.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedBinding.repository) ||
    expectedBinding.repository
      .split("/")
      .some((part) => part === "." || part === "..") ||
    typeof expectedBinding.remoteDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedBinding.remoteDigest) ||
    !["private", "public"].includes(expectedBinding.visibility) ||
    !["private-history", "repository-knowledge"].includes(
      expectedBinding.scope,
    ) ||
    (expectedBinding.scope === "private-history" &&
      expectedBinding.visibility !== "private")
  )
    throw new Error("Invalid recovery checkpoint binding");
  assertCheckpointRef(expectedBinding.ref);
  keys(bounds, ["maxBytes", "maxFiles"]);
  if (
    !Number.isSafeInteger(bounds.maxBytes) ||
    bounds.maxBytes < 1 ||
    !Number.isSafeInteger(bounds.maxFiles) ||
    bounds.maxFiles < 1
  )
    throw new Error("Checkpoint bounds must be finite positive integers");
  assertManifest(value, expectedBinding, {
    ...bounds,
    scope: expectedBinding.scope,
  });
}
function allRefs(
  value: Pick<RecoveryCheckpointClosure, "files" | "contentRefs">,
): ContentRef[] {
  const refs = new Map<string, ContentRef>();
  for (const ref of [
    ...value.files.map((file) => file.ref),
    ...value.contentRefs,
  ]) {
    const prior = refs.get(ref.digest);
    if (prior && prior.bytes !== ref.bytes)
      throw new Error("Conflicting checkpoint content identities");
    refs.set(ref.digest, ref);
  }
  return [...refs.values()].sort((a, b) => (a.digest < b.digest ? -1 : 1));
}
function closureIdentity(value: RecoveryCheckpointClosure): string {
  const ordered = (items: unknown[]) => items.map(canonical).sort();
  return canonical({
    files: ordered(value.files),
    contentRefs: ordered(value.contentRefs),
    gitObjects: ordered(value.gitObjects ?? []),
    gaps: ordered(value.gaps),
  });
}
// A transport batch bounds framing and argv overhead; archive admission limits
// and every body's exact identity still apply to the complete collection.
const BODY_BATCH_SIZE = 64;
function assertBodyBounds(
  refs: readonly ContentRef[],
  options: GitPersistenceConfig,
): void {
  for (const ref of refs) assertRef(ref);
  if (
    refs.length > options.maxFiles ||
    new Set(refs.map((ref) => ref.digest)).size !== refs.length ||
    refs.reduce((sum, ref) => sum + ref.bytes, 0) > options.maxBytes
  )
    throw new Error("Checkpoint body batch exceeds admitted bounds");
}
export function readRecoveryCheckpointBodies(
  directory: string,
  options: GitPersistenceConfig,
  entries: readonly { ref: ContentRef; oid: string }[],
): Map<string, Buffer> {
  assertBodyBounds(
    entries.map(({ ref }) => ref),
    options,
  );
  const bodies = new Map<string, Buffer>();
  for (let offset = 0; offset < entries.length; offset += BODY_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + BODY_BATCH_SIZE);
    if (batch.some(({ oid }) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))
      throw new Error("Checkpoint body Git identity is invalid");
    const output = git(
      directory,
      options,
      ["cat-file", "--batch"],
      batch.map(({ oid }) => `${oid}\n`).join(""),
    );
    let cursor = 0;
    for (const { ref, oid } of batch) {
      const end = output.indexOf(10, cursor);
      const expected = `${oid} blob ${ref.bytes}`;
      if (
        end === -1 ||
        !output.subarray(cursor, end).equals(Buffer.from(expected))
      )
        throw new Error("Checkpoint body batch identity, type or size differs");
      cursor = end + 1;
      const bytes = output.subarray(cursor, cursor + ref.bytes);
      cursor += ref.bytes;
      if (
        bytes.length !== ref.bytes ||
        output[cursor] !== 10 ||
        hash(bytes) !== ref.digest ||
        createHash(oid.length === 40 ? "sha1" : "sha256")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== oid
      )
        throw new Error(
          "Fetched checkpoint body failed exact digest verification",
        );
      cursor++;
      bodies.set(ref.digest, bytes);
    }
    if (cursor !== output.length)
      throw new Error("Checkpoint body batch contains extra bytes");
  }
  return bodies;
}
export function writeRecoveryCheckpointBodies(
  directory: string,
  options: GitPersistenceConfig,
  bodies: readonly { ref: ContentRef; bytes: Uint8Array }[],
): { ref: ContentRef; oid: string }[] {
  assertBodyBounds(
    bodies.map(({ ref }) => ref),
    options,
  );
  if (!bodies.length) return [];
  const temporary = mkdtempSync(join(tmpdir(), "factory-checkpoint-bodies-"));
  const entries: { ref: ContentRef; oid: string }[] = [];
  try {
    for (let offset = 0; offset < bodies.length; offset += BODY_BATCH_SIZE) {
      const batch = bodies.slice(offset, offset + BODY_BATCH_SIZE);
      const files = batch.map(({ ref, bytes }) => {
        if (bytes.length !== ref.bytes || hash(bytes) !== ref.digest)
          throw new Error("Checkpoint write body differs from exact reference");
        const path = join(temporary, ref.digest);
        writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
        return path;
      });
      const output = git(
        resolve(directory),
        options,
        [
          "hash-object",
          "--no-filters",
          "-w",
          "--",
          ...batch.map(({ ref }) => ref.digest),
        ],
        undefined,
        temporary,
      ).toString("utf8");
      const oids = output.split("\n");
      if (oids.pop() !== "" || oids.length !== batch.length)
        throw new Error("Checkpoint written Git identities are incomplete");
      for (let index = 0; index < batch.length; index++) {
        const oid = oids[index]!;
        const { ref, bytes } = batch[index]!;
        if (
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) ||
          createHash(oid.length === 40 ? "sha1" : "sha256")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex") !== oid
        )
          throw new Error(
            "Checkpoint written Git identity differs from exact bytes",
          );
        entries.push({ ref, oid });
        rmSync(files[index]!);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return entries;
}
export function recoveryCheckpointClosureDigest(
  closure: RecoveryCheckpointClosure,
): string {
  return hash(closureIdentity(closure));
}
function readArchive(
  directory: string,
  commitSha: string,
  config: FactoryConfig,
  options: GitPersistenceConfig,
): {
  manifest: RecoveryCheckpointManifest;
  blobs: Map<string, Buffer>;
  blobEntries: { ref: ContentRef; oid: string }[];
  manifestBytes: number;
  originalManifestBytes: Buffer;
  payloadDigest: string;
} {
  const manifestBytes = git(directory, options, [
    "show",
    `${commitSha}:checkpoint.json`,
  ]);
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
  );
  assertManifest(manifest, binding(config, options), options);
  if (canonical(manifest) !== manifestBytes.toString("utf8"))
    throw new Error(
      "Checkpoint manifest does not retain canonical exact bytes",
    );
  const refs = allRefs(manifest);
  const objectIds = new Map<string, string>();
  const names = git(directory, options, [
    "ls-tree",
    "-rz",
    "--full-tree",
    commitSha,
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      if (
        mode !== "100644" ||
        type !== "blob" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid!)
      )
        throw new Error("Archive contains nonregular payload entries");
      const path = line.slice(tab + 1);
      objectIds.set(path, oid!);
      return path;
    })
    .sort();
  const expected = [
    "checkpoint.json",
    ...refs.map((ref) => `blobs/${ref.digest}`),
  ].sort();
  if (canonical(names) !== canonical(expected))
    throw new Error("Archive contains unexpected or missing bytes");
  const blobEntries = refs.map((ref) => ({
    ref,
    oid: objectIds.get(`blobs/${ref.digest}`)!,
  }));
  const blobs = readRecoveryCheckpointBodies(directory, options, blobEntries);
  return {
    manifest,
    blobs,
    blobEntries,
    manifestBytes: manifestBytes.length,
    originalManifestBytes: manifestBytes,
    payloadDigest: hash(manifestBytes),
  };
}
async function inspectReachableHistory(
  directory: string,
  options: GitPersistenceConfig,
  tip: string,
): Promise<RecoveryCheckpointInspection["reachableHistory"]> {
  try {
    const output = await gitRemote(directory, options, [
      "rev-list",
      "--objects",
      "--no-object-names",
      tip,
    ]);
    const objects = output.trim().split("\n");
    if (
      !objects.length ||
      objects.some((object) => !/^[a-f0-9]{40,64}$/.test(object)) ||
      new Set(objects).size !== objects.length
    )
      throw new Error("Reachable Git object identities are invalid");
    const measured = await gitRemote(
      directory,
      options,
      ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
      `${objects.join("\n")}\n`,
    );
    const rows = measured.trim().split("\n");
    if (rows.length !== objects.length)
      throw new Error("Reachable Git object sizes are incomplete");
    let logicalObjectBytes = 0;
    for (const [index, row] of rows.entries()) {
      const match = /^([a-f0-9]{40,64}) ([0-9]+)$/.exec(row);
      const bytes = match ? Number(match[2]) : Number.NaN;
      if (
        !match ||
        match[1] !== objects[index] ||
        !Number.isSafeInteger(bytes) ||
        !Number.isSafeInteger(logicalObjectBytes + bytes)
      )
        throw new Error("Reachable Git object size is unavailable");
      logicalObjectBytes += bytes;
    }
    return {
      availability: "available",
      logicalObjectBytes,
      objects: objects.length,
    };
  } catch (error) {
    if (error instanceof UnsettledSubprocessError) throw error;
    return {
      availability: "unavailable",
      reason: "bounded-inspection-unavailable",
    };
  }
}
/** Fixed private queue/continuation paths; this is not a general history index. */
function verificationKey(
  config: FactoryConfig,
  options: GitPersistenceConfig,
): string {
  return canonical({
    configDigest: factoryConfigDigest(config),
    stateRoot: stateRoot(config.repository),
    authority: factoryAuthorityDigest(config),
    binding: binding(config, options),
    options,
  });
}
function historicalManifestSummary(
  bytes: Buffer,
  config: FactoryConfig,
  options: GitPersistenceConfig,
  capturedKey: string,
): HistoricalManifestSummary {
  const context = scopes.getStore()?.verification;
  const key = `${capturedKey}:${hash(bytes)}`;
  const hit =
    context &&
    !context.closed &&
    !context.quarantined &&
    context.key === capturedKey
      ? context.summaries.get(key)
      : undefined;
  if (hit) return hit;
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  assertManifest(manifest, binding(config, options), options);
  if (canonical(manifest) !== bytes.toString("utf8"))
    throw new Error(
      "Queue lineage manifest does not retain canonical exact bytes",
    );
  const summary: HistoricalManifestSummary = Object.freeze({
    sequence: manifest.sequence,
    files: Object.freeze(
      manifest.files
        .filter(
          (file: RecoveryCheckpointFile) =>
            /^project-queue-history\/[a-f0-9-]{36}\.json$/.test(file.path) ||
            /^objectives\/[0-9]+\/(?:pre-state|state)\.json$/.test(file.path),
        )
        .map((file: RecoveryCheckpointFile) =>
          Object.freeze({ ...file, ref: Object.freeze({ ...file.ref }) }),
        ),
    ),
  });
  // Optional reuse is performance-only. Encoded summary/key charge is bounded;
  // this is not a claim about the JavaScript heap or a new logical read allowance.
  if (
    context &&
    !context.closed &&
    !context.quarantined &&
    context.key === capturedKey
  ) {
    const charge =
      Buffer.byteLength(key) + Buffer.byteLength(canonical(summary));
    if (
      context.summaries.size >= options.maxFiles ||
      context.summaryBytes + charge > options.maxBytes
    ) {
      context.summaries.clear();
      context.summaryBytes = 0;
    }
    if (charge <= options.maxBytes) {
      context.summaries.set(key, summary);
      context.summaryBytes += charge;
    }
  }
  return summary;
}
interface QueueBodyDescription {
  kind?: string;
  objective?: number;
  id?: string;
  runId?: string;
  repository?: string;
  binding: string;
}
interface QueueAncestryObservation {
  key: string;
  tip: string;
  manifestTransportBytes: number;
  entries: readonly {
    commit: string;
    bytes: Buffer;
    ref: ContentRef;
  }[];
  summary(
    entry: QueueAncestryObservation["entries"][number],
  ): HistoricalManifestSummary;
  prefetchOriginals(request: QueueOwnerLineageRequest): void;
  readOriginal(commit: string, ref: ContentRef): Buffer;
  description(
    ref: ContentRef,
    bytes: Buffer,
    claimBinding: boolean,
  ): QueueBodyDescription;
}
/** One fresh read shares transport and intrinsic facts, never a query verdict. */
function observeQueueAncestry(
  directory: string,
  options: GitPersistenceConfig,
  config: FactoryConfig,
  tip: string,
): QueueAncestryObservation {
  const capturedKey = verificationKey(config, options);
  const commits = git(directory, options, [
    "rev-list",
    "--first-parent",
    "--reverse",
    tip,
  ])
    .toString("utf8")
    .trim()
    .split("\n");
  if (commits.some((sha) => !/^[a-f0-9]{40,64}$/.test(sha)))
    throw new Error("Queue cancellation lineage commit inventory is invalid");
  if (commits.length > options.maxFiles)
    throw new Error(
      `Queue cancellation ancestry exceeds admitted commit bound: commits=${commits.length}, maxFiles=${options.maxFiles}`,
    );
  const inventory = `${commits.map((sha) => `${sha}:checkpoint.json`).join("\n")}\n`;
  const metadata = git(
    directory,
    options,
    ["cat-file", "--batch-check"],
    inventory,
  )
    .toString("utf8")
    .split("\n");
  if (metadata.pop() !== "" || metadata.length !== commits.length)
    throw new Error("Queue lineage manifest size inventory is incomplete");
  let manifestTransportBytes = 0;
  const identities = metadata.map((row) => {
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(row);
    const size = match ? Number(match[2]) : Number.NaN;
    const charge = Buffer.byteLength(row) + 2 + size;
    if (
      !match ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(manifestTransportBytes + charge)
    )
      throw new Error("Queue lineage manifest type or size is invalid");
    manifestTransportBytes += charge;
    return { oid: match[1]!, size };
  });
  const manifestBufferBytes = options.maxBytes + 65536;
  if (manifestTransportBytes > manifestBufferBytes)
    throw new Error(
      `Queue cancellation ancestry exceeds admitted manifest transport buffer: predictedBytes=${manifestTransportBytes}, bufferBytes=${manifestBufferBytes}, maxBytes=${options.maxBytes}, commits=${commits.length}; original body bytes not read`,
    );
  const batch = git(directory, options, ["cat-file", "--batch"], inventory);
  if (batch.length !== manifestTransportBytes)
    throw new Error(
      "Queue lineage manifest transport differs from size inventory",
    );
  const entries: QueueAncestryObservation["entries"][number][] = [];
  let offset = 0;
  for (const [index, commit] of commits.entries()) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString("utf8");
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header);
    const size = match ? Number(match[2]) : Number.NaN;
    if (
      end < offset ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + 1 + size >= batch.length ||
      match?.[1] !== identities[index]!.oid ||
      size !== identities[index]!.size ||
      batch[end + 1 + size] !== 10
    )
      throw new Error("Queue lineage manifest transport is incomplete");
    const bytes = batch.subarray(end + 1, end + 1 + size);
    offset = end + 2 + size;
    if (
      createHash(identities[index]!.oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== identities[index]!.oid
    )
      throw new Error("Queue lineage manifest Git identity differs");
    entries.push(
      Object.freeze({
        commit,
        bytes,
        ref: Object.freeze({
          digest: hash(bytes),
          bytes: bytes.length,
          mediaType: "application/json",
        }),
      }),
    );
  }
  if (offset !== batch.length)
    throw new Error("Queue lineage manifest transport contains extra bytes");
  const summaries = new Map<string, HistoricalManifestSummary>();
  const originals = new Map<string, Buffer>();
  const descriptions = new Map<string, QueueBodyDescription>();
  let memoBytes = 0;
  const budget = Math.max(0, options.maxBytes - batch.length);
  const retain = (charge: number) => {
    if (charge > budget) return false;
    if (
      summaries.size + originals.size + descriptions.size >= options.maxFiles ||
      memoBytes + charge > budget
    ) {
      summaries.clear();
      originals.clear();
      descriptions.clear();
      memoBytes = 0;
    }
    memoBytes += charge;
    return true;
  };
  const tuple = (ref: ContentRef) =>
    canonical([ref.digest, ref.bytes, ref.mediaType ?? null]);
  const originalKey = (commit: string, ref: ContentRef) =>
    canonical([commit, `blobs/${ref.digest}`, tuple(ref)]);
  return {
    key: capturedKey,
    tip,
    manifestTransportBytes: batch.length,
    entries: Object.freeze(entries),
    summary(entry) {
      const key = entry.ref.digest;
      const hit = summaries.get(key);
      if (hit) return hit;
      const value = historicalManifestSummary(
        entry.bytes,
        config,
        options,
        capturedKey,
      );
      if (retain(Buffer.byteLength(key) + Buffer.byteLength(canonical(value))))
        summaries.set(key, value);
      return value;
    },
    prefetchOriginals(request) {
      const claimPath = `project-queue-history/${request.claimId}.json`;
      const statePaths = [
        `objectives/${request.objective}/state.json`,
        `objectives/${request.objective}/pre-state.json`,
      ];
      const first = new Set<string>();
      const needed: { commit: string; ref: ContentRef; key: string }[] = [];
      let charge = 0;
      const select = (commit: string, ref: ContentRef) => {
        if (first.has(ref.digest)) return true;
        first.add(ref.digest);
        const key = originalKey(commit, ref);
        if (originals.has(key)) return true;
        const source = `${commit}:blobs/${ref.digest}\n`;
        // Reserve raw batch framing and detached retained bytes as well as keys.
        // This optional pool does not change a query's logical original charge.
        charge +=
          ref.bytes * 2 +
          Buffer.byteLength(key) +
          Buffer.byteLength(source) +
          2 * (64 + String(ref.bytes).length + 8);
        if (
          needed.length >= options.maxFiles ||
          !Number.isSafeInteger(charge) ||
          memoBytes + charge > budget
        )
          return false;
        needed.push({ commit, ref, key });
        return true;
      };
      let before = false;
      let claimed = false;
      let initial = false;
      for (const entry of entries) {
        const manifest = this.summary(entry);
        const claim = manifest.files.find((file) => file.path === claimPath);
        const states = manifest.files.filter((file) =>
          statePaths.includes(file.path),
        );
        for (const file of manifest.files.filter((file) =>
          /^project-queue-history\/[a-f0-9-]{36}\.json$/.test(file.path),
        ))
          if (!select(entry.commit, file.ref)) return;
        if (!claim) {
          if (claimed || states.length) return;
          before = true;
          continue;
        }
        if (claim.kind !== "historical" || claim.visibility !== "private")
          return;
        if (!claimed) {
          if (!before) return;
          claimed = true;
          first.add(entry.ref.digest); // Preserve selected-witness seeding order.
        }
        if (states.length > 1) return;
        if (!states.length) {
          if (initial) return;
          continue;
        }
        const state = states[0]!;
        if (state.kind !== "continuation" || state.visibility !== "private")
          return;
        if (!select(entry.commit, state.ref)) return;
        if (!initial) {
          initial = true;
          first.add(entry.ref.digest);
        }
      }
      if (
        !needed.length ||
        memoBytes + charge > budget ||
        summaries.size + originals.size + descriptions.size + needed.length >
          options.maxFiles
      )
        return;
      const metadata = git(
        directory,
        options,
        ["cat-file", "--batch-check"],
        needed
          .map(({ commit, ref }) => `${commit}:blobs/${ref.digest}\n`)
          .join(""),
      )
        .toString("utf8")
        .split("\n");
      if (metadata.pop() !== "" || metadata.length !== needed.length)
        throw new Error(
          "Queue lineage original source inventory is incomplete",
        );
      const selected = needed.map(({ ref }, index) => {
        const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(
          metadata[index]!,
        );
        if (!match || Number(match[2]) !== ref.bytes)
          throw new Error("Queue lineage original source type or size differs");
        return { ref, oid: match[1]! };
      });
      const loaded = readRecoveryCheckpointBodies(directory, options, selected);
      for (const { key, ref } of needed) {
        const bytes = loaded.get(ref.digest)!;
        if (retain(bytes.length + Buffer.byteLength(key)))
          originals.set(key, Buffer.from(bytes));
      }
    },
    readOriginal(commit, ref) {
      // The historical source association must be authenticated before another
      // query can reuse literal bytes. A current-tip body is not that proof.
      const key = originalKey(commit, ref);
      const retained = originals.get(key);
      if (retained) return retained;
      const bytes = git(directory, options, [
        "show",
        `${commit}:blobs/${ref.digest}`,
      ]);
      if (bytes.length !== ref.bytes || hash(bytes) !== ref.digest)
        throw new Error("Queue lineage original failed exact verification");
      if (retain(bytes.length + Buffer.byteLength(key)))
        originals.set(key, bytes);
      return bytes;
    },
    description(ref, bytes, claimBinding) {
      const key = canonical([tuple(ref), claimBinding]);
      const hit = descriptions.get(key);
      if (hit) return hit;
      const original = JSON.parse(bytes.toString("utf8"));
      const {
        settled: ignoredSettlement,
        runBinding: ignoredRunBinding,
        ...immutableBinding
      } = original;
      const value = Object.freeze({
        kind: original.kind,
        objective: original.objective,
        id: original.id,
        runId: original.runId,
        repository: original.repository,
        binding: claimBinding ? canonical(immutableBinding) : "",
      });
      if (
        retain(
          Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)),
        )
      )
        descriptions.set(key, value);
      return value;
    },
  };
}
function assertQueueLineageRequest(
  options: GitPersistenceConfig,
  request: QueueOwnerLineageRequest,
): void {
  if (
    options.scope !== "private-history" ||
    !Number.isSafeInteger(request.objective) ||
    request.objective < 1 ||
    !/^[a-f0-9-]{36}$/.test(request.claimId) ||
    !request.runId
  )
    throw new Error("Invalid queue cancellation lineage request");
}
function queueOwnerLineage(
  options: GitPersistenceConfig,
  config: FactoryConfig,
  tip: string,
  request: QueueOwnerLineageRequest,
  observeCapacity: ((capacity: QueueLineageCapacity) => void) | undefined,
  observation: QueueAncestryObservation,
): VerifiedQueueOwnerLineage {
  assertQueueLineageRequest(options, request);
  if (
    observation.key !== verificationKey(config, options) ||
    observation.tip !== tip
  )
    throw new Error(
      "Queue ancestry observation has a different admitted binding",
    );
  const commits = observation.entries;
  const manifestTransportBytes = observation.manifestTransportBytes;
  const manifestBufferBytes = options.maxBytes + 65536;
  observation.prefetchOriginals(request);
  const bodies = new Map<string, { ref: ContentRef; bytes: Uint8Array }>();
  let retainedOriginalBytes = 0;
  const body = (commit: string, ref: ContentRef) => {
    const retained = bodies.get(ref.digest);
    if (retained) {
      if (
        retained.ref.bytes !== ref.bytes ||
        retained.ref.mediaType !== ref.mediaType
      )
        throw new Error("Queue lineage reference binding differs");
      return Buffer.from(retained.bytes);
    }
    const bytes = observation.readOriginal(commit, ref);
    bodies.set(ref.digest, { ref, bytes: Uint8Array.from(bytes) });
    retainedOriginalBytes = [...bodies.values()].reduce(
      (total, entry) => total + entry.ref.bytes,
      0,
    );
    if (manifestTransportBytes + retainedOriginalBytes > options.maxBytes)
      throw new Error(
        `Queue cancellation ancestry exceeds admitted cumulative byte bound: manifestTransportBytes=${manifestTransportBytes}, retainedOriginalBytes=${retainedOriginalBytes}, chargedBytes=${manifestTransportBytes + retainedOriginalBytes}, maxBytes=${options.maxBytes}, commits=${commits.length}`,
      );
    return bytes;
  };
  const description = (commit: string, ref: ContentRef, claimBinding = true) =>
    observation.description(ref, body(commit, ref), claimBinding);
  const claimPath = `project-queue-history/${request.claimId}.json`;
  const statePaths = [
    `objectives/${request.objective}/state.json`,
    `objectives/${request.objective}/pre-state.json`,
  ];
  let before: QueueCheckpointWitness | undefined;
  let claimed: QueueCheckpointWitness | undefined;
  let initial: QueueCheckpointWitness | undefined;
  let originalClaim: ContentRef | undefined;
  let initialSnapshot: ContentRef | undefined;
  let priorSequence = -1;
  let priorManifestDigest: string | undefined;
  for (const entry of observation.entries) {
    const { commit, bytes } = entry;
    const manifest = observation.summary(entry);
    if (
      manifest.sequence < priorSequence ||
      (manifest.sequence === priorSequence &&
        entry.ref.digest !== priorManifestDigest)
    )
      throw new Error("Queue lineage manifest ancestry is ambiguous");
    priorSequence = manifest.sequence;
    priorManifestDigest = entry.ref.digest;
    const ref = { ...entry.ref };
    const witness = { commitSha: commit, manifest: ref };
    const claim = manifest.files.find((file) => file.path === claimPath);
    const states = manifest.files.filter((file) =>
      statePaths.includes(file.path),
    );
    for (const file of manifest.files.filter((file) =>
      /^project-queue-history\/[a-f0-9-]{36}\.json$/.test(file.path),
    )) {
      const record = description(commit, file.ref);
      if (
        record.kind === "project-queue-owner" &&
        record.objective === request.objective &&
        record.id !== request.claimId
      )
        throw new Error(
          "Competing Project claims make first-run lineage ambiguous",
        );
    }
    if (!claim) {
      if (claimed || states.length)
        throw new Error("Queue claim/run lineage was removed or replaced");
      before = witness;
      continue;
    }
    if (claim.kind !== "historical" || claim.visibility !== "private")
      throw new Error("Queue lineage claim has invalid scope");
    if (!claimed) {
      if (!before)
        throw new Error(
          "Queue lineage has no authenticated pre-claim checkpoint",
        );
      claimed = witness;
      originalClaim = claim.ref;
      bodies.set(ref.digest, { ref, bytes: Uint8Array.from(bytes) });
    }
    // Settlement may later extend this exact original claim, but its original
    // admission, token and deadline must remain literal throughout the chain.
    const original = description(claimed.commitSha, originalClaim!);
    const current = description(commit, claim.ref);
    if (current.binding !== original.binding)
      throw new Error("Original queue claim changed within its lineage");
    if (states.length > 1)
      throw new Error("Competing initial continuation files are ambiguous");
    if (!states.length) {
      if (initial) throw new Error("Original queue continuation was removed");
      continue;
    }
    const state = states[0]!;
    if (state.kind !== "continuation" || state.visibility !== "private")
      throw new Error("Queue initial continuation has an unsupported scope");
    const snapshot = description(commit, state.ref, false);
    if (
      snapshot.runId !== request.runId ||
      snapshot.objective !== request.objective ||
      snapshot.repository !== config.repository
    )
      throw new Error("Queue first-run continuation was replaced");
    if (!initial) {
      initial = witness;
      initialSnapshot = state.ref;
      bodies.set(ref.digest, { ref, bytes: Uint8Array.from(bytes) });
    }
  }
  if (!before || !claimed || !initial || !originalClaim || !initialSnapshot)
    throw new Error("Authenticated first-run queue lineage is unavailable");
  // Keep only selected witnesses and originals, not an additional journal.
  const beforeBytes = observation.entries.find(
    (entry) => entry.commit === before.commitSha,
  )!.bytes;
  bodies.set(before.manifest.digest, {
    ref: before.manifest,
    bytes: Uint8Array.from(beforeBytes),
  });
  const selected = [
    before.manifest,
    claimed.manifest,
    initial.manifest,
    originalClaim,
    initialSnapshot,
  ];
  observeCapacity?.({
    commits: commits.length,
    manifestTransportBytes,
    retainedOriginalBytes,
    chargedBytes: manifestTransportBytes + retainedOriginalBytes,
    byteHeadroom:
      options.maxBytes - manifestTransportBytes - retainedOriginalBytes,
    commitHeadroom: options.maxFiles - commits.length,
    manifestBufferHeadroom: manifestBufferBytes - manifestTransportBytes,
  });
  return {
    checkpoints: { before, claimed, initial },
    originalClaim,
    initialSnapshot,
    bodies: selected.map((ref) => {
      const original = bodies.get(ref.digest)!;
      return {
        ref: { ...original.ref },
        bytes: Uint8Array.from(original.bytes),
      };
    }),
  };
}
function assertRemoteOnlyVerifier(
  directory: string,
  options: GitPersistenceConfig,
): void {
  if (
    existsSync(join(directory, "objects", "info", "alternates")) ||
    existsSync(join(directory, "objects", "info", "http-alternates")) ||
    git(directory, options, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace",
    ]).length
  )
    throw new Error("Queue verifier contains alternate or replacement objects");
}
async function freshArchive(
  config: FactoryConfig,
  options: GitPersistenceConfig,
  expectedCommit?: string,
  inspectHistory = false,
  lineageRequest?: QueueOwnerLineageRequest,
  observeCapacity?: (capacity: QueueLineageCapacity) => void,
) {
  const context = scopes.getStore()?.verification;
  if (!context)
    return freshArchiveOwned(
      config,
      options,
      expectedCommit,
      inspectHistory,
      lineageRequest,
      observeCapacity,
    );
  if (
    context.closed ||
    context.quarantined ||
    context.key !== verificationKey(config, options)
  )
    throw new Error(
      "Queue verifier is closed, uncertain or has a different admitted binding",
    );
  const previous = context.serial;
  let release!: () => void;
  context.serial = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (
      context.closed ||
      context.quarantined ||
      context.key !== verificationKey(config, options)
    )
      throw new Error(
        "Queue verifier is closed, uncertain or has a different admitted binding",
      );
    return await freshArchiveOwned(
      config,
      options,
      expectedCommit,
      inspectHistory,
      lineageRequest,
      observeCapacity,
      context,
    );
  } finally {
    release();
  }
}
async function freshArchiveOwned(
  config: FactoryConfig,
  options: GitPersistenceConfig,
  expectedCommit?: string,
  inspectHistory = false,
  lineageRequest?: QueueOwnerLineageRequest,
  observeCapacity?: (capacity: QueueLineageCapacity) => void,
  context?: QueueVerificationContext,
) {
  const directory =
    context?.directory ??
    join(paths(config.repository).root, `verify-${randomUUID()}.git`);
  if (context) context.directory = directory;
  let settled = true;
  try {
    initializeGit(directory, options);
    if (context) chmodSync(directory, 0o700);
    if (context) assertRemoteOnlyVerifier(directory, options);
    const tip = await remoteTip(directory, options);
    if (!tip) throw new Error("Configured Git archive ref has no checkpoint");
    if (context && context.key !== verificationKey(config, options))
      throw new Error(
        "Queue verifier admitted binding changed during remote observation",
      );
    await gitRemote(directory, options, [
      "fetch",
      "--no-tags",
      "--",
      options.remote,
      options.ref,
    ]);
    if (context && context.key !== verificationKey(config, options))
      throw new Error("Queue verifier admitted binding changed during fetch");
    const fetched = git(directory, options, ["rev-parse", "FETCH_HEAD"])
      .toString("utf8")
      .trim();
    if (fetched !== tip)
      throw new Error("Archive ref changed during independent verification");
    if (context) {
      // A reused repository is an object cache, never an authority or graph verdict.
      // Git's full strict validator authenticates raw packed/loose object hashes
      // before any ancestry or path lookup; connectivity-only is insufficient.
      assertRemoteOnlyVerifier(directory, options);
      await gitRemote(directory, options, [
        "fsck",
        "--full",
        "--strict",
        "--no-reflogs",
        "--no-dangling",
        tip,
      ]);
    }
    if (context && context.key !== verificationKey(config, options))
      throw new Error(
        "Queue verifier admitted binding changed during object verification",
      );
    const commit = expectedCommit ?? tip;
    if (expectedCommit)
      git(directory, options, [
        "merge-base",
        "--is-ancestor",
        expectedCommit,
        tip,
      ]);
    const archive = {
      ...readArchive(directory, commit, config, options),
      commitSha: commit,
      remoteTip: tip,
    };
    let observation: QueueAncestryObservation | undefined;
    const verifyLineage = (request: QueueOwnerLineageRequest) => {
      assertQueueLineageRequest(options, request);
      if (!observation)
        observation = observeQueueAncestry(directory, options, config, tip);
      return queueOwnerLineage(
        options,
        config,
        tip,
        request,
        observeCapacity,
        observation,
      );
    };
    let lineage = lineageRequest ? verifyLineage(lineageRequest) : undefined;
    // Retained cancellation witnesses must still be actual ancestor packets,
    // rather than manually shaped manifest text in the current body store.
    for (const file of archive.manifest.files.filter((file) =>
      /^project-queue-history\/[a-f0-9-]{36}\.json$/.test(file.path),
    )) {
      const record = JSON.parse(
        archive.blobs.get(file.ref.digest)!.toString("utf8"),
      );
      const proof =
        record.kind === "project-queue-owner"
          ? record.settled?.cancellation
          : undefined;
      if (proof?.lineage?.kind !== "verified-first-run") continue;
      const verified = verifyLineage({
        objective: record.objective,
        claimId: record.id,
        runId: record.settled.runId,
      });
      if (
        canonical(verified.checkpoints) !==
          canonical(proof.lineage.checkpoints) ||
        canonical(verified.originalClaim) !== canonical(proof.originalClaim) ||
        canonical(verified.initialSnapshot) !== canonical(proof.initialSnapshot)
      )
        throw new Error(
          "Retained queue cancellation lineage differs from actual Git ancestry",
        );
      if (lineageRequest?.claimId === record.id) lineage = verified;
    }
    const result = {
      ...archive,
      ...(lineage ? { queueOwnerLineage: lineage } : {}),
      ...(inspectHistory
        ? {
            reachableHistory: await inspectReachableHistory(
              directory,
              options,
              tip,
            ),
          }
        : {}),
    };
    if (context && context.key !== verificationKey(config, options))
      throw new Error(
        "Queue verifier admitted binding changed during archive verification",
      );
    if (observation && observation.key !== verificationKey(config, options))
      throw new Error(
        "Queue ancestry observation binding changed during archive verification",
      );
    return result;
  } catch (error) {
    if (error instanceof UnsettledSubprocessError) {
      settled = false;
      if (context) {
        context.quarantined = true;
        context.summaries.clear();
      }
    }
    if (context && settled) {
      context.summaries.clear();
      context.summaryBytes = 0;
      context.quarantined = true;
      try {
        rmSync(directory, { recursive: true, force: true });
        delete context.directory;
        context.quarantined = false;
      } catch {
        // Keep the failed verifier quarantined and preserve the original error.
      }
    }
    throw error;
  } finally {
    if (settled && !context)
      rmSync(directory, { recursive: true, force: true });
  }
}
export async function readVerifiedRecoveryCheckpoint(
  config: FactoryConfig,
  commitSha?: string,
  lineageRequest?: QueueOwnerLineageRequest,
): Promise<VerifiedRecoveryCheckpoint> {
  const options = settings(config);
  if (!options) throw new Error("Git persistence is not configured");
  if (commitSha !== undefined && !/^[a-f0-9]{40,64}$/.test(commitSha))
    throw new Error("Invalid requested checkpoint commit");
  await verifyDestination(config, options);
  const archive = await freshArchive(
    config,
    options,
    commitSha,
    false,
    lineageRequest,
  );
  return {
    manifest: archive.manifest,
    commitSha: archive.commitSha,
    remoteTip: archive.remoteTip,
    payloadDigest: archive.payloadDigest,
    manifestBytes: Uint8Array.from(archive.originalManifestBytes),
    ...(archive.queueOwnerLineage
      ? { queueOwnerLineage: archive.queueOwnerLineage }
      : {}),
    async readVerifiedBlob(ref) {
      assertRef(ref);
      const bytes = archive.blobs.get(ref.digest);
      if (!bytes || bytes.length !== ref.bytes || hash(bytes) !== ref.digest)
        throw new Error(
          "Requested body is absent from verified archive closure",
        );
      return Uint8Array.from(bytes);
    },
  };
}
async function assertInstallationLease(
  repository: string,
  lock: ControllerLock,
): Promise<void> {
  const { installationLockPath, readControllerOwner } = await import(
    "./state-store.js"
  );
  const path = installationLockPath(repository);
  const owner = readControllerOwner(path);
  const processIdentity = linuxProcessIdentity(process.pid);
  const held = fstatSync(lock.fd);
  const current = lstatSync(path);
  if (
    !owner ||
    !processIdentity ||
    owner.token !== lock.token ||
    owner.pid !== process.pid ||
    owner.startTime !== processIdentity.startTime ||
    !held.isFile() ||
    held.ino !== current.ino ||
    held.dev !== current.dev ||
    current.uid !== process.getuid?.() ||
    current.mode & 0o077 ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error(
      "Checkpoint restoration requires the held exclusive installation lease",
    );
}
/** Establishes only an archive parent; imported execution remains inspection/reconciliation. */
export async function adoptRecoveryCheckpointBaseline(
  config: FactoryConfig,
  input: {
    checkpoint: VerifiedRecoveryCheckpoint;
    installedClosureDigest: string;
    lock: ControllerLock;
  },
): Promise<RecoveryCheckpointStatus> {
  return serializePublication(config.repository, async () => {
    const options = settings(config);
    if (!options || options.scope !== "private-history")
      throw new CheckpointAdmissionFailure(
        "Restored continuation requires an explicit private-history archive",
        "explicit",
      );
    const p = paths(config.repository);
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    takeGuard(p.publicationGuard);
    try {
      await assertInstallationLease(config.repository, input.lock);
      assertManifest(
        input.checkpoint.manifest,
        binding(config, options),
        options,
      );
      const authority = input.checkpoint.manifest.authority;
      if (
        !authority ||
        authority.authorityDigest !== factoryAuthorityDigest(config)
      )
        throw new Error(
          "Checkpoint publisher authority is unavailable or differs; restoration remains inspection-only",
        );
      const closureDigest = recoveryCheckpointClosureDigest(
        input.checkpoint.manifest,
      );
      if (
        input.installedClosureDigest !== closureDigest ||
        !/^[a-f0-9]{64}$/.test(input.checkpoint.payloadDigest) ||
        hash(input.checkpoint.manifestBytes) !==
          input.checkpoint.payloadDigest ||
        !/^[a-f0-9]{40,64}$/.test(input.checkpoint.commitSha) ||
        input.checkpoint.commitSha !== input.checkpoint.remoteTip
      )
        throw new Error(
          "Historical or incomplete checkpoint cannot establish the current writer baseline",
        );
      await verifyDestination(config, options);
      const verified = await freshArchive(
        config,
        options,
        input.checkpoint.commitSha,
      );
      if (
        verified.remoteTip !== input.checkpoint.commitSha ||
        verified.payloadDigest !== input.checkpoint.payloadDigest ||
        canonical(verified.manifest) !== canonical(input.checkpoint.manifest)
      )
        throw new Error(
          "Archive head or original checkpoint changed before baseline adoption",
        );
      const store = new LocalContentStore(
        join(stateRoot(config.repository), "content"),
      );
      store.readBytes({
        digest: verified.payloadDigest,
        bytes: verified.originalManifestBytes.length,
        mediaType: "application/json",
      });
      for (const ref of allRefs(verified.manifest)) store.readBytes(ref);
      await assertInstallationLease(config.repository, input.lock);
      return status(
        mutate(config, options, (record) => {
          assertRetentionResolved(record);
          const prior = record.restoredBaseline;
          if (
            prior?.commitSha === verified.commitSha &&
            prior.payloadDigest === verified.payloadDigest &&
            prior.closureDigest === closureDigest &&
            prior.localConfigDigest === factoryConfigDigest(config) &&
            canonical(prior.localHostLayout) === canonical(hostLayout(config))
          ) {
            if (
              record.attempts.some(
                (attempt) => attempt.status !== "acknowledged",
              ) ||
              record.hold ||
              record.error ||
              record.changed.some(
                (entry) =>
                  entry.path !== "archive/restoration-receipt" ||
                  entry.kind !== "historical",
              )
            )
              throw new Error(
                "Existing checkpoint intents or outcomes remain held during repeated restoration",
              );
            return;
          }
          if (
            record.attempts.length ||
            record.lastAcknowledged ||
            (record.hold && record.hold !== "needs-restore") ||
            (record.error && record.hold !== "needs-restore") ||
            record.sequence !== 0 ||
            record.changed.length
          )
            throw new Error(
              "Existing checkpoint intents or outcomes require reconciliation before restored baseline adoption",
            );
          const at = new Date().toISOString();
          const sequence = verified.manifest.sequence;
          if (!Number.isSafeInteger(sequence + 1))
            throw new Error(
              "Restored checkpoint sequence cannot retain a pending provenance epoch",
            );
          record.restoredBaseline = {
            schemaVersion: 1,
            source: "verified-restoration",
            commitSha: verified.commitSha,
            payloadDigest: verified.payloadDigest,
            closureDigest,
            sequence,
            at,
            authority: structuredClone(authority),
            localConfigDigest: factoryConfigDigest(config),
            localHostLayout: hostLayout(config),
            transportOutcome: "unavailable",
            ...(record.hold === "needs-restore"
              ? {
                  priorHold: {
                    kind: "needs-restore",
                    ...(record.error ? { error: record.error } : {}),
                  },
                }
              : {}),
          };
          record.lastAcknowledged = {
            commitSha: verified.commitSha,
            payloadDigest: verified.payloadDigest,
            at,
            sequence,
          };
          record.acknowledgedSequence = sequence;
          record.sequence = sequence + 1;
          record.dirtySince = at;
          record.changed = [
            { path: "archive/restoration-receipt", kind: "historical" },
          ];
          if (record.hold === "needs-restore") {
            delete record.hold;
            delete record.error;
          }
        }),
        options,
      );
    } catch (error) {
      if (isCheckpointAdmissionFailure(error)) throw error;
      throw new CheckpointAdmissionFailure(
        error instanceof Error
          ? error.message
          : "Restored checkpoint baseline unavailable",
        "explicit",
      );
    } finally {
      releaseGuard(p.publicationGuard);
    }
  });
}
/** Logical reachable Git bytes; compression, remote allocation and caches are not measured. */
export async function inspectRecoveryCheckpoint(
  config: FactoryConfig,
): Promise<RecoveryCheckpointInspection> {
  const options = settings(config);
  if (!options) throw new Error("Git persistence is not configured");
  await verifyDestination(config, options);
  const traversals: QueueLineageCapacity[] = [];
  const archive = await freshArchive(
    config,
    options,
    undefined,
    true,
    undefined,
    (capacity) => traversals.push(capacity),
  );
  if (!archive.reachableHistory)
    throw new Error("Reachable archive history inspection is unavailable");
  const refs = allRefs(archive.manifest);
  const logicalFileBytes = archive.manifest.files.reduce(
    (bytes, file) => bytes + file.ref.bytes,
    0,
  );
  const uniqueBodyBytes = refs.reduce((bytes, ref) => bytes + ref.bytes, 0);
  if (
    !Number.isSafeInteger(logicalFileBytes) ||
    !Number.isSafeInteger(uniqueBodyBytes)
  )
    throw new Error(
      "Current checkpoint logical size exceeds exact integer range",
    );
  return {
    binding: archive.manifest.binding,
    commitSha: archive.commitSha,
    remoteTip: archive.remoteTip,
    current: {
      manifestBytes: archive.manifestBytes,
      logicalFileBytes,
      uniqueBodyBytes,
      uniqueBodies: refs.length,
      logicalFiles: archive.manifest.files.length,
    },
    reachableHistory: archive.reachableHistory,
    storage: "git-logical-bytes",
    capacity: {
      limits: {
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
        manifestBufferBytes: options.maxBytes + 65536,
      },
      current: {
        bytes: archive.manifestBytes + uniqueBodyBytes,
        files: archive.manifest.files.length + refs.length + 1,
        byteHeadroom:
          options.maxBytes - archive.manifestBytes - uniqueBodyBytes,
        fileHeadroom:
          options.maxFiles - archive.manifest.files.length - refs.length - 1,
      },
      cancellationAncestry: traversals.length
        ? { availability: "available", traversals }
        : { availability: "unavailable", reason: "not-traversed" },
    },
  };
}
function acknowledge(
  config: FactoryConfig,
  options: GitPersistenceConfig,
  attempt: CheckpointAttempt,
): RecoveryCheckpointStatus {
  return status(
    mutate(config, options, (record) => {
      assertRetentionResolved(record);
      const current = record.attempts.find(
        (entry) => entry.candidate === attempt.candidate,
      );
      if (
        !current ||
        canonical({ ...current, status: attempt.status }) !== canonical(attempt)
      )
        throw new Error("Attempt changed before acknowledgement");
      current.status = "acknowledged";
      record.lastAcknowledged = {
        commitSha: attempt.candidate,
        payloadDigest: attempt.payloadDigest,
        at: new Date().toISOString(),
        sequence: attempt.sequence,
      };
      record.acknowledgedSequence = attempt.sequence;
      if (record.sequence === attempt.sequence) {
        record.changed = [];
        delete record.dirtySince;
      }
      delete record.error;
    }),
    options,
  );
}
export async function synchronizeRecoveryCheckpoint(
  config: FactoryConfig,
  input: {
    reason: "before-effect" | "settled" | "explicit";
    buildClosure?: () => Promise<RecoveryCheckpointClosure>;
  },
): Promise<RecoveryCheckpointStatus> {
  return serializePublication(config.repository, async () => {
    try {
      return await publishCheckpoint(config, input);
    } catch (error) {
      if (isCheckpointAdmissionFailure(error)) throw error;
      throw new CheckpointAdmissionFailure(
        error instanceof Error ? error.message : "Checkpoint admission failed",
        input.reason,
      );
    }
  });
}
async function serializePublication<T>(
  repository: string,
  task: () => Promise<T>,
): Promise<T> {
  const predecessor = publications.get(repository) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((done) => {
    release = done;
  });
  const tail = predecessor.then(() => completion);
  publications.set(repository, tail);
  await predecessor;
  try {
    return await task();
  } finally {
    release();
    if (publications.get(repository) === tail) publications.delete(repository);
  }
}
const publications = new Map<string, Promise<void>>();
async function publishCheckpoint(
  config: FactoryConfig,
  input: {
    reason: "before-effect" | "settled" | "explicit";
    buildClosure?: () => Promise<RecoveryCheckpointClosure>;
  },
): Promise<RecoveryCheckpointStatus> {
  const options = settings(config);
  if (!options) return gitPersistenceStatus(config);
  const p = paths(config.repository);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  takeGuard(p.publicationGuard);
  try {
    await verifyDestination(config, options);
    let record = journal(config, options);
    const build =
      scopes.getStore()?.buildClosure ??
      input.buildClosure ??
      (async () => {
        const { buildRecoveryCheckpointClosure } = await import(
          "./recovery-checkpoint-closure.js"
        );
        return buildRecoveryCheckpointClosure({ config, scope: options.scope });
      });
    const buildScoped = () =>
      withRecoveryCheckpointScope({ config, buildClosure: build }, build);
    if (record.retentionGaps?.length) {
      await buildScoped();
      record = journal(config, options);
      assertRetentionResolved(record);
    }
    const previous = record.attempts.at(-1);
    if (previous && previous.status !== "acknowledged") {
      // Observation can establish an old submission. It never grants a second push.
      const recovered = await freshArchive(config, options, previous.candidate);
      if (recovered.payloadDigest !== previous.payloadDigest)
        throw new Error(
          "Observed checkpoint differs from retained attempted payload",
        );
      acknowledge(config, options, previous);
      record = journal(config, options);
      if (
        record.sequence === record.acknowledgedSequence ||
        input.reason !== "before-effect"
      )
        return status(record, options);
    }
    if (record.hold === "needs-restore")
      throw new CheckpointRestoreRequired(
        "Existing archive requires verified latest restoration before publication",
      );
    if (record.hold)
      throw new CheckpointConflict(
        "Checkpoint publication is held after an archive conflict; verified restoration is required",
      );
    if (
      record.lastAcknowledged &&
      record.sequence === record.acknowledgedSequence &&
      input.reason !== "explicit"
    )
      return status(record, options);
    if (
      input.reason === "settled" &&
      record.dirtySince &&
      Date.now() - Date.parse(record.dirtySince) < options.coalesceMs
    )
      return status(record, options);
    let sequence = record.sequence;
    const closure = await buildScoped();
    record = journal(config, options);
    assertRetentionResolved(record);
    const manifest: RecoveryCheckpointManifest = {
      ...closure,
      schemaVersion: 1,
      binding: binding(config, options),
      createdAt: new Date().toISOString(),
      sequence,
      ...(options.scope === "private-history"
        ? { authority: checkpointAuthority(config) }
        : {}),
    };
    assertManifest(manifest, manifest.binding, options);
    const store = new LocalContentStore(
      join(stateRoot(config.repository), "content"),
    );
    const blobs = allRefs(manifest).map((ref) => ({
      ref,
      bytes: store.readBytes(ref),
    }));
    if (
      input.reason === "explicit" &&
      record.lastAcknowledged &&
      record.sequence === record.acknowledgedSequence
    ) {
      const acknowledged = await freshArchive(
        config,
        options,
        record.lastAcknowledged.commitSha,
      );
      if (acknowledged.remoteTip !== record.lastAcknowledged.commitSha)
        throw new CheckpointConflict(
          "Remote archive advanced outside the acknowledged writer; conflict requires inspection",
        );
      if (acknowledged.payloadDigest !== record.lastAcknowledged.payloadDigest)
        throw new Error(
          "Verified archived bytes differ from the retained acknowledgement",
        );
      if (closureIdentity(closure) === closureIdentity(acknowledged.manifest))
        return status(journal(config, options), options);
      let observedSequence = sequence;
      record = mutate(config, options, (current) => {
        if (current.sequence !== sequence) return;
        current.sequence++;
        if (!Number.isSafeInteger(current.sequence))
          throw new Error("Checkpoint sequence overflow");
        observedSequence = current.sequence;
        current.dirtySince ??= new Date().toISOString();
        current.changed.push({
          path: "archive/explicit-material",
          kind: "historical",
        });
      });
      sequence = observedSequence;
      manifest.sequence = sequence;
      assertManifest(manifest, manifest.binding, options);
    }
    initializeGit(p.git, options);
    const base = await remoteTip(p.git, options);
    let verifiedBaseEntries: { ref: ContentRef; oid: string }[] = [];
    if (base) {
      if (!record.lastAcknowledged) {
        const missingBaseline =
          record.sequence === 0 &&
          !record.attempts.length &&
          !record.changed.length;
        const Failure = missingBaseline
          ? CheckpointRestoreRequired
          : CheckpointConflict;
        throw new Failure(
          "Existing archive has no locally acknowledged restored baseline; read-only restoration is required before publication",
        );
      }
      if (base !== record.lastAcknowledged.commitSha)
        throw new CheckpointConflict(
          "Remote archive advanced outside the acknowledged writer; conflict requires inspection",
        );
      await gitRemote(p.git, options, [
        "fetch",
        "--no-tags",
        "--",
        options.remote,
        options.ref,
      ]);
      const fetched = git(p.git, options, ["rev-parse", "FETCH_HEAD"])
        .toString("utf8")
        .trim();
      if (fetched !== base)
        throw new CheckpointConflict(
          "Remote checkpoint changed during base fetch",
        );
      verifiedBaseEntries = readArchive(
        p.git,
        base,
        config,
        options,
      ).blobEntries;
    } else if (record.lastAcknowledged)
      throw new CheckpointConflict(
        "Acknowledged archive ref is missing; no branch recreation is admitted",
      );
    const manifestBytes = Buffer.from(canonical(manifest));
    const manifestBlob = git(
      p.git,
      options,
      ["hash-object", "-w", "--stdin"],
      manifestBytes,
    )
      .toString("utf8")
      .trim();
    // Reuse only identities fully authenticated by this publication's fresh
    // base fetch. Current local bytes were independently checked above, and
    // the complete collection remains bounded before selecting new bodies.
    assertBodyBounds(
      blobs.map(({ ref }) => ref),
      options,
    );
    const verifiedBase = new Map(
      verifiedBaseEntries.map((entry) => [entry.ref.digest, entry]),
    );
    const blobEntries: { ref: ContentRef; oid: string }[] = [];
    const newBodies = blobs.filter(({ ref }) => {
      const prior = verifiedBase.get(ref.digest);
      if (!prior || canonical(prior.ref) !== canonical(ref)) return true;
      blobEntries.push({ ref, oid: prior.oid });
      return false;
    });
    blobEntries.push(
      ...writeRecoveryCheckpointBodies(p.git, options, newBodies),
    );
    const blobsTree = git(
      p.git,
      options,
      ["mktree"],
      blobEntries
        .map(({ ref, oid }) => `100644 blob ${oid}\t${ref.digest}\n`)
        .join(""),
    )
      .toString("utf8")
      .trim();
    const tree = git(
      p.git,
      options,
      ["mktree"],
      `040000 tree ${blobsTree}\tblobs\n100644 blob ${manifestBlob}\tcheckpoint.json\n`,
    )
      .toString("utf8")
      .trim();
    const candidate = git(
      p.git,
      options,
      [
        "-c",
        "user.name=Factory checkpoint",
        "-c",
        "user.email=checkpoint@factory.invalid",
        "commit-tree",
        tree,
        ...(base ? ["-p", base] : []),
      ],
      "Factory exact recovery checkpoint\n",
    )
      .toString("utf8")
      .trim();
    const attempt: CheckpointAttempt = {
      ...(base ? { base } : {}),
      candidate,
      payloadDigest: hash(manifestBytes),
      sequence,
      preparedAt: new Date().toISOString(),
      status: "prepared",
      transportOutcome: "not-dispatched",
    };
    mutate(config, options, (current) => {
      current.attempts.push(attempt);
      delete current.error;
    });
    await verifyDestination(config, options);
    if ((await remoteTip(p.git, options)) !== base) {
      mutate(config, options, (current) => {
        current.attempts.at(-1)!.status = "conflict";
        current.error =
          "Remote checkpoint changed before push; candidate was not dispatched";
      });
      throw new CheckpointConflict(
        "Remote checkpoint changed before bounded publication",
      );
    }
    mutate(config, options, (current) => {
      const active = current.attempts.at(-1)!;
      active.status = "submitted";
      active.transportOutcome = "unknown";
      active.submittedAt = new Date().toISOString();
    });
    try {
      await gitRemote(p.git, options, [
        "push",
        "--porcelain",
        "--",
        options.remote,
        `${candidate}:${options.ref}`,
      ]);
    } catch {
      mutate(config, options, (current) => {
        current.attempts.at(-1)!.status = "unknown";
        current.error =
          "Git publication outcome is unknown; only exact remote observation is allowed";
      });
      throw new Error(
        "Git publication outcome is unknown; no automatic retry is admitted",
      );
    }
    mutate(config, options, (current) => {
      current.attempts.at(-1)!.transportOutcome = "response-success";
    });
    const verified = await freshArchive(config, options, candidate);
    if (verified.payloadDigest !== attempt.payloadDigest)
      throw new Error(
        "Independent remote payload differs from submitted checkpoint",
      );
    const submitted = journal(config, options).attempts.at(-1)!;
    return acknowledge(config, options, submitted);
  } catch (error) {
    try {
      mutate(config, options, (record) => {
        if (
          !(
            error instanceof CheckpointRestoreRequired &&
            record.hold === "needs-restore" &&
            record.error
          )
        )
          record.error =
            error instanceof Error
              ? error.message
              : "Checkpoint synchronization failed";
        const attempt = record.attempts.at(-1);
        if (attempt?.status === "submitted") attempt.status = "unknown";
        if (error instanceof CheckpointConflict) record.hold = "conflict";
        if (error instanceof CheckpointRestoreRequired)
          record.hold = "needs-restore";
      });
    } catch {
      /* Original fence is preserved if even local status cannot be written. */
    }
    throw new CheckpointAdmissionFailure(
      error instanceof Error
        ? error.message
        : "Recovery checkpoint is not remotely acknowledged",
      input.reason,
    );
  } finally {
    releaseGuard(p.publicationGuard);
  }
}
