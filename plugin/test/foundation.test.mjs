// A foundation Objective's review (#275): `pendulum:foundation` adds a second reviewer call that checks the shared contracts
// the diff changes against their callers; its comments go up in the same comment-only review, within max_usd.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FOUNDATION_LABEL, foundationLabel } from "../scripts/lib/choice.mjs";
import { CHOICE_FIX, choiceGate, choiceTrusted, foundationTrusted, objectiveSha } from "../scripts/lib/objective-trust.mjs";
import { reviewPost, reviewsCover } from "../scripts/lib/handoff.mjs";
import { parseReview } from "../scripts/lib/logic.mjs";
import { FOUNDATION_AGENT, answerList, foundationCall, foundationPrompt, foundationReview } from "../scripts/review.mjs";
import { AGENT_DIRS, agentModel } from "../scripts/lib/checkout.mjs";
import { harnessCommand } from "../scripts/lib/harness.mjs";

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

test("the foundation label is no edit: the plan's record does not cover it", () => {
  assert.equal(objectiveSha("t", "b", ["pendulum:objective", FOUNDATION_LABEL]), objectiveSha("t", "b", ["pendulum:objective"]));
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

test("foundationPrompt: comments only, on the reference's section, with the issue, PR body and diff", () => {
  const p = foundationPrompt({ issue: 5, issueTitle: "Command registry", issueBody: "## Acceptance\n- one", prBody: "the body", diff: "diff --git a/x b/x\n+y\n", harness: "claude" });
  assert.match(p, /foundation pass for the pull request on issue #5: Command registry/);
  assert.match(p, /`pendulum:foundation`/);
  assert.match(p, /reference\.md section "Foundation review"/);
  assert.match(p, /\{"comments": \[\{"path": "src\/errors\.ts", "line": 12, "entry": "foundation", "body": "foundation review: \.\.\."\}\]\}/);
  assert.doesNotMatch(p, /"acceptance":/, "the first pass judges the entries");
  for (const part of ["## Issue\n## Acceptance\n- one", "## PR body\nthe body", "## Diff\n```diff\ndiff --git a/x b/x\n+y"]) assert.ok(p.includes(part), part);
  assert.match(foundationPrompt({ issue: 5, issueTitle: "t", issueBody: "", prBody: "", diff: "", harness: "codex" }), /Act as the reviewer agent defined in \.codex\/agents\/foundation-reviewer\.toml/);
  const ref = readFileSync(join(ROOT, "plugin", "skills", "pendulum-review-pr", "reference.md"), "utf8");
  assert.match(ref, /\n## Foundation review\n/, "the section the prompt names");
  assert.match(readFileSync(join(ROOT, "plugin", "skills", "pendulum-review-pr", "SKILL.md"), "utf8"), /The foundation pass: reference\.md, "Foundation review"\./);
});

test("reviewPost: the foundation pass's comments go up in the same review, counted in its body; without it, as before", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  const review = { comments: [{ path: "src/a.ts", line: 3, entry: "A", body: "acceptance A: x" }], acceptance: [{ entry: "A", met: false, path: "src/a.ts", line: 3, evidence: "x" }] };
  const foundation = parseReview('{"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: `settings_invalid` never reaches the result; src/cli.ts:40 maps every input error to `invalid_input`"}]}');
  const post = reviewPost({ issue: 7, review, diff, entries, foundation });
  assert.deepEqual(post.comments.map((c) => [c.path, c.line]), [["src/a.ts", 3], ["src/new.ts", 2]]);
  assert.equal(post.placeholder, false);
  assert.deepEqual(post.body.split("\n").slice(0, 3), ["<!-- pendulum:7:review -->", "<!-- pendulum:7:foundation -->", "Pendulum reviewer: one comment-only review of two passes, 2 comment(s); the foundation pass checked the shared contracts the diff changes against their callers and raised 1."]);
  assert.equal(reviewPost({ issue: 7, review, diff, entries }).body.split("\n")[1], "Pendulum reviewer: one comment-only pass, 1 comment(s).");
  // Only foundation findings: no placeholder stands in, the foundation comment is what the answer pass answers.
  const met = { comments: [], acceptance: [{ entry: "A", met: true, evidence: "ok" }] };
  const only = reviewPost({ issue: 7, review: met, diff, entries, foundation });
  assert.deepEqual([only.placeholder, only.comments.length], [false, 1]);
  assert.equal(reviewPost({ issue: 7, review: met, diff, entries, foundation: parseReview('{"comments": []}') }).placeholder, true);
  assert.throws(() => reviewPost({ issue: 7, review: met, diff, entries, foundation: parseReview("prose") }), /foundation pass's answer held no findings JSON/);
  // A foundation comment on an entry the first pass judged not met without a comment: both go up.
  const unmet = { comments: [], acceptance: [{ entry: "B", met: false, path: "src/a.ts", line: 3, evidence: "the limit is gone" }] };
  const both = reviewPost({ issue: 7, review: unmet, diff, entries: [{ id: "B", text: "b" }], foundation: parseReview('{"comments": [{"path": "src/new.ts", "line": 2, "entry": "B", "body": "foundation review: y"}]}') });
  assert.deepEqual(both.comments.map((c) => [c.path, c.line, c.body]), [["src/new.ts", 2, "foundation review: y"], ["src/a.ts", 3, "acceptance B: not met. the limit is gone"]]);
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
  assert.match(block, /maxUsd: Math\.max\(0, inputs\.maxUsd - sumSpend\(records\)\),/, "each call capped at what is left");
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

test("the foundation call runs as its own foundation-reviewer agent on every harness, never as the first pass's reviewer", () => {
  const files = { claude: "claude/foundation-reviewer.md", codex: "codex/foundation-reviewer.toml", copilot: "copilot/foundation-reviewer.agent.md" };
  const source = JSON.parse(readFileSync(join(ROOT, "plugin", "agents", "source.json"), "utf8")).agents;
  const own = source.find((a) => a.name === FOUNDATION_AGENT);
  const first = source.find((a) => a.name === "reviewer");
  assert.deepEqual(own.models, first.models, "the reviewer's models");
  assert.match(own.instructions, /judge no acceptance entry/);
  assert.match(own.instructions, /final message is only the JSON \{"comments": \[\{"path", "line", "entry", "body"\}\]\}/);
  assert.doesNotMatch(own.instructions, /"acceptance"/);
  assert.doesNotMatch(first.instructions, /foundation/i, "the first pass's agent is unchanged");
  for (const [harness, file] of Object.entries(files)) {
    const text = readFileSync(join(ROOT, "plugin", "agents", file), "utf8");
    assert.ok(text.includes(harness === "codex" ? 'name = "foundation-reviewer"' : "name: foundation-reviewer"), `${file}: rendered with its name`);
    assert.ok(text.includes(harness === "codex" ? own.instructions.replace(/\\/g, "\\\\") : own.instructions), `${file}: its own instructions`);
    assert.ok(!text.includes('"acceptance"'), `${file}: no acceptance answer asked for`);
    // The call: Claude and Copilot select the agent by --agent; Codex, which has no flag, is told its file in the prompt.
    const call = foundationCall({ harness, model: "m", effort: "high", label: "review-foundation", timeoutMs: 1, prompt: foundationPrompt({ issue: 5, issueTitle: "t", issueBody: "", prBody: "", diff: "", harness }), maxUsd: 3, cwd: "/w", env: {}, eventsFile: "/e" });
    assert.deepEqual([call.agent, call.reviewer, call.maxUsd, call.label], [harness === "codex" ? undefined : "foundation-reviewer", true, 3, "review-foundation"], harness);
    assert.equal(call.prompt.includes(`Act as the reviewer agent defined in ${AGENT_DIRS.codex}/foundation-reviewer.toml`), harness === "codex", harness);
    assert.ok(!call.prompt.includes("/reviewer."), `${harness}: never the first pass's agent file`);
    if (harness !== "codex") {
      const { args } = harnessCommand({ harness, model: "m", prompt: "p", agent: call.agent });
      assert.equal(args[args.indexOf("--agent") + 1], "foundation-reviewer", `${harness}: --agent`);
    }
  }
  // Installed on the reviewer model the Objective runs on, as the first pass's agent is.
  assert.equal(agentModel("foundation-reviewer", { reviewer: "claude-opus-5-5", subagent: "s" }), "claude-opus-5-5");
  assert.equal(agentModel("reviewer", { reviewer: "claude-opus-5-5" }), "claude-opus-5-5");
  assert.equal(agentModel("implementer", { subagent: "s" }), "s");
  assert.equal(agentModel("foundation-reviewer", {}), null, "no input: the file's own pin");
  const review = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  assert.match(review, /const rec = await runHarness\(\n\s+foundationCall\(\{/, "the job runs exactly foundationCall's arguments");
});

test("post-review reads the session file once, whatever the order of its keys", async () => {
  const { reviewPostFor } = await import("../scripts/local.mjs");
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  const pass = '"foundation": {"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: z"}]}';
  const first = '"acceptance": [{"entry": "A", "met": true}], "comments": []';
  for (const text of [`{${first}, ${pass}}`, `{${pass}, ${first}}`, `{"comments": [], ${pass}, "acceptance": [{"entry": "A", "met": true}]}`]) {
    const post = reviewPostFor({ issue: 7, text, file: "f.json", diff, entries, foundation: true });
    assert.deepEqual([post.comments.map((c) => c.body), /raised 1\./.test(post.body), /- A: met/.test(post.body)], [["foundation review: z"], true, true], text);
  }
  // Not one JSON value (a fenced answer): read as the review job reads one, with no foundation pass in it.
  assert.equal(reviewPostFor({ issue: 7, text: "```json\n{" + first + "}\n```", file: "f.json", diff, entries }).placeholder, true);
  assert.throws(() => reviewPostFor({ issue: 7, text: `{${pass}}`, file: "f.json", diff, entries, foundation: true }), /f\.json holds no reviewer JSON; nothing posted/, "the first pass is still required");
});

test("a PR reviewed before the foundation label gets the foundation pass alone at its next review stage, as its own review", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  const bot = (body) => ({ body, author_association: "MEMBER", user: { login: "kirk" } });
  // The first review stage ran before the label: one pass, no foundation marker.
  const plain = reviewPost({ issue: 7, review: { comments: [], acceptance: [{ entry: "A", met: true, evidence: "ok" }] }, diff, entries });
  assert.doesNotMatch(plain.body, /pendulum:7:foundation/);
  assert.deepEqual(reviewsCover([bot(plain.body)], 7), { reviewed: true, foundation: false }, "the next stage: reviewed, the foundation pass due");
  // That stage posts the foundation pass alone: its own review, both markers, no acceptance judged again.
  const alone = reviewPost({ issue: 7, review: null, diff, foundation: parseReview('{"comments": [{"path": "src/new.ts", "line": 2, "entry": "foundation", "body": "foundation review: z"}]}') });
  assert.deepEqual(alone.body.split("\n"), ["<!-- pendulum:7:review -->", "<!-- pendulum:7:foundation -->", "Pendulum reviewer: the foundation pass, after this PR's first review (the Objective was labelled a foundation one since), 1 comment(s); it checked the shared contracts the diff changes against their callers."]);
  assert.deepEqual([alone.placeholder, alone.comments.map((c) => c.body), alone.unjudged], [false, ["foundation review: z"], []]);
  assert.deepEqual(reviewsCover([bot(plain.body), bot(alone.body)], 7), { reviewed: true, foundation: true }, "and the stage after: nothing due");
  const empty = reviewPost({ issue: 7, review: null, diff, foundation: parseReview('{"comments": []}') });
  assert.equal(empty.placeholder, true, "nothing found: the placeholder records the pass");
  assert.deepEqual(reviewsCover([bot(empty.body)], 7).foundation, true);
  // Markers count only from Pendulum or someone who can push; another issue's do not.
  assert.deepEqual(reviewsCover([{ ...bot(alone.body), author_association: "NONE", user: { login: "stranger" } }], 7), { reviewed: false, foundation: false });
  assert.deepEqual(reviewsCover([bot(alone.body)], 8), { reviewed: false, foundation: false });
  assert.throws(() => reviewPost({ issue: 7, review: null, diff }), /no pass answered/);
  // The review job: the pass is due on a trusted foundation Objective whose reviews lack the marker, reviewed or not; on
  // an already reviewed PR it is posted alone; the earlier review's open comments are still answered.
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  assert.match(src, /const covered = reviewsCover\(reviews, issue\);/);
  // A head with commits since the review (#350) gets the foundation pass again, on those commits, with the first pass.
  assert.match(src, /const alreadyReviewed = scope\.covered;\n\s+const foundationDue = foundation && \(!alreadyReviewed \|\| !covered\.foundation\);/);
  assert.match(src, /\n  if \(foundationDue\) \{\n/);
  assert.doesNotMatch(src, /foundation && !alreadyReviewed/);
  assert.match(src, /: found\n\s+\? reviewPost\(\{ issue, review: null, diff, foundation: found\.review \}\)\n\s+: null;/);
  // The foundation pass alone, with nothing found, on a PR already reviewed: the earlier review's open comments are still answered.
  assert.deepEqual(answerList([{ id: 1 }, { id: 2, from: "greptile-apps[bot]" }], { placeholder: true, first: false }).map((c) => c.id), [1, 2]);
  // The worker's rebase keeps a review only when it covers a foundation Objective's foundation pass.
  const worker = readFileSync(join(ROOT, "plugin", "scripts", "worker.mjs"), "utf8");
  assert.ok(worker.indexOf("const foundation = !!chosen.foundation;") > worker.indexOf("await choiceGate("));
  assert.match(worker, /let reviewed = !!cover\?\.reviewed && \(!foundation \|\| cover\.foundation\);/);
});
