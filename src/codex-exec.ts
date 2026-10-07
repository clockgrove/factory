import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { codexRuntimeDirectory } from "./codex-planning-isolation.js";
import { attachFault } from "./fault.js";
import { subprocessAsync, UnsettledSubprocessError } from "./process.js";

/** The installed SDK's native JSON protocol, with Factory-owned cessation. */
export async function runCodexExec(args: {
  env: Record<string, string>;
  options: ThreadOptions;
  prompt: string;
  schema: unknown;
  signal: AbortSignal;
  event: (event: ThreadEvent) => void;
}): Promise<void> {
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
  const stop = new AbortController();
  const signal = AbortSignal.any([args.signal, stop.signal]);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let failed = false;
  let failure: unknown;
  const line = (text: string) => {
    if (failed) return;
    try {
      const event = JSON.parse(text) as ThreadEvent;
      args.event(event);
    } catch (error) {
      failed = true;
      failure = error;
      stop.abort(error);
    }
  };
  try {
    const result = await subprocessAsync(
      file,
      command,
      { env, signal },
      args.prompt,
      (stream, chunk) => {
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
    );
    pending += decoder.end();
    if (pending) line(pending);
    if (failed) throw failure;
    if (result.status !== 0)
      throw new Error(
        `Codex Exec exited with code ${result.status}: ${result.stderr}`,
      );
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
  }
}
