// GitHub REST and GraphQL through `gh api`, with the token the caller sets in GH_TOKEN.
// Every write the plan routes through the App (push, PR, review request, card move,
// merge) goes through here with the App token in env; the job token is never passed.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateChecks, setWriters, isPlaceholder, marker, spendOf, trustedAuthor } from "./logic.mjs";
import { exec } from "./proc.mjs";

/** Run gh and throw on non-zero exit, with stderr on the error. */
async function run(cmd, args, opts = {}) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    const e = new Error(`${cmd} exited ${r.code ?? r.signal}`);
    e.stderr = String(r.stderr);
    throw e;
  }
  return r;
}

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** `token` is a string or a getter (the TokenKeeper's, which re-mints during long jobs). */
function env(token) {
  const e = { ...process.env };
  const t = typeof token === "function" ? token() : token;
  if (t) e.GH_TOKEN = t;
  delete e.GITHUB_TOKEN; // gh prefers GH_TOKEN; make sure the job token never wins
  delete e.GH_CONFIG_DIR;
  return e;
}

/** REST call. `body` is sent as JSON with --input; `method` defaults to GET. Returns parsed JSON or null. */
export async function rest(path, { method = "GET", body, token, paginate = false, raw = false } = {}) {
  const args = ["api", path, "-X", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (paginate) args.push("--paginate", "--slurp");
  if (raw) args.splice(args.indexOf("-H"), 2, "-H", raw);
  let input;
  if (body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(body);
  }
  try {
    const { stdout } = await run("gh", args, { env: env(token), maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
    const text = stdout.trim();
    if (!text) return null;
    if (paginate) {
      const pages = JSON.parse(text);
      return Array.isArray(pages) ? pages.flat() : pages;
    }
    return raw ? text : JSON.parse(text);
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString();
    const status = Number(/HTTP (\d{3})/.exec(msg)?.[1]) || 0;
    throw new GitHubError(`gh api ${method} ${path} failed${status ? ` (${status})` : ""}: ${msg.slice(0, 500)}`, status, msg);
  }
}

/** GraphQL call. Variables are passed as typed -F/-f fields. */
export async function graphql(query, variables = {}, { token } = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === "number" || typeof v === "boolean") args.push("-F", `${k}=${v}`);
    else args.push("-f", `${k}=${v}`);
  }
  try {
    const { stdout } = await run("gh", args, { env: env(token), maxBuffer: 64 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    if (data.errors?.length) throw new GitHubError(`graphql: ${data.errors.map((e) => e.message).join("; ")}`, 0, data);
    return data.data;
  } catch (e) {
    if (e instanceof GitHubError) throw e;
    throw new GitHubError(`gh api graphql failed: ${(e.stderr || e.message || "").toString().slice(0, 500)}`, 0, e.stderr);
  }
}

export const repoOf = (full) => {
  const [owner, name] = String(full).split("/");
  if (!owner || !name) throw new Error(`--repo must be OWNER/NAME, got ${full}`);
  return { owner, name, full: `${owner}/${name}` };
};

// ------------------------------------------------------------------ issues

export async function getIssue(repo, number, opts) {
  return rest(`repos/${repo.full}/issues/${number}`, opts);
}

/** Issues with the label closed in the last `hours` (for the Done reconcile). */
export async function recentlyClosedByLabel(repo, label, hours, opts) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const items = await rest(`repos/${repo.full}/issues?state=closed&labels=${encodeURIComponent(label)}&since=${since}&per_page=100`, { ...opts, paginate: true });
  return (items || []).filter((i) => !i.pull_request);
}

export async function listIssuesByLabel(repo, label, opts) {
  const items = await rest(`repos/${repo.full}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`, { ...opts, paginate: true });
  return (items || []).filter((i) => !i.pull_request);
}

/** The REST "blocked by" relations of an issue, or null when the endpoint is unavailable. */
export async function blockedByRelations(repo, number, opts) {
  try {
    const items = await rest(`repos/${repo.full}/issues/${number}/dependencies/blocked_by?per_page=100`, opts);
    if (!Array.isArray(items)) return null;
    return items.map((i) => ({ number: i.number, state: i.state }));
  } catch (e) {
    if (e.status === 404 || e.status === 410 || e.status === 403) return null;
    throw e;
  }
}

/**
 * Whether `label` was (re)applied after the last `since` label was applied: the
 * plan's recovery path, where a human re-applies factory:objective to a Blocked,
 * Question or abandoned In-review issue. Reads the issue timeline's `labeled` events.
 */
export async function relabeledAfter(repo, number, label, since, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  let lastSince = null;
  for (const e of events) {
    if (e.event !== "labeled" || !e.label?.name) continue;
    if (e.label.name === label) last = e.created_at;
    if (since.includes(e.label.name)) lastSince = e.created_at;
  }
  return !!(last && lastSince && last > lastSince);
}

export async function addLabels(repo, number, labels, opts) {
  return rest(`repos/${repo.full}/issues/${number}/labels`, { ...opts, method: "POST", body: { labels } });
}

export async function removeLabel(repo, number, label, opts) {
  try {
    await rest(`repos/${repo.full}/issues/${number}/labels/${encodeURIComponent(label)}`, { ...opts, method: "DELETE" });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

/** Set exactly one of the factory:* state labels. */
export async function setStateLabel(repo, number, state, opts) {
  const all = ["factory:running", "factory:blocked", "factory:question", "factory:in-review"];
  const want = state ? `factory:${state}` : null;
  for (const l of all) if (l !== want) await removeLabel(repo, number, l, opts);
  if (want) await addLabels(repo, number, [want], opts);
}

export async function ensureLabel(repo, name, color, description, opts) {
  try {
    await rest(`repos/${repo.full}/labels/${encodeURIComponent(name)}`, opts);
    return false;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await rest(`repos/${repo.full}/labels`, { ...opts, method: "POST", body: { name, color, description } });
  return true;
}

export async function listComments(repo, number, opts) {
  return (await rest(`repos/${repo.full}/issues/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [];
}

/** Post a comment, or update the one carrying `marker` when it exists (idempotent on rerun). */
export async function upsertComment(repo, number, marker, body, opts) {
  const text = `${marker}\n${body}`;
  // Only a comment Factory or someone who can push wrote is ours to edit: anyone can paste the marker into theirs.
  const existing = (await listComments(repo, number, opts)).find((c) => trustedAuthor(c) && (c.body || "").includes(marker));
  if (existing) return rest(`repos/${repo.full}/issues/comments/${existing.id}`, { ...opts, method: "PATCH", body: { body: text } });
  return rest(`repos/${repo.full}/issues/${number}/comments`, { ...opts, method: "POST", body: { body: text } });
}

// --------------------------------------------------------------------- PRs

export async function findPr(repo, head, opts) {
  const list = await rest(`repos/${repo.full}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}&per_page=10`, opts);
  return Array.isArray(list) && list.length ? list[0] : null;
}

export async function getPr(repo, number, opts) {
  return rest(`repos/${repo.full}/pulls/${number}`, opts);
}

/**
 * The PR once GitHub has worked out whether it still merges. Right after a sibling merges its state is `unknown`
 * for a few seconds (the read starts the computation); a decision on that would miss the conflict, and on Actions
 * nothing else wakes the dispatcher. Gives up after `tries` and returns the last answer.
 */
export async function getPrSettled(repo, number, opts, { tries = 6, waitMs = 2500 } = {}) {
  let pr = await getPr(repo, number, opts);
  for (let i = 1; i < tries && pr && !pr.merged && pr.state === "open" && (pr.mergeable === null || pr.mergeable_state === "unknown"); i += 1) {
    await new Promise((r) => setTimeout(r, waitMs));
    pr = await getPr(repo, number, opts);
  }
  return pr;
}

export async function createPr(repo, { head, base, title, body, draft }, opts) {
  return rest(`repos/${repo.full}/pulls`, { ...opts, method: "POST", body: { head, base, title, body, draft: !!draft } });
}

export async function prDiff(repo, number, opts) {
  return rest(`repos/${repo.full}/pulls/${number}`, { ...opts, raw: "Accept: application/vnd.github.diff" });
}

/** Convert to draft or mark ready: GraphQL is the only API for it. */
export async function setDraft(repo, number, draft, opts) {
  const pr = await getPr(repo, number, opts);
  if (!!pr.draft === !!draft) return;
  const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  await graphql(`mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`, { id: pr.node_id }, opts);
}

export async function requestReviewers(repo, number, reviewers, opts) {
  if (!reviewers.length) return;
  await rest(`repos/${repo.full}/pulls/${number}/requested_reviewers`, { ...opts, method: "POST", body: { reviewers } });
}

export async function listReviewComments(repo, number, opts) {
  return (await rest(`repos/${repo.full}/pulls/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [];
}

/** One comment-only review with line comments. */
export async function postReview(repo, number, { body, comments, commitId }, opts) {
  return rest(`repos/${repo.full}/pulls/${number}/reviews`, { ...opts, method: "POST", body: { event: "COMMENT", body, comments, ...(commitId ? { commit_id: commitId } : {}) } });
}

/**
 * Resolve the review threads Factory itself opened (the root comment belongs to the review
 * carrying marker(issue, "review")) once they are answered: a reply exists, or the root is
 * Factory's placeholder. Identified by Factory's own marker, never by login: GraphQL names a
 * Bot without the "[bot]" suffix REST adds. Returns the number resolved.
 */
export async function resolveFactoryThreads(repo, number, issue, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 50) { nodes { body pullRequestReview { body authorAssociation author { __typename login } } } } } } } } }`,
    { owner: repo.owner, name: repo.name, n: Number(number) },
    opts,
  );
  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const mark = marker(issue, "review");
  let resolved = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const comments = t.comments?.nodes || [];
    const root = comments[0];
    const review = root?.pullRequestReview;
    if (!root || !String(review?.body || "").includes(mark) || !trustedAuthor({ user: { type: review?.author?.__typename, login: review?.author?.login }, author_association: review?.authorAssociation })) continue;
    const answered = comments.length > 1 || isPlaceholder(root.body);
    if (!answered) continue;
    await graphql(`mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`, { id: t.id }, opts);
    resolved += 1;
  }
  return resolved;
}

/** The issue numbers GitHub parsed as closed by this PR (its closing references), as GitHub will act on them. */
export async function closingIssues(repo, number, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { number } } } } }`,
    { owner: repo.owner, name: repo.name, number },
    opts,
  );
  return (data?.repository?.pullRequest?.closingIssuesReferences?.nodes || []).map((n) => n.number);
}

/** Every check-run on a commit (Actions jobs and other apps' checks). */
export async function checkRuns(repo, sha, opts) {
  const pages = await rest(`repos/${repo.full}/commits/${sha}/check-runs?per_page=100`, { ...opts, paginate: true });
  return (pages || []).flatMap((p) => (Array.isArray(p) ? p : p?.check_runs || []));
}

/** The tail of an Actions job's log (a check-run's id is the job's id); empty when unavailable. */
export async function jobLogTail(repo, jobId, opts, chars = 4000) {
  try {
    // gh refuses to print a log with terminal escapes unless told to; the escapes and the per-line timestamps are stripped here.
    const { stdout } = await run("gh", ["api", "--allow-escape-sequences", `repos/${repo.full}/actions/jobs/${jobId}/logs`], { env: env(opts.token), maxBuffer: 64 * 1024 * 1024 });
    // eslint-disable-next-line no-control-regex
    const text = String(stdout).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/gm, "");
    // The runner's own error annotations mark where the job failed; the window around them beats the tail (post-job cleanup).
    const first = text.indexOf("##[error]");
    if (first === -1) return text.slice(-chars);
    const last = text.lastIndexOf("##[error]");
    return text.slice(Math.max(0, first - Math.round(chars * 0.75)), Math.min(text.length, last + Math.round(chars * 0.25)));
  } catch {
    return "";
  }
}

/**
 * Wait for the named required checks on `sha`: polls the check-runs until every name has a
 * completed run, or `timeoutMs` passes. A name with no run at all after `appearMs` is a
 * failure (no workflow ran for this head). Returns {green, checks, output, timedOut} where
 * `output` is the failed jobs' log tails (every failed check-run on the head, named or not,
 * since the required check is usually an aggregate of the jobs that actually fail).
 */
export async function awaitChecks(repo, sha, names, { token, timeoutMs = 60 * 60_000, appearMs = 15 * 60_000, pollMs = 60_000, onPoll = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = Date.now();
  let runs = [];
  let state = null;
  for (;;) {
    runs = await checkRuns(repo, sha, { token }).catch(() => []);
    state = evaluateChecks(names, runs);
    if (state.done) break;
    const elapsed = Date.now() - started;
    if (state.missing.length && elapsed > appearMs && !state.pending.length && runs.length === 0) break; // nothing ran for this head
    if (elapsed > timeoutMs) break;
    if (onPoll) await onPoll(state, Math.round(elapsed / 60000));
    await sleep(pollMs);
  }
  const timedOut = !state.done;
  const failedRuns = runs.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion));
  const parts = [];
  for (const r of failedRuns.slice(0, 4)) parts.push(`--- ${r.name}: ${r.conclusion}\n${await jobLogTail(repo, r.id, { token })}`);
  if (timedOut) parts.unshift(`required check(s) not finished after ${Math.round((Date.now() - started) / 60000)} min: missing ${state.missing.join(", ") || "none"}; pending ${state.pending.join(", ") || "none"}`);
  return { green: state.green && !timedOut, checks: state, output: parts.join("\n"), timedOut, failedNames: state.failed.map((f) => f.name) };
}

/** GitHub merges the base branch into the PR's branch (its "Update branch" button): 202 accepted; 422 when it is up to date or conflicting. */
export async function updatePrBranch(repo, number, opts) {
  return rest(`repos/${repo.full}/pulls/${number}/update-branch`, { ...opts, method: "PUT", body: {} });
}

export async function prComment(repo, number, body, opts) {
  return rest(`repos/${repo.full}/issues/${number}/comments`, { ...opts, method: "POST", body: { body } });
}

/**
 * `gh pr merge --auto --squash` with the App token (the queue needs the App as
 * enqueuer). GitHub refuses auto-merge on a PR that is already mergeable ("clean
 * status"); that one merges (enqueues, on a queue-protected branch) directly.
 */
export async function enableAutoMerge(repo, number, opts = {}) {
  try {
    await run("gh", ["pr", "merge", String(number), "--repo", repo.full, "--auto", "--squash"], { env: env(opts.token) });
    return "auto";
  } catch (e) {
    // Not the error text: the PR's own state decides. Armed after all: done. Else a direct merge
    // (the already-mergeable case); if that fails too, the first error is the one to report.
    const state = await rest(`repos/${repo.full}/pulls/${number}`, { token: opts.token }).catch(() => null);
    if (state?.auto_merge) return "auto";
    try {
      await run("gh", ["pr", "merge", String(number), "--repo", repo.full, "--squash"], { env: env(opts.token) });
      return "direct";
    } catch {
      throw e;
    }
  }
}

// ---------------------------------------------------------------- projects

const PROJECT_FIELDS = `
  id title number
  field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name color description } } }
`;

/** The board's title: one per repository, since org projects share one namespace. */
export const projectTitle = (repo) => `Factory: ${repo.name}`;

/** The repository's Factory project (title "Factory: <repo>", "Factory", else a linked project with a Queued column), or null. */
export async function findProject(repo, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id projectsV2(first: 20) { nodes { ${PROJECT_FIELDS} } } } }`,
    { owner: repo.owner, name: repo.name },
    opts,
  );
  const nodes = data?.repository?.projectsV2?.nodes || [];
  const project = nodes.find((p) => p.title === projectTitle(repo)) || nodes.find((p) => p.title === "Factory") || nodes.find((p) => p.field?.options?.some((o) => o.name === "Queued")) || null;
  return project ? { ...project, repositoryId: data.repository.id } : null;
}

export async function repositoryNodeId(repo, opts) {
  const data = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id owner { id __typename } } }`, { owner: repo.owner, name: repo.name }, opts);
  return data.repository;
}

/** The project item for an issue, with its Status name, or null. */
export async function projectItem(project, repo, issueNumber, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { id projectItems(first: 20) { nodes { id project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
    { owner: repo.owner, name: repo.name, n: Number(issueNumber) },
    opts,
  );
  const issue = data?.repository?.issue;
  if (!issue) return null;
  const item = (issue.projectItems?.nodes || []).find((i) => i.project?.id === project.id);
  return { issueId: issue.id, itemId: item?.id ?? null, status: item?.fieldValueByName?.name ?? null };
}

/** Statuses of many issues in one query (dispatch). Returns {number: status|null}. */
export async function projectStatuses(project, repo, numbers, opts) {
  const out = {};
  const chunk = 25;
  for (let i = 0; i < numbers.length; i += chunk) {
    const slice = numbers.slice(i, i + chunk);
    const fields = slice.map((n, j) => `i${j}: issue(number: ${n}) { number projectItems(first: 20) { nodes { project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }`).join("\n");
    const data = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner: repo.owner, name: repo.name }, opts);
    for (const v of Object.values(data?.repository || {})) {
      if (!v?.number) continue;
      const item = (v.projectItems?.nodes || []).find((it) => it.project?.id === project.id);
      out[v.number] = item?.fieldValueByName?.name ?? null;
    }
  }
  return out;
}

/** Move an issue's card to a Status column, adding it to the project when absent. */
export async function moveCard(project, repo, issueNumber, status, opts) {
  if (!project) return false;
  const option = project.field?.options?.find((o) => o.name.toLowerCase() === status.toLowerCase());
  if (!option) throw new Error(`project has no Status option ${status}`);
  const item = await projectItem(project, repo, issueNumber, opts);
  if (!item) return false;
  let itemId = item.itemId;
  if (!itemId) {
    const added = await graphql(`mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }`, { p: project.id, c: item.issueId }, opts);
    itemId = added.addProjectV2ItemById.item.id;
  }
  await graphql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}}) { projectV2Item { id } } }`,
    { p: project.id, i: itemId, f: project.field.id, o: option.id },
    opts,
  );
  return true;
}

export const COLUMNS = ["Queued", "Running", "In review", "Blocked", "Done"];

/** Create the Factory project with the five Status options and link it to the repository. */
export async function createProject(repo, opts) {
  const { id: repositoryId, owner } = await repositoryNodeId(repo, opts);
  const created = await graphql(`mutation($o: ID!, $t: String!) { createProjectV2(input: {ownerId: $o, title: $t}) { projectV2 { id number } } }`, { o: owner.id, t: projectTitle(repo) }, opts);
  const project = created.createProjectV2.projectV2;
  await graphql(`mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: {projectId: $p, repositoryId: $r}) { repository { id } } }`, { p: project.id, r: repositoryId }, opts);
  // A new project already has a Status field with Todo/In Progress/Done; replace its options.
  const fields = await graphql(`query($p: ID!) { node(id: $p) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id } } } } }`, { p: project.id }, opts);
  const fieldId = fields.node.field?.id;
  const colors = { Queued: "GRAY", Running: "BLUE", "In review": "YELLOW", Blocked: "RED", Done: "GREEN" };
  const options = COLUMNS.map((name) => `{name: "${name}", color: ${colors[name]}, description: ""}`).join(", ");
  if (fieldId) {
    // UpdateProjectV2FieldInput takes fieldId only (no projectId): the field already belongs to the project.
    await graphql(`mutation($f: ID!) { updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { f: fieldId }, opts);
  } else {
    await graphql(`mutation($p: ID!) { createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: "Status", singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { p: project.id }, opts);
  }
  return project;
}

// --------------------------------------------------------------- artifacts

/** An artifact never changes once uploaded: a long-lived dispatcher (factory serve) reads each one once. */
const usageCache = new Map();
const USAGE_DOWNLOADS = 8;

/**
 * Today's spend by runs that upload no usage artifact (local mode, any machine): the spend lines in the progress
 * comments updated today, written by Factory or someone who can push. Actions runs write none, so
 * nothing here is counted twice with the artifacts.
 */
export async function localSpendToday(repo, { dateIso = new Date().toISOString().slice(0, 10), token } = {}) {
  // One paged read of the repository's comments updated today (issues and PRs alike), not one per Objective.
  const pages = (await rest(`repos/${repo.full}/issues/comments?since=${dateIso}T00:00:00Z&per_page=100`, { token, paginate: true })) || [];
  const comments = (Array.isArray(pages) ? pages : [pages]).flat();
  let usd = 0;
  for (const c of comments) {
    if (trustedAuthor(c) && /^<!-- factory:\d+:progress:/.test(c.body || "") && String(c.updated_at || "").startsWith(dateIso)) usd += spendOf(c.body);
  }
  return usd;
}

/** Usage artifacts uploaded today (UTC), as parsed result.json records. */
export async function todaysUsage(repo, { prefix = "factory-usage-", token, dateIso = new Date().toISOString().slice(0, 10), download } = {}) {
  // The artifacts endpoint wraps each page as {total_count, artifacts}; --slurp gives the pages.
  const pages = (await rest(`repos/${repo.full}/actions/artifacts?per_page=100`, { token, paginate: true })) || [];
  const artifacts = (Array.isArray(pages) ? pages : [pages]).flatMap((p) => (Array.isArray(p) ? p : p?.artifacts || []));
  const today = artifacts.filter((a) => a.name?.startsWith(prefix) && !a.expired && String(a.created_at || "").startsWith(dateIso));
  // One download is about a second and a busy day has a hundred artifacts, so eight at a time: the
  // dispatcher's tick, and with it every Objective's pickup, waits on this sum.
  const one = async (a) => {
    try {
      const rec = usageCache.has(a.id) ? usageCache.get(a.id) : await (download ?? downloadArtifactResult)(repo, a, token);
      if (!download) usageCache.set(a.id, rec);
      return rec ? { artifact: a.name, ...rec } : null;
    } catch (e) {
      return { artifact: a.name, usd: null, basis: `unreadable: ${e.message.slice(0, 120)}` };
    }
  };
  const records = new Array(today.length);
  let next = 0;
  const lane = async () => {
    while (next < today.length) {
      const i = next++;
      records[i] = await one(today[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(USAGE_DOWNLOADS, today.length) }, lane));
  return records.filter(Boolean);
}

/** One artifact's result.json; `gh run download` unpacks it, so nothing beyond gh is needed. */
async function downloadArtifactResult(repo, artifact, token) {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-"));
  try {
    await run("gh", ["run", "download", String(artifact.workflow_run?.id), "-n", artifact.name, "-D", dir, "-R", repo.full], { env: env(token), timeoutMs: 120_000 });
    const file = [join(dir, "result.json"), join(dir, "usage", "result.json")].find(existsSync);
    return file ? JSON.parse(readFileSync(file, "utf8")) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- jobs

/** The workflow file this run belongs to (GITHUB_WORKFLOW_REF), else factory.yml. */
export const workflowFile = (env = process.env) => /\/(\.github\/workflows\/([^@/]+))@/.exec(env.GITHUB_WORKFLOW_REF || "")?.[2] || "factory.yml";

/** Issue numbers with a worker job (`work (<n>)`) not yet completed in any live run of the workflow. Needs actions: read. */
export async function activeWorkIssues(repo, opts) {
  return (await activeFactoryJobs(repo, opts)).work;
}

/** The Objectives with a live Factory job, by kind: `work (N)` and `review (factory/N)` jobs not yet completed. */
export async function activeFactoryJobs(repo, opts) {
  const out = { work: new Set(), review: new Set() };
  for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
    const runs = (await rest(`repos/${repo.full}/actions/workflows/${workflowFile()}/runs?status=${status}&per_page=50`, opts).catch(() => null))?.workflow_runs || [];
    for (const run of runs) {
      const jobs = (await rest(`repos/${repo.full}/actions/runs/${run.id}/jobs?per_page=100`, opts).catch(() => null))?.jobs || [];
      for (const j of jobs) {
        if (j.status === "completed") continue;
        const w = /^work \((\d+)\)$/.exec(j.name || "");
        if (w) out.work.add(Number(w[1]));
        const r = /^review \(factory\/(\d+)\)$/.exec(j.name || "");
        if (r) out.review.add(Number(r[1]));
      }
    }
  }
  return out;
}

/** When the Objective label was last applied (a human's recovery re-applies it), or null. */
export async function objectiveLabeledAt(repo, number, label, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "labeled" && e.label?.name === label) last = e.created_at;
  return last;
}

/** When the issue last became Running (its `labeled factory:running` event), or null. */
export async function runningSince(repo, number, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "labeled" && e.label?.name === "factory:running") last = e.created_at;
  return last;
}

/** Whether an active ruleset puts a merge queue on the default branch. */
export async function hasMergeQueue(repo, opts) {
  const data = await getRepo(repo, opts);
  const branch = data.default_branch;
  for (const r of await listRulesets(repo, opts)) {
    if (r.target !== "branch" || r.enforcement !== "active") continue;
    const full = await rest(`repos/${repo.full}/rulesets/${r.id}`, opts).catch(() => null);
    const inc = full?.conditions?.ref_name?.include || [];
    if (!inc.some((i) => i === `refs/heads/${branch}` || i === "~DEFAULT_BRANCH")) continue;
    if ((full.rules || []).some((rule) => rule.type === "merge_queue")) return true;
  }
  return false;
}

// -------------------------------------------------------------- repo facts

export async function getRepo(repo, opts) {
  return rest(`repos/${repo.full}`, opts);
}

export async function listRulesets(repo, opts) {
  return (await rest(`repos/${repo.full}/rulesets?per_page=100`, opts)) || [];
}

/** Create or update the Factory ruleset on the default branch: merge queue (unless `queue: false`), required checks, no deletion/force push. */
export async function ensureRuleset(repo, { branch, checks, queue = true }, opts) {
  const existing = (await listRulesets(repo, opts)).find((r) => r.name === "factory");
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ["squash"] } },
  ];
  if (queue) rules.push({ type: "merge_queue", parameters: { merge_method: "SQUASH", max_entries_to_build: 5, min_entries_to_merge: 1, max_entries_to_merge: 5, min_entries_to_merge_wait_minutes: 5, grouping_strategy: "ALLGREEN", check_response_timeout_minutes: 60 } });
  if (checks.length) rules.push({ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: checks.map((context) => ({ context })) } });
  const body = {
    name: "factory",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules,
  };
  if (existing) return rest(`repos/${repo.full}/rulesets/${existing.id}`, { ...opts, method: "PUT", body });
  return rest(`repos/${repo.full}/rulesets`, { ...opts, method: "POST", body });
}

/**
 * Learn the repository's writers (push or more; org members and owners included, whatever their membership's
 * visibility) so trustedAuthor can tell them apart from strangers. Once per process per repository; a failed read
 * leaves the association check alone, logged.
 */
const WRITERS_TTL_MS = 10 * 60_000;
const primed = new Map();
export async function primeWriters(repo, opts) {
  // A long-lived loop (local serve) re-reads them, so access revoked meanwhile stops counting within minutes.
  if (Date.now() - (primed.get(repo.full) ?? -Infinity) < WRITERS_TTL_MS) return;
  try {
    const list = (await rest(`repos/${repo.full}/collaborators?affiliation=all&permission=push&per_page=100`, { ...opts, paginate: true })) || [];
    setWriters(repo.full, list.map((u) => u.login));
    primed.set(repo.full, Date.now());
    process.stdout.write(`[factory] ${list.length} writer(s) of ${repo.full} known\n`);
  } catch (e) {
    // Not marked primed: the next call tries again.
    process.stdout.write(`[factory] writers of ${repo.full} could not be read (${e.status || String(e.message).slice(0, 80)}); trusting by author association only\n`);
  }
}

export async function collaboratorPermission(repo, login, opts) {
  try {
    const d = await rest(`repos/${repo.full}/collaborators/${encodeURIComponent(login)}/permission`, opts);
    return d?.permission ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
