/**
 * Serving an installation and following a run (`factory serve`,
 * `factory run`). The service is the only writer of Factory state:
 * following a run only writes a request and reads.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostCapacity } from "./capacity.js";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { eventLine, redactDeep } from "./display.js";
import { DEFAULT_LIMITS, type EngineLimits, hostLimits } from "./engine.js";
import { GitRefusal } from "./git.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import {
  type Holder,
  type HolderRecord,
  HolderRefusal,
  holderChanged,
  holderText,
  projectHolder,
  releaseHolder,
  takeHolder,
} from "./holder.js";
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
import { projectRepositories } from "./queue.js";
import {
  type RefusalCode,
  type RequestResult,
  writeRequest,
} from "./requests.js";
import { resettable } from "./reset.js";
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
    planningContext: config.planning.context,
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
 * Serve the installation in this process until SIGTERM or SIGINT:
 * `factory serve`. New Objectives freeze `provider`, else
 * defaultProvider. A configuration that doesn't load throws
 * ConfigurationError before anything runs; a second service is refused
 * by the installation lock.
 */
export async function serveInstallation(
  repository: string,
  paths: Paths,
  options: {
    provider?: string;
    drainMs: number;
    /** Take the repository from the installation that holds it (holder.ts). */
    takeOver?: boolean;
  },
): Promise<number> {
  const limits = envLimits();
  let sync: GitHubSync | undefined;
  let loaded: CoreConfig | undefined;
  let workflow = objectiveWorkflow();
  let frozen: Frozen | undefined;
  let freeze: ((provider: string) => Frozen | undefined) | undefined;
  let log: RunLog | undefined;
  let repositories: HolderContext["repositories"] | undefined;
  if (existsSync(configPath(repository))) {
    let config: CoreConfig;
    try {
      config = loadConfig(repository);
    } catch (error) {
      throw new ConfigurationError(errorMessage(error));
    }
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
    repositories = (signal) => projectRepositories(github, config, signal);
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
      github,
      config,
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
  const serveWith = (signal?: AbortSignal) =>
    serve({
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
      drainMs: options.drainMs,
      ...(signal ? { signal } : {}),
      limits: {
        ...limits,
        ...(loaded ? { concurrency: loaded.execution.concurrency } : {}),
      },
    });
  if (!loaded || !repositories) return await serveWith();
  const context: HolderContext = {
    checkout: loaded.checkout,
    repository: loaded.repository,
    root: paths.root,
    project: loaded.queue.projectId,
    repositories,
  };
  // One stop for this whole run: SIGTERM, SIGINT, or a take-over seen at a
  // check. The signal keeps it, so a stop is never lost between the wait
  // for the record and serve's own handlers.
  const stopping = new AbortController();
  const onSignal = (): void => stopping.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    let holder: Holder | undefined;
    try {
      holder = await holderFor(
        context,
        options.takeOver ?? false,
        stopping.signal,
      );
    } catch (error) {
      if (!(error instanceof Unconfirmed)) throw error;
      process.stderr.write(`factory: ${error.message}\n`);
      return UNCHECKED_EXIT;
    }
    if (!holder) return 0;
    if (holder.replaced)
      process.stderr.write(
        `factory: took ${loaded.repository} over from ${holderText(holder.replaced)}\n`,
      );
    return await serveHolding(context, holder, loaded, stopping, serveWith);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** The repository and its Project, as the start's holder checks need them (holder.ts). */
export interface HolderContext {
  checkout: string;
  repository: string;
  root: string;
  /** The Project's id, for messages. */
  project: string;
  /** The Project's other repositories (queue.ts projectRepositories). */
  repositories(signal: AbortSignal): Promise<string[]>;
}

/**
 * Serve while this installation holds the repository. Every queue poll
 * checks the record: another installation that took over stops this one
 * before its next effects. So does a record that can't be checked for
 * UNCHECKED_POLLS polls in a row: Git can fail while REST works, and a
 * take-over must not go unseen. That stop exits with a code systemd
 * restarts on, and the restart waits until it can confirm the record.
 */
async function serveHolding(
  context: { checkout: string; repository: string; root: string },
  holder: Holder,
  loaded: CoreConfig,
  stopping: AbortController,
  serveWith: (signal?: AbortSignal) => Promise<number>,
): Promise<number> {
  let stop: "lost" | "unchecked" | undefined;
  let taker: HolderRecord | undefined;
  let failures = 0;
  const end = (why: "lost" | "unchecked"): void => {
    if (stop) return;
    stop = why;
    stopping.abort();
  };
  const watch = setInterval(() => {
    holderChanged(context, holder).then(
      (changed) => {
        failures = 0;
        if (!changed) return;
        taker = changed.record;
        end("lost");
      },
      () => {
        if (++failures >= UNCHECKED_POLLS) end("unchecked");
      },
    );
  }, loaded.queue.pollSeconds * 1000);
  let code: number;
  try {
    code = await serveWith(stopping.signal);
  } finally {
    clearInterval(watch);
  }
  if (stop === "lost")
    throw new ConfigurationError(
      `Another installation took ${loaded.repository} over${taker ? `: ${holderText(taker)}` : ""}, so this one stopped. To serve from here again, stop that one, then start this one.`,
    );
  if (stop === "unchecked") {
    process.stderr.write(
      `factory: couldn't check which installation serves ${loaded.repository} for ${UNCHECKED_POLLS} queue polls in a row, so this one stopped; it keeps the repository, and starting it again resumes once Git reaches origin\n`,
    );
    return UNCHECKED_EXIT;
  }
  // A clean stop frees the repository; a service that didn't start (one
  // already ran here) leaves it to that service.
  if (code === 0)
    await releaseHolder(context, holder).catch((error: unknown) =>
      process.stderr.write(
        `factory: couldn't free ${loaded.repository} (${errorMessage(error)}); starting this installation again resumes it, and another one takes over with --take-over\n`,
      ),
    );
  return code;
}

/** Failed record checks in a row after which the service stops (holder.ts). */
const UNCHECKED_POLLS = 10;
/** Exit code for that stop: systemd restarts on it (EX_TEMPFAIL). */
const UNCHECKED_EXIT = 75;

/** How long a start waits for the Project's repositories before it starts unchecked. */
const PROJECT_START_MS = 5000;

/** Attempts to confirm the record at a start, about 4 minutes in all. */
const START_ATTEMPTS = 8;

/** The record couldn't be confirmed at a start: the service exits to be restarted. */
class Unconfirmed extends Error {}

/**
 * Take the repository for this installation (holder.ts) before anything
 * reaches GitHub: transient Git failures wait and retry (rule 5), at most
 * START_ATTEMPTS times, then throw Unconfirmed, so the process exits with
 * a code systemd restarts on rather than waiting unseen. `signal` stops
 * the wait (undefined). Another holder, a ruleset that refuses the record,
 * or an origin that doesn't name the repository is a ConfigurationError
 * that names the fix. So is another installation's record on another
 * repository of the Project (`projectCheck`), checked first.
 */
export async function holderFor(
  context: HolderContext,
  takeOver: boolean,
  signal: AbortSignal,
): Promise<Holder | undefined> {
  await projectCheck(context, signal);
  let last = "";
  for (
    let attempt = 1, wait = 2000;
    attempt <= START_ATTEMPTS && !signal.aborted;
    attempt++, wait = Math.min(wait * 2, 60_000)
  ) {
    try {
      const holder = await takeHolder(context, takeOver);
      // A stop that came during a slow Git call: the record is kept, and
      // starting again resumes it.
      return signal.aborted ? undefined : holder;
    } catch (error) {
      if (error instanceof HolderRefusal)
        throw new ConfigurationError(error.message);
      if (error instanceof GitRefusal)
        throw new ConfigurationError(
          `Can't check which installation serves ${context.repository}: ${error.message}`,
        );
      last = errorMessage(error).split("\n")[0] ?? "";
      if (attempt === START_ATTEMPTS) break;
      process.stderr.write(
        `factory: waiting to check which installation serves ${context.repository} (${last}); retrying in ${wait / 1000} s\n`,
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
  if (signal.aborted) return undefined;
  throw new Unconfirmed(
    `couldn't check which installation serves ${context.repository} after ${START_ATTEMPTS} tries (${last}); exiting so the service starts again`,
  );
}

/**
 * Refuse the start (ConfigurationError) while another installation serves
 * a repository on the Project. The Project is an input, never a
 * precondition: a read that fails or takes over PROJECT_START_MS, or a
 * repository whose record can't be read, is logged and the start goes on.
 */
async function projectCheck(
  context: HolderContext,
  signal: AbortSignal,
): Promise<void> {
  let found: Awaited<ReturnType<typeof projectHolder>>;
  try {
    found = await projectHolder(
      context,
      await context.repositories(
        AbortSignal.any([signal, AbortSignal.timeout(PROJECT_START_MS)]),
      ),
    );
  } catch (error) {
    found = { unread: [`the Project (${errorMessage(error).split("\n")[0]})`] };
  }
  const { holder, unread } = found;
  if (holder)
    throw new ConfigurationError(
      `Project ${context.project} is served by another installation, on ${holder.repository}: ${holderText(holder.record)}. Only one installation may serve a Project. Stop that one first. If it is stopped for good (its machine is gone, or its state was wiped), take ${holder.repository} over on a machine set up for it, factory serve --repo ${holder.repository} --take-over, then stop that cleanly, which frees it.`,
    );
  if (unread.length && !signal.aborted)
    process.stderr.write(
      `factory: couldn't check which installation serves Project ${context.project}: can't read ${unread.join(", ")}; starting anyway\n`,
    );
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
