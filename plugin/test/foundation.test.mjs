// A foundation Objective's review (#275): `pendulum:foundation` adds a second reviewer call that checks the shared contracts
// the diff changes against their callers; its comments go up in the same comment-only review, within max_usd.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FOUNDATION_LABEL, foundationLabel } from "../scripts/lib/choice.mjs";
import { CHOICE_FIX, choiceGate, choiceTrusted, foundationTrusted } from "../scripts/lib/objective-trust.mjs";
import { reviewPost, reviewsCover } from "../scripts/lib/handoff.mjs";
import { parseReview } from "../scripts/lib/logic.mjs";
import { foundationCall, foundationReview } from "../scripts/review.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ROOT = join(import.meta.dirname, "..", "..");
const ENV = { GITHUB_REPOSITORY: "acme/app", PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_REVIEWER_MODEL: "claude-fable-5-2" };
const person = (login, id = 1) => ({ login, id, type: "User" });
const perms = { kirk: "admin", reader: "read" };
const timeline = (by, asked = []) => ({ labelers: async (_, n, names) => (asked.push(...names), Object.fromEntries(names.filter((l) => by[l]).map((l) => [l, { at: "2026-11-14T10:00:00Z", actor: by[l] }]))), permission: async (_, login) => perms[login] ?? null });

test("the foundation label is trusted as the choice labels are: only from a person who can push", async () => {
  assert.equal(foundationLabel([{ name: "pendulum:objective" }, { name: "Pendulum:Foundation" }]), "Pendulum:Foundation");
  assert.equal(foundationLabel(["pendulum:objective"]), null);
  const asked = [];
  const ok = await choiceTrusted(repo, 7, ["pendulum:objective", FOUNDATION_LABEL], {}, timeline({ [FOUNDATION_LABEL]: person("kirk") }, asked));
  assert.deepEqual([ok.ok, ok.foundation, ok.labels, ok.choice], [true, true, [], {}], "a foundation, no harness or model choice");
  assert.deepEqual(asked, [FOUNDATION_LABEL], "its labeler read from the timeline");
  const stranger = await choiceTrusted(repo, 7, [FOUNDATION_LABEL], {}, timeline({ [FOUNDATION_LABEL]: person("reader") }));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /^`pendulum:foundation` was applied by `reader`, who cannot push to acme\/app/);
  assert.equal(stranger.fix, CHOICE_FIX);
  assert.match((await choiceTrusted(repo, 7, [FOUNDATION_LABEL], {}, timeline({}))).reason, /who applied `pendulum:foundation` could not be read/);
  const none = await choiceTrusted(repo, 7, ["pendulum:objective"], {}, { labelers: async () => assert.fail("no label to vouch for: no timeline read") });
  assert.equal(none.foundation, false);
  // With a model label too: both are vouched for in one timeline read.
  const both = [];
  const mixed = await choiceTrusted(repo, 7, [FOUNDATION_LABEL, "pendulum:model:claude-sonnet-5-5"], {}, timeline({ [FOUNDATION_LABEL]: person("reader"), "pendulum:model:claude-sonnet-5-5": person("kirk") }, both));
  assert.deepEqual([mixed.ok, both], [false, ["pendulum:model:claude-sonnet-5-5", FOUNDATION_LABEL]]);
});

test("choiceGate hands the stage the foundation mark, or Blocks before any harness on an untrusted one", async () => {
  const applied = [];
  const gate = (by) => choiceGate({ repo, issue: 7, labels: ["pendulum:objective", FOUNDATION_LABEL], env: ENV, pr: { number: 9 }, notify: "boss", opts: {}, apply: async (_, e) => applied.push(e), stage: "review", gh: timeline(by) });
  const good = await gate({ [FOUNDATION_LABEL]: person("kirk") });
  assert.deepEqual([good.ok, good.foundation, good.inputs.harness, good.inputs.reviewerModel], [true, true, "claude", "claude-fable-5-2"], "the repository's defaults, foundation on");
  assert.equal(applied.length, 0);
  const bad = await gate({ [FOUNDATION_LABEL]: person("reader") });
  assert.equal(bad.ok, false);
  assert.deepEqual([applied[0].exit, applied[0].cause, applied[0].stage, applied[0].fix], ["blocked", "setup", "review", CHOICE_FIX]);
});

/** A reviewer call as runHarness returns it, booked as the review job books it. */
const call = (finalText, extra = {}) => ({ ok: true, finalText, usd: 1, ...extra });

test("foundationReview: no call starts with max_usd spent or less than a call's minimum time left", async () => {
  const runs = [];
  const run = async (a) => (runs.push(a), call("", { ok: false, budgetExceeded: true }));
  assert.deepEqual(await foundationReview({ model: "m", run, over: () => true, timeout: () => 60_000 }), { review: null, recs: [], stop: "cap" });
  assert.deepEqual(await foundationReview({ model: "m", run, over: () => false, timeout: () => null }), { review: null, recs: [], stop: "time" });
  assert.equal(runs.length, 0);
  // No time left for the rerun: the pass ends on how its first call ended, not on the time cap.
  let left = 60_000;
  const late = await foundationReview({ model: "m", run: async (a) => (runs.push(a), (left = 0), call("", { ok: false, exitCode: 1 })), over: () => false, timeout: () => (left ? left : null) });
  assert.deepEqual([late.stop, late.recs.length, runs.length], ["missed", 1, 1]);
  runs.length = 0;
  // The first call spent the cap: its rerun does not start (`over` reads what `run` booked).
  let spent = 0;
  const capped = await foundationReview({ model: "m", run: async (a) => (runs.push(a), (spent += 5), call("", { ok: false, budgetExceeded: true })), over: () => spent >= 5, timeout: () => 60_000 });
  assert.deepEqual([capped.stop, capped.recs.length, runs.length], ["cap", 1, 1]);
});

test("the review job runs the foundation pass on a trusted foundation Objective only, after the first pass's answer and before the post", () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  const run = src.indexOf("async function run()");
  const at = (s) => src.indexOf(s, run);
  assert.ok(at("const foundation = !!chosen.foundation;") > at("await choiceGate("), "the mark from the trusted choice");
  const pass = at("if (foundationDue) {");
  assert.ok(pass > at("const answer = alreadyReviewed ? reviewRec : reviewAnswer(") && pass > at("if (!answer) {"), "after the first pass has a review");
  assert.ok(at("reviewPost({ issue, review: reviewOf(answer), diff, entries, ok: answer.ok, splitPart, foundation: found?.review ?? null, since: sinceReviewed })") > pass, "posted with the first pass's comments");
  const block = src.slice(pass, at("const post = !alreadyReviewed"));
  assert.match(block, /over: \(\) => over\(\) \|\| overBudget,/, "max_usd: the job's own cap");
  assert.match(block, /maxUsd: Math\.max\(0, passCap\(\) - sumSpend\(records\)\.usd\),/, "each call capped at what is left of max_usd less the drift reserve");
  assert.match(block, /mark\(rec, rec\);\n\s+records\.push\(rec\);/, "each call booked before the next check");
  assert.match(block, /if \(found\.stop === "cap"\) return blockedAtCap\("the foundation pass"\);\n\s+if \(found\.stop === "time"\) return blockedAtTime\("the foundation pass"\);/);
  assert.match(block, /exit: "blocked", reason, cause: last\.refusal \? refusalCause\(last\.refusal\) : "pendulum"[\s\S]*await finish\("blocked", reason\);\n\s+return;/, "no answer: nothing posted, Blocked");
  assert.match(block, /runHarness\(\n\s+foundationCall\(\{\n\s+harness: inputs\.harness,/, "foundationCall's agent and reviewer mark");
});

test("a session's review: post-review takes the foundation pass under `foundation` on a trusted foundation Objective only", async () => {
  assert.deepEqual(await foundationTrusted(repo, 7, ["pendulum:objective"], {}, { labelers: async () => assert.fail("no label: no timeline read") }), { ok: true, foundation: false });
  assert.deepEqual(await foundationTrusted(repo, 7, [FOUNDATION_LABEL, "pendulum:model:x"], {}, timeline({ [FOUNDATION_LABEL]: person("kirk") })), { ok: true, foundation: true }, "only the foundation label is vouched for");
  const refused = await foundationTrusted(repo, 7, [FOUNDATION_LABEL], {}, timeline({ [FOUNDATION_LABEL]: person("reader") }));
  assert.deepEqual([refused.ok, refused.fix], [false, CHOICE_FIX]);
  const { reviewPostFor } = await import("../scripts/local.mjs");
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  const first = '"acceptance": [{"entry": "A", "met": true}], "comments": []';
  const both = reviewPostFor({ issue: 7, text: `{${first}, "foundation": {"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: z"}]}}`, file: "f.json", diff, entries, foundation: true });
  assert.deepEqual([both.placeholder, both.comments.map((c) => c.body)], [false, ["foundation review: z"]]);
  assert.match(both.body, /review of two passes, 1 comment\(s\); the foundation pass [^\n]* raised 1\./);
  assert.throws(() => reviewPostFor({ issue: 7, text: `{${first}}`, file: "f.json", diff, entries, foundation: true }), /f\.json holds no foundation pass \("foundation": \{"comments": \[\.\.\.\]\}\), which #7's pendulum:foundation label asks for; nothing posted/);
  assert.throws(() => reviewPostFor({ issue: 7, text: `{${first}, "foundation": {"comments": []}}`, file: "f.json", diff, entries }), /#7 is not a foundation Objective/);
  assert.match(reviewPostFor({ issue: 7, text: `{${first}}`, file: "f.json", diff, entries }).body, /one comment-only pass/, "any other Objective: as before");
  const src = readFileSync(join(ROOT, "plugin", "scripts", "local.mjs"), "utf8");
  const post = src.indexOf("async function postFindings(");
  const at = (x) => src.indexOf(x, post);
  assert.ok(at("const found = await foundationTrusted(repo, issue, trusted.labels, opts);") > at("const trusted = await trustedIssue("), "read with the text it vouches for");
  assert.ok(at("if (!found.ok) throw new Error(`nothing posted: ${found.reason}. ${found.fix}`);") < at("await postReview("), "refused before anything is posted");
  assert.ok(at("foundation: found.foundation })") < at("await postReview("));
});

test("reviewsCover: a review and its foundation pass count only from Pendulum or someone who can push, and only for their own issue", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const bot = (body) => ({ body, author_association: "OWNER", user: { login: "kirk" } });
  // The first review stage ran before the label: one pass, no foundation marker, so the foundation pass is due.
  const plain = reviewPost({ issue: 7, review: { comments: [], acceptance: [{ entry: "A", met: true, evidence: "ok" }] }, diff, entries: [{ id: "A", text: "a" }] });
  assert.deepEqual(reviewsCover([bot(plain.body)], 7), { reviewed: true, foundation: false });
  const alone = reviewPost({ issue: 7, review: null, diff, foundation: parseReview('{"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: z"}]}') });
  assert.deepEqual(reviewsCover([bot(plain.body), bot(alone.body)], 7), { reviewed: true, foundation: true });
  assert.deepEqual(reviewsCover([{ ...bot(alone.body), author_association: "NONE", user: { login: "stranger" } }], 7), { reviewed: false, foundation: false });
  assert.deepEqual(reviewsCover([bot(alone.body)], 8), { reviewed: false, foundation: false });
});
