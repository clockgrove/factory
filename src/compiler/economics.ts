import type { CompilerWorkItem } from "./index.js";

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
>;
const canonical = (values: string[]) => JSON.stringify([...new Set(values)].sort());

/** Structural evidence and configured estimates, never pricing or observed savings. */
export function assessDecomposition(items: readonly EconomicItem[]): DecompositionAssessment {
  if (items.length < 1 || items.length > 100)
    throw new Error("economic assessment requires 1 to 100 items");
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) throw new Error("duplicate Work Item id in economic assessment");
  const completed = new Set<string>();
  const finish = new Map<string, number>();
  let width = 0;
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
        canonical(a.validationCommands) === canonical(b.validationCommands)
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
    feedback,
    unknowns: [
      ...(!durationKnown
        ? ["One or more configured duration estimates are absent or invalid."]
        : []),
      "Actual CPU/memory admission, delivery mode serialization, model tokens, pricing, retry cost, and cloud eligibility are not established by compilation.",
      "Ideal concurrency savings exclude validation, integration, startup overhead, host pressure, and provider latency; they do not authorize paid execution.",
    ],
  };
}

export function economicRationale(assessment: DecompositionAssessment): string {
  return [
    `${assessment.workItems} Work Items; dependency wave width ${assessment.dependencyWaveWidth}.`,
    `Configured work/critical path/ideal concurrency reduction (minutes): ${assessment.configuredWorkMinutes ?? "unavailable"}/${assessment.configuredCriticalPathMinutes ?? "unavailable"}/${assessment.idealConcurrencyTimeSavedMinutes ?? "unavailable"}.`,
    `${assessment.repeatedContextPathReads}/${assessment.contextPathReads} context path reads repeated; ${assessment.repeatedValidationCommands} repeated validation commands.`,
    ...assessment.feedback,
    ...assessment.unknowns,
  ]
    .join(" ")
    .slice(0, 2_000);
}
