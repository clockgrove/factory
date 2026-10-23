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
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { eventLine, redactDeep } from "./display.js";
import {
  DEFAULT_LIMITS,
  type EngineLimits,
  hostLimits,
  MAX_ANSWER_TEXT,
  settled,
} from "./engine.js";
import { gitEnvironment } from "./git.js";
import { GitHub } from "./github.js";
import { GitHubSync, moved } from "./github-sync.js";
import {
  applyDream,
  type DreamCommand,
  dreamCommand,
  runDream,
} from "./knowledge/dream.js";
import { knowledgeObserver } from "./knowledge/index.js";
import {
  configureKnowledge,
  type KnowledgeSettings,
} from "./knowledge/settings.js";
import { lockHeld } from "./lock.js";
import {
  completeLines,
  type LogEvent,
  logFiles,
  parseLines,
  RunLog,
  readFrom,
  readLog,
  sizeOf,
} from "./log.js";
import { installationPaths, type Paths } from "./paths.js";
import { BaseFiles } from "./planning/facts.js";
import {
  markdownBlocks,
  previewRecipe,
  recipeInstallation,
  selectRecipe,
} from "./planning/recipes.js";
import type { Planner } from "./providers/planner.js";
import {
  freezeConfig,
  type ProviderRoute,
  providerPlanner,
  providerWorker,
  providerWorkflow,
} from "./providers/selection.js";
import { readCards } from "./queue.js";
import {
  type QueueMode,
  type RefusalCode,
  type Request,
  type RequestResult,
  writeRequest,
} from "./requests.js";
import { rebuildStep, resettable } from "./reset.js";
import { serve } from "./service.js";
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
  type Frozen,
  findState,
  listAllObjectives,
  loadQueueControl,
  type ObjectiveState,
  TERMINAL,
} from "./state.js";
import { readStatus, statusText } from "./status.js";
import { CONFIGURATION_EXIT } from "./systemd.js";
import { errorMessage } from "./text.js";
import { adaptiveWorkflow } from "./validate.js";
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
    help: "Write and check the configuration (--checkout PATH --project-id PVT_... to create it), the checkout's origin and the queue's Project fields; repeated, it changes nothing. --provider NAME [--planner KIND] [--worker codex|claude|copilot] [--default] adds or changes a provider; see docs/CORE.md#Setup for every option",
  },
  status: {
    args: "[ISSUE]",
    flags: { json: "switch", all: "switch" },
    help: "Show the service, the queue and each Objective: its phase, the next command, its Work Items, provider, allowances and open questions; --json is the full model with the plan, --all also lists Objectives finished more than 24 h ago",
    check: (args) =>
      args.positional[1] === undefined ? undefined : issueCheck(args),
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
  answer: {
    args: "ISSUE ANSWER [ARG]",
    flags: { question: "value", text: "value", "text-file": "value" },
    help: "Answer open question --question ID with one of its options (status lists them); ARG is the option's argument (`switch NAME`); --text, or --text-file ABSOLUTE_PATH, the text (`answer` sends it to the next attempt as your guidance)",
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
                  : undefined)
      );
    },
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
function flagForm(name: string, kind: FlagKind | undefined): string {
  const value = name === "tail" ? "N" : name.toUpperCase();
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
      .map(([flag, kind]) => ` [${flagForm(flag, kind)}]`)
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

class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

const usage = (message: string) => new Refusal("usage", message);

/** Runs a command line `parse` has checked: its arguments are trusted here. */
async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw usage("give --repo OWNER/NAME");
  const paths = installationPaths(repository);
  switch (command) {
    case "serve":
      return await serveCommand(repository, paths, args);
    case "setup":
      return await setupCommand(repository, args);
    case "status":
      return await status(paths, repository, args);
    case "log":
      return await logCommand(paths, repository, args);
    case "queue":
      return await queueCommand(paths, repository, args);
    case "dream":
      return await dream(repository, paths, args);
    case "recipe":
      return await recipe(repository, args);
    case "answer": {
      // `answer ISSUE switch NAME`: the option's argument, never the text.
      const arg = args.positional[3];
      const { question } = args.flags;
      const text = answerText(args);
      return await request(paths, {
        kind: "answer",
        issue: issueOf(args),
        answer: args.positional[2]!,
        ...(arg ? { arg } : {}),
        ...(text ? { text } : {}),
        ...(question !== undefined ? { question } : {}),
      });
    }
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
  if (file === undefined) return args.flags.text;
  let fd: number;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    throw usage(`--text-file ${file} can't be opened: ${errorMessage(error)}`);
  }
  try {
    if (!fstatSync(fd).isFile())
      throw usage(`--text-file ${file} isn't a regular file`);
    const buffer = Buffer.alloc(MAX_ANSWER_TEXT + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > MAX_ANSWER_TEXT)
      throw usage(
        `--text-file ${file} is over ${MAX_ANSWER_TEXT} bytes, an answer's limit`,
      );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw usage(`--text-file ${file} isn't UTF-8 text`);
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
  const limits = envLimits();
  let sync: GitHubSync | undefined;
  let loaded: CoreConfig | undefined;
  let workflow = objectiveWorkflow();
  let frozen: Frozen | undefined;
  if (existsSync(configPath(repository))) {
    let config: CoreConfig;
    try {
      config = loadConfig(repository);
    } catch (error) {
      // A restart can't fix it: the unit doesn't restart on this code.
      process.stderr.write(`factory: ${errorMessage(error)}\n`);
      return CONFIGURATION_EXIT;
    }
    loaded = config;
    configureKnowledge(knowledge(config, paths));
    const name = providerName(config, args);
    frozen = {
      ...freezeConfig(config, name)!,
      provider: name,
      selectedBy: args.flags.provider ? "--provider" : "defaultProvider",
    };
    const github = new GitHub(
      config.repository,
      process.env.FACTORY_GITHUB_API,
    ).redacting(config.secrets);
    sync = new GitHubSync(
      github,
      config,
      new RunLog(paths.logs, "sync"),
      limits,
    );
    const routes = new Map<string, ProviderRoute>();
    for (const [each, settings] of Object.entries(config.providers))
      routes.set(each, {
        frozen: freezeConfig(config, each)!,
        workflow: objectiveWorkflow({
          config,
          github,
          planner: planner(config, each),
          workDir: (issue) => join(paths.root, "work", String(issue)),
          worker: providerWorker(settings, config),
        }),
      });
    workflow = resettable(
      providerWorkflow(routes, routes.get(name)!.workflow),
      rebuildStep(github, config),
    );
  }
  if (loaded)
    hostLimits.configure({
      worker: loaded.execution.workers,
      cpu: loaded.execution.validations,
      github: loaded.queue.maxActiveObjectives,
    });
  return await serve({
    paths,
    workflow,
    ...(loaded ? {} : { unconfigured: configPath(repository) }),
    ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
    ...(sync ? { sync, reset: true } : {}),
    ...(frozen ? { frozen } : {}),
    ...(loaded ? { observer: knowledgeObserver, dream: applyDream } : {}),
    ...(process.env.FACTORY_TICK_MS
      ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
      : {}),
    limits: {
      ...limits,
      ...(loaded ? { concurrency: loaded.execution.concurrency } : {}),
    },
  });
}

/** The provider `--provider` names, else defaultProvider; one the configuration lacks is refused. */
function providerName(config: CoreConfig, args: Args): string {
  const name = args.flags.provider ?? config.defaultProvider;
  if (!config.providers[name])
    throw usage(
      `no provider ${JSON.stringify(name)}; the configuration names ${Object.keys(config.providers).join(", ")}`,
    );
  return name;
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
  const log = new RunLog(paths.logs, "dream");
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

function knowledge(config: CoreConfig, paths: Paths): KnowledgeSettings {
  return {
    repository: config.repository,
    root: paths.root,
    checkout: config.checkout,
    ...(config.planning.context
      ? { planningContext: config.planning.context }
      : {}),
    secrets: config.secrets,
  };
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
function envLimits(): EngineLimits {
  const env = (name: string): number | undefined => {
    const value = Number(process.env[name]);
    return process.env[name] && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const set = <K extends keyof EngineLimits>(key: K, name: string) => {
    const value = env(name);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    ...DEFAULT_LIMITS,
    ...set("baseBackoffMs", "FACTORY_BACKOFF_MS"),
    ...set("maxWaitMs", "FACTORY_WAIT_MS"),
    ...set("noteAfterMs", "FACTORY_NOTE_MS"),
    ...set("remindAfterMs", "FACTORY_REMIND_MS"),
    ...set("maxDeadlineMs", "FACTORY_DEADLINE_MS"),
  };
}

/** The configuration, if this repository has one that loads. */
function configOf(repository: string): CoreConfig | undefined {
  if (!existsSync(configPath(repository))) return undefined;
  try {
    return loadConfig(repository);
  } catch {
    return undefined;
  }
}

async function status(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const only = args.positional[1] ? issueOf(args) : undefined;
  const view = readStatus(paths, {
    ...(only !== undefined ? { only } : {}),
    live: await serviceLive(paths),
    secrets: configOf(repository)?.secrets ?? [],
  });
  process.stdout.write(
    args.flags.json !== undefined
      ? `${JSON.stringify(view, null, 2)}\n`
      : statusText(view, {
          list: only === undefined,
          all: args.flags.all !== undefined,
        }),
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
      `Setup ${report.status}: ${what}.\n${report.problems.map((problem) => `- ${problem}\n`).join("")}${checklist ? `Readiness (no model calls):\n${checklist}` : ""}${report.status === "refused" || report.created || !report.changed.length ? "" : "Restart the service to use the change.\n"}`,
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
  const offsets = ends;
  let stop = false;
  process.once("SIGINT", () => {
    stop = true;
  });
  process.once("SIGTERM", () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const fresh: LogEvent[] = [];
    for (const file of logFiles(paths.logs, issue)) {
      const from = offsets.get(file) ?? 0;
      const complete = completeLines(readFrom(file, from, sizeOf(file)));
      if (!complete.length) continue;
      offsets.set(file, from + complete.length);
      fresh.push(...parseLines(complete.toString("utf8")));
    }
    for (const event of fresh.sort((a, b) => a.at.localeCompare(b.at)))
      print(event);
  }
  return 0;
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
    } else if (finished && !moved(card, state))
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `It has ${state.status}, and the card was set to queued before that. Set it to queued again to run it again.`,
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
const serviceLive = (paths: Paths) => lockHeld(paths.lockName);

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
        `--${name} needs a value: factory ${command ?? "<command>"} ${flagForm(name, kind)}`,
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
    return `--${name} belongs to factory ${owners.join(", ")}; use factory ${owners[0]} ${owner.args} ${flagForm(name, owner.flags[name])}`.replace(
      /\s+/g,
      " ",
    );
  }
  return `Unknown option --${name} for factory ${command ?? "(no command)"}; see factory help`;
}

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
