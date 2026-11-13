// What GitHub says about one Objective, through `api(path)` (lib/gh.mjs's
// ghApi online; a snapshot reader offline). Everything is REST. The shape
// is what lib/objective.mjs scores, and what `--snapshot` writes so a run
// can be scored again, or tested, without a token:
//
//   { repository, issue, issueTimeline, issueComments, pulls,
//     pullDetails: { [number]: { commits, timeline, comments, reviews, reviewComments } },
//     jobs, artifacts, stageRuns: { [runId]: { event, created_at } }, workflowRuns: [a person's run...],
//     usage: [record...], harness }
//
// `usage` comes from the artifacts API when `download` is given (a token
// with actions: read), else from `--usage <dir>` (usageFromDir below), else
// it is empty and the row says "missing: usage artifact".
import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { findFile } from "./gh.mjs";
import { parseUsageText, sessionsOf } from "./cost.mjs";
import { OBJECTIVE_LABEL } from "./objective.mjs";
import { bySelf, factoryLogin } from "./phases.mjs";

const PER_PAGE = "per_page=100";
const STATE_LABELS = ["factory:blocked", "factory:question", "factory:in-review", "factory:running"];
const labelNames = (issue) => (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/** The artifact names the jobs upload (workflow-template.yml): the worker's, and the review job's. */
export const WORK_ARTIFACT = (issue) => `factory-usage-${issue}`;
export const REVIEW_ARTIFACT = (issue) => `factory-usage-${issue}-review`;

/**
 * The Objectives worth a row: issues with the label that closed at or after
 * `since` (ISO date), plus open ones carrying a Factory state label (Blocked,
 * Question, In review, Running), so the misses that never merged are rows too.
 * With `since`, also every issue whose label was removed at or after it (a
 * parked Objective, waiting on other work) and that Factory picked up then (a
 * state label applied at or after `since`): it ran and cost money, whatever its
 * labels are now, after the labelled ones.
 */
export async function listObjectives(api, repoFull, { since, label = OBJECTIVE_LABEL, state = "all" } = {}) {
  const query = [`labels=${encodeURIComponent(label)}`, `state=${state}`, since ? `since=${encodeURIComponent(since)}` : null, "sort=updated", "direction=desc", PER_PAGE].filter(Boolean).join("&");
  const issues = await api(`repos/${repoFull}/issues?${query}`, { paginate: true });
  const numbers = new Set(
    issues
      .filter((i) => !i.pull_request)
      .filter((i) => (i.state === "closed" ? !since || Date.parse(i.closed_at ?? i.updated_at) >= Date.parse(since) : labelNames(i).some((n) => STATE_LABELS.includes(n))))
      .map((i) => i.number),
  );
  if (since) for (const n of await parkedSince(api, repoFull, { since, label, skip: new Set(issues.map((i) => i.number)) })) numbers.add(n);
  return [...numbers];
}

/**
 * Issues that lost `label` at or after `since` and gained a Factory state label at or after it. The candidates are the
 * issues updated at or after `since` that do not carry the label now (removing it updates the issue), less `skip`;
 * only each candidate's own events are read. The reads scale with the issues touched in the window, never with the
 * repository's PR and event traffic, and no ceiling cuts the list short.
 */
export async function parkedSince(api, repoFull, { since, label = OBJECTIVE_LABEL, skip = new Set() }) {
  const from = Date.parse(since);
  const touched = await api(`repos/${repoFull}/issues?state=all&since=${encodeURIComponent(since)}&${PER_PAGE}`, { paginate: true });
  const candidates = touched.filter((i) => !i.pull_request && !skip.has(i.number) && !labelNames(i).includes(label)).map((i) => i.number);
  const out = [];
  for (const n of candidates) {
    const events = (await api(`repos/${repoFull}/issues/${n}/events?${PER_PAGE}`, { paginate: true })).filter((e) => Date.parse(e.created_at) >= from);
    const removed = events.some((e) => e.event === "unlabeled" && e.label?.name === label);
    const started = events.some((e) => e.event === "labeled" && STATE_LABELS.includes(e.label?.name));
    if (removed && started) out.push(n);
  }
  return out;
}

/** This issue's usage artifacts by their exact names (the `name=` filter is exact), expired ones included: they still name their run. */
async function listArtifacts(api, repoFull, issue) {
  const out = [];
  for (const name of [WORK_ARTIFACT(issue), REVIEW_ARTIFACT(issue)]) {
    let pages;
    try {
      pages = await api(`repos/${repoFull}/actions/artifacts?name=${encodeURIComponent(name)}&${PER_PAGE}`, { paginate: true });
    } catch (error) {
      if (error.status === 404) continue;
      throw error;
    }
    out.push(...pages.flatMap((p) => (Array.isArray(p) ? p : p?.artifacts || [])));
  }
  return out.filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i).map((a) => ({ id: a.id, name: a.name, created_at: a.created_at, expired: !!a.expired, workflow_run: a.workflow_run?.id ?? null }));
}

/**
 * The usage artifacts an ended Objective still owes, by name: for each stage kind Factory ran (a progress comment of
 * its own, `self` being factoryLogin's), that kind's artifact created at or after the kind's latest progress comment,
 * the stage's start. A stage uploads its artifact after it posts its exit (on the sandbox path a later launcher run
 * does), so a scorer that reads the Blocked label or the merge can be early: bench/drill.mjs waits until this is empty.
 * An Objective with no stage owes nothing.
 */
export function usagePending(issue, comments, artifacts, { self }) {
  const latest = {};
  for (const c of comments || []) {
    const kind = new RegExp(`^<!-- factory:${issue}:progress:(work|review)[:\\s-]`).exec(c.body || "")?.[1];
    if (kind && bySelf(c, self) && !(Date.parse(latest[kind]) >= Date.parse(c.created_at))) latest[kind] = c.created_at;
  }
  const name = { work: WORK_ARTIFACT(issue), review: REVIEW_ARTIFACT(issue) };
  return Object.entries(latest)
    .filter(([kind, at]) => !(artifacts || []).some((a) => a.name === name[kind] && Date.parse(a.created_at) >= Date.parse(at)))
    .map(([kind]) => name[kind]);
}

/**
 * Fetch the usage of every issue in `issues`, waiting first for those in `ended` (merged, Blocked, Question; all of
 * `issues` by default). The label lands first and the last stage's artifact seconds later (on the sandbox path, from a
 * launcher run), so a scorer that read the label at once missed it. Polls usagePending for the ended ones until nothing
 * is owed or `waitMs` passes, reads the rest once, then calls `fetch(issue, artifact)` for every unexpired artifact of
 * each issue (each run's by id, so two runs' artifacts of one name are both kept): an Objective still running keeps the
 * usage its finished stages uploaded. Returns `{ missing: { [issue]: [what never came or failed, by name] } }`, a stage
 * still running named `<artifact> (still running)`; it never throws for one issue's failure.
 */
export async function awaitUsage(api, repoFull, issues, { ended = issues, waitMs = 0, sleep, fetch, log = () => {}, pollMs = 15_000, now = Date.now } = {}) {
  const owed = new Map();
  const deadline = now() + waitMs;
  const read = async (issue) => {
    try {
      const [timeline, comments, artifacts] = await Promise.all([api(`repos/${repoFull}/issues/${issue}/timeline?${PER_PAGE}`, { paginate: true }), api(`repos/${repoFull}/issues/${issue}/comments?${PER_PAGE}`, { paginate: true }), listArtifacts(api, repoFull, issue)]);
      owed.set(issue, { pending: usagePending(issue, comments, artifacts, { self: factoryLogin(timeline) }), artifacts });
    } catch (error) {
      owed.set(issue, { pending: [`unread (HTTP ${error.status || "?"})`], artifacts: owed.get(issue)?.artifacts ?? [] });
    }
  };
  const waited = issues.filter((n) => ended.includes(n));
  for (;;) {
    for (const issue of waited) await read(issue);
    const waiting = waited.filter((n) => owed.get(n).pending.length);
    if (!waiting.length || now() >= deadline) break;
    log(`waiting for usage: ${waiting.map((n) => `#${n} ${owed.get(n).pending.join(", ")}`).join("; ")}`);
    await sleep(pollMs);
  }
  for (const issue of issues) if (!ended.includes(issue)) await read(issue);
  const missing = {};
  for (const issue of issues) {
    const o = owed.get(issue);
    const running = !ended.includes(issue);
    if (o.pending.length) missing[issue] = o.pending.map((p) => (running && !p.startsWith("unread") ? `${p} (still running)` : p));
    for (const a of o.artifacts.filter((x) => !x.expired && x.workflow_run)) {
      try {
        await fetch(issue, a);
      } catch (error) {
        (missing[issue] ??= []).push(`${a.name} (download failed: exit ${error.code ?? "?"})`);
      }
    }
  }
  return { missing };
}

/** The usage records of the artifacts, downloaded and read; each tagged with its artifact name. */
async function usageFromArtifacts(artifacts, repoFull, download) {
  const records = [];
  for (const a of artifacts) {
    if (a.expired) continue;
    const dir = await download(repoFull, a);
    try {
      const file = findFile(dir, "result.json") ?? findFile(dir, "events.jsonl");
      const rec = file ? parseUsageText(readFileSync(file, "utf8")) : null;
      const events = findFile(dir, "events.jsonl");
      if (rec && events) rec.sessions = sessionsOf(readFileSync(events, "utf8"));
      records.push(rec ? { ...rec, artifact: a.name } : { artifact: a.name, harness: null, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: `unreadable: no result.json or events.jsonl in ${a.name}` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return records;
}

/**
 * Every job of the workflow runs that uploaded this issue's artifacts: the
 * worker run (`work (<issue>)`) and each review run (`review`). The job names
 * do not all carry the issue number, so the artifacts' `workflow_run` ids are
 * the link; an Objective with no artifact has no job here.
 */
async function jobsFor(api, repoFull, runIds) {
  const jobs = [];
  for (const run of runIds) {
    const page = await api(`repos/${repoFull}/actions/runs/${run}/jobs?${PER_PAGE}`, { paginate: true });
    for (const job of page.flatMap((p) => (Array.isArray(p) ? p : p?.jobs || []))) {
      jobs.push({ id: job.id, run, name: job.name, started_at: job.started_at, completed_at: job.completed_at, conclusion: job.conclusion });
    }
  }
  return jobs;
}

/** The Factory workflow's file name in an adopter (workflow-template.yml is written there). */
export const FACTORY_WORKFLOW = "factory.yml";
const RUNS_CAP = 1000;
const JOB_ISSUE = /^(?:work|launch|merge tick) \((\d+)\)$|^review \(factory\/(\d+)\)$/;

/**
 * The runs of Factory's workflow a person started (`workflow_dispatch`) or re-ran (attempt 2 and up) while the
 * Objective was live: from its first Objective or Running label to its merge (or its close, or now). Bots' runs are
 * left out here already. Each is `{id, event, attempt, created_at, run_started_at, by, issues}`, `issues` being the
 * Objectives its jobs name (`work (N)`, `launch (N)`, `merge tick (N)`, `review (factory/N)`), empty for a run tied to
 * none (a dispatcher tick). Throws when the runs cannot be read, or when GitHub's 1,000-run cap on a `created` filter
 * may have cut the list. A re-run of a run created before the first label is not listed (the filter is on creation).
 */
export async function humanWorkflowRuns(api, repoFull, issueData, timeline, pulls, { workflow = FACTORY_WORKFLOW } = {}) {
  const starts = (timeline || []).filter((e) => e.event === "labeled" && (e.label?.name === OBJECTIVE_LABEL || e.label?.name === "factory:running")).map((e) => Date.parse(e.created_at)).filter(Number.isFinite);
  if (!starts.length) return [];
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const from = iso(Math.min(...starts));
  const merged = (pulls || []).map((p) => Date.parse(p.merged_at)).filter(Number.isFinite);
  const endMs = merged.length ? Math.max(...merged) : Date.parse(issueData.closed_at) || null;
  const range = endMs ? `${from}..${iso(endMs)}` : `>=${from}`;
  let pages;
  try {
    pages = await api(`repos/${repoFull}/actions/workflows/${encodeURIComponent(workflow)}/runs?created=${encodeURIComponent(range)}&${PER_PAGE}`, { paginate: true });
  } catch (error) {
    if (error.status === 404) return []; // no Factory workflow in this repository (local mode only): no run to start
    throw error;
  }
  const runs = pages.flatMap((p) => (Array.isArray(p) ? p : p?.workflow_runs || []));
  // GitHub returns at most 1,000 runs for a `created` filter: past that, runs are lost silently, so none is taken as read.
  const total = pages.find((p) => !Array.isArray(p) && Number.isFinite(p?.total_count))?.total_count;
  if (runs.length >= RUNS_CAP || (Number.isFinite(total) && total > runs.length)) throw new Error(`${total ?? runs.length} Factory workflow runs in the window: GitHub lists at most ${RUNS_CAP}`);
  const out = [];
  for (const r of runs) {
    const attempt = r.run_attempt ?? 1;
    if (r.event !== "workflow_dispatch" && attempt < 2) continue;
    const by = r.triggering_actor ?? r.actor ?? null;
    if (!by || by.type === "Bot" || /\[bot\]$/i.test(by.login ?? "")) continue;
    const jobs = await api(`repos/${repoFull}/actions/runs/${r.id}/jobs?${PER_PAGE}`, { paginate: true });
    const issues = [...new Set(jobs.flatMap((p) => (Array.isArray(p) ? p : p?.jobs || [])).filter((j) => j.conclusion !== "skipped").map((j) => JOB_ISSUE.exec(j.name || "")).filter(Boolean).map((m) => Number(m[1] ?? m[2])))];
    out.push({ id: r.id, event: r.event, attempt, created_at: r.created_at, run_started_at: r.run_started_at ?? r.created_at, head_sha: r.head_sha ?? null, by: { login: by.login, type: by.type }, issues });
  }
  return out;
}

/**
 * Collect one Objective. `download(repoFull, artifact)` returns a directory
 * (lib/gh.mjs's downloadArtifact bound to a token) or is null offline.
 * `usage` is a list of records read from --usage <dir> when given.
 */
export async function collectObjective(api, repoFull, issue, { download = null, usage = null, jobs: wantJobs = true, graphql = null, app = null, workflow = FACTORY_WORKFLOW } = {}) {
  const base = `repos/${repoFull}`;
  const issueData = await api(`${base}/issues/${issue}`);
  const [issueTimeline, issueComments, pullsOpen, pullsClosed] = await Promise.all([
    api(`${base}/issues/${issue}/timeline?${PER_PAGE}`, { paginate: true }),
    api(`${base}/issues/${issue}/comments?${PER_PAGE}`, { paginate: true }),
    api(`${base}/pulls?head=${encodeURIComponent(`${repoFull.split("/")[0]}:factory/${issue}`)}&state=open&${PER_PAGE}`, { paginate: true }),
    api(`${base}/pulls?head=${encodeURIComponent(`${repoFull.split("/")[0]}:factory/${issue}`)}&state=closed&${PER_PAGE}`, { paginate: true }),
  ]);
  const pulls = [];
  const pullDetails = {};
  for (const summary of [...pullsOpen, ...pullsClosed]) {
    // The list endpoint omits merged_by and merge_commit_sha; the PR endpoint has them.
    const pr = await api(`${base}/pulls/${summary.number}`);
    pulls.push(pr);
    const [commits, timeline, comments, reviews, reviewComments] = await Promise.all([
      api(`${base}/pulls/${pr.number}/commits?${PER_PAGE}`, { paginate: true }),
      api(`${base}/issues/${pr.number}/timeline?${PER_PAGE}`, { paginate: true }),
      api(`${base}/issues/${pr.number}/comments?${PER_PAGE}`, { paginate: true }),
      api(`${base}/pulls/${pr.number}/reviews?${PER_PAGE}`, { paginate: true }),
      api(`${base}/pulls/${pr.number}/comments?${PER_PAGE}`, { paginate: true }),
    ]);
    pullDetails[pr.number] = { commits, timeline, comments, reviews, reviewComments };
  }
  // Human edits of the issue or PR body are not on the REST timeline; GraphQL has lastEditedAt/editor.
  // Claude's cloud blocks GraphQL, so a failure leaves bodyEdits null and the row says so.
  let bodyEdits = null;
  if (graphql) {
    try {
      const [owner, name] = repoFull.split("/");
      const q = `query($o:String!,$n:String!,$i:Int!){ repository(owner:$o,name:$n){ issue(number:$i){ lastEditedAt editor { login __typename } } } }`;
      const data = await graphql(q, { o: owner, n: name, i: issue });
      bodyEdits = [];
      const ed = data?.repository?.issue;
      if (ed?.lastEditedAt) bodyEdits.push({ at: ed.lastEditedAt, where: `#${issue}`, by: { login: ed.editor?.login, type: ed.editor?.__typename === "Bot" ? "Bot" : "User" } });
      for (const pr of pulls) {
        const pq = `query($o:String!,$n:String!,$i:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$i){ lastEditedAt editor { login __typename } } } }`;
        const pd = await graphql(pq, { o: owner, n: name, i: pr.number });
        const pe = pd?.repository?.pullRequest;
        if (pe?.lastEditedAt) bodyEdits.push({ at: pe.lastEditedAt, where: `PR #${pr.number}`, by: { login: pe.editor?.login, type: pe.editor?.__typename === "Bot" ? "Bot" : "User" } });
      }
    } catch {
      bodyEdits = null;
    }
  }
  let artifacts = [];
  try {
    artifacts = await listArtifacts(api, repoFull, issue);
  } catch {
    artifacts = [];
  }
  let jobs = null;
  if (wantJobs)
    try {
      jobs = await jobsFor(api, repoFull, [...new Set(artifacts.map((a) => a.workflow_run).filter(Boolean))]);
    } catch {
      jobs = null;
    }
  // The Actions run that launched each work stage (the run id its progress comment is keyed by): its event and creation
  // are the stage's tick when the sandbox record does not show its launch (lib/phases.mjs dispatchLatency). Factory's
  // own progress comments only: anyone can paste a marker. A local loop's key is no Actions run.
  let stageRuns = null;
  if (!labelNames(issueData).includes("factory:local")) {
    stageRuns = {};
    const self = factoryLogin(issueTimeline, app);
    const ids = new Set(issueComments.filter((c) => bySelf(c, self)).map((c) => new RegExp(`^<!-- factory:${issue}:progress:work:(\\d{1,20})(?:-|\\s)`).exec(c.body || "")?.[1]).filter(Boolean));
    for (const id of ids) {
      try {
        const r = await api(`${base}/actions/runs/${id}`);
        stageRuns[id] = { event: r?.event ?? null, created_at: r?.created_at ?? null };
      } catch {
        // deleted, or not readable with this token: the stage is timed from its own trigger
      }
    }
  }
  let workflowRuns = null;
  try {
    workflowRuns = await humanWorkflowRuns(api, repoFull, issueData, issueTimeline, pulls, { workflow });
  } catch {
    workflowRuns = null; // not readable with this token (actions: read): the row says so
  }
  let records = usage ?? [];
  if (!usage && download) records = await usageFromArtifacts(artifacts, repoFull, download);
  return {
    repository: repoFull,
    collectedAt: new Date().toISOString(),
    issue: issueData,
    issueTimeline,
    issueComments,
    pulls,
    pullDetails,
    jobs,
    artifacts,
    stageRuns,
    workflowRuns,
    usage: records,
    bodyEdits,
    harness: records.find((r) => r.harness)?.harness ?? null,
  };
}

/** An `api` over a snapshot: paths are looked up as written, so a snapshot replays exactly. */
export function snapshotApi(snapshot) {
  const calls = snapshot.calls ?? {};
  return async (path) => {
    if (!(path in calls)) {
      const e = new Error(`snapshot has no answer for ${path}`);
      e.status = 404;
      throw e;
    }
    return calls[path];
  };
}

/** An `api` that records every answer into `calls` (for `--snapshot`), delegating to `inner`. */
export function recordingApi(inner, calls) {
  return async (path, opts) => {
    const value = await inner(path, opts);
    calls[path] = value;
    return value;
  };
}

/**
 * Where one issue's usage sits under `--usage <dir>`: `<dir>/<issue>` when it is there. Without it, the issue has no
 * usage when `<dir>` holds other issues' directories (bench/drill.mjs downloads nothing for an Objective that never ran
 * a stage), or when several issues are scored from one flat directory; one artifact's unzip scored for one issue is
 * `<dir>` itself. Null means no usage.
 */
export function usageDirFor(dir, issue, { scored, readdir, isDir }) {
  const names = readdir(dir);
  const perIssue = (name) => /^\d+$/.test(name) && isDir(`${dir}/${name}`);
  if (names.includes(String(issue)) && perIssue(String(issue))) return `${dir}/${issue}`;
  return scored === 1 && !names.some(perIssue) ? dir : null;
}

/** Usage records from a directory of result.json / events.jsonl files (one artifact's unzip, or several side by side). */
export function usageFromDir(dir, { readdir, read, isDir = null }) {
  const records = [];
  const walk = (at, depth) => {
    for (const name of readdir(at)) {
      const file = `${at}/${name}`;
      if (name === "result.json" || name === "events.jsonl" || (depth === 0 && /\.(json|jsonl)$/.test(name))) {
        const text = read(file);
        const rec = parseUsageText(text);
        if (rec?.harness) records.push({ ...rec, ...(name === "events.jsonl" ? { sessions: sessionsOf(text) } : {}), artifact: basename(at) === basename(dir) ? name : `${basename(at)}/${name}` });
      } else if (depth < 2 && (isDir ? isDir(file) : !name.includes("."))) {
        try {
          walk(file, depth + 1);
        } catch {
          // a file without an extension
        }
      }
    }
  };
  walk(dir, 0);
  // A result.json beside its events.jsonl is the same run: keep the normalized one.
  const byDir = new Map();
  for (const r of records) {
    const key = r.artifact.replace(/\/?(result\.json|events\.jsonl)$/, "");
    const have = byDir.get(key);
    const sessions = r.sessions ?? have?.sessions ?? null;
    if (!have || r.artifact.endsWith("result.json")) byDir.set(key, { ...r, sessions });
    else if (sessions && !have.sessions) byDir.set(key, { ...have, sessions });
  }
  return [...byDir.values()];
}
