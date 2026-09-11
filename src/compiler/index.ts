import {
  ExecutionRequirementsSchema,
  RepositoryScopePathSchema,
  type ExecutionRequirements,
} from "../protocol/worker-packet.js";
import { addScopeSerializationEdges } from "../graph.js";
import {
  assertRequirementsWithinPolicy,
  DEFAULT_RUN_POLICY,
  type RunPolicy,
} from "../protocol/policy.js";
import { z } from "zod";
import { assessDecomposition, economicRationale, type DecompositionEvidence } from "./economics.js";
export {
  assessDecomposition,
  economicRequirements,
  type DecompositionAssessment,
  type DecompositionEvidence,
} from "./economics.js";
import {
  buildContextManifest,
  discoverValidationCommands,
  isGroundedValidationCommand,
  normalizeRepositoryFacts,
  profileRepository,
  type RepositoryFacts,
} from "../repository-profiles/index.js";
import { groundExecutionRequirements } from "./requirements.js";
import {
  type CriterionRiskAssessment,
  type CriterionValidationTier,
  type CriterionValidationDesign,
  inferCriterionRisk,
  validateCriterionValidationDesign,
} from "./validation-design.js";
import {
  assertFutureToolchainRequirements,
  DEFERRED_CAPABILITY_ADAPTERS,
  futureToolchainCommand,
  isFutureToolchainProvider,
  managedRuntimeRequirements,
  repositoryLacksFutureToolchainAuthority,
  unprovisionedFutureToolchainReason,
} from "../toolchains/authority.js";
import { bindDeferredCapabilityGraph } from "../repository-capabilities/model.js";

export type ConflictClass = "parallel-safe" | "exclusive" | "generated" | "large-binary";
export type ValidationTier = CriterionValidationTier;
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
  repositoryCapabilities?: import("../protocol/worker-packet.js").RepositoryCapabilityBindings;
  managedRuntimes?: import("../runtime/toolchain-bundle.js").RuntimeBundleRequirement[];
  context: {
    mustRead: string[];
    searchSeeds: string[];
    dependencyEvidence: Array<{ workItem: string; commit: string }>;
  };
  changeSurface: { mergeClass: ConflictClass; exclusiveResources: string[] };
  validation: CriterionValidationDesign[];
  criterionRisks: CriterionRiskAssessment[];
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
  | "context"
  | "changeSurface"
  | "validation"
  | "criterionRisks"
  | "delivery"
  | "economicReview"
  | "repositoryCapabilities"
  | "managedRuntimes"
> & {
  exclusiveResources?: string[] | undefined;
  validation?: CriterionValidationDesign[] | undefined;
  criterionRisks?: CriterionRiskAssessment[] | undefined;
};
export type CompileInput = {
  title: string;
  baseSha: string;
  repositoryFacts: RepositoryFacts;
  workItems: CompilerWorkItemInput[];
  /** Immutable active policy. Omitted only by legacy direct callers, which receive product defaults. */
  runPolicy?: RunPolicy;
  economicEvidence?: DecompositionEvidence;
};

const sorted = (xs: string[]) => [...new Set(xs)].sort();
const dependencyOrder = <T extends { id: string; dependsOn: string[] }>(items: T[]): T[] => {
  // Let the structural validator report duplicates without losing either
  // entry through ID-keyed ordering state.
  if (new Set(items.map((item) => item.id)).size !== items.length) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const remaining = new Set(byId.keys());
  const ordered: T[] = [];
  while (remaining.size) {
    const next = items.find(
      (item) =>
        remaining.has(item.id) && item.dependsOn.every((dependency) => !remaining.has(dependency)),
    );
    // Invalid cycles are rejected by validateCompiledObjective. Keep this
    // total so validation, rather than an ordering loop, reports the defect.
    if (!next) {
      ordered.push(...items.filter((item) => remaining.has(item.id)));
      break;
    }
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
};
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
  const workItems = input.workItems.map((w) => ({
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
              (a, b) => a.workItem.localeCompare(b.workItem) || a.commit.localeCompare(b.commit),
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
            .map((v) => ({
              ...v,
              criteria: sorted(v.criteria),
              evidenceCommands: sorted(v.evidenceCommands),
            }))
            .sort((a, b) => a.tier.localeCompare(b.tier)),
        }
      : {}),
    ...(w.criterionRisks
      ? {
          criterionRisks: [...w.criterionRisks].sort((a, b) =>
            a.criterion.localeCompare(b.criterion),
          ),
        }
      : {}),
  }));
  return {
    title: input.title,
    workItems: dependencyOrder(workItems),
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
    ...(r.evidence
      ? {
          evidence: [...r.evidence].sort(
            (a, b) =>
              a.field.localeCompare(b.field) ||
              a.kind.localeCompare(b.kind) ||
              a.source.localeCompare(b.source),
          ),
        }
      : {}),
  };
}

export function validateCompiledObjective(
  objective: CompilerObjective,
  commandEvidence?: string[] | RepositoryFacts,
): void {
  if (objective.workItems.length < 1 || objective.workItems.length > 100)
    throw new Error("Work Item count is out of bounds");
  const violations: string[] = [];
  const reject = (message: string): void => {
    if (!violations.includes(message)) violations.push(message);
  };
  const capture = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error));
    }
  };
  const throwViolations = (): void => {
    if (violations.length === 0) return;
    if (violations.length === 1) throw new Error(violations[0]);
    throw new Error(
      `compiled Objective has ${violations.length} deterministic violations:\n${violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  };
  const byId = new Map<string, CompilerWorkItem>();
  const observed = commandEvidence
    ? Array.isArray(commandEvidence)
      ? commandEvidence
      : discoverValidationCommands(commandEvidence)
    : [];
  const facts = !Array.isArray(commandEvidence) ? commandEvidence : undefined;
  const basePaths = new Set(
    facts ? normalizeRepositoryFacts(facts).files.map((file) => file.path) : [],
  );
  const hasAbsentFutureAuthority = (command: string): boolean => {
    const parsed = futureToolchainCommand(command);
    return Boolean(parsed && repositoryLacksFutureToolchainAuthority(parsed.adapter, basePaths));
  };
  const ungrounded: Array<{ item: CompilerWorkItem; command: string }> = [];
  for (const w of objective.workItems) {
    if (byId.has(w.id)) reject(`duplicate Work Item id ${w.id}`);
    byId.set(w.id, w);
    w.scope.forEach((p) => capture(() => void RepositoryScopePathSchema.parse(p)));
    if (w.acceptance.length < 1 || w.acceptance.length > 64)
      reject(`invalid acceptance criteria in ${w.id}: provide between 1 and 64 criteria`);
    for (const [index, criterion] of w.acceptance.entries()) {
      const problem = acceptanceTextProblem(criterion);
      if (problem)
        reject(
          `invalid acceptance criterion ${index + 1} in ${w.id}: ${problem}; state a concrete expected behavior or result and associate it with validation evidence`,
        );
    }
    if (w.validationCommands.length < 1) reject(`missing validation command in ${w.id}`);
    if (commandEvidence) {
      for (const command of w.validationCommands)
        if (
          Array.isArray(commandEvidence)
            ? !commandEvidence.includes(command)
            : !isGroundedValidationCommand(command, commandEvidence, w.scope, {
                root: w.dependsOn.length === 0,
                tools: w.requirements.tools,
              })
        )
          ungrounded.push({ item: w, command });
      if (
        facts &&
        w.dependsOn.length === 0 &&
        w.validationCommands.some(hasAbsentFutureAuthority) &&
        w.validationCommands.length !== 1
      )
        reject(`greenfield validation in ${w.id} must name exactly one toolchain script`);
      if (facts && w.validationCommands.some(hasAbsentFutureAuthority)) {
        for (const command of w.validationCommands) {
          const parsed = futureToolchainCommand(command);
          if (parsed && repositoryLacksFutureToolchainAuthority(parsed.adapter, basePaths))
            capture(() =>
              assertFutureToolchainRequirements(
                parsed,
                {
                  allowedPaths: w.scope,
                  requirements: w.requirements,
                },
                false,
              ),
            );
        }
      }
    }
    if (
      !w.context ||
      !w.changeSurface ||
      !w.validation ||
      !w.criterionRisks ||
      !w.delivery ||
      !w.economicReview
    )
      reject(`missing compiler analysis record in ${w.id}`);
    if (
      w.context &&
      (w.context.mustRead.length > 64 ||
        w.context.searchSeeds.length > 64 ||
        w.context.dependencyEvidence.length > 64)
    )
      reject(`unbounded context manifest in ${w.id}`);
    const validationProfile =
      commandEvidence && !Array.isArray(commandEvidence)
        ? profileRepository({
            files: commandEvidence.files.filter((file) =>
              w.scope.some((path) =>
                path.endsWith("/") ? file.path.startsWith(path) : file.path === path,
              ),
            ),
            ...(commandEvidence.scripts === undefined ? {} : { scripts: commandEvidence.scripts }),
          })
        : undefined;
    if (w.validation && w.criterionRisks)
      capture(() =>
        validateCriterionValidationDesign({
          itemId: w.id,
          acceptance: w.acceptance,
          validationCommands: w.validationCommands,
          validation: w.validation!,
          criterionRisks: w.criterionRisks!,
          deterministicSimulation: validationProfile?.deterministicSimulation ?? true,
          visualValidation: validationProfile?.visualValidation ?? true,
        }),
      );
    if (w.changeSurface) {
      if (w.changeSurface.exclusiveResources.length > 64)
        reject(`unbounded exclusive resources in ${w.id}`);
      if (
        w.changeSurface.mergeClass === "parallel-safe" &&
        w.changeSurface.exclusiveResources.length
      )
        reject(`invalid exclusive resources in ${w.id}`);
      if (
        w.changeSurface.mergeClass !== "parallel-safe" &&
        !w.changeSurface.exclusiveResources.length
      )
        reject(`missing exclusive resource in ${w.id}`);
    }
    if (
      w.economicReview &&
      (!w.economicReview.conservative || w.economicReview.paidMeasurementRequired)
    )
      reject(`non-conservative economic review in ${w.id}`);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      reject("dependency cycle");
      return;
    }
    if (done.has(id)) return;
    const w = byId.get(id);
    if (!w) {
      reject(`unknown dependency ${id}`);
      return;
    }
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
  const futureProviders = new Map<string, CompilerWorkItem[]>();
  if (facts)
    for (const item of byId.values()) {
      const parsed =
        item.validationCommands.length === 1
          ? futureToolchainCommand(item.validationCommands[0]!)
          : null;
      if (
        parsed &&
        repositoryLacksFutureToolchainAuthority(parsed.adapter, basePaths) &&
        isFutureToolchainProvider({
          allowedPaths: item.scope,
          requirements: item.requirements,
          validationCommands: item.validationCommands,
          dependsOn: item.dependsOn,
        })
      )
        futureProviders.set(parsed.adapter.id, [
          ...(futureProviders.get(parsed.adapter.id) ?? []),
          item,
        ]);
    }
  if (ungrounded.length > 0) {
    for (const invalid of ungrounded.filter(({ item, command }) => {
      const parsed = futureToolchainCommand(command);
      const providers = parsed ? (futureProviders.get(parsed.adapter.id) ?? []) : [];
      return !providers.some((provider) => path(item.id, provider.id));
    })) {
      const unavailable = facts ? unprovisionedFutureToolchainReason(invalid.command) : undefined;
      const future = facts ? futureToolchainCommand(invalid.command) : null;
      const presentAuthorityPaths = future
        ? future.adapter.requiredRootPaths.filter((path) => basePaths.has(path))
        : [];
      const partialFutureAuthority =
        future &&
        presentAuthorityPaths.length > 0 &&
        presentAuthorityPaths.length < future.adapter.requiredRootPaths.length
          ? `${future.adapter.runner} future authority is partially present ` +
            `(${presentAuthorityPaths.join(", ")}); Factory will not replace or complete an ` +
            `observed package-manager authority surface from a compiler-proposed bootstrap ` +
            `(Work Item ${invalid.item.id})`
          : undefined;
      reject(
        partialFutureAuthority ??
          (unavailable
            ? `${unavailable} (Work Item ${invalid.item.id})`
            : `invented validation command in ${invalid.item.id}: ${JSON.stringify(invalid.command.slice(0, 200))}; repository-observed commands: ${JSON.stringify(observed).slice(0, 600)}. Use an observed command, specialize an observed bare node --test with concrete existing or Work Item-scoped JavaScript test files, or bind a finite script to one audited future-capable toolchain provider and its transitive dependency path; flags, shell syntax, unplanned targets, siblings, and unrelated roots are not allowed.`),
      );
    }
  }
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
        reject(`overlapping unordered scopes: ${a.id}, ${b.id}`);
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
        reject(`conflicting unordered exclusive resource: ${a.id}, ${b.id}`);
    }
  for (const w of items) {
    const d = w.delivery;
    if (!d) continue;
    if (
      d.relationship === "root" &&
      (d.parentWorkItem || w.dependsOn.length !== 0 || d.group !== w.id)
    )
      reject(`impossible root topology for ${w.id}`);
    if (
      d.relationship === "continue-stack" &&
      (!d.parentWorkItem ||
        w.dependsOn.length !== 1 ||
        w.dependsOn[0] !== d.parentWorkItem ||
        byId.get(d.parentWorkItem)?.delivery?.group !== d.group)
    )
      reject(`impossible stack topology for ${w.id}`);
    if (d.relationship === "join-after-merge") {
      const groups = w.dependsOn.map((id) => byId.get(id)?.delivery?.group);
      if (
        d.parentWorkItem ||
        w.dependsOn.length < 2 ||
        groups.some((g) => !g) ||
        new Set(groups).size !== groups.length ||
        groups.includes(d.group)
      )
        reject(`impossible join topology for ${w.id}`);
    }
    if (
      d.relationship === "sibling" &&
      (d.parentWorkItem ||
        w.dependsOn.length !== 1 ||
        byId.get(w.dependsOn[0]!)?.delivery?.group === d.group ||
        d.group !== w.id)
    )
      reject(`impossible sibling topology for ${w.id}`);
  }
  throwViolations();
}

export function compileObjective(input: CompileInput): CompilerObjective {
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha)) throw new Error("invalid base SHA");
  const facts = normalizeRepositoryFacts(input.repositoryFacts);
  const runPolicy = input.runPolicy ?? DEFAULT_RUN_POLICY;
  if (facts.lfs !== undefined && facts.lfs.baseSha !== input.baseSha)
    throw new Error("LFS repository facts do not match the pinned compilation base");
  const analyzed = input.workItems.map((w) => {
    const explicitResources = sorted(ExclusiveResourcesSchema.parse(w.exclusiveResources ?? []));
    const {
      exclusiveResources: _claims,
      validation: authoredValidation,
      criterionRisks: authoredCriterionRisks,
      ...source
    } = w;
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
    const validation = authoredValidation ?? [
      {
        tier: "semantic" as const,
        criteria: w.acceptance,
        rationale:
          "No criterion-specific deterministic binding was supplied; conservative semantic review is retained.",
        evidenceCommands: [],
      },
    ];
    const criterionRisks =
      authoredCriterionRisks ??
      w.acceptance.map((criterion) => ({ criterion, risk: inferCriterionRisk(criterion) }));
    const resources = sorted([
      ...explicitResources,
      ...(generated || binary ? (scopedFacts.length ? scopedFacts.map((f) => f.path) : scope) : []),
    ]);
    return {
      ...source,
      baseSha: input.baseSha,
      requirements: groundExecutionRequirements(
        {
          ...w.requirements,
          tools: sorted([...w.requirements.tools, ...(facts.lfs?.requiredTools ?? [])]),
        },
        facts,
        scope,
        runPolicy,
      ),
      validationCommands: w.validationCommands,
      context: { ...manifest, dependencyEvidence: [] },
      changeSurface: { mergeClass, exclusiveResources: resources },
      validation,
      criterionRisks,
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
  const basePaths = new Set(facts.files.map((file) => file.path));
  const deferred = bindDeferredCapabilityGraph(
    result.workItems,
    DEFERRED_CAPABILITY_ADAPTERS,
    (item, command) => {
      const parsed = futureToolchainCommand(command);
      return Boolean(
        parsed &&
          !isGroundedValidationCommand(command, facts, [...item.scope], undefined) &&
          repositoryLacksFutureToolchainAuthority(parsed.adapter, basePaths),
      );
    },
  );
  for (const item of result.workItems) {
    const bindings = deferred.get(item.id)!;
    if (bindings.provides.length > 0 || bindings.requires.length > 0)
      item.repositoryCapabilities = bindings;
    const runtimes = managedRuntimeRequirements(item.validationCommands);
    if (runtimes.length > 0) item.managedRuntimes = runtimes;
  }
  for (const item of result.workItems)
    assertRequirementsWithinPolicy(item.requirements, runPolicy, `Work Item ${item.id}`);
  validateCompiledObjective(result, facts);
  applyEconomicReview(result, input.economicEvidence);
  return result;
}

/** Applied before the immutable compilation checkpoint; never rerun on recovered graphs. */
export function applyEconomicReview(
  result: CompilerObjective,
  evidence?: DecompositionEvidence,
): void {
  const assessment = assessDecomposition(result.workItems, evidence);
  if (assessment.redundantItemPairs.length)
    throw new Error(
      `uneconomic duplicate deliverables: ${assessment.redundantItemPairs.map((pair) => pair.join(" / ")).join(", ")}. ${assessment.feedback[0]}`,
    );
  for (const item of result.workItems)
    item.economicReview.rationale = economicRationale(assessment, item.id);
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
