// GitHub REST and GraphQL through `gh api`, with the token the caller sets in GH_TOKEN.
// Every write the plan routes through the App (push, PR, review request, card move,
// merge) goes through here with the App token in env; the job token is never passed.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./proc.mjs";

/** Run gh (or unzip) and throw on non-zero exit, with stderr on the error. */
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
  const existing = (await listComments(repo, number, opts)).find((c) => (c.body || "").includes(marker));
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
    if (!/clean status|already|not in the correct state/i.test(String(e.stderr || e.message))) throw e;
    await run("gh", ["pr", "merge", String(number), "--repo", repo.full, "--squash"], { env: env(opts.token) });
    return "direct";
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

/** Usage artifacts uploaded today (UTC), as parsed result.json records. */
export async function todaysUsage(repo, { prefix = "factory-usage-", token, dateIso = new Date().toISOString().slice(0, 10), download } = {}) {
  // The artifacts endpoint wraps each page as {total_count, artifacts}; --slurp gives the pages.
  const pages = (await rest(`repos/${repo.full}/actions/artifacts?per_page=100`, { token, paginate: true })) || [];
  const artifacts = (Array.isArray(pages) ? pages : [pages]).flatMap((p) => (Array.isArray(p) ? p : p?.artifacts || []));
  const today = artifacts.filter((a) => a.name?.startsWith(prefix) && !a.expired && String(a.created_at || "").startsWith(dateIso));
  const records = [];
  for (const a of today) {
    try {
      const rec = await (download ?? downloadArtifactResult)(repo, a, token);
      if (rec) records.push({ artifact: a.name, ...rec });
    } catch (e) {
      records.push({ artifact: a.name, usd: null, basis: `unreadable: ${e.message.slice(0, 120)}` });
    }
  }
  return records;
}

async function downloadArtifactResult(repo, artifact, token) {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-"));
  const zip = join(dir, "a.zip");
  const { stdout } = await run("gh", ["api", `repos/${repo.full}/actions/artifacts/${artifact.id}/zip`], { env: env(token), encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(zip, stdout);
  await run("unzip", ["-o", "-q", zip, "-d", dir]);
  const file = [join(dir, "result.json"), join(dir, "usage", "result.json")].find(existsSync);
  return file ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// ------------------------------------------------------------------- jobs

/** The workflow file this run belongs to (GITHUB_WORKFLOW_REF), else factory.yml. */
export const workflowFile = (env = process.env) => /\/(\.github\/workflows\/([^@/]+))@/.exec(env.GITHUB_WORKFLOW_REF || "")?.[2] || "factory.yml";

/** Issue numbers with a worker job (`work (<n>)`) not yet completed in any live run of the workflow. Needs actions: read. */
export async function activeWorkIssues(repo, opts) {
  const out = new Set();
  for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
    const runs = (await rest(`repos/${repo.full}/actions/workflows/${workflowFile()}/runs?status=${status}&per_page=50`, opts).catch(() => null))?.workflow_runs || [];
    for (const run of runs) {
      const jobs = (await rest(`repos/${repo.full}/actions/runs/${run.id}/jobs?per_page=100`, opts).catch(() => null))?.jobs || [];
      for (const j of jobs) {
        const m = /^work \((\d+)\)$/.exec(j.name || "");
        if (m && j.status !== "completed") out.add(Number(m[1]));
      }
    }
  }
  return out;
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

export async function collaboratorPermission(repo, login, opts) {
  try {
    const d = await rest(`repos/${repo.full}/collaborators/${encodeURIComponent(login)}/permission`, opts);
    return d?.permission ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
