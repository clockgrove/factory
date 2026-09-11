/**
 * Graph application: apply a compiled Objective (`skills/objective-compilation`)
 * to GitHub as sub-issues plus native `blocked by` relationships (§3).
 *
 * This module is deliberately dumb. `objective-compilation` already decided
 * *what* the work is — every field on a `CompiledWorkItem` is final by the
 * time it reaches here. `applyGraph` only turns that decision into GitHub
 * primitives: one `createIssue` per Work Item (with `parentIssueId` set, so
 * the sub-issue relationship exists from creation — no separate `addSubIssue`
 * call needed for the common case) and one `addBlockedBy` per declared
 * dependency. Nothing here chooses scope, writes acceptance criteria, or
 * decides what should block what.
 *
 * `renderWorkPacket` is the one formatting decision this module makes, and it
 * is formatting, not judgment: the Work Packet *is* the prompt (Agent
 * Tasks/`agentAssignment` takes no separate prompt field), so a created issue's
 * body is simply its already-compiled Work Packet fields (§8) rendered as
 * markdown. `dispatch.ts`'s `assignCopilot` does not set
 * `customInstructions` — the issue body this module writes is the whole prompt
 * the coding agent will read.
 *
 * Deliberately does *not* assign Copilot at creation time, even though
 * `CreateIssueInput` accepts an `agentAssignment` field directly: assignment
 * must wait for `ready()`
 * (§3.2 — every `blocked by` issue closed), which a Work Item with
 * dependencies cannot satisfy at the moment its own issue is created.
 * Dispatch stays `dispatch.ts`'s job, driven by state derived fresh next
 * cycle, exactly as it already is for every other Work Item.
 */

import { createHash } from "node:crypto";

import type { Octokit } from "@octokit/core";
import {
  observeMutationOperation,
  observeMutationFence,
  observeMutationQueue,
  type MutationOperationObservation,
} from "./control/mutation-observation.js";
import { z } from "zod";

import { createOctokit, type GitHubOptions } from "./github.js";
import {
  ChangeSurfaceSchema,
  ContextManifestSchema,
  CriterionRiskAssessmentSchema,
  DeliveryHintSchema,
  ExecutionRequirementsSchema,
  RepositoryCapabilityBindingsSchema,
  RepositoryScopePathSchema,
  RuntimeBundleRequirementSchema,
  ValidationDesignSchema,
  parseWorkerPacket,
  type ExecutionRequirements,
  type RepositoryCapabilityBindings,
  type WorkerPacket,
} from "./protocol/worker-packet.js";
import { assertWithinBytes } from "./protocol/limits.js";
import { validateCapabilityGraphBindings } from "./repository-capabilities/model.js";
import {
  DEFERRED_CAPABILITY_ADAPTERS,
  managedRuntimeRequirements,
} from "./toolchains/authority.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  MutationScheduler,
  PlatformUnavailableError,
  classifyRefusal,
  isSecondaryRateLimitRefusal,
  type MutationAdmission,
} from "./platform.js";

/**
 * One compiled Work Item, matching `schemas/work-item.schema.json`. `id` is
 * compiler-local (§ the schema's own description) and never sent to GitHub —
 * it exists only so `dependsOn` can reference a sibling before either has a
 * real issue number.
 */
export interface CompiledWorkItem {
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  scope: string[];
  preconditions: string[];
  outOfScope: string[];
  conventions: string[];
  dependsOn: string[];
  /** V2 execution fields. Optional only while reading legacy v1 compiler output. */
  baseSha?: string | undefined;
  validationCommands?: string[] | undefined;
  requirements?: ExecutionRequirements | undefined;
  artifactContract?: "clockgrove.factory/artifact-v1" | undefined;
  /** Compiler analysis fields are optional only for persisted pre-vNext graphs. */
  context?: z.infer<typeof ContextManifestSchema> | undefined;
  changeSurface?: z.infer<typeof ChangeSurfaceSchema> | undefined;
  criterionRisks?:
    | Array<{
        criterion: string;
        risk: "ordinary" | "safety" | "security" | "destructive-action" | "accounting" | "recovery";
      }>
    | undefined;
  validation?:
    | Array<{
        tier: "mechanical" | "semantic" | "visual" | "deterministic-simulation";
        criteria: string[];
        rationale?: string | undefined;
        evidenceCommands?: string[] | undefined;
      }>
    | undefined;
  delivery?: z.infer<typeof DeliveryHintSchema> | undefined;
  economicReview?:
    | {
        conservative: boolean;
        rationale: string;
        paidMeasurementRequired: boolean;
      }
    | undefined;
  repositoryCapabilities?: RepositoryCapabilityBindings | undefined;
  managedRuntimes?: z.infer<typeof RuntimeBundleRequirementSchema>[] | undefined;
}

/** Matches `schemas/objective.schema.json` — the objective-compilation skill's output. */
export interface CompiledObjective {
  title: string;
  workItems: CompiledWorkItem[];
  /** Host-derived objective-wide classification; omitted only by authenticated historical graphs. */
  deferredCapabilityAdapters?: string[] | undefined;
}

/**
 * A pre-v2 Work Item is untrusted input, not a recoverable compiled graph. These
 * fields are the bounded human-authored core Factory may preserve while a new
 * compiler run adds the v2 execution packet. The compiler-local ID is derived
 * mechanically from the immutable issue number so a recovery plan can bind the
 * future projection before any model invocation occurs.
 */
export interface LegacyWorkItemConstraint {
  compilerId: string;
  issueNodeId: string;
  issueNumber: number;
  title: string;
  goal: string;
  acceptance: string[];
  scope: string[];
  preconditions: string[];
  outOfScope: string[];
  conventions: string[];
  blockedByNumbers: number[];
}

export interface LegacyGraphConstraints {
  protocol: "clockgrove.factory/legacy-graph-constraints-v1";
  objectiveTitle: string;
  workItems: LegacyWorkItemConstraint[];
}

const LEGACY_HEADINGS = [
  "Goal",
  "Acceptance",
  "Scope",
  "Preconditions",
  "Out of scope",
  "Conventions",
] as const;

/** Parse only Factory's historical six-section Work Item shape. */
export function parseLegacyWorkItemConstraint(input: {
  id: string;
  number: number;
  title: string;
  body: string;
  blockedByNumbers: number[];
}): LegacyWorkItemConstraint {
  if (!input.id || input.id.length > 200)
    throw new Error("legacy Work Item node identity is invalid");
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("legacy Work Item number is invalid");
  if (!input.title.trim() || input.title.length > 256)
    throw new Error(`legacy Work Item #${input.number} title is invalid`);
  assertWithinBytes(input.body, 128 * 1024, `legacy Work Item #${input.number}`);
  if (/clockgrove-factory:(?:worker-packet|graph-item)/i.test(input.body))
    throw new Error(`Work Item #${input.number} contains partial or malformed Factory metadata`);

  const headings = [...input.body.matchAll(/^##[ \t]+([^\r\n]+?)[ \t]*$/gm)];
  if (
    headings.length !== LEGACY_HEADINGS.length ||
    headings.some((match, index) => match[1] !== LEGACY_HEADINGS[index])
  )
    throw new Error(
      `Work Item #${input.number} must contain exactly the six ordered legacy sections`,
    );

  const sections = new Map<string, string>();
  for (const [index, match] of headings.entries()) {
    const start = match.index! + match[0].length;
    const end = headings[index + 1]?.index ?? input.body.length;
    sections.set(match[1]!, input.body.slice(start, end).trim());
  }
  if (input.body.slice(0, headings[0]!.index).trim())
    throw new Error(`Work Item #${input.number} has content before its Goal section`);

  const list = (heading: (typeof LEGACY_HEADINGS)[number], required = false): string[] => {
    const value = sections.get(heading) ?? "";
    const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.some((line) => !line.startsWith("- ") || !line.slice(2).trim()))
      throw new Error(`Work Item #${input.number} ${heading} must be a flat bullet list`);
    const items = lines.map((line) => line.slice(2).trim());
    if ((required && items.length === 0) || items.length > 64)
      throw new Error(`Work Item #${input.number} ${heading} item count is invalid`);
    if (items.some((item) => item.length > 2_000))
      throw new Error(`Work Item #${input.number} ${heading} item is too large`);
    return items;
  };
  const goal = sections.get("Goal") ?? "";
  if (!goal || goal.length > 4_000 || /^\s*[-#]/m.test(goal))
    throw new Error(`Work Item #${input.number} Goal must be bounded prose`);
  const blockedByNumbers = [...input.blockedByNumbers].sort((left, right) => left - right);
  if (
    blockedByNumbers.length > 50 ||
    new Set(blockedByNumbers).size !== blockedByNumbers.length ||
    blockedByNumbers.some(
      (number) => !Number.isSafeInteger(number) || number <= 0 || number === input.number,
    )
  )
    throw new Error(`Work Item #${input.number} has invalid legacy dependencies`);
  return {
    compilerId: `adopted-${input.number}`,
    issueNodeId: input.id,
    issueNumber: input.number,
    title: input.title,
    goal,
    acceptance: list("Acceptance", true),
    scope: list("Scope", true).map((path) => RepositoryScopePathSchema.parse(path)),
    preconditions: list("Preconditions"),
    outOfScope: list("Out of scope"),
    conventions: list("Conventions"),
    blockedByNumbers,
  };
}

export function parseLegacyGraphConstraints(input: {
  objectiveTitle: string;
  workItems: Array<{
    id: string;
    number: number;
    title: string;
    body: string;
    blockedByNumbers: number[];
  }>;
}): LegacyGraphConstraints {
  if (!input.objectiveTitle.trim() || input.objectiveTitle.length > 256)
    throw new Error("legacy Objective title is invalid");
  if (input.workItems.length < 1 || input.workItems.length > 100)
    throw new Error("legacy Objective must contain between 1 and 100 Work Items");
  const workItems = input.workItems.map(parseLegacyWorkItemConstraint);
  const numbers = new Set(workItems.map((item) => item.issueNumber));
  const nodes = new Set(workItems.map((item) => item.issueNodeId));
  if (numbers.size !== workItems.length || nodes.size !== workItems.length)
    throw new Error("legacy Objective contains duplicate Work Item identity");
  if (workItems.some((item) => item.blockedByNumbers.some((number) => !numbers.has(number))))
    throw new Error("legacy Objective has a dependency outside its Work Items");
  const byNumber = new Map(workItems.map((item) => [item.issueNumber, item]));
  const state = new Map<number, "visiting" | "done">();
  const visit = (number: number): void => {
    const mark = state.get(number);
    if (mark === "done") return;
    if (mark === "visiting") throw new Error("legacy Objective dependency graph contains a cycle");
    state.set(number, "visiting");
    for (const dependency of byNumber.get(number)!.blockedByNumbers) visit(dependency);
    state.set(number, "done");
  };
  for (const item of workItems) visit(item.issueNumber);
  return {
    protocol: "clockgrove.factory/legacy-graph-constraints-v1",
    objectiveTitle: input.objectiveTitle,
    workItems,
  };
}

export function legacyGraphConstraintsDigest(input: LegacyGraphConstraints): string {
  const parsed = parseLegacyGraphConstraints({
    objectiveTitle: input.objectiveTitle,
    workItems: input.workItems.map((item) => ({
      id: item.issueNodeId,
      number: item.issueNumber,
      title: item.title,
      body: renderLegacyWorkItemCore(item),
      blockedByNumbers: item.blockedByNumbers,
    })),
  });
  return createHash("sha256").update(canonical(parsed)).digest("hex");
}

/** Reconstruct the same bounded legacy core during an interrupted adoption.
 * Authenticated adopted bodies contribute only their immutable Worker Packet
 * core; raw bodies must still match the exact historical six-section shape. */
export function parseLegacyGraphConstraintsSnapshot(input: {
  objectiveTitle: string;
  workItems: Array<{
    id: string;
    number: number;
    title: string;
    body: string;
    blockedByNumbers: number[];
  }>;
}): LegacyGraphConstraints {
  return parseLegacyGraphConstraints({
    objectiveTitle: input.objectiveTitle,
    workItems: input.workItems.map((item) => {
      try {
        const metadata = parseGraphItemMetadata(item.body);
        if (metadata.id !== `adopted-${item.number}`)
          throw new Error(`Work Item #${item.number} has non-adoption graph metadata`);
        const packet = parseWorkerPacketFromIssue(item.body);
        return {
          ...item,
          body: renderLegacyWorkItemCore({
            goal: packet.goal,
            acceptance: packet.acceptanceCriteria,
            scope: packet.allowedPaths,
            preconditions: packet.preconditions,
            outOfScope: packet.outOfScope,
            conventions: packet.conventions,
          }),
        };
      } catch (error) {
        if (/clockgrove-factory:(?:worker-packet|graph-item)/i.test(item.body)) throw error;
        return item;
      }
    }),
  });
}

export function renderLegacyWorkItemCore(
  item: Pick<
    LegacyWorkItemConstraint,
    "goal" | "acceptance" | "scope" | "preconditions" | "outOfScope" | "conventions"
  >,
): string {
  const section = (heading: string, values: string[]) =>
    `## ${heading}\n\n${values.map((value) => `- ${value}`).join("\n")}`;
  return [
    `## Goal\n\n${item.goal}`,
    section("Acceptance", item.acceptance),
    section("Scope", item.scope),
    section("Preconditions", item.preconditions),
    section("Out of scope", item.outOfScope),
    section("Conventions", item.conventions),
  ].join("\n\n");
}

/** The model may enrich only fields absent from a legacy Work Item. */
export function assertCompiledObjectiveAdoptsLegacyConstraints(
  objective: CompiledObjective,
  constraints: LegacyGraphConstraints,
): void {
  if (
    objective.title !== constraints.objectiveTitle ||
    objective.workItems.length !== constraints.workItems.length
  )
    throw new Error("compiled Objective changed legacy graph identity or cardinality");
  const expectedIdByNumber = new Map(
    constraints.workItems.map((item) => [item.issueNumber, item.compilerId]),
  );
  for (const [index, expected] of constraints.workItems.entries()) {
    const actual = objective.workItems[index];
    if (!actual)
      throw new Error(`compiled Objective omitted legacy Work Item #${expected.issueNumber}`);
    const actualCore = {
      id: actual.id,
      title: actual.title,
      goal: actual.goal,
      acceptance: actual.acceptance,
      scope: actual.scope,
      preconditions: actual.preconditions,
      outOfScope: actual.outOfScope,
      conventions: actual.conventions,
      dependsOn: actual.dependsOn,
    };
    const expectedCore = {
      id: expected.compilerId,
      title: expected.title,
      goal: expected.goal,
      acceptance: expected.acceptance,
      scope: expected.scope,
      preconditions: expected.preconditions,
      outOfScope: expected.outOfScope,
      conventions: expected.conventions,
      dependsOn: expected.blockedByNumbers.map((number) => expectedIdByNumber.get(number)!),
    };
    if (canonical(actualCore) !== canonical(expectedCore))
      throw new Error(`compiled Objective changed legacy Work Item #${expected.issueNumber}`);
  }
}

function scopeOverlaps(left: string, right: string): boolean {
  const leftDirectory = left.endsWith("/");
  const rightDirectory = right.endsWith("/");
  if (!leftDirectory && !rightDirectory) return left === right;
  if (leftDirectory && rightDirectory) {
    return left.startsWith(right) || right.startsWith(left);
  }
  return leftDirectory ? right.startsWith(left) : left.startsWith(right);
}

function dependsTransitivelyOn(
  byId: Map<string, CompiledWorkItem>,
  from: string,
  target: string,
): boolean {
  const pending = [...(byId.get(from)?.dependsOn ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

/**
 * A compiler may correctly identify shared files while forgetting to order the
 * affected Work Items. That omission has one safe mechanical repair: preserve
 * compiler order by making the later item depend on the earlier item. All
 * semantic graph errors remain validation failures.
 */
export function addScopeSerializationEdges<T extends CompiledObjective>(objective: T): T {
  const normalized = {
    ...objective,
    workItems: objective.workItems.map((item) => ({
      ...item,
      dependsOn: [...item.dependsOn],
    })),
  } as T;
  const byId = new Map(normalized.workItems.map((item) => [item.id, item]));
  for (let leftIndex = 0; leftIndex < normalized.workItems.length; leftIndex += 1) {
    const left = normalized.workItems[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalized.workItems.length;
      rightIndex += 1
    ) {
      const right = normalized.workItems[rightIndex]!;
      const overlapping = left.scope.some((leftPath) =>
        right.scope.some((rightPath) => scopeOverlaps(leftPath, rightPath)),
      );
      if (
        overlapping &&
        !dependsTransitivelyOn(byId, left.id, right.id) &&
        !dependsTransitivelyOn(byId, right.id, left.id)
      ) {
        right.dependsOn.push(left.id);
      }
    }
  }
  return normalized;
}

const PersistedCompiledWorkItemSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(64),
    title: z.string().min(1).max(256),
    goal: z.string().min(1).max(4_000),
    acceptance: z.array(z.string().min(1).max(2_000)).min(1).max(64),
    scope: z.array(RepositoryScopePathSchema).min(1).max(64),
    preconditions: z.array(z.string().min(1).max(2_000)).max(64),
    outOfScope: z.array(z.string().min(1).max(2_000)).max(64),
    conventions: z.array(z.string().min(1).max(2_000)).max(64),
    dependsOn: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .max(64),
      )
      .max(50),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
    validationCommands: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    requirements: ExecutionRequirementsSchema,
    artifactContract: z.literal("clockgrove.factory/artifact-v1"),
    context: ContextManifestSchema.optional(),
    changeSurface: ChangeSurfaceSchema.optional(),
    criterionRisks: CriterionRiskAssessmentSchema.optional(),
    validation: ValidationDesignSchema.optional(),
    delivery: DeliveryHintSchema.optional(),
    economicReview: z
      .object({
        conservative: z.boolean(),
        rationale: z.string().min(1).max(2_000),
        paidMeasurementRequired: z.boolean(),
      })
      .strict()
      .optional(),
    repositoryCapabilities: RepositoryCapabilityBindingsSchema.optional(),
    managedRuntimes: z.array(RuntimeBundleRequirementSchema).min(1).max(8).optional(),
  })
  .strict();

const PersistedCompiledObjectiveSchema = z
  .object({
    title: z.string().min(1).max(256),
    workItems: z.array(PersistedCompiledWorkItemSchema).min(1).max(100),
    deferredCapabilityAdapters: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .max(64),
      )
      .max(16)
      .optional(),
  })
  .strict();

export function parsePersistedCompiledObjective(input: unknown): CompiledObjective {
  const objective = PersistedCompiledObjectiveSchema.parse(input);
  validateGraphShape(objective, true);
  return objective;
}

/** A created Work Item issue, keyed by the compiled graph's own `id`. */
export interface CreatedWorkItem {
  id: string;
  number: number;
}

/**
 * Graph-level invariants `schemas/work-item.schema.json` cannot express
 * structurally (its own description says so): unique `id`s, every
 * `dependsOn` resolving to a sibling, and an acyclic dependency graph. The
 * compiling skill is asked to self-check these before emitting
 * (`skills/objective-compilation/SKILL.md`), but a skill is a fallible,
 * model-driven step — this is the same cheap-mechanical-check-before-a-write
 * discipline `evaluate.ts` applies to PRs, applied here to a graph before any
 * GitHub issue exists. Throws with a message naming the specific violation;
 * never partially applies a graph it has rejected.
 */
function validateGraphShape(
  objective: CompiledObjective,
  allowAuthenticatedLegacyOmissions: boolean,
): void {
  if (objective.workItems.length < 1 || objective.workItems.length > 100) {
    throw new Error("compiled Objective must contain between 1 and 100 Work Items");
  }
  const ids = new Set<string>();
  for (const wi of objective.workItems) {
    if (ids.has(wi.id)) {
      throw new Error(`duplicate Work Item id: ${wi.id}`);
    }
    ids.add(wi.id);
  }
  for (const wi of objective.workItems) {
    for (const dep of wi.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Work Item ${wi.id} depends on unknown id ${dep}`);
      }
      if (dep === wi.id) {
        throw new Error(`Work Item ${wi.id} depends on itself`);
      }
    }
  }

  // Cycle check: a plain DFS over the dependsOn edges. Objective graphs are
  // small enough that there is no need for anything more clever.
  const byId = new Map(objective.workItems.map((wi) => [wi.id, wi]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`dependency cycle: ${[...path, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.dependsOn) {
      visit(dep, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const wi of objective.workItems) visit(wi.id, []);

  // Two scopes overlap when they name the same file/directory, when an exact
  // file sits below a directory scope, or when two directory scopes nest. A
  // dependency path in either direction serializes the pair. Without one,
  // both items can enter the same wave and independently publish changes to
  // the same path, so reject that graph before its first GitHub write.
  for (let leftIndex = 0; leftIndex < objective.workItems.length; leftIndex += 1) {
    const left = objective.workItems[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < objective.workItems.length; rightIndex += 1) {
      const right = objective.workItems[rightIndex]!;
      const overlapping = left.scope.some((leftPath) =>
        right.scope.some((rightPath) => scopeOverlaps(leftPath, rightPath)),
      );
      if (
        overlapping &&
        !dependsTransitivelyOn(byId, left.id, right.id) &&
        !dependsTransitivelyOn(byId, right.id, left.id)
      ) {
        throw new Error(
          `Work Items ${left.id} and ${right.id} have overlapping scopes but no dependency path`,
        );
      }
    }
  }

  if (!allowAuthenticatedLegacyOmissions && objective.deferredCapabilityAdapters === undefined)
    throw new Error("compiled Objective lacks deferred capability adapter disposition");
  validateCapabilityGraphBindings(
    objective.workItems,
    DEFERRED_CAPABILITY_ADAPTERS,
    objective.deferredCapabilityAdapters,
  );

  for (const wi of objective.workItems) {
    if (wi.validationCommands) {
      const expectedRuntimes = managedRuntimeRequirements(
        wi.validationCommands,
        wi.repositoryCapabilities,
      );
      if ((wi.managedRuntimes ?? []).some(({ bundleDigest }) => bundleDigest !== undefined))
        throw new Error(`Work Item ${wi.id} immutable graph selected a managed runtime bundle`);
      if (
        !(
          allowAuthenticatedLegacyOmissions &&
          wi.managedRuntimes === undefined &&
          expectedRuntimes.length > 0
        ) &&
        JSON.stringify(wi.managedRuntimes ?? []) !== JSON.stringify(expectedRuntimes)
      )
        throw new Error(
          `Work Item ${wi.id} managed runtime contract differs from canonical host derivation: observed ${JSON.stringify(wi.managedRuntimes ?? [])}; expected ${JSON.stringify(expectedRuntimes)}`,
        );
    }
    const v2Fields = [wi.baseSha, wi.validationCommands, wi.requirements, wi.artifactContract];
    if (v2Fields.some((value) => value !== undefined)) {
      workerPacketFromCompiled(wi);
    }
  }
}

export function validateGraph(objective: CompiledObjective): void {
  validateGraphShape(objective, false);
}

const WORKER_PACKET_MARKER = "clockgrove-factory:worker-packet";
const GRAPH_ITEM_MARKER = "clockgrove-factory:graph-item";

const GraphItemMetadataSchema = z.object({
  protocol: z.literal("clockgrove.factory/graph-v1"),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64),
  graphDigest: z.string().regex(/^[0-9a-f]{64}$/),
  graphSize: z.number().int().positive().max(100),
  index: z.number().int().nonnegative().max(99),
  dependsOn: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(64),
    )
    .max(50),
  /** Repeated in every current issue envelope so a complete projection can reconstruct the graph. */
  deferredCapabilityAdapters: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(64),
    )
    .max(16)
    .optional(),
});

export type GraphItemMetadata = z.infer<typeof GraphItemMetadataSchema>;

export function graphCapabilityDisposition(
  metadata: readonly GraphItemMetadata[],
): string[] | undefined {
  if (metadata.length === 0) return undefined;
  const dispositions = new Set(
    metadata.map((entry) => JSON.stringify(entry.deferredCapabilityAdapters)),
  );
  if (dispositions.size !== 1)
    throw new Error("Work Items disagree on deferred capability adapter disposition");
  return metadata[0]!.deferredCapabilityAdapters;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeCompiledObjective(objective: CompiledObjective): Buffer {
  const parsed = parsePersistedCompiledObjective(objective);
  const serialized = Buffer.from(canonical(parsed), "utf8");
  assertWithinBytes(serialized.toString("utf8"), 2 * 1024 * 1024, "compiled graph");
  return serialized;
}

export function compiledGraphDigest(objective: CompiledObjective): string {
  validateGraphShape(objective, true);
  return createHash("sha256").update(canonical(objective)).digest("hex");
}

export function encodeGraphItemMetadata(metadata: GraphItemMetadata): string {
  const value = GraphItemMetadataSchema.parse(metadata);
  return `<!-- ${GRAPH_ITEM_MARKER} ${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")} -->`;
}

export function parseGraphItemMetadata(body: string): GraphItemMetadata {
  const pattern = new RegExp(`<!--\\s*${GRAPH_ITEM_MARKER}\\s+([A-Za-z0-9_-]+)\\s*-->`, "g");
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error("Work Item must contain exactly one graph-item envelope");
  }
  return GraphItemMetadataSchema.parse(
    JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8")),
  );
}

export function workerPacketFromCompiled(wi: CompiledWorkItem): WorkerPacket {
  if (
    wi.baseSha === undefined ||
    wi.validationCommands === undefined ||
    wi.requirements === undefined ||
    wi.artifactContract === undefined
  ) {
    throw new Error(`Work Item ${wi.id} has an incomplete v2 Worker Packet`);
  }
  return parseWorkerPacket({
    goal: wi.goal,
    acceptanceCriteria: wi.acceptance,
    allowedPaths: wi.scope,
    preconditions: wi.preconditions,
    outOfScope: wi.outOfScope,
    conventions: wi.conventions,
    baseSha: wi.baseSha,
    validationCommands: wi.validationCommands,
    requirements: wi.requirements,
    artifactContract: wi.artifactContract,
    ...(wi.context ? { context: wi.context } : {}),
    ...(wi.changeSurface ? { changeSurface: wi.changeSurface } : {}),
    ...(wi.criterionRisks ? { criterionRisks: wi.criterionRisks } : {}),
    ...(wi.delivery ? { delivery: wi.delivery } : {}),
    ...(wi.validation ? { validation: wi.validation } : {}),
    ...(wi.repositoryCapabilities ? { repositoryCapabilities: wi.repositoryCapabilities } : {}),
    ...(wi.managedRuntimes ? { managedRuntimes: wi.managedRuntimes } : {}),
  });
}

/**
 * Construct the non-persisted execution view of an authenticated historical
 * graph. Older graphs predate the host-derived top-level runtime contract, so
 * omission alone may be adapted to the current abstract contract. The raw
 * graph, digest, projection, and rendered issue body remain byte-for-byte
 * unchanged; selected bundle data is never synthesized here.
 */
export function executionWorkerPacketFromCompiled(wi: CompiledWorkItem): WorkerPacket {
  const packet = workerPacketFromCompiled(wi);
  if (wi.managedRuntimes !== undefined) return packet;
  const managedRuntimes = managedRuntimeRequirements(
    packet.validationCommands,
    packet.repositoryCapabilities,
  );
  return managedRuntimes.length === 0 ? packet : parseWorkerPacket({ ...packet, managedRuntimes });
}

export function encodeWorkerPacket(packet: WorkerPacket): string {
  const encoded = Buffer.from(JSON.stringify(parseWorkerPacket(packet)), "utf8").toString(
    "base64url",
  );
  return `<!-- ${WORKER_PACKET_MARKER} ${encoded} -->`;
}

export function parseWorkerPacketFromIssue(body: string): WorkerPacket {
  const pattern = new RegExp(`<!--\\s*${WORKER_PACKET_MARKER}\\s+([A-Za-z0-9_-]+)\\s*-->`, "g");
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error("Work Item must contain exactly one v2 Worker Packet envelope");
  }
  const raw = Buffer.from(matches[0][1], "base64url").toString("utf8");
  return parseWorkerPacket(JSON.parse(raw));
}

/**
 * Render a Work Item's already-compiled fields as the issue body / agent
 * prompt (§8). Purely mechanical: section order matches §8's field list
 * exactly, so the rendering is predictable across every Work Item Factory
 * ever creates. Empty optional sections are omitted rather than rendered
 * with "(none)" — a missing section is not a signal worth an agent reading.
 */
export function renderWorkPacket(wi: CompiledWorkItem, graphMetadata?: GraphItemMetadata): string {
  const section = (heading: string, items: string[]): string =>
    items.length > 0 ? `## ${heading}\n\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";

  const validation = wi.validation?.length
    ? `## Validation design\n\n${wi.validation
        .map(
          (entry) =>
            `- **${entry.tier}** — ${entry.rationale ?? "Selected for the listed acceptance criteria."}${entry.evidenceCommands?.length ? ` Evidence: ${entry.evidenceCommands.map((command) => `\`${command}\``).join(", ")}.` : ""}\n${entry.criteria.map((criterion) => `  - ${criterion}`).join("\n")}`,
        )
        .join("\n")}\n`
    : "";
  const criterionRisks = wi.criterionRisks?.length
    ? `## Criterion risks\n\n${wi.criterionRisks.map((entry) => `- **${entry.risk}** — ${entry.criterion}`).join("\n")}\n`
    : "";

  const rendered = [
    `## Goal\n\n${wi.goal}\n`,
    section("Acceptance", wi.acceptance),
    section("Scope", wi.scope),
    section("Preconditions", wi.preconditions),
    section("Out of scope", wi.outOfScope),
    section("Conventions", wi.conventions),
    section(
      "Execution requirement evidence",
      wi.requirements?.evidence?.map(
        (evidence) => `${evidence.field}: ${evidence.kind} — ${evidence.source}`,
      ) ?? [],
    ),
    criterionRisks,
    validation,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const hasV2 =
    wi.baseSha !== undefined ||
    wi.validationCommands !== undefined ||
    wi.requirements !== undefined ||
    wi.artifactContract !== undefined;
  return [
    rendered,
    hasV2 ? encodeWorkerPacket(workerPacketFromCompiled(wi)) : "",
    graphMetadata ? encodeGraphItemMetadata(graphMetadata) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The GitHub write surface `applyGraph` needs. An interface, not a concrete
 * class, so tests inject a fake and never touch the network (mirrors
 * `dispatch.ts`'s `GitHubWriter`).
 */
export interface GraphWriter {
  createWorkItemIssue(args: {
    repositoryId: string;
    parentIssueId: string;
    title: string;
    body: string;
    labelIds?: string[];
  }): Promise<CreatedWorkItem>;
  /** Updates only the body of an already authenticated legacy sub-issue. */
  updateWorkItemIssue(args: { issueId: string; body: string }): Promise<void>;
  /** `issueId` is the blocked issue; `blockingIssueId` is the dependency. */
  addBlockedBy(issueId: string, blockingIssueId: string): Promise<void>;
}

/**
 * Mutations match docs.github.com/en/graphql/reference/issues.
 * `CreateIssueInput.parentIssueId` and `AddBlockedByInput`'s exact field names
 * (`issueId` = the blocked issue, `blockingIssueId` = the dependency) are
 * checked against the schema reference, not inferred from search results. A
 * sub-issue is created with `parentIssueId` set, and `addBlockedBy` reads back
 * afterward as an actual `blockedBy` edge on the dependent issue.
 */
const CREATE_WORK_ITEM_ISSUE_MUTATION = `
mutation CreateWorkItemIssue(
  $repositoryId: ID!
  $parentIssueId: ID!
  $title: String!
  $body: String!
  $labelIds: [ID!]
) {
  createIssue(input: {
    repositoryId: $repositoryId
    parentIssueId: $parentIssueId
    title: $title
    body: $body
    labelIds: $labelIds
  }) {
    issue { id number }
  }
}`;

const ADD_BLOCKED_BY_MUTATION = `
mutation AddBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    clientMutationId
  }
}`;

const UPDATE_WORK_ITEM_ISSUE_MUTATION = `
mutation UpdateWorkItemIssue($issueId: ID!, $body: String!) {
  updateIssue(input: { id: $issueId, body: $body }) {
    issue { id number }
  }
}`;

interface CreateIssueResponse {
  createIssue: { issue: { id: string; number: number } };
}

export class GithubOctokitGraphWriter implements GraphWriter {
  readonly #octokit: Octokit;

  constructor(opts: GitHubOptions) {
    this.#octokit = createOctokit(opts);
  }

  async createWorkItemIssue(args: {
    repositoryId: string;
    parentIssueId: string;
    title: string;
    body: string;
    labelIds?: string[];
  }): Promise<CreatedWorkItem> {
    const res = await this.#octokit.graphql<CreateIssueResponse>(CREATE_WORK_ITEM_ISSUE_MUTATION, {
      repositoryId: args.repositoryId,
      parentIssueId: args.parentIssueId,
      title: args.title,
      body: args.body,
      labelIds: args.labelIds ?? [],
    });
    return { id: res.createIssue.issue.id, number: res.createIssue.issue.number };
  }

  async addBlockedBy(issueId: string, blockingIssueId: string): Promise<void> {
    await this.#octokit.graphql(ADD_BLOCKED_BY_MUTATION, { issueId, blockingIssueId });
  }

  async updateWorkItemIssue(args: { issueId: string; body: string }): Promise<void> {
    await this.#octokit.graphql(UPDATE_WORK_ITEM_ISSUE_MUTATION, args);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GraphApplierOptions {
  writer: GraphWriter;
  onThrottle?: (message: string) => void;
  circuitBreaker?: CircuitBreaker;
  pacer?: ContentCreationPacer;
  concurrency?: ConcurrencyLimiter;
  mutationScheduler?: MutationAdmission;
  beforeMutation?: (waitedMs: number) => Promise<void>;
  captureMutationFence?: () => (waitedMs: number) => Promise<void>;
  mutationScope?: string;
  onMutationOperation?: (observation: MutationOperationObservation) => void;
}

export interface ExistingGraphWorkItem extends CreatedWorkItem {
  compilerId: string;
  graphDigest: string;
  graphSize: number;
  index: number;
  dependsOn: string[];
  title: string;
  body: string;
  blockedByNumbers: number[];
}

/** Validate any already projected subset without requiring the remaining
 * legacy bodies to have been upgraded yet. */
export function assertExistingGraphWorkItemsMatchCompiled(
  objective: CompiledObjective,
  existing: readonly ExistingGraphWorkItem[],
): void {
  const digest = compiledGraphDigest(objective);
  const expectedById = new Map(objective.workItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const observed of existing) {
    if (observed.graphDigest !== digest || observed.graphSize !== objective.workItems.length)
      throw new Error(
        `existing Work Item ${observed.compilerId} belongs to a different compiled graph`,
      );
    if (seen.has(observed.compilerId))
      throw new Error(`duplicate existing Work Item id: ${observed.compilerId}`);
    seen.add(observed.compilerId);
    const expected = expectedById.get(observed.compilerId);
    if (!expected)
      throw new Error(`existing Work Item ${observed.compilerId} is absent from the durable graph`);
    const index = objective.workItems.indexOf(expected);
    const metadata: GraphItemMetadata = {
      protocol: "clockgrove.factory/graph-v1",
      id: expected.id,
      graphDigest: digest,
      graphSize: objective.workItems.length,
      index,
      dependsOn: expected.dependsOn,
      ...(objective.deferredCapabilityAdapters === undefined
        ? {}
        : { deferredCapabilityAdapters: objective.deferredCapabilityAdapters }),
    };
    if (
      observed.index !== index ||
      JSON.stringify(observed.dependsOn) !== JSON.stringify(expected.dependsOn) ||
      observed.title !== expected.title ||
      observed.body.trim() !== renderWorkPacket(expected, metadata).trim()
    )
      throw new Error(`existing Work Item ${observed.compilerId} differs from the durable graph`);
  }
}

/**
 * Applies a validated compiled Objective to GitHub, routing every write
 * through the same breaker/pacer/concurrency discipline as `Dispatcher`
 * (Finding 4) — a class, not a bare function, so a caller driving both an
 * Objective's initial graph application and its ongoing dispatch loop can
 * share one `CircuitBreaker` instance across both if it chooses to (e.g. a
 * secondary-rate-limit refusal while creating Work Items should also pause
 * dispatch, not just graph application).
 */
export class GraphApplier {
  readonly #writer: GraphWriter;
  readonly #notify: (message: string) => void;
  readonly #breaker: CircuitBreaker;
  readonly #pacer: ContentCreationPacer;
  readonly #concurrency: ConcurrencyLimiter;
  readonly #mutations: MutationAdmission;
  readonly #beforeMutation: (waitedMs: number) => Promise<void>;
  readonly #captureMutationFence: GraphApplierOptions["captureMutationFence"];
  readonly #mutationScope: string;
  readonly #onMutationOperation: (observation: MutationOperationObservation) => void;

  constructor(opts: GraphApplierOptions) {
    this.#writer = opts.writer;
    this.#notify = opts.onThrottle ?? (() => {});
    this.#breaker = opts.circuitBreaker ?? new CircuitBreaker();
    this.#pacer = opts.pacer ?? new ContentCreationPacer();
    this.#concurrency = opts.concurrency ?? new ConcurrencyLimiter();
    this.#mutations =
      opts.mutationScheduler ??
      new MutationScheduler({
        pacer: this.#pacer,
        onThrottle: this.#notify,
      });
    this.#beforeMutation = opts.beforeMutation ?? (async () => {});
    this.#captureMutationFence = opts.captureMutationFence;
    this.#mutationScope = opts.mutationScope ?? "graph-applier";
    this.#onMutationOperation = opts.onMutationOperation ?? (() => {});
  }

  /** True once the circuit has tripped repeatedly enough to need a human (§7.3). */
  exhausted(): boolean {
    return this.#breaker.exhausted();
  }

  /**
   * Create every Work Item as a sub-issue of `parentIssueId`, then wire up
   * every declared `dependsOn` as a native `blocked by` edge (§3.1).
   * Creation order seeds native sub-issue priority. The compiler therefore
   * supplies dependency-aware order, and every issue is still created before
   * any dependency edge is added so edge wiring remains replayable.
   *
   * Replaying the same digested graph is idempotent when `existingWorkItems`
   * comes from a fresh Objective snapshot: existing compiler IDs are reused,
   * missing issues are created, and already-present dependency edges are
   * skipped. A divergent digest fails before another issue is created.
   */
  async apply(
    objective: CompiledObjective,
    ctx: {
      repositoryId: string;
      objectiveIssueId: string;
      workItemLabelId?: string;
      existingWorkItems?: ExistingGraphWorkItem[];
      /** Complete authenticated legacy snapshot. Its cardinality forbids issue creation. */
      legacyGraphConstraints?: LegacyGraphConstraints;
      /** Exact graph bytes already authenticated by the durable graph read path. */
      allowAuthenticatedLegacyOmissions?: boolean;
    },
  ): Promise<Map<string, CreatedWorkItem>> {
    if (ctx.allowAuthenticatedLegacyOmissions || ctx.legacyGraphConstraints)
      validateGraphShape(objective, true);
    else validateGraph(objective);
    const digest = compiledGraphDigest(objective);

    const created = new Map<string, CreatedWorkItem>();
    const observedDependencies = new Map<string, Set<number>>();
    assertExistingGraphWorkItemsMatchCompiled(objective, ctx.existingWorkItems ?? []);
    for (const existing of ctx.existingWorkItems ?? []) {
      created.set(existing.compilerId, { id: existing.id, number: existing.number });
      observedDependencies.set(existing.compilerId, new Set(existing.blockedByNumbers));
    }
    const legacyById = new Map<string, LegacyWorkItemConstraint>();
    if (ctx.legacyGraphConstraints) {
      assertCompiledObjectiveAdoptsLegacyConstraints(objective, ctx.legacyGraphConstraints);
      for (const legacy of ctx.legacyGraphConstraints.workItems) {
        if (legacyById.has(legacy.compilerId))
          throw new Error(`duplicate legacy Work Item id: ${legacy.compilerId}`);
        legacyById.set(legacy.compilerId, legacy);
        const authenticated = (ctx.existingWorkItems ?? []).find(
          (item) => item.compilerId === legacy.compilerId,
        );
        if (authenticated) {
          if (
            authenticated.id !== legacy.issueNodeId ||
            authenticated.number !== legacy.issueNumber
          )
            throw new Error(`adopted Work Item ${legacy.compilerId} changed GitHub identity`);
          continue;
        }
        if (created.has(legacy.compilerId))
          throw new Error(`legacy Work Item ${legacy.compilerId} collides with graph projection`);
        created.set(legacy.compilerId, {
          id: legacy.issueNodeId,
          number: legacy.issueNumber,
        });
        observedDependencies.set(legacy.compilerId, new Set(legacy.blockedByNumbers));
      }
      if (
        created.size !== objective.workItems.length ||
        objective.workItems.some((item) => !created.has(item.id))
      )
        throw new Error("legacy adoption does not bind every compiled Work Item");
      for (const item of objective.workItems) {
        const expected = item.dependsOn.map((id) => created.get(id)!.number).sort((a, b) => a - b);
        const observed = [...(observedDependencies.get(item.id) ?? [])].sort((a, b) => a - b);
        if (canonical(expected) !== canonical(observed))
          throw new Error(`legacy Work Item ${item.id} dependency topology changed`);
      }
    }
    for (const existing of ctx.existingWorkItems ?? []) {
      const expectedDependencyNumbers = new Set(
        existing.dependsOn.flatMap((id) => {
          const dependency = created.get(id);
          return dependency ? [dependency.number] : [];
        }),
      );
      const unexpected = existing.blockedByNumbers.filter(
        (number) => !expectedDependencyNumbers.has(number),
      );
      if (unexpected.length > 0) {
        throw new Error(
          `existing Work Item ${existing.compilerId} has unexpected blockers: ${unexpected.join(", ")}`,
        );
      }
    }
    for (const [index, wi] of objective.workItems.entries()) {
      if (created.has(wi.id)) continue;
      const issue = await this.#call(() =>
        this.#writer.createWorkItemIssue({
          repositoryId: ctx.repositoryId,
          parentIssueId: ctx.objectiveIssueId,
          title: wi.title,
          body: renderWorkPacket(wi, {
            protocol: "clockgrove.factory/graph-v1",
            id: wi.id,
            graphDigest: digest,
            graphSize: objective.workItems.length,
            index,
            dependsOn: wi.dependsOn,
            ...(objective.deferredCapabilityAdapters === undefined
              ? {}
              : { deferredCapabilityAdapters: objective.deferredCapabilityAdapters }),
          }),
          ...(ctx.workItemLabelId ? { labelIds: [ctx.workItemLabelId] } : {}),
        }),
      );
      created.set(wi.id, issue);
    }

    // All identities and native edges are validated before the first body write.
    // A lost response is replayable because the authenticated envelope makes the
    // completed update observable while the remaining legacy bodies retain the
    // same immutable constraint digest.
    for (const [index, wi] of objective.workItems.entries()) {
      const legacy = legacyById.get(wi.id);
      if (!legacy || (ctx.existingWorkItems ?? []).some((item) => item.compilerId === wi.id))
        continue;
      await this.#call(() =>
        this.#writer.updateWorkItemIssue({
          issueId: legacy.issueNodeId,
          body: renderWorkPacket(wi, {
            protocol: "clockgrove.factory/graph-v1",
            id: wi.id,
            graphDigest: digest,
            graphSize: objective.workItems.length,
            index,
            dependsOn: wi.dependsOn,
            ...(objective.deferredCapabilityAdapters === undefined
              ? {}
              : { deferredCapabilityAdapters: objective.deferredCapabilityAdapters }),
          }),
        }),
      );
    }

    for (const wi of objective.workItems) {
      const blocked = created.get(wi.id)!;
      for (const dep of wi.dependsOn) {
        const blocking = created.get(dep)!;
        if (observedDependencies.get(wi.id)?.has(blocking.number)) continue;
        await this.#call(() => this.#writer.addBlockedBy(blocked.id, blocking.id));
      }
    }

    return created;
  }

  /**
   * Routes one mutating call through the breaker, pacer, and concurrency
   * limiter (Finding 4) — identical discipline to `Dispatcher.#call`, kept
   * as a separate copy rather than a shared helper because the two classes'
   * constructor/option shapes are otherwise independent and neither should
   * have to import the other to get pacing right.
   */
  async #call<T>(fn: () => Promise<T>): Promise<T> {
    const fence = this.#captureMutationFence?.();
    return observeMutationOperation(
      "graph-write",
      "objective-publication",
      this.#mutationScope,
      this.#onMutationOperation,
      () => this.#dispatchMutation(fn, fence),
    );
  }

  async #dispatchMutation<T>(
    fn: () => Promise<T>,
    fence?: (waitedMs: number) => Promise<void>,
  ): Promise<T> {
    if (this.#breaker.isOpen()) {
      const wait = this.#breaker.waitMs();
      this.#notify(`circuit open; waiting ${wait}ms before the next call`);
      await sleep(wait);
    }

    const mutationPermit = await this.#mutations.acquire("normal");
    const release = await this.#concurrency.acquire();
    let attempted = false;
    try {
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened while the graph write was queued"),
        );
      }
      observeMutationQueue(mutationPermit.waitedMs);
      await observeMutationFence(async () => {
        if (fence) await fence(mutationPermit.waitedMs);
        await this.#beforeMutation(mutationPermit.waitedMs);
      });
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened during the graph mutation fence"),
        );
      }
      mutationPermit.assertDispatchAllowed?.();
      mutationPermit.recordTransported?.();
      attempted = true;
      const result = await fn();
      mutationPermit.recordSuccess?.();
      this.#breaker.recordSuccess();
      return result;
    } catch (error) {
      if (!attempted) throw error;
      const refusal = classifyRefusal(error);
      if (refusal.kind === "not_refusal") throw error;
      mutationPermit.recordRefusal?.(isSecondaryRateLimitRefusal(error));
      this.#breaker.recordRefusal(refusal);
      throw new PlatformUnavailableError(refusal, error);
    } finally {
      release();
      mutationPermit.release();
    }
  }
}
