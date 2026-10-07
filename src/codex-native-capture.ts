import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import type { CaptureEvent } from "./capture.js";
import { codexRawTokenUsage, codexTokenUsage } from "./usage.js";

export type NativeCaptureObserver = (
  event: CaptureEvent,
  content?: () => unknown,
) => void;

/** Only explicit transport fields: never inspect shell text or nested output. */
export function nativeToolObservation(
  value: unknown,
  rowTimestamp?: unknown,
  turnId: string | null = null,
): CaptureEvent["nativeTool"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const payload = value as Record<string, unknown>;
  const event = ["function_call", "custom_tool_call"].includes(
    String(payload.type),
  )
    ? "call"
    : ["function_call_output", "custom_tool_call_output"].includes(
          String(payload.type),
        )
      ? "output"
      : undefined;
  if (!event) return;
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  const seconds =
    passthrough && typeof passthrough === "object"
      ? (passthrough as Record<string, unknown>).create_time
      : undefined;
  const payloadMs =
    typeof seconds === "number" && Number.isFinite(seconds)
      ? Math.floor(seconds * 1000)
      : NaN;
  const rowMs =
    typeof rowTimestamp === "string" ? Date.parse(rowTimestamp) : NaN;
  const observedMs =
    Number.isSafeInteger(payloadMs) && payloadMs >= 0 && payloadMs <= 8.64e15
      ? payloadMs
      : Number.isSafeInteger(rowMs) && rowMs >= 0 && rowMs <= 8.64e15
        ? rowMs
        : undefined;
  return {
    source: "owned-codex-rollout",
    endpoint: event,
    callId: identifier(payload.call_id),
    name: event === "call" ? (label(payload.name) ?? null) : null,
    type: String(payload.type).startsWith("custom_") ? "custom" : "function",
    turnId,
    status:
      payload.is_error === true || payload.status === "failed"
        ? "reported-failed"
        : "observed",
    recordedAt:
      observedMs !== undefined ? new Date(observedMs).toISOString() : null,
    ...(observedMs !== undefined
      ? {
          timestampSource:
            observedMs === payloadMs
              ? ("native-payload" as const)
              : ("native-row" as const),
        }
      : {}),
    ...(["completed", "failed", "cancelled", "in_progress"].includes(
      String(payload.status),
    )
      ? {
          reportedStatus: payload.status as NonNullable<
            CaptureEvent["nativeTool"]
          >["reportedStatus"],
        }
      : {}),
    ...(payload.is_error === true || payload.status === "failed"
      ? { explicitFailure: true as const }
      : {}),
  };
}
export interface OwnedRolloutBudget {
  remainingBytes: number;
  remainingEvents: number;
}
export interface OwnedChild {
  id: string;
  model?: string;
  reasoningEffort?: string;
}
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value)
    ? value
    : null;
const label = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
    ? value
    : undefined;
const threadIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const recordedTime = (value: unknown): string | null =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;
const nativeStatus = (
  value: unknown,
): NonNullable<CaptureEvent["nativeDescendant"]>["status"] => {
  const kind =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? Object.keys(value)[0]
        : null;
  return (
    (
      {
        pending_init: "pending-init",
        running: "running",
        interrupted: "interrupted",
        completed: "completed",
        errored: "errored",
        shutdown: "shutdown",
        not_found: "not-found",
      } as const
    )[kind as "running"] ?? "unknown"
  );
};

/** Called only with a held regular-file descriptor from an owned, settled Codex home. */
export function captureOwnedRollout(
  fd: number,
  threadId: string,
  observe: NativeCaptureObserver,
  options: {
    parentThreadId?: string;
    rootThreadId?: string;
    budget?: OwnedRolloutBudget;
    child?: (child: OwnedChild) => void;
  } = {},
): "available" | "partial" {
  const stat = fstatSync(fd);
  const budget = options.budget ?? {
    remainingBytes: 8 * 1024 * 1024,
    remainingEvents: 4094,
  };
  const limit = Math.max(0, budget.remainingBytes);
  const buffer = Buffer.alloc(Math.min(stat.size, limit));
  let bytes = 0;
  while (bytes < buffer.length) {
    const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
    if (!read) break;
    bytes += read;
  }
  budget.remainingBytes -= bytes;
  const text = buffer.subarray(0, bytes).toString("utf8");
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  lines.pop(); // An incomplete final record is never reconstructed.
  const header = JSON.parse(lines.shift() ?? "null");
  if (header?.type !== "session_meta" || header.payload?.id !== threadId)
    throw new Error("Owned native history does not match its observed thread");
  const childSource = header.payload.source?.subagent?.thread_spawn;
  if (
    options.parentThreadId &&
    childSource?.parent_thread_id !== options.parentThreadId
  )
    throw new Error("Native descendant lacks authenticated parent ownership");
  let partial = bytes !== stat.size || !terminated;
  const inheritedOrdinal = header.payload.subagent_history_start_ordinal;
  const inheritedBoundary =
    Number.isSafeInteger(inheritedOrdinal) && inheritedOrdinal >= 0
      ? inheritedOrdinal
      : null;
  if (options.parentThreadId && inheritedBoundary === null) partial = true;
  const ownership = options.parentThreadId
    ? {
        rootSessionId: options.rootThreadId ?? options.parentThreadId,
        parentSessionId: options.parentThreadId,
      }
    : undefined;
  const emit: NativeCaptureObserver = (event, content) => {
    // Keep metadata bounded too; leave space for coverage and an outer request.
    if (budget.remainingEvents <= 0) {
      partial = true;
      return;
    }
    budget.remainingEvents--;
    observe(
      { ...event, ...(ownership ? { nativeOwnership: ownership } : {}) },
      content,
    );
  };
  let duplicates = 0;
  let conflicts = 0;
  let childHistory = false;
  const inheritedHistory = Boolean(
    header.payload.parent_thread_id ||
      header.payload.history_base ||
      header.payload.forked_from_id,
  );
  const responses = new Map<string, string>();
  let latestThreadUsage: ReturnType<typeof codexTokenUsage> | undefined;
  let latestTokenCountUsage: ReturnType<typeof codexTokenUsage> | undefined;
  let latestTokenCountPayload: Record<string, unknown> | undefined;
  let rowTime: string | null = null;
  let turnId: string | null = null;
  let reportedModel: string | undefined;
  let reportedReasoningEffort: string | undefined;
  let modelContextWindow: number | undefined;
  const children = new Set<string>();
  const visible = (
    payload: Record<string, unknown>,
    role: CaptureEvent["role"],
    contextSnapshot = false,
    event = "codex.native-message",
    rowTimestamp?: unknown,
  ) => {
    if (budget.remainingEvents <= 0) {
      partial = true;
      return;
    }
    const serialized = JSON.stringify(payload);
    const content = payload.content;
    const textBytes = Array.isArray(content)
      ? content.reduce(
          (sum: number, item: { text?: unknown }) =>
            sum +
            (typeof item?.text === "string" ? Buffer.byteLength(item.text) : 0),
          0,
        )
      : typeof payload.text === "string"
        ? Buffer.byteLength(payload.text)
        : typeof payload.output === "string"
          ? Buffer.byteLength(payload.output)
          : typeof payload.arguments === "string"
            ? Buffer.byteLength(payload.arguments)
            : typeof payload.input === "string"
              ? Buffer.byteLength(payload.input)
              : 0;
    emit(
      {
        kind: "interaction",
        providerEvent: event,
        providerSessionId: threadId,
        role,
        ...(["codex.native-tool-call", "codex.native-tool-output"].includes(
          event,
        )
          ? {
              nativeTool: contextSnapshot
                ? undefined
                : nativeToolObservation(payload, rowTimestamp, turnId),
            }
          : {}),
        coverage: "boundary",
        visible: {
          source: "owned-codex-rollout",
          textBytes,
          serializedBytes: Buffer.byteLength(serialized),
          digest: createHash("sha256").update(serialized).digest("hex"),
          contextSnapshot,
        },
      },
      () => payload,
    );
  };
  if (typeof header.payload.base_instructions?.text === "string")
    visible(
      { text: header.payload.base_instructions.text },
      undefined,
      false,
      "codex.native-base-instructions",
    );
  const message = (
    payload: Record<string, unknown>,
    snapshot = false,
    rowTimestamp?: unknown,
  ) => {
    if (payload.type === "message") {
      const role = ["system", "developer", "user", "assistant"].includes(
        String(payload.role),
      )
        ? (payload.role as CaptureEvent["role"])
        : undefined;
      visible(payload, role, snapshot);
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(
        String(payload.type),
      )
    ) {
      visible(
        payload,
        undefined,
        snapshot,
        "codex.native-tool-output",
        rowTimestamp,
      );
    } else if (
      ["function_call", "custom_tool_call"].includes(String(payload.type))
    ) {
      visible(
        payload,
        undefined,
        snapshot,
        "codex.native-tool-call",
        rowTimestamp,
      );
    } else if (
      ["compaction", "context_compaction"].includes(String(payload.type))
    ) {
      visible(payload, undefined, true, "codex.native-compaction");
    }
  };
  for (const line of lines.slice(0, 8192)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      partial = true;
      continue;
    }
    const rawPayload = row.payload;
    if (
      !rawPayload ||
      typeof rawPayload !== "object" ||
      Array.isArray(rawPayload)
    ) {
      partial = true;
      continue;
    }
    const payload = rawPayload as Record<string, unknown>;
    rowTime = recordedTime(row.timestamp);
    // Child context copied from its parent is not new child work.
    if (
      options.parentThreadId &&
      (inheritedBoundary === null ||
        !Number.isSafeInteger(row.ordinal) ||
        (row.ordinal as number) < inheritedBoundary)
    )
      continue;
    if (row.type === "turn_context") {
      turnId = identifier(payload.turn_id);
      reportedModel = label(payload.model);
      reportedReasoningEffort = label(payload.effort);
    }
    if (row.type === "event_msg" && payload.type === "task_started")
      turnId = identifier(payload.turn_id);
    if (row.type === "event_msg" && payload.sender_thread_id === threadId) {
      if (
        payload.type === "collab_agent_spawn_end" &&
        threadIdentity(payload.new_thread_id)
      ) {
        childHistory = true;
        children.add(payload.new_thread_id);
        const child = {
          id: payload.new_thread_id,
          ...(label(payload.model) ? { model: label(payload.model)! } : {}),
          ...(label(payload.reasoning_effort)
            ? { reasoningEffort: label(payload.reasoning_effort)! }
            : {}),
        };
        emit({
          kind: "interaction",
          providerEvent: "codex.native-descendant",
          providerSessionId: threadId,
          coverage: "boundary",
          nativeDescendant: {
            parentSessionId: threadId,
            childSessionId: child.id,
            relation: "observed-spawn",
            status: nativeStatus(payload.status),
            recordedAt: rowTime,
            ...(child.model ? { model: child.model } : {}),
            ...(child.reasoningEffort
              ? { reasoningEffort: child.reasoningEffort }
              : {}),
            history: "unavailable",
            resourceCessation: "unavailable",
            parentUsageIncludesChild: "unknown",
          },
        });
        options.child?.(child);
      } else if (
        payload.type === "collab_waiting_end" &&
        payload.statuses &&
        typeof payload.statuses === "object"
      ) {
        for (const [id, status] of Object.entries(payload.statuses))
          if (children.has(id))
            emit({
              kind: "interaction",
              providerEvent: "codex.native-descendant-status",
              providerSessionId: threadId,
              coverage: "boundary",
              nativeDescendant: {
                parentSessionId: threadId,
                childSessionId: id,
                relation: "observed-spawn",
                status: nativeStatus(status),
                recordedAt: rowTime,
                history: "unavailable",
                resourceCessation: "unavailable",
                parentUsageIncludesChild: "unknown",
              },
            });
      }
    }
    if (row.type === "token_usage_record") {
      if (
        payload.thread_id !== threadId ||
        typeof payload.response_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(payload.response_id) ||
        ![payload.turn_id, payload.session_id, payload.root_turn_id].every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
        )
      ) {
        partial = true;
        continue;
      }
      const canonical = JSON.stringify(payload);
      const previous = responses.get(payload.response_id);
      if (previous !== undefined) {
        duplicates++;
        if (previous !== canonical) {
          conflicts++;
          partial = true;
          emit(
            {
              kind: "interaction",
              providerEvent: "codex.native-usage-conflict",
              providerMessageId: payload.response_id,
              providerSessionId: threadId,
              coverage: "boundary",
            },
            () => payload,
          );
        }
        continue;
      }
      responses.set(payload.response_id, canonical);
      latestThreadUsage = codexTokenUsage(payload.thread_token_usage);
      const normalized = codexTokenUsage(payload.usage);
      emit(
        {
          kind: "usage",
          providerEvent: "codex.native-response-usage",
          providerMessageId: payload.response_id,
          providerSessionId: threadId,
          coverage: "boundary",
          usage: {
            scope: "provider-call",
            deduplicationKey: `${threadId}:${payload.response_id}`,
            terminal: true,
            completeness: Object.keys(normalized).length
              ? "available-categories"
              : "unavailable",
            normalized,
            raw: codexRawTokenUsage(payload.usage),
          },
        },
        () => payload,
      );
    } else if (row.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info;
      latestTokenCountPayload = payload;
      if (info && typeof info === "object" && !Array.isArray(info)) {
        const context = (info as Record<string, unknown>).model_context_window;
        if (Number.isSafeInteger(context) && (context as number) > 0)
          modelContextWindow = context as number;
      }
      latestTokenCountUsage =
        info && typeof info === "object" && !Array.isArray(info)
          ? codexTokenUsage((info as Record<string, unknown>).total_token_usage)
          : {};
    } else if (row.type === "response_item") {
      if (payload.name === "spawn_agent") childHistory = true;
      message(payload, false, row.timestamp);
    } else if (row.type === "compacted") {
      visible(
        { text: payload.message ?? "" },
        undefined,
        true,
        "codex.native-compaction",
      );
      if (Array.isArray(payload.replacement_history)) {
        if (payload.replacement_history.length > 4094) partial = true;
        for (const item of payload.replacement_history.slice(0, 4094)) {
          if (item && typeof item === "object" && !Array.isArray(item))
            message(item, true);
        }
      }
      // latest_token_usage_record is a copied checkpoint, never a new response.
    } else if (
      [
        "inter_agent_communication",
        "inter_agent_communication_metadata",
      ].includes(String(row.type))
    )
      childHistory = true;
    // token_count is a latest reconciliation snapshot, never added or counted.
  }
  if (lines.length > 8192) partial = true;
  const after = fstatSync(fd);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
    partial = true;
  if (latestTokenCountPayload)
    emit(
      {
        kind: "interaction",
        providerEvent: "codex.native-token-count",
        providerSessionId: threadId,
        coverage: "boundary",
      },
      () => latestTokenCountPayload,
    );
  const status =
    partial || inheritedHistory || childHistory ? "partial" : "available";
  observe({
    ...(ownership ? { nativeOwnership: ownership } : {}),
    kind: "interaction",
    providerEvent: "codex.native-rollout-coverage",
    providerSessionId: threadId,
    coverage: "boundary",
    nativeRollout: {
      cliVersion:
        typeof header.payload.cli_version === "string"
          ? header.payload.cli_version
          : null,
      status,
      ...(label(header.payload.model_provider)
        ? { modelProvider: label(header.payload.model_provider)! }
        : {}),
      ...(reportedModel ? { reportedModel } : {}),
      ...(reportedReasoningEffort ? { reportedReasoningEffort } : {}),
      ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
      readBytes: bytes,
      totalBytes: stat.size,
      observedCompletedResponses: responses.size,
      duplicateResponseRecords: duplicates,
      conflictingResponseRecords: conflicts,
      inheritedHistory,
      childHistory,
      completeRequestCount: "unavailable",
      fullProviderWireAndUpstreamDetails: "unavailable",
      endpointCompleteness: "unavailable",
      latestThreadUsage,
      latestTokenCountUsage,
    },
  });
  return status;
}
