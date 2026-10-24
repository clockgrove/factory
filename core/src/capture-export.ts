/**
 * `factory export-captures ISSUE`: an Objective's model calls as
 * OpenTelemetry spans (OTLP/HTTP JSON), from the run log and, with
 * `--content retained`, its captures (DESIGN.md#Run log). By default
 * a preview: it prints what it would send, or writes it to a local file,
 * and sends nothing. A send needs `--send --endpoint URL --authorize
 * DIGEST`, the digest a preview of exactly that export printed; it binds
 * the endpoint, the content, every batch and the headers. Every event and
 * capture is redacted as it is read, and every exported string again.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  writeSync,
} from "node:fs";
import {
  chosenFiles,
  itemOfEvent,
  num,
  type RunChoice,
  readCapture,
  readRun,
  str,
} from "./diagnostics.js";
import { redact } from "./log.js";
import { captureFile } from "./paths.js";
import { headAndTail } from "./text.js";

export interface ExportOptions {
  logs: string;
  repository: string;
  issue: number;
  runs: RunChoice;
  /** `--invocation ID`: only these model calls, by capture id or span id; every id must match one. */
  invocations?: readonly string[];
  /** `metadata` reads no captured text; `retained` adds the captured request and response. */
  content: "metadata" | "retained";
  /** The collector's base URL; the preview's digest needs it. */
  endpoint?: string;
  secrets: readonly string[];
}

/** One request's bounds: collectors commonly take 4 MiB. */
const BATCH_SPANS = 512;
const BATCH_BYTES = 3 * 1024 * 1024;
/** Each exported body's head and tail, so one span fits a batch. */
const BODY_HALF = 512 * 1024;
/** OTLP's recommended bound on a response. */
const RESPONSE_BYTES = 4 * 1024 * 1024;
const SEND_TIMEOUT_MS = 30_000;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * The exact traces URL: HTTPS (HTTP only to a loopback collector), no
 * credentials, query or fragment; Factory appends `/v1/traces`. A refusal
 * says why `base` isn't one.
 */
export function tracesEndpoint(base: string): string | { refused: string } {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { refused: `--endpoint ${base} isn't a URL` };
  }
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && loopback(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return {
      refused:
        "--endpoint needs HTTPS (or HTTP to a loopback host) without credentials, query or fragment",
    };
  const prefix = url.pathname.replace(/\/$/, "");
  if (prefix.endsWith("/v1/traces"))
    return {
      refused: "--endpoint takes the base URL; Factory appends /v1/traces",
    };
  url.pathname = `${prefix}/v1/traces`;
  return url.href;
}

/**
 * The standard OTLP exporter headers: OTEL_EXPORTER_OTLP_TRACES_HEADERS,
 * else OTEL_EXPORTER_OTLP_HEADERS, as comma-separated URL-encoded
 * `key=value` pairs. A refusal never echoes a value: it usually carries
 * credentials.
 */
export function otlpHeaders(
  environment: NodeJS.ProcessEnv,
): { headers: Record<string, string> } | { refused: string } {
  const name = environment.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    ? "OTEL_EXPORTER_OTLP_TRACES_HEADERS"
    : "OTEL_EXPORTER_OTLP_HEADERS";
  const headers: Record<string, string> = {};
  for (const entry of (environment[name] ?? "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.indexOf("=");
    const key = at > 0 ? entry.slice(0, at).trim() : "";
    let value: string | undefined;
    try {
      value = decodeURIComponent(entry.slice(at + 1).trim());
    } catch {
      value = undefined;
    }
    // RFC 9110: token names, unique ignoring case; values are tab, space,
    // visible ASCII or Latin-1 only.
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      Object.keys(headers).some(
        (other) => other.toLowerCase() === key.toLowerCase(),
      ) ||
      value === undefined ||
      [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return (
          (code < 0x20 && code !== 0x09) ||
          (code >= 0x7f && code < 0xa0) ||
          code > 0xff
        );
      })
    )
      return { refused: `${name} is malformed` };
    headers[key] = value;
  }
  return { headers };
}

interface Span {
  traceId: string;
  spanId: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}

/** An attribute, its strings redacted again (the run log's and the capture's were on read). */
function attribute(
  key: string,
  value: unknown,
  secrets: readonly string[],
): Span["attributes"][number] {
  return {
    key,
    value:
      typeof value === "number" && Number.isInteger(value)
        ? { intValue: String(value) }
        : typeof value === "number"
          ? { doubleValue: value }
          : typeof value === "boolean"
            ? { boolValue: value }
            : {
                stringValue: redact(
                  typeof value === "string" ? value : JSON.stringify(value),
                  secrets,
                ),
              },
  };
}

const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/** Model-usage fields copied as `factory.*` attributes when present. */
const FIELDS = [
  "role",
  "phase",
  "provider",
  "model",
  "effort",
  "outcome",
  "step",
  "item",
  "capture",
  "callId",
  "attemptId",
  "reportedModel",
  "stage",
  "sessionMode",
  "currency",
  "promptDigest",
  "schemaDigest",
  "sourceDigest",
] as const;

/** Numeric and structured model-usage fields copied as `factory.*` attributes when present. */
const MEASURES = [
  "requestBytes",
  "timeToFirstTokenMs",
  "sessionTurn",
  "imageOutputs",
  "promptComponents",
  "nativeTools",
  "providerUsage",
] as const;

/**
 * One root span per model call (its `model-usage` event), in a trace per
 * run; no invented parentage. Ids hash the run and the call's place in it,
 * so a repeat export keeps them.
 */
function spansOf(options: ExportOptions): {
  runs: string[];
  spans: Span[];
  calls: Invocation[];
} {
  const spans: Span[] = [];
  const calls: Invocation[] = [];
  const runs: string[] = [];
  const chosen = options.invocations;
  const secrets = options.secrets;
  for (const file of chosenFiles(options.logs, options.issue, options.runs)) {
    let index = 0;
    readRun(file, 0, secrets, (event) => {
      if (event.event !== "model-usage") return;
      const run = String(event.run);
      const end = Date.parse(event.at);
      if (!Number.isFinite(end)) return;
      const ms = num(event.ms) ?? 0;
      const key = `${options.repository}#${options.issue}:${run}:${index++}`;
      const spanId = hash(`factory-span:${key}`).slice(0, 16);
      const capture = str(event.capture);
      if (
        chosen?.length &&
        !chosen.includes(spanId) &&
        !(capture !== undefined && chosen.includes(capture))
      )
        return;
      if (!runs.includes(run)) runs.push(run);
      calls.push({
        spanId,
        run,
        ...(capture !== undefined ? { capture } : {}),
        ...(str(event.role) ? { role: str(event.role) } : {}),
        ...(str(event.phase) ? { phase: str(event.phase) } : {}),
        ...(itemOfEvent(event) ? { item: itemOfEvent(event) } : {}),
      });
      const attributes = [
        attribute("session.id", `${options.repository}#${options.issue}`, []),
        attribute("factory.run", run, secrets),
        ...FIELDS.flatMap((field) => {
          const value = str(event[field]);
          return value === undefined
            ? []
            : [attribute(`factory.${field}`, value, secrets)];
        }),
        ...(num(event.ms) !== undefined
          ? [attribute("factory.ms", ms, secrets)]
          : []),
        ...(event.tokens && typeof event.tokens === "object"
          ? [attribute("factory.tokens", event.tokens, secrets)]
          : []),
        ...(num(event.costUsd) !== undefined
          ? [attribute("factory.costUsd", event.costUsd, secrets)]
          : []),
        ...(str(event.error) !== undefined
          ? [attribute("factory.error", event.error, secrets)]
          : []),
        ...MEASURES.flatMap((field) => {
          const value = event[field];
          return num(value) !== undefined ||
            (value !== null && typeof value === "object")
            ? [attribute(`factory.${field}`, value, secrets)]
            : [];
        }),
      ];
      if (options.content === "retained") {
        const id = str(event.capture);
        const path = id && captureFile(options.issue, run, id);
        const body = path
          ? readCapture(options.logs, path, secrets)
          : undefined;
        attributes.push(
          attribute(
            "factory.content",
            !id ? "not-captured" : body ? "retained" : "unavailable",
            secrets,
          ),
        );
        for (const part of ["request", "response"] as const) {
          const text = body?.[part];
          if (text !== undefined)
            attributes.push(
              attribute(
                `factory.${part}`,
                headAndTail(text, BODY_HALF, BODY_HALF),
                secrets,
              ),
            );
        }
        if (body?.truncated)
          attributes.push(attribute("factory.truncated", true, secrets));
      }
      spans.push({
        traceId: hash(
          `factory-trace:${options.repository}#${options.issue}:${run}`,
        ).slice(0, 32),
        spanId,
        name: `Factory ${str(event.phase) ?? str(event.role) ?? "model call"}`,
        kind: 1,
        startTimeUnixNano: nanos(Math.max(0, end - ms)),
        endTimeUnixNano: nanos(end),
        attributes,
      });
    });
  }
  return { runs, spans, calls };
}

/** A selected model call: `--invocation` takes its span id, or its capture id. */
export interface Invocation {
  spanId: string;
  run: string;
  capture?: string;
  role?: string;
  phase?: string;
  item?: string;
}

/** One OTLP request body per batch: at most BATCH_SPANS spans and BATCH_BYTES each. */
function batchesOf(spans: Span[]): string[] {
  const request = (batch: Span[]) =>
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "factory" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "factory.capture-export", version: "1" },
              spans: batch,
            },
          ],
        },
      ],
    });
  const batches: string[] = [];
  let batch: Span[] = [];
  let bytes = 0;
  for (const span of spans) {
    const size = Buffer.byteLength(JSON.stringify(span)) + 1;
    if (
      batch.length &&
      (batch.length >= BATCH_SPANS || bytes + size > BATCH_BYTES)
    ) {
      batches.push(request(batch));
      batch = [];
      bytes = 0;
    }
    batch.push(span);
    bytes += size;
  }
  if (batch.length) batches.push(request(batch));
  return batches;
}

/** Binds the endpoint, content, every batch and the headers (names ignoring case, values hashed). */
function authorizationDigest(
  endpoint: string,
  content: string,
  selection: readonly string[],
  batches: string[],
  headers: Record<string, string>,
): string {
  const headerDigest = hash(
    JSON.stringify(
      Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => (a! < b! ? -1 : 1)),
    ),
  );
  return hash(
    JSON.stringify([
      endpoint,
      content,
      [...selection].sort(),
      batches.map(hash),
      headerDigest,
    ]),
  );
}

export interface Prepared {
  preview: {
    repository: string;
    issue: number;
    runs: string[];
    content: ExportOptions["content"];
    spans: number;
    /** The selected model calls; `--invocation` takes a span id or capture id. */
    invocations: Invocation[];
    batches: number;
    payloadBytes: number;
    endpoint: string | null;
    headerNames: string[];
    /** What `--send --authorize` takes; null without `--endpoint`. */
    authorizationDigest: string | null;
    limitations: string[];
  };
  batches: string[];
  headers: Record<string, string>;
}

/** Build the export, sending nothing; a string is why it can't. */
export function prepareExport(
  options: ExportOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Prepared | string {
  const endpoint =
    options.endpoint === undefined ? null : tracesEndpoint(options.endpoint);
  if (endpoint !== null && typeof endpoint !== "string")
    return endpoint.refused;
  const read = otlpHeaders(environment);
  if ("refused" in read) return read.refused;
  const { headers } = read;
  const { runs, spans, calls } = spansOf(options);
  const unknown = options.invocations?.find(
    (id) => !calls.some((call) => call.spanId === id || call.capture === id),
  );
  if (unknown !== undefined)
    return `#${options.issue} has no model call ${unknown} in the chosen runs: a preview lists each call's span id and capture id (--all-runs for every run).`;
  if (!spans.length)
    return `#${options.issue} has no model calls to export in the chosen runs: \`factory diagnostics ${options.issue} --all-runs\` shows them.`;
  const batches = batchesOf(spans);
  return {
    preview: {
      repository: options.repository,
      issue: options.issue,
      runs,
      content: options.content,
      spans: spans.length,
      invocations: calls,
      batches: batches.length,
      payloadBytes: batches.reduce((sum, b) => sum + Buffer.byteLength(b), 0),
      endpoint,
      headerNames: Object.keys(headers).sort(),
      authorizationDigest:
        endpoint === null
          ? null
          : authorizationDigest(
              endpoint,
              options.content,
              options.invocations ?? [],
              batches,
              headers,
            ),
      limitations: [
        "Each model call is a root span in its run's trace; Factory invents no parentage.",
        "Ids are stable, so a repeat send may update or duplicate spans at the collector: check it before sending again.",
        "Redaction is best effort, and metadata can be sensitive too: authorize only a destination your repository's policy allows.",
      ],
    },
    batches,
    headers,
  };
}

/** `--output FILE`: the batches as JSON lines, one OTLP request each, in a new 0600 file. */
export function writeExport(prepared: Prepared, file: string): void {
  const fd = openSync(
    file,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (const batch of prepared.batches) writeSync(fd, `${batch}\n`);
  } finally {
    closeSync(fd);
  }
}

export function previewText(prepared: Prepared): string {
  const p = prepared.preview;
  return [
    `Export preview for #${p.issue} · ${p.spans} model call${p.spans === 1 ? "" : "s"} in ${p.runs.length} run${p.runs.length === 1 ? "" : "s"} · ${p.content} · ${p.batches} batch${p.batches === 1 ? "" : "es"}, ${p.payloadBytes} bytes · nothing sent`,
    p.endpoint === null
      ? "  endpoint: none (add --endpoint URL for the digest a send needs)"
      : `  endpoint: ${p.endpoint}`,
    `  headers: ${p.headerNames.join(", ") || "none"} (values never shown)`,
    ...p.invocations.map(
      (call) =>
        `  ${call.spanId}${call.capture ? ` capture ${call.capture}` : ""} · ${[call.role ?? "?", call.phase].filter(Boolean).join(" ")} · ${call.item ? `item ${call.item}` : "objective"} · run ${call.run}`,
    ),
    ...(p.authorizationDigest
      ? [
          `  send with: --send --endpoint ${p.endpoint} --authorize ${p.authorizationDigest}`,
        ]
      : []),
    ...p.limitations.map((line) => `  ${line}`),
    "",
  ].join("\n");
}

type BatchResult =
  | { status: "accepted" }
  | { status: "rejected-or-unknown"; httpStatus: number }
  | { status: "partial-or-warning"; rejectedSpans: number | null }
  | { status: "unknown"; reason: string };

/** One POST; response text and transport errors are discarded: they can carry secrets. */
async function sendBatch(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
): Promise<BatchResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: "rejected-or-unknown", httpStatus: response.status };
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_BYTES) {
          await reader.cancel();
          return { status: "unknown", reason: "response-too-large" };
        }
        chunks.push(chunk.value);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    const ack = (text.trim() ? JSON.parse(text) : {}) as unknown;
    if (!ack || typeof ack !== "object" || Array.isArray(ack))
      return { status: "unknown", reason: "invalid-acknowledgement" };
    const { partialSuccess, ...rest } = ack as {
      partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown };
    };
    if (partialSuccess === undefined)
      return Object.keys(rest).length
        ? { status: "unknown", reason: "invalid-acknowledgement" }
        : { status: "accepted" };
    if (
      !partialSuccess ||
      typeof partialSuccess !== "object" ||
      Array.isArray(partialSuccess)
    )
      return { status: "unknown", reason: "invalid-acknowledgement" };
    const rejected = Number(partialSuccess.rejectedSpans ?? 0);
    // Collectors commonly acknowledge full success as `{"partialSuccess":{}}`.
    if (rejected === 0 && !partialSuccess.errorMessage)
      return { status: "accepted" };
    return {
      status: "partial-or-warning",
      rejectedSpans:
        Number.isSafeInteger(rejected) && rejected >= 0 ? rejected : null,
    };
  } catch {
    return {
      status: "unknown",
      reason: "transport-or-acknowledgement-failure",
    };
  }
}

export interface SendReceipt {
  endpoint: string;
  authorizationDigest: string;
  batches: number;
  sent: number;
  spans: number;
  retries: 0;
  status: "accepted" | "stopped";
  results: BatchResult[];
}

/**
 * Send an export the operator authorized: `digest` must be the one this
 * exact export previews, or it refuses (a string). Batches go in order,
 * one request each with no retries, and the first one not fully
 * acknowledged stops the send.
 */
export async function sendExport(
  prepared: Prepared,
  digest: string,
): Promise<SendReceipt | string> {
  const { endpoint, authorizationDigest: expected } = prepared.preview;
  if (endpoint === null || expected === null || digest !== expected)
    return "The export changed, or this digest isn't its preview's: preview this exact endpoint, content, selection and headers again and authorize the new digest.";
  const results: BatchResult[] = [];
  for (const batch of prepared.batches) {
    const result = await sendBatch(endpoint, prepared.headers, batch);
    results.push(result);
    if (result.status !== "accepted") break;
  }
  const accepted =
    results.length === prepared.batches.length &&
    results.every((result) => result.status === "accepted");
  return {
    endpoint,
    authorizationDigest: digest,
    batches: prepared.batches.length,
    sent: results.length,
    spans: prepared.preview.spans,
    retries: 0,
    status: accepted ? "accepted" : "stopped",
    results,
  };
}
