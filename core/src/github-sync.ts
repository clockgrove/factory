import type { CoreConfig, QueueOption } from "./config.js";
import { crashPoint } from "./crash.js";
import type { EngineLimits, ObjectiveRunner } from "./engine.js";
import { type GitHub, issueGone, TransientError } from "./github.js";
import type { RunLog } from "./log.js";
import { QueueDisplay, type QueueItem, queued, readQueue } from "./queue.js";
import { writeRequest } from "./requests.js";
import type { ObjectiveState, ObjectiveStatus } from "./state.js";
import { CLOCK_SKEW_MS, TERMINAL } from "./state.js";
import { errorMessage } from "./text.js";

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
  /** When Factory last wrote the option, by GitHub's clock. */
  shownAt?: string;
  /** When the card was set to queued for this run, by GitHub's clock. */
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
  /** `/factory` comments whose author's access couldn't be read yet, oldest first. */
  unchecked?: UncheckedComment[];
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
  /** Checked and waiting for a slot: still shown as queued. */
  waitingForSlot(issue: number): boolean;
  requestsDir: string;
  /** The result of an applied request, by id, while its result file exists. */
  result(id: string): string | undefined;
}

const MARK = (issue: number, kind: string, id: string) =>
  `<!-- factory:${issue}:${kind}:${id} -->`;

const OPTION: Record<ObjectiveStatus, QueueOption> = {
  checking: "queued",
  planning: "planning",
  building: "building",
  finishing: "building",
  holding: "holding",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** A sync job that failed waits this long, doubling, up to MAX_BACKOFF_MS. */
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** Comments kept waiting for their author's access to be read, per Objective. */
const MAX_UNCHECKED = 20;
const COMMAND = /^\/factory\s+(\S+)(?:\s+([\s\S]*))?$/;
/** `--question ID` right after the answer names the hold it answers. */
const QUESTION = /^--question\s+(\S+)(?:\s+([\s\S]*))?$/;

/**
 * GitHub is input and display, never a precondition: every call here runs in
 * the background, and nothing here can fail a run. A failed job is logged
 * and tried again after a backoff of its own (per job and Objective, capped
 * at ten minutes), so one Objective's bad card or locked issue never spends
 * the rate limit the others need. A finished Objective stays until its
 * final option and replies are written.
 *
 * The queue is read by edges, never by levels: Factory writes the queued
 * option itself (while an Objective is checked or waits for a slot), so a
 * card that reads queued means nothing alone. A finished Objective queues
 * again only when its option was set after Factory's own last write
 * (GitHub's `updatedAt` of the option, against the `shownAt` and
 * `queuedAt` Factory saved), so a stale card never re-admits a finished or
 * cancelled run. An unfinished one dequeues when its card changes from
 * queued to anything else, cleared or off the Project included, against
 * the option Factory last saw or wrote (`seen`), which has no clock to need.
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
  /** Running jobs, by key, with their Objective. */
  private readonly busy = new Map<string, number>();
  private readonly backoff = new Map<
    string,
    { failures: number; nextAt: number }
  >();
  /** Finished Objectives whose final option and replies are written. */
  private readonly settled = new Set<number>();
  /** The repository's identity was read once since the service started. */
  private identified = false;
  private readonly display: QueueDisplay;

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
      this.background(0, "identity", async () => {
        await this.github.checkIdentity();
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
        ]),
      ].filter((issue) => !this.gone.has(issue));
      // The poll interval paces the queue read; it needs no backoff.
      const startedAt = this.now();
      this.background(
        0,
        "queue",
        async () => {
          const read = await readQueue(this.github, this.config, known);
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
      const finished =
        TERMINAL.includes(runner.state.status) && !runner.hasWork;
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
      this.reply(runner, module, sync);
      if (finished) continue;
      this.note(runner, module);
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

  /** Whether a finished Objective's sync is done and no job of it is running. */
  idle(issue: number): boolean {
    return (
      this.settled.has(issue) &&
      ![...this.busy.values()].some((owner) => owner === issue)
    );
  }

  /** Whether a finished Objective's card shows its final option and every reply is posted. */
  synced(state: ObjectiveState): boolean {
    const module = state.modules.github as GitHubModule | undefined;
    if (!module) return true;
    return (
      TERMINAL.includes(state.status) &&
      [module.shown, module.ceded].includes(
        this.config.queue.options[OPTION[state.status]],
      ) &&
      !unreplied(state, module).length
    );
  }

  /** Forget an Objective the service let go of, or whose run was replaced. */
  forget(issue: number): void {
    this.settled.delete(issue);
    this.changed.delete(issue);
    this.wroteAt.delete(issue);
    for (const key of this.backoff.keys())
      if (key.endsWith(`:${issue}`) || key.includes(`:${issue}:`))
        this.backoff.delete(key);
  }

  /** The service withdrew a dequeued run: forget it, and keep the dequeue's edge. */
  withdrawn(state: ObjectiveState): void {
    this.forget(state.issue);
    const module = state.modules.github as GitHubModule | undefined;
    const marks = [module?.queuedAt, module?.shownAt]
      .map((mark) => Date.parse(mark ?? ""))
      .filter(Number.isFinite);
    if (marks.length) this.withdrawnAt.set(state.issue, Math.max(...marks));
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
        this.busy.has(`show:${issue}`) ||
        (this.wroteAt.get(issue) ?? -1) >= this.viewAt
      )
        continue;
      this.changed.delete(issue);
      // Missing from a read that asked for it by number: no card.
      const item = items.get(issue);
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
            item?.option === queuedOption &&
            !runner.hasWork &&
            moved(item, state)
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
      if (option === queued) return "requeued";
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

  /** The option the Objective's status shows. */
  private desired(runner: ObjectiveRunner, sync: SyncView): string {
    const status = runner.state.status;
    return this.config.queue.options[
      !TERMINAL.includes(status) &&
      status !== "holding" &&
      sync.waitingForSlot(runner.state.issue)
        ? "queued"
        : OPTION[status]
    ];
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
      runner.state.withdrawing ||
      module.shown === option ||
      module.ceded === option ||
      this.changed.has(issue)
    )
      return;
    const github = () => runner.state.modules.github as GitHubModule;
    this.background(issue, `show:${issue}`, async () => {
      const card = await this.display.get(github().itemId);
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
      let at = card.at;
      if (card.option !== option) {
        runner.transact(() => {
          github().writing = option;
        });
        crashPoint("sync:show:before");
        at = await this.display.set(github().itemId, option);
        crashPoint("sync:show:after");
        this.wroteAt.set(issue, this.now());
      }
      runner.transact(() => {
        const module = github();
        module.shown = option;
        module.seen = option;
        delete module.writing;
        delete module.ceded;
        if (at) module.shownAt = at;
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
   * comment is edited to name its question too.
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
      this.background(issue, `ask:${issue}:${hold.id}`, async () => {
        const marker = MARK(issue, "hold", hold.id);
        const named = ` --question ${hold.id}`;
        const answers = hold.answers
          .map(
            (a) =>
              `\`/factory ${a}${bound ? named : ""}\`${a === hold.recommended ? " (recommended)" : ""}`,
          )
          .join(", ");
        const about = hold.item
          ? ` It stops Work Item \`${hold.item}\` and the items that depend on it; other work goes on.`
          : "";
        const form = others
          ? " Other questions are open too, so the answer names this one."
          : bound
            ? " Another question was shown after this one, so the answer names this one."
            : ` While this is the only open question, the short form works; \`/factory <answer>${named}\` always does.`;
        const comment = await this.github.upsertComment(
          issue,
          marker,
          `${marker}\n**Factory needs you.** ${hold.question}\n\nReply with one of: ${answers}. Add text after the answer to explain it.${about}${form}`,
          "sync:ask",
          undefined,
          new Date(Date.parse(hold.askedAt) - CLOCK_SKEW_MS).toISOString(),
        );
        runner.transact(() =>
          runner.shown(
            hold.id,
            comment.updated_at ?? comment.created_at,
            !bound,
          ),
        );
      });
    }
  }

  /**
   * A wait shown on the issue: one status note, edited in place, once an
   * unknown transient cause has lasted `noteAfterMs`; one reminder once a
   * human gate (an approval, a required review) has lasted `remindAfterMs`.
   * Neither for a step an open question stops: it waits on the answer,
   * and the engine pauses its clocks until it comes.
   */
  private note(runner: ObjectiveRunner, module: GitHubModule): void {
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
      this.background(issue, `note:${issue}`, async () => {
        const marker = MARK(issue, "waiting", "note");
        await this.github.upsertComment(
          issue,
          marker,
          `${marker}\n**Factory is waiting.** Step \`${step}\` has been retrying since ${retry.since}. It began with: ${(retry.cause ?? retry.lastError).slice(0, 500)}\n\nLast error: ${retry.lastError.slice(0, 500)}\n\nFactory keeps retrying on its own, and asks here if the wait goes on.`,
          "sync:note",
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
      this.background(issue, `remind:${issue}`, async () => {
        const marker = MARK(issue, "remind", id);
        if (!(await this.posted(issue, marker, retry.since))) {
          crashPoint("sync:remind:before");
          await this.github.postComment(
            issue,
            `${marker}\n**Factory is still waiting on ${what}**, since ${retry.since}. It carries on by itself once that is done.`,
          );
          crashPoint("sync:remind:after");
        }
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).reminded = id;
        });
      });
    }
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
      this.background(issue, `show:${issue}`, async () => {
        crashPoint("sync:show:before");
        const at = await this.display.set(module.itemId, option);
        crashPoint("sync:show:after");
        module.shown = option;
        if (at) module.shownAt = at;
      });
    if (!module.askedUnreadable)
      this.background(issue, `ask:${issue}`, async () => {
        // This incident's question: an earlier incident's question, and
        // the answers to it, never count for this one.
        const marker = MARK(issue, "hold", `unreadable:${entry.incident}`);
        let question = await this.github.markedComment(issue, marker);
        if (!question) {
          crashPoint("sync:ask:before");
          question = await this.github.postComment(
            issue,
            `${marker}\n**Factory needs you.** Factory can't read this Objective's state (${entry.error.slice(0, 500)}). Reply with \`/factory cancel\` (recommended) to start over from a cancelled record; then queue it again to run it again.`,
          );
          crashPoint("sync:ask:after");
        }
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
    this.background(issue, `comments:${issue}`, async () => {
      const since = module.commentsSince;
      const comments = await this.github.comments(issue, since);
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
          allowed = await this.github.canWrite(comment.login);
        } catch (error) {
          const failures = comment.failures + 1;
          unchecked.push({
            ...comment,
            failures,
            nextAt: new Date(
              now +
                Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
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
    const bound = QUESTION.exec(command[2]?.trim() ?? "");
    const question = bound?.[1];
    const text = (bound ? bound[2] : command[2])?.trim();
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
            },
      comment.login,
      `comment-${comment.id}`,
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
      this.background(issue, `reply:${issue}:${request.id}`, async () => {
        const marker = MARK(issue, "reply", request.id);
        const message = sync.result(request.id) ?? request.message;
        if (!(await this.posted(issue, marker, module.commentsSince))) {
          crashPoint("sync:reply:before");
          await this.github.postComment(
            issue,
            `${marker}\n${message === "ok" ? "Factory: done." : `Factory: ${message}`}`,
          );
          crashPoint("sync:reply:after");
        }
        runner.transact(() => {
          const github = runner.state.modules.github as GitHubModule;
          github.replied = [...(github.replied ?? []), request.id].slice(-50);
        });
      });
    }
  }

  /** Whether the marked comment exists; read from a little before `since`, for clock skew between this host and GitHub. */
  private async posted(
    issue: number,
    marker: string,
    since: string,
  ): Promise<boolean> {
    // An unreadable state's cursor is empty until its question is shown.
    const at = Date.parse(since);
    const from = Number.isFinite(at)
      ? new Date(at - CLOCK_SKEW_MS).toISOString()
      : undefined;
    return (await this.github.findComment(issue, marker, from)) !== undefined;
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
   * Run `job` for Objective `issue` (0: the queue) unless it is running or
   * backing off after a failure; log any failure and back off.
   */
  private background(
    issue: number,
    key: string,
    job: () => Promise<void>,
    backs = true,
  ): void {
    if (this.busy.has(key)) return;
    const wait = this.backoff.get(key);
    if (wait && this.now() < wait.nextAt) return;
    this.busy.set(key, issue);
    job()
      .then(() => this.backoff.delete(key))
      .catch(async (error: unknown) => {
        // A sub-resource's 404 (comments, a card) can be transient or a
        // permission gap: the issue is gone only if a direct read of it
        // also says so. Otherwise the job retries with its backoff.
        if (issue && issueGone(error)) await this.confirmGone(issue, key);
        const failures = (this.backoff.get(key)?.failures ?? 0) + 1;
        if (backs)
          this.backoff.set(key, {
            failures,
            nextAt:
              this.now() +
              Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
          });
        this.log.write(issue, {
          event: "github-sync",
          job: key,
          transient: error instanceof TransientError,
          failures,
          error: errorMessage(error),
        });
      })
      .finally(() => this.busy.delete(key));
  }
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
 * Whether the card's option was set after Factory's own last write for
 * this run (by GitHub's clock): an operator's queue or dequeue. A run with
 * no GitHub time saved falls back to its last save.
 */
function moved(item: QueueItem, state: ObjectiveState): boolean {
  const at = Date.parse(item.optionAt ?? "");
  if (!Number.isFinite(at)) return false;
  const module = state.modules.github as GitHubModule | undefined;
  const marks = [module?.shownAt, module?.queuedAt]
    .map((mark) => Date.parse(mark ?? ""))
    .filter(Number.isFinite);
  return at > (marks.length ? Math.max(...marks) : Date.parse(state.updatedAt));
}
