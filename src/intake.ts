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
import type { ExecutionAuthority } from "./admission.js";
import {
  checkAuthority,
  bindAdmission,
  validateAuthority,
} from "./admission.js";
import {
  factoryConfigDigest,
  stateRoot,
  type FactoryConfig,
} from "./config.js";
import type { GitHubGateway, IntakeIssuePage } from "./contracts.js";
import { objectiveComplete } from "./completion.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import {
  type ControlRequest,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { git, gitAsync, withProcessCancellation } from "./process.js";
import {
  type ApplicationServices,
  planObjective,
  runObjective,
  CoordinatorHandoff,
} from "./runner.js";
import {
  acquireControllerLock,
  readContinuation,
  readControllerOwner,
  releaseControllerLock,
  retargetControllerLock,
  saveState,
  statePath,
  type ControllerLock,
} from "./state-store.js";
import type { PreparationState, ContinuationState } from "./state.js";

/** Authorization and idle control only. Pending order is derived, never copied into a queue. */
export interface IntakeServiceConsent {
  actor: string;
  reason: string;
  consent: true;
}
export interface IntakeOptions {
  priorityLabels?: string[];
  pollSeconds?: number;
  watch?: boolean;
}
export interface IntakeAuthorization {
  version: 1;
  repository: string;
  configDigest: string;
  authority?: ExecutionAuthority;
  watch?: true;
  serviceConsent?: IntakeServiceConsent;
  bodyDigests: Record<string, string>;
  priorityLabels: string[];
  pollSeconds: number;
  dequeued: number[];
  mode: "running" | "paused" | "draining";
  observation?: {
    at: string;
    reasons: Record<string, string>;
    error?: string;
    idleReason?: "awaiting-approved-work" | "waiting-for-eligible-work";
    unapproved?: number[];
  };
}
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
  if (!existsSync(intakePath(config))) return;
  const value = JSON.parse(
    readFileSync(intakePath(config), "utf8"),
  ) as IntakeAuthorization;
  if (
    value.version !== 1 ||
    value.repository !== config.repository ||
    value.configDigest !== factoryConfigDigest(config) ||
    !["running", "paused", "draining"].includes(value.mode) ||
    !Array.isArray(value.dequeued) ||
    !Array.isArray(value.priorityLabels) ||
    value.priorityLabels.some(
      (label) => typeof label !== "string" || !label.trim(),
    ) ||
    !Number.isFinite(value.pollSeconds) ||
    value.pollSeconds <= 0
  )
    throw new Error(
      "Intake authority differs from this installation or is invalid",
    );
  for (const key of Object.keys(value))
    if (
      ![
        "version",
        "repository",
        "configDigest",
        "authority",
        "watch",
        "serviceConsent",
        "bodyDigests",
        "priorityLabels",
        "pollSeconds",
        "dequeued",
        "mode",
        "observation",
      ].includes(key)
    )
      throw new Error(
        `Unsupported intake authorization field ${key}; compatibility refused`,
      );
  if (value.watch !== undefined && value.watch !== true)
    throw new Error("Invalid continuous intake selection");
  if (value.serviceConsent !== undefined)
    validateServiceConsent(value.serviceConsent);
  if (!value.authority && (!value.watch || !intakeServiceConsent(value)))
    throw new Error(
      "Observation-only intake requires explicit watch and service consent",
    );
  if (value.watch && !intakeServiceConsent(value))
    throw new Error("Continuous watch requires explicit service consent");
  if (value.authority) validateAuthority(value.authority);
  for (const objective of value.authority?.objectives ?? []) {
    checkAuthority(config, objective, value.authority!);
    if (!/^[a-f0-9]{64}$/.test(value.bodyDigests[objective] ?? ""))
      throw new Error("Intake issue body binding is missing");
  }
  if (
    value.dequeued.some(
      (id) => !(value.authority?.objectives ?? []).includes(id),
    )
  )
    throw new Error("Invalid revoked Objective authorization");
  return value;
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
    (state.schemaVersion === 4 && objectiveComplete(state))
  );
}
export function intakeComplete(
  config: FactoryConfig,
  record: IntakeAuthorization,
): boolean {
  return (record.authority?.objectives ?? []).every((id) => {
    if (record.dequeued.includes(id)) return true;
    const state = readContinuation(config.repository, id);
    return !!state && terminal(state);
  });
}
function validateServiceConsent(consent: IntakeServiceConsent): void {
  if (
    !consent ||
    consent.consent !== true ||
    typeof consent.actor !== "string" ||
    !consent.actor.trim() ||
    typeof consent.reason !== "string" ||
    !consent.reason.trim() ||
    Object.keys(consent).some(
      (key) => !["actor", "reason", "consent"].includes(key),
    )
  )
    throw new Error(
      "Watcher requires explicit service consent, actor and reason",
    );
}
export function intakeServiceConsent(record: IntakeAuthorization): boolean {
  return (
    record.authority?.serviceConsent === true ||
    record.serviceConsent?.consent === true
  );
}
export function intakeSettled(config: FactoryConfig): boolean {
  return continuations(config).every(terminal);
}
function settledRefill(config: FactoryConfig): void {
  if (!intakeSettled(config))
    throw new Error("An active Objective prevents replacing intake authority");
}
async function bindIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  authority: ExecutionAuthority,
  options: IntakeOptions,
  previous?: IntakeAuthorization,
): Promise<IntakeAuthorization> {
  settledRefill(config);
  validateAuthority(authority);
  if (
    (options.watch ?? previous?.watch) &&
    !authority.serviceConsent &&
    !previous?.serviceConsent
  )
    throw new Error("Continuous watch requires explicit service consent");
  const bodyDigests: Record<string, string> = {};
  for (const objective of authority.objectives) {
    checkAuthority(config, objective, authority);
    bodyDigests[objective] = digest((await github.objective(objective)).body);
  }
  const value: IntakeAuthorization = {
    version: 1,
    repository: config.repository,
    configDigest: factoryConfigDigest(config),
    authority: structuredClone(authority),
    bodyDigests,
    priorityLabels: options.priorityLabels ?? previous?.priorityLabels ?? [],
    pollSeconds: options.pollSeconds ?? previous?.pollSeconds ?? 30,
    dequeued: [],
    mode: previous?.mode ?? "running",
    ...((options.watch ?? previous?.watch) ? { watch: true as const } : {}),
    ...(previous?.serviceConsent
      ? { serviceConsent: previous.serviceConsent }
      : {}),
  };
  if (
    !Number.isFinite(value.pollSeconds) ||
    value.pollSeconds <= 0 ||
    value.priorityLabels.some(
      (label) => typeof label !== "string" || !label.trim(),
    )
  )
    throw new Error(
      "Intake polling interval and priority labels must be explicit valid values",
    );
  return value;
}
/** Refill is handled by the current owner, or by the ordinary lock when stopped. */
export async function enqueueIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  authority: ExecutionAuthority,
  options: IntakeOptions = {},
): Promise<IntakeAuthorization> {
  const reply = await requestControl(config.repository, {
    objective: 0,
    action: "enqueue",
    input: { authority, options },
  });
  if (reply.handled) return reply.result as IntakeAuthorization;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  try {
    const value = await bindIntake(
      config,
      github,
      authority,
      options,
      readIntake(config),
    );
    saveIntake(config, value);
    return value;
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}
export async function watchIntake(
  config: FactoryConfig,
  consent: IntakeServiceConsent,
  options: Pick<IntakeOptions, "pollSeconds"> = {},
): Promise<IntakeAuthorization> {
  validateServiceConsent(consent);
  const reply = await requestControl(config.repository, {
    objective: 0,
    action: "watch",
    input: { consent, options },
  });
  if (reply.handled) return reply.result as IntakeAuthorization;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const path = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(path, 0);
  try {
    const previous = readIntake(config);
    settledRefill(config);
    const value = watchRecord(config, consent, options, previous);
    saveIntake(config, value);
    return value;
  } finally {
    releaseControllerLock(path, lock);
  }
}
function watchRecord(
  config: FactoryConfig,
  consent: IntakeServiceConsent,
  options: Pick<IntakeOptions, "pollSeconds">,
  previous?: IntakeAuthorization,
): IntakeAuthorization {
  validateServiceConsent(consent);
  const pollSeconds = options.pollSeconds ?? previous?.pollSeconds ?? 30;
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0)
    throw new Error("Intake polling interval must be a positive number");
  return {
    version: 1,
    repository: config.repository,
    configDigest: factoryConfigDigest(config),
    bodyDigests: {},
    priorityLabels: [],
    dequeued: [],
    mode: "running",
    ...previous,
    watch: true,
    serviceConsent: structuredClone(consent),
    pollSeconds,
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
  const reply = await requestControl(config.repository, {
    objective: 0,
    action,
    input: objective ? { objective } : undefined,
  });
  if (reply.handled) return reply.result;
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const path = join(stateRoot(config.repository), "controller.lock"),
    lock = acquireControllerLock(path, 0);
  try {
    const record = readIntake(config);
    if (!record) throw new Error("No intake authority registered");
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
    if (!objective || !(record.authority?.objectives ?? []).includes(objective))
      throw new Error("Objective is outside intake authority");
    const state = readContinuation(config.repository, objective);
    if (state && !terminal(state))
      throw new Error(
        "An active Objective cannot be dequeued; pause or cancel its owned work",
      );
    if (!record.dequeued.includes(objective)) record.dequeued.push(objective);
  } else if (action === "pause") record.mode = "paused";
  else if (action === "resume") record.mode = "running";
  else if (action === "drain" || action === "handoff") record.mode = "draining";
  else if (action !== "status")
    throw new Error("Unsupported intake control action");
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
  await gitAsync(
    config.checkout,
    "fetch",
    "origin",
    await github.defaultBranch(),
  );
  const head = git(config.checkout, "rev-parse", "FETCH_HEAD");
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
  if (!initial) throw new Error("No intake authority registered");
  let record: IntakeAuthorization = initial;
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  const observations = new IntakeObservation(services.github);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  let activeObjective: number | undefined;
  let objectiveControl:
    | ((request: ControlRequest) => Promise<unknown>)
    | undefined;
  let preparation: PreparationState | undefined;
  let planningAbort: AbortController | undefined;
  let handingOff = false;
  let observing = false;
  let refilling = false;
  let wake: (() => void) | undefined;
  const onHandoff = () => {
    handingOff = true;
    record.mode = "draining";
    saveIntake(config, record);
    wake?.();
  };
  const handle = async (request: ControlRequest): Promise<unknown> => {
    if (request.objective === 0 && request.action === "status")
      return { ...record, activeObjective: activeObjective ?? null };
    if (
      request.objective === 0 &&
      ["enqueue", "watch"].includes(request.action)
    ) {
      if (activeObjective || observing || refilling || handingOff)
        throw new Error(
          "Intake is not at a settled refill boundary; inspect status and retry after observation settles",
        );
      settledRefill(config);
      refilling = true;
      try {
        const next =
          request.action === "enqueue"
            ? await bindIntake(
                config,
                services.github,
                request.input?.authority as ExecutionAuthority,
                (request.input?.options ?? {}) as IntakeOptions,
                record,
              )
            : watchRecord(
                config,
                request.input?.consent as IntakeServiceConsent,
                (request.input?.options ?? {}) as IntakeOptions,
                record,
              );
        if (handingOff || record.mode === "draining")
          throw new Error("Intake handoff prevents replacing authorization");
        saveIntake(config, next);
        record = next;
      } finally {
        refilling = false;
        wake?.();
      }
      return record;
    }
    if (request.objective !== 0) {
      if (request.objective === activeObjective && objectiveControl)
        return objectiveControl(request);
      const preparing =
        preparation ?? readContinuation(config.repository, request.objective);
      if (
        request.action === "status" &&
        preparing?.objective === request.objective &&
        (record.authority?.objectives ?? []).includes(request.objective)
      )
        return preparing.coordinator;
      if (
        preparing?.schemaVersion !== 5 ||
        preparing.objective !== request.objective ||
        !(record.authority?.objectives ?? []).includes(request.objective)
      )
        throw new Error(
          "Use intake control while discovery owns this installation",
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
        planningAbort?.abort();
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
    if (["pause", "resume", "drain", "handoff"].includes(request.action)) {
      const preparing =
        preparation ??
        continuations(config).find(
          (state): state is PreparationState =>
            state.schemaVersion === 5 && !terminal(state),
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
      if (
        current &&
        !(record.authority?.objectives ?? []).includes(current.objective)
      )
        throw new Error("Active Objective is outside this intake authority");
      const reasons: Record<string, string> = {};
      let selected = current?.objective;
      if (record.mode === "running" && !selected && !refilling) {
        const remaining = (record.authority?.objectives ?? []).filter(
          (id) =>
            !record.dequeued.includes(id) &&
            !readContinuation(config.repository, id),
        );
        if (!remaining.length && !record.watch) return record;
        observing = true;
        try {
          const scanned = await observations.scan();
          const ranked = [...remaining].sort((left, right) => {
            const rank = (id: number) => {
              const labels = scanned.get(id)?.labels ?? [];
              const index = record.priorityLabels.findIndex((label) =>
                labels.includes(label),
              );
              return index < 0 ? record.priorityLabels.length : index;
            };
            return (
              rank(left) - rank(right) ||
              (record.authority?.objectives ?? []).indexOf(left) -
                (record.authority?.objectives ?? []).indexOf(right)
            );
          });
          for (const id of ranked) {
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
                  state?.schemaVersion !== 4 ||
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
                    (id) => !(record.authority?.objectives ?? []).includes(id),
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
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            error: String(error),
          };
        } finally {
          observing = false;
        }
        saveIntake(config, record);
      }
      if (selected && record.mode === "running" && !refilling) {
        activeObjective = selected;
        retargetControllerLock(lockPath, lock, selected);
        try {
          let state = readContinuation(config.repository, selected);
          if (state?.error || state?.cancelRequested)
            throw new Error(
              "Current Objective is failed or cancelling; explicit supported recovery is required",
            );
          let plan;
          let admission;
          if (!state || state.schemaVersion === 5) {
            const issue = await services.github.objective(selected);
            if (
              issue.state !== "open" ||
              digest(issue.body) !== record.bodyDigests[selected]
            )
              throw new Error("Selected Objective changed before compilation");
            // #250 supplies the internal durable planning/borrowed-owner seam.
            planningAbort = new AbortController();
            plan = await withProcessCancellation(planningAbort.signal, () =>
              planObjective(
                config,
                selected!,
                services,
                [],
                record.authority!,
                {
                  ownerLock: lock,
                  observePreparation: (value: PreparationState) => {
                    preparation = value;
                  },
                  stopped: () =>
                    record.mode !== "running" ||
                    handingOff ||
                    !!preparation?.cancelRequested,
                },
              ),
            );
            planningAbort = undefined;
            preparation = undefined;
            if (!["clean", "human-accepted"].includes(plan.review.status))
              throw new Error(
                "Compiled plan awaits independent acceptance; stop intake for an explicit plan decision",
              );
            admission = bindAdmission(
              config,
              selected,
              issue.body,
              plan.baseSha,
              plan,
              record.authority!,
            );
            state = readContinuation(config.repository, selected);
          }
          if (record.mode !== "running" || handingOff) continue;
          await runObjective(config, selected, services, plan, admission, {
            ownerLock: lock,
            observeControl: (handler) => {
              objectiveControl = handler;
            },
          });
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
          preparation = undefined;
          planningAbort = undefined;
          objectiveControl = undefined;
          activeObjective = undefined;
          retargetControllerLock(lockPath, lock, 0);
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, record.pollSeconds * 1000);
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
