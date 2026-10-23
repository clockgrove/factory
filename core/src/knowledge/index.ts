/**
 * The Knowledge capability: the curated playbook, repository memory and
 * Dream. Planning calls {@link planningKnowledge} once per planning call
 * (its single hook, beside the playbook read), and {@link memoryLookup}
 * for a memory lookup the planner asks for; the worker, the repair
 * diagnosis and both reviews call {@link roleMemory}; the service calls
 * {@link knowledgeObserver} as Objectives move, and applies `dream`
 * writes (dream.ts applyDream).
 */
import { TransientError } from "../github.js";
import { BaseFiles, planningSources } from "../planning/facts.js";
import { acceptedInputs } from "../planning/plan.js";
import type { ShownObjective } from "../shown.js";
import { type ObjectiveState, runOf } from "../state.js";
import { errorMessage } from "../text.js";
import { adaptiveWorkflow } from "../validate.js";
import { pinnedPlaybook } from "./dream.js";
import {
  type MemoryRole,
  type MemorySection,
  observeObjective,
  pathDigest,
  queryMemory,
  retain,
  sourceRecords,
} from "./memory.js";
import { knowledgeSettings, type PlanningContext } from "./settings.js";
import { type Database, openStore, readStore } from "./store.js";

/**
 * The advisory text planning appends to its prompts: the target's curated
 * playbook, then the approved Dream playbook this Objective is pinned to,
 * then, for an Adaptive workflow Objective, the admitted planning context
 * and the relevant repository memory. With nothing beyond the target's
 * playbook it returns that playbook unchanged. A store that can't be read
 * is named in the text; it never stops planning.
 */
export async function planningKnowledge(input: {
  state: ObjectiveState;
  /** The Objective as shown. */
  shown: ShownObjective;
  /** The Objective is a Factory-created split child. */
  child: boolean;
  files: BaseFiles;
  /** The target's curated playbook at the base; empty when there is none. */
  playbook: string;
}): Promise<string> {
  const settings = knowledgeSettings();
  if (!settings) return input.playbook;
  const context = adaptiveWorkflow(input.shown.blocks).enabled
    ? settings.planningContext
    : undefined;
  // Git reads fail as TransientError, which the planning step retries.
  const sources = context?.memory
    ? (await planningSources(input.shown, input.files, input.child)).sources
    : [];
  const issue = input.state.issue;
  const run = runOf(input.state);
  const parts = [input.playbook.trim() ? input.playbook : ""];
  let db: Database | undefined;
  try {
    db = openStore(settings.root);
    parts.push(pinnedPlaybook(db, issue, run));
    if (context) {
      parts.push(
        `Adaptive workflow: planning context is admitted for ${context.selectors.join(", ")}. Read those paths with your repository tools as needed.`,
      );
      if (context.memory) {
        retain(db, sourceRecords(issue, run, input.files.base, sources));
        const memory = await queryMemory(db, {
          role: "planning",
          objective: issue,
          text: input.shown.body,
          paths: context.selectors,
          maxBytes: context.bounds.maxBytes,
          context,
          supplied: sources.map((s) => `${s.path}#${s.heading ?? ""}`),
          digest: (path) => pathDigest(input.files, path),
        });
        parts.push(memory.text);
      }
    }
  } catch (error) {
    if (error instanceof TransientError) throw error;
    parts.push(
      `Factory's knowledge store is unavailable for this call (${errorMessage(error)}); plan without the Dream playbook and repository memory.`,
    );
  } finally {
    db?.close();
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The memory bytes each role gets at most (planning.context's maxBytes
 * still caps them). Review's peer-notes row inlines 64 KB (result.ts
 * KNOWLEDGE_INLINE_BYTES): final review, which sees every item, gets that
 * much again; the worker and result review half of it, for one item; the
 * diagnosis an eighth of its 128 KB candidate-file bound (repair.ts).
 */
const ROLE_BYTES: Record<Exclude<MemoryRole, "planning">, number> = {
  work: 32_000,
  "result-review": 32_000,
  diagnosis: 16_000,
  "final-review": 64_000,
};

/**
 * A read waits this long for the writer's lock; longer, memory is empty.
 * The wait blocks the service's loop, so it matches the writer's own
 * (store.ts openStore).
 */
const ROLE_BUSY_MS = 1000;

/**
 * Repository memory for one role call, gated as planning's is: only for an
 * Objective whose Adaptive workflow section is enabled, on an installation
 * whose planning context turns `memory` on. Empty otherwise, and when no
 * record is relevant: a role isn't told about memory it lacks. Memory is
 * advisory, so a store that can't be read or is slow gives empty memory and
 * a log line, never a hold or a retry.
 */
export async function roleMemory(input: {
  role: Exclude<MemoryRole, "planning">;
  state: ObjectiveState;
  checkout: string;
  /** The commit the role reads: a record's staleness is judged there. */
  tree: string;
  /** The paths the role works on. */
  paths: readonly string[];
  /** What the role is about: the search text. */
  text: string;
  /** Sources the role already has. */
  supplied: readonly { path: string; heading?: string }[];
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}): Promise<string> {
  const settings = knowledgeSettings();
  const context = settings?.planningContext;
  if (
    !settings ||
    !context?.memory ||
    !adaptiveWorkflow(acceptedInputs(input.state).shown.blocks).enabled
  )
    return "";
  const files = new BaseFiles(input.checkout, input.tree, input.signal);
  try {
    const section = await readStore(
      settings.root,
      (db) =>
        queryMemory(db, {
          role: input.role,
          objective: input.state.issue,
          text: input.text,
          paths: input.paths,
          maxBytes: ROLE_BYTES[input.role],
          context,
          supplied: input.supplied.map((s) => `${s.path}#${s.heading ?? ""}`),
          digest: (path) => pathDigest(files, path),
        }),
      ROLE_BUSY_MS,
    );
    input.log({
      event: "memory",
      role: input.role,
      shown: section.shown,
      left: section.left,
    });
    return section.shown ? section.text : "";
  } catch (error) {
    if (input.signal.aborted) throw error;
    input.log({
      event: "memory-unavailable",
      role: input.role,
      error: errorMessage(error),
    });
    return "";
  }
}

/**
 * One planner-requested memory lookup (planning/lookup.ts): the same query
 * every role reads through, with the planner's own search text and paths.
 * Throws when the store can't be read or stays busy; the lookup then
 * answers that memory is unavailable.
 */
export async function memoryLookup(input: {
  issue: number;
  context: PlanningContext;
  text: string;
  paths: readonly string[];
  maxBytes: number;
  files: BaseFiles;
}): Promise<MemorySection> {
  const settings = knowledgeSettings();
  if (!settings) throw new Error("no knowledge store is configured");
  return readStore(
    settings.root,
    (db) =>
      queryMemory(db, {
        role: "planning",
        objective: input.issue,
        text: input.text,
        paths: input.paths,
        maxBytes: input.maxBytes,
        context: input.context,
        supplied: [],
        digest: (path) => pathDigest(input.files, path),
      }),
    ROLE_BUSY_MS,
  );
}

/**
 * The service's observer: records what an Objective's state shows as it
 * moves, and ends a run once it is settled (terminal with nothing left to
 * run, or replaced by a new admission or a withdrawal).
 */
export const knowledgeObserver = {
  async observe(
    state: ObjectiveState,
    settled: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = knowledgeSettings();
    if (settings) await observeObjective(settings, state, settled, signal);
  },
};
