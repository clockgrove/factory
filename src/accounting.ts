import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
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
import { dirname, join, resolve } from "node:path";
import type { InteractionMetadata } from "./capture.js";
import { stateRoot } from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  ContentRef,
  ModelInvocationObservation,
  WorkerUsageObservation,
} from "./contracts.js";
import {
  markAccountingGap,
  resolveAccountingGap,
  markCheckpointDirty,
  checkpointRetentionGaps,
  type RecoveryCheckpointClosure,
} from "./recovery-checkpoint.js";
import {
  isCodexUsageIdentity,
  normalizeCodexTokenUsage,
  normalizeTokenUsage,
  pickTokenCounters,
} from "./usage.js";

/** Observations never grant execution, recovery, acceptance or budget authority. */
export interface AccountingBinding {
  repository: string;
  objective: number;
  runId: string | null;
  itemId: string | null;
  attemptId: string | null;
  configDigest: string | null;
  scopeId?: string;
}
export type AccountingRecord = {
  schemaVersion: 1;
  binding: AccountingBinding;
  at: string;
} & (
  | { kind: "model"; observation: Omit<ModelInvocationObservation, "capture"> }
  | { kind: "worker"; observation: WorkerUsageObservation }
  | { kind: "interaction"; capture: InteractionMetadata }
);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const safeObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid accounting record");
  return value as Record<string, unknown>;
};
function pick(value: unknown, names: string[]): Record<string, unknown> {
  const object = safeObject(value);
  return Object.fromEntries(
    names.flatMap((name) => {
      const entry = object[name];
      if (entry === undefined) return [];
      if (
        entry !== null &&
        !["string", "number", "boolean"].includes(typeof entry)
      )
        throw new Error("Accounting scalar field is not safe");
      if (typeof entry === "number" && !Number.isFinite(entry))
        throw new Error("Accounting counter is not finite");
      return [[name, entry]];
    }),
  );
}
const observationScalars = [
  "type",
  "invocationId",
  "phase",
  "ordinal",
  "providerAttempt",
  "providerMaxAttempts",
  "profileId",
  "role",
  "adapter",
  "provider",
  "model",
  "reasoningEffort",
  "providerThreadId",
  "durationMs",
  "usageAvailable",
  "retryDelayMs",
  "promptBytes",
  "promptDigest",
  "schemaBytes",
  "schemaDigest",
  "sourcePacketBytes",
  "sourcePacketDigest",
  "responseBytes",
  "responseDigest",
  "providerEvent",
  "providerItemId",
  "providerItemType",
  "tool",
  "failureClass",
];
function observation(
  value: unknown,
): ModelInvocationObservation | WorkerUsageObservation {
  const object = safeObject(value),
    result = pick(object, observationScalars);
  if (object.usage !== undefined)
    result.usage =
      isCodexUsageIdentity(result.adapter) ||
      isCodexUsageIdentity(result.provider)
        ? normalizeCodexTokenUsage(object.usage)
        : normalizeTokenUsage(object.usage);
  if (
    typeof result.invocationId !== "string" ||
    !result.invocationId ||
    ![
      "started",
      "progress",
      "retry-scheduled",
      "completed",
      "failed",
      "response-invalid",
    ].includes(String(result.type)) ||
    typeof result.phase !== "string" ||
    (result.providerAttempt !== undefined &&
      (!Number.isSafeInteger(result.providerAttempt) ||
        Number(result.providerAttempt) < 1))
  )
    throw new Error("Accounting invocation identity is incomplete");
  return result as unknown as ModelInvocationObservation;
}
const captureScalars = [
  "schemaVersion",
  "recordId",
  "at",
  "sequence",
  "repository",
  "objective",
  "runId",
  "itemId",
  "attemptId",
  "scopeId",
  "invocationId",
  "providerAttempt",
  "phase",
  "kind",
  "factoryVersion",
  "adapter",
  "reportedModel",
  "providerEvent",
  "providerSessionId",
  "providerMessageId",
  "toolCallId",
  "role",
  "tool",
  "configDigest",
  "sourceDigest",
  "promptDigest",
  "schemaDigest",
  "durationMs",
  "coverage",
];
const nestedCaptureFields: Record<string, string[]> = {
  configured: ["provider", "model", "reasoningEffort"],
  visible: [
    "source",
    "textBytes",
    "serializedBytes",
    "digest",
    "contextSnapshot",
  ],
  nativeTool: [
    "source",
    "endpoint",
    "callId",
    "name",
    "type",
    "recordedAt",
    "turnId",
    "status",
    "timestampSource",
    "reportedStatus",
    "explicitFailure",
  ],
  sdkOperation: ["source", "itemId", "kind", "event", "status"],
  nativeImageOutput: [
    "source",
    "callId",
    "recordedAt",
    "images",
    "inlineEncodedImages",
    "imageReferences",
    "unknownEncodingImages",
    "serializedImageBytes",
    "serializedImageDigest",
  ],
  nativeOwnership: ["rootSessionId", "parentSessionId"],
  nativeDescendant: [
    "parentSessionId",
    "childSessionId",
    "toolCallId",
    "relation",
    "status",
    "recordedAt",
    "model",
    "reasoningEffort",
    "history",
    "resourceCessation",
    "parentUsageIncludesChild",
  ],
  outcome: ["stage", "status", "failureClass", "stopReason"],
};
const rawCategories = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "thinkingTokens",
];
/** Fixed metadata schema: no prompts, arguments, output text, arbitrary evidence or native homes. */
function safeCapture(value: unknown): InteractionMetadata {
  const input = safeObject(value),
    result = pick(input, captureScalars);
  for (const [key, fields] of Object.entries(nestedCaptureFields))
    if (input[key] !== undefined) result[key] = pick(input[key], fields);
  if (input.sessionTurn !== undefined) {
    const body = safeObject(input.sessionTurn),
      projected = pick(body, [
        "mode",
        "ordinal",
        "sessionIdentity",
        "boundaryBytes",
      ]);
    if (body.usageBaseline !== undefined)
      projected.usageBaseline = normalizeTokenUsage(body.usageBaseline);
    result.sessionTurn = projected;
  }
  if (input.boundary !== undefined) {
    const body = safeObject(input.boundary),
      projected = pick(body, [
        "source",
        "event",
        "elapsedMs",
        "durationMs",
        "transport",
        "statusCode",
        "success",
        "nativeAttempt",
        "retryLayer",
        "retryOperation",
        "delayMs",
        "tool",
        "toolCallId",
        "toolStatus",
        "exitCode",
        "observedBytes",
        "truncatedRecords",
        "unparsedRecords",
        "quarantinedRecords",
        "parsedRecords",
        "status",
        "submission",
        "nativeTransport",
      ]);
    if (body.responseCounters !== undefined) {
      projected.responseCounters = {
        ...normalizeTokenUsage(body.responseCounters),
        ...pick(body.responseCounters, ["ttftMs"]),
      };
    }
    result.boundary = projected;
  }
  if (input.nativeRollout !== undefined) {
    const body = safeObject(input.nativeRollout),
      projected = pick(body, [
        "cliVersion",
        "toolMetadata",
        "modelProvider",
        "reportedModel",
        "reportedReasoningEffort",
        "modelContextWindow",
        "status",
        "turnBoundaryBytes",
        "readBytes",
        "totalBytes",
        "observedCompletedResponses",
        "duplicateResponseRecords",
        "conflictingResponseRecords",
        "inheritedHistory",
        "childHistory",
        "completeRequestCount",
        "fullProviderWireAndUpstreamDetails",
        "endpointCompleteness",
      ]);
    for (const key of ["latestThreadUsage", "latestTokenCountUsage"])
      if (body[key] !== undefined)
        projected[key] = normalizeCodexTokenUsage(body[key]);
    result.nativeRollout = projected;
  }
  if (input.promptComponents !== undefined) {
    const body = safeObject(input.promptComponents),
      projected = pick(body, [
        "renderedPromptBytes",
        "exportedEvidenceFileBytes",
        "schemaBytes",
        "evidenceBytes",
        "rolePreambleTaskSplit",
      ]);
    if (body.sections !== undefined) {
      if (!Array.isArray(body.sections))
        throw new Error("Invalid accounting prompt section metadata");
      projected.sections = body.sections.map((section) =>
        pick(section, ["kind", "startByte", "endByte"]),
      );
    }
    result.promptComponents = projected;
  }
  const content = safeObject(input.content),
    projectedContent = pick(content, [
      "status",
      "redacted",
      "truncated",
      "originalBytes",
      "originalDigest",
      "retainedBytes",
      "retainedDigest",
      "payloadRetention",
    ]);
  if (content.reference !== undefined) {
    const body = safeObject(content.reference),
      reference = pick(body, ["invocationId", "providerAttempt", "recordId"]);
    if (body.payload !== undefined)
      reference.payload = pick(body.payload, ["digest", "bytes", "mediaType"]);
    projectedContent.reference = reference;
  }
  result.content = projectedContent;
  if (input.usage !== undefined) {
    const body = safeObject(input.usage),
      projected = pick(body, [
        "scope",
        "inputSemantics",
        "deduplicationKey",
        "terminal",
        "completeness",
        "rawScope",
      ]);
    projected.normalized = normalizeTokenUsage(body.normalized);
    if (body.raw !== undefined)
      projected.raw = pickTokenCounters(body.raw, rawCategories);
    if (body.modelBreakdown !== undefined)
      projected.modelBreakdown = Object.fromEntries(
        Object.entries(safeObject(body.modelBreakdown)).map(
          ([model, counters]) => [
            model,
            pickTokenCounters(counters, rawCategories),
          ],
        ),
      );
    if (body.cost !== undefined)
      projected.cost = pick(body.cost, [
        "value",
        "currency",
        "kind",
        "completeness",
        "provenance",
      ]);
    result.usage = projected;
  }
  if (
    result.schemaVersion !== 1 ||
    typeof result.recordId !== "string" ||
    !result.recordId ||
    typeof result.invocationId !== "string" ||
    !result.invocationId ||
    !Number.isSafeInteger(result.providerAttempt) ||
    Number(result.providerAttempt) < 1 ||
    !["request", "interaction", "response", "usage", "outcome"].includes(
      String(result.kind),
    )
  )
    throw new Error("Invalid accounting capture identity");
  if (
    !Number.isSafeInteger(result.sequence) ||
    Number(result.sequence) < 1 ||
    typeof result.at !== "string" ||
    !Number.isFinite(Date.parse(result.at)) ||
    typeof result.adapter !== "string" ||
    !result.adapter ||
    typeof result.phase !== "string" ||
    !["boundary", "sdk-exposed"].includes(String(result.coverage)) ||
    !["captured", "capture-disabled", "not-exposed", "unavailable"].includes(
      String(projectedContent.status),
    ) ||
    typeof projectedContent.redacted !== "boolean" ||
    typeof projectedContent.truncated !== "boolean"
  )
    throw new Error("Invalid accounting capture metadata");
  const reference =
    projectedContent.reference as InteractionMetadata["content"]["reference"];
  const payload = reference?.payload;
  if (projectedContent.payloadRetention === "retained") {
    if (
      !payload ||
      reference?.recordId !== result.recordId ||
      reference.invocationId !== result.invocationId ||
      reference.providerAttempt !== result.providerAttempt ||
      payload.digest !== projectedContent.retainedDigest ||
      payload.bytes !== projectedContent.retainedBytes ||
      !/^[a-f0-9]{64}$/.test(payload.digest) ||
      !Number.isSafeInteger(payload.bytes) ||
      payload.bytes < 0 ||
      payload.mediaType !== "text/plain; charset=utf-8"
    )
      throw new Error(
        "Accounting capture payload differs from its exact retained identity",
      );
  } else if (payload)
    throw new Error("Accounting capture declares an unretained payload body");
  return result as unknown as InteractionMetadata;
}
function validateRecord(value: unknown): AccountingRecord {
  const record = safeObject(value),
    binding = safeObject(record.binding);
  if (
    record.schemaVersion !== 1 ||
    typeof record.at !== "string" ||
    !Number.isFinite(Date.parse(record.at)) ||
    typeof binding.repository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(binding.repository) ||
    !Number.isSafeInteger(binding.objective) ||
    Number(binding.objective) < 0 ||
    ["runId", "itemId", "attemptId", "configDigest"].some(
      (key) =>
        binding[key] !== null &&
        (typeof binding[key] !== "string" || !binding[key]),
    )
  )
    throw new Error("Invalid durable accounting binding");
  const exactBinding = pick(binding, [
    "repository",
    "objective",
    "runId",
    "itemId",
    "attemptId",
    "configDigest",
    "scopeId",
  ]);
  const base = {
    schemaVersion: 1 as const,
    binding: exactBinding as unknown as AccountingBinding,
    at: record.at,
  };
  let projected: AccountingRecord;
  if (record.kind === "interaction") {
    const capture = safeCapture(record.capture);
    if (
      capture.repository !== binding.repository ||
      capture.objective !== binding.objective ||
      (capture.runId ?? null) !== binding.runId ||
      (capture.itemId ?? null) !== binding.itemId ||
      (capture.attemptId ?? null) !== binding.attemptId ||
      (capture.configDigest ?? null) !== binding.configDigest ||
      capture.at !== record.at
    )
      throw new Error("Accounting capture differs from its exact owner");
    projected = { ...base, kind: "interaction", capture };
  } else if (record.kind === "model" || record.kind === "worker") {
    const body = observation(record.observation);
    if (
      record.kind === "worker" &&
      (body.phase !== "implementation" ||
        (body as WorkerUsageObservation).role !== "worker")
    )
      throw new Error(
        "Accounting worker phase differs from its observed scope",
      );
    if (
      record.kind === "worker" &&
      (body.providerAttempt === undefined ||
        !["started", "progress", "completed", "failed"].includes(body.type))
    )
      throw new Error("Accounting worker has no actual provider attempt");
    if (
      record.kind === "model" &&
      (![
        "propose",
        "dream",
        "compile",
        "diagnosis",
        "graph-review",
        "result-review",
        "objective-review",
      ].includes(body.phase) ||
        !Number.isSafeInteger((body as ModelInvocationObservation).ordinal) ||
        (body as ModelInvocationObservation).ordinal < 0)
    )
      throw new Error("Accounting model phase or ordinal is invalid");
    projected = {
      ...base,
      kind: record.kind,
      observation: body,
    } as AccountingRecord;
  } else throw new Error("Unsupported durable accounting kind");
  if (canonical(projected) !== canonical(value))
    throw new Error("Unsupported durable accounting fields or counters");
  return projected;
}
const failed = new Map<
  string,
  { record: AccountingRecord; bytes: Buffer; path: string; digest: string }
>();
const seen = new Map<string, string>();
function root(repository: string): string {
  return join(stateRoot(repository), "accounting");
}
function privateDirectory(repository: string): string {
  const directory = root(repository);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(directory) !== resolve(directory)
  )
    throw new Error("Accounting originals require an owned private directory");
  return directory;
}
function privateBytes(path: string): Buffer {
  if (realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new Error("Accounting original parent resolves through a link");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error(
        "Accounting original must be an owned private regular file",
      );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function decodeAccountingRecord(
  repository: string,
  path: string,
  bytes: Uint8Array,
): AccountingRecord {
  if (path !== `accounting/${digest(bytes)}.json`)
    throw new Error("Accounting original differs from its immutable identity");
  const record = validateRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    record.binding.repository !== repository ||
    Buffer.from(`${canonical(record)}\n`).compare(Buffer.from(bytes)) !== 0
  )
    throw new Error(
      "Accounting original differs from its canonical repository binding",
    );
  return record;
}
function retain(record: AccountingRecord): void {
  validateRecord(record);
  const bytes = Buffer.from(`${canonical(record)}\n`),
    hash = digest(bytes),
    path = `accounting/${hash}.json`,
    key = `${record.binding.repository}:${path}`;
  try {
    let changed = false;
    const directory = privateDirectory(record.binding.repository),
      destination = join(directory, `${hash}.json`);
    const store = new LocalContentStore(
      join(stateRoot(record.binding.repository), "content"),
    );
    store.putBytes(bytes, { mediaType: "application/json" });
    if (existsSync(destination)) {
      if (!privateBytes(destination).equals(bytes))
        throw new Error("Accounting original was replaced");
    } else {
      changed = true;
      const temporary = join(directory, `${randomUUID()}.tmp`),
        fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!privateBytes(destination).equals(bytes)) throw error;
      } finally {
        rmSync(temporary, { force: true });
      }
      const directoryFd = openSync(directory, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    if (changed)
      markCheckpointDirty(record.binding.repository, {
        path,
        kind: "accounting",
      });
    resolveAccountingGap(record.binding.repository, { path, digest: hash });
    failed.delete(key);
  } catch (error) {
    failed.set(key, {
      record: structuredClone(record),
      bytes,
      path,
      digest: hash,
    });
    markAccountingGap(record.binding.repository, {
      path,
      digest: hash,
      reason: "local-retention-unavailable",
    });
    throw error;
  }
}
function retainObservation(
  binding: AccountingBinding,
  value: ModelInvocationObservation | WorkerUsageObservation,
  kind: "model" | "worker",
): void {
  const body = observation(value),
    key = canonical([
      binding,
      kind,
      body.invocationId,
      body.providerAttempt ?? null,
    ]);
  if (
    body.type === "progress" &&
    !Object.keys(body.usage ?? {}).length &&
    !(body as ModelInvocationObservation).tool &&
    !["command_execution", "mcp_tool_call"].includes(
      (body as ModelInvocationObservation).providerItemType ?? "",
    )
  )
    return;
  const signature = canonical(body);
  if (seen.get(key) === signature) return;
  retain({
    schemaVersion: 1,
    binding,
    kind,
    at: new Date().toISOString(),
    observation: body,
  } as AccountingRecord);
  seen.set(key, signature);
}
export function retainModelAccounting(
  binding: AccountingBinding,
  value: ModelInvocationObservation,
): void {
  retainObservation(binding, value, "model");
}
export function retainWorkerAccounting(
  binding: AccountingBinding,
  value: WorkerUsageObservation,
): void {
  retainObservation(binding, value, "worker");
}
export function retainAccountingCapture(metadata: InteractionMetadata): void {
  if (
    !["request", "usage", "outcome"].includes(metadata.kind) &&
    !metadata.nativeTool &&
    !metadata.sdkOperation &&
    !metadata.nativeDescendant &&
    !metadata.nativeRollout &&
    !metadata.nativeImageOutput &&
    !metadata.boundary &&
    !metadata.content.reference?.payload
  )
    return;
  const capture = safeCapture(metadata);
  retain({
    schemaVersion: 1,
    kind: "interaction",
    at: capture.at,
    binding: {
      repository: capture.repository,
      objective: capture.objective,
      runId: capture.runId ?? null,
      itemId: capture.itemId ?? null,
      attemptId: capture.attemptId ?? null,
      configDigest: capture.configDigest ?? null,
    },
    capture,
  });
}
/** Pure read; loss of the optional diagnostic log cannot erase these originals. */
export function readAccountingRecords(
  repository: string,
  objective?: number,
): AccountingRecord[] {
  return readAccountingOriginals(repository)
    .map(({ record }) => record)
    .filter(
      (record) =>
        objective === undefined || record.binding.objective === objective,
    );
}
function readAccountingOriginals(
  repository: string,
): { record: AccountingRecord; bytes: Buffer }[] {
  if (!existsSync(root(repository))) return [];
  privateDirectory(repository);
  return readdirSync(root(repository))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => {
      const bytes = privateBytes(join(root(repository), name));
      return {
        record: decodeAccountingRecord(repository, `accounting/${name}`, bytes),
        bytes,
      };
    })
    .sort((left, right) => left.record.at.localeCompare(right.record.at));
}
export function accountingPersistenceClosure(
  repository: string,
): RecoveryCheckpointClosure {
  for (const pending of [...failed.values()])
    if (pending.record.binding.repository === repository) {
      try {
        retain(decodeAccountingRecord(repository, pending.path, pending.bytes));
      } catch {
        /* Existing journal retains the exact missing original fence. */
      }
    }
  for (const gap of checkpointRetentionGaps(repository)) {
    try {
      const original = join(stateRoot(repository), gap.path);
      const bytes = existsSync(original)
        ? privateBytes(original)
        : privateBytes(
            join(
              stateRoot(repository),
              "content",
              gap.digest.slice(0, 2),
              gap.digest,
            ),
          );
      retain(decodeAccountingRecord(repository, gap.path, bytes));
    } catch {
      /* A missing original stays fenced; do not manufacture another observation. */
    }
  }
  const files: RecoveryCheckpointClosure["files"] = [],
    contentRefs = new Map<string, ContentRef>(),
    gaps: RecoveryCheckpointClosure["gaps"] = [];
  for (const pending of failed.values())
    if (pending.record.binding.repository === repository)
      gaps.push({
        path: pending.path,
        reason: "Exact observed accounting original could not be retained",
        availability: "unavailable",
        required: true,
      });
  for (const gap of checkpointRetentionGaps(repository))
    if (!gaps.some((entry) => entry.path === gap.path))
      gaps.push({
        path: gap.path,
        reason: "Exact observed accounting original could not be retained",
        availability: "unavailable",
        required: true,
      });
  const store = new LocalContentStore(join(stateRoot(repository), "content"));
  for (const { record, bytes } of readAccountingOriginals(repository)) {
    const ref = store.putBytes(bytes, { mediaType: "application/json" }),
      path = `accounting/${ref.digest}.json`;
    files.push({ kind: "historical", path, ref, visibility: "private" });
    contentRefs.set(canonical(ref), ref);
    if (record.kind !== "interaction") continue;
    const content = record.capture.content,
      reference = content.reference,
      payload = reference?.payload;
    if (content.payloadRetention === "retained") {
      if (
        !payload ||
        reference?.recordId !== record.capture.recordId ||
        reference.invocationId !== record.capture.invocationId ||
        reference.providerAttempt !== record.capture.providerAttempt ||
        payload.digest !== content.retainedDigest ||
        payload.bytes !== content.retainedBytes ||
        payload.mediaType !== "text/plain; charset=utf-8"
      )
        throw new Error(
          "Accounting capture payload differs from its exact retained identity",
        );
      store.readBytes(payload);
      contentRefs.set(canonical(payload), payload);
    } else if (payload)
      throw new Error("Accounting capture declares an unretained payload body");
  }
  return { files, contentRefs: [...contentRefs.values()], gaps };
}

/** Frozen observational subset. Later observations cannot rewrite a final seal. */
export interface AccountingSeal {
  schemaVersion: 1;
  source: "durable-accounting";
  repository: string;
  objective: number;
  runId: string;
  chargedWorkAttempts: string[];
  records: ContentRef[];
  digest: string;
  coverage: {
    records: number;
    modelInvocations: number;
    workerInvocations: number;
    observedWorkAttempts: string[];
    unobservedWorkAttempts: string[];
    unknownProviderAttemptRecords: number;
    usageAvailableRecords: number;
    usageUnavailableRecords: number;
    wholeWorkflowTotal: "unproven";
  };
}
function sealCoverage(
  records: AccountingRecord[],
  chargedWorkAttempts: string[],
): AccountingSeal["coverage"] {
  const models = new Set<string>(),
    workers = new Set<string>(),
    observed = new Set<string>();
  let unknown = 0,
    available = 0,
    unavailable = 0;
  for (const record of records) {
    const body =
      record.kind === "interaction" ? record.capture : record.observation;
    const key = canonical([
      record.binding.runId,
      record.binding.attemptId,
      body.invocationId,
      body.providerAttempt ?? null,
    ]);
    if (body.providerAttempt === undefined) unknown++;
    const worker =
      record.kind === "worker" ||
      (record.kind === "interaction" &&
        record.capture.phase === "implementation");
    if (worker) {
      workers.add(key);
      if (record.binding.attemptId) observed.add(record.binding.attemptId);
    } else if (record.kind === "model") models.add(key);
    const usage =
      record.kind === "interaction"
        ? record.capture.usage?.normalized
        : record.observation.usage;
    if (Object.keys(usage ?? {}).length) available++;
    else unavailable++;
  }
  return {
    records: records.length,
    modelInvocations: models.size,
    workerInvocations: workers.size,
    observedWorkAttempts: [...observed].sort(),
    unobservedWorkAttempts: chargedWorkAttempts.filter(
      (id) => !observed.has(id),
    ),
    unknownProviderAttemptRecords: unknown,
    usageAvailableRecords: available,
    usageUnavailableRecords: unavailable,
    wholeWorkflowTotal: "unproven",
  };
}
export function buildAccountingSeal(
  repository: string,
  objective: number,
  runId: string,
  chargedWorkAttempts: string[],
): AccountingSeal {
  const records = readAccountingRecords(repository, objective).filter(
    (record) => record.binding.runId === runId,
  );
  const store = new LocalContentStore(join(stateRoot(repository), "content"));
  const refs = records
    .map((record) =>
      store.putBytes(Buffer.from(`${canonical(record)}\n`), {
        mediaType: "application/json",
      }),
    )
    .sort((left, right) => left.digest.localeCompare(right.digest));
  const charged = [...new Set(chargedWorkAttempts)].sort();
  const body = {
    schemaVersion: 1 as const,
    source: "durable-accounting" as const,
    repository,
    objective,
    runId,
    chargedWorkAttempts: charged,
    records: refs,
    coverage: sealCoverage(records, charged),
  };
  return { ...body, digest: digest(Buffer.from(canonical(body))) };
}
/** Metadata-only admission: archive parsing happens before body hydration. */
export function assertAccountingSealBinding(
  repository: string,
  objective: number,
  runId: string,
  seal: AccountingSeal,
): void {
  const source = safeObject(seal),
    coverage = safeObject(source.coverage);
  if (
    source.schemaVersion !== 1 ||
    source.source !== "durable-accounting" ||
    source.repository !== repository ||
    source.objective !== objective ||
    source.runId !== runId ||
    !Number.isSafeInteger(objective) ||
    objective < 0 ||
    !runId ||
    !/^[a-f0-9]{64}$/.test(String(source.digest)) ||
    !Array.isArray(source.records)
  )
    throw new Error("Final accounting seal has invalid scope");
  const ids = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.some((id) => typeof id !== "string" || !id) ||
      canonical([...new Set(value)].sort()) !== canonical(value)
    )
      throw new Error("Final accounting identities are invalid");
    return value;
  };
  const charged = ids(source.chargedWorkAttempts),
    observed = ids(coverage.observedWorkAttempts),
    unobserved = ids(coverage.unobservedWorkAttempts);
  const refs = source.records.map((value) => {
    const ref = pick(value, ["digest", "bytes", "mediaType"]);
    if (
      !/^[a-f0-9]{64}$/.test(String(ref.digest)) ||
      !Number.isSafeInteger(ref.bytes) ||
      Number(ref.bytes) < 0 ||
      ref.mediaType !== "application/json" ||
      canonical(ref) !== canonical(value)
    )
      throw new Error("Final accounting seal contains an invalid reference");
    return ref as unknown as ContentRef;
  });
  if (
    new Set(refs.map((ref) => ref.digest)).size !== refs.length ||
    canonical(refs.map((ref) => ref.digest)) !==
      canonical(refs.map((ref) => ref.digest).sort()) ||
    canonical(charged.filter((id) => !observed.includes(id))) !==
      canonical(unobserved)
  )
    throw new Error(
      "Final accounting seal identities differ from their bindings",
    );
  const counts = pick(coverage, [
    "records",
    "modelInvocations",
    "workerInvocations",
    "unknownProviderAttemptRecords",
    "usageAvailableRecords",
    "usageUnavailableRecords",
    "wholeWorkflowTotal",
  ]);
  if (
    Object.keys(counts).length !== 7 ||
    Object.entries(counts).some(
      ([key, value]) =>
        key !== "wholeWorkflowTotal" &&
        (!Number.isSafeInteger(value) || Number(value) < 0),
    ) ||
    counts.wholeWorkflowTotal !== "unproven" ||
    counts.records !== refs.length ||
    Number(counts.usageAvailableRecords) +
      Number(counts.usageUnavailableRecords) !==
      refs.length ||
    [
      counts.modelInvocations,
      counts.workerInvocations,
      counts.unknownProviderAttemptRecords,
    ].some((value) => Number(value) > refs.length)
  )
    throw new Error("Final accounting coverage is malformed");
  const projected = {
    schemaVersion: 1,
    source: "durable-accounting",
    repository,
    objective,
    runId,
    chargedWorkAttempts: charged,
    records: refs,
    coverage: {
      ...counts,
      observedWorkAttempts: observed,
      unobservedWorkAttempts: unobserved,
    },
  };
  if (
    digest(Buffer.from(canonical(projected))) !== source.digest ||
    canonical({ ...projected, digest: source.digest }) !== canonical(source)
  )
    throw new Error(
      "Final accounting seal differs from its immutable bindings",
    );
}
function assertSealRecords(
  repository: string,
  objective: number,
  runId: string,
  seal: AccountingSeal,
  records: AccountingRecord[],
): void {
  if (
    records.some(
      (record) =>
        record.binding.repository !== repository ||
        record.binding.objective !== objective ||
        record.binding.runId !== runId,
    ) ||
    canonical(seal.coverage) !==
      canonical(sealCoverage(records, seal.chargedWorkAttempts))
  )
    throw new Error(
      "Final accounting coverage differs from its original observations",
    );
}
export function assertAccountingSeal(
  repository: string,
  objective: number,
  runId: string,
  seal: AccountingSeal,
): void {
  assertAccountingSealBinding(repository, objective, runId, seal);
  const store = new LocalContentStore(join(stateRoot(repository), "content"));
  const records = seal.records.map((ref) =>
    decodeAccountingRecord(
      repository,
      `accounting/${ref.digest}.json`,
      store.readBytes(ref),
    ),
  );
  assertSealRecords(repository, objective, runId, seal, records);
}
/** Supplied archive ContentStore, after hydration; never reads a different local root. */
export async function assertAccountingSealContent(
  repository: string,
  objective: number,
  runId: string,
  seal: AccountingSeal,
  readBytes: (ref: ContentRef) => Uint8Array | Promise<Uint8Array>,
): Promise<readonly AccountingRecord[]> {
  assertAccountingSealBinding(repository, objective, runId, seal);
  const records = await Promise.all(
    seal.records.map(async (ref) => {
      const bytes = await readBytes(ref);
      if (bytes.byteLength !== ref.bytes)
        throw new Error(
          "Final accounting receipt size differs from its reference",
        );
      return decodeAccountingRecord(
        repository,
        `accounting/${ref.digest}.json`,
        bytes,
      );
    }),
  );
  assertSealRecords(repository, objective, runId, seal, records);
  return records;
}
