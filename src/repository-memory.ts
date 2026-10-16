import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stateRoot } from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import { parseDiscoveryBody } from "./discovery.js";
import { validOwnershipPath } from "./ownership.js";
import { acceptedPlanningDecisionContext } from "./planning-decision-context.js";
import { markCheckpointDirty } from "./recovery-checkpoint.js";
import {
  type ContinuationState,
  isExecutionState,
  type WorkState,
} from "./state.js";

export type MemoryVisibility = "repository" | "private";
export type MemoryKind =
  | "observation"
  | "discovery"
  | "repository-map"
  | "hypothesis"
  | "decision"
  | "diagnosed-correction"
  | "failure"
  | "handoff"
  | "episode"
  | "lesson"
  | "reference";

/** Provenance authenticates origin; no memory confers new source or effect authority. */
export interface RepositoryMemoryRecord {
  schemaVersion: 1;
  repository: string;
  visibility: MemoryVisibility;
  kind: MemoryKind;
  producer: {
    objective?: number;
    runId?: string;
    identity?: string;
    itemId?: string;
    attemptId?: string;
    status: string;
  };
  createdAt: string;
  authority:
    | "observation"
    | "advisory"
    | "human-decision"
    | "acceptance-evidence";
  summary: string;
  bodies: {
    role: string;
    ref?: ContentRef;
    availability: "retained" | "missing-legacy" | "unavailable";
  }[];
  sources: {
    identity: string;
    path?: string;
    heading?: string;
    commitSha?: string;
    treeSha?: string;
    version?: string;
    apiVersion?: string;
    dependencyVersion?: string;
    retrievedAt?: string;
    complete: boolean;
    ref?: ContentRef;
  }[];
  bindings: {
    objective?: number;
    runId?: string;
    graphDigest?: string;
    sourcePacketDigest?: string;
    commitSha?: string;
    selectors?: string[];
    treeSha?: string;
    paths?: { path: string; digest: string }[];
    dependencies?: Record<string, string>;
    environment?: Record<string, string>;
  };
  validity: {
    state: "current" | "historical" | "superseded";
    conditions: string[];
    expiresAt?: string;
  };
  supersedes: string[];
}

export interface RepositoryMemoryBinding {
  id: string;
  manifestRef: ContentRef;
}

/** Decode original immutable bytes without observation deduplication or authority promotion. */
export function decodeRepositoryMemoryManifest(
  binding: RepositoryMemoryBinding,
  bytes: Uint8Array,
): RepositoryMemoryRecord {
  assertRepositoryMemoryBindings([binding]);
  const body = Buffer.from(bytes);
  if (
    body.length !== binding.manifestRef.bytes ||
    createHash("sha256").update(body).digest("hex") !== binding.id
  )
    throw new Error(
      "Imported memory manifest differs from its original identity",
    );
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    body,
  );
  const record: unknown = JSON.parse(raw);
  assertRepositoryMemoryRecord(record);
  if (!Buffer.from(raw).equals(body) || canonical(record) !== raw)
    throw new Error(
      "Imported memory manifest is not its original canonical bytes",
    );
  return record;
}
export interface MemoryAccess {
  repository: string;
  visibility: MemoryVisibility[];
}
export interface MemoryApplicability {
  objective?: number;
  runId?: string;
  graphDigest?: string;
  sourcePacketDigest?: string;
  commitSha?: string;
  treeSha?: string;
  paths?: Record<string, string>;
  dependencies?: Record<string, string>;
  environment?: Record<string, string>;
  conditions?: string[];
  sources?: Record<
    string,
    { version?: string; apiVersion?: string; dependencyVersion?: string }
  >;
}
export interface MemoryResult {
  binding: RepositoryMemoryBinding;
  record: RepositoryMemoryRecord;
  disposition:
    | "current"
    | "historical"
    | "stale"
    | "unavailable"
    | "incomplete";
  content: { role: string; ref: ContentRef; text: string }[];
  gaps: string[];
}
export interface MemoryLookup {
  access: MemoryAccess;
  excludeIds?: string[];
  suppliedSources?: { path: string; heading?: string; digest: string }[];
  /** Automatic context omits machine source snapshots for an already supplied selection. */
  excludeSuppliedSourceHistory?: boolean;
  /** Exact complete bodies already authenticated in the current role packet. */
  suppliedBodyDigests?: string[];
  scope?: {
    objective?: number;
    paths?: string[];
    kinds?: MemoryKind[];
    itemIds?: string[];
  };
  applicability?: MemoryApplicability;
  limit: number;
  /** Bound unique authenticated body bytes; callers separately bound rendered metadata. */
  maxBytes?: number;
}

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Memory value must be an object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, permitted: string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some((key) => !permitted.includes(key)))
    throw new Error("Memory value contains unsupported fields");
  return record;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Memory text must be nonempty and contain no NUL");
}
/** Full-file wire selections use an empty heading; memory stores its optional equivalent. */
export function memorySourceHeading(
  heading: string | undefined,
): string | undefined {
  if (heading === undefined || heading === "") return undefined;
  text(heading);
  return heading;
}
function date(value: unknown): void {
  text(value);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("Invalid memory date");
}
function ref(value: unknown): asserts value is ContentRef {
  const record = keys(value, ["digest", "bytes", "mediaType"]);
  if (
    !isHash(record.digest) ||
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) < 0
  )
    throw new Error("Invalid memory content reference");
  text(record.mediaType);
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error("Memory strings must be an array");
  for (const entry of value) text(entry);
}
function versions(value: unknown): void {
  for (const [key, version] of Object.entries(object(value))) {
    text(key);
    text(version);
  }
}
/** One strict producer/reader contract, also used by operational snapshot validation. */
export function assertRepositoryMemoryRecord(
  value: unknown,
): asserts value is RepositoryMemoryRecord {
  const record = keys(value, [
    "schemaVersion",
    "repository",
    "visibility",
    "kind",
    "producer",
    "createdAt",
    "authority",
    "summary",
    "bodies",
    "sources",
    "bindings",
    "validity",
    "supersedes",
  ]);
  if (
    record.schemaVersion !== 1 ||
    typeof record.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
    !["repository", "private"].includes(String(record.visibility)) ||
    ![
      "observation",
      "discovery",
      "repository-map",
      "hypothesis",
      "decision",
      "diagnosed-correction",
      "failure",
      "handoff",
      "episode",
      "lesson",
      "reference",
    ].includes(String(record.kind)) ||
    ![
      "observation",
      "advisory",
      "human-decision",
      "acceptance-evidence",
    ].includes(String(record.authority))
  )
    throw new Error("Invalid memory record scope or type");
  const producer = keys(record.producer, [
    "objective",
    "runId",
    "identity",
    "itemId",
    "attemptId",
    "status",
  ]);
  if (
    producer.objective !== undefined &&
    (!Number.isSafeInteger(producer.objective) ||
      Number(producer.objective) < 1)
  )
    throw new Error("Invalid memory Objective");
  text(producer.status);
  for (const name of ["runId", "identity", "itemId", "attemptId"])
    if (producer[name] !== undefined) text(producer[name]);
  if (producer.runId === undefined && producer.identity === undefined)
    throw new Error("Memory producer requires its original run or identity");
  date(record.createdAt);
  text(record.summary);
  if (!Array.isArray(record.bodies) || !Array.isArray(record.sources))
    throw new Error("Memory bodies and sources must be arrays");
  for (const value of record.bodies) {
    const body = keys(value, ["role", "ref", "availability"]);
    text(body.role);
    if (
      !["retained", "missing-legacy", "unavailable"].includes(
        String(body.availability),
      ) ||
      (body.availability === "retained" && body.ref === undefined)
    )
      throw new Error("Memory body availability is invalid");
    if (body.ref !== undefined) ref(body.ref);
  }
  for (const value of record.sources) {
    const source = keys(value, [
      "identity",
      "path",
      "heading",
      "commitSha",
      "treeSha",
      "version",
      "apiVersion",
      "dependencyVersion",
      "retrievedAt",
      "complete",
      "ref",
    ]);
    text(source.identity);
    if (
      source.path !== undefined &&
      (typeof source.path !== "string" || !validOwnershipPath(source.path))
    )
      throw new Error("Invalid memory source path");
    if (source.heading !== undefined) text(source.heading);
    for (const name of ["commitSha", "treeSha"])
      if (
        source[name] !== undefined &&
        (typeof source[name] !== "string" ||
          !/^[a-f0-9]{40,64}$/.test(source[name]))
      )
        throw new Error("Invalid memory source revision");
    for (const name of ["version", "apiVersion", "dependencyVersion"])
      if (source[name] !== undefined) text(source[name]);
    if (source.retrievedAt !== undefined) date(source.retrievedAt);
    if (typeof source.complete !== "boolean")
      throw new Error("Memory source completeness is invalid");
    if (source.ref !== undefined) ref(source.ref);
  }
  const bindings = keys(record.bindings, [
    "objective",
    "runId",
    "graphDigest",
    "sourcePacketDigest",
    "commitSha",
    "selectors",
    "treeSha",
    "paths",
    "dependencies",
    "environment",
  ]);
  if (bindings.selectors !== undefined) {
    strings(bindings.selectors);
    if (!bindings.selectors.every(validOwnershipPath))
      throw new Error("Invalid memory source selector");
  }
  if (
    bindings.objective !== undefined &&
    (!Number.isSafeInteger(bindings.objective) ||
      Number(bindings.objective) < 1)
  )
    throw new Error("Invalid memory Objective binding");
  if (bindings.runId !== undefined) text(bindings.runId);
  for (const name of ["graphDigest", "sourcePacketDigest"])
    if (bindings[name] !== undefined && !isHash(bindings[name]))
      throw new Error("Invalid memory source binding");
  if (
    bindings.commitSha !== undefined &&
    (typeof bindings.commitSha !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(bindings.commitSha))
  )
    throw new Error("Invalid memory commit binding");
  if (
    bindings.treeSha !== undefined &&
    (typeof bindings.treeSha !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(bindings.treeSha))
  )
    throw new Error("Invalid memory tree binding");
  if (bindings.paths !== undefined) {
    if (!Array.isArray(bindings.paths))
      throw new Error("Memory path bindings must be an array");
    for (const value of bindings.paths) {
      const path = keys(value, ["path", "digest"]);
      if (
        typeof path.path !== "string" ||
        !validOwnershipPath(path.path) ||
        !isHash(path.digest)
      )
        throw new Error("Invalid memory path binding");
    }
  }
  for (const name of ["dependencies", "environment"])
    if (bindings[name] !== undefined) versions(bindings[name]);
  const validity = keys(record.validity, ["state", "conditions", "expiresAt"]);
  if (!["current", "historical", "superseded"].includes(String(validity.state)))
    throw new Error("Invalid memory validity");
  strings(validity.conditions);
  if (validity.expiresAt !== undefined) date(validity.expiresAt);
  strings(record.supersedes);
  if (!record.supersedes.every(isHash))
    throw new Error("Invalid superseded memory identity");
}

export function assertRepositoryMemoryBindings(
  value: unknown,
): asserts value is RepositoryMemoryBinding[] {
  if (!Array.isArray(value))
    throw new Error("Memory bindings must be an array");
  const seen = new Set<string>();
  for (const valueEntry of value) {
    const binding = keys(valueEntry, ["id", "manifestRef"]);
    ref(binding.manifestRef);
    if (
      !isHash(binding.id) ||
      binding.id !== binding.manifestRef.digest ||
      binding.manifestRef.mediaType !== "application/json" ||
      seen.has(binding.id)
    )
      throw new Error("Invalid or duplicate memory manifest binding");
    seen.add(binding.id);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function meaningfulRecord(record: RepositoryMemoryRecord): string {
  const immutableReference =
    record.kind === "reference" &&
    record.sources.length > 0 &&
    record.sources.every(
      (source) =>
        source.commitSha && source.treeSha && source.version && source.ref,
    );
  return canonical({
    ...record,
    createdAt: undefined,
    // An unchanged pinned Git selection keeps its first actual observation time.
    // External/API refresh records still distinguish their retrieval events.
    ...(immutableReference
      ? {
          sources: record.sources.map((source) => ({
            ...source,
            retrievedAt: undefined,
          })),
        }
      : {}),
  });
}
class MemoryStorageDenied extends Error {}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(path) !== resolve(path)
  )
    throw new MemoryStorageDenied(
      "Memory storage must be an owned private directory without links",
    );
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new MemoryStorageDenied(
        "Memory manifest pointer must be an owned private file",
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function append(path: string, bytes: string): void {
  if (existsSync(path)) {
    if (privateRead(path) !== bytes)
      throw new Error("Immutable memory identity has different retained bytes");
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        privateRead(path) !== bytes
      )
        throw error;
    }
    const directory = openSync(join(path, ".."), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Immutable manifests and supporting bodies outlive worktrees and native sessions.
 * No automatic forgetting or cleanup is permitted here. Catalog rows have no lifecycle authority.
 */
export class LocalRepositoryMemory {
  private readonly directory: string;
  private readonly records: string;
  private readonly store: LocalContentStore;
  private retainedIdentities?: Map<string, RepositoryMemoryBinding>;
  private retainedIdentitiesComplete = false;
  private readonly observedBodies = new Map<string, Buffer>();
  catalogStatus: "ready" | "unavailable" = "unavailable";
  constructor(
    root: string,
    readonly repository: string,
    store?: LocalContentStore,
    stateBindings: RepositoryMemoryBinding[] = [],
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Invalid memory repository scope");
    privateDirectory(root);
    this.directory = join(root, "memory");
    this.records = join(this.directory, "records");
    privateDirectory(this.directory);
    privateDirectory(this.records);
    this.store = store ?? new LocalContentStore(join(root, "content"));
    if (stateBindings.length) {
      assertRepositoryMemoryBindings(stateBindings);
      this.retainedIdentities = new Map();
      for (const binding of [...stateBindings].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        try {
          const original = this.manifest(binding.id);
          if (canonical(original.binding) !== canonical(binding)) continue;
          this.retainedIdentities.set(
            meaningfulRecord(original.record),
            original.binding,
          );
        } catch (error) {
          // Unavailable originals supply no reuse, just as in a full scan.
          if (error instanceof MemoryStorageDenied) throw error;
        }
      }
    }
  }
  /** Reuse already authenticated exact supplied bytes within this lookup instance. */
  suppliedContent(bytes: Uint8Array): void {
    const body = Buffer.from(bytes);
    this.observedBodies.set(
      createHash("sha256").update(body).digest("hex"),
      body,
    );
  }
  private observedBody(ref: ContentRef): Buffer {
    const existing = this.observedBodies.get(ref.digest);
    if (existing) {
      if (existing.length !== ref.bytes)
        throw new Error("Supplied memory body size differs");
      return existing;
    }
    const bytes = this.store.readBytes(ref);
    this.observedBodies.set(ref.digest, bytes);
    return bytes;
  }
  retain(record: RepositoryMemoryRecord): RepositoryMemoryBinding {
    assertRepositoryMemoryRecord(record);
    if (record.repository !== this.repository)
      throw new Error("Memory repository differs from the retained root");
    // Missing legacy references are retained as declared, never reconstructed.
    for (const body of record.bodies)
      if (body.availability === "retained") this.store.readBytes(body.ref!);
    for (const source of record.sources)
      if (source.ref !== undefined && source.complete)
        this.store.readBytes(source.ref);
    const meaningful = meaningfulRecord(record);
    // Verified state-bound originals cover unchanged observations. A genuine
    // miss still acquires the complete repository inventory before retention.
    // Neither map authenticates reads or supplies continuation authority.
    let existing = this.retainedIdentities?.get(meaningful);
    if (!existing && !this.retainedIdentitiesComplete) {
      this.retainedIdentities = new Map(
        this.retained().entries.map((entry) => [
          meaningfulRecord(entry.record),
          entry.binding,
        ]),
      );
      this.retainedIdentitiesComplete = true;
      existing = this.retainedIdentities.get(meaningful);
    }
    if (existing) return existing;
    const manifestRef = this.store.putBytes(Buffer.from(canonical(record)), {
      mediaType: "application/json",
    });
    const binding = { id: manifestRef.digest, manifestRef };
    append(join(this.records, `${binding.id}.json`), canonical(binding));
    markCheckpointDirty(this.repository, {
      path: `memory/records/${binding.id}.json`,
      kind: "memory-binding",
    });
    this.retainedIdentities!.set(meaningful, binding);
    // A failed derived index never prevents retention or changes continuation.
    try {
      this.index(binding, record);
    } catch (error) {
      this.catalogStatus = "unavailable";
      if (error instanceof MemoryStorageDenied) throw error;
    }
    return binding;
  }
  /** Complete eligible originals, without search ranking, body reads or result truncation. */
  recordsForTransfer(selection: {
    access: MemoryAccess;
    ids?: string[];
    scope?: MemoryLookup["scope"];
  }): {
    entries: {
      binding: RepositoryMemoryBinding;
      record: RepositoryMemoryRecord;
      bindingBytes: Buffer;
      manifestBytes: Buffer;
    }[];
    unavailable: string[];
  } {
    if (selection.ids?.some((id) => !isHash(id)))
      throw new Error("Invalid memory transfer identity");
    const retained = this.eligible({
      access: selection.access,
      scope: selection.scope,
      // eligible() checks the shared lookup contract but does not truncate rows.
      limit: 256,
    });
    const selected = new Set(selection.ids);
    const entries = retained.entries.filter(
      (entry) => selection.ids === undefined || selected.has(entry.binding.id),
    );
    if (
      selection.ids?.some(
        (id) => !entries.some((entry) => entry.binding.id === id),
      )
    )
      throw new Error(
        "Requested memory record is unavailable or outside authorized scope",
      );
    return {
      entries: entries.map((entry) => ({
        ...entry,
        bindingBytes: Buffer.from(
          privateRead(join(this.records, `${entry.binding.id}.json`)),
        ),
        manifestBytes: this.store.readBytes(entry.binding.manifestRef),
      })),
      // An unavailable manifest cannot disclose its visibility through its filename.
      unavailable: retained.unavailable.length
        ? ["memory manifest unavailable"]
        : [],
    };
  }
  /** Install the original binding; never recollect it as a new observation. */
  assertTransferScope(
    record: RepositoryMemoryRecord,
    access: MemoryAccess,
    scope?: MemoryLookup["scope"],
  ): void {
    assertRepositoryMemoryRecord(record);
    if (
      !this.accessible(access, record) ||
      !this.inScope(record, { access, scope, limit: 1 })
    )
      throw new Error("Imported memory is outside authorized repository scope");
  }
  assertExactDestination(
    binding: RepositoryMemoryBinding,
    bytes: Uint8Array,
    access: MemoryAccess,
    scope?: MemoryLookup["scope"],
  ): void {
    this.assertTransferScope(
      decodeRepositoryMemoryManifest(binding, bytes),
      access,
      scope,
    );
    const path = join(this.records, `${binding.id}.json`);
    if (existsSync(path) && privateRead(path) !== canonical(binding))
      throw new Error(
        "Immutable memory destination already contains different original bytes",
      );
  }
  installExact(
    binding: RepositoryMemoryBinding,
    bytes: Uint8Array,
    access: MemoryAccess,
    scope?: MemoryLookup["scope"],
  ): void {
    const record = decodeRepositoryMemoryManifest(binding, bytes);
    this.assertExactDestination(binding, bytes, access, scope);
    for (const body of record.bodies)
      if (body.availability === "retained") this.store.readBytes(body.ref!);
    for (const source of record.sources)
      if (source.complete && source.ref) this.store.readBytes(source.ref);
    const installed = this.store.putBytes(bytes, {
      mediaType: binding.manifestRef.mediaType,
    });
    if (canonical(installed) !== canonical(binding.manifestRef))
      throw new Error("Imported memory reference changed during installation");
    append(join(this.records, `${binding.id}.json`), canonical(binding));
    this.retainedIdentities = undefined;
    this.retainedIdentitiesComplete = false;
    this.catalogStatus = "unavailable";
  }
  private accessible(
    access: MemoryAccess,
    record: RepositoryMemoryRecord,
  ): boolean {
    return (
      access.repository === this.repository &&
      record.repository === access.repository &&
      access.visibility.includes(record.visibility)
    );
  }
  private manifest(id: string): {
    binding: RepositoryMemoryBinding;
    record: RepositoryMemoryRecord;
  } {
    if (!isHash(id)) throw new Error("Invalid memory identity");
    const rawBinding = privateRead(join(this.records, `${id}.json`));
    const binding: RepositoryMemoryBinding = JSON.parse(rawBinding);
    assertRepositoryMemoryBindings([binding]);
    if (binding.id !== id || rawBinding !== canonical(binding))
      throw new Error("Memory filename differs from manifest identity");
    const bytes = this.store.readBytes(binding.manifestRef);
    const record: RepositoryMemoryRecord = JSON.parse(bytes.toString("utf8"));
    assertRepositoryMemoryRecord(record);
    if (
      record.repository !== this.repository ||
      canonical(record) !== bytes.toString("utf8")
    )
      throw new Error(
        "Memory manifest differs from its retained scope or canonical bytes",
      );
    return { binding, record };
  }
  private retained(): {
    entries: ReturnType<LocalRepositoryMemory["manifest"]>[];
    unavailable: string[];
  } {
    const entries: ReturnType<LocalRepositoryMemory["manifest"]>[] = [];
    const unavailable: string[] = [];
    for (const name of readdirSync(this.records)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()) {
      try {
        entries.push(this.manifest(name.slice(0, -5)));
      } catch (error) {
        if (error instanceof MemoryStorageDenied) throw error;
        unavailable.push(name.slice(0, -5));
      }
    }
    return { entries, unavailable };
  }
  private database(): DatabaseSync {
    const path = join(this.directory, "catalog.sqlite");
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new MemoryStorageDenied(
          "Memory catalog must be an owned private file without links",
        );
    }
    // Lazy loading leaves existing static Objectives usable on older Node 22.
    const sqlite = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, repository TEXT NOT NULL, visibility TEXT NOT NULL, created TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);",
      );
      this.catalogStatus = "ready";
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private searchable(record: RepositoryMemoryRecord): string {
    const bodies: string[] = [];
    for (const body of record.bodies) {
      if (
        body.availability !== "retained" ||
        !body.ref ||
        body.ref.bytes > 4 * 1024 * 1024
      )
        continue;
      try {
        const bytes = this.observedBody(body.ref);
        const decoded = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (!decoded.includes("\0") && Buffer.from(decoded).equals(bytes))
          bodies.push(decoded);
      } catch {
        /* Retained missing bodies remain visible at read time. */
      }
    }
    return [
      record.summary,
      record.kind,
      canonical(record.bindings),
      canonical(record.sources),
      ...bodies,
    ].join("\n");
  }
  private insert(
    db: DatabaseSync,
    binding: RepositoryMemoryBinding,
    record: RepositoryMemoryRecord,
  ): void {
    db.prepare("INSERT OR IGNORE INTO memory VALUES (?, ?, ?, ?)").run(
      binding.id,
      record.repository,
      record.visibility,
      record.createdAt,
    );
    db.prepare("DELETE FROM memory_fts WHERE id = ?").run(binding.id);
    db.prepare("INSERT INTO memory_fts (id, text) VALUES (?, ?)").run(
      binding.id,
      this.searchable(record),
    );
  }
  private index(
    binding: RepositoryMemoryBinding,
    record: RepositoryMemoryRecord,
  ): void {
    const db = this.database();
    try {
      db.exec("BEGIN IMMEDIATE");
      this.insert(db, binding, record);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  rebuild(): { records: number; unavailable: string[] } {
    const retained = this.retained();
    let db: DatabaseSync | undefined;
    try {
      db = this.database();
      db.exec("BEGIN IMMEDIATE; DELETE FROM memory; DELETE FROM memory_fts;");
      for (const entry of retained.entries)
        this.insert(db, entry.binding, entry.record);
      db.exec("COMMIT");
    } catch (error) {
      this.catalogStatus = "unavailable";
      if (error instanceof MemoryStorageDenied) throw error;
    } finally {
      db?.close();
    }
    return {
      records: retained.entries.length,
      unavailable: retained.unavailable,
    };
  }
  private result(
    entry: ReturnType<LocalRepositoryMemory["manifest"]>,
    applicability: MemoryApplicability | undefined,
    budget: { bytes: number; bodies?: Map<string, Uint8Array> },
    superseded = false,
  ): MemoryResult {
    const { binding, record } = entry;
    const gaps: string[] = [];
    let disposition: MemoryResult["disposition"] =
      record.validity.state === "current" && !superseded
        ? "current"
        : "historical";
    const check = (
      label: string,
      expected: string,
      actual: string | undefined,
    ) => {
      if (actual === expected) return;
      gaps.push(
        `${label}: ${actual === undefined ? "not verified" : "binding mismatch"}`,
      );
      if (disposition === "unavailable" || disposition === "incomplete") return;
      disposition =
        actual === undefined
          ? disposition === "stale"
            ? "stale"
            : "historical"
          : "stale";
    };
    for (const condition of record.validity.conditions)
      if (!applicability?.conditions?.includes(condition)) {
        gaps.push(`validity condition not verified: ${condition}`);
        if (disposition === "current") disposition = "historical";
      }
    if (record.bindings.treeSha)
      check("source tree", record.bindings.treeSha, applicability?.treeSha);
    for (const path of record.bindings.paths ?? [])
      check(
        `path ${path.path}`,
        path.digest,
        applicability?.paths?.[path.path],
      );
    for (const name of [
      "objective",
      "runId",
      "graphDigest",
      "sourcePacketDigest",
      "commitSha",
    ] as const)
      if (record.bindings[name] !== undefined)
        check(
          name,
          String(record.bindings[name]),
          applicability?.[name] === undefined
            ? undefined
            : String(applicability[name]),
        );
    for (const kind of ["dependencies", "environment"] as const)
      for (const [key, expected] of Object.entries(record.bindings[kind] ?? {}))
        check(`${kind} ${key}`, expected, applicability?.[kind]?.[key]);
    if (
      record.validity.expiresAt &&
      Date.parse(record.validity.expiresAt) <= Date.now()
    ) {
      disposition = "stale";
      gaps.push("validity expired");
    }
    if (superseded || record.validity.state === "superseded")
      gaps.push("superseded historical lead");
    const content: MemoryResult["content"] = [];
    for (const body of record.bodies) {
      if (body.availability !== "retained" || !body.ref) {
        gaps.push(
          `${body.role}: ${body.availability === "missing-legacy" ? "missing legacy body" : "referenced bytes unavailable"}`,
        );
        disposition = "unavailable";
        continue;
      }
      try {
        const bytes =
          budget.bodies?.get(body.ref.digest) ?? this.store.readBytes(body.ref);
        if (bytes.length !== body.ref.bytes)
          throw new Error("Retained body size differs");
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
          if (decoded.includes("\0") || !Buffer.from(decoded).equals(bytes))
            throw new Error("Binary body");
        } catch {
          gaps.push(
            `${body.role}: exact binary bytes retained; text lookup unavailable`,
          );
          disposition = "unavailable";
          continue;
        }
        const cost = budget.bodies?.has(body.ref.digest) ? 0 : bytes.length;
        if (cost > budget.bytes) {
          gaps.push(
            `${body.role}: complete body exceeds remaining byte allowance`,
          );
          if (disposition !== "unavailable") disposition = "incomplete";
          continue;
        }
        budget.bytes -= cost;
        budget.bodies?.set(body.ref.digest, bytes);
        content.push({
          role: body.role,
          ref: body.ref,
          text: decoded,
        });
      } catch {
        gaps.push(`${body.role}: referenced bytes unavailable or corrupt`);
        disposition = "unavailable";
      }
    }
    for (const source of record.sources) {
      for (const kind of [
        "version",
        "apiVersion",
        "dependencyVersion",
      ] as const)
        if (source[kind])
          check(
            `source ${source.identity} ${kind}`,
            source[kind],
            applicability?.sources?.[source.identity]?.[kind],
          );
      if (!source.complete || !source.ref) {
        gaps.push(
          `source ${source.identity}: incomplete or unavailable source content`,
        );
        if (disposition !== "unavailable") disposition = "incomplete";
      } else {
        try {
          this.observedBody(source.ref);
        } catch {
          gaps.push(
            `source ${source.identity}: referenced bytes unavailable or corrupt`,
          );
          disposition = "unavailable";
        }
      }
    }
    return { binding, record, disposition, content, gaps };
  }
  private eligible(
    lookup: MemoryLookup,
  ): ReturnType<LocalRepositoryMemory["retained"]> {
    if (
      !Number.isSafeInteger(lookup.limit) ||
      lookup.limit < 0 ||
      lookup.limit > 256 ||
      (lookup.maxBytes !== undefined &&
        (!Number.isSafeInteger(lookup.maxBytes) || lookup.maxBytes < 0))
    )
      throw new Error("Invalid memory lookup bound");
    if (
      lookup.excludeIds !== undefined &&
      (!Array.isArray(lookup.excludeIds) || !lookup.excludeIds.every(isHash))
    )
      throw new Error("Invalid excluded memory identity");
    if (
      lookup.excludeSuppliedSourceHistory !== undefined &&
      typeof lookup.excludeSuppliedSourceHistory !== "boolean"
    )
      throw new Error("Invalid automatic source history selection");
    if (lookup.suppliedSources !== undefined) {
      if (!Array.isArray(lookup.suppliedSources))
        throw new Error("Invalid supplied memory sources");
      for (const source of lookup.suppliedSources) {
        keys(source, ["path", "heading", "digest"]);
        if (!validOwnershipPath(source.path) || !isHash(source.digest))
          throw new Error("Invalid supplied memory source identity");
        memorySourceHeading(source.heading);
      }
    }
    if (
      lookup.suppliedBodyDigests !== undefined &&
      (!Array.isArray(lookup.suppliedBodyDigests) ||
        !lookup.suppliedBodyDigests.every(isHash))
    )
      throw new Error("Invalid supplied memory body digests");
    if (lookup.scope?.itemIds !== undefined) strings(lookup.scope.itemIds);
    if (lookup.access.repository !== this.repository)
      return { entries: [], unavailable: [] };
    if (
      !Array.isArray(lookup.access.visibility) ||
      lookup.access.visibility.some(
        (scope) => !["repository", "private"].includes(scope),
      )
    )
      throw new Error("Invalid memory visibility access");
    const retained = this.retained();
    const excluded = new Set(lookup.excludeIds ?? []);
    retained.entries = retained.entries.filter(
      (entry) =>
        !excluded.has(entry.binding.id) &&
        !(
          entry.record.bodies.length &&
          entry.record.bodies.every(
            (body) =>
              body.ref && lookup.suppliedBodyDigests?.includes(body.ref.digest),
          )
        ) &&
        !(
          entry.record.kind === "reference" &&
          entry.record.bodies.length === 1 &&
          entry.record.sources.some((source) =>
            (lookup.suppliedSources ?? []).some(
              (supplied) =>
                source.path === supplied.path &&
                memorySourceHeading(source.heading) ===
                  memorySourceHeading(supplied.heading) &&
                source.ref?.digest === supplied.digest &&
                entry.record.bodies[0]?.ref?.digest === supplied.digest,
            ),
          )
        ) &&
        !(
          lookup.excludeSuppliedSourceHistory &&
          entry.record.kind === "reference" &&
          entry.record.authority === "observation" &&
          entry.record.producer.status === "observed-supplied-source" &&
          entry.record.bodies.length === 1 &&
          entry.record.bodies[0]?.role === "supplied-source-selection" &&
          entry.record.bodies[0]?.availability === "retained" &&
          entry.record.bodies[0]?.ref !== undefined &&
          entry.record.sources.length === 1 &&
          entry.record.sources[0]?.ref?.digest ===
            entry.record.bodies[0]?.ref?.digest &&
          (lookup.suppliedSources ?? []).some(
            (supplied) =>
              entry.record.sources[0]?.path === supplied.path &&
              memorySourceHeading(entry.record.sources[0]?.heading) ===
                memorySourceHeading(supplied.heading),
          )
        ) &&
        this.accessible(lookup.access, entry.record) &&
        this.inScope(entry.record, lookup),
    );
    return retained;
  }
  private inScope(
    record: RepositoryMemoryRecord,
    lookup: MemoryLookup,
  ): boolean {
    const scope = lookup.scope;
    if (!scope) return true;
    if (scope.kinds && !scope.kinds.includes(record.kind)) return false;
    if (
      scope.itemIds &&
      record.producer.objective === scope.objective &&
      record.producer.itemId !== undefined &&
      !scope.itemIds.includes(record.producer.itemId)
    )
      return false;
    // Relevance never grants source authority, including on a successor of the
    // same Objective. Admit every retained repository body before returning it.
    const admitted = (path: string) =>
      (scope.paths ?? []).some(
        (selector) =>
          path === selector ||
          (selector.endsWith("/") && path.startsWith(selector)),
      );
    if (scope.paths !== undefined) {
      const repositoryPaths = [
        ...(record.bindings.paths ?? []).map((entry) => entry.path),
        ...record.sources
          .filter(
            (source) =>
              source.path !== undefined ||
              source.identity.startsWith("repository:"),
          )
          .map(
            (source) =>
              source.path ?? source.identity.slice("repository:".length),
          ),
      ];
      if (
        record.kind !== "decision" &&
        record.bodies.length &&
        !repositoryPaths.length &&
        !record.bindings.selectors?.length
      )
        return false;
      if (
        repositoryPaths.some((path) => !admitted(path)) ||
        (record.bindings.selectors ?? []).some(
          (selector) => !admitted(selector),
        )
      )
        return false;
    }
    if (
      scope.objective !== undefined &&
      scope.objective === record.producer.objective
    )
      return true;
    if (
      (record.bindings.paths ?? []).some(({ path }) =>
        (scope.paths ?? []).some(
          (selector) =>
            path === selector ||
            (selector.endsWith("/") && path.startsWith(selector)),
        ),
      )
    )
      return true;
    if ((record.bindings.selectors ?? []).some(admitted)) return true;
    if (scope.objective === undefined && scope.paths === undefined) return true;
    if (
      ![
        "decision",
        "repository-map",
        "reference",
        "diagnosed-correction",
      ].includes(record.kind) ||
      record.validity.state !== "current" ||
      (record.validity.expiresAt &&
        Date.parse(record.validity.expiresAt) <= Date.now())
    )
      return false;
    const expected = record.bindings;
    const supplied = lookup.applicability;
    for (const name of [
      "objective",
      "runId",
      "graphDigest",
      "sourcePacketDigest",
      "commitSha",
    ] as const)
      if (expected[name] !== undefined && expected[name] !== supplied?.[name])
        return false;
    if (!expected.treeSha || expected.treeSha !== supplied?.treeSha)
      return false;
    if (
      (record.validity.conditions ?? []).some(
        (condition) => !supplied?.conditions?.includes(condition),
      )
    )
      return false;
    if (
      (expected.paths ?? []).some(
        ({ path, digest }) => supplied?.paths?.[path] !== digest,
      )
    )
      return false;
    for (const kind of ["dependencies", "environment"] as const)
      for (const [name, version] of Object.entries(expected[kind] ?? {}))
        if (supplied?.[kind]?.[name] !== version) return false;
    for (const source of record.sources)
      for (const kind of [
        "version",
        "apiVersion",
        "dependencyVersion",
      ] as const)
        if (
          source[kind] &&
          source[kind] !== supplied?.sources?.[source.identity]?.[kind]
        )
          return false;
    return true;
  }
  /** Eligible manifest metadata only; no supporting body is opened for relevance selection. */
  metadata(
    lookup: MemoryLookup,
    query?: string,
  ): {
    entries: {
      binding: RepositoryMemoryBinding;
      record: RepositoryMemoryRecord;
    }[];
    complete: boolean;
    unavailable: string[];
  } {
    const retained = this.eligible(lookup);
    // Metadata relevance never opens retained bodies and never broadens eligibility.
    const words = query
      ?.match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 32)
      .map((word) => word.toLowerCase());
    if (words?.length)
      retained.entries = retained.entries.filter((entry) => {
        const metadata = JSON.stringify({
          summary: entry.record.summary,
          producer: entry.record.producer,
          sources: entry.record.sources,
          bindings: entry.record.bindings,
        }).toLowerCase();
        return words.some((word) => metadata.includes(word));
      });
    return {
      entries: retained.entries
        .sort((left, right) =>
          right.record.createdAt.localeCompare(left.record.createdAt),
        )
        .slice(0, lookup.limit),
      complete:
        retained.entries.length <= lookup.limit && !retained.unavailable.length,
      unavailable: retained.unavailable.length
        ? ["retained manifest integrity or availability gap"]
        : [],
    };
  }
  catalog(lookup: MemoryLookup): {
    results: MemoryResult[];
    complete: boolean;
    unavailable: string[];
  } {
    const retained = this.eligible(lookup);
    const superseded = new Set(
      retained.entries.flatMap((entry) => entry.record.supersedes),
    );
    const budget = {
      bytes: lookup.maxBytes ?? 262_144,
      bodies: new Map<string, Uint8Array>(),
    };
    const entries = retained.entries
      .sort((left, right) =>
        right.record.createdAt.localeCompare(left.record.createdAt),
      )
      .slice(0, lookup.limit);
    return {
      results: entries.map((entry) =>
        this.result(
          entry,
          lookup.applicability,
          budget,
          superseded.has(entry.binding.id),
        ),
      ),
      complete:
        retained.entries.length <= lookup.limit && !retained.unavailable.length,
      unavailable: retained.unavailable.length
        ? ["retained manifest integrity or availability gap"]
        : [],
    };
  }
  search(lookup: MemoryLookup & { query: string }): MemoryResult[] {
    const retained = this.eligible(lookup);
    const words = lookup.query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 32) ?? [];
    if (!words.length || !retained.entries.length || !lookup.limit) return [];
    const eligible = new Map(
      retained.entries.map((entry) => [entry.binding.id, entry]),
    );
    let selected: typeof retained.entries;
    let db: DatabaseSync | undefined;
    try {
      db = this.database();
      db.exec(
        "BEGIN IMMEDIATE; CREATE TEMP TABLE selected_scope (id TEXT PRIMARY KEY);",
      );
      for (const entry of retained.entries) {
        if (
          !db
            .prepare("SELECT id FROM memory WHERE id = ?")
            .get(entry.binding.id)
        )
          this.insert(db, entry.binding, entry.record);
        db.prepare("INSERT INTO selected_scope VALUES (?)").run(
          entry.binding.id,
        );
      }
      db.exec("COMMIT");
      // Eligible scope is filtered before full-text ranking. No titles from denied roots.
      const visibility = [...new Set(lookup.access.visibility)];
      if (!visibility.length) return [];
      const ids = db
        .prepare(
          `SELECT memory.id FROM memory JOIN selected_scope ON memory.id = selected_scope.id JOIN memory_fts ON memory.id = memory_fts.id WHERE memory.repository = ? AND memory.visibility IN (${visibility.map(() => "?").join(",")}) AND memory_fts MATCH ? ORDER BY bm25(memory_fts), memory.created DESC LIMIT ?`,
        )
        .all(
          this.repository,
          ...visibility,
          words.map((word) => `"${word}"`).join(" OR "),
          lookup.limit,
        );
      selected = ids.flatMap((row) =>
        eligible.has(String(row.id)) ? [eligible.get(String(row.id))!] : [],
      );
    } catch (error) {
      if (error instanceof MemoryStorageDenied) throw error;
      this.catalogStatus = "unavailable";
      selected = retained.entries
        .filter((entry) =>
          words.some((word) =>
            this.searchable(entry.record)
              .toLowerCase()
              .includes(word.toLowerCase()),
          ),
        )
        .slice(0, lookup.limit);
    } finally {
      db?.close();
    }
    const superseded = new Set(
      retained.entries.flatMap((entry) => entry.record.supersedes),
    );
    const budget = {
      bytes: lookup.maxBytes ?? 262_144,
      bodies: new Map<string, Uint8Array>(),
    };
    return selected.map((entry) =>
      this.result(
        entry,
        lookup.applicability,
        budget,
        superseded.has(entry.binding.id),
      ),
    );
  }
  read(
    lookup: Omit<MemoryLookup, "limit"> & { id: string },
  ): MemoryResult | undefined {
    const retained = this.eligible({ ...lookup, limit: 1 });
    const entry = retained.entries.find(
      (entry) => entry.binding.id === lookup.id,
    );
    if (!entry) return undefined;
    return this.result(
      entry,
      lookup.applicability,
      { bytes: lookup.maxBytes ?? 262_144 },
      retained.entries.some((peer) =>
        peer.record.supersedes.includes(entry.binding.id),
      ),
    );
  }
}

/** Observe real retained attempts at the snapshot seam; no model calls or inferred success.
 * Only content-bearing/started attempts are retained. The returned bindings belong in that
 * same atomic continuation snapshot. On failure the caller preserves its original outcome.
 */
export function retainStateMemory(
  state: ContinuationState,
  root: string,
): RepositoryMemoryBinding[] {
  const store = new LocalContentStore(join(root, "content"));
  const memory = new LocalRepositoryMemory(
    root,
    state.repository,
    store,
    state.memoryBindings,
  );
  const bindings: RepositoryMemoryBinding[] = [];
  const retain = (record: RepositoryMemoryRecord) => {
    const binding = memory.retain(record);
    if (!bindings.some((entry) => entry.id === binding.id))
      bindings.push(binding);
  };
  const body = (
    role: string,
    value: unknown,
  ): RepositoryMemoryRecord["bodies"][number] => ({
    role,
    ref: store.putBytes(Buffer.from(canonical(value)), {
      mediaType: "application/json",
    }),
    availability: "retained",
  });
  const retained = (
    role: string,
    contentRef: ContentRef,
  ): RepositoryMemoryRecord["bodies"][number] => {
    try {
      store.readBytes(contentRef);
      return { role, ref: contentRef, availability: "retained" };
    } catch {
      return { role, ref: contentRef, availability: "unavailable" };
    }
  };
  const now = new Date().toISOString();
  const base = (
    itemId: string | undefined,
    work: WorkState | undefined,
  ): RepositoryMemoryRecord => ({
    schemaVersion: 1,
    repository: state.repository,
    visibility: "private",
    kind: "observation",
    producer: {
      objective: state.objective,
      runId: state.runId,
      ...(itemId ? { itemId } : {}),
      ...(work?.attempt ? { attemptId: work.attempt } : {}),
      status:
        work?.status ??
        (state.cancelledAt
          ? "cancelled"
          : isExecutionState(state) && state.finalAcceptance
            ? "accepted"
            : "working"),
    },
    createdAt: now,
    authority: "observation",
    summary: itemId
      ? `Work Item ${itemId}: ${work?.status ?? "unknown"}`
      : `Objective ${state.objective}: retained working observation`,
    bodies: [],
    sources: [],
    bindings: {
      ...(work?.treeSha ? { treeSha: work.treeSha } : {}),
      ...(itemId && isExecutionState(state)
        ? {
            selectors:
              (work?.graphRevisionDigest
                ? state.graphRevisions?.find(
                    (revision) => revision.digest === work.graphRevisionDigest,
                  )?.graph
                : state.graph
              )?.items.find((item) => item.id === itemId)?.ownedPaths ?? [],
          }
        : {}),
      environment: { configDigest: state.configDigest },
    },
    validity: { state: "historical", conditions: [] },
    supersedes: [],
  });
  const observeWork = (itemId: string, work: WorkState) => {
    if (
      !work.attempt &&
      !work.error &&
      !work.knowledge &&
      !work.failedValidation
    )
      return;
    const observation = base(itemId, work);
    observation.kind =
      work.status === "failed" || work.error ? "failure" : "observation";
    observation.bodies = [
      body("attempt-observation", {
        status: work.status,
        step: work.step,
        attempt: work.attempt,
        executionBaseSha: work.executionBaseSha,
        changeRef: work.changeRef,
        treeSha: work.treeSha,
        error: work.error,
        failedValidation: work.failedValidation,
        validation: work.validation,
        acceptancePending: work.acceptancePending,
        acceptanceDecisions: work.acceptanceDecisions,
        assets: work.assets,
        recovery: work.recovery
          ? {
              failure: work.recovery.failure,
              correction: work.recovery.correction,
            }
          : undefined,
      }),
    ];
    retain(observation);
    if (work.discoveryOutput) {
      const output = work.discoveryOutput;
      const discovery = base(itemId, work);
      discovery.kind = "discovery";
      discovery.authority = output.disposition;
      discovery.producer = { ...output.producer, status: output.status };
      discovery.summary = `Discovery ${output.role}: ${output.status}; ${output.selectedEntries} selected entries`;
      const manifestBody = body("discovery-manifest", output);
      const outputBody = retained(output.role, output.body);
      discovery.bodies = [manifestBody, outputBody];
      discovery.sources = [
        {
          identity: `discovery:${output.role}:${output.specificationDigest}`,
          ref: output.body,
          complete:
            output.status === "complete" &&
            outputBody.availability === "retained",
        },
      ];
      discovery.bindings = {
        commitSha: output.source.commitSha,
        treeSha: output.source.treeSha,
        selectors: output.source.selectors,
        environment: { configDigest: state.configDigest },
      };
      discovery.validity = {
        state: output.status === "complete" ? "current" : "historical",
        conditions: [],
      };
      if (outputBody.availability === "retained") {
        const inventory = parseDiscoveryBody(store.readBytes(output.body));
        discovery.bindings.paths = inventory.entries.map((entry) => ({
          path: entry.path,
          digest: entry.content.digest,
        }));
        for (const entry of inventory.entries) {
          const sourceBody = retained(`source:${entry.path}`, entry.content);
          discovery.bodies.push(sourceBody);
          discovery.sources.push({
            identity: `repository:${entry.path}`,
            ref: entry.content,
            complete: sourceBody.availability === "retained",
          });
        }
      }
      retain(discovery);
    }
    for (const decision of work.acceptanceDecisions ?? []) {
      const answer = base(itemId, work);
      answer.kind = "decision";
      answer.authority = "human-decision";
      answer.createdAt = decision.at;
      answer.summary = `Recorded ${decision.outcome} for original criterion: ${decision.criterion}`;
      answer.bindings = {
        objective: state.objective,
        runId: state.runId,
        treeSha: decision.treeSha,
        environment: { configDigest: state.configDigest },
      };
      answer.bodies = [
        body("original-criterion-decision", {
          repository: state.repository,
          objective: state.objective,
          runId: state.runId,
          itemId,
          originalDecision: decision,
          scope:
            "The authenticated original human criterion decision applies only to its original Objective, run and tree; it supplies no inherited current validation or delivery proof.",
        }),
      ];
      retain(answer);
    }
    if (work.knowledge) {
      const knowledge = work.knowledge;
      const handoff = base(itemId, work);
      handoff.kind = "handoff";
      handoff.authority = "advisory";
      handoff.summary =
        knowledge.notes
          // Verification maps index one result's review, not lasting memory.
          .filter((note) => note.kind !== "verification")
          .map((note) => `${note.kind}: ${note.summary}`)
          .join("\n") || "Retained Objective handoff";
      handoff.bodies = [
        retained("handoff", knowledge.recordRef),
        ...knowledge.sources.map((source) =>
          retained(`source:${source.path}`, source.ref),
        ),
      ];
      handoff.sources = knowledge.sources.map((source) => ({
        identity: `repository:${source.path}`,
        complete:
          handoff.bodies.find((body) => body.role === `source:${source.path}`)
            ?.availability === "retained",
        ref: source.ref,
      }));
      handoff.bindings = {
        treeSha: knowledge.treeSha,
        selectors: [...new Set(knowledge.notes.flatMap((note) => note.paths))],
        paths: knowledge.sources.map((source) => ({
          path: source.path,
          digest: source.ref.digest,
        })),
        environment: { configDigest: knowledge.configDigest },
      };
      handoff.validity = { state: "current", conditions: [] };
      retain(handoff);
    }
    if (work.recovery?.correction) {
      const correction = base(itemId, work);
      correction.kind = "diagnosed-correction";
      correction.authority = "advisory";
      correction.summary = `${work.recovery.correction.diagnosis}\n${work.recovery.correction.correction}`;
      correction.bodies = [
        body("diagnosed-correction", {
          failure: work.recovery.failure,
          correction: work.recovery.correction,
        }),
      ];
      correction.validity = { state: "current", conditions: [] };
      retain(correction);
    }
    for (const previous of work.recovery?.history ?? [])
      observeWork(itemId, previous.work);
  };
  if (isExecutionState(state))
    for (const [itemId, work] of Object.entries(state.work))
      observeWork(itemId, work);
  if (isExecutionState(state) && state.acceptedPlanningDecision) {
    const context = acceptedPlanningDecisionContext(state);
    const decision = state.acceptedPlanningDecision.decision;
    const answer = base(undefined, undefined);
    answer.kind = "decision";
    answer.authority = "human-decision";
    answer.createdAt = decision.at;
    answer.summary = `Original planning reply: ${decision.question}\n${decision.answer}`;
    answer.producer.status = "verified-original-planning-answer";
    answer.bodies = [body("accepted-planning-decision", context)];
    answer.sources = [
      {
        identity: `original-plan-review:${state.acceptedPlanningDecision.reviewDigest}`,
        ref: answer.bodies[0]!.ref!,
        complete: true,
      },
    ];
    answer.bindings = {
      objective: state.objective,
      runId: state.runId,
      graphDigest: state.acceptedPlanningDecision.graphDigest,
      ...(state.sourcePacketDigest
        ? { sourcePacketDigest: state.sourcePacketDigest }
        : {}),
      commitSha: state.baseSha,
      environment: { configDigest: state.configDigest },
    };
    answer.validity = { state: "current", conditions: [] };
    retain(answer);
  }
  if (isExecutionState(state))
    for (const decision of state.finalAcceptanceDecisions ?? []) {
      const answer = base(undefined, undefined);
      answer.kind = "decision";
      answer.authority = "human-decision";
      answer.createdAt = decision.at;
      answer.summary = `Recorded ${decision.outcome} for original Objective criterion: ${decision.criterion}`;
      answer.bindings = {
        objective: state.objective,
        runId: state.runId,
        treeSha: decision.treeSha,
        environment: { configDigest: state.configDigest },
      };
      answer.bodies = [
        body("original-objective-criterion-decision", {
          repository: state.repository,
          objective: state.objective,
          runId: state.runId,
          originalDecision: decision,
          scope:
            "Original human criterion decision only; no inherited current implementation acceptance or effect authority.",
        }),
      ];
      retain(answer);
    }
  if (
    state.error ||
    state.cancelledAt ||
    state.planningRecovery ||
    (isExecutionState(state) && state.finalAcceptance)
  ) {
    const observation = base(undefined, undefined);
    observation.kind = state.error ? "failure" : "observation";
    observation.bodies = [
      body("objective-observation", {
        error: state.error,
        cancelledAt: state.cancelledAt,
        planningRecovery: state.planningRecovery,
        acceptance: isExecutionState(state) ? state.finalAcceptance : undefined,
      }),
    ];
    retain(observation);
  }
  return bindings;
}

/** Retain already supplied, approved source bytes; never fetch or reread a source.
 * Original Sources keep their normative authority outside this advisory catalog.
 * A heading selection retains every supplied byte without inventing its whole file.
 */
export function retainPlanningSourceMemory(input: {
  repository: string;
  objective: number;
  runId: string;
  baseSha: string;
  treeSha: string;
  configDigest: string;
  sources: { path: string; heading?: string; content: string }[];
}): RepositoryMemoryBinding[] {
  const root = stateRoot(input.repository);
  const memory = new LocalRepositoryMemory(root, input.repository);
  const store = new LocalContentStore(join(root, "content"));
  const observedAt = new Date().toISOString();
  return input.sources
    .filter((source) => source.path !== "OBJECTIVE")
    .map((source) => {
      const sourceRef = store.putBytes(Buffer.from(source.content), {
        mediaType: "text/plain; charset=utf-8",
      });
      const heading = memorySourceHeading(source.heading);
      const selectedSection = heading !== undefined;
      return memory.retain({
        schemaVersion: 1,
        repository: input.repository,
        visibility: "private",
        kind: "reference",
        producer: {
          objective: input.objective,
          runId: input.runId,
          status: "observed-supplied-source",
        },
        createdAt: observedAt,
        authority: "observation",
        summary: `Retained ${selectedSection ? "complete supplied section of" : "complete supplied source"} ${source.path}${selectedSection ? `#${heading}; underlying whole file was not supplied` : ""}`,
        bodies: [
          {
            role: "supplied-source-selection",
            ref: sourceRef,
            availability: "retained",
          },
        ],
        sources: [
          {
            identity: `${source.path}#${source.heading ?? ""}`,
            path: source.path,
            ...(selectedSection ? { heading } : {}),
            version: sourceRef.digest,
            commitSha: input.baseSha,
            treeSha: input.treeSha,
            retrievedAt: observedAt,
            // Completeness applies to this explicit path/heading selection.
            // The heading and summary retain that the whole file was not supplied.
            complete: true,
            ref: sourceRef,
          },
        ],
        bindings: {
          treeSha: input.treeSha,
          selectors: [source.path],
          ...(!selectedSection
            ? { paths: [{ path: source.path, digest: sourceRef.digest }] }
            : {}),
          environment: { configDigest: input.configDigest },
        },
        validity: { state: "current", conditions: [] },
        supersedes: [],
      });
    });
}
