import {
  ExecutionRequirementsSchema,
  RepositoryScopePathSchema,
  type ExecutionRequirements,
} from "../protocol/worker-packet.js";
import { addScopeSerializationEdges } from "../graph.js";
import { z } from "zod";
import { assessDecomposition, economicRationale } from "./economics.js";
export { assessDecomposition, type DecompositionAssessment } from "./economics.js";
import {
  buildContextManifest,
  discoverValidationCommands,
  isGroundedValidationCommand,
  normalizeRepositoryFacts,
  profileRepository,
  type RepositoryFacts,
} from "../repository-profiles/index.js";

export type ConflictClass = "parallel-safe" | "exclusive" | "generated" | "large-binary";
export type ValidationTier = "mechanical" | "semantic" | "visual" | "deterministic-simulation";
export type DeliveryRelationship = "root" | "continue-stack" | "sibling" | "join-after-merge";
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
export const ExclusiveResourcesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9:._/-]*$/)
      .refine(
        (value) => !value.split("/").some((part) => part === ".." || part === "." || part === ""),
        "resource identity contains traversal or empty components",
      ),
  )
  .max(64);
export type CompilerWorkItemInput = Omit<
  CompilerWorkItem,
  "context" | "changeSurface" | "validation" | "delivery" | "economicReview"
> & { exclusiveResources?: string[] | undefined };
export type CompileInput = {
  title: string;
  baseSha: string;
  repositoryFacts: RepositoryFacts;
  workItems: CompilerWorkItemInput[];
};

const sorted = (xs: string[]) => [...new Set(xs)].sort();
const overlaps = (a: string, b: string) =>
  a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
// This is a structural guard, not a natural-language observability classifier.
// Function names, equations, error behavior, and domain vocabulary are all valid
// ways to describe acceptance. Reject only malformed text and obvious whole-text
// placeholders; matching a vocabulary can never establish semantic acceptance.
// The management compiler must formulate checkable criteria, and independent
// semantic review must establish each one against authoritative validation evidence.
const acceptanceTextProblem = (criterion: string): string | undefined => {
  const text = criterion.trim();
  if (text.length === 0) return "criterion is blank";
  if (criterion.length > 2_000) return "criterion exceeds 2000 characters";
  if (!/[\p{L}\p{N}]/u.test(text)) return "criterion contains no descriptive text";
  // Anchor these narrowly: e.g. a statement describing how a literal 'TODO' is
  // handled is not itself a placeholder. Unrecognized prose is left to review.
  const statement = text.replace(/[.!?]+$/, "").trim();
  if (
    /^(?:todo|tbd|n\/?a|none|done|works?|works? (?:well|correctly|as expected)|make it better|improve (?:it|quality|performance)|(?:all )?tests? (?:are|is) (?:good|great|wonderful))$/i.test(
      statement,
    )
  )
    return "criterion is only a placeholder or an unspecified quality claim";
  return undefined;
};

export function canonicalizeObjective(input: CompilerObjective): CompilerObjective {
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
        // Validation is an executable sequence, not a set. Preserve its
        // authored order so setup/generation steps cannot move after checks.
        validationCommands: [...w.validationCommands],
        requirements: canonicalRequirements(w.requirements),
        ...(w.context
          ? {
              context: {
                mustRead: sorted(w.context.mustRead),
                searchSeeds: sorted(w.context.searchSeeds),
                dependencyEvidence: [...w.context.dependencyEvidence].sort(
                  (a, b) =>
                    a.workItem.localeCompare(b.workItem) || a.commit.localeCompare(b.commit),
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
  commandEvidence?: string[] | RepositoryFacts,
): void {
  if (objective.workItems.length < 1 || objective.workItems.length > 100)
    throw new Error("Work Item count is out of bounds");
  const byId = new Map<string, CompilerWorkItem>();
  for (const w of objective.workItems) {
    if (byId.has(w.id)) throw new Error(`duplicate Work Item id ${w.id}`);
    byId.set(w.id, w);
    w.scope.forEach((p) => RepositoryScopePathSchema.parse(p));
    if (w.acceptance.length < 1 || w.acceptance.length > 64)
      throw new Error(`invalid acceptance criteria in ${w.id}: provide between 1 and 64 criteria`);
    for (const [index, criterion] of w.acceptance.entries()) {
      const problem = acceptanceTextProblem(criterion);
      if (problem)
        throw new Error(
          `invalid acceptance criterion ${index + 1} in ${w.id}: ${problem}; state a concrete expected behavior or result and associate it with validation evidence`,
        );
    }
    if (w.validationCommands.length < 1) throw new Error(`missing validation command in ${w.id}`);
    if (commandEvidence) {
      const observed = Array.isArray(commandEvidence)
        ? commandEvidence
        : discoverValidationCommands(commandEvidence);
      const invalid = w.validationCommands.find((command) =>
        Array.isArray(commandEvidence)
          ? !commandEvidence.includes(command)
          : !isGroundedValidationCommand(command, commandEvidence, w.scope),
      );
      if (invalid !== undefined)
        throw new Error(
          `invented validation command in ${w.id}: ${JSON.stringify(invalid.slice(0, 200))}; repository-observed commands: ${JSON.stringify(observed).slice(0, 600)}. Use an observed command or specialize an observed bare node --test with concrete existing or Work Item-scoped JavaScript test files; flags, shell syntax, and unplanned targets are not allowed.`,
        );
    }
    if (!w.context || !w.changeSurface || !w.validation || !w.delivery || !w.economicReview)
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
    if (w.changeSurface.mergeClass === "parallel-safe" && w.changeSurface.exclusiveResources.length)
      throw new Error(`invalid exclusive resources in ${w.id}`);
    if (
      w.changeSurface.mergeClass !== "parallel-safe" &&
      !w.changeSurface.exclusiveResources.length
    )
      throw new Error(`missing exclusive resource in ${w.id}`);
    const associated = new Set(w.validation.flatMap((v) => v.criteria));
    if (w.acceptance.some((c) => !associated.has(c)))
      throw new Error(`unvalidated acceptance criterion in ${w.id}`);
    if (!w.economicReview.conservative || w.economicReview.paidMeasurementRequired)
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
        throw new Error(`conflicting unordered exclusive resource: ${a.id}, ${b.id}`);
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
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha)) throw new Error("invalid base SHA");
  const facts = normalizeRepositoryFacts(input.repositoryFacts);
  const analyzed = input.workItems.map((w) => {
    const explicitResources = sorted(ExclusiveResourcesSchema.parse(w.exclusiveResources ?? []));
    const { exclusiveResources: _claims, ...source } = w;
    const scope = w.scope.map((p) => RepositoryScopePathSchema.parse(p));
    const manifest = buildContextManifest(facts, scope);
    const scopedFacts = facts.files.filter((f) =>
      scope.some((p) => (p.endsWith("/") ? f.path.startsWith(p) : f.path === p)),
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
        : explicitResources.length
          ? "exclusive"
          : "parallel-safe";
    const scopedProfile = profileRepository({
      files: scopedFacts,
      ...(facts.scripts === undefined ? {} : { scripts: facts.scripts }),
    });
    const tiers: ValidationTier[] = [
      "mechanical",
      "semantic",
      ...(scopedProfile.deterministicSimulation ? ["deterministic-simulation" as const] : []),
      ...(scopedProfile.visualValidation ? ["visual" as const] : []),
    ];
    const resources = sorted([
      ...explicitResources,
      ...(generated || binary ? (scopedFacts.length ? scopedFacts.map((f) => f.path) : scope) : []),
    ]);
    return {
      ...source,
      baseSha: input.baseSha,
      validationCommands: w.validationCommands,
      context: { ...manifest, dependencyEvidence: [] },
      changeSurface: { mergeClass, exclusiveResources: resources },
      validation: tiers.map((tier) => ({ tier, criteria: w.acceptance })),
      economicReview: {
        conservative: true,
        rationale: "Assessment pending graph validation",
        paidMeasurementRequired: false,
      },
    };
  });
  // Scope overlap has one safe mechanical repair: serialize the later
  // provider-emitted item after the earlier one. Do this before deriving
  // delivery hints so both strict validation and stack topology see the
  // repaired DAG.
  const serialized = addScopeSerializationEdges({
    title: input.title,
    workItems: analyzed,
  }).workItems;
  const depends = (from: string, to: string): boolean => {
    const pending = [from],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(serialized.find((item) => item.id === id)?.dependsOn ?? []));
    }
    return false;
  };
  for (let i = 0; i < serialized.length; i++)
    for (let j = i + 1; j < serialized.length; j++) {
      const a = serialized[i]!,
        b = serialized[j]!;
      if (
        a.changeSurface.exclusiveResources.some((resource) =>
          b.changeSurface.exclusiveResources.includes(resource),
        ) &&
        !depends(a.id, b.id) &&
        !depends(b.id, a.id)
      )
        b.dependsOn = sorted([...b.dependsOn, a.id]);
    }
  const analyzedById = new Map(serialized.map((w) => [w.id, w]));
  const childCounts = new Map<string, number>();
  for (const item of serialized) {
    for (const parent of item.dependsOn) {
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
  }
  const stackGroup = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const item = analyzedById.get(current);
      if (!item || item.dependsOn.length !== 1) return current;
      const parent = item.dependsOn[0]!;
      // Every child of a fan-out starts a distinct sibling delivery group.
      // Otherwise a later join cannot distinguish the diamond's branches.
      if ((childCounts.get(parent) ?? 0) > 1) return current;
      current = parent;
    }
    return id;
  };
  const items = serialized.map((w) => {
    if (w.dependsOn.length === 0)
      return { ...w, delivery: { group: w.id, relationship: "root" as const } };
    if (w.dependsOn.length === 1) {
      const parent = w.dependsOn[0]!;
      if ((childCounts.get(parent) ?? 0) > 1) {
        return {
          ...w,
          delivery: { group: w.id, relationship: "sibling" as const },
        };
      }
      const group = stackGroup(parent);
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
  validateCompiledObjective(result, facts);
  const assessment = assessDecomposition(result.workItems);
  if (assessment.redundantItemPairs.length)
    throw new Error(
      `uneconomic duplicate deliverables: ${assessment.redundantItemPairs.map((pair) => pair.join(" / ")).join(", ")}. ${assessment.feedback[0]}`,
    );
  for (const item of result.workItems)
    item.economicReview.rationale = economicRationale(assessment);
  return result;
}

export function serializeCompilerObjective(objective: CompilerObjective): string {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value as Record<string, unknown>)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(value);
  return canonical(canonicalizeObjective(objective));
}
