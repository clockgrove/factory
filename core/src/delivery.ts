/**
 * Regular PR delivery for one Work Item: push its result to its fixed
 * branch, find or open its PR, wait for CI on the exact head, bring the
 * branch up to date, and merge with a merge commit. Every effect is found
 * on GitHub before it is made (CORE.md#Idempotence), so a step that runs
 * again carries on from whatever the last run left. Each function returns
 * data the item steps return as their outcome; GitHub's and Git's
 * failures escape to the engine, which maps them in one place (workflow.ts
 * `errorOutcome`).
 *
 * Native-stack delivery reuses publish and observeCi per layer, with the
 * layer below as the PR's base, and merges the whole chain at once with
 * mergeUnit.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { crashPoint } from "./crash.js";
import {
  type HoldAfter,
  hold,
  type Offer,
  type Outcome,
  objectiveWide,
} from "./engine.js";
import {
  defaultHead,
  GitRefusal,
  originBound,
  originRefusal,
  pathsHoldingSecrets,
  pinnedGitExit,
  sha256,
} from "./git.js";
import {
  type AsyncMerge,
  type CheckRun,
  type GitHub,
  GitHubError,
  needing,
  type PullRequest,
  type Stack,
  TransientError,
  Unreadable,
} from "./github.js";
import { redact } from "./log.js";
import { lfsObjectsHoldingSecrets, lfsPushIfPointers } from "./media.js";
import { BaseFiles, workflowCheckNames } from "./planning/facts.js";
import type { WorkItem } from "./planning/types.js";
import { errorMessage } from "./text.js";
import { FACTORY_EMAIL } from "./work/collect.js";
import { hostGit, isAncestor } from "./worktree.js";

const MINUTE = 60_000;
/** How long GitHub may not yet show what Factory just did. */
const GITHUB_LAG_MS = 2 * MINUTE;
/**
 * How long a newly pushed head may show no run or status of a check it
 * needs before Factory asks: a check that never registers, or a workflow
 * that didn't trigger, needs a person (CORE.md#Waits).
 */
const CHECK_SETTLE_MS = 15 * MINUTE;
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
  /**
   * The change doesn't sit on its base: it conflicts with it, or a stack
   * layer doesn't contain the layer below. The repair is mechanical: move
   * the change onto the current base (`onto`, when Factory knows the head)
   * and let the worker resolve what conflicts, with no diagnosis.
   */
  conflict?: { onto?: string };
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
const REPUBLISHING: Offer = {
  answer: REPUBLISH,
  family: "retry",
  consequence: "Opens a new PR for the current result.",
};

/**
 * The answer that replaces a Factory branch holding commits Factory did not
 * make with the current result: the publish step passes `reset: true`.
 */
export const RESET_BRANCH = "reset";

/** Commits beyond the default branch checked for Factory's ownership; more is not Factory's. */
const MAX_OWNED_COMMITS = 250;

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
}

/**
 * The fixed branch of a Work Item; the only key that finds its PR again.
 * A native-stack layer above the bottom passes its predecessor's branch as
 * `baseBranch` to publish and observeCi.
 */
export function itemBranch(issue: number, item: string): string {
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
  /** The operator answered RESET_BRANCH: replace the branch whoever made it. */
  reset?: boolean;
  /** The values no pushed blob may hold (config.secrets). */
  secrets: readonly string[];
  /** The digest of a secret finding the operator let through (`publish`). */
  allowSecret?: string;
  /**
   * The PR's base: omitted (the default branch) for a regular item or the
   * bottom layer of a native stack; the predecessor layer's branch
   * (`itemBranch(issue, predecessor)`) for a layer above it.
   */
  baseBranch?: string;
  /** The Objective's run (state.ts runOf), marked in the PR body for `factory reset`. */
  run?: string;
}

/**
 * The bases a PR may show: the one Factory set, or the default branch,
 * which GitHub retargets a layer to once the layer below it has merged.
 */
async function acceptedBases(
  context: DeliveryContext,
  baseBranch: string | undefined,
): Promise<{ expected: string; defaultBranch: string; bases: string[] }> {
  const defaultBranch = await context.github.defaultBranch(context.signal);
  const expected = baseBranch ?? defaultBranch;
  return {
    expected,
    defaultBranch,
    bases: [...new Set([expected, defaultBranch])],
  };
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
  /**
   * A blob the push would add holds a secret value; nothing was pushed.
   * `digest` names this finding on this commit, for the operator's answer.
   */
  | { kind: "secret"; finding: string; digest: string }
  | Retry
  | Repair
  | Hold;

/**
 * Put the result on `factory/<issue>/<item>` and find or open its PR.
 * The remote branch is read first: holding the commit (or GitHub's update
 * of it), nothing is pushed; holding a head Factory pushed earlier, or
 * nothing, it is pushed with a lease on exactly that; holding anything
 * else, Factory asks. Before a push, the LFS objects behind any pointer the
 * result adds are uploaded (Factory runs no pre-push hook); a pointer with
 * no object is a `repair`. The PR is found by its head branch; only when
 * there is none is one opened, so a lost create is found by the next run.
 *
 * Before a push, a blob the result adds or changes that holds a value of
 * `secrets` stops it: `secret`, unless `allowSecret` is that finding's
 * digest.
 *
 * Outcomes for the publish step: `published` → done; `empty` and `repair`
 * → the item's delivery repair with the finding; `secret` → a hold whose
 * `repair` answer sends the finding to the worker and whose `publish`
 * answer lets exactly that finding through; `retry` and `hold` as
 * they are.
 */
export async function publish(
  context: DeliveryContext,
  input: PublishInput,
): Promise<PublishResult> {
  const { github, signal } = context;
  const branch = itemBranch(input.issue, input.item.id);
  const {
    expected: baseBranch,
    defaultBranch,
    bases,
  } = await acceptedBases(context, input.baseBranch);
  const current = new Set([input.commit]);
  const earlier = new Set(input.pushedHeads.filter((h) => h !== input.commit));
  const known = new Set([...current, ...earlier]);
  let pulls = await github.pullsByHead(branch, signal);
  const merged = pulls.filter((pull) => pull.merged_at);
  // A merged PR of this result: the merge step confirms it.
  for (const pull of merged)
    if (await updates(context, pull.head.sha, current, bases))
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
      if (await updates(context, pull.head.sha, earlier, bases))
        return hold(
          `PR #${pull.number} merged an earlier head of ${branch} (${pull.head.sha}), not the current result ${input.commit}, so that result is not on ${baseBranch}. Answer ${REPUBLISH} to open a new PR for the current result, or cancel.`,
          [REPUBLISHING, "cancel"],
        );
  const remote = await remoteHead(context, branch);
  // The branch's head once pushed: the commit, or GitHub's update of it.
  let delivered = remote ?? input.commit;
  if (!remote || !(await updates(context, remote, current, bases))) {
    // A branch whose every commit Factory made (a head of an earlier run,
    // before a replan or a re-queue) is Factory's own: the push below
    // resets it, with a lease on exactly that head. Anyone else's commit
    // on it is never overwritten without the operator's answer.
    if (
      remote &&
      !input.reset &&
      !(await updates(context, remote, earlier, bases)) &&
      !(await factoryMade(context, remote, defaultBranch, bases))
    )
      return hold(
        `Remote branch ${branch} holds commits Factory did not make (head ${remote}; Factory pushed ${[...known].join(", ")}). Move them off the branch and answer retry; answer ${RESET_BRANCH} to replace the branch with Factory's result, dropping them from it; or cancel.`,
        [
          {
            answer: "retry",
            family: "retry",
            consequence:
              "Pushes again once the commits are moved off the branch.",
          },
          {
            answer: RESET_BRANCH,
            family: "reset",
            consequence:
              "Replaces the branch with Factory's result, dropping the commits Factory did not make.",
          },
          "cancel",
        ],
      );
    // Nothing Factory pushes carries a secret value it knows (config.secrets).
    const leaked = [
      ...(await pathsHoldingSecrets(
        context.checkout,
        input.base,
        input.commit,
        input.secrets,
        signal,
      )),
      ...(await lfsObjectsHoldingSecrets(
        context.checkout,
        input.base,
        input.commit,
        input.secrets,
        signal,
      )),
    ];
    if (leaked.length) {
      const finding = `The result writes the value of a secret Factory redacts (a policy.allowedSecretNames variable or a managed provider's credential), as written or base64-encoded, into ${leaked.map((path) => JSON.stringify(path)).join(", ")}. Remove it from those files and never write a secret's value into the repository.`;
      const digest = sha256(Buffer.from(`${input.commit}\n${finding}`)).slice(
        0,
        16,
      );
      if (input.allowSecret !== digest)
        return { kind: "secret", finding, digest };
    }
    // Only before a push: a branch that holds the result already has its
    // objects. The upload is by object id, so a rerun repeats it safely.
    crashPoint("deliver:lfs-push:before");
    const media = await lfsPushIfPointers({
      checkout: context.checkout,
      repository: github.repository,
      base: input.base,
      commit: input.commit,
      signal,
    });
    crashPoint("deliver:lfs-push:after");
    if (media.kind === "retry") return retry(media.reason);
    if (media.kind !== "done") return media;
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
    if (!bases.includes(pull.base.ref))
      return hold(
        `PR #${pull.number} for ${branch} targets ${pull.base.ref}, not ${baseBranch}. Change its base back and answer retry, or cancel.`,
      );
    if (await updates(context, pull.head.sha, current, bases))
      return {
        kind: "published",
        pr: pull.number,
        head: pull.head.sha,
        merged: false,
      };
    if (await updates(context, pull.head.sha, earlier, bases))
      return lagging(
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
    if (!(error instanceof GitHubError && error.status === 422))
      throw needing(error, "Pull requests: write");
    // GitHub's compare status decides, not its error text: a result
    // identical to or behind the base adds nothing, an empty change.
    const status = await github.compare(baseBranch, input.commit, signal);
    if (status === "identical" || status === "behind")
      return {
        kind: "empty",
        finding: `The result ${input.commit} adds no commits to ${baseBranch} (GitHub compares it as ${status}). The Work Item's change is empty or already on ${baseBranch}: make the change the Work Item asks for.`,
      };
    // A PR for the branch exists already (a create whose answer was lost).
    return retry(`GitHub refused a second PR for ${branch}: ${error.message}`);
  }
  crashPoint("deliver:pr-create:after");
  return {
    kind: "published",
    pr: created.number,
    head: delivered,
    merged: false,
  };
}

/**
 * Whether Factory made every commit `remote` has beyond the default branch:
 * each is committed as FACTORY_EMAIL (Factory commits with a clean Git
 * environment; an amend, rebase or cherry-pick by anyone else changes the
 * committer), or is GitHub's update-branch merge (updateMerge) whose first
 * parent is one of those commits and whose other is on one of the item's
 * accepted `bases` (a stack layer's predecessor branch too), as updates()
 * accepts. The whole range is read; a range too long to read is not
 * Factory's.
 */
async function factoryMade(
  context: DeliveryContext,
  remote: string,
  defaultBranch: string,
  bases: readonly string[],
): Promise<boolean> {
  const { total, commits } = await context.github.commitsBeyond(
    defaultBranch,
    remote,
    MAX_OWNED_COMMITS,
    context.signal,
  );
  if (total > commits.length) return false;
  const range = new Set(commits.map((commit) => commit.sha));
  for (const commit of commits)
    if (
      commit.committerEmail !== FACTORY_EMAIL &&
      !(
        range.has(commit.parents[0] ?? "") &&
        (await updateMerge(context, commit, bases))
      )
    )
      return false;
  return true;
}

/**
 * Delete Factory's branch once its PR merged (a native stack's layers once
 * the whole unit merged) or cancel closed it. Only a branch whose every
 * commit beyond the default branch is Factory's (factoryMade) goes, by a
 * push with a lease on the head read, so a commit pushed meanwhile keeps
 * it. A branch already gone (GitHub's auto-delete, or a run before a
 * crash) is done. Returns why a branch was kept; a refused delete never
 * blocks the step. A failure to reach origin throws, for a retry.
 * `baseBranch` is a stack layer's predecessor branch, as for publish.
 */
export async function deleteFactoryBranch(
  context: DeliveryContext,
  branch: string,
  point: string,
  baseBranch?: string,
): Promise<string | undefined> {
  const remote = await remoteHead(context, branch);
  if (!remote) return undefined;
  const { defaultBranch, bases } = await acceptedBases(context, baseBranch);
  if (!(await factoryMade(context, remote, defaultBranch, bases)))
    return `${branch} holds commits Factory did not make`;
  crashPoint(`${point}:before`);
  const toOrigin = await originGit(context);
  try {
    await toOrigin([
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${branch}:${remote}`,
      "origin",
      `:refs/heads/${branch}`,
    ]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    const refused = pushRefusal(
      (error as { stdout?: unknown }).stdout?.toString() ?? "",
    );
    if (!refused)
      throw new TransientError(
        `git push --delete ${branch}: ${message(error)}`,
      );
    if (!(await remoteHead(context, branch))) return undefined;
    return `the remote refused deleting ${branch} (${refused})`;
  }
  crashPoint(`${point}:after`);
  return undefined;
}

/** The hidden marker in the body of every PR Factory opens. */
function pullMarker(issue: number, item: string): string {
  return `<!-- factory:${issue}:pr:${item} -->`;
}

/** Push with a lease on `remote`; undefined once the branch holds `commit`. */
async function pushBranch(
  context: DeliveryContext,
  branch: string,
  commit: string,
  remote: string | undefined,
): Promise<Retry | Hold | undefined> {
  crashPoint("deliver:push:before");
  const toOrigin = await originGit(context);
  try {
    await toOrigin([
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
        return objectiveWide(
          hold(
            `Factory's login may not push to ${context.github.repository} (git push of ${branch} failed: ${message(error).slice(0, 300)}). Give it write access (fine-grained token: Contents: write), then answer retry; or cancel.`,
          ),
        );
      throw new TransientError(`git push of ${branch}: ${message(error)}`);
    }
    // The ref was not updated. If the branch moved after it was read, read
    // it again; if it did not, the remote refuses the push itself.
    if ((await remoteHead(context, branch)) !== remote)
      return retry(`Remote branch ${branch} moved during the push`);
    return objectiveWide(
      hold(
        `The remote refused Factory's push of ${branch} (${refused}) although the branch did not move. Allow Factory's login to push and force-push its own branches (factory/*), then answer retry; or cancel.`,
      ),
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
  const toOrigin = await originGit(context);
  try {
    listed = await toOrigin(["ls-remote", "origin", `refs/heads/${branch}`]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new TransientError(`git ls-remote ${branch}: ${message(error)}`);
  }
  return listed.split(/\s+/)[0] || undefined;
}

/**
 * The origin check (git.ts originBound), then a runner for one remote Git
 * call. Bind before the call's `try`: the GitRefusal escapes every catch
 * here, and the step holds (workflow.ts errorOutcome).
 */
function originGit(
  context: DeliveryContext,
): Promise<(args: string[]) => Promise<string>> {
  return originBound(
    context.checkout,
    context.github.repository,
    context.signal,
  );
}

/** Before a merge, which reaches GitHub, not origin: the origin check as a hold. */
async function originHold(context: DeliveryContext): Promise<Hold | undefined> {
  const refusal = await originRefusal(
    context.checkout,
    context.github.repository,
    context.signal,
  );
  return refusal ? objectiveWide(hold(refusal.message)) : undefined;
}

// ── PR body ─────────────────────────────────────────────────────────────

/** Factory's PR text: the goal, links, changed paths, passing commands and the candidate. No model call. */
async function pullRequestBody(
  context: Pick<DeliveryContext, "github" | "checkout" | "signal">,
  input: PublishInput,
): Promise<string> {
  const safe = (value: string) => redact(value);
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
    pullMarker(input.issue, input.item.id),
    ...(input.run ? [`<!-- factory-run:${input.run} -->`] : []),
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
  /** The PR's base, as given to publish (see PublishInput.baseBranch). */
  baseBranch?: string;
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
 * re-ran, with a needed check that never registered, or with no checks at
 * all, is a question (#1640). Checks queued or running are a transient
 * wait; an environment approval or a required review is a human gate the
 * engine waits on without a deadline (CORE.md#Waits).
 */
export async function observeCi(
  context: DeliveryContext,
  input: PullInput,
): Promise<CiResult> {
  const judged = await judge(context, input);
  return judged.kind === "ready"
    ? {
        kind: "ready",
        head: judged.head,
        merged: judged.pull.merged === true,
      }
    : judged;
}

type Judged =
  | { kind: "ready"; head: string; pull: PullRequest; defaultBranch: string }
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
      `PR #${pr} is closed without a merge`,
      `${closed}. Answer ${REPUBLISH} to open a new PR for this result, or cancel.`,
      [REPUBLISHING, "cancel"],
    );
  }
  const { expected, defaultBranch, bases } = await acceptedBases(
    context,
    input.baseBranch,
  );
  if (!bases.includes(pull.base.ref))
    return hold(
      `PR #${pr} targets ${pull.base.ref}, not ${expected}. Change its base back and answer retry, or cancel.`,
    );
  const baseBranch = pull.base.ref;
  const head = await deliveredHead(context, pull, input, bases);
  if (typeof head !== "string") return head;
  if (pull.merged) return { kind: "ready", head, pull, defaultBranch };
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
  if (readiness === "behind") return updateBranch(context, { pr, head, bases });
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
      conflict: {},
    };
  // A required check with no run and no status yet is pending, whatever
  // GitHub's readiness says: CLEAN can come before it registers (#626), and
  // a missing one makes the PR BLOCKED. Missing required checks are judged
  // before any gate, so one that never registers reaches the hold below
  // instead of reading as a wait for a review.
  const reported = new Set<string>(
    [
      ...runs.map((run) => run.name),
      ...statuses.map((status) => status.context),
    ].filter((name): name is string => typeof name === "string" && !!name),
  );
  const unreported = (await github.requiredChecks(baseBranch, signal)).filter(
    (name) => !reported.has(name),
  );
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
      { pr, head, baseBranch: defaultBranch },
      absent,
      unreported,
    );
    if (renamed) return renamed;
    // A required or plan-named check with no run or status a while after
    // the push never registered: a person must trigger or fix it.
    // The engine asks once the wait has gone on CHECK_SETTLE_MS from the
    // push, or from when Factory began waiting when GitHub doesn't say.
    const missing = [...new Set([...unreported, ...absent])];
    let settle: HoldAfter | undefined;
    if (missing.length) {
      const pushedAt = await github.pushTime(pull.head.ref, head, signal);
      const pushed = Number.isFinite(Date.parse(pushedAt ?? ""));
      settle = {
        ms: CHECK_SETTLE_MS,
        question: `Check ${bounded(
          missing.map((name) => JSON.stringify(name)),
          ", ",
        )} has no run or status on PR #${pr}'s head ${head} ${CHECK_SETTLE_MS / MINUTE} minutes after ${pushed ? `its push at ${pushedAt}` : "Factory began waiting"}, though ${absent.length ? "the plan" : "branch protection"} requires it. Trigger or fix the workflow that reports it, then answer retry; or cancel.`,
        ...(pushed ? { since: pushedAt! } : {}),
      };
    }
    // Jobs held for an environment's approval, or a review the branch
    // requires once every required check is there: people outside Factory
    // decide, so there is no deadline.
    const approvals = runs
      .filter((run) => run.status === "waiting")
      .map((run) => run.name);
    const gate = approvals.length
      ? `an environment approval for ${bounded(approvals, ", ")} on PR #${pr}`
      : readiness === "waiting" &&
          !pending.length &&
          !named.length &&
          ["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(
            state.reviewDecision ?? "",
          )
        ? `a required review on PR #${pr}`
        : undefined;
    return {
      kind: "retry",
      reason: gate ? `Waiting on ${gate}` : waiting,
      afterMs: CI_POLL_MS,
      ...(gate ? { wait: { kind: "gate", gate } } : {}),
      ...(settle ? { holdAfter: settle } : {}),
    };
  }
  const unregistered = await unregisteredChecks(
    context,
    pull,
    head,
    runs,
    reported.size > 0,
  );
  return unregistered ?? { kind: "ready", head, pull, defaultBranch };
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
  const tip = await recentDefaultHead(context);
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
async function recentDefaultHead(context: DeliveryContext): Promise<string> {
  const { checkout, github, signal } = context;
  const known = fetchedHeads.get(checkout);
  if (known && Date.now() - known.at < DEFAULT_HEAD_REUSE_MS) return known.head;
  const head = await defaultHead(checkout, github.repository, signal);
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
  return parts.length ? redact(parts.join("\n")) : undefined;
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
  let approval = false;
  if (others) {
    const workflows = await github.workflowRuns(head, signal);
    approval = Boolean(workflows?.some((run) => run?.status === "waiting"));
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
    ? `No Actions checks registered on PR #${pr}'s head ${head}, and GitHub does not show when it was pushed or its Actions runs. Inspect its checks, then answer retry; or merge the PR by hand, then answer retry; or cancel.`
    : `No checks registered on PR #${pr}'s head ${head}: does a path filter or a push-only workflow skip it? Add or fix its checks, then answer retry; or merge the PR by hand, then answer retry; or cancel.`;
  const pushed = Date.parse(pushedAt ?? "");
  // A run held for a concurrency group or a runner is a transient wait; one
  // held for an environment's approval waits on that person.
  if (actions === "running")
    return approval
      ? {
          kind: "retry",
          reason: `Waiting on an environment approval for Actions workflow runs on PR #${pr}`,
          afterMs: CI_POLL_MS,
          wait: {
            kind: "gate",
            gate: `an environment approval for Actions workflow runs on PR #${pr}`,
          },
        }
      : {
          kind: "retry",
          reason: `Awaiting Actions workflow runs on PR #${pr} to start their jobs`,
          afterMs: CI_POLL_MS,
        };
  // GitHub's activity can lag the push for a moment; past that, ask.
  if (!Number.isFinite(pushed))
    return lagging(
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
 * Bring a PR up to date with its base: one BEHIND its base under strict
 * protection, or a stack layer that doesn't contain the layer below it.
 * GitHub merges the base into `head`, guarded by the expected head, while
 * the PR still targets one of `bases` (a stack layer's predecessor branch,
 * or the default branch). No worker runs. GitHub makes the merge
 * asynchronously, so this ends in a retry; the next observation accepts
 * the new head by its shape (see deliveredHead).
 */
async function updateBranch(
  context: DeliveryContext,
  input: { pr: number; head: string; bases: string[] },
  /**
   * What a refused update is when GitHub shows the unmoved head conflicting
   * with its base: a stack layer's conflict with the layer below. Any other
   * refusal, or none given, retries: the next observation reads the PR and
   * its readiness again.
   */
  refused?: Repair,
): Promise<Retry | Hold | Repair> {
  const { github, signal } = context;
  const pull = await github.pull(input.pr, signal);
  if (
    pull.state !== "open" ||
    pull.head.sha !== input.head ||
    !input.bases.includes(pull.base.ref)
  )
    return retry(`PR #${input.pr} changed before its branch update`);
  crashPoint("deliver:update-branch:before");
  try {
    await github.requestBranchUpdate(input.pr, input.head, signal);
  } catch (error) {
    // The head moved, the branch is current, or the base conflicts: the
    // next observation reads the PR and its readiness again.
    if (!(error instanceof GitHubError && error.status === 422))
      throw needing(error, "Contents: write and Pull requests: write");
    // A 422 also answers a repeat request while GitHub's first update is
    // still pending: only a head GitHub shows conflicting is refused.
    if (refused) {
      const state = await github.mergeState(input.pr, signal);
      if (state.headRefOid === input.head && state.mergeStateStatus === "DIRTY")
        return refused;
    }
  }
  crashPoint("deliver:update-branch:after");
  return {
    kind: "retry",
    reason: `Awaiting GitHub's update of PR #${input.pr} with its base`,
    afterMs: LAG_POLL_MS,
  };
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
  bases: string[],
): Promise<string | Retry | Hold> {
  const sha = pull.head.sha;
  if (await updates(context, sha, new Set([input.head]), bases)) return sha;
  if (input.pushedHeads.includes(sha))
    return lagging(
      `PR #${pull.number} does not show the pushed head ${input.head} yet`,
      `PR #${pull.number} still shows an earlier head (${sha}), not ${input.head}. Inspect it, then answer retry, or cancel.`,
    );
  return foreign(pull, input.head);
}

/**
 * Whether `sha` is one of `heads`, or GitHub's update-branch of one
 * (updateMerge) whose first parent is the earlier head, followed back a
 * few updates.
 */
async function updates(
  context: DeliveryContext,
  sha: string,
  heads: Set<string>,
  bases: string[],
): Promise<boolean> {
  for (let step = 0; step <= MAX_BRANCH_UPDATES; step++) {
    if (heads.has(sha)) return true;
    if (!heads.size || !/^[a-f0-9]{40}$/.test(sha)) return false;
    const commit = await context.github.commit(sha, context.signal);
    if (commit.sha !== sha || !(await updateMerge(context, commit, bases)))
      return false;
    sha = commit.parents[0]!;
  }
  return false;
}

/**
 * Whether `commit` is GitHub's update-branch merge and nothing more: two
 * parents, committed by web-flow, the second on one of `bases`, and its
 * tree exactly what `git merge-tree` makes of the two parents. Anyone can
 * commit as web-flow (GitHub attributes noreply@github.com to it); only
 * the tree check shows the merge adds nothing of its own. The commit is
 * fetched from origin when the checkout lacks it.
 */
async function updateMerge(
  context: DeliveryContext,
  commit: { sha: string; parents: string[]; committer?: string },
  bases: readonly string[],
): Promise<boolean> {
  const [first, merged] = commit.parents;
  if (
    commit.parents.length !== 2 ||
    commit.committer !== "web-flow" ||
    !first ||
    !merged ||
    !/^[a-f0-9]{40}$/.test(commit.sha)
  )
    return false;
  let onBase = false;
  for (const base of bases) {
    const compared = await context.github.compare(merged, base, context.signal);
    if (compared === "identical" || compared === "ahead") {
      onBase = true;
      break;
    }
  }
  if (!onBase) return false;
  const git = (args: string[]) =>
    pinnedGitExit(context.checkout, args, { signal: context.signal });
  if ((await git(["cat-file", "-e", `${commit.sha}^{commit}`])).code !== 0) {
    const toOrigin = await originGit(context);
    try {
      await toOrigin(["fetch", "--quiet", "--no-tags", "origin", commit.sha]);
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new TransientError(`git fetch ${commit.sha}: ${message(error)}`);
    }
  }
  const local = await git([
    "rev-parse",
    `${commit.sha}^1`,
    `${commit.sha}^2`,
    `${commit.sha}^{tree}`,
  ]);
  const [one, two, tree] = local.stdout.toString("utf8").trim().split("\n");
  if (local.code !== 0 || one !== first || two !== merged || !tree)
    throw new TransientError(
      `git can't read the parents and tree of ${commit.sha}: ${local.stderr}`,
    );
  const made = await git(["merge-tree", "--write-tree", first, merged]);
  // 1: the parents conflict, so no merge GitHub made can be this one.
  if (made.code === 1) return false;
  if (made.code !== 0)
    throw new TransientError(
      `git merge-tree ${first} ${merged}: ${made.stderr}`,
    );
  return made.stdout.toString("utf8").split("\n")[0] === tree;
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
  const result = mergeTail.then(() => mergeOnce(context, input));
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
  const { head, pull, defaultBranch } = judged;
  if (pull.merged) return confirmMerged(context, input, pull);
  const disallowed = await mergeCommitsHold(context, defaultBranch);
  if (disallowed) return disallowed;
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
  return integrate(context, input.pr, input.integrated, merged.sha);
}

async function mergeCommitsHold(
  context: DeliveryContext,
  defaultBranch: string,
): Promise<Hold | undefined> {
  return (await context.github.mergeCommitsAllowed(
    defaultBranch,
    context.signal,
  ))
    ? undefined
    : objectiveWide(
        hold(
          `The repository does not allow merge commits into ${defaultBranch}, which Factory needs to bind each delivered head into the default branch. Allow merge commits in the repository settings (Settings → General → Pull Requests) and any ruleset, then answer retry; or cancel.`,
        ),
      );
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
      `PR #${pull.number} merge is not on its timeline yet`,
      `GitHub shows PR #${pull.number} merged but names no merge commit. Inspect it, then answer retry; or cancel.`,
    );
  return integrate(context, input.pr, input.integrated, mergeSha);
}

/**
 * The merge must be on the default branch. Other work may have merged
 * since, so only ancestry is required. Until GitHub's lag window passes a
 * missing merge is "not yet"; then the default branch lost a merge GitHub
 * confirmed, and Factory asks.
 */
async function integrate(
  context: DeliveryContext,
  pr: number,
  integrated: string | undefined,
  mergeSha: string,
): Promise<Extract<MergeResult, { kind: "merged" }> | Retry | Hold> {
  const tip = await defaultHead(
    context.checkout,
    context.github.repository,
    context.signal,
  );
  if (!(await isAncestor(context.checkout, mergeSha, tip, context.signal)))
    return lagging(
      `The default branch does not show the merge of PR #${pr} (${mergeSha}) yet`,
      `The default branch (at ${tip}) does not contain the merge of PR #${pr} (${mergeSha}). Inspect it, then answer retry; or cancel.`,
    );
  // Merges can be recorded out of order, so the integrated head never moves back.
  if (
    !integrated ||
    integrated === mergeSha ||
    (await isAncestor(context.checkout, integrated, mergeSha, context.signal))
  )
    return { kind: "merged", mergeSha, integratedSha: mergeSha };
  if (await isAncestor(context.checkout, mergeSha, integrated, context.signal))
    return { kind: "merged", mergeSha, integratedSha: integrated };
  return hold(
    `The merge of PR #${pr} (${mergeSha}) and Factory's integrated head ${integrated} have diverged. Inspect the default branch, then answer retry; or cancel.`,
  );
}

// ── Native stack ────────────────────────────────────────────────────────

/**
 * How long one merge step polls a pending stack merge inside the merge
 * lock; then it retries outside the lock, so other merges are not held up.
 */
const STACK_MERGE_POLL_MS = 6_000;
const STACK_POLL_INTERVAL_MS = 2_000;
const STACK_PERMISSION =
  "Contents: write and Pull requests: write, with stacked pull requests enabled for the repository";
/**
 * How to deliver without native stacks. The service reads delivery.kind
 * once at start and an Objective's plan was split by it, so a retry never
 * changes it: the Objective runs again under the new setting.
 */
const WITHOUT_STACKS = `To deliver without native stacks instead, cancel, set the installation's delivery.kind to regular, restart the service and queue the Objective again`;

/** A delivery result pinned to the layer (Work Item) it belongs to. */
export type LayerResult = (Retry | Repair | Hold | Republish) & {
  item: string;
};

export type UnitMergeResult =
  | {
      kind: "merged";
      /** The unit's merge commit (the top layer's; one shared by every layer). */
      mergeSha: string;
      /** The later of `integrated` and the merge: what the next item builds on. */
      integratedSha: string;
      /** Every layer's item, bottom first: each is merged with `mergeSha`. */
      items: string[];
    }
  | LayerResult;

interface Layer {
  input: PullInput;
  /** Factory's head of the layer, as judged. */
  head: string;
  pull: PullRequest;
}

/**
 * Merge a native-stack delivery unit (a linear chain of Work Items, bottom
 * first) as one effect, or confirm the merge already made. A one-layer unit
 * is a regular merge.
 *
 * In order: every layer is judged again (each against the branch below it,
 * the bottom against the default branch), so a failed check or conflict is
 * pinned to its own layer; merge commits must be allowed; the stack is found
 * by its bottom PR, or created and checked; each layer must contain the
 * head of the layer below it (GitHub merges that head into a layer that
 * doesn't, as it updates a BEHIND bottom layer; only a conflict is the
 * layer's repair); then GitHub merges it through the top PR at
 * Factory's top head. Every layer must then be merged at its own head with
 * one shared merge commit, on the default branch, on every path (fresh,
 * already merged, refused as merged, after a crash). Layers merged with
 * different commits, or only some layers merged, are a question once
 * GitHub's lag window has passed.
 *
 * Nothing is recorded between runs. A run after a crash or a lost answer
 * finds the stack by its bottom PR, and a repeated merge request is answered
 * with the pending request (409, polled) or a refusal of merged layers (403,
 * confirmed), so nothing is created or merged twice.
 *
 * How the merge step of the unit's top item calls it:
 * - `layers`: each layer's `PullInput` (as for observeCi, with `head` from
 *   its CI step), bottom first. Their `baseBranch` is set here from the
 *   order. `integrated`: as for merge.
 * - `merged` → `done` with `{ mergeSha, integratedSha }`; every item in
 *   `items` counts as merged at `mergeSha`.
 * - `repair` → the delivery repair of `item` (the layer that failed, or a
 *   layer GitHub can't update with its predecessor's head), which also
 *   clears the layers above it.
 * - `republish` → the republish repair of `item`.
 * - `retry` and `hold` → returned as they are; `item` names the layer the
 *   wait or question is about (the top layer for the unit as a whole). A
 *   failed merge request, a refused stack creation and stack data Factory
 *   can't read retry, then hold after GitHub's lag window.
 * - Escaped exceptions are the engine's retry, as for every step.
 * - `accept`: the operator answered ACCEPT to a partial-merge or
 *   different-merge-commit question. The unit is delivered when every
 *   layer is merged at Factory's head and each merge commit is on the
 *   default branch; otherwise the question names what is still missing.
 */
export function mergeUnit(
  context: DeliveryContext,
  layers: [PullInput, ...PullInput[]],
  integrated?: string,
  accept?: boolean,
): Promise<UnitMergeResult> {
  const result = mergeTail.then(() =>
    accept && layers.length > 1
      ? acceptUnit(context, layers, integrated)
      : mergeUnitOnce(context, layers, integrated),
  );
  mergeTail = result.catch(() => undefined);
  return result;
}

function pin(result: Retry | Repair | Hold | Republish, item: PullInput) {
  return { ...result, item: item.item };
}

/**
 * The answer that takes a native stack merged by other means (layer by
 * layer, or with different merge commits) as delivered. Steps pass it to
 * mergeUnit as `accept`.
 */
export const ACCEPT = "accept";
const ACCEPTING: Offer = {
  answer: ACCEPT,
  family: "accept",
  consequence:
    "Takes the stack as delivered, once every layer is merged on the default branch.",
};
const UNIT_ANSWERS: Offer[] = ["retry", ACCEPTING, "cancel"];
const ACCEPT_HELP = `answer ${ACCEPT} to take the unit as delivered once every layer is merged on the default branch`;

/**
 * The operator's ACCEPT: every layer merged at Factory's head with a merge
 * commit on the default branch. The unit then integrates at the latest of
 * those merge commits; otherwise the question names what is missing.
 */
async function acceptUnit(
  context: DeliveryContext,
  input: PullInput[],
  integrated: string | undefined,
): Promise<UnitMergeResult> {
  const { github, signal } = context;
  const top = input[input.length - 1]!;
  const tip = await defaultHead(context.checkout, github.repository, signal);
  const missing: string[] = [];
  const shas: string[] = [];
  for (const [index, layer] of input.entries()) {
    const pull = await github.pull(layer.pr, signal);
    if (!pull.merged) {
      missing.push(`PR #${layer.pr} is not merged`);
      continue;
    }
    const judged = await judgeLayer(context, input, index);
    if (judged.kind !== "ready") return pin(judged, layer);
    const sha = await github.mergeCommitOf(layer.pr, signal);
    if (!sha) missing.push(`PR #${layer.pr} names no merge commit`);
    else if (!(await isAncestor(context.checkout, sha, tip, context.signal)))
      missing.push(
        `PR #${layer.pr}'s merge ${sha} is not on the default branch (${tip})`,
      );
    else shas.push(sha);
  }
  if (missing.length)
    return pin(
      hold(
        `The native stack is not delivered yet: ${missing.join("; ")}. Merge the rest, then ${ACCEPT_HELP}; or answer retry to merge it as a stack; or cancel.`,
        [ACCEPTING, "retry", "cancel"],
      ),
      top,
    );
  let latest = shas[0]!;
  for (const sha of shas.slice(1))
    if (await isAncestor(context.checkout, latest, sha, context.signal))
      latest = sha;
  const result = await integrate(context, top.pr, integrated, latest);
  if (result.kind !== "merged") return pin(result, top);
  return {
    kind: "merged",
    mergeSha: latest,
    integratedSha: result.integratedSha,
    items: input.map((layer) => layer.item),
  };
}

/** Repairs first, so the layer at fault is repaired; then questions, then waits. */
const PINNED_ORDER = ["repair", "republish", "hold", "retry"] as const;

async function mergeUnitOnce(
  context: DeliveryContext,
  input: PullInput[],
  integrated: string | undefined,
): Promise<UnitMergeResult> {
  const { github, signal } = context;
  const top = input[input.length - 1]!;
  if (input.length === 1) {
    const result = await mergeOnce(context, {
      ...top,
      ...(integrated ? { integrated } : {}),
    });
    return result.kind === "merged"
      ? { ...result, items: [top.item] }
      : pin(result, top);
  }
  const origin = await originHold(context);
  if (origin) return pin(origin, top);
  const judged = await judgeLayers(context, input);
  if ("kind" in judged) return judged;
  const { layers, defaultBranch } = judged;
  const merged = layers.filter((layer) => layer.pull.merged);
  if (merged.length === layers.length)
    return confirmUnit(context, layers, integrated);
  // A stack merge in progress can show its layers merging one by one; past
  // the lag window the unit no longer merges as one stack (old
  // native-stack: an operator decision, never a merge by hand).
  if (merged.length) {
    const open = layers.find((layer) => !layer.pull.merged)!;
    return pin(
      lagging(
        `Not every layer of the native stack shows its merge yet`,
        `${merged.map((layer) => `PR #${layer.pull.number}`).join(", ")} merged, but PR #${open.pull.number} did not, so the native stack did not merge as one. Inspect the stack and the default branch, then answer retry; or ${ACCEPT_HELP}; or cancel.`,
        UNIT_ANSWERS,
      ),
      open.input,
    );
  }
  const disallowed = await mergeCommitsHold(context, defaultBranch);
  if (disallowed) return pin(disallowed, top);
  // Only the chain Factory built becomes a stack.
  for (const [index, layer] of layers.entries()) {
    const { pull } = layer;
    const branch = itemBranch(layer.input.issue, layer.input.item);
    const base = index ? layers[index - 1]!.pull.head.ref : defaultBranch;
    if (
      pull.state !== "open" ||
      pull.head.ref !== branch ||
      pull.head.sha !== layer.head ||
      pull.base.ref !== base
    )
      return pin(
        hold(
          `PR #${pull.number} is not the stack layer Factory built: it should be open with head ${branch} at ${layer.head} and base ${base}, and shows ${pull.state} with head ${pull.head.ref} at ${pull.head.sha} and base ${pull.base.ref}. Restore it, then answer retry; or cancel.`,
        ),
        layer.input,
      );
    // Each layer must be built on its predecessor's current head (#619).
    const below = layers[index - 1];
    if (below) {
      const relation = await github.compare(below.head, layer.head, signal);
      if (relation === undefined)
        return pin(
          lagging(
            `GitHub shows no comparison of ${below.head} and ${layer.head}`,
            `GitHub shows no comparison of ${below.head} (PR #${below.pull.number}) and ${layer.head} (PR #${pull.number}), so Factory can't tell whether the layer contains the one below it. Inspect both branches, then answer retry; or cancel.`,
          ),
          layer.input,
        );
      // The layer below moved (GitHub updated it with the default branch,
      // or it was repaired): GitHub merges it into this layer the same way,
      // with no worker. Only a refused update, a real conflict, is a repair.
      if (relation !== "identical" && relation !== "ahead")
        return pin(
          await updateBranch(
            context,
            {
              pr: pull.number,
              head: layer.head,
              bases: [below.pull.head.ref],
            },
            {
              kind: "repair",
              finding: `PR #${pull.number} (${branch}) at ${layer.head} does not contain the head ${below.head} of the layer below it (PR #${below.pull.number}, ${below.pull.head.ref}), and GitHub can't merge that head into it. Rebuild the change on the current ${below.pull.head.ref}.`,
              conflict: { onto: below.head },
            },
          ),
          layer.input,
        );
    }
  }
  const stacked = await ensureStack(
    context,
    layers.map((layer) => layer.pull.number),
    defaultBranch,
  );
  if (stacked) return pin(stacked, top);
  const last = layers[layers.length - 1]!;
  crashPoint("stack:merge:before");
  let request: AsyncMerge;
  try {
    request = await github.mergeAsync(last.pull.number, last.head, signal);
  } catch (error) {
    // 403: GitHub refuses a stack whose layers merged already (an earlier
    // request whose answer was lost). 405: not mergeable, or merging; 409
    // without a pending request: a head that moved.
    if (
      !(error instanceof GitHubError && [403, 405, 409].includes(error.status))
    )
      throw needing(error, MERGE_PERMISSION);
    if (await allMerged(context, layers))
      return confirmUnit(context, layers, integrated);
    if (error.status === 403) throw needing(error, MERGE_PERMISSION);
    return pin(
      lagging(
        `GitHub refused to merge the native stack through PR #${last.pull.number} (HTTP ${error.status})`,
        `GitHub refused to merge the native stack through PR #${last.pull.number} (not mergeable, or a repository rule): ${error.message}. Inspect the stack, then answer retry; or cancel.`,
      ),
      top,
    );
  }
  crashPoint("stack:merge:after");
  const settled = await settleMerge(context, last.pull.number, request);
  if (settled.status === "merged" && settled.sha)
    return confirmUnit(context, layers, integrated, settled.sha);
  if (settled.status === "failed") {
    // Often a check that was still pending or failed: judge every layer
    // again first, so a CI wait or a repair is pinned to its layer. Left
    // unexplained, retry (a fresh request) until the lag window, then ask.
    const again = await judgeLayers(context, input);
    if ("kind" in again) return again;
    const why = settled.message ? `: ${settled.message}` : "";
    return pin(
      lagging(
        `GitHub's merge of the native stack through PR #${last.pull.number} failed${why}`,
        `GitHub did not merge the native stack through PR #${last.pull.number}${why}, and every layer still reads ready. Inspect the stack and the repository's rules, then answer retry; or cancel.`,
      ),
      top,
    );
  }
  // Still pending: poll again from a fresh run, outside the merge lock (a
  // repeated request is answered with the pending one). Queued without a
  // request to poll: a CI wait.
  if (settled.status === "pending" || settled.status === "queued")
    return pin(
      {
        kind: "retry",
        reason: `Awaiting GitHub's merge of the native stack through PR #${last.pull.number} (${settled.status})`,
        afterMs: settled.status === "queued" ? CI_POLL_MS : LAG_POLL_MS,
      },
      top,
    );
  // An answer Factory can't read ("unknown", or merged with no commit).
  return pin(
    lagging(
      `GitHub's answer to the native stack merge through PR #${last.pull.number} is unreadable (${settled.status})`,
      `GitHub answered the native stack merge through PR #${last.pull.number} with status ${settled.status}${settled.sha ? "" : " and no merge commit"}, which Factory can't read. Inspect the stack, then answer retry; or cancel.`,
    ),
    top,
  );
}

/**
 * Judge every layer (each against the branch below it, the bottom against
 * the default branch) before any wait, so a failure is pinned to its
 * layer: repairs first, then questions, then waits.
 */
async function judgeLayers(
  context: DeliveryContext,
  input: PullInput[],
): Promise<{ layers: Layer[]; defaultBranch: string } | LayerResult> {
  const layers: Layer[] = [];
  const refused: LayerResult[] = [];
  let defaultBranch = "";
  for (const [index, layer] of input.entries()) {
    const judged = await judgeLayer(context, input, index);
    if (judged.kind === "ready") {
      layers.push({ input: layer, head: judged.head, pull: judged.pull });
      defaultBranch = judged.defaultBranch;
    } else refused.push(pin(judged, layer));
  }
  for (const kind of PINNED_ORDER) {
    const first = refused.find((result) => result.kind === kind);
    if (first) return first;
  }
  return { layers, defaultBranch };
}

/** Judge one layer against the branch below it; the bottom against the default branch. */
function judgeLayer(
  context: DeliveryContext,
  input: PullInput[],
  index: number,
): Promise<Judged> {
  const layer = input[index]!;
  const below = input[index - 1];
  return judge(context, {
    ...layer,
    ...(below ? { baseBranch: itemBranch(layer.issue, below.item) } : {}),
  });
}

/**
 * The stack of `pulls` (bottom first) onto `defaultBranch`: found by its
 * bottom PR, or created and checked. Another stack holding these PRs is a
 * question; Factory never adopts a stack it did not build. A refused
 * creation, or stack data Factory can't read, retries and becomes a
 * question after GitHub's lag window.
 */
async function ensureStack(
  context: DeliveryContext,
  pulls: number[],
  defaultBranch: string,
): Promise<Retry | Hold | undefined> {
  const { github, signal } = context;
  const expected = `base ${defaultBranch} and PRs ${pulls.map((pr) => `#${pr}`).join(", ")}`;
  const shown = (stack: Stack) =>
    `stack ${stack.number} (base ${stack.base}, PRs ${stack.pulls.map((pr) => `#${pr}`).join(", ")})`;
  const same = (stack: Stack) =>
    stack.base === defaultBranch && stack.pulls.join() === pulls.join();
  const unreadable = (error: Unreadable) =>
    lagging(
      error.message,
      `${error.message} (for ${expected}). GitHub's native stack API may have changed: inspect the stack, then answer retry; or cancel. ${WITHOUT_STACKS}.`,
    );
  let found: Stack[];
  try {
    found = await github.findStack(pulls[0]!, signal);
  } catch (error) {
    if (error instanceof Unreadable) return unreadable(error);
    if (error instanceof GitHubError && error.status === 404)
      return objectiveWide(
        hold(
          `GitHub shows no native stacks for ${github.repository} (${error.message.slice(0, 300)}). Enable stacked pull requests for the repository, then answer retry; or cancel. ${WITHOUT_STACKS}.`,
        ),
      );
    throw error;
  }
  const other = found.find((stack) => !same(stack));
  if (found.length > 1 || other)
    return hold(
      `PR #${pulls[0]} is in ${found.map(shown).join(" and ")}, not the native stack Factory builds (${expected}). Inspect it; remove the other stack, then answer retry; or cancel.`,
    );
  if (found.length) return undefined;
  crashPoint("stack:create:before");
  let created: Stack;
  try {
    created = await github.createStack(pulls, signal);
  } catch (error) {
    // Made but unreadable: the next run finds it by its bottom PR.
    if (error instanceof Unreadable) return unreadable(error);
    // A stack an earlier request made (its answer was lost), or a chain
    // GitHub does not show yet: the next run finds it, or tries again.
    // Past the lag window the refusal stands (a PR held by another stack,
    // or a rule), and Factory asks.
    if (error instanceof GitHubError && error.status === 422)
      return lagging(
        `GitHub refused the native stack of ${expected}: ${error.message}`,
        `GitHub refuses to make the native stack of ${expected}: ${error.message.slice(0, 500)}. Inspect the PRs (one may be in another stack), then answer retry; or cancel.`,
      );
    throw needing(error, STACK_PERMISSION);
  }
  crashPoint("stack:create:after");
  return same(created)
    ? undefined
    : hold(
        `GitHub made ${shown(created)}, not the native stack Factory asked for (${expected}). Inspect it; remove it, then answer retry; or cancel.`,
      );
}

/**
 * Poll a merge request by its uuid for up to STACK_MERGE_POLL_MS, inside
 * the merge lock. The uuid lives only here: a later run sends the request
 * again and gets the pending one back.
 */
async function settleMerge(
  context: DeliveryContext,
  top: number,
  request: AsyncMerge,
): Promise<AsyncMerge> {
  const until = Date.now() + STACK_MERGE_POLL_MS;
  let current = request;
  const { uuid } = request;
  while (
    uuid &&
    (current.status === "pending" || current.status === "queued") &&
    Date.now() < until
  ) {
    await sleep(STACK_POLL_INTERVAL_MS, undefined, { signal: context.signal });
    try {
      current = await context.github.mergeStatus(top, uuid, context.signal);
    } catch (error) {
      // A request just made may not be readable by its uuid yet.
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }
  return current;
}

/** Whether GitHub shows every layer merged. */
async function allMerged(
  context: DeliveryContext,
  layers: Layer[],
): Promise<boolean> {
  for (const layer of layers)
    if (!(await context.github.pull(layer.pull.number, context.signal)).merged)
      return false;
  return true;
}

/**
 * Every layer merged at its own head with one shared merge commit, on the
 * default branch: on every path, so layers merged one by one are never
 * accepted. After Factory's own stack merge that commit must be
 * `expected`, the one GitHub reported. A difference may be GitHub's lag at
 * first; past the window it is a question.
 */
async function confirmUnit(
  context: DeliveryContext,
  layers: Layer[],
  integrated: string | undefined,
  expected?: string,
): Promise<UnitMergeResult> {
  const { github, signal } = context;
  const top = layers[layers.length - 1]!.input;
  const shas: string[] = [];
  for (const layer of layers) {
    const { pr } = layer.input;
    const pull = await github.pull(pr, signal);
    if (!pull.merged)
      return pin(
        lagging(
          `PR #${pr} does not show the native stack's merge yet`,
          `GitHub merged the native stack, but PR #${pr} does not show it merged. Inspect the stack and the default branch, then answer retry; or cancel.`,
        ),
        layer.input,
      );
    if (
      pull.head.sha !== layer.head ||
      pull.head.ref !== itemBranch(layer.input.issue, layer.input.item)
    )
      return pin(foreign(pull, layer.head), layer.input);
    const sha = await github.mergeCommitOf(pr, signal);
    if (!sha)
      return pin(
        lagging(
          `PR #${pr} merge is not on its timeline yet`,
          `GitHub shows PR #${pr} merged but names no merge commit. Inspect it, then answer retry; or cancel.`,
        ),
        layer.input,
      );
    shas.push(sha);
  }
  const mergeSha = shas[0]!;
  if (
    shas.some((sha) => sha !== mergeSha) ||
    (expected && mergeSha !== expected)
  )
    return pin(
      lagging(
        `The native stack's layers do not all show one merge commit${expected ? ` (${expected})` : ""} yet`,
        `The native stack's layers ${layers.map((layer) => `PR #${layer.input.pr}`).join(", ")} show the merge commits ${shas.join(", ")}${expected ? `, not GitHub's stack merge ${expected}` : ""}: they did not merge as one stack. Inspect the stack and the default branch, then ${ACCEPT_HELP}; or answer retry; or cancel.`,
        // Merge commits never change, so retry alone can't pass.
        [ACCEPTING, "retry", "cancel"],
      ),
      top,
    );
  const result = await integrate(context, top.pr, integrated, mergeSha);
  if (result.kind !== "merged") return pin(result, top);
  return {
    kind: "merged",
    mergeSha,
    integratedSha: result.integratedSha,
    items: layers.map((layer) => layer.input.item),
  };
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

function retry(reason: string): Retry {
  return { kind: "retry", reason, afterMs: LAG_POLL_MS };
}

/**
 * Something GitHub may not show yet: a retry, which the engine turns into
 * the question once the step has waited GitHub's lag window.
 */
function lagging(
  reason: string,
  question: string,
  offers?: readonly Offer[],
): Retry {
  return {
    ...retry(reason),
    holdAfter: {
      ms: GITHUB_LAG_MS,
      question,
      ...(offers ? { offers } : {}),
    },
  };
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
