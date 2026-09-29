import { createHash } from "node:crypto";
import type { ExecutionAuthority } from "./admission.js";
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
export interface RepairLedger {
  admission?: { authority: ExecutionAuthority };
  authority?: ExecutionAuthority;
  allowanceConsumption?: AllowanceConsumption;
  repairConsumption?: Record<string, AllowanceConsumption>;
}
export interface FailureDisposition {
  digest: string;
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
export function chargeRepair(
  state: RepairLedger,
  kind: RepairClass,
  scopes: string[],
): void {
  const authority = state.admission?.authority ?? state.authority;
  if (!authority?.repairPolicy || !authority.repairClasses.includes(kind))
    throw new Error(
      `Repair class ${kind} is not admitted; operator decision required`,
    );
  consumeAllowance(state, allowanceKey(kind), scopes);
}
export function consumeAllowance(
  state: RepairLedger,
  key: keyof AllowanceConsumption,
  scopes: string[],
): void {
  const authority = state.admission?.authority ?? state.authority;
  if (!authority)
    throw new Error("Allowance consumption requires bound authority");
  const total = state.allowanceConsumption ?? emptyConsumption();
  const paths = state.repairConsumption ?? {};
  if (total[key] >= authority.allowances[key])
    throw new Error(`Objective ${key} allowance exhausted`);
  if (!scopes.length || scopes.some((scope) => !scope))
    throw new Error("Repair needs an inherited scope");
  for (const scope of new Set(scopes))
    if (
      authority.repairPolicy &&
      (paths[scope]?.[key] ?? 0) >= authority.repairPolicy.perPath[key]
    )
      throw new Error(`Repair path ${scope} ${key} allowance exhausted`);
  total[key]++;
  if (authority.repairPolicy)
    for (const scope of new Set(scopes)) {
      paths[scope] ??= emptyConsumption();
      paths[scope][key]++;
    }
  state.allowanceConsumption = total;
  if (authority.repairPolicy) state.repairConsumption = paths;
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
  const authority = state.admission?.authority ?? state.authority;
  const validCounts = (value: AllowanceConsumption): boolean =>
    Boolean(
      value &&
        ["planningRevisions", "implementationRepairs", "resultRereviews"].every(
          (key) =>
            Number.isSafeInteger(value[key as keyof AllowanceConsumption]) &&
            value[key as keyof AllowanceConsumption] >= 0,
        ),
    );
  if (
    state.allowanceConsumption &&
    (!authority ||
      !validCounts(state.allowanceConsumption) ||
      Object.keys(state.allowanceConsumption).some(
        (key) =>
          !Object.hasOwn(authority.allowances, key) ||
          state.allowanceConsumption![key as keyof AllowanceConsumption] >
            authority.allowances[key as keyof AllowanceConsumption],
      ))
  )
    throw new Error("Invalid persisted Objective repair consumption");
  if (state.repairConsumption) {
    if (
      !authority?.repairPolicy ||
      !state.allowanceConsumption ||
      typeof state.repairConsumption !== "object" ||
      Array.isArray(state.repairConsumption)
    )
      throw new Error("Repair path consumption lacks its bound policy");
    for (const [scope, counts] of Object.entries(state.repairConsumption)) {
      if (!scope || !validCounts(counts))
        throw new Error("Invalid inherited repair path consumption");
      for (const key of [
        "planningRevisions",
        "implementationRepairs",
        "resultRereviews",
      ] as const)
        if (
          counts[key] > authority.repairPolicy.perPath[key] ||
          counts[key] > state.allowanceConsumption[key]
        )
          throw new Error("Repair path consumption exceeds bound allowance");
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
