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
 * verdict, method, evidence }], metrics }` to BENCH_OUT, each verdict
 * `pass`, `fail` or `unknown`; `metrics`, optional, maps a name to a number,
 * such as the delivered tests' mutation score (#2224). Also optional, from a
 * grader that reviews as well as grades, such as bench/grade-auto.mjs
 * (#2273): `findings` (each `{ id, severity, title, evidence, reproduce }`,
 * severity `defect`, `quality` or `minor`), `mutation` (`{ survived,
 * killed, examples }`), `cost` and `durationMs`. A harness run's
 * BENCH_OBJECTIVE is the Objective as filed. The harness never interprets
 * criteria itself: a grader that fails, times out or writes anything else
 * is recorded as `grade.error`, never as a pass rate.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapesOf } from "./outcomes.mjs";

const VERDICTS = ["pass", "fail", "unknown"];
/** A finding's severity: `defect` violates a criterion the Objective states. */
export const SEVERITIES = ["defect", "quality", "minor"];
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
 * Factory published (`heads`). The definition's base patches, which
 * provisioning put on the branch before admission (`patches`, the commits
 * they made), are never hand fixes, whatever their time. `base`, when the
 * checkout has it, bounds the history read.
 */
export function handFixCommits(
  checkout,
  { end, base, startedAt, endedAt, merges, heads, patches = new Set() },
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
    if (at < from || at > to || patches.has(sha)) continue;
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
  try {
    checkoutInto(repo, commit, tree);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, tree };
}

/** `commit` of repository `repo` checked out into the new directory `tree`, as freshCheckout does. */
export function checkoutInto(repo, commit, tree) {
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };
  const run = (args) =>
    execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["clone", "--quiet", "--shared", "--no-checkout", repo, tree]);
    run(["-C", tree, "checkout", "--quiet", "--detach", commit]);
  } catch (error) {
    throw new Error(
      `can't check out ${commit} from ${repo}: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
}

/** The command run in a shell of its own process group, killed whole at `timeoutMs`. */
export function runCommand(command, { cwd, env, timeoutMs }) {
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
  const metrics = value.metrics ?? {};
  if (
    typeof metrics !== "object" ||
    Array.isArray(metrics) ||
    !Object.values(metrics).every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  )
    throw new Error("BENCH_OUT's metrics must map each name to a number");
  const words = (v) => (typeof v === "string" ? v : null);
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  const { findings, mutation, cost, durationMs } = value;
  if (
    findings !== undefined &&
    !(
      Array.isArray(findings) &&
      findings.every(
        (f) => typeof f?.id === "string" && SEVERITIES.includes(f.severity),
      )
    )
  )
    throw new Error(
      `BENCH_OUT's findings must each have an id and a severity of ${SEVERITIES.join(", ")}`,
    );
  if (
    mutation !== undefined &&
    mutation !== null &&
    !(
      whole(mutation.survived) &&
      whole(mutation.killed) &&
      (mutation.examples === undefined || Array.isArray(mutation.examples))
    )
  )
    throw new Error(
      "BENCH_OUT's mutation must give survived and killed as whole numbers",
    );
  if (
    cost !== undefined &&
    cost !== null &&
    !(
      typeof cost === "object" &&
      (cost.usd === null || (typeof cost.usd === "number" && cost.usd >= 0))
    )
  )
    throw new Error("BENCH_OUT's cost must give usd as a number or null");
  if (
    durationMs !== undefined &&
    !(typeof durationMs === "number" && durationMs >= 0)
  )
    throw new Error("BENCH_OUT's durationMs must be a number");
  return {
    graderVersion: value.graderVersion,
    metrics: { ...metrics },
    // Only what the grader reported: a grader that reviews nothing has none.
    ...(findings
      ? {
          findings: findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            title: words(f.title),
            evidence: f.evidence ?? null,
            reproduce: words(f.reproduce),
          })),
        }
      : {}),
    ...(mutation !== undefined
      ? {
          mutation: mutation && {
            survived: mutation.survived,
            killed: mutation.killed,
            examples: mutation.examples ?? [],
          },
        }
      : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
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
  metrics: {},
  error,
});

/** The grade of `commit` from what a grader wrote (graderOutput's): its verdicts counted. */
function gradeOf(graded, commit) {
  const count = (verdict) =>
    graded.criteria.filter((c) => c.verdict === verdict).length;
  const { graderVersion, criteria, metrics, ...reviewed } = graded;
  return {
    graderVersion,
    commit,
    passed: count("pass"),
    failed: count("fail"),
    unknown: count("unknown"),
    passRate: count("pass") / criteria.length,
    criteria,
    metrics,
    ...reviewed,
  };
}

/**
 * The grade in `file`, a grader's output written outside the harness (such
 * as bench/grade-auto.mjs run standalone), checked as BENCH_OUT is. Its
 * commit is `commit`, or the file's own `commit`. Throws naming what is wrong.
 */
export function gradeFile(file, commit = null) {
  const text = readFileSync(file, "utf8");
  const graded = graderOutput(text);
  const own = JSON.parse(text).commit ?? null;
  if (commit && own && commit !== own)
    throw new Error(`${file} grades ${own}, not ${commit}`);
  if (!commit && !own)
    throw new Error(`${file} names no commit: give --grade-commit SHA`);
  return gradeOf(graded, commit ?? own);
}

/**
 * Run the definition's grader on `commit` of repository `repo` (a fresh
 * checkout, removed after), with BENCH_OBJECTIVE when `objective` (the
 * Objective as filed) is known. The grade: per-criterion verdicts as the
 * grader gave them, `passRate`, the share of criteria it passed (an
 * unknown verdict is not a pass), and the grader's own `metrics`, with any
 * findings, mutation, cost and duration it reported. A failure is `error`,
 * never a rate.
 */
export async function runGrader(
  definition,
  { repo, commit, objective = null },
) {
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
        ...(objective ? { BENCH_OBJECTIVE: objective } : {}),
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
    return gradeOf(graded, commit);
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
    finalPassed: card.totals.final.reviewPassed === true,
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
  // A harness run's directory holds the Objective as filed.
  const filed = card.run.dir ? join(card.run.dir, "objective.md") : null;
  return setGrade(
    card,
    await runGrader(definition, {
      repo,
      commit: at,
      objective: filed && existsSync(filed) ? filed : null,
    }),
  );
}
