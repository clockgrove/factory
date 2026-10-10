import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { codexRuntimeDirectory } from "./codex-planning-isolation.js";
import { attachFault } from "./fault.js";
import { subprocessAsync, UnsettledSubprocessError } from "./process.js";
import { redactDiagnosticDetail } from "./diagnostics.js";
import type { ModelBoundaryObservation } from "./capture.js";
import {
  codexBoundaryTelemetry,
  codexJsonBoundaries,
} from "./codex-boundary-telemetry.js";

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

/** The installed SDK's native JSON protocol, with Factory-owned cessation. */
export async function runCodexExec(args: {
  env: Record<string, string>;
  options: ThreadOptions;
  prompt: string;
  schema: unknown;
  threadId?: string;
  signal: AbortSignal;
  deadlineAt?: string;
  event: (event: ThreadEvent) => void;
  stderr?: (diagnostic: CodexStderrDiagnostic) => void | Promise<void>;
  redactionValues?: string[];
  boundary?: (observation: ModelBoundaryObservation) => void;
}): Promise<void> {
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
  const options = args.options;
  const command = ["exec", "--experimental-json"];
  if (options.model) command.push("--model", options.model);
  if (options.sandboxMode) command.push("--sandbox", options.sandboxMode);
  if (options.workingDirectory) command.push("--cd", options.workingDirectory);
  if (options.skipGitRepoCheck) command.push("--skip-git-repo-check");
  command.push("--output-schema", schema);
  if (options.modelReasoningEffort)
    command.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(options.modelReasoningEffort)}`,
    );
  command.push("--config", 'approval_policy="never"');
  if (args.threadId) command.push("resume", args.threadId);
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
      throw new Error(
        `Codex Exec exited with code ${result.status}: ${args.boundary ? filteredStderr : result.stderr}`,
      );
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
