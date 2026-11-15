// A foundation Objective's review (#275): `factory:foundation` adds a second reviewer call that checks the shared contracts
// the diff changes against their callers; its comments go up in the same comment-only review, within max_usd.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FOUNDATION_LABEL, foundationLabel } from "../scripts/lib/choice.mjs";
import { CHOICE_FIX, choiceGate, choiceTrusted, objectiveSha } from "../scripts/lib/objective-trust.mjs";
import { reviewPost } from "../scripts/lib/handoff.mjs";
import { parseReview } from "../scripts/lib/logic.mjs";
import { foundationPrompt, foundationReview } from "../scripts/review.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ROOT = join(import.meta.dirname, "..", "..");
const ENV = { GITHUB_REPOSITORY: "acme/app", FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_REVIEWER_MODEL: "claude-fable-5-2" };
const person = (login, id = 1) => ({ login, id, type: "User" });
const perms = { kirk: "admin", reader: "read" };
const timeline = (by, asked = []) => ({ labelers: async (_, n, names) => (asked.push(...names), Object.fromEntries(names.filter((l) => by[l]).map((l) => [l, { at: "2026-11-14T10:00:00Z", actor: by[l] }]))), permission: async (_, login) => perms[login] ?? null });

test("the foundation label is trusted as the choice labels are: only from a person who can push", async () => {
  assert.equal(foundationLabel([{ name: "factory:objective" }, { name: "Factory:Foundation" }]), "Factory:Foundation");
  assert.equal(foundationLabel(["factory:objective"]), null);
  const asked = [];
  const ok = await choiceTrusted(repo, 7, ["factory:objective", FOUNDATION_LABEL], {}, timeline({ [FOUNDATION_LABEL]: person("kirk") }, asked));
  assert.deepEqual([ok.ok, ok.foundation, ok.labels, ok.choice], [true, true, [], {}], "a foundation, no harness or model choice");
  assert.deepEqual(asked, [FOUNDATION_LABEL], "its labeler read from the timeline");
  const stranger = await choiceTrusted(repo, 7, [FOUNDATION_LABEL], {}, timeline({ [FOUNDATION_LABEL]: person("reader") }));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /^`factory:foundation` was applied by `reader`, who cannot push to acme\/app/);
  assert.equal(stranger.fix, CHOICE_FIX);
  assert.match((await choiceTrusted(repo, 7, [FOUNDATION_LABEL], {}, timeline({}))).reason, /who applied `factory:foundation` could not be read/);
  const none = await choiceTrusted(repo, 7, ["factory:objective"], {}, { labelers: async () => assert.fail("no label to vouch for: no timeline read") });
  assert.equal(none.foundation, false);
  // With a model label too: both are vouched for in one timeline read.
  const both = [];
  const mixed = await choiceTrusted(repo, 7, [FOUNDATION_LABEL, "factory:model:claude-sonnet-5-5"], {}, timeline({ [FOUNDATION_LABEL]: person("reader"), "factory:model:claude-sonnet-5-5": person("kirk") }, both));
  assert.deepEqual([mixed.ok, both], [false, ["factory:model:claude-sonnet-5-5", FOUNDATION_LABEL]]);
});

test("choiceGate hands the stage the foundation mark, or Blocks before any harness on an untrusted one", async () => {
  const applied = [];
  const gate = (by) => choiceGate({ repo, issue: 7, labels: ["factory:objective", FOUNDATION_LABEL], env: ENV, pr: { number: 9 }, notify: "boss", opts: {}, apply: async (_, e) => applied.push(e), stage: "review", gh: timeline(by) });
  const good = await gate({ [FOUNDATION_LABEL]: person("kirk") });
  assert.deepEqual([good.ok, good.foundation, good.inputs.harness, good.inputs.reviewerModel], [true, true, "claude", "claude-fable-5-2"], "the repository's defaults, foundation on");
  assert.equal(applied.length, 0);
  const bad = await gate({ [FOUNDATION_LABEL]: person("reader") });
  assert.equal(bad.ok, false);
  assert.deepEqual([applied[0].exit, applied[0].cause, applied[0].stage, applied[0].fix], ["blocked", "setup", "review", CHOICE_FIX]);
});

test("the foundation label is no edit: the plan's record does not cover it", () => {
  assert.equal(objectiveSha("t", "b", ["factory:objective", FOUNDATION_LABEL]), objectiveSha("t", "b", ["factory:objective"]));
});

/** A reviewer call as runHarness returns it, booked as the review job books it. */
const call = (finalText, extra = {}) => ({ ok: true, finalText, usd: 1, ...extra });

test("foundationReview: one call that answers is the pass; a miss reruns once on the fallback; a refusal is not rerun", async () => {
  const runs = [];
  const run = (answers) => async (a) => (runs.push(a), answers.shift());
  const base = { model: "claude-fable-5-2", effort: "high", fallback: { model: "claude-opus-5-5", effort: "xhigh" }, over: () => false, timeout: () => 60_000 };
  const one = await foundationReview({ ...base, run: run([call('{"comments": [{"path": "src/errors.ts", "line": 3, "entry": "foundation", "body": "foundation review: x"}]}')]) });
  assert.deepEqual([one.stop, one.review.comments.length, runs.map((r) => [r.model, r.effort, r.label, r.timeoutMs])], [null, 1, [["claude-fable-5-2", "high", "review-foundation", 60_000]]]);
  runs.length = 0;
  const again = await foundationReview({ ...base, run: run([call("", { ok: false, exitCode: 1 }), call("no JSON here"), call("unused")]) });
  assert.deepEqual([again.stop, again.review, runs.map((r) => [r.model, r.label])], ["missed", null, [["claude-fable-5-2", "review-foundation"], ["claude-opus-5-5", "review-foundation-fallback"]]]);
  runs.length = 0;
  const same = await foundationReview({ ...base, fallback: null, run: run([call("prose"), call('{"comments": []}')]) });
  assert.deepEqual([same.stop, same.review.comments, runs.map((r) => [r.model, r.label])], [null, [], [["claude-fable-5-2", "review-foundation"], ["claude-fable-5-2", "review-foundation-retry"]]]);
  runs.length = 0;
  const refused = await foundationReview({ ...base, run: run([call("", { ok: false, refusal: { kind: "usage-limit" } })]) });
  assert.deepEqual([refused.stop, runs.length], ["missed", 1]);
});

test("foundationReview: no call starts with max_usd spent or less than a call's minimum time left", async () => {
  const runs = [];
  const run = async (a) => (runs.push(a), call("", { ok: false, budgetExceeded: true }));
  assert.deepEqual(await foundationReview({ model: "m", run, over: () => true, timeout: () => 60_000 }), { review: null, recs: [], stop: "cap" });
  assert.deepEqual(await foundationReview({ model: "m", run, over: () => false, timeout: () => null }), { review: null, recs: [], stop: "time" });
  assert.equal(runs.length, 0);
  // The first call spent the cap: its rerun does not start (`over` reads what `run` booked).
  let spent = 0;
  const capped = await foundationReview({ model: "m", run: async (a) => (runs.push(a), (spent += 5), call("", { ok: false, budgetExceeded: true })), over: () => spent >= 5, timeout: () => 60_000 });
  assert.deepEqual([capped.stop, capped.recs.length, runs.length], ["cap", 1, 1]);
});

test("foundationPrompt: comments only, on the reference's section, with the issue, PR body and diff", () => {
  const p = foundationPrompt({ issue: 5, issueTitle: "Command registry", issueBody: "## Acceptance\n- one", prBody: "the body", diff: "diff --git a/x b/x\n+y\n", harness: "claude" });
  assert.match(p, /foundation pass for the pull request on issue #5: Command registry/);
  assert.match(p, /`factory:foundation`/);
  assert.match(p, /reference\.md section "Foundation review"/);
  assert.match(p, /\{"comments": \[\{"path": "src\/errors\.ts", "line": 12, "entry": "foundation", "body": "foundation review: \.\.\."\}\]\}/);
  assert.doesNotMatch(p, /"acceptance":/, "the first pass judges the entries");
  for (const part of ["## Issue\n## Acceptance\n- one", "## PR body\nthe body", "## Diff\n```diff\ndiff --git a/x b/x\n+y"]) assert.ok(p.includes(part), part);
  assert.match(foundationPrompt({ issue: 5, issueTitle: "t", issueBody: "", prBody: "", diff: "", harness: "codex" }), /Act as the reviewer agent defined in \.codex\/agents\/reviewer\.toml/);
  const ref = readFileSync(join(ROOT, "plugin", "skills", "factory-review-pr", "reference.md"), "utf8");
  assert.match(ref, /\n## Foundation review\n/, "the section the prompt names");
  assert.match(readFileSync(join(ROOT, "plugin", "skills", "factory-review-pr", "SKILL.md"), "utf8"), /The foundation pass: reference\.md, "Foundation review"\./);
});

test("reviewPost: the foundation pass's comments go up in the same review, counted in its body; without it, as before", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  const review = { comments: [{ path: "src/a.ts", line: 3, entry: "A", body: "acceptance A: x" }], acceptance: [{ entry: "A", met: false, path: "src/a.ts", line: 3, evidence: "x" }] };
  const foundation = parseReview('{"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: `settings_invalid` never reaches the result; src/cli.ts:40 maps every input error to `invalid_input`"}]}');
  const post = reviewPost({ issue: 7, review, diff, entries, foundation });
  assert.deepEqual(post.comments.map((c) => [c.path, c.line]), [["src/a.ts", 3], ["src/new.ts", 2]]);
  assert.equal(post.placeholder, false);
  assert.equal(post.body.split("\n")[1], "Factory reviewer: one comment-only review of two passes, 2 comment(s); the foundation pass checked the shared contracts the diff changes against their callers and raised 1.");
  assert.equal(reviewPost({ issue: 7, review, diff, entries }).body.split("\n")[1], "Factory reviewer: one comment-only pass, 1 comment(s).");
  // Only foundation findings: no placeholder stands in, the foundation comment is what the answer pass answers.
  const met = { comments: [], acceptance: [{ entry: "A", met: true, evidence: "ok" }] };
  const only = reviewPost({ issue: 7, review: met, diff, entries, foundation });
  assert.deepEqual([only.placeholder, only.comments.length], [false, 1]);
  assert.equal(reviewPost({ issue: 7, review: met, diff, entries, foundation: parseReview('{"comments": []}') }).placeholder, true);
  assert.throws(() => reviewPost({ issue: 7, review: met, diff, entries, foundation: parseReview("prose") }), /foundation pass's answer held no findings JSON/);
});

test("the review job runs the foundation pass on a trusted foundation Objective only, after the first pass's answer and before the post", () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  const run = src.indexOf("async function run()");
  const at = (s) => src.indexOf(s, run);
  assert.ok(at("const foundation = !!chosen.foundation;") > at("await choiceGate("), "the mark from the trusted choice");
  const pass = at("if (foundation && !alreadyReviewed) {");
  assert.ok(pass > at("const answer = alreadyReviewed ? reviewRec : reviewAnswer(") && pass > at("if (!answer) {"), "after the first pass has a review");
  assert.ok(at("reviewPost({ issue, review: reviewOf(answer), diff, entries, ok: answer.ok, splitPart, foundation: found?.review ?? null })") > pass, "posted with the first pass's comments");
  const block = src.slice(pass, at("const post = alreadyReviewed ? null : reviewPost("));
  assert.match(block, /over: \(\) => over\(\) \|\| overBudget,/, "max_usd: the job's own cap");
  assert.match(block, /maxUsd: Math\.max\(0, inputs\.maxUsd - sumSpend\(records\)\),/, "each call capped at what is left");
  assert.match(block, /mark\(rec, rec\);\n\s+records\.push\(rec\);/, "each call booked before the next check");
  assert.match(block, /if \(found\.stop === "cap"\) return blockedAtCap\("the foundation pass"\);\n\s+if \(found\.stop === "time"\) return blockedAtTime\("the foundation pass"\);/);
  assert.match(block, /exit: "blocked", reason, cause: last\.refusal \? refusalCause\(last\.refusal\) : "factory"[\s\S]*await finish\("blocked", reason\);\n\s+return;/, "no answer: nothing posted, Blocked");
  assert.match(block, /agent: inputs\.harness === "codex" \? undefined : "reviewer",\n\s+reviewer: true,/, "the pinned reviewer, no worker secrets");
});
