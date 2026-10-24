#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_FIELDS,
  type AnalysisField,
  analyze,
  captures,
  gantt,
} from "./analysis.js";
import {
  type CapacityRecommendation,
  capacityRecommendation,
  hostCapacity,
} from "./capacity.js";
import {
  prepareExport,
  previewText,
  sendExport,
  writeExport,
} from "./capture-export.js";
import { type CoreConfig, loadConfig } from "./config.js";
import { diagnostics } from "./diagnostics.js";
import { eventLine, redactDeep } from "./display.js";
import { MAX_ANSWER_TEXT, settled } from "./engine.js";
import { gitEnvironment } from "./git.js";
import { GitHub } from "./github.js";
import { finalShown, requeued } from "./github-sync.js";
import {
  ConfigurationError,
  configOf,
  followRun,
  knowledge,
  providerNamed,
  Refusal,
  serveInstallation,
  serviceLive,
} from "./host.js";
import {
  type DreamCommand,
  dreamCommand,
  runDream,
} from "./knowledge/dream.js";
import {
  type LogEvent,
  logFiles,
  newRunId,
  RunLog,
  readLog,
  readNew,
  runOfFile,
  untilInterrupted,
} from "./log.js";
import { installationPaths, type Paths, validRepository } from "./paths.js";
import { BaseFiles } from "./planning/facts.js";
import {
  markdownBlocks,
  previewRecipe,
  recipeInstallation,
  selectRecipe,
} from "./planning/recipes.js";
import {
  approveProposal,
  draftProposal,
  ProposalRefused,
} from "./proposals.js";
import type { Planner } from "./providers/planner.js";
import { providerPlanner } from "./providers/selection.js";
import { readCards } from "./queue.js";
import {
  type QueueMode,
  type Request,
  type RequestResult,
  writeRequest,
} from "./requests.js";
import {
  type Scorecard,
  ScorecardError,
  scorecard,
  scorecardText,
} from "./scorecard.js";
import {
  SERVICE_MODES,
  SETUP_FLAGS,
  type ServiceReport,
  type SetupReport,
  SetupUsage,
  serviceSetup,
  setup,
} from "./setup.js";
import {
  findState,
  listAllObjectives,
  loadQueueControl,
  type ObjectiveState,
  TERMINAL,
} from "./state.js";
import {
  capacityText,
  type IssueFocus,
  issueFocus,
  readStatus,
  recommendationText,
  statusText,
} from "./status.js";
import { CONFIGURATION_EXIT } from "./systemd.js";
import { errorMessage } from "./text.js";
import { adaptiveWorkflow } from "./validate.js";
import { watch } from "./watch.js";
import { objectiveWorkflow } from "./workflow.js";

/**
 * An option's kind: a switch takes no value, a value takes one, and a list
 * takes one each time it is given (`Args.lists`).
 */
type FlagKind = "switch" | "value" | "list";

interface Command {
  args: string;
  flags: Record<string, FlagKind>;
  help: string;
  /** What is wrong with this command line beyond its options' shape, if anything. */
  check?: (args: Args) => string | undefined;
}

/** The command line names an issue number as its first argument. */
const issueCheck = (args: Args): string | undefined => {
  const command = args.positional[0]!;
  const issue = Number(args.positional[1]);
  return Number.isInteger(issue) && issue > 0
    ? undefined
    : `${command} needs an issue number: factory ${command} ${COMMANDS[command]?.args}`;
};

/** `--issue`'s issue: a number, or an issue URL (its repository is checked where it's known). */
function issueNumber(
  value: string,
): { issue: number; repository?: string } | undefined {
  const url =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(
      value,
    );
  const digits = url ? url[2]! : value;
  const issue = Number(digits);
  if (!/^[1-9][0-9]*$/.test(digits) || !Number.isSafeInteger(issue))
    return undefined;
  return url ? { issue, repository: url[1]! } : { issue };
}

const QUEUE_MODES: Record<string, QueueMode> = {
  pause: "paused",
  drain: "draining",
  resume: "running",
};

/**
 * Every command: its arguments, its options, its help and its check. The
 * one table `factory help`, the option parser and the checks read, so the
 * help covers every command by construction.
 */
const COMMANDS: Record<string, Command> = {
  serve: {
    args: "",
    flags: { provider: "value" },
    help: "Run the service (the only writer of state); new Objectives use --provider NAME, else defaultProvider",
  },
  setup: {
    args: "",
    flags: SETUP_FLAGS,
    help: "Write and check the configuration (--checkout PATH --project-id PVT_... to create it), the checkout's origin and the queue's Project fields; repeated, it changes nothing. --provider NAME [--planner KIND] [--worker codex|claude|copilot] [--default] adds or changes a provider; see docs/DESIGN.md#Setup for every option",
  },
  run: {
    args: "ISSUE",
    flags: { provider: "value", deadline: "value" },
    help: "Queue the Objective now and follow it to the end (Ctrl-C stops following; it keeps running): --provider NAME runs it on that provider, --deadline an ISO time or a duration (90m, 2h, 1d12h) cancels it then; exits 0 when done, 2 when it needs you (a question, or the service isn't running: the request waits for it), 1 when cancelled or refused. Run again on a running Objective to follow it",
    check: (args) =>
      issueCheck(args) ??
      (args.flags.deadline === undefined ||
      deadlineOf(args.flags.deadline, Date.now()) !== undefined
        ? undefined
        : `--deadline takes a future ISO time (2026-11-01T18:00:00Z) or a duration (90m, 2h, 1d12h); not ${args.flags.deadline}`),
  },
  status: {
    args: "[ISSUE]",
    flags: {
      json: "switch",
      all: "switch",
      capacity: "switch",
      issue: "value",
    },
    help: "Show the service, the queue and each Objective: its phase, the next command, its Work Items, provider, allowances and open questions; --json is the full model with the plan, --all also lists Objectives finished more than 24 h ago, --capacity shows the host's slots and memory in use and how the configured capacity fits the host, --issue N (or the issue's URL) shows the Objective that issue N is, or whose Work Item it is, from local state only",
    check: (args) =>
      args.flags.issue !== undefined
        ? args.positional[1] !== undefined
          ? "give the Objective as ISSUE or --issue N, not both"
          : issueNumber(args.flags.issue) === undefined
            ? `--issue takes an issue number or its GitHub URL; not ${args.flags.issue}`
            : undefined
        : args.positional[1] === undefined
          ? undefined
          : issueCheck(args),
  },
  log: {
    args: "ISSUE",
    flags: { tail: "value", follow: "switch", json: "switch" },
    help: "Show an Objective's run log: the last --tail N events (50), --follow for new ones",
    check: (args) => {
      const tail = Number(args.flags.tail ?? 0);
      return (
        issueCheck(args) ??
        (Number.isInteger(tail) && tail >= 0
          ? undefined
          : "--tail takes a whole number of events, such as --tail 100")
      );
    },
  },
  diagnostics: {
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
    help: "Show what an Objective's run did, from its run log: a timeline of steps, waits, repairs, holds and answers, model calls (role, provider, model, time, tokens) and worker activity, relative to the run's start; --follow streams new lines, --logs ITEM shows one Work Item's events in detail with each model call's capture file (--show-captures prints its request and response; capture.enabled keeps them), --summary the totals per role and phase, repairs, holds, the critical path and the slowest steps, --captures lists the captured model calls (--content ID prints one), --analyze the time, wait, retry, repair, hold, validation, activity and history views and per group (--group-by FIELD, default phase; --filter FIELD=VALUE, null for missing) tokens, cache effectiveness, tool calls, outcomes and efficiency, --gantt a chart of each Work Item's steps over time in lanes per item and phase; the latest run, or --run ID, or --all-runs. Without ISSUE, --scorecard ABSOLUTE_FILE compares the Factory Objectives and codex-direct sessions the selection FILE names (docs/DESIGN.md#Run log): per packet, per route and per pair, with how many of each Objective's runs the run log still has",
    check: (args) => {
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
        issueCheck(args) ??
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
  },
  "export-captures": {
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
    check: (args) => {
      const { flags } = args;
      const content = flags.content ?? "metadata";
      const output = flags.output;
      return (
        issueCheck(args) ??
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
  },
  watch: {
    args: "[ISSUE]",
    flags: {},
    help: "Follow running work live, one row per Work Item: its step, outcome or hold, and its worker's turns, tools, edits and last command; from the run log, every Objective active in the last 24 h without ISSUE",
    check: (args) =>
      args.positional[1] === undefined ? undefined : issueCheck(args),
  },
  answer: {
    args: "ISSUE ANSWER [ARG]",
    flags: {
      question: "value",
      text: "value",
      "text-file": "value",
      "review-artifacts": "list",
    },
    help: "Answer open question --question ID with one of its options (status lists them); ARG is the option's argument (`switch NAME`); --text, or --text-file ABSOLUTE_PATH, the text (`answer` sends it to the next attempt as your guidance); with `revalidate`, --review-artifacts N (repeatable) captures only the configured reviewArtifacts selectors numbered N (from 1), or none, for this rereview",
    check: (args) => {
      const answer = args.positional[2];
      const file = args.flags["text-file"];
      return (
        issueCheck(args) ??
        (!answer
          ? "answer needs an answer: factory answer ISSUE ANSWER --question ID"
          : // Bound to the question the operator read, so a delayed answer
            // never lands on a newer one. Cancel needs no question.
            answer !== "cancel" && args.flags.question === undefined
            ? `answer needs --question with the open question's id, so it can't answer a newer one: see \`factory status ${args.positional[1]}\``
            : // ARG names a parameterized answer's option (`switch NAME`).
              answer === "cancel" && args.positional[3] !== undefined
              ? "cancel takes no argument"
              : file !== undefined && args.flags.text !== undefined
                ? "give --text or --text-file, not both"
                : file !== undefined && !isAbsolute(file)
                  ? "--text-file needs an absolute path"
                  : args.lists["review-artifacts"] &&
                      answer !== "revalidate" &&
                      answer !== "more"
                    ? "--review-artifacts goes with revalidate: factory answer ISSUE revalidate --question ID --review-artifacts N"
                    : undefined)
      );
    },
  },
  "propose-amendment": {
    args: "ISSUE",
    flags: { file: "value" },
    help: "Propose an amendment of the accepted plan: --file ABSOLUTE_PATH holds JSON with scope (in-scope), reason, and lists evidence, ownership, acceptance and dependencies (known Work Item ids). The planner revises the plan for it and an independent review judges it; it uses a planning revision. A rejected amendment is replaced by answering its question with replace",
    check: (args) =>
      issueCheck(args) ??
      (args.flags.file && isAbsolute(args.flags.file)
        ? undefined
        : "propose-amendment needs --file ABSOLUTE_PATH"),
  },
  "decline-discovery": {
    args: "ISSUE",
    flags: { item: "value", reason: "value" },
    help: "Decline Work Item --item ITEM's pending discovery proposal (the worker's .factory-discovery.json, proposed as an amendment) with --reason TEXT: the item carries on with its result as collected; the planning revision stays spent",
    check: (args) =>
      issueCheck(args) ??
      (args.flags.item && args.flags.reason?.trim()
        ? undefined
        : "decline-discovery needs --item ITEM and --reason TEXT"),
  },
  retry: {
    args: "ISSUE",
    flags: { question: "value" },
    help: "Retry the waiting steps no open question stops now; with --question ID, answer retry to it",
    check: issueCheck,
  },
  cancel: {
    args: "ISSUE",
    flags: {},
    help: "Cancel an Objective",
    check: issueCheck,
  },
  reset: {
    args: "ISSUE",
    flags: {},
    help: "Rebuild an Objective's state from GitHub: its plan comment, PRs and report",
    check: issueCheck,
  },
  pause: {
    args: "ISSUE",
    flags: {},
    help: "Pause an Objective: no step starts until resume",
    check: issueCheck,
  },
  drain: {
    args: "ISSUE",
    flags: {},
    help: "Drain an Objective: started Work Items finish, no new one starts",
    check: issueCheck,
  },
  resume: {
    args: "ISSUE",
    flags: {},
    help: "Resume a paused or drained Objective",
    check: issueCheck,
  },
  queue: {
    args: "list|pause|resume|drain",
    flags: { json: "switch" },
    help: "List the Project's queued, candidate and inert cards, or pause, drain or resume the whole queue",
    check: (args) => {
      const action = args.positional[1];
      if (action === "list") return undefined;
      if (!action || !QUEUE_MODES[action])
        return `Unknown queue action ${action ?? "(none)"}; use factory queue list, pause, resume or drain`;
      return args.flags.json === undefined
        ? undefined
        : `--json belongs to factory queue list; use factory queue ${action}`;
    },
  },
  dream: {
    args: "",
    flags: {
      preview: "switch",
      record: "switch",
      show: "switch",
      objective: "value",
      file: "value",
      approve: "value",
      reject: "value",
      "budget-bytes": "value",
      "input-budget-bytes": "value",
      provider: "value",
    },
    help: "Propose a playbook from settled episodes ([--preview] [--budget-bytes N] [--input-budget-bytes N] [--provider NAME]); --record --objective N records one; --file PATH --approve|--reject SHA256 decides a draft; --show shows the playbook",
    check: (args) => {
      const parsed = dreamCommand(args.flags);
      return typeof parsed === "string" ? parsed : undefined;
    },
  },
  propose: {
    args: "[INTENT]",
    flags: {
      source: "list",
      file: "value",
      approve: "value",
      enqueue: "switch",
      provider: "value",
    },
    help: "Draft Objectives with the planner, checked like a queued Objective, previewed and saved as one draft; nothing goes to GitHub: one from INTENT, or with --source DOC#HEADING one per roadmap item of that section at the default branch, with their dependencies (a further --source is context); [--file ABSOLUTE_NEW_FILE] [--provider NAME]. --file DRAFT --approve SHA256 creates their issues from the reviewed draft's exact bytes and links each dependency as blocked-by (once, however often it runs); --enqueue also queues them, as factory run does",
    check: (args) => {
      const intent = args.positional[1];
      const { file, approve, enqueue, provider } = args.flags;
      const sources = args.lists.source;
      if (file !== undefined && !isAbsolute(file))
        return "--file needs an absolute path";
      if (approve === undefined)
        return enqueue !== undefined
          ? "--enqueue goes with --approve: factory propose --file DRAFT --approve SHA256 --enqueue"
          : intent !== undefined && sources
            ? 'give "INTENT" or --source DOC#HEADING, not both'
            : sources
              ? sources.some(
                  (source) =>
                    !source.trim() || /[\s`]/.test(source.split("#")[0]!),
                )
                ? "--source takes a repository path, or path#Exact Heading"
                : undefined
              : !intent?.trim()
                ? 'propose needs the intent or a roadmap section: factory propose "INTENT", or factory propose --source DOC#HEADING'
                : intent.length > MAX_ANSWER_TEXT
                  ? `The intent is over ${MAX_ANSWER_TEXT} characters`
                  : undefined;
      return intent !== undefined || sources
        ? "give the intent or --source to draft, or --file DRAFT --approve SHA256 to publish a draft, not both"
        : provider !== undefined
          ? "--provider goes with drafting; an approval makes no model call"
          : file === undefined
            ? "--approve needs the draft: factory propose --file DRAFT --approve SHA256"
            : /^[a-f0-9]{64}$/.test(approve)
              ? undefined
              : "--approve takes the draft's exact SHA-256 (64 hex characters)";
    },
  },
  recipe: {
    args: "",
    flags: { file: "value" },
    help: "Preview the Workflow recipe of the Objective in --file ABSOLUTE_PATH (Markdown) at the checkout's HEAD, with no model call; exits 1 when it can't be used",
    check: (args) => {
      const file = args.flags.file;
      if (!file || !isAbsolute(file))
        return "recipe needs --file ABSOLUTE_OBJECTIVE";
      return lstatSync(file, { throwIfNoEntry: false })?.isFile()
        ? undefined
        : `recipe --file ${file} isn't a regular file`;
    },
  },
  help: { args: "", flags: {}, help: "Show this help" },
};

/** How an option is written in help and fixes: `--tail N`, `--json`. */
function flagForm(
  name: string,
  kind: FlagKind | undefined,
  command?: string,
): string {
  const value =
    (command === "export-captures" && name === "content"
      ? "metadata|retained"
      : undefined) ??
    {
      tail: "N",
      logs: "ITEM",
      run: "ID",
      content: "ID",
      "group-by": "FIELD",
      filter: "FIELD=VALUE",
      scorecard: "FILE",
      endpoint: "URL",
      output: "ABSOLUTE_FILE",
      authorize: "DIGEST",
      invocation: "ID",
    }[name] ??
    name.toUpperCase();
  return kind === "switch"
    ? `--${name}`
    : kind === "list"
      ? `--${name} ${value}...`
      : `--${name} ${value}`;
}

const USAGE = `Usage: factory <command> --repo OWNER/NAME (or FACTORY_REPOSITORY)

${Object.entries(COMMANDS)
  .map(([name, command]) => {
    const flags = Object.entries(command.flags)
      .map(([flag, kind]) => ` [${flagForm(flag, kind, name)}]`)
      .join("");
    return `  ${`${name} ${command.args}${flags}`.trimEnd()}\n      ${command.help}`;
  })
  .join("\n")}

Queue: factory queue pause holds every Objective (no step starts) and admits
nothing; drain admits nothing new while admitted Objectives carry on; resume
undoes both. Controls survive restarts.

Refusals print {"kind":"lifecycle-refusal","code":"..."} on stderr, then the
message, and exit 1. Wrong usage exits 2. Times show in the host's zone, or
in FACTORY_DISPLAY_TIMEZONE.
`;

const usage = (message: string) => new Refusal("usage", message);

/** How long `factory serve` waits at a stop for steps and jobs to end. */
const STOP_DRAIN_MS = 20_000;

/**
 * Run one command line in this process, as the `factory` binary does,
 * and resolve with its exit code; a refusal throws Refusal. A host program
 * runs commands that build its registered kinds (dream, propose) this way
 * (library.ts).
 */
export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !validRepository(repository))
    throw usage("give --repo OWNER/NAME");
  const paths = installationPaths(repository);
  switch (command) {
    case "serve":
      return await serveCommand(repository, paths, args);
    case "setup":
      return await setupCommand(repository, args);
    case "run":
      return await runCommand(paths, repository, args);
    case "status":
      return await status(paths, repository, args);
    case "log":
      return await logCommand(paths, repository, args);
    case "diagnostics":
      return await diagnosticsCommand(paths, repository, args);
    case "export-captures":
      return await exportCommand(paths, repository, args);
    case "watch":
      await watch(
        paths.logs,
        args.positional[1] === undefined ? undefined : issueOf(args),
        configOf(repository)?.secrets ?? [],
        process.stdout,
      );
      return 0;
    case "queue":
      return await queueCommand(paths, repository, args);
    case "dream":
      return await dream(repository, paths, args);
    case "propose":
      return await propose(repository, paths, args);
    case "recipe":
      return await recipe(repository, args);
    case "answer": {
      // `answer ISSUE switch NAME`: the option's argument, never the text.
      const arg = args.positional[3];
      const { question } = args.flags;
      const text = answerText(args);
      const reviewArtifacts = args.lists["review-artifacts"];
      return await request(paths, {
        kind: "answer",
        issue: issueOf(args),
        answer: args.positional[2]!,
        ...(arg ? { arg } : {}),
        ...(text ? { text } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(reviewArtifacts ? { reviewArtifacts } : {}),
      });
    }
    case "propose-amendment": {
      const file = args.flags.file!;
      let proposal: unknown;
      try {
        proposal = JSON.parse(textFile(file, "--file"));
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw usage(`--file ${file} isn't JSON: ${errorMessage(error)}`);
      }
      return await request(paths, {
        kind: "propose-amendment",
        issue: issueOf(args),
        proposal,
      });
    }
    case "decline-discovery":
      return await request(paths, {
        kind: "decline-discovery",
        issue: issueOf(args),
        item: args.flags.item!,
        reason: args.flags.reason!,
      });
    case "retry":
      return await request(paths, {
        kind: "retry",
        issue: issueOf(args),
        ...(args.flags.question !== undefined
          ? { question: args.flags.question }
          : {}),
      });
    default:
      return await request(paths, {
        kind: command as "cancel" | "reset" | "pause" | "drain" | "resume",
        issue: issueOf(args),
      });
  }
}

/**
 * An answer's text: `--text`, or the UTF-8 file `--text-file` names, read
 * from one descriptor (no symlink, never blocking on a FIFO), a regular
 * file only, and at most the engine's cap, which it enforces for every
 * answer; this read stops past it.
 */
function answerText(args: Args): string | undefined {
  const file = args.flags["text-file"];
  return file === undefined ? args.flags.text : textFile(file, "--text-file");
}

/** The UTF-8 text of `file`, named by option `flag`, read as `answerText` says. */
function textFile(file: string, flag: string): string {
  let fd: number;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    throw usage(`${flag} ${file} can't be opened: ${errorMessage(error)}`);
  }
  try {
    if (!fstatSync(fd).isFile())
      throw usage(`${flag} ${file} isn't a regular file`);
    const buffer = Buffer.alloc(MAX_ANSWER_TEXT + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > MAX_ANSWER_TEXT)
      throw usage(`${flag} ${file} is over ${MAX_ANSWER_TEXT} bytes`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw usage(`${flag} ${file} isn't UTF-8 text`);
    }
  } finally {
    closeSync(fd);
  }
}

async function serveCommand(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  try {
    // The process exits once serve returns, ending what still runs: the
    // stop waits for its drain only briefly (DESIGN.md#Process model).
    return await serveInstallation(repository, paths, {
      drainMs: STOP_DRAIN_MS,
      ...(args.flags.provider !== undefined
        ? { provider: args.flags.provider }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    // A restart can't fix it: the unit doesn't restart on this code.
    process.stderr.write(`factory: ${error.message}\n`);
    return CONFIGURATION_EXIT;
  }
}

/** The provider `--provider` names, else defaultProvider; one the configuration lacks is refused. */
function providerName(config: CoreConfig, args: Args): string {
  return providerNamed(config, args.flags.provider);
}

async function dream(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  // Checked by its COMMANDS check.
  const parsed = dreamCommand(args.flags) as DreamCommand;
  const config = loadConfig(repository);
  const name = providerName(config, args);
  const log = new RunLog(
    paths.logs,
    newRunId(),
    config.capture,
    config.secrets,
  );
  try {
    return await runDream(parsed, {
      settings: knowledge(config, paths),
      planner: () => planner(config, name),
      log: (event) => log.write(0, event),
      settledState: (issue) => settledState(paths, issue),
      send: async (write) => {
        // Only the service writes the store: no fallback to a direct write.
        // A call's end waits for the service instead, so a finished model
        // call is never lost to a restart.
        if (write.op !== "end" && !(await serviceLive(paths)))
          throw new Refusal(
            "service_not_running",
            "The service isn't running, and only it writes the knowledge store: start it (factory serve), then run this again.",
          );
        return (await sent(paths, { kind: "dream", issue: 0, write }))?.detail;
      },
      out: (text) => process.stdout.write(text),
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    process.stderr.write(`factory: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    log.end(() => "stopped");
  }
}

/**
 * `propose`: draft an Objective (proposals.ts), or publish a reviewed
 * draft and, with --enqueue, queue it through a `run` request. A refused
 * draft or approval is `proposal_refused`.
 */
async function propose(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  const config = configOf(repository);
  if (!config)
    throw new Refusal(
      "no_configuration",
      `Factory has no readable configuration for ${repository}; run factory setup.`,
    );
  const log = new RunLog(
    paths.logs,
    newRunId(),
    config.capture,
    config.secrets,
  );
  const deps = {
    config,
    paths,
    github: new GitHub(
      config.repository,
      process.env.FACTORY_GITHUB_API,
    ).redacting(config.secrets),
    log: (event: Record<string, unknown>) => log.write(0, event),
    out: (text: string) => process.stdout.write(text),
  };
  const { file, approve } = args.flags;
  try {
    if (approve === undefined) {
      const name = providerName(config, args);
      const sources = args.lists.source;
      await draftProposal(
        sources ? { sources } : { intent: args.positional[1]! },
        file,
        planner(config, name),
        deps,
      );
      return 0;
    }
    const published = await approveProposal(file!, approve, deps);
    const enqueue = args.flags.enqueue !== undefined;
    // `factory run`'s request for each, with its normal timestamp id so a
    // later `factory run N` still supersedes it: the service sets the card
    // to queued, and the predecessors step orders them by their links. A
    // duplicate from approving again is harmless: startRun accepts an
    // Objective that isn't terminal, and a newer waiting run replaces an
    // older one.
    if (enqueue)
      for (const { issue } of published)
        writeRequest(
          paths.requests,
          { kind: "run", issue },
          process.env.USER ?? "operator",
        );
    const live = enqueue && (await serviceLive(paths));
    const numbers = published.map(({ issue }) => issue).join(" ");
    process.stdout.write(
      `${JSON.stringify({
        issues: published.map((each) => ({
          ...each,
          url: `https://github.com/${config.repository}/issues/${each.issue}`,
        })),
        queued: enqueue,
      })}\n${
        !enqueue
          ? `Queue them with factory run N (${numbers}).\n`
          : live
            ? `Queued: the service sets their cards to queued; factory status shows them.\n`
            : `The service isn't running; the queue requests apply when it starts (factory serve).\n`
      }`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ProposalRefused)
      throw new Refusal("proposal_refused", error.message);
    throw error;
  }
}

/**
 * The planner (plan, review, diagnosis) for a configured provider: the
 * one named, by default `defaultProvider`. An Objective uses its frozen
 * provider's planner.
 */
function planner(
  config: CoreConfig,
  name: string = config.defaultProvider,
): Planner {
  const provider = config.providers[name];
  if (!provider) throw new Error(`No provider ${JSON.stringify(name)}`);
  return providerPlanner(provider);
}

/** An Objective's state once it is terminal with nothing left to run, or why not. */
function settledState(paths: Paths, issue: number): ObjectiveState | string {
  const loaded = findState(paths.objectives, issue);
  if (!loaded) return `Factory has no Objective #${issue}`;
  if (loaded.kind === "unreadable")
    return `#${issue} has unreadable state (${loaded.error})`;
  const { state } = loaded;
  if (!settled(state, objectiveWorkflow()))
    return `Objective #${issue} is ${state.status} and hasn't settled; record it once it is done, or cancelled and cleaned up`;
  return state;
}

/**
 * The engine's limits, with shorter timings from the environment for
 * tests: FACTORY_BACKOFF_MS (first backoff), FACTORY_WAIT_MS (transient
 * budget), FACTORY_NOTE_MS (status note), FACTORY_REMIND_MS (gate
 * reminder), FACTORY_DEADLINE_MS (a cap on step deadlines).
 */
async function status(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  let only = args.positional[1] ? issueOf(args) : undefined;
  let focus: IssueFocus | undefined;
  if (args.flags.issue !== undefined) {
    const named = issueNumber(args.flags.issue)!;
    if (
      named.repository &&
      named.repository.toLowerCase() !== repository.toLowerCase()
    )
      throw usage(`${args.flags.issue} is not an issue of ${repository}`);
    focus = issueFocus(paths, named.issue);
    if (!focus)
      throw new Refusal(
        "no_factory_state",
        `No Objective here is issue #${named.issue} or has it as a Work Item issue`,
      );
    only = focus.objective;
  }
  if (args.flags.capacity !== undefined) {
    const live = await serviceLive(paths);
    const use = live
      ? readStatus(paths, { live, secrets: [] }).capacity
      : undefined;
    let recommendation: CapacityRecommendation | undefined;
    try {
      const config = loadConfig(repository);
      recommendation = capacityRecommendation(
        hostCapacity(config.execution, config.queue.maxActiveObjectives),
      );
    } catch (error) {
      process.stderr.write(`factory: ${errorMessage(error)}\n`);
    }
    process.stdout.write(
      args.flags.json !== undefined
        ? `${JSON.stringify({ service: live ? "running" : "stopped", ...(use ? { capacity: use } : {}), ...(recommendation ? { recommendation } : {}) }, null, 2)}\n`
        : capacityText(live, use, recommendation),
    );
    return 0;
  }
  const view = readStatus(paths, {
    ...(only !== undefined ? { only } : {}),
    live: await serviceLive(paths),
    secrets: configOf(repository)?.secrets ?? [],
  });
  process.stdout.write(
    args.flags.json !== undefined
      ? `${JSON.stringify(focus ? { focus, ...view } : view, null, 2)}\n`
      : `${focus ? `Issue #${focus.issue} is ${focus.item === undefined ? "the Objective" : `Work Item ${focus.item} of Objective #${focus.objective}`}.\n` : ""}${statusText(
          view,
          {
            list: only === undefined,
            all: args.flags.all !== undefined,
          },
        )}`,
  );
  return 0;
}

/** `factory setup`: setup.ts writes and checks; this prints its report. */
async function setupCommand(repository: string, args: Args): Promise<number> {
  const values: Record<string, string[]> = { ...args.lists };
  for (const [flag, value] of Object.entries(args.flags))
    values[flag] = [value];
  const modes = SERVICE_MODES.filter((mode) => values[mode]);
  if (modes.length > 1) throw usage(`give one of --${modes.join(", --")}`);
  if (values["credential-file"] && modes[0] !== "background")
    throw usage(
      "--credential-file binds the background service: give --background",
    );
  let report: SetupReport;
  try {
    if (modes[0])
      return printService(
        await serviceSetup(repository, modes[0], values),
        args,
      );
    report = await setup(repository, values);
  } catch (error) {
    if (error instanceof SetupUsage) throw usage(error.message);
    throw error;
  }
  if (args.flags.json !== undefined)
    process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    const what =
      report.status === "refused"
        ? `${report.config} was not changed`
        : `${report.config} ${report.created ? "created" : report.changed.length ? `changed: ${report.changed.join(", ")}` : "unchanged"}; default provider ${report.defaultProvider}`;
    const mark = { ok: "ok     ", warn: "warning", blocked: "BLOCKED" };
    const checklist = (report.readiness?.checks ?? [])
      .map(
        (check) =>
          `  ${mark[check.status]} ${check.name}: ${check.detail}${check.fix && check.status !== "ok" ? `\n          ${check.fix}` : ""}\n`,
      )
      .join("");
    process.stdout.write(
      `Setup ${report.status}: ${what}.\n${report.problems.map((problem) => `- ${problem}\n`).join("")}${checklist ? `Readiness (no model calls):\n${checklist}` : ""}${report.capacity ? `Capacity: ${recommendationText(report.capacity)}` : ""}${report.status === "refused" || report.created || !report.changed.length ? "" : "Restart the service to use the change.\n"}`,
    );
  }
  return report.status === "configured" ? 0 : 1;
}

/** `setup --background|--check|--stop|--uninstall`'s report. */
function printService(report: ServiceReport, args: Args): number {
  if (args.flags.json !== undefined)
    process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    const service = report.service;
    process.stdout.write(
      [
        `Service ${report.status}${service ? `: ${service.unit} (${service.installed ? `${service.enabled}, ${service.active}${service.serving ? ", serving" : ""}` : "not installed"})` : ""}.`,
        ...(service?.credentials.length
          ? [`  Credentials: ${service.credentials.join(", ")}`]
          : []),
        ...(report.setup && report.setup.status !== "configured"
          ? [
              `  Setup ${report.setup.status}:`,
              ...report.setup.problems.map((problem) => `  - ${problem}`),
            ]
          : []),
        ...report.problems.map((problem) => `- ${problem}`),
        ...report.warnings.map((warning) => `  Warning: ${warning}`),
        "",
      ].join("\n"),
    );
  }
  const ok =
    report.mode === "check"
      ? report.status === "running"
      : report.status !== "blocked";
  return ok ? 0 : 1;
}

/** `factory log ISSUE [--tail N] [--follow] [--json]`. */
async function logCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const tail = args.flags.tail === undefined ? 50 : Number(args.flags.tail);
  const secrets = configOf(repository)?.secrets ?? [];
  // Redacted before formatting, so no escaped form of a secret slips past.
  const print = (event: LogEvent) => {
    const shown = redactDeep(event, secrets);
    process.stdout.write(
      `${args.flags.json !== undefined ? JSON.stringify(shown) : eventLine(shown)}\n`,
    );
  };
  const { events, ends } = readLog(paths.logs, issue, tail);
  if (!ends.size && !listAllObjectives(paths.objectives).includes(issue))
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log or state for #${issue}.`,
    );
  for (const event of events) print(event);
  if (args.flags.follow === undefined) return 0;
  // Follow: new complete lines of every run file, from exactly where the
  // tail read each one (a new file from its start), until interrupted.
  await untilInterrupted(() => {
    for (const event of readNew(paths.logs, issue, ends)) print(event);
  });
  return 0;
}

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
    secrets: configOf(repository)?.secrets ?? [],
  };
  const write = (text: string) => {
    process.stdout.write(text);
  };
  if (flags.captures !== undefined) {
    const missing = captures(
      {
        ...read,
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
      secrets: configOf(repository)?.secrets ?? [],
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
    secrets: configOf(repository)?.secrets ?? [],
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

/** `--deadline`: an absolute time, or a duration from `now`; undefined when it isn't one, or has passed. */
function deadlineOf(value: string, now: number): string | undefined {
  const span = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  const at =
    span && value
      ? now +
        ((Number(span[1] ?? 0) * 24 + Number(span[2] ?? 0)) * 3600 +
          Number(span[3] ?? 0) * 60 +
          Number(span[4] ?? 0)) *
          1000
      : /^\d{4}-\d\d-\d\dT/.test(value)
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) && at > now
    ? new Date(at).toISOString()
    : undefined;
}

/**
 * `factory run ISSUE [--provider NAME] [--deadline WHEN]`: a request that
 * queues the Objective (the service admits it through the normal queue),
 * then a follower: its new run log events, until it ends (0 done, 1
 * cancelled), needs a person (2: a question, or the service isn't
 * running), or Ctrl-C, which stops only the following.
 */
async function runCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const { provider, deadline } = args.flags;
  const { code } = await followRun(paths, repository, {
    issue: issueOf(args),
    ...(provider !== undefined ? { provider } : {}),
    ...(deadline !== undefined
      ? { deadline: deadlineOf(deadline, Date.now())! }
      : {}),
    write: (text) => process.stdout.write(text),
  });
  return code;
}

/** `factory queue list|pause|resume|drain`. */
async function queueCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const action = args.positional[1]!;
  if (action !== "list")
    return await request(paths, {
      kind: "queue",
      issue: 0,
      mode: QUEUE_MODES[action]!,
    });
  const config = configOf(repository);
  if (!config)
    throw new Refusal(
      "no_configuration",
      `Factory has no configuration for ${repository}, so it can't read the Project.`,
    );
  const github = new GitHub(config.repository, process.env.FACTORY_GITHUB_API);
  const { items, truncated } = await readCards(github, config);
  const control = loadQueueControl(paths.root);
  const queuedOption = config.queue.options.queued;
  const queued: { issue: number; order: number | null; status: string }[] = [];
  const candidates: {
    issue: number;
    option: string | null;
    status?: string;
  }[] = [];
  const inert: { issue: number; option: string | null; reason: string }[] = [];
  for (const card of items) {
    let loaded: ReturnType<typeof findState>;
    try {
      loaded = findState(paths.objectives, card.issue);
    } catch {
      loaded = null;
    }
    const state = loaded?.kind === "ok" ? loaded.state : undefined;
    const finished = state && TERMINAL.includes(state.status);
    if (loaded?.kind === "unreadable")
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `Its state can't be read (${loaded.error}): factory reset ${card.issue}, or cancel.`,
      });
    else if (card.option !== queuedOption) {
      if (!state || finished)
        candidates.push({
          issue: card.issue,
          option: card.option,
          ...(state ? { status: state.status } : {}),
        });
    } else if (finished && !requeued(card, state, config))
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: finalShown(state, config)
          ? `It has ${state.status}, and the card still reads the queue it ran from. Move it off queued and back to run it again.`
          : `It has ${state.status}, and its final status isn't on the card yet; it runs again once the service shows it.`,
      });
    else if (control.mode !== "running" && (!state || finished))
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `The queue is ${control.mode}: it is admitted after factory queue resume.`,
      });
    else
      queued.push({
        issue: card.issue,
        order: card.order,
        status: state && !finished ? state.status : "waiting to be admitted",
      });
  }
  queued.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) || a.issue - b.issue,
  );
  const result = { queue: control, queued, candidates, inert, truncated };
  if (args.flags.json !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const lines = [`Queue: ${control.mode}`];
  lines.push(
    queued.length ? "Queued:" : "Queued: none",
    ...queued.map(
      (q) =>
        `  #${q.issue} ${q.status}${q.order !== null ? ` (order ${q.order})` : ""}`,
    ),
    candidates.length
      ? "Candidates (set Status to queued to run):"
      : "Candidates: none",
    ...candidates.map(
      (c) =>
        `  #${c.issue} ${c.option ?? "(no status)"}${c.status ? `, ${c.status}` : ""}`,
    ),
  );
  if (inert.length)
    lines.push(
      "Inert cards:",
      ...inert.map((i) => `  #${i.issue}: ${i.reason}`),
    );
  if (truncated) lines.push(`${truncated} more cards weren't read.`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function request(paths: Paths, body: Request): Promise<number> {
  const result = await sent(paths, body);
  if (!result) return 0;
  // Anything but "ok" is a refusal, even one that names no code.
  if (result.message !== "ok") {
    process.stderr.write(`factory: ${result.message}\n`);
    return 1;
  }
  process.stdout.write("Done.\n");
  return 0;
}

/**
 * Write a request and wait up to 10 s for its result. Undefined when it
 * is still pending: the service isn't running, stopped, or is slow (the
 * CLI says which). A refusal with a code throws it.
 */
async function sent(
  paths: Paths,
  body: Request,
): Promise<RequestResult | undefined> {
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return undefined;
  }
  const file = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return undefined;
    }
    if (existsSync(file)) {
      const result = JSON.parse(readFileSync(file, "utf8")) as RequestResult;
      rmSync(file, { force: true });
      if (result.code) throw new Refusal(result.code, result.message);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write(
    body.kind === "reset"
      ? `The reset is running; factory status ${body.issue} shows it.\n`
      : "Sent; the service hasn't applied it yet.\n",
  );
  return undefined;
}

/**
 * `recipe --file OBJECTIVE`: resolve and check the Objective's Workflow
 * recipe at the checkout's HEAD, as planning would, and print the preview.
 * No model call, no request, no state. Exit 1 when it can't be used.
 */
async function recipe(repository: string, args: Args): Promise<number> {
  const file = args.flags.file!;
  const config = loadConfig(repository);
  // A local file has no GitHub rendering: its sections come from the
  // Markdown itself.
  const blocks = markdownBlocks(readFileSync(file, "utf8"));
  const base = execFileSync(
    "git",
    ["-C", config.checkout, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", env: gitEnvironment() },
  ).trim();
  const adaptive = adaptiveWorkflow(blocks);
  const selected = await selectRecipe(
    blocks,
    new BaseFiles(config.checkout, base),
  );
  const problems = [adaptive.problem, selected.problem].filter(
    (problem): problem is string => problem !== undefined,
  );
  if (!problems.length && !selected.selected)
    problems.push("The Objective has no Workflow recipe section.");
  const preview = selected.selected
    ? previewRecipe(
        selected.selected,
        adaptive.enabled,
        recipeInstallation(config),
        config.execution.concurrency,
      )
    : { status: "blocked", missingPrerequisites: [] };
  const output = {
    ...preview,
    ...(problems.length
      ? {
          status: "blocked",
          missingPrerequisites: [
            ...problems,
            ...(preview.missingPrerequisites as string[]),
          ],
        }
      : {}),
    repository: config.repository,
    base,
    admission: "preview-only",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.status === "ready" ? 0 : 1;
}

/** The service holds its abstract socket while it lives. */

interface Args {
  positional: string[];
  /** Switches (as "") and values, by name. */
  flags: Record<string, string>;
  /** Each list option's values, in order. */
  lists: Record<string, string[]>;
}

/** The issue number a checked command line names. */
function issueOf(args: Args): number {
  return Number(args.positional[1]);
}

/**
 * The command line, checked where it enters: an unknown command, an option
 * the command doesn't take, a missing value, an extra argument, or what the
 * command's own check refuses, with how to write it.
 */
function parse(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, lists: {} };
  if (argv.includes("--help") || argv.includes("-h"))
    return { ...args, positional: ["help"] };
  // The command is the first word that isn't an option or an option's
  // value, so options may come before it.
  let command: string | undefined;
  for (let i = 0; i < argv.length && command === undefined; i++)
    if (!argv[i]!.startsWith("--")) command = argv[i];
    else if (takesValueAnywhere(argv[i]!.slice(2))) i++;
  const spec = command ? COMMANDS[command] : undefined;
  if (command && !spec)
    throw usage(`Unknown command: ${command}; see factory help`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      args.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = name === "repo" ? "value" : spec?.flags[name];
    if (kind === undefined) throw usage(misplaced(name, command));
    if (kind === "switch") {
      args.flags[name] = "";
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw usage(
        `--${name} needs a value: factory ${command ?? "<command>"} ${flagForm(name, kind, command)}`,
      );
    if (kind === "list")
      args.lists[name] = [...(args.lists[name] ?? []), value];
    else args.flags[name] = value;
    i++;
  }
  if (!command || !spec) return args;
  const most = 1 + spec.args.split(" ").filter(Boolean).length;
  if (args.positional.length > most)
    throw usage(
      `factory ${command} takes ${spec.args || "no arguments"}; unexpected ${args.positional.slice(most).join(" ")}`,
    );
  const problem = spec.check?.(args);
  if (problem) throw usage(problem);
  return args;
}

/** Whether any command's option `name` takes a value (`--repo` does everywhere). */
function takesValueAnywhere(name: string): boolean {
  return (
    name === "repo" ||
    Object.values(COMMANDS).some(
      (spec) => spec.flags[name] !== undefined && spec.flags[name] !== "switch",
    )
  );
}

/** The fix for an option this command doesn't take. */
function misplaced(name: string, command: string | undefined): string {
  if (name === "objective" && command)
    return `factory ${command} takes the issue as an argument, not --objective; use factory ${command} ${COMMANDS[command]?.args || "N"}`;
  const owners = Object.entries(COMMANDS)
    .filter(([, spec]) => name in spec.flags)
    .map(([owner]) => owner);
  if (owners.length) {
    const owner = COMMANDS[owners[0]!]!;
    return `--${name} belongs to factory ${owners.join(", ")}; use factory ${owners[0]} ${owner.args} ${flagForm(name, owner.flags[name], owners[0])}`.replace(
      /\s+/g,
      " ",
    );
  }
  return `Unknown option --${name} for factory ${command ?? "(no command)"}; see factory help`;
}

// The `factory` binary; imported by the library, it only exports main.
const entry = (): boolean => {
  try {
    return (
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
};
if (entry())
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Refusal) {
        process.stderr.write(
          `${JSON.stringify({ kind: "lifecycle-refusal", code: error.code })}\nfactory: ${error.message}\n`,
        );
        process.exit(error.code === "usage" ? 2 : 1);
      }
      process.stderr.write(
        `factory: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exit(1);
    },
  );
