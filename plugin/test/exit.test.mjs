import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appJwt, normalizePem } from "../scripts/lib/app-token.mjs";
import { input, parseArgs, resolveInputs } from "../scripts/lib/inputs.mjs";
import { EXIT_PROMPT, QUESTION_TESTS, REASON_MAX, acceptanceEntries, capReached, clip, commandPaths, decideExit, deniedHostsFix, isHostName, diffLines, entryKey, fixRunAllowed, fixScopeReason, fixScopeRefused, isPlaceholder, marker, membershipOnly, mergeChecked, namesPath, parseExitRecord, parseFindings, parseReview, questionCheckPrompt, questionFounded, setupPaths, snapComments, standingQuestions, pushRefusal, toolchainFile, workflowScopeReason, workflowScopeRefused, workspaceDeclarations } from "../scripts/lib/logic.mjs";
import { noReviewReason, reviewAnswer, reviewCallEnd, reviewCallTimeout, reviewMissed, reviewPost, reviewProduced, reviewRetry } from "../scripts/lib/handoff.mjs";
import { exitRecord } from "../scripts/lib/session.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";

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
  assert.equal(isPlaceholder("<!-- factory:placeholder -->\nFactory reviewer: no findings"), true);
  assert.equal(isPlaceholder("No findings here"), false);
});

test("a question exit names the Question rule's test for each question; one that names none is unfounded", () => {
  const breaks = { question: "Rename pnpm dev:yard to pnpm dev:world with no alias?", test: "contract", existing: "pnpm dev:yard, documented in README" };
  const additive = { question: "Is an additive `materials` command acceptable?", test: "additive", existing: "none" };
  assert.deepEqual(QUESTION_TESTS, ["contract", "decision", "access"]);
  assert.equal(questionFounded(breaks), true);
  assert.equal(questionFounded({ ...breaks, test: "decision", existing: "the issue's 2026-11-07 decision" }), true);
  assert.equal(questionFounded({ question: "Grant the workflow contents: write?", test: "access", existing: "contents: read today" }), true);
  for (const q of [additive, { ...breaks, existing: " " }, { ...breaks, existing: undefined }, { ...breaks, question: "" }, "a string question", null]) assert.equal(questionFounded(q), false, JSON.stringify(q));
  // Founded questions alone: no check. The text keeps flowing to the notice as before.
  assert.deepEqual(parseExitRecord(JSON.stringify({ exit: "question", questions: [breaks], reason: "" })), { exit: "question", reason: "", questions: [breaks.question] });
  // The case behind #2528: an addition raised as a Question names no test, so it is unfounded.
  assert.deepEqual(parseExitRecord(JSON.stringify({ exit: "question", questions: [breaks, additive], reason: "" })).unfounded, [additive.question]);
  assert.deepEqual(parseExitRecord('{"exit":"question","questions":[],"reason":"needs a decision"}').unfounded, ["needs a decision"]);
  assert.deepEqual(parseExitRecord('{"exit":"question"}').unfounded, ["a question exit with no question"]);
  // Only a question exit is checked.
  assert.equal("unfounded" in parseExitRecord(JSON.stringify({ exit: "delivered", questions: [additive] })), false);
  assert.equal("unfounded" in parseExitRecord(JSON.stringify({ exit: "blocked", reason: "x", questions: ["q"] })), false);
  // What Factory asks names each unfounded question on one line and the shape of the answer it parses.
  const prompt = questionCheckPrompt(parseExitRecord(JSON.stringify({ exit: "question", questions: ["Is an additive\ncommand acceptable?"] })));
  assert.match(prompt, /^Your exit record raises a Question/);
  assert.match(prompt, /\n1\. Is an additive command acceptable\?\n/);
  assert.match(prompt, /reply with only one JSON object/);
  assert.match(prompt, /\("access"\)/);
  assert.doesNotMatch(prompt, /already name a test/, "nothing stands: no list of questions that stay");
  assert.match(questionCheckPrompt({ questions: ["q"], unfounded: ["q"] }, { file: true }), /write \$FACTORY_OUT\/exit\.json as only one JSON object/);
  // Mixed: the founded question is named as staying, so the answer keeps it.
  const mixed = questionCheckPrompt(parseExitRecord(JSON.stringify({ exit: "question", questions: [breaks, additive] })));
  assert.match(mixed, /\n1\. Is an additive `materials` command acceptable\?\n\nThese questions already name a test and stay in the record as raised; keep their QUESTION: markers and include each unchanged in "questions":\n1\. Rename pnpm dev:yard/);
  assert.match(mixed, /the questions that stay make it "question"/);
  // The record the check answers with parses as a founded Question or a delivery.
  assert.deepEqual(parseExitRecord('{"exit":"delivered","questions":[],"reason":""}'), { exit: "delivered", reason: "", questions: [] });
  assert.match(EXIT_PROMPT, /"test": "contract" \| "decision"/);
});

test("the question check's answer never drops a question that already named a test (mergeChecked)", () => {
  const breaks = { question: "Rename pnpm dev:yard with no alias?", test: "contract", existing: "pnpm dev:yard" };
  const additive = "Is the additive command ok?";
  const mixed = parseExitRecord(JSON.stringify({ exit: "question", questions: [breaks, additive] }));
  assert.deepEqual(standingQuestions(mixed), [breaks.question]);
  const answer = (o) => parseExitRecord(JSON.stringify(o));
  // The #2559 review case: the check answers delivered because none of the listed questions stands; the founded one does.
  assert.deepEqual(mergeChecked(mixed, answer({ exit: "delivered", questions: [], reason: "" })), { exit: "question", reason: "", questions: [breaks.question] });
  // The answer repeats the founded one (deduplicated) and founds the other.
  const founded = { question: additive, test: "decision", existing: "the issue's decision" };
  assert.deepEqual(mergeChecked(mixed, answer({ exit: "question", questions: [breaks, founded] })), { exit: "question", reason: "", questions: [breaks.question, additive] });
  // An answer that still names no test keeps that question unfounded (logged; no second check).
  assert.deepEqual(mergeChecked(mixed, answer({ exit: "question", questions: [additive] })), { exit: "question", reason: "", questions: [breaks.question, additive], unfounded: [additive] });
  // Nothing founded: a delivered answer delivers.
  const lone = parseExitRecord(JSON.stringify({ exit: "question", questions: [additive], part: { remaining: ["item 3"] } }));
  assert.deepEqual(standingQuestions(lone), []);
  assert.deepEqual(mergeChecked(lone, answer({ exit: "delivered" })), { exit: "delivered", reason: "", questions: [], part: { remaining: ["item 3"] } }, "the split part carries over");
  assert.deepEqual(mergeChecked(lone, answer({ exit: "delivered", part: { remaining: [] } })).part, { remaining: [] }, "the answer's own part wins");
  // Blocked or no record answers nothing: the Question stands as raised.
  assert.equal(mergeChecked(lone, answer({ exit: "blocked", reason: "x" })), null);
  assert.equal(mergeChecked(lone, null), null);
});

test("exitRecord: an unfounded Question with no time, budget or metering left stands as raised, and the harness is not asked", async () => {
  const text = JSON.stringify({ exit: "question", questions: ["Is the additive command ok?"], reason: "" });
  const base = { text, harness: "claude", model: "m", session: null, cwd: "/nonexistent", env: {}, eventsFile: null };
  const later = Date.now() + 60 * 60_000;
  for (const [why, args] of [["unmetered", { deadlineAt: later, maxUsd: 5, unmetered: true }], ["time", { deadlineAt: Date.now(), maxUsd: 5 }], ["budget", { deadlineAt: later, maxUsd: 1, spentUsd: 1 }]]) {
    const r = await exitRecord({ ...base, ...args });
    assert.deepEqual(r, { record: parseExitRecord(text), usage: [], basis: "exit file" }, why);
  }
  // A founded Question, a delivery or a block in the exit file is returned as written, with no call.
  const founded = JSON.stringify({ exit: "question", questions: [{ question: "q", test: "contract", existing: "x" }] });
  for (const t of [founded, '{"exit":"delivered"}', '{"exit":"blocked","reason":"r"}']) assert.deepEqual(await exitRecord({ ...base, text: t, deadlineAt: later, maxUsd: 5 }), { record: parseExitRecord(t), usage: [], basis: "exit file" });
  // No exit file and metering lost: blocked without a call (the review answer pass relies on this as well).
  assert.deepEqual((await exitRecord({ ...base, text: undefined, deadlineAt: later, maxUsd: 5, unmetered: true })).record, { exit: "blocked", reason: "unmetered: max_usd cannot be enforced", questions: [] });
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
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 2, green: false } }).reason, "validation red after Factory's second pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 1, green: false } }).reason, "validation red after Factory's first pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, reviewUnaddressed: 2 }).reason, "2 reviewer finding(s) unaddressed after the one pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, record: { exit: "blocked", reason: "The migration needs a credential the runner lacks.", questions: [] } }).reason, "worker blocked: The migration needs a credential the runner lacks.");
  assert.equal(decideExit({ harness: { ok: false, error: "harness error" }, pr: pr(), commits: 2, validation: green }).reason, "harness error");
});

test("no commits: the worker's own exit record decides the Block or Question and its reason, not the generic line", () => {
  const blocked = parseExitRecord('{"exit":"blocked","questions":[],"reason":"The last part needs a receipt the run does not have."}');
  for (const recordBasis of ["exit file", "asked", undefined]) {
    assert.deepEqual(decideExit({ harness: ok, pr: null, commits: 0, record: blocked, recordBasis }), { exit: "blocked", reason: "worker blocked: The last part needs a receipt the run does not have.", cause: "work" }, String(recordBasis));
  }
  const question = parseExitRecord(JSON.stringify({ exit: "question", reason: "", questions: [{ question: "Drop the old route?", test: "contract", existing: "GET /v1/items" }] }));
  assert.deepEqual(decideExit({ harness: ok, pr: null, commits: 0, record: question, recordBasis: "exit file" }), { exit: "question", reason: "question: Drop the old route?" });
  // Factory's own stand-in when the ask could not run is no worker reason: the generic line leads and says why.
  const none = { exit: "blocked", reason: "no exit record and no time left to ask", questions: [] };
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: none, recordBasis: "none" }).reason, "worker ended without commits or a PR; no exit record and no time left to ask");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "blocked", reason: "", questions: [] } }).reason, "worker ended without commits or a PR", "a Block with no reason keeps the generic line");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "delivered", reason: "", questions: [] } }).reason, "worker ended without commits or a PR", "a delivery with nothing delivered Blocks");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 2, record: blocked }).reason, "no PR could be opened for the branch", "with commits, the missing PR is Factory's");
});

test("clip: a long reason ends on a word boundary and shows it was cut", () => {
  const long = `The provider serves every generated mod from a download host ${"that the sandbox never reached ".repeat(8)}end.`;
  const c = clip(long);
  assert.ok(c.length <= REASON_MAX, `${c.length} characters`);
  assert.ok(c.endsWith("…"));
  assert.ok(long.startsWith(c.slice(0, -1)), "a prefix of the reason");
  assert.match(long.slice(c.length - 1), /^\s/, "cut where a word ends");
  assert.equal(clip("short reason."), "short reason.", "nothing cut, nothing marked");
  assert.equal(clip("a".repeat(REASON_MAX)), "a".repeat(REASON_MAX), "exactly the cap is not cut");
  assert.equal(clip(`see https://example.com/${"x".repeat(300)}`), `see https://example.com/${"x".repeat(REASON_MAX - 25)}…`, "one long word is cut inside it");
  assert.equal(clip(`${"word ".repeat(38)}four, five six`), `${"word ".repeat(38)}four…`, "no trailing comma before the mark");
  const blocked = decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 1, green: true }, record: { exit: "blocked", reason: long, questions: [] } });
  assert.equal(blocked.reason, `worker blocked: ${c}`);
  const asked = decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 1, green: true }, record: { exit: "question", reason: "", questions: [long] } });
  assert.equal(asked.reason, `question: ${c}`);
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
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, protectedHits: [".github/x"], record: rec }).deniedHosts, undefined, "a Block of Factory's own carries no host fix");
  assert.equal(deniedHostsFix(["cdn.example.org"]), "The local sandbox denied `cdn.example.org`. If the Objective needs it, add it to `FACTORY_LOCAL_DOMAINS` (a running `serve` reads it when it restarts), then re-apply `factory:objective`.");
  assert.match(deniedHostsFix(["a.example.com", "b.example.com"]), /denied `a\.example\.com`, `b\.example\.com`\. If the Objective needs them, add them to `FACTORY_LOCAL_DOMAINS`/);
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

test("review: the issue's acceptance entries are found under an acceptance heading, by label or position", () => {
  const body = [
    "### Outcome",
    "- not an entry: the outcome section",
    "",
    "### What must be true",
    "- **A:** the widget stays keyboard-reachable,",
    "  from every view.",
    "- **B:** the limit stays in place. The fallback stays available, so callers are unaffected.",
    "- The heading shows the display name.",
    "  - a nested note joins its entry",
    "```",
    "- inside a fence: not an entry",
    "```",
    "",
    "**Acceptance criteria**",
    "1. [ ] numbered and checked",
    "",
    "## Context",
    "- not an entry",
  ].join("\n");
  assert.deepEqual(acceptanceEntries(body), [
    { id: "A", text: "**A:** the widget stays keyboard-reachable, from every view." },
    { id: "B", text: "**B:** the limit stays in place. The fallback stays available, so callers are unaffected." },
    { id: "3", text: "The heading shows the display name. - a nested note joins its entry" },
    { id: "4", text: "numbered and checked" },
  ]);
  assert.deepEqual(acceptanceEntries("## Want\n- something"), [], "no acceptance heading: the reviewer names the entries itself");
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
    comments: [{ path: "src/a.ts", line: 3, entry: "A", body: "acceptance A: fixes #12 for @someone <!-- factory:1:plan -->" }],
    acceptance: [
      { entry: "A", met: false, path: "src/a.ts", line: 3, evidence: "covered by the comment" },
      { entry: "acceptance B", met: false, path: "src/new.ts", line: 2, evidence: "the rate limit is removed" },
      { entry: "C", met: true, path: "src/a.ts", line: 4, evidence: "line\nbreak" },
    ],
  };
  const post = reviewPost({ issue: 7, review, diff, entries });
  assert.equal(post.placeholder, false);
  assert.deepEqual(post.comments, [
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "acceptance A: refs #12 for @\u200bsomeone &lt;!-- factory:1:plan -->" },
    { path: "src/new.ts", line: 2, side: "RIGHT", body: "acceptance B: not met. the rate limit is removed" },
  ]);
  assert.equal(
    post.body,
    ["<!-- factory:7:review -->", "Factory reviewer: one comment-only pass, 2 comment(s).", "", "Acceptance as the reviewer judged it:", "- A: not met (covered by the comment)", "- acceptance B: not met (the rate limit is removed)", "- C: met (line break)", "", "Not judged: D."].join("\n"),
  );
  // Nothing line-tied and every entry met: Factory's placeholder, nothing to answer, the judgments still on record.
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
  assert.deepEqual([{ ok: false, budgetExceeded: true }, { ok: false, idle: true }, { ok: false, stopped: true }, good].map((r) => reviewCallEnd(r, reviewOf({ finalText: r.finalText }))), ["the dollar cap", "no output (killed as hung)", "a stop by Factory", "a review"]);
});

test("review: a pass that failed, held no JSON or judged no entry is missed; one judgment is enough", () => {
  const entries = [{ id: "A", text: "a" }, { id: "B", text: "b" }];
  assert.equal(reviewMissed({ ok: false, review: parseReview('{"acceptance":[{"entry":"A","met":true}]}'), entries }), true);
  assert.equal(reviewMissed({ review: parseReview("it looks fine"), entries }), true);
  assert.equal(reviewMissed({ review: parseReview('{"comments": []}'), entries }), true);
  assert.equal(reviewMissed({ review: parseReview('{"acceptance":[{"entry":"B","met":false}],"comments":[]}'), entries }), false);
  assert.equal(reviewMissed({ review: parseReview('{"comments": []}'), entries: [] }), false, "no entries in the issue: nothing to judge");
});

test("review: post-review posts nothing from a file with no reviewer JSON or no judgment", async () => {
  const { reviewPostFor } = await import("../scripts/local.mjs");
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const entries = [{ id: "A", text: "a" }];
  // Unquoted key: not JSON, so nothing is posted (it would carry the review marker and stop the Action's pass).
  assert.throws(() => reviewPostFor({ issue: 7, text: '{"acceptance": [ {"entry": "A", met: true} ], "comments": []}', file: "f.json", diff, entries }), /f\.json holds no reviewer JSON; nothing posted/);
  assert.throws(() => reviewPostFor({ issue: 7, text: '{"comments": []}', file: "f.json", diff, entries }), /judges none of the issue's acceptance entries \(A\); nothing posted/);
  const post = reviewPostFor({ issue: 7, text: '{"acceptance": [{"entry": "A", "met": true}], "comments": []}', file: "f.json", diff, entries });
  assert.equal(post.placeholder, true);
});

test("review: the prompt lists the issue's entries by id and asks for a judgment of each", async () => {
  const { reviewerPrompt } = await import("../scripts/review.mjs");
  const p = reviewerPrompt({ issue: 5, issueTitle: "t", issueBody: "## Acceptance\n- **A:** one\n- two", prBody: "", diff: "", harness: "claude" });
  assert.match(p, /"acceptance": \[\{"entry": "2", "met": true/);
  assert.match(p, /The issue's acceptance entries, by the ids to use[^\n]*\n- A: \*\*A:\*\* one\n- 2: two\n/);
  assert.match(reviewerPrompt({ issue: 5, issueTitle: "t", issueBody: "## Want\n- x", prBody: "", diff: "", harness: "codex" }), /Name each acceptance entry the issue states by its own label/);
});

test("markers follow the 0.5 idempotent shape lane 1 adopted", () => {
  assert.equal(marker(811, "plan"), "<!-- factory:811:plan -->");
  assert.equal(marker(811, "blocked", "work"), "<!-- factory:811:blocked:work -->");
});

test("inputs: flag, then with:, then workflow env, then default; booleans and lists", () => {
  const env = { FACTORY_INPUT_MAX_USD: "", FACTORY_MAX_USD: "12", FACTORY_INPUT_HARNESS: "codex", FACTORY_VALIDATION: "a, b\nc", FACTORY_AUTO_MERGE: "false", GITHUB_REPOSITORY: "o/r" };
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

test("workflow template renders with defaults for empty values and stays valid YAML-shaped", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const out = renderWorkflow(template, { harness: "claude", max_concurrent: "4", timeout_minutes: "", runs_on: "ubuntu-latest", version: "v1" });
  assert.match(out, /FACTORY_HARNESS: claude/);
  assert.match(out, /max-parallel: 4/);
  assert.match(out, /timeout-minutes: 240/);
  assert.match(out, /uses: clockgrove\/factory@v\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(out, /\{\{\w+\}\}/, "every {{key}} placeholder rendered; ${{ }} expressions stay");
  assert.match(out, /contents: read/);
  assert.doesNotMatch(out, /contents: write/);
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

test("decideExit: a red validation names the command that failed", () => {
  const harness = { ok: true, died: 0 };
  const pr = { exists: true, draft: false, body: "## Assumptions\nnone" };
  assert.equal(decideExit({ harness, pr, commits: 1, validation: { passes: 2, green: false, command: "pnpm test" } }).reason, "validation red after Factory's second pass (pnpm test)");
  assert.equal(decideExit({ harness, pr, commits: 1, validation: { passes: 1, green: false } }).reason, "validation red after Factory's first pass");
  assert.equal(decideExit({ harness, pr, commits: 1, validation: { passes: 3, green: false } }).reason, "validation red after Factory's third pass");
});

test("fixRunAllowed: a red the required checks find first gets a fix run, even on the last pass; later reds stop at the cap", () => {
  // Pass 1 red in the local commands, fixed; pass 2 green locally, then red in the required checks (a browser test only CI runs).
  assert.equal(fixRunAllowed({ passes: 1, maxPasses: 2, fromChecks: false, checksFixed: false }), true);
  assert.equal(fixRunAllowed({ passes: 2, maxPasses: 2, fromChecks: true, checksFixed: false }), true, "the checks' first red is fixed");
  assert.equal(fixRunAllowed({ passes: 3, maxPasses: 2, fromChecks: true, checksFixed: true }), false, "pass 3 is the last");
  assert.equal(fixRunAllowed({ passes: 3, maxPasses: 2, fromChecks: false, checksFixed: true }), false);
  // A local red on the last pass, or a second checks red, stops at the cap as before.
  assert.equal(fixRunAllowed({ passes: 2, maxPasses: 2, fromChecks: false, checksFixed: false }), false);
  assert.equal(fixRunAllowed({ passes: 2, maxPasses: 2, fromChecks: true, checksFixed: true }), false);
});

test("fixRunAllowed: each catch-up merge of Factory's own found red is one pass more, never the change's last (#10)", () => {
  // Pass 1 was red in the checks and fixed; pass 2 is red on Factory's catch-up merge: it gets its fix run.
  assert.equal(fixRunAllowed({ passes: 2, maxPasses: 2, fromChecks: true, checksFixed: true, catchUps: 1 }), true);
  // Pass 3, on the agent's own commit, is the last: a red there stops.
  assert.equal(fixRunAllowed({ passes: 3, maxPasses: 2, fromChecks: true, checksFixed: true, catchUps: 1 }), false);
  // A second catch-up merge found red gets its own pass too; with none, the cap is as before.
  assert.equal(fixRunAllowed({ passes: 3, maxPasses: 2, fromChecks: false, checksFixed: true, catchUps: 2 }), true);
  assert.equal(fixRunAllowed({ passes: 2, maxPasses: 2, fromChecks: false, checksFixed: false }), false);
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

test("harnessActivity: turns, tool calls, sub-agents, tokens and the status line from the harness's own events", async () => {
  const { harnessActivity, activityLine } = await import("../scripts/lib/logic.mjs");
  let t = 0;
  const a = harnessActivity(() => t);
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-opus-5-5"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Planning."},{"type":"tool_use","name":"Agent","input":{"subagent_type":"implementer","description":"Web: reducer"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":13001,"cache_creation_input_tokens":11978,"output_tokens":3}}}',
    '{"type":"system","subtype":"task_started","task_id":"a1","description":"Web: reducer","subagent_type":"implementer"}',
    '{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm test --filter web"}}],"usage":{"input_tokens":10,"output_tokens":5}}}',
    'not json',
    '{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed"}',
  ];
  for (const l of lines) {
    t += 60_000;
    a.feed(l);
  }
  const snap = a.snapshot();
  assert.equal(snap.turns, 1, "a sub-agent's assistant message is not a turn");
  assert.equal(snap.toolCalls, 2);
  assert.equal(snap.lastTool, "Bash: pnpm test --filter web");
  assert.deepEqual([snap.subagentsActive.length, snap.subagentsDone], [0, 1]);
  assert.deepEqual(snap.tokens, { input: 24991, output: 8, written: 11978 }, "cache writes inside the input, counted beside it");
  assert.equal(snap.events, 5);
  const line = activityLine(snap, { harness: "claude", model: "claude-opus-5-5" });
  assert.match(line, /^claude \(claude-opus-5-5\) working: 6 min, 1 turns, 2 tool calls; sub-agents 1 done; active now; 25k tokens in, 8 out; last tool Bash: pnpm test --filter web$/);
  t += 7 * 60_000;
  a.feed('{"type":"system","subtype":"task_started","task_id":"a2","description":"Runtime: journey test","subagent_type":"implementer"}');
  t += 5 * 60_000;
  assert.match(activityLine(a.snapshot(), { harness: "claude" }), /sub-agents 1 active \(implementer: Runtime: journey test, 5 min\), 1 done; last event 5 min ago/);
  a.feed('{"type":"result","total_cost_usd":1.25}');
  assert.match(activityLine(a.snapshot(), { harness: "claude" }), /finished: .*; ended; .*\$1\.25/);
  assert.equal(activityLine(harnessActivity(() => 0).snapshot(), { harness: "codex" }), "codex started 0 min ago; no event from it yet");
  const c = harnessActivity(() => 0);
  c.feed('{"type":"turn.started"}');
  c.feed('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}');
  c.feed('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5}}');
  // input_tokens already includes the cached part, output_tokens the reasoning part.
  assert.deepEqual([c.snapshot().turns, c.snapshot().toolCalls, c.snapshot().lastTool, c.snapshot().tokens], [1, 1, "command: npm test", { input: 100, output: 20, written: 0 }]);
  // Claude reports a resumed session's cost as its running total: the line shows the pass's own share.
  const r = harnessActivity(() => 0);
  r.since("s1", { usd: 12.9695405, tokens: { input: 1, output: 1 } });
  r.feed('{"type":"system","subtype":"init","session_id":"s1"}');
  r.feed('{"type":"result","session_id":"s1","total_cost_usd":14.2617083}');
  assert.match(activityLine(r.snapshot(), { harness: "claude" }), /\$1\.29/);
  r.feed('{"type":"result","session_id":"s2","total_cost_usd":0.5}');
  assert.equal(r.snapshot().usd, 0.5, "another session's total is its own");
});

test("exec: onLine sees each stdout line; a child silent for idleMs is killed and reported idle", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const seen = [];
  const r = await exec(process.execPath, ["-e", "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\n'), 50)"], { onLine: (l) => seen.push(l) });
  assert.deepEqual([r.code, r.idle, seen], [0, false, ["a", "bc"]]);
  const hung = await exec(process.execPath, ["-e", "console.log('x'); setTimeout(() => {}, 60000)"], { idleMs: 300 });
  assert.equal(hung.idle, true);
  assert.ok(hung.signal, "killed by signal");
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
  const bin = mkdtempSync(join(tmpdir(), "factory-eagain-"));
  // After the spawn, as srt does: libuv makes a child's inherited stdio blocking again when it starts it.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nrequire("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));\nsetTimeout(() => process.stdout, 50);\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    // Factory busy for a second after the first line (posting progress, a slow disk): the stream backs up meanwhile.
    const busy = new Int32Array(new SharedArrayBuffer(4));
    let first = true;
    const onLine = () => {
      if (first) Atomics.wait(busy, 0, 0, 1000);
      first = false;
    };
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label: "review", onLine });
    assert.equal(rec.exitCode, 0, rec.stderrTail);
    assert.deepEqual([rec.ok, rec.turns, rec.finalText, /os error 11/.test(rec.stderrTail)], [true, 1, '{"comments": []}', false]);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("exec: fileStdio hands the child regular files and still streams lines, stderr and the idle kill", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const seen = [];
  const r = await exec(process.execPath, ["-e", "const fs=require('fs');const t=(n)=>fs.fstatSync(n).isFile();process.stdout.write('a\\nb');process.stderr.write('e'+t(1)+t(2));setTimeout(()=>process.stdout.write('c\\n'),300)"], { onLine: (l) => seen.push(l), fileStdio: true });
  assert.deepEqual([r.code, r.stdout, r.stderr, seen], [0, "a\nbc\n", "etruetrue", ["a", "bc"]]);
  const hung = await exec(process.execPath, ["-e", "console.log('x'); setTimeout(() => {}, 60000)"], { idleMs: 400, fileStdio: true });
  assert.deepEqual([hung.idle, hung.stdout, !!hung.signal], [true, "x\n", true]);
  await assert.rejects(exec("factory-no-such-command", [], { fileStdio: true }), /ENOENT/);
});

test("exec: a fileStdio run closes each of its descriptors once, so one Factory opens during the run stays open (#2660)", async () => {
  const { closeSync, fstatSync, openSync } = await import("node:fs");
  const { exec } = await import("../scripts/lib/proc.mjs");
  // Opened while the run is live: the numbers its write ends had are free again, and these take them.
  const run = exec(process.execPath, ["-e", "setTimeout(() => console.log('done'), 300)"], { fileStdio: true });
  const mine = [openSync(process.execPath, "r"), openSync(process.execPath, "r")];
  try {
    const r = await run;
    assert.equal(r.stdout, "done\n");
    for (const fd of mine) assert.ok(fstatSync(fd).isFile(), `fd ${fd} is still open`);
    // A child that cannot start: its descriptors are dropped once, whatever events follow the failure.
    await assert.rejects(exec("factory-no-such-command", [], { fileStdio: true }), /ENOENT/);
    const after = [openSync(process.execPath, "r"), openSync(process.execPath, "r")];
    mine.push(...after);
    await new Promise((r) => setTimeout(r, 200));
    for (const fd of mine) assert.ok(fstatSync(fd).isFile(), `fd ${fd} is still open`);
  } finally {
    for (const fd of mine) closeSync(fd);
  }
});

test("exec: a fileStdio child that writes faster than Factory reads still meets the time cap (#2660)", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  // 20 MB/s of 1 KB lines for 3 s, read at about 10 MB/s: a reader that reads to the end before yielding never yields.
  const writer = "const fs=require('fs');const l=Buffer.from('y'.repeat(1023)+'\\n');const c=Buffer.concat(Array(1024).fill(l));let n=0;const t=setInterval(()=>{fs.writeSync(1,c);if(++n===60){clearInterval(t);fs.writeSync(2,'done');}},50);";
  const started = Date.now();
  let lines = 0;
  const r = await exec(process.execPath, ["-e", writer], {
    fileStdio: true,
    timeoutMs: 300,
    onLine: () => {
      lines++;
      const t = performance.now();
      while (performance.now() - t < 0.1);
    },
  });
  assert.deepEqual([r.timedOut, !!r.signal, /done/.test(r.stderr)], [true, true, false], `${Date.now() - started} ms, ${lines} lines`);
});

test("exec: a fileStdio run whose output grows past maxBytes is killed there, its first maxBytes kept (#2660)", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const writer = "const fs=require('fs');const c=Buffer.alloc(256*1024,120);let n=0;const t=setInterval(()=>{fs.writeSync(1,c);if(++n===40){clearInterval(t);fs.writeSync(2,'done');}},50);";
  const r = await exec(process.execPath, ["-e", writer], { fileStdio: true, maxBytes: 1024 * 1024 });
  assert.deepEqual([r.truncated, !!r.signal, r.stdout.length, /done/.test(r.stderr)], [true, true, 1024 * 1024, false]);
});

test("exec: a fileStdio read that fails mid-run stops the run instead of leaving it silent (#2660)", async () => {
  const { closeSync, readdirSync, readlinkSync } = await import("node:fs");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const started = Date.now();
  const run = exec(process.execPath, ["-e", "console.log('x'); setTimeout(() => {}, 5000)"], { fileStdio: true });
  await new Promise((r) => setTimeout(r, 200));
  // Factory's read end of the run's stdout file, closed from under it: the next read fails with EBADF.
  const fd = readdirSync("/proc/self/fd").map(Number).find((n) => {
    try {
      return /factory-stdio-[^/]+\/stdout$/.test(readlinkSync(`/proc/self/fd/${n}`));
    } catch {
      return false;
    }
  });
  assert.ok(fd !== undefined, "the read end is open");
  closeSync(fd);
  const r = await run;
  assert.deepEqual([r.readError, !!r.signal, r.stdout, /reading the run's output failed \(EBADF\)/.test(r.stderr)], ["EBADF", true, "x\n", true]);
  assert.ok(Date.now() - started < 3000, `stopped after ${Date.now() - started} ms`);
});

test("exec: a fileStdio file the child truncates is read again from its start (#2660)", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const r = await exec(process.execPath, ["-e", "const fs=require('fs');fs.writeSync(1,'aaaa\\n');setTimeout(()=>{fs.ftruncateSync(1,0);fs.writeSync(1,'b\\n');},300)"], { fileStdio: true });
  assert.equal(r.stdout, "aaaa\nb\n");
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

test("harnessActivity: background commands are counted apart from sub-agents", async () => {
  const { harnessActivity, activityLine } = await import("../scripts/lib/logic.mjs");
  const a = harnessActivity(() => 0);
  a.feed('{"type":"system","subtype":"task_started","task_id":"b1","description":"pnpm test > /tmp/t.log","task_type":"local_bash"}');
  a.feed('{"type":"system","subtype":"task_started","task_id":"a1","description":"Runtime: journey test","subagent_type":"implementer","task_type":"local_agent"}');
  const snap = a.snapshot();
  assert.deepEqual([snap.subagentsActive.length, snap.backgroundCommands], [1, 1]);
  assert.match(activityLine(snap, { harness: "claude" }), /sub-agents 1 active \(implementer: Runtime: journey test, 0 min\); 1 background command running;/);
});

test("Factory's mirror refuses a branch name that collides with refs under it, before any harness spend", async () => {
  const { openOutbox } = await import("../scripts/lib/outbox.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "factory-refs-"));
  const bare = join(dir, "remote.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", work, "push", "-q", "origin", "main", "main:refs/heads/factory/5/old-slice"]);
  const open = (n) => openOutbox({ branch: `factory/${n}`, defaultBranch: "main", checkout: work, remote: bare, base: dir });
  await assert.rejects(open(5), (e) => e.code === "ref-collision" && /factory\/5 cannot be created: factory\/5\/old-slice exists/.test(e.message));
  const ok = await open(6);
  assert.deepEqual([ok.resumed, ok.start === ok.base], [false, true]);
});

test("decideExit: a refused or rejected push always Blocks with its reason, PR or not", () => {
  const harness = { ok: true, died: 0 };
  assert.equal(decideExit({ harness, pr: null, commits: 3, pushRejected: "push rejected: ! [remote rejected] factory/808 (cannot lock ref)" }).reason, "push rejected: ! [remote rejected] factory/808 (cannot lock ref)");
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
  assert.equal(costByPhase([{ label: "work-1", usd: null }, { label: "exit", usd: 0.1 }]), "");
});

test("Git LFS: a plain blob is refused (renames aside), local mode commits media, comments are no LFS use", async () => {
  const { configureGit } = await import("../scripts/lib/session.mjs");
  const { POINTER_HEAD, lfsMedia, plainLfsBlobs, usesLfs } = await import("../scripts/lib/lfs.mjs");
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync, spawnSync } = await import("node:child_process");
  // No git-lfs filter from the box's own config: exactly the checkout where the binary would go in as a plain blob.
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM, l: process.env.FACTORY_LOCAL };
  delete process.env.FACTORY_LOCAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const work = mkdtempSync(join(tmpdir(), "factory-lfs-"));
    const g = (...a) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    writeFileSync(join(work, ".gitattributes"), "assets/** filter=lfs diff=lfs merge=lfs -text\n");
    g("add", ".gitattributes");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    const base = g("rev-parse", "HEAD").trim();
    assert.equal(await usesLfs(work), true);
    await configureGit(work, { login: "t", protectedList: [] });
    mkdirSync(join(work, "assets"));
    writeFileSync(join(work, "assets", "model.glb"), Buffer.alloc(4096, 7));
    g("add", "assets/model.glb");
    const refused = spawnSync("git", ["-C", work, "commit", "-q", "-m", "media"], { encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /staged as plain git blobs: assets\/model\.glb/);
    g("commit", "-q", "--no-verify", "-m", "media, hook skipped");
    assert.deepEqual(await plainLfsBlobs(work, base), ["assets/model.glb"]);
    // A pointer (what git-lfs's clean filter stages) passes both.
    writeFileSync(join(work, "assets", "model.glb"), `${POINTER_HEAD}\noid sha256:${"a".repeat(64)}\nsize 4096\n`);
    g("add", "assets/model.glb");
    g("commit", "-q", "-m", "pointer");
    assert.deepEqual(await plainLfsBlobs(work, base), []);
    // A pure rename of an old plain file restages nothing: neither the hook nor the check counts it.
    writeFileSync(join(work, "assets", "old.bin"), Buffer.alloc(2048, 3));
    g("add", "assets/old.bin");
    g("commit", "-q", "--no-verify", "-m", "an old plain file");
    const before = g("rev-parse", "HEAD").trim();
    g("mv", "assets/old.bin", "assets/moved.bin");
    g("commit", "-q", "-m", "rename only");
    assert.deepEqual(await plainLfsBlobs(work, before), []);
    // Media committed as a pointer passes (Factory's push uploads it); a plain blob is still refused.
    await configureGit(work, { login: "t", protectedList: [] });
    writeFileSync(join(work, "assets", "new.glb"), `${POINTER_HEAD}\noid sha256:${"b".repeat(64)}\nsize 10\n`);
    g("add", "assets/new.glb");
    const local = spawnSync("git", ["-C", work, "commit", "-q", "-m", "local media"], { encoding: "utf8" });
    assert.equal(local.status, 0, local.stderr);
    writeFileSync(join(work, "assets", "raw.glb"), Buffer.alloc(2048, 9));
    g("add", "assets/raw.glb");
    const raw = spawnSync("git", ["-C", work, "commit", "-q", "-m", "local plain blob"], { encoding: "utf8" });
    assert.notEqual(raw.status, 0);
    assert.match(raw.stderr, /staged as plain git blobs: assets\/raw\.glb/);
    g("reset", "-q", "assets/raw.glb");
    assert.deepEqual(await lfsMedia(work, before), ["assets/new.glb"], "the rename alone is no new media");
    assert.deepEqual(await lfsMedia(work, base), ["assets/model.glb", "assets/moved.bin", "assets/new.glb"]);
    // A commented pattern is no LFS use.
    writeFileSync(join(work, ".gitattributes"), "# assets/** filter=lfs diff=lfs merge=lfs -text\n");
    g("add", ".gitattributes");
    g("commit", "-q", "-m", "LFS off");
    assert.equal(await usesLfs(work), false);
  } finally {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s], ["FACTORY_LOCAL", saved.l]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("Git LFS: a quota refusal is named and Blocks even with a PR open; the endpoint follows the remote", async () => {
  const { lfsEndpoint, lfsQuotaLine } = await import("../scripts/lib/lfs.mjs");
  const out = "Uploading LFS objects:   0% (0/1), 0 B | 0 B/s, done.\nbatch response: This repository is over its data quota. Account responsible for LFS bandwidth should purchase more data packs to restore access.\nerror: failed to push some refs to 'https://github.com/o/r'";
  assert.match(lfsQuotaLine(out), /^This repository is over its data quota/);
  assert.equal(lfsQuotaLine("! [rejected] HEAD -> factory/1 (fetch first)\nerror: failed to push some refs"), null);
  const reason = `Git LFS refused the upload (quota or storage): ${lfsQuotaLine(out)}`;
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, validation: { passes: 1, green: true }, pushRejected: reason, lfsRefused: true, lfsQuota: true }), { exit: "blocked", reason, cause: "provider-quota" });
  // Any other Git LFS refusal (the local cap, a missing endpoint, pointers) is a setup gap.
  assert.equal(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, pushRejected: "the remote has no https Git LFS endpoint to pin the media upload to", lfsRefused: true }).cause, "setup");
  assert.match(decideExit({ harness: { ok: true }, pr: pr(), commits: 2, lfsPlain: ["a.glb"] }).reason, /plain git blobs .*: a\.glb$/);
  assert.equal(lfsEndpoint("https://github.com/o/r"), "https://github.com/o/r.git/info/lfs");
  assert.equal(lfsEndpoint("https://github.com/o/r.git\n"), "https://github.com/o/r.git/info/lfs");
  assert.equal(lfsEndpoint("git@github.com:o/r.git"), null);
});

test("Git LFS: media the default branch gained is not the branch's own after a rebase", async () => {
  const { currentBase, lfsMedia } = await import("../scripts/lib/lfs.mjs");
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const root = mkdtempSync(join(tmpdir(), "factory-lfsbase-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const run = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, work]);
    writeFileSync(join(work, ".gitattributes"), "assets/** filter=lfs diff=lfs merge=lfs -text\n");
    run(work, "add", ".gitattributes");
    run(work, "commit", "-q", "-m", "base");
    run(work, "push", "-q", "origin", "HEAD:main");
    const oldBase = run(work, "rev-parse", "HEAD").trim();
    run(work, "checkout", "-q", "-b", "factory/1");
    writeFileSync(join(work, "code.txt"), "change\n");
    run(work, "add", "code.txt");
    run(work, "commit", "-q", "-m", "code only");
    // The default branch gains media (another PR), and the branch is rebased onto it, as a fix or answer pass does.
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    mkdirSync(join(other, "assets"));
    writeFileSync(join(other, "assets", "golden.png"), "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n");
    run(other, "add", "assets/golden.png");
    run(other, "commit", "-q", "-m", "media on main");
    run(other, "push", "-q", "origin", "HEAD:main");
    run(work, "fetch", "-q", "origin", "main");
    run(work, "rebase", "-q", "origin/main");
    assert.deepEqual(await lfsMedia(work, oldBase), ["assets/golden.png"], "the job's first base counts main's media");
    assert.deepEqual(await lfsMedia(work, await currentBase(work, "main", oldBase)), [], "the current base does not");
  } finally {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
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
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "FACTORY_LOCAL", "FACTORY_LOCAL_MEDIA_MAX_MB", "GH_TOKEN"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GH_TOKEN: "not-a-real-token" });
  try {
    const root = mkdtempSync(join(tmpdir(), "factory-lfspush-"));
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
    // Factory's own git gets the token by env config, for GitHub only: not the LFS storage host, not one a planted
    // .lfsconfig names; and scrubbedEnv takes it all away from every child.
    const { credentialEnv } = await import("../scripts/lib/outbox.mjs");
    const { addGitConfig } = await import("../scripts/lib/session.mjs");
    const own = addGitConfig(lfsPinEnv("https://github.com/o/r.git"), credentialEnv("not-a-real-token"));
    const factoryEnv = { ...lfsPinEnv("https://github.com/o/r.git"), ...own };
    assert.match(fill("github.com", factoryEnv).stdout, /password=not-a-real-token/);
    for (const host of ["github-cloud.s3.amazonaws.com", "example.invalid"]) assert.doesNotMatch(fill(host, factoryEnv).stdout, /password=/, host);
    assert.deepEqual(scrubbedEnv({ PATH: "/bin", ...factoryEnv }), { PATH: "/bin" });
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
    run("checkout", "-q", "-b", "factory/1");
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
    // Over the cap (the legacy pointer counted, the copy once), Factory's push Blocks with its reason and sends nothing.
    Object.assign(process.env, { FACTORY_LOCAL_MEDIA_MAX_MB: "0.15" });
    const box = await openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: work, remote: origin, local: true, base: root });
    assert.equal(await box.push(), false);
    assert.equal(box.lfsRefused, true);
    assert.match(box.error, /^the branch's Git LFS media is 0\.2 MB \(2 object\(s\)\), over the local limit of 0\.15 MB \(FACTORY_LOCAL_MEDIA_MAX_MB\)$/);
    assert.equal(decideExit({ harness: { ok: true }, pr: pr(), commits: 1, pushRejected: box.error, lfsRefused: true }).reason, box.error);
    assert.equal(box.errorKind, "", "the local media cap is no quota of GitHub's");
    assert.throws(() => execFileSync("git", ["-C", origin, "rev-parse", "--verify", "factory/1"], { stdio: "ignore" }), "nothing reached origin");
    // The pin is Factory's own: no sandboxed child or harness gets it.
    const scrubbed = scrubbedEnv({ ...lfsPinEnv("https://github.com/o/r.git"), FACTORY_LFS_PIN: "1", PATH: "/bin" });
    assert.deepEqual(scrubbed, { PATH: "/bin" });
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("Factory's push: a replace ref that adds media is neither counted nor uploaded", async (t) => {
  const { openOutbox } = await import("../scripts/lib/outbox.mjs");
  const { POINTER_HEAD, lfsVersion } = await import("../scripts/lib/lfs.mjs");
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const { createHash, randomBytes } = await import("node:crypto");
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "FACTORY_LOCAL", "FACTORY_LOCAL_MEDIA_MAX_MB"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  try {
    const root = mkdtempSync(join(tmpdir(), "factory-lfsreplace-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const run = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, work]);
    run("lfs", "install", "--local");
    writeFileSync(join(work, ".gitattributes"), "assets/** filter=lfs diff=lfs merge=lfs -text\n");
    run("add", ".gitattributes");
    run("commit", "-q", "-m", "base");
    run("push", "-q", "origin", "HEAD:main");
    // Sandboxed code stores 400 KB, replaces the default branch's commit with one whose tree points at it, drops the
    // remote-tracking refs and works on a branch origin has not seen.
    const bytes = randomBytes(400_000);
    const oid = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
    writeFileSync(join(work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid), bytes);
    const real = run("rev-parse", "HEAD").trim();
    run("checkout", "-q", "-b", "factory/2");
    run("commit", "-q", "--allow-empty", "-m", "work");
    run("checkout", "-q", "-b", "fake", real);
    mkdirSync(join(work, "assets"));
    writeFileSync(join(work, "assets", "big.glb"), `${POINTER_HEAD}\noid sha256:${oid}\nsize 400000\n`);
    run("add", "assets");
    run("commit", "-q", "--amend", "--no-verify", "-m", "base");
    run("checkout", "-q", "factory/2");
    run("replace", real, run("rev-parse", "fake").trim());
    run("update-ref", "-d", "refs/remotes/origin/main");
    Object.assign(process.env, { FACTORY_LOCAL_MEDIA_MAX_MB: "0.1" });
    const box = await openOutbox({ branch: "factory/2", defaultBranch: "main", checkout: work, remote: origin, local: true, base: root });
    assert.equal(await box.push(), true, box.error || "the real branch carries no media");
    assert.equal(existsSync(join(origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)), false, "the replacement's media was not uploaded");
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("stageChanges: a stage answers for what it changed since it started, never for the branch's earlier pushes or the default branch's", async () => {
  const { stageChanges } = await import("../scripts/lib/checkout.mjs");
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  try {
    const root = mkdtempSync(join(tmpdir(), "factory-stage-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const maint = join(root, "maintainer");
    const run = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=m@m", "-c", "user.name=maintainer", ...a], { encoding: "utf8" }).trim();
    const put = (cwd, file, text) => {
      mkdirSync(join(cwd, file, ".."), { recursive: true });
      writeFileSync(join(cwd, file), text);
      run(cwd, "add", file);
    };
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, maint]);
    put(maint, "app.txt", "v1\n");
    run(maint, "commit", "-q", "-m", "base");
    run(maint, "push", "-q", "origin", "HEAD:main");
    // A maintainer answers a Question by pushing a workflow to the Factory branch before the next stage.
    run(maint, "checkout", "-q", "-b", "factory/1");
    put(maint, "app.txt", "v2\n");
    run(maint, "commit", "-q", "-m", "worker's earlier stage");
    put(maint, ".github/workflows/dispatch.yml", "on: workflow_dispatch\n");
    run(maint, "commit", "-q", "-m", "maintainer workflow");
    run(maint, "push", "-q", "origin", "factory/1");
    // main then changes another workflow.
    run(maint, "checkout", "-q", "main");
    put(maint, ".github/workflows/ci.yml", "on: push\n");
    run(maint, "commit", "-q", "-m", "ci on main");
    run(maint, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "-q", origin, work]);
    // The stage starts from the branch as GitHub has it (Factory's mirror reads that; here, the clone does).
    run(work, "checkout", "-q", "-b", "factory/1", "origin/factory/1");
    const start = run(work, "rev-parse", "HEAD");
    assert.deepEqual(await stageChanges(work, start), [], "the maintainer's push before the stage is not the stage's");
    run(work, "rebase", "-q", "origin/main");
    assert.deepEqual(await stageChanges(work, start), [], "a rebase takes main's workflow, the stage made no change");
    const rebased = run(work, "rev-parse", "HEAD");
    // The worker edits a workflow under the maintainer's name, in a commit it passes off as main's: the branch moves onto
    // it, origin/main is pointed at it, and a graft makes it main's parent.
    const main = run(work, "rev-parse", "origin/main");
    run(work, "checkout", "-q", "-b", "fake", main);
    put(work, ".github/workflows/ci.yml", "on: [push, pull_request]\n");
    run(work, "commit", "-q", "--amend", "--author", "maintainer <m@m>", "-m", "ci on main");
    const fake = run(work, "rev-parse", "HEAD");
    run(work, "checkout", "-q", "factory/1");
    run(work, "rebase", "-q", "--onto", fake, main);
    run(work, "update-ref", "refs/remotes/origin/main", fake);
    writeFileSync(join(work, ".git", "info", "grafts"), `${main} ${fake}\n`);
    assert.deepEqual(await stageChanges(work, start), [".github/workflows/ci.yml"], "the worker's own edit counts whoever the author is");
    rmSync(join(work, ".git", "info", "grafts"));
    run(work, "reset", "-q", "--hard", rebased);
    run(work, "revert", "--no-edit", "HEAD");
    assert.deepEqual(await stageChanges(work, start), [".github/workflows/dispatch.yml"], "undoing the maintainer's workflow is a change to it");
  } finally {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("exec group: a run's processes are killed when it ends, one that left the group (setsid) included", async (t) => {
  if (process.platform !== "linux") return t.skip("reads /proc");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "factory-group-"));
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
  const base = { writers, readAt, startedAt, self: "factory-app[bot]" };
  const answer = [decision("Kirk", "2026-11-08T10:05:00Z")];
  const marked = [ready("kirk", "User", "2026-11-08T10:07:00Z")];
  assert.equal(answerDuring({ ...base, unread: answer, events: marked }), "kirk marked the PR ready and 1 maintainer decision(s) arrived during the review");
  assert.equal(answerDuring({ ...base, unread: [decision("stranger", "2026-11-08T10:05:00Z")], events: marked }), "", "a non-writer's comment and a ready mark: the Question stands");
  assert.equal(answerDuring({ ...base, unread: [], events: marked }), "", "a ready mark alone: the Question stands");
  assert.equal(answerDuring({ ...base, unread: answer, events: [] }), "", "a decision alone: the Question stands, the comment stays unread");
  assert.equal(answerDuring({ ...base, unread: [decision("kirk", "2026-11-08T10:01:00Z")], events: marked }), "", "posted before the job read the decisions");
  assert.equal(answerDuring({ ...base, unread: answer, events: [ready("kirk", "User", "2026-11-08T09:59:00Z")] }), "", "a ready mark before the run");
  assert.equal(answerDuring({ ...base, unread: answer, events: [ready("factory-app[bot]", "Bot", "2026-11-08T10:07:00Z")] }), "", "Factory's own ready mark on Actions");
  assert.equal(answerDuring({ ...base, self: "kirk", unread: answer, events: marked }), "", "local mode: Factory marks ready as the developer's login");
  assert.equal(answerDuring({ ...base, self: "someone-else", local: true, unread: answer, events: marked }), "", "local mode keeps the Question: no local loop runs an unlabelled ready PR");
});

test("capReached: a job's max_usd is spent at or past it; no cap when max_usd is 0; unmetered runs add nothing", () => {
  const runs = [{ usd: 20 }, { usd: null }, { usd: 4.5 }];
  assert.equal(capReached(25, runs), false);
  assert.equal(capReached(24.5, runs), true, "at the cap is spent: the review job starts no further run");
  assert.equal(capReached(10, runs), true);
  assert.equal(capReached(0, runs), false, "max_usd 0 is no cap");
  assert.equal(capReached(25, []), false);
});

test("fix-pass scope: toolchain, lockfile and CI files outside the plan and the red are refused; everything else passes", () => {
  for (const p of ["package-lock.json", "web/pnpm-lock.yaml", ".nvmrc", "rust-toolchain.toml", "scripts/install-toolchain.sh", ".gitlab-ci.yml", ".circleci/config.yml", "Dockerfile", "docker/api.Dockerfile", ".devcontainer/devcontainer.json", "gradle/wrapper/gradle-wrapper.properties", ".husky/pre-commit", "toolchain/fetch.sh", "tools/toolchains/zig.sh", "src/toolchain/x.ts"]) assert.equal(toolchainFile(p), true, p);
  for (const p of ["src/app.ts", "package.json", "README.md", "docs/toolchain.md", "Dockerfiles/readme.md", "scripts/setup.sh", "src/mytoolchainutil/x.ts"]) assert.equal(toolchainFile(p), false, p);
  // The incident shape: a fix for an unrelated red edits the toolchain download step and the pins.
  const changed = ["src/parse.ts", "scripts/fetch-toolchain.sh", ".nvmrc", "package-lock.json"];
  const plan = "1. Parser fix: owns `src/parse.ts`, `test/parse.test.ts` (acceptance 1).";
  const red = "FAIL test/parse.test.ts\n  expected 3, received 2\n    at src/parse.ts:41:7";
  assert.deepEqual(fixScopeRefused(changed, { prior: ["src/parse.ts"], texts: [plan, red] }), ["scripts/fetch-toolchain.sh", ".nvmrc", "package-lock.json"]);
  // In scope: changed before the fix passes; named by the plan, the issue or the red (path or file name); a lockfile beside its own manifest in scope.
  assert.deepEqual(fixScopeRefused(changed, { prior: ["src/parse.ts", ".nvmrc"], texts: [plan, red] }), ["scripts/fetch-toolchain.sh", "package-lock.json"]);
  assert.deepEqual(fixScopeRefused(changed, { prior: ["package.json"], texts: ["npm ci: `package-lock.json` is not in sync with package.json", "bump `scripts/fetch-toolchain.sh` to zig 0.14"] }), [".nvmrc"]);
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
  assert.deepEqual(commandPaths(`bash scripts/setup.sh && FOO=1 sh "./tools/install-deps.sh" --dir=vendor/x; curl -fsSL https://x.test/a.sh | sh; source ~/.env; ../up.sh; make setup`), ["scripts/setup.sh", "tools/install-deps.sh", "vendor/x"]);
  assert.deepEqual(setupPaths({ setup: "./scripts/setup.sh", install: "auto" }), ["scripts/setup.sh"]);
  assert.deepEqual(commandPaths("sh configure; bash -e bootstrap && node -e run; python -m pip install x; ruby -e puts; make setup"), ["configure", "bootstrap"], "an interpreter's script operand is a path; inline code and modules are not");
  assert.deepEqual(setupPaths({ setup: "", install: "bash tools/install-deps.sh" }), ["tools/install-deps.sh"]);
  assert.deepEqual(setupPaths({ setup: "", install: "none" }), []);
  // A dependency list the install command reads is not toolchain: a fix pass that adds a dependency may change it.
  assert.deepEqual(setupPaths({ install: "pip install -r requirements.txt" }), []);
  assert.deepEqual(setupPaths({ install: "pip install -r requirements-dev.txt -c constraints.txt && npm ci --prefix web/package.json" }), []);
  assert.deepEqual(setupPaths({ setup: "bash scripts/setup.sh", install: "poetry install -C api/pyproject.toml && bundle install --gemfile=Gemfile && cargo fetch --locked Cargo.lock" }), ["scripts/setup.sh"]);
  assert.deepEqual(fixScopeRefused(["requirements.txt"], { texts: [plan, red], extra: setupPaths({ install: "pip install -r requirements.txt" }) }), []);
  // The common layouts too: a requirements/ or constraints/ directory, a prefixed name. Other files there stay named.
  assert.deepEqual(setupPaths({ install: "pip install -r requirements/dev.txt -r dev-requirements.txt -c constraints/base.in -r test_requirements.txt" }), []);
  assert.deepEqual(setupPaths({ install: "pip install -r requirements/build.sh -r tools/requirements-gen.py" }), ["requirements/build.sh", "tools/requirements-gen.py"]);
  const extra = setupPaths({ setup: "bash scripts/setup.sh" });
  assert.deepEqual(fixScopeRefused(["src/parse.ts", "scripts/setup.sh", "scripts/other.sh"], { prior: ["src/parse.ts"], texts: [plan, red], extra }), ["scripts/setup.sh"]);
  assert.deepEqual(fixScopeRefused(["scripts/setup.sh"], { texts: ["setup fails: scripts/setup.sh line 3"], extra }), []);
  assert.deepEqual(fixScopeRefused(["scripts/setup.sh"], { prior: ["scripts/setup.sh"], extra }), []);
  assert.deepEqual(fixScopeRefused(["toolchain/fetch.sh"], { texts: [plan, red] }), ["toolchain/fetch.sh"]);
  const reason = fixScopeReason(["a/.nvmrc", "b", "c", "d", "e", "f", "g"]);
  assert.match(reason, /^a fix pass changed a\/\.nvmrc, b, c, d, e and 2 more \(toolchain, lockfile or CI configuration\)/);
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: true }, commits: 2, validation: { passes: 1, green: false, scope: reason } }), { exit: "blocked", reason, cause: "work" });
});

test("fix-pass scope: a workspace member's manifest brings its workspace's root lockfile, as the declaration lists members", () => {
  const plan = "1. Parser fix: owns `src/parse.ts` (acceptance 1).";
  const red = "FAIL test/parse.test.ts: cannot find module zod";
  // [ecosystem, declaration files at the workspace root, a member manifest, the root lockfile, a manifest outside the members, an excluded one]
  const layouts = [
    ["pnpm", { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/legacy'\ncatalog:\n  zod: ^4\n", "package.json": '{"private":true}' }, "packages/x/package.json", "pnpm-lock.yaml", "tools/y/package.json", "packages/legacy/package.json"],
    ["npm", { "package.json": JSON.stringify({ private: true, workspaces: ["packages/*", "apps/**", "!apps/old"] }) }, "apps/web/site/package.json", "package-lock.json", "scripts/package.json", "apps/old/package.json"],
    ["yarn", { "package.json": JSON.stringify({ workspaces: { packages: ["./packages/*/"], nohoist: ["**/x"] } }) }, "packages/x/package.json", "yarn.lock", "packages/x/y/package.json", null],
    ["uv", { "pyproject.toml": '[project]\nname = "root"\ndescription = """\n[workspace]\nmembers = ["**"]\n"""\n\n[tool.uv.workspace]\nmembers = [\n  "libs/*", # every lib\n  \'apps/api\',\n]\nexclude = ["libs/seed"]\n' }, "libs/core/pyproject.toml", "uv.lock", "tools/pyproject.toml", "libs/seed/pyproject.toml"],
    ["uv, inline table", { "pyproject.toml": '[tool.uv]\nworkspace = { members = ["libs/*"] }\n' }, "libs/core/pyproject.toml", "uv.lock", "apps/pyproject.toml", null],
    ["cargo", { "Cargo.toml": '[workspace]\nresolver = "2"\nmembers = ["crates/*", "cli"]\nexclude = ["crates/old"]\n\n[workspace.dependencies]\nserde = { version = "1", features = ["derive"] }\n' }, "crates/core/Cargo.toml", "Cargo.lock", "examples/x/Cargo.toml", "crates/old/Cargo.toml"],
  ];
  for (const [eco, files, member, lock, outsider, excluded] of layouts) {
    for (const dir of ["", "mono/"]) {
      const workspaces = workspaceDeclarations(dir, files);
      assert.equal(workspaces.length, 1, `${eco}: one workspace declared`);
      const at = (p) => `${dir}${p}`;
      const scope = (changed, more = {}) => fixScopeRefused(changed, { prior: ["src/parse.ts"], texts: [plan, red], workspaces, ...more });
      // The member manifest changed by the pass, or before it: the root lockfile follows.
      assert.deepEqual(scope([at(member), at(lock), "src/parse.ts"]), [], `${eco} ${dir}: ${member} brings ${lock}`);
      assert.deepEqual(scope([at(lock)], { prior: [at(member)] }), [], `${eco} ${dir}: ${member} changed before`);
      // The root lockfile alone, or with a manifest the declaration does not list or excludes: refused.
      assert.deepEqual(scope([at(lock), "src/parse.ts"]), [at(lock)], `${eco} ${dir}: ${lock} alone`);
      assert.deepEqual(scope([at(outsider), at(lock)]), [at(lock)], `${eco} ${dir}: ${outsider} is not a member`);
      if (excluded) assert.deepEqual(scope([at(excluded), at(lock)]), [at(lock)], `${eco} ${dir}: ${excluded} is excluded`);
      // Only that lockfile: the member's own neighbours, another ecosystem's lockfile, a pin at the root stay out.
      assert.deepEqual(scope([at(member), at(lock), at("Gemfile.lock"), at(".nvmrc"), at("go.sum")]), [at("Gemfile.lock"), at(".nvmrc"), at("go.sum")], `${eco} ${dir}: only ${lock}`);
      // Without the declaration the member is just another directory's manifest: refused, as before.
      assert.deepEqual(fixScopeRefused([at(member), at(lock)], { texts: [plan, red] }), [at(lock)], `${eco} ${dir}: no declaration`);
    }
    // A workspace in another directory, or a member manifest outside its root, does not reach this lockfile.
    assert.deepEqual(fixScopeRefused([member, `mono/${lock}`], { workspaces: workspaceDeclarations("", files) }), [`mono/${lock}`], `${eco}: another root`);
    assert.deepEqual(fixScopeRefused([member, `mono/${lock}`], { workspaces: workspaceDeclarations("mono/", files) }), [`mono/${lock}`], `${eco}: member outside the root`);
  }
  // A declaration's lockfiles only: a pnpm workspace does not bring an npm lockfile, nor an npm one pnpm's.
  assert.deepEqual(fixScopeRefused(["packages/x/package.json", "package-lock.json"], { workspaces: workspaceDeclarations("", layouts[0][1]) }), ["package-lock.json"]);
  assert.deepEqual(fixScopeRefused(["packages/x/package.json", "pnpm-lock.yaml"], { workspaces: workspaceDeclarations("", { "package.json": '{"workspaces":["packages/*"]}' }) }), ["pnpm-lock.yaml"]);
  // Read structurally: a declaration that does not parse, or whose lists are not lists of strings, declares nothing.
  for (const files of [
    { "package.json": "{ workspaces: [packages/*] }" },
    { "package.json": '{"workspaces":"packages/*"}' },
    { "pnpm-workspace.yaml": "base: &b\n  - packages/*\npackages: *b\n" },
    { "Cargo.toml": "[workspace]\nmembers = [1]\n" },
    { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nmembers = ["**"]\n' },
    { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace]\nexclude = []\n' },
    { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = "crates/old"\n' },
    { "Cargo.toml": '[package]\nname = "x"\n# [workspace]\n# members = ["**"]\n' },
    { "pyproject.toml": '[tool.uv.workspace]\nmembers = ["libs/*"\n' },
    { "pyproject.toml": '[tool.poetry]\npackages = [{ include = "libs" }]\n' },
    { "Cargo.toml": '[__proto__.workspace]\nmembers = ["**"]\n' },
    { "pyproject.toml": '[tool.uv.workspace]\nconstructor = 1\nmembers = ["libs/*"]\n' },
  ]) assert.deepEqual(workspaceDeclarations("", files), [], JSON.stringify(files));
  // A member pattern that leaves the root matches nothing.
  assert.deepEqual(fixScopeRefused(["libs/x/Cargo.toml", "mono/Cargo.lock"], { workspaces: workspaceDeclarations("mono/", { "Cargo.toml": '[workspace]\nmembers = ["../libs/*", "/libs/*"]\n' }) }), ["mono/Cargo.lock"]);
});

test("fix-pass scope: pnpm-workspace.yaml is toolchain, unless only its packages list changed", () => {
  const plan = "1. Parser fix: owns `src/parse.ts` (acceptance 1).";
  const red = "FAIL test/parse.test.ts: cannot find module zod";
  const base = "# the workspace\npackages:\n  - 'packages/*'\n\ncatalog:\n  zod: ^4\nonlyBuiltDependencies:\n  - esbuild\noverrides:\n  left-pad: 1.3.0\n";
  const scope = (before, after, more = {}) => fixScopeRefused(["pnpm-workspace.yaml", "src/parse.ts"], { prior: ["src/parse.ts"], texts: [plan, red], membership: membershipOnly(before, after) ? ["pnpm-workspace.yaml"] : [], ...more });
  assert.equal(toolchainFile("pnpm-workspace.yaml"), true);
  assert.equal(toolchainFile("web/pnpm-workspace.yaml"), true);
  // The packages list alone, in either list style, or its comments: workspace membership, allowed.
  assert.deepEqual(scope(base, base.replace("  - 'packages/*'\n", "  - 'packages/*'\n  - 'tools/*'  # tools too\n")), []);
  assert.deepEqual(scope(base, base.replace("  - 'packages/*'\n", "- packages/*\n- apps/*\n# apps\n")), []);
  assert.deepEqual(scope(base, `${base}packages: [packages/*]\n`.replace("packages:\n  - 'packages/*'\n", "")), [], "moved and flow style");
  assert.deepEqual(scope(base, base.replace("# the workspace\n", "")), [], "a column-0 comment");
  // A new file with only packages: allowed; with any other key: refused.
  assert.deepEqual(scope(null, "# members\npackages:\n  - 'packages/*'\n"), []);
  assert.deepEqual(scope(null, "packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - postinstall-thing\n"), ["pnpm-workspace.yaml"]);
  assert.deepEqual(scope(null, "packages:\n  - 'packages/*'\ndangerouslyAllowAllBuilds: true\n"), ["pnpm-workspace.yaml"]);
  // Any other key added, removed or changed: refused, together with a packages change or alone.
  for (const after of [
    base.replace("left-pad: 1.3.0", "left-pad: npm:evil-pad@1.0.0"),
    base.replace("overrides:\n  left-pad: 1.3.0\n", ""),
    base.replace("  - esbuild\n", "  - esbuild\n  - postinstall-thing\n"),
    base.replace("  - 'packages/*'\n", "  - 'packages/*'\n  - 'tools/*'\n").replace("  - esbuild\n", "  - esbuild\n  - postinstall-thing\n"),
    base.replace("zod: ^4", "zod: ^3"),
    `${base}patchedDependencies:\n  zod: patches/zod.patch\n`,
    base.replace("zod: ^4", "zod: '^4'"),
    base.replace("zod: ^4", "zod: ^4 # pinned"),
    base.replace("packages:\n", "packages:\n  # catalogs:\n").replace("catalog:", "'catalog':"),
    base.replace("packages:\n  - 'packages/*'\n", "packages:\n  - 'packages/*'\n__proto__:\n  overrides:\n    zod: 0.0.1\n"),
    base.replace("packages:\n  - 'packages/*'\n", "packages:\n  overrides:\n    zod: 0.0.1\n"),
    base.replace("packages:\n  - 'packages/*'\n", "packages:\n  - 'packages/*'\n-foo: 1\n"),
    null,
  ]) assert.deepEqual(scope(base, after), ["pnpm-workspace.yaml"], JSON.stringify(after));
  // A version that does not parse, before or after: refused.
  assert.deepEqual(scope(base, `${base}overrides:\n  zod: 1\n`), ["pnpm-workspace.yaml"], "a repeated key");
  assert.deepEqual(scope(base, "packages: &p\n  - 'packages/*'\n"), ["pnpm-workspace.yaml"], "an anchor");
  assert.deepEqual(scope("packages: [unclosed\n", "packages:\n  - 'packages/*'\n"), ["pnpm-workspace.yaml"], "the base");
  assert.deepEqual(scope("packages: [a]\n", "\tpackages: [b]\n"), ["pnpm-workspace.yaml"], "a tab");
  // Named by the plan, the issue or a decision, or changed before the fix passes: in scope whatever changed.
  const settings = base.replace("  - esbuild\n", "  - esbuild\n  - sharp\n");
  assert.deepEqual(scope(base, settings, { texts: [plan, red, "Decision: allow sharp's install script in pnpm-workspace.yaml"] }), []);
  assert.deepEqual(scope(base, settings, { prior: ["src/parse.ts", "pnpm-workspace.yaml"] }), []);
  // membership counts for a pnpm-workspace.yaml only, and never for one the setup command names.
  assert.deepEqual(fixScopeRefused([".npmrc"], { membership: [".npmrc"] }), [".npmrc"]);
  assert.deepEqual(fixScopeRefused(["pnpm-workspace.yaml"], { membership: ["pnpm-workspace.yaml"], extra: ["pnpm-workspace.yaml"] }), ["pnpm-workspace.yaml"]);
  // Bounded on hostile input: each is refused, and quickly.
  const started = performance.now();
  for (const after of [
    `packages:\n  - a${" ".repeat(70_000)}b\n`,
    `packages:\n  - a${" ".repeat(1_000)}b\n`.repeat(60),
    `packages:\n  - "a${" ".repeat(1_100)}"\n`,
    "-\n".repeat(5_000),
    `packages:\n  - a\nx: ${"[".repeat(5_000)}${"]".repeat(5_000)}\n`,
    `packages:\n  - a\nx: ${"[".repeat(33)}${"]".repeat(33)}\n`,
  ]) assert.equal(membershipOnly("packages:\n  - a\n", after), false, after.slice(0, 40));
  assert.ok(performance.now() - started < 2_000, `hostile inputs took ${performance.now() - started} ms`);
  assert.equal(membershipOnly(`packages:\n  - a\n${"# c\n".repeat(900)}`, `packages:\n  - b\n${"# c\n".repeat(900)}`), true, "within the bounds");
});

test("fix-pass scope: a hostile workspace declaration, as an earlier pass could have written it, declares nothing and quickly", () => {
  const started = performance.now();
  // One long line: the YAML reader's key match is quadratic in it (about 7 s here unbounded); refused on its length.
  const line = `packages:\n  - 'packages/*'\na${" ".repeat(100_000)}b: 1\n`;
  for (const [file, text] of [
    ["pnpm-workspace.yaml", line],
    ["pnpm-workspace.yaml", `packages: ${"[".repeat(20_000)}${"]".repeat(20_000)}\n`],
    ["pnpm-workspace.yaml", "-\n".repeat(20_000)],
    ["Cargo.toml", `[workspace]\nmembers = ["crates/*"]\nx = ${"[".repeat(100_000)}${"]".repeat(100_000)}\n`],
    ["pyproject.toml", `[tool.uv.workspace]\nmembers = ["libs/*"]\nx = "${"a".repeat(2_000_000)}"\n`],
  ]) assert.deepEqual(workspaceDeclarations("", { [file]: text }), [], `${file} ${text.slice(0, 30)}`);
  assert.ok(performance.now() - started < 1_000, `hostile declarations took ${Math.round(performance.now() - started)} ms`);
  // Past a bound though well formed: declares nothing (the lockfile is then refused), within them as before.
  const many = (n) => `packages:\n  - 'packages/*'\n${"# note\n".repeat(n)}`;
  assert.deepEqual(workspaceDeclarations("", { "pnpm-workspace.yaml": many(1_000) }), []);
  assert.equal(workspaceDeclarations("", { "pnpm-workspace.yaml": many(900) }).length, 1);
  assert.deepEqual(workspaceDeclarations("", { "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n# ${"x".repeat(1_100)}\n` }), []);
  assert.equal(workspaceDeclarations("", { "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n# ${"x".repeat(1_000)}\n` }).length, 1);
  // package.json goes to JSON.parse, linear and not recursive: a long one still declares.
  assert.equal(workspaceDeclarations("", { "package.json": JSON.stringify({ workspaces: ["packages/*"], description: "x".repeat(200_000) }) }).length, 1);
});

test("fix-pass scope: a corrective turn that puts the files back and asks a Question stops the stage with that Question", async () => {
  const { scopeTurnResult } = await import("../scripts/lib/session.mjs");
  const ok = { ok: true, exitCode: 0, turns: 3 };
  const first = [".nvmrc"];
  const question = JSON.stringify({ exit: "question", reason: "needs node 20", questions: ["The fix needs .nvmrc at 20: node 22 drops the parser's API. May it change?"] });
  const delivered = JSON.stringify({ exit: "delivered", reason: "", questions: [] });
  // Put back, and this turn asked: the stage stops (question), naming the files the fix needs; the exit decides on the record.
  const asked = scopeTurnResult({ first, out: [], rec: ok, exitBefore: delivered, exitNow: question });
  assert.equal(asked.question, true);
  assert.match(asked.refused, /^a fix pass changed \.nvmrc /);
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: false }, commits: 2, validation: undefined, record: JSON.parse(question) }).exit, "question", "the caller passes no validation for it: the Question is not lost to a red");
  // Put back without a Question (or with one left from before the turn): validation goes on.
  assert.deepEqual(scopeTurnResult({ first, out: [], rec: ok, exitBefore: delivered, exitNow: delivered }), {});
  assert.deepEqual(scopeTurnResult({ first, out: [], rec: ok, exitBefore: question, exitNow: question }), {});
  // Kept, even with a Question: refused (nothing pushed), no question flag.
  assert.deepEqual(scopeTurnResult({ first, out: [".nvmrc"], rec: ok, exitBefore: delivered, exitNow: question }), { refused: scopeTurnResult({ first, out: [], rec: ok, exitBefore: "", exitNow: question }).refused });
  // Unreadable after the turn: refused, closed.
  assert.match(scopeTurnResult({ first, out: new Error("git diff failed"), rec: ok }).refused, /^the fix pass's changes could not be read: git diff failed/);
  // A capped turn: its record, refused when files are still outside.
  const capped = scopeTurnResult({ first, out: [".nvmrc"], rec: { ...ok, budgetExceeded: true }, exitNow: question });
  assert.equal(capped.harness.budgetExceeded, true);
  assert.equal(capped.question, undefined);
});

test("workflowScopeReason: the cause and what to do, whether the branch changed the file or carries an older one (#2579)", () => {
  const behind = workflowScopeReason({ branch: "factory/7", defaultBranch: "main", paths: [".github/workflows/factory.yml"], own: [] });
  assert.match(behind, /^push rejected \(workflow scope\): GitHub refused factory\/7 because its \.github\/workflows\/factory\.yml is not the version main has/);
  assert.match(behind, /bring the branch up to date with main/);
  const own = workflowScopeReason({ branch: "factory/7", defaultBranch: "main", paths: ["a", "b", "c", "d"], own: ["a", "b", "c", "d"] });
  assert.match(own, /because it changes a, b, c and 1 more, .*a person makes workflow changes/);
  // Blocked as it stands: decideExit keeps a reason that starts with "push rejected".
  assert.equal(decideExit({ harness: { ok: true }, pushRejected: behind }).reason, behind);
  // The branch's workflow files matched the default branch Factory read: it moved again during the push.
  assert.match(workflowScopeReason({ branch: "factory/7", defaultBranch: "main" }), /^push rejected \(workflow scope\): GitHub refused factory\/7 for a workflow file .* main likely changed one again/);
});

test("pushRefusal: git's status word, git's own reason and the exit code; never the remote's text", () => {
  const remote = ["To https://x-access-token@github.com/acme/app.git", "remote: error: GH013: Repository rule violations found for refs/heads/factory/7.", "!\trefs/heads/incoming:refs/heads/factory/7\t[remote rejected] (push declined due to repository rule violations)", "Done"];
  const reason = pushRefusal({ branch: "factory/7", out: remote, code: 1 });
  assert.equal(reason, "push rejected: GitHub refused refs/heads/factory/7 (remote rejected, exit 1); its message is in the job log");
  assert.doesNotMatch(reason, /GH013|rule|github\.com|declined/);
  assert.equal(pushRefusal({ branch: "factory/7", out: ["!\trefs/heads/incoming:refs/heads/factory/7\t[rejected] (stale info)"], code: 1 }), "push rejected: GitHub refused refs/heads/factory/7 (rejected, GitHub's head moved since Factory read it, exit 1); its message is in the job log");
  assert.equal(pushRefusal({ branch: "factory/7", out: ["!\trefs/heads/incoming:refs/heads/factory/7\t[rejected] (non-fast-forward)"], code: 1 }), "push rejected: GitHub refused refs/heads/factory/7 (rejected, non-fast-forward, exit 1); its message is in the job log");
  assert.equal(pushRefusal({ branch: "factory/7", out: ["fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host"], code: 128 }), "push rejected: GitHub refused refs/heads/factory/7 (exit 128); its message is in the job log");
  assert.equal(decideExit({ harness: { ok: true }, pushRejected: reason }).reason, reason);
});

test("workflowScopeRefused: GitHub's own phrase on the ref's own line only", () => {
  const line = (reason, ref = "factory/7") => `!\trefs/heads/incoming:refs/heads/${ref}\t[remote rejected] (${reason})`;
  assert.equal(workflowScopeRefused(line("refusing to allow a Personal Access Token to create or update workflow .github/workflows/factory.yml without workflow scope"), "factory/7"), true);
  assert.equal(workflowScopeRefused(line("refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"), "factory/7"), true);
  assert.equal(workflowScopeRefused(line("refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope"), "factory/7"), true);
  // Another ref's line, another reason naming a workflow, a remote: line, git's own rejection.
  assert.equal(workflowScopeRefused(line("refusing to allow a GitHub App to create or update workflow x", "factory/70"), "factory/7"), false);
  assert.equal(workflowScopeRefused(line("pre-receive hook declined: workflow files are locked"), "factory/7"), false);
  assert.equal(workflowScopeRefused("remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`", "factory/7"), false);
  assert.equal(workflowScopeRefused("!\trefs/heads/incoming:refs/heads/factory/7\t[rejected] (non-fast-forward) workflow", "factory/7"), false);
});

test("a file named like an Object.prototype key is never read as a lockfile pair", () => {
  for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(fixScopeRefused([name], { prior: ["src/parse.ts"], texts: ["fix src/parse.ts"], extra: [name] }), [name]);
  }
});

test("hostile member globs are decided in bounded time (factory#2618 review)", () => {
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
  assert.deepEqual(Object.keys(BLOCK_CAUSES), ["max-usd", "gateway-budget", "provider-quota", "outage", "setup", "work", "factory"]);
  assert.deepEqual(Object.entries(BLOCK_CAUSES).filter(([, c]) => c.external).map(([k]) => k), ["max-usd", "gateway-budget", "provider-quota", "outage"]);
  const ok = { ok: true };
  const cause = (args) => decideExit({ harness: ok, pr: { exists: true }, commits: 1, ...args }).cause;
  assert.equal(cause({ harness: { budgetExceeded: true } }), "max-usd");
  assert.equal(cause({ harness: { budgetExceeded: true, unmetered: true } }), "factory");
  assert.equal(cause({ harness: { refusal: { harness: "codex", status: 429, type: "insufficient_quota" } } }), "provider-quota");
  assert.equal(cause({ harness: { refusal: { harness: "codex", status: null, type: "insufficient_funds" } } }), "gateway-budget");
  assert.equal(cause({ harness: { refusal: { harness: "claude", status: 401, type: "authentication_error" } } }), "setup");
  assert.equal(refusalCause({ harness: "claude", status: 402, type: null }), "provider-quota");
  assert.equal(cause({ validation: { passes: 1, green: false, notStarted: "GitHub never started the job" } }), "outage");
  assert.equal(cause({ validation: { passes: 2, green: false } }), "work");
  assert.equal(cause({ harness: { died: 2 } }), "factory");
  // The relay: the gateway's own refusal is the cause; its shutdown is no max_usd overrun.
  assert.equal(stageBlockCause("work", { gatewayRefused: { type: "insufficient_funds" } }), "gateway-budget");
  assert.equal(stageBlockCause("max-usd", { shut: { calls: 2, why: "x" } }, false), "factory");
  assert.equal(stageBlockCause("max-usd", { shut: { calls: 2, why: "x" } }, true), "max-usd");
  assert.equal(stageBlockCause("work", null), "work");
  // The notice's cause line: read back by structure; a code off the list is written and read as nothing external.
  assert.equal(blockCauseOf(`@dev Blocked (work): dollar cap reached\n${blockMarker("max-usd")}`), "max-usd");
  assert.equal(blockMarker("bogus"), '<!-- factory:block {"cause":"factory"} -->');
  assert.equal(blockCauseOf('<!-- factory:block {"cause":"bogus"} -->'), null);
  assert.equal(blockCauseOf("@dev Blocked (work): an older notice"), null);
  assert.equal(blockCauseOf(`${blockMarker("max-usd")}\n${blockMarker("work")}`), "work", "the last line is Factory's");
});
