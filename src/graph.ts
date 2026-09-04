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
import { z } from "zod";

import { createOctokit, type GitHubOptions } from "./github.js";
import {
  ChangeSurfaceSchema,
  ContextManifestSchema,
  DeliveryHintSchema,
  ExecutionRequirementsSchema,
  RepositoryScopePathSchema,
  parseWorkerPacket,
  type ExecutionRequirements,
  type WorkerPacket,
} from "./protocol/worker-packet.js";
import { assertWithinBytes } from "./protocol/limits.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  MutationScheduler,
  PlatformUnavailableError,
  classifyRefusal,
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
  validation?:
    | Array<{
        tier: "mechanical" | "semantic" | "visual" | "deterministic-simulation";
        criteria: string[];
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
}

/** Matches `schemas/objective.schema.json` — the objective-compilation skill's output. */
export interface CompiledObjective {
  title: string;
  workItems: CompiledWorkItem[];
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
    validation: z
      .array(
        z
          .object({
            tier: z.enum(["mechanical", "semantic", "visual", "deterministic-simulation"]),
            criteria: z.array(z.string().min(1).max(2_000)).min(1).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .optional(),
    delivery: DeliveryHintSchema.optional(),
    economicReview: z
      .object({
        conservative: z.boolean(),
        rationale: z.string().min(1).max(2_000),
        paidMeasurementRequired: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const PersistedCompiledObjectiveSchema = z
  .object({
    title: z.string().min(1).max(256),
    workItems: z.array(PersistedCompiledWorkItemSchema).min(1).max(100),
  })
  .strict();

export function parsePersistedCompiledObjective(input: unknown): CompiledObjective {
  const objective = PersistedCompiledObjectiveSchema.parse(input);
  validateGraph(objective);
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
export function validateGraph(objective: CompiledObjective): void {
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

  for (const wi of objective.workItems) {
    const v2Fields = [wi.baseSha, wi.validationCommands, wi.requirements, wi.artifactContract];
    if (v2Fields.some((value) => value !== undefined)) {
      workerPacketFromCompiled(wi);
    }
  }
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
});

export type GraphItemMetadata = z.infer<typeof GraphItemMetadataSchema>;

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
  validateGraph(objective);
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
    ...(wi.delivery ? { delivery: wi.delivery } : {}),
  });
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

  const rendered = [
    `## Goal\n\n${wi.goal}\n`,
    section("Acceptance", wi.acceptance),
    section("Scope", wi.scope),
    section("Preconditions", wi.preconditions),
    section("Out of scope", wi.outOfScope),
    section("Conventions", wi.conventions),
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
  }

  /** True once the circuit has tripped repeatedly enough to need a human (§7.3). */
  exhausted(): boolean {
    return this.#breaker.exhausted();
  }

  /**
   * Create every Work Item as a sub-issue of `parentIssueId`, then wire up
   * every declared `dependsOn` as a native `blocked by` edge (§3.1).
   * Creation order does not matter — every issue is created before any
   * dependency edge is added, so a Work Item can depend on a sibling
   * regardless of which was created first.
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
    },
  ): Promise<Map<string, CreatedWorkItem>> {
    validateGraph(objective);
    const digest = compiledGraphDigest(objective);

    const created = new Map<string, CreatedWorkItem>();
    const observedDependencies = new Map<string, Set<number>>();
    const expectedById = new Map(objective.workItems.map((item) => [item.id, item]));
    for (const existing of ctx.existingWorkItems ?? []) {
      if (existing.graphDigest !== digest || existing.graphSize !== objective.workItems.length) {
        throw new Error(
          `existing Work Item ${existing.compilerId} belongs to a different compiled graph`,
        );
      }
      if (created.has(existing.compilerId)) {
        throw new Error(`duplicate existing Work Item id: ${existing.compilerId}`);
      }
      const expected = expectedById.get(existing.compilerId);
      if (!expected) {
        throw new Error(
          `existing Work Item ${existing.compilerId} is absent from the durable graph`,
        );
      }
      const expectedIndex = objective.workItems.indexOf(expected);
      const metadata: GraphItemMetadata = {
        protocol: "clockgrove.factory/graph-v1",
        id: expected.id,
        graphDigest: digest,
        graphSize: objective.workItems.length,
        index: expectedIndex,
        dependsOn: expected.dependsOn,
      };
      if (
        existing.index !== expectedIndex ||
        JSON.stringify(existing.dependsOn) !== JSON.stringify(expected.dependsOn) ||
        existing.title !== expected.title ||
        existing.body.trim() !== renderWorkPacket(expected, metadata).trim()
      ) {
        throw new Error(`existing Work Item ${existing.compilerId} differs from the durable graph`);
      }
      created.set(existing.compilerId, { id: existing.id, number: existing.number });
      observedDependencies.set(existing.compilerId, new Set(existing.blockedByNumbers));
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
          }),
          ...(ctx.workItemLabelId ? { labelIds: [ctx.workItemLabelId] } : {}),
        }),
      );
      created.set(wi.id, issue);
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
    if (this.#breaker.isOpen()) {
      const wait = this.#breaker.waitMs();
      this.#notify(`circuit open; waiting ${wait}ms before the next call`);
      await sleep(wait);
    }

    const mutationPermit = await this.#mutations.acquire("normal");
    const release = await this.#concurrency.acquire();
    try {
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened while the graph write was queued"),
        );
      }
      await this.#beforeMutation(mutationPermit.waitedMs);
      const result = await fn();
      this.#breaker.recordSuccess();
      return result;
    } catch (error) {
      const refusal = classifyRefusal(error);
      if (refusal.kind === "not_refusal") throw error;
      this.#breaker.recordRefusal(refusal);
      throw new PlatformUnavailableError(refusal, error);
    } finally {
      release();
      mutationPermit.release();
    }
  }
}
