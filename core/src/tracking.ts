import { createHash } from "node:crypto";
import type { QueueOption } from "./config.js";
import { crashPoint } from "./crash.js";
import {
  type GitHub,
  GitHubError,
  type IssueSummary,
  issueGone,
  TransientError,
} from "./github.js";
import {
  addLabels,
  ensureRoles,
  objectiveRole,
  PRIORITY,
  type RoleTypes,
  removeLabel,
  WORK_ITEM_LABEL,
} from "./github-roles.js";
import { code, inert, mark, prose } from "./markdown.js";
import { currentPlan } from "./planning/plan.js";
import type { Plan } from "./planning/types.js";
import { addCard, cardProject } from "./queue.js";
import { CLOCK_SKEW_MS, type ObjectiveState, TERMINAL } from "./state.js";
import { itemRows } from "./status.js";
import { errorMessage } from "./text.js";

/**
 * Work Item issues: one display-only issue per Work Item of the plan in
 * force (planning/plan.ts `currentPlan`), a sub-issue of the Objective,
 * with blocked-by links that mirror the plan's dependencies, the
 * configured native type, the `factory:work-item` label, the Objective's
 * priority labels, a card on the Objective's Project and one live
 * comment that shows the item's state. The Objective gets its own role
 * once per run: the `factory:objective` label and its type when it has
 * none (github-roles.ts); its priority labels are read then for its
 * items. An item's issue is closed as completed when the item merges, and as not planned, with the reason in its comment, when
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
 * A create repeated because GitHub's list hadn't shown the first yet
 * makes a duplicate: the time the first began is kept (`duplicates`),
 * and once SWEEP_AFTER_MS has passed, or the Objective has ended, one
 * list of Factory's labelled issues since then finds every issue with an
 * item's marker. Each one that isn't the item's recorded issue, and that
 * still reads as Factory wrote it, is closed as not planned with a comment
 * naming the issue Factory keeps; an edited copy only gets that comment,
 * as a possible duplicate, and stays open.
 *
 * A refusal on one item's issue (deleted, locked, transferred) stops
 * only that issue's writes: the others are still written and closed.
 * Only a refusal of the Objective-wide calls (the lists, a create) gives
 * tracking up for the run (github-sync.ts).
 */

/** What was written for one Work Item's issue. */
export interface ItemIssue {
  /** The issue's number, database id and node id (a Project card takes it). */
  issue: number;
  id: number;
  node?: string;
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
  /** The priority labels it has, as Factory last wrote or found them. */
  labels?: string[];
  /** It has its card on the Project. */
  card?: true;
  /** The card's Project item id: its Factory field shows the item's phase. */
  cardItem?: string;
  /** The Factory option last written on the card. */
  status?: QueueOption;
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
  /**
   * A create may have been repeated: when (host time) the earliest
   * repeated one's first create began. Swept for duplicates once.
   */
  duplicates?: string;
  /** The repository doesn't offer the native type, or refused it: not tried again this run. */
  untyped?: true;
  /** The Objective has its role for this run, and the priority labels its items inherit. */
  objective?: { priority: string[] };
  /** The Project the Objective's card is on, where the item cards go; null when it has none. */
  project?: string | null;
  /** The Project refused a card: not tried again this run. */
  uncarded?: true;
  /** The cards aren't on the queue's Project, so no Factory field shows their phase. */
  statusless?: true;
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
  /** The card's Factory option for the item's phase; none before it starts, or skipped. */
  status?: QueueOption;
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
    // As the Objective's card, by the item's phase.
    const status: QueueOption | undefined =
      row.phase === "merged"
        ? "done"
        : row.phase === "skipped" || row.phase === "pending"
          ? undefined
          : ended
            ? "cancelled"
            : row.hold
              ? "holding"
              : "building";
    items.set(item.id, {
      planned: !ended,
      ...(status ? { status } : {}),
      // A title is plain text, never Markdown: cut to one line, and it
      // references and mentions nothing (markdown.ts inert). Every create
      // and edit of the issue uses this title.
      title: inert(cut(item.title, 200)),
      body: issueBody(objective, item, plan!),
      dependencies: [...item.dependencies].sort(),
      comment: liveComment(objective, item.id, [
        `**Phase:** ${prose(row.phase)}`,
        `**PR:** ${row.pr === null ? "none yet" : `#${row.pr}`}`,
        ...(row.repairs ? [`**Repairs:** ${row.repairs}`] : []),
        ...(row.hold
          ? [
              state.holds.find((open) => open.id === row.hold)?.cause ===
              "failure"
                ? `**Failed:** ${code(row.hold)} on #${objective} names the failure, its evidence and the answers; answer it there.`
                : `**Question:** ${code(row.hold)} is open on #${objective}; answer it there.`,
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
        status: "cancelled",
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
    ...(tracking.duplicates ? { duplicates: tracking.duplicates } : {}),
  };
}

/** How long after a repeated create the duplicates are swept: GitHub's lists lag by seconds. */
const SWEEP_AFTER_MS = 10 * 60_000;

/** The least wait before a sweep, even once the Objective has ended: the lag the list just showed. */
const SWEEP_LAG_MS = 2 * 60_000;

/**
 * Whether the duplicate sweep is due: SWEEP_AFTER_MS on, or once the
 * Objective has ended, but never within SWEEP_LAG_MS, when the list may
 * still not show the first create.
 */
function sweepDue(state: ObjectiveState, now: number): boolean {
  const from = trackingOf(state)?.duplicates;
  if (from === undefined) return false;
  const waited = now - Date.parse(from);
  return (
    waited >= SWEEP_AFTER_MS ||
    (TERMINAL.includes(state.status) && waited >= SWEEP_LAG_MS)
  );
}

/** Whether a tracking pass has a write to make. */
export function trackingDue(state: ObjectiveState, now = Date.now()): boolean {
  const tracking = trackingOf(state);
  if (Object.keys(tracking?.creating ?? {}).length) return true;
  if (sweepDue(state, now)) return true;
  const all = wanted(state);
  if (all.size && !tracking?.objective) return true;
  const priority = tracking?.objective?.priority.join("\n");
  for (const [id, want] of all) {
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
      want.status &&
      has.card &&
      !tracking?.statusless &&
      has.status !== want.status
    )
      return true;
    if (
      has.comment !== hash(want.comment) ||
      Boolean(has.closed) !== Boolean(want.close) ||
      (want.planned &&
        (has.body !== hash(want.title, want.body) ||
          !has.parent ||
          (!has.typed && !tracking.untyped) ||
          (has.labels ?? []).join("\n") !== priority ||
          (!has.card && tracking.project !== null && !tracking.uncarded) ||
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
  /** The native type to give each role's issue (config.ts `tracking.issueType`). */
  issueType: RoleTypes;
  /** Save a change to the recorded tracking (made if absent). */
  save(change: (tracking: Tracking) => void): void;
  /** Log an event on the Objective's run log. */
  log(event: Record<string, unknown>): void;
  signal: AbortSignal;
  /**
   * The queue's Project and how to set a card's Factory option on it
   * (queue.ts QueueDisplay); absent, the cards show no phase.
   */
  cardStatus?: {
    project: string;
    set(item: string, option: QueueOption, signal: AbortSignal): Promise<void>;
  };
}

/**
 * One pass: every write the recorded state shows is due, in an order a
 * crash can stop anywhere. The roles (once per installation), the
 * Objective's role (once per run), create (recorded as `creating`
 * first), then per issue: its title and body, its type, its priority
 * labels, its card, the sub-issue link, the blocked-by links, the live
 * comment, and the close (or a reopen).
 * A refusal on one issue is recorded on it, and the pass goes on.
 */
export async function track(context: TrackContext): Promise<void> {
  const { github, signal } = context;
  const state = context.state();
  const objective = state.issue;
  const issueMark = (id: string) => mark(objective, "item", id);
  const record = () => trackingOf(context.state()) ?? { items: {} };
  const want = wanted(state);
  const roles = await ensureRoles(github, context.issueType);
  if (!record().objective) {
    const role = await objectiveRole(
      github,
      objective,
      roles.types.objective,
      signal,
    );
    if (!roles.types.objective || role.typeRefused)
      context.log({
        event: "issue-type-missing",
        role: "objective",
        type: context.issueType.objective,
        ...(role.typeRefused ? { status: role.typeRefused.status } : {}),
      });
    context.save((tracking) => {
      tracking.objective = { priority: role.priority };
    });
  }
  const priority = record().objective!.priority;
  if (!roles.types.workItem && !record().untyped) {
    context.save((tracking) => {
      tracking.untyped = true;
    });
    context.log({
      event: "issue-type-missing",
      role: "workItem",
      type: context.issueType.workItem,
    });
  }
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
    for (const [id, at] of creating) {
      const issue = record().items[id]
        ? undefined
        : await github.markedIssue(found, issueMark(id), signal);
      context.save((tracking) => {
        if (issue) tracking.items[id] = adopted(issue);
        if (tracking.items[id] || !want.get(id)?.planned) created(tracking, id);
        // Not found yet, and created again below: the first may exist.
        else if (
          !tracking.duplicates ||
          Date.parse(at) < Date.parse(tracking.duplicates)
        )
          tracking.duplicates = at;
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
        labels: [WORK_ITEM_LABEL, ...priority],
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
  if (
    record().project === undefined &&
    [...want].some(([id, item]) => item.planned && !record().items[id]?.card)
  ) {
    const card = (state.modules.github as { itemId?: string } | undefined)
      ?.itemId;
    const project = card ? await cardProject(github, card, signal) : null;
    context.save((tracking) => {
      tracking.project = project;
    });
  }
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

  if (sweepDue(context.state(), Date.now())) await sweep();

  /**
   * Close every issue with an item's marker that isn't the item's
   * recorded issue: duplicates a repeated create made.
   */
  async function sweep(): Promise<void> {
    const from = record().duplicates!;
    const listed = await github.issuesByLabel(
      WORK_ITEM_LABEL,
      new Date(Date.parse(from) - CLOCK_SKEW_MS).toISOString(),
      signal,
    );
    for (const [id, kept] of Object.entries(record().items))
      for (const duplicate of await github.markedIssues(
        listed,
        issueMark(id),
        signal,
      )) {
        if (duplicate.number === kept.issue || duplicate.state !== "open")
          continue;
        // Only an exact copy is closed: one a person edited may be in use.
        const exact = [
          kept.body,
          ...(want.get(id)?.title
            ? [hash(want.get(id)!.title, want.get(id)!.body)]
            : []),
        ].includes(
          hash(duplicate.title, (duplicate.body ?? "").replace(/\r\n/g, "\n")),
        );
        const about = `#${kept.issue}, which Factory keeps for Work Item ${code(id)} of #${objective}`;
        try {
          if (exact) {
            const marker = mark(
              objective,
              "duplicate",
              String(duplicate.number),
            );
            await github.ensureComment(
              duplicate.number,
              marker,
              `${marker}\nDuplicate of ${about}.`,
              "sync:item-duplicate:comment",
              signal,
            );
            await github.closeIssue(
              duplicate.number,
              "not_planned",
              "sync:item-duplicate:close",
              signal,
            );
          } else {
            const marker = mark(
              objective,
              "possible-duplicate",
              String(duplicate.number),
            );
            await github.ensureComment(
              duplicate.number,
              marker,
              `${marker}\nPossible duplicate of ${about}. It was edited after Factory opened it, so Factory leaves it open: close it once nobody needs it.`,
              "sync:item-duplicate:comment",
              signal,
            );
          }
          context.log({
            event: exact
              ? "item-issue-duplicate-closed"
              : "item-issue-duplicate-left-open",
            item: id,
            issue: duplicate.number,
            kept: kept.issue,
          });
        } catch (error) {
          if (!refusal(error)) throw error;
          context.log({
            event: "item-issue-refused",
            item: id,
            issue: duplicate.number,
            status: error.status,
            duplicate: true,
          });
        }
      }
    context.save((tracking) => {
      delete tracking.duplicates;
    });
  }

  /** The issue's body, type, labels, card, links, live comment and reopen, as due. */
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
        await setType(context, roles.types.workItem!, has, () =>
          update((issue) => {
            issue.typed = true;
          }),
        );
      const labels = has.labels ?? [];
      if (labels.join("\n") !== priority.join("\n")) {
        const add = priority.filter((label) => !labels.includes(label));
        if (add.length)
          await addLabels(
            github,
            has.issue,
            add,
            "sync:item-issue:label",
            signal,
          );
        for (const label of labels)
          if (!priority.includes(label))
            await removeLabel(
              github,
              has.issue,
              label,
              "sync:item-issue:label",
              signal,
            );
        update((issue) => {
          issue.labels = priority;
        });
      }
      const project = record().project;
      if (!has.card && project && !record().uncarded)
        await card(has, project, update);
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
    if (item.status && has.card && has.status !== item.status)
      await status(has, item.status, update);
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

  /**
   * The card's Factory option, as the Objective's card shows its own
   * phase. Only on the queue's Project, where the field is; the queue's
   * reads leave out the Work Item label, so a card never reaches the queue.
   */
  async function status(
    has: ItemIssue,
    option: QueueOption,
    update: (change: (issue: ItemIssue) => void) => void,
  ): Promise<void> {
    const display = context.cardStatus;
    const project = record().project;
    if (record().statusless) return;
    if (!display || !project || project !== display.project) {
      context.save((tracking) => {
        tracking.statusless = true;
      });
      return;
    }
    // A card recorded before its item id was: the Project returns it again.
    const item =
      has.cardItem ??
      (await addCard(github, project, has.node ?? (await node(has)), signal));
    try {
      crashPoint("sync:item-issue:status:before");
      await display.set(item, option, signal);
      crashPoint("sync:item-issue:status:after");
    } catch (error) {
      // The field or its option, not this issue, refused (or is missing):
      // no card shows a phase this run, and the issue's other writes go on.
      if (
        error instanceof TransientError ||
        (error instanceof GitHubError && error.status === 401) ||
        signal.aborted
      )
        throw error;
      context.save((tracking) => {
        tracking.statusless = true;
      });
      context.log({
        event: "item-status-refused",
        issue: has.issue,
        error: errorMessage(error),
      });
      return;
    }
    update((issue) => {
      issue.cardItem = item;
      issue.status = option;
    });
  }

  /** The issue's node id, which a Project card takes. */
  async function node(has: ItemIssue): Promise<string> {
    return (
      await github.rest<{ node_id: string }>(
        "GET",
        `/repos/${github.repository}/issues/${has.issue}`,
        undefined,
        signal,
      )
    ).node_id;
  }

  /**
   * The issue's card on the Project. A refusal (no access to the Project,
   * a Project that's gone) is logged and not tried again this run: the
   * issue stays tracked without its card.
   */
  async function card(
    has: ItemIssue,
    project: string,
    update: (change: (issue: ItemIssue) => void) => void,
  ): Promise<void> {
    const content = has.node ?? (await node(has));
    let item: string;
    try {
      item = await addCard(github, project, content, signal);
    } catch (error) {
      if (
        error instanceof TransientError ||
        (error instanceof GitHubError && error.status === 401) ||
        signal.aborted
      )
        throw error;
      context.save((tracking) => {
        tracking.uncarded = true;
      });
      context.log({
        event: "item-card-refused",
        issue: has.issue,
        error: errorMessage(error),
      });
      return;
    }
    update((issue) => {
      issue.card = true;
      issue.node = content;
      issue.cardItem = item;
    });
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
  type: string,
  issue: ItemIssue,
  done: () => void,
): Promise<void> {
  try {
    await context.github.editIssue(
      issue.issue,
      { type },
      "sync:item-issue:edit",
      context.signal,
    );
    done();
  } catch (error) {
    if (
      !(error instanceof GitHubError) ||
      error.status < 400 ||
      error.status >= 500 ||
      error.status === 401
    )
      throw error;
    context.save((tracking) => {
      tracking.untyped = true;
    });
    context.log({
      event: "item-issue-untyped",
      type,
      status: error.status,
    });
  }
}

/** An issue found or created: recorded as it is on GitHub. */
function adopted(
  issue: IssueSummary & {
    node_id?: string;
    labels?: ({ name?: string } | string)[];
  },
): ItemIssue {
  return {
    issue: issue.number,
    id: issue.id,
    ...(issue.node_id ? { node: issue.node_id } : {}),
    body: hash(issue.title, issue.body ?? ""),
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter((label) => PRIORITY.test(label))
      .sort(),
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
 * HTML, mention or reference nothing (markdown.ts `prose`, `inert`), and
 * start no link definition, so nothing in it is hidden.
 */
function line(value: string, max: number): string {
  return prose(inert(cut(value, max)))
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** One line, cut to `max` characters. */
function cut(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
