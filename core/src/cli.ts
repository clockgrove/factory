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
import { DEFAULT_LIMITS, hostLimits } from "./engine.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import { dreamCommand, runDream } from "./knowledge/dream.js";
import { observeState } from "./knowledge/index.js";
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
  type Hold,
  listObjectives,
  loadState,
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
  answer ISSUE ANSWER [--text T] Answer an Objective's open question
  cancel ISSUE                   Cancel an Objective
  retry ISSUE                    Retry an Objective's waiting steps now
  dream [--preview] [--budget-bytes N] [--input-budget-bytes N]
                                 Propose a playbook from settled episodes
  dream --record --objective N   Record a settled Objective's episode
  dream --file PATH --approve|--reject SHA256
                                 Decide a reviewed draft's exact bytes
  dream --show                   Show the approved playbook and pending drafts
`;

interface StatusRow {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  hold: Hold | null;
  provider?: FrozenProvider;
  waiting: { step: string; nextAt: string; lastError: string }[];
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
        const github = new GitHub(config.repository).redacting(
          config.policy.allowedSecretNames.flatMap(
            (name) => process.env[name] ?? [],
          ),
        );
        sync = new GitHubSync(github, config, new RunLog(paths.logs, "sync"));
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
        });
      return await serve({
        paths,
        workflow,
        ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
        ...(sync ? { sync } : {}),
        ...(provider ? { provider } : {}),
        ...(loaded ? { observe: observeState } : {}),
        ...(process.env.FACTORY_TICK_MS
          ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
          : {}),
        limits: {
          ...DEFAULT_LIMITS,
          ...(loaded
            ? {
                concurrency: loaded.execution.concurrency,
                maxRepairs: loaded.execution.repairs,
              }
            : {}),
          ...(process.env.FACTORY_BACKOFF_MS
            ? { baseBackoffMs: Number(process.env.FACTORY_BACKOFF_MS) }
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
      const log = new RunLog(paths.logs, "dream");
      try {
        return await runDream(parsed, {
          settings: knowledge(config, paths),
          planner: () => planner(config),
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
    allowedSecretNames: config.policy.allowedSecretNames,
  });
}

/** An Objective's state once it is terminal with nothing left to run, or why not. */
function settledState(paths: Paths, issue: number): ObjectiveState | string {
  const loaded = loadState(paths.objectives, issue);
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

async function status(paths: Paths, args: Args): Promise<number> {
  const only = args.positional[1] ? Number(args.positional[1]) : undefined;
  const rows: StatusRow[] = [];
  for (const issue of listObjectives(paths.objectives)) {
    if (only !== undefined && issue !== only) continue;
    const loaded = loadState(paths.objectives, issue);
    if (!loaded) continue;
    if (loaded.kind === "unreadable") {
      rows.push({
        issue,
        status: "unreadable",
        hold: {
          id: "unreadable",
          step: "state",
          question: `Factory can't read this Objective's state (${loaded.error}).`,
          answers: ["cancel"],
          recommended: "cancel",
          askedAt: "",
        },
        waiting: [],
        error: loaded.error,
      });
      continue;
    }
    const { state } = loaded;
    rows.push({
      issue,
      status: state.status,
      hold: state.hold,
      ...(state.provider ? { provider: state.provider } : {}),
      waiting: Object.entries(state.retries).map(([step, retry]) => ({
        step,
        nextAt: retry.nextAt,
        lastError: retry.lastError,
      })),
    });
  }
  const live = await serviceLive(paths);
  if (args.flags.json !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ service: live ? "running" : "stopped", objectives: rows }, null, 2)}\n`,
    );
    return 0;
  }
  const lines = [`Service: ${live ? "running" : "stopped"}`];
  if (rows.length === 0) lines.push("No Objectives.");
  for (const row of rows) {
    lines.push(`#${row.issue}: ${row.status}`);
    if (row.provider)
      lines.push(
        `  Provider: ${row.provider.name} (selectedBy: ${row.provider.selectedBy})`,
      );
    if (row.hold)
      lines.push(
        `  Question: ${row.hold.question}`,
        `  Answers: ${row.hold.answers.join(", ")} (recommended: ${row.hold.recommended})`,
        `  Answer with: factory answer ${row.issue} <answer>`,
      );
    for (const wait of row.waiting)
      lines.push(
        `  Waiting: ${wait.step} retries at ${wait.nextAt} (${wait.lastError})`,
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
    body = {
      kind: "answer",
      issue,
      answer,
      ...(args.flags.text ? { text: args.flags.text } : {}),
    };
  } else body = { kind: command, issue };
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
