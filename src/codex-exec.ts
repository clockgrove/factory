import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ThreadError,
  ThreadEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { CodexServiceTier } from "./config.js";
import { codexRuntimeDirectory } from "./codex-planning-isolation.js";
import { attachFault } from "./fault.js";
import { subprocessAsync, UnsettledSubprocessError } from "./process.js";
import { redactDiagnosticDetail } from "./diagnostics.js";
import type { ModelBoundaryObservation } from "./capture.js";
import {
  codexBoundaryTelemetry,
  codexJsonBoundaries,
} from "./codex-boundary-telemetry.js";

import {
  AuthenticationRequiredError,
  type ReviewImageInput,
} from "./contracts.js";
import { assertReviewImages } from "./compiler/transport.js";
import { assertProviderTurnDeadline } from "./provider-turn.js";

export interface CodexStderrDiagnostic {
  text: string;
  observedBytes: number;
  retainedBytes: number;
  retainedTextBytes: number;
  truncated: boolean;
  redacted: boolean;
  completeLinesOnly: true;
}

export interface CodexThreadOptions extends ThreadOptions {
  serviceTier?: CodexServiceTier;
}

/** Pinned native sentinel for explicit Standard, or the Fast request tier. */
export function nativeCodexServiceTier(
  value: CodexServiceTier | undefined,
): "default" | "priority" | undefined {
  if (value === undefined) return undefined;
  if (value === "standard") return "default";
  if (value === "fast") return "priority";
  throw new Error("Unsupported Codex service tier");
}

/**
 * Codex exec (CLI and SDK 0.160.0) reports a failed turn, and a failed
 * process, only as text: ThreadError has just `message` and the exit error
 * just stderr. A rejected API request arrives as its JSON body with `status`.
 * Credentials the CLI itself finds missing or unrefreshable carry no status,
 * so this narrowest fallback matches the CLI's own login remediation and its
 * rendering of HTTP 401. It applies to exec and to an app-server failure
 * without a typed cause.
 */
const CODEX_EXEC_LOGIN =
  /\bcodex login\b|\bsign in again\b|\b401 Unauthorized\b/;

function jsonStatus(message: string): unknown {
  try {
    return (JSON.parse(message) as { status?: unknown } | null)?.status;
  } catch {
    return undefined;
  }
}

/**
 * A failed Codex turn that is an authentication failure. The app-server
 * projection carries the native `codexErrorInfo` ("unauthorized", or a
 * variant with `httpStatusCode`). When it gives no typed cause (null or
 * "other", as for an API 401 it did not map) or on exec, which has none, the
 * JSON body status and the exec fallback above apply.
 */
export function codexAuthentication(
  error: ThreadError & { codexErrorInfo?: unknown },
): AuthenticationRequiredError | undefined {
  const info = error.codexErrorInfo;
  const authentication =
    info === "unauthorized" ||
    (info !== null &&
      typeof info === "object" &&
      Object.values(info).some(
        (variant) =>
          (variant as { httpStatusCode?: unknown } | null)?.httpStatusCode ===
          401,
      )) ||
    ((info === undefined || info === null || info === "other") &&
      (jsonStatus(error.message) === 401 ||
        CODEX_EXEC_LOGIN.test(error.message)));
  return authentication
    ? new AuthenticationRequiredError(error.message, {
        provider: "codex",
        command: "codex login",
      })
    : undefined;
}

/** One bounded observation per native attempt, never provider progress. */
export function codexStderrCapture(
  observe: (diagnostic: CodexStderrDiagnostic) => void | Promise<void>,
  secrets: string[] = [],
): { chunk: (bytes: Buffer) => void; finish: () => void } {
  const retained = Buffer.alloc(64 * 1024);
  let bytes = 0;
  let observedBytes = 0;
  let finished = false;
  return {
    chunk: (chunk) => {
      if (finished) return;
      observedBytes += chunk.length;
      bytes += chunk.copy(retained, bytes, 0, retained.length - bytes);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      // Withhold the whole unterminated suffix, including a cap-cut secret
      // or UTF-8 code point. Redact complete lines across all stream chunks
      // before the private writer applies its own UTF-8-aware content budget.
      const end = retained.subarray(0, bytes).lastIndexOf(10) + 1;
      const decoder = new StringDecoder("utf8");
      const original = decoder.write(retained.subarray(0, end)) + decoder.end();
      const text = redactDiagnosticDetail(original, secrets);
      try {
        void Promise.resolve(
          observe({
            text,
            observedBytes,
            retainedBytes: end,
            retainedTextBytes: Buffer.byteLength(text),
            truncated: end < observedBytes,
            redacted: text !== original,
            completeLinesOnly: true,
          }),
        ).catch(() => undefined);
      } catch {
        // A private diagnostic sink never changes native work or its error.
      }
    },
  };
}

/** The exact native exec arguments used by initial and resumed planning turns. */
export function codexExecArguments(
  options: CodexThreadOptions,
  schemaPath: string,
  threadId?: string,
  reviewImages?: ReviewImageInput[],
): string[] {
  const command = ["exec", "--experimental-json"];
  if (options.model) command.push("--model", options.model);
  if (options.sandboxMode) command.push("--sandbox", options.sandboxMode);
  if (options.workingDirectory) command.push("--cd", options.workingDirectory);
  if (options.skipGitRepoCheck) command.push("--skip-git-repo-check");
  command.push("--output-schema", schemaPath);
  if (options.modelReasoningEffort)
    command.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(options.modelReasoningEffort)}`,
    );
  const tier = nativeCodexServiceTier(options.serviceTier);
  if (tier !== undefined)
    command.push("--config", `service_tier=${JSON.stringify(tier)}`);
  command.push("--config", 'approval_policy="never"');
  if (threadId) command.push("resume", threadId);
  // Same native input contract as SDK 0.160 local_image, including resumed turns.
  for (const image of reviewImages ?? []) command.push("--image", image.path);
  return command;
}

/** The installed SDK's native JSON protocol, with Factory-owned cessation. */
export async function runCodexExec(args: {
  env: Record<string, string>;
  options: CodexThreadOptions;
  prompt: string;
  schema: unknown;
  reviewImages?: ReviewImageInput[];
  threadId?: string;
  signal: AbortSignal;
  deadlineAt?: string;
  event: (event: ThreadEvent) => void;
  stderr?: (diagnostic: CodexStderrDiagnostic) => void | Promise<void>;
  redactionValues?: string[];
  boundary?: (observation: ModelBoundaryObservation) => void;
}): Promise<void> {
  assertReviewImages(args.reviewImages, args.options.workingDirectory);
  const started = performance.now();
  const observe = (
    source: ModelBoundaryObservation["source"],
    observation: Omit<ModelBoundaryObservation, "source" | "elapsedMs">,
  ) => {
    try {
      void Promise.resolve(
        args.boundary?.({
          ...observation,
          source,
          elapsedMs: Math.max(0, performance.now() - started),
        }),
      ).catch(() => undefined);
    } catch {
      /* Boundary sinks cannot change provider work. */
    }
  };
  const target =
    process.arch === "arm64"
      ? "aarch64-unknown-linux-musl"
      : "x86_64-unknown-linux-musl";
  const root = join(codexRuntimeDirectory(), target);
  const modern = existsSync(join(root, "bin", "codex"));
  const file = join(root, modern ? "bin" : "codex", "codex");
  const path = join(root, modern ? "codex-path" : "path");
  const env: Record<string, string> = {
    ...args.env,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_sdk_ts",
  };
  if (args.boundary) env.RUST_LOG = "off,codex_otel.trace_safe=trace";
  if (existsSync(path)) env.PATH = `${path}${delimiter}${env.PATH ?? ""}`;
  const schema = join(env.TMPDIR!, "output-schema.json");
  writeFileSync(schema, JSON.stringify(args.schema), { mode: 0o600 });
  const command = codexExecArguments(
    args.options,
    schema,
    args.threadId,
    args.reviewImages,
  );
  const stop = new AbortController();
  const signal = AbortSignal.any([args.signal, stop.signal]);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let failed = false;
  let failure: unknown;
  let filteredStderr = "";
  const stderr =
    args.stderr || args.boundary
      ? codexStderrCapture((diagnostic) => {
          filteredStderr = diagnostic.text;
          return args.stderr?.(diagnostic);
        }, args.redactionValues)
      : undefined;
  const telemetry = args.boundary
    ? codexBoundaryTelemetry(
        (event) => observe("codex-trace-safe", event),
        (chunk) => stderr?.chunk(chunk),
      )
    : undefined;
  const jsonBoundary = args.boundary
    ? codexJsonBoundaries((event) => observe("codex-exec-json", event))
    : undefined;
  const line = (text: string) => {
    if (failed) return;
    try {
      const event = JSON.parse(text) as ThreadEvent;
      jsonBoundary?.(event);
      args.event(event);
    } catch (error) {
      failed = true;
      failure = error;
      stop.abort(error);
    }
  };
  try {
    assertProviderTurnDeadline(args.deadlineAt);
    const result = await subprocessAsync(
      file,
      command,
      { env, signal },
      args.prompt,
      (stream, chunk) => {
        if (stream === "stderr") {
          if (telemetry) telemetry.chunk(chunk);
          else stderr?.chunk(chunk);
          return;
        }
        if (stream !== "stdout" || failed) return;
        pending += decoder.write(chunk);
        for (
          let end = pending.indexOf("\n");
          end >= 0;
          end = pending.indexOf("\n")
        ) {
          const next = pending.slice(0, end).replace(/\r$/, "");
          pending = pending.slice(end + 1);
          line(next);
        }
      },
      args.boundary ? (event) => observe("factory-process", event) : undefined,
      args.boundary ? { stderr: false } : undefined,
    );
    pending += decoder.end();
    if (pending) line(pending);
    if (failed) throw failure;
    if (result.status !== 0) {
      if (args.boundary) {
        telemetry?.finish();
        stderr?.finish();
      }
      const message = `Codex Exec exited with code ${result.status}: ${args.boundary ? filteredStderr : result.stderr}`;
      throw codexAuthentication({ message }) ?? new Error(message);
    }
  } catch (error) {
    if (error instanceof UnsettledSubprocessError)
      throw attachFault(
        new UnsettledSubprocessError(error.message, {
          cause: args.signal.aborted
            ? args.signal.reason
            : failed
              ? failure
              : error,
        }),
        { kind: "defect", detail: error.message },
      );
    if (failed) throw failure;
    if (args.signal.aborted) throw args.signal.reason;
    throw error;
  } finally {
    telemetry?.finish();
    stderr?.finish();
  }
}
