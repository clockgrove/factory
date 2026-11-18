import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appJwt, normalizePem } from "../scripts/lib/app-token.mjs";
import { input, parseArgs, resolveInputs } from "../scripts/lib/inputs.mjs";
import { EXIT_PROMPT, acceptanceEntries, capReached, commandPaths, decideExit, deniedHostsFix, fenceDecidable, isHostName, diffLines, entryKey, fixScopeReason, fixScopeRefused, isPlaceholder, marker, namesPath, parseExitRecord, parseFindings, parseReview, protectedPaths, setupPaths, snapComments, pushRefusal, toolchainFile, workflowScopeRefused, workspaceDeclarations } from "../scripts/lib/logic.mjs";
import { noReviewReason, reviewAnswer, reviewCallEnd, reviewCallTimeout, reviewPost, reviewProduced, reviewRetry } from "../scripts/lib/handoff.mjs";
import { scopeRefusal } from "../scripts/lib/session.mjs";

const ok = { ok: true };
const pr = (body = "## Acceptance\nok", draft = false) => ({ exists: true, draft, body });

test("delivered: PR open, validation green, nothing unaddressed", () => {
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 3, validation: { passes: 1, green: true } }), { exit: "delivered", reason: "" });
});

test("question: the harness's exit record says so; the PR body is never read", () => {
  const green = { passes: 1, green: true };
  const record = { exit: "question", reason: "", questions: ["is this wire shape acceptable?"] };
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, record }), { exit: "question", reason: "question: is this wire shape acceptable?" });
  assert.equal(decideExit({ harness: ok, pr: pr("## Assumptions\n1. QUESTION: does the API change?"), commits: 1, validation: green, record: { exit: "delivered", reason: "", questions: [] } }).exit, "delivered", "the word in the body decides nothing");
  assert.equal(decideExit({ harness: ok, pr: pr("1. Resolved (was a QUESTION)."), commits: 1, validation: green, record: null }).exit, "delivered");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, record, question: false }).exit, "delivered", "the review job's draft state overrides");
});

test("parseExitRecord: the first JSON object with a known exit, from a file or a harness answer", () => {
  assert.deepEqual(parseExitRecord('{"exit":"question","questions":["which port?"],"reason":""}'), { exit: "question", reason: "", questions: ["which port?"], unfounded: ["which port?"] });
  assert.deepEqual(parseExitRecord('Sure, here it is:\n```json\n{"exit": "delivered"}\n```'), { exit: "delivered", reason: "", questions: [] });
  assert.deepEqual(parseExitRecord('{"note":"not an exit"} {"exit":"blocked","reason":"no credential","questions":[{"question":"q1"}]}'), { exit: "blocked", reason: "no credential", questions: ["q1"] });
  assert.equal(parseExitRecord('{"exit":"maybe"}'), null);
  assert.equal(parseExitRecord("QUESTION: prose only"), null);
  assert.equal(parseExitRecord(""), null);
  assert.equal(isPlaceholder("<!-- pendulum:placeholder -->\nPendulum reviewer: no findings"), true);
  assert.equal(isPlaceholder("No findings here"), false);
});

test("blocked: each reason in the worker contract, in priority order", () => {
  const green = { passes: 1, green: true };
  assert.equal(decideExit({ harness: { ok: false, died: 2 }, pr: pr(), commits: 1, validation: green }).reason, "worker process died twice");
  assert.equal(decideExit({ harness: { ok: false, timedOut: true }, pr: pr(), commits: 1, validation: green }).reason, "time cap reached");
  assert.equal(decideExit({ harness: { ok: false, budgetExceeded: true }, pr: pr(), commits: 1, validation: green }).reason, "dollar cap reached");
  assert.match(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, protectedHits: [".github/workflows/ci.yml"] }).reason, /touched protected path \.github\/workflows\/ci\.yml/);
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0 }).reason, "worker ended without commits or a PR");
  assert.equal(decideExit({ harness: { ok: false, error: "boom" }, pr: null, commits: 0 }).reason, "worker ended without commits: boom");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 2 }).reason, "no PR could be opened for the branch");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 2, green: false } }).reason, "validation red after Pendulum's second pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 1, green: false } }).reason, "validation red after Pendulum's first pass");
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, reviewUnaddressed: 2 }), { exit: "blocked", reason: "2 reviewer finding(s) still open after the answer pass", cause: "work", findingsOpen: true });
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, record: { exit: "blocked", reason: "The migration needs a credential the runner lacks.", questions: [] } }).reason, "worker blocked: The migration needs a credential the runner lacks.");
  assert.equal(decideExit({ harness: { ok: false, error: "harness error" }, pr: pr(), commits: 2, validation: green }).reason, "harness error");
});

test("deniedHosts: a blocked exit record's host names, checked for DNS shape, become the decision's and the local fix", () => {
  const rec = parseExitRecord(JSON.stringify({ exit: "blocked", reason: "the proof needs the download host", deniedHosts: [" Downloads.Example.com ", "downloads.example.com", "cdn.example.org", "10.0.0.1", "example.com:443", "*.example.net", "https://x.example.com/a", "a b.example.com", "`x`.example.com", "localhost", "-bad.example.com", 7] }));
  assert.deepEqual(rec.deniedHosts, ["downloads.example.com", "cdn.example.org"], "host names only, lower case, once each");
  assert.equal(parseExitRecord('{"exit":"blocked","reason":"x","deniedHosts":["1.2.3.4"]}').deniedHosts, undefined, "none valid, none kept");
  assert.equal(parseExitRecord('{"exit":"delivered","deniedHosts":["cdn.example.org"]}').deniedHosts, undefined, "only a Block carries them");
  assert.equal(parseExitRecord(JSON.stringify({ exit: "blocked", deniedHosts: Array.from({ length: 20 }, (_, i) => `h${i}.example.com`) })).deniedHosts.length, 10);
  for (const h of ["a.b", "xn--bcher-kva.example", "a-b.c-d.example.com"]) assert.equal(isHostName(h), true, h);
  for (const h of ["example", "1.2.3.4", "a..b.com", "a.b-.com", `${"a".repeat(64)}.com`, "A.COM", "a.com.", "a.com/x", "@a.com"]) assert.equal(isHostName(h), false, h);
  const green = { passes: 1, green: true };
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, record: rec }), { exit: "blocked", reason: "worker blocked: the proof needs the download host", cause: "setup", deniedHosts: rec.deniedHosts });
  assert.deepEqual(decideExit({ harness: ok, pr: null, commits: 0, record: rec }).deniedHosts, rec.deniedHosts, "a Block before any commit keeps the worker's reason and hosts");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: rec }).reason, "worker blocked: the proof needs the download host");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "blocked", reason: "x", questions: [] } }).deniedHosts, undefined, "without hosts no host fix");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, protectedHits: [".github/x"], record: rec }).deniedHosts, undefined, "a Block of Pendulum's own carries no host fix");
  assert.equal(deniedHostsFix(["cdn.example.org"]), "The local sandbox denied `cdn.example.org`. If the Objective needs it, a person who can push applies `pendulum:host:cdn.example.org` to this issue, which opens it to this Objective alone, then re-applies `pendulum:objective`. To open it to every Objective, add it to `PENDULUM_LOCAL_DOMAINS` (a running `serve` reads it when it restarts), then re-apply `pendulum:objective`.");
  assert.match(deniedHostsFix(["a.example.com", "b.example.com"]), /denied `a\.example\.com`, `b\.example\.com`\. If the Objective needs them, .*To open them to every Objective, add them to `PENDULUM_LOCAL_DOMAINS`/);
  assert.match(deniedHostsFix(["github.com", "a.cdn.example.com", "b.example.com"], ["github.com", "*.cdn.example.com"]), /denied `b\.example\.com`\./, "hosts already allowed are left out");
  assert.equal(deniedHostsFix(["github.com"], ["github.com"]), null, "allowed already: the generic fix stands");
  assert.equal(deniedHostsFix(["not a host"]), null);
  assert.match(EXIT_PROMPT, /"deniedHosts"/);
});

test("a question with red validation is blocked, not question", () => {
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: { passes: 2, green: false }, record: { exit: "question", reason: "", questions: ["x"] } }).exit, "blocked");
});

test("review: findings parse from a fenced block and snap to diff lines", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const lines = diffLines(diff);
  assert.deepEqual([...lines["src/a.ts"].lines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(lines["src/a.ts"].first, 2);
  assert.equal(lines["src/new.ts"].first, 1);
  assert.equal(lines["old.ts"], undefined, "a deleted file has no right side");
  const findings = parseFindings('Here are my findings.\n```json\n{"comments":[{"path":"src/a.ts","line":3,"body":"acceptance 1: b is unused"},{"path":"src/a.ts","line":99,"body":"rule x"},{"path":"elsewhere.ts","line":1,"body":"acceptance 2"},{"body":""}]}\n```');
  assert.equal(findings.length, 4);
  const comments = snapComments(findings, diff);
  assert.deepEqual(comments, [
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "acceptance 1: b is unused" },
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "**Finding on `src/a.ts` line 99**, which this PR's diff does not show, so it is placed here:\n\nrule x", at: { path: "src/a.ts", line: 99, body: "rule x" } },
    // line 1 is a context line in the hunk, so it is kept
    { path: "src/a.ts", line: 1, side: "RIGHT", body: "**Finding on `elsewhere.ts` line 1**, which this PR's diff does not show, so it is placed here:\n\nacceptance 2", at: { path: "elsewhere.ts", line: 1, body: "acceptance 2" } },
  ]);
  assert.deepEqual(parseFindings("no json here"), []);
  assert.deepEqual(parseFindings('prose {"comments": [{"path":"a","line":1,"body":"x"}]}'), [{ path: "a", line: 1, body: "x" }]);
  // No diff line at all: the findings come back unplaced, for postReview to set out in the review body.
  assert.deepEqual(snapComments(findings, "").map((c) => [c.path, c.line]), [["src/a.ts", 3], ["src/a.ts", 99], ["elsewhere.ts", 1]]);
});

test("review: the issue's acceptance entries are the list under its exact Acceptance heading, by label or position", () => {
  const body = [
    "### Outcome",
    "- not an entry: the outcome section",
    "",
    "### Acceptance",
    "- **A:** the widget stays keyboard-reachable,",
    "  from every view.",
    "- **B:** the limit stays in place. The fallback stays available, so callers are unaffected.",
    "- The heading shows the display name.",
    "  - a nested note joins its entry",
    "```",
    "- inside a fence: not an entry",
    "```",
    "",
    "#### API",
    "1. [ ] numbered and checked, under a sub-heading",
    "",
    "### Context",
    "- not an entry",
  ].join("\n");
  assert.deepEqual(acceptanceEntries(body), [
    { id: "A", text: "**A:** the widget stays keyboard-reachable, from every view." },
    { id: "B", text: "**B:** the limit stays in place. The fallback stays available, so callers are unaffected." },
    { id: "3", text: "The heading shows the display name. - a nested note joins its entry" },
    { id: "4", text: "numbered and checked, under a sub-heading" },
  ]);
  assert.deepEqual(acceptanceEntries("## Want\n- something"), [], "no acceptance heading: the reviewer names the entries itself");
  // A heading that only mentions acceptance words is not the section: the reviewer names the entries from the issue (#417).
  const designNotes = "## Selection criteria for the ranking model\n- recall over precision\n- **R:** cheap to rerun\n\n## Done when\n- one\n\n## Acceptance criteria\n- two\n\n**Acceptance**\n- three";
  assert.deepEqual(acceptanceEntries(designNotes), []);
  assert.deepEqual(acceptanceEntries("## acceptance ##\n- one").map((e) => e.text), ["one"], "the heading's case and closing hashes are formatting");
  assert.deepEqual(acceptanceEntries("## Acceptance\n- **A:** one\n- **A:** two").map((e) => e.id), ["A", "2"], "a repeated label falls back to the position");
  assert.equal(entryKey("acceptance b."), "B");
  assert.equal(entryKey("**B:**"), "B");
  assert.notEqual(entryKey("1.2"), entryKey("12"), "nested numbering keeps its dot");
  assert.equal(entryKey("acceptance 1.2."), "1.2");
});

test("review: the answer's per-entry judgments parse beside its comments; a comments-only answer still parses", () => {
  const r = parseReview('```json\n{"acceptance":[{"entry":"B","met":false,"path":"src/a.ts","line":3,"evidence":"the limit is gone"},{"entry":2,"met":true},{"entry":"C","met":"yes"}],"comments":[]}\n```');
  assert.deepEqual(r, { comments: [], acceptance: [{ entry: "B", met: false, path: "src/a.ts", line: 3, evidence: "the limit is gone" }, { entry: "2", met: true, path: null, line: null, evidence: "" }], parsed: true });
  assert.deepEqual(parseReview('{"comments":[{"path":"a","line":1,"body":"x"}]}'), { comments: [{ path: "a", line: 1, body: "x" }], acceptance: null, parsed: true });
  assert.deepEqual(parseReview("prose only"), { comments: [], acceptance: null, parsed: false });
  assert.deepEqual(parseReview('prose {"acceptance": [{"entry": "A", "met": true}], "comments": []}').acceptance.map((a) => a.entry), ["A"]);
  // Pretty-printed after prose, with a closing remark: still the answer.
  assert.deepEqual(parseReview('I checked each entry.\n{\n  "acceptance": [\n    {"entry": "A", "met": false}\n  ],\n  "comments": []\n}\nDone.').acceptance.map((a) => a.met), [false]);
});

test("review: an entry judged not met is posted as a comment unless one carries it; unjudged entries are named; text is sanitised", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }, { id: "B", text: "b" }, { id: "C", text: "c" }, { id: "D", text: "d" }];
  const review = {
    comments: [{ path: "src/a.ts", line: 3, entry: "A", body: "acceptance A: fixes #12 for @someone <!-- pendulum:1:plan -->" }],
    acceptance: [
      { entry: "A", met: false, path: "src/a.ts", line: 3, evidence: "covered by the comment" },
      { entry: "acceptance B", met: false, path: "src/new.ts", line: 2, evidence: "the rate limit is removed" },
      { entry: "C", met: true, path: "src/a.ts", line: 4, evidence: "line\nbreak" },
    ],
  };
  const post = reviewPost({ issue: 7, review, diff, entries });
  assert.equal(post.placeholder, false);
  assert.deepEqual(post.comments, [
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "acceptance A: refs #12 for @\u200bsomeone &lt;!-- pendulum:1:plan -->" },
    { path: "src/new.ts", line: 2, side: "RIGHT", body: "acceptance B: not met. the rate limit is removed" },
  ]);
  assert.equal(
    post.body,
    ["<!-- pendulum:7:review -->", "Pendulum reviewer: one comment-only pass, 2 comment(s).", "", "Acceptance as the reviewer judged it:", "- A: not met (covered by the comment)", "- acceptance B: not met (the rate limit is removed)", "- C: met (line break)", "", "Not judged: D."].join("\n"),
  );
  // Nothing line-tied and every entry met: Pendulum's placeholder, nothing to answer, the judgments still on record.
  const clean = reviewPost({ issue: 7, review: { comments: [], acceptance: [{ entry: "A", met: true, evidence: "ok" }] }, diff, entries: [{ id: "A", text: "a" }] });
  assert.equal(clean.placeholder, true);
  assert.equal(clean.comments.length, 1);
  assert.ok(isPlaceholder(clean.comments[0].body));
  assert.match(clean.body, /\n- A: met \(ok\)$/);
  // A failed call or an answer with no JSON is no review: nothing to post, and no placeholder stands in for it (#2649).
  assert.throws(() => reviewPost({ issue: 7, review: { comments: [], acceptance: null }, diff, entries, ok: false }), /no review to post: the reviewer call failed/);
  assert.throws(() => reviewPost({ issue: 7, review: parseReview('{"comments": [{"path": "src/a.ts", "line": 3, "body": "x"}]}'), diff, entries, ok: false }), /the reviewer call failed/, "a crash after a JSON answer is still no review");
  assert.throws(() => reviewPost({ issue: 7, review: parseReview("I looked and it seems fine."), diff, entries }), /held no findings JSON/);
  // An answer with no judgments on an issue with entries is a missed pass, and its placeholder says so.
  const none = reviewPost({ issue: 7, review: parseReview('{"comments": []}'), diff, entries });
  assert.match(none.body, /The reviewer judged no acceptance entry\.\n\nNot judged: A, B, C, D\.$/);
  assert.match(none.comments[0].body, /judged none of the acceptance entries; this is not a clean pass\.$/);
  assert.deepEqual(none.unjudged, ["A", "B", "C", "D"]);
  // With no entries listed (no exact Acceptance section), an answer judging none says so too (#417).
  const unnamed = reviewPost({ issue: 7, review: parseReview('{"acceptance": [], "comments": []}'), diff, entries: [] });
  assert.equal(unnamed.body, ["<!-- pendulum:7:review -->", "Pendulum reviewer: one comment-only pass, 1 comment(s).", "", "The reviewer judged no acceptance entry."].join("\n"));
  assert.match(unnamed.comments[0].body, /judged none of the acceptance entries; this is not a clean pass\.$/);
  const namedClean = reviewPost({ issue: 7, review: parseReview('{"acceptance": [{"entry": "W1", "met": true}], "comments": []}'), diff, entries: [] });
  assert.match(namedClean.comments[0].body, /no findings; the pass ran/);
  assert.match(namedClean.body, /Acceptance as the reviewer judged it:\n- W1: met$/);
  // A comment that names its entry only in its body prefix still covers that entry's not-met judgment.
  const prefixed = reviewPost({ issue: 7, review: { comments: [{ path: "src/a.ts", line: 3, body: "acceptance A: the limit is gone" }], acceptance: [{ entry: "A", met: false, path: "src/a.ts", line: 3, evidence: "gone" }] }, diff, entries: [{ id: "A", text: "a" }] });
  assert.deepEqual(prefixed.comments.map((c) => c.body), ["acceptance A: the limit is gone"]);
});

test("review: a reviewer call always has a wall-clock cap; past the stage's deadline none starts (#2660)", () => {
  // exec treats a timeout of 0 as no timer: a call started with nothing left would run until the job itself is cut.
  assert.equal(reviewCallTimeout(0), null);
  assert.equal(reviewCallTimeout(59_999), null);
  assert.equal(reviewCallTimeout(60_000), 60_000);
  assert.equal(reviewCallTimeout(10 * 60_000), 10 * 60_000);
  assert.equal(reviewCallTimeout(3 * 60 * 60_000), 45 * 60_000);
});

test("review: a missed pass reruns once on every harness; with no review from either call the stage has no answer to post (#2649)", () => {
  const reviewOf = (rec) => parseReview(rec.finalText || "");
  const crash = { ok: false, exitCode: 101, signal: null, finalText: "" };
  const good = { ok: true, exitCode: 0, finalText: '{"acceptance":[{"entry":"A","met":true}],"comments":[]}' };
  const prose = { ok: true, exitCode: 0, finalText: "it looks fine" };
  const judgedNone = { ok: true, exitCode: 0, finalText: '{"comments":[{"path":"a","line":1,"body":"x"}]}' };
  // The rerun: Claude's fallback reviewer where the harness has one, else the same model and effort (Codex, Copilot).
  assert.deepEqual(reviewRetry({ model: "gpt-6.1-sol", effort: "high", fallback: null }), { model: "gpt-6.1-sol", effort: "high", label: "review-retry" });
  assert.deepEqual(reviewRetry({ model: "claude-fable-5-2", effort: "", fallback: { model: "claude-opus-5-5", effort: "xhigh" } }), { model: "claude-opus-5-5", effort: "xhigh", label: "review-fallback" });
  // A crash whose stream held a JSON answer is still no review: the call did not finish.
  assert.equal(reviewProduced({ ...crash, finalText: good.finalText }, reviewOf({ finalText: good.finalText })), false);
  assert.equal(reviewProduced(good, reviewOf(good)), true);
  assert.equal(reviewProduced(prose, reviewOf(prose)), false);
  // What goes up: the rerun's review, else the first pass's, else nothing (the stage Blocks, nothing is posted).
  assert.equal(reviewAnswer(crash, good, reviewOf), good);
  assert.equal(reviewAnswer(judgedNone, crash, reviewOf), judgedNone, "a pass that ran but judged nothing, then a crashed rerun: the first pass's answer");
  assert.equal(reviewAnswer(crash, crash, reviewOf), null);
  assert.equal(reviewAnswer(crash, prose, reviewOf), null);
  assert.equal(reviewAnswer(prose, { ...crash, timedOut: true }, reviewOf), null);
  assert.equal(reviewAnswer(good, null, reviewOf), good, "no rerun: the first pass's review");
  assert.equal(reviewAnswer(crash, null, reviewOf), null, "no rerun ran (the cap): still no review");
  // The Blocked reason and the log name a crash as a crash, apart from a pass that ran and found nothing.
  assert.equal(noReviewReason([crash, { ...crash, signal: "SIGSEGV", exitCode: null }], reviewOf), "the reviewer produced no review (a crash (exit 101), then a crash (signal SIGSEGV)), so nothing was posted and the PR does not merge");
  assert.equal(noReviewReason([prose, { ok: false, timedOut: true }], reviewOf), "the reviewer produced no review (an answer with no findings JSON, then the time cap), so nothing was posted and the PR does not merge");
  assert.deepEqual([{ ok: false, budgetExceeded: true }, { ok: false, idle: true }, { ok: false, stopped: true }, good].map((r) => reviewCallEnd(r, reviewOf({ finalText: r.finalText }))), ["the dollar cap", "a hang (no output and no progress; killed)", "a stop by Pendulum", "a review"]);
});

test("review: on a split part an entry judged deferred gets no comment; elsewhere it is not met (#157)", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }, { id: "B", text: "b" }];
  const review = parseReview('{"acceptance": [{"entry": "A", "met": false, "deferred": true, "path": "src/a.ts", "line": 3, "evidence": "Undone: a later part"}, {"entry": "B", "met": false, "path": "src/new.ts", "line": 2, "evidence": "claimed, not done"}], "comments": []}');
  assert.equal(review.acceptance[0].deferred, true);
  assert.equal("deferred" in review.acceptance[1], false);
  const part = reviewPost({ issue: 7, review, diff, entries, splitPart: true });
  assert.deepEqual(part.comments.map((c) => c.body), ["acceptance B: not met. claimed, not done"]);
  assert.match(part.body, /\n- A: deferred to a later part \(Undone: a later part\)\n- B: not met \(claimed, not done\)$/);
  // The last part and a one-PR Objective: a deferred judgment is not honoured, so the entry is a finding as before.
  const whole = reviewPost({ issue: 7, review, diff, entries });
  assert.deepEqual(whole.comments.map((c) => c.body), ["acceptance A: not met. Undone: a later part", "acceptance B: not met. claimed, not done"]);
  assert.match(whole.body, /\n- A: not met \(Undone: a later part\)\n/);
  // Every entry deferred on a part: nothing to answer, the judgments still on record.
  const allDeferred = reviewPost({ issue: 7, review: { comments: [], acceptance: [{ entry: "A", met: false, deferred: true, evidence: "later" }] }, diff, entries: [{ id: "A", text: "a" }], splitPart: true });
  assert.equal(allDeferred.placeholder, true);
  assert.deepEqual(allDeferred.unjudged, []);
});

test("markers follow the 0.5 idempotent shape lane 1 adopted", () => {
  assert.equal(marker(811, "plan"), "<!-- pendulum:811:plan -->");
  assert.equal(marker(811, "blocked", "work"), "<!-- pendulum:811:blocked:work -->");
});

test("inputs: flag, then with:, then workflow env, then default; booleans and lists", () => {
  const env = { PENDULUM_INPUT_MAX_USD: "", PENDULUM_MAX_USD: "12", PENDULUM_INPUT_HARNESS: "codex", PENDULUM_VALIDATION: "a, b\nc", PENDULUM_AUTO_MERGE: "false", GITHUB_REPOSITORY: "o/r" };
  assert.equal(input("max_usd", { env }), "12", "empty with: falls through to the env block");
  assert.equal(input("harness", { env }), "codex");
  assert.equal(input("harness", { env, args: { harness: "claude" } }), "claude");
  assert.equal(input("timeout_minutes", { env }), "240");
  const r = resolveInputs({ env, args: parseArgs(["--issue", "5", "--notify=@kirk", "--dry-run"]) });
  assert.equal(r.maxUsd, 12);
  assert.equal(r.autoMerge, false);
  assert.deepEqual(r.validation, ["a", "b", "c"]);
  assert.equal(r.issue, 5);
  assert.equal(r.notify, "kirk");
  assert.equal(r.repo, "o/r");
  assert.equal(r.model, "gpt-6.1-sol", "an empty model takes the harness default");
  assert.equal(r.reviewerModel, "gpt-6.1-sol", "reviewer_model defaults to the harness's reviewer default");
  const c = resolveInputs({ env: { GITHUB_REPOSITORY: "o/r" }, args: {} });
  assert.deepEqual([c.model, c.subagentModel, c.reviewerModel], ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"], "Claude: Opus worker, Sonnet implementers, Fable reviewer");
  assert.deepEqual(c.reviewerFallback, { model: "claude-opus-5-5", effort: "xhigh" });
  assert.equal(c.effort, "medium", "the worker's effort is pinned to the harness default, not left to the CLI");
});

test("App JWT is RS256 with iss, iat and exp; a flattened PEM is restored", () => {
  const { generateKeyPairSync } = globalThis.process.getBuiltinModule("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const flat = pem.replace(/\n/g, " ");
  assert.equal(normalizePem(flat).split("\n").length > 3, true);
  const jwt = appJwt("12345", flat, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_700_000_000 - 30, exp: 1_700_000_000 + 540, iss: "12345" });
  assert.ok(s.length > 300);
});

test("evaluateChecks: required checks from a head's check-runs, latest run per name, missing is not red", async () => {
  const { evaluateChecks } = await import("../scripts/lib/logic.mjs");
  const runs = [
    { id: 1, name: "quality", status: "completed", conclusion: "failure", started_at: "2026-11-05T01:00:00Z" },
    { id: 2, name: "quality", status: "completed", conclusion: "success", started_at: "2026-11-05T02:00:00Z" },
    { id: 3, name: "tests", status: "in_progress", conclusion: null, started_at: "2026-11-05T02:00:00Z" },
  ];
  assert.deepEqual(evaluateChecks(["quality"], runs), { done: true, green: true, missing: [], failed: [], pending: [] });
  assert.deepEqual(evaluateChecks(["quality", "tests"], runs), { done: false, green: false, missing: [], failed: [], pending: ["tests"] });
  assert.deepEqual(evaluateChecks(["quality", "lint"], runs), { done: false, green: false, missing: ["lint"], failed: [], pending: [] });
  assert.deepEqual(evaluateChecks(["quality"], [runs[0]]), { done: true, green: false, missing: [], failed: [{ name: "quality", conclusion: "failure", id: 1 }], pending: [] });
  assert.deepEqual(evaluateChecks([], []), { done: true, green: true, missing: [], failed: [], pending: [] });
});

test("runHarness: a Codex pass whose stdout another process in the chain made non-blocking does not die on EAGAIN (#2649)", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  // A stand-in for srt + Codex: a Node launcher that touches its own process.stdout (Node then makes a pipe or socket
  // stdout non-blocking, and the open file is shared with the child it started), and a child that writes a 4 MB event
  // stream synchronously and dies the way Codex's println! does when a write returns EAGAIN.
  const writer = `
const fs = require("node:fs");
const put = (o) => { const b = Buffer.from(JSON.stringify(o) + "\\n"); let at = 0; while (at < b.length) { try { at += fs.writeSync(1, b, at); } catch (e) { if (e.code !== "EAGAIN") throw e; fs.writeSync(2, "failed printing to stdout: Resource temporarily unavailable (os error 11)\\n"); process.exit(101); } } };
put({ type: "thread.started", thread_id: "t1" });
setTimeout(() => {
  for (let i = 0; i < 1000; i++) put({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(4000) } });
  put({ type: "item.completed", item: { type: "agent_message", text: '{"comments": []}' } });
  put({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
}, 200);`;
  const bin = mkdtempSync(join(tmpdir(), "pendulum-eagain-"));
  // After the spawn, as srt does: libuv makes a child's inherited stdio blocking again when it starts it.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nrequire("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));\nsetTimeout(() => process.stdout, 50);\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    // Pendulum busy for a second after the first line (posting progress, a slow disk): the stream backs up meanwhile.
    const busy = new Int32Array(new SharedArrayBuffer(4));
    let first = true;
    const onLine = () => {
      if (first) Atomics.wait(busy, 0, 0, 1000);
      first = false;
    };
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label: "review", onLine });
    assert.equal(rec.exitCode, 0, rec.stderrTail);
    assert.deepEqual([rec.ok, rec.turns, rec.finalText, /os error 11/.test(rec.stderrTail)], [true, 1, '{"comments": []}', false]);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("exec: a caller's AbortSignal stops the child, as the time cap does, and the result says stopped", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const stop = new AbortController();
  const started = Date.now();
  const r = await exec(process.execPath, ["-e", "console.log('plan'); setTimeout(() => {}, 60000)"], { signal: stop.signal, onLine: () => stop.abort() });
  assert.deepEqual([r.stopped, r.timedOut, r.idle, !!r.signal], [true, false, false, true]);
  assert.ok(Date.now() - started < 10_000, "stopped at once, not at the child's end");
  const before = new AbortController();
  before.abort();
  assert.equal((await exec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { signal: before.signal })).stopped, true, "aborted before it starts");
  const free = await exec(process.execPath, ["-e", "console.log('ok')"], { signal: new AbortController().signal });
  assert.deepEqual([free.code, free.stopped], [0, false], "control: never aborted");
  for (const g of [true]) assert.equal((await exec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { signal: AbortSignal.timeout(200), group: g })).stopped, true, "a process group too");
});

test("decideExit: a refused or rejected push always Blocks with its reason, PR or not", () => {
  const harness = { ok: true, died: 0 };
  assert.equal(decideExit({ harness, pr: null, commits: 3, pushRejected: "push rejected: ! [remote rejected] pendulum/808 (cannot lock ref)" }).reason, "push rejected: ! [remote rejected] pendulum/808 (cannot lock ref)");
  assert.deepEqual(decideExit({ harness, pr: pr(), commits: 3, validation: { passes: 1, green: true }, pushRejected: "touched protected path .github/x.yml" }), { exit: "blocked", reason: "push refused: touched protected path .github/x.yml", cause: "work" });
  assert.equal(decideExit({ harness, pr: null, commits: 3 }).reason, "no PR could be opened for the branch");
});

test("updateBranchHead: only GitHub's signed update-branch merge of the recorded head is accepted without another review", async () => {
  const { updateBranchHead } = await import("../scripts/lib/logic.mjs");
  const recorded = "a".repeat(40);
  const merge = { parents: [{ sha: recorded }, { sha: "b".repeat(40) }], committer: { login: "web-flow" }, commit: { verification: { verified: true } } };
  assert.equal(updateBranchHead(merge, recorded, true), true);
  assert.equal(updateBranchHead(merge, recorded, false), false, "the second parent is not on the default branch");
  assert.equal(updateBranchHead({ ...merge, commit: { verification: { verified: false } } }, recorded, true), false, "unsigned: the parent shape alone proves nothing");
  assert.equal(updateBranchHead({ ...merge, committer: { login: "someone" } }, recorded, true), false, "signed by someone else's key");
  assert.equal(updateBranchHead({ ...merge, parents: [{ sha: "c".repeat(40) }, { sha: "b".repeat(40) }] }, recorded, true), false, "not a merge on top of the recorded head");
  assert.equal(updateBranchHead({ ...merge, parents: [{ sha: recorded }] }, recorded, true), false, "a plain commit on top");
});

test("costByPhase: each harness run's cost by label on the exit line", async () => {
  const { costByPhase } = await import("../scripts/lib/logic.mjs");
  assert.equal(costByPhase([{ label: "work-1", usd: 7.9 }, { label: "validation-fix-1", usd: 0.543 }]), " (work-1 7.90, validation-fix-1 0.54)");
  assert.equal(costByPhase([{ label: "work-1", usd: 7.9 }]), "");
  assert.equal(costByPhase([{ label: "work-1", usd: null }, { label: "exit", usd: 0.1 }]), " (work-1 unknown, exit 0.10)", "a pass of unknown cost is named, never left out");
  assert.equal(costByPhase([{ label: "work-1", usd: 0, noRun: true }, { label: "exit", usd: 0.1 }]), "", "a pass that never ran is none");
});

test("Git LFS: a quota refusal is named and Blocks even with a PR open; the endpoint follows the remote", async () => {
  const { lfsEndpoint, lfsQuotaLine } = await import("../scripts/lib/lfs.mjs");
  const out = "Uploading LFS objects:   0% (0/1), 0 B | 0 B/s, done.\nbatch response: This repository is over its data quota. Account responsible for LFS bandwidth should purchase more data packs to restore access.\nerror: failed to push some refs to 'https://github.com/o/r'";
  assert.match(lfsQuotaLine(out), /^This repository is over its data quota/);
  assert.equal(lfsQuotaLine("! [rejected] HEAD -> pendulum/1 (fetch first)\nerror: failed to push some refs"), null);
  const reason = `Git LFS refused the upload (quota or storage): ${lfsQuotaLine(out)}`;
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, validation: { passes: 1, green: true }, pushRejected: reason, lfsRefused: true, lfsQuota: true }), { exit: "blocked", reason, cause: "provider-quota" });
  // Any other Git LFS refusal (the local cap, a missing endpoint, pointers) is a setup gap.
  assert.equal(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, pushRejected: "the remote has no https Git LFS endpoint to pin the media upload to", lfsRefused: true }).cause, "setup");
  assert.match(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, lfsPlain: ["a.glb"] }).reason, /plain git blobs .*: a\.glb$/);
  assert.equal(lfsEndpoint("https://github.com/o/r"), "https://github.com/o/r.git/info/lfs");
  assert.equal(lfsEndpoint("https://github.com/o/r.git\n"), "https://github.com/o/r.git/info/lfs");
  assert.equal(lfsEndpoint("git@github.com:o/r.git"), null);
});

test("Git LFS: token for github.com only, endpoint over .lfsconfig, every object since the base counted once against the local cap", async () => {
  const { configureGit } = await import("../scripts/lib/session.mjs");
  const { openOutbox } = await import("../scripts/lib/outbox.mjs");
  const { POINTER_HEAD, lfsEndpoint, lfsPinArgs, lfsPinEnv, lfsVersion } = await import("../scripts/lib/lfs.mjs");
  const { scrubbedEnv } = await import("../scripts/lib/harness.mjs");
  const { createHash, randomBytes } = await import("node:crypto");
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PENDULUM_LOCAL", "PENDULUM_LOCAL_MEDIA_MAX_MB", "GH_TOKEN"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GH_TOKEN: "not-a-real-token" });
  try {
    const root = mkdtempSync(join(tmpdir(), "pendulum-lfspush-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const run = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, work]);
    writeFileSync(join(work, ".gitattributes"), "assets/** filter=lfs diff=lfs merge=lfs -text\n");
    run("add", ".gitattributes");
    run("commit", "-q", "-m", "base");
    run("push", "-q", "origin", "HEAD:main");
    await configureGit(work, { login: "t", protectedList: [] });
    // The clone's own config holds no helper: whatever runs there (the harness, a repository's command) gets no token.
    const fill = (host, env = {}) => spawnSync("git", ["-C", work, "credential", "fill"], { input: `protocol=https\nhost=${host}\n\n`, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", ...env } });
    assert.doesNotMatch(fill("github.com").stdout, /password=/);
    // Pendulum's own git gets the token by env config, for GitHub only: not the LFS storage host, not one a planted
    // .lfsconfig names; and scrubbedEnv takes it all away from every child.
    const { credentialEnv } = await import("../scripts/lib/outbox.mjs");
    const { addGitConfig } = await import("../scripts/lib/session.mjs");
    const own = addGitConfig(lfsPinEnv("https://github.com/o/r.git"), credentialEnv("not-a-real-token"));
    const pendulumEnv = { ...lfsPinEnv("https://github.com/o/r.git"), ...own };
    assert.match(fill("github.com", pendulumEnv).stdout, /password=not-a-real-token/);
    for (const host of ["github-cloud.s3.amazonaws.com", "example.invalid"]) assert.doesNotMatch(fill(host, pendulumEnv).stdout, /password=/, host);
    assert.deepEqual(scrubbedEnv({ PATH: "/bin", ...pendulumEnv }), { PATH: "/bin" });
    // Command-line and env config outrank .lfsconfig for every key that picks the endpoint.
    const endpoint = lfsEndpoint("https://github.com/o/r.git");
    // The rest needs git-lfs (GitHub's runners have it).
    if (!(await lfsVersion())) return;
    writeFileSync(join(work, ".lfsconfig"), '[lfs]\n\turl = https://example.invalid/lfs\n\tpushurl = https://example.invalid/lfs\n[remote "origin"]\n\tlfsurl = https://example.invalid/lfs\n');
    assert.match(run(...lfsPinArgs("https://github.com/o/r.git"), "lfs", "env"), new RegExp(`^Endpoint=${endpoint} `, "m"));
    assert.match(execFileSync("git", ["-C", work, "lfs", "env"], { encoding: "utf8", env: { ...process.env, ...lfsPinEnv("https://github.com/o/r.git") } }), new RegExp(`^Endpoint=${endpoint} `, "m"));
    assert.match(run("lfs", "env"), /^Endpoint=https:\/\/example\.invalid\/lfs /m, "unpinned, .lfsconfig would redirect it");
    // The media a local push uploads: every object since the default branch's merge-base on origin, by git-lfs's own
    // parser (legacy pointer versions too), each once, whatever refs/remotes/origin/* say.
    run("checkout", "-q", "-b", "pendulum/1");
    mkdirSync(join(work, "assets"));
    const store = (bytes) => {
      const oid = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(join(work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
      writeFileSync(join(work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid), bytes);
      return oid;
    };
    const a = store(randomBytes(150_000));
    const b = store(randomBytes(50_000));
    writeFileSync(join(work, "assets", "a.glb"), `${POINTER_HEAD}\noid sha256:${a}\nsize 150000\n`);
    writeFileSync(join(work, "assets", "copy.glb"), `${POINTER_HEAD}\noid sha256:${a}\nsize 150000\n`);
    writeFileSync(join(work, "assets", "old.glb"), `version https://hawser.github.com/spec/v1\noid sha256:${b}\nsize 50000\n`);
    run("add", "assets");
    run("commit", "-q", "--no-verify", "-m", "media");
    // Over the cap (the legacy pointer counted, the copy once), Pendulum's push Blocks with its reason and sends nothing.
    Object.assign(process.env, { PENDULUM_LOCAL_MEDIA_MAX_MB: "0.15" });
    const box = await openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: origin, local: true, base: root });
    assert.equal(await box.push(), false);
    assert.equal(box.lfsRefused, true);
    assert.match(box.error, /^the branch's Git LFS media is 0\.2 MB \(2 object\(s\)\), over the local limit of 0\.15 MB \(PENDULUM_LOCAL_MEDIA_MAX_MB\)$/);
    assert.equal(decideExit({ harness: { ok: true }, pr: pr(), commits: 1, pushRejected: box.error, lfsRefused: true }).reason, box.error);
    assert.equal(box.errorKind, "", "the local media cap is no quota of GitHub's");
    assert.throws(() => execFileSync("git", ["-C", origin, "rev-parse", "--verify", "pendulum/1"], { stdio: "ignore" }), "nothing reached origin");
    // The pin is Pendulum's own: no sandboxed child or harness gets it.
    const scrubbed = scrubbedEnv({ ...lfsPinEnv("https://github.com/o/r.git"), PENDULUM_LFS_PIN: "1", PATH: "/bin" });
    assert.deepEqual(scrubbed, { PATH: "/bin" });
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("exec group: a run's processes are killed when it ends, one that left the group (setsid) included", async (t) => {
  if (process.platform !== "linux") return t.skip("reads /proc");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pendulum-group-"));
  const r = await exec("sh", ["-c", `sleep 300 & echo $! > ${dir}/a; setsid sh -c 'sleep 300 & echo $! > ${dir}/b; wait' & sleep 0.5; echo done`], { group: true });
  assert.equal(r.stdout.trim(), "done");
  await new Promise((res) => setTimeout(res, 200));
  for (const f of ["a", "b"]) {
    const pid = Number(readFileSync(join(dir, f), "utf8"));
    assert.equal(existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")), false, `${f} (${pid}) still runs`);
  }
});

test("a Question raised in review is answered during the run only by a writer's new decision and a person's ready mark together", async () => {
  const { answerDuring } = await import("../scripts/lib/logic.mjs");
  const startedAt = Date.parse("2026-11-08T10:00:00Z");
  const readAt = Date.parse("2026-11-08T10:02:00Z");
  const decision = (author, seen) => ({ author, key: `comment:${seen}`, at: "2026-11-08T09:00:00Z", seen });
  const ready = (login, type, at) => ({ event: "ready_for_review", actor: { login, type }, created_at: at });
  const writers = new Set(["kirk"]);
  const base = { writers, readAt, startedAt, self: "pendulum-app[bot]" };
  const answer = [decision("Kirk", "2026-11-08T10:05:00Z")];
  const marked = [ready("kirk", "User", "2026-11-08T10:07:00Z")];
  assert.equal(answerDuring({ ...base, unread: answer, events: marked }), "kirk marked the PR ready and 1 maintainer decision(s) arrived during the review");
  assert.equal(answerDuring({ ...base, unread: [decision("stranger", "2026-11-08T10:05:00Z")], events: marked }), "", "a non-writer's comment and a ready mark: the Question stands");
  assert.equal(answerDuring({ ...base, unread: [], events: marked }), "", "a ready mark alone: the Question stands");
  assert.equal(answerDuring({ ...base, unread: answer, events: [] }), "", "a decision alone: the Question stands, the comment stays unread");
  assert.equal(answerDuring({ ...base, unread: [decision("kirk", "2026-11-08T10:01:00Z")], events: marked }), "", "posted before the job read the decisions");
  assert.equal(answerDuring({ ...base, unread: answer, events: [ready("kirk", "User", "2026-11-08T09:59:00Z")] }), "", "a ready mark before the run");
  assert.equal(answerDuring({ ...base, unread: answer, events: [ready("pendulum-app[bot]", "Bot", "2026-11-08T10:07:00Z")] }), "", "Pendulum's own ready mark on Actions");
  assert.equal(answerDuring({ ...base, self: "kirk", unread: answer, events: marked }), "", "local mode: Pendulum marks ready as the developer's login");
  assert.equal(answerDuring({ ...base, self: "someone-else", local: true, unread: answer, events: marked }), "", "local mode keeps the Question: serve runs a ready mark only while the issue is a Question");
});

test("capReached: a job's max_usd is spent at or past it; no cap when max_usd is 0; runs of unknown cost add nothing", () => {
  const runs = [{ usd: 20 }, { usd: null }, { usd: 4.5 }];
  assert.equal(capReached(25, runs), false);
  assert.equal(capReached(24.5, runs), true, "at the cap is spent: the review job starts no further run");
  assert.equal(capReached(10, runs), true);
  assert.equal(capReached(0, runs), false, "max_usd 0 is no cap");
  assert.equal(capReached(25, []), false);
});

test("fix-pass scope: toolchain, lockfile and CI files outside the plan and the red are refused; everything else passes", () => {
  for (const p of ["package-lock.json", "web/pnpm-lock.yaml", ".nvmrc", "rust-toolchain.toml", ".gitlab-ci.yml", ".circleci/config.yml", "Dockerfile", "docker/api.Dockerfile", ".devcontainer/devcontainer.json", "gradle/wrapper/gradle-wrapper.properties", ".husky/pre-commit"]) assert.equal(toolchainFile(p), true, p);
  for (const p of ["src/app.ts", "package.json", "README.md", "docs/toolchain.md", "Dockerfiles/readme.md", "scripts/setup.sh", "src/mytoolchainutil/x.ts"]) assert.equal(toolchainFile(p), false, p);
  // The incident shape: a fix for an unrelated red edits the toolchain download step and the pins. The download step is
  // toolchain by the repository's `toolchain_paths` setting, not by its name.
  const paths = ["scripts/fetch-toolchain.sh"];
  const changed = ["src/parse.ts", "scripts/fetch-toolchain.sh", ".nvmrc", "package-lock.json"];
  const plan = "1. Parser fix: owns `src/parse.ts`, `test/parse.test.ts` (acceptance 1).";
  const red = "FAIL test/parse.test.ts\n  expected 3, received 2\n    at src/parse.ts:41:7";
  assert.deepEqual(fixScopeRefused(changed, { prior: ["src/parse.ts"], texts: [plan, red], paths }), ["scripts/fetch-toolchain.sh", ".nvmrc", "package-lock.json"]);
  // In scope: changed before the fix passes; named by the plan, the issue or the red (path or file name); a lockfile beside its own manifest in scope.
  assert.deepEqual(fixScopeRefused(changed, { prior: ["src/parse.ts", ".nvmrc"], texts: [plan, red], paths }), ["scripts/fetch-toolchain.sh", "package-lock.json"]);
  assert.deepEqual(fixScopeRefused(changed, { prior: ["package.json"], texts: ["npm ci: `package-lock.json` is not in sync with package.json", "bump `scripts/fetch-toolchain.sh` to zig 0.14"], paths }), [".nvmrc"]);
  assert.deepEqual(fixScopeRefused(["web/package-lock.json"], { prior: ["web/package.json"] }), []);
  assert.deepEqual(fixScopeRefused(["web/package-lock.json"], { prior: ["api/package.json"] }), ["web/package-lock.json"]);
  assert.deepEqual(fixScopeRefused(["web/package-lock.json"], { texts: ["Item 2 adds zod to web/package.json"] }), []);
  // A fix pass that adds a dependency changes the manifest (not toolchain) and its own lockfile beside it: in scope, per ecosystem.
  for (const [manifest, lock] of [["package.json", "package-lock.json"], ["package.json", "pnpm-lock.yaml"], ["package.json", "yarn.lock"], ["pyproject.toml", "uv.lock"], ["pyproject.toml", "poetry.lock"], ["Cargo.toml", "Cargo.lock"]]) {
    for (const dir of ["", "services/api/"]) {
      assert.deepEqual(fixScopeRefused([`${dir}${manifest}`, `${dir}${lock}`, "src/parse.ts"], { prior: ["src/parse.ts"], texts: [plan, red] }), [], `${dir}${manifest} with ${dir}${lock}`);
      // The lockfile alone, its manifest neither changed nor named: refused, as before.
      assert.deepEqual(fixScopeRefused([`${dir}${lock}`, "src/parse.ts"], { prior: ["src/parse.ts"], texts: [plan, red] }), [`${dir}${lock}`], `${dir}${lock} alone`);
    }
  }
  // Only that pair: another ecosystem's lockfile, or the manifest's lockfile in another directory, stays out.
  assert.deepEqual(fixScopeRefused(["package.json", "Cargo.lock", "uv.lock"], { texts: [plan, red] }), ["Cargo.lock", "uv.lock"]);
  assert.deepEqual(fixScopeRefused(["pyproject.toml", "package-lock.json", "Cargo.lock"], { texts: [plan, red] }), ["package-lock.json", "Cargo.lock"]);
  assert.deepEqual(fixScopeRefused(["Cargo.toml", "poetry.lock", "yarn.lock"], { texts: [plan, red] }), ["poetry.lock", "yarn.lock"]);
  assert.deepEqual(fixScopeRefused(["web/package.json", "package-lock.json", "api/package-lock.json"], { texts: [plan, red] }), ["package-lock.json", "api/package-lock.json"]);
  assert.deepEqual(fixScopeRefused(["Cargo.lock"], { prior: ["package.json"], texts: ["Item 2 adds zod to package.json"] }), ["Cargo.lock"]);
  // The pair brings in the lockfile only, never a pin beside it.
  assert.deepEqual(fixScopeRefused(["package.json", "package-lock.json", ".nvmrc", ".npmrc"], { texts: [plan, red] }), [".nvmrc", ".npmrc"]);
  // A name inside a longer one is not that file.
  assert.equal(namesPath("see Dockerfile.dev and my.nvmrc.bak", "Dockerfile"), false);
  assert.equal(namesPath("see Dockerfile.dev and my.nvmrc.bak", ".nvmrc"), false);
  assert.equal(namesPath("node version from .nvmrc.", ".nvmrc"), true);
  assert.equal(namesPath("(web/yarn.lock)", "yarn.lock"), true);
  // The repository's own setup and install commands name its setup scripts: toolchain, unless the scope names them.
  // Every argument word is a path to match (one naming no file matches nothing); absolute paths, ~, URLs and .. are none.
  assert.deepEqual(commandPaths(`bash scripts/setup.sh && FOO=1 sh "./tools/install-deps.sh" --dir=vendor/x; curl -fsSL https://x.test/a.sh | sh; source ~/.env; ../up.sh; make setup`), ["scripts/setup.sh", "tools/install-deps.sh", "vendor/x"]);
  assert.deepEqual(setupPaths({ setup: "./scripts/setup.sh", install: "auto" }).paths, ["scripts/setup.sh"]);
  assert.deepEqual(commandPaths("sh configure; bash -e bootstrap; bash -c run.sh; python -m tools.gen"), ["configure", "bootstrap", "run.sh", "tools.gen"], "an interpreter's script operand is a path; every path-looking word of the text too");
  assert.ok(setupPaths({ setup: "python -m tools.gen" }).paths.includes("tools/gen.py"), "the files a module runs are toolchain");
  assert.deepEqual(setupPaths({ setup: "", install: "bash tools/install-deps.sh" }).paths, ["tools/install-deps.sh"]);
  assert.deepEqual(setupPaths({ setup: "", install: "none" }), { paths: [], named: [], scripts: [], unresolved: [] });
  // A dependency list the install command reads is not toolchain: a fix pass that adds a dependency may change it.
  assert.deepEqual(setupPaths({ install: "pip install -r requirements.txt" }).paths, []);
  assert.deepEqual(setupPaths({ install: "pip install -r requirements-dev.txt -c constraints.txt && npm ci --prefix web/package.json" }).paths.filter((p) => /requirements|constraints|package\.json$/.test(p)), []);
  assert.deepEqual(setupPaths({ setup: "bash scripts/setup.sh", install: "poetry install -C api/pyproject.toml && bundle install --gemfile=Gemfile && cargo fetch --locked Cargo.lock" }).paths, ["scripts/setup.sh"]);
  assert.deepEqual(fixScopeRefused(["requirements.txt"], { texts: [plan, red], extra: setupPaths({ install: "pip install -r requirements.txt" }).paths }), []);
  // The common layouts too: a requirements/ or constraints/ directory, a prefixed name. Other files there stay named.
  assert.deepEqual(setupPaths({ install: "pip install -r requirements/dev.txt -r dev-requirements.txt -c constraints/base.in -r test_requirements.txt" }).paths, []);
  assert.deepEqual(setupPaths({ install: "pip install -r requirements/build.sh -r tools/requirements-gen.py" }).paths, ["requirements/build.sh", "tools/requirements-gen.py"]);
  const extra = setupPaths({ setup: "bash scripts/setup.sh" }).paths;
  assert.deepEqual(fixScopeRefused(["src/parse.ts", "scripts/setup.sh", "scripts/other.sh"], { prior: ["src/parse.ts"], texts: [plan, red], extra }), ["scripts/setup.sh"]);
  assert.deepEqual(fixScopeRefused(["scripts/setup.sh"], { texts: ["setup fails: scripts/setup.sh line 3"], extra }), []);
  assert.deepEqual(fixScopeRefused(["scripts/setup.sh"], { prior: ["scripts/setup.sh"], extra }), []);
  assert.deepEqual(fixScopeRefused(["toolchain/fetch.sh"], { texts: [plan, red], paths: ["toolchain/"] }), ["toolchain/fetch.sh"]);
  const reason = fixScopeReason(["a/.nvmrc", "b", "c", "d", "e", "f", "g"]);
  assert.match(reason, /^a fix pass changed a\/\.nvmrc, b, c, d, e and 2 more \(toolchain, lockfile or CI configuration\)/);
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: true }, commits: 2, validation: { passes: 1, green: false, scope: reason } }), { exit: "blocked", reason, cause: "work" });
});

test("#414: toolchain by exact lists and the toolchain_paths setting, never by a name guess; the fence check is asked only about what it may let go", () => {
  // No name guess: a `*toolchain*` file or a `toolchain(s)/` directory is toolchain only on the setting.
  for (const p of ["scripts/install-toolchain.sh", "toolchain/fetch.sh", "tools/toolchains/zig.sh", "src/toolchain/x.ts"]) {
    assert.equal(toolchainFile(p), false, `${p}: no guess`);
    assert.deepEqual(fixScopeRefused([p], {}), [], `${p}: a fix pass may change it`);
  }
  const paths = ["toolchain/", "zig.sh", "/scripts/install-toolchain.sh"];
  for (const p of ["toolchain/fetch.sh", "tools/toolchains/zig.sh", "scripts/install-toolchain.sh"]) assert.equal(toolchainFile(p, paths), true, `${p}: on the setting`);
  assert.equal(toolchainFile("src/toolchain/x.ts", paths), false, "a directory matches from the root, as protected_paths do");
  assert.equal(toolchainFile("a/scripts/install-toolchain.sh", paths), false, "a leading / matches at the root only");
  assert.deepEqual(resolveInputs({ env: {} }).toolchainPaths, [], "empty by default: the exact lists only");
  assert.deepEqual(resolveInputs({ env: { PENDULUM_TOOLCHAIN_PATHS: "toolchain/, scripts/zig.sh" } }).toolchainPaths, ["toolchain/", "scripts/zig.sh"]);
  // What the fence check may let go: a lockfile, nothing else.
  for (const p of ["package-lock.json", "web/yarn.lock", "Cargo.lock", "uv.lock"]) assert.equal(fenceDecidable(p), true, p);
  // Never: version pins, CI and hooks, containers, wrappers, mise.toml, package-manager configuration, the setting's files.
  for (const p of [".nvmrc", ".node-version", ".tool-versions", ".python-version", "rust-toolchain", "rust-toolchain.toml", "global.json", ".ruby-version", ".gitlab-ci.yml", ".circleci/config.yml", "ci/.buildkite/pipeline.yml", ".husky/pre-commit", ".pre-commit-config.yaml", "lefthook.yml", "Jenkinsfile", "Dockerfile", "docker/api.Containerfile", ".devcontainer/devcontainer.json", "gradle/wrapper/gradle-wrapper.properties", ".mvn/wrapper/maven-wrapper.properties", "mise.toml", ".mise.toml", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "bunfig.toml", "pnpm-workspace.yaml"]) assert.equal(fenceDecidable(p), false, p);
  assert.equal(fenceDecidable("toolchain/fetch.sh", { paths }), false, "a toolchain_paths file: refused unless in scope");
  assert.equal(fenceDecidable("src/app.ts"), false, "not toolchain: nothing to judge");
  // Never: a protected path, what setup or install names or runs (with what is under it), the guard's files, a script entry.
  assert.equal(fenceDecidable("yarn.lock", { protectedList: protectedPaths(["/yarn.lock"]) }), false, "a protected path");
  assert.equal(fenceDecidable("tools/yarn.lock", { extra: ["tools/yarn.lock"] }), false, "what setup or install names");
  assert.equal(fenceDecidable("web/package-lock.json", { extra: ["web"] }), false, "under a directory an explicit install names (guardCovers)");
  assert.equal(fenceDecidable("tools/yarn.lock", { guarded: ["tools"] }), false, "what the setup guard covers, under a guarded directory");
  assert.equal(fenceDecidable("package-lock.json", { unknown: ["$SCRIPT"] }), false, "a command that may run a file Pendulum cannot name");
  assert.equal(fenceDecidable("package.json scripts.x/yarn.lock"), false, "a script entry, even one named like a lockfile");
  // Every still-refused file undecided: Pendulum's or the outage's Block; any other among them: the work's.
  const undecided = { cause: "outage", undecided: ["a.lock"], judged: ["a.lock: the decision model (m) gave no answer (unavailable)"] };
  assert.equal(scopeRefusal(["a.lock"], undecided).cause, "outage");
  assert.equal(scopeRefusal(["a.lock", ".npmrc"], undecided).cause, undefined, "a file never asked about makes it the work's");
  // The Block names what the fence check said; its cause is the work's unless it gave no answer.
  const reason = fixScopeReason(["package-lock.json"], [], ["package-lock.json: judged to weaken or sidestep the check at 0.91"]);
  assert.match(reason, /\(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names; the fence check: package-lock\.json: judged to weaken/);
  const exit = (more) => decideExit({ harness: { ok: true }, pr: { exists: true, draft: true }, commits: 2, ...more });
  assert.equal(exit({ validation: { passes: 1, green: false, scope: reason, scopeCause: "outage" } }).cause, "outage");
  assert.equal(exit({ validation: { passes: 1, green: false, scope: reason, scopeCause: "nonsense" } }).cause, "work");
  assert.equal(exit({ pushRejected: reason, pushCause: "pendulum" }).cause, "pendulum");
  assert.equal(exit({ pushRejected: reason }).cause, "work");
});

test("pushRefusal: git's status word, git's own reason and the exit code; never the remote's text", () => {
  const remote = ["To https://x-access-token@github.com/acme/app.git", "remote: error: GH013: Repository rule violations found for refs/heads/pendulum/7.", "!\trefs/heads/incoming:refs/heads/pendulum/7\t[remote rejected] (push declined due to repository rule violations)", "Done"];
  const reason = pushRefusal({ branch: "pendulum/7", out: remote, code: 1 });
  assert.equal(reason, "push rejected: GitHub refused refs/heads/pendulum/7 (remote rejected, exit 1); its message is in the job log");
  assert.doesNotMatch(reason, /GH013|rule|github\.com|declined/);
  assert.equal(pushRefusal({ branch: "pendulum/7", out: ["!\trefs/heads/incoming:refs/heads/pendulum/7\t[rejected] (stale info)"], code: 1 }), "push rejected: GitHub refused refs/heads/pendulum/7 (rejected, GitHub's head moved since Pendulum read it, exit 1); its message is in the job log");
  assert.equal(pushRefusal({ branch: "pendulum/7", out: ["!\trefs/heads/incoming:refs/heads/pendulum/7\t[rejected] (non-fast-forward)"], code: 1 }), "push rejected: GitHub refused refs/heads/pendulum/7 (rejected, non-fast-forward, exit 1); its message is in the job log");
  assert.equal(pushRefusal({ branch: "pendulum/7", out: ["fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host"], code: 128 }), "push rejected: GitHub refused refs/heads/pendulum/7 (exit 128); its message is in the job log");
  assert.equal(decideExit({ harness: { ok: true }, pushRejected: reason }).reason, reason);
});

test("workflowScopeRefused: GitHub's own phrase on the ref's own line only", () => {
  const line = (reason, ref = "pendulum/7") => `!\trefs/heads/incoming:refs/heads/${ref}\t[remote rejected] (${reason})`;
  assert.equal(workflowScopeRefused(line("refusing to allow a Personal Access Token to create or update workflow .github/workflows/pendulum.yml without workflow scope"), "pendulum/7"), true);
  assert.equal(workflowScopeRefused(line("refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"), "pendulum/7"), true);
  assert.equal(workflowScopeRefused(line("refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope"), "pendulum/7"), true);
  // Another ref's line, another reason naming a workflow, a remote: line, git's own rejection.
  assert.equal(workflowScopeRefused(line("refusing to allow a GitHub App to create or update workflow x", "pendulum/70"), "pendulum/7"), false);
  assert.equal(workflowScopeRefused(line("pre-receive hook declined: workflow files are locked"), "pendulum/7"), false);
  assert.equal(workflowScopeRefused("remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`", "pendulum/7"), false);
  assert.equal(workflowScopeRefused("!\trefs/heads/incoming:refs/heads/pendulum/7\t[rejected] (non-fast-forward) workflow", "pendulum/7"), false);
});

test("a file named like an Object.prototype key is never read as a lockfile pair", () => {
  for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(fixScopeRefused([name], { prior: ["src/parse.ts"], texts: ["fix src/parse.ts"], extra: [name] }), [name]);
  }
});

test("hostile member globs are decided in bounded time (pendulum#2618 review)", () => {
  // Member globs come from a file a worker can write; a pattern built to backtrack must not stall the outbox.
  const stars = (n) => `x${"*a".repeat(n)}*b`;
  const deep = Array.from({ length: 30 }, (_, k) => `d${k}`).join("/");
  const cases = [
    [stars(10), `x${"a".repeat(40)}`],
    [stars(14), `x${"a".repeat(40)}`],
    [Array(12).fill("**").join("/") + "/nope", deep],
    [Array(12).fill("**").join("/"), deep],
  ];
  for (const [glob, dir] of cases) {
    const workspaces = workspaceDeclarations("", { "package.json": JSON.stringify({ workspaces: [glob] }) });
    const started = performance.now();
    const refused = fixScopeRefused([`${dir}/package.json`, "package-lock.json"], { workspaces });
    const ms = performance.now() - started;
    assert.ok(ms < 100, `${glob.slice(0, 24)}: ${ms.toFixed(1)} ms`);
    // The star pattern needs a closing b, so it misses; the trailing nope misses; bare ** matches any depth.
    assert.deepEqual(refused, glob.endsWith("**") ? [] : ["package-lock.json"], glob.slice(0, 24));
  }
});


test("Block causes: each Block carries a code from the one closed list; refusals, the cap and GitHub's unstarted job are external, the rest not", async () => {
  const { BLOCK_CAUSES, blockCauseOf, blockMarker, refusalCause } = await import("../scripts/lib/logic.mjs");
  const { stageBlockCause } = await import("../scripts/lib/gateway-relay.mjs");
  assert.deepEqual(Object.keys(BLOCK_CAUSES), ["max-usd", "max-objective-usd", "gateway-budget", "provider-quota", "outage", "setup", "work", "pendulum"]);
  assert.deepEqual(Object.entries(BLOCK_CAUSES).filter(([, c]) => c.external).map(([k]) => k), ["max-usd", "max-objective-usd", "gateway-budget", "provider-quota", "outage"]);
  const ok = { ok: true };
  const cause = (args) => decideExit({ harness: ok, pr: { exists: true }, commits: 1, ...args }).cause;
  assert.equal(cause({ harness: { budgetExceeded: true } }), "max-usd");
  assert.equal(cause({ harness: { refusal: { harness: "codex", status: 429, type: "insufficient_quota" } } }), "provider-quota");
  assert.equal(cause({ harness: { refusal: { harness: "codex", status: null, type: "insufficient_funds" } } }), "gateway-budget");
  assert.equal(cause({ harness: { refusal: { harness: "claude", status: 401, type: "authentication_error" } } }), "setup");
  assert.equal(refusalCause({ harness: "claude", status: 402, type: null }), "provider-quota");
  assert.equal(cause({ validation: { passes: 1, green: false, notStarted: "GitHub never started the job" } }), "outage");
  assert.equal(cause({ validation: { passes: 2, green: false } }), "work");
  assert.equal(cause({ harness: { died: 2 } }), "pendulum");
  // The relay: the gateway's own refusal is the cause; calls of unknown cost never are (#483).
  assert.equal(stageBlockCause("work", { gatewayRefused: { type: "insufficient_funds" } }), "gateway-budget");
  assert.equal(stageBlockCause("max-usd", { unknown: 7 }), "max-usd");
  assert.equal(stageBlockCause("work", null), "work");
  // The notice's cause line: read back by structure; a code off the list is written and read as nothing external.
  assert.equal(blockCauseOf(`@dev Blocked (work): dollar cap reached\n${blockMarker("max-usd")}`), "max-usd");
  assert.equal(blockMarker("bogus"), '<!-- pendulum:block {"cause":"pendulum"} -->');
  assert.equal(blockCauseOf('<!-- pendulum:block {"cause":"bogus"} -->'), null);
  assert.equal(blockCauseOf("@dev Blocked (work): an older notice"), null);
  assert.equal(blockCauseOf(`${blockMarker("max-usd")}\n${blockMarker("work")}`), "work", "the last line is Pendulum's");
});
