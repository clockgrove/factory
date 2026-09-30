import { createHash } from "node:crypto";
import {
  exportEndpoint,
  invocationObservations,
  type SelectedCaptures,
} from "./capture-export.js";

export interface LangSmithDestination {
  projectId: string;
  workspaceId?: string;
}
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC UUIDv5: deterministic IDs namespace actual Factory invocation/attempt identity. */
function invocationUuid(key: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`factory-capture:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function validateDestination(destination: LangSmithDestination) {
  if (
    !uuidPattern.test(destination.projectId) ||
    (destination.workspaceId !== undefined &&
      !uuidPattern.test(destination.workspaceId))
  )
    throw new Error(
      "LangSmith requires --project-id UUID and, if selected, --workspace-id UUID",
    );
}

export function mapLangSmithCaptures(
  selection: SelectedCaptures,
  destination: LangSmithDestination,
) {
  validateDestination(destination);
  return selection.report.invocations.map((invocation) => {
    const records = invocationObservations(selection, invocation);
    const id = invocationUuid(invocation.key);
    const start = invocation.interval.startedAt ?? records[0]!.at;
    if (!Number.isSafeInteger(Date.parse(start)))
      throw new Error("Capture has an invalid observation timestamp");
    return {
      id,
      trace_id: id,
      session_id: destination.projectId,
      name: `Factory ${String(invocation.identity.phase)}`,
      // Preserve provenance without treating partial captures as native billable LLM runs.
      run_type: "chain",
      start_time: start,
      ...(invocation.interval.complete
        ? { end_time: invocation.interval.endedAt }
        : {}),
      inputs:
        selection.options.content === "retained"
          ? {
              observations: records
                .filter((record) => record.kind === "request")
                .map((record) => record.exportedContent),
            }
          : {},
      outputs: {
        outcomes: invocation.outcomes,
        ...(selection.options.content === "retained"
          ? {
              observations: records
                .filter((record) => record.kind === "response")
                .map((record) => record.exportedContent),
            }
          : {}),
      },
      extra: {
        metadata: {
          factory: {
            identity: invocation.identity,
            interval: invocation.interval,
            usage: invocation.usage,
            costEstimate: invocation.costEstimate,
            controllerObservations: selection.controllerObservations.filter(
              (record) => record.relatedInvocationKeys.includes(invocation.key),
            ),
          },
        },
      },
      events: records.map((record) => ({
        name: record.kind,
        time: record.at,
        kwargs: { factory: record },
      })),
    };
  });
}

export function prepareLangSmithExport(
  selection: SelectedCaptures,
  destination: LangSmithDestination,
) {
  const endpoint = exportEndpoint(selection.options.endpoint, "/api/v1/runs");
  const runs = mapLangSmithCaptures(selection, destination);
  const payload = json(runs);
  return {
    preview: {
      destination: "langsmith" as const,
      endpoint,
      projectId: destination.projectId,
      workspaceId: destination.workspaceId ?? null,
      repository: selection.repository,
      objective: selection.objective,
      content: selection.options.content,
      identities: selection.report.invocations.map(
        (invocation) => invocation.identity,
      ),
      observationCount: selection.records.size,
      runIds: runs.map((run) => run.id),
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
        "Each actual invocation/provider attempt becomes a separate root chain run. Recorded identities/relationships remain metadata/events; complete conversations, hidden reasoning and unrecorded causal parentage are unavailable.",
        "Usage and cost estimates are provenance-bearing metadata, not native LangSmith token/billing fields. Incomplete intervals omit end_time rather than fabricate completion.",
        "Stable UUIDv5 IDs repeat on export; conflicts/duplicates/updates are destination behavior, not proof of prior acceptance. A HTTP 409 is not silently accepted. Inspect the destination after partial or uncertain uploads before resending.",
        "One request per selected invocation, no automatic retries; stop on first failure and report all unsent IDs. A HTTP 202 is asynchronous ingestion acknowledgement, not proof of indexed content.",
        "Metadata can be sensitive and redaction is best-effort. Authorize only a destination and scope permitted by your repository policy.",
      ],
      requestCount: runs.length,
      payloadBytes: Buffer.byteLength(payload),
      authorizationDigest: hash(
        json([
          endpoint,
          destination.projectId,
          destination.workspaceId ?? null,
          selection.options.content,
          payload,
        ]),
      ),
    },
    payload,
  };
}
export type LangSmithExport = ReturnType<typeof prepareLangSmithExport>;

/** No background SDK/queue/retry: bounded selected requests with visible partial progress. */
export async function sendLangSmithExport(
  prepared: LangSmithExport,
  authorizationDigest: string,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const preview = prepared.preview;
  if (
    authorizationDigest !== preview.authorizationDigest ||
    hash(
      json([
        preview.endpoint,
        preview.projectId,
        preview.workspaceId,
        preview.content,
        prepared.payload,
      ]),
    ) !== authorizationDigest
  )
    throw new Error(
      "Export changed; preview and authorize this exact destination/content/scope again",
    );
  const key = environment.LANGSMITH_API_KEY;
  if (!key)
    throw new Error(
      "Set LANGSMITH_API_KEY in the controller environment; never in target files",
    );
  const runs = JSON.parse(prepared.payload) as Array<{ id: string }>;
  const uploads: Array<{ id: string; status: string; httpStatus?: number }> =
    [];
  for (const run of runs) {
    try {
      const response = await request(preview.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": key,
          ...(preview.workspaceId
            ? { "x-tenant-id": preview.workspaceId }
            : {}),
          "Content-Type": "application/json",
        },
        body: json(run),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      // Exact documented status; discard prose that could echo private content/keys.
      await response.body?.cancel();
      uploads.push({
        id: run.id,
        status:
          response.status === 202 ? "acknowledged" : "rejected-or-unknown",
        httpStatus: response.status,
      });
      if (response.status !== 202) break;
    } catch {
      uploads.push({ id: run.id, status: "unknown" });
      break;
    }
  }
  return {
    destination: preview.destination,
    endpoint: preview.endpoint,
    projectId: preview.projectId,
    workspaceId: preview.workspaceId,
    authorizationDigest,
    status:
      uploads.length === runs.length &&
      uploads.every((upload) => upload.status === "acknowledged")
        ? "accepted"
        : "incomplete",
    uploads: [
      ...uploads,
      ...runs
        .slice(uploads.length)
        .map((run) => ({ id: run.id, status: "not-sent" })),
    ],
    retries: 0,
    acceptance: "asynchronous ingestion acknowledgement only",
  };
}
