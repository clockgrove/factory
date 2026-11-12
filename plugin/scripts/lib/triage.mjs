// Triage of a red required check before Factory spends a fix pass on it. Each failing CI job is asked, one question per
// job, whether the change broke it or it is infrastructure or a flake; only when every failing job reads flaky at
// MIN_CONFIDENCE or more, and no failure names a file or test the PR changes, are the failed jobs rerun, once per head.
// Anything else (a change verdict, a low confidence, an error, a refusal, a failure signature already rerun once, an
// earlier refused rerun, no key) goes to the fix pass exactly as before. Each triage line, and why triage is off at a red,
// goes to the job log and the run's progress comment.
// A required job GitHub never started (neverStarted: no step, no runner) is no question at all: the validation loop
// Blocks on it before triage (session.mjs validationLoop), quoting GitHub's annotation.
// The decision model sits behind the decider adapter (adapters/decider.mjs, docs/ADAPTERS.md). This runs in Factory's
// own process, never in a harness: the key stays here, and scrubbedEnv (harness.mjs) keeps it out of every child.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { openDecider } from "./adapters/decider.mjs";
import { cleanLog, jobLog, listComments, logWindow, rest } from "./github.mjs";
import { log, mask } from "./inputs.mjs";
import { gatewayKeyFile, keyDirExposedBy } from "./local.mjs";
import { isSelf } from "./logic.mjs";
import { parseYaml } from "./yaml.mjs";

/** The default decision model: 23/23 single-job reds and every flaky one caught in Factory's offline replay (#2504). */
export const TRIAGE_MODEL = "perplexity/pplx-decider-v1.2";
/** A flaky verdict below this reruns nothing: on the replay set the hard change-caused reds scored 0.51 to 0.58. */
export const MIN_CONFIDENCE = 0.7;
/** More failing jobs than this are not triaged (and reds.mjs details no more): so wide a red is not one flake. */
export const MAX_JOBS = 10;

/** The one question each failing job is asked, as measured in the replay. */
export const TRIAGE_QUESTION = {
  type: "choice",
  name: "red_cause",
  instructions:
    "A required CI check went red on a pull request. Using the failing job, its log and the pull request's diff summary, decide the most likely cause of this job's failure. " +
    "Choose change_caused when the failure is in code, tests, dependencies or contracts the pull request touched or introduced. " +
    "Choose flaky_or_infra when the failure is unrelated to the change (timing races, intermittent tests, runner or network trouble) and would likely pass on a rerun with no change. " +
    "Choose base_failure when the default branch itself fails the same way without this change.",
  choices: [
    { value: "change_caused", description: "The pull request's change broke the check; a fix in the PR is needed." },
    { value: "flaky_or_infra", description: "Intermittent test or infrastructure failure unrelated to the change; a rerun would pass." },
    { value: "base_failure", description: "The default branch fails the same way; not caused by this change." },
  ],
};

/**
 * The key, or why there is none (a code). On Actions the `ai_gateway_api_key` input only; off Actions the file
 * ~/.config/factory/ai-gateway-key only, which Factory's own process reads and no sandbox can (the sandboxes deny that
 * literal path), so the key is in no process's environment. The file is held to local mode's rules for key files
 * (lib/local.mjs localApp): ~/.config/factory a real directory, the key a regular file (no symlink) with one link and
 * no group or world bits, and no home of the harness (`inputs.harness`, which the outer sandbox leaves readable) equals
 * or holds ~/.config/factory. Codes: no-key, key-dir-exposed, key-dir-symlink, key-file-not-regular, key-file-links,
 * key-file-mode, key-file-empty, key-file-<errno> (any other fs error, for example key-file-eacces).
 */
export function triageKeyState({ inputs = {}, env = process.env, home = homedir() } = {}) {
  const none = (code) => ({ key: "", code });
  if (env.GITHUB_ACTIONS) {
    const key = String(inputs.aiGatewayApiKey || "").trim();
    return key ? { key, code: null } : none("no-key");
  }
  const file = gatewayKeyFile(home);
  const dir = dirname(file);
  const errno = (e) => (e?.code === "ENOENT" ? "no-key" : `key-file-${String(e?.code || "error").toLowerCase()}`);
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    return none(errno(e));
  }
  if (keyDirExposedBy(inputs.harness, env, home)) return none("key-dir-exposed");
  try {
    if (realpathSync(dir) !== dir) return none("key-dir-symlink");
  } catch (e) {
    return none(errno(e));
  }
  if (!st.isFile()) return none("key-file-not-regular");
  if (st.nlink > 1) return none("key-file-links");
  if (st.mode & 0o077) return none("key-file-mode");
  try {
    const key = readFileSync(file, "utf8").trim();
    return key ? { key, code: null } : none("key-file-empty");
  } catch (e) {
    return none(errno(e));
  }
}

/** The key alone ("" turns triage off). */
export const triageKey = (opts) => triageKeyState(opts).key;

/** Whether this process has said triage is off: once per stage (one stage is one process). */
let offSaid = false;

/** What one failing job is asked about: the shape the replay measured, one job at a time. */
export function triageInput({ repo, prNumber, sha, job, excerpt, files = [], maxFiles = 60 }) {
  const adds = files.reduce((n, f) => n + (f.additions || 0), 0);
  const dels = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const names = files.slice(0, maxFiles).map((f) => f.filename);
  const more = files.length > maxFiles ? `\n… and ${files.length - maxFiles} more files` : "";
  return [
    `Repository: ${repo}`,
    `Pull request: #${prNumber}, head ${String(sha).slice(0, 12)}`,
    `Failing CI job: ${job}`,
    "",
    `Diff summary: ${files.length} files changed, ${adds} insertions(+), ${dels} deletions(-)`,
    "Files changed by the pull request:",
    names.join("\n") + more,
    "",
    "Log of the failing job (key lines):",
    excerpt,
  ].join("\n");
}

/** Rerun only when there is at least one verdict and every one is flaky at `min` or more; a missing confidence is not enough. */
export const rerunWanted = (verdicts, min = MIN_CONFIDENCE) => verdicts.length > 0 && verdicts.every((v) => v.verdict === "flaky_or_infra" && typeof v.confidence === "number" && v.confidence >= min);

// ------------------------------------------------------------------ failure signatures

// Lines a test runner, compiler or tool prints for a failure itself: node --test (✖), Jest (●, FAIL, Expected/Received),
// Vitest (×, FAIL), Playwright (✘, numbered titles), Mocha (numbered titles), TAP (not ok), Go (--- FAIL, panic), pytest
// (FAILED, E), apt (E:), Rust (panicked, error[E…]), tsc and ESLint, any Error or Exception, and the network and
// download failures infrastructure reds print.
const FAILURE = [
  /^[✖×✗✘●]\s+\S/u,
  /^\d+\)\s+\S/,
  /^FAIL(?:ED)?\b/,
  /^not ok\b/,
  /^--- FAIL\b/,
  /^panic:/,
  /\bpanicked at\b/,
  /^E\s{2,}\S/,
  /^E: /,
  /^(?:[\w$]+\.)*[\w$]*(?:Error|Exception)\b(?:\s*\[[A-Z0-9_]+\])?:/,
  /^error(?:\[\w+\])?:/i,
  /\berror TS\d+:/,
  /^\d+:\d+\s+error\s/,
  /^(?:Expected|Received): /,
  /^curl: \(\d+\)/,
  /^fatal:/,
  /^Failed to\b/,
  /^Unexpected HTTP response\b/,
  /^Error while\b/,
];
// The wrappers every red repeats whatever failed: the runner's annotation, npm, pnpm and yarn's exit lines, summaries.
const BOILERPLATE = [/^##\[/, /^npm (?:error|ERR!)/, /ELIFECYCLE/, /^Error: Process completed with exit code/, /^error Command failed with exit code/, /^[✖×]\s+failing tests:?$/u, /^(?:FAIL|FAILED)\s*$/, /^Error: The process '.*' failed with exit code/];
const EXPLAINS = /(?:Error|Exception)\b|^E:?\s|^error|^panic|panicked|^FAILED|^not ok|^--- FAIL/;
// Lines that locate a failure in the repository: stack frames, a test's location, Python's `File "…", line N`, and a
// `path:line:` prefix (Go's t.Errorf, pytest's crash line, ESLint) or tsc's `path(line,col)`.
const LOCATION = [/^at\s/, /\btest at\b/, /^File "[^"]+", line \d+/, /^[\w./@+-]+\.\w+:\d+(?::\d+)?:/, /^[\w./@+-]+\.\w+\(\d+,\d+\)/, /\.(?:test|spec)\.[cm]?[jt]sx?\b/, /:\d+:\d+\)?$/];
// A source file reference with its line: `path:N`, `path", line N` or `path(N,M)`.
const REF = /(?:file:\/\/)?((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|exs?|c|cc|cpp|h|hpp|vue|svelte))(?=:\d|", line \d|\(\d+,\d+\))/g;

// A path character: anything but whitespace, quotes, brackets and the `:` before a line number.
const PC = "[^\\s'\"()<>:]";
// Windows paths as posix ones: `D:\a\app\app\x.js` and `file:///D:/a/app/app/x.js` become `/D/a/app/app/x.js`.
const WIN_PATH = /(?:file:\/\/\/)?\b([A-Za-z]):([\\/][^\s'"()<>]*)/g;
// Paths that are random per run: the system temp directories, the runner's temp directory ($RUNNER_TEMP is
// <workspace>/_temp on every hosted runner) and Windows' user temp. The whole path is folded, file name included.
const TEMP_PATH = new RegExp(`(?:file://)?(?:/private)?(?:/tmp|/var/folders|(?:/${PC}+?)?/_temp|/[A-Za-z]/Users/${PC}+/AppData/Local/Temp)(?:/${PC}*)?`, "g");
// The runner's checkout prefix: `/home/runner/work/<repo>/<repo>/`, a self-hosted runner's `.../_work/<repo>/<repo>/`,
// Windows' `D:\a\<repo>\<repo>\` (posix by now). What follows it is the repository-relative path.
// The runner's own directories under the workspace (actions' code, the tool cache) are never a checkout.
const SEG = "(?!_(?:actions|tool|temp)/)[^\\s'\"()<>:/]+";
const RUNNER_PREFIX = new RegExp(`(?:file://)?(?:/${PC}+?)?/_?work/${SEG}/${SEG}/|(?:file://)?/[A-Za-z]/a/${SEG}/${SEG}/`, "g");

/**
 * A line with the paths that differ from run to run folded, before anything is hashed: Windows paths made posix, temp
 * directories (with whatever is under them) replaced by `<tmp>`, the runner's checkout prefix dropped, bundle chunk
 * hashes (`main.3f9a2b1c.js`, `index-Bq3XmRtk.js` to `HASH`) and numbered chunks (`chunks/482.js`) and pytest's numbered
 * directories folded.
 */
export function foldPaths(line) {
  return String(line)
    .replace(WIN_PATH, (_, drive, rest) => `/${drive.toUpperCase()}${rest.replace(/\\/g, "/")}`)
    .replace(TEMP_PATH, "<tmp>")
    .replace(RUNNER_PREFIX, "")
    .replace(/([./-])(?:(?=[0-9a-f]*\d)[0-9a-f]{6,}|(?=[A-Za-z0-9_-]*(?:\d|[a-z][A-Za-z0-9_-]*[A-Z]|[A-Z][A-Za-z0-9_-]*[a-z]))[A-Za-z0-9_-]{8})(?=\.(?:[cm]?js|css|map)\b)/g, "$1HASH")
    .replace(/(^|[/.-])\d+(?=\.(?:[cm]?js|css|map)\b)/g, "$1N")
    .replace(/\bpytest-\d+\b/g, "pytest-N");
}

/** One failure line with run-to-run noise folded: paths (foldPaths), hashes, numbers (durations, counts, ports, line numbers). */
const fold = (l) => foldPaths(l).replace(/\b[0-9a-f]{7,}\b/gi, "#").replace(/\d+(?:\.\d+)?/g, "0").replace(/\s+/g, " ").trim();

/**
 * The repository files a line points at, as paths relative to the checkout (foldPaths: a runner's checkout prefix on
 * Linux, macOS, Windows or a self-hosted runner dropped, chunk hashes folded), other absolute paths cut to their last
 * three parts. Temp directories, dependencies (node_modules, site-packages, the Go module cache), the runner's tool
 * cache and the runtime's own frames are not the repository's.
 */
export function repoRefs(line) {
  const out = [];
  for (const m of foldPaths(line).matchAll(REF)) {
    let p = m[1].replace(/^\.\//, "");
    if (/(?:^|\/)(?:node_modules|site-packages|dist-packages|hostedtoolcache|_actions|_tool|go\/pkg\/mod)\//.test(p) || /^(?:node:|internal\/)/.test(p)) continue;
    if (p.startsWith("/")) p = p.split("/").slice(-3).join("/");
    out.push(p);
  }
  return out;
}

/**
 * The lines of the step that failed: from the last `##[group]` (a step's header) before the first `##[error]` to the
 * next `##[group]` after it. Warnings and failure-shaped lines from steps that passed (setup, caches) stay out of the
 * signature. A log with no `##[error]`, or no group before it, is read whole.
 */
export function failingStep(lines) {
  const err = lines.findIndex((l) => l.startsWith("##[error]"));
  if (err < 0) return lines;
  let start = -1;
  for (let i = err - 1; i >= 0; i -= 1) if (lines[i].startsWith("##[group]")) {
    start = i;
    break;
  }
  if (start < 0) return lines;
  const next = lines.findIndex((l, i) => i > err && l.startsWith("##[group]"));
  return lines.slice(start, next < 0 ? lines.length : next);
}

/**
 * A job's failure signature: a hash of the job name, the sorted, folded set of failure lines in the step that failed
 * (failingStep; FAILURE, minus BOILERPLATE), and the repository files those lines and the lines that locate them point
 * at (repoRefs). A log
 * with no failure line (only exit codes and wrappers) has no signature (`id` null), and no signature ever matches
 * another. `line` is the most telling failure line, for people; `lines` are the failure lines and `context` the lines
 * that locate them (stack frames, test files), as logged.
 */
export function failureSignature(name, text) {
  const all = failingStep(cleanLog(text).split("\n").map((l) => l.trim()).filter(Boolean));
  const lines = [];
  const context = [];
  for (const l of all) {
    if (BOILERPLATE.some((re) => re.test(l))) continue;
    if (FAILURE.some((re) => re.test(l))) {
      if (lines.length < 400) lines.push(l);
    } else if (LOCATION.some((re) => re.test(l)) && context.length < 400) context.push(l);
  }
  if (!lines.length) return { id: null, line: "", lines, context };
  const files = [...lines, ...context].flatMap(repoRefs).map((p) => `@${p}`);
  const set = [...new Set([...lines.map(fold), ...files])].sort();
  const id = createHash("sha256").update(`${name}\n${set.join("\n")}`).digest("hex").slice(0, 12);
  const line = (lines.find((l) => EXPLAINS.test(l)) ?? lines[0]).slice(0, 160);
  return { id, line, lines, context };
}

/** Whether two signatures are the same failure: both exist and are equal. */
export const sameFailure = (a, b) => !!a?.id && !!b?.id && a.id === b.id;

// ------------------------------------------------------------------ what the PR changed

/** The names a red could point at in the PR: changed paths, their file names, and tests its added lines name. */
export function changedNames(files) {
  const paths = new Set();
  const bases = new Set();
  const tests = new Set();
  for (const f of files || []) {
    for (const p of [f.filename, f.previous_filename].filter(Boolean)) {
      paths.add(p);
      const b = basename(p);
      if (b.length >= 4) bases.add(b);
    }
    for (const raw of String(f.patch || "").split("\n")) {
      if (!raw.startsWith("+")) continue;
      const m = /\b(?:test|it|describe|context|scenario)(?:\.\w+)?\s*\(\s*(["'`])(.{3,120}?)\1/.exec(raw) || /^\+\s*(?:async\s+)?def (test_\w+)/.exec(raw) || /^\+func (Test\w+)\(/.exec(raw);
      if (m) tests.add(m[2] ?? m[1]);
    }
  }
  return { paths, bases, tests };
}

/** The first changed path, file name or test a failure's lines name, or null. */
export function namesChange(sig, names) {
  for (const l of [...(sig?.lines || []), ...(sig?.context || [])]) {
    for (const p of names.paths) if (l.includes(p)) return p;
    for (const b of names.bases) if (new RegExp(`(?:^|[\\s/\\\\(\`'"])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s:)\`'"])`).test(l)) return b;
    for (const t of names.tests) if (l.includes(t)) return t;
  }
  return null;
}

// ------------------------------------------------------------------ the record

/** The triage record in a run's progress comment: the heads rerun, the signatures rerun, and whether a rerun was refused. */
export const triageMarker = (rec) => `<!-- factory:triage ${JSON.stringify({ reruns: [...(rec?.reruns || [])], sigs: [...(rec?.sigs || [])], ...(rec?.refused ? { refused: true } : {}) })} -->`;
const TRIAGE = /^<!-- factory:triage (\{[^\n]*\}) -->$/m;

/** Merge triage records: the union of the heads and the signatures; refused once is refused. */
export function mergeTriage(...recs) {
  const reruns = new Set();
  const sigs = new Set();
  let refused = false;
  for (const r of recs) {
    for (const s of r?.reruns || []) if (typeof s === "string" && /^[0-9a-f]{7,64}$/.test(s)) reruns.add(s);
    for (const s of r?.sigs || []) if (typeof s === "string" && /^[0-9a-f]{12}$/.test(s)) sigs.add(s);
    if (r?.refused === true) refused = true;
  }
  return { reruns, sigs, refused };
}

/** Every triage record on the issue: only from Factory's own progress comments (its own login), as decisionsReadOf reads. */
export function triageOf(comments, { issue }) {
  const progress = `<!-- factory:${issue}:progress:`;
  const recs = [];
  for (const c of comments || []) {
    if (!isSelf(c) || !(c.body || "").startsWith(progress)) continue;
    const m = TRIAGE.exec(c.body || "");
    if (!m) continue;
    try {
      recs.push(JSON.parse(m[1]));
    } catch {
      // a malformed record: nothing recorded
    }
  }
  return mergeTriage(...recs);
}

// ------------------------------------------------------------------ which jobs

/**
 * A required check that only gathers other jobs (an `always()` job that `needs:` them): in the same workflow run (check
 * suite) as another failing job, and started no earlier than that job completed. Structure only, never its name.
 */
export function isAggregate(run, failedRuns, required = []) {
  if (!required.includes(run.name) || run.suite == null) return false;
  const start = Date.parse(run.started_at);
  return failedRuns.some((o) => o !== run && o.suite === run.suite && Number.isFinite(start) && Number.isFinite(Date.parse(o.completed_at)) && start >= Date.parse(o.completed_at));
}

/**
 * The jobs triage asks the model about: every failing job except an aggregate of the others, which is one that is
 * structurally so (isAggregate) and whose own log has no failure line (`sigs`, by check-run id; a job whose signature
 * is not known is always asked). A queued real job that started after another failed has failure lines of its own.
 * Only triage's questions use this: the fix pass and the base-failure decision cover every failing job.
 */
export function jobsToTriage(failedRuns, required = [], sigs = new Map()) {
  const runs = failedRuns || [];
  const own = runs.filter((r) => !(isAggregate(r, runs, required) && sigs.has(r.id) && !sigs.get(r.id).lines.length));
  return own.length ? own : [...runs];
}

// ------------------------------------------------------------------ jobs GitHub never started

/**
 * Whether an Actions job never started: GitHub completed it as failed with no step run and no runner assigned (an
 * account locked for billing, a spending limit reached, a runner label no runner serves). Structure only, never the
 * annotation's words. No change to the branch can turn such a check green, so it is infrastructure, never the change's.
 */
export const neverStarted = (job) => !!job && job.conclusion === "failure" && Array.isArray(job.steps) && job.steps.length === 0 && !job.runner_id && !job.runner_name;

/** GitHub's own words on a check run, to quote: its first failure annotation's message, on one line. */
const annotationText = (annotations) => {
  const list = Array.isArray(annotations) ? annotations : [];
  const a = list.find((x) => x?.annotation_level === "failure" && x.message) ?? list.find((x) => x?.message);
  return a ? String(a.message).replace(/\s+/g, " ").trim().slice(0, 300) : "";
};

/**
 * The failing jobs GitHub never started (neverStarted) that hold a required check red: a required check's own job, or
 * one a failing required aggregate gathers (an aggregate that `needs:` it: same workflow run, started once it completed),
 * and then only when every failing job that aggregate gathers never started; one that ran and failed is a red the
 * change may have caused, left to triage and the fix pass. Each comes with the required check it holds red and GitHub's
 * annotation on it, read only to be quoted. The candidates are chosen first (required jobs first), then at most MAX_JOBS
 * jobs are read; a job not read counts as one that ran. A check that is no Actions job, or whose job cannot be read
 * (said in the log), is none: it goes on to triage and the fix pass as before. `actionsToken` reads the jobs, `token`
 * the check runs' annotations.
 */
export async function notStartedJobs({ repo, failedRuns = [], required = [], token, actionsToken = token }) {
  const at = (t) => Date.parse(t);
  const gathers = (a) => failedRuns.filter((o) => o !== a && a.suite != null && o.suite === a.suite && Number.isFinite(at(o.completed_at)) && at(a.started_at) >= at(o.completed_at));
  const isRequired = (r) => required.includes(r.name);
  const aggregates = failedRuns.filter((a) => isRequired(a) && gathers(a).length);
  const own = failedRuns.filter(isRequired);
  const gathered = failedRuns.filter((r) => !isRequired(r) && aggregates.some((a) => gathers(a).includes(r)));
  // Only the candidates are read, and every job an aggregate gathers, so its verdict covers all of them.
  const reads = [...new Set([...own, ...gathered, ...aggregates.flatMap(gathers)])].slice(0, MAX_JOBS);
  const jobs = new Map();
  for (const r of reads) {
    jobs.set(r, await rest(`repos/${repo.full}/actions/jobs/${r.id}`, { token: actionsToken }).catch((e) => {
      log(`job ${r.id} (${r.name}) unreadable (${e?.status || "error"}): never-started check skipped`);
      return null;
    }));
  }
  const stuck = (r) => neverStarted(jobs.get(r));
  const out = [];
  const add = async (r, check) => {
    const annotations = await rest(`repos/${repo.full}/check-runs/${r.id}/annotations?per_page=50`, { token }).catch(() => []);
    out.push({ id: r.id, name: r.name, check, annotation: annotationText(annotations) });
  };
  for (const r of own) if (stuck(r)) await add(r, r.name);
  for (const r of gathered) {
    if (!stuck(r)) continue;
    const agg = aggregates.find((a) => gathers(a).includes(r) && gathers(a).every(stuck));
    if (agg) await add(r, agg.name);
  }
  return out;
}

/** The Block reason for jobs GitHub never started: each named, with GitHub's annotation quoted. */
export const notStartedReason = (jobs) =>
  jobs.map((j) => `GitHub did not start the required job ${j.name}${j.check !== j.name ? ` (needed by the required check ${j.check})` : ""}: ${j.annotation || "no annotation from GitHub"}`).join("; ");

// ------------------------------------------------------------------ required checks GitHub has not started yet

/** A workflow run or check run GitHub has created but not started. `waiting` is not one: it waits for an approval. */
const UNSTARTED = ["queued", "requested", "pending"];
/** The newest check run of `name` among `checkRuns`. */
const latestRun = (checkRuns, name) => (checkRuns || []).filter((r) => r.name === name).sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")) || (b.id ?? 0) - (a.id ?? 0))[0];
/** The check names a workflow file's jobs report: a job's literal `name`, else its id. A matrix job reports `name (…)`. */
export function workflowChecks(text) {
  try {
    return Object.entries(parseYaml(String(text || ""))?.jobs || {}).map(([id, job]) => (typeof job?.name === "string" && !job.name.includes("${{") ? job.name : id));
  } catch {
    return [];
  }
}
const reports = (check, name) => name === check || name.startsWith(`${check} (`);

/**
 * What checksNotStarted reads, on structure: the head's workflow runs; the Actions job of each required check run not
 * started yet (whether a runner took it); and, for a required check with no check run on the head, the workflows that
 * produce it (`producers`: name → workflow ids): a head workflow run whose file (at the head) has a job reporting that
 * name, else the workflow of that check's run on an older commit (`history()`: commit ids, newest first, read only
 * when needed), found through its check suite. `workflowRuns` null: they could not be read (`readError`).
 */
export async function checkSources({ repo, sha, names, checkRuns = [], token, actionsToken = token, history = async () => [] }) {
  const actions = { token: actionsToken };
  let workflowRuns;
  try {
    workflowRuns = (await rest(`repos/${repo.full}/actions/runs?head_sha=${sha}&per_page=100`, actions))?.workflow_runs || [];
  } catch (e) {
    return { workflowRuns: null, readError: String(e?.status || "error"), jobs: new Map(), producers: new Map() };
  }
  const jobs = new Map();
  for (const n of names) {
    const r = latestRun(checkRuns, n);
    if (r && UNSTARTED.includes(r.status)) jobs.set(r.id, await rest(`repos/${repo.full}/actions/jobs/${r.id}`, actions).catch(() => null));
  }
  const producers = new Map();
  const add = (n, id) => producers.set(n, new Set([...(producers.get(n) || []), id]));
  const missing = names.filter((n) => !latestRun(checkRuns, n));
  if (missing.length) {
    const seen = new Set();
    for (const w of workflowRuns) {
      if (seen.has(w.workflow_id) || !w.path) continue;
      seen.add(w.workflow_id);
      const path = String(w.path).replace(/@.*$/, "");
      const text = await rest(`repos/${repo.full}/contents/${path}?ref=${sha}`, { token, raw: "Accept: application/vnd.github.raw+json" }).catch(() => "");
      for (const check of workflowChecks(text)) for (const n of missing) if (reports(check, n)) add(n, w.workflow_id);
    }
    const left = missing.filter((n) => !producers.has(n));
    const older = left.length ? await history().catch(() => []) : [];
    for (const n of left) {
      for (const c of older) {
        const run = (await rest(`repos/${repo.full}/commits/${c}/check-runs?check_name=${encodeURIComponent(n)}&filter=all&per_page=5`, { token }).catch(() => null))?.check_runs?.[0];
        if (!run?.check_suite?.id) continue;
        const w = (await rest(`repos/${repo.full}/actions/runs?check_suite_id=${run.check_suite.id}&per_page=1`, actions).catch(() => null))?.workflow_runs?.[0];
        if (w?.workflow_id) {
          add(n, w.workflow_id);
          break;
        }
      }
    }
  }
  return { workflowRuns, readError: "", jobs, producers };
}

/**
 * Why a wait on the required checks ended with none failed and some not finished (awaitChecks `timedOut` with no
 * completed failing run), from checkSources's reads. Returns {githubDelay, reason, runs}. githubDelay is GitHub not
 * starting a required check, which no change can fix, each tied to that check: its check run still queued with no
 * runner (in a workflow run still going, or one that completed: #72's two shapes), or, with no check run, the workflow
 * that produces it queued on the head, or never created (as when the head has no workflow run at all). A check waiting
 * for an approval (`waiting`), still running, or that no workflow on the head produces (a wrong check name) is none of
 * GitHub's delay; a queued run of another workflow is not this check's. `now` and `waitedMin` only word the reason.
 */
export function checksNotStarted({ sha, names = [], checkRuns = [], workflowRuns = null, jobs = new Map(), producers = new Map(), waitedMin = 0, readError = "", now = Date.now() }) {
  const short = String(sha).slice(0, 7);
  const list = (xs) => xs.join(", ");
  const mins = (t) => (Number.isFinite(Date.parse(t)) ? Math.max(0, Math.round((now - Date.parse(t)) / 60000)) : null);
  const label = (w) => `${w.name || "workflow"} (run ${w.id})`;
  const open = names.filter((n) => latestRun(checkRuns, n)?.status !== "completed");
  if (!Array.isArray(workflowRuns)) return { githubDelay: false, runs: [], reason: `required check(s) ${list(open)} not finished on ${short} after ${waitedMin} min, and its workflow runs could not be read${readError ? ` (${readError})` : ""}; no failing run to fix` };
  const bySuite = new Map(workflowRuns.map((w) => [w.check_suite_id, w]));
  const started = [];
  const approval = [];
  const running = [];
  const unreported = [];
  for (const n of open) {
    const r = latestRun(checkRuns, n);
    if (r) {
      const w = bySuite.get(r.check_suite?.id ?? r.suite) || null;
      const job = jobs.get(r.id);
      if (r.status === "waiting") approval.push(n);
      else if (UNSTARTED.includes(r.status) && !job?.runner_id && !job?.runner_name) {
        const how = !w ? "with no runner" : w.status === "completed" ? `after its workflow run ${label(w)} completed${mins(w.updated_at) === null ? "" : ` ${mins(w.updated_at)} min ago`}` : `with no runner in workflow run ${label(w)}`;
        started.push({ n, w, text: `${n} queued ${how}` });
      } else running.push({ n, w });
      continue;
    }
    const ids = producers.get(n);
    const mine = ids ? workflowRuns.filter((w) => ids.has(w.workflow_id)) : [];
    const queued = mine.filter((w) => UNSTARTED.includes(w.status));
    if (queued.length) started.push({ n, w: queued[0], text: `workflow run ${label(queued[0])} queued ${mins(queued[0].created_at) ?? "?"} min with no job started` });
    else if (mine.some((w) => w.status === "waiting")) approval.push(n);
    else if (mine.some((w) => w.status !== "completed")) running.push({ n, w: mine.find((w) => w.status !== "completed") });
    else if ((ids && !mine.length) || !workflowRuns.length) started.push({ n, w: null, text: `no workflow run for it was created in ${waitedMin} min` });
    else unreported.push(n);
  }
  if (unreported.length) return { githubDelay: false, runs: [], reason: `required check(s) ${list(unreported)} never reported on ${short}: no workflow run on it produces ${unreported.length > 1 ? "them" : "it"} (${list(workflowRuns.slice(0, 3).map(label))}); check the required check names; no failing run to fix` };
  if (approval.length) return { githubDelay: false, runs: [], reason: `required check(s) ${list(approval)} on ${short} wait for a deployment approval; approve ${approval.length > 1 ? "them" : "it"}, then re-apply the label; no failing run to fix` };
  if (started.length) return { githubDelay: true, runs: started.map((x) => x.w).filter(Boolean), reason: `GitHub has not started the required check(s) ${list(started.map((x) => x.n))} on ${short}: ${started.map((x) => x.text).join("; ")} (infrastructure, not this change)` };
  return { githubDelay: false, runs: running.map((x) => x.w).filter(Boolean), reason: `required check(s) ${list(open)} not finished on ${short} after ${waitedMin} min: ${list([...new Set(running.map((x) => (x.w ? label(x.w) : x.n)))])} still in progress; no failing run to fix` };
}

/**
 * The Block reason's part for a red whose triage read every failing job as a flake or infrastructure and whose rerun
 * GitHub refused (`refusal`, from red()): triage's verdicts, the refusal, and what a person does about it. A 403 is the
 * token's missing Actions write: locally the repository token's, on Actions the workflow's `actions: write`.
 */
export function refusedRerunText(refusal) {
  const jobs = (refusal?.jobs || []).map((j) => `${j.name}: ${j.verdict ?? "no verdict"}${typeof j.confidence === "number" ? ` ${j.confidence.toFixed(2)}` : ""}`).join(", ");
  const status = refusal?.status ? String(refusal.status) : "error";
  const why = refusal?.permission ? `${status}: the token cannot rerun jobs` : refusal?.rateLimited ? `${status}: rate limited` : status;
  const grant = refusal?.where === "actions" ? "give the workflow's work and review jobs `actions: write`" : "give the token Actions read and write";
  return `red-check triage read it as a flake or infrastructure (${jobs}), but GitHub refused the rerun (${why}); rerun the failed jobs on GitHub${refusal?.permission ? `, or ${grant},` : ""} then re-apply the label`;
}

/** The progress line for one triage: each job's verdict, confidence and signature, then what Factory does. */
export function triageLine({ sha, model, jobs, outcome }) {
  const each = jobs.map((j) => {
    const sig = j.sig.id ? `${j.sig.id}${j.repeat ? ", seen before" : ""}${j.sig.line ? ` \`${j.sig.line.replace(/`/g, "'")}\`` : ""}` : "no failure line found";
    return `${j.name}: ${j.verdict ?? `no verdict (${j.error || "?"})`}${typeof j.confidence === "number" ? ` ${j.confidence.toFixed(2)}` : ""} [${sig}]`;
  });
  return `triage of the red on ${String(sha).slice(0, 7)} (${model}): ${each.join("; ")} → ${outcome}`;
}

/**
 * Triage. `token` reads the issue and the PR; `actionsToken` reads the jobs and reruns them: on Actions the job token
 * (workflow-template.yml gives the work and review jobs actions: write), locally the repository token (Actions: read
 * and write). `progress` is the run's progressReporter. `red({sha, failedRuns, required})` returns {rerun, ignoreIds,
 * jobs}. Without a key (`off` is the code why) every red goes to the fix pass, and the first says so, once per stage.
 */
export function openTriage({ inputs, env = process.env, home = homedir(), repo, issue, prNumber, token, actionsToken = token, progress = null, decider = null }) {
  const { key, code } = decider ? { key: null, code: null } : triageKeyState({ inputs, env, home });
  const model = inputs?.triageModel || TRIAGE_MODEL;
  if (!decider && !key) {
    const red = async ({ failedRuns = [] } = {}) => {
      if (!failedRuns.length || offSaid) return { rerun: false };
      offSaid = true;
      const line = `triage: off (${code}); fix pass`;
      log(line);
      if (progress) await progress(line);
      return { rerun: false };
    };
    return { model, off: code, red };
  }
  mask(key);
  let ask = decider;
  // What this job recorded, on top of what earlier jobs left on the issue (read once, at the first red).
  let mine = mergeTriage();
  let earlier = null;
  const opts = { token };
  const actions = { token: actionsToken };
  const record = async (line, rec) => {
    mine = mergeTriage(mine, rec);
    progress?.triage?.(mine);
    log(line);
    if (progress) await progress(line);
  };

  const red = async ({ sha, failedRuns = [], required = [] }) => {
    const no = { rerun: false };
    if (!failedRuns.length) return no;
    if (!earlier) {
      // Factory's own login first: only its own progress comments' records count (triageOf).
      await progress?.self?.().catch(() => null);
      earlier = triageOf(await listComments(repo, issue, opts).catch(() => []), { issue });
    }
    const known = mergeTriage(earlier, mine);
    if (known.refused) {
      await record(`triage: a rerun was refused earlier on this Objective (the token cannot rerun jobs: it needs Actions read and write); fix pass`, {});
      return no;
    }
    if (known.reruns.has(sha)) {
      await record(`triage: the failed jobs on ${sha.slice(0, 7)} were already rerun once; fix pass`, {});
      return no;
    }
    if (failedRuns.length > MAX_JOBS) {
      await record(`triage: ${failedRuns.length} failing jobs on ${sha.slice(0, 7)}, more than ${MAX_JOBS}; fix pass`, {});
      return no;
    }
    // Only an Actions job can be rerun: each failing job must resolve to its workflow run, or nothing is asked.
    const runIds = new Set();
    for (const r of failedRuns) {
      const job = await rest(`repos/${repo.full}/actions/jobs/${r.id}`, actions).catch(() => null);
      if (!job?.run_id) {
        await record(`triage: ${r.name} is not an Actions job, so it cannot be rerun; fix pass`, {});
        return no;
      }
      runIds.add(job.run_id);
    }
    const files = (await rest(`repos/${repo.full}/pulls/${prNumber}/files?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
    const names = changedNames(files);
    ask ??= await openDecider({ key, model });
    const texts = new Map(await Promise.all(failedRuns.map(async (r) => [r.id, await jobLog(repo, r.id, actions).catch(() => "")])));
    const sigs = new Map(failedRuns.map((r) => [r.id, failureSignature(r.name, texts.get(r.id))]));
    const picked = jobsToTriage(failedRuns, required, sigs);
    const jobs = await Promise.all(
      picked.map(async (r) => {
        const text = texts.get(r.id);
        const sig = sigs.get(r.id);
        const repeat = !!sig.id && known.sigs.has(sig.id);
        // A failure already rerun once (on any head of this Objective) is not asked again: rerunning it hides a defect.
        if (repeat) return { name: r.name, sig, repeat, verdict: null, confidence: null, error: "already rerun once" };
        // A failure that names what the PR changed could be the change's own intermittent defect: never rerun to green.
        const named = namesChange(sig, names);
        if (named) return { name: r.name, sig, repeat, verdict: null, confidence: null, error: `its failure names ${named}, which the PR changes` };
        const v = await ask.decide(triageInput({ repo: repo.full, prNumber, sha, job: r.name, excerpt: logWindow(cleanLog(text), 4000), files }), TRIAGE_QUESTION);
        return { name: r.name, sig, repeat, ...v };
      }),
    );
    if (!rerunWanted(jobs)) {
      await record(triageLine({ sha, model, jobs, outcome: "fix pass" }), {});
      return no;
    }
    // Rerun-failed-jobs needs each workflow run completed; a run still going after ten minutes is left to the fix pass.
    for (const id of runIds) {
      const done = await waitRunCompleted(repo, id, actions);
      if (!done) {
        await record(triageLine({ sha, model, jobs, outcome: `fix pass (workflow run ${id} did not complete)` }), {});
        return no;
      }
    }
    for (const id of runIds) {
      try {
        await rest(`repos/${repo.full}/actions/runs/${id}/rerun-failed-jobs`, { ...actions, method: "POST", body: {} });
      } catch (e) {
        // A refusal is remembered for the Objective, so a later red goes straight to the fix pass instead of waiting and
        // asking again. A 403 is a missing permission (locally the token's Actions read and write, on Actions the
        // workflow's actions: write); a 404 may be a run that cannot be rerun, so it names no permission.
        // A throttled call (rate limit) is no refusal: this red goes to the fix pass, and a later one may ask again.
        const refused = (e.status === 403 || e.status === 404) && !e.rateLimited;
        const why = refused && e.status === 403 ? ", no permission to rerun jobs (Actions: write)" : "";
        await record(triageLine({ sha, model, jobs, outcome: `fix pass (the rerun was refused: ${e.status || "error"}${why})` }), refused ? { refused: true } : {});
        // What the Block says when this red is the last (session.mjs validationLoop, refusedRerunText): every job's
        // verdict and failure line, and the refusal.
        const refusal = { status: e.status || null, permission: refused && e.status === 403, rateLimited: !!e.rateLimited, where: env.GITHUB_ACTIONS ? "actions" : "local", jobs: jobs.map((j) => ({ name: j.name, verdict: j.verdict, confidence: j.confidence, line: j.sig.line, lines: j.sig.lines })) };
        return { rerun: false, refused: refusal };
      }
    }
    await record(triageLine({ sha, model, jobs, outcome: "failed jobs rerun" }), { reruns: [sha], sigs: jobs.map((j) => j.sig.id).filter(Boolean) });
    return { rerun: true, ignoreIds: new Set(failedRuns.map((r) => r.id)), jobs: jobs.map((j) => j.name) };
  };
  return { model, red };
}

async function waitRunCompleted(repo, id, { token, timeoutMs = 10 * 60_000, pollMs = 20_000 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await rest(`repos/${repo.full}/actions/runs/${id}`, { token }).catch(() => null);
    if (run?.status === "completed") return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
