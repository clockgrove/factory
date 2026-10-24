import { createHash } from "node:crypto";
import { analyzeInteractions } from "./analysis.js";
import { readInteractionContent, readInteractionMetadata } from "./capture.js";
import { readDiagnosticMetadata } from "./diagnostics.js";

export interface CaptureExportOptions {
  endpoint: string;
  content: "metadata" | "retained";
  runs?: string[];
  invocations?: string[];
}
type Invocation = ReturnType<typeof analyzeInteractions>["invocations"][number];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const attribute = (key: string, value: unknown) => ({
  key,
  value: { stringValue: typeof value === "string" ? value : json(value) },
});
const nanos = (at: string) => {
  const ms = Date.parse(at);
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new Error("Capture has an invalid observation timestamp");
  return (BigInt(ms) * 1_000_000n).toString();
};

const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * Exact destination only; never follow redirects carrying credentials/content.
 * Plain HTTP is allowed only for a loopback collector.
 */
export function exportEndpoint(base: string, path: string): string {
  const url = new URL(base);
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
    throw new Error(
      "Export endpoint requires HTTPS (or HTTP to a loopback host) without credentials, query or fragment",
    );
  const prefix = url.pathname.replace(/\/$/, "");
  if (prefix.endsWith(path))
    throw new Error(
      `Pass the base URL; Factory appends ${path} to the export endpoint`,
    );
  url.pathname = `${prefix}${path}`;
  return url.href;
}

/** Uses the capture reader and existing analysis deduplication, never execution state. */
export function selectCaptures(
  repository: string,
  objective: number,
  options: CaptureExportOptions,
  records = readInteractionMetadata(repository, objective),
  readContent = readInteractionContent,
  diagnostics = readDiagnosticMetadata(repository, objective),
) {
  if (options.content !== "metadata" && options.content !== "retained")
    throw new Error("Select --content metadata or retained explicitly");
  for (const record of records)
    if (record.repository !== repository || record.objective !== objective)
      throw new Error(
        "Capture identity does not match selected repository/Objective",
      );
  for (const [field, values] of [
    ["runId", options.runs],
    ["invocationId", options.invocations],
  ] as const)
    for (const selected of values ?? [])
      if (!records.some((record) => record[field] === selected))
        throw new Error(`No retained capture matches selected ${field}`);
  const selected = records.filter(
    (record) =>
      (!options.runs?.length || options.runs.includes(record.runId ?? "")) &&
      (!options.invocations?.length ||
        options.invocations.includes(record.invocationId)),
  );
  const report = analyzeInteractions(
    selected,
    diagnostics.filter(
      (event) => !event.capture && event.operation !== "model-invocation",
    ),
  );
  if (!report.invocations.length)
    throw new Error("No retained captures match the selected scope");
  const unique = new Map(selected.map((record) => [record.recordId, record]));
  const content = new Map<string, { status: string; text?: string }>();
  if (options.content === "retained")
    for (const record of unique.values()) {
      if (record.content.status !== "captured" || !record.content.reference) {
        content.set(record.recordId, { status: record.content.status });
        continue;
      }
      try {
        // A truncated payload remains text; never repair or parse it as complete JSON.
        content.set(record.recordId, {
          status: "retained",
          text: readContent(repository, record.content.reference),
        });
      } catch {
        content.set(record.recordId, { status: "unavailable" });
      }
    }
  return {
    repository,
    objective,
    options,
    report,
    records: unique,
    content,
    controllerObservations: report.controllerObservations.filter(
      (observation) => observation.relatedInvocationKeys.length > 0,
    ),
  };
}
export type SelectedCaptures = ReturnType<typeof selectCaptures>;

export function invocationObservations(
  selection: SelectedCaptures,
  invocation: Invocation,
) {
  return invocation.observations.map((observation) => ({
    ...selection.records.get(observation.recordId)!,
    ...(selection.options.content === "retained"
      ? { exportedContent: selection.content.get(observation.recordId) }
      : {}),
  }));
}

/** One root span per actual invocation/attempt; no invented cross-invocation parentage. */
export function mapOtlpCaptures(selection: SelectedCaptures) {
  const spans = selection.report.invocations.map((invocation) => {
    const observations = invocationObservations(selection, invocation);
    const start = invocation.interval.startedAt ?? observations[0]!.at;
    const end = invocation.interval.endedAt ?? observations.at(-1)!.at;
    const input = observations.filter((record) => record.kind === "request");
    const output = observations.filter((record) => record.kind === "response");
    return {
      traceId: hash(`factory-trace:${invocation.key}`).slice(0, 32),
      spanId: hash(`factory-span:${invocation.key}`).slice(0, 16),
      name: `Factory ${String(invocation.identity.phase)}`,
      kind: 1,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      // Plain spans prevent destination model pricing from inventing Factory billing.
      attributes: [
        attribute(
          "session.id",
          `${selection.repository}#${selection.objective}`,
        ),
        attribute("factory.metadata", {
          identity: invocation.identity,
          interval: invocation.interval,
          outcomes: invocation.outcomes,
          usage: invocation.usage,
          costEstimate: invocation.costEstimate,
          observations,
          controllerObservations: selection.controllerObservations.filter(
            (record) => record.relatedInvocationKeys.includes(invocation.key),
          ),
        }),
        ...(selection.options.content === "retained"
          ? [
              attribute(
                "factory.input",
                input.map((record) => record.exportedContent),
              ),
              attribute(
                "factory.output",
                output.map((record) => record.exportedContent),
              ),
            ]
          : []),
      ],
    };
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "factory")] },
        scopeSpans: [
          { scope: { name: "factory.capture-export", version: "1" }, spans },
        ],
      },
    ],
  };
}

/** OTLP/HTTP JSON: the base URL gets the standard `/v1/traces` signal path. */
export function prepareOtlpExport(
  selection: SelectedCaptures,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const endpoint = exportEndpoint(selection.options.endpoint, "/v1/traces");
  const payload = json(mapOtlpCaptures(selection));
  const headers = otlpHeaders(environment);
  return {
    preview: {
      endpoint,
      headerNames: Object.keys(headers).sort(),
      repository: selection.repository,
      objective: selection.objective,
      content: selection.options.content,
      identities: selection.report.invocations.map(
        (invocation) => invocation.identity,
      ),
      observationCount: selection.records.size,
      contentStatus: [...selection.records.values()].map((record) => ({
        recordId: record.recordId,
        ...record.content,
        exportStatus:
          selection.options.content === "metadata"
            ? "not-selected"
            : selection.content.get(record.recordId)?.status,
      })),
      usage: selection.report.usage,
      limitations: [
        ...selection.report.limitations,
        "Each provider attempt is a root span; recorded Objective/run/item/session/tool identities remain metadata, not invented causal spans.",
        "Partial attempts use their observed timestamp envelope, not a fabricated completion. Missing model and outcome fields remain unavailable.",
        "Usage and estimates are provenance-bearing metadata, not native billable generation counters. Factory metadata preserves available observations; hidden reasoning and complete provider conversations are unavailable.",
        "Stable trace/span IDs are repeated on export; destination deduplication is not guaranteed. A repeat may update or duplicate observations. Inspect the destination after a partial/unknown response before deciding to send again.",
        "Redaction is best-effort. Metadata can also be sensitive; only authorize a destination and scope permitted by your repository policy.",
      ],
      payloadBytes: Buffer.byteLength(payload),
      authorizationDigest: authorizationDigest(
        endpoint,
        selection.options.content,
        payload,
        headers,
      ),
    },
    payload,
  };
}

/** Binds endpoint, content, payload and header names+values (only hashed). */
function authorizationDigest(
  endpoint: string,
  content: string,
  payload: string,
  headers: Record<string, string>,
) {
  // Header names are case-insensitive; a case-only change keeps the preview.
  const headerDigest = hash(
    json(
      Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => (a! < b! ? -1 : 1)),
    ),
  );
  return hash(json([endpoint, content, payload, headerDigest]));
}
export type OtlpExport = ReturnType<typeof prepareOtlpExport>;

function decodeHeaderValue(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * Standard OTLP exporter headers: OTEL_EXPORTER_OTLP_TRACES_HEADERS, else
 * OTEL_EXPORTER_OTLP_HEADERS; comma-separated, URL-encoded key=value pairs.
 * Errors never echo the value, which usually carries credentials.
 */
export function otlpHeaders(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const name = environment.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    ? "OTEL_EXPORTER_OTLP_TRACES_HEADERS"
    : "OTEL_EXPORTER_OTLP_HEADERS";
  const headers: Record<string, string> = {};
  for (const entry of (environment[name] ?? "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.indexOf("=");
    const key = at > 0 ? entry.slice(0, at).trim() : "";
    const value = decodeHeaderValue(entry.slice(at + 1).trim());
    // RFC 9110: token names, unique ignoring case; values are tab, space,
    // visible ASCII or Latin-1 (obs-text) only.
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
      throw new Error(`${name} is malformed`);
    headers[key] = value;
  }
  return headers;
}

/** Returns a sanitized receipt; response prose and transport errors can contain secrets. */
export async function sendOtlpExport(
  prepared: OtlpExport,
  digest: string,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const headers = otlpHeaders(environment);
  if (
    digest !== prepared.preview.authorizationDigest ||
    authorizationDigest(
      prepared.preview.endpoint,
      prepared.preview.content,
      prepared.payload,
      headers,
    ) !== digest
  )
    throw new Error(
      "Export changed; preview and authorize this exact destination/headers/content/scope again",
    );
  const receipt = {
    endpoint: prepared.preview.endpoint,
    authorizationDigest: digest,
    observations: prepared.preview.observationCount,
    attemptedSpans: JSON.parse(prepared.payload).resourceSpans[0].scopeSpans[0]
      .spans.length as number,
    retries: 0,
  };
  try {
    const response = await request(prepared.preview.endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: prepared.payload,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        ...receipt,
        status: "rejected-or-unknown",
        httpStatus: response.status,
      };
    }
    // OTLP recommends a 4 MiB response bound; enforce it while streaming.
    const reader = response.body?.getReader();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) {
          await reader.cancel();
          return {
            ...receipt,
            status: "unknown",
            reason: "response-too-large",
          };
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    text += decoder.decode();
    const body = JSON.parse(text) as {
      partialSuccess?: {
        rejectedSpans?: string | number;
        errorMessage?: string;
      };
    };
    if (!body || Array.isArray(body) || typeof body !== "object")
      return {
        ...receipt,
        status: "unknown",
        reason: "invalid-acknowledgement",
      };
    const { partialSuccess, ...rest } = body;
    const invalid =
      partialSuccess === undefined
        ? Object.keys(rest).length > 0
        : !partialSuccess ||
          typeof partialSuccess !== "object" ||
          Array.isArray(partialSuccess);
    if (invalid)
      return {
        ...receipt,
        status: "unknown",
        reason: "invalid-acknowledgement",
      };
    if (partialSuccess) {
      const rejected = Number(partialSuccess.rejectedSpans ?? 0);
      const rejectedSpans =
        Number.isSafeInteger(rejected) && rejected >= 0 ? rejected : null;
      // Collectors commonly acknowledge full success as `{"partialSuccess":{}}`.
      if (rejectedSpans === 0 && !partialSuccess.errorMessage)
        return { ...receipt, status: "accepted" };
      return {
        ...receipt,
        status: "partial-or-warning",
        rejectedSpans,
        warningPresent: Boolean(partialSuccess.errorMessage),
      };
    }
    return { ...receipt, status: "accepted" };
  } catch {
    return {
      ...receipt,
      status: "unknown",
      reason: "transport-or-acknowledgement-failure",
    };
  }
}
