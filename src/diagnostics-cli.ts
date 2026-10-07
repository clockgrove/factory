import { readFileSync } from "node:fs";
import { runAnalysisCommand, writeAnalysisReport } from "./analysis-cli.js";
import { readInteractionContent, readInteractionMetadata } from "./capture.js";
import { option } from "./cli-flags.js";
import type { FactoryConfig } from "./config.js";
import {
  readAgentTimeline,
  readWorkerOutput,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import { renderEfficiency } from "./efficiency.js";
import {
  factoryObjectiveSummary,
  renderScorecard,
  summarizeScorecard,
} from "./scorecard.js";
import { readContinuation, readState } from "./state-store.js";

const modes = ["summary", "analyze", "logs", "captures"] as const;
const analysisFlags = ["group-by", "filter", "json", "gantt", "output"];
/** Flags that belong to --analyze alone; --json is shared with --summary. */
const analyzeOnlyFlags = analysisFlags.filter((flag) => flag !== "json");

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
 * timeline (`--follow` keeps printing); `--summary` prints the efficiency report (`--json` for
 * tools), `--analyze` reports on
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
    for (const flag of analyzeOnlyFlags)
      if (flags.has(flag))
        throw new Error(`--${flag} belongs to diagnostics --analyze`);
  if (flags.has("json") && mode !== "analyze" && mode !== "summary")
    throw new Error("--json belongs to diagnostics --summary or --analyze");
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
  if (mode === "summary") {
    const report = factoryObjectiveSummary(
      config.repository,
      objective,
      Date.now(),
    );
    const { efficiency, accounting } = report;
    if (flags.has("json"))
      console.log(
        JSON.stringify({
          ...accounting,
          efficiency,
          bindings: report.bindings,
          outcome: report.outcome,
          receiptDigest: report.receiptDigest,
        }),
      );
    else process.stdout.write(renderEfficiency(efficiency));
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

/** Batch observation does not need an Objective or perform any lifecycle operation. */
export function runDiagnosticsScorecardCommand(
  config: FactoryConfig,
  args: string[],
): void {
  for (const flag of args.filter((arg) => arg.startsWith("--")))
    if (!["--config", "--scorecard", "--json", "--output"].includes(flag))
      throw new Error(`${flag} does not belong to diagnostics --scorecard`);
  const path = option(args, "scorecard");
  if (!path || path.startsWith("--"))
    throw new Error("diagnostics --scorecard requires a selection JSON file");
  const report = summarizeScorecard(
    config.repository,
    JSON.parse(readFileSync(path, "utf8")),
  );
  const result = args.includes("--json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderScorecard(report);
  const output = option(args, "output");
  if (output) {
    writeAnalysisReport(output, config.checkout, result);
    console.log(`Saved private scorecard to ${output}`);
  } else process.stdout.write(result);
}
