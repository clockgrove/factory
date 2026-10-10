import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  type CaptureContext,
  type CaptureEvent,
  CaptureWriter,
  type InteractionMetadata,
} from "../capture.js";
import type { HarnessRequest, ModelInvocationUsage } from "../contracts.js";
import {
  codexRawTokenUsage,
  codexInvocationUsage,
  codexSdkTokenUsage,
  codexTokenUsage,
  normalizeTokenUsage,
} from "../usage.js";
import {
  claudeCost,
  claudeModelUsage,
  claudeRawTokenUsage,
} from "./claude-usage.js";
import { privateProgress, redact } from "./harness-support.js";

/**
 * Project one Claude Agent SDK message into capture events. The worker capture
 * and the Claude planning transport share this projection.
 */
export function claudeCaptureEvents(
  message: SDKMessage,
  secrets: string[] = [],
  observedUsage?: Record<string, unknown>,
): { event: CaptureEvent; content?: () => unknown }[] {
  const projected: { event: CaptureEvent; content?: () => unknown }[] = [];
  const record = (event: CaptureEvent, content?: () => unknown) => {
    projected.push({ event, content });
  };
  const base: CaptureEvent = {
    kind: "interaction",
    providerEvent: message.type,
    providerSessionId: "session_id" in message ? message.session_id : undefined,
    coverage: "sdk-exposed",
  };
  if (message.type === "system" && message.subtype === "init") {
    record({ ...base, reportedModel: message.model });
  } else if (message.type === "assistant" || message.type === "user") {
    base.role = message.type;
    if (message.type === "assistant") {
      base.providerMessageId = message.message.id;
      base.reportedModel = message.message.model;
    } else base.providerMessageId = message.uuid;
    const content = message.message.content;
    if (typeof content === "string") record(base, () => ({ text: content }));
    else
      for (const block of content) {
        if (block.type === "text") record(base, () => ({ text: block.text }));
        else if (block.type === "tool_use")
          record({ ...base, tool: block.name, toolCallId: block.id }, () => ({
            arguments: block.input,
          }));
        else if (block.type === "tool_result")
          record(
            { ...base, role: "tool", toolCallId: block.tool_use_id },
            () => ({ content: block.content, isError: block.is_error }),
          );
        else record(base); // Thinking, signatures and hidden blocks stay unexposed.
      }
    if (message.type === "assistant" && observedUsage) {
      const raw = claudeRawTokenUsage(message.message.usage);
      const sum = [
        raw.input_tokens,
        raw.cache_read_input_tokens,
        raw.cache_creation_input_tokens,
      ];
      const input = sum.every((value) => value !== undefined)
        ? sum.reduce((total, value) => total + value!, 0)
        : undefined;
      record({
        ...base,
        kind: "usage",
        usage: {
          scope: "provider-call",
          terminal: false,
          deduplicationKey: JSON.stringify([
            message.session_id,
            message.message.id,
          ]),
          completeness: Object.keys(raw).length
            ? "available-categories"
            : "unavailable",
          raw,
          normalized: normalizeTokenUsage({
            inputTokens: input,
            cachedInputTokens: raw.cache_read_input_tokens,
            cacheWriteInputTokens: raw.cache_creation_input_tokens,
            outputTokens: raw.output_tokens,
          }),
        },
      });
    }
  } else if (message.type === "result") {
    record({ ...base, kind: "response", role: "assistant" }, () =>
      message.subtype === "success"
        ? {
            text: message.result,
            isError: message.is_error,
            ...(message.structured_output !== undefined && {
              structuredOutput: message.structured_output,
            }),
          }
        : { errors: message.errors },
    );
    record({
      ...base,
      kind: "usage",
      usage: {
        scope: "model-breakdown",
        terminal: false,
        completeness:
          message.subtype === "error_during_execution"
            ? "unavailable"
            : "available-categories",
        normalized: {},
        raw: claudeRawTokenUsage(message.usage),
        modelBreakdown: claudeModelUsage(message.modelUsage, secrets),
      },
    });
  } else record(base);
  return projected;
}

export function codexCaptureEvent(
  event: ThreadEvent,
  sessionId?: string,
  secrets: string[] = [],
  usageSource: "native" | "sdk" = "native",
  usageBaseline?: ModelInvocationUsage,
): { event: CaptureEvent; content?: () => unknown } {
  let projected: { event: CaptureEvent; content?: () => unknown } = {
    event: { kind: "interaction" },
  };
  const record = (event: CaptureEvent, content?: () => unknown) => {
    projected = { event, content };
  };
  const base: CaptureEvent = {
    kind: "interaction",
    providerEvent: event.type,
    providerSessionId: sessionId,
    coverage: "sdk-exposed",
  };
  if (event.type === "thread.started") base.providerSessionId = event.thread_id;
  if (event.type === "turn.completed") {
    const raw = codexRawTokenUsage(event.usage);
    const normalized =
      usageBaseline !== undefined
        ? codexInvocationUsage(raw, usageBaseline)
        : usageSource === "sdk"
          ? codexSdkTokenUsage(raw)
          : codexTokenUsage(raw);
    record({
      ...base,
      kind: "usage",
      usage: {
        scope: "invocation-cumulative",
        terminal: false,
        completeness: Object.keys(normalized).length
          ? "available-categories"
          : "unavailable",
        raw,
        rawScope: "thread-cumulative",
        normalized,
      },
    });
  } else if (event.type === "turn.failed" || event.type === "error") {
    record(base, () => ({
      error: event.type === "error" ? event.message : event.error.message,
    }));
  } else if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    const item = event.item;
    base.providerMessageId = item.id;
    if (item.type === "agent_message")
      record(
        {
          ...base,
          kind: event.type === "item.completed" ? "response" : "interaction",
          role: "assistant",
        },
        () => ({
          partialSuffixWithheld:
            event.type !== "item.completed" &&
            safePartialText(item.text, secrets) !== item.text,
          text:
            event.type === "item.completed"
              ? item.text
              : safePartialText(item.text, secrets),
        }),
      );
    else if (item.type === "command_execution")
      record(
        { ...base, role: "tool", tool: "shell", toolCallId: item.id },
        () => ({
          command: item.command,
          partialSuffixWithheld:
            event.type !== "item.completed" &&
            safePartialText(item.aggregated_output, secrets) !==
              item.aggregated_output,
          output:
            event.type === "item.completed"
              ? item.aggregated_output
              : safePartialText(item.aggregated_output, secrets),
          exitCode: item.exit_code,
          status: item.status,
        }),
      );
    else if (item.type === "mcp_tool_call")
      record(
        {
          ...base,
          role: "tool",
          tool: `${item.server}/${item.tool}`,
          toolCallId: item.id,
        },
        () => ({
          arguments: item.arguments,
          result: item.result && {
            content: item.result.content,
            structuredContent: item.result.structured_content,
          },
          error: item.error?.message,
          status: item.status,
        }),
      );
    else if (item.type === "file_change")
      record(
        { ...base, role: "tool", tool: "file_change", toolCallId: item.id },
        () => ({
          changes: item.changes.map(({ path, kind }) => ({ path, kind })),
          status: item.status,
        }),
      );
    else if (item.type === "web_search")
      record(
        { ...base, role: "tool", tool: "web_search", toolCallId: item.id },
        () => ({ query: item.query }),
      );
    else if (item.type === "error")
      record(
        { ...base, outcome: { stage: "provider", status: "warning" } },
        () => ({ error: item.message }),
      );
    // Reasoning/todo internals are not captured as assistant response text.
    else record(base);
  } else record(base);

  return projected;
}

function safePartialText(text: string, secrets: string[]): string {
  let end = text.length;
  for (const secret of secrets)
    for (let size = 1; size < secret.length && size <= text.length; size++)
      if (text.endsWith(secret.slice(0, size)))
        end = Math.min(end, text.length - size);
  return text.slice(0, end);
}

import { codexJsonBoundaries } from "../codex-boundary-telemetry.js";

/** Adapter observations only: these records never decide a worker outcome. */
export class WorkerInteractionCapture {
  private writer?: CaptureWriter;
  private terminalCost?: NonNullable<InteractionMetadata["usage"]>["cost"];
  private started = Date.now();
  private partials = new Map<string, string>();
  private partialBytes = 0;
  private partialIncomplete = false;
  private partialLimit: number;
  private boundaryStarted = performance.now();
  private codexBoundary?: ReturnType<typeof codexJsonBoundaries>;
  constructor(
    request: HarnessRequest,
    progressPath: string,
    private secrets: string[],
    configured?: CaptureContext["configured"],
  ) {
    this.partialLimit = request.capture?.policy?.maxBytesPerInvocation ?? 0;
    if (request.capture?.policy?.nativeBoundaryTelemetry) {
      this.codexBoundary = codexJsonBoundaries((boundary) =>
        this.safely(() =>
          this.writer!.record({
            kind: "interaction",
            coverage: "boundary",
            boundary: {
              ...boundary,
              source: "codex-exec-json",
              elapsedMs: Math.max(0, performance.now() - this.boundaryStarted),
            },
          }),
        ),
      );
    }
    if (request.capture)
      this.writer = new CaptureWriter(
        { ...request.capture.context, ...(configured && { configured }) },
        request.capture.policy,
        secrets,
        (capture) =>
          privateProgress(progressPath, {
            operation: "model-capture",
            eventId: capture.recordId,
            at: capture.at,
            attemptId: capture.attemptId,
            capture,
          }),
      );
  }

  private safely(action: () => void): void {
    if (!this.writer) return;
    try {
      action();
    } catch (error) {
      // SDK projections, as well as serialization and I/O, are observational.
      try {
        process.stderr.write(
          `Factory worker capture unavailable: ${redact(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 512)}\n`,
        );
      } catch {
        /* No effect on execution. */
      }
    }
  }

  request(prompt: string, instructions?: unknown): void {
    if (this.codexBoundary)
      this.safely(() =>
        this.writer!.record({
          kind: "interaction",
          coverage: "boundary",
          boundary: {
            source: "codex-exec-json",
            event: "telemetry-coverage",
            elapsedMs: Math.max(0, performance.now() - this.boundaryStarted),
            status: "unavailable",
            submission: "unsupported",
            nativeTransport: "unsupported",
          },
        }),
      );
    this.safely(() =>
      this.writer!.record(
        {
          kind: "request",
          role: "user",
          coverage: "boundary",
          promptComponents: {
            renderedPromptBytes: Buffer.byteLength(prompt),
            rolePreambleTaskSplit: "unavailable",
          },
        },
        () => ({ prompt, instructions }),
      ),
    );
  }

  providerCompleted(): void {
    this.safely(() =>
      this.writer!.record({
        kind: "outcome",
        coverage: "boundary",
        durationMs: Date.now() - this.started,
        outcome: { stage: "provider", status: "completed" },
      }),
    );
  }

  outcome(
    status: "completed" | "failed",
    usage: ModelInvocationUsage,
    error?: unknown,
    stage: "provider" | "protocol" = "provider",
  ): void {
    this.safely(() => {
      this.writer!.record({
        kind: "usage",
        coverage: "boundary",
        usage: {
          scope: "invocation-cumulative",
          terminal: true,
          completeness: Object.keys(usage).length
            ? "available-categories"
            : "unavailable",
          normalized: usage,
          ...(this.terminalCost && { cost: this.terminalCost }),
        },
      });
      this.writer!.record(
        {
          kind: "outcome",
          durationMs: Date.now() - this.started,
          outcome: { stage, status },
          coverage: "boundary",
        },
        error === undefined
          ? undefined
          : () => ({
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : String(error),
            }),
      );
    });
  }

  response(text: string | undefined, sessionId?: string): void {
    this.safely(() =>
      this.writer!.record(
        {
          kind: "response",
          role: "assistant",
          coverage: "boundary",
          providerSessionId: sessionId,
        },
        text === undefined ? undefined : () => ({ text }),
      ),
    );
  }

  private partial(
    key: string,
    delta: string,
  ): {
    text: string;
    bufferTruncated: boolean;
    partialSuffixWithheld: boolean;
  } {
    const bytes = Buffer.from(delta);
    let end = Math.min(
      bytes.length,
      Math.max(0, this.partialLimit - this.partialBytes),
    );
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
      end--;
    this.partialBytes += end;
    const whole =
      (this.partials.get(key) ?? "") + bytes.subarray(0, end).toString("utf8");
    if (end) this.partials.set(key, whole);
    this.partialIncomplete ||= end < bytes.length;
    return {
      text: this.safePartial(whole),
      partialSuffixWithheld: this.safePartial(whole) !== whole,
      bufferTruncated: this.partialIncomplete,
    };
  }

  private safePartial(text: string): string {
    return safePartialText(text, this.secrets);
  }

  codex(
    event: ThreadEvent,
    sessionId?: string,
    usageBaseline?: ModelInvocationUsage,
  ): void {
    this.safely(() => {
      this.codexBoundary?.(event);
      const projected = codexCaptureEvent(
        event,
        sessionId,
        this.secrets,
        "sdk",
        usageBaseline,
      );
      this.writer!.record(projected.event, projected.content);
    });
  }

  nativeFailure(content: () => unknown, sessionId?: string): void {
    this.safely(() =>
      this.writer!.record(
        {
          kind: "interaction",
          providerEvent: "codex.native-failure",
          providerSessionId: sessionId,
          coverage: "boundary",
        },
        content,
      ),
    );
  }

  native(event: CaptureEvent, content?: () => unknown): void {
    this.safely(() => this.writer!.record(event, content));
  }

  claude(message: SDKMessage, observedUsage?: Record<string, unknown>): void {
    this.safely(() => {
      if (message.type === "result") {
        const cost = claudeCost(message.total_cost_usd);
        this.terminalCost =
          cost === undefined || message.subtype === "error_during_execution"
            ? undefined
            : {
                value: cost,
                currency: "USD",
                kind: "provider-estimate",
                completeness:
                  message.subtype === "success" && !message.is_error
                    ? "available"
                    : "partial",
                provenance: "Claude SDK total_cost_usd",
              };
      }
      for (const { event, content } of claudeCaptureEvents(
        message,
        this.secrets,
        observedUsage,
      ))
        this.writer!.record(event, content);
    });
  }

  copilot(
    event: SessionEvent,
    sessionId?: string,
    observedUsage?: Record<string, unknown>,
  ): void {
    this.safely(() => {
      const base: CaptureEvent = {
        kind: "interaction",
        providerEvent: event.type,
        providerSessionId: sessionId,
        coverage: "sdk-exposed",
      };
      if (event.type === "session.start")
        this.writer!.record({
          ...base,
          providerSessionId: event.data.sessionId,
          reportedModel: event.data.selectedModel,
        });
      else if (event.type === "assistant.message")
        this.writer!.record(
          {
            ...base,
            role: "assistant",
            providerMessageId: event.data.messageId,
            reportedModel: event.data.model,
          },
          () => ({ text: event.data.content }),
        );
      else if (event.type === "user.message")
        this.writer!.record(
          { ...base, role: "user", providerMessageId: event.data.messageId },
          () => ({
            text: event.data.content,
            transformedContent: event.data.transformedContent,
          }),
        );
      else if (event.type === "assistant.message_delta")
        this.writer!.record(
          {
            ...base,
            role: "assistant",
            providerMessageId: event.data.messageId,
          },
          () => ({
            partialText: this.partial(
              `message:${event.data.messageId}`,
              event.data.deltaContent,
            ),
          }),
        );
      else if (event.type === "tool.execution_start")
        this.writer!.record(
          {
            ...base,
            role: "tool",
            tool: event.data.toolName,
            toolCallId: event.data.toolCallId,
            reportedModel: event.data.model,
          },
          () => ({ arguments: event.data.arguments }),
        );
      else if (event.type === "tool.execution_partial_result")
        this.writer!.record(
          { ...base, role: "tool", toolCallId: event.data.toolCallId },
          () => ({
            partialOutput: this.partial(
              `tool:${event.data.toolCallId}`,
              event.data.partialOutput,
            ),
          }),
        );
      else if (event.type === "tool.execution_complete")
        this.writer!.record(
          {
            ...base,
            role: "tool",
            toolCallId: event.data.toolCallId,
            reportedModel: event.data.model,
          },
          () => ({
            success: event.data.success,
            result: event.data.result && {
              content: event.data.result.content,
              detailedContent: event.data.result.detailedContent,
              structuredContent: event.data.result.structuredContent,
            },
            error: event.data.error && {
              message: event.data.error.message,
              code: event.data.error.code,
            },
          }),
        );
      else if (event.type === "session.error")
        this.writer!.record(base, () => ({ error: event.data.message }));
      else if (event.type === "assistant.usage") {
        if (!observedUsage) return;
        const raw = observedUsage.usage as Record<string, number>;
        this.writer!.record({
          ...base,
          kind: "usage",
          reportedModel: event.data.model,
          usage: {
            scope: "provider-call",
            terminal: false,
            deduplicationKey:
              event.data.apiCallId ?? event.data.providerCallId ?? event.id,
            completeness: Object.keys(raw).length
              ? "available-categories"
              : "unavailable",
            raw,
            normalized: normalizeTokenUsage({
              inputTokens: raw.inputTokens,
              outputTokens: raw.outputTokens,
              cachedInputTokens: raw.cacheReadTokens,
              cacheWriteInputTokens: raw.cacheWriteTokens,
              reasoningOutputTokens: raw.reasoningTokens,
            }),
          },
        });
      } else this.writer!.record(base);
    });
  }
}
