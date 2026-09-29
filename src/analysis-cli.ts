import { realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { readInteractionMetadata } from "./capture.js";
import { readDiagnosticMetadata } from "./diagnostics.js";
import {
  analysisFields,
  analyzeInteractions,
  renderAnalysis,
  type AnalysisField,
  type AnalysisOptions,
} from "./analysis.js";

export function parseAnalysisOptions(
  args: string[],
): AnalysisOptions & { json: boolean; output?: string } {
  const filters: NonNullable<AnalysisOptions["filters"]> = {};
  const groupBy: AnalysisField[] = [];
  let output: string | undefined;
  let json = false;
  const field = (value: string): AnalysisField => {
    if (!analysisFields.includes(value as AnalysisField))
      throw new Error(
        `Unknown analysis field ${value}; choose ${analysisFields.join(", ")}`,
      );
    return value as AnalysisField;
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (
      ![
        "--config",
        "--objective",
        "--filter",
        "--group-by",
        "--output",
      ].includes(flag)
    )
      throw new Error(`Unknown analyze option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    if (flag === "--group-by") groupBy.push(field(value));
    if (flag === "--output") {
      if (output) throw new Error("Use only one --output path");
      output = value;
    }
    if (flag === "--filter") {
      const equals = value.indexOf("=");
      if (equals < 1) throw new Error("Analysis filter must be FIELD=VALUE");
      const name = field(value.slice(0, equals));
      if (filters[name] !== undefined)
        throw new Error(`Duplicate analysis filter: ${name}`);
      filters[name] = value.slice(equals + 1);
    }
  }
  return {
    filters,
    ...(groupBy.length ? { groupBy } : {}),
    json,
    ...(output ? { output } : {}),
  };
}

/** A report is private local metadata: create once, outside the target. */
export function writeAnalysisReport(
  path: string,
  checkout: string,
  content: string,
): void {
  if (!isAbsolute(path))
    throw new Error("Analysis output requires an absolute new file path");
  const destination = resolve(path);
  const parent = dirname(destination);
  // Existing parent only: do not create target directories through a symlink.
  if (realpathSync(parent) !== parent)
    throw new Error("Analysis output parent must not traverse symlinks");
  const target = realpathSync(checkout);
  if (destination === target || destination.startsWith(`${target}${sep}`))
    throw new Error("Analysis output must stay outside the target checkout");
  writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
}

export function runAnalysisCommand(
  config: { repository: string; checkout: string },
  objective: number,
  args: string[],
): string {
  const options = parseAnalysisOptions(args);
  const report = analyzeInteractions(
    readInteractionMetadata(config.repository, objective),
    readDiagnosticMetadata(config.repository, objective).filter(
      (event) => !event.capture && event.operation !== "model-invocation",
    ),
    options,
  );
  const result = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderAnalysis(report);
  if (options.output) {
    writeAnalysisReport(options.output, config.checkout, result);
    return `Saved private analysis report to ${options.output}\n`;
  }
  return result;
}
