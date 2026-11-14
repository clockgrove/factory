import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { decideExit, planAskedMarker, planAskedOf, setSelf, staleDecision } from "../scripts/lib/logic.mjs";
import { DECLARE_KEY, NEED_KEY, answeredRepos, declaredQuestion, declaredRepos, planNeeds, plannedRepos } from "../scripts/lib/one-repo.mjs";
import { applyExit, crashed, questionNotice } from "../scripts/lib/session.mjs";

const source = { owner: "acme", name: "platform", full: "acme/platform" };
const BOT = "factory-app[bot]";
setSelf(BOT);
const ask = (plan, opts = {}) => planNeeds(plan, { source, label: "factory:objective", ...opts }).reason || "";

test("one repository: an issue body naming another repository is a Question before any harness, asking the owner to split it", () => {
  const body = "Add the export format.\n\nFactory-Repository: acme/world allow .github/workflows/ci.yml\n";
  assert.equal(
    declaredQuestion(body, { source, label: "factory:objective" }),
    "the issue names acme/world on a Factory-Repository line, and Factory works in one repository per Objective; split it into one Objective per repository (this one changes only acme/platform), remove the line and re-apply factory:objective",
  );
  assert.deepEqual(declaredRepos(body, source), ["acme/world"]);
  assert.deepEqual(declaredRepos("- factory-repository: `Acme/World`\nFactory-Repository: acme/infra", source), ["Acme/World", "acme/infra"], "any case, a list item, backticks");
  assert.match(declaredQuestion("Factory-Repository: acme/world\nFactory-Repository: acme/infra", { source }), /names acme\/world, acme\/infra on a/);
  // This repository named on the line is no other repository; a line in a code fence, or in prose, is no line.
  assert.equal(declaredQuestion("Factory-Repository: Acme/Platform", { source }), "");
  assert.equal(declaredQuestion("```\nFactory-Repository: acme/world\n```", { source }), "");
  assert.equal(declaredQuestion("It once had a Factory-Repository: acme/world line.", { source }), "");
  assert.equal(declaredQuestion("Factory-Repository: <!-- x --> @someone", { source }), "", "the author's words never reach the Question");
  assert.equal(declaredQuestion("", { source }), "");
  assert.ok(!declaredQuestion("Factory-Repository: acme/world", { source }).includes("\n"), "one line");
});

test("one repository: the worker and the session's deliver ask the body's Question before any harness, branch or push", () => {
  const worker = readFileSync(join(PLUGIN_ROOT, "scripts", "worker.mjs"), "utf8");
  const run = worker.indexOf("async function run()");
  const at = worker.indexOf("declaredQuestion(", run);
  assert.ok(at > worker.indexOf("await authorGate(", run), "on the body the trust check read");
  for (const later of ["openOutbox(", "installPlugin(", "runHarness(", "openHandoff("]) assert.ok(worker.indexOf(later, run) > at, `before ${later}`);
  assert.match(worker.slice(at, at + 500), /findPr\(repo, `factory\/\$\{issue\}`[^\n]*\n[^\n]*pr: asking, exit: "question", reason: named, [^\n]*askOnIssue: true/, "an open PR goes back to a draft with the Question");
  const local = readFileSync(join(PLUGIN_ROOT, "scripts", "local.mjs"), "utf8");
  const deliver = local.indexOf("async function deliver(");
  const q = local.indexOf("declaredQuestion(", deliver);
  assert.ok(q > deliver && q < local.indexOf("openOutbox(", deliver), "deliver asks it before Factory's push");
});

test("one repository: the body's Question puts an open, conflicting PR back to a draft, so the dispatcher sends it back for no rebase", async () => {
  const pr = { number: 7, node_id: "PR_7", draft: false, mergeable_state: "dirty", head: { sha: "abc" }, user: { login: "factory[bot]" } };
  assert.equal(staleDecision({ pr }), "rebase", "the loop: a ready, conflicting PR is sent back each tick");
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || "GET", body });
    if (/\/graphql$/.test(String(url)) && /convertPullRequestToDraft/.test(body.query)) pr.draft = true;
    const json = /\/pulls\/7$/.test(String(url)) ? pr : /\/graphql$/.test(String(url)) ? { data: {} } : /\/comments(\?|$)/.test(String(url)) && (init.method || "GET") === "GET" ? [] : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const reason = declaredQuestion("Factory-Repository: acme/world", { source });
    await applyExit({ owner: "acme", name: "platform", full: "acme/platform" }, { issue: 2, pr, exit: "question", reason, notify: "kirk", stage: "work", askOnIssue: true }, { token: "t" });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(calls.some((c) => /convertPullRequestToDraft/.test(c.body?.query || "")), "the PR goes back to a draft");
  assert.ok(!calls.some((c) => /requested_reviewers/.test(c.url)), "asked on the issue: no review request");
  assert.ok(calls.some((c) => c.method === "POST" && /\/issues\/2\/comments$/.test(c.url) && /Question \(work\)/.test(c.body?.body || "")), "the Question is on the issue");
  assert.equal(staleDecision({ pr }), "ignore", "a draft is never sent back");
});

test("plan-time Question: only a Needs-Repository line outside code fences names a repository the plan needs; any other value is no need, counted and never repeated", () => {
  const plan = [
    "## Checklist",
    "1. Add the job (`.github/workflows/ci.yml` there).",
    "Needs-Repository: acme/world the CI workflow that consumes the platform lives there",
    "- needs-repository: `Acme/World`: same one, other spelling",
    "* Needs-Repository: acme/infra.",
    "```",
    "Needs-Repository: evil/inside-fence",
    "```",
    "Needs-Repository: the world repo, <!-- x --> @someone",
    "It mentions Needs-Repository: acme/inline in prose",
  ].join("\n");
  assert.deepEqual(plannedRepos(plan), { repos: ["acme/world", "acme/infra"], ignored: 1 });
  assert.deepEqual(plannedRepos(""), { repos: [], ignored: 0 });
  assert.deepEqual(plannedRepos(null), { repos: [], ignored: 0 });
  // The shapes a model writes the line in: a numbered or nested item, a blockquote, a bold key or value, a link, a URL.
  for (const line of ["1. Needs-Repository: acme/deploy", "  2) Needs-Repository: acme/deploy why", "> Needs-Repository: acme/deploy", "> - Needs-Repository: acme/deploy", "**Needs-Repository:** acme/deploy", "- **Needs-Repository**: `acme/deploy` the manifest", "Needs-Repository: **acme/deploy**", "Needs-Repository: [acme/deploy](https://github.com/acme/deploy)", "Needs-Repository: https://github.com/acme/deploy/", "- [ ] Needs-Repository: acme/deploy the manifest", "* [x] **Needs-Repository:** acme/deploy", "Needs-Repository: [the deploy repository](https://github.com/acme/deploy) why", "Needs-Repository: <https://github.com/acme/deploy>", "Needs-Repository: github.com/acme/deploy.", "Needs-Repository: http://www.github.com/acme/deploy.git", "Needs-Repository: https://github.com/acme/deploy/blob/main/deploy.yml", "Needs-Repository: **`acme/deploy`**"]) {
    assert.deepEqual(plannedRepos(line), { repos: ["acme/deploy"], ignored: 0 }, line);
  }
  // A placeholder is how a plan says there is none: no need, so no Question. One character each side (N/A) is never a repository.
  for (const line of ["Needs-Repository: none", "Needs-Repository: None.", "Needs-Repository: N/A (all here)", "- Needs-Repository: n/a", "Needs-Repository: -", "Needs-Repository:", "Needs-Repository:   ", "- Needs-Repository: (dropped: owner said do without)", "Needs-Repository: ~~acme/deploy~~ (dropped)", "Needs-Repository: nothing outside this repository", "Needs-Repository: [none](https://example.com)", "Needs-Repository: https://github.com/acme", "- [ ] Needs-Repository: none"]) {
    assert.equal(plannedRepos(line).repos.length, 0, line);
    assert.equal(plannedRepos(line).ignored, 1, line);
    assert.equal(ask(line), "", line);
  }
  assert.equal(plannedRepos("~~Needs-Repository: acme/deploy~~").ignored, 0, "a struck-through line is no line");
  assert.deepEqual(plannedRepos("Needs-Repository: x/deploy").repos, ["x/deploy"], "control: a one-character owner with a longer name is a repository");
});

test("plan-time Question: a plan that needs another repository asks the owner to split the Objective, one per repository; this repository is no other", () => {
  assert.equal(ask("Needs-Repository: acme/platform the plan names this repository"), "", "this repository is no other");
  assert.equal(ask("no such line\n```\nNeeds-Repository: acme/world\n```"), "", "inside a fence it is no line");
  assert.equal(
    ask("Needs-Repository: acme/world the CI there"),
    "the plan needs a change in acme/world, and Factory works in one repository per Objective; split it into one Objective per repository and re-apply factory:objective, or answer in a comment how to do the work in acme/platform alone",
  );
  assert.match(ask("Needs-Repository: acme/infra\nNeeds-Repository: acme/world"), /^the plan needs a change in acme\/infra, acme\/world, and Factory works in one repository per Objective; /);
  // The harness's words never reach the issue: a value that is no OWNER/NAME asks nothing.
  assert.equal(ask("Needs-Repository: <!-- hidden --> @someone closes #1"), "");
  assert.equal(ask("Needs-Repository: <!-- hidden --> @someone\nNeeds-Repository: acme/world"), ask("Needs-Repository: acme/world"));
  assert.ok(!ask("Needs-Repository: acme/world").includes("\n"), "one line");
  assert.deepEqual(planNeeds("Needs-Repository: Acme/World", { source }).repos, ["Acme/World"], "the repositories asked about, recorded with the ask");
  assert.deepEqual(planNeeds("Needs-Repository: none", { source }), {});
});

test("plan-time Question: one a maintainer answered since Factory asked is not asked again, whatever the plan line still says", () => {
  const asked = { "acme/deploy": "2026-11-09T10:00:00Z" };
  const d = (body, at, seen = at) => ({ author: "owner", at, seen, body, key: `comment:${at}` });
  const after = "2026-11-09T10:05:00Z";
  assert.deepEqual([...answeredRepos(asked, [d("Do without acme/deploy: ops changes the manifest by hand.", after)])], ["acme/deploy"]);
  assert.deepEqual([...answeredRepos(asked, [d("Skip `Acme/Deploy`.", after)])], ["acme/deploy"], "any case, in backticks");
  assert.deepEqual([...answeredRepos(asked, [d("see https://github.com/acme/deploy/pull/3", after)])], ["acme/deploy"], "in a URL");
  assert.deepEqual([...answeredRepos(asked, [d("Do without acme/deploy", "2026-11-09T09:00:00Z")])], [], "a decision before the ask answers nothing");
  assert.deepEqual([...answeredRepos(asked, [d("Do without acme/deploy", "2026-11-09T09:00:00Z", after)])], ["acme/deploy"], "edited after it, it does");
  assert.deepEqual([...answeredRepos(asked, [d("Do without it", after)])], [], "an answer that names no repository is the harness's to apply");
  for (const other of ["acme/deploy-tools", "acme/deployment", "xacme/deploy", "acme/deploy.js"]) assert.deepEqual([...answeredRepos(asked, [d(`about ${other}`, after)])], [], other);
  assert.deepEqual([...answeredRepos(asked, [d("acme/deploy.", after)])], ["acme/deploy"], "a sentence's full stop");
  assert.deepEqual([...answeredRepos({}, [d("acme/deploy", after)])], [], "nothing asked, nothing answered");
  const plan = "## Assumptions\n1. Needs-Repository: acme/deploy (dropped per the owner's decision)";
  const answered = answeredRepos(asked, [d("do without acme/deploy", after)]);
  assert.equal(ask(plan, { answered }), "");
  assert.match(ask(plan), /needs a change in acme\/deploy/, "control: unanswered, it is asked");
  assert.match(ask(`${plan}\nNeeds-Repository: acme/infra`, { answered }), /needs a change in acme\/infra, and/, "another repository is still asked about");
});

test("plan-time Question: the mid-run stop never stops a rerun for a repository a maintainer replied about since the ask", () => {
  const asked = { "acme/deploy": "2026-11-09T10:00:00Z" };
  const d = (body, at) => ({ author: "owner", at, seen: at, body, key: `comment:${at}` });
  const reply = [d("Do without it: ops changes the manifest by hand.", "2026-11-09T10:05:00Z")];
  assert.deepEqual([...answeredRepos(asked, reply)], []);
  assert.deepEqual([...answeredRepos(asked, reply, { named: false })], ["acme/deploy"]);
  const stopSet = new Set([...answeredRepos(asked, reply), ...answeredRepos(asked, reply, { named: false })]);
  const copied = "## Plan\nNeeds-Repository: acme/deploy the manifest";
  assert.deepEqual(planNeeds(copied, { source, answered: stopSet }), {}, "the plan copied from the last run does not stop it");
  assert.match(ask(`${copied}\nNeeds-Repository: acme/infra`, { answered: stopSet }), /acme\/infra/, "a repository never asked about still stops it");
  assert.deepEqual([...answeredRepos(asked, [d("Do without it", "2026-11-09T09:00:00Z")], { named: false })], [], "a reply before the ask is no answer");
});

test("plan-time Question: the ask is recorded in Factory's own progress comment, and only its own record counts", () => {
  const at = "2026-11-09T10:00:00Z";
  const own = (body, login = BOT) => ({ user: { login }, body });
  const rec = planAskedMarker({ "acme/deploy": at });
  assert.equal(rec, `<!-- factory:plan-asked {"acme/deploy":"${at}"} -->`);
  const progress = (extra) => `<!-- factory:7:progress:work:1 -->\nFactory work run 1: started\n${extra}`;
  assert.deepEqual(planAskedOf([own(progress(rec))], { issue: 7, self: BOT }), { "acme/deploy": at });
  assert.deepEqual(planAskedOf([own(progress(rec), "someone")], { issue: 7, self: BOT }), {}, "someone else's comment");
  assert.deepEqual(planAskedOf([own(progress(rec))], { issue: 7, self: null }), {}, "Factory's login unknown: nothing counts");
});

test("plan-time Question: the issue comment says to answer on the issue, never to mark the PR ready", () => {
  const reason = ask("Needs-Repository: acme/deploy");
  assert.equal(questionNotice({ at: "@owner ", reason, askOnIssue: true }), `@owner Question (work): ${reason}.`);
  const withPr = questionNotice({ at: "@owner ", reason, pr: { number: 12 }, askOnIssue: true });
  assert.equal(withPr, `@owner Question (work): ${reason}. PR #12 stays a draft: answer here on the issue, not by marking it ready, which would start its review and merge it without the rest of the work.`);
  assert.ok(!withPr.includes("\n"), "one line");
});

test("plan-time Question: a harness Factory stopped is no crash, so it is not run again", () => {
  const rec = { ok: false, timedOut: false, budgetExceeded: false, signal: "SIGTERM", exitCode: null };
  assert.equal(crashed(rec), true, "control: killed by a signal it did not expect");
  assert.equal(crashed({ ...rec, stopped: true }), false);
});

test("plan-time Question: the exit is a Question even with no commit and no PR, after the hard stops and before every other check", () => {
  const planNeedsReason = ask("Needs-Repository: acme/world");
  const harness = { ok: true };
  assert.deepEqual(decideExit({ harness, pr: null, commits: 0, planNeeds: planNeedsReason }), { exit: "question", reason: planNeedsReason });
  assert.deepEqual(decideExit({ harness: { ok: false, error: "stopped by Factory", unmetered: true }, pr: null, commits: 0, planNeeds: planNeedsReason }), { exit: "question", reason: planNeedsReason });
  assert.equal(decideExit({ harness, pr: null, commits: 0 }).reason, "worker ended without commits or a PR", "control: without it, an empty run Blocks");
  const pr = { exists: true, draft: true, body: "" };
  assert.equal(decideExit({ harness: { ok: false, error: "max turns" }, pr, commits: 3, validation: { passes: 1, green: false }, record: { exit: "blocked", reason: "x" }, planNeeds: planNeedsReason }).exit, "question");
  assert.equal(decideExit({ harness: { ok: true, died: 2 }, pr: null, commits: 0, planNeeds: planNeedsReason }).reason, "worker process died twice");
  assert.equal(decideExit({ harness: { ok: true, budgetExceeded: true }, pr: null, commits: 0, planNeeds: planNeedsReason }).reason, "dollar cap reached");
  assert.equal(decideExit({ harness, pr, commits: 1, protectedHits: [".github/x"], planNeeds: planNeedsReason }).exit, "blocked");
});

test("plan-time Question: the factory-objective-plan skill names the plan line Factory reads and the one-repository rule", () => {
  const skill = readFileSync(join(PLUGIN_ROOT, "skills", "factory-objective-plan", "SKILL.md"), "utf8");
  assert.ok(skill.includes(`\`${NEED_KEY}: OWNER/NAME\``), "the plan line, as plannedRepos reads it");
  assert.match(skill, /one repository per Objective/);
  assert.match(skill, /`question` exit record \(test `access`\)/);
  assert.ok(!skill.includes(DECLARE_KEY), "the skill never offers the issue line");
});
