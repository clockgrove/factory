// What a fix pass gets about a red the required checks found, and whether the red is the change's at all: each failing
// CI job's whole log (a file, not a tail), the diff since the PR's last green head, and, per job, whether the default
// branch fails the same job with the same failure signature, steadily (a base failure, not this change's).
import { checkRuns, getRepo, jobLog, logWindow, rest } from "./github.mjs";
import { filesDiff, trustedAuthor } from "./logic.mjs";
import { MAX_JOBS, failureSignature, isAggregate, sameFailure } from "./triage.mjs";

/** The largest log or diff handed to the harness as one file; past it the head is cut and the tail kept. */
export const RED_FILE_CAP = 8 * 1024 * 1024;
/** How many of the default branch's newest runs of a job are read, and how many must fail the same way. */
export const BASE_RUNS = 3;
export const BASE_MATCHES = 2;
const PASSED = ["success", "neutral", "skipped"];

/** `text` within `cap` characters: the tail kept, with a first line that says what was cut. */
export function capped(text, cap = RED_FILE_CAP) {
  const s = String(text ?? "");
  return s.length <= cap ? s : `(the first ${s.length - cap} characters are cut; the rest is the end of the file)\n${s.slice(-cap)}`;
}

/** The newest head of the PR that Factory recorded as validation green (its validated marker), or null. */
export function lastGreenHead(comments, issue) {
  const re = new RegExp(`<!-- factory:${issue}:validated:([0-9a-f]{40}) -->`);
  let best = null;
  for (const c of comments || []) {
    const m = re.exec(c?.body || "");
    if (!m || !trustedAuthor(c)) continue;
    if (!best || Date.parse(c.created_at) >= Date.parse(best.at)) best = { sha: m[1], at: c.created_at };
  }
  return best?.sha ?? null;
}

/**
 * Whether the default branch fails a job the same way, steadily: its newest completed run of the job (attempts
 * included, newest first) is red with this failure signature, and at least BASE_MATCHES of its newest BASE_RUNS are.
 * One red run on the base (a flake, an outage) is not enough. `runs` are [{run, sig}] newest first; a run whose log was
 * not read has no `sig`.
 */
export function steadyOnBase(sig, runs) {
  const newest = (runs || []).slice(0, BASE_RUNS);
  const same = (x) => !!x && !PASSED.includes(x.run.conclusion) && sameFailure(sig, x.sig);
  return !!newest.length && same(newest[0]) && newest.filter(same).length >= BASE_MATCHES;
}

/**
 * The jobs a fix pass is told about and the base-failure decision covers, at most MAX_JOBS: every failing job, aggregates
 * included, the required ones first so none is ever left out for an optional one. `truncated` when more failed.
 */
export function jobsToDetail(failedRuns, required = []) {
  const runs = failedRuns || [];
  const ordered = [...runs.filter((r) => required.includes(r.name)), ...runs.filter((r) => !required.includes(r.name))];
  return { jobs: ordered.slice(0, MAX_JOBS), truncated: ordered.length > MAX_JOBS };
}

/**
 * What the default branch shows for one job, as evidence for the fix pass (never an instruction): how many of its newest
 * runs there are red, and the failure lines of the newest red one. Null when none of them is red.
 */
export function baseEvidence(runs) {
  const red = (runs || []).filter((x) => !PASSED.includes(x.run.conclusion));
  if (!red.length) return null;
  return { sha: red[0].sha, red: red.length, of: runs.length, lines: (red[0].sig?.lines || []).slice(0, 5) };
}

/** The evidence line for the fix prompt: the base's red runs of the job and their failure lines beside this run's. */
export function evidenceText({ branch, job, evidence, lines }) {
  const show = (ls) => (ls.length ? ls.map((l) => `    ${l.slice(0, 200)}`).join("\n") : "    (no failure line found)");
  return `${branch}@${evidence.sha.slice(0, 7)}'s latest runs of ${job} are also red (${evidence.red} of ${evidence.of}) with these failure lines:\n${show(evidence.lines)}\nCompare with this run's failure lines:\n${show((lines || []).slice(0, 5))}`;
}

/**
 * The detail of a checks red on `sha`: {jobs: [{name, id, required, log, window, sig, base, evidence}], truncated,
 * branch, green, diff, diffError}. `base` is {sha} when the job fails exactly the same way, steadily, on the default
 * branch (steadyOnBase), else null; `evidence` is what the base's newest runs of it show (baseEvidence), for the prompt. `green` is the PR's last green head; `diff` the two-dot diff from it to `sha`, made by `diffOf(from, to)`
 * (Factory's own mirror) or, when the red head descends from it, GitHub's compare; `diffError` says why there is none.
 * `token` reads the repository and the PR; `actionsToken` the job logs.
 */
export async function redDetail({ repo, issue, prNumber, sha, failedRuns, required = [], token, actionsToken = token, diffOf = null, lookBack = 5 }) {
  const opts = { token };
  const actions = { token: actionsToken };
  const { jobs: picked, truncated } = jobsToDetail(failedRuns, required);
  const branch = (await getRepo(repo, opts).catch(() => null))?.default_branch || null;
  // The default branch's newest commits, newest first; each one's runs (every attempt) read once.
  const baseCommits = branch ? ((await rest(`repos/${repo.full}/commits?sha=${encodeURIComponent(branch)}&per_page=${lookBack}`, opts).catch(() => [])) || []).map((c) => c.sha) : [];
  const runsOn = new Map();
  const baseRunsOf = async (name) => {
    const out = [];
    for (const s of baseCommits) {
      if (!runsOn.has(s)) runsOn.set(s, await checkRuns(repo, s, opts, { all: true }).catch(() => []));
      const mine = runsOn.get(s).filter((r) => r.name === name && r.status === "completed").sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)) || (b.id ?? 0) - (a.id ?? 0));
      for (const run of mine) out.push({ run, sha: s });
      if (out.length >= BASE_RUNS) break;
    }
    return out.slice(0, BASE_RUNS);
  };
  const jobs = [];
  for (const r of picked) {
    const log = await jobLog(repo, r.id, actions).catch(() => "");
    const sig = failureSignature(r.name, log);
    // The base's newest runs of the job; each red one's log is read once (not kept: no later step reads it again).
    const runs = await baseRunsOf(r.name);
    for (const x of runs) if (!PASSED.includes(x.run.conclusion)) x.sig = failureSignature(r.name, await jobLog(repo, x.run.id, actions, { cache: false }).catch(() => ""));
    // Handed back only on an exact, steady match; no signature (an unreadable log, or only wrappers) never matches.
    const base = sig.id && steadyOnBase(sig, runs) ? { sha: runs[0].sha } : null;
    // A required check that only gathers the others (isAggregate) and printed no failure line of its own.
    const aggregate = isAggregate(r, failedRuns, required) && !sig.lines.length;
    jobs.push({ name: r.name, id: r.id, required: required.includes(r.name), log: capped(log), window: logWindow(log, 4000), sig, base, aggregate, evidence: baseEvidence(runs) });
  }
  const comments = await rest(`repos/${repo.full}/issues/${prNumber}/comments?per_page=100`, { ...opts, paginate: true }).catch(() => []);
  const green = lastGreenHead(comments, issue);
  let diff = null;
  let diffError = "";
  if (green && green !== sha) {
    try {
      diff = capped(await diffSince({ repo, green, sha, opts, diffOf }));
    } catch (e) {
      diffError = String(e?.message || e).slice(0, 200);
    }
  }
  return { jobs, truncated, branch, green, diff, diffError };
}

/**
 * How many files GitHub's compare API lists at most. Unlike a PR's files they cannot be paged: `page` pages the
 * comparison's commits, and every page past the first lists no file (checked on a 300-plus-file comparison).
 */
const COMPARE_FILES_CAP = 300;

/**
 * The two-dot diff green..sha: Factory's mirror first (a diff too large for it throws, so it falls through); GitHub's
 * compare only when sha descends from green (then it is the same), made from the comparison's file list (its diff media
 * type refuses one over 300 files; the list stops there, and the diff then says it is incomplete).
 */
async function diffSince({ repo, green, sha, opts, diffOf }) {
  if (diffOf) {
    try {
      return await diffOf(green, sha);
    } catch {
      // the mirror could not get the old head (a rebase left it unreachable): GitHub's compare below
    }
  }
  const cmp = await rest(`repos/${repo.full}/compare/${green}...${sha}`, opts);
  if (!["ahead", "identical"].includes(cmp?.status)) throw new Error(`the branch was rebased since ${green.slice(0, 7)} (GitHub compares ${cmp?.status ?? "nothing"}), so no diff from it alone can be made`);
  const files = Array.isArray(cmp?.files) ? cmp.files : [];
  return `${filesDiff(files)}${files.length >= COMPARE_FILES_CAP ? `(GitHub lists at most ${COMPARE_FILES_CAP} files of a comparison; files past them are not shown)\n` : ""}`;
}

/**
 * Every failing job is a base failure, and none was left out: the red is handed back as the base's, with no fix pass.
 * An aggregate required check with no output of its own (`aggregate`) can never match the base; it is passed over when
 * at least one other job is a steady base match, since it is red only because they are.
 */
export const allOnBase = (detail) => !!detail?.jobs?.length && !detail.truncated && detail.jobs.every((j) => j.base || j.aggregate) && detail.jobs.some((j) => j.base && !j.aggregate);

/** The one-line reason for a red that is all base failures (the base matches named; an aggregate beside them). */
export const baseFailureReason = (detail) => {
  const based = detail.jobs.filter((j) => j.base);
  const gathered = detail.jobs.filter((j) => !j.base && j.aggregate);
  return `base failure: ${based.map((j) => j.name).join(", ")} ${based.length > 1 ? "fail" : "fails"} the same way on ${detail.branch}@${String(based[0].base.sha).slice(0, 7)} (${based.map((j) => j.sig.id).join(", ")})${gathered.length ? `, and ${gathered.map((j) => j.name).join(", ")} only ${gathered.length > 1 ? "gather" : "gathers"} ${based.length > 1 ? "them" : "it"}` : ""}; not this change`;
};
