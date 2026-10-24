/**
 * A worker's own Validate, shared by the Claude and Copilot workers: the
 * Work Item's declared commands through `validateTree` on a snapshot commit
 * of the worker's current files, in a fresh checkout, plus the handoff
 * decode collection will apply. The worker names no command: only the
 * declared ones run. Runs are queued one at a time.
 */

import { stripVTControlCharacters } from "node:util";
import type { SandboxConfig } from "../config.js";
import { hold, objectiveWide } from "../engine.js";
import { GitRefusal } from "../git.js";
import { DESIGN_QUESTIONS } from "../planning/rubric.js";
import type { Plan } from "../planning/types.js";
import type { ObjectiveBlock } from "../shown.js";
import { errorMessage, headAndTail } from "../text.js";
import { validateTree } from "../validate.js";
import { hasGitlink } from "../worktree.js";
import {
  type HandoffNote,
  handoffPeers,
  readHandoffNotes,
  snapshot,
  workHandoffSchema,
} from "./collect.js";
import type { WorkerInput, WorkerResult } from "./worker.js";

/** What Validate needs beyond the worker's input. */
export interface SelfValidateOptions {
  sandbox: SandboxConfig;
  /** The accepted plan: Validate's pins and the handoff's peers. */
  plan: Plan;
  /** The Objective's shown structure as planned: its package-manager and workspace pins. */
  blocks: readonly ObjectiveBlock[];
  /** Origin's `owner/name`: Validate fetches Git LFS objects the local store lacks from it. */
  repository: string;
  /** Each command's limit: `validation.commandTimeoutSeconds`, in ms. */
  commandTimeoutMs: number;
}

/** The tool's name, as both workers serve it. */
export const VALIDATION_TOOL_NAME = "run_validation";

export const VALIDATION_TOOL_DESCRIPTION =
  "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, decode .factory-handoff.json as Factory will when it collects your result, and return the result. Files the commands produce under your owned paths that Git ignores (such as actual values a check writes) are copied back to your checkout at the same paths, and the result lists them. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review and handoff fixes: finish only after a run passes on your final files.";

/** Validate keeps the tail: failures report last. */
const VALIDATION_OUTPUT_CHARS = 8_000;
/** Enough of a note to see which criterion and sub-clauses it answers. */
const NOTE_EXCERPT_CHARS = 600;

/** Plain text: the first line names the failed command; the tail holds the failures. */
function bounded(output: string): string {
  const plain = stripVTControlCharacters(output);
  const head = (plain.split("\n", 1)[0] ?? "").slice(0, 300);
  return headAndTail(plain, head.length, VALIDATION_OUTPUT_CHARS);
}

/**
 * Each criterion's exact text beside the note recorded for its index, so the
 * final self-review compares against the criterion, not a paraphrase.
 * Criteria are never cut; long note summaries are, since the worker has them.
 */
function criterionMap(
  acceptance: readonly string[],
  notes: readonly HandoffNote[] = [],
): string {
  const summaries = new Map(
    notes
      .filter((note) => note.kind === "verification")
      .map((note) => [note.criterionIndex, note.summary]),
  );
  const missing = acceptance.flatMap((_, index) =>
    summaries.has(index) ? [] : [index],
  );
  const lines = acceptance.map((criterion, index) => {
    const summary = summaries.get(index);
    const note =
      summary === undefined
        ? "none recorded"
        : summary.length <= NOTE_EXCERPT_CHARS
          ? summary
          : `${summary.slice(0, NOTE_EXCERPT_CHARS)} [${summary.length - NOTE_EXCERPT_CHARS} more characters]`;
    return `[${index}] ${criterion}\nnote [${index}]: ${note}`;
  });
  return `Check each acceptance criterion's exact text against the verification note recorded for its index. The reviewer checks every sub-clause of this text, not a paraphrase: a note that answers another criterion, merges criteria or omits a sub-clause leaves that criterion unproved. Add any missing proof, then fix the note.${missing.length ? ` No note yet for criteria ${missing.join(", ")}.` : ""}\n${lines.join("\n")}`;
}

export interface HandoffCheck {
  passed: boolean;
  text?: string;
  criteria?: string;
}

/**
 * Whether the worktree holds a submodule gitlink. Host Git must not enter a
 * repository the commands could write behind one, so Validate never runs in
 * such a checkout; a Git refusal is the whole Objective's question.
 */
export async function worktreeGitlinks(
  input: WorkerInput,
): Promise<boolean | WorkerResult> {
  try {
    return await hasGitlink(input.worktree, { signal: input.signal });
  } catch (error) {
    if (error instanceof GitRefusal) return objectiveWide(hold(error.message));
    throw error;
  }
}

/** One attempt's Validate: its runs and the trees that passed. */
export class SelfValidation {
  private queue: Promise<unknown> = Promise.resolve();
  private runs = 0;
  private readonly passedTrees = new Set<string>();

  /** `signal` stops a running validation: cancel, or the attempt ending. */
  constructor(
    private readonly input: WorkerInput,
    private readonly options: SelfValidateOptions,
    private readonly signal: AbortSignal,
  ) {}

  /** One tool call: the result text, or why validation is unavailable. */
  async call(): Promise<{ text: string; isError: boolean }> {
    const result = this.queue.then(() => this.validate());
    this.queue = result.catch(() => undefined);
    try {
      return { text: await result, isError: false };
    } catch (error) {
      return {
        text: `Factory validation unavailable: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }

  /** Settles once no run is in flight. */
  idle(): Promise<unknown> {
    return this.queue;
  }

  /**
   * The declared commands on a snapshot commit of the worker's current
   * files, in a fresh checkout, so the worker's files never change and no
   * build output or other run's temporary files reach the commands.
   */
  private async validate(): Promise<string> {
    const run = ++this.runs;
    const { input, options } = this;
    const signal = this.signal;
    const handoff = await this.checkHandoff();
    const snapped = await snapshot(input.worktree, options.sandbox, signal);
    if ("problem" in snapped)
      return `Validation failed. Fix this before you finish.\n${snapped.problem}`;
    const { tree, commit } = snapped;
    const result = await validateTree({
      checkout: input.worktree,
      repository: options.repository,
      directory: `${input.worktree}.validation`,
      commit,
      item: input.item,
      plan: options.plan,
      blocks: options.blocks,
      sandbox: options.sandbox,
      commandTimeoutMs: options.commandTimeoutMs,
      returnTo: input.worktree,
      predecessor: input.base !== options.plan.base ? input.base : undefined,
      signal,
      log: input.log,
    });
    if (result.kind === "retry") throw new Error(result.reason);
    if (result.kind === "hold") throw new Error(result.question);
    const passed = result.kind === "passed";
    const declared =
      result.kind === "passed"
        ? `All ${result.commands.length} declared validation commands passed:\n${result.commands.map((command) => `- ${command}`).join("\n")}`
        : `Validation failed. Fix this before you finish.\n${bounded(result.failed ? `${result.failed.command} failed:\n${result.output}` : result.output || result.detail)}`;
    const parts = [
      result.produced ? `${declared}\n\n${result.produced}` : declared,
    ];
    if (handoff.text)
      if (handoff.passed) parts.push(handoff.text);
      else parts.unshift(handoff.text);
    // Self-review follows a passing run; after the bounded output, so never cut.
    if (passed && handoff.criteria) parts.push(handoff.criteria);
    if (passed && !handoff.passed)
      parts.unshift("Validation failed. Fix this before you finish.");
    // The handoff is outside the tree; the final check decodes it again.
    if (passed) this.passedTrees.add(tree);
    input.log({
      event: "worker-validate",
      run,
      passed: passed && handoff.passed,
      tree,
      handoffPassed: handoff.passed,
    });
    return parts.join("\n\n");
  }

  /**
   * Decode .factory-handoff.json as collection will, so the worker can
   * repair a manifest that would reject its whole result. `criteria` maps
   * each criterion to its note once the manifest decodes.
   */
  async checkHandoff(): Promise<HandoffCheck> {
    const { item, worktree } = this.input;
    const { plan } = this.options;
    const count = item.acceptance.length;
    const notes = await readHandoffNotes(worktree, plan, item);
    if (notes && "problem" in notes)
      return {
        passed: false,
        text: `.factory-handoff.json would be rejected at collection, and your whole result with it. ${notes.problem}\nRewrite it to match this exact schema, then run validation again: ${JSON.stringify(workHandoffSchema(handoffPeers(plan, item).length, count))}`,
      };
    if (!notes)
      return {
        passed: true,
        ...(count && {
          text: `No .factory-handoff.json yet. Before you finish, record one verification note for each of the ${count} acceptance criteria there, using the schema in your instructions.`,
          criteria: criterionMap(item.acceptance),
        }),
      };
    const verified = notes.filter(
      (note) => note.kind === "verification",
    ).length;
    const answered = new Set<string>(
      notes.flatMap((note) => note.designRisk ?? []),
    );
    const unanswered = Object.keys(DESIGN_QUESTIONS).filter(
      (risk) => !answered.has(risk),
    );
    return {
      passed: true,
      text: `.factory-handoff.json decodes: ${notes.length} notes, verification notes for ${verified} of ${count} acceptance criteria.${unanswered.length ? ` No design note yet for ${unanswered.join(", ")}.` : ""}`,
      ...(count && { criteria: criterionMap(item.acceptance, notes) }),
    };
  }

  /**
   * Whether a passing Validate run covered the files the worker returns,
   * with a handoff collection accepts: the tree, false, or undefined when
   * the files can't be staged (collection reports that itself).
   */
  async finalTree(): Promise<string | false | undefined> {
    if (!this.passedTrees.size) return false;
    try {
      const snapped = await snapshot(
        this.input.worktree,
        this.options.sandbox,
        this.input.signal,
      );
      if ("problem" in snapped) return undefined;
      return this.passedTrees.has(snapped.tree) &&
        (await this.checkHandoff()).passed
        ? snapped.tree
        : false;
    } catch {
      return undefined;
    }
  }
}
