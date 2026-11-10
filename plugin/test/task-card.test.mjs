import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { FACTORY_PROTECTED, protectedPaths, protectedTouched, renderTaskCard, taskCardValues } from "../scripts/lib/logic.mjs";
import { validationGroups } from "../scripts/lib/logic.mjs";
import { buildPrompt } from "../scripts/lib/session.mjs";

const template = readFileSync(join(PLUGIN_ROOT, "templates", "task-card.md"), "utf8");

test("renders the plugin's task card with every placeholder filled", () => {
  const values = taskCardValues({ issue: 811, maxUsd: 25, timeoutMinutes: 240, validation: ["pnpm check", "pnpm test"], budgetCommand: "node scripts/check-test-budget.mjs", protectedPaths: protectedPaths(["scripts/test-budget.json"]) });
  const card = renderTaskCard(template, values);
  assert.match(card, /GitHub issue #811 in this repository, unattended/);
  assert.match(card, /Your budget is \$25 and 4 hours/);
  assert.match(card, /Validation commands: pnpm check; pnpm test\./);
  assert.match(card, /Budget command: node scripts\/check-test-budget\.mjs\./);
  assert.match(card, /Protected paths: \.github\/, CODEOWNERS, \.agents\/skills\/, \.claude\/, \.codex\/, scripts\/test-budget\.json\./);
  assert.match(card, /commits on factory\/811, which Factory pushes/);
  assert.match(card, /You never write to GitHub/);
  assert.doesNotMatch(card, /FACTORY_EXIT_FILE|gh pr create|git push/);
  assert.doesNotMatch(card, /\{\{/);
});

test("hours are rounded to one decimal and empty commands read as none", () => {
  const v = taskCardValues({ issue: 1, maxUsd: 5, timeoutMinutes: 100, validation: [], budgetCommand: "", protectedPaths: FACTORY_PROTECTED });
  assert.equal(v.hours, "1.7");
  assert.equal(v.validation, "none");
  assert.equal(v.budget_command, "none");
});

test("a missing placeholder value is an error, not an empty string", () => {
  assert.throws(() => renderTaskCard("hi {{issue}} {{nope}}", { issue: 1 }), /missing values for nope/);
});

test("the prompt is the card followed by the issue verbatim", () => {
  const prompt = buildPrompt({ templatePath: join(PLUGIN_ROOT, "templates", "task-card.md"), issue: 7, issueTitle: "Add thing", issueBody: "## Goal\nDo it.\n\n## Decisions\n- keep X", maxUsd: 10, timeoutMinutes: 60, validation: ["make test"], budgetCommand: "", protectedList: FACTORY_PROTECTED });
  const [card, issue] = prompt.split("\n---\n");
  assert.match(card, /issue #7/);
  assert.match(issue, /Issue #7: Add thing\n\n## Goal\nDo it\.\n\n## Decisions\n- keep X/);
});

test("protected paths: Factory's list plus the repository's, deduped; directory and file rules", () => {
  const list = protectedPaths([".github/", " scripts/test-budget.json ", ""]);
  assert.deepEqual(list, [".github/", "CODEOWNERS", ".agents/skills/", ".claude/", ".codex/", "scripts/test-budget.json"]);
  assert.deepEqual(protectedTouched([".github/workflows/ci.yml", "src/a.ts", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"], list), [".github/workflows/ci.yml", "docs/CODEOWNERS", "scripts/test-budget.json", ".claude/agents/implementer.md"]);
  assert.deepEqual(protectedTouched(["src/x.ts"], list), []);
});

test("protected paths: a leading / anchors a file entry at the root; without it a file name matches at any depth", async () => {
  const files = ["build.mjs", "packages/web/build.mjs", "scripts/ci/setup.sh", "vendor/scripts/ci/setup.sh", "db/x.sql"];
  assert.deepEqual(protectedTouched(files, ["/build.mjs", "/scripts/ci/setup.sh", "/db/"]), ["build.mjs", "scripts/ci/setup.sh", "db/x.sql"]);
  assert.deepEqual(protectedTouched(files, ["build.mjs", "scripts/ci/setup.sh"]), ["build.mjs", "packages/web/build.mjs", "scripts/ci/setup.sh", "vendor/scripts/ci/setup.sh"]);
  assert.deepEqual(protectedTouched(files, ["./build.mjs"]), ["build.mjs", "packages/web/build.mjs"], "a leading ./ anchors nothing, as before");
  // The job's commit hook (session.mjs configureGit) matches the same way.
  const { configureGit } = await import("../scripts/lib/session.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const dir = mkdtempSync(join(tmpdir(), "factory-root-hook-"));
  execFileSync("git", ["init", "-q", dir], { env });
  await configureGit(dir, { login: "t", id: 1, protectedList: [...FACTORY_PROTECTED, "/build.mjs", "/db/", "toolchain.sh"], credentialHelper: null, env });
  const commit = (file) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "x\n");
    execFileSync("git", ["-C", dir, "add", "."], { env });
    try {
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", file], { env, stdio: "pipe" });
      return "ok";
    } catch (e) {
      execFileSync("git", ["-C", dir, "reset", "-q"], { env });
      execFileSync("git", ["-C", dir, "clean", "-qfd"], { env });
      return String(e.stderr).trim();
    }
  };
  assert.equal(commit("packages/web/build.mjs"), "ok", "a nested file of a root-anchored name is the worker's");
  assert.equal(commit("build.mjs"), "factory: refusing commit on protected path(s): build.mjs");
  assert.equal(commit("db/x.sql"), "factory: refusing commit on protected path(s): db/x.sql");
  assert.equal(commit("ci/toolchain.sh"), "factory: refusing commit on protected path(s): ci/toolchain.sh", "an unanchored file name still matches at any depth");
});


test("task card: with required checks the harness runs the tests it touched; without them it runs the commands", () => {
  const withChecks = taskCardValues({ issue: 2, maxUsd: 5, timeoutMinutes: 60, validation: ["pnpm test"], budgetCommand: "", protectedPaths: FACTORY_PROTECTED, ciChecks: ["quality"] });
  assert.match(withChecks.validation_note, /required check \(quality\) on the head Factory pushes.*tests your change touches/);
  const without = taskCardValues({ issue: 2, maxUsd: 5, timeoutMinutes: 60, validation: ["pnpm test"], budgetCommand: "", protectedPaths: FACTORY_PROTECTED });
  assert.equal(without.validation_note, "Run the validation commands before you stop; Factory runs them again.");
});

test("validation commands: consecutive parallel: marks share a group, unmarked ones run alone, the card shows no marks", () => {
  const commands = ["pnpm install-check", "parallel: pnpm test", "parallel: pnpm run test:db", "pnpm build", "parallel: pnpm lint"];
  assert.deepEqual(validationGroups(commands), [["pnpm install-check"], ["pnpm test", "pnpm run test:db"], ["pnpm build"], ["pnpm lint"]]);
  assert.equal(taskCardValues({ issue: 1, maxUsd: 1, timeoutMinutes: 60, validation: commands, protectedPaths: [] }).validation, "pnpm install-check; pnpm test; pnpm run test:db; pnpm build; pnpm lint");
});

test("maintainer decisions: people who can push, no bots or Factory markers, oldest first; the answer prompt carries them", async () => {
  const { maintainerDecisions, decisionsSection } = await import("../scripts/lib/logic.mjs");
  const { answerPrompt } = await import("../scripts/review.mjs");
  const c = (login, assoc, type, at, body) => ({ user: { login, type }, author_association: assoc, created_at: at, body });
  const decisions = maintainerDecisions([
    c("owner", "OWNER", "User", "2026-11-07T09:52:00Z", "Answer: follow the participant set."),
    c("factory[bot]", "NONE", "Bot", "2026-11-07T09:40:00Z", "Plan."),
    c("owner", "OWNER", "User", "2026-11-07T09:30:00Z", "<!-- factory:14:plan -->\nnot a decision"),
    c("stranger", "NONE", "User", "2026-11-07T09:31:00Z", "Answer: ship it as is."),
    c("member", "MEMBER", "User", "2026-11-07T09:10:00Z", "Keep the 1024-octet bound."),
  ]);
  // Who may decide is checked by write access in objectiveDecisions, not here: a private org member reads as CONTRIBUTOR.
  assert.deepEqual(decisions.map((d) => d.author), ["member", "stranger", "owner"]);
  const { setWriters, pushAuthor, trustedAuthor, knownWriter } = await import("../scripts/lib/logic.mjs");
  const privateMember = { user: { login: "kirk-private", type: "User" }, author_association: "CONTRIBUTOR" };
  assert.equal(trustedAuthor(privateMember), false);
  assert.equal(knownWriter("kirk-private"), null);
  setWriters("o/r", ["kirk-private"]);
  assert.equal(trustedAuthor(privateMember), true);
  setWriters("o/other", []);
  assert.equal(trustedAuthor(privateMember), false);
  // What an App saw on a real adopter: the owner as CONTRIBUTOR and an empty writer list; the workflow's notify user counts.
  const { setMaintainers } = await import("../scripts/lib/logic.mjs");
  setWriters("o/r", []);
  assert.equal(knownWriter("kirk-private"), null, "an empty writer list is not a no");
  setMaintainers("o/r", [" @Kirk-Private"]);
  assert.equal(trustedAuthor(privateMember), false, "a bare login is trusted for nothing: it could be renamed away and re-registered");
  setMaintainers("o/r", [" @Kirk-Private#4242"]);
  assert.equal(trustedAuthor({ ...privateMember, user: { ...privateMember.user, id: 4242 } }), true);
  assert.equal(trustedAuthor({ ...privateMember, user: { ...privateMember.user, id: 9999 } }), false, "the login, renamed away and registered by someone else");
  assert.equal(trustedAuthor({ user: { login: "kirk-renamed", type: "User", id: 4242 }, author_association: "CONTRIBUTOR" }), true, "the same account after its own rename");
  assert.equal(trustedAuthor({ user: { login: "stranger", type: "User" }, author_association: "CONTRIBUTOR" }), false);
  assert.equal(pushAuthor({ user: { login: "someone", type: "User" }, author_association: "NONE" }), false);
  assert.match(decisionsSection(decisions), /Keep the 1024-octet bound[\s\S]*participant set/);
  assert.equal(decisionsSection([]), "");
  const p = answerPrompt({ taskCard: "", prNumber: 32, comments: [], decisions });
  assert.match(p, /answered PR #32's question/);
  assert.match(p, /participant set/);
  // A maintainer's change no pass has read (no Question): the answer pass is told so, with the decision.
  const q = answerPrompt({ taskCard: "", prNumber: 59, comments: [], decisions, afterPush: true });
  assert.match(q, /commented on PR #59 after the last pass read the decisions/);
  assert.match(q, /participant set/);
  assert.doesNotMatch(q, /QUESTION:/);
});

test("unread decisions: what no pass read, or edited after the version read; Factory's own review threads are not decisions", async () => {
  const { maintainerDecisions, decisionsRead, decisionsReadMarker, decisionsReadOf, mergeRead, unreadDecisions, setWriters } = await import("../scripts/lib/logic.mjs");
  setWriters("o/r", []);
  const dev = { login: "kirk", type: "User" };
  const at = (m) => `2026-11-07T10:${String(m).padStart(2, "0")}:00Z`;
  const comments = [
    { kind: "comment", id: 1, user: dev, author_association: "OWNER", created_at: at(1), body: "Keep the bound." },
    { kind: "comment", id: 2, user: dev, author_association: "OWNER", created_at: at(2), updated_at: at(30), body: "Use the new name (edited)." },
    // Local mode: Factory's review, its inline finding and the worker's reply all post as the developer's login.
    { kind: "review", id: 70, user: dev, author_association: "OWNER", created_at: at(3), body: "<!-- factory:5:review -->\nFactory reviewer: one pass." },
    { kind: "line", id: 71, pull_request_review_id: 70, user: dev, author_association: "OWNER", created_at: at(3), body: "a.js:4: acceptance 1: off by one." },
    { kind: "line", id: 72, pull_request_review_id: 99, in_reply_to_id: 71, user: dev, author_association: "OWNER", created_at: at(4), body: "a.js:4: Fixed in abc123." },
    // A different maintainer's reply in that thread is their word, and so is a line comment in a review of their own.
    { kind: "line", id: 73, pull_request_review_id: 98, in_reply_to_id: 71, user: { login: "maria", type: "User" }, author_association: "MEMBER", created_at: at(5), body: "a.js:4: No, keep it inclusive." },
    { kind: "line", id: 74, pull_request_review_id: 97, user: dev, author_association: "OWNER", created_at: at(6), body: "b.js:9: This regressed the export." },
  ];
  const decisions = maintainerDecisions(comments);
  assert.deepEqual(decisions.map((d) => d.key), ["comment:1", "comment:2", "line:73", "line:74"]);
  assert.equal(decisions[1].seen, at(30), "an edit is the version a pass must read");

  // The worker read the first two before its run; the line comments came during it, one comment was edited after.
  const worker = decisionsRead(decisions.slice(0, 2).map((d) => ({ ...d, seen: d.at })));
  const self = "factory[bot]";
  const progress = (login, body, extra = {}) => ({ user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, author_association: "OWNER", body: `<!-- factory:5:progress:work:1 -->\nFactory work run 1\n${body}`, ...extra });
  const issueComments = [
    progress(self, decisionsReadMarker(worker)),
    // Only Factory's own progress comments count: another bot, a maintainer, or a marker outside a progress comment do not.
    progress("other-app[bot]", decisionsReadMarker({ "line:74": at(59) })),
    progress("kirk", decisionsReadMarker({ "line:73": at(59) })),
    { user: { login: self, type: "Bot" }, body: decisionsReadMarker({ "comment:2": at(59) }) },
    // A malformed record is ignored, never an error: its decisions stay unread.
    progress(self, "<!-- factory:decisions-read {nope} -->"),
  ];
  const read = decisionsReadOf(issueComments, { issue: 5, self });
  assert.deepEqual(unreadDecisions(decisions, read).map((d) => d.key), ["comment:2", "line:73", "line:74"]);
  // In local mode Factory posts as the developer: their progress comments are the record there.
  assert.deepEqual(Object.keys(decisionsReadOf(issueComments, { issue: 5, self: "Kirk" })), ["line:73"]);
  assert.throws(() => decisionsReadOf(issueComments, { issue: 5, self: null }), /own login is unknown/);
  // The review's answer pass read them all: nothing unread, so the merge may go ahead.
  assert.deepEqual(unreadDecisions(decisions, mergeRead(read, decisionsRead(decisions))), []);
  // No record at all (a PR from before the record existed): every decision is unread, an answer pass rather than a merge.
  assert.equal(unreadDecisions(decisions, {}).length, 4);
});

test("decisions cut for length are not shown, so not recorded as read; the prompt says more exist; unread ones are never cut", async () => {
  const { decisionsRead, decisionsSection, decisionsShown } = await import("../scripts/lib/logic.mjs");
  const { answerFed, answerPrompt } = await import("../scripts/review.mjs");
  const d = (i, size) => ({ author: "kirk", at: `2026-11-07T10:0${i}:00Z`, key: `comment:${i}`, body: `${i}`.repeat(size) });
  const decisions = [d(1, 5000), d(2, 5000), d(3, 5000)];
  assert.deepEqual(decisionsShown(decisions).map((x) => x.key), ["comment:2", "comment:3"]);
  assert.match(decisionsSection(decisions), /1 earlier decision\(s\) are not shown here for length/);
  assert.doesNotMatch(decisionsSection(decisions.slice(1)), /not shown/);
  // The newest is shown whole even when it alone is over the cap: a decision that never fits would stay unread forever.
  assert.deepEqual(decisionsShown([d(4, 20_000)]).map((x) => x.key), ["comment:4"]);
  assert.deepEqual(Object.keys(decisionsRead(decisionsShown(decisions))), ["comment:2", "comment:3"]);
  // The answer pass for unread decisions lists them all, uncut, and records them all.
  const unread = [d(5, 9000), d(6, 9000)];
  assert.doesNotMatch(answerPrompt({ taskCard: "", prNumber: 9, comments: [], decisions: unread, afterPush: true }), /not shown/);
  assert.deepEqual(answerFed({ fresh: true, decisions, listed: unread, afterPush: true }).map((x) => x.key), ["comment:2", "comment:3", "comment:5", "comment:6"]);
  // A resumed pass answering findings gets the decisions as they fit; a fresh one has them in its card only.
  assert.deepEqual(answerFed({ fresh: false, decisions, listed: decisions, afterPush: false }).map((x) => x.key), ["comment:2", "comment:3"]);
  assert.deepEqual(answerFed({ fresh: true, decisions, listed: [], afterPush: false }).map((x) => x.key), ["comment:2", "comment:3"]);
});
