// What GitHub says about one Objective, through `api(path)` (lib/gh.mjs's
// ghApi online; a snapshot reader offline). Everything is REST. The shape
// is what lib/objective.mjs scores, and what `--snapshot` writes so a run
// can be scored again, or tested, without a token:
//
//   { repository, issue, issueTimeline, issueComments, pulls,
//     pullDetails: { [number]: { commits, timeline, comments, reviews, reviewComments } },
//     jobs, artifacts, usage: [record...], harness }
//
// `usage` comes from the artifacts API when `download` is given (a token
// with actions: read), else from `--usage <dir>` (usageFromDir below), else
// it is empty and the row says "missing: usage artifact".
import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { findFile } from "./gh.mjs";
import { parseUsageText } from "./cost.mjs";
import { OBJECTIVE_LABEL } from "./objective.mjs";

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
 */
export async function listObjectives(api, repoFull, { since, label = OBJECTIVE_LABEL, state = "all" } = {}) {
  const query = [`labels=${encodeURIComponent(label)}`, `state=${state}`, since ? `since=${encodeURIComponent(since)}` : null, "sort=updated", "direction=desc", PER_PAGE].filter(Boolean).join("&");
  const issues = await api(`repos/${repoFull}/issues?${query}`, { paginate: true });
  return issues
    .filter((i) => !i.pull_request)
    .filter((i) => (i.state === "closed" ? !since || Date.parse(i.closed_at ?? i.updated_at) >= Date.parse(since) : labelNames(i).some((n) => STATE_LABELS.includes(n))))
    .map((i) => i.number);
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

/** The usage records of the artifacts, downloaded and read; each tagged with its artifact name. */
async function usageFromArtifacts(artifacts, repoFull, download) {
  const records = [];
  for (const a of artifacts) {
    if (a.expired) continue;
    const dir = await download(repoFull, a.id);
    try {
      const file = findFile(dir, "result.json") ?? findFile(dir, "events.jsonl");
      const rec = file ? parseUsageText(readFileSync(file, "utf8")) : null;
      records.push(rec ? { ...rec, artifact: a.name } : { artifact: a.name, harness: null, usd: null, tokens: { input: null, output: null, cached: null }, basis: `unreadable: no result.json or events.jsonl in ${a.name}` });
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

/**
 * Collect one Objective. `download(repoFull, artifactId)` returns a directory
 * (lib/gh.mjs's downloadArtifact bound to a token) or is null offline.
 * `usage` is a list of records read from --usage <dir> when given.
 */
export async function collectObjective(api, repoFull, issue, { download = null, usage = null, jobs: wantJobs = true, graphql = null } = {}) {
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

/** Usage records from a directory of result.json / events.jsonl files (one artifact's unzip, or several side by side). */
export function usageFromDir(dir, { readdir, read, isDir = null }) {
  const records = [];
  const walk = (at, depth) => {
    for (const name of readdir(at)) {
      const file = `${at}/${name}`;
      if (name === "result.json" || name === "events.jsonl" || (depth === 0 && /\.(json|jsonl)$/.test(name))) {
        const rec = parseUsageText(read(file));
        if (rec?.harness) records.push({ ...rec, artifact: basename(at) === basename(dir) ? name : `${basename(at)}/${name}` });
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
    if (!have || r.artifact.endsWith("result.json")) byDir.set(key, r);
  }
  return [...byDir.values()];
}
