import type { CoreConfig } from "./config.js";
import { hold, type Outcome, type Step, type Workflow } from "./engine.js";
import { type GitHub, GitHubError, type IssueComment } from "./github.js";
import type { GitHubModule } from "./github-sync.js";
import { readExpansionComments } from "./planning/expansion.js";
import { ACCEPTED_AT, currentPlan, decisionsOf } from "./planning/plan.js";
import type { Plan } from "./planning/types.js";
import { readQueue } from "./queue.js";
import { type RequestResult, refused, type StoredRequest } from "./requests.js";
import {
  deadlineAt,
  type Frozen,
  newObjective,
  type ObjectiveState,
  TERMINAL,
} from "./state.js";
import { fact, facts } from "./work/facts.js";

/**
 * `factory reset N` (DESIGN.md#State). The service saves a resetting record
 * at once (`resetRecord`); its one step, `rebuild`, reads GitHub and
 * replaces the record with the rebuilt state. The engine gives that step
 * its deadline, its retries and its questions like any other, cancel
 * works on it at once, and a crash anywhere reruns it: it only reads.
 */
export const RESET = "reset";

/** What the resetting record keeps for its rebuild (`kept.reset`). */
export interface ResetRecord {
  /** The reset request, answered when the rebuild lands. */
  request: string;
  requestedAt: string;
  /** Whether Factory had a state file for the issue (readable or not). */
  hadState: boolean;
  /** The old state, when it was readable: its operator choices carry over, and a refused reset restores it. */
  old?: ObjectiveState;
}

/**
 * The record that stands while the state is rebuilt: the old run's
 * identity (`startedAt`), deadline, frozen configuration, Project card and comment cursor, and
 * the operator's pause or drain, so nothing the operator did or wrote is
 * lost meanwhile.
 */
export function resetRecord(
  issue: number,
  stored: StoredRequest,
  old: ObjectiveState | undefined,
  hadState: boolean,
  github: GitHubModule | undefined,
  frozen: Frozen | undefined,
  /** `queue.objectiveDeadlineSeconds`: a reset with no readable old state admits the Objective, so its deadline starts now. */
  deadlineSeconds: number | undefined,
): ObjectiveState {
  const now = new Date();
  const state = newObjective(issue, now, old?.frozen ?? frozen);
  state.status = "resetting";
  if (old?.startedAt) state.startedAt = old.startedAt;
  // A readable old state keeps its deadline, or its lack of one.
  const deadline = old ? old.deadline : deadlineAt(now, deadlineSeconds);
  if (deadline) state.deadline = deadline;
  if (old?.control) state.control = old.control;
  if (old) state.appliedRequests = old.appliedRequests;
  const module = (old?.modules.github as GitHubModule | undefined) ?? github;
  if (module) {
    const { askedUnreadable: _asked, ...rest } = module;
    state.modules.github = rest;
  }
  const record: ResetRecord = {
    request: stored.id,
    requestedAt: stored.at,
    hadState,
    ...(old ? { old } : {}),
  };
  state.kept[RESET] = record;
  return state;
}

/** The workflow, with the rebuild as the only step while a reset stands. */
export function resettable(inner: Workflow, rebuild: Step): Workflow {
  const resetting = (state: ObjectiveState) =>
    Boolean(state.kept?.[RESET]) && !TERMINAL.includes(state.status);
  return {
    ...inner,
    steps: (state) => (resetting(state) ? [rebuild] : inner.steps(state)),
    status: (state) => (resetting(state) ? "resetting" : inner.status(state)),
  };
}

/** `rebuild`: read GitHub and replace the resetting record with what it finds. */
export function rebuildStep(github: GitHub, config: CoreConfig): Step {
  return {
    key: "rebuild",
    deadlineMs: 15 * 60_000,
    resource: "github",
    run: async ({ state, signal }): Promise<Outcome> => {
      const record = state.kept[RESET] as ResetRecord;
      const found = await rebuildState(github, config, state, signal);
      if ("version" in found)
        return {
          kind: "replace",
          build: (live) =>
            carried(found, live, record.request, { message: "ok" }),
        };
      // Refused: the old state stands again, or, with none, the record
      // goes as if never admitted. With an unreadable old state and a
      // plan it can't read, only the operator can say.
      if (record.old) {
        const old = record.old;
        return {
          kind: "replace",
          build: (live) => carried(old, live, record.request, found),
        };
      }
      if (found.code === "plan_unreadable")
        return hold(
          `${found.message} Answer retry once the plan comment is fixed or deleted (then Factory plans afresh); or cancel.`,
        );
      return {
        kind: "replace",
        build: (live) => carried(live, live, record.request, found),
        withdraw: true,
      };
    },
  };
}

/**
 * The record that replaces the resetting one: `base` (rebuilt from GitHub,
 * or the old state restored), with what the operator and the sync own
 * taken from the live record when the rebuild lands: a pause or drain, the
 * frozen configuration (a `switch` or `adopt`), the card and comment cursor, and every request
 * applied meanwhile, plus this reset's own answer.
 */
function carried(
  base: ObjectiveState,
  live: ObjectiveState,
  request: string,
  result: RequestResult,
): ObjectiveState {
  const state = structuredClone(base);
  if (live.control) state.control = live.control;
  else delete state.control;
  if (live.frozen) state.frozen = live.frozen;
  const kept = live.modules.github as GitHubModule | undefined;
  const card = base.modules.github as GitHubModule | undefined;
  if (kept)
    state.modules.github = {
      ...kept,
      ...(card ? { itemId: card.itemId, order: card.order ?? null } : {}),
    };
  // Attempt numbers never go back, so no attempt id is used twice.
  const runs = { ...base.stepRuns };
  for (const [key, run] of Object.entries(live.stepRuns ?? {}))
    runs[key] = { ...runs[key], n: Math.max(run.n, runs[key]?.n ?? 0) };
  if (Object.keys(runs).length) state.stepRuns = runs;
  state.appliedRequests = [
    ...live.appliedRequests.filter((applied) => applied.id !== request),
    { id: request, ...result },
  ].slice(-50);
  return state;
}

/**
 * The state rebuilt only from what Factory left on GitHub: its plan
 * comment (and its numbered `plan-data` continuations), the PRs whose head
 * is a Work Item branch, the expansion records posted before an expansion
 * child's first PR, and its report comment. It reads and never
 * writes. A refusal comes back as a result with its code.
 *
 * Everything found is bound to this run and plan. Only comments by
 * Factory's own login count. The plan comment counts only while the old
 * state (when readable) had accepted a plan, and its data only from
 * Factory's own data block at the comment's end, or from the continuation
 * comments it names; anything else refuses with `plan_unreadable`. A PR
 * counts only if it was opened after the plan comment was last written and
 * names no other run (the newest wins); the report counts only if it is
 * newer than the plan comment and names no other run. Without a readable old
 * state the run is unknown: then the plan comment, the PRs and the report
 * must be newer than when this run was queued (the card's queue time), and
 * with no queue time a plan comment refuses with `plan_unreadable`. An
 * Objective Factory has no state or plan comment for needs a card that is
 * queued. The operator's own choices (pause or drain, a switch or adopt,
 * the card and the comment cursor) are taken from the live record when the
 * rebuild lands (`carried`).
 *
 * The rebuilt state checks the issue again and then carries on: a merged
 * Work Item stays merged; every other item starts fresh on the current
 * start (its kept worktree is moved there). A reported Objective is done,
 * and a closed, unreported one is cancelled (its cleanup runs again).
 */
export async function rebuildState(
  github: GitHub,
  config: CoreConfig,
  record: ObjectiveState,
  signal: AbortSignal,
): Promise<ObjectiveState | RequestResult> {
  const issue = record.issue;
  const { old, hadState, requestedAt } = record.kept[RESET] as ResetRecord;
  let open: boolean;
  try {
    open = (await github.issue(issue, signal)).state === "open";
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404)
      return refused(
        "no_such_issue",
        `${config.repository} has no issue #${issue}.`,
      );
    throw error;
  }
  const card = (await readQueue(github, config, [issue], signal)).items.find(
    (item) => item.issue === issue,
  );
  const self = (await github.login(signal)).toLowerCase();
  const mine = (await github.comments(issue, undefined, signal)).filter(
    (comment) => comment.user?.login.toLowerCase() === self,
  );
  const marked = (marker: string): IssueComment | undefined =>
    mine.find((comment) => comment.body.startsWith(marker));
  const planned = marked(`<!-- factory:${issue}:plan -->`);
  // Only a card queued under this configuration admits an Objective
  // Factory has no state for; a candidate or inert card doesn't.
  const queued = card?.option === config.queue.options.queued;
  if (!hadState && !planned && !queued)
    return refused(
      "no_factory_state",
      `Factory has no state or plan comment for #${issue}, and its card isn't queued, so there is nothing to reset.`,
    );
  // The run is known only from a readable old state. Otherwise what is
  // found must be newer than when this run was queued (the card's queue
  // time); with neither, an earlier run's results can't be told apart.
  const run = old?.startedAt;
  const queuedAt =
    (record.modules.github as GitHubModule | undefined)?.queuedAt ??
    card?.optionAt ??
    undefined;
  if (!run && !queuedAt && planned)
    return refused(
      "plan_unreadable",
      `#${issue}'s plan comment can't be tied to this run: its state can't be read and its card has no queue time.`,
    );
  const planAt = planned && (planned.updated_at ?? planned.created_at);
  // A replan or a re-run that hasn't accepted its plan yet, or a plan from
  // before this run was queued: the comment is an earlier plan's.
  const planComment =
    (old && !currentPlan(old)) || (!run && planAt && planAt < queuedAt!)
      ? undefined
      : planned;

  const state = newObjective(issue, new Date(requestedAt), record.frozen);
  if (record.startedAt) state.startedAt = record.startedAt;
  if (record.deadline) state.deadline = record.deadline;
  if (card)
    state.modules.github = {
      itemId: card.itemId,
      order: card.order,
      commentsSince: planAt ?? requestedAt,
      seen: card.option,
      ...(card.option ? { shown: card.option } : {}),
    } satisfies GitHubModule;

  if (planComment && planAt) {
    const plan = planOf(issue, planComment.body, marked);
    if (typeof plan === "string")
      return refused(
        "plan_unreadable",
        `#${issue}'s plan comment can't be read (${plan}).`,
      );
    state.done.plan = plan;
    state.kept[ACCEPTED_AT] = planAt;
    // The operator's criterion decisions in the saved state stay: GitHub
    // doesn't hold them. They now decide under the rebuilt plan, still
    // only on the exact tree each was made on.
    for (const entry of (old && decisionsOf(old)) ?? []) {
      const moved = { ...entry, plan: planAt };
      Object.assign(
        state.kept,
        entry.itemId
          ? facts(
              {
                decisions: [
                  ...(fact(state, "decisions", entry.itemId) ?? []),
                  moved,
                ],
              },
              entry.itemId,
            )
          : facts({
              "final-review:decisions": [
                ...(fact(state, "final-review:decisions") ?? []),
                moved,
              ],
            }),
      );
    }
    // So do the operator's retirements: they now retire from the rebuilt
    // plan.
    for (const entry of (old && currentPlan(old)?.retired) ?? []) {
      const moved = { ...entry, plan: planAt };
      Object.assign(
        state.kept,
        entry.itemId
          ? facts(
              {
                retired: [
                  ...(fact(state, "retired", entry.itemId) ?? []),
                  moved,
                ],
              },
              entry.itemId,
            )
          : entry.command !== undefined
            ? facts({
                "final:retired": [
                  ...(fact(state, "final:retired") ?? []),
                  moved,
                ],
              })
            : facts({
                "final-review:retired": [
                  ...(fact(state, "final-review:retired") ?? []),
                  moved,
                ],
              }),
      );
    }
    // The PR that merged Work Item `id` in this plan and run, if any.
    const mergedPull = async (id: string) => {
      const merged = (
        await github.pullsByHead(`factory/${issue}/${id}`, signal)
      )
        .filter(
          (pull) =>
            pull.merged_at &&
            (pull.created_at ?? "") >= planAt &&
            ofRun(pull.body ?? "", /<!-- factory-run:(\S+) -->/, run),
        )
        .sort((a, b) =>
          (b.created_at ?? "").localeCompare(a.created_at ?? ""),
        )[0];
      const mergeSha =
        merged &&
        (merged.merge_commit_sha ??
          (await github.mergeCommitOf(merged.number, signal)));
      return merged?.merged_at && mergeSha ? { merged, mergeSha } : undefined;
    };
    // A discovery item's settled expansions, from the records posted
    // before its children's first PR (work/steps.ts postExpansion), when
    // one of those children merged in this plan and run: they join the
    // plan again with the same ids. The child's PR binds the record to
    // this plan (an id hashes the envelope, commit and batch), so an
    // older comment counts too. Otherwise the discovery observes again.
    const expansionText = (marker: string) => marked(marker)?.body;
    const restored = new Map<string, Awaited<ReturnType<typeof mergedPull>>>();
    for (const producer of new Set(
      (plan.expansions ?? []).map((entry) => entry.input.producerItemId),
    )) {
      const records = readExpansionComments(issue, producer, expansionText);
      const children = (records ?? []).flatMap((record) =>
        record.children.map((child) => child.id),
      );
      for (const id of children) restored.set(id, await mergedPull(id));
      if (children.some((id) => restored.get(id)))
        state.done[`item:${producer}:merge`] = {
          settled: "discovery",
          expansions: records,
        };
    }
    for (const item of currentPlan(state)!.items) {
      if (state.done[`item:${item.id}:merge`]) continue;
      const found = restored.has(item.id)
        ? restored.get(item.id)
        : await mergedPull(item.id);
      if (!found) {
        // Not merged in this plan: start fresh on the current start, so a
        // kept worktree on an older base is moved, not collected against
        // a base it wasn't built on.
        Object.assign(state.kept, facts({ rebase: true }, item.id));
        continue;
      }
      const { merged, mergeSha } = found;
      state.done[`item:${item.id}:publish`] = {
        pr: merged.number,
        head: merged.head.sha,
        merged: true,
      };
      state.done[`item:${item.id}:merge`] = {
        mergeSha,
        integratedSha: mergeSha,
        at: merged.merged_at,
      };
    }
    const reported = mine.some(
      (comment) =>
        comment.created_at >= planAt &&
        ofRun(
          comment.body,
          new RegExp(`^<!-- factory:${issue}:report(?::(\\S+))? -->`),
          run,
          true,
        ),
    );
    if (reported) {
      state.status = "done";
      state.done.report = true;
      state.ended = { at: state.updatedAt };
      return state;
    }
  }
  if (!open) {
    state.status = "cancelled";
    state.ended = { at: state.updatedAt };
  }
  return state;
}

/**
 * Whether `text` belongs to `run`: `pattern` must match when `required`,
 * and the run it names (its first group), if any, must be `run` when this
 * run is known.
 */
function ofRun(
  text: string,
  pattern: RegExp,
  run: string | undefined,
  required = false,
): boolean {
  const match = pattern.exec(text);
  if (!match) return !required;
  return !run || !match[1] || match[1] === run;
}

const DATA_OPEN = (label: string) =>
  `\n\n<details><summary>${label}</summary>\n\n\`\`\`json\n`;
const DATA_CLOSE = "\n```\n</details>";

/**
 * The plan in Factory's own data block (planning/steps.ts postPlan), or
 * joined from the continuation comments the plan comment names; a string
 * says why it can't be read. The data block is the end of the comment:
 * model-written text (titles, decisions) comes before it and can't stand
 * in for it, and the JSON itself holds no raw newline, so it can't close
 * the block early. A continuation comment must be exactly its marker and
 * its block.
 */
function planOf(
  issue: number,
  body: string,
  marked: (marker: string) => IssueComment | undefined,
): Plan | string {
  let json: string | undefined;
  const parts = new RegExp(
    `\\n\\nPlan data: in the (\\d+) comments marked \`factory:${issue}:plan-data:1\` to \`:(\\d+)\` below; join their JSON in order\\.$`,
  ).exec(body);
  if (parts) {
    const count = Number(parts[1]);
    if (count < 1 || String(count) !== parts[2])
      return "its continuation count is inconsistent";
    json = "";
    for (let part = 1; part <= count; part++) {
      const marker = `<!-- factory:${issue}:plan-data:${part} -->`;
      const comment = marked(marker);
      const head = `${marker}${DATA_OPEN(`Plan data, part ${part} of ${count}`)}`;
      if (!comment?.body.startsWith(head) || !comment.body.endsWith(DATA_CLOSE))
        return `plan-data part ${part} is missing or not Factory's own`;
      const text = comment.body.slice(head.length, -DATA_CLOSE.length);
      if (text.includes("\n")) return `plan-data part ${part} is malformed`;
      json += text;
    }
  } else if (body.endsWith(DATA_CLOSE)) {
    const open = DATA_OPEN("Plan data");
    const at = body.lastIndexOf(open);
    const text = at < 0 ? "" : body.slice(at + open.length, -DATA_CLOSE.length);
    if (at < 0 || text.includes("\n"))
      return "its data block is not Factory's own";
    json = text;
  }
  if (json === undefined) return "it carries no plan data block";
  let plan: Plan;
  try {
    plan = JSON.parse(json) as Plan;
  } catch (error) {
    return String(error);
  }
  const valid =
    typeof plan?.base === "string" &&
    Array.isArray(plan.items) &&
    plan.items.every(
      (item) =>
        typeof item?.id === "string" &&
        Array.isArray(item.ownedPaths) &&
        Array.isArray(item.dependencies),
    );
  return valid ? plan : "its data is not a plan";
}
