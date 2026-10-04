import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkRequiredEnvironment } from "./repair-policy.js";
import {
  factoryConfigDigest,
  stateRoot,
  type FactoryConfig,
} from "./config.js";
import type { GitHubGateway, IntakeIssuePage } from "./contracts.js";
import * as time from "./clock.js";
import { objectiveComplete } from "./completion.js";
import { attachedFault } from "./fault.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import {
  type ControlRequest,
  ForegroundControllerError,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { fetchHead, git, gitAsync } from "./process.js";
import {
  type ApplicationServices,
  runObjective,
  CoordinatorHandoff,
} from "./runner.js";
import {
  acquireControllerLock,
  readContinuation,
  releaseControllerLock,
  retargetControllerLock,
  saveState,
  statePath,
} from "./state-store.js";
import type { PreparationState, ContinuationState } from "./state.js";

/**
 * The queue and its service switch. Pending order is derived from `objectives`, never copied
 * into a second queue. `watch` is set by `factory setup --background`, which is the consent to
 * run the service; a queue without it is only a list waiting for that setup.
 */
export interface IntakeAuthorization {
  version: 1;
  repository: string;
  configDigest: string;
  /** Objectives the operator queued, in order; empty for a watch-only service. */
  objectives: number[];
  watch?: true;
  bodyDigests: Record<string, string>;
  dequeued: number[];
  mode: "running" | "paused" | "draining";
  observation?: {
    at: string;
    reasons: Record<string, string>;
    error?: string;
    /** The Objective that stopped the queue for a human decision. */
    needsDecision?: number;
    idleReason?: "awaiting-approved-work" | "waiting-for-eligible-work";
    unapproved?: number[];
  };
}
const DRAINING_REFUSAL =
  "The queue is draining; it cannot take new work. `factory queue resume` reopens it";
/** How often the service looks at GitHub for queued work. */
export const DEFAULT_QUEUE_POLL_SECONDS = 30;
export const queuePollSeconds = (config: FactoryConfig): number =>
  config.queue?.pollSeconds ?? DEFAULT_QUEUE_POLL_SECONDS;
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const intakePath = (config: FactoryConfig) =>
  join(stateRoot(config.repository), "intake.json");
function saveIntake(config: FactoryConfig, value: IntakeAuthorization): void {
  const path = intakePath(config);
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(stateRoot(config.repository), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function readIntake(
  config: FactoryConfig,
): IntakeAuthorization | undefined {
  const path = intakePath(config);
  if (!existsSync(path)) return;
  const invalid = (reason: string): never => {
    throw new Error(
      `The queue record ${path} cannot be used (${reason}). It is from an earlier build or another configuration; delete it, then run \`factory setup --background\` and \`factory queue add N\` to start a new queue`,
    );
  };
  let value: IntakeAuthorization;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as IntakeAuthorization;
  } catch {
    return invalid("not valid JSON");
  }
  if (
    value.version !== 1 ||
    value.repository !== config.repository ||
    value.configDigest !== factoryConfigDigest(config) ||
    !["running", "paused", "draining"].includes(value.mode) ||
    !Array.isArray(value.dequeued)
  )
    invalid("it does not match this installation");
  for (const key of Object.keys(value))
    if (
      ![
        "version",
        "repository",
        "configDigest",
        "objectives",
        "watch",
        "bodyDigests",
        "dequeued",
        "mode",
        "observation",
      ].includes(key)
    )
      invalid(`unsupported field ${key}`);
  if (value.watch !== undefined && value.watch !== true)
    invalid("invalid service switch");
  try {
    validateObjectives(value.objectives);
  } catch {
    invalid("invalid Objective list");
  }
  if (!value.objectives.length && !value.watch)
    invalid("an empty queue exists only with the background service");
  for (const objective of value.objectives)
    if (!/^[a-f0-9]{64}$/.test(value.bodyDigests[objective] ?? ""))
      invalid(`Objective #${objective} has no issue body binding`);
  if (value.dequeued.some((id) => !value.objectives.includes(id)))
    invalid("a removed Objective is not in the queue");
  return value;
}
function validateObjectives(objectives: number[]): void {
  if (
    !Array.isArray(objectives) ||
    objectives.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(objectives).size !== objectives.length
  )
    throw new Error("The queue takes distinct positive Objective numbers");
}
function continuations(config: FactoryConfig): ContinuationState[] {
  const path = join(stateRoot(config.repository), "objectives");
  return existsSync(path)
    ? readdirSync(path)
        .filter((name) => /^\d+$/.test(name))
        .map((name) => readContinuation(config.repository, Number(name))!)
        .filter(Boolean)
    : [];
}
function terminal(state: ContinuationState): boolean {
  return (
    !!state.cancelledAt ||
    (state.schemaVersion === 7 && objectiveComplete(state))
  );
}
export function intakeSettled(config: FactoryConfig): boolean {
  return continuations(config).every(terminal);
}
/** Authorize the issues' current bodies; the queue runs an Objective only while its body matches. */
async function authorizedBodies(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
): Promise<Record<string, string>> {
  validateObjectives(objectives);
  if (!objectives.length)
    throw new Error("queue add needs at least one Objective number");
  checkRequiredEnvironment(config);
  const bodyDigests: Record<string, string> = {};
  for (const objective of objectives)
    bodyDigests[objective] = digest((await github.objective(objective)).body);
  return bodyDigests;
}
/**
 * The queue with these Objectives added: new ones go last, one already queued keeps its place
 * and takes the freshly authorized body, one removed earlier is queued again.
 */
function queued(
  config: FactoryConfig,
  objectives: number[],
  bodyDigests: Record<string, string>,
  previous?: IntakeAuthorization,
): IntakeAuthorization {
  return {
    version: 1,
    repository: config.repository,
    configDigest: factoryConfigDigest(config),
    objectives: [
      ...(previous?.objectives ?? []),
      ...objectives.filter((id) => !previous?.objectives.includes(id)),
    ],
    bodyDigests: { ...previous?.bodyDigests, ...bodyDigests },
    dequeued: (previous?.dequeued ?? []).filter(
      (id) => !objectives.includes(id),
    ),
    mode: previous?.mode ?? "running",
    ...(previous?.watch ? { watch: true as const } : {}),
  };
}
/** `queue add`: handled by the service when it owns the installation, else under the ordinary lock. */
export async function enqueueIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
): Promise<IntakeAuthorization> {
  const reply = await requestControl(config.repository, {
    objective: 0,
    action: "enqueue",
    input: { objectives },
  });
  if (reply.handled) return reply.result as IntakeAuthorization;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  try {
    const bodyDigests = await authorizedBodies(config, github, objectives);
    const value = queued(config, objectives, bodyDigests, readIntake(config));
    saveIntake(config, value);
    return value;
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}
/** Mark the queue as served by the background service: what `factory setup --background` does. */
export async function watchIntake(
  config: FactoryConfig,
): Promise<IntakeAuthorization> {
  const reply = await requestControl(config.repository, {
    objective: 0,
    action: "watch",
  });
  if (reply.handled) return reply.result as IntakeAuthorization;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const path = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(path, 0);
  try {
    const value = watchRecord(config, readIntake(config));
    saveIntake(config, value);
    return value;
  } finally {
    releaseControllerLock(path, lock);
  }
}
function watchRecord(
  config: FactoryConfig,
  previous?: IntakeAuthorization,
): IntakeAuthorization {
  return {
    version: 1,
    repository: config.repository,
    configDigest: factoryConfigDigest(config),
    objectives: [],
    bodyDigests: {},
    dequeued: [],
    mode: "running",
    ...previous,
    watch: true,
  };
}

/** Conditional page receipts are transient observations. A restart performs fresh authenticated reads. */
export class IntakeObservation {
  private pages = new Map<number, IntakeIssuePage>();
  constructor(private readonly github: GitHubGateway) {}
  async scan(): Promise<
    Map<number, { labels: string[]; state: "open" | "closed" }>
  > {
    if (!this.github.intakePage)
      throw new Error(
        "GitHub gateway does not support conditional intake observations",
      );
    const issues = new Map<
      number,
      { labels: string[]; state: "open" | "closed" }
    >();
    for (let page = 1; ; page++) {
      const cached = this.pages.get(page);
      let observed = await this.github.intakePage(page, cached?.etag);
      if (observed.status === 304) {
        if (cached?.data) observed = cached;
        else observed = await this.github.intakePage(page);
      }
      if (observed.status !== 200 || !Array.isArray(observed.data))
        throw new Error("Conditional intake observation has no usable page");
      this.pages.set(page, observed);
      for (const issue of observed.data)
        if (issue.number > 0) issues.set(issue.number, issue);
      if (observed.data.length < 100) {
        for (const key of this.pages.keys())
          if (key > page) this.pages.delete(key);
        return issues;
      }
    }
  }
}

export async function intakeControl(
  config: FactoryConfig,
  action: "status" | "pause" | "resume" | "drain" | "dequeue",
  objective?: number,
): Promise<unknown> {
  let reply: Awaited<ReturnType<typeof requestControl>>;
  try {
    reply = await requestControl(config.repository, {
      objective: 0,
      action,
      input: objective ? { objective } : undefined,
    });
  } catch (error) {
    // A foreground run answers only for its Objective, but the queue can still be read.
    if (action !== "status" || !(error instanceof ForegroundControllerError))
      throw error;
    return {
      ...(readIntake(config) ?? { objectives: [], dequeued: [] }),
      activeObjective: error.objective,
    };
  }
  if (reply.handled) return reply.result;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const path = join(stateRoot(config.repository), "controller.lock"),
    lock = acquireControllerLock(path, 0);
  try {
    const record = readIntake(config);
    if (!record) {
      if (action === "status") return { objectives: [], dequeued: [] };
      throw new Error(
        "Nothing is queued; add Objectives with `factory queue add N`",
      );
    }
    applyControl(config, record, action, objective);
    if (["pause", "resume", "drain"].includes(action)) {
      for (const current of continuations(config).filter(
        (state) => !terminal(state),
      )) {
        if (current.coordinator) {
          current.coordinator.mode = record.mode;
          saveState(statePath(config.repository, current.objective), current);
        }
      }
    }
    return record;
  } finally {
    releaseControllerLock(path, lock);
  }
}
function applyControl(
  config: FactoryConfig,
  record: IntakeAuthorization,
  action: string,
  objective?: number,
): void {
  if (action === "dequeue") {
    if (!objective || !record.objectives.includes(objective))
      throw new Error(`Objective #${objective} is not in the queue`);
    const state = readContinuation(config.repository, objective);
    if (state && !terminal(state))
      throw new Error(
        `Objective #${objective} is running and cannot be removed; cancel it with \`factory cancel --objective ${objective}\``,
      );
    if (!record.dequeued.includes(objective)) record.dequeued.push(objective);
  } else if (action === "pause") record.mode = "paused";
  else if (action === "resume") record.mode = "running";
  else if (action === "drain" || action === "handoff") record.mode = "draining";
  else if (action !== "status") throw new Error("Unsupported queue action");
  if (action !== "status") saveIntake(config, record);
}

/** Restore only the unchanged, settled idle watch after supported artifact handoff. */
export function resumeWatcherAfterUpgrade(
  config: FactoryConfig,
  expected: IntakeAuthorization,
): boolean {
  const path = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(path, 0);
  try {
    const current = readIntake(config);
    const binding = (record: IntakeAuthorization) => {
      const { mode: _mode, observation: _observation, ...value } = record;
      return JSON.stringify(value);
    };
    if (
      !current?.watch ||
      !expected.watch ||
      expected.mode !== "running" ||
      current.mode !== "draining" ||
      binding(current) !== binding(expected) ||
      !intakeSettled(config)
    )
      return false;
    applyControl(config, current, "resume");
    return true;
  } finally {
    releaseControllerLock(path, lock);
  }
}

async function resolveBase(
  config: FactoryConfig,
  github: GitHubGateway,
  predecessors: number[],
  objective: number,
): Promise<string> {
  const head = await fetchHead(config.checkout, await github.defaultBranch());
  await planningPrerequisites(config, github, objective, head, predecessors);
  if (git(config.checkout, "status", "--porcelain"))
    throw new Error(
      "Compilation checkout has local changes; preserve them before intake",
    );
  await gitAsync(config.checkout, "merge", "--ff-only", head);
  if (git(config.checkout, "rev-parse", "HEAD") !== head)
    throw new Error(
      "Compilation checkout diverges from authenticated default head",
    );
  return head;
}

/** One installation owner, finite explicit authority, existing per-Objective continuations. */
export async function runIntake(
  config: FactoryConfig,
  services: ApplicationServices,
): Promise<IntakeAuthorization> {
  const initial = readIntake(config);
  if (!initial)
    throw new Error(
      "Nothing is queued; add Objectives with `factory queue add N`",
    );
  const record: IntakeAuthorization = initial;
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  const observations = new IntakeObservation(services.github);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  let activeObjective: number | undefined;
  let objectiveControl:
    | ((request: ControlRequest) => Promise<unknown>)
    | undefined;
  let handingOff = false;
  let wake: (() => void) | undefined;
  /**
   * When GitHub may answer again after a transient fault with a time (a
   * rate limit): the next observation waits until then (#641).
   */
  let heldUntil = 0;
  const holdFor = (error: unknown) => {
    const fault = attachedFault(error);
    const at =
      fault?.kind === "transient" && fault.retryAt
        ? Date.parse(fault.retryAt)
        : Number.NaN;
    if (Number.isFinite(at)) heldUntil = Math.max(heldUntil, at);
    return fault?.kind === "transient";
  };
  const onHandoff = () => {
    handingOff = true;
    record.mode = "draining";
    saveIntake(config, record);
    wake?.();
  };
  const closing = () => handingOff || record.mode === "draining";
  const handle = async (request: ControlRequest): Promise<unknown> => {
    if (request.objective === 0 && request.action === "status")
      return { ...record, activeObjective: activeObjective ?? null };
    if (
      request.objective === 0 &&
      ["enqueue", "watch"].includes(request.action)
    ) {
      if (closing()) throw new Error(DRAINING_REFUSAL);
      if (request.action === "enqueue") {
        // Authorized outside the loop, applied in one step: the loop sees the new Objectives next pass.
        const objectives = request.input?.objectives as number[];
        const bodyDigests = await authorizedBodies(
          config,
          services.github,
          objectives,
        );
        if (closing()) throw new Error(DRAINING_REFUSAL);
        Object.assign(record, queued(config, objectives, bodyDigests, record));
      } else Object.assign(record, watchRecord(config, record));
      saveIntake(config, record);
      wake?.();
      return record;
    }
    if (request.objective !== 0) {
      if (request.objective === activeObjective && objectiveControl)
        return objectiveControl(request);
      const preparing = readContinuation(config.repository, request.objective);
      if (
        request.action === "status" &&
        preparing?.objective === request.objective &&
        record.objectives.includes(request.objective)
      )
        return preparing.coordinator;
      if (
        preparing?.schemaVersion !== 8 ||
        preparing.objective !== request.objective ||
        !record.objectives.includes(request.objective)
      )
        throw new Error(
          `Objective #${request.objective} is not the one the service is running; \`factory queue list\` shows what is`,
        );
      if (request.action === "status") return preparing.coordinator;
      if (request.action === "cancel") {
        preparing.cancelRequested = true;
        preparing.coordinator.mode = "paused";
        preparing.coordinator.waitReason =
          "Planning cancellation requested; submitted outcomes remain preserved";
        saveState(statePath(config.repository, preparing.objective), preparing);
        record.mode = "paused";
        saveIntake(config, record);
        wake?.();
        return "requested";
      }
      if (!["pause", "resume", "drain", "handoff"].includes(request.action))
        throw new Error(
          "Preparation supports status, pause, resume, drain, handoff and cancellation",
        );
    }
    applyControl(
      config,
      record,
      request.action,
      Number(request.input?.objective) || undefined,
    );
    if (request.action === "handoff") handingOff = true;
    if (
      activeObjective &&
      objectiveControl &&
      ["pause", "resume", "drain", "handoff"].includes(request.action)
    )
      await objectiveControl({
        objective: activeObjective,
        action: request.action,
      });
    if (
      !objectiveControl &&
      ["pause", "resume", "drain", "handoff"].includes(request.action)
    ) {
      const preparing = continuations(config).find(
        (state): state is PreparationState =>
          state.schemaVersion === 8 && !terminal(state),
      );
      if (preparing) {
        preparing.coordinator.mode = record.mode;
        saveState(statePath(config.repository, preparing.objective), preparing);
      }
    }
    wake?.();
    return { ...record, activeObjective: activeObjective ?? null };
  };
  const serve = async () => {
    server = await serveControl(config.repository, lock, handle);
  };
  const closeServer = async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };
  process.on("SIGTERM", onHandoff);
  try {
    retargetControllerLock(lockPath, lock, 0);
    await serve();
    for (;;) {
      if (handingOff || record.mode === "draining") return record;
      const existing = continuations(config).filter(
        (state) => !terminal(state),
      );
      if (existing.length > 1)
        throw new Error(
          "Multiple nonterminal Objectives require ownership reconciliation",
        );
      const current = existing[0];
      if (current && !record.objectives.includes(current.objective))
        throw new Error("Active Objective is outside this intake selection");
      const reasons: Record<string, string> = {};
      let selected = current?.objective;
      if (record.mode === "running" && !selected) {
        const remaining = record.objectives.filter(
          (id) =>
            !record.dequeued.includes(id) &&
            !readContinuation(config.repository, id),
        );
        if (!remaining.length && !record.watch) return record;
        try {
          const scanned = await observations.scan();
          for (const id of remaining) {
            try {
              const issue = await services.github.objective(id);
              if (issue.state !== "open") {
                reasons[id] = "Issue is closed";
                continue;
              }
              if (digest(issue.body) !== record.bodyDigests[id]) {
                reasons[id] = "Issue body changed after authorization";
                continue;
              }
              if (!services.github.objectiveDependencies)
                throw new Error("GitHub dependency observation unavailable");
              const predecessors =
                await services.github.objectiveDependencies(id);
              const missing = predecessors.find((before) => {
                const state = readContinuation(config.repository, before);
                return (
                  state?.schemaVersion !== 7 ||
                  !objectiveComplete(state) ||
                  !state.finalAcceptance
                );
              });
              if (missing) {
                reasons[id] =
                  `Predecessor #${missing} has no accepted evidence`;
                continue;
              }
              await resolveBase(config, services.github, predecessors, id);
              selected = id;
              break;
            } catch (error) {
              holdFor(error);
              reasons[id] =
                `Observation or baseline unavailable: ${String(error)}`;
            }
          }
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            ...(record.watch
              ? {
                  unapproved: [...scanned.keys()].filter(
                    (id) => !record.objectives.includes(id),
                  ),
                  ...(!selected
                    ? {
                        idleReason: remaining.length
                          ? ("waiting-for-eligible-work" as const)
                          : ("awaiting-approved-work" as const),
                      }
                    : {}),
                }
              : {}),
          };
        } catch (error) {
          holdFor(error);
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            error: String(error),
          };
        }
        saveIntake(config, record);
      }
      if (selected && record.mode === "running") {
        let unavailable = false;
        activeObjective = selected;
        retargetControllerLock(lockPath, lock, selected);
        try {
          const state = readContinuation(config.repository, selected);
          if (state?.error || state?.cancelRequested)
            throw new Error(
              "Current Objective is failed or cancelling; explicit supported recovery is required",
            );
          if (!state || state.schemaVersion === 8) {
            const issue = await services.github
              .objective(selected)
              .catch((error: unknown) => {
                // GitHub cannot answer yet (a rate limit, an outage): nothing
                // has started, so observe again when it may, not pause (#641).
                if (!holdFor(error)) throw error;
                record.observation = {
                  at: new Date().toISOString(),
                  reasons,
                  error: String(error),
                };
                saveIntake(config, record);
                return undefined;
              });
            if (!issue) unavailable = true;
            else if (
              issue.state !== "open" ||
              digest(issue.body) !== record.bodyDigests[selected]
            )
              throw new Error("Selected Objective changed before compilation");
          }
          if (record.mode !== "running" || handingOff) continue;
          if (!unavailable) {
            const result = await runObjective(config, selected, services, {
              ownerLock: lock,
              observeControl: (handler) => {
                objectiveControl = handler;
              },
            });
            if (!terminal(result)) {
              // The queue stops on a human decision; status names the command, then `factory queue resume`.
              record.mode = "paused";
              record.observation = {
                at: new Date().toISOString(),
                reasons,
                needsDecision: selected,
                error: `Objective #${selected} needs a human decision: ${result.coordinator?.waitReason ?? "inspect its status"}`,
              };
              saveIntake(config, record);
              return record;
            }
          }
        } catch (error) {
          if (record.mode !== "running" || handingOff) {
            if (String(record.mode) === "draining" || handingOff) return record;
            continue;
          }
          if (error instanceof CoordinatorHandoff) {
            handingOff = true;
            return record;
          }
          record.mode = "paused";
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            error: String(error),
          };
          saveIntake(config, record);
          // Unknown/failed work remains in its existing snapshot; no automatic repeat.
          return record;
        } finally {
          objectiveControl = undefined;
          activeObjective = undefined;
          retargetControllerLock(lockPath, lock, 0);
        }
        // Unavailable: wait below for GitHub, as an idle observation does.
        if (!unavailable) continue;
      }
      const wait = Math.max(
        queuePollSeconds(config) * 1000,
        heldUntil - time.now(),
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, time.realDelay(wait));
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
  } finally {
    process.off("SIGTERM", onHandoff);
    await closeServer();
    releaseControllerLock(lockPath, lock);
  }
}
