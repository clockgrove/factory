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

import { Octokit } from "@octokit/core";

import { createOctokit, type GitHubOptions } from "./github.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  PlatformUnavailableError,
  classifyRefusal,
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
}

/** Matches `schemas/objective.schema.json` — the objective-compilation skill's output. */
export interface CompiledObjective {
  title: string;
  workItems: CompiledWorkItem[];
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
}

/**
 * Render a Work Item's already-compiled fields as the issue body / agent
 * prompt (§8). Purely mechanical: section order matches §8's field list
 * exactly, so the rendering is predictable across every Work Item Factory
 * ever creates. Empty optional sections are omitted rather than rendered
 * with "(none)" — a missing section is not a signal worth an agent reading.
 */
export function renderWorkPacket(wi: CompiledWorkItem): string {
  const section = (heading: string, items: string[]): string =>
    items.length > 0 ? `## ${heading}\n\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";

  return [
    `## Goal\n\n${wi.goal}\n`,
    section("Acceptance", wi.acceptance),
    section("Scope", wi.scope),
    section("Preconditions", wi.preconditions),
    section("Out of scope", wi.outOfScope),
    section("Conventions", wi.conventions),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
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
    const res = await this.#octokit.graphql<CreateIssueResponse>(
      CREATE_WORK_ITEM_ISSUE_MUTATION,
      {
        repositoryId: args.repositoryId,
        parentIssueId: args.parentIssueId,
        title: args.title,
        body: args.body,
        labelIds: args.labelIds ?? [],
      },
    );
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

  constructor(opts: GraphApplierOptions) {
    this.#writer = opts.writer;
    this.#notify = opts.onThrottle ?? (() => {});
    this.#breaker = opts.circuitBreaker ?? new CircuitBreaker();
    this.#pacer = opts.pacer ?? new ContentCreationPacer();
    this.#concurrency = opts.concurrency ?? new ConcurrencyLimiter();
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
   * Not idempotent, and deliberately not made so here: re-running this
   * against an Objective that already has Work Items would create
   * duplicates. Calling only once, guarded by "does this Objective already
   * have sub-issues" (readable via `github.ts`'s existing `subIssues`
   * query), is the caller's responsibility — the same "read GitHub before
   * writing" discipline `dispatch.ts` already depends on for its own
   * idempotency (§4.3).
   */
  async apply(
    objective: CompiledObjective,
    ctx: { repositoryId: string; objectiveIssueId: string; workItemLabelId?: string },
  ): Promise<Map<string, CreatedWorkItem>> {
    validateGraph(objective);

    const created = new Map<string, CreatedWorkItem>();
    for (const wi of objective.workItems) {
      const issue = await this.#call(() =>
        this.#writer.createWorkItemIssue({
          repositoryId: ctx.repositoryId,
          parentIssueId: ctx.objectiveIssueId,
          title: wi.title,
          body: renderWorkPacket(wi),
          ...(ctx.workItemLabelId ? { labelIds: [ctx.workItemLabelId] } : {}),
        }),
      );
      created.set(wi.id, issue);
    }

    for (const wi of objective.workItems) {
      const blocked = created.get(wi.id)!;
      for (const dep of wi.dependsOn) {
        const blocking = created.get(dep)!;
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

    const pacerWait = this.#pacer.waitMs();
    if (pacerWait > 0) await sleep(pacerWait);

    const release = await this.#concurrency.acquire();
    try {
      const result = await fn();
      this.#pacer.recordCall();
      this.#breaker.recordSuccess();
      return result;
    } catch (error) {
      const refusal = classifyRefusal(error);
      if (refusal.kind === "not_refusal") throw error;
      this.#breaker.recordRefusal(refusal);
      throw new PlatformUnavailableError(refusal, error);
    } finally {
      release();
    }
  }
}
