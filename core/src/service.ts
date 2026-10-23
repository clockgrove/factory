import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { crashPoint } from "./crash.js";
import {
  DEFAULT_LIMITS,
  type EngineLimits,
  ObjectiveRunner,
  type ServiceRun,
  type Workflow,
} from "./engine.js";
import type {
  GitHubModule,
  GitHubSync,
  UnreadableObjective,
} from "./github-sync.js";
import { takeServiceLock } from "./lock.js";
import { RunLog, rotateLogs } from "./log.js";
import type { Paths } from "./paths.js";
import { pathsOverlap } from "./planning/graph.js";
import { ACCEPTED_AT } from "./planning/steps.js";
import type { Plan } from "./planning/types.js";
import {
  pendingRequests,
  removeRequest,
  type StoredRequest,
} from "./requests.js";
import {
  type FrozenProvider,
  findState,
  finishState,
  listObjectives,
  newObjective,
  type ObjectiveState,
  removeState,
  runOf,
  saveState,
  TERMINAL,
} from "./state.js";
import { built, RERUN } from "./work/steps.js";
import { objectiveWorkflow } from "./workflow.js";

export interface ServeOptions {
  paths: Paths;
  workflow?: Workflow;
  limits?: EngineLimits;
  /** Objectives that may make progress at once (v1: 1). */
  maxActive?: number;
  tickMs?: number;
  /** GitHub queue, display and comments. Absent without configuration. */
  sync?: GitHubSync;
  /** The provider each newly admitted Objective freezes. */
  provider?: FrozenProvider;
  /** Reads Objectives as they move; never changes them (knowledge records memory here). */
  observer?: StateObserver;
}

/**
 * `observe` sees an Objective once each time its status (or settledness:
 * terminal with nothing left to run) changes, and once when the service
 * reads an active state file. It gets a copy and runs beside the loop,
 * aborted by `signal` past its deadline; a failure is retried with backoff
 * until it succeeds. `release` ends a run that a new admission of the same
 * issue replaces, or a withdrawal removes, before the new run starts.
 *
 * Knowledge is best effort for the lifecycle: a failed observation or
 * release never holds back admission, withdrawal or retirement. The run's
 * settled observation (which also releases it) is kept and retried in the
 * background, with backoff, until it lands: an episode may be recorded
 * late, but the queue never waits on it.
 */
export interface StateObserver {
  observe(
    state: ObjectiveState,
    settled: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  release(state: ObjectiveState): void;
}

interface Observation {
  mark?: string;
  busy: boolean;
  failures: number;
  nextAt: number;
}

const OBSERVE_BACKOFF_MS = 1000;
const OBSERVE_DEADLINE_MS = 5 * 60 * 1000;

/** Terminal with nothing left to run. */
const settled = (runner: ObjectiveRunner): boolean =>
  TERMINAL.includes(runner.state.status) && !runner.hasWork;

/** What the observer last saw: the status and whether it had settled. */
const observeMark = (runner: ObjectiveRunner): string =>
  `${runner.state.status}:${settled(runner)}`;
const OBSERVE_MAX_BACKOFF_MS = 5 * 60 * 1000;

const KEEP_REQUEST_IDS = 50;
const RESULT_TTL_MS = 60 * 60 * 1000;

/**
 * `factory serve`: the only writer of Factory state. It returns only when
 * stopped by a signal. It never exits on an Objective's error: every error
 * is a step outcome.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const { paths } = options;
  const workflow = options.workflow ?? objectiveWorkflow();
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxActive = options.maxActive ?? 1;
  const lock = await takeServiceLock(paths.lockName);
  if (!lock) {
    process.stderr.write("factory: the service is already running\n");
    return 3;
  }
  for (const dir of [paths.objectives, paths.requests, paths.logs])
    mkdirSync(dir, { recursive: true });
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const log = new RunLog(paths.logs, runId);
  const run: ServiceRun = { id: runId, finished: 0, resumeAt: 0 };
  // The last run's record, read before this run's first heartbeat replaces it.
  const previous = readServiceRecord(paths.root);
  // Unfinished Objectives, and finished ones until their cleanup, their
  // final sync and their settled observation are done; then their files
  // move to finished/, which startup never reads. A finished one is read
  // from disk again only when a request or the queue names it (rule 6:
  // cost follows active work, never history).
  const runners = new Map<number, ObjectiveRunner>();
  const unreadable = new Map<number, UnreadableObjective>();
  /** Per Objective: the mark last observed, an observation in flight, the failure backoff. */
  const observed = new Map<number, Observation>();
  /**
   * Settled observations of runs no longer in memory (retired, replaced or
   * withdrawn before the observer took them), by `<issue>@<run>`: retried
   * with backoff until they land.
   */
  const late = new Map<string, Observation & { state: ObjectiveState }>();
  const observeLate = (state: ObjectiveState): void => {
    if (!options.observer) return;
    late.set(`${state.issue}@${runOf(state)}`, {
      state: structuredClone(state),
      busy: false,
      failures: 0,
      nextAt: 0,
    });
  };
  /** Run an observer job unless one is in flight or backing off; log a failure and back off. */
  const attempt = (
    entry: Observation,
    issue: number,
    job: () => Promise<void>,
    done: () => void,
  ): void => {
    if (entry.busy || Date.now() < entry.nextAt) return;
    entry.busy = true;
    job()
      .then(
        () => {
          entry.failures = 0;
          done();
        },
        (error: unknown) => {
          entry.failures += 1;
          entry.nextAt =
            Date.now() +
            Math.min(
              OBSERVE_BACKOFF_MS * 2 ** (entry.failures - 1),
              OBSERVE_MAX_BACKOFF_MS,
            );
          log.write(issue, {
            event: "observe-failed",
            error: String(error),
            retryAt: new Date(entry.nextAt).toISOString(),
          });
        },
      )
      .finally(() => {
        entry.busy = false;
      });
  };
  /** Checked Objectives waiting for a slot, as of the last tick. */
  const waitingForSlot = new Set<number>();
  const open = (state: ObjectiveState): ObjectiveRunner => {
    const runner = new ObjectiveRunner(
      state,
      workflow,
      paths.objectives,
      log,
      run,
      limits,
    );
    runners.set(state.issue, runner);
    return runner;
  };
  /**
   * The Objective's run: in memory, else read from disk (which may find it
   * unreadable). A read that fails (EMFILE, EIO) throws; nothing is
   * decided on it, and the caller tries again later.
   */
  const find = (issue: number): ObjectiveRunner | undefined => {
    const known = runners.get(issue);
    if (known || unreadable.has(issue)) return known;
    const loaded = findState(paths.objectives, issue);
    if (loaded?.kind === "unreadable")
      unreadable.set(issue, {
        error: loaded.error,
        incident: loaded.incident,
      });
    return loaded?.kind === "ok" ? open(loaded.state) : undefined;
  };
  /** State files not read yet because the read failed: tried every tick. */
  const unloaded = new Set<number>();
  const load = (issue: number): void => {
    let runner: ObjectiveRunner | undefined;
    try {
      runner = find(issue);
    } catch (error) {
      if (!unloaded.has(issue))
        log.write(issue, { event: "load-failed", error: String(error) });
      unloaded.add(issue);
      return;
    }
    unloaded.delete(issue);
    // A finished one stays only until its cleanup and its final sync are
    // done, and, with an observer, until it is observed once: the service
    // may have died before its end was recorded, or before its file moved.
    if (
      runner &&
      settled(runner) &&
      (options.sync?.synced(runner.state) ?? true) &&
      !options.observer
    )
      retire(issue);
  };
  /**
   * A settled Objective leaves memory, and its file moves to finished/. Its
   * settled observation, if it hasn't landed, goes on in the background.
   */
  const retire = (issue: number): void => {
    const runner = runners.get(issue);
    try {
      finishState(paths.objectives, issue);
    } catch (error) {
      // It stays, and moves on a later tick.
      log.write(issue, { event: "finish-failed", error: String(error) });
      return;
    }
    if (runner && observed.get(issue)?.mark !== observeMark(runner))
      observeLate(runner.state);
    runners.delete(issue);
    options.sync?.forget(issue);
    observed.delete(issue);
  };
  /**
   * The observer ends a run that is replaced (a re-queue) or withdrawn,
   * before its state goes. One that fails is retried in the background,
   * never waited on.
   */
  const release = (state: ObjectiveState): void => {
    if (!options.observer) return;
    observed.delete(state.issue);
    try {
      options.observer.release(structuredClone(state));
    } catch (error) {
      log.write(state.issue, {
        event: "release-deferred",
        error: String(error),
      });
      observeLate(state);
    }
  };

  // Only the lock holder writes state, so leftover temporary files are from a crash.
  for (const name of readdirSync(paths.objectives))
    if (name.endsWith(".tmp"))
      rmSync(join(paths.objectives, name), { force: true });
  for (const issue of listObjectives(paths.objectives)) load(issue);
  const record = startRecord(previous, startedAt, runId, runners, limits);
  run.resumeAt = Date.parse(record.resumeAt ?? "") || 0;
  if (record.resumeAt)
    log.write(0, {
      event: "crash-loop",
      crashes: record.starts.length - 1,
      resumeAt: record.resumeAt,
    });
  const heartbeat = (stopped = false): void =>
    writeServiceRecord(paths.root, record, run, unreadable, stopped);
  // Saved before any hold below, so a crash in between never counts the
  // same death twice.
  heartbeat();
  const culprits = suspects(record.crashes);
  for (const culprit of culprits)
    try {
      runners
        .get(culprit.issue)
        ?.suspect(
          culprit.step,
          `The service died ${SUSPECT_CRASHES} times in a row while step ${culprit.step} ran, and other steps finished in between, so this step may be what stops it (for example, by running the host out of memory).${culprits.length > 1 ? ` ${culprits.length - 1} other step${culprits.length > 2 ? "s" : ""} ran at every one of those deaths too, and each holds with a question like this one.` : ""} \`retry\` runs it again; or cancel.`,
        );
    } catch (error) {
      log.write(culprit.issue, {
        event: "suspect-failed",
        error: String(error),
      });
    }
  if (culprits.length) {
    // The evidence is spent: the question is asked, or saved to ask as
    // soon as no open question stops the step (engine.ts `hold`); another
    // needs three new deaths.
    record.crashes = [];
    heartbeat();
  }
  crashPoint("serve:loaded");

  const applyRequests = (): void => {
    for (const { file, stored } of pendingRequests(paths.requests)) {
      if (!stored) {
        removeRequest(file);
        continue;
      }
      let message: string;
      try {
        message = applyRequest(stored);
      } catch (error) {
        // Not saved: the request file stays and is tried again next tick.
        log.write(stored.request.issue, {
          event: "request-failed",
          id: stored.id,
          error: String(error),
        });
        continue;
      }
      writeResult(paths.requests, stored.id, message);
      crashPoint("requests:applied");
      removeRequest(file);
    }
  };

  const applyRequest = (stored: StoredRequest): string => {
    const { request } = stored;
    const runner = find(request.issue);
    const broken = unreadable.get(request.issue);
    if (!runner && broken) {
      if (
        request.kind !== "cancel" &&
        !(request.kind === "answer" && request.answer === "cancel")
      )
        return `#${request.issue} has unreadable state (${broken.error}). Answers: cancel.`;
      // Start over from a fresh cancelled record that replaces the unreadable
      // file; cleanup closes the Objective's PRs and issue, and the sync
      // replies and shows it cancelled.
      const state = newObjective(request.issue, new Date());
      state.status = "cancelled";
      state.endedAt = state.updatedAt;
      state.appliedRequests = [{ id: stored.id, message: "ok" }];
      if (broken.github) state.modules.github = broken.github;
      saveState(paths.objectives, state);
      unreadable.delete(request.issue);
      open(state);
      return "ok";
    }
    if (!runner) return `Factory has no Objective #${request.issue}.`;
    const seen = runner.state.appliedRequests.find((r) => r.id === stored.id);
    if (seen) return seen.message;
    // The change and the record that it was applied are saved together.
    const message = runner.transact(() => {
      const state = runner.state;
      let result: string | null = null;
      switch (request.kind) {
        case "cancel":
          result = runner.cancel(stored.by);
          break;
        case "retry":
          result = runner.retryNow(stored.by, request.question);
          break;
        case "answer":
          result = runner.answer(
            request.answer,
            request.text,
            stored.by,
            request.writtenAt,
            request.question,
          );
          break;
      }
      const text = result ?? "ok";
      state.appliedRequests = [
        ...state.appliedRequests,
        { id: stored.id, message: text },
      ].slice(-KEEP_REQUEST_IDS);
      return text;
    });
    log.write(request.issue, {
      event: "request",
      request,
      by: stored.by,
      message,
    });
    return message;
  };

  /**
   * Dequeued before planning: the run goes as if never admitted, so
   * queuing it again checks it afresh. The observer ends it first.
   */
  const withdrawNow = (runner: ObjectiveRunner): void => {
    const issue = runner.state.issue;
    release(runner.state);
    removeState(paths.objectives, issue);
    crashPoint("serve:withdrawn");
    runner.stop();
    runners.delete(issue);
    options.sync?.forget(issue);
    log.write(issue, { event: "withdrawn" });
  };

  const tick = (): void => {
    for (const issue of [...unloaded]) load(issue);
    applyRequests();
    // Running steps keep their slot; then started Objectives; then queue order.
    const ordered = [...runners.values()].sort(
      (a, b) =>
        Number(b.busy) - Number(a.busy) ||
        Number(started(b)) - Number(started(a)) ||
        queueOrder(a) - queueOrder(b) ||
        a.state.issue - b.state.issue,
    );
    let slots = maxActive;
    waitingForSlot.clear();
    for (const runner of ordered) {
      const { state } = runner;
      // Dequeued while its check or a re-run's cleanup ran: once that is
      // done and nothing runs, it goes; nothing past them starts.
      if (
        state.withdrawing &&
        !TERMINAL.includes(state.status) &&
        !state.kept?.[RERUN]
      ) {
        if (!runner.busy)
          try {
            withdrawNow(runner);
          } catch (error) {
            log.write(state.issue, {
              event: "withdraw-failed",
              error: String(error),
            });
          }
        continue;
      }
      let run = false;
      if (TERMINAL.includes(state.status)) run = runner.hasWork;
      // The check (and a new run's cleanup) runs when the Objective is first
      // seen, slot or not (rule 7); planning and building need a slot.
      else if (!state.done.check) run = true;
      else if (runner.busy) {
        // Running steps keep their slot, even while another step's question is open.
        slots -= 1;
        run = true;
      } else if (runner.held)
        // Questions that stop every step it could start take no slot; a
        // step the service's death interrupted resumes.
        run = Object.keys(state.attempts).length > 0;
      // A wait on a human gate (an approval, a required review) has no
      // deadline, so it takes no slot: it polls, and its paths stay owned.
      else if (gated(runner, workflow)) run = true;
      // Waiting on another Objective's paths takes no slot either, so a hold
      // that owns common paths can't stall the queue (rule 1).
      else if (waitsOnPaths(runner, ordered)) run = false;
      else if (slots > 0) {
        slots -= 1;
        run = true;
      } else waitingForSlot.add(state.issue);
      if (!run) continue;
      try {
        runner.tick();
      } catch (error) {
        // A failed save: that Objective's state stays as on disk and is tried again next tick.
        log.write(state.issue, {
          event: "tick-failed",
          error: String(error),
        });
      }
    }
    const observer = options.observer;
    for (const runner of observer ? runners.values() : []) {
      const { state } = runner;
      const mark = observeMark(runner);
      const entry = observed.get(state.issue) ?? {
        busy: false,
        failures: 0,
        nextAt: 0,
      };
      observed.set(state.issue, entry);
      if (entry.mark === mark) continue;
      // The mark is kept only once the observation succeeded.
      const copy = structuredClone(state);
      const end = settled(runner);
      attempt(
        entry,
        state.issue,
        () =>
          observer!.observe(
            copy,
            end,
            AbortSignal.timeout(OBSERVE_DEADLINE_MS),
          ),
        () => {
          entry.mark = mark;
        },
      );
    }
    for (const [key, entry] of observer ? late : [])
      attempt(
        entry,
        entry.state.issue,
        () =>
          observer!.observe(
            entry.state,
            true,
            AbortSignal.timeout(OBSERVE_DEADLINE_MS),
          ),
        () => late.delete(key),
      );
    options.sync?.tick({
      runners,
      unreadable,
      requestsDir: paths.requests,
      waitingForSlot: (issue) => waitingForSlot.has(issue),
      find,
      admit: (issue: number, github: GitHubModule) => {
        const previous = find(issue);
        if (unreadable.has(issue)) return; // never over an unreadable file
        // Never over an unfinished run, nor one whose cleanup still runs.
        if (
          previous &&
          (!TERMINAL.includes(previous.state.status) || previous.hasWork)
        )
          return;
        // A run again after the operator queued a finished one. The observer
        // ends the old run first (its episode, its playbook pin), now or in
        // the background.
        if (previous) release(previous.state);
        // The old run stops for good (its steps, its saves, its sync jobs)
        // before the new one exists, so only one run ever writes the file.
        previous?.stop();
        options.sync?.forget(issue);
        const state = newObjective(issue, new Date(), options.provider);
        state.modules.github = github;
        // The earlier run's PRs and worktrees go before the new run plans.
        if (previous) state.kept[RERUN] = true;
        saveState(paths.objectives, state);
        crashPoint("serve:admitted");
        open(state);
        log.write(issue, {
          event: "admitted",
          again: Boolean(previous),
          ...(options.provider ? { provider: options.provider } : {}),
        });
      },
      withdraw: (issue: number) => {
        const runner = runners.get(issue);
        if (
          !runner ||
          TERMINAL.includes(runner.state.status) ||
          !unstarted(runner.state)
        )
          return false;
        // Its check or a re-run's cleanup still runs: it goes once that
        // ends, and nothing past them starts meanwhile (see tick).
        if (runner.busy || runner.state.kept?.[RERUN]) {
          if (!runner.state.withdrawing)
            runner.transact(() => {
              runner.state.withdrawing = true;
            });
          return "pending";
        }
        withdrawNow(runner);
        return "withdrawn";
      },
      result: (id: string) => readResult(paths.requests, id),
    });
    // A finished Objective leaves memory, and its file objectives/, once
    // its cleanup and its final sync are done, and no observation of it is
    // in flight (one that failed goes on in the background); a request or
    // a re-queue reads it again from finished/.
    for (const runner of [...runners.values()]) {
      const issue = runner.state.issue;
      if (
        settled(runner) &&
        (options.sync?.idle(issue) ?? true) &&
        !observed.get(issue)?.busy
      )
        retire(issue);
    }
    heartbeat();
  };

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // A stray rejection must not end the service: log it and keep serving.
  process.on("unhandledRejection", (reason) =>
    log.write(0, { event: "unhandled-rejection", error: String(reason) }),
  );
  const housekeeping = (): void => {
    try {
      rotateLogs(paths.logs);
      sweepResults(paths.requests);
    } catch (error) {
      log.write(0, { event: "housekeeping-failed", error: String(error) });
    }
  };
  housekeeping();
  let lastHousekeeping = Date.now();
  while (!stopping) {
    try {
      tick();
    } catch (error) {
      // A bug in the loop itself: log it and keep serving.
      log.write(0, { event: "loop-error", error: String(error) });
    }
    if (Date.now() - lastHousekeeping > RESULT_TTL_MS) {
      housekeeping();
      lastHousekeeping = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, options.tickMs ?? 1000));
  }
  // A clean stop (an upgrade, a reboot) ends any crash streak.
  heartbeat(true);
  lock.close();
  return 0;
}

/**
 * An Objective builds only while no earlier unfinished Objective owns an
 * overlapping path; planning never waits. Earlier means its plan was
 * accepted earlier: an Objective still planning owns nothing yet, and once
 * its plan lands it waits on every plan accepted before it, so two
 * Objectives never build overlapping paths at once.
 */
function waitsOnPaths(
  runner: ObjectiveRunner,
  all: readonly ObjectiveRunner[],
): boolean {
  const mine = ownedPaths(runner.state);
  if (!mine.length || built(runner.state)) return false;
  const at = acceptedAt(runner.state);
  return all.some((other) => {
    if (other === runner) return false;
    if (TERMINAL.includes(other.state.status) || built(other.state))
      return false;
    const theirs = ownedPaths(other.state);
    if (!theirs.length) return false;
    const when = acceptedAt(other.state);
    if (when > at || (when === at && other.state.issue > runner.state.issue))
      return false;
    return mine.some((a) => theirs.some((b) => pathsOverlap(a, b)));
  });
}

function ownedPaths(state: ObjectiveState): string[] {
  const plan = state.done.plan as Plan | undefined;
  return plan ? plan.items.flatMap((item) => item.ownedPaths) : [];
}

/** When the Objective's plan was accepted (planning/steps.ts keeps it). */
function acceptedAt(state: ObjectiveState): string {
  return (state.kept?.[ACCEPTED_AT] as string | undefined) ?? "";
}

/**
 * Whether every step left to run waits on a human gate or an open
 * question: nothing it can do until a person acts.
 */
function gated(runner: ObjectiveRunner, workflow: Workflow): boolean {
  const steps = workflow.steps(runner.state);
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        runner.state.retries[step.key]?.wait?.kind === "gate" ||
        runner.heldBy(step.key),
    )
  );
}

/** Not started: nothing past the check (and a re-run's cleanup) has run or begun. */
function unstarted(state: ObjectiveState): boolean {
  const early = (key: string) => key === "check" || key === "rerun:cleanup";
  return [
    ...Object.keys(state.done),
    ...Object.keys(state.retries),
    ...Object.keys(state.asking),
    ...Object.keys(state.attempts),
  ].every(early);
}

function started(runner: ObjectiveRunner): boolean {
  return (
    runner.busy || Object.keys(runner.state.done).some((key) => key !== "check")
  );
}

/** The Project's order number, read again on every queue read until it starts. */
function queueOrder(runner: ObjectiveRunner): number {
  return (
    (runner.state.modules.github as GitHubModule | undefined)?.order ??
    Number.MAX_SAFE_INTEGER
  );
}

function readResult(dir: string, id: string): string | undefined {
  try {
    return readFileSync(join(dir, `${id}.result`), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Write the result whole, and only once: a request re-read after a crash keeps its first result. */
function writeResult(dir: string, id: string, message: string): void {
  const temporary = join(dir, `.${id}.result.tmp`);
  try {
    writeFileSync(temporary, `${message}\n`);
    linkSync(temporary, join(dir, `${id}.result`));
  } catch {
    // Already written.
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sweepResults(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const name of names) {
    if (!name.endsWith(".result") && !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * `service.json`: the heartbeat `status` reads, and what the next start
 * needs to tell a crash from a clean stop.
 */
interface ServiceRecord {
  pid: number;
  runId: string;
  /** The last heartbeat: about when the run died, if it died. */
  at: string;
  startedAt: string;
  /**
   * The starts of this crash streak, oldest first: each start after the
   * first follows a run that died (no clean stop) within STREAK_MS of
   * resuming its interrupted steps.
   */
  starts: string[];
  /** When this run resumes interrupted steps; absent when it did at once. */
  resumeAt?: string;
  /** Step attempts that finished in this run. */
  finished: number;
  /** The latest deaths, oldest first: the steps running at each, and whether the run that died finished any step. */
  crashes: Crash[];
  /** Set by a clean stop. */
  stopped?: boolean;
  unreadable: Record<string, string>;
}

interface Crash {
  at: string;
  running: { issue: number; step: string }[];
  progressed: boolean;
}

/** A run that dies this soon after resuming continues a crash streak. */
const STREAK_MS = 10 * 60 * 1000;
/** Starts in a streak before interrupted steps are delayed: 30 s, doubling, up to MAX_RESUME_DELAY_MS. */
const LOOP_STARTS = 3;
const MAX_RESUME_DELAY_MS = 30 * 60 * 1000;
/** Deaths in a row with a step running at each before that step holds. */
const SUSPECT_CRASHES = 3;

function readServiceRecord(root: string): Partial<ServiceRecord> | undefined {
  try {
    return JSON.parse(readFileSync(join(root, "service.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * This run's record. A start after a run that didn't stop cleanly is a
 * crash restart: it records the steps that were running (the open attempts
 * that run started), and continues the crash streak if that run died within
 * STREAK_MS of resuming. From the third start in a streak, interrupted
 * steps resume after a delay: 30 s (the base backoff), doubling, up to
 * 30 min. A clean stop starts afresh.
 */
function startRecord(
  previous: Partial<ServiceRecord> | undefined,
  startedAt: Date,
  runId: string,
  runners: ReadonlyMap<number, ObjectiveRunner>,
  limits: EngineLimits,
): ServiceRecord {
  const now = startedAt.toISOString();
  const crashed = previous?.runId !== undefined && !previous.stopped;
  const lived =
    Date.parse(previous?.at ?? "") -
    Date.parse(previous?.resumeAt ?? previous?.startedAt ?? "");
  const starts = [
    ...(crashed && lived < STREAK_MS ? (previous.starts ?? []) : []),
    now,
  ].slice(-20);
  const crashes: Crash[] = crashed
    ? [
        ...(previous.crashes ?? []),
        {
          at: now,
          running: [...runners.values()].flatMap((runner) =>
            Object.entries(runner.state.attempts)
              .filter(([, attempt]) => attempt.run === previous.runId)
              .map(([step]) => ({ issue: runner.state.issue, step })),
          ),
          // The heartbeat's count can trail a death; the saved states can't.
          progressed:
            (previous.finished ?? 0) > 0 ||
            [...runners.values()].some(
              (runner) => runner.state.finishedRun === previous.runId,
            ),
        },
      ].slice(-SUSPECT_CRASHES)
    : [];
  const delay =
    starts.length >= LOOP_STARTS
      ? Math.min(
          limits.baseBackoffMs * 2 ** (starts.length - LOOP_STARTS),
          MAX_RESUME_DELAY_MS,
        )
      : 0;
  return {
    pid: process.pid,
    runId,
    at: now,
    startedAt: now,
    starts,
    ...(delay
      ? { resumeAt: new Date(startedAt.getTime() + delay).toISOString() }
      : {}),
    finished: 0,
    crashes,
    unreadable: {},
  };
}

/**
 * Every step running at each of the last SUSPECT_CRASHES deaths, when
 * other steps finished in the runs between them: the strongest sign the
 * saved state gives that one of them stops the service. Each holds, so a
 * crash streak ends in questions within SUSPECT_CRASHES deaths however
 * many steps keep being interrupted together.
 */
function suspects(crashes: Crash[]): Crash["running"] {
  if (crashes.length < SUSPECT_CRASHES) return [];
  const last = crashes.slice(-SUSPECT_CRASHES);
  if (!last.slice(1).every((crash) => crash.progressed)) return [];
  const id = (r: { issue: number; step: string }) => `${r.issue} ${r.step}`;
  return last[0]!.running.filter((r) =>
    last.every((crash) => crash.running.some((o) => id(o) === id(r))),
  );
}

function writeServiceRecord(
  root: string,
  record: ServiceRecord,
  run: ServiceRun,
  unreadable: Map<number, UnreadableObjective>,
  stopped: boolean,
): void {
  record.at = new Date().toISOString();
  record.finished = run.finished;
  record.unreadable = Object.fromEntries(
    [...unreadable].map(([issue, entry]) => [issue, entry.error]),
  );
  if (stopped) record.stopped = true;
  const path = join(root, "service.json");
  try {
    // Whole or not at all: the next start reads it to tell a crash.
    writeFileSync(`${path}.tmp`, JSON.stringify(record));
    renameSync(`${path}.tmp`, path);
  } catch {
    // Status falls back to the lock probe.
  }
}
