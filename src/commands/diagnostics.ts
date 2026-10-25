/**
 * `factory diagnostics`: its options, help and check, and what it does.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ANALYSIS_FIELDS,
  type AnalysisField,
  analyze,
  captures,
  gantt,
} from "../analysis.js";
import { diagnostics } from "../diagnostics.js";
import { configOf, Refusal } from "../host.js";
import { CAPTURE_OFF, logFiles, runOfFile } from "../log.js";
import type { Paths } from "../paths.js";
import {
  type Scorecard,
  ScorecardError,
  scorecard,
  scorecardText,
} from "../scorecard.js";
import { listAllObjectives } from "../state.js";
import { errorMessage } from "../text.js";
import {
  type Args,
  type Command,
  issueCheck,
  issueOf,
  usage,
} from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: {
    follow: "switch",
    logs: "value",
    summary: "switch",
    run: "value",
    "all-runs": "switch",
    "show-captures": "switch",
    captures: "switch",
    content: "value",
    analyze: "switch",
    "group-by": "list",
    filter: "list",
    gantt: "switch",
    scorecard: "value",
    json: "switch",
  },
  help: "Show what an Objective's run did, from its run log: a timeline of steps, waits, repairs, holds and answers, model calls (role, provider, model, time, tokens) and worker activity, relative to the run's start; --follow streams new lines, --logs ITEM shows one Work Item's events in detail with each model call's capture file (--show-captures prints its request and response; capture.enabled keeps them) and each worker attempt's transcript (its tool calls with their targets and the provider's raw output), --summary the totals per role and phase, repairs, holds, the critical path and the slowest steps, --captures lists the captured model calls (--content ID prints one), --analyze the time, wait, retry, repair, hold, validation, activity and history views and per group (--group-by FIELD, default phase; --filter FIELD=VALUE, null for missing) tokens, cache effectiveness, tool calls, outcomes and efficiency, --gantt a chart of each Work Item's steps over time in lanes per item and phase; the latest run, or --run ID, or --all-runs. Without ISSUE, --scorecard ABSOLUTE_FILE compares the Factory Objectives and codex-direct sessions the selection FILE names (docs/reference/run-log.md#Run log): per packet, per route and per pair, with how many of each Objective's runs the run log still has",
  check: (args, command) => {
    const { flags, lists } = args;
    if (flags.scorecard !== undefined) {
      const others = Object.keys(flags).filter(
        (flag) => !["scorecard", "json", "repo"].includes(flag),
      );
      return args.positional[1] !== undefined
        ? "--scorecard reads its Objectives from the selection file; give no ISSUE"
        : others.length || Object.keys(lists).length
          ? `--scorecard goes with --json only, not --${[...others, ...Object.keys(lists)].join(", --")}`
          : isAbsolute(flags.scorecard)
            ? undefined
            : `--scorecard takes an absolute path to the selection file; not ${flags.scorecard}`;
    }
    const modes = ["summary", "logs", "captures", "analyze", "gantt"].filter(
      (mode) => flags[mode] !== undefined,
    );
    const fields = [
      ...(lists["group-by"] ?? []),
      ...(lists.filter ?? []).map((filter) => filter.split("=")[0]!),
    ];
    const unknown = fields.find(
      (field) => !ANALYSIS_FIELDS.includes(field as AnalysisField),
    );
    return (
      issueCheck(args, command) ??
      (modes.length > 1
        ? `give one of --${modes.join(", --")}, not several`
        : flags.follow !== undefined && modes.length && modes[0] !== "logs"
          ? `--follow goes with the timeline or --logs ITEM, not --${modes[0]}`
          : flags.run !== undefined && flags["all-runs"] !== undefined
            ? "give --run ID or --all-runs, not both"
            : flags["show-captures"] !== undefined && flags.logs === undefined
              ? "--show-captures goes with --logs ITEM"
              : flags.content !== undefined && flags.captures === undefined
                ? "--content ID goes with --captures"
                : (lists["group-by"] || lists.filter) &&
                    flags.analyze === undefined
                  ? "--group-by and --filter go with --analyze"
                  : (lists.filter ?? []).some((f) => f.indexOf("=") < 1)
                    ? "--filter takes FIELD=VALUE, such as --filter role=worker"
                    : unknown !== undefined
                      ? `Unknown analysis field ${unknown}; use ${ANALYSIS_FIELDS.join(", ")}`
                      : undefined)
    );
  },
  run: ({ paths, repository, args }) =>
    diagnosticsCommand(paths, repository, args),
};

/** `factory diagnostics --scorecard FILE [--json]`, or `factory diagnostics ISSUE [--follow] [--logs ITEM [--show-captures]] [--summary] [--captures [--content ID]] [--analyze [--group-by F]... [--filter F=V]...] [--gantt] [--run ID | --all-runs] [--json]`. */
async function diagnosticsCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  if (args.flags.scorecard !== undefined)
    return scorecardCommand(paths, repository, args);
  const issue = issueOf(args);
  const runs = logFiles(paths.logs, issue).map(runOfFile);
  if (!runs.length && !listAllObjectives(paths.objectives).includes(issue))
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log or state for #${issue}.`,
    );
  const { flags } = args;
  if (flags.run !== undefined && !runs.includes(flags.run))
    throw new Refusal(
      "no_factory_state",
      `#${issue} has no run ${flags.run} in its run log; its runs: ${runs.join(", ") || "none"}.`,
    );
  const config = configOf(repository);
  const maxBytesPerCall =
    config?.capture.maxBytesPerCall ?? CAPTURE_OFF.maxBytesPerCall;
  const read = {
    logs: paths.logs,
    issue,
    runs:
      flags.run !== undefined
        ? { kind: "run" as const, id: flags.run }
        : flags["all-runs"] !== undefined
          ? { kind: "all" as const }
          : { kind: "latest" as const },
    json: flags.json !== undefined,
    secrets: config?.secrets ?? [],
  };
  const write = (text: string) => {
    process.stdout.write(text);
  };
  if (flags.captures !== undefined) {
    const missing = captures(
      {
        ...read,
        maxBytesPerCall,
        ...(flags.content !== undefined ? { id: flags.content } : {}),
      },
      write,
    );
    if (missing) throw new Refusal("no_factory_state", missing);
    return 0;
  }
  if (flags.analyze !== undefined) {
    const filters: Partial<Record<AnalysisField, string>> = {};
    for (const filter of args.lists.filter ?? []) {
      const at = filter.indexOf("=");
      filters[filter.slice(0, at) as AnalysisField] = filter.slice(at + 1);
    }
    const groupBy = [
      ...new Set((args.lists["group-by"] ?? ["phase"]) as AnalysisField[]),
    ];
    analyze({ ...read, groupBy, filters }, write);
    return 0;
  }
  if (flags.gantt !== undefined) {
    gantt(read, write);
    return 0;
  }
  await diagnostics(
    {
      logs: paths.logs,
      issue,
      runs: read.runs,
      ...(flags.logs !== undefined ? { item: flags.logs } : {}),
      summary: flags.summary !== undefined,
      follow: flags.follow !== undefined,
      captures: flags["show-captures"] !== undefined,
      json: flags.json !== undefined,
      secrets: read.secrets,
      maxBytesPerCall,
    },
    (text) => process.stdout.write(text),
  );
  return 0;
}

/** `factory diagnostics --scorecard ABSOLUTE_FILE [--json]`: read-only, redacted. */
function scorecardCommand(
  paths: Paths,
  repository: string,
  args: Args,
): number {
  const file = args.flags.scorecard!;
  let selection: unknown;
  try {
    selection = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw usage(
      `Can't read the scorecard selection ${file}: ${errorMessage(error)}`,
    );
  }
  let report: Scorecard;
  try {
    report = scorecard(
      {
        logs: paths.logs,
        objectives: paths.objectives,
        secrets: configOf(repository)?.secrets ?? [],
      },
      selection as Parameters<typeof scorecard>[1],
    );
  } catch (error) {
    if (error instanceof ScorecardError)
      throw new Refusal(error.code, error.message);
    throw error;
  }
  process.stdout.write(
    args.flags.json !== undefined
      ? `${JSON.stringify(report)}\n`
      : scorecardText(report),
  );
  return 0;
}
