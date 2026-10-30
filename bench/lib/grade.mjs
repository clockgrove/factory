/**
 * The benchmark's own judgment of a run (#2223): its frozen grader run
 * against a fresh checkout of the run repository's default branch at the
 * Objective's end, never Factory's reviewers. And what the run repository's
 * history says of the operator: commits on the default branch during the
 * run that no Factory merge made (hand fixes).
 *
 * Grader contract (bench/README.md#Grader): `definition.grader = { command,
 * timeoutMinutes }`. The command runs in a shell, its working directory the
 * checkout, with BENCH_TREE (the checkout), BENCH_COMMIT (the commit),
 * BENCH_DEFINITION (the definition file) and BENCH_OUT (where to write) in
 * its environment. It writes `{ graderVersion, criteria: [{ id, text,
 * verdict, method, evidence }] }` to BENCH_OUT, each verdict `pass`, `fail`
 * or `unknown`. The harness never interprets criteria itself: a grader
 * that fails, times out or writes anything else is recorded as
 * `grade.error`, never as a pass rate.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapesOf } from "./outcomes.mjs";

const VERDICTS = ["pass", "fail", "unknown"];
/** How much of a failed grader's output the error keeps. */
const TAIL = 2000;

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Seconds since the epoch, as git takes an instant (`@<seconds>`). */
const seconds = (at) => Math.floor(Date.parse(at) / 1000);

/** The checkout's default branch as its remote-tracking ref (`origin/main`), or null. */
export function defaultBranch(checkout) {
  try {
    return git(
      checkout,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    );
  } catch {
    for (const ref of ["origin/main", "origin/master"])
      try {
        git(checkout, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
        return ref;
      } catch {
        // Not this one.
      }
    return null;
  }
}

/**
 * The default branch's commit at `endedAt` in the run repository's checkout
 * `checkout`: its last first-parent commit made by then. A commit made after
 * the Objective ended is not the run's. Null when the checkout can't say.
 */
export function endCommit(checkout, endedAt) {
  try {
    const branch = defaultBranch(checkout);
    if (!branch || !endedAt) return null;
    const commit = git(
      checkout,
      "rev-list",
      "-1",
      "--first-parent",
      `--before=@${seconds(endedAt)}`,
      branch,
    );
    return commit ? { branch, commit } : null;
  } catch {
    return null;
  }
}

/**
 * Commits on the default branch (first parent, up to `end`) made from
 * `startedAt` to `endedAt` that no Factory merge made, oldest first: each
 * `{ sha, at }`. Factory's merges are the merge commits its merge steps
 * recorded (`merges`) and any merge commit whose other parent is a head
 * Factory published (`heads`). `base`, when the checkout has it, bounds
 * the history read.
 */
export function handFixCommits(
  checkout,
  { end, base, startedAt, endedAt, merges, heads },
) {
  let hasBase = false;
  try {
    git(checkout, "cat-file", "-e", `${base}^{commit}`);
    hasBase = Boolean(base);
  } catch {
    // An invented or unfetched base: the time window bounds it.
  }
  const lines = git(
    checkout,
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H %ct %P",
    hasBase ? `${base}..${end}` : end,
  )
    .split("\n")
    .filter(Boolean);
  const from = seconds(startedAt);
  const to = seconds(endedAt);
  const fixes = [];
  for (const line of lines) {
    const [sha, time, , ...others] = line.split(" ");
    const at = Number(time);
    if (at < from || at > to) continue;
    if (merges.has(sha) || others.some((parent) => heads.has(parent))) continue;
    fixes.push({ sha, at: new Date(at * 1000).toISOString() });
  }
  return fixes;
}

/** When commit `sha` was made in `repo`, or null when the repository doesn't have it. */
export function commitTime(repo, sha) {
  try {
    return new Date(
      Number(git(repo, "show", "-s", "--format=%ct", `${sha}^{commit}`)) * 1000,
    ).toISOString();
  } catch {
    return null;
  }
}

/**
 * A fresh checkout of `commit` from repository `repo`, in a new temporary
 * directory: a clone sharing `repo`'s objects, so nothing is fetched and
 * `repo` is only read. LFS files stay pointers (no smudge from an unknown
 * remote); a grader that needs them runs `git lfs pull` itself.
 */
export function freshCheckout(repo, commit) {
  const root = mkdtempSync(join(tmpdir(), "bench-grade-"));
  const tree = join(root, "tree");
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };
  const run = (args) =>
    execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["clone", "--quiet", "--shared", "--no-checkout", repo, tree]);
    run(["-C", tree, "checkout", "--quiet", "--detach", commit]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `can't check out ${commit} from ${repo}: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
  return { root, tree };
}

/** The command run in a shell of its own process group, killed whole at `timeoutMs`. */
function runCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (text) => {
      output = (output + text).slice(-TAIL);
    };
    child.stdout.setEncoding("utf8").on("data", keep);
    child.stderr.setEncoding("utf8").on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

/** What the grader wrote, checked; throws naming what is wrong. */
function graderOutput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`BENCH_OUT is not JSON: ${error.message}`);
  }
  if (typeof value?.graderVersion !== "string" || !value.graderVersion)
    throw new Error("BENCH_OUT has no graderVersion");
  if (!Array.isArray(value.criteria) || !value.criteria.length)
    throw new Error("BENCH_OUT has no criteria");
  return {
    graderVersion: value.graderVersion,
    criteria: value.criteria.map((criterion, index) => {
      if (
        typeof criterion?.id !== "string" ||
        !VERDICTS.includes(criterion.verdict)
      )
        throw new Error(
          `criterion ${index + 1} needs an id and a verdict of ${VERDICTS.join(", ")}`,
        );
      return {
        id: criterion.id,
        text: typeof criterion.text === "string" ? criterion.text : null,
        verdict: criterion.verdict,
        method: typeof criterion.method === "string" ? criterion.method : null,
        evidence: criterion.evidence ?? null,
      };
    }),
  };
}

/** A grade that couldn't be made: the error, no numbers. */
const failed = (commit, error, graderVersion = null) => ({
  graderVersion,
  commit,
  passed: null,
  failed: null,
  unknown: null,
  passRate: null,
  criteria: [],
  error,
});

/**
 * Run the definition's grader on `commit` of repository `repo` (a fresh
 * checkout, removed after). The grade: per-criterion verdicts as the
 * grader gave them, and `passRate`, the share of criteria it passed (an
 * unknown verdict is not a pass). A failure is `error`, never a rate.
 */
export async function runGrader(definition, { repo, commit }) {
  const { command, timeoutMinutes } = definition.grader;
  let checkout;
  try {
    checkout = freshCheckout(repo, commit);
  } catch (error) {
    return failed(commit, error.message);
  }
  try {
    const out = join(checkout.root, "grade.json");
    const run = await runCommand(command, {
      cwd: checkout.tree,
      env: {
        ...process.env,
        BENCH_TREE: checkout.tree,
        BENCH_COMMIT: commit,
        BENCH_DEFINITION: definition.file,
        BENCH_OUT: out,
      },
      timeoutMs: timeoutMinutes * 60_000,
    });
    const tail = run.output.trim() ? `: ${run.output.trim()}` : "";
    if (run.timedOut)
      return failed(
        commit,
        `the grader timed out after ${timeoutMinutes} min${tail}`,
      );
    if (run.code !== 0)
      return failed(
        commit,
        `the grader exited ${run.code ?? run.signal ?? "without a code"}${tail}`,
      );
    let graded;
    try {
      graded = graderOutput(readFileSync(out, "utf8"));
    } catch (error) {
      return failed(
        commit,
        error.code === "ENOENT"
          ? "the grader wrote nothing to BENCH_OUT"
          : error.message,
      );
    }
    const count = (verdict) =>
      graded.criteria.filter((c) => c.verdict === verdict).length;
    return {
      graderVersion: graded.graderVersion,
      commit,
      passed: count("pass"),
      failed: count("fail"),
      unknown: count("unknown"),
      passRate: count("pass") / graded.criteria.length,
      criteria: graded.criteria,
    };
  } finally {
    rmSync(checkout.root, { recursive: true, force: true });
  }
}

/** The card's gaps without those about its grade. */
const ungraded = (card) =>
  card.unavailable.filter((gap) => gap.metric !== "grade");

/** Record `grade` on `card` (from runGrader), and the escapes it decides. */
export function setGrade(card, grade) {
  card.grade = grade;
  card.escapes = escapesOf({
    refusals: card.escapes.finalReviewRefusals,
    handFixesAfter: card.escapes.handFixesAfterFinalReview,
    grade,
    finalPassed: card.totals.final.review?.outcome === "pass",
  });
  card.unavailable = [
    ...ungraded(card),
    ...(grade.error
      ? [{ metric: "grade", reason: `the grader failed: ${grade.error}` }]
      : []),
  ];
  return card;
}

/** Say why `card` has no grade (no grader, no checkout to grade, ...). */
export function noGrade(card, reason) {
  card.grade = null;
  card.unavailable = [...ungraded(card), { metric: "grade", reason }];
  return card;
}

/**
 * Grade a scored card: with the definition's grader, on `commit` (default:
 * the card's end commit) of `repo`. Without a grader, a repository or a
 * commit, the card says why it has no grade. Returns the card.
 */
export async function gradeCard(card, definition, { repo, commit }) {
  if (!definition.grader) return noGrade(card, "the definition has no grader");
  if (card.partial)
    return noGrade(card, "the run hadn't ended: only an ended run is graded");
  const at = commit ?? card.endCommit;
  if (!repo || !at)
    return noGrade(
      card,
      repo
        ? "no end commit: give --grade-commit SHA"
        : "no checkout of the run repository to grade: give --grade-tree DIR --grade-commit SHA",
    );
  return setGrade(card, await runGrader(definition, { repo, commit: at }));
}
