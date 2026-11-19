import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit, planAskedMarker, planAskedOf, setSelf } from "../scripts/lib/logic.mjs";
import { answeredRepos, declaredQuestion, declaredRepos, planNeeds, plannedRepos } from "../scripts/lib/one-repo.mjs";

const source = { owner: "acme", name: "platform", full: "acme/platform" };
const BOT = "pendulum-app[bot]";
setSelf(BOT);
const ask = (plan, opts = {}) => planNeeds(plan, { source, label: "pendulum:objective", ...opts }).reason || "";

test("one repository: an issue body naming another repository is a Question before any harness, asking the owner to split it", () => {
  const body = "Add the export format.\n\nPendulum-Repository: acme/world allow .github/workflows/ci.yml\n";
  assert.equal(
    declaredQuestion(body, { source, label: "pendulum:objective" }),
    "the issue names acme/world on a Pendulum-Repository line, and Pendulum works in one repository per Objective; split it into one Objective per repository (this one changes only acme/platform), remove the line and resume through Draft",
  );
  assert.deepEqual(declaredRepos(body, source), ["acme/world"]);
  assert.deepEqual(declaredRepos("- pendulum-repository: `Acme/World`\nPendulum-Repository: acme/infra", source), ["Acme/World", "acme/infra"], "any case, a list item, backticks");
  assert.match(declaredQuestion("Pendulum-Repository: acme/world\nPendulum-Repository: acme/infra", { source }), /names acme\/world, acme\/infra on a/);
  // This repository named on the line is no other repository; a line in a code fence, or in prose, is no line.
  assert.equal(declaredQuestion("Pendulum-Repository: Acme/Platform", { source }), "");
  assert.equal(declaredQuestion("```\nPendulum-Repository: acme/world\n```", { source }), "");
  assert.equal(declaredQuestion("It once had a Pendulum-Repository: acme/world line.", { source }), "");
  assert.equal(declaredQuestion("Pendulum-Repository: <!-- x --> @someone", { source }), "", "the author's words never reach the Question");
  assert.equal(declaredQuestion("", { source }), "");
  assert.ok(!declaredQuestion("Pendulum-Repository: acme/world", { source }).includes("\n"), "one line");
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

test("plan-time Question: one a maintainer answered since Pendulum asked is not asked again, whatever the plan line still says", () => {
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

test("plan-time Question: the ask is recorded in Pendulum's own progress comment, and only its own record counts", () => {
  const at = "2026-11-09T10:00:00Z";
  const own = (body, login = BOT) => ({ user: { login }, body });
  const rec = planAskedMarker({ "acme/deploy": at });
  assert.equal(rec, `<!-- pendulum:plan-asked {"acme/deploy":"${at}"} -->`);
  const progress = (extra) => `<!-- pendulum:7:progress:work:1 -->\nPendulum work run 1: started\n${extra}`;
  assert.deepEqual(planAskedOf([own(progress(rec))], { issue: 7, self: BOT }), { "acme/deploy": at });
  assert.deepEqual(planAskedOf([own(progress(rec), "someone")], { issue: 7, self: BOT }), {}, "someone else's comment");
  assert.deepEqual(planAskedOf([own(progress(rec))], { issue: 7, self: null }), {}, "Pendulum's login unknown: nothing counts");
});

test("plan-time Question: the exit is a Question even with no commit and no PR, after the hard stops and before every other check", () => {
  const planNeedsReason = ask("Needs-Repository: acme/world");
  const harness = { ok: true };
  assert.deepEqual(decideExit({ harness, pr: null, commits: 0, planNeeds: planNeedsReason }), { exit: "question", reason: planNeedsReason });
  assert.deepEqual(decideExit({ harness: { ok: false, error: "stopped by Pendulum" }, pr: null, commits: 0, planNeeds: planNeedsReason }), { exit: "question", reason: planNeedsReason });
  assert.equal(decideExit({ harness, pr: null, commits: 0 }).reason, "worker ended without commits or a PR", "control: without it, an empty run Blocks");
  const pr = { exists: true, draft: true, body: "" };
  assert.equal(decideExit({ harness: { ok: false, error: "max turns" }, pr, commits: 3, validation: { passes: 1, green: false }, record: { exit: "blocked", reason: "x" }, planNeeds: planNeedsReason }).exit, "question");
  assert.equal(decideExit({ harness: { ok: true, died: 2 }, pr: null, commits: 0, planNeeds: planNeedsReason }).reason, "worker process died twice");
  assert.equal(decideExit({ harness: { ok: true, budgetExceeded: true }, pr: null, commits: 0, planNeeds: planNeedsReason }).reason, "dollar cap reached");
  assert.equal(decideExit({ harness, pr, commits: 1, protectedHits: [".github/x"], planNeeds: planNeedsReason }).exit, "blocked");
});
