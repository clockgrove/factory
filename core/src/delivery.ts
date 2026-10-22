/**
 * Regular PR delivery for one Work Item: push its result to its fixed
 * branch, find or open its PR, wait for CI on the exact head, bring the
 * branch up to date, and merge with a merge commit. Every effect is found
 * on GitHub before it is made (CORE.md#Idempotence), so a step that runs
 * again carries on from whatever the last run left. Each function returns
 * data the item steps return as their outcome; GitHub's transient errors
 * come back as `retry`.
 */
import { crashPoint } from "./crash.js";
import { hold, type Outcome } from "./engine.js";
import { defaultHead, type GitExit, operatorGit } from "./git.js";
import {
  type CheckRun,
  type GitHub,
  GitHubError,
  type PullRequest,
  TransientError,
} from "./github.js";
import { redact } from "./log.js";
import { BaseFiles, workflowCheckNames } from "./planning/facts.js";
import type { WorkItem } from "./planning/types.js";
import { errorMessage } from "./text.js";
import { GitRefusal, hostGit, hostGitExit, originProblem } from "./worktree.js";

const MINUTE = 60_000;
/** How long GitHub may not yet show what Factory just did. */
const GITHUB_LAG_MS = 2 * MINUTE;
/** How long a newly pushed head may show no checks before Factory asks. */
const CHECK_SETTLE_MS = 20 * MINUTE;
/** Checks pending with the same set this long become a question. */
const ESCALATE_AFTER_MS = 24 * 60 * MINUTE;
const CI_POLL_MS = 20_000;
/** How long a fetched default-branch head serves renamed-check lookups. */
const DEFAULT_HEAD_REUSE_MS = 10 * MINUTE;
const LAG_POLL_MS = 15_000;
/** Failed checks a finding names one by one; the rest are counted. */
const LISTED_CHECKS = 10;
/** Failed checks whose annotations and log tail go into the finding. */
const EXCERPTED_CHECKS = 3;
const LOG_TAIL_LINES = 40;
const LOG_TAIL_CHARS = 3000;
/** Update-branch merges followed back to Factory's own head. */
const MAX_BRANCH_UPDATES = 10;
/** ANSI CSI and OSC sequences, and other two-byte escapes, in job logs. */
const ANSI_ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escapes.
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

type Retry = Extract<Outcome, { kind: "retry" }>;
type Hold = Extract<Outcome, { kind: "hold" }>;
/** The item step adds the target and the steps to clear. */
export interface Repair {
  kind: "repair";
  finding: string;
}

/**
 * The answer that delivers the current result on a new PR, offered when its
 * PR was closed without merging or an earlier head was merged instead.
 * Steps route it as follows:
 * - Publish step: on this answer (`context.answer`), call `publish` with
 *   `republish: true`; it then ignores PRs that merged an earlier head and
 *   opens a new PR (a closed PR is never reused).
 * - CI and merge steps: on this answer, call `observeCi`/`merge` with
 *   `republish: true`. A `republish` result becomes the engine outcome
 *   `{ kind: "repair", finding: reason, target: <publish step>, clear:
 *   [<publish step>, <CI step>, <merge step>] }`, so publish runs again and
 *   the new PR's number reaches the later steps.
 */
export const REPUBLISH = "republish";

/**
 * GitHub has no commits between the default branch and the result: the
 * result adds nothing to the base. The publish step treats it as a repair
 * finding (an empty change).
 */
export interface Empty {
  kind: "empty";
  finding: string;
}

/** The operator answered REPUBLISH: publish this result on a new PR. */
export interface Republish {
  kind: "republish";
  reason: string;
}

/** What every delivery call needs. */
export interface DeliveryContext {
  github: GitHub;
  /** The operator's checkout; worktrees share its objects. */
  checkout: string;
  signal: AbortSignal;
  /**
   * When the calling step's current run of retries began
   * (`state.retries[key]?.since`). GitHub may lag a moment behind what
   * Factory did; past GITHUB_LAG_MS from this, the lag becomes a question.
   */
  retryingSince?: string;
  /** Secret values (policy.allowedSecretNames) redacted from PR text and excerpts. */
  secrets?: string[];
}

/** The fixed branch of a Work Item; the only key that finds its PR again. */
function itemBranch(issue: number, item: string): string {
  return `factory/${issue}/${item}`;
}

// ── Publish ─────────────────────────────────────────────────────────────

export interface PublishInput {
  issue: number;
  item: WorkItem;
  /** The commit the item's result is built on. */
  base: string;
  /** The reviewed result commit, and its tree. */
  commit: string;
  tree: string;
  /** Every head Factory pushed for this item before, oldest first. */
  pushedHeads: string[];
  /** Commands that passed on this tree, and a flaky first failure if one was rerun. */
  validation: {
    commands: string[];
    flaky?: { command: string; exitCode: number | null };
  };
  /** The operator answered REPUBLISH to this step's question. */
  republish?: boolean;
}

export type PublishResult =
  | {
      kind: "published";
      pr: number;
      /** The PR's head: the commit, or GitHub's update of it. */
      head: string;
      /** Merged already: the merge step confirms it. */
      merged: boolean;
    }
  | Empty
  | Retry
  | Hold;

/**
 * Put the result on `factory/<issue>/<item>` and find or open its PR.
 * The remote branch is read first: holding the commit (or GitHub's update
 * of it), nothing is pushed; holding a head Factory pushed earlier, or
 * nothing, it is pushed with a lease on exactly that; holding anything
 * else, Factory asks. The PR is found by its head branch; only when there
 * is none is one opened, so a lost create is found by the next run.
 */
export function publish(
  context: DeliveryContext,
  input: PublishInput,
): Promise<PublishResult> {
  return guarded(context, async () => {
    const { github, signal } = context;
    const branch = itemBranch(input.issue, input.item.id);
    const origin = await originHold(context);
    if (origin) return origin;
    const baseBranch = await github.defaultBranch(signal);
    const current = new Set([input.commit]);
    const earlier = new Set(
      input.pushedHeads.filter((h) => h !== input.commit),
    );
    const known = new Set([...current, ...earlier]);
    let pulls = await github.pullsByHead(branch, signal);
    const merged = pulls.filter((pull) => pull.merged_at);
    // A merged PR of this result: the merge step confirms it.
    for (const pull of merged)
      if (await updates(context, pull.head.sha, current, baseBranch))
        return {
          kind: "published",
          pr: pull.number,
          head: pull.head.sha,
          merged: true,
        };
    // Someone merged an earlier head: the result Factory made since is not
    // on the default branch.
    if (!input.republish)
      for (const pull of merged)
        if (await updates(context, pull.head.sha, earlier, baseBranch))
          return hold(
            `PR #${pull.number} merged an earlier head of ${branch} (${pull.head.sha}), not the current result ${input.commit}, so that result is not on ${baseBranch}. Answer ${REPUBLISH} to open a new PR for the current result, or cancel.`,
            [REPUBLISH, "cancel"],
          );
    const remote = await remoteHead(context, branch);
    // The branch's head once pushed: the commit, or GitHub's update of it.
    let delivered = remote ?? input.commit;
    if (!remote || !(await updates(context, remote, current, baseBranch))) {
      if (remote && !(await updates(context, remote, earlier, baseBranch)))
        return hold(
          `Remote branch ${branch} holds a commit Factory did not push (${remote}; Factory pushed ${[...known].join(", ")}). Inspect it; delete or restore the branch and answer retry, or cancel.`,
          ["cancel", "retry"],
        );
      const pushed = await pushBranch(context, branch, input.commit, remote);
      if (pushed) return pushed;
      delivered = input.commit;
      pulls = await github.pullsByHead(branch, signal);
    }
    const open = pulls.filter((pull) => pull.state === "open");
    if (open.length > 1)
      return hold(
        `More than one open PR has head ${branch}: ${open.map((pull) => `#${pull.number}`).join(", ")}. Close the extra ones and answer retry, or cancel.`,
      );
    const pull = open[0];
    if (pull) {
      if (pull.base.ref !== baseBranch)
        return hold(
          `PR #${pull.number} for ${branch} targets ${pull.base.ref}, not the default branch ${baseBranch}. Change its base back and answer retry, or cancel.`,
        );
      if (await updates(context, pull.head.sha, current, baseBranch))
        return {
          kind: "published",
          pr: pull.number,
          head: pull.head.sha,
          merged: false,
        };
      if (await updates(context, pull.head.sha, earlier, baseBranch))
        return lagging(
          context,
          `PR #${pull.number} does not show the pushed head ${input.commit} yet`,
          `PR #${pull.number} still shows an earlier head (${pull.head.sha}), not the pushed ${input.commit}. Inspect it, then answer retry, or cancel.`,
        );
      return foreign(pull, input.commit);
    }
    const body = await pullRequestBody(context, input);
    crashPoint("deliver:pr-create:before");
    let created: PullRequest;
    try {
      created = await github.createPull(
        { head: branch, base: baseBranch, title: input.item.title, body },
        signal,
      );
    } catch (error) {
      // The branch adds nothing to the default branch: an empty change.
      if (
        error instanceof GitHubError &&
        error.status === 422 &&
        /No commits between/i.test(error.message)
      )
        return {
          kind: "empty",
          finding: `The result ${input.commit} adds no commits to ${baseBranch} (GitHub: ${error.message.slice(0, 300)}). The Work Item's change is empty or already on ${baseBranch}: make the change the Work Item asks for.`,
        };
      // A PR for the branch exists already (a create whose answer was lost).
      if (error instanceof GitHubError && error.status === 422)
        return retry(
          `GitHub refused a second PR for ${branch}: ${error.message}`,
        );
      throw needing(error, "Pull requests: write");
    }
    crashPoint("deliver:pr-create:after");
    return {
      kind: "published",
      pr: created.number,
      head: delivered,
      merged: false,
    };
  });
}

/** Push with a lease on `remote`; undefined once the branch holds `commit`. */
async function pushBranch(
  context: DeliveryContext,
  branch: string,
  commit: string,
  remote: string | undefined,
): Promise<Retry | Hold | undefined> {
  crashPoint("deliver:push:before");
  try {
    await remoteGit(context, [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`,
      "origin",
      `${commit}:refs/heads/${branch}`,
    ]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    const refused = pushRefusal(
      (error as { stdout?: unknown }).stdout?.toString() ?? "",
    );
    if (!refused) {
      // No ref was refused: the push never reached the refs (network, or
      // credentials). A login without push access is a setting to change.
      if ((await context.github.canPush(context.signal)) === false)
        return hold(
          `Factory's login may not push to ${context.github.repository} (git push of ${branch} failed: ${message(error).slice(0, 300)}). Give it write access (fine-grained token: Contents: write), then answer retry; or cancel.`,
        );
      throw new TransientError(`git push of ${branch}: ${message(error)}`);
    }
    // The ref was not updated. If the branch moved after it was read, read
    // it again; if it did not, the remote refuses the push itself.
    if ((await remoteHead(context, branch)) !== remote)
      return retry(`Remote branch ${branch} moved during the push`);
    return hold(
      `The remote refused Factory's push of ${branch} (${refused}) although the branch did not move. Allow Factory's login to push and force-push its own branches (factory/*), then answer retry; or cancel.`,
    );
  }
  crashPoint("deliver:push:after");
  if ((await remoteHead(context, branch)) !== commit)
    return retry(
      `Remote branch ${branch} does not show the pushed ${commit} yet`,
    );
  return undefined;
}

/** `! TAB from:to TAB [rejected] (reason)` lines of `git push --porcelain`. */
function pushRefusal(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields[0] !== "!") continue;
    const status = /^(\[[^\]]*\]|\S+)(?: \((.*)\))?$/.exec(fields[2]!);
    if (status?.[1] === "[rejected]" || status?.[1] === "[remote rejected]")
      return status[2] ? `${status[1]} ${status[2]}` : status[1];
  }
  return undefined;
}

/** The commit a remote branch holds, or undefined when it doesn't exist. */
async function remoteHead(
  context: DeliveryContext,
  branch: string,
): Promise<string | undefined> {
  let listed: string;
  try {
    listed = await remoteGit(context, [
      "ls-remote",
      "origin",
      `refs/heads/${branch}`,
    ]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new TransientError(`git ls-remote ${branch}: ${message(error)}`);
  }
  return listed.split(/\s+/)[0] || undefined;
}

/**
 * Git that reaches origin, with the operator's configuration and
 * credentials, after the origin check, as git.ts defaultHead does.
 */
function remoteGit(context: DeliveryContext, args: string[]): Promise<string> {
  return operatorGit(
    context.checkout,
    ["-c", "protocol.file.allow=never", ...args],
    { signal: context.signal, timeoutMs: 5 * MINUTE },
  );
}

async function originHold(context: DeliveryContext): Promise<Hold | undefined> {
  const problem = await originProblem(
    context.checkout,
    context.github.repository,
    context.signal,
  );
  return problem
    ? hold(
        `${problem}. Point origin's fetch and push URLs (and any insteadOf rewrite) at ${context.github.repository} with its default LFS route, then answer retry; or cancel.`,
      )
    : undefined;
}

// ── PR body ─────────────────────────────────────────────────────────────

/** Factory's PR text: the goal, links, changed paths, passing commands and the candidate. No model call. */
async function pullRequestBody(
  context: Pick<DeliveryContext, "github" | "checkout" | "signal" | "secrets">,
  input: PublishInput,
): Promise<string> {
  const safe = (value: string) => redact(value, context.secrets);
  const code = (value: string) =>
    `<code>${safe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;")}</code>`;
  const issues = `https://github.com/${context.github.repository}/issues`;
  const parts: string[] = [
    safe(input.item.goal).trim().slice(0, 4000) ||
      "This candidate contains the changes listed below.",
    `Work Item: ${code(input.item.id)} · Objective: [#${input.issue}](${issues}/${input.issue})`,
  ];
  const entries = (
    await localGit(
      context,
      [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        input.base,
        input.commit,
        "--",
      ],
      { signal: context.signal },
    )
  )
    .toString("utf8")
    .split("\0");
  const changes: string[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const verb =
      { A: "Adds", D: "Removes", M: "Updates", T: "Changes the type of" }[
        entries[index]!
      ] ?? "Changes";
    changes.push(`${verb} ${code(entries[index + 1]!)}`);
  }
  parts.push(
    changes.length
      ? `Changes in this candidate:\n\n${changes
          .slice(0, 40)
          .map((change) => `- ${change}`)
          .join(
            "\n",
          )}${changes.length > 40 ? `\n- ${changes.length - 40} further changed paths.` : ""}`
      : "This candidate has no file changes relative to its delivery base.",
  );
  const { commands, flaky } = input.validation;
  parts.push(
    commands.length
      ? `Controller validation passed on this candidate:\n\n${commands
          .slice(0, 20)
          .map((command) => `- ${code(command)}`)
          .join(
            "\n",
          )}${commands.length > 20 ? `\n- ${commands.length - 20} further commands passed.` : ""}`
      : "No controller validation commands ran on this candidate.",
  );
  // A check that failed once on this exact tree, then passed (#1595).
  if (flaky)
    parts.push(
      `Possibly flaky: the controller's first validation run of this candidate failed at ${code(flaky.command)} (exit ${flaky.exitCode ?? "unknown"}) after the worker's validation passed on it, and its one rerun passed.`,
    );
  parts.push(
    `Candidate commit: ${code(input.commit)}\n\nCandidate tree: ${code(input.tree)}`,
  );
  return parts.join("\n\n");
}

// ── CI ──────────────────────────────────────────────────────────────────

export interface PullInput {
  issue: number;
  item: string;
  pr: number;
  /** The head the publish step delivered. */
  head: string;
  /** Every head Factory pushed for this item, oldest first. */
  pushedHeads: string[];
  /** The plan's requiredPreIntegrationChecks names: each must pass on the head. */
  requiredChecks: string[];
  /** The operator answered REPUBLISH to this step's question. */
  republish?: boolean;
}

export type CiResult =
  | {
      kind: "ready";
      /** The head to merge: the delivered one, or GitHub's update of it. */
      head: string;
      merged: boolean;
    }
  | Retry
  | Repair
  | Hold
  | Republish;

/**
 * Whether the PR may merge. Every check on the exact head must settle; any
 * that failed, required or not, or a conflict with the base, is a repair
 * (#1637). Each plan-named check must pass by name. A PR BEHIND its base
 * under strict protection is updated by GitHub and observed again. A PR
 * made a draft, closed without merging, with only cancelled checks nothing
 * re-ran, with the same checks pending for a day, or with no checks at all,
 * is a question (#1640).
 */
export function observeCi(
  context: DeliveryContext,
  input: PullInput,
): Promise<CiResult> {
  return guarded(context, async () => {
    const judged = await judge(context, input);
    return judged.kind === "ready"
      ? {
          kind: "ready",
          head: judged.head,
          merged: judged.pull.merged === true,
        }
      : judged;
  });
}

type Judged =
  | { kind: "ready"; head: string; pull: PullRequest; baseBranch: string }
  | Retry
  | Repair
  | Hold
  | Republish;

async function judge(
  context: DeliveryContext,
  input: PullInput,
): Promise<Judged> {
  const { github, signal } = context;
  const { pr } = input;
  const pull = await github.pull(pr, signal);
  if (pull.state === "closed" && !pull.merged) {
    const closed = `PR #${pr} was closed without merging${pull.closed_at ? ` at ${pull.closed_at}` : ""}`;
    if (input.republish) return { kind: "republish", reason: closed };
    // A merge GitHub has not shown yet reads as closed for a moment.
    return lagging(
      context,
      `PR #${pr} is closed without a merge`,
      `${closed}. Answer ${REPUBLISH} to open a new PR for this result, or cancel.`,
      [REPUBLISH, "cancel"],
    );
  }
  const baseBranch = await github.defaultBranch(signal);
  if (pull.base.ref !== baseBranch)
    return hold(
      `PR #${pr} targets ${pull.base.ref}, not the default branch ${baseBranch}. Change its base back and answer retry, or cancel.`,
    );
  const head = await deliveredHead(context, pull, input, baseBranch);
  if (typeof head !== "string") return head;
  if (pull.merged) return { kind: "ready", head, pull, baseBranch };
  const state = await github.mergeState(pr, signal);
  if (
    state.headRefOid !== head ||
    state.headRefName !== pull.head.ref ||
    state.baseRefName !== baseBranch
  )
    return retry(`GitHub's readiness of PR #${pr} does not show ${head} yet`);
  const readiness = READINESS[state.mergeStateStatus];
  if (!readiness)
    return retry(
      `GitHub reports PR #${pr} readiness ${state.mergeStateStatus}, which Factory does not know`,
    );
  if (readiness === "draft" || pull.draft)
    return hold(
      `PR #${pr} was made a draft. Mark it ready, then answer retry; or cancel.`,
    );
  // Strict protection: GitHub merges the base into Factory's head.
  if (readiness === "behind") return updateBranch(context, { pr, head });
  const runs = (await github.checkRuns(head, signal)).filter(
    (run) => run.head_sha === head,
  );
  const statuses = await github.commitStatuses(head, signal);
  const failed = failedChecks(runs, statuses);
  const listed = (checks: FailedCheck[]) =>
    bounded(
      checks.map(
        (check) =>
          `${check.name} (${check.conclusion}${check.url ? `, ${check.url}` : ""})`,
      ),
      "; ",
    );
  const broken = failed.filter(
    (check) => !["cancelled", "stale"].includes(check.conclusion),
  );
  if (broken.length) {
    // Why the first few failed, so a repair is not blind.
    const excerpts: string[] = [];
    for (const check of broken.slice(0, EXCERPTED_CHECKS)) {
      const excerpt = check.run && (await failureExcerpt(context, check.run));
      if (excerpt) excerpts.push(`${check.name}:\n${excerpt}`);
    }
    return {
      kind: "repair",
      finding: [
        `Checks failed on PR #${pr} at ${head}: ${listed(broken)}`,
        ...excerpts,
      ].join("\n\n"),
    };
  }
  // A run cancelled (often by another PR's run in a shared concurrency
  // group) or gone stale says nothing about the change; a repair cannot fix
  // it (#1640).
  if (failed.length)
    return hold(
      `Checks on PR #${pr} ended cancelled or stale, and nothing re-ran them: ${bounded([...new Set(failed.map((check) => check.name))], ", ")} (${listed(failed)}). Re-run them, then answer retry; or cancel.`,
    );
  if (readiness === "conflict")
    return {
      kind: "repair",
      finding: `PR #${pr} conflicts with its base branch; rebase the change`,
    };
  // GitHub can report a PR CLEAN before a required check registers on its
  // head. A required check with no run and no status yet is pending (#626).
  const reported = new Set<string>(
    [
      ...runs.map((run) => run.name),
      ...statuses.map((status) => status.context),
    ].filter((name): name is string => typeof name === "string" && !!name),
  );
  const unreported =
    readiness === "ready"
      ? (await github.requiredChecks(baseBranch, signal)).filter(
          (name) => !reported.has(name),
        )
      : [];
  const pending = [
    ...new Set([
      ...runs
        .filter((run) => run.status !== "completed")
        .map((run) => run.name),
      ...statuses
        .filter((status) => status.state === "pending")
        .map((status) => String(status.context)),
      ...unreported,
    ]),
  ];
  // The plan's own gates: a successful completed run of each name on the head.
  const named = input.requiredChecks.filter((name) => {
    const group = runs.filter((run) => run.name === name);
    return !(
      group.length &&
      group.every(
        (run) => run.status === "completed" && run.conclusion === "success",
      )
    );
  });
  const waiting = named.length
    ? `Awaiting successful plan-required checks on PR #${pr}: ${named.join(", ")}`
    : readiness === "waiting" || pending.length
      ? `Awaiting checks and protection readiness on PR #${pr}${pending.length ? `: ${pending.join(", ")}` : ""}`
      : undefined;
  if (waiting) {
    // Plan-named checks with no run on the head at all.
    const absent = named.filter((name) => !runs.some((r) => r.name === name));
    const renamed = await renamedChecks(
      context,
      { pr, head, baseBranch },
      absent,
      unreported,
    );
    if (renamed) return renamed;
    // A check held for an approval or a runner, a status nobody completes,
    // or a plan-named check that never runs or settles without success,
    // never settles on its own: after a day with the same pending set, ask.
    // A time GitHub doesn't show counts from when this wait began retrying.
    const times = [
      ...runs
        .filter((run) => run.status !== "completed")
        .map((run) => run.started_at),
      ...runs
        .filter((run) => run.status === "completed" && named.includes(run.name))
        .map((run) => run.completed_at),
      ...statuses
        .filter((status) => status.state === "pending")
        .map((status) => status.updated_at),
      ...(unreported.length || absent.length
        ? [await github.pushTime(pull.head.ref, head, signal)]
        : []),
    ].map((time) => (typeof time === "string" ? Date.parse(time) : Number.NaN));
    const began = Date.parse(context.retryingSince ?? "");
    // NaN only before the first retry is recorded: the next poll decides.
    const since = Math.max(
      ...(times.length ? times : [began]).map((time) =>
        Number.isFinite(time) ? time : began,
      ),
    );
    if (Date.now() - since >= ESCALATE_AFTER_MS)
      return hold(
        `Checks on PR #${pr} have been pending since ${new Date(since).toISOString()}: ${pending.join(", ") || named.join(", ") || "unnamed"}. Complete or re-run them, or merge the PR by hand, then answer retry; or cancel.`,
      );
    return { kind: "retry", reason: waiting, afterMs: CI_POLL_MS };
  }
  const unregistered = await unregisteredChecks(
    context,
    pull,
    head,
    runs,
    reported.size > 0,
  );
  return unregistered ?? { kind: "ready", head, pull, baseBranch };
}

/**
 * A check that has not reported on the head and that the default branch's
 * workflows no longer define as a job: renamed or removed after planning,
 * so it would never report. Plan-named checks were jobs at the plan's base;
 * a repository-required one counts only when the head's own workflows
 * define it (other apps report checks no workflow names).
 */
async function renamedChecks(
  context: DeliveryContext,
  at: { pr: number; head: string; baseBranch: string },
  named: string[],
  required: string[],
): Promise<Hold | undefined> {
  if (!named.length && !required.length) return undefined;
  const { checkout, signal } = context;
  const jobs = async (commit: string) =>
    new Set(await workflowCheckNames(new BaseFiles(checkout, commit, signal)));
  const tip = await recentDefaultHead(checkout, signal);
  const defined = await jobs(tip);
  const own = required.length ? await jobs(at.head) : new Set<string>();
  const gone = [
    ...new Set([...named, ...required.filter((name) => own.has(name))]),
  ].filter((name) => !defined.has(name));
  if (!gone.length) return undefined;
  return hold(
    `CI check ${bounded(
      gone.map((name) => JSON.stringify(name)),
      ", ",
    )} has not reported on PR #${at.pr}'s head ${at.head} and is no longer a job in ${at.baseBranch}'s GitHub workflows (at ${tip}), so it will never report. Restore the job under that name on ${at.baseBranch}, then answer retry; or cancel.`,
  );
}

/** Default-branch heads fetched for renamed-check lookups, per checkout. */
const fetchedHeads = new Map<string, { head: string; at: number }>();

/**
 * The default branch head, fetched at most once per DEFAULT_HEAD_REUSE_MS
 * per checkout: a renamed job stays renamed, so CI polls need not fetch.
 */
async function recentDefaultHead(
  checkout: string,
  signal: AbortSignal,
): Promise<string> {
  const known = fetchedHeads.get(checkout);
  if (known && Date.now() - known.at < DEFAULT_HEAD_REUSE_MS) return known.head;
  const head = await defaultHead(checkout, signal);
  fetchedHeads.set(checkout, { head, at: Date.now() });
  return head;
}

const READINESS: Record<
  string,
  "ready" | "waiting" | "behind" | "conflict" | "draft"
> = {
  CLEAN: "ready",
  HAS_HOOKS: "ready",
  // Mergeable; only checks the repository does not require are not
  // passing. Delivery still waits for or fails on those (#1637).
  UNSTABLE: "ready",
  UNKNOWN: "waiting",
  BLOCKED: "waiting",
  BEHIND: "behind",
  DIRTY: "conflict",
  DRAFT: "draft",
};

interface FailedCheck {
  name: string;
  conclusion: string;
  url?: string;
  run?: CheckRun;
}

/**
 * Every check on the head that ended without success, required or not
 * (#1637), once per name and conclusion. A cancelled or stale run with
 * another run of the same name and app on the head that succeeded or is
 * still running was superseded, not failed (#1640).
 */
function failedChecks(
  runs: CheckRun[],
  statuses: Awaited<ReturnType<GitHub["commitStatuses"]>>,
): FailedCheck[] {
  const same = (a: CheckRun, b: CheckRun) =>
    a !== b &&
    a.name === b.name &&
    typeof a.app?.id === "number" &&
    a.app.id === b.app?.id;
  const superseded = (run: CheckRun) =>
    runs.some(
      (other) =>
        same(run, other) &&
        (other.status !== "completed" || other.conclusion === "success"),
    );
  const failed: FailedCheck[] = [];
  const listed = (name: string, conclusion: string) =>
    failed.some(
      (check) => check.name === name && check.conclusion === conclusion,
    );
  for (const run of runs) {
    const conclusion = run.conclusion ?? "";
    if (
      listed(run.name, conclusion) ||
      !(
        ["failure", "timed_out", "action_required", "startup_failure"].includes(
          conclusion,
        ) ||
        (["cancelled", "stale"].includes(conclusion) && !superseded(run))
      )
    )
      continue;
    failed.push({
      name: run.name,
      conclusion,
      ...(run.html_url ? { url: run.html_url } : {}),
      run,
    });
  }
  for (const status of statuses)
    if (
      typeof status.context === "string" &&
      ["error", "failure"].includes(String(status.state)) &&
      !listed(status.context, String(status.state))
    )
      failed.push({
        name: status.context,
        conclusion: String(status.state),
        ...(typeof status.target_url === "string" && status.target_url
          ? { url: status.target_url }
          : {}),
      });
  return failed;
}

/** A large matrix lists its first checks and counts the rest. */
function bounded(items: string[], separator: string): string {
  return items.length > LISTED_CHECKS
    ? `${items.slice(0, LISTED_CHECKS).join(separator)}${separator}and ${items.length - LISTED_CHECKS} more`
    : items.join(separator);
}

/**
 * A failed check run's failure annotations and, for an Actions job, the
 * tail of its log. Best effort: undefined when GitHub shows neither (no
 * access, logs expired), and the finding then names the check only.
 */
async function failureExcerpt(
  context: DeliveryContext,
  check: CheckRun,
): Promise<string | undefined> {
  const parts: string[] = [];
  const tolerate = (error: unknown) => {
    if (context.signal.aborted) throw error;
  };
  try {
    parts.push(
      ...(await context.github.failureAnnotations(check.id, context.signal)),
    );
  } catch (error) {
    tolerate(error);
  }
  if (check.app?.slug === "github-actions")
    try {
      // An Actions check run's id is its job's id.
      const log = await context.github.jobLogTail(check.id, context.signal);
      if (log)
        parts.push(
          log
            // Colour codes would spend the bound without saying anything.
            .replace(ANSI_ESCAPE, "")
            .trimEnd()
            .split("\n")
            .slice(-LOG_TAIL_LINES)
            .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""))
            .join("\n")
            .slice(-LOG_TAIL_CHARS),
        );
    } catch (error) {
      tolerate(error);
    }
  return parts.length ? redact(parts.join("\n"), context.secrets) : undefined;
}

/**
 * A head that may otherwise merge but has no Actions check run: Actions
 * may not have created its check suites yet, or a path filter or push-only
 * workflow never will. A fast check from another app does not end the
 * wait (#1687). Workflow runs on the head without jobs are waited for or
 * asked about. Otherwise wait CHECK_SETTLE_MS from the push. Past it, when
 * other checks passed and GitHub shows no unfinished or failed run, Actions
 * skipped the head and it merges; with no check at all, ask. Factory never
 * merges without registered checks on its own authority (#1640).
 */
async function unregisteredChecks(
  context: DeliveryContext,
  pull: PullRequest,
  head: string,
  runs: CheckRun[],
  others: boolean,
): Promise<Retry | Hold | undefined> {
  if (runs.some((run) => run.app?.slug === "github-actions")) return undefined;
  const { github, signal } = context;
  const pr = pull.number;
  const pushedAt = await github.pushTime(pull.head.ref, head, signal);
  let actions: "running" | "failed" | "completed" | "none" | undefined;
  if (others) {
    const workflows = await github.workflowRuns(head, signal);
    actions = !workflows
      ? undefined
      : workflows.some((run) => run?.status !== "completed")
        ? "running"
        : workflows.some(
              (run) =>
                !["success", "neutral", "skipped"].includes(
                  String(run?.conclusion),
                ),
            )
          ? "failed"
          : workflows.length
            ? "completed"
            : "none";
  }
  if (actions === "failed")
    return hold(
      `Actions workflow runs on PR #${pr}'s head ${head} ended without jobs or success (a startup failure, or awaiting approval). Fix or approve them, then answer retry; or merge the PR by hand, then answer retry; or cancel.`,
    );
  const question = others
    ? `No Actions checks registered on PR #${pr}'s head ${head}, and GitHub does not show ${actions === "running" ? "its runs finishing" : "when it was pushed or its Actions runs"}. Inspect its checks, then answer retry; or merge the PR by hand, then answer retry; or cancel.`
    : `No checks registered on PR #${pr}'s head ${head}: does a path filter or a push-only workflow skip it? Add or fix its checks, then answer retry; or merge the PR by hand, then answer retry; or cancel.`;
  const pushed = Date.parse(pushedAt ?? "");
  // A run held for a concurrency group or a runner: wait, for a day at most.
  if (actions === "running")
    return Date.now() - pushed >= ESCALATE_AFTER_MS
      ? hold(question)
      : {
          kind: "retry",
          reason: `Awaiting Actions workflow runs on PR #${pr} to start their jobs`,
          afterMs: CI_POLL_MS,
        };
  // GitHub's activity can lag the push for a moment; past that, ask.
  if (!Number.isFinite(pushed))
    return lagging(
      context,
      `PR #${pr} shows no ${others ? "Actions " : ""}checks, and GitHub does not show when its head was pushed`,
      question,
    );
  if (Date.now() - pushed >= CHECK_SETTLE_MS)
    return others && actions ? undefined : hold(question);
  return {
    kind: "retry",
    reason: `Awaiting ${others ? "Actions " : ""}checks to register on PR #${pr} (none since its push at ${pushedAt})`,
    afterMs: CI_POLL_MS,
  };
}

// ── Branch update ───────────────────────────────────────────────────────

/**
 * Bring a PR that is BEHIND its base under strict protection up to date:
 * GitHub merges the base into `head`, guarded by the expected head. GitHub
 * makes the merge asynchronously, so this always ends in a retry; the next
 * observation accepts the new head by its shape (see deliveredHead).
 */
function updateBranch(
  context: DeliveryContext,
  input: { pr: number; head: string },
): Promise<Retry | Hold> {
  return guarded(context, async () => {
    const { github, signal } = context;
    const pull = await github.pull(input.pr, signal);
    if (pull.state !== "open" || pull.head.sha !== input.head)
      return retry(`PR #${input.pr} changed before its branch update`);
    crashPoint("deliver:update-branch:before");
    try {
      await github.requestBranchUpdate(input.pr, input.head, signal);
    } catch (error) {
      // The head moved, the branch is current, or the base conflicts: the
      // next observation reads the PR and its readiness again.
      if (!(error instanceof GitHubError && error.status === 422))
        throw needing(error, "Contents: write and Pull requests: write");
    }
    crashPoint("deliver:update-branch:after");
    return {
      kind: "retry",
      reason: `Awaiting GitHub's update of PR #${input.pr} with its base`,
      afterMs: LAG_POLL_MS,
    };
  });
}

/**
 * The PR's head when it delivers Factory's result: the delivered head, or
 * GitHub's update of it. A head Factory pushed earlier is a read that has
 * not caught up with the push; anything else Factory did not make.
 */
async function deliveredHead(
  context: DeliveryContext,
  pull: PullRequest,
  input: PullInput,
  baseBranch: string,
): Promise<string | Retry | Hold> {
  const sha = pull.head.sha;
  if (await updates(context, sha, new Set([input.head]), baseBranch))
    return sha;
  if (input.pushedHeads.includes(sha))
    return lagging(
      context,
      `PR #${pull.number} does not show the pushed head ${input.head} yet`,
      `PR #${pull.number} still shows an earlier head (${sha}), not ${input.head}. Inspect it, then answer retry, or cancel.`,
    );
  return foreign(pull, input.head);
}

/**
 * Whether `sha` is one of `heads`, or GitHub's update-branch of one: a
 * merge committed by web-flow whose first parent is the earlier head and
 * whose second is on the base branch, followed back a few updates.
 */
async function updates(
  context: DeliveryContext,
  sha: string,
  heads: Set<string>,
  baseBranch: string,
): Promise<boolean> {
  for (let step = 0; step <= MAX_BRANCH_UPDATES; step++) {
    if (heads.has(sha)) return true;
    if (!heads.size || !/^[a-f0-9]{40}$/.test(sha)) return false;
    const commit = await context.github.commit(sha, context.signal);
    const [first, merged] = commit.parents;
    if (
      commit.sha !== sha ||
      commit.parents.length !== 2 ||
      commit.committer !== "web-flow" ||
      !first ||
      !merged
    )
      return false;
    const compared = await context.github.compare(
      merged,
      baseBranch,
      context.signal,
    );
    if (compared !== "identical" && compared !== "ahead") return false;
    sha = first;
  }
  return false;
}

// ── Merge ───────────────────────────────────────────────────────────────

export type MergeResult =
  | {
      kind: "merged";
      /** The PR's merge commit. */
      mergeSha: string;
      /** The later of `integrated` and the merge: what the next item builds on. */
      integratedSha: string;
    }
  | Retry
  | Repair
  | Hold
  | Republish;

const MERGE_PERMISSION =
  "Contents: write and Pull requests: write, and a bypass of any ruleset that blocks its merges";

/** Merges run one at a time, so each sees the last one's result. */
let mergeTail: Promise<unknown> = Promise.resolve();

/**
 * Merge the PR with a merge commit, or confirm a merge already made. The
 * readiness is judged again first (a conflict or failed check can appear
 * after the CI wait). The merge is sent with the head as its guard, so it
 * never merges another head. Afterwards the merge must be on the default
 * branch.
 */
export function merge(
  context: DeliveryContext,
  input: PullInput & { integrated?: string },
): Promise<MergeResult> {
  const result = mergeTail.then(() =>
    guarded(context, () => mergeOnce(context, input)),
  );
  mergeTail = result.catch(() => undefined);
  return result;
}

async function mergeOnce(
  context: DeliveryContext,
  input: PullInput & { integrated?: string },
): Promise<MergeResult> {
  const { github, signal } = context;
  const { pr } = input;
  const origin = await originHold(context);
  if (origin) return origin;
  const judged = await judge(context, input);
  if (judged.kind !== "ready") return judged;
  const { head, pull, baseBranch } = judged;
  if (pull.merged) return confirmMerged(context, input, pull);
  if (!(await github.mergeCommitsAllowed(baseBranch, signal)))
    return hold(
      `The repository does not allow merge commits into ${baseBranch}, which Factory needs to bind each delivered head into the default branch. Allow merge commits in the repository settings (Settings → General → Pull Requests) and any ruleset, then answer retry; or cancel.`,
    );
  crashPoint("deliver:merge:before");
  let merged: { merged?: boolean; sha?: string };
  try {
    merged = await github.mergePull(pr, head, signal);
  } catch (error) {
    // 405 "not mergeable" also answers a merge in progress, or one a lost
    // earlier request made; 409 a head that moved. GitHub refuses PUT
    // merge on a PR in a native stack with 403 even once it merged.
    if (
      !(error instanceof GitHubError && [403, 405, 409].includes(error.status))
    )
      throw needing(error, MERGE_PERMISSION);
    const after = await github.pull(pr, signal);
    if (after.merged) return confirmMerged(context, input, after);
    if (error.status === 403) throw needing(error, MERGE_PERMISSION);
    return lagging(
      context,
      `GitHub refused to merge PR #${pr} (HTTP ${error.status})`,
      `GitHub refused to merge PR #${pr} (not mergeable, or a repository rule): ${error.message}. Inspect the pull request, then answer retry; or cancel.`,
    );
  }
  crashPoint("deliver:merge:after");
  // A PR merged meanwhile answers 200 without a fresh merge (#627).
  if (
    merged.merged !== true ||
    typeof merged.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(merged.sha)
  ) {
    const after = await github.pull(pr, signal);
    if (after.merged) return confirmMerged(context, input, after);
    return retry(`GitHub did not confirm the merge of PR #${pr} yet`);
  }
  return integrate(context, input, merged.sha);
}

/**
 * A merged PR whose head is Factory's (judge checked it): its merge commit,
 * from the timeline. A person may have merged it by hand with any method.
 */
async function confirmMerged(
  context: DeliveryContext,
  input: PullInput & { integrated?: string },
  pull: PullRequest,
): Promise<MergeResult> {
  const mergeSha = await context.github.mergeCommitOf(
    pull.number,
    context.signal,
  );
  if (!mergeSha)
    return lagging(
      context,
      `PR #${pull.number} merge is not on its timeline yet`,
      `GitHub shows PR #${pull.number} merged but names no merge commit. Inspect it, then answer retry; or cancel.`,
    );
  return integrate(context, input, mergeSha);
}

/**
 * The merge must be on the default branch. Other work may have merged
 * since, so only ancestry is required. Until GitHub's lag window passes a
 * missing merge is "not yet"; then the default branch lost a merge GitHub
 * confirmed, and Factory asks.
 */
async function integrate(
  context: DeliveryContext,
  input: PullInput & { integrated?: string },
  mergeSha: string,
): Promise<MergeResult> {
  const tip = await defaultHead(context.checkout, context.signal);
  if (!(await ancestor(context, mergeSha, tip)))
    return lagging(
      context,
      `The default branch does not show the merge of PR #${input.pr} (${mergeSha}) yet`,
      `The default branch (at ${tip}) does not contain the merge of PR #${input.pr} (${mergeSha}). Inspect it, then answer retry; or cancel.`,
    );
  // Merges can be recorded out of order, so the integrated head never moves back.
  const recorded = input.integrated;
  if (
    !recorded ||
    recorded === mergeSha ||
    (await ancestor(context, recorded, mergeSha))
  )
    return { kind: "merged", mergeSha, integratedSha: mergeSha };
  if (await ancestor(context, mergeSha, recorded))
    return { kind: "merged", mergeSha, integratedSha: recorded };
  return hold(
    `The merge of PR #${input.pr} (${mergeSha}) and Factory's integrated head ${recorded} have diverged. Inspect the default branch, then answer retry; or cancel.`,
  );
}

/** `git merge-base --is-ancestor`: exit 1 is no, anything else but 0 is an error. */
async function ancestor(
  context: DeliveryContext,
  older: string,
  newer: string,
): Promise<boolean> {
  let result: GitExit;
  try {
    result = await hostGitExit(
      context.checkout,
      ["merge-base", "--is-ancestor", older, newer],
      { signal: context.signal, timeoutMs: MINUTE },
    );
  } catch (error) {
    if (context.signal.aborted || error instanceof GitRefusal) throw error;
    throw new TransientError(
      `git merge-base --is-ancestor ${older} ${newer}: ${message(error)}`,
    );
  }
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new TransientError(
    `git merge-base --is-ancestor ${older} ${newer} ${result.code === null ? `ended by ${result.signal}` : `exited ${result.code}`}: ${result.stderr}`,
  );
}

/**
 * Host Git on the checkout inside delivery: a refusal passes unchanged so
 * the step holds; any other failure is a TransientError (a retry).
 */
async function localGit(
  context: Pick<DeliveryContext, "checkout" | "signal">,
  args: string[],
  options: { signal: AbortSignal },
): Promise<Buffer> {
  try {
    return await hostGit(context.checkout, args, options);
  } catch (error) {
    if (context.signal.aborted || error instanceof GitRefusal) throw error;
    throw new TransientError(message(error));
  }
}

// ── Outcomes ────────────────────────────────────────────────────────────

/** A GitHub refusal of a call that needs `permission`. */
class Refused extends Error {
  constructor(
    readonly error: GitHubError,
    readonly permission: string,
  ) {
    super(error.message);
  }
}

/** Names the permission a GitHub refusal of a write lacks; other errors pass through. */
function needing(error: unknown, permission: string): unknown {
  return error instanceof GitHubError ? new Refused(error, permission) : error;
}

/**
 * GitHub's and git's transient failures become a retry. A rejected login
 * (401) is a hold naming `gh auth login`; GitHub's refusals (403, or a 404
 * the login can't see past) become a hold naming the permission the call
 * needs; its other answers (409, 422, GraphQL errors) may change, so they
 * retry. A GitRefusal, and anything else, escapes to the caller.
 */
async function guarded<T>(
  context: DeliveryContext,
  body: () => Promise<T>,
): Promise<T | Retry | Hold> {
  try {
    return await body();
  } catch (error) {
    if (context.signal.aborted || error instanceof GitRefusal) throw error;
    if (error instanceof TransientError)
      return {
        kind: "retry",
        reason: error.message,
        ...(error.retryAfterMs !== undefined
          ? { afterMs: error.retryAfterMs }
          : {}),
      };
    const refused = error instanceof Refused ? error.error : error;
    if (!(refused instanceof GitHubError)) throw error;
    if (refused.status === 401)
      return hold(
        `GitHub rejected Factory's login on ${context.github.repository} (${refused.message.slice(0, 300)}). Log in again with \`gh auth login\` (or replace FACTORY_GITHUB_TOKEN), then answer retry; or cancel.`,
      );
    if (refused.status === 403 || refused.status === 404)
      return hold(
        `${refused.message.slice(0, 500)}. Give Factory's login ${error instanceof Refused ? error.permission : "read access to the repository, its pull requests and its checks (fine-grained token: Contents, Pull requests, Checks and Commit statuses: read)"} on ${context.github.repository}, then answer retry; or cancel.`,
      );
    return {
      kind: "retry",
      reason: refused.message,
      afterMs: CI_POLL_MS,
    };
  }
}

function retry(reason: string): Retry {
  return { kind: "retry", reason, afterMs: LAG_POLL_MS };
}

/**
 * Something GitHub may not show yet: a retry while the step has been
 * retrying for less than GitHub's lag window, then the question.
 */
function lagging(
  context: DeliveryContext,
  reason: string,
  question: string,
  answers?: string[],
): Retry | Hold {
  const since = Date.parse(context.retryingSince ?? "");
  return Number.isFinite(since) && Date.now() - since >= GITHUB_LAG_MS
    ? hold(question, answers)
    : retry(reason);
}

function foreign(pull: PullRequest, expected: string): Hold {
  return hold(
    `PR #${pull.number} (${pull.head.ref}) now has head ${pull.head.sha}, a change Factory did not make (it delivered ${expected}). Inspect it, then answer retry; or cancel.`,
  );
}

function message(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return (
    (typeof stderr === "string" && stderr.trim()) ||
    errorMessage(error)
  ).slice(0, 2000);
}
