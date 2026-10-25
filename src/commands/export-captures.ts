/**
 * `factory export-captures`: its options, help and check, and what it does.
 */
import { isAbsolute } from "node:path";
import {
  prepareExport,
  previewText,
  sendExport,
  writeExport,
} from "../capture-export.js";
import { configOf, Refusal } from "../host.js";
import { CAPTURE_OFF, logFiles, runOfFile } from "../log.js";
import type { Paths } from "../paths.js";
import { errorMessage } from "../text.js";
import { type Args, type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: {
    run: "value",
    "all-runs": "switch",
    invocation: "list",
    content: "value",
    endpoint: "value",
    output: "value",
    json: "switch",
    send: "switch",
    authorize: "value",
  },
  help: "Preview an Objective's model calls as OpenTelemetry spans (OTLP/HTTP JSON) and send nothing: --content metadata (the default; no captured text) or retained (adds the captured request and response, redacted again), --output ABSOLUTE_FILE writes the OTLP requests to a new local file, --endpoint URL (a collector's base URL, HTTPS or loopback HTTP; headers from OTEL_EXPORTER_OTLP_TRACES_HEADERS or OTEL_EXPORTER_OTLP_HEADERS, never shown) prints the digest a send needs; --invocation ID (repeatable) selects model calls by the span id or capture id the preview lists; --send --endpoint URL --authorize DIGEST sends exactly what that preview showed, in bounded batches; the latest run, or --run ID, or --all-runs",
  check: (args, command) => {
    const { flags } = args;
    const content = flags.content ?? "metadata";
    const output = flags.output;
    return (
      issueCheck(args, command) ??
      (content !== "metadata" && content !== "retained"
        ? "--content takes metadata or retained"
        : flags.run !== undefined && flags["all-runs"] !== undefined
          ? "give --run ID or --all-runs, not both"
          : (flags.send !== undefined) !== (flags.authorize !== undefined)
            ? "a send needs --send --endpoint URL --authorize DIGEST, the digest the preview printed"
            : flags.send !== undefined && flags.endpoint === undefined
              ? "--send needs --endpoint URL, the one the preview showed"
              : output !== undefined && !isAbsolute(output)
                ? "--output needs an absolute path"
                : output !== undefined && flags.send !== undefined
                  ? "--output goes with a preview, not --send"
                  : undefined)
    );
  },
  run: ({ paths, repository, args }) => exportCommand(paths, repository, args),
};

/**
 * `factory export-captures ISSUE [--run ID | --all-runs] [--invocation ID]... [--content
 * metadata|retained] [--endpoint URL] [--output FILE] [--json]`: a
 * preview that sends nothing; `--send --endpoint URL --authorize DIGEST`
 * sends what that preview showed. Exits 0 only when every batch was fully
 * acknowledged.
 */
async function exportCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const { flags } = args;
  const runs = logFiles(paths.logs, issue).map(runOfFile);
  if (!runs.length)
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log for #${issue}.`,
    );
  if (flags.run !== undefined && !runs.includes(flags.run))
    throw new Refusal(
      "no_factory_state",
      `#${issue} has no run ${flags.run} in its run log; its runs: ${runs.join(", ")}.`,
    );
  const config = configOf(repository);
  const prepared = prepareExport({
    logs: paths.logs,
    repository,
    issue,
    runs:
      flags.run !== undefined
        ? { kind: "run", id: flags.run }
        : flags["all-runs"] !== undefined
          ? { kind: "all" }
          : { kind: "latest" },
    content: flags.content === "retained" ? "retained" : "metadata",
    ...(args.lists.invocation
      ? { invocations: [...new Set(args.lists.invocation)] }
      : {}),
    ...(flags.endpoint !== undefined ? { endpoint: flags.endpoint } : {}),
    maxBytesPerCall:
      config?.capture.maxBytesPerCall ?? CAPTURE_OFF.maxBytesPerCall,
    secrets: config?.secrets ?? [],
  });
  if (typeof prepared === "string")
    throw new Refusal("export_refused", prepared);
  if (flags.authorize === undefined) {
    if (flags.output !== undefined)
      try {
        writeExport(prepared, flags.output);
      } catch (error) {
        throw new Refusal(
          "export_refused",
          `--output ${flags.output} can't be written as a new file: ${errorMessage(error)}`,
        );
      }
    process.stdout.write(
      flags.json !== undefined
        ? `${JSON.stringify({ status: "preview", ...prepared.preview })}\n`
        : previewText(prepared),
    );
    return 0;
  }
  const receipt = await sendExport(prepared, flags.authorize);
  if (typeof receipt === "string") throw new Refusal("export_refused", receipt);
  process.stdout.write(
    flags.json !== undefined
      ? `${JSON.stringify(receipt)}\n`
      : `Export ${receipt.status}: ${receipt.sent} of ${receipt.batches} batch${receipt.batches === 1 ? "" : "es"} (${receipt.spans} spans) to ${receipt.endpoint}${receipt.status === "accepted" ? "" : `; ${JSON.stringify(receipt.results.at(-1))}: check the collector before sending again`}\n`,
  );
  return receipt.status === "accepted" ? 0 : 1;
}
