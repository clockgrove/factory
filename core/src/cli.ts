#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { displayTime, redactDeep } from "./display.js";
import { DEFAULT_LIMITS, type EngineLimits, hostLimits } from "./engine.js";
import { gitEnvironment } from "./git.js";
import { GitHub } from "./github.js";
import { GitHubSync, moved } from "./github-sync.js";
import { dreamCommand, runDream } from "./knowledge/dream.js";
import { knowledgeObserver } from "./knowledge/index.js";
import {
  configureKnowledge,
  type KnowledgeSettings,
} from "./knowledge/settings.js";
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
import { PLANNERS, WORKERS } from "./providers/config.js";
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
import { RESET, type ResetRecord, rebuildStep, resettable } from "./reset.js";
import { serve } from "./service.js";
import {
  type Frozen,
  findState,
  type Hold,
  listAllObjectives,
  loadQueueControl,
  type ObjectiveState,
  type ObjectiveStatus,
  type QueueControl,
  TERMINAL,
} from "./state.js";
import { errorMessage } from "./text.js";
import { adaptiveWorkflow } from "./validate.js";
import { objectiveWorkflow } from "./workflow.js";

/** Worker kinds setup can write: the managed ones need settings by hand. */
const SETUP_WORKERS = ["codex", "claude", "copilot"];

/** The settings a managed worker needs, which setup doesn't take. */
const MANAGED_FIELDS: Record<string, string> = {
  "openai-agents": '"model", "effort", "containerSize", "apiKeyEnv"',
  "claude-managed-agents":
    '"agentId", "agentVersion", "environmentId", "workspaceId", "credentialEnv"',
};

/**
 * Every command: its arguments, its options (true: takes a value), and its
 * help. The one table both `factory help` and the option check read.
 */
const COMMANDS: Record<
  string,
  { args: string; flags: Record<string, boolean>; help: string }
> = {
  serve: {
    args: "",
    flags: { provider: true },
    help: "Run the service (the only writer of state); new Objectives use --provider NAME, else defaultProvider",
  },
  setup: {
    args: "",
    flags: {
      provider: true,
      planner: true,
      worker: true,
      default: false,
      json: false,
    },
    help: "Add or change a named provider (--provider NAME [--planner codex|claude|copilot] [--worker codex|claude|copilot] [--default])",
  },
  status: {
    args: "[ISSUE]",
    flags: { json: false },
    help: "Show the service, the queue, Objectives, open questions, waits and the next step",
  },
  log: {
    args: "ISSUE",
    flags: { tail: true, follow: false, json: false },
    help: "Show an Objective's run log: the last --tail N events (50), --follow for new ones",
  },
  answer: {
    args: "ISSUE ANSWER [NAME]",
    flags: { question: true, text: true },
    help: "Answer open question --question ID (status shows the ids); `switch NAME` runs it on another provider, `adopt` on the changed configuration",
  },
  retry: {
    args: "ISSUE",
    flags: { question: true },
    help: "Retry the waiting steps no open question stops now; with --question ID, answer retry to it",
  },
  cancel: { args: "ISSUE", flags: {}, help: "Cancel an Objective" },
  reset: {
    args: "ISSUE",
    flags: {},
    help: "Rebuild an Objective's state from GitHub: its plan comment, PRs and report",
  },
  pause: {
    args: "ISSUE",
    flags: {},
    help: "Pause an Objective: no step starts until resume",
  },
  drain: {
    args: "ISSUE",
    flags: {},
    help: "Drain an Objective: started Work Items finish, no new one starts",
  },
  resume: {
    args: "ISSUE",
    flags: {},
    help: "Resume a paused or drained Objective",
  },
  queue: {
    args: "list|pause|resume|drain",
    flags: { json: false },
    help: "List the Project's queued, candidate and inert cards, or pause, drain or resume the whole queue",
  },
  dream: {
    args: "",
    flags: {
      preview: false,
      record: false,
      show: false,
      objective: true,
      file: true,
      approve: true,
      reject: true,
      "budget-bytes": true,
      "input-budget-bytes": true,
      provider: true,
    },
    help: "Propose a playbook from settled episodes ([--preview] [--budget-bytes N] [--input-budget-bytes N] [--provider NAME]); --record --objective N records one; --file PATH --approve|--reject SHA256 decides a draft; --show shows the playbook",
  },
  recipe: {
    args: "",
    flags: { file: true },
    help: "Preview the Workflow recipe of the Objective in --file ABSOLUTE_PATH (Markdown) at the checkout's HEAD, with no model call; exits 1 when it can't be used",
  },
  help: { args: "", flags: {}, help: "Show this help" },
};

const USAGE = `Usage: factory <command> --repo OWNER/NAME (or FACTORY_REPOSITORY)

${Object.entries(COMMANDS)
  .map(([name, command]) => {
    const flags = Object.entries(command.flags)
      .map(
        ([flag, value]) =>
          ` [--${flag}${value ? ` ${flag === "tail" ? "N" : flag.toUpperCase()}` : ""}]`,
      )
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
      return setup(repository, args);
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
    default: {
      const issue = issueOf(args);
      if (command === "answer") {
        const answer = args.positional[2];
        if (!answer)
          throw usage(
            "answer needs an answer: factory answer ISSUE ANSWER --question ID",
          );
        // Bound to the question the operator read, so a delayed answer
        // never lands on a newer one. Cancel needs no question.
        const question = args.flags.question;
        if (answer !== "cancel" && question === undefined)
          throw usage(
            `answer needs --question with the open question's id, so it can't answer a newer one: see \`factory status ${issue}\``,
          );
        // `answer ISSUE switch NAME` names the provider, as `--text NAME` does.
        const text = args.flags.text ?? args.positional[3];
        return await request(paths, {
          kind: "answer",
          issue,
          answer,
          ...(text ? { text } : {}),
          ...(question !== undefined ? { question } : {}),
        });
      }
      if (command === "retry")
        return await request(paths, {
          kind: "retry",
          issue,
          ...(args.flags.question !== undefined
            ? { question: args.flags.question }
            : {}),
        });
      return await request(paths, {
        kind: command as "cancel" | "reset" | "pause" | "drain" | "resume",
        issue,
      });
    }
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
    const config = loadConfig(repository);
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
    ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
    ...(sync ? { sync, reset: true } : {}),
    ...(frozen ? { frozen } : {}),
    ...(loaded ? { observer: knowledgeObserver } : {}),
    ...(process.env.FACTORY_TICK_MS
      ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
      : {}),
    limits: {
      ...limits,
      ...(loaded
        ? {
            concurrency: loaded.execution.concurrency,
            maxRepairs: loaded.execution.repairs,
          }
        : {}),
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
  const parsed = dreamCommand(args.flags);
  if (typeof parsed === "string") throw usage(parsed);
  const config = loadConfig(repository);
  const name = providerName(config, args);
  const log = new RunLog(paths.logs, "dream");
  try {
    return await runDream(parsed, {
      settings: knowledge(config, paths),
      planner: () => planner(config, name),
      log: (event) => log.write(0, event),
      settledState: (issue) => settledState(paths, issue),
      out: (text) => process.stdout.write(text),
    });
  } catch (error) {
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
  if (
    !TERMINAL.includes(state.status) ||
    Object.keys(state.attempts).length > 0 ||
    objectiveWorkflow().steps(state).length > 0
  )
    return `Objective #${issue} is ${state.status} and hasn't settled; record it once it is done, failed or cancelled and cleaned up`;
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

interface StatusRow {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  /** The operator's control of this Objective; `running` when none. */
  mode: "running" | "paused" | "draining";
  /** Open questions, oldest first. */
  holds: Hold[];
  /** The configuration frozen at admission (or by a `switch` or `adopt` answer): its provider, what chose it, and its digest. */
  frozen?: Pick<Frozen, "provider" | "selectedBy" | "digest">;
  waiting: {
    step: string;
    nextAt: string;
    lastError: string;
    since: string;
    /** A person outside Factory the step waits on, such as an environment approval. */
    gate?: string;
  }[];
  /** Waiting for a slot, or for an earlier Objective that owns overlapping paths. */
  waitsOn: { slot: true } | { paths: number } | null;
  /** Steps started and not finished. */
  running: string[];
  /** Work Items whose validation failed once and passed on its one rerun. */
  flakyRerun: { item: string; command: string }[];
  /** A reset rebuilding the state from GitHub. */
  reset?: { requestedAt: string; hadState: boolean };
  /** What happens next, and the command that moves it, if one does. */
  nextAction: { command: string | null; reason: string };
  /** The latest run log event. */
  lastEvent: LogEvent | null;
  error?: string;
}

/** What `status` reads from the running service's `service.json`. */
interface ServiceView {
  crashLoop?: { crashes: number; resumeAt: string };
  problem?: string;
  waits: Record<string, { slot: true } | { paths: number }>;
}

async function status(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const only = args.positional[1] ? issueOf(args) : undefined;
  const live = await serviceLive(paths);
  const service: ServiceView = live ? serviceRecord(paths) : { waits: {} };
  const queue = loadQueueControl(paths.root);
  const rows: StatusRow[] = [];
  for (const issue of listAllObjectives(paths.objectives)) {
    if (only !== undefined && issue !== only) continue;
    let loaded: ReturnType<typeof findState>;
    try {
      loaded = findState(paths.objectives, issue);
    } catch (error) {
      process.stderr.write(`#${issue}: can't read its state now: ${error}\n`);
      continue;
    }
    if (!loaded) continue;
    const lastEvent = readLog(paths.logs, issue, 1).events[0] ?? null;
    if (loaded.kind === "unreadable") {
      rows.push({
        issue,
        status: "unreadable",
        mode: "running",
        holds: [
          {
            id: "unreadable",
            step: "state",
            question: `Factory can't read this Objective's state (${loaded.error}).`,
            answers: ["reset", "cancel"],
            recommended: "reset",
            askedAt: "",
          },
        ],
        waiting: [],
        waitsOn: null,
        running: [],
        flakyRerun: [],
        nextAction: {
          command: `factory reset ${issue}`,
          reason:
            "Its state can't be read: reset rebuilds it from GitHub (or cancel).",
        },
        lastEvent,
        error: loaded.error,
      });
      continue;
    }
    const { state } = loaded;
    const reset = state.kept?.[RESET] as ResetRecord | undefined;
    const row: StatusRow = {
      issue,
      status: state.status,
      mode: state.control?.mode ?? "running",
      holds: state.holds,
      ...(state.frozen
        ? {
            frozen: {
              provider: state.frozen.provider,
              selectedBy: state.frozen.selectedBy,
              digest: state.frozen.digest,
            },
          }
        : {}),
      waiting: Object.entries(state.retries).map(([step, retry]) => ({
        step,
        nextAt: retry.nextAt,
        lastError: retry.lastError,
        since: retry.since,
        ...(retry.wait?.kind === "gate" ? { gate: retry.wait.gate } : {}),
      })),
      waitsOn: service.waits[issue] ?? null,
      running: Object.keys(state.attempts),
      flakyRerun: flakyReruns(state),
      ...(reset && !TERMINAL.includes(state.status)
        ? {
            reset: {
              requestedAt: reset.requestedAt,
              hadState: reset.hadState,
            },
          }
        : {}),
      nextAction: { command: null, reason: "" },
      lastEvent,
    };
    row.nextAction = nextAction(row, queue, live);
    rows.push(row);
  }
  // Every string is redacted before it is formatted, so no escaped form
  // of a secret slips past.
  const shown = redactDeep(rows, configOf(repository)?.secrets ?? []);
  const { waits: _waits, ...record } = service;
  if (args.flags.json !== undefined) {
    process.stdout.write(
      `${JSON.stringify(
        {
          service: live ? "running" : "stopped",
          ...record,
          queue,
          objectives: shown,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines = [`Service: ${live ? "running" : "stopped"}`];
  if (record.problem)
    lines.push(`  Problem: ${record.problem}. GitHub effects are paused.`);
  const loop = record.crashLoop;
  if (loop)
    lines.push(
      `  Crash loop: the service restarted after ${loop.crashes} deaths in a row; interrupted steps ${Date.parse(loop.resumeAt) > Date.now() ? "resume" : "resumed"} at ${displayTime(loop.resumeAt)}.`,
    );
  if (queue.mode !== "running")
    lines.push(
      `Queue: ${queue.mode}${queue.at ? ` since ${displayTime(queue.at)}` : ""}${queue.by ? ` (by ${queue.by})` : ""}; factory queue resume undoes it`,
    );
  if (shown.length === 0) lines.push("No Objectives.");
  for (const row of shown) {
    lines.push(
      `#${row.issue}: ${row.status}${row.mode !== "running" ? ` (${row.mode})` : ""}`,
    );
    if (row.frozen)
      lines.push(
        `  Provider: ${row.frozen.provider} (selectedBy: ${row.frozen.selectedBy}); configuration ${row.frozen.digest.slice(0, 12)}`,
      );
    for (const hold of row.holds)
      lines.push(
        `  Question ${hold.id}${hold.item ? ` (Work Item ${hold.item})` : ""}: ${hold.question}`,
        `  Answers: ${hold.answers.join(", ")} (recommended: ${hold.recommended})`,
        `  Answer with: factory answer ${row.issue} <answer> --question ${hold.id}`,
      );
    if (row.reset)
      lines.push(
        `  Resetting since ${displayTime(row.reset.requestedAt)}: rebuilding the state from GitHub`,
      );
    for (const step of row.running) lines.push(`  Running: ${step}`);
    for (const wait of row.waiting)
      lines.push(
        wait.gate
          ? `  Waiting on ${wait.gate} (${wait.step}, since ${displayTime(wait.since)})`
          : `  Waiting: ${wait.step} retries at ${displayTime(wait.nextAt)} (${wait.lastError})`,
      );
    if (row.waitsOn)
      lines.push(
        "slot" in row.waitsOn
          ? "  Waiting on a free slot (queue.maxActiveObjectives)"
          : `  Waiting on Objective #${row.waitsOn.paths} (overlapping owned paths)`,
      );
    for (const flaky of row.flakyRerun)
      lines.push(
        `  Possibly flaky: ${flaky.item}: \`${flaky.command}\` failed once; its rerun passed`,
      );
    if (row.lastEvent) lines.push(`  Last: ${eventLine(row.lastEvent)}`);
    lines.push(
      row.nextAction.command
        ? `  Next: ${row.nextAction.command}\n    ${row.nextAction.reason}`
        : `  Next: ${row.nextAction.reason}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** Validation reruns that passed: the rerun's tree is the validated tree. */
function flakyReruns(state: ObjectiveState): StatusRow["flakyRerun"] {
  const reruns: StatusRow["flakyRerun"] = [];
  for (const [key, value] of Object.entries(state.kept ?? {})) {
    const item = /^item:(.+):flaky$/.exec(key)?.[1];
    const rerun = value as { tree?: string; command?: string } | null;
    const validated = state.done[`item:${item}:validate`] as
      | { tree?: string }
      | undefined;
    if (item && rerun?.command && rerun.tree && validated?.tree === rerun.tree)
      reruns.push({ item, command: rerun.command });
  }
  return reruns;
}

/** The one thing that moves the Objective on, or what it waits for. */
function nextAction(
  row: StatusRow,
  queue: QueueControl,
  live: boolean,
): StatusRow["nextAction"] {
  const issue = row.issue;
  // The question that stops the most: the Objective's, else the oldest.
  const hold =
    row.holds.find((open) => open.item === undefined) ?? row.holds[0];
  if (hold)
    return {
      command: `factory answer ${issue} ${hold.recommended} --question ${hold.id}`,
      reason: `The recommended answer to ${hold.item ? `Work Item ${hold.item}'s` : "the"} question. Others: ${hold.answers.filter((a) => a !== hold.recommended).join(", ")}.`,
    };
  if (TERMINAL.includes(row.status as ObjectiveStatus))
    return row.running.length || row.waiting.length
      ? {
          command: null,
          reason: `It has ${row.status}; Factory is cleaning up.`,
        }
      : { command: null, reason: `It has ${row.status}.` };
  if (row.reset && !live)
    return {
      command: "factory serve",
      reason:
        "The reset waits for the service (start it with its systemd unit).",
    };
  if (row.reset)
    return {
      command: null,
      reason: "Factory is rebuilding its state from GitHub.",
    };
  if (row.mode !== "running")
    return {
      command: `factory resume ${issue}`,
      reason: `The operator ${row.mode === "paused" ? "paused it: no step starts" : "drained it: no new Work Item starts"} until resume.`,
    };
  if (queue.mode === "paused")
    return {
      command: "factory queue resume",
      reason: "The queue is paused: no step starts until resume.",
    };
  if (!live)
    return {
      command: "factory serve",
      reason: "The service isn't running (start it with its systemd unit).",
    };
  const gate = row.waiting.find((wait) => wait.gate);
  if (gate)
    return {
      command: null,
      reason: `Waiting on ${gate.gate}; Factory carries on by itself once that is done.`,
    };
  if (row.running.length)
    return { command: null, reason: `Running ${row.running.join(", ")}.` };
  if (row.waiting.length) {
    const first = [...row.waiting].sort((a, b) =>
      a.nextAt.localeCompare(b.nextAt),
    )[0]!;
    return {
      command: `factory retry ${issue}`,
      reason: `${first.step} retries by itself at ${displayTime(first.nextAt)}; retry runs it now.`,
    };
  }
  if (row.waitsOn)
    return {
      command: null,
      reason:
        "slot" in row.waitsOn
          ? "Waiting on a free slot."
          : `Waiting on Objective #${row.waitsOn.paths}, which owns overlapping paths.`,
    };
  return {
    command: null,
    reason: `The next ${row.status} step starts shortly.`,
  };
}

/**
 * The running service's record, from `service.json`: its crash loop (the
 * deaths in a row before this start, and when it resumes interrupted
 * steps; shown until the run has lived 10 min past that time), a problem
 * that pauses its GitHub effects, and the Objectives waiting for a slot or
 * on another's paths.
 */
function serviceRecord(paths: Paths): ServiceView {
  try {
    const record = JSON.parse(
      readFileSync(join(paths.root, "service.json"), "utf8"),
    ) as {
      starts?: string[];
      resumeAt?: string;
      problem?: string;
      waits?: ServiceView["waits"];
    };
    return {
      ...(record.resumeAt &&
      Date.now() <= Date.parse(record.resumeAt) + 10 * 60 * 1000
        ? {
            crashLoop: {
              crashes: (record.starts?.length ?? 1) - 1,
              resumeAt: record.resumeAt,
            },
          }
        : {}),
      ...(typeof record.problem === "string"
        ? { problem: record.problem }
        : {}),
      waits: record.waits ?? {},
    };
  } catch {
    return { waits: {} };
  }
}

/**
 * `setup --provider NAME`: add a named provider to the configuration, or
 * change its planner or worker kind, and verify the result loads. The
 * first provider, or `--default`, becomes defaultProvider. Managed
 * workers need settings written by hand. An Objective holds while the
 * configuration differs from the one it froze; restart the service to use
 * the change, and answer adopt.
 */
function setup(repository: string, args: Args): number {
  const name = args.flags.provider;
  const path = configPath(repository);
  if (!name) throw usage("setup needs --provider NAME");
  let raw: Record<string, unknown>;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Refusal(
      "no_configuration",
      `can't read ${path}: ${String(error)}`,
    );
  }
  const planner = args.flags.planner;
  const worker = args.flags.worker;
  if (planner && !(PLANNERS as readonly string[]).includes(planner))
    throw usage(`--planner is one of ${PLANNERS.join(", ")}`);
  if (worker && !SETUP_WORKERS.includes(worker))
    throw usage(
      (WORKERS as readonly string[]).includes(worker)
        ? `a ${worker} worker needs settings setup doesn't take: write providers.${name}.worker = { "kind": "${worker}", ${MANAGED_FIELDS[worker]} } in ${path} by hand`
        : `--worker is one of ${SETUP_WORKERS.join(", ")}`,
    );
  // Without providers the configuration has one: codex, the default.
  const providers = (raw.providers ?? {
    codex: { planner: "codex", worker: { kind: "codex" } },
  }) as Record<string, Record<string, unknown>>;
  // Keep the effective default (the first provider) unless --default moves it.
  raw.defaultProvider ??= Object.keys(providers)[0] ?? name;
  const existing = providers[name];
  const kind = planner ?? (existing?.planner as string | undefined) ?? "codex";
  const current = existing?.worker as Record<string, unknown> | undefined;
  // Model choices belong to one planner kind.
  const { models, ...kept } = existing ?? {};
  providers[name] = {
    ...kept,
    ...(models && kind === existing?.planner ? { models } : {}),
    planner: kind,
    worker:
      worker && worker !== current?.kind
        ? { kind: worker }
        : (current ?? { kind: worker ?? kind }),
  };
  raw.providers = providers;
  if (args.flags.default !== undefined) raw.defaultProvider = name;
  const save = (body: string) => {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, path);
  };
  save(`${JSON.stringify(raw, null, 2)}\n`);
  try {
    loadConfig(repository);
  } catch (error) {
    save(text);
    process.stderr.write(
      `factory: the provider was not saved: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const summary = {
    provider: name,
    planner: kind,
    worker: (providers[name]!.worker as { kind: string }).kind,
    defaultProvider: raw.defaultProvider,
  };
  process.stdout.write(
    args.flags.json !== undefined
      ? `${JSON.stringify(summary)}\n`
      : `Provider ${name}: ${summary.planner} plans, ${summary.worker} works; default is ${summary.defaultProvider}. Restart the service to use it.\n`,
  );
  return 0;
}

function eventLine(event: LogEvent): string {
  const { at, step, event: kind, ...rest } = event;
  const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${displayTime(at)}${step ? ` ${step}` : ""} ${kind ?? ""}${detail}`;
}

/** `factory log ISSUE [--tail N] [--follow] [--json]`. */
async function logCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const tail = args.flags.tail === undefined ? 50 : Number(args.flags.tail);
  if (!Number.isInteger(tail) || tail < 0)
    throw usage("--tail takes a whole number of events, such as --tail 100");
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
  const action = args.positional[1];
  if (args.positional.length > 2)
    throw usage(`queue ${action} takes no issue numbers`);
  const modes: Record<string, QueueMode> = {
    pause: "paused",
    drain: "draining",
    resume: "running",
  };
  if (action && modes[action]) {
    if (args.flags.json !== undefined)
      throw usage(
        `--json belongs to factory queue list; use factory queue ${action}`,
      );
    return await request(paths, {
      kind: "queue",
      issue: 0,
      mode: modes[action],
    });
  }
  if (action !== "list")
    throw usage(
      `Unknown queue action ${action ?? "(none)"}; use factory queue list, pause, resume or drain`,
    );
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
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return 0;
  }
  const file = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return 0;
    }
    if (existsSync(file)) {
      const result = JSON.parse(readFileSync(file, "utf8")) as RequestResult;
      rmSync(file, { force: true });
      if (result.code) throw new Refusal(result.code, result.message);
      // Anything but "ok" is a refusal, even one that names no code.
      if (result.message !== "ok") {
        process.stderr.write(`factory: ${result.message}\n`);
        return 1;
      }
      process.stdout.write("Done.\n");
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write(
    body.kind === "reset"
      ? `The reset is running; factory status ${body.issue} shows it.\n`
      : "Sent; the service hasn't applied it yet.\n",
  );
  return 0;
}

/**
 * `recipe --file OBJECTIVE`: resolve and check the Objective's Workflow
 * recipe at the checkout's HEAD, as planning would, and print the preview.
 * No model call, no request, no state. Exit 1 when it can't be used.
 */
async function recipe(repository: string, args: Args): Promise<number> {
  const file = args.flags.file;
  if (!file || !isAbsolute(file))
    throw usage("recipe needs --file ABSOLUTE_OBJECTIVE");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile())
    throw usage(`recipe --file ${file} isn't a regular file`);
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
async function serviceLive(paths: Paths): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(paths.lockName);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function issueOf(args: Args): number {
  const command = args.positional[0];
  const issue = Number(args.positional[1]);
  if (!Number.isInteger(issue) || issue <= 0)
    throw usage(
      `${command} needs an issue number: factory ${command} ${COMMANDS[command!]?.args}`,
    );
  return issue;
}

/**
 * The command line, checked where it enters: an unknown command, an option
 * the command doesn't take, a missing value or an extra argument is
 * refused with how to write it.
 */
function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  if (argv.includes("--help") || argv.includes("-h"))
    return { positional: ["help"], flags };
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
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const takesValue = name === "repo" ? true : spec?.flags[name];
    if (takesValue === undefined) throw usage(misplaced(name, command));
    if (!takesValue) {
      flags[name] = "";
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw usage(
        `--${name} needs a value: factory ${command ?? "<command>"} --${name} ${name.toUpperCase()}`,
      );
    flags[name] = value;
    i++;
  }
  const most = command
    ? 1 + (spec?.args.split(" ").filter(Boolean).length ?? 0)
    : 0;
  if (command && positional.length > most)
    throw usage(
      `factory ${command} takes ${spec?.args || "no arguments"}; unexpected ${positional.slice(most).join(" ")}`,
    );
  return { positional, flags };
}

/** Whether any command's option `name` takes a value (`--repo` does everywhere). */
function takesValueAnywhere(name: string): boolean {
  return (
    name === "repo" ||
    Object.values(COMMANDS).some((spec) => spec.flags[name] === true)
  );
}

/** The fix for an option this command doesn't take. */
function misplaced(name: string, command: string | undefined): string {
  if (name === "objective" && command)
    return `factory ${command} takes the issue as an argument, not --objective; use factory ${command} ${COMMANDS[command]?.args || "N"}`;
  const owners = Object.entries(COMMANDS)
    .filter(([, spec]) => name in spec.flags)
    .map(([owner]) => owner);
  if (owners.length)
    return `--${name} belongs to factory ${owners.join(", ")}; use factory ${owners[0]} ${COMMANDS[owners[0]!]!.args} --${name}${COMMANDS[owners[0]!]!.flags[name] ? ` ${name.toUpperCase()}` : ""}`.replace(
      /\s+/g,
      " ",
    );
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
