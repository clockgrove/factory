/**
 * Each Work Item's own telemetry (#2278): the time its steps took, its
 * model calls with their tokens and cost, its worker's activity, its
 * validation runs, repairs, review verdicts and CI, and what its candidate
 * changed, folded from the run log alone (docs/reference/run-log.md). One
 * fold: the live status comment's tally (progress.ts RunTally) keeps one
 * per Objective run, and the Work Item comments (tracking.ts), the
 * Objective's Work Item table (progress.ts), the PR body (delivery.ts) and
 * `factory status ISSUE --item ID` render it.
 *
 * A count a provider doesn't report is counted apart from those it does,
 * and shows as "not reported", never 0. Nothing from a prompt, a
 * transcript or a command's output is kept: only counts, names (models,
 * tools, validation commands) and the candidate's changed paths, which the
 * PR shows already.
 */
import { ChildThreads, childTokensOf } from "./child-threads.js";
import {
  type ActivityCounts,
  count,
  foldActivity,
  itemOfEvent,
  num,
  phaseOf,
  str,
} from "./diagnostics.js";
import { displayTime, duration } from "./display.js";
import { itemOf } from "./engine.js";
import type { LogEvent } from "./log.js";
import { code, prose } from "./markdown.js";

/** A count summed over the model calls that reported it; `calls`: how many did. */
export interface Reported {
  sum: number;
  calls: number;
}

const TOKEN_FIELDS = [
  "input",
  "output",
  "cached",
  "cacheWrite",
  "reasoning",
  "total",
] as const;

/** One changed file of the candidate: lines added and removed, null for a binary file. */
export interface ChangedFile {
  path: string;
  added: number | null;
  removed: number | null;
}

/** What the published candidate changed against its base (the publish step's `published` event). */
export interface Changes {
  commit: string;
  files: ChangedFile[];
  /** Every changed file, also those past the ones listed. */
  count: number;
  /** Paths of the tests it adds or changes (`TEST_FILE`). */
  tests: string[];
}

export interface ItemTelemetry {
  item: string;
  /** Its first step's start, and its last event folded (for a settled view, the outcome it was taken at). */
  from: string;
  to: string;
  /**
   * Each phase's attempts, their outcomes and their summed time;
   * `running`: when the attempt running now started.
   */
  stages: Record<
    string,
    {
      attempts: number;
      ms: number;
      outcomes: Record<string, number>;
      running?: string;
    }
  >;
  /** Model calls in all, and by role with each model as `provider model effort`. */
  calls: number;
  roles: Record<string, { calls: number; models: string[] }>;
  /** Child threads included (providers/usage.ts Tokens). */
  tokens: Record<(typeof TOKEN_FIELDS)[number], Reported>;
  /**
   * The part of `tokens.total` child threads spent (Codex `spawn_agent`),
   * and how many threads; `calls`: the calls whose provider reports them
   * apart (a Claude call's sub-agents are inside its tokens, unsplit).
   */
  childTokens: Reported & { threads: number };
  costUsd: Reported;
  /** Model-visible tool calls by name (`nativeToolActivity`); `calls`: the calls that reported them. */
  tools: { byName: Record<string, number>; calls: number };
  /** Its worker's activity, summed; null when no `worker-activity` event was logged. */
  activity: ActivityCounts | null;
  /** Each validation command's runs (the worker's own and the validate step's), failures and time. */
  validation: Record<string, { runs: number; failed: number; ms: number }>;
  /** Each repair of it: the phase whose failure sent it back, and the phase repaired. */
  repairs: { from: string; target: string }[];
  /** The result review's verdicts: accepted, refused (a repair) or held. */
  reviews: Record<string, number>;
  /**
   * The result reviews' own telemetry (#2344), summed over them: the
   * finder's verdicts by kind; the suspicions raised, and of those proved,
   * made questions or notes, and dropped, with the proofs' tokens; the
   * proofs' repros confirmed or dropped by the refusal check; questions;
   * the review calls' tokens (the proofs' among them) and the reviews' time.
   */
  reviewer: {
    reviews: number;
    verdicts: Record<string, number>;
    suspicions: {
      raised: number;
      proved: number;
      questions: number;
      notes: number;
      dropped: number;
      tokens: number;
    };
    repros: { confirmed: number; dropped: number };
    questions: number;
    tokens: Reported;
    ms: number;
    /**
     * Each phase's time, summed over the reviews (review/item.ts): the
     * workspace's install, the finder calls (their wall time and the
     * slowest criterion's call), the time from their start to the first
     * proof's, and the proofs.
     */
    phases: {
      prepareMs: number;
      modelMs: number;
      slowestFinderMs: number;
      firstProofMs: number;
      proofsMs: number;
    };
  };
  /** CI step attempts, its polls (retries while checks run) and the failed jobs it reran. */
  ci: { attempts: number; polls: number; reruns: number };
  /** Null until its candidate is published. */
  changes: Changes | null;
}

/** Providers whose calls report child threads apart (`childTokens`, providers/usage.ts usageRecord). */
const CHILD_THREADS_APART = new Set(["codex"]);

/** A test file by its path: in a test directory, or named as a test. */
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$/;

/** The changed files a `published` event keeps; `count` has them all. */
export const CHANGES_KEPT = 200;

/** The tests among `files`, by path. */
export function testsOf(files: readonly ChangedFile[]): string[] {
  return files.map((file) => file.path).filter((path) => TEST_FILE.test(path));
}

/**
 * The fold, fed a run's events in log order. `settled` is each item as of
 * its last step outcome that wasn't a poll (`polled`), or its attempt
 * dropped at cancel: the GitHub views show that, so they change as the
 * item moves through its steps, not with every worker report or CI poll.
 * `live` is everything read so far.
 */
export class ItemTelemetries {
  private readonly live = new Map<string, ItemTelemetry>();
  private readonly settled = new Map<string, ItemTelemetry>();
  /** Each step attempt running now: its start. */
  private readonly open = new Map<string, string>();
  /** Older Codex calls' child threads, counted as today's (child-threads.ts). */
  private readonly children = new ChildThreads();

  add(read: LogEvent): void {
    const event = this.children.counted(read);
    const step = str(event.step);
    const id = itemOfEvent(event);
    switch (event.event) {
      case "start": {
        if (!step || !id || !itemOf(step)) return;
        const item = this.record(id, event.at);
        const phase = phaseOf(step);
        // An item runs one step at a time: one still open was interrupted
        // (its run died), and its time is unknown.
        for (const [other, stage] of Object.entries(item.stages))
          if (stage.running) {
            delete stage.running;
            this.open.delete(`item:${id}:${other}`);
          }
        item.stages[phase] ??= { attempts: 0, ms: 0, outcomes: {} };
        const stage = item.stages[phase];
        stage.attempts += 1;
        stage.running = event.at;
        this.open.set(step, event.at);
        if (phase === "ci") item.ci.attempts += 1;
        return;
      }
      case "outcome": {
        if (!step) return;
        const outcome = str(event.outcome) ?? "ended";
        const target = str(event.target) ?? step;
        // A repair counts on the item it sends back (analysis.ts repairs).
        const repaired = outcome === "repair" ? itemOf(target) : undefined;
        if (repaired)
          this.record(repaired, event.at).repairs.push({
            from: phaseOf(step),
            target: phaseOf(target),
          });
        if (id && itemOf(step)) {
          const item = this.record(id, event.at);
          const phase = phaseOf(step);
          const stage = this.close(item, step, event.at);
          if (stage)
            stage.outcomes[outcome] = (stage.outcomes[outcome] ?? 0) + 1;
          if (phase === "ci" && outcome === "retry") item.ci.polls += 1;
          if (phase === "review" && outcome !== "retry") {
            const verdict =
              outcome === "done"
                ? "accepted"
                : outcome === "repair"
                  ? "refused"
                  : outcome === "hold"
                    ? "held"
                    : outcome;
            item.reviews[verdict] = (item.reviews[verdict] ?? 0) + 1;
          }
          if (outcome !== "retry" || !this.polled(event, item)) this.settle(id);
        }
        if (repaired && repaired !== id) this.settle(repaired);
        return;
      }
      case "ignored": {
        // A step from before cancel (engine.ts `apply`): its attempt ended
        // there, and the closed issue's comment shows what it spent.
        if (!step || !id || !itemOf(step)) return;
        this.close(this.record(id, event.at), step, event.at);
        this.settle(id);
        return;
      }
      case "model-usage": {
        if (!id) return;
        const item = this.record(id, event.at);
        item.calls += 1;
        const role = str(event.role) ?? "unknown";
        item.roles[role] ??= { calls: 0, models: [] };
        const of = item.roles[role];
        of.calls += 1;
        const model = [event.provider, event.model, event.effort]
          .map(str)
          .filter(Boolean)
          .join(" ");
        if (model && !of.models.includes(model) && of.models.length < 3)
          of.models.push(model);
        const counts = (event.tokens ?? {}) as Record<string, unknown>;
        for (const field of TOKEN_FIELDS) {
          const value = num(counts[field]);
          if (value === undefined) continue;
          item.tokens[field].sum += value;
          item.tokens[field].calls += 1;
        }
        const children = childTokensOf(event);
        if (
          children ||
          (event.childTokens !== undefined &&
            CHILD_THREADS_APART.has(str(event.provider) ?? ""))
        ) {
          item.childTokens.calls += 1;
          item.childTokens.sum += num(children?.total) ?? 0;
          item.childTokens.threads += num(children?.threads) ?? 0;
        }
        const total = num(counts.total);
        if (str(event.phase) === "result-review" && total !== undefined) {
          item.reviewer.tokens.sum += total;
          item.reviewer.tokens.calls += 1;
        }
        const cost = num(event.costUsd);
        if (cost !== undefined) {
          item.costUsd.sum += cost;
          item.costUsd.calls += 1;
        }
        const tools = event.nativeToolActivity as
          | { byName?: Record<string, unknown> }
          | null
          | undefined;
        if (tools && typeof tools === "object") {
          item.tools.calls += 1;
          for (const [name, n] of Object.entries(tools.byName ?? {}))
            item.tools.byName[name] =
              (item.tools.byName[name] ?? 0) + (num(n) ?? 0);
        }
        return;
      }
      case "worker-activity": {
        if (!id) return;
        const item = this.record(id, event.at);
        item.activity = foldActivity(event, item.activity ?? undefined);
        return;
      }
      case "validation-result": {
        if (!id) return;
        const item = this.record(id, event.at);
        const command = str(event.command) ?? "unnamed";
        item.validation[command] ??= { runs: 0, failed: 0, ms: 0 };
        const row = item.validation[command];
        row.runs += 1;
        if (!event.passed) row.failed += 1;
        row.ms += num(event.durationMs) ?? 0;
        return;
      }
      case "ci-rerun":
        if (id) this.record(id, event.at).ci.reruns += 1;
        return;
      case "result-review": {
        if (!id) return;
        const { reviewer } = this.record(id, event.at);
        reviewer.reviews += 1;
        const of = (value: unknown) =>
          (value && typeof value === "object" ? value : {}) as Record<
            string,
            unknown
          >;
        for (const [kind, n] of Object.entries(of(event.verdicts)))
          reviewer.verdicts[kind] =
            (reviewer.verdicts[kind] ?? 0) + (num(n) ?? 0);
        const suspicions = of(event.suspicions);
        for (const key of [
          "raised",
          "proved",
          "questions",
          "notes",
          "dropped",
          "tokens",
        ] as const)
          reviewer.suspicions[key] += num(suspicions[key]) ?? 0;
        reviewer.repros.confirmed += num(of(event.repros).confirmed) ?? 0;
        reviewer.repros.dropped += num(of(event.repros).dropped) ?? 0;
        reviewer.questions += num(event.questions) ?? 0;
        reviewer.ms += num(event.ms) ?? 0;
        const phases = of(event.phases);
        reviewer.phases.prepareMs += num(phases.prepareMs) ?? 0;
        reviewer.phases.modelMs += num(phases.modelMs) ?? 0;
        reviewer.phases.slowestFinderMs += num(phases.slowestFinderMs) ?? 0;
        reviewer.phases.firstProofMs += num(phases.firstProofMs) ?? 0;
        reviewer.phases.proofsMs += num(phases.proofsMs) ?? 0;
        return;
      }
      case "published": {
        if (!id) return;
        const changes = changesOf(event);
        if (changes) this.record(id, event.at).changes = changes;
        return;
      }
    }
  }

  /** Each item as of its last settled outcome. */
  settledItems(): Record<string, ItemTelemetry> {
    return Object.fromEntries(this.settled);
  }

  /** Each item as of the last event read. */
  liveItems(): Record<string, ItemTelemetry> {
    return Object.fromEntries(
      [...this.live].map(([id, item]) => [id, structuredClone(item)]),
    );
  }

  private settle(id: string): void {
    const item = this.live.get(id);
    if (item) this.settled.set(id, structuredClone(item));
  }

  /** End `step`'s attempt running now at `at`: its stage, with the attempt's time added. */
  private close(item: ItemTelemetry, step: string, at: string) {
    const stage = item.stages[phaseOf(step)];
    const started = this.open.get(step);
    this.open.delete(step);
    if (!stage) return undefined;
    delete stage.running;
    if (started) stage.ms += Math.max(0, Date.parse(at) - Date.parse(started));
    return stage;
  }

  /**
   * Whether a retry is a poll (CI checks running, a gate, GitHub's lag):
   * neither an error nor a continuation, and nothing spent since the item
   * last settled. An error or a continuation ends an attempt that may have
   * worked, so a step that keeps failing or continuing shows what it spent.
   */
  private polled(event: LogEvent, item: ItemTelemetry): boolean {
    if (event.progress === true || event.wait === "error") return false;
    const last = this.settled.get(item.item);
    const runs = (of: ItemTelemetry | undefined) =>
      Object.values(of?.validation ?? {}).reduce(
        (sum, row) => sum + row.runs,
        0,
      );
    return (
      (last?.calls ?? 0) === item.calls &&
      runs(last) === runs(item) &&
      (last?.ci.reruns ?? 0) === item.ci.reruns
    );
  }

  private record(id: string, at: string): ItemTelemetry {
    let item = this.live.get(id);
    if (!item) {
      const reported = () => ({ sum: 0, calls: 0 });
      item = {
        item: id,
        from: at,
        to: at,
        stages: {},
        calls: 0,
        roles: {},
        tokens: {
          input: reported(),
          output: reported(),
          cached: reported(),
          cacheWrite: reported(),
          reasoning: reported(),
          total: reported(),
        },
        childTokens: { ...reported(), threads: 0 },
        costUsd: reported(),
        tools: { byName: {}, calls: 0 },
        activity: null,
        validation: {},
        repairs: [],
        reviews: {},
        reviewer: {
          reviews: 0,
          verdicts: {},
          suspicions: {
            raised: 0,
            proved: 0,
            questions: 0,
            notes: 0,
            dropped: 0,
            tokens: 0,
          },
          repros: { confirmed: 0, dropped: 0 },
          questions: 0,
          tokens: reported(),
          ms: 0,
          phases: {
            prepareMs: 0,
            modelMs: 0,
            slowestFinderMs: 0,
            firstProofMs: 0,
            proofsMs: 0,
          },
        },
        ci: { attempts: 0, polls: 0, reruns: 0 },
        changes: null,
      };
      this.live.set(id, item);
    }
    if (at > item.to) item.to = at;
    return item;
  }
}

/** A `published` event's changes, checked. */
function changesOf(event: LogEvent): Changes | undefined {
  const changes = event.changes as Record<string, unknown> | undefined;
  if (!changes || typeof changes !== "object" || !Array.isArray(changes.files))
    return undefined;
  const files = changes.files.flatMap((file): ChangedFile[] => {
    const path = str((file as Record<string, unknown> | null)?.path);
    if (path === undefined) return [];
    const lines = (key: string) =>
      num((file as Record<string, unknown>)[key]) ?? null;
    return [{ path, added: lines("added"), removed: lines("removed") }];
  });
  return {
    commit: str(changes.commit) ?? "",
    files,
    count: num(changes.count) ?? files.length,
    tests: Array.isArray(changes.tests)
      ? changes.tests.map(str).filter((path) => path !== undefined)
      : testsOf(files),
  };
}

// --- rendering --------------------------------------------------------------

/** The item's wall time: its first step's start to its last event folded. */
export function wallMs(item: ItemTelemetry): number {
  return Math.max(0, Date.parse(item.to) - Date.parse(item.from));
}

/** A count over `calls` model calls: "not reported" when none reported it, and how many did when some didn't. */
function reported(value: Reported, calls: number, show = count): string {
  if (!value.calls) return "not reported";
  return value.calls < calls
    ? `${show(value.sum)} (${value.calls} of ${calls} calls reported)`
    : show(value.sum);
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A token count in a few characters: `13.0M`, `950K`, `812`. */
export function shortCount(sum: number): string {
  return sum >= 1_000_000
    ? `${(sum / 1_000_000).toFixed(1)}M`
    : sum >= 1_000
      ? `${Math.round(sum / 1_000)}K`
      : String(sum);
}

/** Tokens in a few characters, for a table cell: `13.0M`, `950K`, `812`. */
export function shortTokens(item: ItemTelemetry): string {
  const { sum, calls } = item.tokens.total;
  if (!calls) return item.calls ? "not reported" : "-";
  const short = shortCount(sum);
  return calls < item.calls ? `${short}+` : short;
}

/**
 * The one-line summary: wall time, tokens, model calls and repairs. Plain
 * text, numbers and words only: it goes into Markdown as it is.
 */
export function summaryLine(item: ItemTelemetry): string {
  return [
    duration(wallMs(item)),
    item.calls
      ? `${reported(item.tokens.total, item.calls)} tokens`
      : "no model calls",
    ...(item.calls ? [plural(item.calls, "model call")] : []),
    plural(item.repairs.length, "repair"),
  ].join(" · ");
}

/** The phases in step order (work/steps.ts PHASES); any other after them. */
const ORDER = [
  "work",
  "select",
  "validate",
  "review",
  "publish",
  "ci",
  "merge",
];

/** How a breakdown renders names and how much of each list it shows. */
interface Style {
  /** A name (a command, path, tool or model): code on GitHub. */
  name(value: string): string;
  /** Free text that isn't a name: prose on GitHub. */
  text(value: string): string;
  /** The most entries a list shows, and of the changed files; undefined: all of them. */
  limit?: number;
  files?: number;
}

/** The breakdown, one row per kind: its label, its line, and lines under it. */
function rows(
  item: ItemTelemetry,
  style: Style,
): { label: string; value: string; under?: string[] }[] {
  const listed = <T>(
    entries: T[],
    each: (entry: T) => string,
    limit = style.limit,
  ) => {
    const shown = limit === undefined ? entries : entries.slice(0, limit);
    return [
      ...shown.map(each),
      ...(entries.length > shown.length
        ? [`+${entries.length - shown.length} more`]
        : []),
    ];
  };
  const phases = Object.keys(item.stages).sort(
    (a, b) =>
      (ORDER.indexOf(a) + 1 || ORDER.length + 1) -
        (ORDER.indexOf(b) + 1 || ORDER.length + 1) || a.localeCompare(b),
  );
  const stages = phases.map((phase) => {
    const stage = item.stages[phase]!;
    const name = phase === "ci" ? "CI" : phase;
    const notes = [
      ...(stage.attempts > 1 ? [plural(stage.attempts, "attempt")] : []),
      ...(phase === "ci" && item.ci.polls
        ? [plural(item.ci.polls, "poll")]
        : []),
    ];
    return `${style.text(name)} ${duration(stage.ms)}${notes.length ? ` (${notes.join(", ")})` : ""}${stage.running ? `, running since ${style.text(displayTime(stage.running))}` : ""}`;
  });
  const { tokens, calls } = item;
  const share =
    tokens.cached.calls === tokens.input.calls && tokens.input.sum > 0
      ? `, ${Math.round((tokens.cached.sum / tokens.input.sum) * 100)}% of input`
      : "";
  const children = item.childTokens;
  const roles = Object.entries(item.roles).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const tools = Object.entries(item.tools.byName).sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  const commands = Object.entries(item.validation).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const runs = commands.reduce((sum, [, row]) => sum + row.runs, 0);
  const failed = commands.reduce((sum, [, row]) => sum + row.failed, 0);
  const validationMs = commands.reduce((sum, [, row]) => sum + row.ms, 0);
  const reviews = Object.entries(item.reviews);
  const activity = item.activity;
  const changes = item.changes;
  const lines = (file: ChangedFile) =>
    file.added === null || file.removed === null
      ? "binary"
      : `+${file.added} -${file.removed}`;
  const known = changes?.files.filter((file) => file.added !== null) ?? [];
  return [
    {
      label: "Time",
      value: `${duration(wallMs(item))} in all${stages.length ? `; ${stages.join(", ")}` : ""}`,
    },
    {
      label: "Model calls",
      value: calls
        ? listed(
            roles,
            ([role, of]) =>
              `${style.text(role)} ${of.calls}${of.models.length ? ` (${of.models.map(style.name).join(", ")})` : ""}`,
          ).join(", ")
        : "none",
    },
    ...(calls
      ? [
          {
            label: "Tokens",
            value: [
              `${reported(tokens.total, calls)} in all`,
              `input ${reported(tokens.input, calls)}`,
              `cached ${reported(tokens.cached, calls)}${share}`,
              `cache writes ${reported(tokens.cacheWrite, calls)}`,
              `output ${reported(tokens.output, calls)}`,
              `reasoning ${reported(tokens.reasoning, calls)}`,
              `child threads ${children.calls ? (children.sum ? `${count(children.sum)} by ${plural(children.threads, "thread")}` : "none") : "not reported"}`,
            ].join(", "),
          },
          {
            label: "Cost",
            value: reported(item.costUsd, calls, (usd) => `$${usd.toFixed(2)}`),
          },
          {
            label: "Tool calls",
            value: item.tools.calls
              ? tools.length
                ? `${tools.reduce((sum, [, n]) => sum + n, 0)}${item.tools.calls < calls ? ` (${item.tools.calls} of ${calls} calls reported)` : ""}: ${listed(tools, ([name, n]) => `${style.name(name)} ${n}`).join(", ")}`
                : "none"
              : "not reported",
          },
        ]
      : []),
    // Edits count only what a provider reports as an edit (Codex's
    // `file_change` items, Claude's edit tools): a file a shell command
    // writes, as Codex workers mostly do, is in none, so the count says so
    // rather than read as all the item changed.
    {
      label: "Worker",
      value: activity
        ? `${plural(activity.turns, "turn")}, ${plural(activity.commands, "command")} (${activity.commandsFailed} failed), ${plural(activity.edits, "edit")}, ${plural(activity.compactions, "compaction")}`
        : "not reported",
    },
    {
      label: "Validation",
      value: runs
        ? `${plural(runs, "run")}, ${failed} failed, ${duration(validationMs)}: ${listed(
            commands,
            ([command, row]) =>
              `${style.name(command)} ${row.runs}${row.failed ? ` (${row.failed} failed)` : ""} in ${duration(row.ms)}`,
          ).join("; ")}`
        : "none",
    },
    {
      label: "Repairs",
      value: item.repairs.length
        ? `${item.repairs.length}: ${listed(item.repairs, (repair) => `${style.text(repair.from)} sent ${style.text(repair.target)} back`).join(", ")}`
        : "none",
    },
    {
      label: "Review",
      value: reviews.length
        ? reviews
            .map(([verdict, n]) => `${n} ${style.text(verdict)}`)
            .join(", ")
        : "none",
    },
    {
      label: "Reviewer",
      value: reviewerLine(item.reviewer),
    },
    {
      label: "CI",
      value: item.ci.attempts
        ? `${plural(item.ci.attempts, "attempt")}, ${plural(item.ci.polls, "poll")}, ${plural(item.ci.reruns, "rerun")} of failed jobs`
        : "none",
    },
    changes
      ? {
          label: "Changes",
          value: `${plural(changes.count, "file")}${known.length ? `, +${known.reduce((sum, file) => sum + file.added!, 0)} -${known.reduce((sum, file) => sum + file.removed!, 0)} lines${changes.count > changes.files.length ? ` in the first ${changes.files.length}` : ""}` : ""}${changes.commit ? ` in ${style.name(changes.commit.slice(0, 12))}` : ""}`,
          under: listed(
            changes.files,
            (file) => `${style.name(file.path)} ${lines(file)}`,
            style.files,
          ),
        }
      : { label: "Changes", value: "not published yet" },
    ...(changes
      ? [
          {
            label: "Tests added or changed",
            value: changes.tests.length
              ? listed(changes.tests, style.name).join(", ")
              : "none",
          },
        ]
      : []),
  ];
}

/** The result reviews' telemetry as one line of numbers and words. */
function reviewerLine(reviewer: ItemTelemetry["reviewer"]): string {
  if (!reviewer.reviews) return "none";
  const verdicts = ["pass", "suspect", "question"]
    .map((kind) => `${reviewer.verdicts[kind] ?? 0} ${kind}`)
    .join(", ");
  const { suspicions } = reviewer;
  return [
    plural(reviewer.reviews, "review"),
    `verdicts ${verdicts}`,
    `suspicions ${suspicions.raised} raised, ${suspicions.proved} proved, ${suspicions.questions} questions, ${suspicions.notes} notes, ${suspicions.dropped} dropped (proofs ${count(suspicions.tokens)} tokens)`,
    `repros ${reviewer.repros.confirmed} confirmed, ${reviewer.repros.dropped} dropped`,
    plural(reviewer.questions, "question"),
    `${reviewer.tokens.calls ? count(reviewer.tokens.sum) : "not reported"} tokens`,
    `${duration(reviewer.ms)} (install ${duration(reviewer.phases.prepareMs)}, finder ${duration(reviewer.phases.modelMs)}, slowest criterion ${duration(reviewer.phases.slowestFinderMs)}, first proof after ${duration(reviewer.phases.firstProofMs)}, proofs ${duration(reviewer.phases.proofsMs)})`,
  ].join(", ");
}

/**
 * The most of each list the GitHub comment shows (of the changed files,
 * FILES), and of one name's characters: with them a comment stays under
 * 25,000 characters with every list full, well under GitHub's 65,536.
 */
const LISTED = 20;
const FILES = 40;
const NAME_CHARS = 120;

/** One line, cut to `max` characters. */
function cut(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The item comment's telemetry: the summary line, then the breakdown in a
 * `<details>` block. Names are inline code, cut; lists stop at LISTED.
 */
export function telemetryMarkdown(item: ItemTelemetry): string[] {
  const style: Style = {
    name: (value) => code(cut(value, NAME_CHARS)),
    text: (value) => prose(cut(value, NAME_CHARS)),
    limit: LISTED,
    files: FILES,
  };
  return [
    `**Telemetry:** ${summaryLine(item)}`,
    [
      "<details><summary>Telemetry details</summary>",
      "",
      ...rows(item, style).flatMap((row) => [
        `- **${row.label}:** ${row.value}`,
        ...(row.under ?? []).map((line) => `  - ${line}`),
      ]),
      "",
      "</details>",
    ].join("\n"),
  ];
}

/** `factory status ISSUE --item ID`: the same breakdown as text, every list whole. */
export function telemetryText(item: ItemTelemetry, heading: string): string {
  const style: Style = { name: (value) => value, text: (value) => value };
  return `${[
    `${heading} · ${summaryLine(item)}`,
    ...rows(item, style).flatMap((row) => [
      `  ${row.label}: ${row.value}`,
      ...(row.under ?? []).map((line) => `    ${line}`),
    ]),
  ].join("\n")}\n`;
}
