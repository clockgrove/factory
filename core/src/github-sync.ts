import type { CoreConfig, QueueOption } from "./config.js";
import { crashPoint } from "./crash.js";
import { DEADLINE, type EngineLimits, type ObjectiveRunner } from "./engine.js";
import {
  type GitHub,
  GitHubError,
  issueGone,
  TransientError,
  type Transport,
  transport,
} from "./github.js";
import { backoffMs, Jobs } from "./jobs.js";
import { type RunLog, redact } from "./log.js";
import { code, mark, prose } from "./markdown.js";
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
import { type RequestResult, refused, writeRequest } from "./requests.js";
import type {
  Hold,
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
   * stale read after a dequeue never admits the issue again (`withdrawnAt`),
   * and `reset` tells this run's plan comment from an earlier run's.
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
  /** Open questions whose 24 h reminder is posted, by hold id (its step and `askedAt`). */
  remindedHolds?: string[];
  /** A cancelled run's closing comment is posted, or GitHub refused it: it counts as shown. */
  cancelShown?: boolean;
  /** `/factory` comments whose author's access couldn't be read yet, oldest first. */
  unchecked?: UncheckedComment[];
  /** The live status comment's last write: its stable body's hash, the status it showed, and its GitHub time. */
  status?: { hash: string; shown: ObjectiveStatus; at: string };
  /** This run's live status comment can't be written (a lasting refusal or render failure): it counts as shown. */
  statusGivenUp?: boolean;
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
  failures: number;
  nextAt: string;
}

/** An Objective whose state file can't be read: it holds, with `cancel`. */
export interface UnreadableObjective {
  error: string;
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
  /** Start (or start again) an Objective seen queued; the service decides whether it may. */
  admit(issue: number, github: GitHubModule): void;
  /**
   * Withdraw an Objective dequeued before it started: now, or (`pending`)
   * once its running check or a re-run's cleanup ends; false when it has
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
/** Status or tracking job failures in a row, other than GitHub's transient errors, before it is given up. */
const GIVE_UP_AFTER = 3;

/** A sync job that failed waits this long, doubling, up to MAX_BACKOFF_MS. */
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** A sync job past this is aborted and counts as failed. */
const DEADLINE_MS = 10 * 60_000;
/** Comments kept waiting for their author's access to be read, per Objective. */
const MAX_UNCHECKED = 20;
const COMMAND = /^\/factory\s+(\S+)(?:\s+([\s\S]*))?$/;
/**
 * The options right after the answer, before its text: `--question ID`
 * names the hold it answers, and each `--review-artifacts N` a selector a
 * `revalidate` captures.
 */
const ANSWER_OPTION =
  /^--(question|review-artifacts)\s+(\S+)(?:\s+([\s\S]*))?$/;

/**
 * GitHub is input and display, never a precondition: every call here runs in
 * the background, and nothing here can fail a run. A failed job is logged
 * and tried again after a backoff of its own (per job and Objective, capped
 * at ten minutes; jobs.ts), and one past its ten-minute deadline is
 * aborted and counts as failed, so one Objective's bad card or locked issue never spends
 * the rate limit the others need. A finished Objective stays until its
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
   * Withdrawn runs' last queued time, by GitHub's clock: a card that still
   * reads queued from then (a read that began before the dequeue) is never
   * a new queue. Only a later queue admits the issue again.
   */
  private readonly withdrawnAt = new Map<number, number>();
  /** Known issues GitHub no longer has: left out of later reads. */
  private readonly gone = new Set<number>();
  private lastPoll = 0;
  /**
   * `factory run` cards queued and not yet admitted, with how to answer
   * their request when the operator dequeues them first: read by number
   * until then.
   */
  private readonly queuing = new Map<number, (result: RequestResult) => void>();
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
  ) {
    this.display = new QueueDisplay(github, config);
    this.jobs = new Jobs(
      log,
      "github-sync",
      {
        baseMs: BASE_BACKOFF_MS,
        maxMs: MAX_BACKOFF_MS,
        deadlineMs: DEADLINE_MS,
      },
      now,
      (error) => ({ transient: error instanceof TransientError }),
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

  tick(sync: SyncView): void {
    if (this.problem()) return;
    // Read once at start: a rename while the service was down pauses
    // before any issue counts as gone (later redirects check it again).
    if (!this.identified)
      this.background(0, "identity", async (signal) => {
        await this.github.checkIdentity(signal);
        this.identified = true;
      });
    const due =
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
          this.view = read.items;
          this.viewKnown = new Set(known);
          this.viewAt = startedAt;
          this.fresh = true;
          for (const issue of read.gone) this.lose(issue, "queue");
          if (read.truncated)
            this.log.write(0, {
              event: "queue-truncated",
              unread: read.truncated,
            });
        },
        false,
      );
    }
    if (this.fresh) {
      this.fresh = false;
      this.intake(sync);
    }
    for (const runner of sync.runners.values()) {
      const module = runner.state.modules.github as GitHubModule | undefined;
      const issue = runner.state.issue;
      const finished = runner.settled;
      if (finished && this.settled.has(issue)) continue;
      // An issue GitHub no longer has here (deleted, or moved away) has no
      // card or comments to write: its replies are dropped, and once it
      // finishes its sync is settled.
      if (this.gone.has(issue)) {
        if (finished) {
          for (const request of module ? unreplied(runner.state, module) : [])
            this.log.write(issue, { event: "reply-dropped", id: request.id });
          this.settled.add(issue);
        }
        continue;
      }
      if (finished && this.synced(runner.state)) {
        this.settled.add(issue);
        continue;
      }
      if (!module) continue;
      this.show(runner, module, sync);
      this.ask(runner);
      this.status(runner, sync);
      this.track(runner);
      this.reply(runner, module, sync);
      this.cancelled(runner, module);
      if (finished) continue;
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
    }
    for (const [issue, entry] of sync.unreadable)
      if (!this.gone.has(issue)) this.unreadable(issue, entry, due, sync);
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
   */
  unqueue(issue: number): void {
    this.queuing.delete(issue);
    this.jobs.forget(`run:${issue}`);
    if (this.problem()) return;
    this.background(issue, `unrun:${issue}`, async (signal) => {
      await unqueueIssue(this.github, this.config, this.display, issue, signal);
      this.wroteAt.set(issue, this.now());
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
      (!this.config.progress.enabled ||
        ((module.statusGivenUp === true ||
          module.status?.shown === state.status) &&
          (state.status !== "cancelled" ||
            state.withdrawing === true ||
            module.cancelShown === true))) &&
      (!this.config.tracking.enabled ||
        module.trackingGivenUp === true ||
        !trackingDue(state))
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
   * change: from queued to anything else (another option, cleared, or off
   * the Project) dequeues an Objective that hasn't started. Every
   * unfinished Objective takes its order from the card, so reordering works
   * until it starts. A card Factory wrote after the read began is skipped:
   * the read is stale for it.
   */
  private intake(sync: SyncView): void {
    const queuedOption = this.config.queue.options.queued;
    const items = new Map(this.view.map((item) => [item.issue, item]));
    for (const issue of new Set([...items.keys(), ...this.viewKnown])) {
      if (sync.unreadable.has(issue)) continue;
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
            github.seen = option;
            delete github.writing;
          });
        else if (option !== module.seen) {
          if (this.cardChanged(runner, option, sync) === "withdrawn") continue;
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
   * Someone else changed the card since Factory last saw or wrote it. From
   * queued, that dequeues an Objective that hasn't started. A finished
   * Objective set to queued is left to intake, which runs it again. Any
   * other change stands: Factory doesn't write over it until the status
   * moves on (`ceded`).
   */
  private cardChanged(
    runner: ObjectiveRunner,
    option: string | null,
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
    } else if (module.seen === queued && option !== queued) {
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
      runner.state.withdrawing ||
      module.shown === option ||
      module.ceded === option ||
      this.changed.has(issue)
    )
      return;
    const github = () => runner.state.modules.github as GitHubModule;
    this.background(issue, `show:${issue}`, async (signal) => {
      const card = await this.display.get(github().itemId, signal);
      if (runner.state.withdrawing) return;
      const { seen, writing } = github();
      if (
        seen !== undefined &&
        card.option !== seen &&
        card.option !== writing
      ) {
        if (this.cardChanged(runner, card.option, sync) === "requeued")
          this.changed.add(issue);
        return;
      }
      if (card.option !== option) {
        runner.transact(() => {
          github().writing = option;
        });
        crashPoint("sync:show:before");
        await this.display.set(github().itemId, option, signal);
        crashPoint("sync:show:after");
        this.wroteAt.set(issue, this.now());
      }
      runner.transact(() => {
        const module = github();
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
            `${marker}\n${opening}\n\nReply with one of:\n${answers}\n\nAdd text after the answer to explain it.${about}${form}`,
            "sync:ask",
            signal,
            new Date(Date.parse(hold.askedAt) - CLOCK_SKEW_MS).toISOString(),
          );
          runner.transact(() =>
            runner.shown(
              hold.id,
              comment.updated_at ?? comment.created_at,
              !bound,
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
    const given = (state.modules.github as GitHubModule).statusGivenUp;
    if (!this.config.progress.enabled || state.withdrawing || given) return;
    const now = this.now();
    if (now - (this.statusTried.get(issue) ?? -Infinity) < STATUS_EVERY_MS)
      return;
    if (this.jobs.pending(`status:${issue}`)) return;
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
   * The Work Item issues (tracking.ts): projected from the plan in force
   * and each item's state by a background job, at most once per
   * STATUS_EVERY_MS while the Objective runs and at once when it has
   * finished, and only when a write is due. A finished Objective settles
   * only once every item issue shows its end and is closed, or GitHub
   * refused that issue's close (it is never counted closed).
   */
  private track(runner: ObjectiveRunner): void {
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
    if (this.jobs.pending(`track:${issue}`) || !trackingDue(state)) return;
    this.trackTried.set(issue, now);
    this.background(
      issue,
      `track:${issue}`,
      (signal) =>
        track({
          github: this.github,
          state: () => runner.state,
          issueType: this.config.tracking.issueType,
          save: (change) =>
            runner.transact(() => {
              const github = runner.state.modules.github as GitHubModule;
              github.tracking ??= { items: {} };
              change(github.tracking);
            }),
          log: (event) => this.log.write(issue, event),
          signal,
        }),
      true,
      (error) => this.givenUp(runner, "track", error),
    );
  }

  /**
   * A status or tracking job failed. GitHub's transient errors (network,
   * 5xx, rate limits) retry on; a lasting refusal (a 4xx), or anything
   * else three times in a row (a render that keeps throwing), gives it up
   * for this run, so it never holds back settling. Tracking handles a
   * refusal on one item's issue itself, so one reaching here is the
   * repository's (issues off, no access, gone).
   */
  private givenUp(
    runner: ObjectiveRunner,
    job: "status" | "track" | "cancel",
    error: unknown,
  ): void {
    if (error instanceof TransientError) return;
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
   * Neither for a step an open question stops: it waits on the answer,
   * and the engine pauses its clocks until it comes. Neither while
   * progress comments are off.
   */
  private note(runner: ObjectiveRunner, module: GitHubModule): void {
    if (!this.config.progress.enabled) return;
    const now = this.now();
    const issue = runner.state.issue;
    const waits = Object.entries(runner.state.retries)
      .filter(([step, retry]) => retry.count === 0 && !runner.heldBy(step))
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
          `${marker}\n**Factory is waiting.** Step ${code(step)} has been retrying since ${code(retry.since)}. It began with: ${excerpt(retry.cause ?? retry.lastError, this.config.secrets, 500)}\n\nLast error: ${excerpt(retry.lastError, this.config.secrets, 500)}\n\nFactory keeps retrying on its own, and asks here if the wait goes on.`,
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
   * A cancelled run's one closing comment: who cancelled it (the login
   * of a `/factory cancel` comment's author; a CLI cancel is "the
   * operator", never the host's user name), or its deadline. Keyed by the run, so a restart never posts it twice;
   * a finished Objective settles once it is posted, or GitHub refused it
   * (`givenUp`). None for a withdrawn run or while progress comments are
   * off.
   */
  private cancelled(runner: ObjectiveRunner, module: GitHubModule): void {
    const { state } = runner;
    if (
      !this.config.progress.enabled ||
      state.status !== "cancelled" ||
      state.withdrawing ||
      module.cancelShown
    )
      return;
    const issue = state.issue;
    this.background(
      issue,
      `cancel:${issue}`,
      async (signal) => {
        const marker = mark(issue, "cancelled", runOf(state));
        const ended = state.ended;
        const why =
          ended?.by === DEADLINE
            ? `its deadline${state.deadline ? `, ${code(state.deadline)},` : ""} passed`
            : ended?.source === "github" && ended.by
              ? `${prose(ended.by)} cancelled it`
              : "the operator cancelled it";
        await this.github.ensureComment(
          issue,
          marker,
          `${marker}\n**Factory cancelled this Objective**${ended ? ` at ${code(ended.at)}` : ""}: ${why}. Its open pull requests close and the issue closes as not planned; what merged stays merged. Queue it again to run it from a new plan.`,
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
          `${marker}\n**Factory needs you.** Factory can't read this Objective's state (${entry.error.slice(0, 500)}). Reply with \`/factory reset\` (recommended) to rebuild it from its plan comment and PRs on GitHub, or \`/factory cancel\` to start over from a cancelled record (queue it again to run it again).`,
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
          unchecked.push({
            ...comment,
            failures,
            nextAt: new Date(
              now + backoffMs(failures, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
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
    const command = comment.body.match(COMMAND);
    if (!command) return;
    const answer = command[1]!.toLowerCase();
    let rest = command[2]?.trim() ?? "";
    let question: string | undefined;
    let reviewArtifacts: string[] | undefined;
    for (
      let option = ANSWER_OPTION.exec(rest);
      option;
      option = ANSWER_OPTION.exec(rest)
    ) {
      if (option[1] === "question") question = option[2];
      else reviewArtifacts = [...(reviewArtifacts ?? []), option[2]!];
      rest = option[3]?.trim() ?? "";
    }
    const text = rest;
    writeRequest(
      sync.requestsDir,
      answer === "cancel"
        ? { kind: "cancel", issue }
        : answer === "retry" && !holding && !question
          ? { kind: "retry", issue }
          : {
              kind: "answer",
              issue,
              answer,
              ...(text ? { text } : {}),
              writtenAt: comment.createdAt,
              ...(question ? { question } : {}),
              ...(reviewArtifacts ? { reviewArtifacts } : {}),
            },
      comment.login,
      `comment-${comment.id}`,
      "github",
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
    const counted: Transport = {
      calls: 0,
      retries: this.transportFailed.has(key) ? 1 : 0,
      rateLimited: 0,
      failed: 0,
      bytes: 0,
    };
    const started = this.now();
    const ended = (ok: boolean) => {
      if (ok) this.transportFailed.delete(key);
      else this.transportFailed.set(key, issue);
      // Each failed, re-sent or rate-limited request, unthrottled: one bad request stays traceable.
      for (const request of counted.requests ?? [])
        this.log.write(issue, {
          event: "github-request",
          job: key,
          ...request,
        });
      if (counted.unnoted)
        this.log.write(issue, {
          event: "github-request",
          job: key,
          unnoted: counted.unnoted,
        });
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
      issue,
      since: this.now(),
      runs: 0,
      ms: 0,
      calls: 0,
      retries: 0,
      rateLimited: 0,
      failed: 0,
      bytes: 0,
    };
    tally.runs += 1;
    tally.ms += ms;
    tally.calls += run.calls;
    tally.retries += run.retries;
    tally.rateLimited += run.rateLimited;
    tally.failed += run.failed;
    tally.bytes += run.bytes;
    this.transportTally.set(key, tally);
    if (failed || this.now() - tally.since >= TRANSPORT_EVERY_MS)
      this.writeTransport(key);
  }

  /** Write every unwritten `github-call` tally: at the service's stop, before its run ends. */
  flushTransport(): void {
    for (const key of [...this.transportTally.keys()]) this.writeTransport(key);
  }

  private writeTransport(key: string): void {
    const tally = this.transportTally.get(key);
    this.transportTally.delete(key);
    if (!tally?.calls) return;
    const {
      issue,
      since: _since,
      requests: _requests,
      unnoted: _unnoted,
      ...counts
    } = tally;
    this.log.write(issue, { event: "github-call", job: key, ...counts });
  }
}

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
