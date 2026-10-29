// Repair diagnosis quality (#2173), from the post-mortem of Clockgrove
// Objective #800 on 0.5.7: 29 diagnosis calls (2.27M tokens), 8 operator
// escalations. entity-selection hit the contract drift the operator had
// told living-scene how to fix 3.5 hours earlier, and its diagnosis asked
// again; three questions were Factory's placeholder for an empty one; a
// formatter failure that repeated unchanged was repaired again; and the
// diagnosis hit the provider cache on 14% of its input, against 92% for
// workers, since each call started fresh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SESSIONS, openTurn } from "../dist/providers/session.js";
import { correction, unchangedFailure } from "../dist/repair.js";
import { carriedAnswers } from "../dist/work/repair-context.js";
import { item, plan, tempDir } from "./helpers.mjs";

const owned = item("a", {
  ownedPaths: ["src/a.js"],
  validation: [{ command: "npm test" }],
});
const other = item("b", { ownedPaths: ["src/b.js"] });
const SOURCE = `The Objective. ${"Stable source text. ".repeat(1500)}`;

/** A checkout with a base and a result commit that changes src/a.js. */
function checkout() {
  const dir = tempDir("factory-diagnosis-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/b.js"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "src/a.js"), "export const a  =  2;\n");
  git("commit", "-q", "-am", "result");
  return { dir, base, commit: git("rev-parse", "HEAD") };
}

const answer = (fields) => ({
  decision: "operator",
  diagnosis: "",
  predecessor: "",
  path: "",
  correction: "",
  question: "",
  requestedFiles: [],
  ownership: [],
  evidence: [],
  acceptance: [],
  ...fields,
});

const repair = (correction) =>
  answer({
    decision: "repair",
    diagnosis: "The formatter rewrites src/a.js.",
    path: "src/a.js",
    correction,
  });

/** A planner whose answers come in order, the last one repeating. */
function planner(...answers) {
  const asked = [];
  return {
    asked,
    answer: async (call) => {
      asked.push(call);
      return { value: answers[Math.min(asked.length, answers.length) - 1] };
    },
  };
}

/** One diagnosis of item `a`'s result. */
function diagnose(repo, model, fields = {}) {
  const logged = [];
  return {
    logged,
    result: correction({
      planner: model,
      plan: plan([owned, other]),
      item: owned,
      finding: { kind: "failure", detail: "npm test failed: sum is 3" },
      checkout: repo.dir,
      base: repo.base,
      commit: repo.commit,
      sources: [{ path: "objective.md", content: SOURCE }],
      prior: [],
      validate: true,
      signal: AbortSignal.timeout(60_000),
      log: (event) => logged.push(event),
      ...fields,
    }),
  };
}

/** The first line of each paragraph of a diagnosis request. */
const headings = (prompt) =>
  prompt.split("\n\n").map((part) => part.split("\n", 1)[0]);

/** A paragraph's content digest, as its heading carries it. */
const digest = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The paragraph names a continued turn's manifest lists as gone. */
const gone = (sent) =>
  [
    ...(
      /No longer part of the request, so disregard them: (.*)\.\n/.exec(
        sent,
      )?.[1] ?? ""
    ).matchAll(/"((?:[^"\\]|\\.)*)"/g),
  ].map((match) => JSON.parse(`"${match[1]}"`));

// --- 1. Carry operator answers forward ----------------------------------

const drift =
  "Validation command failed (1): pnpm check: contract drift: regenerate scripts/contracts.generated.json";
const howTo =
  "Your shell can't run the generator. Run Validate: its command 2 prints the contract inventory. Copy it into scripts/contracts.generated.json and raise its version by one.";

/** Item `id`'s saved diagnosis, with these corrections applied. */
const diagnosed = (id, applied) => ({
  [`item:${id}:diagnosis`]: {
    repair: applied.length,
    context: { finding: "x" },
    applied,
  },
});

test("an operator's answer to another Work Item's diagnosis question reaches the next item's diagnosis, ahead of the item (#2173)", async () => {
  const state = {
    kept: {
      ...diagnosed("living", [
        {
          source: "diagnosis",
          failure: drift,
          diagnosis: "The manifest is stale.",
          path: "scripts/contracts.generated.json",
          correction: "Regenerate it.",
        },
        {
          source: "operator",
          failure: drift,
          diagnosis: "The operator answered the diagnosis question.",
          correction: howTo,
        },
      ]),
      // The item's own answers are its prior corrections already.
      ...diagnosed("a", [
        {
          source: "operator",
          failure: "npm test failed",
          diagnosis: "The operator answered the diagnosis question.",
          correction: "its own answer",
        },
      ]),
    },
  };
  const carried = carriedAnswers(state, "a");
  assert.deepEqual(carried, [
    { item: "living", failure: drift, answer: howTo },
  ]);

  const model = planner(repair("Format src/a.js."));
  const { result } = diagnose(checkout(), model, { operatorAnswers: carried });
  assert.equal((await result).kind, "correction");
  const { prompt } = model.asked[0];
  const parts = prompt.split("\n\n");
  const at = (heading) => parts.findIndex((part) => part.startsWith(heading));
  const answers = parts[at("The operator's answers")];
  const json = JSON.stringify({ operatorAnswers: carried });
  assert.equal(
    answers,
    `The operator's answers to other Work Items' questions, 1 (${digest(json)}):\n${json}`,
  );
  // Objective-wide, so before the Work Item and its failure.
  assert.ok(at("The operator's answers") < at("Work Item a ("));
  for (const rule of [
    "operatorAnswers, when present, are the operator's answers to earlier diagnosis questions of this Objective's other Work Items, each with the failure it answered",
    "When one settles this failure, decide from it instead of asking the operator again",
    "never ask what an answer already says.",
  ])
    assert.ok(parts[0].includes(rule), rule);

  // None carried: no paragraph.
  const bare = planner(repair("Format src/a.js."));
  await diagnose(checkout(), bare).result;
  assert.ok(!bare.asked[0].prompt.includes('operatorAnswers":'));
});

test("carried answers are bounded: each one's head and tail, the latest within the whole bound, and an answer given twice once", () => {
  const long = (n) => `answer ${n} ${"x".repeat(10_000)}`;
  const kept = {};
  for (let n = 0; n < 10; n++)
    Object.assign(
      kept,
      diagnosed(`i${n}`, [
        {
          source: "operator",
          failure: `failure ${n} ${"y".repeat(5_000)}`,
          diagnosis: "The operator answered the diagnosis question.",
          correction: long(n),
        },
      ]),
    );
  Object.assign(
    kept,
    diagnosed("again", [
      {
        source: "operator",
        failure: "f",
        diagnosis: "",
        correction: long(9),
      },
    ]),
  );
  const carried = carriedAnswers({ kept }, "a");
  const size = carried.reduce(
    (sum, entry) =>
      sum + entry.item.length + entry.failure.length + entry.answer.length,
    0,
  );
  assert.ok(size <= 24_000, `${size}`);
  assert.ok(carried.length >= 3, `${carried.length}`);
  for (const entry of carried) {
    assert.ok(entry.answer.length < 4_100, `${entry.answer.length}`);
    assert.ok(entry.failure.length < 1_100, `${entry.failure.length}`);
    assert.match(entry.answer, /characters omitted/);
  }
  // The latest kept, oldest first; answer 9 only once (the later copy).
  assert.deepEqual(
    carried.map((entry) => entry.item),
    ["i5", "i6", "i7", "i8", "again"].slice(-carried.length),
  );
  assert.ok(!carried.some((entry) => entry.item === "i0"));
});

// --- 2. Refuse empty questions -------------------------------------------

test("an operator decision without a question is refused and asked again: Factory never asks a question that says nothing (#2173)", async () => {
  const question =
    "npm test fails with sum is 3: should sum round half up, as the sources' example shows, or truncate?";
  const model = planner(answer({}), answer({ question }));
  const { result, logged } = diagnose(checkout(), model);
  assert.deepEqual(await result, { kind: "question", question });
  assert.equal(model.asked.length, 2);
  assert.match(
    model.asked[1].prompt,
    /\n\nRejected answer 1 of 2 \([0-9a-f]{12}\):\nYour previous answer was rejected: an operator decision needs a question that names the failure \(the failing command, check or criterion, and what it reported\) and the decision it needs from the operator\. Answer again\.$/,
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis-rejected").length,
    1,
  );
  assert.ok(
    model.asked[0].prompt.includes(
      "The question names the failure (the failing command, check or criterion, and what it reported) and the one decision it needs from the operator",
    ),
  );

  // Never a question: the question names the failure itself.
  const silent = planner(answer({ question: "   " }));
  const held = await diagnose(checkout(), silent).result;
  assert.equal(held.kind, "question");
  assert.equal(silent.asked.length, 3);
  assert.ok(held.question.includes("npm test failed: sum is 3"), held.question);
  assert.ok(!held.question.includes("What concrete operator decision"));
});

// --- 3. Escalate unchanged repeats ---------------------------------------

/** A correction repair 1 ran, saved as repairContext stamps it. */
const formatted = {
  source: "diagnosis",
  failure: "npm test failed: sum is 3",
  diagnosis: "The formatter rewrites src/a.js.",
  path: "src/a.js",
  correction: "Format src/a.js with two-space indentation.",
  repair: 1,
};

test("a failure that repeats unchanged after its last correction is escalated, never repaired again (#2173)", async () => {
  // Repair 2 diagnoses what repair 1's attempt, which ran the correction, left.
  assert.equal(
    unchangedFailure("npm test failed: sum is 3", [formatted], 2),
    true,
  );
  // Only the last correction counts: one in between moved the failure.
  assert.equal(
    unchangedFailure(
      "npm test failed: sum is 3",
      [
        formatted,
        { ...formatted, failure: "npm run lint: 2 errors", repair: 2 },
      ],
      3,
    ),
    false,
  );
  assert.equal(unchangedFailure("npm test failed: sum is 3", [], 2), false);

  // Live (#800): the formatter's change repeated unchanged, and the
  // diagnosis chose another repair of it.
  const question =
    "npm test still fails with sum is 3 after the formatting correction: should the worker change the test's expected sum instead?";
  const model = planner(
    repair("Format it again, harder."),
    answer({ question }),
  );
  const { result, logged } = diagnose(checkout(), model, {
    prior: [formatted],
    repair: 2,
  });
  assert.deepEqual(await result, { kind: "question", question });
  assert.equal(model.asked.length, 2);
  assert.match(model.asked[0].prompt, /"failureRepeatedUnchanged":true/);
  assert.match(
    model.asked[1].prompt,
    /Your previous answer was rejected: the failure repeated unchanged after the last correction \(the last entry of prior\), so another repair of this Work Item is refused/,
  );
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis"),
    [{ event: "diagnosis", decision: "operator", unchanged: true }],
  );
  assert.ok(
    model.asked[0].prompt.includes(
      "When failureRepeatedUnchanged is true, the last entry of prior left this exact failure as it was",
    ),
  );

  // A diagnosis that keeps choosing repair asks, naming what was tried.
  const stubborn = planner(repair("Format it again, harder."));
  const held = await diagnose(checkout(), stubborn, {
    prior: [formatted],
    repair: 2,
  }).result;
  assert.equal(held.kind, "question");
  assert.equal(stubborn.asked.length, 3);
  assert.match(
    held.question,
    /^The failure repeated unchanged after the last correction, and the repair diagnosis gave no other usable decision after 3 answers/,
  );
  assert.ok(
    held.question.includes(
      "The last correction: Format src/a.js with two-space indentation.",
    ),
  );

  // A failure the last correction changed is repaired as before.
  const moved = planner(repair("Fix the sum."));
  const fixed = await diagnose(checkout(), moved, {
    prior: [{ ...formatted, failure: "npm run lint: 2 errors" }],
    repair: 2,
  }).result;
  assert.equal(fixed.kind, "correction");
  assert.doesNotMatch(moved.asked[0].prompt, /"failureRepeatedUnchanged"/);
});

test("a failure that comes back after an attempt that ran no correction (a conflict replay, an amended attempt) is repaired, not escalated (#2173)", async () => {
  // Repair 1 ran the correction and its result passed; repair 2 was a
  // conflict replay (or an amended attempt), which adds no correction, and
  // its result brought the same failure back: the correction is not the
  // one that left it.
  assert.equal(
    unchangedFailure("npm test failed: sum is 3", [formatted], 3),
    false,
  );
  const model = planner(
    repair("Reapply the numeric value of a on top of the new base's change."),
  );
  const { result, logged } = diagnose(checkout(), model, {
    prior: [formatted],
    repair: 3,
  });
  const fixed = await result;
  assert.equal(fixed.kind, "correction");
  assert.equal(
    fixed.correction.correction,
    "Reapply the numeric value of a on top of the new base's change.",
  );
  assert.equal(model.asked.length, 1);
  assert.doesNotMatch(model.asked[0].prompt, /"failureRepeatedUnchanged"/);
  assert.deepEqual(
    logged.filter((event) => event.event === "diagnosis-rejected"),
    [],
  );
  // The same correction again is still refused as a repeat.
  const again = planner(repair(formatted.correction));
  const asked = await diagnose(checkout(), again, {
    prior: [formatted],
    repair: 3,
  }).result;
  assert.equal(asked.kind, "question");
  assert.match(
    again.asked[1].prompt,
    /that correction already failed for this same failure/,
  );

  // A correction saved before corrections carried their repair (0.5.8
  // state) is never taken as the failed attempt's.
  const unstamped = { ...formatted };
  delete unstamped.repair;
  assert.equal(
    unchangedFailure("npm test failed: sum is 3", [unstamped], 2),
    false,
  );
  // Nor is any without the repair being diagnosed.
  assert.equal(
    unchangedFailure("npm test failed: sum is 3", [formatted], undefined),
    false,
  );
});

// --- 4. Stable prompt prefix, and a conversation that caches ------------

/**
 * A planner that keeps conversations as a provider adapter does
 * (providers/session.ts `openTurn`): what each call sent, and whether it
 * continued the conversation.
 */
function conversing(...answers) {
  const sent = [];
  return {
    sent,
    answer: async (call) => {
      const turn = openTurn(
        call.conversation,
        call.prompt,
        "codex",
        "model",
        () => true,
      );
      sent.push({
        prompt: call.prompt,
        sent: turn.prompt,
        resumed: !!turn.resumed,
      });
      return {
        value: answers[Math.min(sent.length, answers.length) - 1],
        session: turn.end("thread-1"),
      };
    },
  };
}

test("the diagnosis request puts its stable parts first and continues the item's conversation, so a re-ask and the next repair send only what changed (#2173)", async () => {
  const repo = checkout();
  const question =
    "npm test fails with sum is 3: should sum round half up, as the sources' example shows, or truncate?";
  const conversation = {
    dir: join(tempDir("factory-diagnosis-session-"), "diagnosis-a"),
    scope: "scope",
    policy: DEFAULT_SESSIONS,
  };
  const model = conversing(answer({}), answer({ question }));
  const { result } = diagnose(repo, model, { conversation });
  assert.deepEqual(await result, { kind: "question", question });

  // Instructions, then the Objective's parts, the item's, and the attempt's.
  const [first, again] = model.sent;
  // Each named by its part and its content's digest.
  const named = [
    "The Objective's sources",
    "The plan's ownership",
    "Work Item a",
    `The failed result ${repo.commit.slice(0, 12)}`,
    "The corrections already tried, 0",
    "The failure",
    "Candidate file src/a.js",
  ];
  const listed = headings(first.prompt).slice(1);
  assert.equal(listed.length, named.length, listed.join("\n"));
  named.forEach((name, n) => {
    assert.ok(listed[n].startsWith(`${name} (`), listed[n]);
    assert.match(listed[n].slice(name.length), /^ \([0-9a-f]{12}\):$/);
  });
  // The digest is of the paragraph's content.
  const [, sources] = first.prompt.split("\n\n");
  assert.equal(
    sources.split("\n", 1)[0],
    `The Objective's sources (${digest(sources.slice(sources.indexOf("\n") + 1))}):`,
  );
  assert.ok(first.prompt.startsWith("Diagnose this failed Work Item"));
  assert.equal(first.resumed, false);
  assert.equal(first.sent, first.prompt);

  // The re-ask continues it: the rejection is new, the sources are not.
  assert.equal(again.resumed, true);
  assert.match(
    again.sent,
    /Rejected answer 1 of 2 \([0-9a-f]{12}\):\nYour previous answer/,
  );
  assert.ok(!again.sent.includes("Stable source text."));
  assert.ok(!again.sent.includes("Diagnose this failed Work Item"));
  assert.ok(again.sent.length * 10 < again.prompt.length);
  assert.equal(conversation.kept.turns, 2);
  assert.equal(conversation.kept.id, "thread-1");

  // The item's next diagnosis continues it too, with the new failure.
  const next = conversing(repair("Fix the sum in src/a.js."));
  const later = diagnose(repo, next, {
    finding: { kind: "failure", detail: "npm test failed: sum is 4" },
    prior: [formatted],
    conversation: {
      dir: conversation.dir,
      scope: "scope",
      policy: DEFAULT_SESSIONS,
      previous: conversation.kept,
    },
  });
  assert.equal((await later.result).kind, "correction");
  const [turn] = next.sent;
  assert.equal(turn.resumed, true);
  assert.ok(turn.sent.includes("npm test failed: sum is 4"));
  assert.ok(!turn.sent.includes("Stable source text."));
  assert.ok(!turn.sent.includes('"planOwnership"'));
  // The rejection and the old failure left the request, by name.
  assert.ok(
    gone(turn.sent).some((name) => /^Rejected answer 1 of 2 \(/.test(name)),
    turn.sent,
  );
  assert.ok(
    gone(turn.sent).some((name) => name.startsWith("The failure (")),
    turn.sent,
  );

  // Another item's request shares the same instructions and Objective parts.
  const peer = planner(answer({ question }));
  await correction({
    planner: peer,
    plan: plan([owned, item("c", { ownedPaths: ["src/c.js"] })]),
    item: item("c", { ownedPaths: ["src/c.js"] }),
    finding: { kind: "failure", detail: "npm test failed: c" },
    checkout: repo.dir,
    base: repo.base,
    commit: repo.commit,
    sources: [{ path: "objective.md", content: SOURCE }],
    prior: [],
    validate: true,
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  const mine = first.prompt.split("\n\n");
  const theirs = peer.asked[0].prompt.split("\n\n");
  assert.equal(theirs[0], mine[0]);
  assert.equal(theirs[1], mine[1]);
});

/** A new retained diagnosis conversation for item `a`. */
const session = () => ({
  dir: join(tempDir("factory-diagnosis-session-"), "diagnosis-a"),
  scope: "scope",
  policy: DEFAULT_SESSIONS,
});

/** The heading of `prompt`'s paragraph that starts with `start`. */
const headingOf = (prompt, start) =>
  headings(prompt).find((heading) => heading.startsWith(start));

test("each re-ask's rejection is its own named paragraph: a changed one is never disregarded by its own name, and a repeated one continues the conversation (#2173)", async () => {
  const question =
    "npm test fails with sum is 3: should sum round half up, as the sources' example shows, or truncate?";
  // Rejected for two different reasons, then answered.
  const changed = conversing(
    answer({}),
    answer({
      decision: "repair",
      diagnosis: "b is wrong.",
      path: "src/b.js",
      correction: "Change b.",
    }),
    answer({ question }),
  );
  assert.deepEqual(
    await diagnose(checkout(), changed, { conversation: session() }).result,
    { kind: "question", question },
  );
  const [, second, third] = changed.sent;
  assert.equal(second.resumed, true);
  assert.equal(third.resumed, true);
  const current = headingOf(third.prompt, "Rejected answer");
  assert.match(current, /^Rejected answer 2 of 2 \([0-9a-f]{12}\):$/);
  assert.ok(
    third.sent.includes(
      `${current}\nYour previous answer was rejected: a repair's path must name one file the Work Item owns`,
    ),
  );
  // The earlier rejection is gone by its own name, never by the current one's.
  assert.deepEqual(gone(third.sent), [
    headingOf(second.prompt, "Rejected answer"),
  ]);
  assert.ok(!gone(third.sent).includes(current));

  // Rejected twice for the same reason: the third call still continues,
  // sending only the new rejection.
  const silent = conversing(answer({}));
  const held = await diagnose(checkout(), silent, { conversation: session() })
    .result;
  assert.equal(held.kind, "question");
  const [, again, last] = silent.sent;
  assert.equal(again.resumed, true);
  assert.equal(last.resumed, true);
  assert.notEqual(last.prompt, again.prompt);
  assert.ok(last.sent.length * 10 < last.prompt.length);
  assert.match(last.sent, /\nRejected answer 2 of 2 \([0-9a-f]{12}\):\n/);
  assert.ok(
    !gone(last.sent).includes(headingOf(last.prompt, "Rejected answer")),
  );
});

test("carried answers and tried corrections that change at the same count are new paragraphs by name, never disregarded (#2173)", async () => {
  const repo = checkout();
  const question =
    "npm test fails with sum is 3: should sum round half up, as the sources' example shows, or truncate?";
  const conversation = session();
  const first = conversing(answer({ question }));
  await diagnose(repo, first, {
    conversation,
    prior: [formatted],
    operatorAnswers: [{ item: "b", failure: "f1", answer: "old answer" }],
  }).result;
  // The next diagnosis: one carried answer replaced by another (the bound
  // evicted it, or its item's facts were cleared), one correction replaced.
  const next = conversing(answer({ question }));
  await diagnose(repo, next, {
    finding: { kind: "failure", detail: "npm test failed: sum is 4" },
    prior: [{ ...formatted, correction: "Format src/a.js with tabs." }],
    operatorAnswers: [{ item: "c", failure: "f2", answer: "new answer" }],
    conversation: {
      ...session(),
      dir: conversation.dir,
      previous: conversation.kept,
    },
  }).result;
  const [turn] = next.sent;
  assert.equal(turn.resumed, true);
  assert.ok(turn.sent.includes('"answer":"new answer"'));
  assert.ok(turn.sent.includes("Format src/a.js with tabs."));
  const was = gone(turn.sent);
  for (const start of [
    "The operator's answers to other Work Items' questions, 1 (",
    "The corrections already tried, 1 (",
  ]) {
    const now = headingOf(turn.prompt, start);
    const before = headingOf(first.sent[0].prompt, start);
    assert.ok(now && before && now !== before, `${before} -> ${now}`);
    assert.ok(was.includes(before), `${before} not gone: ${was.join(" | ")}`);
    assert.ok(!was.includes(now), `${now} disregarded`);
  }
});
