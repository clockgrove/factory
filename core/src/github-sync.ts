import type { CoreConfig, QueueOption } from "./config.js";
import type { ObjectiveRunner } from "./engine.js";
import { type GitHub, TransientError } from "./github.js";
import type { RunLog } from "./log.js";
import { type QueueItem, QueueDisplay, queued, readQueue } from "./queue.js";
import { writeRequest } from "./requests.js";
import type { ObjectiveStatus } from "./state.js";
import { TERMINAL } from "./state.js";

/** What the sync keeps in an Objective's state (`modules.github`). */
export interface GitHubModule {
  itemId: string;
  /** The Factory field option last written. */
  shown?: string;
  /** The hold whose question comment exists. */
  askedHold?: string;
  /** Comments are read from here on. */
  commentsSince: string;
  /** Request ids already replied to. */
  replied?: string[];
}

export interface SyncView {
  runners: ReadonlyMap<number, ObjectiveRunner>;
  /** Whether a new Objective may start now. */
  slotFree(): boolean;
  /** Start an Objective from the queue. */
  admit(issue: number, github: GitHubModule): void;
  requestsDir: string;
  /** The result of an applied request, by id, while its result file exists. */
  result(id: string): string | undefined;
}

const MARK = (issue: number, kind: string, id: string) =>
  `<!-- factory:${issue}:${kind}:${id} -->`;

const OPTION: Record<ObjectiveStatus, QueueOption> = {
  checking: "planning",
  planning: "planning",
  building: "building",
  finishing: "building",
  holding: "holding",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * GitHub is input and display, never a precondition: every call here runs in
 * the background, a failure is logged and tried again on the next poll, and
 * nothing here can fail a run.
 */
export class GitHubSync {
  private view: QueueItem[] = [];
  private lastPoll = 0;
  private readonly busy = new Set<string>();
  private readonly display: QueueDisplay;
  private readonly writers = new Map<string, boolean>();

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
    private readonly log: RunLog,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.display = new QueueDisplay(github, config);
  }

  tick(sync: SyncView): void {
    const due =
      this.now() - this.lastPoll >= this.config.queue.pollSeconds * 1000;
    if (due) {
      this.lastPoll = this.now();
      this.background("queue", async () => {
        this.view = await readQueue(this.github, this.config);
      });
    }
    this.admit(sync);
    for (const runner of sync.runners.values()) {
      const module = runner.state.modules.github as GitHubModule | undefined;
      if (!module) continue;
      this.show(runner, module);
      this.ask(runner, module);
      this.reply(runner, module, sync);
      if (due && !TERMINAL.includes(runner.state.status))
        this.readComments(runner, module, sync);
    }
  }

  /** Start the first queued Objective that has no unfinished run. */
  private admit(sync: SyncView): void {
    if (!sync.slotFree()) return;
    for (const item of queued(this.view, this.config)) {
      const runner = sync.runners.get(item.issue);
      // A finished run shows its final option, so a queued one was queued again.
      if (runner && !TERMINAL.includes(runner.state.status)) continue;
      sync.admit(item.issue, {
        itemId: item.itemId,
        commentsSince: new Date(this.now()).toISOString(),
      });
      // Show it as started at once, so the next poll doesn't see it queued again.
      item.option = this.config.queue.options.planning;
      return;
    }
  }

  private show(runner: ObjectiveRunner, module: GitHubModule): void {
    const option = this.config.queue.options[OPTION[runner.state.status]];
    if (module.shown === option) return;
    const issue = runner.state.issue;
    this.background(`show:${issue}`, async () => {
      await this.display.set(module.itemId, option);
      runner.transact(() => {
        (runner.state.modules.github as GitHubModule).shown = option;
      });
      const item = this.view.find((i) => i.issue === issue);
      if (item) item.option = option;
    });
  }

  /** Post the open question once, with its answers. */
  private ask(runner: ObjectiveRunner, module: GitHubModule): void {
    const hold = runner.state.hold;
    if (!hold || module.askedHold === hold.id) return;
    const issue = runner.state.issue;
    this.background(`ask:${issue}`, async () => {
      const marker = MARK(issue, "hold", hold.id);
      if (!(await this.posted(issue, marker, hold.askedAt))) {
        const answers = hold.answers
          .map(
            (a) =>
              `\`/factory ${a}\`${a === hold.recommended ? " (recommended)" : ""}`,
          )
          .join(", ");
        await this.comment(
          issue,
          `${marker}\n**Factory needs you.** ${hold.question}\n\nReply with one of: ${answers}. Add text after the answer to explain it.`,
        );
      }
      runner.transact(() => {
        (runner.state.modules.github as GitHubModule).askedHold = hold.id;
      });
    });
  }

  /** Read new `/factory` comments and turn each into a request. */
  private readComments(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const issue = runner.state.issue;
    this.background(`comments:${issue}`, async () => {
      const comments = await this.github.comments(issue, module.commentsSince);
      let latest = module.commentsSince;
      for (const comment of comments) {
        if (comment.created_at > latest) latest = comment.created_at;
        const command = comment.body
          .trim()
          .match(/^\/factory\s+(\S+)(?:\s+([\s\S]*))?$/);
        if (!command || !comment.user) continue;
        const login = comment.user.login;
        if (!(await this.canWrite(login))) {
          this.log.write(issue, {
            event: "comment-ignored",
            comment: comment.id,
            login,
          });
          continue;
        }
        const answer = command[1]!.toLowerCase();
        const text = command[2]?.trim();
        writeRequest(
          sync.requestsDir,
          answer === "cancel"
            ? { kind: "cancel", issue }
            : answer === "retry" && !runner.state.hold
              ? { kind: "retry", issue }
              : {
                  kind: "answer",
                  issue,
                  answer,
                  ...(text ? { text } : {}),
                  writtenAt: comment.created_at,
                },
          login,
          `comment-${comment.id}`,
        );
      }
      if (latest !== module.commentsSince)
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).commentsSince = latest;
        });
    });
  }

  /** Reply to each `/factory` comment with what happened. */
  private reply(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const issue = runner.state.issue;
    const pending = runner.state.appliedRequests.filter(
      (r) =>
        r.id.startsWith("comment-") && !(module.replied ?? []).includes(r.id),
    );
    for (const request of pending) {
      this.background(`reply:${request.id}`, async () => {
        const marker = MARK(issue, "reply", request.id);
        const message = sync.result(request.id) ?? request.message;
        if (!(await this.posted(issue, marker, module.commentsSince))) {
          await this.comment(
            issue,
            `${marker}\n${message === "ok" ? "Factory: done." : `Factory: ${message}`}`,
          );
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
    const from = new Date(Date.parse(since) - 10 * 60_000).toISOString();
    return (await this.github.findComment(issue, marker, from)) !== undefined;
  }

  private async comment(issue: number, body: string): Promise<void> {
    await this.github.rest(
      "POST",
      `/repos/${this.config.repository}/issues/${issue}/comments`,
      { body },
    );
  }

  private async canWrite(login: string): Promise<boolean> {
    const known = this.writers.get(login);
    if (known !== undefined) return known;
    const { permission } = await this.github.rest<{ permission: string }>(
      "GET",
      `/repos/${this.config.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const ok = ["admin", "maintain", "write"].includes(permission);
    this.writers.set(login, ok);
    return ok;
  }

  /** Run `job` unless the same job is still running; log any failure. */
  private background(key: string, job: () => Promise<void>): void {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    job()
      .catch((error: unknown) =>
        this.log.write(0, {
          event: "github-sync",
          job: key,
          transient: error instanceof TransientError,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => this.busy.delete(key));
  }
}
