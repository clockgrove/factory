import type { CompilerWorkItem } from "./index.js";
import type { BackendCandidate } from "../execution/registry.js";
import { capabilityMismatch } from "../execution/backend.js";
import { normalizeSchedulingPolicy, requirementsPolicyRejections, type RunPolicy } from "../protocol/policy.js";
import { admissionCapacityLimits } from "../scheduling/admission.js";
import { CapacityLedger, capacityReservationKey, type CapacitySnapshot } from "../scheduling/capacity-ledger.js";
import { resourcePressureReasons, type ResourceSnapshot } from "../scheduling/resource-sampler.js";

/** Trusted caller observations, never model-generated authority or an admission request. */
export interface DecompositionEvidence {
  objective: number;
  policy: RunPolicy;
  capacity?: CapacitySnapshot;
  resource?: ResourceSnapshot | null;
  repositoryLimits?: { maxLocalWorkers: number; maxPaidWorkers: number };
  deliveryMode?: "regular-prs" | "native-stacks" | "escalate";
  nowMs?: number;
  cooldownUntilMs?: number;
  /** Registry evaluations must be for economicRequirements(item, policy). */
  candidates?: ReadonlyMap<string, readonly BackendCandidate[]>;
}

export interface LocalFitAssessment {
  availability: "estimated" | "unavailable";
  /** Largest deterministic first-fit subset of a topological wave at the supplied snapshot. */
  likelySlots: number | null;
  waveFits: Array<number | null>;
  measuredAt: string | null;
  reasons: string[];
}

export interface CloudEligibilityAssessment {
  workItem: string;
  status: "eligible-in-principle" | "ineligible" | "unknown";
  /** Execution policy/capability only: not validation, live budget, burst or lease approval. */
  backendIds: string[];
  reason: string;
}

export interface DecompositionAssessment {
  workItems: number;
  /** Maximum simultaneous items in topological waves; not measured host capacity. */
  dependencyWaveWidth: number;
  configuredWorkMinutes: number | null;
  configuredCriticalPathMinutes: number | null;
  idealConcurrencyTimeSavedMinutes: number | null;
  contextPathReads: number;
  uniqueContextPaths: number;
  repeatedContextPathReads: number;
  repeatedValidationCommands: number;
  redundantItemPairs: Array<[string, string]>;
  localFit: LocalFitAssessment;
  cloudEligibility: CloudEligibilityAssessment[];
  feedback: string[];
  unknowns: string[];
}

type EconomicItem = Pick<
  CompilerWorkItem,
  | "id"
  | "goal"
  | "acceptance"
  | "scope"
  | "preconditions"
  | "outOfScope"
  | "dependsOn"
  | "requirements"
  | "context"
  | "validationCommands"
> & Partial<Pick<CompilerWorkItem, "conventions" | "changeSurface">>;
const canonical = (values: string[]) => JSON.stringify([...new Set(values)].sort());
const canonicalObject = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalObject).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalObject(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Match the Supervisor's effective trust without mutating the compiled packet. */
export function economicRequirements(item: Pick<EconomicItem, "requirements">, policy: RunPolicy) {
  return {
    ...item.requirements,
    ...(policy.trust === "sandbox_untrusted" && item.requirements.trust === "trusted_local"
      ? { trust: "isolated" as const } : {}),
  };
}

function usable(candidate: BackendCandidate, item: EconomicItem, policy: RunPolicy): boolean {
  return candidate.registered && candidate.capabilities !== null && candidate.id === candidate.capabilities.id &&
    candidate.permanentReasons.length === 0 && candidate.transientReasons.length === 0 &&
    candidate.probe?.available === true && candidate.probe.authenticated &&
    capabilityMismatch(candidate.capabilities, economicRequirements(item, policy)).length === 0 &&
    (!policy.models || candidate.capabilities.supportsModelSelection === true);
}

function cloudEligibility(item: EconomicItem, evidence?: DecompositionEvidence): CloudEligibilityAssessment {
  const result = (status: CloudEligibilityAssessment["status"], reason: string, backendIds: string[] = []): CloudEligibilityAssessment =>
    ({ workItem: item.id, status, reason, backendIds });
  if (!evidence) return result("unknown", "No immutable run policy supplied.");
  const { policy } = evidence;
  const allowed = policy.backendOrder.filter((id) => policy.allowedPaidBackends.includes(id));
  if (!allowed.length || requirementsPolicyRejections(item.requirements, policy).length)
    return result("ineligible", "Immutable policy does not permit a paid execution route.");
  const candidates = evidence.candidates?.get(item.id);
  if (!candidates) return result("unknown", "Per-item registry capability observations unavailable.");
  const eligible = candidates.filter((candidate) => allowed.includes(candidate.id) && candidate.paid &&
    candidate.capabilities?.requiresPaidRuntime && usable(candidate, item, policy));
  if (eligible.length) return result("eligible-in-principle", "Supplied execution policy and capability checks fit; validation, delivery, budget, burst and current authority still require admission.", eligible.map((candidate) => candidate.id).sort());
  const incomplete = allowed.some((id) => !candidates.some((candidate) => candidate.id === id)) ||
    candidates.some((candidate) => allowed.includes(candidate.id) && candidate.permanentReasons.length === 0 &&
      (!candidate.probe?.available || !candidate.probe.authenticated || candidate.transientReasons.length > 0));
  return incomplete ? result("unknown", "Paid capability observations are incomplete or temporarily unavailable.") :
    result("ineligible", "Supplied paid execution capabilities do not satisfy this packet.");
}

function localFit(waves: readonly EconomicItem[][], evidence?: DecompositionEvidence): LocalFitAssessment {
  const unavailable = (reason: string): LocalFitAssessment => ({ availability: "unavailable", likelySlots: null,
    waveFits: waves.map(() => null), measuredAt: evidence?.resource?.measuredAt ?? null, reasons: [reason] });
  if (!evidence?.resource || !evidence.capacity || !evidence.repositoryLimits || !evidence.deliveryMode || !evidence.candidates)
    return unavailable("Resource sample, capacity ledger, controller limits, delivery mode or per-item capabilities unavailable.");
  const { policy, resource, capacity, repositoryLimits } = evidence;
  const effective = normalizeSchedulingPolicy(policy);
  if (effective.capacity.mode !== "adaptive-local")
    return unavailable("Fixed-worker policy does not establish resource-constrained slots.");
  if (!Number.isSafeInteger(evidence.objective) || evidence.objective <= 0 ||
    !Number.isFinite(Date.parse(resource.measuredAt)) ||
    ![resource.effectiveCpu, resource.totalMemoryMb, resource.availableMemoryMb, resource.loadRatio, resource.memoryUsageRatio].every((n) => Number.isFinite(n) && n >= 0) ||
    resource.effectiveCpu <= 0 || resource.availableMemoryMb > resource.totalMemoryMb || resource.memoryUsageRatio > 1)
    return unavailable("Supplied resource observation is invalid.");
  const reasons = resourcePressureReasons(resource, effective.capacity.local);
  if ((evidence.nowMs !== undefined && !Number.isFinite(evidence.nowMs)) ||
    (evidence.cooldownUntilMs !== undefined && !Number.isFinite(evidence.cooldownUntilMs)))
    return unavailable("Supplied cooldown comparison time is invalid.");
  if (evidence.cooldownUntilMs !== undefined && evidence.nowMs === undefined)
    return unavailable("Cooldown observation has no supplied comparison time.");
  if ((evidence.cooldownUntilMs ?? 0) > (evidence.nowMs ?? 0)) reasons.push("Observed local admission cooldown is active.");
  if (evidence.deliveryMode === "escalate") reasons.push("Selected delivery mode cannot execute work.");
  const limits = admissionCapacityLimits(policy, resource, evidence.objective, undefined, repositoryLimits);
  if (evidence.deliveryMode === "regular-prs") limits.objectiveMaxParallel = { objective: evidence.objective, max: 1 };
  const itemNumbers = new Map(waves.flat().map((item, index) => [item.id, index + 1]));
  const waveFits = waves.map((wave): number | null => {
    if (reasons.length) return 0;
    if (wave.some((item) => !evidence.candidates!.has(item.id) ||
      policy.backendOrder.some((id) => !evidence.candidates!.get(item.id)!.some((candidate) => candidate.id === id)))) return null;
    const provisional = new CapacityLedger();
    provisional.reconcile(Math.max(1, capacity.generation), capacity.reservations);
    const observedMemory = provisional.snapshot().memoryMb;
    let fit = 0;
    for (const item of [...wave].sort((a, b) => a.id.localeCompare(b.id))) {
      if (requirementsPolicyRejections(item.requirements, policy).length) continue;
      const candidates = evidence.candidates!.get(item.id)!.filter((candidate) => policy.backendOrder.includes(candidate.id) && candidate.local &&
        candidate.capabilities?.hostExecution && !candidate.capabilities.requiresPaidRuntime && usable(candidate, item, policy));
      const cpu = item.requirements.cpu ?? effective.capacity.local.defaultCpu;
      const memoryMb = item.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb;
      if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isFinite(memoryMb) || memoryMb <= 0) return null;
      for (const candidate of candidates) {
        if (resource.availableMemoryMb - Math.max(0, provisional.snapshot().memoryMb - observedMemory) < memoryMb + effective.capacity.local.minimumFreeMemoryMb) break;
        // Private simulation identity, never persisted or sent to a backend.
        const identity = { objective: evidence.objective, workItem: itemNumbers.get(item.id)!, attempt: Number.MAX_SAFE_INTEGER, phase: "execution" as const, backendId: candidate.id };
        const result = provisional.tryReserve(provisional.snapshot().generation, {
          ...identity, key: capacityReservationKey(identity), admissionClass: "local", local: true,
          cpu, memoryMb, paidUnits: 0, paths: item.scope,
          exclusiveResources: item.changeSurface?.exclusiveResources ?? [],
        }, limits);
        if (result.reserved) { fit++; break; }
      }
    }
    return fit;
  });
  return { availability: waveFits.includes(null) ? "unavailable" : "estimated",
    likelySlots: waveFits.includes(null) ? null : Math.max(...(waveFits as number[])), waveFits,
    measuredAt: resource.measuredAt, reasons: [...reasons,
      ...(waveFits.includes(null) ? ["At least one wave lacks complete per-item registry observations or valid resource requirements."] : []),
      "Deterministic ID-order first fit per topological wave using one frozen resource/ledger snapshot; not an optimum, live admission, or completion forecast.",
      "Future dependencies are assumed complete; each wave independently reuses the supplied reservations. Defaults fill absent CPU/memory requirements."] };
}

/** Structural evidence and configured estimates, never pricing or observed savings. */
export function assessDecomposition(items: readonly EconomicItem[], evidence?: DecompositionEvidence): DecompositionAssessment {
  if (items.length < 1 || items.length > 100)
    throw new Error("economic assessment requires 1 to 100 items");
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) throw new Error("duplicate Work Item id in economic assessment");
  const completed = new Set<string>();
  const finish = new Map<string, number>();
  let width = 0;
  const waves: EconomicItem[][] = [];
  const durationKnown = items.every((item) => {
    const duration = item.requirements.estimatedDurationMinutes;
    return duration !== undefined && Number.isFinite(duration) && duration > 0 && duration <= 1440;
  });
  while (completed.size < items.length) {
    const wave = items.filter(
      (item) => !completed.has(item.id) && item.dependsOn.every((id) => completed.has(id)),
    );
    if (!wave.length) throw new Error("cyclic or incomplete graph in economic assessment");
    width = Math.max(width, wave.length);
    waves.push(wave);
    for (const item of wave) {
      finish.set(
        item.id,
        Math.max(0, ...item.dependsOn.map((id) => finish.get(id)!)) +
          (durationKnown ? item.requirements.estimatedDurationMinutes! : 0),
      );
      completed.add(item.id);
    }
  }
  const reads = items.flatMap((item) => [...new Set(item.context.mustRead)]);
  const validations = items.flatMap((item) => [...new Set(item.validationCommands)]);
  const redundantItemPairs: Array<[string, string]> = [];
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!,
        b = ordered[j]!;
      // Exact duplicate contracts are stronger evidence than shared paths or vocabulary.
      if (
        a.goal.trim() === b.goal.trim() &&
        canonical(a.acceptance) === canonical(b.acceptance) &&
        canonical(a.scope) === canonical(b.scope) &&
        canonical(a.preconditions) === canonical(b.preconditions) &&
        canonical(a.outOfScope) === canonical(b.outOfScope) &&
        JSON.stringify(a.validationCommands) === JSON.stringify(b.validationCommands) &&
        canonical(a.conventions ?? []) === canonical(b.conventions ?? []) &&
        canonicalObject(a.requirements) === canonicalObject(b.requirements) &&
        canonicalObject(a.changeSurface ?? null) === canonicalObject(b.changeSurface ?? null)
      ) {
        if (redundantItemPairs.length < 16) redundantItemPairs.push([a.id, b.id]);
      }
    }
  const configuredWorkMinutes = durationKnown
    ? items.reduce((sum, item) => sum + item.requirements.estimatedDurationMinutes!, 0)
    : null;
  const configuredCriticalPathMinutes = durationKnown ? Math.max(...finish.values()) : null;
  const repeatedContextPathReads = reads.length - new Set(reads).size;
  const feedback: string[] = [];
  if (redundantItemPairs.length)
    feedback.push(
      "Combine duplicate goal, acceptance, and scope contracts before execution; they add sessions without a distinct deliverable.",
    );
  if (items.length > 1 && reads.length > 0 && repeatedContextPathReads >= reads.length / 2)
    feedback.push(
      "At least half of context path reads are repeated. Narrow manifests or combine related work when independent reviewability does not justify repetition; path counts do not establish token cost.",
    );
  if (items.length > 1 && width === 1)
    feedback.push(
      "The dependency graph permits one item per wave. Splitting adds sessions and repeated validation without concurrency benefit; retain boundaries only for distinct reviewable deliverables.",
    );
  if (!redundantItemPairs.length)
    feedback.push("Retain distinct acceptance and execution boundaries where they provide independently reviewable behavior; structural counts alone do not prove combining them is cheaper or safe.");
  return {
    workItems: items.length,
    dependencyWaveWidth: width,
    configuredWorkMinutes,
    configuredCriticalPathMinutes,
    idealConcurrencyTimeSavedMinutes:
      configuredWorkMinutes === null || configuredCriticalPathMinutes === null
        ? null
        : configuredWorkMinutes - configuredCriticalPathMinutes,
    contextPathReads: reads.length,
    uniqueContextPaths: new Set(reads).size,
    repeatedContextPathReads,
    repeatedValidationCommands: validations.length - new Set(validations).size,
    redundantItemPairs,
    localFit: localFit(waves, evidence),
    cloudEligibility: ordered.map((item) => cloudEligibility(item, evidence)),
    feedback,
    unknowns: [
      ...(!durationKnown
        ? ["One or more configured duration estimates are absent or invalid."]
        : []),
      "Resource-fit estimates and paid execution eligibility are advisory supplied-snapshot assessments; actual admission, validation, live budget, model tokens, pricing and retry cost are not established by compilation.",
      "Ideal concurrency savings exclude validation, integration, startup overhead, host pressure, and provider latency; they do not authorize paid execution.",
    ],
  };
}

export function economicRationale(assessment: DecompositionAssessment, workItem?: string): string {
  const cloud = assessment.cloudEligibility.find((item) => item.workItem === workItem);
  return [
    "Advisory estimates only; no admission or paid execution authority.",
    `${assessment.workItems} Work Items; dependency wave width ${assessment.dependencyWaveWidth}.`,
    `Resource-constrained local wave fit: ${assessment.localFit.likelySlots ?? "unavailable"}; sample ${assessment.localFit.measuredAt ?? "unavailable"}. ID-order first fit using frozen reservations, not an optimum or a completion forecast.`,
    ...(cloud ? [`Paid execution policy/capability: ${cloud.status}. ${cloud.reason}`] : []),
    `Configured work/critical path/ideal concurrency reduction (minutes): ${assessment.configuredWorkMinutes ?? "unavailable"}/${assessment.configuredCriticalPathMinutes ?? "unavailable"}/${assessment.idealConcurrencyTimeSavedMinutes ?? "unavailable"}.`,
    `${assessment.repeatedContextPathReads}/${assessment.contextPathReads} context path reads repeated; ${assessment.repeatedValidationCommands} repeated validation commands.`,
    ...assessment.feedback,
    ...assessment.unknowns,
  ]
    .join(" ")
    .slice(0, 2_000);
}
