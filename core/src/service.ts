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
  type CapacityUse,
  DEFAULT_LIMITS,
  type EngineLimits,
  hostLimits,
  itemOf,
  ObjectiveRunner,
  type ServiceRun,
  type Workflow,
} from "./engine.js";
import type {
  GitHubModule,
  GitHubSync,
  UnreadableObjective,
} from "./github-sync.js";
import { backoffMs, Jobs } from "./jobs.js";
import { takeServiceLock } from "./lock.js";
import { newRunId, RunLog, rotateLogs } from "./log.js";
import type { Paths } from "./paths.js";
import { declineDiscovery, proposeAmendment } from "./planning/amendments.js";
import { pathsOverlap } from "./planning/graph.js";
import { ACCEPTED_AT, currentPlan } from "./planning/plan.js";
import {
  type DreamRequest,
  isCancel,
  pendingRequests,
  type RequestResult,
  type RunRequest,
  refused,
  removeRequest,
  type StoredRequest,
} from "./requests.js";
import { RESET, type ResetRecord, resetRecord } from "./reset.js";
import {
  deadlineAt,
  type Frozen,
  findState,
  finishState,
  listObjectives,
  listObservations,
  loadQueueControl,
  newObjective,
  type ObjectiveState,
  type QueueControl,
  removeState,
  runOf,
  saveObservation,
  saveQueueControl,
  saveState,
  TERMINAL,
} from "./state.js";
import { carried } from "./tracking.js";
import { built, RERUN, RERUN_CLEANUP, startedItems } from "./work/steps.js";
import { objectiveWorkflow, started } from "./workflow.js";

export interface ServeOptions {
  paths: Paths;
  workflow?: Workflow;
  limits?: EngineLimits;
  /** Objectives that may make progress at once (v1: 1). */
  maxActive?: number;
  tickMs?: number;
  /** GitHub queue, display and comments. Absent without configuration. */
  sync?: GitHubSync;
  /** This run's log, shared with `sync`; absent, a new one without capture. */
  log?: RunLog;
  /** The configuration each newly admitted Objective freezes. */
  frozen?: Frozen;
  /** The configuration an Objective admitted for `factory run --provider NAME` freezes; undefined for a provider it lacks. */
  freeze?: (provider: string) => Frozen | undefined;
  /** Each newly admitted Objective's deadline, from its admission (`queue.objectiveDeadlineSeconds`). */
  deadlineSeconds?: number;
  /** Reads Objectives as they move; never changes them (knowledge records memory here). */
  observer?: StateObserver;
  /** Applies a `dream` request to the knowledge store, which only the service writes. */
  dream?: (stored: StoredRequest & { request: DreamRequest }) => RequestResult;
  /** The workflow can rebuild a state from GitHub (`factory reset`, reset.ts): it has configuration. */
  reset?: boolean;
  /**
   * The configuration path that doesn't exist: the service applies
   * requests only, and says so in its log and in `status`.
   */
  unconfigured?: string;
}

/**
 * `observe` sees an Objective once each time its status (or settledness:
 * terminal with nothing left to run) changes, and once when the service
 * reads an active state file. It gets a copy and runs beside the loop,
 * aborted by `signal` past its deadline (which frees it at once: jobs.ts);
 * a failure is retried with backoff until it succeeds. A run that a new
 * admission of the same issue replaces, or a withdrawal removes, is
 * observed as settled too, which ends it.
 *
 * Knowledge is best effort for the lifecycle: admission, withdrawal and
 * retirement never wait on an observation. A run's settled observation is
 * kept and retried in the background, with backoff, until it lands,
 * across restarts (saved beside the finished states): an episode may be
 * recorded late, but the queue never waits on it.
 */
export interface StateObserver {
  observe(
    state: ObjectiveState,
    settled: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}

const OBSERVE_BACKOFF_MS = 1000;
const OBSERVE_DEADLINE_MS = 5 * 60 * 1000;

/** What the observer last saw: the status and whether it had settled. */
const observeMark = (runner: ObjectiveRunner): string =>
  `${runner.state.status}:${runner.settled}`;
const OBSERVE_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** One run's observations, live or late, share this job key. */
const observeKey = (state: ObjectiveState): string =>
  `${state.issue}@${runOf(state)}`;

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
  const log = options.log ?? new RunLog(paths.logs, newRunId(startedAt));
  const { runId } = log;
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
  /** Per Objective: the mark last observed. */
  const observed = new Map<number, string>();
  /** Observations in flight and their backoff, by run (`observeKey`). */
  const observing = new Jobs(log, "observe-failed", {
    baseMs: OBSERVE_BACKOFF_MS,
    maxMs: OBSERVE_MAX_BACKOFF_MS,
    deadlineMs: OBSERVE_DEADLINE_MS,
  });
  /**
   * Settled observations of runs no longer in memory (retired, replaced or
   * withdrawn before the observer took them), by `observeKey`: retried
   * with backoff until they land. Each is saved in finished/ (`path`)
   * until then, and startup reads those files back.
   */
  const late = new Map<string, { state: ObjectiveState; path?: string }>();
  const keepLate = (state: ObjectiveState, path?: string): void => {
    late.set(observeKey(state), {
      state: structuredClone(state),
      ...(path ? { path } : {}),
    });
  };
  /** Keep a settled observation on disk too; one that can't be saved is kept in memory and logged. */
  const observeLate = (state: ObjectiveState): void => {
    if (!options.observer) return;
    try {
      keepLate(state, saveObservation(paths.objectives, state));
    } catch (error) {
      log.write(state.issue, {
        event: "observe-unsaved",
        error: String(error),
      });
      keepLate(state);
    }
  };
  /** Checked Objectives waiting for a slot, as of the last tick. */
  const waitingForSlot = new Set<number>();
  /** Objectives waiting on an earlier Objective's paths, as of the last tick. */
  const waitingOnPaths = new Map<number, number>();
  /** `factory queue pause|drain|resume`, saved so it survives restarts. */
  let queue = loadQueueControl(paths.root);
  /**
   * `factory run N` requests waiting for their Objective's admission, by
   * issue: the newest one's provider and deadline admit it. Their files
   * stay until then, so a restart reads them again.
   */
  const runs = new Map<number, StoredRequest & { request: RunRequest }>();
  /**
   * The one place a waiting `run` ends: whenever its request gets any
   * result (refused, ok, dequeued, cancelled, admitted), its entry goes,
   * and the sync stops watching its card. A newer request for the issue
   * keeps its own entry.
   */
  const endRun = (issue: number, id: string): void => {
    if (runs.get(issue)?.id !== id) return;
    runs.delete(issue);
    options.sync?.ranOut(issue);
  };
  /** Answer a request that stayed pending, and remove it. */
  const answer = (
    stored: StoredRequest & { request: RunRequest },
    result: RequestResult,
  ): void => {
    endRun(stored.request.issue, stored.id);
    writeResult(paths.requests, stored.id, result);
    removeRequest(join(paths.requests, `${stored.id}.json`));
    log.write(stored.request.issue, {
      event: "request",
      request: stored.request,
      ...result,
    });
  };
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
      runner.settled &&
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
    const unobserved =
      options.observer && runner && observed.get(issue) !== observeMark(runner);
    let path: string | undefined;
    try {
      // Saved before the move, so a restart retries it from finished/.
      if (unobserved) path = saveObservation(paths.objectives, runner.state);
      finishState(paths.objectives, issue);
    } catch (error) {
      // It stays, and moves on a later tick.
      log.write(issue, { event: "finish-failed", error: String(error) });
      return;
    }
    if (unobserved) keepLate(runner.state, path);
    runners.delete(issue);
    options.sync?.forget(issue);
    observed.delete(issue);
  };
  /**
   * The observer ends a run that is replaced (a re-queue) or withdrawn, in
   * the background: its settled observation goes on late, under the run's
   * key, unless it already landed. Nothing here touches the store.
   */
  const release = (state: ObjectiveState): void => {
    if (!options.observer) return;
    const key = observeKey(state);
    const owed =
      observed.get(state.issue) !== `${state.status}:true` ||
      observing.pending(key);
    observed.delete(state.issue);
    if (owed) observeLate(state);
    else observing.forget(key);
  };

  // Only the lock holder writes state, so leftover temporary files are from a crash.
  for (const name of readdirSync(paths.objectives))
    if (name.endsWith(".tmp"))
      rmSync(join(paths.objectives, name), { force: true });
  for (const issue of listObjectives(paths.objectives)) load(issue);
  // Settled observations that hadn't landed: retried, never history read.
  for (const { path, state, error } of options.observer
    ? listObservations(paths.objectives)
    : [])
    if (state) keepLate(state, path);
    else {
      log.write(0, { event: "observation-unreadable", path, error });
      rmSync(path, { force: true });
    }
  const record = startRecord(previous, startedAt, runId, runners, limits);
  if (options.unconfigured) {
    record.problem = `No configuration at ${options.unconfigured}, so the service applies requests only and never reads the queue; run factory setup, then restart the service`;
    log.write(0, { event: "unconfigured", config: options.unconfigured });
    process.stderr.write(`factory: ${record.problem}\n`);
  }
  run.resumeAt = Date.parse(record.resumeAt ?? "") || 0;
  if (record.resumeAt)
    log.write(0, {
      event: "crash-loop",
      crashes: crashStreak(record.deaths),
      resumeAt: record.resumeAt,
    });
  const heartbeat = (stopped = false): void => {
    record.queue = queue;
    record.capacity = hostLimits.usage();
    record.waits = Object.fromEntries([
      ...[...waitingForSlot].map((issue) => [issue, { slot: true as const }]),
      ...[...waitingOnPaths].map(([issue, other]) => [issue, { paths: other }]),
    ]);
    writeServiceRecord(paths.root, record, run, unreadable, stopped);
  };
  // Saved before any hold below, so a crash in between never counts the
  // same death twice.
  heartbeat();
  // The evidence is spent before any question is visible: the steps to
  // ask about are saved in the record first (`suspected`), so a death
  // before their questions are saved asks them at the next start, and a
  // reader who sees a question never sees the evidence behind it again.
  const id = (r: { issue: number; step: string }) => `${r.issue} ${r.step}`;
  const culprits = [
    ...(previous?.suspected ?? []),
    ...suspects(record.deaths),
  ].filter((r, at, all) => all.findIndex((o) => id(o) === id(r)) === at);
  if (culprits.length) {
    // Another question needs three new deaths.
    for (const death of record.deaths) death.spent = true;
    record.suspected = culprits;
    heartbeat();
  }
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
    // Each question is asked, or saved to ask as soon as no open question
    // stops the step (engine.ts `hold`).
    delete record.suspected;
    heartbeat();
  }
  crashPoint("serve:loaded");

  const applyRequests = (): void => {
    for (const { file, stored } of pendingRequests(paths.requests)) {
      if (!stored) {
        removeRequest(file);
        continue;
      }
      let result: RequestResult | undefined;
      try {
        result = applyRequest(stored);
      } catch (error) {
        // Not saved: the request file stays and is tried again next tick.
        log.write(stored.request.issue, {
          event: "request-failed",
          id: stored.id,
          error: String(error),
        });
        continue;
      }
      // A reset that is rebuilding, or a run waiting for its admission:
      // answered when that lands.
      if (!result) continue;
      if (stored.request.kind === "run")
        endRun(stored.request.issue, stored.id);
      writeResult(paths.requests, stored.id, result);
      crashPoint("requests:applied");
      removeRequest(file);
    }
  };

  /** The result; undefined while a reset rebuilds (or its state can't be read now). */
  const applyRequest = (stored: StoredRequest): RequestResult | undefined => {
    const { request } = stored;
    if (request.kind === "dream") {
      const result = options.dream
        ? options.dream({ ...stored, request })
        : refused(
            "no_configuration",
            "The service runs without configuration, so it has no knowledge store.",
          );
      log.write(0, {
        event: "dream",
        op: request.write.op,
        by: stored.by,
        ...(result.code ? { code: result.code, error: result.message } : {}),
      });
      return result;
    }
    if (request.kind === "run") return startRun({ ...stored, request });
    // A cancel drops a `factory run` waiting for its admission, and takes
    // its card out of the queue: the operator's latest action wins.
    const waiting = isCancel(request) ? runs.get(request.issue) : undefined;
    if (waiting) {
      answer(waiting, refused("superseded", "A cancel replaced this run."));
      options.sync?.unqueue(request.issue);
      const known = find(request.issue);
      if (!known || TERMINAL.includes(known.state.status))
        return { message: "ok" };
    }
    if (request.kind === "queue") {
      queue = { mode: request.mode, by: stored.by, at: stored.at };
      saveQueueControl(paths.root, queue);
      log.write(0, { event: "queue", mode: request.mode, by: stored.by });
      return { message: "ok" };
    }
    // `reset` answers an unreadable state's question; elsewhere `reset` is
    // an ordinary answer (such as replacing a Work Item branch).
    if (
      request.kind === "reset" ||
      (request.kind === "answer" &&
        request.answer === "reset" &&
        unreadable.has(request.issue))
    )
      return startReset(stored);
    const runner = find(request.issue);
    const broken = unreadable.get(request.issue);
    if (!runner && broken) {
      if (!isCancel(request))
        return refused(
          "state_unreadable",
          `#${request.issue} has unreadable state (${broken.error}). Answers: reset, cancel.`,
        );
      // Start over from a fresh cancelled record that replaces the unreadable
      // file; cleanup closes the Objective's PRs and issue, and the sync
      // replies and shows it cancelled.
      const state = newObjective(request.issue, new Date());
      state.status = "cancelled";
      state.ended = {
        at: state.updatedAt,
        by: stored.by,
        ...(stored.source ? { source: stored.source } : {}),
      };
      state.appliedRequests = [{ id: stored.id, message: "ok" }];
      if (broken.github) state.modules.github = broken.github;
      saveState(paths.objectives, state);
      unreadable.delete(request.issue);
      open(state);
      return { message: "ok" };
    }
    if (!runner)
      return refused(
        "no_factory_state",
        `Factory has no Objective #${request.issue}.`,
      );
    const seen = runner.state.appliedRequests.find((r) => r.id === stored.id);
    if (seen) return seen;
    // The change and the record that it was applied are saved together.
    const result = runner.transact(() => {
      const state = runner.state;
      const resetting = state.kept?.[RESET] as ResetRecord | undefined;
      const endedBefore = state.ended;
      let refusal: RequestResult | null = null;
      switch (request.kind) {
        case "cancel":
          refusal = runner.cancel(stored.by);
          break;
        case "retry":
          refusal = runner.retryNow(stored.by, request.question);
          break;
        case "answer":
          refusal = runner.answer(
            request.answer,
            request.text,
            stored.by,
            request.writtenAt,
            request.question,
            request.arg,
            request.reviewArtifacts,
          );
          break;
        case "pause":
        case "drain":
        case "resume":
          refusal = control(state, request.kind, stored);
          break;
        case "propose-amendment":
        case "decline-discovery": {
          // Taken in this save: the workflow runs a proposal before any
          // other step once the plan is accepted (workflow.ts).
          const problems = TERMINAL.includes(state.status)
            ? [
                `#${request.issue} has finished; an amendment needs a running Objective`,
              ]
            : request.kind === "propose-amendment"
              ? proposeAmendment(
                  state,
                  request.proposal,
                  stored.id,
                  stored.by,
                  stored.at,
                )
              : declineDiscovery(
                  state,
                  request.item,
                  request.reason,
                  stored.by,
                  stored.at,
                );
          if (problems.length)
            refusal = refused(
              TERMINAL.includes(state.status)
                ? "objective_finished"
                : "amendment_refused",
              problems.join("\n"),
            );
          break;
        }
      }
      // A cancel this request made records where it came from.
      if (state.ended && state.ended !== endedBefore && stored.source)
        state.ended.source = stored.source;
      const applied = refusal ?? { message: "ok" };
      // A cancel replaces a reset that hasn't landed: its request is
      // answered here, with this save.
      const superseded =
        resetting && !refusal && isCancel(request)
          ? [
              {
                id: resetting.request,
                ...refused("superseded", "A cancel replaced this reset."),
              },
            ]
          : [];
      state.appliedRequests = [
        ...state.appliedRequests,
        ...superseded,
        { id: stored.id, ...applied },
      ].slice(-KEEP_REQUEST_IDS);
      return applied;
    });
    log.write(request.issue, {
      event: "request",
      request,
      by: stored.by,
      ...result,
    });
    return result;
  };

  /**
   * `factory run N`: an Objective already running answers at once (no
   * second admission); otherwise its card is queued and the request waits
   * for the normal queue admission, which takes its provider and deadline.
   */
  const startRun = (
    stored: StoredRequest & { request: RunRequest },
  ): RequestResult | undefined => {
    const { issue, provider } = stored.request;
    if (unreadable.has(issue))
      return refused(
        "state_unreadable",
        `#${issue} has unreadable state. Answers: factory reset ${issue}, or cancel.`,
      );
    const known = find(issue);
    if (known && !TERMINAL.includes(known.state.status))
      return { message: "ok" };
    const current = runs.get(issue);
    if (current && current.id > stored.id)
      return refused(
        "superseded",
        `A later factory run ${issue} replaced this one.`,
      );
    const { deadline } = stored.request;
    if (deadline !== undefined && Date.parse(deadline) <= Date.now())
      return refused(
        "deadline_passed",
        `This run's deadline (${deadline}) passed before #${issue} was admitted; run factory run ${issue} again with a new --deadline.`,
      );
    if (queue.mode !== "running")
      return refused(
        "queue_not_running",
        `The queue is ${queue.mode}, so #${issue} isn't admitted; run factory queue resume, then factory run ${issue} again.`,
      );
    const sync = options.sync;
    if (!sync)
      return refused(
        "no_configuration",
        "The service runs without configuration, so it has no queue to run an Objective from.",
      );
    if (provider !== undefined && !options.freeze?.(provider))
      return refused(
        "unknown_provider",
        `The service's configuration has no provider ${JSON.stringify(provider)}; restart the service after adding it, or leave out --provider.`,
      );
    if (!current || current.id < stored.id) {
      runs.set(issue, stored);
      log.write(issue, {
        event: "request",
        request: stored.request,
        by: stored.by,
      });
    }
    const shown = (known?.state.modules.github as GitHubModule | undefined)
      ?.shown;
    // The card's outcome answers whichever request waits for it by then.
    sync.queue(issue, Boolean(known), { at: stored.at, shown }, (result) => {
      const waiting = runs.get(issue);
      if (waiting) answer(waiting, result);
    });
    return undefined;
  };

  /**
   * `factory reset N`: save a resetting record in place of the old state
   * (which it keeps, to carry the operator's choices over or to restore),
   * and let its `rebuild` step read GitHub (reset.ts). The request is
   * answered when the rebuild lands; a crash at any point reruns the
   * rebuild, which only reads.
   */
  const startReset = (stored: StoredRequest): RequestResult | undefined => {
    const issue = stored.request.issue;
    if (!options.reset)
      return refused(
        "no_configuration",
        "Factory has no configuration for this repository, so it can't read GitHub to reset.",
      );
    let known: ObjectiveRunner | undefined;
    try {
      known = find(issue);
    } catch {
      return undefined; // the state can't be read now: tried again next tick
    }
    const seen = known?.state.appliedRequests.find((r) => r.id === stored.id);
    if (seen) return seen;
    const running = known?.state.kept?.[RESET] as ResetRecord | undefined;
    if (running?.request === stored.id) return undefined;
    if (running && !TERMINAL.includes(known!.state.status))
      return refused(
        "reset_in_progress",
        `A reset of #${issue} is already rebuilding it; factory status ${issue} shows it.`,
      );
    const hadState = Boolean(known) || unreadable.has(issue);
    // Creating an Objective is an admission: not while the queue isn't running.
    if (!hadState && queue.mode !== "running")
      return refused(
        "queue_not_running",
        `The queue is ${queue.mode}, so #${issue}, which Factory has no state for, isn't admitted; run factory queue resume, then reset again.`,
      );
    const state = resetRecord(
      issue,
      stored,
      known ? structuredClone(known.state) : undefined,
      hadState,
      unreadable.get(issue)?.github,
      options.frozen,
      options.deadlineSeconds,
    );
    // Its steps are stopped, and the rebuild starts only once they have
    // ended (each by its deadline at the latest), so no effect of theirs
    // (a merge) lands after the rebuild read GitHub. A cancel meanwhile
    // replaces the reset at once.
    const stopped = known?.stop();
    runners.delete(issue);
    unreadable.delete(issue);
    options.sync?.forget(issue);
    saveState(paths.objectives, state);
    crashPoint("reset:recorded");
    const runner = open(state);
    if (stopped) runner.after(stopped);
    log.write(issue, { event: "reset-started", by: stored.by, hadState });
    return undefined;
  };

  /**
   * Dequeued before planning: the run goes as if never admitted, so
   * queuing it again checks it afresh. The observer ends it first.
   */
  const withdrawNow = (runner: ObjectiveRunner): void => {
    const issue = runner.state.issue;
    // A reset that found nothing to rebuild: its request is answered
    // before the record goes.
    const reset = runner.state.kept?.[RESET] as ResetRecord | undefined;
    const answered =
      reset && runner.state.appliedRequests.find((r) => r.id === reset.request);
    if (reset && answered) {
      writeResult(paths.requests, reset.request, answered);
      removeRequest(join(paths.requests, `${reset.request}.json`));
      crashPoint("reset:answered");
    }
    release(runner.state);
    removeState(paths.objectives, issue);
    crashPoint("serve:withdrawn");
    void runner.stop();
    runners.delete(issue);
    options.sync?.withdrawn(runner.state);
    log.write(issue, { event: "withdrawn" });
  };

  /** The service-level problem last logged (GitHubSync.problem). */
  let reported: string | undefined;
  const tick = (): void => {
    for (const issue of [...unloaded]) load(issue);
    applyRequests();
    // The repository moved: every GitHub effect pauses. No step runs (no
    // push, merge or close), no sync job runs, nothing settles or
    // retires; states stay as they are until a restart with the fixed
    // configuration. Requests are still recorded.
    const problem = options.sync?.problem();
    if (problem) {
      if (reported !== problem)
        log.write(0, { event: "service-problem", problem });
      reported = problem;
      record.problem = problem;
      heartbeat();
      return;
    }
    // Running steps keep their slot; then started Objectives; then queue order.
    const ordered = [...runners.values()].sort(
      (a, b) =>
        Number(b.busy) - Number(a.busy) ||
        Number(started(b.state)) - Number(started(a.state)) ||
        queueOrder(a) - queueOrder(b) ||
        a.state.issue - b.state.issue,
    );
    let slots = maxActive;
    waitingForSlot.clear();
    waitingOnPaths.clear();
    for (const runner of ordered) {
      // The deadline is absolute: checked for every Objective, whatever
      // it waits on, before what it may run is decided.
      try {
        runner.expire();
      } catch (error) {
        log.write(runner.state.issue, {
          event: "tick-failed",
          error: String(error),
        });
      }
      const { state } = runner;
      // Dequeued while its check or a re-run's cleanup ran: it goes once
      // that ends, and nothing past them starts. A cleanup the service's
      // death interrupted resumes first; one that holds or errors is never
      // asked about: the run goes at once.
      if (state.withdrawing && !TERMINAL.includes(state.status)) {
        if (!ending(runner)) {
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
        if (runner.busy) continue;
      }
      let run = false;
      const allow = allowed(runner, queue);
      if (TERMINAL.includes(state.status)) run = runner.hasWork;
      // Paused (the queue or the Objective), or drained with nothing left
      // to start: no slot; a step the service's death interrupted resumes.
      else if (
        !runner.busy &&
        !workflow.steps(state).some((step) => allow(step.key))
      )
        run = Object.keys(state.attempts).length > 0;
      // The check (and a new run's cleanup, and the wait for predecessors
      // before it) runs when the Objective is first seen, slot or not
      // (rule 7), within the host's `github` cap; planning and building
      // need a slot. So an Objective waiting on its predecessors takes none.
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
      else {
        const owner = pathOwner(runner, ordered);
        if (owner !== undefined) waitingOnPaths.set(state.issue, owner);
        else if (slots > 0) {
          slots -= 1;
          run = true;
        } else waitingForSlot.add(state.issue);
      }
      if (!run) continue;
      try {
        runner.tick(TERMINAL.includes(state.status) ? undefined : allow);
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
      if (observed.get(state.issue) === mark) continue;
      // The mark is kept only once the observation succeeded, and only
      // while this run is the issue's (a released one goes on late).
      const end = runner.settled;
      observing.run(
        state.issue,
        observeKey(state),
        (signal) => observer!.observe(structuredClone(state), end, signal),
        {
          done: () => {
            if (runners.get(state.issue) === runner)
              observed.set(state.issue, mark);
          },
        },
      );
    }
    for (const [key, entry] of observer ? late : [])
      observing.run(
        entry.state.issue,
        key,
        (signal) => observer!.observe(entry.state, true, signal),
        {
          done: () => {
            if (late.get(key) !== entry) return;
            late.delete(key);
            if (entry.path) rmSync(entry.path, { force: true });
          },
        },
      );
    options.sync?.tick({
      runners,
      unreadable,
      requestsDir: paths.requests,
      waitingForSlot: (issue) => waitingForSlot.has(issue),
      waitsOn: (issue) => {
        const other = waitingOnPaths.get(issue);
        return waitingForSlot.has(issue)
          ? { slot: true }
          : other !== undefined
            ? { paths: other }
            : null;
      },
      queue,
      logs: paths.logs,
      find,
      admit: (issue: number, github: GitHubModule) => {
        // A paused or draining queue admits nothing new; the card stays
        // queued and is admitted on a read after resume.
        if (queue.mode !== "running") return;
        const previous = find(issue);
        if (unreadable.has(issue)) return; // never over an unreadable file
        // Never over an unfinished run, nor one whose cleanup still runs.
        if (previous && !previous.settled) return;
        // A run again after the operator queued a finished one. The observer
        // ends the old run first (its episode, its playbook pin), now or in
        // the background.
        if (previous) release(previous.state);
        // The old run stops for good (its steps, its saves, its sync jobs)
        // before the new one exists, so only one run ever writes the file.
        void previous?.stop();
        options.sync?.forget(issue);
        const now = new Date();
        // A `factory run` request waiting for this admission chooses the
        // provider and the deadline.
        const asked = runs.get(issue);
        const frozen =
          asked?.request.provider !== undefined
            ? (options.freeze?.(asked.request.provider) ?? options.frozen)
            : options.frozen;
        const state = newObjective(issue, now, frozen);
        const deadline = deadlineAt(
          now,
          options.deadlineSeconds,
          asked?.request.deadline,
        );
        if (deadline) state.deadline = deadline;
        // The earlier run's Work Item issues stay recorded (tracking.ts).
        const tracking = (
          previous?.state.modules.github as GitHubModule | undefined
        )?.tracking;
        state.modules.github = tracking
          ? { ...github, tracking: carried(tracking) }
          : github;
        // The earlier run's PRs and worktrees go before the new run plans.
        if (previous) state.kept[RERUN] = true;
        saveState(paths.objectives, state);
        crashPoint("serve:admitted");
        open(state);
        log.write(issue, {
          event: "admitted",
          again: Boolean(previous),
          ...(frozen
            ? { provider: frozen.provider, config: frozen.digest }
            : {}),
          ...(asked ? { request: asked.id } : {}),
        });
        // A crash before this answers it when the request is read again:
        // the Objective is running by then.
        if (asked) answer(asked, { message: "ok" });
      },
      withdraw: (issue: number) => {
        const runner = runners.get(issue);
        if (
          !runner ||
          TERMINAL.includes(runner.state.status) ||
          started(runner.state)
        )
          return false;
        // Its check or a re-run's cleanup still runs: it goes once that
        // ends, and nothing past them starts meanwhile (see tick). A
        // cleanup not begun never runs: the earlier run's record stands.
        if (ending(runner)) {
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
        runner.settled &&
        (options.sync?.idle(issue) ?? true) &&
        !observing.active(observeKey(runner.state))
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
      rotateLogs(paths.logs, runId);
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
function pathOwner(
  runner: ObjectiveRunner,
  all: readonly ObjectiveRunner[],
): number | undefined {
  const mine = ownedPaths(runner.state);
  if (!mine.length || built(runner.state)) return undefined;
  const at = acceptedAt(runner.state);
  return all.find((other) => {
    if (other === runner) return false;
    if (TERMINAL.includes(other.state.status) || built(other.state))
      return false;
    const theirs = ownedPaths(other.state);
    if (!theirs.length) return false;
    const when = acceptedAt(other.state);
    if (when > at || (when === at && other.state.issue > runner.state.issue))
      return false;
    return mine.some((a) => theirs.some((b) => pathsOverlap(a, b)));
  })?.state.issue;
}

/**
 * Which steps may start under the operator's controls. A paused queue or
 * Objective starts none; a draining Objective starts no Work Item that
 * hasn't started (as buildSteps counts it), and a draining queue only
 * stops admissions. A reset's rebuild is the operator's own request: it
 * always runs.
 */
function allowed(
  runner: ObjectiveRunner,
  queue: QueueControl,
): (key: string) => boolean {
  const mode = runner.state.control?.mode;
  if (queue.mode === "paused" || mode === "paused")
    return (key) => key === "rebuild";
  if (mode !== "draining") return () => true;
  const started = startedItems(runner.state);
  return (key) => {
    const item = itemOf(key);
    return item === undefined || started.has(item);
  };
}

/** Apply `factory pause|drain|resume N`. */
function control(
  state: ObjectiveState,
  kind: "pause" | "drain" | "resume",
  stored: StoredRequest,
): RequestResult | null {
  if (TERMINAL.includes(state.status))
    return refused(
      "objective_finished",
      `#${state.issue} has already finished (${state.status}).`,
    );
  if (kind === "resume") delete state.control;
  else
    state.control = {
      mode: kind === "pause" ? "paused" : "draining",
      by: stored.by,
      at: stored.at,
    };
  return null;
}

function ownedPaths(state: ObjectiveState): string[] {
  const plan = currentPlan(state);
  // An envelope owns its selectors from acceptance, before children exist.
  return plan
    ? [
        ...plan.items.flatMap((item) => item.ownedPaths),
        ...(plan.expansions ?? []).flatMap((envelope) => envelope.selectors),
      ]
    : [];
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

/**
 * A dequeued run waits to be withdrawn only while a step runs, a re-run's
 * cleanup has begun (an attempt is open), or the steps of a run a reset
 * replaced haven't ended (`waiting`): their effects are half made.
 */
function ending(runner: ObjectiveRunner): boolean {
  return (
    runner.busy ||
    runner.waiting ||
    Boolean(runner.state.kept?.[RERUN] && runner.state.attempts[RERUN_CLEANUP])
  );
}

/** The Project's order number, read again on every queue read until it starts. */
function queueOrder(runner: ObjectiveRunner): number {
  return (
    (runner.state.modules.github as GitHubModule | undefined)?.order ??
    Number.MAX_SAFE_INTEGER
  );
}

/** An applied request's message, for the reply on GitHub. */
function readResult(dir: string, id: string): string | undefined {
  try {
    return (
      JSON.parse(
        readFileSync(join(dir, `${id}.result`), "utf8"),
      ) as RequestResult
    ).message;
  } catch {
    return undefined;
  }
}

/** Write the result whole, and only once: a request re-read after a crash keeps its first result. */
function writeResult(dir: string, id: string, result: RequestResult): void {
  const temporary = join(dir, `.${id}.result.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(result)}\n`);
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
   * The latest deaths (runs that ended without a clean stop), oldest
   * first, at most MAX_DEATHS. A clean stop empties it. The crash streak is
   * its trailing deaths that lived less than STREAK_MS after resuming; the
   * suspect evidence, its last SUSPECT_CRASHES deaths not yet spent.
   */
  deaths: Death[];
  /** When this run resumes interrupted steps; absent when it did at once. */
  resumeAt?: string;
  /** Step attempts that finished in this run. */
  finished: number;
  /** Steps the spent evidence names, until their questions are saved. */
  suspected?: Death["running"];
  /** Set by a clean stop. */
  stopped?: boolean;
  unreadable: Record<string, string>;
  /** What pauses the service's GitHub effects (GitHubSync.problem); `status` shows it. */
  problem?: string;
  /** The queue's mode. */
  queue?: QueueControl;
  /** The host limiter's slots and memory in use, as of the last heartbeat. */
  capacity?: CapacityUse;
  /** Objectives waiting, as of the last tick: for a slot, or on another Objective's paths. */
  waits?: Record<string, { slot: true } | { paths: number }>;
}

export interface Death {
  /** When the next run started: about when this one died. */
  at: string;
  /** How long the run lived after resuming; null when its record didn't say. */
  lived: number | null;
  /** The steps running when it died. */
  running: { issue: number; step: string }[];
  /** Whether the run finished any step. */
  progressed: boolean;
  /** Set once a suspect question used it as evidence. */
  spent?: true;
}

/** Deaths kept: enough for any streak the resume delay still grows on. */
const MAX_DEATHS = 20;

/** The crash streak's deaths: the trailing ones that died soon after resuming. */
export function crashStreak(deaths: readonly Death[]): number {
  let streak = 0;
  for (let at = deaths.length - 1; at >= 0; at--) {
    if ((deaths[at]!.lived ?? Number.POSITIVE_INFINITY) >= STREAK_MS) break;
    streak++;
  }
  return streak;
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
  const deaths: Death[] = crashed
    ? [
        ...(previous.deaths ?? []),
        {
          at: now,
          lived: Number.isFinite(lived) ? lived : null,
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
      ].slice(-MAX_DEATHS)
    : [];
  // This start is the streak's deaths plus one.
  const starts = crashStreak(deaths) + 1;
  const delay =
    starts >= LOOP_STARTS
      ? backoffMs(
          starts - LOOP_STARTS + 1,
          limits.baseBackoffMs,
          MAX_RESUME_DELAY_MS,
        )
      : 0;
  return {
    pid: process.pid,
    runId,
    at: now,
    startedAt: now,
    deaths,
    ...(delay
      ? { resumeAt: new Date(startedAt.getTime() + delay).toISOString() }
      : {}),
    finished: 0,
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
function suspects(deaths: Death[]): Death["running"] {
  const last = deaths.slice(-SUSPECT_CRASHES);
  if (last.length < SUSPECT_CRASHES || last.some((death) => death.spent))
    return [];
  if (!last.slice(1).every((death) => death.progressed)) return [];
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
