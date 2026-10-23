/**
 * The Knowledge capability: the curated playbook, repository memory and
 * Dream. Planning calls {@link planningKnowledge} once per planning call
 * (its single hook, beside the playbook read); the service calls
 * {@link observeState} as Objectives move.
 */
import { TransientError } from "../github.js";
import { type BaseFiles, planningSources } from "../planning/facts.js";
import type { ShownObjective } from "../shown.js";
import { type ObjectiveState, runOf } from "../state.js";
import { errorMessage } from "../text.js";
import { adaptiveWorkflow } from "../validate.js";
import { pinnedPlaybook } from "./dream.js";
import {
  memorySection,
  observeObjective,
  pathDigest,
  releaseRun,
  retain,
  sourceRecords,
} from "./memory.js";
import { knowledgeSettings } from "./settings.js";
import { type Database, openStore, withStore } from "./store.js";

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
        parts.push(
          await memorySection(db, {
            objective: issue,
            body: input.shown.body,
            context,
            supplied: sources.map((s) => `${s.path}#${s.heading ?? ""}`),
            digest: (path) => pathDigest(input.files, path),
          }),
        );
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
 * The service's observer: records what an Objective's state shows as it
 * moves (`settled`: terminal with nothing left to run), and ends a run
 * that a new admission of the same issue replaces.
 */
export const knowledgeObserver = {
  async observe(
    state: ObjectiveState,
    settled: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = knowledgeSettings();
    if (settings) await observeObjective(settings, state, settled, { signal });
  },
  release(state: ObjectiveState): void {
    const settings = knowledgeSettings();
    if (settings)
      withStore(settings.root, (db) =>
        releaseRun(db, settings.repository, state),
      );
  },
};
