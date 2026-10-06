import { createHash } from "node:crypto";
import { refuseUnknownFields } from "./unknown-fields.js";
import type { FactoryConfig } from "./config.js";
import type { AllowanceConsumption } from "./graph-amendments.js";
import type { FactoryState, WorkState } from "./state.js";

export const repairClasses = [
  "implementation",
  "planning-output",
  "planning-evidence",
  "planning-choice",
] as const;
export type RepairClass = (typeof repairClasses)[number];
export interface RepairPolicy {
  perPath: AllowanceConsumption;
}
/** Limits on unattended work; each Objective snapshots them when it starts. */
export interface Autonomy {
  allowances: AllowanceConsumption;
  repairClasses: RepairClass[];
  repairPolicy: RepairPolicy;
  /** Worker secrets checked before planning; each must also be in policy.allowedSecretNames. */
  requiredEnvironment: string[];
}
/** The optional config.json `autonomy` section; omitted fields keep the bounded defaults. */
export type AutonomyConfig = Partial<
  Omit<Autonomy, "allowances" | "repairPolicy">
> & {
  allowances?: Partial<AllowanceConsumption>;
  repairPolicy?: { perPath?: Partial<AllowanceConsumption> };
};
export const defaultAutonomy: Autonomy = {
  allowances: {
    planningRevisions: 1,
    implementationRepairs: 2,
    resultRereviews: 1,
  },
  repairClasses: [...repairClasses],
  repairPolicy: {
    perPath: {
      planningRevisions: 1,
      implementationRepairs: 1,
      resultRereviews: 1,
    },
  },
  requiredEnvironment: [],
};
const allowanceKeys = [
  "planningRevisions",
  "implementationRepairs",
  "resultRereviews",
] as const;
function onlyKeys(value: object, names: readonly string[], label: string) {
  refuseUnknownFields(value as Record<string, unknown>, names, label);
}
function assertAllowances(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  onlyKeys(value, allowanceKeys, label);
  for (const key of allowanceKeys) {
    const amount = (value as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(amount) || (amount as number) < 0)
      throw new Error(`${label}.${key} must be a nonnegative integer`);
  }
}
export function validateAutonomy(value: Autonomy): Autonomy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("autonomy must be an object");
  onlyKeys(
    value,
    ["allowances", "repairClasses", "repairPolicy", "requiredEnvironment"],
    "autonomy",
  );
  assertAllowances(value.allowances, "autonomy.allowances");
  if (!value.repairPolicy || typeof value.repairPolicy !== "object")
    throw new Error("autonomy.repairPolicy must be an object");
  onlyKeys(value.repairPolicy, ["perPath"], "autonomy.repairPolicy");
  assertAllowances(value.repairPolicy.perPath, "autonomy.repairPolicy.perPath");
  if (Array.isArray(value.repairClasses))
    for (const kind of value.repairClasses)
      if (legacyClasses.includes(kind))
        throw new Error(
          `autonomy.repairClasses lists ${kind}, which Factory no longer has: remove it from the configuration, or start an Objective that snapshotted it fresh`,
        );
  if (
    !Array.isArray(value.repairClasses) ||
    value.repairClasses.some((kind) => !repairClasses.includes(kind))
  )
    throw new Error("autonomy.repairClasses has unsupported repair classes");
  if (
    !Array.isArray(value.requiredEnvironment) ||
    value.requiredEnvironment.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    )
  )
    throw new Error("autonomy.requiredEnvironment must list variable names");
  return value;
}
/** Fill omitted fields of the config section with the bounded defaults. */
export function resolveAutonomy(section: AutonomyConfig = {}): Autonomy {
  if (!section || typeof section !== "object" || Array.isArray(section))
    throw new Error("autonomy must be an object");
  return validateAutonomy({
    ...section,
    allowances: { ...defaultAutonomy.allowances, ...section.allowances },
    repairClasses: [
      ...(section.repairClasses ?? defaultAutonomy.repairClasses),
    ],
    repairPolicy: {
      ...section.repairPolicy,
      perPath: {
        ...defaultAutonomy.repairPolicy.perPath,
        ...section.repairPolicy?.perPath,
      },
    },
    requiredEnvironment: [
      ...(section.requiredEnvironment ?? defaultAutonomy.requiredEnvironment),
    ],
  });
}
/**
 * Required worker secrets must be allowed and present before any model is called. A started
 * Objective names them from its snapshot; presence is always checked live.
 */
export function checkRequiredEnvironment(
  config: FactoryConfig,
  autonomy: Autonomy = resolveAutonomy(config.autonomy),
): void {
  for (const name of autonomy.requiredEnvironment) {
    if (!config.policy.allowedSecretNames.includes(name))
      throw new Error(
        `Required environment ${name} is not in policy.allowedSecretNames`,
      );
    if (!process.env[name])
      throw new Error(
        `Required environment ${name} is unavailable; provide it before running`,
      );
  }
}
type Allowance = keyof AllowanceConsumption;
/** One charged failure event: the allowances its corrections used and the scopes they count against. */
export interface Charge {
  allowances: Allowance[];
  scopes: string[];
}
export interface RepairLedger {
  autonomy: Autonomy;
  /**
   * Charged failure events. Consumption is derived from them, so repeating
   * an event (restart, interruption, lost response) never charges twice.
   */
  charges?: Record<string, Charge>;
}
/** Paid calls (planning diagnoses) asked per failure event before the operator decides. */
export const PAID_ATTEMPTS = 3;
/**
 * What a failed attempt was: a repair class for a wrong result, else the
 * kind of fault that ended it.
 */
export type FailureClass =
  | RepairClass
  | Exclude<import("./fault.js").FaultKind, "work">;
const failureClasses: readonly string[] = [
  ...repairClasses,
  "transient",
  "decision",
  "config",
  "defect",
  "cancelled",
];
/** Classes and repair kinds earlier Factory versions persisted; never migrated. */
const legacyClasses: readonly string[] = [
  "interruption",
  "authority",
  "uncertain",
  "review-evidence",
  // A validation environment fault waits for the fix; `factory retry` then
  // validates again (step rule 7), so it needs no repair class.
  "validation-environment",
];
const startFresh = (what: string) =>
  `State records ${what} from an earlier Factory version; start the Objective fresh`;
export interface FailureDisposition {
  digest: string;
  /** Optional canonical failed-validation capture; absence never supplies receipts. */
  validationCaptureDigest?: string;
  /**
   * The failure event a correction charges. Only a wrong result has one; a
   * transient or configuration failure is never charged.
   */
  event?: string;
  classification: FailureClass;
  detail: string;
  at: string;
  continuation: "new-attempt-from-accepted-base" | "operator-decision";
  unfinishedEdits: "removed" | "unavailable";
  decision: string;
  /**
   * The integrated predecessor whose delivered file caused the failure
   * (src/work-repair.ts). Only a decision about that predecessor names one.
   */
  predecessor?: {
    item: string;
    path: string;
    pullRequest?: number;
    /** The model's diagnosis, capped; quoted in the decision. */
    diagnosis: string;
    /** The graph the blame was made on: a different one means an amendment landed. */
    graphDigest: string;
  };
}
export interface RepairCorrection {
  failureDigest: string;
  /** The failure event it was admitted for; the controller sets it. */
  event?: string;
  kind: RepairClass;
  diagnosis: string;
  correction: string;
  actor: string;
}
export interface WorkRecovery {
  failure?: FailureDisposition;
  correction?: RepairCorrection;
  phase?: "diagnosing" | "ready" | "stopped";
  scopes?: string[];
  history?: {
    at: string;
    work: Omit<WorkState, "recovery">;
    failure?: FailureDisposition;
    correction?: RepairCorrection;
  }[];
}
const emptyConsumption = (): AllowanceConsumption => ({
  planningRevisions: 0,
  implementationRepairs: 0,
  resultRereviews: 0,
});
export const failureDigest = (detail: string): string =>
  createHash("sha256").update(detail).digest("hex");
export function allowanceKey(kind: RepairClass): keyof AllowanceConsumption {
  return kind.startsWith("planning-")
    ? "planningRevisions"
    : "implementationRepairs";
}
/** Failure event of a Work Item step; `round` counts the item's earlier attempts. */
export const itemEvent = (item: string, step: string, round: number) =>
  `item/${item}/${step}/${round}`;
/** Failure event of an Objective step: a plan revision round or an amendment id. */
export const objectiveEvent = (step: string, round: number | string) =>
  `objective/${step}/${round}`;
const EVENT =
  /^(objective|item\/[A-Za-z0-9][A-Za-z0-9_-]*)\/[a-z][a-z-]*\/[A-Za-z0-9_-]+$/;
/** Failure classes that are wrong results; only their failures carry an event. */
const CHARGED: readonly string[] = ["implementation"];

/** Consumption derived from the charged events, Objective-wide or for one scope. */
export function consumption(
  state: RepairLedger,
  scope?: string,
): AllowanceConsumption {
  const total = emptyConsumption();
  for (const charge of Object.values(state.charges ?? {}))
    if (scope === undefined || charge.scopes.includes(scope))
      for (const allowance of charge.allowances) total[allowance]++;
  return total;
}
/** Per-path limits cap Work Item scopes; planning is one Objective-wide scope under its allowance. */
function scopeLimit(autonomy: Autonomy, scope: string, key: Allowance): number {
  return scope === "$planning"
    ? autonomy.allowances[key]
    : autonomy.repairPolicy.perPath[key];
}
/** What is left of each allowance, Objective-wide and for each scope. */
export function remaining(
  state: RepairLedger,
  scopes: string[],
): {
  objective: AllowanceConsumption;
  paths: Record<string, AllowanceConsumption>;
} {
  const left = (scope?: string): AllowanceConsumption => {
    const used = consumption(state, scope);
    const result = emptyConsumption();
    for (const key of allowanceKeys)
      result[key] =
        (scope === undefined
          ? state.autonomy.allowances[key]
          : scopeLimit(state.autonomy, scope, key)) - used[key];
    return result;
  };
  return {
    objective: left(),
    paths: Object.fromEntries(scopes.map((scope) => [scope, left(scope)])),
  };
}
const charged = (state: RepairLedger, event: string, key: Allowance) =>
  Boolean(state.charges?.[event]?.allowances.includes(key));
/** Why one more charge does not fit, or undefined when it does. */
function exhausted(
  state: RepairLedger,
  key: Allowance,
  scopes: string[],
): string | undefined {
  if (consumption(state)[key] >= state.autonomy.allowances[key])
    return `Objective ${key} allowance exhausted`;
  for (const scope of scopes)
    if (
      consumption(state, scope)[key] >= scopeLimit(state.autonomy, scope, key)
    )
      return `Repair path ${scope} ${key} allowance exhausted`;
  return undefined;
}
/** Whether `event` already used `key`, or one more charge fits every limit. */
export function allowanceAvailable(
  state: RepairLedger,
  event: string,
  key: Allowance,
  scopes: string[],
): boolean {
  return charged(state, event, key) || !exhausted(state, key, scopes);
}
/**
 * Whether `factory repair` (a charge of `event` against implementationRepairs)
 * would be accepted: implementation repair is enabled and an allowance fits.
 * Status and the recorded decision name `factory repair` only then.
 */
export function implementationRepairable(
  state: RepairLedger,
  event: string,
  scopes: string[],
): boolean {
  return (
    state.autonomy.repairClasses.includes("implementation") &&
    allowanceAvailable(state, event, "implementationRepairs", scopes)
  );
}
/** Whether one more amendment (one planning revision) fits the limit the Objective recorded. */
export function amendmentAllowed(state: RepairLedger): boolean {
  return allowanceAvailable(
    state,
    objectiveEvent("amend", "new"),
    "planningRevisions",
    ["$planning"],
  );
}
/**
 * What works once amendments are not allowed. Limits are recorded when an
 * Objective starts, so a higher limit in the config reaches only an Objective
 * started after it.
 */
export const amendmentsUsedUp = (objective: number): string =>
  `The Objective's planningRevisions allowance is used up, so it cannot take an amendment. Limits are recorded when an Objective starts: a higher autonomy.allowances.planningRevisions in the config applies to a new Objective only. Run \`factory cancel --objective ${objective}\`, raise the limit, then start a new Objective`;
/**
 * Charge one failure event against `key`. Repeating it is free; a correction
 * of another kind for the same event charges its own allowance. A charge
 * that does not fit throws, which stops for an operator decision.
 */
export function charge(
  state: RepairLedger,
  event: string,
  key: Allowance,
  scopes: string[],
): void {
  if (charged(state, event, key)) return;
  if (!EVENT.test(event)) throw new Error(`Invalid failure event ${event}`);
  if (!scopes.length || scopes.some((scope) => !scope))
    throw new Error("Repair needs an inherited scope");
  const prior = state.charges?.[event];
  const unique = prior?.scopes ?? [...new Set(scopes)].sort();
  const reason = exhausted(state, key, unique);
  if (reason) throw new Error(reason);
  state.charges = {
    ...state.charges,
    [event]: {
      allowances: [...(prior?.allowances ?? []), key],
      scopes: unique,
    },
  };
}
/**
 * Give back the implementation repair a failure event used: no correction was
 * made for it. Any other allowance the event holds stays charged.
 */
export function releaseCharge(state: RepairLedger, event: string): void {
  const held = state.charges?.[event];
  if (!held) return;
  const { [event]: _released, ...others } = state.charges!;
  const allowances = held.allowances.filter(
    (key) => key !== "implementationRepairs",
  );
  state.charges = allowances.length
    ? { ...others, [event]: { ...held, allowances } }
    : others;
}
/** Corrections of `kind` must be enabled for this Objective. */
export function assertRepairClass(
  state: RepairLedger,
  kind: RepairClass,
): void {
  if (!state.autonomy.repairClasses.includes(kind))
    throw new Error(
      `Repair class ${kind} is not enabled; operator decision required`,
    );
}
/**
 * Admit a correction of `kind` and charge its failure event. A failure
 * without an event (not a wrong result) is corrected without a charge.
 */
export function chargeRepair(
  state: RepairLedger,
  event: string | undefined,
  kind: RepairClass,
  scopes: string[],
): void {
  assertRepairClass(state, kind);
  if (event) charge(state, event, allowanceKey(kind), scopes);
}
/** Original identities remain the scope even when a parent becomes an aggregate. */
export function repairScopes(state: FactoryState, id: string): string[] {
  const existing = state.work[id]?.recovery?.scopes;
  if (existing) return existing;
  const initial = state.graphRevisions?.[0]?.graph ?? state.graph;
  const roots = new Set(initial.items.map((item) => item.id));
  const visited = new Set<string>();
  const scopes = new Set<string>();
  const visit = (current: string): void => {
    if (visited.has(current)) return;
    visited.add(current);
    if (roots.has(current)) scopes.add(current);
    for (const parent of state.graph.items.filter((item) =>
      item.children?.includes(current),
    ))
      visit(parent.id);
  };
  visit(id);
  return scopes.size ? [...scopes].sort() : ["$objective"];
}
/** Commits earlier attempts of this Work Item produced, oldest first. */
export function earlierHeads(work: WorkState): string[] {
  return (work.recovery?.history ?? []).flatMap((attempt) =>
    attempt.work.changeRef ? [attempt.work.changeRef] : [],
  );
}
export function archiveAttempt(work: WorkState): WorkRecovery {
  const recovery = work.recovery ?? {};
  const { recovery: _old, ...attempt } = work;
  return {
    ...recovery,
    history: [
      ...(recovery.history ?? []),
      {
        at: new Date().toISOString(),
        work: structuredClone(attempt),
        ...(recovery.failure
          ? { failure: structuredClone(recovery.failure) }
          : {}),
        ...(recovery.correction
          ? { correction: structuredClone(recovery.correction) }
          : {}),
      },
    ],
  };
}
export function validateCorrection(
  work: WorkState,
  correction: RepairCorrection,
): void {
  if (
    !work.recovery?.failure ||
    correction.failureDigest !== work.recovery.failure.digest
  )
    throw new Error("Correction does not bind the current failure");
  if (
    ![correction.actor, correction.diagnosis, correction.correction].every(
      (text) => typeof text === "string" && text.trim(),
    )
  )
    throw new Error("Concrete diagnosis, correction and actor are required");
  if (
    work.recovery.phase === "stopped" &&
    work.recovery.correction?.failureDigest === correction.failureDigest &&
    work.recovery.correction.correction === correction.correction
  )
    throw new Error("Unchanged failed correction cannot be repeated");
  if (
    work.recovery.history?.some(
      (prior) =>
        prior.failure?.digest === correction.failureDigest &&
        prior.correction?.correction === correction.correction,
    )
  )
    throw new Error("Unchanged failed correction cannot be repeated");
}

/** Persisted allowance and continuation data is validated before it can authorize effects. */
export function assertRepairLedger(
  state: RepairLedger & {
    planningRecovery?: unknown;
    work?: Record<string, WorkState>;
  },
): void {
  const autonomy = validateAutonomy(state.autonomy);
  // Earlier versions kept counters; refuse rather than silently reset them.
  for (const legacy of ["allowanceConsumption", "repairConsumption"])
    if (Object.hasOwn(state, legacy))
      throw new Error(
        `State records ${legacy} from an earlier Factory version; start the Objective fresh`,
      );
  if (state.charges !== undefined) {
    if (
      !state.charges ||
      typeof state.charges !== "object" ||
      Array.isArray(state.charges)
    )
      throw new Error("Invalid persisted repair charges");
    const scopes = new Set<string>();
    for (const [event, charge] of Object.entries(state.charges)) {
      if (
        !EVENT.test(event) ||
        !charge ||
        typeof charge !== "object" ||
        Object.keys(charge).sort().join(",") !== "allowances,scopes" ||
        !Array.isArray(charge.allowances) ||
        !charge.allowances.length ||
        new Set(charge.allowances).size !== charge.allowances.length ||
        charge.allowances.some((key) => !allowanceKeys.includes(key)) ||
        !Array.isArray(charge.scopes) ||
        !charge.scopes.length ||
        charge.scopes.some((scope) => typeof scope !== "string" || !scope)
      )
        throw new Error(`Invalid persisted repair charge ${event}`);
      for (const scope of charge.scopes) scopes.add(scope);
    }
    const total = consumption(state);
    for (const key of allowanceKeys) {
      if (total[key] > autonomy.allowances[key])
        throw new Error("Repair charges exceed the bound allowance");
      for (const scope of scopes)
        if (consumption(state, scope)[key] > scopeLimit(autonomy, scope, key))
          throw new Error("Repair path charges exceed the bound allowance");
    }
  }
  // A wrong result names its event, and every correction admitted for it
  // (or a diagnosis under way) was charged.
  const assertCharged = (
    failure: FailureDisposition | undefined,
    key: Allowance | undefined,
  ): void => {
    if (!failure) return;
    if (legacyClasses.includes(failure.classification))
      throw new Error(startFresh(`a ${failure.classification} failure`));
    if (!failureClasses.includes(failure.classification))
      throw new Error("Invalid failure classification");
    if ((failure.continuation as string) === "exact-candidate-revalidation")
      throw new Error(startFresh("an exact-candidate revalidation"));
    if (CHARGED.includes(failure.classification) !== Boolean(failure.event))
      throw new Error("Failure event does not match its classification");
    if (
      failure.event &&
      key &&
      !state.charges?.[failure.event]?.allowances.includes(key)
    )
      throw new Error(`Failure event ${failure.event} lacks its charge`);
  };
  for (const work of Object.values(state.work ?? {})) {
    const recovery = work.recovery;
    if (!recovery) continue;
    for (const correction of [
      recovery.correction,
      ...(Array.isArray(recovery.history) ? recovery.history : []).map(
        (entry) => entry.correction,
      ),
    ])
      if (correction && legacyClasses.includes(correction.kind))
        throw new Error(startFresh(`a ${correction.kind} correction`));
    // A record pairs a failure with the correction admitted for it, bound by
    // the failure's event.
    const bound = (
      failure: FailureDisposition | undefined,
      correction: RepairCorrection | undefined,
    ): Allowance | undefined => {
      if (!correction) return undefined;
      if (correction.event !== failure?.event)
        throw new Error("Correction is not bound to its failure event");
      return correction.event ? allowanceKey(correction.kind) : undefined;
    };
    assertCharged(
      recovery.failure,
      recovery.phase === "diagnosing"
        ? "implementationRepairs"
        : recovery.phase === "ready"
          ? bound(recovery.failure, recovery.correction)
          : undefined,
    );
    for (const entry of Array.isArray(recovery.history) ? recovery.history : [])
      assertCharged(entry.failure, bound(entry.failure, entry.correction));
  }
  for (const work of Object.values(state.work ?? {})) {
    const recovery = work.recovery;
    if (!recovery) continue;
    if (
      recovery.phase &&
      !["diagnosing", "ready", "stopped"].includes(recovery.phase)
    )
      throw new Error("Invalid repair circuit phase");
    if (
      recovery.scopes &&
      (!Array.isArray(recovery.scopes) ||
        recovery.scopes.some((scope) => typeof scope !== "string" || !scope))
    )
      throw new Error("Invalid inherited repair scopes");
    if (
      recovery.history &&
      (!Array.isArray(recovery.history) ||
        recovery.history.some(
          (entry) =>
            !entry.work ||
            "recovery" in entry.work ||
            !Number.isFinite(Date.parse(entry.at)),
        ))
    )
      throw new Error("Invalid retained attempt history");
    if (
      recovery.failure &&
      (!/^[a-f0-9]{64}$/.test(recovery.failure.digest) ||
        recovery.failure.digest !== failureDigest(recovery.failure.detail) ||
        (recovery.failure.event !== undefined &&
          !EVENT.test(recovery.failure.event)) ||
        !Number.isFinite(Date.parse(recovery.failure.at)))
    )
      throw new Error("Invalid original failure identity");
    if (
      recovery.correction &&
      (!repairClasses.includes(recovery.correction.kind) ||
        !/^[a-f0-9]{64}$/.test(recovery.correction.failureDigest) ||
        ![
          recovery.correction.actor,
          recovery.correction.diagnosis,
          recovery.correction.correction,
        ].every((text) => typeof text === "string" && text.trim()))
    )
      throw new Error("Invalid diagnosed correction");
  }
  if (state.planningRecovery !== undefined) {
    const value =
      state.planningRecovery as import("./compiler.js").PlanningRecoveryRecord;
    if (
      !value ||
      !["ready", "submitted", "complete", "stopped"].includes(value.phase) ||
      !Array.isArray(value.history) ||
      value.history.some(
        (entry) =>
          !repairClasses.includes(entry.kind) ||
          !/^[a-f0-9]{64}$/.test(entry.failure) ||
          !entry.diagnosis ||
          !entry.correction ||
          typeof entry.detail !== "string" ||
          failureDigest(entry.detail) !== entry.failure ||
          !Array.isArray(entry.invocations) ||
          entry.invocations.some(
            (receipt) =>
              !receipt ||
              !receipt.id ||
              !receipt.phase ||
              (receipt.resultDigest !== undefined &&
                !/^[a-f0-9]{64}$/.test(receipt.resultDigest)),
          ),
      )
    )
      throw new Error("Invalid planning recovery disposition");
    // Each accepted planning correction was charged as its round.
    for (const round of value.history.keys())
      if (
        !state.charges?.[objectiveEvent("plan", round)]?.allowances.includes(
          "planningRevisions",
        )
      )
        throw new Error(`Planning correction ${round} lacks its charge`);
  }
}
