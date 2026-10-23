#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { DEFAULT_LIMITS, type EngineLimits, hostLimits } from "./engine.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import { dreamCommand, runDream } from "./knowledge/dream.js";
import { knowledgeObserver } from "./knowledge/index.js";
import {
  configureKnowledge,
  type KnowledgeSettings,
  loadKnowledgeSettings,
} from "./knowledge/settings.js";
import { RunLog } from "./log.js";
import { installationPaths, type Paths } from "./paths.js";
import { PLANNERS, WORKERS } from "./providers/config.js";

import type { Planner } from "./providers/planner.js";
import {
  frozenSettings,
  type ProviderRoute,
  providerPlanner,
  providerWorker,
  providerWorkflow,
} from "./providers/selection.js";
import { type Request, writeRequest } from "./requests.js";
import { serve } from "./service.js";
import {
  type FrozenProvider,
  findState,
  type Hold,
  listAllObjectives,
  type ObjectiveState,
  type ObjectiveStatus,
  TERMINAL,
} from "./state.js";
import { errorMessage } from "./text.js";
import { objectiveWorkflow } from "./workflow.js";

/** Worker kinds setup can write: the managed ones need settings by hand. */
const SETUP_WORKERS = ["codex", "claude", "copilot"];

const USAGE = `Usage: factory <command> --repo OWNER/NAME

  serve [--provider NAME]        Run the service (the only writer of state);
                                 new Objectives use NAME, else defaultProvider
  setup --provider NAME [--planner codex|claude|copilot]
        [--worker codex|claude|copilot]
        [--default]              Add or change a named provider in the configuration
  status [ISSUE] [--json]        Show Objectives and open questions
  answer ISSUE ANSWER --question ID [--text T]
                                 Answer the open question ID (see status)
                                 (switch NAME: run it on another provider)
  cancel ISSUE                   Cancel an Objective
  retry ISSUE [--question ID]    Retry the waiting steps no open question stops
                                 now; with --question, answer retry to question ID
  dream [--preview] [--budget-bytes N] [--input-budget-bytes N] [--provider NAME]
                                 Propose a playbook from settled episodes
  dream --record --objective N   Record a settled Objective's episode
  dream --file PATH --approve|--reject SHA256
                                 Decide a reviewed draft's exact bytes
  dream --show                   Show the approved playbook and pending drafts
`;

interface StatusRow {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  /** Open questions, oldest first. */
  holds: Hold[];
  provider?: FrozenProvider;
  waiting: {
    step: string;
    nextAt: string;
    lastError: string;
    since: string;
    /** A person outside Factory the step waits on, such as an environment approval. */
    gate?: string;
  }[];
  error?: string;
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    process.stderr.write("factory: give --repo OWNER/NAME\n");
    return 2;
  }
  const paths = installationPaths(repository);
  switch (command) {
    case "serve": {
      const limits = envLimits();
      let sync: GitHubSync | undefined;
      let loaded: CoreConfig | undefined;
      let workflow = objectiveWorkflow();
      let provider: FrozenProvider | undefined;
      if (existsSync(configPath(repository))) {
        const config = loadConfig(repository);
        loaded = config;
        configureKnowledge(knowledge(config, paths));
        const name = args.flags.provider ?? config.defaultProvider;
        if (!config.providers[name]) {
          process.stderr.write(
            `factory: no provider ${JSON.stringify(name)}; the configuration names ${Object.keys(config.providers).join(", ")}\n`,
          );
          return 2;
        }
        provider = {
          name,
          selectedBy: args.flags.provider ? "--provider" : "defaultProvider",
          settings: frozenSettings(config.providers[name]!),
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
            settings,
            workflow: objectiveWorkflow({
              config,
              github,
              planner: planner(config, each),
              workDir: (issue) => join(paths.root, "work", String(issue)),
              worker: providerWorker(settings, config),
            }),
          });
        workflow = providerWorkflow(routes, routes.get(name)!.workflow);
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
        ...(sync ? { sync } : {}),
        ...(provider ? { provider } : {}),
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
    case "status":
      return await status(paths, args);
    case "setup":
      return setup(repository, args);
    case "answer":
    case "cancel":
    case "retry":
      return await request(paths, command, args);
    case "dream": {
      const parsed = dreamCommand(args.flags);
      if (typeof parsed === "string") {
        process.stderr.write(`factory: ${parsed}\n`);
        return 2;
      }
      const config = loadConfig(repository);
      const name = args.flags.provider ?? config.defaultProvider;
      if (!config.providers[name]) {
        process.stderr.write(
          `factory: no provider ${JSON.stringify(name)}; the configuration names ${Object.keys(config.providers).join(", ")}\n`,
        );
        return 2;
      }
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
    default:
      process.stderr.write(USAGE);
      return 2;
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
  return loadKnowledgeSettings({
    repository: config.repository,
    root: paths.root,
    checkout: config.checkout,
    secrets: config.secrets,
  });
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

async function status(paths: Paths, args: Args): Promise<number> {
  const only = args.positional[1] ? Number(args.positional[1]) : undefined;
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
    if (loaded.kind === "unreadable") {
      rows.push({
        issue,
        status: "unreadable",
        holds: [
          {
            id: "unreadable",
            step: "state",
            question: `Factory can't read this Objective's state (${loaded.error}).`,
            answers: ["cancel"],
            recommended: "cancel",
            askedAt: "",
          },
        ],
        waiting: [],
        error: loaded.error,
      });
      continue;
    }
    const { state } = loaded;
    rows.push({
      issue,
      status: state.status,
      holds: state.holds,
      ...(state.provider ? { provider: state.provider } : {}),
      waiting: Object.entries(state.retries).map(([step, retry]) => ({
        step,
        nextAt: retry.nextAt,
        lastError: retry.lastError,
        since: retry.since,
        ...(retry.wait?.kind === "gate" ? { gate: retry.wait.gate } : {}),
      })),
    });
  }
  const live = await serviceLive(paths);
  const service = live ? serviceRecord(paths) : {};
  const loop = service.crashLoop;
  if (args.flags.json !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ service: live ? "running" : "stopped", ...service, objectives: rows }, null, 2)}\n`,
    );
    return 0;
  }
  const lines = [`Service: ${live ? "running" : "stopped"}`];
  if (service.problem)
    lines.push(`  Problem: ${service.problem}. GitHub effects are paused.`);
  if (loop)
    lines.push(
      `  Crash loop: the service restarted after ${loop.crashes} deaths in a row; interrupted steps ${Date.parse(loop.resumeAt) > Date.now() ? "resume" : "resumed"} at ${loop.resumeAt}.`,
    );
  if (rows.length === 0) lines.push("No Objectives.");
  for (const row of rows) {
    lines.push(`#${row.issue}: ${row.status}`);
    if (row.provider)
      lines.push(
        `  Provider: ${row.provider.name} (selectedBy: ${row.provider.selectedBy})`,
      );
    for (const hold of row.holds)
      lines.push(
        `  Question ${hold.id}${hold.item ? ` (Work Item ${hold.item})` : ""}: ${hold.question}`,
        `  Answers: ${hold.answers.join(", ")} (recommended: ${hold.recommended})`,
        `  Answer with: factory answer ${row.issue} <answer> --question ${hold.id}`,
      );
    for (const wait of row.waiting)
      lines.push(
        wait.gate
          ? `  Waiting on ${wait.gate} (${wait.step}, since ${wait.since})`
          : `  Waiting: ${wait.step} retries at ${wait.nextAt} (${wait.lastError})`,
      );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * `setup --provider NAME`: add a named provider to the configuration, or
 * change its planner or worker kind, and verify the result loads. The
 * first provider, or `--default`, becomes defaultProvider. Managed
 * workers need settings written by hand. An Objective that started on a
 * provider holds while that provider's settings differ from the ones it
 * froze; restart the service to use the change.
 */
function setup(repository: string, args: Args): number {
  const name = args.flags.provider;
  const path = configPath(repository);
  if (!name) {
    process.stderr.write("factory: setup needs --provider NAME\n");
    return 2;
  }
  let raw: Record<string, unknown>;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    process.stderr.write(`factory: can't read ${path}: ${String(error)}\n`);
    return 2;
  }
  const planner = args.flags.planner;
  const worker = args.flags.worker;
  if (planner && !(PLANNERS as readonly string[]).includes(planner)) {
    process.stderr.write(
      `factory: --planner is one of ${PLANNERS.join(", ")}\n`,
    );
    return 2;
  }
  if (worker && !SETUP_WORKERS.includes(worker)) {
    process.stderr.write(
      (WORKERS as readonly string[]).includes(worker)
        ? `factory: a ${worker} worker needs settings setup doesn't take (account, model, key variable, limits): write providers.${name}.worker in ${path} by hand, as the user guide's managed execution section shows\n`
        : `factory: --worker is one of ${SETUP_WORKERS.join(", ")}\n`,
    );
    return 2;
  }
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

async function request(
  paths: Paths,
  command: "answer" | "cancel" | "retry",
  args: Args,
): Promise<number> {
  const issue = Number(args.positional[1]);
  if (!Number.isInteger(issue) || issue <= 0) {
    process.stderr.write(`factory: ${command} needs an issue number\n`);
    return 2;
  }
  let body: Request;
  if (command === "answer") {
    const answer = args.positional[2];
    if (!answer) {
      process.stderr.write("factory: answer needs an answer\n");
      return 2;
    }
    // Bound to the question the operator read, so a delayed answer never
    // lands on a newer one. Cancel needs no question.
    const question = args.flags.question;
    if (answer !== "cancel" && !question) {
      process.stderr.write(
        "factory: answer needs --question ID, the open question's id from `factory status`\n",
      );
      return 2;
    }
    // `answer ISSUE switch NAME` names the provider, as `--text NAME` does.
    const text = args.flags.text ?? args.positional[3];
    body = {
      kind: "answer",
      issue,
      answer,
      ...(text ? { text } : {}),
      ...(question ? { question } : {}),
    };
  } else if (command === "retry")
    body = {
      kind: "retry",
      issue,
      ...(args.flags.question ? { question: args.flags.question } : {}),
    };
  else body = { kind: command, issue };
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return 0;
  }
  const result = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return 0;
    }
    if (existsSync(result)) {
      const message = readFileSync(result, "utf8").trim();
      rmSync(result, { force: true });
      process.stdout.write(`${message === "ok" ? "Done." : message}\n`);
      return message === "ok" ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write("Sent; the service hasn't applied it yet.\n");
  return 0;
}

/**
 * The running service's record, from `service.json`: its crash loop (the
 * deaths in a row before this start, and when it resumes interrupted
 * steps; shown until the run has lived 10 min past that time), and a
 * problem that pauses its GitHub effects.
 */
function serviceRecord(paths: Paths): {
  crashLoop?: { crashes: number; resumeAt: string };
  problem?: string;
} {
  try {
    const record = JSON.parse(
      readFileSync(join(paths.root, "service.json"), "utf8"),
    ) as { starts?: string[]; resumeAt?: string; problem?: string };
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
    };
  } catch {
    return {};
  }
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

/** Flags that take no value. */
const SWITCHES = ["json", "default", "record", "preview", "show"];

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (SWITCHES.includes(name)) flags[name] = "";
    else if (next !== undefined) {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `factory: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  },
);
