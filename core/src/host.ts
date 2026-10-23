/**
 * Serving an installation and following a run, shared by the CLI
 * (`factory serve`, `factory run`) and the library (library.ts
 * serveFactory, runFactory). The service is the only writer of Factory
 * state: following a run only writes a request and reads.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostCapacity } from "./capacity.js";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { eventLine, redactDeep } from "./display.js";
import { DEFAULT_LIMITS, type EngineLimits, hostLimits } from "./engine.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import { unregisteredKinds } from "./kinds.js";
import { applyDream } from "./knowledge/dream.js";
import { knowledgeObserver } from "./knowledge/index.js";
import {
  configureKnowledge,
  type KnowledgeSettings,
} from "./knowledge/settings.js";
import { lockHeld } from "./lock.js";
import { newRunId, RunLog, readLog, readNew, untilInterrupted } from "./log.js";
import type { Paths } from "./paths.js";
import {
  freezeConfig,
  type ProviderRoute,
  providerPlanner,
  providerWorker,
  providerWorkflow,
} from "./providers/selection.js";
import {
  type RefusalCode,
  type RequestResult,
  writeRequest,
} from "./requests.js";
import { rebuildStep, resettable } from "./reset.js";
import { serve } from "./service.js";
import { type Frozen, type ObjectiveState, TERMINAL } from "./state.js";
import { readStatus, type StatusView, statusText } from "./status.js";
import { errorMessage } from "./text.js";
import { objectiveWorkflow } from "./workflow.js";

/** A refusal with its stable code (requests.ts RefusalCode). */
export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** A configuration the service can't run on: a restart can't fix it. */
export class ConfigurationError extends Error {}

/** Whether a service holds the installation's lock. */
export const serviceLive = (paths: Paths): Promise<boolean> =>
  lockHeld(paths.lockName);

/** The configuration, if this repository has one that loads. */
export function configOf(repository: string): CoreConfig | undefined {
  if (!existsSync(configPath(repository))) return undefined;
  try {
    return loadConfig(repository);
  } catch {
    return undefined;
  }
}

/** `name`, else defaultProvider; one the configuration lacks is refused. */
export function providerNamed(config: CoreConfig, name?: string): string {
  const chosen = name ?? config.defaultProvider;
  if (!config.providers[chosen])
    throw new Refusal(
      "usage",
      `no provider ${JSON.stringify(chosen)}; the configuration names ${Object.keys(config.providers).join(", ")}`,
    );
  return chosen;
}

export function knowledge(config: CoreConfig, paths: Paths): KnowledgeSettings {
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

/**
 * Serve the installation in this process until SIGTERM, SIGINT or
 * `signal`: `factory serve`. New Objectives freeze `provider`, else
 * defaultProvider. A configuration that doesn't load, or names a host
 * kind this process hasn't registered (kinds.ts), throws
 * ConfigurationError before anything runs; a second service is refused
 * by the installation lock.
 */
export async function serveInstallation(
  repository: string,
  paths: Paths,
  options: { provider?: string; signal?: AbortSignal; drainMs?: number } = {},
): Promise<number> {
  const limits = envLimits();
  let sync: GitHubSync | undefined;
  let loaded: CoreConfig | undefined;
  let workflow = objectiveWorkflow();
  let frozen: Frozen | undefined;
  let freeze: ((provider: string) => Frozen | undefined) | undefined;
  let log: RunLog | undefined;
  if (existsSync(configPath(repository))) {
    let config: CoreConfig;
    try {
      config = loadConfig(repository);
    } catch (error) {
      throw new ConfigurationError(errorMessage(error));
    }
    const missing = unregisteredKinds(config.providers);
    if (missing.length)
      throw new ConfigurationError(
        `This process hasn't registered ${missing.join(", ")}: serve the installation from the host program that registers ${missing.length === 1 ? "it" : "them"} (serveFactory).`,
      );
    loaded = config;
    configureKnowledge(knowledge(config, paths));
    const name = providerNamed(config, options.provider);
    frozen = {
      ...freezeConfig(config, name)!,
      provider: name,
      selectedBy: options.provider ? "--provider" : "defaultProvider",
    };
    const github = new GitHub(
      config.repository,
      process.env.FACTORY_GITHUB_API,
    ).redacting(config.secrets);
    // One log per service run: the sync's events go to the run's files too.
    log = new RunLog(paths.logs, newRunId(), config.capture, config.secrets);
    sync = new GitHubSync(github, config, log, limits);
    const routes = new Map<string, ProviderRoute>();
    for (const [each, settings] of Object.entries(config.providers))
      routes.set(each, {
        frozen: freezeConfig(config, each)!,
        workflow: objectiveWorkflow({
          config,
          github,
          planner: providerPlanner(settings),
          workDir: (issue) => join(paths.root, "work", String(issue)),
          objectives: paths.objectives,
          worker: providerWorker(settings, config),
        }),
      });
    workflow = resettable(
      providerWorkflow(routes, routes.get(name)!.workflow),
      rebuildStep(github, config),
    );
    freeze = (each) => {
      const route = routes.get(each);
      return route
        ? { ...route.frozen, provider: each, selectedBy: "--provider" }
        : undefined;
    };
  }
  if (loaded)
    hostLimits.configure(
      hostCapacity(loaded.execution, loaded.queue.maxActiveObjectives),
    );
  return await serve({
    paths,
    workflow,
    ...(loaded ? {} : { unconfigured: configPath(repository) }),
    ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
    ...(sync ? { sync, reset: true } : {}),
    ...(log ? { log } : {}),
    ...(frozen ? { frozen } : {}),
    ...(freeze ? { freeze } : {}),
    ...(loaded?.queue.objectiveDeadlineSeconds
      ? { deadlineSeconds: loaded.queue.objectiveDeadlineSeconds }
      : {}),
    ...(loaded ? { observer: knowledgeObserver, dream: applyDream } : {}),
    ...(process.env.FACTORY_TICK_MS
      ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.drainMs !== undefined ? { drainMs: options.drainMs } : {}),
    limits: {
      ...limits,
      ...(loaded ? { concurrency: loaded.execution.concurrency } : {}),
    },
  });
}

export interface FollowOptions {
  issue: number;
  provider?: string;
  /** An ISO time after now. */
  deadline?: string;
  /** Each new run log event, redacted. */
  event?(event: Record<string, unknown>): void;
  /** What `factory run` prints: the service's state, and the final status. */
  write?(text: string): void;
  /** Stops following only: the Objective keeps running. */
  signal?: AbortSignal;
}

/** How a followed run ended: 0 done, 1 cancelled, 2 needs a person (a question, or no service), 130 stopped following. */
export interface FollowResult {
  code: 0 | 1 | 2 | 130;
  /** The status when it ended; absent when the service isn't running or following stopped. */
  status?: StatusView;
}

/**
 * `factory run`: a request that queues the Objective (the service admits
 * it through the normal queue), then a follower of its new run log events
 * until it ends, needs a person, or following stops. A refusal throws
 * Refusal.
 */
export async function followRun(
  paths: Paths,
  repository: string,
  options: FollowOptions,
): Promise<FollowResult> {
  const { issue, provider, deadline } = options;
  const write = options.write ?? (() => undefined);
  const config = configOf(repository);
  if (provider !== undefined && config) providerNamed(config, provider);
  const secrets = config?.secrets ?? [];
  // Follow from here: only what happens from now on.
  const { ends } = readLog(paths.logs, issue, 0);
  const id = writeRequest(
    paths.requests,
    {
      kind: "run",
      issue,
      ...(provider !== undefined ? { provider } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
    },
    process.env.USER ?? "operator",
  );
  const stoppedService = (): FollowResult => {
    write(
      `The service isn't running; the request applies when it starts. Start it (factory serve, or its systemd unit), then factory run ${issue} follows it.\n`,
    );
    return { code: 2 };
  };
  if (!(await serviceLive(paths))) return stoppedService();
  const resultFile = join(paths.requests, `${id}.result`);
  let admitted = false;
  const result = await untilInterrupted(
    async (): Promise<FollowResult | undefined> => {
      for (const event of readNew(paths.logs, issue, ends)) {
        const shown = redactDeep(event, secrets);
        options.event?.(shown);
        write(`${eventLine(shown)}\n`);
      }
      const live = await serviceLive(paths);
      if (!admitted && existsSync(resultFile)) {
        const result = JSON.parse(
          readFileSync(resultFile, "utf8"),
        ) as RequestResult;
        rmSync(resultFile, { force: true });
        if (result.code) throw new Refusal(result.code, result.message);
        admitted = true;
      }
      if (!live) return stoppedService();
      // Before the admission, an earlier run's state is not this one's.
      if (!admitted) return undefined;
      const view = readStatus(paths, { only: issue, live, secrets });
      const row = view.objectives[0];
      if (!row) return undefined;
      const ended = TERMINAL.includes(row.status as ObjectiveState["status"]);
      if (!ended && row.status !== "unreadable" && !row.holds.length)
        return undefined;
      write(statusText(view, { list: false, all: false }));
      return { code: row.status === "done" ? 0 : ended ? 1 : 2, status: view };
    },
    options.signal,
    500,
    // Printed once Ctrl-C is caught: a script that interrupts on seeing it
    // gets the follower's 130, never Node's default exit.
    () =>
      write(
        `Queued #${issue}; following it (Ctrl-C stops following, and it keeps running).\n`,
      ),
  );
  if (result !== undefined) return result;
  write(
    `Stopped following #${issue}; it keeps running: factory status ${issue}, or factory run ${issue} to follow it again.\n`,
  );
  return { code: 130 };
}
