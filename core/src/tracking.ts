import { createHash } from "node:crypto";
import {
  type GitHub,
  GitHubError,
  type IssueSummary,
  issueGone,
} from "./github.js";
import { code, mark, prose } from "./markdown.js";
import { currentPlan } from "./planning/plan.js";
import type { Plan } from "./planning/types.js";
import { CLOCK_SKEW_MS, type ObjectiveState, TERMINAL } from "./state.js";
import { itemRows } from "./status.js";

/**
 * Work Item issues: one display-only issue per Work Item of the plan in
 * force (planning/plan.ts `currentPlan`), a sub-issue of the Objective,
 * with blocked-by links that mirror the plan's dependencies, the
 * configured native type, the `factory:work-item` label and one live
 * comment that shows the item's state. It is closed as completed when the
 * item merges, and as not planned, with the reason in its comment, when
 * the item leaves the plan (a replan or an amendment) or the Objective
 * ends without it. The issue shows progress and never drives it:
 * questions and answers stay on the Objective.
 *
 * Projection only: github-sync.ts runs `track` as a background job, and
 * what was written is kept in the Objective's state (`Tracking`), so a
 * pass makes only the writes whose recorded state differs from the plan,
 * and makes no GitHub call when nothing changed. An issue is found by the
 * marker on its body's first line before it is made: on a replay its
 * creation is looked up (the Objective's sub-issues, and, only while a
 * creation may be unrecorded, one list of Factory's labelled issues since
 * that creation began), never repeated. A run again of a finished
 * Objective keeps the issues recorded (service.ts), so one created but
 * never linked is still found.
 *
 * A refusal on one item's issue (deleted, locked, transferred) stops
 * only that issue's writes: the others are still written and closed.
 * Only a refusal of the Objective-wide calls (the lists, a create) gives
 * tracking up for the run (github-sync.ts).
 */

/** The role label of a Work Item issue: the queue never takes one as an Objective. */
export const WORK_ITEM_LABEL = "factory:work-item";

/** What was written for one Work Item's issue. */
export interface ItemIssue {
  /** The issue's number and database id. */
  issue: number;
  id: number;
  /** The hash of the title and body last written (or found). */
  body: string;
  /** Its native type is written, or the repository refused it. */
  typed?: true;
  /** It is a sub-issue of the Objective. */
  parent?: true;
  /** The dependencies its blocked-by links mirror. */
  blockedBy?: string[];
  /** The hash of its live comment as last written. */
  comment?: string;
  closed?: true;
  /** GitHub refused a write to it: only its close is still tried this run. */
  refused?: true;
  /** GitHub refused its close too: nothing more is tried this run. It stays unclosed. */
  unclosed?: true;
}

/** What tracking keeps in the Objective's state (`modules.github.tracking`). */
export interface Tracking {
  items: Record<string, ItemIssue>;
  /** Items whose issue may have been created without being recorded here, with when (host time) each create began: looked up first. */
  creating?: Record<string, string>;
  /** The repository refused the native type: not tried again this run. */
  untyped?: true;
}

/** What one Work Item's issue should show. */
interface Wanted {
  /** In the plan in force while the Objective runs: its issue is created, and its body and links kept. */
  planned: boolean;
  title: string;
  body: string;
  dependencies: string[];
  comment: string;
  /** Closed, and how; open when absent. */
  close?: "completed" | "not_planned";
}

/** The issue of `item`, once tracking has recorded it: a PR body names it. */
export function itemIssueOf(
  state: ObjectiveState,
  item: string,
): number | undefined {
  return trackingOf(state)?.items[item]?.issue;
}

function trackingOf(state: ObjectiveState): Tracking | undefined {
  return (state.modules.github as { tracking?: Tracking } | undefined)
    ?.tracking;
}

/**
 * Each Work Item's wanted issue: the plan's items, and the items recorded
 * earlier that left it. Nothing here reads GitHub.
 */
function wanted(state: ObjectiveState): Map<string, Wanted> {
  const objective = state.issue;
  const plan = currentPlan(state);
  const ended = TERMINAL.includes(state.status);
  const items = new Map<string, Wanted>();
  const rows = new Map(
    (plan ? itemRows(state, plan) : []).map((row) => [row.id, row]),
  );
  for (const item of plan?.items ?? []) {
    const row = rows.get(item.id)!;
    const close =
      row.phase === "merged"
        ? "completed"
        : row.phase === "skipped" || ended
          ? "not_planned"
          : undefined;
    const why =
      row.phase === "merged"
        ? "merged."
        : row.phase === "skipped"
          ? "skipped: its condition doesn't hold."
          : state.status === "cancelled"
            ? "not planned: the Objective was cancelled."
            : "not planned: the Objective finished without it.";
    items.set(item.id, {
      planned: !ended,
      // A title is plain text, never Markdown: only cut to one line.
      title: cut(item.title, 200),
      body: issueBody(objective, item, plan!),
      dependencies: [...item.dependencies].sort(),
      comment: liveComment(objective, item.id, [
        `**Phase:** ${prose(row.phase)}`,
        `**PR:** ${row.pr === null ? "none yet" : `#${row.pr}`}`,
        ...(row.repairs ? [`**Repairs:** ${row.repairs}`] : []),
        ...(row.hold
          ? [
              `**Question:** ${code(row.hold)} is open on #${objective}; answer it there.`,
            ]
          : []),
        ...(close ? [`**Closed:** ${why}`] : []),
      ]),
      ...(close ? { close } : {}),
    });
  }
  // With no plan in force yet (a run again, or a replan, still planning),
  // the issues recorded earlier stay as they are until one is accepted.
  if (!plan && !ended) return items;
  for (const id of Object.keys(trackingOf(state)?.items ?? {}))
    if (!items.has(id))
      items.set(id, {
        planned: false,
        title: "",
        body: "",
        dependencies: [],
        comment: liveComment(objective, id, [
          `**Closed:** not planned: ${state.status === "cancelled" ? "the Objective was cancelled" : "it is not in the current plan (replanned or amended)"}.`,
        ]),
        close: "not_planned",
      });
  return items;
}

/**
 * The tracking a run again of a finished Objective starts from: the
 * issues recorded so far, so one created but never linked is found, not
 * made again. Refusals were this run's: they are tried again.
 */
export function carried(tracking: Tracking): Tracking {
  return {
    items: Object.fromEntries(
      Object.entries(tracking.items).map(
        ([id, { refused: _refused, unclosed: _unclosed, ...issue }]) => [
          id,
          issue,
        ],
      ),
    ),
    ...(tracking.creating ? { creating: tracking.creating } : {}),
  };
}

/** Whether a tracking pass has a write to make. */
export function trackingDue(state: ObjectiveState): boolean {
  const tracking = trackingOf(state);
  if (Object.keys(tracking?.creating ?? {}).length) return true;
  for (const [id, want] of wanted(state)) {
    const has = tracking?.items[id];
    if (!has) {
      if (want.planned) return true;
      continue;
    }
    if (has.unclosed) continue;
    if (has.refused) {
      if (want.close && !has.closed) return true;
      continue;
    }
    if (
      has.comment !== hash(want.comment) ||
      Boolean(has.closed) !== Boolean(want.close) ||
      (want.planned &&
        (has.body !== hash(want.title, want.body) ||
          !has.parent ||
          (!has.typed && !tracking.untyped) ||
          has.blockedBy?.join("\n") !== want.dependencies.join("\n")))
    )
      return true;
  }
  return false;
}

export interface TrackContext {
  github: GitHub;
  /** The Objective's state as it is now (a save may replace it). */
  state: () => ObjectiveState;
  /** The native type to give each issue. */
  issueType: string;
  /** Save a change to the recorded tracking (made if absent). */
  save(change: (tracking: Tracking) => void): void;
  /** Log an event on the Objective's run log. */
  log(event: Record<string, unknown>): void;
  signal: AbortSignal;
}

/**
 * One pass: every write the recorded state shows is due, in an order a
 * crash can stop anywhere. Create (recorded as `creating` first), then
 * per issue: its title and body, its type, the sub-issue link, the
 * blocked-by links, the live comment, and the close (or a reopen).
 * A refusal on one issue is recorded on it, and the pass goes on.
 */
export async function track(context: TrackContext): Promise<void> {
  const { github, signal } = context;
  const state = context.state();
  const objective = state.issue;
  const issueMark = (id: string) => mark(objective, "item", id);
  const record = () => trackingOf(context.state()) ?? { items: {} };
  const want = wanted(state);
  const missing = [...want].filter(
    ([id, item]) => item.planned && !record().items[id],
  );
  const creating = Object.entries(record().creating ?? {});
  let subIssues: IssueSummary[] | undefined;
  let found: IssueSummary[] = [];
  if (missing.length || creating.length)
    found = subIssues = await github.subIssues(objective, signal);
  if (creating.length) {
    // A creation a crash left unrecorded: adopted (and closed, if no
    // longer wanted). One not found is created below if still planned.
    // Only issues updated since the earliest such create began are listed.
    const since = Math.min(...creating.map(([, at]) => Date.parse(at)));
    found = [
      ...found,
      ...(await github.issuesByLabel(
        WORK_ITEM_LABEL,
        new Date(since - CLOCK_SKEW_MS).toISOString(),
        signal,
      )),
    ];
    for (const [id] of creating) {
      const issue = record().items[id]
        ? undefined
        : await github.markedIssue(found, issueMark(id), signal);
      context.save((tracking) => {
        if (issue) tracking.items[id] = adopted(issue);
        if (tracking.items[id] || !want.get(id)?.planned) created(tracking, id);
      });
    }
  }
  for (const [id, item] of missing) {
    if (record().items[id]) continue;
    context.save((tracking) => {
      tracking.creating = {
        ...tracking.creating,
        [id]: new Date().toISOString(),
      };
    });
    const issue = await github.ensureIssue(
      found,
      issueMark(id),
      {
        title: item.title,
        body: item.body,
        labels: [WORK_ITEM_LABEL],
      },
      "sync:item-issue:create",
      signal,
    );
    context.save((tracking) => {
      tracking.items[id] = adopted(issue);
      created(tracking, id);
    });
  }
  const owned = new Set(
    Object.values(record().items).map((issue) => issue.issue),
  );
  for (const [id, item] of want) {
    const has = record().items[id];
    if (!has || has.unclosed) continue;
    const update = (change: (issue: ItemIssue) => void) =>
      context.save((tracking) => change(tracking.items[id]!));
    let closing = false;
    try {
      if (!has.refused) await show(id, item, has, update);
      closing = Boolean(item.close && !has.closed);
      if (closing) {
        await github.closeIssue(
          has.issue,
          item.close!,
          "sync:item-issue:close",
          signal,
        );
        update((issue) => {
          issue.closed = true;
        });
      }
    } catch (error) {
      if (!refusal(error)) throw error;
      update((issue) => {
        issue.refused = true;
        if (closing) issue.unclosed = true;
      });
      context.log({
        event: "item-issue-refused",
        item: id,
        issue: has.issue,
        status: error.status,
        close: closing,
      });
    }
  }

  /** The issue's body, type, links, live comment and reopen, as due. */
  async function show(
    id: string,
    item: Wanted,
    has: ItemIssue,
    update: (change: (issue: ItemIssue) => void) => void,
  ): Promise<void> {
    if (item.planned) {
      const body = hash(item.title, item.body);
      if (has.body !== body) {
        await github.editIssue(
          has.issue,
          { title: item.title, body: item.body },
          "sync:item-issue:edit",
          signal,
        );
        update((issue) => {
          issue.body = body;
        });
      }
      if (!has.typed && !record().untyped)
        await setType(context, has, () =>
          update((issue) => {
            issue.typed = true;
          }),
        );
      if (!has.parent) {
        subIssues ??= await github.subIssues(objective, signal);
        await github.ensureSubIssue(
          objective,
          { id: has.id, number: has.issue },
          subIssues,
          "sync:item-issue:link",
          signal,
        );
        update((issue) => {
          issue.parent = true;
        });
      }
      if (has.blockedBy?.join("\n") !== item.dependencies.join("\n")) {
        const blockers = item.dependencies
          .map((dependency) => record().items[dependency])
          .filter((issue): issue is ItemIssue => !!issue)
          .map((issue) => ({ id: issue.id, number: issue.issue }));
        await github.ensureBlockedBy(
          has.issue,
          blockers,
          owned,
          "sync:item-issue:link",
          signal,
        );
        update((issue) => {
          issue.blockedBy = item.dependencies;
        });
      }
    }
    if (has.closed && !item.close) {
      await github.reopenIssue(has.issue, "sync:item-issue:reopen", signal);
      update((issue) => {
        delete issue.closed;
      });
    }
    const comment = hash(item.comment);
    if (has.comment !== comment) {
      await github.upsertComment(
        has.issue,
        mark(objective, "item-status", id),
        item.comment,
        "sync:item-issue:comment",
        signal,
      );
      update((issue) => {
        issue.comment = comment;
      });
    }
  }
}

/** A lasting refusal of a write to one issue: deleted, moved, locked or not allowed (a rejected login is not one). */
function refusal(error: unknown): error is GitHubError {
  return (
    issueGone(error) ||
    (error instanceof GitHubError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401)
  );
}

/** The create of `id` is recorded, or no longer wanted. */
function created(tracking: Tracking, id: string): void {
  if (!tracking.creating) return;
  delete tracking.creating[id];
  if (!Object.keys(tracking.creating).length) delete tracking.creating;
}

/**
 * Set the issue's native type. A refusal (a repository without issue
 * types, or no such type) is logged once and not tried again this run;
 * the issue stays tracked without it.
 */
async function setType(
  context: TrackContext,
  issue: ItemIssue,
  done: () => void,
): Promise<void> {
  try {
    await context.github.editIssue(
      issue.issue,
      { type: context.issueType },
      "sync:item-issue:edit",
      context.signal,
    );
    done();
  } catch (error) {
    if (
      !(error instanceof GitHubError) ||
      error.status < 400 ||
      error.status >= 500
    )
      throw error;
    context.save((tracking) => {
      tracking.untyped = true;
    });
    context.log({
      event: "item-issue-untyped",
      type: context.issueType,
      status: error.status,
    });
  }
}

/** An issue found or created: recorded as it is on GitHub. */
function adopted(issue: IssueSummary): ItemIssue {
  return {
    issue: issue.number,
    id: issue.id,
    body: hash(issue.title, issue.body ?? ""),
    ...(issue.state === "open" ? {} : { closed: true }),
  };
}

/** The issue's body: Factory's marker, then the item as the plan states it. */
function issueBody(
  objective: number,
  item: Plan["items"][number],
  plan: Plan,
): string {
  const titles = new Map(plan.items.map((each) => [each.id, each.title]));
  return [
    mark(objective, "item", item.id),
    `Work Item ${code(item.id)} of #${objective}. Factory tracks it here for display only: its questions and answers stay on #${objective}.`,
    "",
    `**Goal:** ${line(item.goal, 2000)}`,
    ...(item.acceptance.length
      ? [
          "",
          "**Acceptance**",
          ...item.acceptance
            .slice(0, 30)
            .map((criterion) => `- ${line(criterion, 500)}`),
        ]
      : []),
    ...(item.dependencies.length
      ? [
          "",
          `**Depends on:** ${item.dependencies
            .map(
              (dependency) =>
                `${code(dependency)} (${line(titles.get(dependency) ?? "", 120)})`,
            )
            .join(", ")}`,
        ]
      : []),
  ].join("\n");
}

function liveComment(objective: number, item: string, lines: string[]): string {
  return [
    mark(objective, "item-status", item),
    `### Work Item ${code(item)}`,
    "",
    ...lines.flatMap((each) => [each, ""]),
    `<sub>Factory edits this comment in place as the Work Item moves. Objective: #${objective}.</sub>`,
  ].join("\n");
}

/**
 * Model or worker text as prose on one line, cut to `max`: it can open no
 * HTML, mention no one (markdown.ts `prose`), and start no link
 * definition, so nothing in it is hidden.
 */
function line(value: string, max: number): string {
  return prose(cut(value, max)).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** One line, cut to `max` characters. */
function cut(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
