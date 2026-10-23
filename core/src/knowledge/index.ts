/**
 * The Knowledge capability: the curated playbook, repository memory and
 * Dream. Planning calls {@link planningKnowledge} once per planning call
 * (its single hook, beside the playbook read); the service calls
 * {@link observeState} as Objectives move.
 */
import { TransientError } from "../github.js";
import { type BaseFiles, planningSources } from "../planning/facts.js";
import type { ObjectiveState } from "../state.js";
import { errorMessage } from "../text.js";
import { adaptiveWorkflow } from "../validate.js";
import { pinnedPlaybook } from "./dream.js";
import {
  memorySection,
  observeObjective,
  retain,
  sourceRecords,
} from "./memory.js";
import { knowledgeSettings } from "./settings.js";
import { type Database, openStore, sha256, withStore } from "./store.js";

/**
 * The advisory text planning appends to its prompts: the target's curated
 * playbook, then the approved Dream playbook this Objective is pinned to,
 * then, for an Adaptive workflow Objective, the admitted planning context
 * and the relevant repository memory. With nothing beyond the target's
 * playbook it returns that playbook unchanged. A store that can't be read
 * is named in the text; it never stops planning.
 */
export async function planningKnowledge(input: {
  issue: number;
  body: string;
  files: BaseFiles;
  /** The target's curated playbook at the base; empty when there is none. */
  playbook: string;
}): Promise<string> {
  const settings = knowledgeSettings();
  if (!settings) return input.playbook;
  const context = adaptiveWorkflow(input.body).enabled
    ? settings.planningContext
    : undefined;
  // Git reads fail as TransientError, which the planning step retries.
  const sources = context?.memory
    ? (await planningSources(input.body, input.files)).sources
    : [];
  const parts = [input.playbook.trim() ? input.playbook : ""];
  let db: Database | undefined;
  try {
    db = openStore(settings.root);
    parts.push(pinnedPlaybook(db, input.issue));
    if (context) {
      parts.push(
        `Adaptive workflow: planning context is admitted for ${context.selectors.join(", ")}. Read those paths with your repository tools as needed.`,
      );
      if (context.memory) {
        retain(db, sourceRecords(input.issue, input.files.base, sources));
        parts.push(
          await memorySection(db, {
            objective: input.issue,
            body: input.body,
            context,
            supplied: sources.map((s) => `${s.path}#${s.heading ?? ""}`),
            digest: async (path) => {
              const bytes = await input.files.blob(path);
              return bytes && sha256(bytes);
            },
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

/** Record what an Objective's state shows. `settled`: terminal with nothing left to run. */
export function observeState(state: ObjectiveState, settled: boolean): number {
  const settings = knowledgeSettings();
  if (!settings) return 0;
  return withStore(settings.root, (db) =>
    observeObjective(db, settings.repository, state, settled),
  );
}
