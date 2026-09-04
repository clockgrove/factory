import {
  ExecutionRequirementsSchema,
  RepositoryScopePathSchema,
  type ExecutionRequirements,
} from "../protocol/worker-packet.js";
import {
  buildContextManifest,
  discoverValidationCommands,
  normalizeRepositoryFacts,
  profileRepository,
  type RepositoryFacts,
} from "../repository-profiles/index.js";

export type ConflictClass =
  | "parallel-safe"
  | "exclusive"
  | "generated"
  | "large-binary";
export type ValidationTier =
  | "mechanical"
  | "semantic"
  | "visual"
  | "deterministic-simulation";
export type DeliveryRelationship =
  | "root"
  | "continue-stack"
  | "sibling"
  | "join-after-merge";
export type CompilerWorkItem = {
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  scope: string[];
  preconditions: string[];
  outOfScope: string[];
  conventions: string[];
  dependsOn: string[];
  baseSha: string;
  validationCommands: string[];
  requirements: ExecutionRequirements;
  artifactContract: "clockgrove.factory/artifact-v1";
  context: {
    mustRead: string[];
    searchSeeds: string[];
    dependencyEvidence: Array<{ workItem: string; commit: string }>;
  };
  changeSurface: { mergeClass: ConflictClass; exclusiveResources: string[] };
  validation: { tier: ValidationTier; criteria: string[] }[];
  delivery: {
    group: string;
    relationship: DeliveryRelationship;
    parentWorkItem?: string;
  };
  economicReview: {
    conservative: boolean;
    rationale: string;
    paidMeasurementRequired: boolean;
  };
};
export type CompilerObjective = {
  title: string;
  workItems: CompilerWorkItem[];
};
export type CompilerWorkItemInput = Omit<
  CompilerWorkItem,
  "context" | "changeSurface" | "validation" | "delivery" | "economicReview"
>;
export type CompileInput = {
  title: string;
  baseSha: string;
  repositoryFacts: RepositoryFacts;
  workItems: CompilerWorkItemInput[];
};

const sorted = (xs: string[]) => [...new Set(xs)].sort();
const overlaps = (a: string, b: string) =>
  a === b ||
  (a.endsWith("/") && b.startsWith(a)) ||
  (b.endsWith("/") && a.startsWith(b));
// An observable criterion states both a subject and a checkable outcome. Bare
// aspirational verbs ("improve", "produce", "make valid") are not evidence.
const observable = (criterion: string) => {
  const text = criterion.trim();
  return (
    text.length >= 8 &&
    /\b(?:tests?|commands?|files?|output|result|response|schema|graph|manifest|profile|build|typecheck|render|snapshot|simulation)\b/i.test(
      text,
    ) &&
    /\b(?:pass(?:es)?|fails?|rejects?|accepts?|equals?|contains?|matches?|records?|returns?|emits?|exists?|remains? (?:unchanged|stable|bounded|valid)|compiles?|renders?)\b/i.test(
      text,
    )
  );
};

export function canonicalizeObjective(
  input: CompilerObjective,
): CompilerObjective {
  return {
    title: input.title,
    workItems: input.workItems
      .map((w) => ({
        ...w,
        acceptance: sorted(w.acceptance),
        scope: sorted(w.scope),
        preconditions: sorted(w.preconditions),
        outOfScope: sorted(w.outOfScope),
        conventions: sorted(w.conventions),
        dependsOn: sorted(w.dependsOn),
        validationCommands: sorted(w.validationCommands),
        requirements: canonicalRequirements(w.requirements),
        ...(w.context
          ? {
              context: {
                mustRead: sorted(w.context.mustRead),
                searchSeeds: sorted(w.context.searchSeeds),
                dependencyEvidence: [...w.context.dependencyEvidence].sort(
                  (a, b) =>
                    a.workItem.localeCompare(b.workItem) ||
                    a.commit.localeCompare(b.commit),
                ),
              },
            }
          : {}),
        ...(w.changeSurface
          ? {
              changeSurface: {
                mergeClass: w.changeSurface.mergeClass,
                exclusiveResources: sorted(w.changeSurface.exclusiveResources),
              },
            }
          : {}),
        ...(w.validation
          ? {
              validation: [...w.validation]
                .map((v) => ({ ...v, criteria: sorted(v.criteria) }))
                .sort((a, b) => a.tier.localeCompare(b.tier)),
            }
          : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function canonicalRequirements(value: unknown): ExecutionRequirements {
  const r = ExecutionRequirementsSchema.parse(value);
  return {
    ...r,
    os: sorted(r.os),
    architecture: sorted(r.architecture),
    tools: sorted(r.tools),
    services: sorted(r.services),
    networkDestinations: sorted(r.networkDestinations),
    permittedSecretNames: sorted(r.permittedSecretNames),
  };
}

export function validateCompiledObjective(
  objective: CompilerObjective,
  observedCommands?: string[],
): void {
  if (objective.workItems.length < 1 || objective.workItems.length > 100)
    throw new Error("Work Item count is out of bounds");
  const byId = new Map<string, CompilerWorkItem>();
  for (const w of objective.workItems) {
    if (byId.has(w.id)) throw new Error(`duplicate Work Item id ${w.id}`);
    byId.set(w.id, w);
    w.scope.forEach((p) => RepositoryScopePathSchema.parse(p));
    if (w.acceptance.some((c) => !observable(c)))
      throw new Error(`unobservable acceptance criterion in ${w.id}`);
    if (w.validationCommands.length < 1)
      throw new Error(`missing validation command in ${w.id}`);
    if (
      observedCommands &&
      w.validationCommands.some((c) => !observedCommands.includes(c))
    )
      throw new Error(`invented validation command in ${w.id}`);
    if (
      !w.context ||
      !w.changeSurface ||
      !w.validation ||
      !w.delivery ||
      !w.economicReview
    )
      throw new Error(`missing compiler analysis record in ${w.id}`);
    if (
      w.context.mustRead.length > 64 ||
      w.context.searchSeeds.length > 64 ||
      w.context.dependencyEvidence.length > 64
    )
      throw new Error(`unbounded context manifest in ${w.id}`);
    if (
      w.validation.length < 1 ||
      w.validation.length > 4 ||
      w.validation.some((v) => v.criteria.length < 1 || v.criteria.length > 64)
    )
      throw new Error(`invalid validation design in ${w.id}`);
    if (w.changeSurface.exclusiveResources.length > 64)
      throw new Error(`unbounded exclusive resources in ${w.id}`);
    if (
      w.changeSurface.mergeClass === "parallel-safe" &&
      w.changeSurface.exclusiveResources.length
    )
      throw new Error(`invalid exclusive resources in ${w.id}`);
    if (
      w.changeSurface.mergeClass !== "parallel-safe" &&
      !w.changeSurface.exclusiveResources.length
    )
      throw new Error(`missing exclusive resource in ${w.id}`);
    const associated = new Set(w.validation.flatMap((v) => v.criteria));
    if (w.acceptance.some((c) => !associated.has(c)))
      throw new Error(`unvalidated acceptance criterion in ${w.id}`);
    if (
      !w.economicReview.conservative ||
      w.economicReview.paidMeasurementRequired
    )
      throw new Error(`non-conservative economic review in ${w.id}`);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("dependency cycle");
    if (done.has(id)) return;
    const w = byId.get(id);
    if (!w) throw new Error(`unknown dependency ${id}`);
    visiting.add(id);
    w.dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  byId.forEach((_, id) => visit(id));
  const path = (from: string, to: string): boolean => {
    const pending = [from],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  const items = [...byId.values()];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!,
        b = items[j]!;
      if (
        a.scope.some((x) => b.scope.some((y) => overlaps(x, y))) &&
        !path(a.id, b.id) &&
        !path(b.id, a.id)
      )
        throw new Error(`overlapping unordered scopes: ${a.id}, ${b.id}`);
    }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!,
        b = items[j]!;
      if (
        (a.changeSurface?.exclusiveResources ?? []).some((x) =>
          (b.changeSurface?.exclusiveResources ?? []).includes(x),
        ) &&
        !path(a.id, b.id) &&
        !path(b.id, a.id)
      )
        throw new Error(
          `conflicting unordered exclusive resource: ${a.id}, ${b.id}`,
        );
    }
  for (const w of items) {
    const d = w.delivery;
    if (!d) continue;
    if (
      d.relationship === "root" &&
      (d.parentWorkItem || w.dependsOn.length !== 0 || d.group !== w.id)
    )
      throw new Error(`impossible root topology for ${w.id}`);
    if (
      d.relationship === "continue-stack" &&
      (!d.parentWorkItem ||
        w.dependsOn.length !== 1 ||
        w.dependsOn[0] !== d.parentWorkItem ||
        byId.get(d.parentWorkItem)?.delivery?.group !== d.group)
    )
      throw new Error(`impossible stack topology for ${w.id}`);
    if (d.relationship === "join-after-merge") {
      const groups = w.dependsOn.map((id) => byId.get(id)?.delivery?.group);
      if (
        d.parentWorkItem ||
        w.dependsOn.length < 2 ||
        groups.some((g) => !g) ||
        new Set(groups).size !== groups.length ||
        groups.includes(d.group)
      )
        throw new Error(`impossible join topology for ${w.id}`);
    }
    if (
      d.relationship === "sibling" &&
      (d.parentWorkItem ||
        w.dependsOn.length !== 1 ||
        byId.get(w.dependsOn[0]!)?.delivery?.group === d.group ||
        d.group !== w.id)
    )
      throw new Error(`impossible sibling topology for ${w.id}`);
  }
}

export function compileObjective(input: CompileInput): CompilerObjective {
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha))
    throw new Error("invalid base SHA");
  const facts = normalizeRepositoryFacts(input.repositoryFacts),
    commands = discoverValidationCommands(facts);
  const analyzed = input.workItems.map((w) => {
    const scope = w.scope.map((p) => RepositoryScopePathSchema.parse(p));
    const manifest = buildContextManifest(facts, scope);
    const scopedFacts = facts.files.filter((f) =>
      scope.some((p) =>
        p.endsWith("/") ? f.path.startsWith(p) : f.path === p,
      ),
    );
    const generated =
      scopedFacts.some((f) => f.generated === true) ||
      scope.some((p) => /(^|\/)(?:dist|build|generated)\//.test(p));
    const binary =
      scopedFacts.some((f) => f.binary === true) ||
      scope.some((p) => /\.(?:png|jpe?g|zip|wasm|pdf)$/i.test(p));
    const mergeClass: ConflictClass = binary
      ? "large-binary"
      : generated
        ? "generated"
        : "parallel-safe";
    const scopedProfile = profileRepository({
      files: scopedFacts,
      ...(facts.scripts === undefined ? {} : { scripts: facts.scripts }),
    });
    const tiers: ValidationTier[] = [
      "mechanical",
      "semantic",
      ...(scopedProfile.deterministicSimulation
        ? ["deterministic-simulation" as const]
        : []),
      ...(scopedProfile.visualValidation ? ["visual" as const] : []),
    ];
    const resources =
      mergeClass === "parallel-safe"
        ? []
        : sorted(scopedFacts.length ? scopedFacts.map((f) => f.path) : scope);
    const req = ExecutionRequirementsSchema.parse(w.requirements);
    const runtime = [
      `trust ${req.trust}`,
      req.timeoutMinutes ? `timeout ${req.timeoutMinutes}m` : undefined,
      req.cpu ? `cpu ${req.cpu}` : undefined,
      req.memoryMb ? `memory ${req.memoryMb}MB` : undefined,
      req.diskMb ? `disk ${req.diskMb}MB` : undefined,
      req.tools.length ? `tools ${sorted(req.tools).join(",")}` : undefined,
      req.services.length
        ? `services ${sorted(req.services).join(",")}`
        : undefined,
      req.networkDestinations.length
        ? `network ${sorted(req.networkDestinations).join(",")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      ...w,
      baseSha: input.baseSha,
      validationCommands: w.validationCommands,
      context: { ...manifest, dependencyEvidence: [] },
      changeSurface: { mergeClass, exclusiveResources: resources },
      validation: tiers.map((tier) => ({ tier, criteria: w.acceptance })),
      economicReview: {
        conservative: true,
        rationale: `Repository-observed commands: ${commands.join(", ")}; validation tiers: ${tiers.join(", ")}; runtime requirements: ${runtime}. No live paid measurement was assumed.`,
        paidMeasurementRequired: false,
      },
    };
  });
  const analyzedById = new Map(analyzed.map((w) => [w.id, w]));
  const stackGroup = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const item = analyzedById.get(current);
      if (!item || item.dependsOn.length !== 1) return current;
      current = item.dependsOn[0]!;
    }
    return id;
  };
  const items = analyzed.map((w) => {
    if (w.dependsOn.length === 0)
      return { ...w, delivery: { group: w.id, relationship: "root" as const } };
    if (w.dependsOn.length === 1) {
      const parent = w.dependsOn[0]!,
        group = stackGroup(parent);
      return {
        ...w,
        delivery: {
          group,
          relationship: "continue-stack" as const,
          parentWorkItem: parent,
        },
      };
    }
    return {
      ...w,
      delivery: { group: w.id, relationship: "join-after-merge" as const },
    };
  });
  const result = canonicalizeObjective({
    title: input.title,
    workItems: items,
  });
  validateCompiledObjective(result, commands);
  return result;
}

export function serializeCompilerObjective(
  objective: CompilerObjective,
): string {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value as Record<string, unknown>)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`
        : JSON.stringify(value);
  return canonical(canonicalizeObjective(objective));
}
