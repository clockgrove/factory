import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  readAccountingRecords,
  retainAccountingCapture,
} from "./accounting.js";
import { stateRoot } from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import {
  diagnosticPath,
  privateRecords,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import { FACTORY_VERSION } from "./package-metadata.js";
import type { PromptSection } from "./prompt-bytes.js";

/** Observed client boundaries, never submission, billing or server-time authority. */
export interface ModelBoundaryObservation {
  source: "factory-process" | "codex-exec-json" | "codex-trace-safe";
  event:
    | "process-start"
    | "stdin-finished"
    | "stdin-error"
    | "thread-started"
    | "transport-completed"
    | "first-output"
    | "visible-output-item"
    | "response-completed"
    | "stream-terminal"
    | "retry"
    | "tool-start"
    | "tool-end"
    | "tool-result"
    | "turn-completed"
    | "turn-failed"
    | "process-exit"
    | "pipes-closed"
    | "cessation"
    | "telemetry-coverage";
  elapsedMs: number;
  /** Actual pinned trace timestamp, distinct from the local parser observation time. */
  nativeAt?: string;
  nativeThreadId?: string;
  durationMs?: number;
  transport?: "http" | "websocket-connect" | "websocket-request";
  statusCode?: number;
  success?: boolean;
  nativeAttempt?: number;
  retryLayer?: "http" | "stream";
  retryOperation?: "request" | "sampling" | "remote_compaction_v2";
  delayMs?: number;
  tool?: "shell" | "mcp";
  toolCallId?: string;
  /** Native result sequence is completion order, not start order or a provider request ID. */
  nativeToolResultSequence?: number;
  toolName?: string;
  toolNamespace?: string;
  toolOrigin?: "builtin" | "mcp";
  argumentBytes?: number;
  outputBytes?: number;
  outputLines?: number;
  /** Native telemetry preview truncation, not proof of truncated model tool output. */
  outputPreviewTruncated?: boolean;
  toolStatus?: "in_progress" | "completed" | "failed";
  exitCode?: number | null;
  observedBytes?: number;
  truncatedRecords?: number;
  unparsedRecords?: number;
  quarantinedRecords?: number;
  parsedRecords?: number;
  projectedBytes?: number;
  detailDroppedRecords?: number;
  responseCompletedRecords?: number;
  zeroOutputResponseCompletedRecords?: number;
  toolResultRecords?: number;
  transportCompletedRecords?: number;
  retryRecords?: number;
  status?: "observed" | "incomplete" | "unavailable" | "verified";
  /** Native response counters can include prewarm; never add them to outer usage. */
  responseCounters?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
    ttftMs?: number;
  };
  /** Transport acceptance and provider-internal time are not exposed by this path. */
  submission?: "unsupported";
  nativeTransport?: "unsupported";
}

/** Versioned local observation contract; never lifecycle authority. */
export interface InteractionMetadata {
  schemaVersion: 1;
  recordId: string;
  at: string;
  sequence: number;
  repository: string;
  objective: number;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  scopeId?: string;
  invocationId: string;
  providerAttempt: number;
  phase: string;
  kind: "request" | "interaction" | "response" | "usage" | "outcome";
  factoryVersion: string;
  adapter: string;
  configured: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    serviceTier?: import("./config.js").CodexServiceTier;
  };
  reportedModel?: string;
  providerEvent?: string;
  providerSessionId?: string;
  providerMessageId?: string;
  sessionTurn?: {
    mode: "fresh" | "resumed";
    ordinal: number;
    sessionIdentity: string;
    /** Authenticated native append cutoff for resumed Codex turns. */
    boundaryBytes?: number;
    /** Category counters at the authenticated pre-dispatch append boundary. */
    usageBaseline?: import("./contracts.js").ModelInvocationUsage;
  };
  toolCallId?: string;
  role?: "system" | "developer" | "user" | "assistant" | "tool";
  tool?: string;
  configDigest?: string;
  sourceDigest?: string;
  promptDigest?: string;
  schemaDigest?: string;
  durationMs?: number;
  boundary?: ModelBoundaryObservation;
  coverage: "boundary" | "sdk-exposed";
  /** Visible serialized native history, never billed tokens or a complete wire request. */
  visible?: {
    source: "owned-codex-rollout";
    textBytes: number;
    serializedBytes: number;
    digest: string;
    contextSnapshot: boolean;
  };
  /** Native identifiers and timestamps, never tool arguments or process-success inference. */
  nativeTool?: {
    source: "owned-codex-rollout";
    endpoint: "call" | "output";
    callId: string | null;
    name: string | null;
    type: "function" | "custom";
    recordedAt: string | null;
    turnId: string | null;
    status: "observed" | "reported-failed";
    timestampSource?: "native-row" | "native-payload";
    reportedStatus?: "completed" | "failed" | "cancelled" | "in_progress";
    explicitFailure?: true;
  };
  /** SDK items are operations exposed by the adapter, not additional native calls. */
  sdkOperation?: {
    source: "codex-sdk";
    itemId: string;
    kind: "command_execution" | "mcp_tool_call";
    event: "item.started" | "item.updated" | "item.completed";
    status: "in_progress" | "completed" | "failed";
  };
  /** An image-bearing native output; no inference about rendering or billed image tokens. */
  nativeImageOutput?: {
    source: "owned-codex-rollout";
    callId: string | null;
    recordedAt: string | null;
    images: number;
    inlineEncodedImages: number;
    imageReferences: number;
    unknownEncodingImages: number;
    serializedImageBytes: number;
    serializedImageDigest: string;
  };
  /** Each descendant remains a separate accounting scope, bound to the invoking parent. */
  nativeOwnership?: { rootSessionId: string; parentSessionId: string };
  nativeDescendant?: {
    parentSessionId: string;
    childSessionId: string;
    toolCallId?: string;
    relation:
      | "observed-spawn"
      | "observed-reference"
      | "authenticated-owned-home";
    status:
      | "pending-init"
      | "running"
      | "interrupted"
      | "completed"
      | "errored"
      | "shutdown"
      | "not-found"
      | "unknown";
    recordedAt: string | null;
    model?: string;
    reasoningEffort?: string;
    history: "available" | "partial" | "unavailable";
    resourceCessation: "unavailable";
    parentUsageIncludesChild: "unknown";
  };
  nativeRollout?: {
    cliVersion: string | null;
    /** Absent when native history is unavailable; history completeness alone cannot establish tool coverage. */
    toolMetadata?: "available" | "partial";
    modelProvider?: string;
    reportedModel?: string;
    reportedReasoningEffort?: string;
    reportedServiceTier?: string;
    modelContextWindow?: number;
    status: "available" | "partial" | "unavailable";
    turnBoundaryBytes?: number;
    readBytes: number | null;
    totalBytes: number | null;
    observedCompletedResponses: number | null;
    duplicateResponseRecords: number | null;
    conflictingResponseRecords: number | null;
    inheritedHistory: boolean | null;
    childHistory: boolean | null;
    completeRequestCount: "unavailable";
    fullProviderWireAndUpstreamDetails: "unavailable";
    endpointCompleteness: "unavailable";
    latestThreadUsage?: NonNullable<InteractionMetadata["usage"]>["normalized"];
    latestTokenCountUsage?: NonNullable<
      InteractionMetadata["usage"]
    >["normalized"];
  };
  /** Author-owned byte measurements; section ranges are disjoint, other views may overlap. */
  promptComponents?: {
    renderedPromptBytes: number;
    /** Disjoint complete rendered-text ranges, supplied by the actual renderer. */
    sections?: PromptSection[];
    /** Separately exported evidence bodies; never added to inline prompt bytes. */
    exportedEvidenceFileBytes?: number;
    schemaBytes?: number;
    evidenceBytes?: number;
    rolePreambleTaskSplit: "unavailable";
  };
  /** Complete provider conversation, implicit prompts and hidden reasoning are not exposed. */
  content: {
    status: "captured" | "capture-disabled" | "not-exposed" | "unavailable";
    redacted: boolean;
    truncated: boolean;
    originalBytes?: number;
    originalDigest?: string;
    retainedBytes?: number;
    /** Hash of the actually captured text after redaction and UTF-8 truncation. */
    retainedDigest?: string;
    /** Separate explicit opt-in for recovery; omitted on historical records. */
    payloadRetention?: "retained" | "disabled" | "not-exposed" | "unavailable";
    reference?: {
      invocationId: string;
      providerAttempt: number;
      recordId: string;
      /** Exact retained text, never the original unredacted serialization. */
      payload?: ContentRef;
    };
  };
  usage?: {
    scope: "invocation-cumulative" | "provider-call" | "model-breakdown";
    /** Raw input was reported without a verified cached-category inclusion contract. */
    inputSemantics?: "provider-reported-inclusion-unknown";
    /** Stable observation identity where provided; missing means dedup unknown. */
    deduplicationKey?: string;
    /** Native usage observations; tracing identifiers never establish call identity. */
    providerEventId?: string;
    apiCallId?: string;
    providerCallId?: string;
    /** Conflicting or unidentified observations are diagnostics, not accounted calls. */
    ambiguityReason?:
      | "missing-session-identity"
      | "missing-event-identity"
      | "conflicting-counters"
      | "identity-collision";
    conflictingIdentityKinds?: ("event" | "api")[];
    terminal: boolean;
    completeness: "available-categories" | "unavailable";
    normalized: {
      inputTokens?: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
      totalTokens?: number;
    };
    raw?: Record<string, number>;
    rawScope?: "thread-cumulative";
    modelBreakdown?: Record<string, Record<string, number>>;
    cost?: {
      value: number;
      currency: "USD";
      kind: "provider-estimate";
      completeness: "available" | "partial" | "unavailable";
      provenance: string;
    };
  };
  outcome?: {
    stage: "provider" | "parse" | "protocol" | "semantic";
    status: string;
    failureClass?: string;
    /** Provider-native stop reason, when it reported one. */
    stopReason?: string;
  };
}

export interface CapturePolicy {
  enabled: boolean;
  maxBytesPerInvocation: number;
  retainInRecovery?: boolean;
  nativeBoundaryTelemetry?: boolean;
}
export type CaptureContext = Pick<
  InteractionMetadata,
  | "repository"
  | "objective"
  | "runId"
  | "itemId"
  | "attemptId"
  | "scopeId"
  | "invocationId"
  | "providerAttempt"
  | "phase"
  | "adapter"
  | "configured"
  | "configDigest"
  | "sourceDigest"
>;
export type CaptureEvent = Partial<Omit<InteractionMetadata, "content">> &
  Pick<InteractionMetadata, "kind">;
const factoryVersion = FACTORY_VERSION;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function capturePath(
  repository: string,
  invocationId: string,
  providerAttempt: number,
): string {
  if (
    typeof invocationId !== "string" ||
    !invocationId ||
    !Number.isSafeInteger(providerAttempt) ||
    providerAttempt < 1
  )
    throw new Error("Invalid capture identity");
  return join(
    stateRoot(repository),
    "captures",
    `${sha(invocationId)}-${providerAttempt}.ndjson`,
  );
}
function appendPrivate(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("Capture is not a restricted regular file");
    appendFileSync(fd, JSON.stringify(value) + "\n");
  } finally {
    closeSync(fd);
  }
}
function safeObject<T>(value: T, secrets: string[]): T {
  // Redact values individually so quotes/newlines in secrets do not evade JSON escaping.
  if (typeof value === "string")
    return redactDiagnosticDetail(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((v) => safeObject(v, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        redactDiagnosticDetail(k, secrets),
        safeObject(v, secrets),
      ]),
    ) as T;
  return value;
}
/** Observational only: neither serializer nor sink failure may affect provider work. */
export class CaptureWriter {
  private sequence = 0;

  constructor(
    private context: CaptureContext,
    private policy: CapturePolicy | undefined,
    private secrets: string[],
    private emit: (metadata: InteractionMetadata) => void,
    private budget = { retained: 0 },
  ) {}
  record(event: CaptureEvent, content?: () => unknown): void {
    let record: InteractionMetadata | undefined;
    let finalized = false;
    try {
      record = safeObject(
        {
          ...this.context,
          ...event,
          schemaVersion: 1,
          recordId: randomUUID(),
          at: new Date().toISOString(),
          sequence: ++this.sequence,
          factoryVersion,
          coverage: event.coverage ?? "boundary",
          content: {
            status: this.policy?.enabled ? "not-exposed" : "capture-disabled",
            redacted: false,
            truncated: false,
            payloadRetention:
              this.policy?.enabled && this.policy.retainInRecovery === true
                ? "not-exposed"
                : "disabled",
          },
        } as InteractionMetadata,
        this.secrets,
      );
      if (this.policy?.enabled && content) {
        const value = content();
        const original = JSON.stringify(value);
        if (original !== undefined) {
          const redacted = JSON.stringify(safeObject(value, this.secrets));
          const remaining = Math.max(
            0,
            this.policy.maxBytesPerInvocation - this.budget.retained,
          );
          const bytes = Buffer.from(redacted);
          let end = Math.min(bytes.length, remaining);
          while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
            end--;
          const text = bytes.subarray(0, end).toString("utf8");
          const reference: NonNullable<
            InteractionMetadata["content"]["reference"]
          > = {
            invocationId: record.invocationId,
            providerAttempt: record.providerAttempt,
            recordId: record.recordId,
          };
          const root = join(stateRoot(this.context.repository), "captures");
          mkdirSync(root, { recursive: true, mode: 0o700 });
          const directory = lstatSync(root);
          if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
            throw new Error("Capture directory is not private");
          appendPrivate(
            capturePath(
              this.context.repository,
              reference.invocationId,
              reference.providerAttempt,
            ),
            { schemaVersion: 1, recordId: record.recordId, text },
          );
          this.budget.retained += Buffer.byteLength(text);
          record.content = {
            status: "captured",
            redacted: redacted !== original,
            truncated: end < bytes.length,
            originalBytes: Buffer.byteLength(original),
            originalDigest: sha(original),
            retainedBytes: Buffer.byteLength(text),
            retainedDigest: sha(text),
            payloadRetention: "disabled",
            reference,
          };
          if (this.policy.retainInRecovery === true) {
            try {
              const root = join(stateRoot(this.context.repository), "content");
              mkdirSync(root, { recursive: true, mode: 0o700 });
              const directory = lstatSync(root);
              if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
                throw new Error("Capture content directory is not private");
              reference.payload = new LocalContentStore(root).putBytes(
                Buffer.from(text),
                {
                  mediaType: "text/plain; charset=utf-8",
                },
              );
              record.content.payloadRetention = "retained";
            } catch {
              // Optional retention cannot invalidate a successfully captured local record.
              record.content.payloadRetention = "unavailable";
            }
          }
        }
      }
      finalized = true;
      try {
        retainAccountingCapture(record);
      } catch {
        /* Accounting availability never changes provider work. */
      }
      this.emit(record);
    } catch (error) {
      if (record)
        try {
          const unavailable: InteractionMetadata = finalized
            ? record
            : {
                ...record,
                content: {
                  status: "unavailable",
                  redacted: false,
                  truncated: false,
                  payloadRetention:
                    this.policy?.enabled &&
                    this.policy.retainInRecovery === true
                      ? "unavailable"
                      : "disabled",
                },
              };
          try {
            retainAccountingCapture(unavailable);
          } catch {
            /* Accounting sink unavailable. */
          }
          this.emit(unavailable);
        } catch {
          /* diagnostic sink also unavailable */
        }
      try {
        process.stderr.write(
          `Factory interaction capture unavailable: ${redactDiagnosticDetail(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 512)}\n`,
        );
      } catch {
        /* Noninterference includes a closed diagnostic sink. */
      }
    }
  }
}
/** Prefer canonical observations; local diagnostic/progress records are replicas. */
export function readInteractionMetadata(
  repository: string,
  objective: number,
): InteractionMetadata[] {
  const records = new Map<string, InteractionMetadata>();
  const identity = (capture: InteractionMetadata): string =>
    JSON.stringify([
      capture.runId ?? null,
      capture.itemId ?? null,
      capture.attemptId ?? null,
      capture.invocationId,
      capture.providerAttempt,
      capture.recordId,
    ]);
  for (const record of readAccountingRecords(repository, objective))
    if (record.kind === "interaction")
      records.set(identity(record.capture), record.capture);
  const paths = [diagnosticPath(repository, objective)];
  const root = join(stateRoot(repository), "harness");
  if (existsSync(root))
    paths.push(
      ...readdirSync(root)
        .filter((n) => /^[0-9a-f-]{36}\.progress\.ndjson$/.test(n))
        .map((n) => join(root, n)),
    );
  for (const path of paths)
    if (existsSync(path))
      for (const event of privateRecords(path)) {
        const capture = event.capture as InteractionMetadata | undefined;
        if (
          capture?.schemaVersion === 1 &&
          capture.repository === repository &&
          capture.objective === objective
        ) {
          const key = identity(capture);
          if (!records.has(key)) records.set(key, capture);
        }
      }
  return [...records.values()].sort(
    (a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence,
  );
}
/** Explicit sensitive-content read; truncation can mean text is incomplete JSON. */
export function readInteractionContent(
  repository: string,
  reference: NonNullable<InteractionMetadata["content"]["reference"]>,
): string {
  const path = capturePath(
    repository,
    reference.invocationId,
    reference.providerAttempt,
  );
  if (reference.payload) {
    if (reference.payload.mediaType !== "text/plain; charset=utf-8")
      throw new Error("Retained capture payload has an unsupported media type");
    const bytes = new LocalContentStore(
      join(stateRoot(repository), "content"),
    ).readBytes(reference.payload);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (!Buffer.from(text).equals(bytes))
      throw new Error("Retained capture payload is not exact UTF-8 text");
    return text;
  }
  for (const record of privateRecords(path))
    if (
      record.recordId === reference.recordId &&
      typeof record.text === "string"
    )
      return record.text;
  throw new Error("Captured interaction content unavailable");
}
