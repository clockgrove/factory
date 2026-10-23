import type { CoreConfig } from "./config.js";
import { hold, type Outcome, type Step, type Workflow } from "./engine.js";
import { type GitHub, GitHubError, type IssueComment } from "./github.js";
import type { GitHubModule } from "./github-sync.js";
import { ACCEPTED_AT, guarded } from "./planning/steps.js";
import type { Plan } from "./planning/types.js";
import { readQueue } from "./queue.js";
import { type RequestResult, refused, type StoredRequest } from "./requests.js";
import {
  type FrozenProvider,
  newObjective,
  type ObjectiveState,
  TERMINAL,
} from "./state.js";

/**
 * `factory reset N` (CORE.md#State). The service saves a resetting record
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
 * identity (`startedAt`), provider, Project card and comment cursor, and
 * the operator's pause or drain, so nothing the operator did or wrote is
 * lost meanwhile.
 */
export function resetRecord(
  issue: number,
  stored: StoredRequest,
  old: ObjectiveState | undefined,
  hadState: boolean,
  github: GitHubModule | undefined,
  provider: FrozenProvider | undefined,
): ObjectiveState {
  const now = new Date();
  const state = newObjective(issue, now, old?.provider ?? provider);
  state.status = "resetting";
  if (old?.startedAt) state.startedAt = old.startedAt;
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
    steps: (state) => (resetting(state) ? [rebuild] : inner.steps(state)),
    status: (state) => (resetting(state) ? "resetting" : inner.status(state)),
    ...(inner.upstream
      ? { upstream: (state, item) => inner.upstream!(state, item) }
      : {}),
    ...(inner.providers ? { providers: inner.providers } : {}),
  };
}

/** `rebuild`: read GitHub and replace the resetting record with what it finds. */
export function rebuildStep(github: GitHub, config: CoreConfig): Step {
  return {
    key: "rebuild",
    deadlineMs: 15 * 60_000,
    resource: "github",
    run: ({ state, signal }) =>
      guarded(config.repository, async (): Promise<Outcome> => {
        const record = state.kept[RESET] as ResetRecord;
        const found = await rebuildState(github, config, state, signal);
        const answered = (base: ObjectiveState, result: RequestResult) => ({
          ...base,
          appliedRequests: [
            ...base.appliedRequests,
            { id: record.request, ...result },
          ].slice(-50),
        });
        if ("version" in found)
          return {
            kind: "replace",
            state: answered(found, { message: "ok" }),
          };
        // Refused: the old state stands again, or, with none, the record
        // goes as if never admitted. With an unreadable old state and a
        // plan it can't read, only the operator can say.
        if (record.old)
          return { kind: "replace", state: answered(record.old, found) };
        if (found.code === "plan_unreadable")
          return hold(
            `${found.message} Answer retry once the plan comment is fixed or deleted (then Factory plans afresh); or cancel.`,
          );
        return {
          kind: "replace",
          state: answered(state, found),
          withdraw: true,
        };
      }),
  };
}

/**
 * The state rebuilt only from what Factory left on GitHub: its plan
 * comment (and its numbered `plan-data` continuations), the PRs whose head
 * is a Work Item branch, and its report comment. It reads and never
 * writes. A refusal comes back as a result with its code.
 *
 * Everything found is bound to this run and plan. Only comments by
 * Factory's own login count. The plan comment counts only while the old
 * state (when readable) had accepted a plan, and its data only from
 * Factory's own data block at the comment's end, or from the continuation
 * comments it names; anything else refuses with `plan_unreadable`. A PR
 * counts only if it was opened after the plan comment was last written and
 * names no other run (the newest wins); the report counts only if it is
 * newer than the plan comment and names no other run. The operator's own
 * choices (pause or drain, a provider switch, the Project card and the
 * comment cursor) carry over from the resetting record.
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
  // A replan or a re-run that hasn't accepted its plan yet: the comment is
  // an earlier plan's.
  const planComment =
    old && !old.done.plan
      ? undefined
      : marked(`<!-- factory:${issue}:plan -->`);
  if (!hadState && !planComment && !card)
    return refused(
      "no_factory_state",
      `Factory has no state, plan comment or Project card for #${issue}, so there is nothing to reset.`,
    );

  const state = newObjective(issue, new Date(requestedAt), record.provider);
  if (record.startedAt) state.startedAt = record.startedAt;
  // The run is known only from a readable old state; otherwise only the
  // times bind what is found.
  const run = old?.startedAt;
  if (record.control) state.control = record.control;
  state.appliedRequests = record.appliedRequests;
  const planAt =
    planComment && (planComment.updated_at ?? planComment.created_at);
  const module = record.modules.github as GitHubModule | undefined;
  if (module || card) {
    const base: GitHubModule = module ?? {
      itemId: card!.itemId,
      commentsSince: planAt ?? requestedAt,
      seen: card!.option,
      ...(card!.option ? { shown: card!.option } : {}),
      ...(card!.optionAt ? { shownAt: card!.optionAt } : {}),
    };
    state.modules.github = {
      ...base,
      ...(card ? { itemId: card.itemId, order: card.order } : {}),
    };
  }

  if (planComment && planAt) {
    const plan = planOf(issue, planComment.body, marked);
    if (typeof plan === "string")
      return refused(
        "plan_unreadable",
        `#${issue}'s plan comment can't be read (${plan}).`,
      );
    state.done.plan = plan;
    state.kept[ACCEPTED_AT] = planAt;
    for (const item of plan.items) {
      const merged = (
        await github.pullsByHead(`factory/${issue}/${item.id}`, signal)
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
      if (!merged?.merged_at || !mergeSha) {
        // Not merged in this plan: start fresh on the current start, so a
        // kept worktree on an older base is moved, not collected against
        // a base it wasn't built on.
        state.kept[`item:${item.id}:rebase`] = true;
        continue;
      }
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
      state.endedAt = state.updatedAt;
      return state;
    }
  }
  if (!open) {
    state.status = "cancelled";
    state.endedAt = state.updatedAt;
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
