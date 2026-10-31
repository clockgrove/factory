import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isObject } from "./checked.js";
import { crashPoint } from "./crash.js";
import type { FrozenConfig } from "./providers/selection.js";
import type { QueueMode, RefusalCode } from "./requests.js";
import type { Spend } from "./spend.js";

/**
 * 10: a validation entry of a kept planner answer is `{command, after}`,
 * not a string (#2290). 9: an attempt counts the service's deaths it ran at (`interrupted`),
 * and no question is saved per step (`asking`). 8: a diagnosis fact's `applied` corrections are records, not their
 * rendered findings (work/facts.ts). 6: a hold carries its answers as
 * `options`, each with its family and consequence. 5: a Work Item's
 * refused and replayed result is one `refused` fact, and its diagnosis
 * one `diagnosis` fact (work/facts.ts).
 * 4: a hold has a cause, an error retry is a wait class, cancel and the
 * end are one `ended` record (3: one frozen configuration in place of the
 * frozen provider). Another version is unreadable, with no migration;
 * `factory reset` rebuilds it from GitHub (reset.ts), with no open
 * question.
 */
const STATE_VERSION = 10;

export type ObjectiveStatus =
  | "checking"
  | "planning"
  | "building"
  | "finishing"
  | "holding"
  /** `factory reset`: rebuilding the state from GitHub (reset.ts). */
  | "resetting"
  | "done"
  | "cancelled";

export const TERMINAL: readonly ObjectiveStatus[] = ["done", "cancelled"];

/**
 * Why a question is open: a decision only a person can make, or a step
 * that can't succeed as it is (errors in a row, an allowance spent, a
 * crash loop, a result it can't produce), which also offers `replan`
 * where the workflow can plan again (engine.ts `Workflow.replannable`).
 */
export type HoldCause = "question" | "failure";

/** What kind of choice an answer is: a host groups a long list of options by it. */
export type AnswerFamily =
  | "retry"
  | "replan"
  | "cancel"
  | "wait"
  | "switch"
  | "adopt"
  | "accept"
  | "refuse"
  /** Several of a hold's answers in one, each with its text (`HoldOption.list`). */
  | "decide"
  | "select"
  | "answer"
  | "repair"
  | "retire"
  | "reset";

/** One answer a hold offers (docs/reference/holds.md#Holds and answers). */
export interface HoldOption {
  /** The literal answer token: `/factory <answer>`. */
  answer: string;
  family: AnswerFamily;
  /** What goes after the token, for a parameterized answer (`switch NAME`). */
  arg?: string;
  /** One short sentence: what happens on this answer. */
  consequence: string;
  /** The answer needs text after it: one without is refused, with no change. */
  needsText?: boolean;
  /** Exactly one option per hold. */
  recommended?: boolean;
  /**
   * The arguments of this hold's options of the same answer that this one
   * gives at once, each with its text (`accept all`: `accept <n>` for every
   * criterion the question lists). The answer records them as its `parts`.
   */
  covers?: string[];
  /**
   * Its text lists this hold's parameterized answers to give at once
   * (`decide`), checked when it is answered (`answerList`). The answer
   * records them as its `parts`.
   */
  list?: true;
}

/**
 * One of the hold's parameterized answers that an answer gave beside
 * others (`HoldOption.covers`, `HoldOption.list`): `accept 2` and its text.
 */
export interface AnswerPart {
  answer: string;
  arg: string;
  text?: string;
}

/** A question only a person can answer. Every answer it lists works. */
export interface Hold {
  id: string;
  /** The step that asked; it runs again with the answer. */
  step: string;
  /**
   * The Work Item it stops (a Work Item step's question about that item):
   * that item waits, and the items that depend on it. Absent: the whole
   * Objective waits (docs/reference/holds.md#Holds and answers).
   */
  item?: string;
  question: string;
  options: HoldOption[];
  cause: HoldCause;
  askedAt: string;
  /**
   * When its issue comment last changed to what it shows now, by GitHub's
   * clock (the comment's created_at or updated_at): an answer that names
   * no question is compared with this, never with a host time.
   */
  shownAt?: string;
  /** The comment shows the short form `/factory <answer>` (it was the one open question). */
  shortForm?: boolean;
  /** Its issue comment's URL, once GitHub showed it: the closed question links it (`ClosedHold.url`). */
  url?: string;
  /**
   * A human gate's question: its step keeps polling while it is open, and
   * it closes by itself once the step no longer waits on the gate.
   */
  polls?: true;
}

/**
 * How an option is written after `/factory`: `switch codex`, `answer
 * <text>`; `bound` (`--question ID`) goes right after the answer.
 */
export function answerForm(option: HoldOption, bound?: string): string {
  return [
    option.answer,
    ...(bound ? [bound] : []),
    ...(option.arg !== undefined ? [option.arg] : []),
    ...(option.needsText ? ["<text>"] : []),
  ].join(" ");
}

/** The answer tokens a hold offers, once each, for a reply that names them. */
export function answersOf(hold: Pick<Hold, "options">): string[] {
  return [...new Set(hold.options.map((option) => option.answer))];
}

/** RegExp source matching `text` literally. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The argument of the answers that give every criterion a question lists
 * at once (`accept all`, `HoldOption.covers`). Only a question that offers
 * it takes it: one about a single criterion offers `accept <n>` alone.
 */
export const ALL = "all";

/**
 * The argument a reason starts with, when it is one of `args`: after
 * `and`, `&` or a comma, or alone when it is a number (`accept 1 and 2
 * <reason>`, `accept 1 2 <reason>`; a provider's name may start a reason).
 * An answer that names one argument and then such a reason would read as
 * deciding several while it decides one, so it is refused.
 */
export function leadingArg(
  reason: string | undefined,
  args: readonly string[],
): string | undefined {
  const lead = reason
    ? /^(and\s+|&\s*|,\s*)?([^\s,.;:&]+)(?=[\s,.;:]|$)/i.exec(reason)
    : null;
  return lead &&
    args.includes(lead[2]!) &&
    (lead[1] !== undefined || /^\d+$/.test(lead[2]!))
    ? lead[2]
    : undefined;
}

/**
 * The parts a `list` option's text gives (`HoldOption.list`), or why it
 * gives none. Each entry reads `<answer> <arg>[,<arg>...] <text>`, one per
 * line, or after a `;` that the next entry follows (`accept 1,2 It ran;
 * refuse 3 It didn't`); a leading `-` or `*` is a list bullet, and a comma
 * may have spaces around it (`accept 1, 2 It ran`). Each names options of
 * `options` with an argument (not another covering or list one), each
 * argument once, with text where its option needs it. An entry whose
 * text starts with another argument (`accept 1 and 2 It ran`) is refused,
 * never read as deciding only the first (`leadingArg`).
 */
export function answerList(
  text: string,
  options: readonly HoldOption[],
): AnswerPart[] | string {
  const single = options.filter(
    (option) => option.arg !== undefined && !option.covers && !option.list,
  );
  const forms = single.map((option) => `\`${answerForm(option)}\``).join(", ");
  if (!single.length) return "This question offers no answers to list.";
  const answers = [...new Set(single.map((option) => option.answer))];
  const args = [...new Set(single.map((option) => option.arg!))];
  // A `;` splits only where an entry follows it, so a reason can hold one.
  const next = new RegExp(
    `;\\s*(?=(?:${answers.map(literal).join("|")})\\s+(?:${args.map(literal).join("|")})(?:[,\\s]|$))`,
    "i",
  );
  const entries = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(next))
    .map((entry) => entry.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  const parts: AnswerPart[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const match =
      /^(\S+)\s+([^\s,]+(?:\s*,\s*[^\s,]+)*)(?:\s+([\s\S]*))?$/.exec(entry);
    const answer = match ? match[1]!.toLowerCase() : undefined;
    if (!match || answer === undefined || !answers.includes(answer))
      return `"${entry.slice(0, 80)}" isn't an entry of the list: each reads \`<answer> <n>[,<n>...] <text>\`, one per line or after \`;\`, naming answers this question offers: ${forms}.`;
    const reason = match[3]?.trim();
    const listed = match[2]!.split(/\s*,\s*/);
    const more = leadingArg(reason, args);
    if (more !== undefined)
      return `"${entry.slice(0, 80)}" names ${more} in its reason: list the criteria an entry decides comma-separated before its reason, \`${answer} ${[...listed, more].join(",")} <text>\`.`;
    for (const arg of listed) {
      const option = single.find(
        (one) => one.answer === answer && one.arg === arg,
      );
      if (!option)
        return `\`${answer} ${arg}\` isn't an answer to this question; it offers ${forms}.`;
      if (seen.has(arg))
        return `The list names ${arg} more than once; name each once.`;
      if (option.needsText && !reason)
        return `\`${answer} ${arg}\` needs text after it in the list, for example \`${answer} ${arg} <your text>\`.`;
      seen.add(arg);
      parts.push({ answer, arg, ...(reason ? { text: reason } : {}) });
    }
  }
  return parts.length
    ? parts
    : `The list names no answer: give one entry per line, each \`<answer> <n>[,<n>...] <text>\`, from ${forms}.`;
}

/**
 * A closing's answer as its question's history shows it: the answer with
 * its argument, then the answers it gave at once (`parts`), as in
 * `decide (accept 1, refuse 2)`.
 */
export function closingAnswer(
  closing: Pick<HoldClosing, "answer" | "arg" | "parts">,
): string {
  const answer = [closing.answer, closing.arg]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return closing.parts?.length
    ? `${answer} (${closing.parts.map((part) => `${part.answer} ${part.arg}`).join(", ")})`
    : answer;
}

/**
 * How an answer reached Factory: `factory answer` (or `factory retry
 * --question`, `factory cancel`), a `/factory` comment, or Factory itself
 * (`rereview-kept`).
 */
export type AnswerChannel = "cli" | "comment" | "factory";

/**
 * Who answered, beyond `by` (docs/reference/holds.md#Answered questions):
 * `as` names who gave the answer on `by`'s behalf (`factory answer --as`,
 * FACTORY_ANSWERED_AS), such as an agent operating Factory for a person;
 * `comment` is a `/factory` comment's URL.
 */
export interface AnsweredVia {
  channel: AnswerChannel;
  as?: string;
  comment?: string;
}

export interface Answer {
  holdId: string;
  /** The question this answers, as it was asked. */
  question?: string;
  answer: string;
  /** The option's argument, for a parameterized answer (`accept 2`). */
  arg?: string;
  text?: string;
  /** The answers it gave at once (`accept all`, `decide`): `HoldOption.covers`, `HoldOption.list`. */
  parts?: AnswerPart[];
  /** A comment's author's GitHub login, the CLI's host user, or `factory`. */
  by: string;
  /** Who gave it on `by`'s behalf (`AnsweredVia`). */
  as?: string;
  channel?: AnswerChannel;
  at: string;
}

/**
 * How a question closed: `answered`, or without an answer: `superseded`
 * (a newer question of its step replaced it), `cancelled` (the Objective
 * was), `reset` (`factory reset` rebuilt the state without it), `cleared`
 * or `replanned` (a repair or a replan cleared the work it asked about),
 * `gate-cleared` (the human gate it waited on cleared by itself),
 * `moved-on` (its human gate's step stopped waiting on the gate some
 * other way, without the gate clearing or a newer question taking its
 * place), `asked-again` (`adopt` met a configuration that changed again)
 * and `declined` (`factory decline-discovery` settled its amendment).
 */
export type ClosedHow =
  | "answered"
  | "superseded"
  | "cancelled"
  | "reset"
  | "cleared"
  | "replanned"
  | "gate-cleared"
  | "moved-on"
  | "asked-again"
  | "declined";

export interface HoldClosing {
  how: ClosedHow;
  at: string;
  /** The answer token, for `answered`. */
  answer?: string;
  /** Its option's argument (`switch NAME`, `accept 2`). */
  arg?: string;
  /** Its text, whole (at most MAX_ANSWER_TEXT): cut only where it is shown, after redaction. */
  text?: string;
  /** The answers it gave at once (`Answer.parts`), each with its text. */
  parts?: AnswerPart[];
  /** Who answered or cancelled (as `Answer.by`); `deadline` when the deadline cancelled. */
  by?: string;
  as?: string;
  channel?: AnswerChannel;
  /** The `/factory` comment's URL. */
  comment?: string;
  /** `superseded`: the question that replaced it. */
  next?: string;
}

/**
 * A question that closed, kept for its comment and the run's history
 * (`closedHolds`): its comment is edited to show the closing, the live
 * status comment lists the latest, and the report the answers.
 */
export interface ClosedHold {
  id: string;
  step: string;
  item?: string;
  cause: HoldCause;
  askedAt: string;
  /** The question's first line, whole and unredacted, as saved: cut only where it is shown, after redaction. */
  summary: string;
  /** The question and its options, kept until its comment shows the closing (`shown`). */
  question?: string;
  options?: HoldOption[];
  /** Its comment's URL (`Hold.url`). */
  url?: string;
  closed: HoldClosing;
  /** Its comment shows the closing, had none, or was given up on. */
  shown?: true;
}

/**
 * The key in `kept` of a resetting record's reset (reset.ts `RESET`,
 * `ResetRecord`), whose `old` state's questions stay open until the
 * rebuild lands (reset.ts `closedByReset`) or a cancel closes them.
 */
export const RESET_KEY = "reset";

/** Shown closed questions kept, newest last (`keptClosings`). */
export const CLOSED_KEPT = 30;

/**
 * Record that `hold` closed (`closing`) in `state.closedHolds`, newest
 * last (`keptClosings` bounds them). A hold recorded already keeps its
 * first closing. Every way a question closes comes here, so its comment
 * shows it. Its summary and text are kept whole: they are redacted only
 * where they are shown, so they are cut only there, after redaction (a
 * cut first could leave part of a secret that redaction no longer
 * matches). An answer's text is at most MAX_ANSWER_TEXT (engine.ts).
 */
export function recordClosed(
  state: Pick<ObjectiveState, "closedHolds">,
  hold: Hold,
  closing: HoldClosing,
): void {
  const closed = state.closedHolds ?? [];
  if (closed.some((entry) => entry.id === hold.id)) return;
  state.closedHolds = keptClosings([
    ...closed,
    {
      id: hold.id,
      step: hold.step,
      ...(hold.item !== undefined ? { item: hold.item } : {}),
      cause: hold.cause,
      askedAt: hold.askedAt,
      summary: hold.question.split("\n")[0]!.trim(),
      question: hold.question,
      options: hold.options,
      ...(hold.url ? { url: hold.url } : {}),
      closed: closing,
    },
  ]);
}

/**
 * Closed questions (oldest first) bounded: every one whose comment doesn't
 * show its closing yet, so none is lost before its edit (the sync edits
 * it or gives it up: `closingShown`), and the newest CLOSED_KEPT shown.
 */
export function keptClosings(entries: ClosedHold[]): ClosedHold[] {
  let shown = 0;
  const kept: ClosedHold[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.shown && ++shown > CLOSED_KEPT) continue;
    kept.push(entry);
  }
  return kept.reverse();
}

/** The closed questions whose comment doesn't show the closing yet. */
export function unshownClosings(
  state: Pick<ObjectiveState, "closedHolds">,
): ClosedHold[] {
  return (state.closedHolds ?? []).filter((entry) => !entry.shown);
}

/**
 * A new question's id for step `key`, asked at `at`: `key@` an ISO time,
 * past every id of the step the state still has (open and closed
 * questions, a resetting record's old ones, and the answers' `holdId`).
 * Times are to the millisecond, so a step asking twice in one (an answer
 * and the narrower question after it) took the earlier one's id (#2211):
 * the later takes the next millisecond instead. The id stays readable and
 * sorts with the step's others; `askedAt` keeps the clock's time.
 */
export function newHoldId(
  state: Pick<ObjectiveState, "holds" | "closedHolds" | "answers" | "kept">,
  key: string,
  at: string,
): string {
  const prefix = `${key}@`;
  const old = (
    state.kept?.[RESET_KEY] as
      | { old?: Pick<ObjectiveState, "holds"> }
      | undefined
  )?.old;
  const ids = [
    ...state.holds,
    ...(old?.holds ?? []),
    ...(state.closedHolds ?? []),
  ].map((hold) => hold.id);
  for (const answer of Object.values(state.answers)) ids.push(answer.holdId);
  let next = Date.parse(at);
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const time = Date.parse(id.slice(prefix.length));
    if (time >= next) next = time + 1;
  }
  return `${prefix}${new Date(next).toISOString()}`;
}

/**
 * Why a retry waits (docs/reference/steps.md#Waits). Absent: an unknown transient cause,
 * such as the network, a GitHub or provider outage, or CI still running.
 */
export type Wait =
  /**
   * An error: an escaped exception, a missed deadline, an idle model or an
   * invalid answer. It shares the unknown cause's budget, and three in a
   * row hold.
   */
  | { kind: "error" }
  /** A limit that resets at `at` (unknown when absent), from `provider` when a model provider set it. */
  | { kind: "reset"; at?: string; provider?: string }
  /**
   * Something outside Factory: a person (`human`: an environment approval,
   * a required review), another Objective (a predecessor, a split's
   * children), or the native-stack layers above a layer, which must be
   * published before its stack exists (delivery.ts `judge`). Only a
   * person's gate asks after a while.
   */
  | { kind: "gate"; gate: string; human?: true };

export interface Retry {
  /** Consecutive escaped errors and missed deadlines; any other outcome resets it. */
  count: number;
  /** Retries in this run of one wait class (`Wait`, or an unknown cause); sets the backoff. */
  attempts: number;
  /** When this run of one wait class began (wall clock, so a restart doesn't reset it). */
  since: string;
  nextAt: string;
  lastError: string;
  /** The reason this run of retries began with. */
  cause?: string;
  /** The latest wait's class; absent for unknown transient causes. */
  wait?: Wait;
  /** The operator answered `wait`: no question until then. */
  grantedUntil?: string;
}

/**
 * The configuration an Objective runs with, frozen at admission
 * (docs/reference/state.md#Frozen configuration): its provider, with that provider's
 * resolved settings, and every other key but the operational ones
 * (providers/selection.ts OPERATIONAL). A `switch` or `adopt` answer freezes it again.
 */
export interface Frozen extends FrozenConfig {
  provider: string;
  /** Why this provider: the configured default, `serve --provider`, or the operator's `switch` answer. */
  selectedBy: "defaultProvider" | "--provider" | "switch";
}

export interface ObjectiveState {
  version: number;
  issue: number;
  /** `holding` while any question is open. */
  status: ObjectiveStatus;
  /** Frozen at admission; absent only without configuration. */
  frozen?: Frozen;
  /** Open questions, oldest first: at most one for the Objective and one per Work Item. */
  holds: Hold[];
  /** The latest closed questions, newest last (`recordClosed`); absent until one closes. */
  closedHolds?: ClosedHold[];
  /**
   * The latest GitHub time at which any question's comment was shown
   * (posted or edited), closed questions included. An answer that names no
   * question applies only to a question shown after every other one, so it
   * can't land on a question its author didn't read (engine.ts `answer`).
   */
  lastShownAt?: string;
  /** The latest answer per step, read by the step when it runs again. */
  answers: Record<string, Answer>;
  retries: Record<string, Retry>;
  /** Facts steps keep across repairs (Outcome `keep`), by key. */
  kept: Record<string, unknown>;
  /**
   * Repairs per target step, the latest repaired last, with the latest
   * findings (newest last).
   * `free`: the repair numbers that count against no allowance (a failure
   * blamed on a predecessor, allowances.ts).
   */
  repairs: Record<
    string,
    {
      count: number;
      findings: string[];
      free?: number[];
      /** The step whose failure sent the latest repair: its class, for status. */
      from?: string;
    }
  >;
  /** Steps that finished, with their saved results. */
  done: Record<string, unknown>;
  /**
   * Steps started and not yet finished, with the service run that started
   * each. One found after a restart was interrupted, and runs again; it
   * counts the deaths in a row it ran at, other steps finishing between
   * (`interrupted`, engine.ts `ObjectiveRunner.interrupted`).
   */
  attempts: Record<
    string,
    { startedAt: string; run?: string; id?: string; interrupted?: number }
  >;
  /**
   * Per step: attempts started so far (`n`; an attempt's id is
   * `<step>#<n>`), and the attempt its next one continues (`parent`: the
   * continuation, the repair that sent it back, or the interrupted
   * attempt it reruns). Run-log identity only; nothing decides on it.
   */
  stepRuns?: Record<string, { n: number; parent?: string }>;
  /** The service run that last finished a step of this Objective, saved with the step's outcome. */
  finishedRun?: string;
  /**
   * Dequeued while its check or a re-run's cleanup ran: nothing past them
   * starts, and the service withdraws it once no step runs and the re-run's
   * cleanup is done.
   */
  withdrawing?: boolean;
  /** The latest applied requests and their results, so a request is never applied twice. */
  appliedRequests: { id: string; message: string; code?: RefusalCode }[];
  /**
   * The operator's pause or drain (`factory pause|drain N`), until
   * `factory resume N`. Paused: no step starts. Draining: no Work Item
   * starts that hasn't started; started ones carry on.
   */
  control?: { mode: "paused" | "draining"; by: string; at: string };
  /** Per-capability data. Modules own their key. */
  modules: Record<string, unknown>;
  /**
   * Model spend so far, and the operator's grants past the spend ceiling
   * (spend.ts). Absent until the first call reports any. A replan keeps it.
   */
  spend?: Spend;
  updatedAt: string;
  /** When this run was admitted: with the issue, it names the run. */
  startedAt?: string;
  /**
   * The absolute deadline, saved at admission (`deadlineAt`): at it the
   * engine cancels the Objective, whatever it waits on (engine.ts
   * `expire`). Nothing moves it: not a restart, a reset or a later
   * configuration. Absent: no deadline.
   */
  deadline?: string;
  /**
   * The first save at a terminal status; `by` names who cancelled
   * (`deadline`: the deadline did); `source` says `by` is the GitHub login
   * of a `/factory cancel` comment's author (absent: the CLI's host user,
   * never shown on GitHub).
   */
  ended?: { at: string; by?: string; source?: "github" };
}

/**
 * The deadline of a run admitted at `at`: the admitting request's own
 * absolute time when it names one, else `seconds` (the configuration's
 * `queue.objectiveDeadlineSeconds`) later; none without either.
 */
export function deadlineAt(
  at: Date,
  seconds: number | undefined,
  requested?: string,
): string | undefined {
  if (requested !== undefined) return new Date(requested).toISOString();
  return seconds === undefined
    ? undefined
    : new Date(at.getTime() + seconds * 1000).toISOString();
}

export function newObjective(
  issue: number,
  now: Date,
  frozen?: Frozen,
): ObjectiveState {
  return {
    version: STATE_VERSION,
    issue,
    status: "checking",
    ...(frozen ? { frozen } : {}),
    holds: [],
    answers: {},
    retries: {},
    repairs: {},
    kept: {},
    done: {},
    attempts: {},
    appliedRequests: [],
    modules: {},
    updatedAt: now.toISOString(),
    startedAt: now.toISOString(),
  };
}

/**
 * A run's identity: its admission time (with the issue, it names the run).
 * Every artifact Factory relies on across runs is bound to it: memory
 * records and pins, the report comment. A record from before runs had one
 * reads as `unknown`.
 */
export function runOf(state: ObjectiveState): string {
  return state.startedAt ?? "unknown";
}

/** The most this host's clock is taken to differ from GitHub's: host times read against GitHub's go back this far. */
export const CLOCK_SKEW_MS = 10 * 60_000;

/** Where a GitHub read of this run's own comments starts: its admission (a host time), less the skew. */
export function sinceRun(state: ObjectiveState): string | undefined {
  const at = Date.parse(state.startedAt ?? "");
  return Number.isFinite(at)
    ? new Date(at - CLOCK_SKEW_MS).toISOString()
    : undefined;
}

function statePath(dir: string, issue: number): string {
  return join(dir, `${issue}.json`);
}

/**
 * Write the whole file, owner-only: temporary file, fsync, rename, fsync
 * the directory. A crash at any point leaves the old file or the new one,
 * never a mix. `point` names the crash points before the rename and after.
 */
export function writeAtomic(path: string, text: string, point?: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (point) crashPoint(`${point}:before-rename`);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
  if (point) crashPoint(`${point}:saved`);
}

/** Save the Objective's state whole (`writeAtomic`). */
export function saveState(dir: string, state: ObjectiveState): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(
    statePath(dir, state.issue),
    `${JSON.stringify(state, null, 2)}\n`,
    "state",
  );
}

/** The queue-wide mode (`factory queue pause|drain|resume`), saved in the installation root. */
export interface QueueControl {
  mode: QueueMode;
  by?: string;
  at?: string;
}

const QUEUE_FILE = "queue.json";

/** The saved queue mode; running when none was saved or the file can't be read. */
export function loadQueueControl(root: string): QueueControl {
  try {
    const saved = JSON.parse(
      readFileSync(join(root, QUEUE_FILE), "utf8"),
    ) as QueueControl;
    if (["running", "paused", "draining"].includes(saved.mode)) return saved;
  } catch {
    // Never saved.
  }
  return { mode: "running" };
}

/** Save the queue mode whole (`writeAtomic`). */
export function saveQueueControl(root: string, control: QueueControl): void {
  writeAtomic(join(root, QUEUE_FILE), `${JSON.stringify(control)}\n`);
}

/** Remove the Objective's state: it was dequeued before it started. */
export function removeState(dir: string, issue: number): void {
  rmSync(statePath(dir, issue), { force: true });
  syncDirectory(dir);
}

/**
 * Settled Objectives' files, under the state directory: the service never
 * reads them at startup (rule 6: cost follows active work, never history);
 * findState reads one when a request, a re-queue or status names it.
 */
const FINISHED = "finished";

/**
 * Move a settled Objective's file into finished/, once its cleanup, its
 * final sync and its settled observation are done. A later save (a request
 * to the finished Objective) writes the active file again, and it moves
 * again. Nothing to move is not an error.
 */
export function finishState(dir: string, issue: number): void {
  const finished = join(dir, FINISHED);
  mkdirSync(finished, { recursive: true });
  try {
    renameSync(statePath(dir, issue), statePath(finished, issue));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(finished);
  syncDirectory(dir);
}

const OBSERVATION = ".observe.json";

/**
 * A run's settled observation that hasn't landed (service.ts `late`): the
 * state it observes, saved beside the finished states until it lands, so
 * a restart retries it. Returns the file, to remove once it lands.
 */
export function saveObservation(dir: string, state: ObjectiveState): string {
  const finished = join(dir, FINISHED);
  mkdirSync(finished, { recursive: true });
  const run = runOf(state).replace(/[^\w.-]/g, "-");
  const path = join(finished, `${state.issue}@${run}${OBSERVATION}`);
  writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

/**
 * The settled observations still to land. Only these files are read, never
 * the finished states; one that isn't a state comes with its `error`, and
 * leftover temporary files are removed.
 */
export function listObservations(
  dir: string,
): { path: string; state?: ObjectiveState; error?: string }[] {
  const finished = join(dir, FINISHED);
  let names: string[];
  try {
    names = readdirSync(finished);
  } catch {
    return [];
  }
  const found: { path: string; state?: ObjectiveState; error?: string }[] = [];
  for (const name of names) {
    const path = join(finished, name);
    if (name.includes(`${OBSERVATION}.`) && name.endsWith(".tmp"))
      rmSync(path, { force: true });
    if (!name.endsWith(OBSERVATION)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // read again at the next start
    }
    let problem: string | undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
      problem = stateProblem(
        value,
        Number(/^(\d+)@/.exec(name)?.[1] ?? Number.NaN),
      );
    } catch (error) {
      problem = String(error);
    }
    found.push(
      problem
        ? { path, error: problem }
        : { path, state: value as ObjectiveState },
    );
  }
  return found;
}

/** The Objective's active state, else its finished one; null when it has neither. */
export function findState(dir: string, issue: number): Loaded | null {
  return loadState(dir, issue) ?? loadState(join(dir, FINISHED), issue);
}

/** Every issue with an active or a finished state file. */
export function listAllObjectives(dir: string): number[] {
  return [
    ...new Set([
      ...listObjectives(dir),
      ...listObjectives(join(dir, FINISHED)),
    ]),
  ].sort((a, b) => a - b);
}

function syncDirectory(dir: string): void {
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export type Loaded =
  | { kind: "ok"; state: ObjectiveState }
  | {
      kind: "unreadable";
      issue: number;
      error: string;
      /** The file's digest: one incident of unreadable state, until the file changes. */
      incident: string;
    };

/**
 * The Objective's state; null when it has none. A file that doesn't
 * parse, has another version or another shape (`stateProblem`) is
 * unreadable; a read that fails (EMFILE, EIO) throws, and the caller tries
 * again later.
 */
export function loadState(dir: string, issue: number): Loaded | null {
  let text: string;
  try {
    text = readFileSync(statePath(dir, issue), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let problem: string | undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
    problem = stateProblem(value, issue);
  } catch (error) {
    problem = String(error);
  }
  return problem
    ? { kind: "unreadable", issue, error: problem, incident: digest(text) }
    : { kind: "ok", state: value as ObjectiveState };
}

const STATUSES: readonly ObjectiveStatus[] = [
  "checking",
  "planning",
  "building",
  "finishing",
  "holding",
  "resetting",
  "done",
  "cancelled",
];

/**
 * Why `value` isn't a state file of Objective `issue` this version can
 * run; undefined when it is one. Checked once, where a file is read: the
 * engine, the sync and status trust every state they get. It checks what
 * every reader relies on (the top-level fields, each open question and
 * the accepted plans' shape); a module's own data is its module's to check.
 */
function stateProblem(value: unknown, issue: number): string | undefined {
  if (!isObject(value)) return "the state isn't an object";
  if (value.version !== STATE_VERSION)
    return `state version ${value.version}, expected ${STATE_VERSION}`;
  if (value.issue !== issue)
    return `the state names issue ${JSON.stringify(value.issue)}, not #${issue}`;
  if (!STATUSES.includes(value.status as ObjectiveStatus))
    return `status ${JSON.stringify(value.status)} isn't one Factory knows`;
  for (const key of [
    "answers",
    "retries",
    "kept",
    "repairs",
    "done",
    "attempts",
    "modules",
  ])
    if (!isObject(value[key])) return `${key} isn't an object`;
  for (const key of ["retries", "attempts"])
    for (const [step, entry] of Object.entries(
      value[key] as Record<string, unknown>,
    ))
      if (!isObject(entry)) return `${key}.${step} isn't an object`;
  for (const key of ["frozen", "control", "ended", "stepRuns", "spend"])
    if (value[key] !== undefined && !isObject(value[key]))
      return `${key} isn't an object`;
  for (const key of [
    "updatedAt",
    "startedAt",
    "deadline",
    "lastShownAt",
    "finishedRun",
  ])
    if (
      (key === "updatedAt" || value[key] !== undefined) &&
      typeof value[key] !== "string"
    )
      return `${key} isn't text`;
  if (
    !Array.isArray(value.appliedRequests) ||
    !value.appliedRequests.every(
      (applied) => isObject(applied) && typeof applied.id === "string",
    )
  )
    return "appliedRequests isn't a list of applied requests";
  if (!Array.isArray(value.holds)) return "holds isn't a list";
  for (const hold of value.holds as unknown[]) {
    if (
      !isObject(hold) ||
      !["id", "step", "question", "askedAt"].every(
        (key) => typeof hold[key] === "string",
      ) ||
      (hold.item !== undefined && typeof hold.item !== "string") ||
      !Array.isArray(hold.options) ||
      !hold.options.every(
        (option) =>
          isObject(option) &&
          typeof option.answer === "string" &&
          typeof option.family === "string" &&
          typeof option.consequence === "string",
      )
    )
      return `holds has a question that isn't one: ${JSON.stringify(hold).slice(0, 200)}`;
  }
  if (value.closedHolds !== undefined) {
    if (!Array.isArray(value.closedHolds)) return "closedHolds isn't a list";
    for (const closed of value.closedHolds as unknown[])
      if (
        !isObject(closed) ||
        !["id", "step", "summary", "askedAt"].every(
          (key) => typeof closed[key] === "string",
        ) ||
        !isObject(closed.closed) ||
        typeof closed.closed.how !== "string" ||
        typeof closed.closed.at !== "string"
      )
        return `closedHolds has a closed question that isn't one: ${JSON.stringify(closed).slice(0, 200)}`;
  }
  // The accepted plan and each accepted amendment's (planning/plan.ts).
  for (const [key, entry] of Object.entries(value.done as object))
    if (key === "plan" || /^amend:[^:]+$/.test(key)) {
      const plan = key === "plan" ? entry : (entry as { plan?: unknown })?.plan;
      if (key !== "plan" && plan === undefined) continue;
      const problem = planProblem(plan);
      if (problem) return `done.${key}${problem}`;
    }
  return undefined;
}

const isTexts = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Why a saved plan lacks what the service reads on every tick (its items,
 * coverage and final commands); undefined when it has it. The planner's
 * answer was checked where it entered (planning/wire.ts); this checks
 * only that the file, or a plan comment a reset reads (reset.ts
 * `planShaped`), still holds a plan.
 */
export function planProblem(plan: unknown): string | undefined {
  if (!isObject(plan)) return " isn't a plan";
  if (!isTexts(plan.finalCommands))
    return ".finalCommands isn't a list of commands";
  if (
    !Array.isArray(plan.coverage) ||
    !plan.coverage.every(
      (entry) => isObject(entry) && typeof entry.itemId === "string",
    )
  )
    return ".coverage isn't a list of covered obligations";
  if (!Array.isArray(plan.items)) return ".items isn't a list";
  for (const item of plan.items as unknown[])
    if (
      !isObject(item) ||
      !["id", "title", "goal", "brief"].every(
        (key) => typeof item[key] === "string",
      ) ||
      !["acceptance", "nonGoals", "dependencies", "ownedPaths"].every((key) =>
        isTexts(item[key]),
      ) ||
      !Array.isArray(item.citations) ||
      !Array.isArray(item.validation) ||
      !item.validation.every(
        (command) => isObject(command) && typeof command.command === "string",
      ) ||
      (item.children !== undefined && !isTexts(item.children))
    )
      return ` has a Work Item that isn't one: ${JSON.stringify(item).slice(0, 200)}`;
  return undefined;
}

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The digest of `state`'s file as saveState writes it: an incident's id, like an unreadable file's. */
export const stateDigest = (state: ObjectiveState): string =>
  digest(`${JSON.stringify(state, null, 2)}\n`);

/** Issue numbers with a state file. Leftover temporary files are ignored. */
export function listObjectives(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}
