/**
 * The Worker seam: run one Work Item's worker in its kept worktree until it
 * finishes. Provider APIs stay in the adapters (providers/codex-worker.ts,
 * providers/claude-worker.ts). Factory, not the worker, collects and commits
 * the result (work/collect.ts).
 */
import type { WorkItem } from "../planning/types.js";

export interface WorkerInput {
  /** The kept worktree for this item; a repair continues in it. */
  worktree: string;
  /** The complete worker prompt (work/prompt.ts). */
  prompt: string;
  item: WorkItem;
  /** The item's validation commands, run through the sandbox by Validate. */
  commands: string[];
  /** The commit the worktree started from. */
  base: string;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export type WorkerResult =
  | {
      kind: "finished";
      /** The worker's last message, shown when it changed nothing. */
      finalResponse: string;
      /** The tree the worker's own Validate last passed, with its commands. */
      validated?: { tree: string; commands: string[] };
    }
  /** Usage or rate limit, idle timeout, lost turn. */
  | { kind: "retry"; reason: string; afterMs?: number }
  /** Login expired, sandbox unavailable, configuration fault. */
  | { kind: "hold"; question: string; answers: string[]; recommended: string };

export interface Worker {
  run(input: WorkerInput): Promise<WorkerResult>;
}
