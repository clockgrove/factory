// Invented GitHub answers for one repository (acme/widgets, dates in 2031;
// nothing here names a real repository or person), in the shape
// lib/collect.mjs returns, so lib/objective.mjs can be scored without a
// token. Each scenario is one Objective.
import { handoverLine, handoverMarker, handoverText } from "../../../plugin/scripts/lib/handover.mjs";

const APP = { login: "acme-pendulum[bot]", type: "Bot" };
const OWNER = { login: "maintainer", type: "User" };
const WRITER = { login: "writer", type: "User" };
export const REPO = "acme/widgets";

const at = (day, h, m = 0) => `2031-03-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

function issue(number, { closed = null, labels = ["pendulum:objective"] } = {}) {
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
    head: { ref: `pendulum/${issueNumber}`, sha: headSha },
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
    issueTimeline: [labeled("pendulum:objective", OWNER, label), labeled("pendulum:running", APP, at(2, 1, 5)), { event: "commented", user: APP, created_at: at(2, 1, 12), body: `<!-- pendulum:${number}:plan -->\n## Plan\n1. ...` }, labeled("pendulum:in-review", APP, at(2, 2, 10)), { event: "unlabeled", label: { name: "pendulum:in-review" }, actor: APP, created_at: at(2, 3, 30) }, { event: "closed", actor: APP, created_at: at(2, 3, 30) }],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- pendulum:${number}:plan -->\n## Plan\n1. ...`)],
    pulls: [pr],
    pullDetails: {
      100: {
        commits: [commit("cafe0001", APP, at(2, 2, 0))],
        timeline: [{ event: "labeled", label: { name: "pendulum:review" }, actor: APP, created_at: at(2, 2, 11) }, { event: "merged", actor: APP, created_at: at(2, 3, 30) }],
        comments: [comment(APP, at(2, 2, 12), `<!-- pendulum:${number}:validated:cafe0001 -->\nValidation green.`)],
        reviews: [{ user: APP, state: "COMMENTED", submitted_at: at(2, 2, 40), body: `<!-- pendulum:${number}:review -->` }],
        reviewComments: [{ user: APP, created_at: at(2, 2, 40), body: "acceptance 1: quote values with commas" }, { user: APP, created_at: at(2, 2, 55), body: "Done in cafe0002." }],
      },
    },
    jobs: [{ id: 1, run: 10, name: `work (${number})`, started_at: at(2, 1, 3), completed_at: at(2, 2, 12), conclusion: "success" }, { id: 2, run: 11, name: "review", started_at: at(2, 2, 15), completed_at: at(2, 2, 58), conclusion: "success" }],
    artifacts: [],
    usage,
    harness: usage[0]?.harness ?? null,
    // Every input source read, and none had anything: no body edit, no person's Pendulum workflow run.
    bodyEdits: [],
    workflowRuns: [],
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
    issue: issue(number, { labels: ["pendulum:objective", "pendulum:blocked"] }),
    issueTimeline: [labeled("pendulum:objective", OWNER, label), labeled("pendulum:running", APP, at(2, 1, 5)), { event: "commented", user: APP, created_at: at(2, 1, 12), body: `<!-- pendulum:${number}:plan -->` }, labeled("pendulum:blocked", APP, at(2, 4, 0))],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- pendulum:${number}:plan -->\n## Plan`), comment(APP, at(2, 4, 0), `<!-- pendulum:${number}:blocked:work -->\n@maintainer Blocked (work): validation red after Pendulum's second pass — PR #102 is a draft with what exists. Fix by pushing to \`pendulum/${number}\` or editing the issue, then re-apply \`pendulum:objective\`.`)],
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
    issueTimeline: [labeled("pendulum:objective", OWNER, label), labeled("pendulum:running", APP, at(2, 1, 5)), labeled("pendulum:question", APP, at(2, 2, 10)), { event: "closed", actor: APP, created_at: at(3, 10, 0) }],
    issueComments: [comment(APP, at(2, 1, 12), `<!-- pendulum:${number}:plan -->\n## Plan`)],
    pulls: [pr],
    pullDetails: {
      103: {
        commits: [commit("f00d0004", APP, at(2, 2, 0)), commit("f00d0005", APP, at(3, 9, 0))],
        timeline: [{ event: "convert_to_draft", actor: APP, created_at: at(2, 2, 10) }, { event: "review_requested", actor: APP, created_at: at(2, 2, 10) }, { event: "ready_for_review", actor: OWNER, created_at: at(3, 8, 30) }, { event: "merged", actor: APP, created_at: at(3, 10, 0) }],
        comments: [comment(OWNER, at(3, 8, 29), "Keep the header as it is. Marking ready."), comment(APP, at(3, 9, 5), `<!-- pendulum:${number}:validated:f00d0005 -->`)],
        reviews: [{ user: APP, state: "COMMENTED", submitted_at: at(3, 8, 50), body: `<!-- pendulum:${number}:review -->` }],
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
  const head = encodeURIComponent(`acme:pendulum/${n}`);
  const calls = {
    [`${base}/issues/${n}`]: collected.issue,
    [`${base}/issues/${n}/timeline?per_page=100`]: collected.issueTimeline,
    [`${base}/issues/${n}/comments?per_page=100`]: collected.issueComments,
    [`${base}/pulls?head=${head}&state=open&per_page=100`]: collected.pulls.filter((p) => p.state === "open"),
    [`${base}/pulls?head=${head}&state=closed&per_page=100`]: collected.pulls.filter((p) => p.state !== "open"),
    // The artifacts name the runs whose jobs are counted: the worker's run and each review run.
    [`${base}/actions/artifacts?name=pendulum-usage-${n}&per_page=100`]: [{ artifacts: collected.jobs.filter((j) => j.name.startsWith("work")).map((j) => ({ id: j.id * 100, name: `pendulum-usage-${n}`, expired: false, created_at: j.completed_at, workflow_run: { id: j.run } })) }],
    [`${base}/actions/artifacts?name=pendulum-usage-${n}-review&per_page=100`]: [{ artifacts: collected.jobs.filter((j) => j.name === "review").map((j) => ({ id: j.id * 100, name: `pendulum-usage-${n}-review`, expired: false, created_at: j.completed_at, workflow_run: { id: j.run } })) }],
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

/**
 * Local mode: Pendulum works as the operator's own login (`dev`). A clean run: work and review stages, each a progress
 * comment with its spend line; the merge queue merged 40 minutes after the review's last write, as `dev` (who armed
 * auto-merge), and GitHub closed the PR and the issue and deleted the branch right after it, as `dev` too.
 */
export const OPERATOR = { login: "dev", type: "User" };
export function localMerge(number = 60) {
  const t = (h, m, s = 0) => `2031-03-02T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;
  const progress = (kind, id, created, updated, lines, spend) => ({ id, user: OPERATOR, created_at: created, updated_at: updated, body: `<!-- pendulum:${number}:progress:${kind}:${id} -->\nPendulum ${kind} run ${id}\n${lines.join("\n")}${spend === null ? "" : `\n<!-- pendulum:spend ${JSON.stringify(spend)} -->`}` });
  const work = progress("work", 1700000001, t(1, 1), t(1, 40), ["- 01:01Z install", "- 01:02Z harness codex (gpt-test) attempt 1", "- 01:40Z exit: delivered; usd 1.25"], { usd: 1.25 });
  const review = progress("review", 1700000002, t(1, 41), t(1, 50), ["- 01:41Z reviewer gpt-test", "- 01:50Z exit: delivered; usd 0.25"], { usd: 0.25 });
  const plan = { id: 9, user: OPERATOR, created_at: t(1, 5), updated_at: t(1, 5), body: `<!-- pendulum:${number}:plan -->\n## Plan` };
  const merged = t(2, 30);
  return {
    repository: REPO,
    issue: { ...issue(number, { closed: t(2, 30, 2), labels: ["pendulum:objective", "pendulum:local"] }), user: OPERATOR },
    issueTimeline: [
      labeled("pendulum:objective", OPERATOR, t(1, 0)),
      labeled("pendulum:running", OPERATOR, t(1, 1)),
      { event: "commented", user: OPERATOR, actor: OPERATOR, created_at: work.created_at, body: work.body },
      { event: "unlabeled", label: { name: "pendulum:running" }, actor: OPERATOR, created_at: t(1, 40) },
      labeled("pendulum:in-review", OPERATOR, t(1, 40, 2)),
      { event: "closed", actor: OPERATOR, created_at: t(2, 30, 2) },
      { event: "unlabeled", label: { name: "pendulum:in-review" }, actor: OPERATOR, created_at: t(2, 30, 20) },
    ],
    issueComments: [work, plan, review],
    pulls: [{ ...pull(200, number, { created: t(1, 20), merged, mergedBy: OPERATOR }), user: OPERATOR }],
    pullDetails: {
      200: {
        commits: [commit("aaaa0001", OPERATOR, t(1, 30))],
        timeline: [
          { event: "ready_for_review", actor: OPERATOR, created_at: t(1, 40) },
          { event: "labeled", label: { name: "pendulum:review" }, actor: OPERATOR, created_at: t(1, 40, 1) },
          { event: "added_to_merge_queue", actor: OPERATOR, created_at: t(1, 50) },
          { event: "removed_from_merge_queue", actor: { login: "github-merge-queue[bot]", type: "Bot" }, created_at: merged },
          { event: "merged", actor: OPERATOR, created_at: merged },
          { event: "closed", actor: OPERATOR, created_at: merged },
          { event: "head_ref_deleted", actor: OPERATOR, created_at: t(2, 30, 2) },
        ],
        comments: [{ user: OPERATOR, created_at: t(1, 40), body: `<!-- pendulum:${number}:validated:aaaa0001 -->\nPendulum: validation green.` }],
        reviews: [{ user: OPERATOR, state: "COMMENTED", submitted_at: t(1, 45), body: "One finding." }],
        reviewComments: [],
      },
    },
    jobs: [],
    artifacts: [],
    usage: [],
    harness: null,
    bodyEdits: [],
    workflowRuns: [],
  };
}

/** The workflow change the hand-over fixtures carry: git's own diff of one workflow file. */
export const HANDOVER_PATCH = "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1,2 @@\n on: push\n+  workflow_dispatch:\n";

/**
 * A merged Objective with a workflow hand-over, from a scenario above (`collected`): its merged PR's body carries
 * Pendulum's hand-over line, and Pendulum's comment holding the patch is on the issue (posted by `by`, Pendulum's login on
 * that route; `posted: false` leaves it out), as handoff.mjs publishPr leaves them.
 */
export function withHandover(collected, { posted = true, by = APP } = {}) {
  const n = collected.issue.number;
  const pr = collected.pulls.find((p) => p.merged_at);
  const files = [".github/workflows/ci.yml"];
  pr.body = `${handoverLine({ issue: n, url: `https://github.test/${REPO}/issues/${n}`, files })}\n\n## Undone\n- the manual trigger: handed over\n\nCloses #${n}\n`;
  if (posted) collected.issueComments.push({ user: by, created_at: pr.created_at, updated_at: pr.created_at, body: `${handoverMarker(n)}\n${handoverText({ issue: n, pr: pr.number, patch: HANDOVER_PATCH, files })}` });
  return collected;
}
