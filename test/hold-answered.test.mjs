// Answered questions on GitHub (#2158): every way a question closes is
// recorded with who answered, on whose behalf and how; its comment is
// edited in place to show it, with no mention; the live status comment,
// status and the report list the decisions; `factory answer --as` and
// FACTORY_ANSWERED_AS name an agent answering on someone's behalf.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answeredBy } from "../dist/display.js";
import { hold, ObjectiveRunner } from "../dist/engine.js";
import { GitHubError } from "../dist/github.js";
import {
  closedComment,
  closingLine,
  commentRequest,
  GitHubSync,
} from "../dist/github-sync.js";
import { mark } from "../dist/markdown.js";
import { statusComment } from "../dist/progress.js";
import {
  answeredVia,
  pendingRequests,
  writeRequest,
} from "../dist/requests.js";
import { closedByReset } from "../dist/reset.js";
import {
  CLOSED_KEPT,
  newObjective,
  recordClosed,
  unshownClosings,
} from "../dist/state.js";
import { recentDecisions } from "../dist/status.js";
import { answeredLines, reportComment } from "../dist/work/finish.js";
import {
  cli,
  closedPort,
  configured,
  installation,
  item,
  offered,
  plan,
  REPO,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

/**
 * `body` without what GitHub never reads a mention in: code spans and
 * blocks, and HTML comments (Factory's markers).
 */
const notified = (body) =>
  body.replace(/(`+)[\s\S]*?\1/g, "").replace(/<!--[\s\S]*?-->/g, "");
const MENTION = /@[\w-]/;

/**
 * A runner on a fresh Objective whose steps never run, on a clock that
 * moves a second each read, so each asking has its own id.
 */
function runner() {
  let at = Date.now();
  return new ObjectiveRunner(
    newObjective(7, new Date()),
    { steps: () => [], status: () => "building" },
    tempDir("factory-answered-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    undefined,
    () => {
      at += 1_000;
      return new Date(at);
    },
  );
}

const COMMENT = `https://github.com/${REPO}/issues/7#issuecomment-99`;

test("a CLI answer and a comment answer close their question with who answered, on whose behalf, how and when", () => {
  const run = runner();
  run.apply(
    "item:a:review",
    hold("Is criterion 2 met?\nThe reviewer can't tell.", [
      { answer: "accept", family: "accept", arg: "2", consequence: "Yes." },
      "cancel",
    ]),
  );
  const [asked] = run.state.holds;
  // The comment GitHub showed it in, kept on the hold.
  run.transact(() =>
    run.shown(
      asked.id,
      new Date().toISOString(),
      true,
      COMMENT.replace("99", "1"),
    ),
  );
  assert.equal(run.state.holds[0].url, COMMENT.replace("99", "1"));
  assert.equal(
    run.transact(() =>
      run.answer(
        "accept",
        "Ran it on this exact tree.",
        "kirk",
        undefined,
        asked.id,
        "2",
        { channel: "cli", as: "Claude Code" },
      ),
    ),
    null,
  );
  const [closed] = run.state.closedHolds;
  assert.equal(closed.id, asked.id);
  assert.equal(closed.summary, "Is criterion 2 met?");
  assert.equal(closed.url, COMMENT.replace("99", "1"));
  assert.ok(closed.question.includes("The reviewer can't tell."));
  assert.ok(!closed.shown);
  const { at, ...closing } = closed.closed;
  assert.ok(Date.parse(at) > 0);
  assert.deepEqual(closing, {
    how: "answered",
    answer: "accept",
    arg: "2",
    text: "Ran it on this exact tree.",
    by: "kirk",
    as: "Claude Code",
    channel: "cli",
  });
  // The step's answer keeps them beside `by`.
  const answer = run.state.answers["item:a:review"];
  assert.equal(answer.by, "kirk");
  assert.equal(answer.as, "Claude Code");
  assert.equal(answer.channel, "cli");

  // A `/factory` comment: its author's login and the comment's URL.
  run.apply("item:b:work", hold("Retry b?"));
  const second = run.state.holds.find((h) => h.step === "item:b:work");
  assert.equal(
    run.transact(() =>
      run.retryNow("octo", second.id, { channel: "comment", comment: COMMENT }),
    ),
    null,
  );
  const answered = run.state.closedHolds.at(-1);
  assert.equal(answered.id, second.id);
  assert.equal(answered.closed.answer, "retry");
  assert.equal(answered.closed.by, "octo");
  assert.equal(answered.closed.channel, "comment");
  assert.equal(answered.closed.comment, COMMENT);
  assert.equal(answered.closed.as, undefined);
  // A refused answer closes nothing.
  run.apply("item:c:work", hold("Retry c?"));
  const third = run.state.holds.find((h) => h.step === "item:c:work");
  assert.ok(
    run.transact(() =>
      run.answer("nope", undefined, "kirk", undefined, third.id),
    ),
  );
  assert.equal(run.state.closedHolds.length, 2);
});

test("a superseded question, a cleared one and a cancelled Objective's questions close without an answer, saying why", () => {
  const run = runner();
  run.apply("item:a:work", hold("First asking."));
  const [first] = run.state.holds;
  // The same step asks again later: the first is superseded by the second.
  run.apply("item:a:work", hold("Second asking."));
  const [second] = run.state.holds;
  assert.notEqual(second.id, first.id);
  const superseded = run.state.closedHolds.find((c) => c.id === first.id);
  assert.equal(superseded.closed.how, "superseded");
  assert.equal(superseded.closed.next, second.id);
  // A repair that clears a question's step closes it as cleared.
  run.apply("item:b:ci", hold("CI?"));
  const ci = run.state.holds.find((h) => h.step === "item:b:ci");
  run.apply("item:b:validate", {
    kind: "repair",
    finding: "broken",
    target: "item:b:work",
    clear: ["item:b:work", "item:b:ci"],
  });
  assert.equal(
    run.state.closedHolds.find((c) => c.id === ci.id).closed.how,
    "cleared",
  );
  // A replan's repair closes it as replanned.
  run.apply("item:d:ci", hold("D?"));
  const d = run.state.holds.find((h) => h.step === "item:d:ci");
  run.apply(
    "final",
    {
      kind: "repair",
      finding: "The operator asked to replan.",
      target: "check",
      clear: ["item:d:ci"],
    },
    true,
  );
  assert.equal(
    run.state.closedHolds.find((c) => c.id === d.id).closed.how,
    "replanned",
  );
  // A `/factory cancel` comment closes every open question as cancelled, by its author.
  run.apply("item:c:work", hold("C?"));
  const open = run.state.holds.map((h) => h.id);
  assert.equal(open.length, 2);
  assert.equal(
    run.transact(() =>
      run.answer("cancel", undefined, "octo", undefined, undefined, undefined, {
        channel: "comment",
        comment: COMMENT,
      }),
    ),
    null,
  );
  assert.deepEqual(run.state.holds, []);
  for (const id of open) {
    const closed = run.state.closedHolds.find((c) => c.id === id).closed;
    assert.equal(closed.how, "cancelled");
    assert.equal(closed.by, "octo");
    assert.equal(closed.channel, "comment");
    assert.equal(closed.comment, COMMENT);
  }
  // The deadline's cancel names no person.
  const timed = runner();
  timed.apply("plan", hold("Plan?"));
  timed.transact(() => timed.cancel("deadline"));
  const [expired] = timed.state.closedHolds;
  assert.equal(expired.closed.how, "cancelled");
  assert.equal(expired.closed.by, "deadline");
  assert.equal(expired.closed.channel, undefined);
});

test("closed questions are kept bounded, once each, with their text cut; a reset closes the questions it drops", () => {
  const state = { closedHolds: undefined };
  const asked = (n) => ({
    id: `s@${n}`,
    step: "s",
    question: `Q${n}`,
    options: offered("retry", "cancel"),
    cause: "question",
    askedAt: "2026-10-28T00:00:00.000Z",
  });
  recordClosed(state, asked(0), {
    how: "answered",
    at: "2026-10-28T00:01:00.000Z",
    text: "x".repeat(5_000),
  });
  assert.equal(state.closedHolds[0].closed.text.length, 2_000);
  recordClosed(state, asked(0), { how: "cancelled", at: "later" });
  assert.equal(state.closedHolds.length, 1, "a question closes once");
  assert.equal(state.closedHolds[0].closed.how, "answered");
  for (let n = 1; n <= CLOSED_KEPT + 5; n++)
    recordClosed(state, asked(n), { how: "answered", at: `t${n}` });
  assert.equal(state.closedHolds.length, CLOSED_KEPT);
  assert.equal(state.closedHolds.at(-1).id, `s@${CLOSED_KEPT + 5}`);
  assert.equal(unshownClosings(state).length, CLOSED_KEPT);

  // A reset: the live record's closings win, the base's others are kept,
  // and a question the old state had open that the rebuilt one lacks is
  // closed as reset; one the rebuilt state keeps open stays open.
  const kept = asked(100);
  const dropped = asked(101);
  const rebuilt = {
    holds: [kept],
    closedHolds: [
      {
        ...state.closedHolds[0],
        closed: { how: "answered", at: "2026-10-28T00:00:00.000Z" },
      },
    ],
  };
  const live = {
    closedHolds: [{ ...state.closedHolds[0], shown: true }],
  };
  closedByReset(
    rebuilt,
    live,
    { holds: [kept, dropped] },
    "2026-10-28T02:00:00.000Z",
  );
  assert.equal(rebuilt.closedHolds.length, 2);
  assert.equal(
    rebuilt.closedHolds[0].shown,
    true,
    "the live record's progress",
  );
  assert.equal(rebuilt.closedHolds[1].id, dropped.id);
  assert.equal(rebuilt.closedHolds[1].closed.how, "reset");
  assert.ok(!rebuilt.closedHolds.some((c) => c.id === kept.id));
});

test("an answered question's comment shows the answer, who, how, when and a redacted excerpt, and mentions no one", () => {
  const secret = "s3cr3t-value-abcdef";
  const closed = {
    id: "item:a:review@1",
    step: "item:a:review",
    item: "a",
    cause: "question",
    askedAt: "2026-10-28T00:00:00.000Z",
    summary: "Is criterion 2 met?",
    question: `Is criterion 2 met? Ask @kirk; the token is ${secret}.`,
    options: [
      { answer: "accept", family: "accept", arg: "2", consequence: "Yes." },
      { answer: "cancel", family: "cancel", consequence: "Ends it." },
    ],
    closed: {
      how: "answered",
      at: "2026-10-28T00:05:00.000Z",
      answer: "accept",
      arg: "2",
      text: `Checked by @ops-2 with ${secret}. ${"more ".repeat(200)}`,
      by: "octo",
      as: "Claude @Code",
      channel: "comment",
      comment: COMMENT,
    },
  };
  const marker = mark(7, "hold", closed.id);
  const body = closedComment(marker, closed, {
    issue: 7,
    secrets: [secret],
  });
  assert.ok(
    body.startsWith(
      `${marker}\n**Answered** \`/factory accept 2\` by \`octo\` (as Claude &#64;Code) in [a \`/factory\` comment](${COMMENT}) at \``,
    ),
  );
  assert.doesNotMatch(body, /Factory needs you|Factory stopped/);
  assert.doesNotMatch(body, new RegExp(secret));
  assert.doesNotMatch(notified(body), MENTION);
  // The excerpt is one quoted line, cut with where the rest is.
  const quote = body.split("\n").find((line) => line.startsWith("> "));
  assert.ok(quote.length < 700, quote.length);
  assert.match(quote, /… \(the run log keeps the rest\)$/);
  assert.match(body, /It asked about Work Item `a`:/);
  assert.match(body, /Its answers were `accept 2`, `cancel`\./);
  // Compact: the question cut as its compact question comment was.
  const long = { ...closed, question: "q".repeat(30_000) };
  assert.ok(
    closedComment(marker, long, { issue: 7, secrets: [], compact: true })
      .length < 5_500,
  );
  assert.ok(
    closedComment(marker, long, { issue: 7, secrets: [] }).length < 21_500,
  );

  // A CLI answer is the operator's: never the host's user name.
  const cliLine = closingLine(
    {
      how: "answered",
      at: closed.closed.at,
      answer: "retry",
      by: "kirk",
      as: "Claude Code",
      channel: "cli",
    },
    [],
  );
  assert.match(
    cliLine,
    /^\*\*Answered\*\* `\/factory retry` by the operator \(as Claude Code\) from the CLI at `/,
  );
  assert.doesNotMatch(cliLine, /kirk/);
  // A failure's question says its step failed, not "Factory stopped".
  const failed = closedComment(
    marker,
    { ...closed, cause: "failure" },
    { issue: 7, secrets: [] },
  );
  assert.match(
    failed,
    /Step `item:a:review` of Work Item `a` had failed, and asked:/,
  );
  // Closed without an answer, each with why.
  const without = (closing) =>
    closingLine({ at: closed.closed.at, ...closing }, []);
  assert.match(
    without({ how: "superseded", next: "item:a:review@2" }),
    /^\*\*Closed without an answer:\*\* Factory asked a newer question in its place \(`item:a:review@2`\)/,
  );
  assert.match(
    without({
      how: "cancelled",
      by: "octo",
      channel: "comment",
      comment: COMMENT,
    }),
    /`octo` in \[a `\/factory` comment\]\([^)]+\) cancelled the Objective/,
  );
  assert.match(
    without({ how: "cancelled", by: "kirk", channel: "cli" }),
    /the operator from the CLI cancelled the Objective/,
  );
  assert.match(
    without({ how: "cancelled", by: "deadline" }),
    /deadline passed, and Factory cancelled it/,
  );
  assert.match(without({ how: "reset" }), /`factory reset` rebuilt/);
  assert.match(without({ how: "cleared" }), /a repair cleared/);
  assert.match(without({ how: "replanned" }), /a replan cleared/);
  assert.match(without({ how: "gate-cleared" }), /was done/);
  assert.match(without({ how: "asked-again" }), /changed again/);
  assert.match(
    without({ how: "declined", by: "kirk" }),
    /declined the discovery/,
  );
  // A link only to a GitHub URL Factory read: anything else is named plainly.
  assert.equal(
    answeredBy({ by: "octo", channel: "comment", comment: "javascript:x" }, []),
    "`octo` in a `/factory` comment",
  );
});

/** A fake GitHub that records comment edits; `refuse` makes each edit throw it. */
function editor(refuse) {
  const edits = [];
  return {
    edits,
    github: {
      repository: REPO,
      editComment: async (issue, marker, body) => {
        if (refuse) throw refuse();
        edits.push({ issue, marker, body });
        return !marker.includes("never-shown");
      },
    },
  };
}

function syncOf(github, events = []) {
  return new GitHubSync(
    github,
    {
      repository: REPO,
      secrets: [],
      operators: ["kirk", "ops-2"],
      progress: { enabled: true, includeQuestions: true },
      queue: { options: { done: "Done", cancelled: "Cancelled" } },
      tracking: { enabled: false },
    },
    { write: (issue, event) => events.push(event) },
    { noteAfterMs: 0, remindAfterMs: 0 },
  );
}

test("the sync edits each closed question's comment once, mentions no one, and a finished Objective settles only after", async () => {
  const run = runner();
  run.apply("item:a:work", hold("Retry a? Tell @kirk."));
  run.apply("item:b:work", hold("Retry b?"));
  const [a, b] = run.state.holds;
  // b was never shown: its comment doesn't exist, and none is posted.
  b.id = "item:b:work@never-shown";
  run.transact(() => {
    run.answer("retry", undefined, "kirk", undefined, a.id, undefined, {
      channel: "cli",
      as: "Claude Code",
    });
    run.answer("retry", undefined, "kirk", undefined, b.id);
  });
  run.state.modules.github = { itemId: "I_7", commentsSince: "" };
  const { edits, github } = editor();
  const sync = syncOf(github);
  assert.equal(unshownClosings(run.state).length, 2);
  sync.closings(run);
  await until(() => !unshownClosings(run.state).length, "both closings shown");
  assert.equal(edits.length, 2);
  const edited = edits.find((e) => e.marker === mark(7, "hold", a.id));
  assert.match(
    edited.body,
    /^<!-- factory:7:hold:item:a:work@[^>]+ -->\n\*\*Answered\*\* `\/factory retry` by the operator \(as Claude Code\) from the CLI/,
  );
  assert.doesNotMatch(
    notified(edited.body),
    MENTION,
    "no operator is mentioned",
  );
  // Shown: the closing keeps its summary only.
  for (const closed of run.state.closedHolds) {
    assert.equal(closed.shown, true);
    assert.equal(closed.question, undefined);
    assert.equal(closed.options, undefined);
  }
  sync.closings(run);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(edits.length, 2, "never edited twice");

  // A finished Objective settles only once its closings are shown.
  const done = {
    ...newObjective(8, new Date()),
    status: "cancelled",
    modules: {
      github: {
        itemId: "I_8",
        commentsSince: "",
        shown: "Cancelled",
        cancelShown: true,
        statusGivenUp: true,
      },
    },
  };
  assert.equal(sync.synced(done), true);
  recordClosed(
    done,
    {
      id: "x@1",
      step: "x",
      question: "Q",
      options: [],
      cause: "question",
      askedAt: "t",
    },
    { how: "cancelled", at: "t" },
  );
  assert.equal(sync.synced(done), false);
});

test("a refused closing edit is written compact, then given up and logged", async () => {
  const run = runner();
  run.apply("item:a:work", hold("q".repeat(30_000)));
  const [a] = run.state.holds;
  run.transact(() => run.answer("retry", undefined, "kirk", undefined, a.id));
  run.state.modules.github = { itemId: "I_7", commentsSince: "" };
  const events = [];
  let calls = 0;
  const sync = syncOf(
    {
      repository: REPO,
      editComment: async () => {
        calls += 1;
        throw new GitHubError("GitHub PATCH: 422 body too long", 422);
      },
    },
    events,
  );
  sync.closings(run);
  await until(
    () => events.some((e) => e.event === "question-compacted"),
    "compact",
  );
  assert.ok(!run.state.closedHolds[0].shown);
  // Its backoff over, the compact edit is refused too: given up.
  const key = `ask:7:${a.id}`;
  for (let i = 0; i < 5 && !run.state.closedHolds[0].shown; i++) {
    await until(() => !sync.jobs.active(key), "the edit ends");
    sync.jobs.forget(key);
    sync.closings(run);
    await until(() => !sync.jobs.active(key), "the edit ends");
  }
  assert.equal(run.state.closedHolds[0].shown, true);
  assert.ok(calls >= 2);
  const given = events.find((e) => e.event === "closed-question-given-up");
  assert.equal(given.hold, a.id);
});

test("a /factory comment's request carries the comment's URL, and a stored request's as and url must be text", () => {
  const dir = tempDir("factory-answered-requests-");
  const sync = syncOf({ repository: REPO });
  sync.request(
    7,
    {
      id: 99,
      login: "octo",
      body: "/factory retry --question q1",
      createdAt: "2026-10-28T00:00:00Z",
      url: COMMENT,
    },
    true,
    { requestsDir: dir },
  );
  const [pending] = pendingRequests(dir);
  assert.equal(pending.stored.url, COMMENT);
  assert.equal(pending.stored.source, "github");
  assert.equal(pending.stored.by, "octo");
  assert.deepEqual(
    commentRequest(
      7,
      { body: "/factory retry --question q1", createdAt: "t" },
      true,
    ),
    {
      kind: "answer",
      issue: 7,
      answer: "retry",
      writtenAt: "t",
      question: "q1",
    },
  );
  const other = tempDir("factory-answered-requests-");
  writeRequest(other, { kind: "cancel", issue: 7 }, "kirk", "bad", undefined, {
    as: "Claude Code",
  });
  const [ok] = pendingRequests(other);
  assert.equal(ok.stored.as, "Claude Code");
  // How the service passes each on (requests.ts `answeredVia`).
  assert.deepEqual(answeredVia(ok.stored), {
    channel: "cli",
    as: "Claude Code",
  });
  assert.deepEqual(answeredVia(pending.stored), {
    channel: "comment",
    comment: COMMENT,
  });
  const file = join(other, "bad.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.as = 5;
  writeFileSync(file, JSON.stringify(stored));
  assert.match(pendingRequests(other)[0].problem, /its as isn't text/);
});

test("status, the live status comment and the report list the recent decisions with who answered and how", () => {
  const state = newObjective(7, new Date());
  const asked = (id, question) => ({
    id,
    step: "item:a:work",
    item: "a",
    question,
    options: offered("retry", "cancel"),
    cause: "question",
    askedAt: "2026-10-28T00:00:00.000Z",
    url: `https://github.com/${REPO}/issues/7#issuecomment-${id.length}`,
  });
  recordClosed(state, asked("q@1", "Retry, @kirk?"), {
    how: "answered",
    at: "2026-10-28T00:01:00.000Z",
    answer: "retry",
    by: "kirk",
    as: "Claude Code",
    channel: "cli",
  });
  recordClosed(state, asked("q@22", "Which set?"), {
    how: "answered",
    at: "2026-10-28T00:02:00.000Z",
    answer: "accept",
    arg: "2",
    text: "y".repeat(1_000),
    by: "octo",
    channel: "comment",
    comment: COMMENT,
  });
  recordClosed(state, asked("q@333", "Old?"), {
    how: "superseded",
    at: "2026-10-28T00:03:00.000Z",
    next: "q@4444",
  });
  const recent = recentDecisions(state);
  assert.deepEqual(
    recent.map((r) => [r.id, r.closed.how, r.closed.as]),
    [
      ["q@1", "answered", "Claude Code"],
      ["q@22", "answered", undefined],
      ["q@333", "superseded", undefined],
    ],
  );
  assert.equal(recent[1].closed.text.length, 300, "status cuts the text");
  assert.equal(
    recent[0].url,
    `https://github.com/${REPO}/issues/7#issuecomment-3`,
  );

  const { body } = statusComment(
    "<!-- marker -->",
    {
      view: {
        issue: 7,
        phase: "building",
        mode: "running",
        nextAction: { reason: "Work goes on." },
        items: [],
        waiting: [],
        holds: [],
        recentDecisions: recent,
      },
      activity: {},
      calls: { planner: 0, worker: 0, tokens: 0 },
      running: [],
      decisions: [],
    },
    [],
    { questions: true },
    Date.now(),
  );
  const section = body.slice(body.indexOf("**Recent decisions**"));
  assert.match(
    section,
    /- \[`q@1`\]\(https:\/\/github\.com\/drill\/target\/issues\/7#issuecomment-3\): Retry, &#64;kirk\? → `retry` by the operator \(as Claude Code\) from the CLI, `/,
  );
  assert.match(section, /→ `accept 2` by `octo` in \[a `\/factory` comment\]/);
  assert.match(section, /→ closed without an answer \(superseded\)/);
  assert.doesNotMatch(notified(section), MENTION);

  // The report lists the answers, the operator's as "the operator".
  const lines = answeredLines(state, []);
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^- \[`q@1`\]\([^)]+\): `retry` by the operator \(as Claude Code\) from the CLI, at `/,
  );
  assert.match(lines[1], /`accept 2` by `octo` in \[a `\/factory` comment\]/);
  const report = reportComment(
    mark(7, "report", "run"),
    {
      ...state,
      done: {
        plan: plan([item("a")]),
        final: { commit: "c".repeat(40), commands: [] },
      },
    },
    ["kirk"],
  );
  assert.match(report, /\n\nQuestions answered:\n- \[`q@1`\]/);
  assert.ok(report.endsWith("\n\n@kirk"), "the report's own mention stays");
});

test("factory answer --as and FACTORY_ANSWERED_AS record who answered on the operator's behalf, through the service to status and the run log", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const now = new Date().toISOString();
  const asked = (id, step) => ({
    id,
    step,
    item: step.split(":")[1],
    question: `${id}?`,
    options: offered("retry", "cancel"),
    cause: "question",
    askedAt: now,
  });
  seed(inst, 31, "holding", {
    holds: [asked("qa", "item:a:work"), asked("qb", "item:b:work")],
    done: {
      check: {},
      plan: plan(
        ["a", "b"].map((id) => item(id, { ownedPaths: [`src/${id}.ts`] })),
      ),
    },
  });
  // Refused before anything is written: an empty or multi-line --as.
  for (const bad of ["", "two\nlines", "x".repeat(101)]) {
    const result = cli(
      inst,
      "answer",
      "31",
      "retry",
      "--question",
      "qa",
      "--as",
      bad,
    );
    assert.equal(result.code, 2, bad);
    assert.equal(refusal(result), "usage");
  }
  assert.ok(
    !existsSync(inst.requests) ||
      !readdirSync(inst.requests).some((name) => name.endsWith(".json")),
    "no request was written",
  );
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const answered = cli(
    inst,
    "answer",
    "31",
    "retry",
    "--question",
    "qa",
    "--as",
    "Claude Code",
  );
  assert.equal(answered.code, 0, answered.err);
  // The environment names it for any CLI request.
  inst.env.FACTORY_ANSWERED_AS = "Codex";
  const retried = cli(inst, "retry", "31", "--question", "qb");
  assert.equal(retried.code, 0, retried.err);
  delete inst.env.FACTORY_ANSWERED_AS;
  const state = stateOf(inst, 31);
  const closed = Object.fromEntries(
    state.closedHolds.map((c) => [c.id, c.closed]),
  );
  assert.equal(closed.qa.as, "Claude Code");
  assert.equal(closed.qb.as, "Codex");
  for (const id of ["qa", "qb"]) {
    assert.equal(closed[id].how, "answered");
    assert.equal(closed[id].channel, "cli");
    assert.equal(closed[id].by, process.env.USER ?? "operator");
  }
  // status --json lists them; the text names who answered and as whom.
  const [view] = status(inst).objectives;
  assert.deepEqual(
    view.recentDecisions.map((r) => [r.id, r.closed.as]),
    [
      ["qa", "Claude Code"],
      ["qb", "Codex"],
    ],
  );
  const text = cli(inst, "status", "31").out;
  assert.match(
    text,
    /Recent decisions:\n {4}qa: answered retry by \S+ \(as Claude Code\) via cli at /,
  );
  // The run log's request event carries it beside `by`.
  const logs = join(inst.logs, "31");
  const events = readdirSync(logs)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(logs, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.event === "request");
  assert.deepEqual(
    events.map((event) => event.as),
    ["Claude Code", "Codex"],
  );
  assert.equal(cli(inst, "cancel", "31").code, 0);
  await stopped(service);
});
