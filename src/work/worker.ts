/**
 * The Worker seam: run one Work Item's worker in its kept worktree until it
 * finishes. Provider APIs stay in the adapters (providers/codex-worker.ts,
 * providers/claude-worker.ts). Factory, not the worker, collects and commits
 * the result (work/collect.ts).
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { HoldScope } from "../engine.js";
import { type RunFile, redact } from "../log.js";
import type { WorkItem } from "../planning/types.js";
import type { Conversation, Session } from "../providers/session.js";
import type { PromptFacts } from "../providers/usage.js";
import type { Answer, HoldOption, Wait } from "../state.js";
import type {
  SelfValidateOptions,
  WorkerValidateFailure,
} from "./self-validate.js";

/**
 * What a paid worker has spent on one Work Item across attempts and
 * repairs, kept in state (`state.kept`) so a ceiling holds across retries
 * and restarts. `allotments` counts the operator's grants of another
 * ceiling; `grantedAt` is the answer that granted the last one.
 */
export interface WorkerSpend {
  runs: number;
  cents: number;
  tokens: number;
  allotments: number;
  grantedAt?: string;
}

export interface WorkerInput {
  /** The kept worktree for this item; a repair continues in it. */
  worktree: string;
  /** The complete worker prompt (work/prompt.ts). */
  prompt: string;
  /** The prompt's parts and pinned sources (providers/usage.ts PromptFacts). */
  facts?: PromptFacts;
  item: WorkItem;
  /** The item's validation commands, run through the sandbox by Validate. */
  commands: string[];
  /** The commit the worktree started from. */
  base: string;
  /**
   * The install store the Objective's items share (worktree.ts
   * `sharedInstallStorePath`), for its own Validate as for the validate
   * step; absent: only the item's own.
   */
  sharedInstallStore?: string;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
  /**
   * What the worker is doing, as it happens: the run log gets it throttled
   * and redacted as `worker-activity` (ActivityLog). Never contents.
   */
  activity(event: WorkerActivity): void;
  /**
   * The provider's own stream, each event as it came (an SDK event or
   * message, a hosted session event): the attempt's transcript gets it
   * redacted and bounded (ActivityLog). Streamed deltas are left out.
   */
  output(event: unknown): void;
  /** The attempt's private files (engine.ts StepContext.runFile), for its own Validate's failed output. */
  runFile(kind: string): RunFile;
  /** The Work Item's spend so far, for workers that bill per run. */
  spend?: WorkerSpend;
  /** The answer to this step's last hold, such as `more`. */
  answer?: Answer;
  /**
   * The item's worker conversation (providers/session.ts): a repair may
   * continue it with only its delta. `prompt` is still the whole request.
   */
  conversation?: Conversation;
}

export type WorkerResult = (
  | {
      kind: "finished";
      /** The worker's last message, shown when it changed nothing. */
      finalResponse: string;
      /** The tree the worker's own Validate last passed, with its commands. */
      validated?: { tree: string; commands: string[] };
      /** The commands the worker's own Validate failed and no later run passed (self-validate.ts `validateFailed`). */
      validateFailed?: WorkerValidateFailure[];
    }
  /** Usage or rate limit (`wait`), lost turn; an idle timeout is an error (`wait.kind` "error"). */
  | { kind: "retry"; reason: string; afterMs?: number; wait?: Wait }
  /** Login expired, sandbox unavailable, configuration fault. */
  | {
      kind: "hold";
      question: string;
      options: HoldOption[];
      /** Absent: the Work Item's (see planner.ts PlannerError.scope). */
      scope?: HoldScope;
    }
) & {
  /** The Work Item's spend after this run, kept in state. */
  spend?: WorkerSpend;
  /** The conversation to keep after a finished run; absent: none to continue. */
  session?: Session;
};

export interface Worker {
  run(input: WorkerInput): Promise<WorkerResult>;
  /**
   * What the worker's Validate runs with (work/self-validate.ts), the
   * repository's formatter included; absent for a worker with no Validate.
   */
  readonly validation?: SelfValidateOptions;
}

/**
 * One thing a worker did: a tool started or finished, a file edited, a
 * command run, a model turn. Names, paths and command lines only, never
 * file contents or model output.
 */
export type WorkerActivity =
  /** `target`: what a started tool acts on (its file, command, pattern or URL), when it names one. */
  | {
      kind: "tool";
      phase: "started" | "finished";
      tool: string;
      target?: string;
    }
  | { kind: "edit"; path: string }
  | { kind: "command"; command: string }
  /** A command ended with a non-zero exit, a signal or its time limit. */
  | { kind: "command-failed" }
  | { kind: "turn" }
  /**
   * The tokens in the worker's context at its last model request, and the
   * model's window when the provider says. Only providers that report it.
   */
  | { kind: "context"; tokens: number; window?: number }
  /** The provider compacted the worker's conversation. */
  | { kind: "compaction" };

/** What a tool call acts on, from its arguments: a file, a command, a pattern or a URL. */
export function targetOf(fields: Record<string, unknown>): { target?: string } {
  const target = [
    fields.file_path,
    fields.notebook_path,
    fields.path,
    fields.command,
    fields.pattern,
    fields.url,
    fields.query,
  ].find((value) => typeof value === "string" && value.length) as
    | string
    | undefined;
  return target ? { target } : {};
}

/** At most one `worker-activity` event per Work Item per this long. */
export const ACTIVITY_INTERVAL_MS = 5_000;
/** How often a running worker's worktree is sampled for its changed files. */
const CHANGES_INTERVAL_MS = 30_000;
/** Changed files a `worker-activity` event lists; `count` has them all. */
const LISTED_CHANGES = 20;
const LISTED = 8;
const COMMAND_CHARS = 200;
const NAME_CHARS = 120;

interface ActivityWindow {
  counts: {
    toolsStarted: number;
    toolsFinished: number;
    edits: number;
    commands: number;
    commandsFailed: number;
    turns: number;
    compactions: number;
  };
  tools: string[];
  /** Started tools with what they act on, `{tool, target}`. */
  targets: { tool: string; target: string }[];
  paths: string[];
  command?: string;
  /** The last context report in this interval. */
  context?: { tokens: number; window?: number };
  /** The worktree's changed files, when a sample found them changed since the last report. */
  changed?: { count: number; files: string[] };
}

const emptyWindow = (): ActivityWindow => ({
  counts: {
    toolsStarted: 0,
    toolsFinished: 0,
    edits: 0,
    commands: 0,
    commandsFailed: 0,
    turns: 0,
    compactions: 0,
  },
  tools: [],
  targets: [],
  paths: [],
});

/** Provider events that only stream a delta of text already in a later event. */
const DELTA = /(?:^stream_event$|_delta$|\.delta$)/;

/**
 * A worker run's activity into the run log: the first report after a
 * quiet interval is written at once, and later ones are coalesced into
 * one `worker-activity` event per interval (docs/reference/run-log.md#Run log), so a busy
 * worker can't balloon the log. Every string is redacted and truncated.
 *
 * With a transcript (the attempt's file, docs/reference/run-log.md#Attempt files), every
 * report and every provider event (`output`) also goes there at once, in
 * full: `{at, activity}` and `{at, output}` lines, redacted and bounded.
 */
export class ActivityLog {
  private window = emptyWindow();
  private pending = false;
  private lastAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly transcript?: RunFile;
  private readonly changes?: () => Promise<string[]>;
  private readonly intervalMs: number;
  private readonly sampler: NodeJS.Timeout | undefined;
  private sampling: Promise<void> | undefined;
  /** The changed files last reported, sorted. */
  private reported: string[] = [];
  /**
   * The files this run's edits counted (#2283): an edit tool's, and a file
   * a sample found changed that no tool reported, a shell's edit.
   */
  private readonly edited = new Set<string>();
  /** The worktree's changed files as the run began: not this run's edits. */
  private readonly before: Promise<void> | undefined;

  constructor(
    private readonly item: string,
    private readonly worktree: string,
    private readonly log: (event: Record<string, unknown>) => void,
    private readonly secrets: readonly string[],
    options: {
      /** The attempt's transcript (docs/reference/run-log.md#Attempt files). */
      transcript?: RunFile;
      /** The worktree's changed files, sampled every CHANGES_INTERVAL_MS: shell edits too. */
      changes?: () => Promise<string[]>;
      intervalMs?: number;
    } = {},
  ) {
    this.transcript = options.transcript;
    this.changes = options.changes;
    this.intervalMs = options.intervalMs ?? ACTIVITY_INTERVAL_MS;
    if (this.transcript)
      log({ event: "transcript", item, file: this.transcript.file });
    if (this.changes) {
      this.before = this.changes().then(
        (files) => {
          for (const file of files) this.edited.add(file);
        },
        () => {
          // The worktree is busy: the first sample counts every changed file.
        },
      );
      this.sampler = setInterval(() => void this.sample(), CHANGES_INTERVAL_MS);
      this.sampler.unref();
    }
  }

  /**
   * Sample the worktree's changed files now; a set that differs from the
   * last report goes out with the next event, and each changed file no
   * edit counted yet counts as one, so edits through a shell count too.
   */
  sample(): Promise<void> {
    if (!this.changes || this.closed) return Promise.resolve();
    const changes = this.changes;
    this.sampling ??= (this.before ?? Promise.resolve())
      .then(() => changes())
      .then((files) => {
        for (const file of files)
          if (!this.edited.has(file)) {
            this.edited.add(file);
            this.window.counts.edits += 1;
            listOnce(this.window.paths, this.clean(file, NAME_CHARS));
          }
        const sorted = [...files].sort();
        if (sorted.join("\0") === this.reported.join("\0")) return;
        this.reported = sorted;
        this.window.changed = {
          count: sorted.length,
          files: sorted
            .slice(0, LISTED_CHANGES)
            .map((file) => this.clean(file, NAME_CHARS)),
        };
        this.due();
      })
      .catch(() => {
        // The worktree is busy or gone: the next sample tries again.
      })
      .finally(() => {
        this.sampling = undefined;
      });
    return this.sampling;
  }

  readonly output = (event: unknown): void => {
    if (this.closed || !this.transcript) return;
    const type =
      event && typeof event === "object"
        ? (event as { type?: unknown }).type
        : undefined;
    if (typeof type === "string" && DELTA.test(type)) return;
    this.transcript.record({ output: event });
  };

  readonly report = (activity: WorkerActivity): void => {
    if (this.closed) return;
    this.transcript?.record({ activity });
    const window = this.window;
    switch (activity.kind) {
      case "tool":
        if (activity.phase === "finished") window.counts.toolsFinished += 1;
        else {
          window.counts.toolsStarted += 1;
          const tool = this.clean(activity.tool, NAME_CHARS);
          listOnce(window.tools, tool);
          if (activity.target && window.targets.length < LISTED)
            window.targets.push({
              tool,
              target: this.clean(this.inTree(activity.target), COMMAND_CHARS),
            });
        }
        break;
      case "edit":
        window.counts.edits += 1;
        this.edited.add(this.inTree(activity.path));
        listOnce(
          window.paths,
          this.clean(this.inTree(activity.path), NAME_CHARS),
        );
        break;
      case "command":
        window.counts.commands += 1;
        window.command = this.clean(activity.command, COMMAND_CHARS);
        break;
      case "command-failed":
        window.counts.commandsFailed += 1;
        break;
      case "turn":
        window.counts.turns += 1;
        break;
      case "context":
        if (!(Number.isSafeInteger(activity.tokens) && activity.tokens >= 0))
          return;
        window.context = {
          tokens: activity.tokens,
          ...(typeof activity.window === "number" &&
          Number.isSafeInteger(activity.window) &&
          activity.window > 0
            ? { window: activity.window }
            : {}),
        };
        break;
      case "compaction":
        window.counts.compactions += 1;
        break;
    }
    this.due();
  };

  /** Something to report: written at once after a quiet interval, else coalesced. */
  private due(): void {
    this.pending = true;
    if (this.timer) return;
    const wait = this.lastAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else {
      this.timer = setTimeout(() => this.flush(), wait);
      this.timer.unref();
    }
  }

  /** Write what is pending and stop: the run ended. */
  close(): void {
    clearInterval(this.sampler);
    this.flush();
    this.closed = true;
    this.transcript?.close();
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const { counts, tools, targets, paths, command, context, changed } =
      this.window;
    this.log({
      event: "worker-activity",
      item: this.item,
      counts,
      tools,
      ...(targets.length ? { targets } : {}),
      paths,
      ...(command !== undefined ? { command } : {}),
      ...(context ? { context } : {}),
      ...(changed ? { changed } : {}),
    });
    this.window = emptyWindow();
    this.pending = false;
    this.lastAt = Date.now();
  }

  /** A path inside the worktree relative to it; any other as given. */
  private inTree(path: string): string {
    const inTree = relative(
      resolve(this.worktree),
      resolve(this.worktree, path),
    );
    return inTree && !inTree.startsWith("..") && !isAbsolute(inTree)
      ? inTree
      : path;
  }

  /** Redacted, then one line, then cut: a cut never splits a secret into view. */
  private clean(value: string, chars: number): string {
    const line = redact(value, this.secrets).replace(/\s+/g, " ").trim();
    return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
  }
}

function listOnce(list: string[], value: string): void {
  if (list.length < LISTED && !list.includes(value)) list.push(value);
}
