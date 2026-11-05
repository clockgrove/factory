// Invented GitHub answers for one repository (acme/widgets, dates in 2031;
// nothing here names a real repository or person), in the shape
// lib/collect.mjs returns, so lib/objective.mjs can be scored without a
// token. Each scenario is one Objective.
const APP = { login: "acme-factory[bot]", type: "Bot" };
const OWNER = { login: "maintainer", type: "User" };
const WRITER = { login: "writer", type: "User" };
export const REPO = "acme/widgets";

const at = (day, h, m = 0) => `2031-03-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

function issue(number, { closed = null, labels = ["factory:objective"] } = {}) {
  return {
    number,
    title: `Objective ${number}: export widgets as CSV`,
    state: closed ? "closed" : "open",
    created_at: at(1, 9),
    closed_at: closed,
    labels: labels.map((name) => ({ name })),
    user: WRITER,
    body: "## Goal\nExport widgets as CSV.\n## Acceptance\n- values are quoted",
  };
}

function commit(sha, actor, date, { linked = true } = {}) {
  const bot = actor.type === "Bot";
  return {
    sha,
    author: linked ? actor : null,
    commit: { author: { name: actor.login, email: bot ? `12345+${actor.login}@users.noreply.github.com` : `${actor.login}@example.test`, date }, committer: { name: actor.login, email: bot ? `12345+${actor.login}@users.noreply.github.com` : `${actor.login}@example.test`, date } },
  };
}

function pull(number, issueNumber, { created, merged = null, draft = false, state = "open", body = `Closes #${issueNumber}`, mergedBy = APP, headSha = "cafe0001" }) {
  return {
    number,
    state: merged ? "closed" : state,
    draft,
    title: `#${issueNumber}: export widgets as CSV`,
    body,
    user: APP,
    created_at: created,
    merged_at: merged,
    merged_by: merged ? mergedBy : null,
    merge_commit_sha: merged ? `merge${number}00` : null,
    head: { ref: `factory/${issueNumber}`, sha: headSha },
    base: { ref: "main", sha: "base0000" },
  };
}

const labeled = (name, actor, created_at) => ({ event: "labeled", label: { name }, actor, created_at });
const comment = (user, created_at, body) => ({ user, created_at, body });

/** A clean merge: the App did everything after the label; the reviewer commented; the queue merged. */
export function cleanMerge(number = 42, usage = []) {
  const label = at(2, 1);
  const pr = pull(100, number, { created: at(2, 2, 10), merged: at(2, 3, 30) });
  return {
    repository: REPO,
    issue: issue(number, { closed: at(2, 3, 30) }),
    issueTimeline: [labeled("factory:objective", OWNER, label), labeled("factory:running", APP, at(2, 1, 5)), { event: "commented", user: APP, created_at: at(2, 1, 12), body: `<!-- factory:${number}:plan -->\n## Plan\n1. ...` }, labeled("factory:in-review", APP, at(2, 2, 10)), { event: "unlabeled", label: { name: "factory:in-review" }, actor: APP, created_at: at(2, 3, 30) }, { event: "closed", actor: APP, created_at: at(2, 3, 30) }],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- factory:${number}:plan -->\n## Plan\n1. ...`)],
    pulls: [pr],
    pullDetails: {
      100: {
        commits: [commit("cafe0001", APP, at(2, 2, 0))],
        timeline: [{ event: "labeled", label: { name: "factory:review" }, actor: APP, created_at: at(2, 2, 11) }, { event: "merged", actor: APP, created_at: at(2, 3, 30) }],
        comments: [comment(APP, at(2, 2, 12), `<!-- factory:${number}:validated:cafe0001 -->\nValidation green.`)],
        reviews: [{ user: APP, state: "COMMENTED", submitted_at: at(2, 2, 40), body: `<!-- factory:${number}:review -->` }],
        reviewComments: [{ user: APP, created_at: at(2, 2, 40), body: "acceptance 1: quote values with commas" }, { user: APP, created_at: at(2, 2, 55), body: "Done in cafe0002." }],
      },
    },
    jobs: [{ id: 1, run: 10, name: `work (${number})`, started_at: at(2, 1, 3), completed_at: at(2, 2, 12), conclusion: "success" }, { id: 2, run: 11, name: "review", started_at: at(2, 2, 15), completed_at: at(2, 2, 58), conclusion: "success" }],
    artifacts: [],
    usage,
    harness: usage[0]?.harness ?? null,
  };
}

/** The same Objective, but the owner pushed a fix to the branch before it merged. */
export function humanPush(number = 43, usage = []) {
  const c = cleanMerge(number, usage);
  c.pulls[0].number = 101;
  c.pullDetails[101] = c.pullDetails[100];
  delete c.pullDetails[100];
  c.pullDetails[101].commits.push(commit("beef0002", OWNER, at(2, 3, 0)));
  return c;
}

/** A Blocked card: validation red twice; the PR is a draft; the issue is open with the label and comment. */
export function blocked(number = 44, usage = []) {
  const label = at(2, 1);
  return {
    repository: REPO,
    issue: issue(number, { labels: ["factory:objective", "factory:blocked"] }),
    issueTimeline: [labeled("factory:objective", OWNER, label), labeled("factory:running", APP, at(2, 1, 5)), { event: "commented", user: APP, created_at: at(2, 1, 12), body: `<!-- factory:${number}:plan -->` }, labeled("factory:blocked", APP, at(2, 4, 0))],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- factory:${number}:plan -->\n## Plan`), comment(APP, at(2, 4, 0), `<!-- factory:${number}:blocked:work -->\n@maintainer Blocked (work): validation red after Factory's second pass — PR #102 is a draft with what exists. Fix by pushing to \`factory/${number}\` or editing the issue, then re-apply \`factory:objective\`.`)],
    pulls: [pull(102, number, { created: at(2, 3, 50), draft: true, headSha: "dead0003" })],
    pullDetails: { 102: { commits: [commit("dead0003", APP, at(2, 3, 40))], timeline: [{ event: "convert_to_draft", actor: APP, created_at: at(2, 4, 0) }], comments: [], reviews: [], reviewComments: [] } },
    jobs: [{ id: 3, run: 12, name: `work (${number})`, started_at: at(2, 1, 3), completed_at: at(2, 4, 1), conclusion: "failure" }],
    artifacts: [],
    usage,
    harness: usage[0]?.harness ?? null,
  };
}

/** A Question: the worker opened a draft with QUESTION in its body; the owner answered and marked it ready; it merged. */
export function questionAnswered(number = 45, usage = []) {
  const label = at(2, 1);
  const pr = pull(103, number, { created: at(2, 2, 10), merged: at(3, 10, 0), body: `Closes #${number}\n\n## Assumptions\n1. QUESTION: does the export change the public CSV header? I assumed not.`, headSha: "f00d0004" });
  return {
    repository: REPO,
    issue: issue(number, { closed: at(3, 10, 0) }),
    issueTimeline: [labeled("factory:objective", OWNER, label), labeled("factory:running", APP, at(2, 1, 5)), labeled("factory:question", APP, at(2, 2, 10)), { event: "closed", actor: APP, created_at: at(3, 10, 0) }],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- factory:${number}:plan -->\n## Plan`)],
    pulls: [pr],
    pullDetails: {
      103: {
        commits: [commit("f00d0004", APP, at(2, 2, 0)), commit("f00d0005", APP, at(3, 9, 0))],
        timeline: [{ event: "convert_to_draft", actor: APP, created_at: at(2, 2, 10) }, { event: "review_requested", actor: APP, created_at: at(2, 2, 10) }, { event: "ready_for_review", actor: OWNER, created_at: at(3, 8, 30) }, { event: "merged", actor: APP, created_at: at(3, 10, 0) }],
        comments: [comment(OWNER, at(3, 8, 29), "Keep the header as it is. Marking ready."), comment(APP, at(3, 9, 5), `<!-- factory:${number}:validated:f00d0005 -->`)],
        reviews: [{ user: APP, state: "COMMENTED", submitted_at: at(3, 8, 50), body: `<!-- factory:${number}:review -->` }],
        reviewComments: [],
      },
    },
    jobs: [{ id: 4, run: 13, name: `work (${number})`, started_at: at(2, 1, 3), completed_at: at(2, 2, 12), conclusion: "success" }, { id: 5, run: 14, name: "review", started_at: at(3, 8, 32), completed_at: at(3, 9, 10), conclusion: "success" }],
    artifacts: [],
    usage,
    harness: usage[0]?.harness ?? null,
  };
}

/** A snapshot of the REST calls lib/collect.mjs makes for a clean merge, so score.mjs --replay can be tested end to end. */
export function snapshotOf(collected) {
  const base = `repos/${REPO}`;
  const n = collected.issue.number;
  const head = encodeURIComponent(`acme:factory/${n}`);
  const calls = {
    [`${base}/issues/${n}`]: collected.issue,
    [`${base}/issues/${n}/timeline?per_page=100`]: collected.issueTimeline,
    [`${base}/issues/${n}/comments?per_page=100`]: collected.issueComments,
    [`${base}/pulls?head=${head}&state=open&per_page=100`]: collected.pulls.filter((p) => p.state === "open"),
    [`${base}/pulls?head=${head}&state=closed&per_page=100`]: collected.pulls.filter((p) => p.state !== "open"),
    // The artifacts name the runs whose jobs are counted: the worker's run and each review run.
    [`${base}/actions/artifacts?name=factory-usage-${n}&per_page=100`]: [{ artifacts: collected.jobs.filter((j) => j.name.startsWith("work")).map((j) => ({ id: j.id * 100, name: `factory-usage-${n}`, expired: false, created_at: j.completed_at, workflow_run: { id: j.run } })) }],
    [`${base}/actions/artifacts?name=factory-usage-${n}-review&per_page=100`]: [{ artifacts: collected.jobs.filter((j) => j.name === "review").map((j) => ({ id: j.id * 100, name: `factory-usage-${n}-review`, expired: false, created_at: j.completed_at, workflow_run: { id: j.run } })) }],
  };
  for (const pr of collected.pulls) {
    const d = collected.pullDetails[pr.number];
    calls[`${base}/pulls/${pr.number}`] = pr;
    calls[`${base}/pulls/${pr.number}/commits?per_page=100`] = d.commits;
    calls[`${base}/issues/${pr.number}/timeline?per_page=100`] = d.timeline;
    calls[`${base}/issues/${pr.number}/comments?per_page=100`] = d.comments;
    calls[`${base}/pulls/${pr.number}/reviews?per_page=100`] = d.reviews;
    calls[`${base}/pulls/${pr.number}/comments?per_page=100`] = d.reviewComments;
  }
  for (const j of collected.jobs) calls[`${base}/actions/runs/${j.run}/jobs?per_page=100`] = [{ jobs: [{ id: j.id, name: j.name, started_at: j.started_at, completed_at: j.completed_at, conclusion: j.conclusion }] }];
  return { repository: REPO, issues: [n], calls };
}
