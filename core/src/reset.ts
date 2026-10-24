import type { CoreConfig } from "./config.js";
import { hold, type Outcome, type Step, type Workflow } from "./engine.js";
import {
  type GitHub,
  GitHubError,
  type IssueComment,
  type PullRequest,
  sameLogin,
  TransientError,
} from "./github.js";
import type { GitHubModule } from "./github-sync.js";
import { mark, readRunMarks, runMarks } from "./markdown.js";
import { checkPlan } from "./planning/checks.js";
import { BaseFiles, finalCommands } from "./planning/facts.js";
import {
  ACCEPTED_AT,
  currentPlan,
  decisionsOf,
  generationInputs,
  position,
} from "./planning/plan.js";
import { decisions, planningFacts, postPlan } from "./planning/steps.js";
import type { Draft, Plan, Retirement } from "./planning/types.js";
import { type StatusRecord, statusRecord } from "./progress.js";
import { type QueueItem, readQueue } from "./queue.js";
import { type RequestResult, refused, type StoredRequest } from "./requests.js";
import type { CriterionDecision } from "./review/result.js";
import {
  deadlineAt,
  type Frozen,
  newObjective,
  type ObjectiveState,
  TERMINAL,
} from "./state.js";
import { fact, facts } from "./work/facts.js";

/**
 * `factory reset N` (docs/reference/state.md#State). The service saves a resetting record
 * at once (`resetRecord`); its one step, `rebuild`, reads GitHub and
 * replaces the record with the rebuilt state. The engine gives that step
 * its deadline, its retries and its questions like any other, cancel
 * works on it at once, and a crash anywhere reruns it: it only reads.
 *
 * A plan read back from GitHub is never trusted as it is: anyone who can
 * write to the repository can edit Factory's comments. The rebuilt state
 * keeps it aside (`REBUILT`); the Objective is checked again, the plan
 * runs through the plan checks against the Objective as GitHub shows it
 * now (`reviewed`, as round `plan:1:1`) and then through plan review like
 * any draft. Only once planning accepts that round does `land` make it the
 * plan and restore what merged under it; a plan that review changed is a
 * new plan, and nothing of the old one carries over.
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

/** The rebuilt plan and what it restores once plan review accepts it. */
export const REBUILT = "reset:plan";

/** The planning round a rebuilt plan stands as (planning/steps.ts `planningStep`). */
const ROUND = "plan:1:1";

/** What a rebuilt plan restores once planning accepts it (`kept[REBUILT]`). */
interface Rebuilt {
  /** The plan as its comment holds it. */
  plan: Plan;
  /** When it was accepted (planning/plan.ts ACCEPTED_AT): it names the plan. */
  accepted: string;
  /** The PR each merged Work Item merged with. */
  merged: Record<
    string,
    { pr: number; head: string; mergeSha: string; at: string }
  >;
  decisions: CriterionDecision[];
  retired: Retirement[];
}

/**
 * What the live status comment records (progress.ts `StatusRecord`): the
 * plan's criterion decisions and retirements, or a rebuilt plan's until
 * it lands, so a second reset meanwhile still finds them.
 */
export function statusRecordOf(state: ObjectiveState): StatusRecord {
  const plan = currentPlan(state);
  const rebuilt = state.kept[REBUILT] as Rebuilt | undefined;
  return !plan && rebuilt
    ? { decisions: rebuilt.decisions, retired: rebuilt.retired }
    : { decisions: decisionsOf(state), retired: plan?.retired ?? [] };
}

/**
 * The workflow, with the rebuild as the only step while a reset stands,
 * and a rebuilt plan's check and landing in place of planning's own
 * first round and acceptance.
 */
export function resettable(
  inner: Workflow,
  github: GitHub,
  config: CoreConfig,
): Workflow {
  const rebuild = rebuildStep(github, config);
  const resetting = (state: ObjectiveState) =>
    Boolean(state.kept?.[RESET]) && !TERMINAL.includes(state.status);
  return {
    ...inner,
    steps: (state) => {
      if (resetting(state)) return [rebuild];
      const rebuilt = state.kept?.[REBUILT] as Rebuilt | undefined;
      if (
        rebuilt &&
        state.done.check &&
        !currentPlan(state) &&
        !TERMINAL.includes(state.status)
      ) {
        if (!state.done[ROUND]) return [reviewed(rebuilt, config)];
        const { g, n } = position(state);
        const decided = state.done["decide:1:1"] as
          | { accept?: true }
          | undefined;
        if (g === 1 && n === 1 && decided?.accept)
          return [land(rebuilt, github, config, inner)];
      }
      return inner.steps(state);
    },
    status: (state) => (resetting(state) ? "resetting" : inner.status(state)),
  };
}

/** `rebuild`: read GitHub and replace the resetting record with what it finds. */
function rebuildStep(github: GitHub, config: CoreConfig): Step {
  return {
    key: "rebuild",
    deadlineMs: 15 * 60_000,
    resource: "github",
    run: async ({ state, signal }): Promise<Outcome> => {
      const record = state.kept[RESET] as ResetRecord;
      const found = await rebuildState(github, config, state, signal);
      if ("state" in found)
        return {
          kind: "replace",
          build: (live) =>
            carried(found.state, live, record.request, {
              message: found.message,
            }),
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
 * `plan:1:1` for a rebuilt plan: the plan checks (planning/checks.ts
 * `checkPlan`) on it against the Objective and
 * base the check step just read, with no planner call. Its findings go to
 * the planner like any round's; a clean round goes to plan review.
 */
function reviewed(rebuilt: Rebuilt, config: CoreConfig): Step {
  return {
    key: ROUND,
    deadlineMs: 10 * 60_000,
    run: async ({ state, signal }): Promise<Outcome> => {
      const inputs = generationInputs(state, 1);
      const files = new BaseFiles(config.checkout, inputs.base, signal);
      const built = await planningFacts(state, inputs, files, config);
      if ("problems" in built)
        return hold(
          `This Objective needs fixing before Factory can check the plan it rebuilt from GitHub:\n${built.problems.map((p) => `- ${p}`).join("\n")}\n\nEdit the issue, then answer \`replan\`.`,
          ["replan", "cancel"],
        );
      const {
        finalCommands: _commands,
        decisions: _decisions,
        reviewArtifacts: _artifacts,
        retired: _retired,
        ...draft
      } = rebuilt.plan;
      const round: Draft = { ...draft, base: inputs.base };
      const findings = await checkPlan(round, built.facts, files);
      return {
        kind: "done",
        result: { draft: round, ...(findings.length ? { findings } : {}) },
      };
    },
  };
}

/**
 * `plan` for a rebuilt plan that planning accepted as it was: it is the
 * plan again, under its own acceptance, on the base its merged items built
 * on; the plan comment shows it (an edit only if it changed), and what
 * merged under it is restored (`restore`).
 */
function land(
  rebuilt: Rebuilt,
  github: GitHub,
  config: CoreConfig,
  inner: Workflow,
): Step {
  return {
    key: "plan",
    deadlineMs: 10 * 60_000,
    resource: "github",
    run: async ({ state, signal }): Promise<Outcome> => {
      const inputs = generationInputs(state, 1);
      const { draft } = state.done[ROUND] as { draft: Draft };
      const plan: Plan = {
        ...draft,
        base: rebuilt.plan.base,
        finalCommands: finalCommands(
          inputs.shown.blocks,
          config.finalValidation.requiredCommands,
        ),
        decisions: decisions(state),
        ...(inputs.reviewArtifacts.length
          ? { reviewArtifacts: inputs.reviewArtifacts }
          : {}),
      };
      await postPlan({ github }, state, plan, signal, {
        accepted: rebuilt.accepted,
      });
      return {
        kind: "replace",
        build: (live) => {
          delete live.attempts.plan;
          delete live.kept[REBUILT];
          restore(live, plan, rebuilt);
          live.status = live.holds.length ? "holding" : inner.status(live);
          return live;
        },
      };
    },
  };
}

/**
 * Make `plan` the accepted plan under its own acceptance, and restore what
 * GitHub shows of it: each merged Work Item stays merged (its PR and merge
 * commit), and every other item starts fresh on the current
 * start (its kept worktree is moved there). The operator's criterion
 * decisions and retirements decide again under it, each still only on the
 * exact tree it was made on.
 */
function restore(state: ObjectiveState, plan: Plan, rebuilt: Rebuilt): void {
  state.done.plan = plan;
  state.kept[ACCEPTED_AT] = rebuilt.accepted;
  for (const item of currentPlan(state)!.items) {
    const merged = rebuilt.merged[item.id];
    if (state.done[`item:${item.id}:merge`]) continue;
    if (!merged) {
      Object.assign(state.kept, facts({ rebase: true }, item.id));
      continue;
    }
    state.done[`item:${item.id}:publish`] = {
      pr: merged.pr,
      head: merged.head,
      merged: true,
    };
    state.done[`item:${item.id}:merge`] = {
      mergeSha: merged.mergeSha,
      integratedSha: merged.mergeSha,
      at: merged.at,
    };
  }
  for (const entry of rebuilt.decisions)
    Object.assign(
      state.kept,
      entry.itemId
        ? facts(
            {
              decisions: [
                ...(fact(state, "decisions", entry.itemId) ?? []),
                entry,
              ],
            },
            entry.itemId,
          )
        : facts({
            "final-review:decisions": [
              ...(fact(state, "final-review:decisions") ?? []),
              entry,
            ],
          }),
    );
  if (rebuilt.retired.length)
    Object.assign(state.kept, facts({ "final:retired": rebuilt.retired }));
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

/** What `rebuild` read from GitHub, for `rebuildFrom`. */
export interface GitHubRead {
  /** The issue is open. */
  open: boolean;
  /** Its card on the Project, if it has one. */
  card?: QueueItem;
  /** The login Factory acts as: only its comments count. */
  self: string;
  /** Every comment on the issue. */
  comments: IssueComment[];
  /** The PRs whose head is each branch `pullBranches` named, a merged one with its merge commit. */
  pulls: Record<string, PullRequest[]>;
}

/**
 * Read what Factory left on GitHub and rebuild the state from it
 * (`rebuildFrom`). It reads and never writes.
 */
export async function rebuildState(
  github: GitHub,
  config: CoreConfig,
  record: ObjectiveState,
  signal: AbortSignal,
): Promise<{ state: ObjectiveState; message: string } | RequestResult> {
  const issue = record.issue;
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
  const read = await readQueue(github, config, [issue], signal);
  if (read.unread.includes(issue))
    throw new TransientError(
      `GitHub couldn't read #${issue}'s card: ${read.skipped.find((s) => s.issue === issue)?.error}`,
    );
  const card = read.items.find((item) => item.issue === issue);
  const self = await github.login(signal);
  const comments = await github.comments(issue, undefined, signal);
  const pulls: GitHubRead["pulls"] = {};
  for (const branch of pullBranches(record, comments, self)) {
    pulls[branch] = await github.pullsByHead(branch, signal);
    for (const pull of pulls[branch])
      if (pull.merged_at && !pull.merge_commit_sha)
        pull.merge_commit_sha =
          (await github.mergeCommitOf(pull.number, signal)) ?? null;
  }
  return rebuildFrom(
    record,
    { open, ...(card ? { card } : {}), self, comments, pulls },
    config,
  );
}

/** Factory's own comments, oldest first. */
function own(read: Pick<GitHubRead, "comments" | "self">): IssueComment[] {
  return read.comments
    .filter(
      (comment) => comment.user && sameLogin(comment.user.login, read.self),
    )
    .sort((a, b) => a.id - b.id);
}

/** The Work Item branches whose PRs `rebuildFrom` needs: the run's plan's items. */
export function pullBranches(
  record: ObjectiveState,
  comments: IssueComment[],
  self: string,
): string[] {
  const issue = record.issue;
  const mine = own({ comments, self });
  const { plan } = findRun(
    issue,
    mine,
    (record.kept[RESET] as ResetRecord).old,
  );
  if (typeof plan !== "object") return [];
  return plan.plan.items.map((item) => `factory/${issue}/${item.id}`);
}

/**
 * The state rebuilt only from what Factory left on GitHub (`read`): its
 * plan comment (and its numbered `plan-data` continuations), the PRs whose
 * head is a Work Item branch, its live status comment's record
 * (progress.ts `StatusRecord`) and its report. Pure: a refusal comes back
 * as a result with its code.
 *
 * Everything found is bound to one run and one plan by the identities
 * Factory writes, never by a time: only comments by Factory's own login
 * count, and the run is the old state's (when readable), else the newest
 * one Factory's comments name (`findRun`). The plan comment counts only
 * when it names that run (and, with a readable old state, that state had
 * accepted a plan or kept a rebuilt one); its data only from Factory's own data block at the
 * comment's end, or from the continuation comments it names; anything
 * else refuses with `plan_unreadable`. A PR counts only when its body
 * names that run and plan (markdown.ts `runMarks`; the newest wins), the
 * status record only that plan's entries, and the report only that
 * run's. An Objective Factory has no state or
 * run on GitHub for needs a card that is queued. The operator's own
 * choices (pause or drain, a switch or adopt, the card and the comment
 * cursor) are taken from the live record when the rebuild lands
 * (`carried`).
 *
 * The rebuilt run then checks the issue again. A reported Objective is
 * done, and a closed,
 * unreported one is cancelled (its cleanup runs again); each shows its
 * plan and merges as they were. Any other run with a plan keeps it aside
 * for the plan checks and plan review (`REBUILT`); its planning decisions
 * stand as generation 0's, which planning reads with every saved decision
 * (planning/steps.ts `decisions`) and no generation counts from. A run
 * with no plan of its own plans afresh. Open questions are asked again by
 * the steps that asked them, and repair counts start again.
 */
export function rebuildFrom(
  record: ObjectiveState,
  read: GitHubRead,
  config: Pick<CoreConfig, "queue">,
): { state: ObjectiveState; message: string } | RequestResult {
  const issue = record.issue;
  const { old, hadState, requestedAt } = record.kept[RESET] as ResetRecord;
  const mine = own(read);
  const options = config.queue.options;
  const { run, plan } = findRun(issue, mine, old);
  // Only a card queued under this configuration admits an Objective
  // Factory has no state for; a candidate or inert card doesn't.
  if (!hadState && !run && read.card?.option !== options.queued)
    return refused(
      "no_factory_state",
      `Factory has no state for #${issue}, its comments name no run of it, and its card isn't queued, so there is nothing to reset.`,
    );
  const ended =
    run &&
    mine.some((comment) => comment.body.startsWith(mark(issue, "report", run)));
  if (typeof plan === "string" && !ended)
    return refused(
      "plan_unreadable",
      `#${issue}'s plan comment can't be read (${plan}).`,
    );

  const state = newObjective(issue, new Date(requestedAt), record.frozen);
  state.startedAt = run ?? record.startedAt;
  if (record.deadline) state.deadline = record.deadline;
  if (ended || !read.open) {
    state.status = ended ? "done" : "cancelled";
    if (ended) state.done.report = true;
    state.ended = { at: state.updatedAt };
  }
  if (read.card) {
    const { card } = read;
    // Comments are read from after the newest one now: none of them acts
    // again (a question they answer is asked again).
    const newest = read.comments.reduce(
      (at, comment) => (comment.created_at > at ? comment.created_at : at),
      "",
    );
    const terminal = TERMINAL.includes(state.status);
    const module: GitHubModule = {
      itemId: card.itemId,
      order: card.order,
      commentsSince: newest
        ? new Date(Date.parse(newest) + 1).toISOString()
        : requestedAt,
      seen: card.option,
    };
    // A card the operator queued shows nothing of Factory's: for a
    // finished run it is a queue again, over the final option.
    if (card.option !== options.queued) {
      if (card.option) module.shown = card.option;
    } else if (terminal)
      module.ceded = options[state.status as "done" | "cancelled"];
    state.modules.github = module;
  }
  const what = `#${issue}${run ? ` (run ${run})` : ""}`;
  if (typeof plan !== "object") {
    const message = ended
      ? `Rebuilt ${what} from GitHub: it is done.`
      : !read.open
        ? `Rebuilt ${what} from GitHub: its issue is closed with no report, so it is cancelled.`
        : `Rebuilt ${what} from GitHub: it has no plan of this run, so it plans again.`;
    return { state, message };
  }
  const rebuilt = rebuiltOf(issue, run!, plan, mine, read.pulls, old);
  const merged = Object.keys(rebuilt.merged).length;
  const open = Object.entries(rebuilt.open);
  if (TERMINAL.includes(state.status)) {
    restore(state, plan.plan, rebuilt);
    return {
      state,
      message: `Rebuilt ${what} from GitHub: it is ${state.status}, with ${merged} merged Work Item${merged === 1 ? "" : "s"}.`,
    };
  }
  const { open: _open, ...kept } = rebuilt;
  state.kept[REBUILT] = kept;
  plan.plan.decisions.forEach((decision, at) => {
    state.done[`decide:0:${at + 1}`] = { decision };
  });
  return {
    state,
    message: `Rebuilt ${what} from GitHub: its plan of ${plan.plan.items.length} Work Item${plan.plan.items.length === 1 ? "" : "s"} (${merged} merged${open.length ? `; open ${open.map(([id, pr]) => `#${pr} (${id})`).join(", ")}, reused when its item publishes again` : ""}) is checked and reviewed again before any work runs.`,
  };
}

/**
 * The run to rebuild and its plan comment: the old state's run when
 * readable, else the newest run Factory's own comments name, by their
 * order on the issue (its live status comment, report or cancel
 * comment), or the plan comment's when no such comment names that run and
 * it is the later run. The plan is the plan comment's when it names that
 * run, and the old state (when readable) had accepted a plan or kept a
 * rebuilt one; a string says why it can't be read.
 */
export function findRun(
  issue: number,
  mine: IssueComment[],
  old: ObjectiveState | undefined,
): {
  run?: string;
  plan?: { plan: Plan; accepted: string } | string;
} {
  const marker = `<!-- factory:${issue}:plan -->`;
  const planned = mine.find((comment) =>
    comment.body.startsWith(`${marker}\n`),
  );
  const line = planned?.body.slice(marker.length + 1).split("\n", 1)[0] ?? "";
  const marks = readRunMarks(line);
  const named =
    marks && line === runMarks(marks.run, marks.plan) ? marks : undefined;
  let run = old?.startedAt;
  if (!run) {
    const runs = mine.flatMap((comment) => {
      const found = new RegExp(
        `^<!-- factory:${issue}:(?:status|report|cancelled):(\\S+) -->`,
      ).exec(comment.body);
      return found ? [found[1]!] : [];
    });
    run = runs.at(-1);
    if (named && !runs.includes(named.run) && (!run || named.run > run))
      run = named.run;
  }
  // A readable old state that hadn't accepted a plan (nor kept a rebuilt
  // one for review) was replanning: the comment is an earlier plan's.
  const replanning = old && !currentPlan(old) && !old.kept[REBUILT];
  if (!planned || !named || named.run !== run || replanning)
    return run ? { run } : {};
  const plan = planOf(issue, planned.body, (part) =>
    mine.find((comment) => comment.body.startsWith(part)),
  );
  return {
    run,
    plan: typeof plan === "string" ? plan : { plan, accepted: named.plan },
  };
}

/** What GitHub shows of `plan` in `run`: its merged and open PRs and its status record's entries. */
function rebuiltOf(
  issue: number,
  run: string,
  { plan, accepted }: { plan: Plan; accepted: string },
  mine: IssueComment[],
  pulls: GitHubRead["pulls"],
  old: ObjectiveState | undefined,
): Rebuilt & { open: Record<string, number> } {
  // The newest PR of this run and plan on item `id`'s branch.
  const newest = (id: string, merged: boolean) =>
    (pulls[`factory/${issue}/${id}`] ?? [])
      .filter((pull) => {
        const marks = readRunMarks(pull.body ?? "");
        return (
          marks?.run === run &&
          marks.plan === accepted &&
          (merged
            ? Boolean(pull.merged_at && pull.merge_commit_sha)
            : pull.state === "open")
        );
      })
      .sort((a, b) => b.number - a.number)[0];
  const merged: Rebuilt["merged"] = {};
  const open: Record<string, number> = {};
  for (const { id } of plan.items) {
    const pull = newest(id, true);
    if (pull)
      merged[id] = {
        pr: pull.number,
        head: pull.head.sha,
        mergeSha: pull.merge_commit_sha!,
        at: pull.merged_at!,
      };
    else {
      const unmerged = newest(id, false);
      if (unmerged) open[id] = unmerged.number;
    }
  }
  // The status record, and a readable old state's own, for this plan.
  const record = mine.find((comment) =>
    comment.body.startsWith(mark(issue, "status", run)),
  );
  const shown = record ? statusRecord(record.body) : undefined;
  // Each entry once (the record's copy first), by its question and what it settles.
  const ofPlan = <
    T extends { plan: string; holdId: string; criterion?: string },
  >(
    entries: T[],
  ): T[] => {
    const key = (entry: T) => JSON.stringify([entry.holdId, entry.criterion]);
    return entries.filter(
      (entry, at) =>
        entry.plan === accepted &&
        entries.findIndex((other) => key(other) === key(entry)) === at,
    );
  };
  return {
    plan,
    accepted,
    merged,
    open,
    decisions: ofPlan([
      ...(shown?.decisions ?? []),
      ...(old ? decisionsOf(old) : []),
    ]),
    retired: ofPlan([
      ...(shown?.retired ?? []),
      ...((old && currentPlan(old)?.retired) ?? []),
    ]),
  };
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
