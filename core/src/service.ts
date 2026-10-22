import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
import type { GitHubModule, GitHubSync } from "./github-sync.js";
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
    const runner = runners.get(request.issue);
    if (!runner && unreadable.has(request.issue)) {
      if (
        request.kind !== "cancel" &&
        !(request.kind === "answer" && request.answer === "cancel")
      )
        return `#${request.issue} has unreadable state (${unreadable.get(request.issue)}). Answers: cancel.`;
      // Start over from a fresh cancelled record that replaces the unreadable file.
      const state = newObjective(request.issue, new Date());
      state.status = "cancelled";
      state.appliedRequests = [{ id: stored.id, message: "ok" }];
      saveState(paths.objectives, state);
      unreadable.delete(request.issue);
      runners.set(
        request.issue,
        new ObjectiveRunner(state, workflow, paths.objectives, log, limits),
      );
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
          result = runner.retryNow(stored.by);
          break;
        case "answer":
          result = runner.answer(request.answer, request.text, stored.by);
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

  const tick = (): void => {
    applyRequests();
    // Objectives with running steps keep their slot; then started ones; then issue order.
    const ordered = [...runners.values()].sort(
      (a, b) =>
        Number(b.busy) - Number(a.busy) ||
        Number(started(b)) - Number(started(a)) ||
        a.state.issue - b.state.issue,
    );
    let slots = maxActive;
    for (const runner of ordered) {
      const status = runner.state.status;
      let run = false;
      if (TERMINAL.includes(status)) run = runner.hasWork;
      else if (runner.busy) {
        // Running steps keep their slot, even while another step's question is open.
        slots -= 1;
        run = true;
      } else if (status !== "holding" && slots > 0) {
        slots -= 1;
        run = true;
      } else if (Object.keys(runner.state.attempts).length > 0 && !runner.busy)
        run = true; // settle an interrupted attempt, which may open a hold
      if (!run) continue;
      try {
        runner.tick();
      } catch (error) {
        // A failed save: that Objective's state stays as on disk and is tried again next tick.
        log.write(runner.state.issue, {
          event: "tick-failed",
          error: String(error),
        });
      }
    }
    options.sync?.tick({
      runners,
      requestsDir: paths.requests,
      slotFree: () =>
        [...runners.values()].filter(
          (r) =>
            !TERMINAL.includes(r.state.status) && r.state.status !== "holding",
        ).length < maxActive,
      admit: (issue: number, github: GitHubModule) => {
        // A new run, or a run again after the operator queued a finished one.
        const state = newObjective(issue, new Date());
        state.modules.github = github;
        saveState(paths.objectives, state);
        unreadable.delete(issue);
        runners.set(
          issue,
          new ObjectiveRunner(state, workflow, paths.objectives, log, limits),
        );
        log.write(issue, { event: "admitted" });
      },
      result: (id: string) => readResult(paths.requests, id),
    });
    writeHeartbeat(paths.root, runId, unreadable);
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
  lock.close();
  return 0;
}

function started(runner: ObjectiveRunner): boolean {
  return runner.busy || Object.keys(runner.state.done).length > 0;
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
