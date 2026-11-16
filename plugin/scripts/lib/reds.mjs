// What a fix pass gets about a red the required checks found, and whether the red is the change's at all: each failing
// CI job's whole log (a file, not a tail), the diff since the PR's last green head, and, per job, whether the default
// branch fails the same job with the same failure, steadily (a base failure, not this change's). "The same failure" is
// equal failure signatures, else, where the signatures cannot tell, a decision call (triage.mjs openTriage `same`).
import { checkRuns, getRepo, jobLog, logWindow, rest } from "./github.mjs";
import { filesDiff, trustedAuthor } from "./logic.mjs";
import { MAX_JOBS, failedStep, failureSignature, failureWindow, isAggregate, sameFailure, workflowJobs } from "./triage.mjs";

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

/** "The same failure" by signature alone: what baseMatch decides with no same-failure check (triage.mjs openTriage `same`). */
export const sameBySignature = async (a, b) => {
  const yes = sameFailure(a?.sig, b?.sig);
  return { same: yes, different: !yes, exact: true, said: yes ? `the same signature, ${a.sig.id}` : "not the same signature" };
};

/**
 * Whether the default branch fails a job the same way, steadily: its newest completed run of the job (attempts
 * included, newest first) is red with the same failure, and at least BASE_MATCHES of its newest BASE_RUNS are. One red
 * run on the base (a flake, an outage) is not enough. `job` is this failure and `runs` the base's, [{run, side}] newest
 * first, each side as `same` takes it (triage.mjs openTriage `same`: equal signatures, else the decision model where
 * they cannot tell; sameBySignature by default), or [{run, sig}]. A run that passed is not asked about, nor any run
 * once the answer is settled. Resolves {base, said, exact, undecided}: `said` how the base's newest run was judged and
 * `exact` whether without the decision model; `undecided` the first judgement with no answer that could have made it a
 * base failure (its `cause`, `said`, `limited`; one the stage harness's usage limit stopped ends the questions and is
 * always returned), else null.
 */
export async function baseMatch(job, runs, same = sameBySignature) {
  const newest = (runs || []).slice(0, BASE_RUNS);
  let matches = 0;
  let open = 0;
  let undecided = null;
  let said = "";
  let exact = true;
  let newestSame = false;
  for (const [i, x] of newest.entries()) {
    if (PASSED.includes(x.run.conclusion)) {
      if (i === 0) break;
      continue;
    }
    // Settled: already steady, or too few runs left to get there.
    if ((newestSame && matches >= BASE_MATCHES) || matches + open + newest.length - i < BASE_MATCHES) break;
    const j = await same(job, x.side ?? { name: job.name, sig: x.sig ?? null });
    if (i === 0) {
      said = j.said;
      exact = j.exact !== false;
      newestSame = !!j.same;
    }
    if (j.same) matches += 1;
    else if (j.undecided) {
      open += 1;
      undecided ??= j;
      // The stage harness's usage limit stopped it: no later question gets an answer either.
      if (j.limited) break;
    } else if (i === 0) break;
  }
  const base = newestSame && matches >= BASE_MATCHES;
  return { base, said, exact, undecided: !base && undecided && (undecided.limited || matches + open >= BASE_MATCHES) ? undecided : null };
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
 * The detail of a checks red on `sha`: {jobs: [{name, id, required, log, window, sig, base, baseUndecided, evidence}],
 * truncated, branch, green, diff, diffError}. `base` is {sha, said} when the job fails the same way, steadily, on the
 * default branch (baseMatch, with `same`: triage.mjs openTriage `same`, which the caller passes only when nothing on the
 * head points at the change, session.mjs baseJudge; else the signature alone), else null;
 * `baseUndecided` ({cause, said, limited?}) when a judgement that could have made it so got no answer; `evidence` is
 * what the base's newest runs of it show (baseEvidence), for the prompt. `green` is the PR's last green head; `diff` the
 * two-dot diff from it to `sha`, made by `diffOf(from, to)` (Factory's own mirror) or, when the red head descends from
 * it, GitHub's compare; `diffError` says why there is none.
 * With `sinceGreen` false (a merge queue commit, no head of the PR) neither is read: `green` and `diff` are null.
 * `token` reads the repository and the PR; `actionsToken` the job logs and jobs.
 */
export async function redDetail({ repo, issue, prNumber, sha, failedRuns, required = [], token, actionsToken = token, diffOf = null, lookBack = 5, sinceGreen = true, same = null }) {
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
  // A job's failed step (its Actions job's first failed step), read once and only when a same-failure judgement needs it.
  const steps = new Map();
  const stepOf = (id) => {
    if (!steps.has(id)) steps.set(id, rest(`repos/${repo.full}/actions/jobs/${id}`, actions).then((j) => failedStep(j)?.name || "", () => ""));
    return steps.get(id);
  };
  const short = (s) => String(s).slice(0, 7);
  const jobs = [];
  for (const r of picked) {
    const log = await jobLog(repo, r.id, actions).catch(() => "");
    const sig = failureSignature(r.name, log);
    // The base's newest runs of the job; each red one's log is read once, and only its failure window kept.
    const runs = await baseRunsOf(r.name);
    for (const x of runs) {
      if (PASSED.includes(x.run.conclusion)) continue;
      const text = await jobLog(repo, x.run.id, actions, { cache: false }).catch(() => "");
      x.sig = failureSignature(r.name, text);
      x.side = { id: x.run.id, name: r.name, sig: x.sig, step: () => stepOf(x.run.id), window: failureWindow(text), label: `job ${x.run.id}, on ${branch}@${short(x.sha)}` };
    }
    // A required check that only gathers the others (isAggregate) and printed no failure line of its own: never asked.
    const aggregate = isAggregate(r, failedRuns, required) && !sig.lines.length;
    // Handed back only on a steady match of the same failure (`same`: the signature, else the decision model).
    const match = aggregate ? { base: false, said: "", undecided: null } : await baseMatch({ id: r.id, name: r.name, sig, step: () => stepOf(r.id), window: failureWindow(log), label: `job ${r.id}, on the head ${short(sha)}` }, runs, same ?? sameBySignature);
    const base = match.base ? { sha: runs[0].sha, said: match.said, exact: match.exact } : null;
    const u = match.undecided;
    const baseUndecided = u ? { cause: u.cause || "factory", said: u.said, ...(u.limited ? { limited: u.limited } : {}) } : null;
    jobs.push({ name: r.name, id: r.id, suite: r.suite ?? null, required: required.includes(r.name), log: capped(log), window: logWindow(log, 4000), sig, base, baseUndecided, aggregate, evidence: baseEvidence(runs) });
  }
  // A red required check whose run has other failing jobs: its workflow file at the run's head says which of them it
  // needs and which may fail without failing the run (triage.mjs workflowJobs), so the Block's lead (leadJobs) quotes a
  // roll-up from the right job and calls no job a required check counts "not required".
  for (const suite of new Set(jobs.filter((j) => j.required && j.suite != null && jobs.some((o) => !o.required && o.suite === j.suite)).map((j) => j.suite))) {
    const inSuite = jobs.filter((j) => j.suite === suite);
    const said = workflowJobs(await workflowAt(repo, suite, opts, actions).catch(() => ""), inSuite);
    for (const j of inSuite) {
      j.coe = said.coe.get(j.id) ?? null;
      if (j.required) j.gathers = said.needs.get(j.id) ?? null;
    }
  }
  // Not for a commit that is no head of the PR (the merge queue's: `sinceGreen` false): no diff from the PR's green head.
  if (!sinceGreen) return { jobs, truncated, branch, green: null, diff: null, diffError: "" };
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

/** The workflow file a check suite's run came from, at that run's head: "" when GitHub names none (not an Actions suite). */
async function workflowAt(repo, suite, opts, actions) {
  const run = (await rest(`repos/${repo.full}/actions/runs?check_suite_id=${suite}&per_page=1`, actions))?.workflow_runs?.[0];
  const path = String(run?.path || "").replace(/@.*$/, "");
  if (!path || !/^[0-9a-f]{40}$/.test(run?.head_sha || "")) return "";
  return String(await rest(`repos/${repo.full}/contents/${path}?ref=${run.head_sha}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" }));
}

/**
 * The failing jobs a Block quotes (session.mjs failureLead), in order, each named for what it is. Every red required
 * check comes first, as `<name> (required check)` with its own failure lines; a required roll-up with none of its own
 * (`aggregate`) is quoted from a failing job it gathers, `<name> (required check), from <job>`: one whose job may not
 * fail without failing the run first (`coe` false, then unknown, then true). A required check with no failure line
 * anywhere says so. The other failing jobs with failure lines follow, a job no required check counts marked `not
 * required`. What a required check counts, whether it printed its own failure or not: the failing jobs of its own run
 * (`suite`) its job `needs`, directly or not (`gathers`), less those that may fail without failing the run; when its
 * workflow file could not say (or, for a roll-up, names none with a failure line), every failing job of its run may
 * count, and none of them is called not required. `jobs` are redDetail's.
 * None when no failing job printed a failure line: the Block then quotes the output's tail.
 */
export function leadJobs(jobs) {
  const all = jobs || [];
  const lined = (j) => !!(j.sig?.line || j.sig?.lines?.length);
  if (!all.some(lined)) return [];
  const rank = (j) => (j.coe === false ? 0 : j.coe === true ? 2 : 1);
  const out = [];
  const quoted = new Set();
  const counted = new Set();
  // Jobs that may count toward a required roll-up whose gathered jobs are not known (its workflow could not say).
  const maybe = new Set();
  for (const r of all.filter((j) => j.required)) {
    quoted.add(r);
    // The failing jobs a required check counts, in its own run only: the ones it needs when its workflow said so, else
    // every failing job of its run, which may count. A roll-up's known set holding no failing job with a failure line
    // explains nothing: read as unknown.
    const ofRun = all.filter((j) => !j.required && r.suite != null && j.suite === r.suite);
    const named = Array.isArray(r.gathers) ? ofRun.filter((j) => r.gathers.includes(j.name)) : null;
    const known = !!named && (lined(r) || named.some(lined));
    const under = known ? named : ofRun;
    for (const j of under) {
      if (!known) maybe.add(j);
      else if (j.coe !== true) counted.add(j);
    }
    if (lined(r)) {
      out.push({ name: `${r.name} (required check)`, line: r.sig.line, lines: r.sig.lines });
      continue;
    }
    const from = r.aggregate ? under.filter(lined).sort((x, y) => rank(x) - rank(y))[0] : null;
    if (from) quoted.add(from);
    out.push(from ? { name: `${r.name} (required check), from ${from.name}${from.coe === true ? " (continue-on-error)" : ""}`, line: from.sig.line, lines: from.sig.lines } : { name: `${r.name} (required check)`, line: `no failure line found in its log${r.aggregate && under.length ? " or in the jobs it gathers" : ""}`, lines: [] });
  }
  for (const j of all) {
    if (quoted.has(j) || !lined(j)) continue;
    const note = j.required || counted.has(j) || maybe.has(j) ? "" : j.coe === true ? " (not required: continue-on-error)" : " (not required)";
    out.push({ name: `${j.name}${note}`, line: j.sig.line, lines: j.sig.lines });
  }
  return out;
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

/**
 * The one-line reason for a red that is all base failures (the base matches named, each by its signature, or by the
 * same-failure check's verdict, confidence and floor where the decision model judged it; an aggregate beside them).
 */
export const baseFailureReason = (detail) => {
  const based = detail.jobs.filter((j) => j.base);
  const gathered = detail.jobs.filter((j) => !j.base && j.aggregate);
  const how = (j) => (j.base.exact === false ? `${j.name}: ${j.base.said}` : j.sig.id);
  return `base failure: ${based.map((j) => j.name).join(", ")} ${based.length > 1 ? "fail" : "fails"} the same way on ${detail.branch}@${String(based[0].base.sha).slice(0, 7)} (${based.map(how).join(", ")})${gathered.length ? `, and ${gathered.map((j) => j.name).join(", ")} only ${gathered.length > 1 ? "gather" : "gathers"} ${based.length > 1 ? "them" : "it"}` : ""}; not this change`;
};

/**
 * A red that would be all base failures (allOnBase) but for jobs whose same-failure judgement got no answer
 * (`baseUndecided`): {cause, why, limited?}, the Block's cause (`outage` when every such judgement met its vendor's
 * outage, else `factory`), why, and the stage harness's usage limit that stopped one. Null otherwise, and when a job is
 * the change's (judged not the same failure) or one was left out.
 */
export function undecidedOnBase(detail) {
  const jobs = detail?.jobs || [];
  if (!jobs.length || detail.truncated) return null;
  const open = jobs.filter((j) => !j.base && !j.aggregate);
  if (!open.length || !open.every((j) => j.baseUndecided)) return null;
  const limited = open.find((j) => j.baseUndecided.limited)?.baseUndecided.limited ?? null;
  const cause = !limited && open.every((j) => j.baseUndecided.cause === "outage") ? "outage" : "factory";
  const names = open.map((j) => j.name).join(", ");
  return { cause, why: `whether ${detail.branch} fails ${names} the same way could not be judged: the same-failure check got ${open.map((j) => j.baseUndecided.said).join("; ")}`, ...(limited ? { limited } : {}) };
}
