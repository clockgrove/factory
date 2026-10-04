import { createHash } from "node:crypto";
import type { FactoryConfig } from "./config.js";
import type { AllowanceConsumption } from "./graph-amendments.js";
import type { FactoryState, WorkState } from "./state.js";

export const repairClasses = [
  "implementation",
  "review-evidence",
  "validation-environment",
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
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new Error(`Unsupported ${label} field: ${key}`);
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
/** One charged failure event: the allowance it used and the scopes it counts against. */
export interface Charge {
  allowance: keyof AllowanceConsumption;
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
export interface FailureDisposition {
  digest: string;
  /**
   * The failure event a correction charges. Only a wrong result has one; a
   * transient or configuration failure is never charged.
   */
  event?: string;
  classification: RepairClass | "interruption" | "authority" | "uncertain";
  detail: string;
  at: string;
  continuation:
    | "new-attempt-from-accepted-base"
    | "exact-candidate-revalidation"
    | "exact-result-review"
    | "operator-decision";
  unfinishedEdits: "removed" | "unavailable";
  decision: string;
}
export interface RepairCorrection {
  failureDigest: string;
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
export const emptyConsumption = (): AllowanceConsumption => ({
  planningRevisions: 0,
  implementationRepairs: 0,
  resultRereviews: 0,
});
export const failureDigest = (detail: string): string =>
  createHash("sha256").update(detail).digest("hex");
export function allowanceKey(kind: RepairClass): keyof AllowanceConsumption {
  return kind.startsWith("planning-")
    ? "planningRevisions"
    : kind === "implementation"
      ? "implementationRepairs"
      : "resultRereviews";
}
/** Failure event of a Work Item step; `round` counts the item's earlier attempts and corrections. */
export const itemEvent = (attempt: string, step: string, round: number) =>
  `${attempt}/${step}/${round}`;
/** Failure event of an Objective step: a plan revision or an amendment. */
export const objectiveEvent = (step: string, round: number | string) =>
  `objective/${step}/${round}`;
const EVENT = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[a-z][a-z-]*\/[A-Za-z0-9_-]+$/;

/** Consumption derived from the charged events, Objective-wide or for one scope. */
export function consumption(
  state: RepairLedger,
  scope?: string,
): AllowanceConsumption {
  const total = emptyConsumption();
  for (const charge of Object.values(state.charges ?? {}))
    if (scope === undefined || charge.scopes.includes(scope))
      total[charge.allowance]++;
  return total;
}
/** Per-path limits cap Work Item scopes; planning is one Objective-wide scope under its allowance. */
export function scopeLimit(
  autonomy: Autonomy,
  scope: string,
  key: keyof AllowanceConsumption,
): number {
  return scope === "$planning"
    ? autonomy.allowances[key]
    : autonomy.repairPolicy.perPath[key];
}
/** Why one more charge does not fit, or undefined when it does. */
function exhausted(
  state: RepairLedger,
  key: keyof AllowanceConsumption,
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
/** Whether `event` is already charged or one more charge fits every limit. */
export function allowanceAvailable(
  state: RepairLedger,
  event: string,
  key: keyof AllowanceConsumption,
  scopes: string[],
): boolean {
  return Boolean(state.charges?.[event]) || !exhausted(state, key, scopes);
}
/**
 * Charge one failure event. Repeating a charged event is free; a new event
 * that does not fit throws, which stops for an operator decision.
 */
export function charge(
  state: RepairLedger,
  event: string,
  key: keyof AllowanceConsumption,
  scopes: string[],
): void {
  if (state.charges?.[event]) return;
  if (!EVENT.test(event)) throw new Error(`Invalid failure event ${event}`);
  if (!scopes.length || scopes.some((scope) => !scope))
    throw new Error("Repair needs an inherited scope");
  const unique = [...new Set(scopes)].sort();
  const reason = exhausted(state, key, unique);
  if (reason) throw new Error(reason);
  state.charges = {
    ...state.charges,
    [event]: { allowance: key, scopes: unique },
  };
}
/**
 * Admit a correction of `kind` and charge its failure event. The class must
 * be enabled. A failure without an event (not a wrong result) is corrected
 * without a charge.
 */
export function chargeRepair(
  state: RepairLedger,
  event: string | undefined,
  kind: RepairClass,
  scopes: string[],
): void {
  if (event && state.charges?.[event]) return;
  if (!state.autonomy.repairClasses.includes(kind))
    throw new Error(
      `Repair class ${kind} is not enabled; operator decision required`,
    );
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
        Object.keys(charge).sort().join(",") !== "allowance,scopes" ||
        !allowanceKeys.includes(charge.allowance) ||
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
  }
}
