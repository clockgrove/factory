import { isObject } from "./checked.js";
import type { CoreConfig } from "./config.js";
import {
  CANCEL_CLEANUP,
  hold,
  type Outcome,
  type Step,
  type Workflow,
} from "./engine.js";
import {
  type GitHub,
  GitHubError,
  type IssueComment,
  type PullRequest,
  sameLogin,
  TransientError,
} from "./github.js";
import type { GitHubModule } from "./github-sync.js";
import { digest, mark, readPlanMarks, readRunMarks } from "./markdown.js";
import { checkPlan } from "./planning/checks.js";
import { BaseFiles, finalCommands } from "./planning/facts.js";
import { coverageCriterion } from "./planning/graph.js";
import {
  ACCEPTED_AT,
  currentPlan,
  decisionsOf,
  generationInputs,
  ownedSince,
  position,
} from "./planning/plan.js";
import { decisions, planningFacts, postPlan } from "./planning/steps.js";
import type { Draft, Plan, Retirement } from "./planning/types.js";
import { type StatusRecord, statusRecord } from "./progress.js";
import { type QueueItem, readQueue } from "./queue.js";
import { type RequestResult, refused, type StoredRequest } from "./requests.js";
import { PROTECTED_CRITERION } from "./review/item.js";
import type { CriterionDecision } from "./review/result.js";
import {
  deadlineAt,
  type Frozen,
  keptClosings,
  newObjective,
  type ObjectiveState,
  planProblem,
  RESET_KEY,
  recordClosed,
  TERMINAL,
} from "./state.js";
import { fact, facts } from "./work/facts.js";
import { commandRefusal } from "./work/retire.js";

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
export const RESET = RESET_KEY;

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
  // Their comments are still shown as closed while it rebuilds.
  if (old?.closedHolds) state.closedHolds = old.closedHolds;
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
  const rebuilt = state.kept?.[REBUILT] as Rebuilt | undefined;
  return !plan && rebuilt
    ? { decisions: rebuilt.decisions, retired: rebuilt.retired }
    : { decisions: decisionsOf(state), retired: plan?.retired ?? [] };
}

/**
 * The plan whose owned paths an Objective holds (service.ts `pathOwners`)
 * and when it was accepted: while a reset stands, the old state's; once
 * rebuilt, the rebuilt plan's under its own acceptance, until planning
 * lands it or drops it (`forget`); else the current plan's. So a reset
 * of a readable state never gives up an Objective's place in the
 * owned-path order; one of an unreadable state owns the rebuilt plan's
 * paths from the rebuild (`rebuildFrom`).
 */
export function ownedPlan(
  state: ObjectiveState,
): { plan: Plan; accepted: string } | undefined {
  if (TERMINAL.includes(state.status)) return undefined;
  if (resetting(state)) {
    const { old } = state.kept[RESET] as ResetRecord;
    return old && ownedPlan(old);
  }
  const plan = currentPlan(state);
  if (plan) return { plan, accepted: String(state.kept[ACCEPTED_AT] ?? "") };
  const rebuilt = state.kept?.[REBUILT] as Rebuilt | undefined;
  return rebuilt && { plan: rebuilt.plan, accepted: rebuilt.accepted };
}

/**
 * The workflow, with the rebuild as the only step while a reset stands,
 * and a rebuilt plan's check and landing in place of planning's own
 * first round and acceptance.
 */
/** A reset stands: the record waits for its rebuild. */
export const resetting = (state: ObjectiveState) =>
  Boolean(state.kept?.[RESET]) && !TERMINAL.includes(state.status);

export function resettable(
  inner: Workflow,
  github: GitHub,
  config: CoreConfig,
): Workflow {
  const rebuild = rebuildStep(github, config);
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
        const { g, n } = position(state);
        // Planning went past round 1:1 without accepting it: a new plan.
        if (g !== 1 || n !== 1) return [forget];
        if (!state.done[ROUND]) return [reviewed(rebuilt, config)];
        const decided = state.done["decide:1:1"] as
          | { accept?: true }
          | undefined;
        if (decided?.accept) return [land(rebuilt, github, config, inner)];
      }
      return inner.steps(state);
    },
    status: (state) => (resetting(state) ? "resetting" : inner.status(state)),
  };
}

/** Drop a rebuilt plan planning didn't accept: nothing of it carries over. */
const forget: Step = {
  key: "reset:forget",
  deadlineMs: 60_000,
  run: async (): Promise<Outcome> => ({
    kind: "retry",
    reason: "Planning made a new plan: the rebuilt one is dropped.",
    progress: true,
    keep: { [REBUILT]: null },
  }),
};

/** Answers to an ended run whose card says a run goes on (`rebuildFrom`). */
const ENDED = "ended";

/** `rebuild`: read GitHub and replace the resetting record with what it finds. */
function rebuildStep(github: GitHub, config: CoreConfig): Step {
  return {
    key: "rebuild",
    deadlineMs: 15 * 60_000,
    resource: "github",
    run: async ({ state, signal, answer }): Promise<Outcome> => {
      const record = state.kept[RESET] as ResetRecord;
      const found = await rebuildState(
        github,
        config,
        state,
        signal,
        answer?.answer === ENDED,
      );
      if ("ended" in found)
        return hold(found.ended, [
          {
            answer: ENDED,
            family: "accept",
            consequence: "Rebuilds it as that run ended it.",
          },
          {
            answer: "retry",
            family: "retry",
            consequence:
              "Reads GitHub again: set its card to the queued option first to run it again.",
          },
          "cancel",
        ]);
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
        ownedSince: _since,
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
    run: async ({ state, signal, log }): Promise<Outcome> => {
      const inputs = generationInputs(state, 1);
      const { draft } = state.done[ROUND] as { draft: Draft };
      const plan: Plan = {
        ...draft,
        base: rebuilt.plan.base,
        finalCommands: finalCommands(config.finalValidation.requiredCommands),
        decisions: decisions(state),
        ...(inputs.reviewArtifacts.length
          ? { reviewArtifacts: inputs.reviewArtifacts }
          : {}),
        ...(rebuilt.plan.ownedSince
          ? { ownedSince: rebuilt.plan.ownedSince }
          : {}),
      };
      await postPlan({ github }, state, plan, signal, {
        accepted: rebuilt.accepted,
      });
      const kept = restorable(
        plan,
        rebuilt,
        config.finalValidation.requiredCommands,
      );
      if (kept.dropped.length)
        log({ event: "reset-dropped", dropped: kept.dropped });
      return {
        kind: "replace",
        build: (live) => {
          delete live.attempts.plan;
          delete live.kept[REBUILT];
          restore(live, plan, { ...rebuilt, ...kept });
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
 * The decisions and retirements `plan` can take, and what it can't, named
 * (`dropped`): a criterion decision only for a Work Item of the plan and a
 * criterion its review judges (the item's own acceptance), or for
 * final review and a criterion of the plan's coverage; a retirement only
 * as final validation would take it now, replayed oldest first
 * (work/retire.ts `commandRefusal`). The record they came from can be
 * edited by anyone who can write to the repository, so each is checked as
 * a fresh answer would be.
 */
function restorable(
  plan: Plan,
  { decisions, retired }: Pick<Rebuilt, "decisions" | "retired">,
  required: readonly string[],
): Pick<Rebuilt, "decisions" | "retired"> & { dropped: string[] } {
  const dropped: string[] = [];
  const judged = new Set(plan.coverage.map(coverageCriterion));
  const kept = decisions.filter((entry) => {
    const item = entry.itemId
      ? plan.items.find((each) => each.id === entry.itemId)
      : undefined;
    const fits = entry.itemId
      ? item !== undefined &&
        [...item.acceptance, PROTECTED_CRITERION].includes(entry.criterion)
      : judged.has(entry.criterion);
    if (!fits)
      dropped.push(
        `the ${entry.outcome} of "${entry.criterion.slice(0, 80)}"${entry.itemId ? ` (Work Item ${entry.itemId})` : ""}`,
      );
    return fits;
  });
  const replayed: Retirement[] = [];
  for (const entry of [...retired].sort((a, b) => a.at.localeCompare(b.at))) {
    const refusal = commandRefusal(
      { ...plan, retired: replayed },
      entry.command,
      required,
    );
    if (refusal)
      dropped.push(`the retirement of \`${entry.command}\` (${refusal})`);
    else replayed.push(entry);
  }
  return { decisions: kept, retired: replayed, dropped };
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
  closedByReset(
    state,
    live,
    (live.kept[RESET] as ResetRecord | undefined)?.old,
    new Date().toISOString(),
  );
  return state;
}

/**
 * The closed questions of the record that replaces a resetting one
 * (`carried`): the live record's (its comments' progress is the sync's),
 * then the base's it lacks, and every question the old state had open
 * that the new record doesn't, closed as `reset`, so its comment says
 * the reset closed it. A restored old state keeps its questions open; a
 * cancel before the rebuild lands closes them as cancelled instead
 * (engine.ts `cancel`).
 */
export function closedByReset(
  state: ObjectiveState,
  live: Pick<ObjectiveState, "closedHolds">,
  old: Pick<ObjectiveState, "holds"> | undefined,
  at: string,
): void {
  const known = new Map(
    [...(state.closedHolds ?? []), ...(live.closedHolds ?? [])].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  // Bounded as recordClosed bounds them: no unshown closing is lost.
  const merged = keptClosings(
    [...known.values()].sort((a, b) => a.closed.at.localeCompare(b.closed.at)),
  );
  if (merged.length) state.closedHolds = merged;
  else delete state.closedHolds;
  for (const hold of old?.holds ?? [])
    if (!state.holds.some((open) => open.id === hold.id))
      recordClosed(state, hold, { how: "reset", at });
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
 * (`rebuildFrom`). It reads and never writes. `ended`: the operator's
 * answer that the run ended as GitHub shows, whatever its card says.
 */
export async function rebuildState(
  github: GitHub,
  config: CoreConfig,
  record: ObjectiveState,
  signal: AbortSignal,
  ended = false,
): Promise<Rebuild> {
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
  const pulls = await pullsOf(
    github,
    pullBranches(record, comments, self),
    signal,
  );
  return rebuildFrom(
    record,
    { open, ...(card ? { card } : {}), self, comments, pulls },
    config,
    ended,
  );
}

/** The PRs whose head is each of `branches`, every merged one with its merge commit. */
async function pullsOf(
  github: GitHub,
  branches: string[],
  signal: AbortSignal,
): Promise<GitHubRead["pulls"]> {
  const pulls: GitHubRead["pulls"] = {};
  for (const branch of branches) {
    pulls[branch] = await github.pullsByHead(branch, signal);
    for (const pull of pulls[branch])
      if (pull.merged_at && !pull.merge_commit_sha) {
        // A merged PR's commit can lag on GitHub: read again later,
        // never take it as unmerged.
        const sha = await github.mergeCommitOf(pull.number, signal);
        if (!sha)
          throw new TransientError(
            `GitHub doesn't show PR #${pull.number}'s merge commit yet`,
          );
        pull.merge_commit_sha = sha;
      }
  }
  return pulls;
}

/** What GitHub alone shows Factory delivered for an Objective (`deliveredOnGitHub`). */
export interface Delivered {
  /** The newest run Factory's own comments name. */
  run?: string;
  /** That run's report is posted: a reported run is done. */
  reported: boolean;
  /** That run's plan, from its plan comment, when it can be read. */
  plan?: Plan;
  /** The PR each of the plan's Work Items merged with in that run. */
  merged: Rebuilt["merged"];
}

/**
 * What Factory delivered for `issue`, read from GitHub as a reset with no
 * readable state reads it (`rebuildFrom`), for a reader that has no
 * readable state of it (planning/predecessors.ts): its newest run, that
 * run's report and plan comment, and each item's merged PR of that run
 * and plan, by its fixed branch. It only reads; a failed read throws.
 */
export async function deliveredOnGitHub(
  github: GitHub,
  issue: number,
  signal: AbortSignal,
): Promise<Delivered> {
  const self = await github.login(signal);
  const mine = own({
    comments: await github.comments(issue, undefined, signal),
    self,
  });
  const { run, plan } = findRun(issue, mine, undefined);
  const reported =
    run !== undefined &&
    mine.some((comment) => comment.body.startsWith(mark(issue, "report", run)));
  if (!run || typeof plan !== "object") return { run, reported, merged: {} };
  const pulls = await pullsOf(
    github,
    plan.plan.items.map((item) => `factory/${issue}/${item.id}`),
    signal,
  );
  const { merged } = rebuiltOf(
    issue,
    run,
    plan,
    mine,
    { pulls, self },
    undefined,
  );
  return { run, reported, plan: plan.plan, merged };
}

/** A rebuild's result: the state, a question for the operator, or a refusal. */
export type Rebuild =
  | { state: ObjectiveState; message: string }
  | { ended: string }
  | RequestResult;

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
  const { plan } = findRun(
    issue,
    own({ comments, self }),
    (record.kept[RESET] as ResetRecord).old,
    record.startedAt,
  );
  if (typeof plan !== "object") return [];
  return plan.plan.items.map((item) => `factory/${issue}/${item.id}`);
}

/**
 * The state rebuilt only from what Factory left on GitHub (`read`): its
 * plan comment (and its numbered `plan-data` continuations), the PRs whose
 * head is a Work Item branch, its live status comment's record
 * (progress.ts `StatusRecord`), its report and its cancel comment. Pure:
 * a refusal comes back as a result with its code.
 *
 * Everything found is bound to one run and one plan by the identities
 * Factory writes, never by a time: only comments and PRs by Factory's own
 * login count, and the run is the old state's (when readable), else the
 * newest one Factory's comments name (`findRun`). The plan comment counts
 * only when it names that run (and, with a readable old state, that state
 * had accepted a plan or kept a rebuilt one); its data only from Factory's
 * own data block at the comment's end, or from the continuation comments
 * it names, and only when it matches the digest the comment carries (an
 * edited plan is taken as none, so the run plans afresh); data that isn't
 * a plan refuses with `plan_unreadable`. A PR counts only when its body
 * names that run and plan (markdown.ts `runMarks`; the newest wins), the
 * status record only when it matches its digest, and only that plan's
 * entries that the plan can take (`restorable`); the report or cancel
 * comment only that run's. An Objective Factory has no state or run on
 * GitHub for needs a card that is queued. The operator's own choices
 * (pause or drain, a switch or adopt, the card and the comment cursor) are
 * taken from the live record when the rebuild lands (`carried`).
 *
 * A reported run is done, a run with its cancel comment is cancelled (its
 * cleanup ran), and a closed, unreported one is cancelled (its cleanup
 * runs again); each shows its plan and merges as they were. A run that
 * ended while its card shows an option Factory writes only while a run
 * goes on asks (`ended`): a later run may have started and written nothing
 * yet. Any other run with a plan keeps it aside for the plan checks and
 * plan review (`REBUILT`); its planning decisions stand as generation 0's,
 * which planning reads with every saved decision (planning/steps.ts
 * `decisions`) and no generation counts from. A run with no plan of its
 * own plans afresh. Open questions are asked again by the steps that
 * asked them, and repair counts start again.
 */
export function rebuildFrom(
  record: ObjectiveState,
  read: GitHubRead,
  config: Pick<CoreConfig, "queue" | "finalValidation">,
  /** The operator answered that the run ended as GitHub shows. */
  endedAnswer = false,
): Rebuild {
  const issue = record.issue;
  const { old, hadState, requestedAt } = record.kept[RESET] as ResetRecord;
  const mine = own(read);
  const options = config.queue.options;
  const { run, plan, edited } = findRun(issue, mine, old, record.startedAt);
  // Only a card queued under this configuration admits an Objective
  // Factory has no state for; a candidate or inert card doesn't.
  if (!hadState && !run && read.card?.option !== options.queued)
    return refused(
      "no_factory_state",
      `Factory has no state for #${issue}, its comments name no run of it, and its card isn't queued, so there is nothing to reset.`,
    );
  const marked = (kind: string) =>
    run !== undefined &&
    mine.some((comment) => comment.body.startsWith(mark(issue, kind, run)));
  const ended = marked("report")
    ? ("done" as const)
    : marked("cancelled")
      ? ("cancelled" as const)
      : undefined;
  if (typeof plan === "string" && !ended)
    return refused(
      "plan_unreadable",
      `#${issue}'s plan comment can't be read (${plan}).`,
    );
  const what = `#${issue}${run ? ` (run ${run})` : ""}`;
  const going = [options.planning, options.building, options.holding];
  if (ended && !endedAnswer && going.includes(read.card?.option ?? ""))
    return {
      ended: `GitHub shows run ${run} of #${issue} ${ended === "done" ? "reported" : "cancelled"}, but its card shows ${read.card!.option}, which Factory writes only while a run goes on: a later run may have started and written nothing on GitHub yet (with progress comments off, it posts no status comment). Answer \`${ENDED}\` to rebuild it as run ${run} ended it; set its card to ${options.queued} and answer \`retry\` to run it again; or cancel.`,
    };

  const state = newObjective(issue, new Date(requestedAt), record.frozen);
  state.startedAt = run ?? record.startedAt;
  if (record.deadline) state.deadline = record.deadline;
  if (ended || !read.open) {
    state.status = ended ?? "cancelled";
    if (ended === "done") state.done.report = true;
    // Its cancel comment is posted once its cleanup has settled.
    if (ended === "cancelled") state.done[CANCEL_CLEANUP] = true;
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
      ...(ended === "cancelled" ? { cancelShown: true } : {}),
    };
    // A card the operator queued shows nothing of Factory's: for a
    // finished run it is a queue again, over the final option.
    if (card.option !== options.queued) {
      if (card.option) module.shown = card.option;
    } else if (terminal)
      module.ceded = options[state.status as "done" | "cancelled"];
    state.modules.github = module;
  }
  const notes = [
    ...(edited?.plan
      ? [
          "its plan data doesn't match the digest its comment carries, so it is taken as edited and the run plans again",
        ]
      : []),
  ];
  const told = (message: string, more: string[] = []) => {
    const all = [...notes, ...more];
    return all.length ? `${message} Note: ${all.join("; ")}.` : message;
  };
  if (typeof plan !== "object") {
    const message =
      ended === "done"
        ? `Rebuilt ${what} from GitHub: it is done.`
        : ended === "cancelled"
          ? `Rebuilt ${what} from GitHub: it was cancelled.`
          : !read.open
            ? `Rebuilt ${what} from GitHub: its issue is closed with no report, so it is cancelled.`
            : `Rebuilt ${what} from GitHub: it has no plan of this run, so it plans again.`;
    return { state, message: told(message) };
  }
  const found = rebuiltOf(issue, run!, plan, mine, read, old);
  const { open, record: status, ...rebuilt } = found;
  const kept = restorable(
    plan.plan,
    rebuilt,
    config.finalValidation.requiredCommands,
  );
  const more = [
    ...(status === "edited"
      ? [
          "its status comment's record doesn't match its digest, so its criterion decisions and retirements are asked for again",
        ]
      : []),
    ...(typeof status === "object" && status.dropped
      ? [
          `its status comment's record had left out ${status.dropped} older entr${status.dropped === 1 ? "y" : "ies"}, which are asked for again`,
        ]
      : []),
    ...(kept.dropped.length
      ? [`the plan can't take ${kept.dropped.join(", ")}, so it is dropped`]
      : []),
  ];
  const merged = Object.keys(rebuilt.merged).length;
  const restored = {
    ...rebuilt,
    decisions: kept.decisions,
    retired: kept.retired,
  };
  if (TERMINAL.includes(state.status)) {
    restore(state, plan.plan, restored);
    return {
      state,
      message: told(
        `Rebuilt ${what} from GitHub: it is ${state.status}, with ${merged} merged Work Item${merged === 1 ? "" : "s"}.`,
        more,
      ),
    };
  }
  // Its paths keep the times the old state owned them from, even a rebuilt
  // plan's it kept (which only `land` posts); a path it didn't own (all,
  // with no readable old state) an Objective accepted since may have
  // started on, so it owns it from now, after every plan accepted before
  // (service.ts `pathOwners`).
  const { ownedSince: _since, ...rebuiltPlan } = plan.plan;
  const since = ownedSince(
    plan.plan.items,
    new Date().toISOString(),
    old && ownedPlan(old),
  );
  restored.plan = since ? { ...rebuiltPlan, ownedSince: since } : rebuiltPlan;
  state.kept[REBUILT] = restored;
  plan.plan.decisions.forEach((decision, at) => {
    state.done[`decide:0:${at + 1}`] = { decision };
  });
  const pulls = Object.entries(open);
  return {
    state,
    message: told(
      `Rebuilt ${what} from GitHub: its plan of ${plan.plan.items.length} Work Item${plan.plan.items.length === 1 ? "" : "s"} (${merged} merged${pulls.length ? `; open ${pulls.map(([id, pr]) => `#${pr} (${id})`).join(", ")}, reused when its item publishes again` : ""}) is checked and reviewed again before any work runs.`,
      more,
    ),
  };
}

/**
 * The run to rebuild and its plan comment: the old state's run when
 * readable, else the newest run Factory's own comments name, by their
 * order on the issue (its live status comment, report or cancel
 * comment), or the plan comment's when no such comment names that run and
 * it is the later run. The resetting record's own run (`resetRun`) is never
 * one: it is no run of GitHub's. The plan is the plan comment's when it
 * names that run, its data matches the digest it carries (else `edited`),
 * and the old state (when readable) had accepted a plan or kept a rebuilt
 * one; a string says why it can't be read.
 */
export function findRun(
  issue: number,
  mine: IssueComment[],
  old: ObjectiveState | undefined,
  resetRun?: string,
): {
  run?: string;
  plan?: { plan: Plan; accepted: string } | string;
  edited?: { plan: true };
} {
  const marker = `<!-- factory:${issue}:plan -->`;
  const planned = mine.find((comment) =>
    comment.body.startsWith(`${marker}\n`),
  );
  const line = planned?.body.slice(marker.length + 1).split("\n", 1)[0] ?? "";
  const named = readPlanMarks(line);
  let run = old?.startedAt;
  if (!run) {
    const runs = mine.flatMap((comment) => {
      const found = new RegExp(
        `^<!-- factory:${issue}:(?:status|report|cancelled):(\\S+) -->`,
      ).exec(comment.body);
      return found && found[1] !== resetRun ? [found[1]!] : [];
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
  if (typeof plan === "string") return { run, plan };
  if (digest(plan.json) !== named.digest)
    return { run, edited: { plan: true } };
  return { run, plan: { plan: plan.plan, accepted: named.plan } };
}

/** What GitHub shows of `plan` in `run`: its merged and open PRs and its status record. */
function rebuiltOf(
  issue: number,
  run: string,
  { plan, accepted }: { plan: Plan; accepted: string },
  mine: IssueComment[],
  { pulls, self }: Pick<GitHubRead, "pulls" | "self">,
  old: ObjectiveState | undefined,
): Rebuilt & {
  open: Record<string, number>;
  record: StatusRecord | "edited" | undefined;
} {
  // The newest PR of this run and plan on item `id`'s branch, by Factory.
  const newest = (id: string, merged: boolean) =>
    (pulls[`factory/${issue}/${id}`] ?? [])
      .filter((pull) => {
        const marks = readRunMarks(pull.body ?? "");
        return (
          pull.user != null &&
          sameLogin(pull.user.login, self) &&
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
  const comment = mine.find((each) =>
    each.body.startsWith(mark(issue, "status", run)),
  );
  const record = comment ? statusRecord(comment.body) : undefined;
  const shown = typeof record === "object" ? record : undefined;
  const local = old ? statusRecordOf(old) : undefined;
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
    record,
    decisions: ofPlan([
      ...(shown?.decisions ?? []),
      ...(local?.decisions ?? []),
    ]),
    retired: ofPlan([...(shown?.retired ?? []), ...(local?.retired ?? [])]),
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
): { plan: Plan; json: string } | string {
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
  return planShaped(plan) ? { plan, json } : "its data is not a plan";
}

/**
 * Whether `value` has the plan's shape where the rebuild and its checks
 * read it, so an edited plan is refused here rather than throwing later:
 * a saved plan's shape (state.ts `planProblem`), and its base, planning
 * decisions and each obligation's source, proof and environment.
 */
function planShaped(value: unknown): value is Plan {
  if (planProblem(value) !== undefined || !isObject(value)) return false;
  return (
    typeof value.base === "string" &&
    (value.coverage as Record<string, unknown>[]).every(
      (entry) =>
        isObject(entry.source) &&
        isObject(entry.proof) &&
        isObject(entry.environment),
    ) &&
    Array.isArray(value.decisions) &&
    value.decisions.every(
      (entry) =>
        isObject(entry) &&
        ["question", "answer", "by", "at"].every(
          (key) => typeof entry[key] === "string",
        ) &&
        (entry.text === undefined || typeof entry.text === "string"),
    ) &&
    (value.retired === undefined ||
      (Array.isArray(value.retired) &&
        value.retired.every((entry) => isObject(entry)))) &&
    (value.ownedSince === undefined ||
      (isObject(value.ownedSince) &&
        Object.values(value.ownedSince).every((at) => typeof at === "string")))
  );
}
