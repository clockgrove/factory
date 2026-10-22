import {
  mkdirSync,
  readdirSync,
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
  type Workflow,
} from "./engine.js";
import { takeServiceLock } from "./lock.js";
import { RunLog, rotateLogs } from "./log.js";
import type { Paths } from "./paths.js";
import {
  pendingRequests,
  removeRequest,
  type StoredRequest,
} from "./requests.js";
import {
  listObjectives,
  loadState,
  newObjective,
  saveState,
  TERMINAL,
} from "./state.js";
import { objectiveWorkflow } from "./workflow.js";

export interface ServeOptions {
  paths: Paths;
  workflow?: Workflow;
  limits?: EngineLimits;
  /** Objectives that may make progress at once (v1: 1). */
  maxActive?: number;
  tickMs?: number;
}

const KEEP_REQUEST_IDS = 50;
const RESULT_TTL_MS = 60 * 60 * 1000;

/**
 * `factory serve`: the only writer of Factory state. It returns only when
 * stopped by a signal. It never exits on an Objective's error: every error
 * is a step outcome.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const { paths } = options;
  const workflow = options.workflow ?? objectiveWorkflow;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxActive = options.maxActive ?? 1;
  const lock = await takeServiceLock(paths.lockName);
  if (!lock) {
    process.stderr.write("factory: the service is already running\n");
    return 3;
  }
  for (const dir of [paths.objectives, paths.requests, paths.logs])
    mkdirSync(dir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const log = new RunLog(paths.logs, runId);
  const runners = new Map<number, ObjectiveRunner>();
  const unreadable = new Map<number, string>();

  // Only the lock holder writes state, so leftover temporary files are from a crash.
  for (const name of readdirSync(paths.objectives))
    if (name.endsWith(".tmp"))
      rmSync(join(paths.objectives, name), { force: true });
  for (const issue of listObjectives(paths.objectives)) {
    const loaded = loadState(paths.objectives, issue);
    if (!loaded) continue;
    if (loaded.kind === "ok")
      runners.set(
        issue,
        new ObjectiveRunner(
          loaded.state,
          workflow,
          paths.objectives,
          log,
          limits,
        ),
      );
    else unreadable.set(issue, loaded.error);
  }
  crashPoint("serve:loaded");

  const applyRequests = (): void => {
    for (const { file, stored } of pendingRequests(paths.requests)) {
      if (!stored) {
        removeRequest(file);
        continue;
      }
      const message = applyRequest(stored);
      writeResult(paths.requests, stored.id, message);
      crashPoint("requests:applied");
      removeRequest(file);
    }
  };

  const applyRequest = (stored: StoredRequest): string => {
    const { request } = stored;
    let runner = runners.get(request.issue);
    if (!runner && unreadable.has(request.issue)) {
      if (
        request.kind !== "cancel" &&
        !(request.kind === "answer" && request.answer === "cancel")
      )
        return `#${request.issue} has unreadable state (${unreadable.get(request.issue)}). Answers: cancel.`;
      // Start over from a fresh cancelled record; the unreadable file is replaced.
      const state = newObjective(request.issue, new Date());
      state.status = "cancelled";
      saveState(paths.objectives, state);
      unreadable.delete(request.issue);
      runner = new ObjectiveRunner(
        state,
        workflow,
        paths.objectives,
        log,
        limits,
      );
      runners.set(request.issue, runner);
    }
    if (!runner) return `Factory has no Objective #${request.issue}.`;
    const state = runner.state;
    if (state.appliedRequests.includes(stored.id)) return "already applied";
    state.appliedRequests = [...state.appliedRequests, stored.id].slice(
      -KEEP_REQUEST_IDS,
    );
    let message = "ok";
    switch (request.kind) {
      case "cancel":
        runner.cancel(stored.by);
        break;
      case "retry":
        runner.retryNow();
        break;
      case "answer":
        message =
          runner.answer(request.answer, request.text, stored.by) ?? "ok";
        break;
    }
    runner.persist();
    log.write(request.issue, {
      event: "request",
      request,
      by: stored.by,
      message,
    });
    return message;
  };

  const tick = (): void => {
    applyRequests();
    const ordered = [...runners.values()].sort(
      (a, b) =>
        Number(started(b)) - Number(started(a)) ||
        a.state.issue - b.state.issue,
    );
    let slots = maxActive;
    for (const runner of ordered) {
      if (TERMINAL.includes(runner.state.status)) {
        if (runner.active) runner.tick();
        continue;
      }
      if (runner.state.status === "holding") continue;
      if (slots <= 0) continue;
      slots -= 1;
      runner.tick();
    }
    writeHeartbeat(paths.root, runId, unreadable);
  };

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  rotateLogs(paths.logs);
  sweepResults(paths.requests);
  let lastHousekeeping = Date.now();
  while (!stopping) {
    try {
      tick();
    } catch (error) {
      // A bug in the loop itself: log it and keep serving.
      log.write(0, { event: "loop-error", error: String(error) });
    }
    if (Date.now() - lastHousekeeping > RESULT_TTL_MS) {
      rotateLogs(paths.logs);
      sweepResults(paths.requests);
      lastHousekeeping = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, options.tickMs ?? 1000));
  }
  lock.close();
  return 0;
}

function started(runner: ObjectiveRunner): boolean {
  return runner.busy || Object.keys(runner.state.done).length > 0;
}

function writeResult(dir: string, id: string, message: string): void {
  try {
    // A request re-read after a crash keeps its first result.
    writeFileSync(join(dir, `${id}.result`), `${message}\n`, { flag: "wx" });
  } catch {
    // Already written.
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

function writeHeartbeat(
  root: string,
  runId: string,
  unreadable: Map<number, string>,
): void {
  try {
    writeFileSync(
      join(root, "service.json"),
      JSON.stringify({
        pid: process.pid,
        runId,
        at: new Date().toISOString(),
        unreadable: Object.fromEntries(unreadable),
      }),
    );
  } catch {
    // Status falls back to the lock probe.
  }
}
