import type { CoreConfig, QueueOption } from "./config.js";
import { crashPoint } from "./crash.js";
import { answeredBy, displayTime, redactDeep } from "./display.js";
import {
  CANCEL_CLEANUP,
  DEADLINE,
  type EngineLimits,
  type Left,
  type ObjectiveRunner,
} from "./engine.js";
import {
  type GitHub,
  GitHubError,
  issueGone,
  TransientError,
  TryAgain,
} from "./github.js";
import {
  callCounts,
  newTransport,
  requestEvents,
  type Transport,
  transport,
} from "./github-trace.js";
import type { ItemTelemetry } from "./item-telemetry.js";
import { backoffMs, Jobs } from "./jobs.js";
import { type RunLog, redact } from "./log.js";
import { code, mark, mentions, prose } from "./markdown.js";
import {
  decisionsOf,
  RunTally,
  STATUS_EVERY_MS,
  STATUS_REFRESH_MS,
  statusComment,
} from "./progress.js";
import {
  QueueDisplay,
  type QueueItem,
  queued,
  queueIssue,
  readQueue,
  unqueueIssue,
} from "./queue.js";
import {
  QUEUE_MODES,
  type Request,
  type RequestResult,
  refused,
  writeRequest,
} from "./requests.js";
import { resetting, statusRecordOf } from "./reset.js";
import type {
  AnswerPart,
  ClosedHold,
  Hold,
  HoldClosing,
  ObjectiveState,
  ObjectiveStatus,
  QueueControl,
  Retry,
} from "./state.js";
import {
  answerForm,
  CLOCK_SKEW_MS,
  runOf,
  sinceRun,
  TERMINAL,
  unshownClosings,
} from "./state.js";
import { type ObjectiveView, statusOf } from "./status.js";
import { errorMessage } from "./text.js";
import { type Tracking, track, trackingDue } from "./tracking.js";

/** What the sync keeps in an Objective's state (`modules.github`). */
export interface GitHubModule {
  itemId: string;
  /** The Project's order number when it was queued; ties go to the lower issue. */
  order?: number | null;
  /** The Factory field option last written. */
  shown?: string;
  /**
   * When Factory's last write of the card landed, by GitHub's clock: a
   * card reading another option set no later than this is a stale read,
   * not the operator's change.
   */
  shownAt?: string;
  /**
   * The option Factory last saw on the card or wrote, null when the card
   * had none (cleared, or off the Project). A card that changes from this
   * changed by someone else: a change from queued dequeues.
   */
  seen?: string | null;
  /**
   * The option Factory would have written when someone else changed the
   * started Objective's card: not written over that change until the
   * status moves on.
   */
  ceded?: string;
  /** An option Factory began writing: a card showing it is Factory's own write, landed or not. */
  writing?: string;
  /**
   * When the card was set to queued for this run, by GitHub's clock: a
   * stale read after a dequeue never admits the issue again (`withdrawnAt`).
   */
  queuedAt?: string;
  /** An unreadable state's question comment exists (open holds keep theirs: `Hold.shownAt`). */
  askedUnreadable?: boolean;
  /**
   * Comments are read from here on, by GitHub's clock, and only one created
   * at or after it is a command: an older comment edited later (GitHub's
   * `since` filters on `updated_at`) never acts. It starts at the run's
   * admission, or an unreadable state's question, and only moves forward.
   */
  commentsSince: string;
  /** Request ids already replied to. */
  replied?: string[];
  /** The wait the status note describes (`<step>@<since>`). */
  noted?: string;
  /** The human gate a reminder was posted for (`<step>@<since>`). */
  reminded?: string;
  /** Open questions whose 24 h reminder is posted, by hold id (unique per step, see newHoldId). */
  remindedHolds?: string[];
  /** A cancelled run's closing comment is posted, or GitHub refused it: it counts as shown. */
  cancelShown?: boolean;
  /** `/factory` comments whose author's access couldn't be read yet, oldest first. */
  unchecked?: UncheckedComment[];
  /** The live status comment's last write: its stable body's hash, the status it showed, and its GitHub time. */
  status?: { hash: string; shown: ObjectiveStatus; at: string };
  /** This run's live status comment can't be written (a lasting refusal or render failure): it counts as shown. */
  statusGivenUp?: boolean;
  /** A run being withdrawn: its live status comment and open question comments show the withdrawal, or it has none. */
  statusWithdrawn?: boolean;
  /** The Work Item issues as last written (tracking.ts). */
  tracking?: Tracking;
  /** This run's Work Item issues can't be written (the repository refused a list or a create): they count as shown. A refusal on one item's issue is kept on that item (tracking.ts), never here. */
  trackingGivenUp?: boolean;
}

/** A `/factory` comment waiting for its author's access to be read. */
export interface UncheckedComment {
  id: number;
  login: string;
  body: string;
  createdAt: string;
  /** Its URL on GitHub: an answer's closed question links it. */
  url?: string;
  failures: number;
  nextAt: string;
}

/** An Objective whose state file can't be read: it holds, with `reset` and `cancel`. */
export interface UnreadableObjective {
  error: string;
  /** Set aside by the service (service.ts `setAside`): its file reads, so `retry` reads it again too. */
  setAside?: true;
  /** Which incident: the unreadable file's digest. Its question and answers are this incident's only. */
  incident: string;
  /** Its card and comment cursor, once the sync has seen it on the Project. */
  github?: GitHubModule;
}

export interface SyncView {
  runners: ReadonlyMap<number, ObjectiveRunner>;
  unreadable: ReadonlyMap<number, UnreadableObjective>;
  /** The Objective's run, read from disk when it isn't in memory; throws when the read fails. */
  find(issue: number): ObjectiveRunner | undefined;
  /**
   * Run one Objective's part of the sync's tick: a throw is that
   * Objective's alone (service.ts `guarded`), and one whose work already
   * threw this tick is left alone.
   */
  guard(issue: number, work: () => void): void;
  /** Start (or start again) an Objective seen queued; the service decides whether it may. */
  admit(issue: number, github: GitHubModule): void;
  /**
   * Withdraw an Objective dequeued before it started: now, or (`pending`)
   * once its running check or a re-run's cleanup ends and its status
   * comment shows the withdrawal (`withdrawShown`); false when it has
   * started.
   */
  withdraw(issue: number): "withdrawn" | "pending" | false;
  /** Checked and waiting for a slot: its card stays as the operator set it until Factory shows a status. */
  waitingForSlot(issue: number): boolean;
  /** What the Objective waits on before it can start, as `factory status` shows it. */
  waitsOn(issue: number): ObjectiveView["waitsOn"];
  queue: QueueControl;
  /** The run log directory: the live status comment reads model calls and worker activity there. */
  logs: string;
  requestsDir: string;
  /** The result of an applied request, by id, while its result file exists. */
  result(id: string): string | undefined;
}

/** The option each status shows; checking shows none (the card stays queued). */
const OPTION: Record<ObjectiveStatus, QueueOption | undefined> = {
  checking: undefined,
  planning: "planning",
  building: "building",
  finishing: "building",
  holding: "holding",
  resetting: "planning",
  done: "done",
  cancelled: "cancelled",
};

/** Live status edits per hour, across the installation's Objectives. */
const STATUS_EDITS_PER_HOUR = 300;
/** A run withdrawn before planning: its status comment's final body, after the marker. */
const WITHDRAWN_LINE =
  "Withdrawn before planning; queue it again to start afresh.";
/** An open question's comment once its run is withdrawn, after the marker. */
const WITHDRAWN_QUESTION =
  "This question no longer applies: the run was withdrawn before planning. Queue the issue again to start afresh.";
/** Status or tracking job failures in a row, other than GitHub's transient errors, before it is given up. */
const GIVE_UP_AFTER = 3;

/** A sync job that failed waits this long, doubling, up to MAX_BACKOFF_MS. */
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/**
 * A rate-limited sync job waits for the reset, then up to this much more
 * at random, so the jobs the limit held don't all start in the same second.
 */
const RESET_JITTER_MS = 15_000;
/** A sync job past this is aborted and counts as failed. */
const DEADLINE_MS = 10 * 60_000;
/** Comments kept waiting for their author's access to be read, per Objective. */
const MAX_UNCHECKED = 20;
/** Queue reads failing this long show as an intake problem in `factory status`. */
const INTAKE_PROBLEM_MS = 10 * 60_000;
const COMMAND = /^\/factory\s+(\S+)(?:\s+([\s\S]*))?$/;
/**
 * The option right after the answer, before its text: `--question ID`
 * names the hold it answers.
 */
const ANSWER_OPTION = /^--question\s+(\S+)(?:\s+([\s\S]*))?$/;

/**
 * The request a writer's `/factory` comment on Objective `issue` makes:
 * `/factory queue pause|drain|resume` sets the whole queue's mode, as
 * `factory queue` does; `cancel` cancels; `retry` with no question open
 * retries; anything else answers a question.
 */
function commentRequest(
  issue: number,
  comment: Pick<UncheckedComment, "body" | "createdAt">,
  holding: boolean,
): Request | undefined {
  const command = comment.body.match(COMMAND);
  if (!command) return undefined;
  const answer = command[1]!.toLowerCase();
  let rest = command[2]?.trim() ?? "";
  const action = rest.toLowerCase();
  if (answer === "queue" && Object.hasOwn(QUEUE_MODES, action))
    return { kind: "queue", issue, mode: QUEUE_MODES[action]! };
  let question: string | undefined;
  for (
    let option = ANSWER_OPTION.exec(rest);
    option;
    option = ANSWER_OPTION.exec(rest)
  ) {
    question = option[1];
    rest = option[2]?.trim() ?? "";
  }
  const text = rest;
  if (answer === "cancel") return { kind: "cancel", issue };
  if (answer === "retry" && !holding && !question)
    return { kind: "retry", issue };
  return {
    kind: "answer",
    issue,
    answer,
    ...(text ? { text } : {}),
    writtenAt: comment.createdAt,
    ...(question ? { question } : {}),
  };
}

/**
 * GitHub is input and display, never a precondition: every call here runs in
 * the background, and nothing here can fail a run. A failed job is logged
 * and tried again after a backoff of its own (per job and Objective, capped
 * at ten minutes; jobs.ts), even when nothing else changes. A rate-limited
 * one waits for the limit's reset instead, plus up to RESET_JITTER_MS, and
 * never counts toward giving up; meanwhile the client sends nothing the
 * limit holds (github.ts `send`), so every job waits for the reset. One
 * past its ten-minute deadline is aborted and counts as failed, so one
 * Objective's bad card or locked issue never spends the rate limit the
 * others need. A finished Objective stays until its
 * final option and replies are written.
 *
 * The queue is read by levels: Factory never writes the queued option, so
 * a card that reads queued is always the operator's input. A finished
 * Objective queues again once its final option is written (`finalShown`)
 * and a read that began after Factory's last write shows it queued; any
 * read after a restart began after the last write. An unfinished one
 * dequeues when its card changes from queued to anything else, cleared or
 * off the Project included, against the option Factory last saw or wrote
 * (`seen`), which has no clock to need.
 */
export class GitHubSync {
  private view: QueueItem[] = [];
  /** The issues the last read asked for by number: one missing from `view` has no card. */
  private viewKnown = new Set<number>();
  /** When the last read started (this host's clock). */
  private viewAt = 0;
  /** When Factory last wrote each card (this host's clock): a read that started earlier is stale for it. */
  private readonly wroteAt = new Map<number, number>();
  /** Cards whose option changed under a pending write: shown again only after a fresh read. */
  private readonly changed = new Set<number>();
  /** A queue read landed since the last intake. */
  private fresh = false;
  /**
   * Known issues the last read couldn't read, with when that began (this
   * host's clock) and GitHub's error: their last good cards stay in
   * `view`, and intake leaves them alone.
   */
  private unread = new Map<number, { since: number; error: string }>();
  /** The entries the last read left out, as logged: each is logged once while it lasts. */
  private skipped = new Set<string>();
  /** When the queue read started failing as a whole (this host's clock). */
  private failingSince: number | undefined;
  /** Why intake is stopped, once queue reads have failed for INTAKE_PROBLEM_MS. */
  private intakeStopped: string | undefined;
  /**
   * Withdrawn runs' last queued time, by GitHub's clock: a card that still
   * reads queued from then (a read that began before the dequeue) is never
   * a new queue. Only a later queue admits the issue again.
   */
  private readonly withdrawnAt = new Map<number, number>();
  /** Known issues GitHub no longer has: left out of later reads. */
  private readonly gone = new Set<number>();
  private lastPoll = 0;
  /** The reset of the low budget last logged (`github-budget-low`): one event per reset. */
  private lowLogged = 0;
  /**
   * `factory run` cards queued and not yet admitted, with how to answer
   * their request when the operator dequeues them first: read by number
   * until then.
   */
  private readonly queuing = new Map<number, (result: RequestResult) => void>();
  /** Cancelled `factory run` cards whose move out of the queue hasn't landed yet (`unqueue`). */
  private readonly unqueuing = new Set<number>();
  private readonly jobs: Jobs;
  /** Finished Objectives whose final option and replies are written. */
  private readonly settled = new Set<number>();
  /** The repository's identity was read once since the service started. */
  private identified = false;
  private readonly display: QueueDisplay;
  /** The run log, read forward for the live status comments (made on the first tick). */
  private tally?: RunTally;
  /** When each Objective's live status comment was last due to be written (this host's clock). */
  private readonly statusTried = new Map<number, number>();
  /** When each Objective's Work Item issues were last due to be projected (this host's clock). */
  private readonly trackTried = new Map<number, number>();
  /** Status and tracking jobs failed in a row by something other than GitHub's transient errors, by job key. */
  private readonly failures = new Map<string, number>();
  /** Per job key: GitHub requests not yet written as `github-call` (`countTransport`). */
  private readonly transportTally = new Map<
    string,
    Transport & { issue: number; since: number; runs: number; ms: number }
  >();
  /** Job keys whose last run failed: the next run counts as a retry. */
  private readonly transportFailed = new Map<string, number>();
  /** Question comments written compact after GitHub refused them in full, by Objective and hold id (`compactAsk`). */
  private readonly compact = new Map<number, Set<string>>();
  /** When each live status edit of the last hour was made, across Objectives (this host's clock). */
  private statusEdits: number[] = [];

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
    private readonly log: RunLog,
    private readonly limits: Pick<
      EngineLimits,
      "noteAfterMs" | "remindAfterMs"
    >,
    private readonly now: () => number = () => Date.now(),
    /** The jitter after a rate limit's reset (RESET_JITTER_MS), as a fraction. */
    random: () => number = Math.random,
  ) {
    this.display = new QueueDisplay(github, config);
    this.jobs = new Jobs(
      log,
      "github-sync",
      {
        baseMs: BASE_BACKOFF_MS,
        maxMs: MAX_BACKOFF_MS,
        deadlineMs: DEADLINE_MS,
        jitterMs: RESET_JITTER_MS,
      },
      now,
      (error) => ({
        transient: error instanceof TransientError,
        ...(limitMs(error) !== undefined ? { rateLimited: true } : {}),
      }),
      limitMs,
      random,
    );
  }

  /**
   * A problem that pauses every GitHub effect of the installation: the
   * repository answers under another name (renamed or transferred). The
   * service then runs no step and no sync job, and settles nothing, until
   * the configuration names the repository and the service restarts.
   */
  problem(): string | undefined {
    return this.github.moved?.message;
  }

  /**
   * What intake hasn't seen for INTAKE_PROBLEM_MS, naming the fix; `factory
   * status` shows it: no queue read worked (the Project's permission lost,
   * a wrong `queue.projectId`), or a known issue's card kept erroring.
   * Running Objectives carry on, and intake resumes at the next good read.
   */
  intakeProblem(): string | undefined {
    const now = this.now();
    const frozen = [...this.unread]
      .filter(([, entry]) => now - entry.since >= INTAKE_PROBLEM_MS)
      .map(
        ([issue, entry]) =>
          `#${issue}'s card unreadable for ${Math.floor((now - entry.since) / 60_000)} min: ${redact(entry.error)}; card changes aren't seen`,
      );
    const problems = [
      ...(this.intakeStopped ? [this.intakeStopped] : []),
      ...frozen,
    ];
    return problems.length ? problems.join(". ") : undefined;
  }

  /** A queue read that failed as a whole: past INTAKE_PROBLEM_MS, intake reports it. */
  private queueFailed(error: unknown, startedAt: number): void {
    this.failingSince ??= startedAt;
    const minutes = Math.floor((this.now() - this.failingSince) / 60_000);
    if (this.now() - this.failingSince < INTAKE_PROBLEM_MS) return;
    const first = this.intakeStopped === undefined;
    const limited = limitMs(error);
    this.intakeStopped =
      limited !== undefined
        ? `Factory hasn't read the queue for ${minutes} min: GitHub's rate limit for ${this.config.github.app ? "the service's GitHub App installation" : "the service's GitHub login"} is spent (${redact(errorMessage(error))}), so no queued Objective is admitted or dequeued until it resets, at about ${displayTime(new Date(this.now() + limited).toISOString())}. Intake resumes at the next good read`
        : `Factory hasn't read the queue for ${minutes} min (${redact(errorMessage(error))}), so no queued Objective is admitted or dequeued. Check that ${this.config.github.app ? "the service's GitHub App can still read Project" : "the service's GitHub login can still read Project"} ${this.config.queue.projectId} (${this.config.github.app ? "the App needs the organization permission Projects: read and write" : "a token needs the project scope"}) and that queue.projectId names it; intake resumes at the next good read`;
    if (first)
      this.log.write(0, {
        event: "intake-stopped",
        error: errorMessage(error),
      });
  }

  tick(sync: SyncView): void {
    // Requests outside steps and sync jobs (readiness, the service's own
    // reads): the service's, tallied like a job's.
    const ambient = this.github.takeAmbient();
    if (ambient) {
      for (const event of requestEvents(AMBIENT, ambient))
        this.log.write(0, event);
      this.countTransport(0, AMBIENT, ambient, 0, ambient.failed > 0);
    }
    if (this.problem()) return;
    // A cancelled `factory run`'s card whose move failed: again, once its
    // wait is over.
    for (const issue of this.unqueuing) this.unrun(issue);
    // Read once at start: a rename while the service was down pauses
    // before any issue counts as gone (later redirects check it again).
    if (!this.identified)
      this.background(0, "identity", async (signal) => {
        await this.github.checkIdentity(signal);
        this.identified = true;
      });
    // The installation's budget below its reserve (github.reserve, the
    // client's lowBudget): what can wait waits for the reset, the queue
    // poll, comment reads, live status comments and Work Item issues.
    // Steps, cards, questions and replies go on. One event per reset.
    const low = this.github.lowBudget();
    if (low && low.resetAt !== this.lowLogged) {
      this.lowLogged = low.resetAt;
      this.log.write(0, {
        event: "github-budget-low",
        resource: low.resource,
        remaining: low.remaining,
        reserve: low.reserve,
        reset: new Date(low.resetAt).toISOString(),
      });
    }
    const due =
      !low &&
      this.now() - this.lastPoll >= this.config.queue.pollSeconds * 1000;
    if (due) {
      this.lastPoll = this.now();
      const known = [
        ...new Set([
          ...queued(this.view, this.config).map((item) => item.issue),
          ...[...sync.runners.values()]
            .filter((runner) => !TERMINAL.includes(runner.state.status))
            .map((runner) => runner.state.issue),
          ...sync.unreadable.keys(),
          ...this.queuing.keys(),
        ]),
      ].filter((issue) => !this.gone.has(issue));
      // The poll interval paces the queue read; it needs no backoff.
      const startedAt = this.now();
      this.background(
        0,
        "queue",
        async (signal) => {
          const read = await readQueue(this.github, this.config, known, signal);
          // An issue GitHub answered with an error for keeps its last good card.
          const unread = new Map(
            read.unread.map((issue) => [
              issue,
              {
                since: this.unread.get(issue)?.since ?? startedAt,
                error:
                  read.skipped.find((entry) => entry.issue === issue)?.error ??
                  "",
              },
            ]),
          );
          this.view = [
            ...read.items,
            ...this.view.filter((item) => unread.has(item.issue)),
          ];
          this.unread = unread;
          this.viewKnown = new Set(known.filter((issue) => !unread.has(issue)));
          this.viewAt = startedAt;
          this.fresh = true;
          for (const issue of read.gone) this.lose(issue, "queue");
          if (read.truncated)
            this.log.write(0, {
              event: "queue-truncated",
              unread: read.truncated,
            });
          const skipped = new Set<string>();
          for (const entry of read.skipped) {
            const key = `${entry.issue ?? ""} ${entry.error}`;
            if (!this.skipped.has(key))
              this.log.write(entry.issue ?? 0, {
                event: "queue-entry-skipped",
                error: entry.error,
              });
            skipped.add(key);
          }
          this.skipped = skipped;
          this.failingSince = undefined;
          if (this.intakeStopped) {
            this.intakeStopped = undefined;
            this.log.write(0, { event: "intake-resumed" });
          }
        },
        false,
        (error) => this.queueFailed(error, startedAt),
      );
    }
    if (this.fresh) {
      this.fresh = false;
      this.intake(sync);
    }
    for (const runner of sync.runners.values())
      sync.guard(runner.state.issue, () => {
        const module = runner.state.modules.github as GitHubModule | undefined;
        const issue = runner.state.issue;
        const finished = runner.settled;
        if (finished && this.settled.has(issue)) return;
        // An issue GitHub no longer has here (deleted, or moved away) has no
        // card or comments to write: its replies are dropped, and once it
        // finishes its sync is settled.
        if (this.gone.has(issue)) {
          if (finished) {
            for (const request of module ? unreplied(runner.state, module) : [])
              this.log.write(issue, { event: "reply-dropped", id: request.id });
            this.settled.add(issue);
          }
          return;
        }
        if (finished && this.synced(runner.state)) {
          this.settled.add(issue);
          return;
        }
        if (!module) return;
        this.show(runner, module, sync);
        this.ask(runner);
        this.closings(runner);
        if (!low) {
          this.status(runner, sync);
          this.track(runner, sync);
        }
        this.reply(runner, module, sync);
        this.cancelled(runner, module);
        if (finished) return;
        this.note(runner, module);
        this.remind(runner, module);
        if (due && !TERMINAL.includes(runner.state.status))
          this.readComments(
            issue,
            module,
            () => runner.state.holds.length > 0,
            sync,
            (change) =>
              runner.transact(() =>
                change(runner.state.modules.github as GitHubModule),
              ),
          );
      });
    for (const [issue, entry] of sync.unreadable)
      if (!this.gone.has(issue))
        sync.guard(issue, () => this.unreadable(issue, entry, due, sync));
  }

  /**
   * `factory run N`: set the issue's card to queued (queue.ts queueIssue),
   * once, in the background, and read the queue at once, so the normal
   * intake admits it. `closed` queues a closed issue (a finished Objective
   * runs again). `answer` refuses a missing or closed issue, and one the
   * operator dequeued after the request (`since`: queueIssue), now or by
   * a later queue read before the admission; a failed write is retried
   * with backoff on a later call.
   */
  queue(
    issue: number,
    closed: boolean,
    since: { at: string; shown?: string | undefined },
    answer: (result: RequestResult) => void,
  ): void {
    if (this.problem() || this.queuing.has(issue)) return;
    // The latest request wins: a cancel's move out of the queue stops.
    if (this.unqueuing.delete(issue)) this.jobs.forget(`unrun:${issue}`);
    this.background(issue, `run:${issue}`, async (signal) => {
      const outcome = await queueIssue(
        this.github,
        this.config,
        this.display,
        issue,
        closed,
        since,
        signal,
      );
      if (outcome === "queued") {
        this.queuing.set(issue, answer);
        // A read that began before this write is stale for the card.
        this.wroteAt.set(issue, this.now());
        this.lastPoll = 0;
        this.log.write(issue, { event: "run-queued" });
      } else answer(runRefusal(outcome, issue, this.config.repository));
    });
  }

  /** A `factory run N` request got its result: its card is no longer watched for a dequeue. */
  ranOut(issue: number): void {
    this.queuing.delete(issue);
  }

  /**
   * A cancel of a `factory run N` not admitted yet: stop queuing its card,
   * and move a card that reads queued to cancelled (queue.ts unqueueIssue).
   * A failed write runs again (`tick`) until it lands, and until then
   * intake leaves the issue alone, so a cancelled run is never admitted; a
   * later `factory run N` replaces it (`queue`).
   */
  unqueue(issue: number): void {
    this.queuing.delete(issue);
    this.jobs.forget(`run:${issue}`);
    this.unqueuing.add(issue);
    this.unrun(issue);
  }

  /** Take a cancelled `factory run` card out of the queue (`unqueue`). */
  private unrun(issue: number): void {
    if (this.problem()) return;
    this.background(issue, `unrun:${issue}`, async (signal) => {
      await unqueueIssue(this.github, this.config, this.display, issue, signal);
      this.wroteAt.set(issue, this.now());
      this.unqueuing.delete(issue);
    });
  }

  /** Whether a finished Objective's sync is done and no job of it is running. */
  idle(issue: number): boolean {
    return this.settled.has(issue) && !this.jobs.busy(issue);
  }

  /** Whether a finished Objective's card shows its final option and every reply is posted. */
  synced(state: ObjectiveState): boolean {
    const module = state.modules.github as GitHubModule | undefined;
    if (!module) return true;
    return (
      finalShown(state, this.config) &&
      !unreplied(state, module).length &&
      !unshownClosings(state).length &&
      (!this.config.progress.enabled ||
        ((module.statusGivenUp === true ||
          module.status?.shown === state.status) &&
          (state.status !== "cancelled" ||
            state.withdrawing === true ||
            module.cancelShown === true))) &&
      (!this.config.tracking.enabled ||
        module.trackingGivenUp === true ||
        !trackingDue(state, Date.now(), this.telemetry(state)))
    );
  }

  /**
   * Each Work Item's telemetry this run, as of its last finished step and
   * redacted, from the tally the status comment reads (progress.ts
   * RunTally): what tracking shows and what `synced` checks it against.
   * Undefined until a SyncView has named the log directory.
   */
  private telemetry(
    state: ObjectiveState,
    sync?: SyncView,
  ): Record<string, ItemTelemetry> | undefined {
    if (sync) this.tally ??= new RunTally(sync.logs);
    if (!this.tally) return undefined;
    return redactDeep(
      this.tally.read(state.issue, state.startedAt ?? "").items,
      this.config.secrets,
    );
  }

  /**
   * Forget an Objective the service let go of, or whose run was replaced:
   * its running jobs are aborted and its backoffs dropped, so nothing of
   * the old run writes, and the new run's jobs start at once. A reply in
   * flight still lands: it answers a command the old run applied, and its
   * marker makes it idempotent.
   */
  forget(issue: number): void {
    for (const [key, tally] of this.transportTally)
      if (tally.issue === issue) this.writeTransport(key);
    for (const [key, owner] of this.transportFailed)
      if (owner === issue) this.transportFailed.delete(key);
    this.settled.delete(issue);
    this.queuing.delete(issue);
    this.changed.delete(issue);
    this.wroteAt.delete(issue);
    this.statusTried.delete(issue);
    this.trackTried.delete(issue);
    this.failures.delete(`status:${issue}`);
    this.failures.delete(`track:${issue}`);
    this.failures.delete(`cancel:${issue}`);
    for (const key of this.failures.keys())
      if (key.startsWith(`ask:${issue}:`)) this.failures.delete(key);
    this.compact.delete(issue);
    this.tally?.forget(issue);
    this.jobs.forget(issue, (key) => key.startsWith("reply:"));
  }

  /** The service withdrew a dequeued run: forget it, and keep the dequeue's edge. */
  withdrawn(state: ObjectiveState): void {
    this.forget(state.issue);
    const module = state.modules.github as GitHubModule | undefined;
    const at = Date.parse(module?.queuedAt ?? "");
    if (Number.isFinite(at)) this.withdrawnAt.set(state.issue, at);
  }

  /**
   * Act on a fresh queue read, once: a card set to queued after Factory's
   * last write admits its Objective (a new one is admitted on first sight,
   * so it is checked at once; planning waits for a slot), and a card that
   * changed from what Factory last saw or wrote (`seen`) is someone else's
   * change: to anything but queued (another option, cleared, or off the
   * Project) it dequeues an Objective that hasn't started. Every
   * unfinished Objective takes its order from the card, so reordering works
   * until it starts. A card Factory wrote after the read began is skipped:
   * the read is stale for it.
   */
  private intake(sync: SyncView): void {
    const queuedOption = this.config.queue.options.queued;
    const items = new Map(this.view.map((item) => [item.issue, item]));
    for (const issue of new Set([...items.keys(), ...this.viewKnown])) {
      if (
        sync.unreadable.has(issue) ||
        this.unread.has(issue) ||
        this.unqueuing.has(issue)
      )
        continue;
      if (
        this.jobs.active(`show:${issue}`) ||
        (this.wroteAt.get(issue) ?? -1) >= this.viewAt
      )
        continue;
      this.changed.delete(issue);
      // Missing from a read that asked for it by number: no card.
      const item = items.get(issue);
      // A `factory run` card moved out of queued before its admission: the
      // operator's later dequeue drops the request.
      const asked = this.queuing.get(issue);
      if (asked && item?.option !== queuedOption) {
        this.queuing.delete(issue);
        asked(runRefusal("dequeued", issue, this.config.repository));
        this.log.write(issue, { event: "run-dequeued", option: item?.option });
        continue;
      }
      try {
        let runner = sync.runners.get(issue);
        if (item?.option === queuedOption && !runner) runner = sync.find(issue);
        if (!runner) {
          // A closed issue with no run isn't queued: only a finished
          // Objective runs again from a closed issue.
          if (item?.option === queuedOption && item.open)
            this.admitItem(item, sync);
          continue;
        }
        const state = runner.state;
        if (TERMINAL.includes(state.status)) {
          // Queued again after it finished: its cleanup ends first. The new
          // run reopens a closed issue (rerun:cleanup).
          if (
            item &&
            requeued(item, state, this.config) &&
            runner.settled &&
            this.synced(state)
          )
            this.admitItem(item, sync);
          continue;
        }
        const module = state.modules.github as GitHubModule | undefined;
        if (!module) continue;
        const option = item?.option ?? null;
        if (module.seen === undefined || option === module.writing)
          runner.transact(() => {
            const github = runner.state.modules.github as GitHubModule;
            if (option === github.writing && item?.optionAt)
              github.shownAt = item.optionAt;
            github.seen = option;
            delete github.writing;
          });
        else if (option !== module.seen) {
          if (
            this.cardChanged(
              runner,
              option,
              item?.optionAt ?? undefined,
              sync,
            ) === "withdrawn"
          )
            continue;
        }
        if (item && (module.order ?? null) !== item.order)
          runner.transact(() => {
            (runner.state.modules.github as GitHubModule).order = item.order;
          });
      } catch (error) {
        // A state read or save that failed: the next fresh read tries again.
        this.log.write(issue, {
          event: "queue-intake-failed",
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Someone else changed the card since Factory last saw or wrote it. To
   * anything but queued, that dequeues an Objective that hasn't started
   * planning: from queued; cleared or off the Project, which Factory never
   * writes; or, from what Factory showed for its check or a re-run's
   * cleanup (such as "Needs you" for a held one), an option set after
   * Factory's write (`at` later than `shownAt`), so a stale read of an
   * earlier write of Factory's own never withdraws. A finished
   * Objective set to queued is left to intake, which runs it again. Any
   * other change stands: Factory doesn't write over it until the status
   * moves on (`ceded`).
   */
  private cardChanged(
    runner: ObjectiveRunner,
    option: string | null,
    at: string | undefined,
    sync: SyncView,
  ): "withdrawn" | "requeued" | "ceded" {
    const issue = runner.state.issue;
    const queued = this.config.queue.options.queued;
    const module = runner.state.modules.github as GitHubModule;
    if (TERMINAL.includes(runner.state.status)) {
      if (option === queued) {
        // The operator's re-queue stands over the final option Factory
        // hadn't shown yet: that counts as shown, so intake can admit it.
        const final = this.desired(runner, sync);
        runner.transact(() => {
          const github = runner.state.modules.github as GitHubModule;
          github.seen = option;
          if (final !== undefined) github.ceded = final;
        });
        this.log.write(issue, { event: "card-changed", option, ceded: final });
        return "requeued";
      }
    } else if (
      option !== queued &&
      (module.seen === queued ||
        option === null ||
        Date.parse(at ?? "") > Date.parse(module.shownAt ?? ""))
    ) {
      // Not started (its check, or a re-run's cleanup): the operator's
      // change away from what Factory last saw or wrote dequeues it, so one
      // held there can be withdrawn. `withdraw` refuses a started Objective.
      const withdrawn = sync.withdraw(issue);
      if (withdrawn === "pending")
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).seen = option;
        });
      if (withdrawn) {
        this.log.write(issue, { event: "dequeued", option, withdrawn });
        return "withdrawn";
      }
    }
    const desired = this.desired(runner, sync);
    runner.transact(() => {
      const github = runner.state.modules.github as GitHubModule;
      github.seen = option;
      github.ceded = desired;
    });
    this.log.write(issue, { event: "card-changed", option, ceded: desired });
    return "ceded";
  }

  /**
   * Admit a queued card. Its comments are read from when it was queued, by
   * GitHub's clock (the option's `updatedAt`), never the host's: a comment
   * written right after queuing is read even when the host runs ahead, and
   * one from before (an earlier run's) never counts. GitHub always sends
   * the time with a set option; without it, a later read admits it.
   */
  private admitItem(item: QueueItem, sync: SyncView): void {
    if (!item.optionAt) return;
    const out = this.withdrawnAt.get(item.issue);
    if (out !== undefined && !(Date.parse(item.optionAt) > out)) return;
    this.withdrawnAt.delete(item.issue);
    sync.admit(item.issue, {
      itemId: item.itemId,
      order: item.order,
      seen: item.option,
      queuedAt: item.optionAt,
      commentsSince: item.optionAt,
    });
  }

  /**
   * The option the Objective's status shows, or undefined to leave the
   * card as it is: while checking, and while it waits for a slot before
   * Factory has shown anything (the operator's queued stands). After a
   * hold is answered it shows its status (Planning, Building) while it
   * waits.
   */
  private desired(runner: ObjectiveRunner, sync: SyncView): string | undefined {
    const { status, issue } = runner.state;
    const module = runner.state.modules.github as GitHubModule | undefined;
    const option = OPTION[status];
    if (
      !option ||
      (module?.shown === undefined &&
        !TERMINAL.includes(status) &&
        status !== "holding" &&
        sync.waitingForSlot(issue))
    )
      return undefined;
    return this.config.queue.options[option];
  }

  /**
   * Show the status on the card. The card is read first: Factory writes
   * only over what it last saw or wrote itself, never over someone else's
   * change (see `cardChanged`). The option being written is saved first, so
   * after a crash the card showing it still reads as Factory's own. A run
   * being withdrawn shows nothing: the operator's dequeue stands.
   */
  private show(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const issue = runner.state.issue;
    const option = this.desired(runner, sync);
    if (
      option === undefined ||
      withdrawingNow(runner.state) ||
      module.shown === option ||
      module.ceded === option ||
      this.changed.has(issue)
    )
      return;
    const github = () => runner.state.modules.github as GitHubModule;
    this.background(issue, `show:${issue}`, async (signal) => {
      const card = await this.display.get(github().itemId, signal);
      if (withdrawingNow(runner.state)) return;
      const { seen, writing } = github();
      if (
        seen !== undefined &&
        card.option !== seen &&
        card.option !== writing
      ) {
        if (this.cardChanged(runner, card.option, card.at, sync) === "requeued")
          this.changed.add(issue);
        return;
      }
      let at = card.at;
      if (card.option !== option) {
        runner.transact(() => {
          github().writing = option;
        });
        crashPoint("sync:show:before");
        at = await this.display.set(github().itemId, option, signal);
        crashPoint("sync:show:after");
        this.wroteAt.set(issue, this.now());
      }
      runner.transact(() => {
        const module = github();
        if (at) module.shownAt = at;
        else delete module.shownAt;
        module.shown = option;
        module.seen = option;
        delete module.writing;
        delete module.ceded;
      });
    });
  }

  /**
   * Post each open question once, with its answers. A comment shows the
   * short form `/factory <answer>` only while it is the one open question;
   * once another opens, it is edited to name its question. The comment's
   * GitHub time is saved on the hold (`shownAt`): an answer that names no
   * question is compared with it (engine.ts `answer`). A short form shown
   * before another question (`lastShownAt`) would be refused, so that
   * comment is edited to name its question too. A failure's comment
   * (cause `failure`) names the failed step and its evidence as well
   * (`failureLines`), unless progress comments are off. Text is redacted.
   */
  private ask(runner: ObjectiveRunner): void {
    // A run being withdrawn goes instead of asking (service.ts tick).
    if (runner.state.withdrawing) return;
    const issue = runner.state.issue;
    const holds = runner.state.holds;
    const others = holds.length > 1;
    const lastShownAt = Date.parse(runner.state.lastShownAt ?? "");
    for (const hold of holds) {
      const bound =
        others ||
        (hold.shortForm === true &&
          lastShownAt > Date.parse(hold.shownAt ?? ""));
      if (hold.shownAt !== undefined && (!hold.shortForm || !bound)) continue;
      this.background(
        issue,
        `ask:${issue}:${hold.id}`,
        async (signal) => {
          const marker = mark(issue, "hold", hold.id);
          const named = `--question ${hold.id}`;
          const answers = hold.options
            .map(
              (option) =>
                `- ${code(`/factory ${answerForm(option, bound ? named : undefined)}`)}${option.recommended ? " (recommended)" : ""}: ${prose(option.consequence)}`,
            )
            .join("\n");
          const about = hold.item
            ? ` It stops Work Item ${code(hold.item)} and the items that depend on it; other work goes on.`
            : "";
          const form = others
            ? " Other questions are open too, so the answer names this one."
            : bound
              ? " Another question was shown after this one, so the answer names this one."
              : ` While this is the only open question, the short form works; \`/factory <answer> ${named}\` always does.`;
          const secrets = this.config.secrets;
          const question = shownQuestion(
            hold.question,
            secrets,
            issue,
            this.compact.get(issue)?.has(hold.id)
              ? COMPACT_LIMIT
              : QUESTION_LIMIT,
          );
          const failed =
            hold.cause === "failure" && this.config.progress.enabled
              ? failureLines(hold, runner.state.retries[hold.step], secrets)
              : undefined;
          const opening = failed
            ? `${failed.title}\n\n${question}${failed.evidence}`
            : `**Factory needs you.** ${question}`;
          const comment = await this.github.upsertComment(
            issue,
            marker,
            questionComment(
              marker,
              opening,
              answers,
              `${about}${form}`,
              this.config.operators,
            ),
            "sync:ask",
            signal,
            new Date(Date.parse(hold.askedAt) - CLOCK_SKEW_MS).toISOString(),
          );
          runner.transact(() =>
            runner.shown(
              hold.id,
              comment.updated_at ?? comment.created_at,
              !bound,
              comment.html_url,
            ),
          );
        },
        true,
        (error) => this.compactAsk(issue, hold.id, error),
      );
    }
  }

  /**
   * A question comment GitHub refused (a 422 for its size, any lasting
   * 4xx), or that failed three times in a row other than transiently, is
   * written compact from then on (its question cut to COMPACT_LIMIT), so
   * a hold is never left unshown; it keeps retrying with its backoff,
   * since it is how the question is answered on GitHub.
   */
  private compactAsk(issue: number, hold: string, error: unknown): void {
    if (error instanceof TransientError) return;
    const key = `ask:${issue}:${hold}`;
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const refused =
      error instanceof GitHubError && error.status >= 400 && error.status < 500;
    if (!refused && failures < GIVE_UP_AFTER) return;
    this.failures.delete(key);
    const compact = this.compact.get(issue) ?? new Set<string>();
    if (compact.has(hold)) return;
    compact.add(hold);
    this.compact.set(issue, compact);
    this.log.write(issue, {
      event: "question-compacted",
      hold,
      failures,
      error: errorMessage(error),
    });
  }

  /**
   * Edit each closed question's comment in place to show how it closed
   * (`closedComment`): its heading no longer says Factory needs you, it
   * names the answer, who gave it and how, or why it closed without one,
   * and it mentions no one, so GitHub notifies nobody of the edit. Only a
   * comment Factory posted is edited (found by its marker), never posted:
   * a question closed before its comment was shown has none. The job
   * shares its question's key, so it never races the question's own post
   * or edit. A refusal writes it compact, as a question's comment; one
   * refused compact too is given up, and logged.
   */
  private closings(runner: ObjectiveRunner): void {
    const issue = runner.state.issue;
    for (const closed of unshownClosings(runner.state))
      this.background(
        issue,
        `ask:${issue}:${closed.id}`,
        async (signal) => {
          const marker = mark(issue, "hold", closed.id);
          await this.github.editComment(
            issue,
            marker,
            closedComment(marker, closed, {
              issue,
              secrets: this.config.secrets,
              compact: this.compact.get(issue)?.has(closed.id) === true,
            }),
            "sync:closed",
            signal,
            new Date(Date.parse(closed.askedAt) - CLOCK_SKEW_MS).toISOString(),
          );
          runner.transact(() => runner.closingShown(closed.id));
        },
        true,
        (error) => this.closingFailed(runner, closed.id, error),
      );
  }

  /** A closed question's edit failed: written compact, then given up (`closings`). */
  private closingFailed(
    runner: ObjectiveRunner,
    hold: string,
    error: unknown,
  ): void {
    const issue = runner.state.issue;
    if (!this.compact.get(issue)?.has(hold)) {
      this.compactAsk(issue, hold, error);
      return;
    }
    if (error instanceof TransientError) return;
    const key = `ask:${issue}:${hold}`;
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const refused =
      error instanceof GitHubError && error.status >= 400 && error.status < 500;
    if (!refused && failures < GIVE_UP_AFTER) return;
    this.failures.delete(key);
    runner.transact(() => runner.closingShown(hold));
    this.log.write(issue, {
      event: "closed-question-given-up",
      hold,
      failures,
      error: errorMessage(error),
    });
  }

  /**
   * The live status comment (progress.ts): one per run, posted once and
   * then edited in place, found by its marker. A background job renders it
   * (a render that throws backs off like a failed write) at most once
   * per STATUS_EVERY_MS and written only when its stable body changed (its
   * hash), or, while a step runs, every STATUS_REFRESH_MS so its ages stay
   * true. A finished Objective settles only once it shows the final status.
   * The comment list is read from the last write on (GitHub's `since` is
   * the edit time), or from the run's admission before the first.
   */
  private status(runner: ObjectiveRunner, sync: SyncView): void {
    const { state } = runner;
    const issue = state.issue;
    // A run being withdrawn shows the withdrawal; one cancelled meanwhile
    // shows its final status like any other.
    if (withdrawingNow(state)) {
      this.statusWithdrawn(runner);
      return;
    }
    const given = (state.modules.github as GitHubModule).statusGivenUp;
    // A resetting record shows nothing: its rebuild reads the run's comment.
    if (!this.config.progress.enabled || given || resetting(state)) return;
    const now = this.now();
    if (now - (this.statusTried.get(issue) ?? -Infinity) < STATUS_EVERY_MS)
      return;
    // Running or backing off; once a failed one's backoff ends it runs
    // again (`pending` stays true until it succeeds, so it can't gate this).
    if (this.jobs.held(`status:${issue}`)) return;
    this.statusTried.set(issue, now);
    this.background(
      issue,
      `status:${issue}`,
      async (signal) => {
        this.tally ??= new RunTally(sync.logs);
        const marker = mark(issue, "status", runOf(state));
        const view = statusOf(
          { kind: "ok", state },
          {
            issue,
            live: true,
            queue: sync.queue,
            waitsOn: sync.waitsOn(issue),
            lastEvent: null,
          },
        );
        const { plan: _plan, ...shown } = view;
        const { body, hash } = statusComment(
          marker,
          {
            view: shown,
            ...this.tally.read(issue, state.startedAt ?? ""),
            decisions: decisionsOf(state),
            ...(state.startedAt ? { startedAt: state.startedAt } : {}),
            record: statusRecordOf(state),
          },
          this.config.secrets,
          { questions: this.config.progress.includeQuestions },
          now,
        );
        const last = (state.modules.github as GitHubModule).status;
        const status = state.status;
        if (
          last?.hash === hash &&
          last.shown === status &&
          !(
            view.running.length &&
            now - Date.parse(last.at) >= STATUS_REFRESH_MS
          )
        )
          return;
        // The installation's hourly budget: over it, an edit waits, except
        // the one that shows a finished Objective's final status.
        this.statusEdits = this.statusEdits.filter(
          (at) => now - at < 60 * 60_000,
        );
        if (
          this.statusEdits.length >= STATUS_EDITS_PER_HOUR &&
          !TERMINAL.includes(status)
        )
          return;
        this.statusEdits.push(now);
        const comment = await this.github.upsertComment(
          issue,
          marker,
          body,
          "sync:status",
          signal,
          last ? skewed(last.at) : sinceRun(state),
        );
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).status = {
            hash,
            shown: status,
            at: comment.updated_at ?? comment.created_at,
          };
        });
      },
      true,
      (error) => this.givenUp(runner, "status", error),
    );
  }

  /**
   * A run being withdrawn: before the state goes, its live status comment
   * (if one was posted, and progress comments are on) is edited to a final
   * line, so nothing is left reading "checking", and each open question's
   * comment Factory posted is edited to say it no longer applies. Each is
   * found by its marker (Factory's own comments only), so after a crash
   * they are edited again; the service withdraws once this is shown
   * (`withdrawShown`).
   */
  private statusWithdrawn(runner: ObjectiveRunner): void {
    const { state } = runner;
    const issue = state.issue;
    const module = state.modules.github as GitHubModule;
    if (
      module.statusWithdrawn ||
      module.statusGivenUp ||
      this.jobs.held(`status:${issue}`)
    )
      return;
    this.background(
      issue,
      `status:${issue}`,
      async (signal) => {
        if (this.config.progress.enabled) {
          const marker = mark(issue, "status", runOf(state));
          await this.github.editComment(
            issue,
            marker,
            `${marker}\n${WITHDRAWN_LINE}`,
            "sync:status",
            signal,
            module.status ? skewed(module.status.at) : sinceRun(state),
          );
        }
        for (const hold of state.holds) {
          const marker = mark(issue, "hold", hold.id);
          await this.github.editComment(
            issue,
            marker,
            `${marker}\n${WITHDRAWN_QUESTION}`,
            "sync:ask",
            signal,
            new Date(Date.parse(hold.askedAt) - CLOCK_SKEW_MS).toISOString(),
          );
        }
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).statusWithdrawn = true;
        });
      },
      true,
      (error) => this.givenUp(runner, "status", error),
    );
  }

  /**
   * Whether a run being withdrawn may go: its comments show the
   * withdrawal, or they were given up, or the issue is gone.
   */
  withdrawShown(state: ObjectiveState): boolean {
    const module = state.modules.github as GitHubModule | undefined;
    return (
      !module ||
      module.statusGivenUp === true ||
      module.statusWithdrawn === true ||
      this.gone.has(state.issue)
    );
  }

  /**
   * The Work Item issues (tracking.ts): projected from the plan in force,
   * each item's state and its telemetry from the run log (`telemetry`) by
   * a background job, at most once per
   * STATUS_EVERY_MS while the Objective runs and at once when it has
   * finished, and only when a write is due; a pass that failed runs again
   * once its backoff ends. A finished Objective settles
   * only once every item issue shows its end and is closed, or GitHub
   * refused that issue's close (it is never counted closed).
   */
  private track(runner: ObjectiveRunner, sync?: SyncView): void {
    const { state } = runner;
    const issue = state.issue;
    const module = state.modules.github as GitHubModule;
    if (
      !this.config.tracking.enabled ||
      state.withdrawing ||
      module.trackingGivenUp
    )
      return;
    const now = this.now();
    if (
      !TERMINAL.includes(state.status) &&
      now - (this.trackTried.get(issue) ?? -Infinity) < STATUS_EVERY_MS
    )
      return;
    if (this.jobs.held(`track:${issue}`)) return;
    const telemetry = this.telemetry(state, sync);
    if (!trackingDue(state, now, telemetry)) return;
    this.trackTried.set(issue, now);
    this.background(
      issue,
      `track:${issue}`,
      (signal) =>
        track({
          github: this.github,
          state: () => runner.state,
          issueType: this.config.tracking.issueType,
          ...(telemetry ? { telemetry } : {}),
          save: (change) =>
            runner.transact(() => {
              const github = runner.state.modules.github as GitHubModule;
              github.tracking ??= { items: {} };
              change(github.tracking);
            }),
          log: (event) => this.log.write(issue, event),
          signal,
          cardStatus: {
            project: this.config.queue.projectId,
            set: async (item, option, signal) => {
              await this.display.set(
                item,
                this.config.queue.options[option],
                signal,
              );
            },
          },
        }),
      true,
      (error) => this.givenUp(runner, "track", error),
    );
  }

  /**
   * A status or tracking job failed. GitHub's transient errors (network,
   * 5xx, rate limits, which wait for their reset) retry on and never count
   * here; a lasting refusal (a 4xx that isn't a rate limit), or anything
   * else three times in a row (a render that keeps throwing), gives it up
   * for this run, so it never holds back settling. A `TryAgain` (a
   * Project's conflict, or "Something went wrong", which GitHub also
   * answers for its timeouts and its own bugs) counts like anything else
   * once its own tries are spent (queue.ts `projectWrite`): one that
   * keeps coming never holds settling back either. Tracking handles a
   * refusal on one item's issue itself, so one reaching here is the
   * repository's (issues off, no access, gone).
   */
  private givenUp(
    runner: ObjectiveRunner,
    job: "status" | "track" | "cancel",
    error: unknown,
  ): void {
    if (error instanceof TransientError && !(error instanceof TryAgain)) return;
    const issue = runner.state.issue;
    const key = `${job}:${issue}`;
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const refused =
      error instanceof GitHubError && error.status >= 400 && error.status < 500;
    if (!refused && failures < GIVE_UP_AFTER) return;
    this.failures.delete(key);
    runner.transact(() => {
      const github = runner.state.modules.github as GitHubModule;
      if (job === "status") github.statusGivenUp = true;
      else if (job === "track") github.trackingGivenUp = true;
      else github.cancelShown = true;
    });
    this.log.write(issue, {
      event:
        job === "status"
          ? "status-given-up"
          : job === "track"
            ? "tracking-given-up"
            : "cancel-comment-given-up",
      failures,
      error: errorMessage(error),
    });
  }

  /**
   * A wait shown on the issue: one status note, edited in place, once an
   * unknown transient cause has lasted `noteAfterMs`; one reminder once a
   * human gate (an approval, a required review) has lasted `remindAfterMs`.
   * Neither for a step an open question or a wait on another Objective's
   * paths stops (engine.ts `blocked`): it waits on that, and the engine
   * pauses its clocks until it ends. Neither while progress comments are
   * off.
   */
  private note(runner: ObjectiveRunner, module: GitHubModule): void {
    if (!this.config.progress.enabled) return;
    const now = this.now();
    const issue = runner.state.issue;
    const waits = Object.entries(runner.state.retries)
      .filter(([step, retry]) => retry.count === 0 && !runner.blocked(step))
      .sort(([, a], [, b]) => a.since.localeCompare(b.since));
    const transient = waits.find(
      ([, retry]) =>
        !retry.wait && now - Date.parse(retry.since) >= this.limits.noteAfterMs,
    );
    if (transient && module.noted !== `${transient[0]}@${transient[1].since}`) {
      const [step, retry] = transient;
      const id = `${step}@${retry.since}`;
      this.background(issue, `note:${issue}`, async (signal) => {
        const marker = mark(issue, "waiting", "note");
        await this.github.upsertComment(
          issue,
          marker,
          `${marker}\n**Factory is waiting.** Step ${code(step)} has been retrying since ${code(displayTime(retry.since))}. It began with: ${excerpt(retry.cause ?? retry.lastError, this.config.secrets, 500)}\n\nLast error: ${excerpt(retry.lastError, this.config.secrets, 500)}\n\nFactory keeps retrying on its own, and asks here if the wait goes on.`,
          "sync:note",
          signal,
        );
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).noted = id;
        });
      });
    }
    const gate = waits.find(
      ([, retry]) =>
        retry.wait?.kind === "gate" &&
        now - Date.parse(retry.since) >= this.limits.remindAfterMs,
    );
    if (gate && module.reminded !== `${gate[0]}@${gate[1].since}`) {
      const [step, retry] = gate;
      const id = `${step}@${retry.since}`;
      const what = retry.wait?.kind === "gate" ? retry.wait.gate : step;
      this.background(issue, `remind:${issue}`, async (signal) => {
        const marker = mark(issue, "remind", id);
        await this.github.ensureComment(
          issue,
          marker,
          `${marker}\n**Factory is still waiting on ${prose(redact(what, this.config.secrets))}**, since ${code(retry.since)}. It carries on by itself once that is done.`,
          "sync:remind",
          signal,
          skewed(retry.since),
        );
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).reminded = id;
        });
      });
    }
  }

  /**
   * One reminder per open question once it has been open `remindAfterMs`
   * (24 h; FACTORY_REMIND_MS in tests), linking its question comment. It
   * is keyed by the hold's id, which carries its step and `askedAt`, so a
   * restart never posts it twice and a question asked again is a new one
   * with its own day. Only a question already shown on the issue is
   * reminded of, and none while progress comments are off.
   */
  private remind(runner: ObjectiveRunner, module: GitHubModule): void {
    if (!this.config.progress.enabled || runner.state.withdrawing) return;
    const now = this.now();
    const issue = runner.state.issue;
    for (const hold of runner.state.holds) {
      if (
        hold.shownAt === undefined ||
        module.remindedHolds?.includes(hold.id) ||
        now - Date.parse(hold.askedAt) < this.limits.remindAfterMs
      )
        continue;
      this.background(issue, `remind:${issue}:${hold.id}`, async (signal) => {
        const since = skewed(hold.askedAt);
        const asked = await this.github.markedComment(
          issue,
          mark(issue, "hold", hold.id),
          since,
          signal,
        );
        const marker = mark(issue, "remind", `hold:${hold.id}`);
        const first = redact(hold.question, this.config.secrets)
          .split("\n")[0]!
          .trim();
        const about = first.length > 300 ? `${first.slice(0, 299)}…` : first;
        await this.github.ensureComment(
          issue,
          marker,
          `${marker}\n**Factory still needs you.** Question ${code(hold.id)}${hold.item ? ` (Work Item ${code(hold.item)})` : ""} has been open since ${code(hold.askedAt)}: ${prose(about)}\n\nIts answers are in ${asked?.html_url ? `[its comment](${asked.html_url})` : "its comment above"}; ${code(`factory status ${issue}`)} lists them too. This is the only reminder.`,
          "sync:remind",
          signal,
          since,
        );
        runner.transact(() => {
          const github = runner.state.modules.github as GitHubModule;
          const open = new Set(runner.state.holds.map((h) => h.id));
          github.remindedHolds = [
            ...(github.remindedHolds ?? []).filter((id) => open.has(id)),
            hold.id,
          ];
        });
      });
    }
  }

  /**
   * A cancelled run's one closing comment, once its cleanup has settled:
   * who cancelled it (the login of a `/factory cancel` comment's author; a
   * CLI cancel is "the operator", never the host's user name), or its
   * deadline, and what the cleanup left when it settled without finishing
   * (engine.ts `Left`). Keyed by the run, so a restart never posts it
   * twice; a finished Objective settles once it is posted, or GitHub
   * refused it (`givenUp`). None for a withdrawn run or while progress
   * comments are off.
   */
  private cancelled(runner: ObjectiveRunner, module: GitHubModule): void {
    const { state } = runner;
    const cleanup = state.done[CANCEL_CLEANUP] as Left | true | undefined;
    if (
      !this.config.progress.enabled ||
      state.status !== "cancelled" ||
      state.withdrawing ||
      module.cancelShown ||
      cleanup === undefined
    )
      return;
    const left = cleanup === true ? undefined : cleanup;
    const issue = state.issue;
    this.background(
      issue,
      `cancel:${issue}`,
      async (signal) => {
        const marker = mark(issue, "cancelled", runOf(state));
        await this.github.ensureComment(
          issue,
          marker,
          cancelComment(marker, state, left, this.config),
          "sync:cancel",
          signal,
          sinceRun(state),
        );
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).cancelShown = true;
        });
      },
      true,
      (error) => this.givenUp(runner, "cancel", error),
    );
  }

  /**
   * An unreadable state holds like any other Objective: its question is
   * posted on the issue, its card shows "Needs you", and `/factory cancel`
   * is read from the comments. Nothing is saved for it until it is cancelled.
   */
  private unreadable(
    issue: number,
    entry: UnreadableObjective,
    due: boolean,
    sync: SyncView,
  ): void {
    const item = this.view.find((i) => i.issue === issue);
    // Comments are read once the question is shown, from its time on.
    if (!entry.github && item)
      entry.github = { itemId: item.itemId, commentsSince: "" };
    const module = entry.github;
    if (!module) return;
    const option = this.config.queue.options.holding;
    if (module.shown !== option)
      this.background(issue, `show:${issue}`, async (signal) => {
        crashPoint("sync:show:before");
        await this.display.set(module.itemId, option, signal);
        crashPoint("sync:show:after");
        module.shown = option;
      });
    if (!module.askedUnreadable)
      this.background(issue, `ask:${issue}`, async (signal) => {
        // This incident's question: an earlier incident's question, and
        // the answers to it, never count for this one.
        const marker = mark(issue, "hold", `unreadable:${entry.incident}`);
        const question = await this.github.ensureComment(
          issue,
          marker,
          `${marker}\n**Factory needs you.** Factory can't read this Objective's state (${entry.error.slice(0, 500)}). Reply with ${entry.setAside ? "`/factory retry` (recommended) to read it again and run on once its cause is fixed, `/factory reset`" : "`/factory reset` (recommended)"} to rebuild it from its plan comment and PRs on GitHub, or \`/factory cancel\` to start over from a cancelled record (queue it again to run it again).${mentions(this.config.operators)}`,
          "sync:ask",
          signal,
        );
        module.commentsSince = question.created_at;
        module.askedUnreadable = true;
      });
    else if (due)
      this.readComments(
        issue,
        module,
        () => true,
        sync,
        (change) => change(module),
      );
  }

  /**
   * Read new `/factory` comments and turn each into a request. A comment is
   * skipped only on a definite answer about its author (no such user, or
   * no write access). One whose author's access can't be read now waits in
   * a bounded list, tried again with backoff on later polls; the cursor
   * still moves past it, so it never blocks the comments after it.
   */
  private readComments(
    issue: number,
    module: GitHubModule,
    holding: () => boolean,
    sync: SyncView,
    save: (change: (module: GitHubModule) => void) => void,
  ): void {
    this.background(issue, `comments:${issue}`, async (signal) => {
      const since = module.commentsSince;
      const comments = await this.github.comments(issue, since, signal);
      const waiting = module.unchecked ?? [];
      const now = this.now();
      let latest = since;
      const fresh: UncheckedComment[] = [];
      for (const comment of comments) {
        // Created before the cursor: read already, or from before this run
        // or its question, and edited since.
        if (Date.parse(comment.created_at) < Date.parse(since)) continue;
        if (comment.created_at > latest) latest = comment.created_at;
        if (
          !comment.user ||
          !COMMAND.test(comment.body.trim()) ||
          waiting.some((w) => w.id === comment.id)
        )
          continue;
        fresh.push({
          id: comment.id,
          login: comment.user.login,
          body: comment.body.trim().slice(0, 20_000),
          createdAt: comment.created_at,
          ...(comment.html_url ? { url: comment.html_url } : {}),
          failures: 0,
          nextAt: new Date(now).toISOString(),
        });
      }
      const unchecked: UncheckedComment[] = [];
      for (const comment of [...waiting, ...fresh]) {
        if (Date.parse(comment.nextAt) > now) {
          unchecked.push(comment);
          continue;
        }
        let allowed: boolean;
        try {
          allowed = await this.github.canWrite(comment.login, signal);
        } catch (error) {
          const failures = comment.failures + 1;
          // A rate limit waits for its reset, never less.
          unchecked.push({
            ...comment,
            failures,
            nextAt: new Date(
              now +
                Math.max(
                  backoffMs(failures, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
                  limitMs(error) ?? 0,
                ),
            ).toISOString(),
          });
          this.log.write(issue, {
            event: "comment-unchecked",
            comment: comment.id,
            login: comment.login,
            failures,
            error: errorMessage(error),
          });
          continue;
        }
        if (!allowed) {
          this.log.write(issue, {
            event: "comment-ignored",
            comment: comment.id,
            login: comment.login,
          });
          continue;
        }
        this.request(issue, comment, holding(), sync);
      }
      for (const dropped of unchecked.slice(0, -MAX_UNCHECKED))
        this.log.write(issue, {
          event: "comment-dropped",
          comment: dropped.id,
          login: dropped.login,
        });
      const kept = unchecked.slice(-MAX_UNCHECKED);
      if (latest !== since || JSON.stringify(kept) !== JSON.stringify(waiting))
        save((github) => {
          github.commentsSince = latest;
          if (kept.length) github.unchecked = kept;
          else delete github.unchecked;
        });
    });
  }

  /** A `/factory` comment from a writer, as a request; its id makes writing it twice harmless. */
  private request(
    issue: number,
    comment: UncheckedComment,
    holding: boolean,
    sync: SyncView,
  ): void {
    const request = commentRequest(issue, comment, holding);
    if (request)
      writeRequest(
        sync.requestsDir,
        request,
        comment.login,
        `comment-${comment.id}`,
        "github",
        comment.url ? { url: comment.url } : {},
      );
  }

  /** Reply to each `/factory` comment with what happened. */
  private reply(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const issue = runner.state.issue;
    for (const request of unreplied(runner.state, module)) {
      this.background(issue, `reply:${issue}:${request.id}`, async (signal) => {
        const marker = mark(issue, "reply", request.id);
        const message = sync.result(request.id) ?? request.message;
        await this.github.ensureComment(
          issue,
          marker,
          `${marker}\n${message === "ok" ? "Factory: done." : `Factory: ${message}`}`,
          "sync:reply",
          signal,
          skewed(module.commentsSince),
        );
        runner.transact(() => {
          const github = runner.state.modules.github as GitHubModule;
          github.replied = [...(github.replied ?? []), request.id].slice(-50);
        });
      });
    }
  }

  /** GitHub no longer has the issue here: nothing more is written to it. */
  private lose(issue: number, job: string, status?: number): void {
    if (this.gone.has(issue)) return;
    this.gone.add(issue);
    // A gone issue has no card to take out of the queue.
    if (this.unqueuing.delete(issue)) this.jobs.forget(`unrun:${issue}`);
    this.log.write(issue, {
      event: "issue-gone",
      job,
      ...(status ? { status } : {}),
    });
  }

  /**
   * Read the issue itself (redirects are answers, never followed); lose it
   * only on 404, 410 or a redirect while the repository still answers
   * under its configured name. A moved repository (RepositoryMoved, from
   * the client's identity check) never makes an issue gone.
   */
  private async confirmGone(issue: number, job: string): Promise<void> {
    if (this.github.moved) return;
    try {
      await this.github.issue(issue);
    } catch (error) {
      if (issueGone(error) && !this.github.moved)
        this.lose(issue, job, error.status);
    }
  }

  /**
   * Run `job` for Objective `issue` (0: the installation's own) unless it
   * is running or backing off after a failure (jobs.ts). A sub-resource's
   * 404 (comments, a card) can be transient or a permission gap: the issue
   * is gone only if a direct read of it also says so; otherwise the job
   * retries with its backoff.
   */
  private background(
    issue: number,
    key: string,
    job: (signal: AbortSignal) => Promise<void>,
    backoff = true,
    failed?: (error: unknown) => void,
  ): void {
    const counted = newTransport();
    if (this.transportFailed.has(key)) counted.retries = 1;
    const started = this.now();
    const ended = (ok: boolean) => {
      if (ok) this.transportFailed.delete(key);
      else this.transportFailed.set(key, issue);
      // Each failed, re-sent or rate-limited request, unthrottled: one bad request stays traceable.
      for (const event of requestEvents(key, counted))
        this.log.write(issue, event);
      this.countTransport(issue, key, counted, this.now() - started, !ok);
    };
    this.jobs.run(
      issue,
      key,
      (signal) => transport.run(counted, () => job(signal)),
      {
        backoff,
        done: () => {
          ended(true);
          if (failed) this.failures.delete(key);
        },
        failed: async (error) => {
          ended(false);
          failed?.(error);
          if (issue && issueGone(error)) await this.confirmGone(issue, key);
        },
      },
    );
  }

  /**
   * Add one job run's GitHub requests to its key's tally, and write the
   * tally as a `github-call` event at most once a minute per key (at once
   * after a failed run), and when its Objective is forgotten: counts, never
   * bodies.
   */
  private countTransport(
    issue: number,
    key: string,
    run: Transport,
    ms: number,
    failed: boolean,
  ): void {
    const tally = this.transportTally.get(key) ?? {
      ...newTransport(),
      issue,
      since: this.now(),
      runs: 0,
      ms: 0,
    };
    tally.runs += 1;
    tally.ms += ms;
    tally.calls += run.calls;
    tally.retries += run.retries;
    tally.rateLimited += run.rateLimited;
    tally.failed += run.failed;
    tally.bytes += run.bytes;
    tally.requestMs += run.requestMs;
    this.transportTally.set(key, tally);
    if (failed || this.now() - tally.since >= TRANSPORT_EVERY_MS)
      this.writeTransport(key);
  }

  /** The service stops: abort the sync's jobs and wait until each has ended. */
  drain(): Promise<void> {
    return this.jobs.drain();
  }

  /** Write every unwritten `github-call` tally: at the service's stop, before its run ends. */
  flushTransport(): void {
    for (const key of [...this.transportTally.keys()]) this.writeTransport(key);
  }

  private writeTransport(key: string): void {
    const tally = this.transportTally.get(key);
    this.transportTally.delete(key);
    if (!tally?.calls) return;
    this.log.write(tally.issue, {
      event: "github-call",
      job: key,
      runs: tally.runs,
      ms: tally.ms,
      ...callCounts(tally),
    });
  }
}

/** The `job` of requests outside steps and sync jobs. */
const AMBIENT = "service";

/** The most often one job key's `github-call` tally is written. */
const TRANSPORT_EVERY_MS = 60_000;

/** A question's most in a comment: whole up to here, then cut with where the rest is. */
const QUESTION_LIMIT = 20_000;
/** Each error line of a failure's evidence. */
const EVIDENCE_LIMIT = 1_000;

/** The end of a question kept whole when its middle is cut: the engine appends its notes (the switch answers, the deadline) there. */
const QUESTION_TAIL = 4_000;
/** A compact question comment, after GitHub refused the full one: its question is cut to this. */
const COMPACT_LIMIT = 4_000;

/**
 * Untrusted error text in a comment: redacted with `secrets`, then cut to
 * `limit` characters, then one code span, so the cut never splits a
 * secret's redaction or an escape.
 */
function excerpt(
  value: string,
  secrets: readonly string[],
  limit: number,
): string {
  const shown = redact(value, secrets);
  return code(shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown);
}

/**
 * A question's comment: its opening (the question, a failure's evidence),
 * its answers and how to give them (`notes`), then the operators'
 * mentions, so GitHub notifies them of a new hold. An edit (the bound
 * form) keeps the same mentions.
 */
export function questionComment(
  marker: string,
  opening: string,
  answers: string,
  notes: string,
  operators: readonly string[],
): string {
  return `${marker}\n${opening}\n\nReply with one of:\n${answers}\n\nAdd text after the answer to explain it.${notes}${mentions(operators)}`;
}

/** The most of an answer's text a closed question's comment quotes. */
const GUIDANCE_LIMIT = 500;

/**
 * A closed question's comment (github-sync `closings`): the closing in
 * place of "Factory needs you" or "Factory stopped" (`closingLine`), the
 * question as it was asked, redacted, escaped and cut as its question
 * comment was (`shownQuestion`, compact when that comment was), and the
 * answers it offered. It mentions no one.
 */
export function closedComment(
  marker: string,
  closed: ClosedHold,
  options: { issue: number; secrets: readonly string[]; compact?: boolean },
): string {
  const { issue, secrets } = options;
  // Its summary (kept whole) once the question is gone: cut the same way,
  // after redaction.
  const question = shownQuestion(
    closed.question ?? closed.summary,
    secrets,
    issue,
    options.compact ? COMPACT_LIMIT : QUESTION_LIMIT,
  );
  const item = closed.item ? ` of Work Item ${code(closed.item)}` : "";
  const about =
    closed.cause === "failure"
      ? `Step ${code(closed.step)}${item} had failed, and asked:`
      : `It asked${closed.item ? ` about Work Item ${code(closed.item)}` : ""}:`;
  const offered = closed.options?.length
    ? `\n\nIts answers were ${closed.options.map((option) => code(answerForm(option))).join(", ")}.`
    : "";
  return `${marker}\n${closingLine(closed.closed, secrets)}\n\n${about}\n\n${question}${offered}\n\nNothing waits on this question now; ${code(`factory status ${issue}`)} shows what Factory is doing.`;
}

/**
 * How a question closed, as its comment's first paragraph: the answer
 * with its argument, who gave it (a comment's author by login in a code
 * span, so no one is mentioned; a CLI answer as "the operator", never the
 * host's user name; with `as` when someone answered on their behalf), how
 * (a link to the `/factory` comment, or the CLI), when, and a short,
 * redacted excerpt of its text. A question closed without an answer says
 * why instead.
 */
export function closingLine(
  closing: HoldClosing,
  secrets: readonly string[],
): string {
  const at = ` at ${code(displayTime(closing.at))}`;
  const who = answeredBy(closing, secrets);
  const without = (why: string) => `**Closed without an answer:** ${why}${at}.`;
  switch (closing.how) {
    case "answered": {
      const answer = [closing.answer ?? "", closing.arg]
        .filter((part) => part !== undefined && part !== "")
        .join(" ");
      const text = closing.parts?.length
        ? `\n\n${answerParts(closing.parts, secrets)}`
        : closing.text
          ? `\n\n> ${guidance(closing.text, secrets)}`
          : "";
      return `**Answered** ${code(`/factory ${answer}`)} by ${who}${at}.${text}`;
    }
    case "cancelled":
      return without(
        closing.by === DEADLINE
          ? "the Objective's deadline passed, and Factory cancelled it"
          : `${who} cancelled the Objective`,
      );
    case "superseded":
      return without(
        `Factory asked a newer question in its place${closing.next ? ` (${code(closing.next)})` : ""}`,
      );
    case "reset":
      return without(
        `${code("factory reset")} rebuilt this Objective's state, which no longer asks it`,
      );
    case "cleared":
      return without("a repair cleared the work it asked about");
    case "replanned":
      return without("a replan cleared the work it asked about");
    case "gate-cleared":
      return without("what it waited on was done, so Factory went on");
    case "moved-on":
      return without(
        "its step stopped waiting on what it asked about for another reason, so it no longer applies",
      );
    case "asked-again":
      return without(
        "the configuration changed again after it was asked, so Factory asks again with the changes as they are now",
      );
    case "declined":
      return without(
        `${who} declined the discovery it asked about (${code("factory decline-discovery")})`,
      );
  }
}

/** An answer's text as one quoted line: redacted, escaped, then cut to GUIDANCE_LIMIT. */
/**
 * The answers one answer gave at once (`HoldClosing.parts`), each shown
 * (#2171): those with the same text on one line, then that text, redacted
 * and cut as an answer's is.
 */
function answerParts(
  parts: readonly AnswerPart[],
  secrets: readonly string[],
): string {
  const groups: { forms: string[]; text?: string }[] = [];
  for (const part of parts) {
    const form = code(`${part.answer} ${part.arg}`);
    const group = groups.find((entry) => entry.text === part.text);
    if (group) group.forms.push(form);
    else
      groups.push({
        forms: [form],
        ...(part.text !== undefined ? { text: part.text } : {}),
      });
  }
  return `It gave:\n${groups
    .map(
      (group) =>
        `- ${group.forms.join(", ")}${group.text ? `: ${guidance(group.text, secrets)}` : ""}`,
    )
    .join("\n")}`;
}

function guidance(text: string, secrets: readonly string[]): string {
  const line = prose(redact(text, secrets).replace(/\s+/g, " ").trim());
  if (line.length <= GUIDANCE_LIMIT) return line;
  const cut = entitySafe(line, GUIDANCE_LIMIT - 1, "end");
  return `${line.slice(0, cut)}… (the run log keeps the rest)`;
}

/**
 * The cancel comment: when and why the Objective was cancelled, what its
 * cleanup left, and the operators' mentions.
 */
export function cancelComment(
  marker: string,
  state: Pick<ObjectiveState, "ended" | "deadline">,
  left: Left | undefined,
  config: Pick<CoreConfig, "secrets" | "operators">,
): string {
  const ended = state.ended;
  const why =
    ended?.by === DEADLINE
      ? `its deadline${state.deadline ? `, ${code(state.deadline)},` : ""} passed`
      : ended?.source === "github" && ended.by
        ? `${prose(ended.by)} cancelled it`
        : "the operator cancelled it";
  return `${marker}\n**Factory cancelled this Objective**${ended ? ` at ${code(ended.at)}` : ""}: ${why}. ${left ? `Its cleanup stopped after ${left.failures} tries, and left what it couldn't do: ${excerpt(left.left, config.secrets, 1500)} Close or delete those by hand.` : "Its open pull requests are closed and the issue is closed as not planned."} What merged stays merged. Queue it again to run it from a new plan.${mentions(config.operators)}`;
}

/**
 * A question for a comment: redacted, escaped (markdown.ts `prose`), and
 * only then cut to `limit` characters, so the limit holds for what GitHub
 * gets. A long question loses its middle, never its end, where the
 * engine's notes are, and a cut never splits an escape (`&…;`).
 */
function shownQuestion(
  question: string,
  secrets: readonly string[],
  issue: number,
  limit: number,
): string {
  const text = prose(redact(question, secrets));
  if (text.length <= limit) return text;
  const gap = `\n\n… (cut to fit a comment; ${code(`factory status ${issue}`)} shows it all) …\n\n`;
  const tail = Math.min(QUESTION_TAIL, Math.floor(limit / 2));
  const head = entitySafe(text, limit - tail - gap.length, "end");
  const end = entitySafe(text, text.length - tail, "start");
  return `${text.slice(0, head)}${gap}${text.slice(end)}`;
}

/**
 * A cut position in escaped text moved off any `&…;` escape it falls
 * inside: back to its `&` when it ends the head, past its `;` when it
 * starts the tail.
 */
function entitySafe(text: string, at: number, side: "end" | "start"): number {
  const amp = text.lastIndexOf("&", at - 1);
  if (amp < 0 || at - amp > 6) return at;
  const semi = text.indexOf(";", amp);
  if (semi < 0 || semi < at) return at;
  return side === "end" ? amp : semi + 1;
}

/**
 * A failure's comment (a hold with the cause `failure`): a title naming
 * the failed step and its Work Item, and the evidence the engine kept
 * for the step (`retries`: its run of errors, first and last), redacted
 * and cut to EVIDENCE_LIMIT each. The question itself says what failed.
 */
function failureLines(
  hold: Hold,
  retry: Retry | undefined,
  secrets: readonly string[],
): { title: string; evidence: string } {
  const item = hold.item ? ` of Work Item ${code(hold.item)}` : "";
  const title = `**Factory stopped: step ${code(hold.step)}${item} failed.** It can't succeed as it is, so it waits for your answer; nothing else it stops runs until then.`;
  if (!retry?.count) return { title, evidence: "" };
  const line = (value: string) => excerpt(value, secrets, EVIDENCE_LIMIT);
  const first = retry.cause ?? retry.lastError;
  const evidence = [
    "",
    "",
    "**Evidence**",
    `- ${retry.count} ${retry.count === 1 ? "error" : "errors in a row"} before it asked, since ${code(retry.since)}.`,
    ...(first !== retry.lastError ? [`- First: ${line(first)}`] : []),
    `- Last: ${line(retry.lastError)}`,
  ].join("\n");
  return { title, evidence };
}

/**
 * Where a read for a comment due at `since` starts: a little before, for
 * clock skew between this host and GitHub. An unreadable state's cursor is
 * empty until its question is shown: then every comment is read.
 */
function skewed(since: string): string | undefined {
  const at = Date.parse(since);
  return Number.isFinite(at)
    ? new Date(at - CLOCK_SKEW_MS).toISOString()
    : undefined;
}

/**
 * How long a failure says to wait before GitHub is asked again: a rate
 * limit's reset (or a request it held back), in ms; undefined for anything
 * else, which waits its backoff.
 */
function limitMs(error: unknown): number | undefined {
  return error instanceof TransientError && error.limited
    ? (error.retryAfterMs ?? 0)
    : undefined;
}

/** Requests from comments that have no reply yet. */
function unreplied(
  state: ObjectiveState,
  module: GitHubModule,
): { id: string; message: string }[] {
  return state.appliedRequests.filter(
    (r) =>
      r.id.startsWith("comment-") && !(module.replied ?? []).includes(r.id),
  );
}

/**
 * Whether a finished Objective's card is a re-queue: it reads queued, its
 * final option is shown (`finalShown`), and it was set to queued after the
 * queue that started this run (`queuedAt`, by GitHub's clock), so a stale
 * read of that first queue never runs a finished or cancelled run again.
 */
export function requeued(
  item: QueueItem,
  state: ObjectiveState,
  config: CoreConfig,
): boolean {
  const module = state.modules.github as GitHubModule | undefined;
  const since = Date.parse(module?.queuedAt ?? "");
  return (
    item.option === config.queue.options.queued &&
    finalShown(state, config) &&
    (!Number.isFinite(since) || Date.parse(item.optionAt ?? "") > since)
  );
}

/** Dequeued and not finished: it shows nothing but the withdrawal. */
function withdrawingNow(state: ObjectiveState): boolean {
  return state.withdrawing === true && !TERMINAL.includes(state.status);
}

/**
 * Whether a finished Objective's card shows its final option (Factory
 * wrote it, or wrote over nothing because someone else's change stood):
 * from then on a card that reads queued is the operator's re-queue.
 */
export function finalShown(state: ObjectiveState, config: CoreConfig): boolean {
  const module = state.modules.github as GitHubModule | undefined;
  if (!module) return true;
  const option = OPTION[state.status];
  return (
    TERMINAL.includes(state.status) &&
    option !== undefined &&
    [module.shown, module.ceded].includes(config.queue.options[option])
  );
}

/** Why a `factory run` request isn't admitted. */
function runRefusal(
  outcome: "no_such_issue" | "issue_closed" | "dequeued",
  issue: number,
  repository: string,
): RequestResult {
  return outcome === "dequeued"
    ? refused(
        "superseded",
        `#${issue}'s card was moved out of queued after this run was asked for, so it isn't admitted; queue it again, or factory run ${issue}.`,
      )
    : outcome === "issue_closed"
      ? refused(
          outcome,
          `#${issue} is closed and Factory never ran it; reopen it, then factory run ${issue} again.`,
        )
      : refused(outcome, `${repository} has no issue #${issue}.`);
}
