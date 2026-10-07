import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import type { CaptureEvent } from "./capture.js";
import { codexRawTokenUsage, codexTokenUsage } from "./usage.js";

export type NativeCaptureObserver = (
  event: CaptureEvent,
  content?: () => unknown,
) => void;

/** Called only with a held regular-file descriptor from an owned, settled Codex home. */
export function captureOwnedRollout(
  fd: number,
  threadId: string,
  observe: NativeCaptureObserver,
): void {
  const stat = fstatSync(fd);
  const limit = 8 * 1024 * 1024;
  const buffer = Buffer.alloc(Math.min(stat.size, limit));
  let bytes = 0;
  while (bytes < buffer.length) {
    const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
    if (!read) break;
    bytes += read;
  }
  const text = buffer.subarray(0, bytes).toString("utf8");
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  lines.pop(); // An incomplete final record is never reconstructed.
  const header = JSON.parse(lines.shift() ?? "null");
  if (header?.type !== "session_meta" || header.payload?.id !== threadId)
    throw new Error("Owned native history does not match its observed thread");
  let partial = bytes !== stat.size || !terminated;
  let emitted = 0;
  const emit: NativeCaptureObserver = (event, content) => {
    // Keep metadata bounded too; leave space for coverage and an outer request.
    if (emitted >= 4094) {
      partial = true;
      return;
    }
    emitted++;
    observe(event, content);
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
  const visible = (
    payload: Record<string, unknown>,
    role: CaptureEvent["role"],
    contextSnapshot = false,
    event = "codex.native-message",
  ) => {
    if (emitted >= 4094) {
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
  const message = (payload: Record<string, unknown>, snapshot = false) => {
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
      visible(payload, "tool", snapshot, "codex.native-tool-output");
    } else if (
      ["function_call", "custom_tool_call"].includes(String(payload.type))
    ) {
      visible(payload, "assistant", snapshot, "codex.native-tool-call");
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
      latestTokenCountUsage =
        info && typeof info === "object" && !Array.isArray(info)
          ? codexTokenUsage((info as Record<string, unknown>).total_token_usage)
          : {};
    } else if (row.type === "response_item") {
      if (payload.name === "spawn_agent") childHistory = true;
      message(payload);
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
  observe({
    kind: "interaction",
    providerEvent: "codex.native-rollout-coverage",
    providerSessionId: threadId,
    coverage: "boundary",
    nativeRollout: {
      cliVersion:
        typeof header.payload.cli_version === "string"
          ? header.payload.cli_version
          : null,
      status:
        partial || inheritedHistory || childHistory ? "partial" : "available",
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
}
