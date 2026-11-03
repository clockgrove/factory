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
// with actions: read), else from `--usage <dir>` (lib/usage-dir.mjs), else
// it is empty and the row says "missing: usage artifact".
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { findFile } from "./gh.mjs";
import { parseUsageText } from "./cost.mjs";
import { OBJECTIVE_LABEL } from "./objective.mjs";

const PER_PAGE = "per_page=100";

/** Every closed issue with the Objective label updated since `since` (ISO date), newest first. */
export async function listObjectives(api, repoFull, { since, label = OBJECTIVE_LABEL, state = "closed" } = {}) {
  const query = [`labels=${encodeURIComponent(label)}`, `state=${state}`, since ? `since=${encodeURIComponent(since)}` : null, "sort=updated", "direction=desc", PER_PAGE].filter(Boolean).join("&");
  const issues = await api(`repos/${repoFull}/issues?${query}`, { paginate: true });
  return issues.filter((i) => !i.pull_request && (!since || Date.parse(i.closed_at ?? i.updated_at) >= Date.parse(since))).map((i) => i.number);
}

/** The usage records of this issue's artifacts, downloaded; each tagged with its artifact name. */
async function usageFromArtifacts(api, repoFull, issue, download) {
  const pages = await api(`repos/${repoFull}/actions/artifacts?name=${encodeURIComponent(`factory-usage-${issue}`)}&${PER_PAGE}`, { paginate: true });
  const named = pages.flatMap((p) => (Array.isArray(p) ? p : p?.artifacts || []));
  // The name filter is exact, so the review artifacts need a listing of their own prefix.
  const all = (await api(`repos/${repoFull}/actions/artifacts?${PER_PAGE}`, { paginate: true })).flatMap((p) => (Array.isArray(p) ? p : p?.artifacts || []));
  const prefix = `factory-usage-${issue}-review-`;
  const artifacts = [...named, ...all.filter((a) => a.name?.startsWith(prefix))].filter((a, i, arr) => !a.expired && arr.findIndex((b) => b.id === a.id) === i);
  const records = [];
  for (const a of artifacts) {
    const dir = await download(repoFull, a.id);
    const file = findFile(dir, "result.json") ?? findFile(dir, "events.jsonl");
    const rec = file ? parseUsageText(readFileSync(file, "utf8")) : null;
    records.push(rec ? { ...rec, artifact: a.name } : { artifact: a.name, harness: null, usd: null, tokens: { input: null, output: null, cached: null }, basis: `unreadable: no result.json or events.jsonl in ${a.name}` });
  }
  return { artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, created_at: a.created_at, workflow_run: a.workflow_run?.id ?? null })), usage: records };
}

/** The factory workflow's jobs for this issue: job names carry the issue number (workflow-template.yml). */
async function jobsFor(api, repoFull, issue, { workflow = "factory.yml" } = {}) {
  let runs;
  try {
    runs = (await api(`repos/${repoFull}/actions/workflows/${workflow}/runs?${PER_PAGE}`, { paginate: true })).flatMap((p) => (Array.isArray(p) ? p : p?.workflow_runs || []));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const jobs = [];
  const want = new RegExp(`(^|[^0-9])${issue}([^0-9]|$)`);
  for (const run of runs) {
    const page = await api(`repos/${repoFull}/actions/runs/${run.id}/jobs?${PER_PAGE}`, { paginate: true });
    for (const job of page.flatMap((p) => (Array.isArray(p) ? p : p?.jobs || []))) {
      if (!want.test(job.name || "")) continue;
      jobs.push({ id: job.id, run: run.id, name: job.name, started_at: job.started_at, completed_at: job.completed_at, conclusion: job.conclusion });
    }
  }
  return jobs;
}

/**
 * Collect one Objective. `download(repoFull, artifactId)` returns a directory
 * (lib/gh.mjs's downloadArtifact bound to a token) or is null offline.
 * `usage` is a list of records read from --usage <dir> when given.
 */
export async function collectObjective(api, repoFull, issue, { download = null, usage = null, jobs: wantJobs = true } = {}) {
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
  let jobs = null;
  if (wantJobs)
    try {
      jobs = await jobsFor(api, repoFull, issue);
    } catch {
      jobs = null;
    }
  let artifacts = [];
  let records = usage ?? [];
  if (!usage && download) {
    const got = await usageFromArtifacts(api, repoFull, issue, download);
    artifacts = got.artifacts;
    records = got.usage;
  }
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
export function usageFromDir(dir, { readdir, read }) {
  const records = [];
  const walk = (at, depth) => {
    for (const name of readdir(at)) {
      const file = `${at}/${name}`;
      if (name === "result.json" || name === "events.jsonl" || (depth === 0 && /\.(json|jsonl)$/.test(name))) {
        const rec = parseUsageText(read(file));
        if (rec) records.push({ ...rec, artifact: basename(at) === basename(dir) ? name : `${basename(at)}/${name}` });
      } else if (depth < 2 && !name.includes(".")) {
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
