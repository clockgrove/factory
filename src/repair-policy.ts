import { createHash } from "node:crypto";
import type { ExecutionAuthority } from "./admission.js";
import type { AllowanceConsumption } from "./graph-amendments.js";
import type { FactoryState, WorkState } from "./state.js";

export const repairClasses = ["implementation", "review-evidence", "validation-environment", "planning-output", "planning-evidence", "planning-choice"] as const;
export type RepairClass = (typeof repairClasses)[number];
export interface RepairPolicy { perPath: AllowanceConsumption }
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
  continuation: "new-attempt-from-accepted-base" | "exact-candidate-revalidation" | "exact-result-review" | "operator-decision";
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
  history?: { at: string; work: Omit<WorkState, "recovery">; failure?: FailureDisposition; correction?: RepairCorrection }[];
}
export const emptyConsumption = (): AllowanceConsumption => ({planningRevisions:0, implementationRepairs:0, resultRereviews:0});
export const failureDigest = (detail: string): string => createHash("sha256").update(detail).digest("hex");
export function allowanceKey(kind: RepairClass): keyof AllowanceConsumption {
  return kind.startsWith("planning-") ? "planningRevisions" : kind === "implementation" ? "implementationRepairs" : "resultRereviews";
}
export function chargeRepair(state: RepairLedger, kind: RepairClass, scopes: string[]): void {
  const authority = state.admission?.authority ?? state.authority;
  if (!authority?.repairPolicy || !authority.repairClasses.includes(kind)) throw new Error(`Repair class ${kind} is not admitted; operator decision required`);
  const key = allowanceKey(kind);
  const total = state.allowanceConsumption ?? emptyConsumption();
  const paths = state.repairConsumption ?? {};
  if (total[key] >= authority.allowances[key]) throw new Error(`Objective ${key} allowance exhausted`);
  if (!scopes.length || scopes.some(scope => !scope)) throw new Error("Repair needs an inherited scope");
  for (const scope of new Set(scopes)) if ((paths[scope]?.[key] ?? 0) >= authority.repairPolicy.perPath[key]) throw new Error(`Repair path ${scope} ${key} allowance exhausted`);
  total[key]++;
  for (const scope of new Set(scopes)) (paths[scope] ??= emptyConsumption())[key]++;
  state.allowanceConsumption = total;
  state.repairConsumption = paths;
}
/** Original identities remain the scope even when a parent becomes an aggregate. */
export function repairScopes(state: FactoryState, id: string): string[] {
  const existing = state.work[id]?.recovery?.scopes;
  if (existing) return existing;
  const initial = state.graphRevisions?.[0]?.graph ?? state.graph;
  const roots = new Set(initial.items.map(item => item.id));
  const visited = new Set<string>();
  const scopes = new Set<string>();
  const visit = (current: string): void => {
    if (visited.has(current)) return;
    visited.add(current);
    if (roots.has(current)) scopes.add(current);
    for (const parent of state.graph.items.filter(item => item.children?.includes(current))) visit(parent.id);
  };
  visit(id);
  return scopes.size ? [...scopes].sort() : ["$objective"];
}
export function archiveAttempt(work: WorkState): WorkRecovery {
  const recovery = work.recovery ?? {};
  const { recovery: _old, ...attempt } = work;
  return { ...recovery, history: [...(recovery.history ?? []), {at: new Date().toISOString(), work: structuredClone(attempt), ...(recovery.failure ? {failure:structuredClone(recovery.failure)} : {}), ...(recovery.correction ? {correction:structuredClone(recovery.correction)} : {})}] };
}
export function validateCorrection(work: WorkState, correction: RepairCorrection): void {
  if (!work.recovery?.failure || correction.failureDigest !== work.recovery.failure.digest) throw new Error("Correction does not bind the current failure");
  if (![correction.actor, correction.diagnosis, correction.correction].every(text => typeof text === "string" && text.trim())) throw new Error("Concrete diagnosis, correction and actor are required");
  if (work.recovery.history?.some(prior => prior.failure?.digest === correction.failureDigest && prior.correction?.correction === correction.correction)) throw new Error("Unchanged failed correction cannot be repeated");
}
