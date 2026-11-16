// Triage of a red required check before Factory spends a fix pass on it. Each failing CI job is asked, one question per
// job, whether the change broke it or it is infrastructure or a flake; only when every failing job reads flaky at
// MIN_CONFIDENCE or more, and no failure points at a file the PR changes, are the failed jobs rerun, once per head.
// Anything else (a change verdict, a low confidence, an error, a refusal, a failure signature already rerun once, an
// earlier refused rerun, no decider) goes to the fix pass exactly as before. Each triage line, and why triage is off at a
// red, goes to the job log and the run's progress comment.
// A required job GitHub never started (neverStarted: no step, no runner) is no question at all: the validation loop
// Blocks on it before triage (session.mjs validationLoop), quoting GitHub's annotation.
// The question goes through the one decision interface (decider.mjs, docs/ADAPTERS.md): the AI Gateway's decision
// model with a key, else the stage's own harness on its login. This runs in Factory's own process, never in a harness.
import { createHash } from "node:crypto";
import { Evaluator, Lexer, Parser, data as exprData } from "../../vendor/@actions/expressions/dist/index.js";
import { Binary, ContextAccess, Grouping, IndexAccess, Literal, Logical, Unary } from "../../vendor/@actions/expressions/dist/ast.js";
import { falsy } from "../../vendor/@actions/expressions/dist/result.js";
import { homedir } from "node:os";
import { basename } from "node:path";
import { deciderKeyState, openDecider } from "./decider.mjs";
import { cleanLog, jobLog, listComments, logWindow, rest } from "./github.mjs";
import { log } from "./inputs.mjs";
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

/** The AI Gateway key, or why there is none (decider.mjs deciderKeyState). */
export const triageKeyState = deciderKeyState;

/** The key alone ("": no AI Gateway key, so the stage's own harness answers, decider.mjs). */
export const triageKey = (opts) => triageKeyState(opts).key;

/** Whether this process has said triage is off: once per stage (one stage is one process). */
let offSaid = false;

/**
 * What one failing job is asked about: the shape the replay measured, one job at a time. `mentions` (changeMentions):
 * the changed files and added tests the failure's lines name, for the model to weigh.
 */
export function triageInput({ repo, prNumber, sha, job, step = "", excerpt, files = [], mentions = null, maxFiles = 60 }) {
  const adds = files.reduce((n, f) => n + (f.additions || 0), 0);
  const dels = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const names = files.slice(0, maxFiles).map((f) => f.filename);
  const more = files.length > maxFiles ? `\n… and ${files.length - maxFiles} more files` : "";
  const named = [...(mentions?.files || []), ...(mentions?.tests || []).map((t) => `test "${t}"`)].slice(0, maxFiles);
  return [
    `Repository: ${repo}`,
    `Pull request: #${prNumber}, head ${String(sha).slice(0, 12)}`,
    `Failing CI job: ${job}`,
    ...(step ? [`Failed step: ${step}`] : []),
    "",
    `Diff summary: ${files.length} files changed, ${adds} insertions(+), ${dels} deletions(-)`,
    "Files changed by the pull request:",
    names.join("\n") + more,
    "",
    ...(named.length ? ["Changed files and added tests the failure's lines or stack frames name (by name: another file may share it):", ...named, ""] : []),
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
// download failures infrastructure reds print, Git LFS's included (its batch and smudge errors, also behind a tool's
// `task:` prefix).
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
  /(?:^|:\s)batch response: /,
  /^Error downloading object: /,
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
// a container job's `/__w/<repo>/<repo>/`, Windows' `D:\a\<repo>\<repo>\` (posix by now). What follows it is the
// repository-relative path.
// The runner's own directories under the workspace (actions' code, the tool cache) are never a checkout.
const SEG = "(?!_(?:actions|tool|temp)/)[^\\s'\"()<>:/]+";
const RUNNER_PREFIX = new RegExp(`(?:file://)?(?:/${PC}+?)?/_?work/${SEG}/${SEG}/|(?:file://)?/__w/${SEG}/${SEG}/|(?:file://)?/[A-Za-z]/a/${SEG}/${SEG}/`, "g");

/**
 * A line with the paths that differ from run to run folded, before anything is hashed: Windows paths made posix, temp
 * directories (with whatever is under them) replaced by `<tmp>`, the runner's checkout prefix dropped, bundle chunk
 * hashes (`main.3f9a2b1c.js`, `index-Bq3XmRtk.js` to `HASH`) and numbered chunks (`chunks/482.js`) and pytest's numbered
 * directories folded.
 */
export function foldPaths(line) {
  return String(line)
    .replace(WIN_PATH, (_, drive, tail) => `/${drive.toUpperCase()}${tail.replace(/\\/g, "/")}`)
    .replace(TEMP_PATH, "<tmp>")
    .replace(RUNNER_PREFIX, "")
    .replace(/([./-])(?:(?=[0-9a-f]*\d)[0-9a-f]{6,}|(?=[A-Za-z0-9_-]*(?:\d|[a-z][A-Za-z0-9_-]*[A-Z]|[A-Z][A-Za-z0-9_-]*[a-z]))[A-Za-z0-9_-]{8})(?=\.(?:[cm]?js|css|map)\b)/g, "$1HASH")
    .replace(/(^|[/.-])\d+(?=\.(?:[cm]?js|css|map)\b)/g, "$1N")
    .replace(/\bpytest-\d+\b/g, "pytest-N");
}

/** One failure line with run-to-run noise folded: paths (foldPaths), hashes, numbers (durations, counts, ports, line numbers). */
const fold = (l) => foldPaths(l).replace(/\b[0-9a-f]{7,}\b/gi, "#").replace(/\d+(?:\.\d+)?/g, "0").replace(/\s+/g, " ").trim();

// A dependency's or the runner's own directory: never the repository's file.
const DEPENDENCY = /(?:^|\/)(?:node_modules|site-packages|dist-packages|hostedtoolcache|_actions|_tool|go\/pkg\/mod)\//;

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
    if (DEPENDENCY.test(p) || /^(?:node:|internal\/)/.test(p)) continue;
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

/** The names a red could point at in the PR: changed paths, their file names (each with its paths), and tests its added lines name. */
export function changedNames(files) {
  const paths = new Set();
  const bases = new Map();
  const tests = new Set();
  for (const f of files || []) {
    for (const p of [f.filename, f.previous_filename].filter(Boolean)) {
      paths.add(p);
      const b = basename(p);
      if (b.length >= 4) bases.set(b, [...(bases.get(b) || []), p]);
    }
    for (const raw of String(f.patch || "").split("\n")) {
      if (!raw.startsWith("+")) continue;
      const m = /\b(?:test|it|describe|context|scenario)(?:\.\w+)?\s*\(\s*(["'`])(.{3,120}?)\1/.exec(raw) || /^\+\s*(?:async\s+)?def (test_\w+)/.exec(raw) || /^\+func (Test\w+)\(/.exec(raw);
      if (m) tests.add(m[2] ?? m[1]);
    }
  }
  return { paths, bases, tests };
}

// What delimits a whole path in a log line: whitespace, quotes, colons, commas, semicolons and brackets.
const PATH_DELIM = /[\s'"`:,;()<>[\]{}]+/;

/**
 * Whether a path token from a log is the changed path `p` itself: equal to it; an absolute path ending in `/p` (a
 * container's or Docker's checkout, `/app/p`); or a relative path with a directory in it that `p` ends with at a path
 * boundary (a run inside a subdirectory, `cd packages/web && vitest` printing `src/a.test.ts`). A bare file name, or a
 * relative path that only contains `p` (`media/p`), is not.
 */
const isPath = (t, p) => t === p || (t.startsWith("/") ? t.endsWith(`/${p}`) : t.includes("/") && p.endsWith(`/${t}`));

/**
 * The one exact sign the change caused a failure: a path the PR changes, named in full (isPath) by a whole token of its
 * failure lines or their stack frames (PATH_DELIM; Windows separators made `/`, the runner's checkout prefix dropped,
 * foldPaths), such as a stack frame's file or Git LFS's `Error downloading object: <path>`. Dependencies' paths
 * (DEPENDENCY) are not the repository's. Returns that changed path, or null.
 */
export function changedPathIn(sig, names) {
  for (const l of [...(sig?.lines || []), ...(sig?.context || [])]) {
    for (let t of foldPaths(String(l).replace(/\\/g, "/")).split(PATH_DELIM)) {
      t = t.replace(/^(?:file:)?\/{2,}(?=\/)/, "").replace(/^\.\//, "");
      if (!t || DEPENDENCY.test(t)) continue;
      for (const p of names.paths) if (isPath(t, p)) return p;
    }
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a failure's lines and stack frames mention of the PR, by name only: changed files (by path or by file name, a
 * name another file may share) and tests its added lines name. Input for the decision model, never a verdict.
 */
export function changeMentions(sig, names) {
  const files = new Set();
  const tests = new Set();
  for (const raw of [...(sig?.lines || []), ...(sig?.context || [])]) {
    const l = String(raw).replace(/\\/g, "/");
    for (const p of names.paths) if (l.includes(p)) files.add(p);
    for (const [b, paths] of names.bases) if (new RegExp(`(?:^|[\\s/\\\\(\`'"])${escapeRe(b)}(?:$|[\\s:)\`'"])`).test(l)) for (const p of paths) files.add(p);
    for (const t of names.tests) if (l.includes(t)) tests.add(t);
  }
  return { files: [...files], tests: [...tests] };
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

/** The first failed step of an Actions job that ran ({name, number, conclusion}, GitHub's `steps`), or null. */
export const failedStep = (job) => (Array.isArray(job?.steps) ? (job.steps.find((x) => x?.conclusion === "failure") ?? null) : null);

/**
 * The names GitHub gives the checkout steps (`uses: actions/checkout@…`) of the workflow job reporting `jobName`: the
 * step's `name`, else `Run <uses>`. `text` is the workflow file at the head; an unreadable one has none.
 */
export function checkoutSteps(text, jobName) {
  let doc;
  try {
    doc = parseYaml(String(text || ""));
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const [id, job] of Object.entries(doc?.jobs || {})) {
    if (!reports(typeof job?.name === "string" ? job.name : id, jobName) || !Array.isArray(job?.steps)) continue;
    for (const st of job.steps) {
      const uses = typeof st?.uses === "string" ? st.uses.trim() : "";
      if (/^actions\/checkout@/.test(uses)) out.add(typeof st.name === "string" ? st.name : `Run ${uses}`);
    }
  }
  return out;
}

/**
 * Whether a job that ran failed only where no code of the change runs: "set-up" when its first failed step is GitHub's
 * own first step (Set up job), "checkout" when it is a checkout step of its workflow (checkoutSteps, `workflow` the file
 * at the head), and every other failed step is one of those too; else null (a `run:` step or anything else failed).
 * Structure only: step numbers, conclusions and the workflow's `uses`, never the log.
 */
export function setupFailure(job, workflow = null) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const failed = steps.filter((x) => x?.conclusion === "failure");
  if (!failed.length) return null;
  let checkout = null;
  const kind = (x) => (x.number === 1 ? "set-up" : (checkout ??= checkoutSteps(workflow, job.name)).has(x.name) ? "checkout" : null);
  // Every step that did not pass or skip (a later step cancelled after a `continue-on-error` checkout included) must
  // be the set-up or a checkout.
  return steps.filter((x) => !["success", "skipped"].includes(x?.conclusion)).every(kind) ? kind(failed[0]) : null;
}

// What only the log says: whether the failed step's far side failed or could not be reached (an HTTP 5xx, a timeout,
// a connection error), or the request itself was refused or names what is missing (a 4xx, an object that does not
// exist, an invalid path, a submodule or .gitattributes problem: the change's or the repository's, never an outage).
// The one place these words decide anything; serverSide reads only the failed step's lines.
const SERVER_SIDE = [
  /\bHTTP(?:\/[\d.]+)? 5\d\d\b/i,
  /\[5\d\d\]/,
  /\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /\bstatus(?: code)?:? 5\d\d\b/i,
  /\btimed out\b|\bTimeout exceeded\b/i,
  /\bE(?:TIMEDOUT|CONNRESET|CONNREFUSED|AI_AGAIN)\b/,
  /\bCould not resolve host\b/i,
  /\bconnection (?:reset|refused|timed out)\b/i,
  /\bearly EOF\b|\bRPC failed\b|\bunexpected disconnect\b/i,
];
const CLIENT_SIDE = [
  /\bHTTP(?:\/[\d.]+)? 4\d\d\b/i,
  /\[4\d\d\]/,
  /\b4\d\d (?:Bad Request|Unauthorized|Forbidden|Not Found)\b/i,
  /\bstatus(?: code)?:? 4\d\d\b/i,
  /\bdoes not exist\b/i,
  /\bnot found\b/i,
  /\binvalid path\b/i,
  /\bsubmodule\b/i,
  /\.gitattributes\b/,
];

/** Whether a job log's failed step (failingStep) says a server or network failure and nothing of a refused or missing request. */
export function serverSide(text) {
  const lines = failingStep(cleanLog(text).split("\n").map((l) => l.trim()).filter(Boolean));
  return lines.some((l) => SERVER_SIDE.some((re) => re.test(l))) && !lines.some((l) => CLIENT_SIDE.some((re) => re.test(l)));
}

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

/** A workflow run's conclusions that end it before its jobs run: GitHub could not start it, or it was cancelled. */
export const ENDED_EARLY = ["startup_failure", "cancelled"];
/** A workflow run or check run GitHub has created but not started. `waiting` is not one: it waits for an approval. */
const UNSTARTED = ["queued", "requested", "pending"];
/** The newest check run of `name` among `checkRuns`. */
const latestRun = (checkRuns, name) => (checkRuns || []).filter((r) => r.name === name).sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")) || (b.id ?? 0) - (a.id ?? 0))[0];
/** A template's literal parts, escaped for a RegExp. */
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The check names a workflow file's jobs report, as templates (`${{ … }}` stands for any text): a job's `name`, else
 * its id; a job that calls a reusable workflow reports `<caller> / <callee's job>`, the callee read with `readLocal`
 * (a path in this repository at the head) and, for one in another repository, any name under the caller. Returns
 * {checks, filters}: `filters` the `paths` or `paths-ignore` of its `pull_request` trigger, else null.
 */
export async function workflowChecks(text, readLocal = async () => "", depth = 0) {
  let doc;
  try {
    doc = parseYaml(String(text || ""));
  } catch {
    return { checks: [], filters: null, chained: false };
  }
  const checks = [];
  // A reusable workflow called here that could not be read (`readLocal` gave null) may run anything: `chained`.
  let unread = false;
  for (const [id, job] of Object.entries(doc?.jobs || {})) {
    const own = typeof job?.name === "string" ? job.name : id;
    const uses = typeof job?.uses === "string" ? job.uses.trim() : "";
    if (!uses) checks.push(own);
    else if (uses.startsWith("./") && depth < 3) {
      const text = await readLocal(uses.slice(2).replace(/@.*$/, "")).catch(() => null);
      const called = await workflowChecks(text, readLocal, depth + 1);
      unread ||= text === null || called.chained;
      for (const c of called.checks) checks.push(`${own} / ${c}`);
    }
    else checks.push(`${own} / \${{ callee }}`);
  }
  const on = doc?.on && typeof doc.on === "object" && !Array.isArray(doc.on) ? doc.on : null;
  const pr = on?.pull_request;
  const key = pr && typeof pr === "object" ? ["paths", "paths-ignore"].find((k) => Array.isArray(pr[k])) : null;
  // The filter decides alone only when pull_request is the one trigger that can start the workflow on the head:
  // another (push, pull_request_target, workflow_dispatch…) may run it anyway (`sole` false).
  const sole = !!on && Object.keys(on).every((t) => t === "pull_request" || NOT_ON_HEAD.includes(t));
  // `chained`: it runs on another workflow's run (`on: workflow_run`), so after the head's other runs completed.
  const triggers = typeof doc?.on === "string" ? [doc.on] : Array.isArray(doc?.on) ? doc.on : Object.keys(on || {});
  return { checks, filters: key ? { key: `on.pull_request.${key}`, ignore: key === "paths-ignore", patterns: pr[key].map(String), sole } : null, chained: triggers.includes("workflow_run") || unread };
}
/** Whether a check name `name` is one the template `check` reports (a matrix job adds ` (…)`). */
export const reports = (check, name) => new RegExp(`^${String(check).split(/\$\{\{[\s\S]*?\}\}/).map(esc).join(".+")}(?: \\(.+\\))?$`).test(name);

// ------------------------------------------------------------------ what a workflow file says about its failing jobs

/** A matrix value GitHub shows in a leg's name: a string, a number or a boolean (the YAML reader keeps each as its text). */
const shownValue = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A job's matrix legs as GitHub makes them: the product of its keys' lists, less each `exclude`, then each `include`
 * added to every leg of that product whose own values it does not change (a value an earlier include added may be
 * overwritten), or as a leg of its own when it fits none; a leg an include made never takes a later include. Each leg
 * is {values, own}: `own` the keys the product gave it. Null when the matrix is not lists (an expression, a non-list value).
 */
export function matrixLegs(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return null;
  const keys = Object.keys(matrix).filter((k) => k !== "include" && k !== "exclude");
  if (keys.some((k) => !Array.isArray(matrix[k]))) return null;
  let legs = keys.length ? [{}] : [];
  for (const k of keys) legs = legs.flatMap((l) => matrix[k].map((v) => ({ ...l, [k]: v })));
  const exclude = Array.isArray(matrix.exclude) ? matrix.exclude.filter((e) => e && typeof e === "object") : [];
  const product = legs.filter((l) => !exclude.some((e) => Object.entries(e).every(([k, v]) => sameValue(l[k], v)))).map((values) => ({ values, own: Object.keys(values) }));
  const added = [];
  for (const inc of Array.isArray(matrix.include) ? matrix.include : []) {
    if (!inc || typeof inc !== "object" || Array.isArray(inc)) return null;
    const fits = product.filter((l) => Object.entries(inc).every(([k, v]) => !l.own.includes(k) || sameValue(l.values[k], v)));
    for (const l of fits) Object.assign(l.values, inc);
    if (!fits.length) added.push({ values: { ...inc }, own: Object.keys(inc) });
  }
  return [...product, ...added];
}

/**
 * The matrix values of the leg a check run named `name` reports, for the job whose check name is `own`. A plain name
 * gets ` (<the leg's values, comma separated>)` added; a name with `${{ }}` in it is each leg's name with them
 * evaluated over its values (matrixExpression), as GitHub shows it, with or without that suffix. Null unless exactly
 * one leg matches (its values shown all, or the ones the product gave it), or the job has no matrix and the name is
 * `own` ({}).
 */
export function legValues(job, own, name) {
  const matrix = job?.strategy?.matrix;
  const templated = /\$\{\{[\s\S]*?\}\}/.test(own);
  if ((matrix === undefined || matrix === null) && !templated) return name === own ? {} : null;
  const legs = matrix === undefined || matrix === null ? [{ values: {}, own: [] }] : matrixLegs(matrix) || [];
  const shown = (vals) => (vals.every(shownValue) ? vals.map(String).join(", ") : null);
  const suffixes = (l) => [shown(Object.values(l.values)), shown(l.own.map((k) => l.values[k]))].filter((x) => x !== null).map((x) => ` (${x})`);
  const hits = legs.filter((l) => {
    const base = templated ? expandName(own, l.values) : own;
    return base !== null && [...(templated ? [""] : []), ...suffixes(l)].some((x) => `${base}${x}` === name);
  });
  return hits.length === 1 ? hits[0].values : null;
}

/** A job name template with each `${{ }}` evaluated over one leg's `matrix` (matrixExpression); null when any cannot be. */
function expandName(template, matrix) {
  let ok = true;
  const out = template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, src) => {
    const v = matrixExpression(src, matrix);
    if (v === null) ok = false;
    return v === null ? "" : v.coerceString();
  });
  return ok ? out : null;
}

/**
 * One `${{ }}` expression's value over a leg's `matrix` context, with GitHub's own expression library: only one of at
 * most EXPRESSION_CAP characters made of literals, `matrix` lookups, comparisons and logic (plainExpression). Null
 * when it is anything else or does not evaluate.
 */
function matrixExpression(src, matrix) {
  if (!matrix || src.length > EXPRESSION_CAP) return null;
  try {
    const expr = new Parser(new Lexer(src).lex().tokens, ["matrix"], []).parse();
    if (!plainExpression(expr)) return null;
    return new Evaluator(expr, JSON.parse(JSON.stringify({ matrix }), exprData.reviver)).evaluate();
  } catch {
    return null;
  }
}

export function continueOnError(job, matrix) {
  const v = job?.["continue-on-error"];
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim();
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  const value = m ? matrixExpression(m[1], matrix) : null;
  return value === null ? null : !falsy(value);
}

/** The longest `continue-on-error` expression evaluated; a longer one is unknown. */
export const EXPRESSION_CAP = 1024;

/**
 * Whether a parsed expression is only literals, `matrix` lookups, comparisons and logic: the bounded part of the
 * language a leg's `continue-on-error` needs. A function call (`format`, `fromJSON`…), whose cost has no bound, or
 * anything else is not evaluated.
 */
function plainExpression(n) {
  if (n instanceof Literal || n instanceof ContextAccess) return true;
  if (n instanceof Unary) return plainExpression(n.expr);
  if (n instanceof Binary) return plainExpression(n.left) && plainExpression(n.right);
  if (n instanceof Logical) return n.args.every(plainExpression);
  if (n instanceof Grouping) return plainExpression(n.group);
  if (n instanceof IndexAccess) return plainExpression(n.expr) && plainExpression(n.index);
  return false;
}

/**
 * What a workflow file (`text`, the one a run of failing jobs came from) says about those jobs, on structure only:
 * `coe` (by check-run id) whether each run's job may fail without failing the run (continueOnError: true, false or
 * null), and `needs` (by check-run id) the names of the failing runs whose jobs each run's job `needs`, directly or
 * through jobs it needs (a job between them may have been skipped), or null when its job is not found. A run's job is
 * the one job whose check name reports it (reports); a run `<caller> / …` is the job that calls a reusable workflow,
 * whose own `continue-on-error` is not read here (null). Nothing (empty maps) when the file does not parse.
 */
export function workflowJobs(text, runs) {
  const coe = new Map();
  const needs = new Map();
  let doc;
  try {
    doc = parseYaml(String(text || ""), { typed: true });
  } catch {
    return { coe, needs };
  }
  const jobs = Object.entries(doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {}).filter(([, j]) => j && typeof j === "object");
  const own = (id, j) => (typeof j.name === "string" || typeof j.name === "number" ? String(j.name) : id);
  const called = (j) => typeof j.uses === "string" && !!j.uses.trim();
  // A caller's runs are named `<caller> / <the called workflow's job>` (workflowChecks).
  const jobOf = (name) => {
    const hits = jobs.filter(([id, j]) => reports(called(j) ? `${own(id, j)} / \${{ callee }}` : own(id, j), name));
    return hits.length === 1 ? hits[0] : null;
  };
  const needsOf = (j) => (Array.isArray(j?.needs) ? j.needs : j?.needs ? [j.needs] : []).map(String);
  const byId = new Map(jobs);
  // Every job a job needs, directly or through others: a roll-up red because a job it needs was skipped after its own
  // need failed is red because of that failure.
  const closure = (id) => {
    const seen = new Set();
    const stack = needsOf(byId.get(id));
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n) || !byId.has(n)) continue;
      seen.add(n);
      stack.push(...needsOf(byId.get(n)));
    }
    return seen;
  };
  const found = new Map((runs || []).map((r) => [r.id, jobOf(r.name)]));
  for (const r of runs || []) {
    const hit = found.get(r.id);
    if (!hit) {
      coe.set(r.id, null);
      needs.set(r.id, null);
      continue;
    }
    const [id, job] = hit;
    coe.set(r.id, called(job) ? null : continueOnError(job, legValues(job, own(id, job), r.name)));
    const wants = closure(id);
    needs.set(r.id, (runs || []).filter((o) => o !== r && wants.has(found.get(o.id)?.[0])).map((o) => o.name));
  }
  return { coe, needs };
}

/** Triggers that never start a workflow on a PR's head commit: they run on the queue's, the default branch's or a tag's. */
const NOT_ON_HEAD = ["merge_group", "schedule", "workflow_call", "workflow_run", "release"];
/**
 * A GitHub path filter pattern as a RegExp: `**` any path, `*` within one segment. Only those: a pattern with GitHub's
 * other operators (`?` and `+` repeat the character before, `[…]` a set) is not read here (filterSkips: unknown).
 */
const globRe = (p) => new RegExp(`^${p.replace(/\*\*\/?|\*|[.^${}()|\\]/g, (m) => (m.startsWith("**") ? ".*" : m === "*" ? "[^/]*" : `\\${m}`))}$`);
const OTHER_OPERATORS = /[?+[\]]/;
/**
 * Whether a `pull_request` path filter skips a change that touches `files`: `paths` runs when a file matches (patterns in
 * order, a `!` one excluding again), `paths-ignore` runs unless every file matches. Null (unknown) unless that is
 * certain: pull_request is the workflow's only trigger on the head (`sole`), the files are read and not empty, and every
 * pattern uses only `*`, `**` and `!`.
 */
export function filterSkips(filters, files) {
  // Unknown (null), never a skip: no filter, another trigger, no changed files read, or an operator not read here.
  if (!filters || !filters.sole || !Array.isArray(files) || !files.length || filters.patterns.some((p) => OTHER_OPERATORS.test(p.replace(/^!/, "")))) return null;
  const match = (f) => {
    let hit = false;
    for (const p of filters.patterns) {
      if (p.startsWith("!")) {
        if (globRe(p.slice(1)).test(f)) hit = false;
      } else if (globRe(p).test(f)) hit = true;
    }
    return hit;
  };
  return filters.ignore ? files.every(match) : !files.some(match);
}

/**
 * What checksNotStarted reads, on structure: the head's workflow runs; the Actions job of each required check run not
 * started yet (whether a runner took it); and, for a required check with no check run on the head, the workflows that
 * produce it (`producers`: name → workflow ids): a workflow of the repository (or one that ran on the head) whose file
 * at the head has a job reporting that name (workflowChecks), else the workflow of that check's run on an older commit
 * (`history()`: commit ids, newest first, read only when needed), found through its check suite. `skips`: workflow id
 * → its path filter and whether it skips this change (`files()`: the PR's changed paths). `chained`: a workflow at the
 * head runs `on: workflow_run`, or one could not be read, so a check may come after every run listed completed. `workflowRuns` null: they
 * could not be read (`readError`).
 */
export async function checkSources({ repo, sha, names, checkRuns = [], token, actionsToken = token, history = async () => [], files = async () => null, cache = new Map() }) {
  const actions = { token: actionsToken };
  let workflowRuns;
  try {
    workflowRuns = (await rest(`repos/${repo.full}/actions/runs?head_sha=${sha}&per_page=100`, actions))?.workflow_runs || [];
  } catch (e) {
    return { workflowRuns: null, readError: String(e?.status || "error"), jobs: new Map(), producers: new Map(), skips: new Map() };
  }
  const jobs = new Map();
  for (const n of names) {
    const r = latestRun(checkRuns, n);
    if (r && UNSTARTED.includes(r.status) && (!r.app || r.app === ACTIONS_APP)) jobs.set(r.id, await rest(`repos/${repo.full}/actions/jobs/${r.id}`, actions).catch(() => null));
  }
  const producers = new Map();
  const skips = new Map();
  const posted = new Set();
  let chained = false;
  const add = (n, id) => producers.set(n, new Set([...(producers.get(n) || []), id]));
  const missing = names.filter((n) => !latestRun(checkRuns, n));
  if (missing.length) {
    // A workflow file at the head is read once per stage (`cache`, the caller's), however often the wait is classified.
    const read = (path) => {
      const key = `${sha}:${path}`;
      if (!cache.has(key)) cache.set(key, rest(`repos/${repo.full}/contents/${path}?ref=${sha}`, { token, raw: "Accept: application/vnd.github.raw+json" }).then(String, () => null));
      return cache.get(key);
    };
    // Every workflow of the repository, a path-filtered one that never ran on the head included, and those that ran.
    const listed = ((await rest(`repos/${repo.full}/actions/workflows?per_page=100`, actions).catch(() => null))?.workflows || []).filter((w) => w.state === "active").map((w) => ({ id: w.id, path: w.path }));
    const all = new Map([...listed, ...workflowRuns.map((w) => ({ id: w.workflow_id, path: w.path }))].filter((w) => w.id && w.path).map((w) => [w.id, String(w.path).replace(/@.*$/, "")]));
    let changed;
    for (const [id, path] of all) {
      if (/(^|\/)factory\.ya?ml$/.test(path)) continue;
      const text = await read(path);
      const { checks, filters, chained: after } = await workflowChecks(text, read);
      // A file that could not be read may run `on: workflow_run`: that is never read as no such workflow.
      chained ||= after || text === null;
      const its = missing.filter((n) => checks.some((c) => reports(c, n)));
      for (const n of its) add(n, id);
      // Every producer is recorded, filtered or not: a check is filtered out only when each of them skips the change.
      if (its.length) {
        if (filters) changed ??= await files().catch(() => null);
        skips.set(id, filters ? { key: filters.key, skips: filterSkips(filters, changed) } : { key: null, skips: false });
      }
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
    // Still none: an older commit's commit status of that name (a service posting statuses, Codecov's say) is its
    // producer, which posts it on this head when it does (`posted`). Each older commit's statuses are read once.
    const statusesOf = new Map();
    for (const n of left.filter((x) => !producers.has(x))) {
      for (const c of older) {
        if (!statusesOf.has(c)) statusesOf.set(c, rest(`repos/${repo.full}/commits/${c}/status`, { token }).then((st) => new Set((st?.statuses || []).map((x) => x?.context)), () => new Set()));
        if ((await statusesOf.get(c)).has(n)) {
          posted.add(n);
          break;
        }
      }
    }
  }
  return { workflowRuns, readError: "", jobs, producers, skips, chained, posted };
}

/** GitHub Actions' own app: a check run from any other app is that service's, not Actions'. */
const ACTIONS_APP = "github-actions";

/**
 * Why a wait on the required checks ended with none failed and some not finished (awaitChecks `timedOut` with no
 * completed failing run), from checkSources's reads. Returns {waits, kind, reason, runs}. `waits` (kind `not-started`):
 * a required check not started yet, which no change can fix, each tied to that check: its check run still queued with
 * no runner (in a workflow run still going, or one that completed: #72's two shapes), or, with no check run, the
 * workflow that produces it queued on the head, or never created (as when the head has no workflow run at all). The
 * reason names who has not started it: GitHub, a run `pending` behind the repository's own concurrency group, or the
 * service whose app owns the check run. Kinds that do not wait: `running` (a check still running), `approval` (a
 * deployment approval), `filtered` (its workflow's path filter skips this change), `ended` (every workflow run on the
 * head that produces it ended `startup_failure`, or `cancelled` with no check run in its suite), `unreported` (no workflow on the head
 * produces it: a wrong check name) and `unread`. A required check with no run that older commits got as a commit
 * status (`posted`) is not started yet, by the service posting it. A queued run of another workflow is not this check's. `now` and
 * `waitedMin` only word the reason.
 */
export function checksNotStarted({ sha, names = [], checkRuns = [], workflowRuns = null, jobs = new Map(), producers = new Map(), skips = new Map(), posted = new Set(), waitedMin = 0, readError = "", now = Date.now() }) {
  const short = String(sha).slice(0, 7);
  const list = (xs) => xs.join(", ");
  const mins = (t) => (Number.isFinite(Date.parse(t)) ? Math.max(0, Math.round((now - Date.parse(t)) / 60000)) : null);
  const label = (w) => `${w.name || "workflow"} (run ${w.id})`;
  const held = (w) => `workflow run ${label(w)} pending ${mins(w.created_at) ?? "?"} min behind its concurrency group (the repository's own workflow setting)`;
  const open = names.filter((n) => latestRun(checkRuns, n)?.status !== "completed");
  if (!Array.isArray(workflowRuns)) return { waits: false, kind: "unread", runs: [], reason: `required check(s) ${list(open)} not finished on ${short} after ${waitedMin} min, and its workflow runs could not be read${readError ? ` (${readError})` : ""}; no failing run to fix` };
  const bySuite = new Map(workflowRuns.map((w) => [w.check_suite_id, w]));
  const started = [];
  const approval = [];
  const running = [];
  const unreported = [];
  const filtered = [];
  const ended = [];
  // A run that ended before its jobs ran: GitHub could not start it, or it was cancelled with no check run in its suite.
  const early = (w) => w.status === "completed" && (w.conclusion === "startup_failure" || (w.conclusion === "cancelled" && !checkRuns.some((r) => (r.check_suite?.id ?? r.suite) === w.check_suite_id)));
  for (const n of open) {
    const r = latestRun(checkRuns, n);
    if (r) {
      const w = bySuite.get(r.check_suite?.id ?? r.suite) || null;
      const job = jobs.get(r.id);
      if (r.status === "waiting") approval.push(n);
      else if (r.app && r.app !== ACTIONS_APP && UNSTARTED.includes(r.status)) started.push({ n, w: null, by: r.app, text: `${n} ${r.status} at ${r.app}, which has not started it` });
      else if (UNSTARTED.includes(r.status) && !job?.runner_id && !job?.runner_name) {
        if (w?.status === "pending" || r.status === "pending") started.push({ n, w, by: "concurrency", text: w ? held(w) : `${n} pending behind its concurrency group (the repository's own workflow setting)` });
        else started.push({ n, w, text: `${n} queued ${!w ? "with no runner" : w.status === "completed" ? `after its workflow run ${label(w)} completed${mins(w.updated_at) === null ? "" : ` ${mins(w.updated_at)} min ago`}` : `with no runner in workflow run ${label(w)}`}` });
      } else running.push({ n, w });
      continue;
    }
    // A commit status earlier commits got (`posted`): its service has not posted it here yet.
    if (posted.has(n)) {
      started.push({ n, w: null, by: "the service posting it", text: `${n} is a commit status earlier commits got, not posted on this head yet` });
      continue;
    }
    const ids = producers.get(n);
    const mine = ids ? workflowRuns.filter((w) => ids.has(w.workflow_id)) : [];
    const queued = mine.filter((w) => UNSTARTED.includes(w.status));
    // Filtered out only when every workflow that produces it skips this change for certain; a filter that may, a hint.
    const filters = ids ? [...ids].map((id) => skips.get(id)) : [];
    const allSkip = filters.length > 0 && filters.every((f) => f?.skips === true);
    const filter = allSkip ? filters[0] : filters.find((f) => f?.key && f.skips !== false) || null;
    if (queued.length) started.push({ n, w: queued[0], ...(queued[0].status === "pending" ? { by: "concurrency", text: held(queued[0]) } : { text: `workflow run ${label(queued[0])} queued ${mins(queued[0].created_at) ?? "?"} min with no job started` }) });
    else if (mine.some((w) => w.status === "waiting")) approval.push(n);
    else if (mine.some((w) => w.status !== "completed")) running.push({ n, w: mine.find((w) => w.status !== "completed") });
    else if (ids && !mine.length && allSkip) filtered.push({ n, key: filter.key });
    else if (mine.length && mine.every(early)) ended.push({ n, w: mine[0] });
    else if ((ids && !mine.length) || !workflowRuns.length) started.push({ n, w: null, text: `no workflow run for it was created in ${waitedMin} min${filter ? ` (its workflow's path filter, ${filter.key}, may skip this change)` : ""}` });
    else unreported.push(n);
  }
  // Its workflow run ended before the job that reports it existed: that run's conclusion, never the check's name, is why.
  if (ended.length) {
    const runs = [...new Set(ended.map((x) => x.w))];
    // GitHub could not start a run: most often the workflow file on the default branch, the repository's (setup). A
    // cancellation may be the repository's own concurrency setting: the work's.
    return { waits: false, kind: "ended", cause: runs.some((w) => w.conclusion === "startup_failure") ? "setup" : "work", runs, reason: `required check(s) ${list(ended.map((x) => x.n))} never reported on ${short}: ${list(runs.map((w) => `workflow run ${label(w)} ended ${w.conclusion}`))} before ${ended.length > 1 ? "their jobs" : "its job"} ran${runs.some((w) => w.conclusion === "startup_failure") ? " (GitHub could not start the workflow: its file or GitHub's side, as the run's page says)" : ""}; rerun it on GitHub or fix the workflow, then re-apply the label; no failing run to fix` };
  }
  if (unreported.length) return { waits: false, kind: "unreported", runs: [], reason: `required check(s) ${list(unreported)} never reported on ${short}: no workflow run on it produces ${unreported.length > 1 ? "them" : "it"} (${list(workflowRuns.slice(0, 3).map((w) => `${label(w)} ${w.status === "completed" ? `completed ${w.conclusion}` : w.status}`))}${workflowRuns.length > 3 ? `, ${workflowRuns.length - 3} more` : ""}); check the required check names; no failing run to fix` };
  if (filtered.length) return { waits: false, kind: "filtered", runs: [], reason: `required check(s) ${list(filtered.map((x) => x.n))} never run on ${short}: ${list([...new Set(filtered.map((x) => x.key))])} of ${filtered.length > 1 ? "their workflows skips" : "its workflow skips"} this change, so GitHub starts no run for it; run the check on every change, or stop requiring it; no failing run to fix` };
  if (approval.length) return { waits: false, kind: "approval", runs: [], reason: `required check(s) ${list(approval)} on ${short} wait for a deployment approval; approve ${approval.length > 1 ? "them" : "it"}, then re-apply the label; no failing run to fix` };
  if (started.length) {
    // Who has not started them: GitHub, the service whose app owns the check, or the repository's own concurrency group.
    const who = [...new Set(started.map((x) => x.by || "GitHub"))];
    const checksText = `the required check(s) ${list(started.map((x) => x.n))} on ${short}`;
    const head = who.length > 1 ? `${checksText[0].toUpperCase()}${checksText.slice(1)} have not started` : who[0] === "GitHub" ? `GitHub has not started ${checksText}` : who[0] === "concurrency" ? `The repository's concurrency group holds ${checksText}` : `${who[0]} has not started ${checksText}`;
    const infra = who.every((x) => x === "concurrency") ? "not this change" : "infrastructure, not this change";
    return { waits: true, kind: "not-started", runs: started.map((x) => x.w).filter(Boolean), reason: `${head}: ${started.map((x) => x.text).join("; ")} (${infra})` };
  }
  return { waits: false, kind: "running", runs: running.map((x) => x.w).filter(Boolean), reason: `required check(s) ${list(open)} not finished on ${short} after ${waitedMin} min: ${list([...new Set(running.map((x) => (x.w ? label(x.w) : x.n)))])} still in progress; no failing run to fix` };
}

/**
 * The Block reason's part for a red whose triage read every failing job as a flake or infrastructure and whose rerun
 * GitHub refused (`refusal`, from red()): triage's verdicts, the refusal, and what a person does about it; `unchanged`, the rerun of a head a fix
 * pass left unchanged (again()), names no verdict; `earlier`, a refusal recorded before on the Objective. A 403 is the
 * token's missing Actions write: locally the repository token's, on Actions the workflow's `actions: write`.
 */
export function refusedRerunText(refusal) {
  const jobs = (refusal?.jobs || []).map((j) => `${j.name}: ${j.verdict ?? "no verdict"}${typeof j.confidence === "number" ? ` ${j.confidence.toFixed(2)}` : ""}`).join(", ");
  const status = refusal?.status ? String(refusal.status) : "error";
  const why = refusal?.earlier ? "a rerun was refused earlier on this Objective" : refusal?.permission ? `${status}: the token cannot rerun jobs` : refusal?.rateLimited ? `${status}: rate limited` : status;
  const grant = refusal?.where === "actions" ? "give the workflow's work and review jobs `actions: write`" : "give the token Actions read and write";
  const what = refusal?.unchanged ? "GitHub refused the rerun of the failed jobs" : `red-check triage read it as a flake or infrastructure (${jobs}), but GitHub refused the rerun`;
  return `${what} (${why}); rerun the failed jobs on GitHub${refusal?.permission || refusal?.earlier ? `, or ${grant},` : ""} then re-apply the label`;
}

/** The progress line for one triage: each job's verdict, confidence and signature, then what Factory does. */
export function triageLine({ sha, model, jobs, outcome }) {
  const each = jobs.map((j) => {
    const sig = j.sig.id ? `${j.sig.id}${j.repeat ? ", seen before" : ""}${j.sig.line ? ` \`${j.sig.line.replace(/`/g, "'")}\`` : ""}` : "no failure line found";
    if (j.infra) return `${j.name}: failed in its ${j.infra} step (${j.step}), no model asked [${sig}]`;
    return `${j.name}: ${j.verdict ?? `no verdict (${j.error || "?"})`}${typeof j.confidence === "number" ? ` ${j.confidence.toFixed(2)}` : ""} [${sig}]`;
  });
  return `triage of the red on ${String(sha).slice(0, 7)} (${model}): ${each.join("; ")} → ${outcome}`;
}

/**
 * Triage. `token` reads the issue and the PR; `actionsToken` reads the jobs and reruns them: on Actions the job token
 * (workflow-template.yml gives the work and review jobs actions: write), locally the repository token (Actions: read
 * and write). `progress` is the run's progressReporter. `red({sha, failedRuns, required, until})` returns {rerun,
 * ignoreIds, jobs}; `until` (ms) bounds its wait for a workflow run still in progress, which must complete before its
 * failed jobs can be rerun. The model is the decider's (decider.mjs openDecider): the AI Gateway's `triage_model` with a
 * key, else the stage's own harness (`stage`: its harness, model, env and usage record) on its login. With neither
 * (`off` is the key's code why) every red goes to the fix pass, and the first says so, once per stage.
 * `again({sha, failedRuns, until})`, with or without a key: the failed jobs rerun once on a head a fix pass left
 * unchanged, no model asked, unless the red reads as the change's (session.mjs validationLoop); returns {rerun,
 * ignoreIds} or why not ({already}, {refused}, {skipped}).
 * `infra({sha, failedRuns})`: whether every failed job failed on GitHub's side (set-up or checkout, a server or network
 * failure, naming nothing the PR changes).
 */
export function openTriage({ inputs, env = process.env, home = homedir(), repo, issue, prNumber, token, actionsToken = token, progress = null, stage = null, decider = null }) {
  const ask = openDecider({ inputs, env, home, model: inputs?.triageModel || TRIAGE_MODEL, stage, decider });
  const { model, off: code } = ask;
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
  const known = async () => {
    if (!earlier) {
      // Factory's own login first: only its own progress comments' records count (triageOf).
      await progress?.self?.().catch(() => null);
      earlier = triageOf(await listComments(repo, issue, opts).catch(() => []), { issue });
    }
    return mergeTriage(earlier, mine);
  };
  // Each failing check run's Actions job, or the name of the first that is none (only an Actions job can be rerun).
  const actionsJobs = async (failedRuns) => {
    const jobs = new Map();
    for (const r of failedRuns) {
      const job = await rest(`repos/${repo.full}/actions/jobs/${r.id}`, actions).catch(() => null);
      if (!job?.run_id) return { notActions: r.name, jobs };
      jobs.set(r.id, job);
    }
    return { jobs };
  };
  // The failed jobs of each workflow run rerun once. Returns null when rerun, else the refusal (recorded) or the run not
  // completed (its line for the caller to record). `outcome(why)` words the line. `until` (ms): how long the caller's
  // checks wait and its stage's wall clock allow.
  const rerunRuns = async (runIds, outcome, until) => {
    // Rerun-failed-jobs needs each workflow run completed: one still going is waited for while it runs, up to `until`.
    for (const id of runIds) if (!(await waitRunCompleted(repo, id, { ...actions, until }))) return { incomplete: id, line: outcome(`workflow run ${id} did not complete`) };
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
        await record(outcome(`the rerun was refused: ${e.status || "error"}${why}`), refused ? { refused: true } : {});
        return { refusal: { status: e.status || null, permission: refused && e.status === 403, rateLimited: !!e.rateLimited, where: env.GITHUB_ACTIONS ? "actions" : "local" } };
      }
    }
    return null;
  };
  // A job's workflow file at the head, read once per workflow run: what tells its checkout steps apart (setupFailure).
  const workflows = new Map();
  const workflowOf = (sha, job) => {
    if (!workflows.has(job.run_id)) {
      workflows.set(
        job.run_id,
        rest(`repos/${repo.full}/actions/runs/${job.run_id}`, actions)
          .then((run) => (run?.path ? rest(`repos/${repo.full}/contents/${String(run.path).replace(/@.*$/, "")}?ref=${sha}`, { token, raw: "Accept: application/vnd.github.raw+json" }) : ""))
          .then(String, () => ""),
      );
    }
    return workflows.get(job.run_id);
  };

  // This process's triage answers by head (red()), so again() never reruns a red the model read as the change's.
  const asked = new Map();
  // The failing jobs' logs and signatures and what the PR changes (job logs are read once per job: github.mjs jobLog).
  const readRed = async (failedRuns) => {
    const files = (await rest(`repos/${repo.full}/pulls/${prNumber}/files?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
    const texts = new Map(await Promise.all(failedRuns.map(async (r) => [r.id, await jobLog(repo, r.id, actions).catch(() => "")])));
    return { files, names: changedNames(files), texts, sigs: new Map(failedRuns.map((r) => [r.id, failureSignature(r.name, texts.get(r.id))])) };
  };
  // A job that failed on GitHub's side: only in its set-up or checkout (setupFailure), its failed step saying a server
  // or network failure (serverSide), and its failure pointing at no file the PR changes (changedPathIn). Returns the
  // kind, or null.
  const githubSide = async (sha, job, text, sig, names) => {
    const step = failedStep(job);
    if (!step || !serverSide(text) || changedPathIn(sig, names)) return null;
    return setupFailure(job, step.number === 1 ? null : await workflowOf(sha, job));
  };

  const offRed = async ({ failedRuns = [] } = {}) => {
    if (!failedRuns.length || offSaid) return { rerun: false };
    offSaid = true;
    const line = `triage: off (${code}); fix pass`;
    log(line);
    if (progress) await progress(line);
    return { rerun: false };
  };

  const red = async ({ sha, failedRuns = [], required = [], until = 0 }) => {
    const no = { rerun: false };
    if (!failedRuns.length) return no;
    const seen = await known();
    if (seen.refused) {
      await record(`triage: a rerun was refused earlier on this Objective (the token cannot rerun jobs: it needs Actions read and write); fix pass`, {});
      return no;
    }
    if (seen.reruns.has(sha)) {
      await record(`triage: the failed jobs on ${sha.slice(0, 7)} were already rerun once; fix pass`, {});
      return no;
    }
    if (failedRuns.length > MAX_JOBS) {
      await record(`triage: ${failedRuns.length} failing jobs on ${sha.slice(0, 7)}, more than ${MAX_JOBS}; fix pass`, {});
      return no;
    }
    const { notActions, jobs: actionsJob } = await actionsJobs(failedRuns);
    if (notActions) {
      await record(`triage: ${notActions} is not an Actions job, so it cannot be rerun; fix pass`, {});
      return no;
    }
    const runIds = new Set([...actionsJob.values()].map((j) => j.run_id));
    const jobs = await askJobs({ sha, failedRuns, required, seen, actionsJob });
    asked.set(sha, jobs);
    if (!rerunWanted(jobs)) {
      await record(triageLine({ sha, model, jobs, outcome: "fix pass" }), {});
      return no;
    }
    const failed = await rerunRuns(runIds, (why) => triageLine({ sha, model, jobs, outcome: `fix pass (${why})` }), until);
    if (failed?.line) await record(failed.line, {});
    // What the Block says when this red is the last (session.mjs validationLoop, refusedRerunText): every job's
    // verdict and failure line, and the refusal.
    if (failed?.refusal) return { rerun: false, refused: { ...failed.refusal, jobs: jobs.map((j) => ({ name: j.name, verdict: j.verdict, confidence: j.confidence, line: j.sig.line, lines: j.sig.lines })) } };
    if (failed) return no;
    await record(triageLine({ sha, model, jobs, outcome: "failed jobs rerun" }), { reruns: [sha], sigs: jobs.map((j) => j.sig.id).filter(Boolean) });
    return { rerun: true, ignoreIds: new Set(failedRuns.map((r) => r.id)), jobs: jobs.map((j) => j.name) };
  };

  // Each failing job's question (red(), classify()): its log and signature read, the model asked unless the failure
  // failed on GitHub's side, was already rerun once on the Objective, or points at a file the PR changes (changedPathIn).
  // What else its lines name of the PR (changeMentions) is part of the question.
  const askJobs = async ({ sha, failedRuns, required, seen, actionsJob }) => {
    const files = (await rest(`repos/${repo.full}/pulls/${prNumber}/files?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
    const names = changedNames(files);
    const texts = new Map(await Promise.all(failedRuns.map(async (r) => [r.id, await jobLog(repo, r.id, actions).catch(() => "")])));
    const sigs = new Map(failedRuns.map((r) => [r.id, failureSignature(r.name, texts.get(r.id))]));
    const picked = jobsToTriage(failedRuns, required, sigs);
    return Promise.all(
      picked.map(async (r) => {
        const text = texts.get(r.id);
        const sig = sigs.get(r.id);
        const job = actionsJob.get(r.id);
        const step = failedStep(job)?.name || "";
        // GitHub's side (githubSide): no code of the change ran and the far side failed, so no model is asked and nothing
        // a rerun could hide; rerun once on this head like a flake. Any other checkout failure is asked like any red.
        const infra = await githubSide(sha, job, text, sig, names);
        if (infra) return { name: r.name, sig, repeat: false, step, infra, verdict: "flaky_or_infra", confidence: 1 };
        const repeat = !!sig.id && seen.sigs.has(sig.id);
        // A failure already rerun once (on any head of this Objective) is not asked again: rerunning it hides a defect.
        if (repeat) return { name: r.name, sig, repeat, step, verdict: null, confidence: null, error: "already rerun once" };
        // A failure in a file the PR changed could be the change's own intermittent defect: never rerun to green.
        const own = changedPathIn(sig, names);
        if (own) return { name: r.name, sig, repeat, step, verdict: null, confidence: null, error: `its failure points at ${own}, which the PR changes` };
        const v = await ask.decide(triageInput({ repo: repo.full, prNumber, sha, job: r.name, step, excerpt: logWindow(cleanLog(text), 4000), files, mentions: changeMentions(sig, names) }), TRIAGE_QUESTION);
        return { name: r.name, sig, repeat, step, ...v };
      }),
    );
  };

  // A red on a commit no rerun brings back (the merge queue's, after the queue dropped the PR: session.mjs queueRedOf):
  // each failing job asked as red() asks it, nothing rerun and no rerun recorded. `flaky` when red() would have rerun
  // it (rerunWanted); `named` when a failure names what the PR changes (namesChange); `off` when no model was asked. The
  // verdicts go to the log and the progress comment.
  const classify = async ({ sha, failedRuns = [], required = [] }) => {
    if (!failedRuns.length) return { flaky: false };
    if (failedRuns.length > MAX_JOBS) {
      await record(`triage: ${failedRuns.length} failing jobs on ${sha.slice(0, 7)}, more than ${MAX_JOBS}; the change's`, {});
      return { flaky: false };
    }
    const { notActions, jobs: actionsJob } = await actionsJobs(failedRuns);
    if (notActions) {
      await record(`triage: ${notActions} is not an Actions job; the change's`, {});
      return { flaky: false };
    }
    const jobs = await askJobs({ sha, failedRuns, required, seen: await known(), actionsJob });
    const flaky = rerunWanted(jobs);
    await record(triageLine({ sha, model, jobs, outcome: flaky ? "a flake: no fix pass" : "the change's: fix pass" }), {});
    return { flaky, jobs, off: false, named: await namesChange(failedRuns) };
  };
  // Whether a failing job's failure names what the PR changes: a changed path (changedPathIn), or a changed file or added
  // test by name (changeMentions). Read only where no model weighs the names (session.mjs queueRedOf, triage off).
  const namesChange = async (failedRuns) => {
    const { sigs, names } = await readRed(failedRuns);
    return failedRuns.some((r) => {
      const m = changeMentions(sigs.get(r.id), names);
      return !!changedPathIn(sigs.get(r.id), names) || m.files.length > 0 || m.tests.length > 0;
    });
  };

  // A fix pass that committed nothing left the red head as it was: its checks are not read again as a second red. The
  // failed jobs are rerun once for that head (the same once-per-head record as red()), no model asked, only when nothing
  // says the change caused the red: no change_caused verdict on this head, no failure pointing at a file the PR changes, no
  // failure signature already rerun on the Objective, and each job either answered by the model on this head or failed
  // on GitHub's side. Otherwise, or past MAX_JOBS, nothing is rerun ({skipped}).
  const again = async ({ sha, failedRuns = [], until = 0 }) => {
    const short = String(sha).slice(0, 7);
    if (!failedRuns.length) return { rerun: false, skipped: "no failed job" };
    if (failedRuns.length > MAX_JOBS) return { rerun: false, skipped: `${failedRuns.length} failing jobs, more than ${MAX_JOBS}` };
    const seen = await known();
    if (seen.refused) return { rerun: false, refused: { earlier: true, unchanged: true, where: env.GITHUB_ACTIONS ? "actions" : "local" } };
    if (seen.reruns.has(sha)) return { rerun: false, already: true };
    const caused = (asked.get(sha) || []).filter((j) => j.verdict === "change_caused");
    if (caused.length) return { rerun: false, skipped: `triage read it as caused by the change: ${caused.map((j) => `${j.name} ${typeof j.confidence === "number" ? j.confidence.toFixed(2) : ""}`.trim()).join(", ")}` };
    const { notActions, jobs } = await actionsJobs(failedRuns);
    if (notActions) return { rerun: false, skipped: `${notActions} is not an Actions job, so it cannot be rerun` };
    const { texts, sigs, names } = await readRed(failedRuns);
    // The model's answers on this head, by job: a job it gave no verdict (triage off, an error, a timeout) is rerun only
    // when it failed on GitHub's side (githubSide).
    const answered = new Set((asked.get(sha) || []).filter((j) => j.verdict).map((j) => j.name));
    for (const r of failedRuns) {
      const sig = sigs.get(r.id);
      if (sig.id && seen.sigs.has(sig.id)) return { rerun: false, skipped: `the failure of ${r.name} was already rerun once on this Objective` };
      const own = changedPathIn(sig, names);
      if (own) return { rerun: false, skipped: `the failure of ${r.name} points at ${own}, which the PR changes` };
      if (!answered.has(r.name) && !(await githubSide(sha, jobs.get(r.id), texts.get(r.id), sig, names))) return { rerun: false, skipped: `${r.name} has no triage verdict and did not fail on GitHub's side` };
    }
    const line = (outcome) => `triage: the fix pass committed nothing, so the red on ${short} is unchanged → ${outcome}`;
    const failed = await rerunRuns(new Set([...jobs.values()].map((j) => j.run_id)), line, until);
    if (failed?.refusal) return { rerun: false, refused: { ...failed.refusal, unchanged: true } };
    if (failed) {
      await record(failed.line, {});
      return { rerun: false, skipped: `workflow run ${failed.incomplete} did not complete` };
    }
    await record(line("failed jobs rerun once, no model asked"), { reruns: [sha], sigs: [...sigs.values()].map((x) => x.id).filter(Boolean) });
    return { rerun: true, ignoreIds: new Set(failedRuns.map((r) => r.id)), jobs: failedRuns.map((r) => r.name) };
  };
  // Whether every failed job failed on GitHub's side (githubSide): its set-up or checkout only, a server or network
  // failure, pointing at no file the PR changes.
  const infra = async ({ sha, failedRuns = [] }) => {
    if (!failedRuns.length) return false;
    const { notActions, jobs } = await actionsJobs(failedRuns);
    if (notActions) return false;
    const { texts, sigs, names } = await readRed(failedRuns);
    for (const r of failedRuns) if (!(await githubSide(sha, jobs.get(r.id), texts.get(r.id), sigs.get(r.id), names))) return false;
    return true;
  };
  // Triage off: no model to ask, so no red is called a flake; `named` says whether a failure names what the PR changes
  // (namesChange: a changed path, or a changed file or added test by name), the only sign left that it is the PR's own.
  const offClassify = async (r) => ((await offRed(r)), { flaky: false, off: true, named: r.failedRuns?.length ? await namesChange(r.failedRuns) : false });
  if (code) return { model, off: code, red: offRed, again, infra, classify: offClassify };
  return { model, red, again, infra, classify };
}

/** How often a workflow run that must complete before its rerun is read. */
const RUN_POLL_MS = 20_000;

/**
 * Whether workflow run `id` completed: its status read until it is `completed`, while it is not and `until` (ms) is
 * ahead. A run whose read fails is read again, within the same bound.
 */
async function waitRunCompleted(repo, id, { token, until = 0, pollMs = RUN_POLL_MS }) {
  for (;;) {
    const run = await rest(`repos/${repo.full}/actions/runs/${id}`, { token }).catch(() => null);
    if (run?.status === "completed") return true;
    if (!(Date.now() < until)) return false;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, until - Date.now())));
  }
}
