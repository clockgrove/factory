import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecutionAuthority } from "./admission.js";
import { checkAuthority, bindAdmission } from "./admission.js";
import {
  factoryConfigDigest,
  stateRoot,
  type FactoryConfig,
} from "./config.js";
import type { GitHubGateway, IntakeIssuePage } from "./contracts.js";
import { objectiveComplete } from "./completion.js";
import {
  type ControlRequest,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { git, gitAsync } from "./process.js";
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
export interface IntakeAuthorization {
  version: 1;
  repository: string;
  configDigest: string;
  authority: ExecutionAuthority;
  bodyDigests: Record<string, string>;
  priorityLabels: string[];
  pollSeconds: number;
  dequeued: number[];
  mode: "running" | "paused" | "draining";
  observation?: { at: string; reasons: Record<string, string>; error?: string };
}
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const intakePath = (config: FactoryConfig) =>
  join(stateRoot(config.repository), "intake.json");
function saveIntake(config: FactoryConfig, value: IntakeAuthorization): void {
  const path = intakePath(config);
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
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
  for (const objective of value.authority.objectives) {
    checkAuthority(config, objective, value.authority);
    if (!/^[a-f0-9]{64}$/.test(value.bodyDigests[objective] ?? ""))
      throw new Error("Intake issue body binding is missing");
  }
  if (value.dequeued.some((id) => !value.authority.objectives.includes(id)))
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
    (state.schemaVersion === 2 && objectiveComplete(state))
  );
}
export async function enqueueIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  authority: ExecutionAuthority,
  options: { priorityLabels?: string[]; pollSeconds?: number } = {},
): Promise<IntakeAuthorization> {
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  try {
    if (continuations(config).some((state) => !terminal(state)))
      throw new Error(
        "An active Objective prevents replacing intake authority",
      );
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
      priorityLabels: options.priorityLabels ?? [],
      pollSeconds: options.pollSeconds ?? 30,
      dequeued: [],
      mode: "running",
    };
    if (
      !Number.isFinite(value.pollSeconds) ||
      value.pollSeconds <= 0 ||
      value.priorityLabels.some((label) => !label.trim())
    )
      throw new Error(
        "Intake polling interval and priority labels must be explicit valid values",
      );
    saveIntake(config, value);
    return value;
  } finally {
    releaseControllerLock(lockPath, lock);
  }
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
    if (!objective || !record.authority.objectives.includes(objective))
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

async function resolveBase(
  config: FactoryConfig,
  github: GitHubGateway,
  predecessors: number[],
): Promise<string> {
  await gitAsync(
    config.checkout,
    "fetch",
    "origin",
    await github.defaultBranch(),
  );
  const head = git(config.checkout, "rev-parse", "FETCH_HEAD");
  for (const objective of predecessors) {
    const previous = readContinuation(config.repository, objective);
    if (
      previous?.schemaVersion !== 2 ||
      !objectiveComplete(previous) ||
      !previous.finalAcceptance
    )
      throw new Error(
        `Predecessor #${objective} lacks bound accepted integration evidence`,
      );
    const remote = await github.objective(objective);
    if (digest(remote.body) !== previous.objectiveBodyDigest)
      throw new Error(
        `Predecessor #${objective} body changed after acceptance`,
      );
    await gitAsync(
      config.checkout,
      "merge-base",
      "--is-ancestor",
      previous.finalAcceptance.commit,
      head,
    );
  }
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
  const record = readIntake(config);
  if (!record) throw new Error("No intake authority registered");
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, 0);
  retargetControllerLock(lockPath, lock, 0);
  const observations = new IntakeObservation(services.github);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  let activeObjective: number | undefined;
  let preparation: PreparationState | undefined;
  let handingOff = false;
  let wake: (() => void) | undefined;
  const onHandoff = () => {
    handingOff = true;
    record.mode = "draining";
    saveIntake(config, record);
    wake?.();
  };
  const handle = async (request: ControlRequest): Promise<unknown> => {
    if (request.objective !== 0)
      throw new Error(
        "Use intake control while compilation or discovery owns this installation",
      );
    applyControl(
      config,
      record,
      request.action,
      Number(request.input?.objective) || undefined,
    );
    if (request.action === "handoff") handingOff = true;
    if (
      activeObjective &&
      !preparation &&
      ["pause", "resume", "drain", "handoff"].includes(request.action)
    )
      await requestControl(config.repository, {
        objective: activeObjective,
        action: request.action,
      });
    if (
      preparation &&
      ["pause", "resume", "drain", "handoff"].includes(request.action)
    ) {
      preparation.coordinator.mode = record.mode;
      saveState(
        statePath(config.repository, preparation.objective),
        preparation,
      );
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
      if (current && !record.authority.objectives.includes(current.objective))
        throw new Error("Active Objective is outside this intake authority");
      const reasons: Record<string, string> = {};
      let selected = current?.objective;
      if (record.mode === "running" && !selected) {
        const remaining = record.authority.objectives.filter(
          (id) =>
            !record.dequeued.includes(id) &&
            !readContinuation(config.repository, id),
        );
        if (!remaining.length) return record;
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
              record.authority.objectives.indexOf(left) -
                record.authority.objectives.indexOf(right)
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
                  state?.schemaVersion !== 2 ||
                  !objectiveComplete(state) ||
                  !state.finalAcceptance
                );
              });
              if (missing) {
                reasons[id] =
                  `Predecessor #${missing} has no accepted evidence`;
                continue;
              }
              await resolveBase(config, services.github, predecessors);
              selected = id;
              break;
            } catch (error) {
              reasons[id] =
                `Observation or baseline unavailable: ${String(error)}`;
            }
          }
          record.observation = { at: new Date().toISOString(), reasons };
        } catch (error) {
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            error: String(error),
          };
        }
        saveIntake(config, record);
      }
      if (selected && record.mode === "running") {
        activeObjective = selected;
        retargetControllerLock(lockPath, lock, selected);
        try {
          let state = readContinuation(config.repository, selected);
          let plan;
          let admission;
          if (!state || state.schemaVersion === 3) {
            const issue = await services.github.objective(selected);
            if (
              issue.state !== "open" ||
              digest(issue.body) !== record.bodyDigests[selected]
            )
              throw new Error("Selected Objective changed before compilation");
            // #250 supplies the internal durable planning/borrowed-owner seam.
            plan = await planObjective(
              config,
              selected,
              services,
              [],
              record.authority,
              {
                ownerLock: lock,
                observePreparation: (value: PreparationState) => {
                  preparation = value;
                },
                stopped: () => record.mode !== "running" || handingOff,
              },
            );
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
              record.authority,
            );
            state = readContinuation(config.repository, selected);
          }
          if (record.mode !== "running" || handingOff) continue;
          await closeServer();
          await runObjective(config, selected, services, plan, admission, {
            ownerLock: lock,
            intakeControl: handle,
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
          activeObjective = undefined;
          retargetControllerLock(lockPath, lock, 0);
          if (!server && !handingOff) await serve();
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
