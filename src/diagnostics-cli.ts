import { runAnalysisCommand } from "./analysis-cli.js";
import { readInteractionContent, readInteractionMetadata } from "./capture.js";
import { option } from "./cli-flags.js";
import type { FactoryConfig } from "./config.js";
import {
  readAgentTimeline,
  readUsageSummaryEvents,
  readWorkerOutput,
  redactDiagnosticDetail,
  summarizeDiagnosticUsage,
} from "./diagnostics.js";
import { readContinuation, readState } from "./state-store.js";

const modes = ["summary", "analyze", "logs", "captures"] as const;
const analysisFlags = ["group-by", "filter", "json", "gantt", "output"];

/** Keep printing until interrupted. */
function untilInterrupted(tick: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const interval = setInterval(tick, 250);
    const stop = () => {
      clearInterval(interval);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/**
 * `factory diagnostics`: the one observation command. Without a mode it prints the agent
 * timeline (`--follow` keeps printing); `--summary` totals usage, `--analyze` reports on
 * retained interactions, `--logs ITEM` prints a Work Item's worker output and `--captures`
 * lists retained captures (`--content ID` prints one).
 */
export async function runDiagnosticsCommand(
  config: FactoryConfig,
  objective: number,
  args: string[],
): Promise<void> {
  const flags = new Set(
    args.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2)),
  );
  const chosen = modes.filter((mode) => flags.has(mode));
  const follow = flags.has("follow");
  if (chosen.length > 1 || (follow && chosen.some((mode) => mode !== "logs")))
    throw new Error(
      "diagnostics takes one mode: --follow, --summary, --analyze, --logs ITEM or --captures (--follow also goes with --logs)",
    );
  const mode = chosen[0];
  if (mode !== "analyze")
    for (const flag of analysisFlags)
      if (flags.has(flag))
        throw new Error(`--${flag} belongs to diagnostics --analyze`);
  if (mode !== "captures" && flags.has("content"))
    throw new Error("--content belongs to diagnostics --captures");
  const secrets = config.policy.allowedSecretNames
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));

  if (mode === "analyze") {
    process.stdout.write(
      runAnalysisCommand(
        config,
        objective,
        args.filter((arg) => arg !== "--analyze"),
      ),
    );
    return;
  }
  if (mode === "captures") {
    const records = readInteractionMetadata(config.repository, objective);
    const id = option(args, "content");
    if (id) {
      const record = records.find((record) => record.recordId === id);
      if (!record?.content.reference)
        throw new Error("Captured content unavailable for this record");
      console.log(
        readInteractionContent(config.repository, record.content.reference),
      );
    } else for (const record of records) console.log(JSON.stringify(record));
    return;
  }
  if (mode === "logs") {
    const item = option(args, "logs");
    if (!item || item.startsWith("--"))
      throw new Error("diagnostics --logs requires ITEM");
    const attempt = readState(config.repository, objective)?.work[item]
      ?.attempt;
    if (!attempt)
      throw new Error("--logs requires a Work Item with a recorded attempt");
    let lines = 0;
    const show = () => {
      const complete = readWorkerOutput(config.repository, attempt).split("\n");
      complete.pop();
      for (const line of complete.slice(lines))
        console.log(redactDiagnosticDetail(line, secrets));
      lines = complete.length;
    };
    show();
    if (follow) await untilInterrupted(show);
    return;
  }
  const continuation = readContinuation(config.repository, objective);
  const executing =
    continuation?.schemaVersion === 7 ? continuation : undefined;
  if (mode === "summary") {
    console.log(
      JSON.stringify(
        summarizeDiagnosticUsage(
          readUsageSummaryEvents(config.repository, objective, executing),
        ),
      ),
    );
    return;
  }
  const seen = new Set<string>();
  const printNew = () => {
    const current = readContinuation(config.repository, objective);
    const timeline = readAgentTimeline(
      config.repository,
      objective,
      current?.schemaVersion === 7 ? current : undefined,
    );
    for (const event of timeline) {
      const json = JSON.stringify(event);
      if (!seen.has(json)) console.log(json);
      seen.add(json);
    }
  };
  printNew();
  if (follow) await untilInterrupted(printNew);
}
