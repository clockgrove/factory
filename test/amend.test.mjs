// Draining and amendments: intake checks, the planner's revision and its review.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cli,
  closedPort,
  configured,
  installation,
  item,
  plan,
  refusal,
  seed,
  serve,
  stateOf,
  stopped,
  until,
} from "./helpers.mjs";

test("a draining Objective starts no Work Item that hasn't started, even with a stack repair's placeholders", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const owned = (id) => item(id, { ownedPaths: [`${id}/`] });
  seed(inst, 57, "building", {
    control: { mode: "draining", by: "test", at: new Date().toISOString() },
    done: {
      check: {},
      plan: plan([owned("a"), owned("b")], { base: "0".repeat(40) }),
    },
    kept: {
      // a started; b only has the placeholders a stack repair writes.
      "item:a:base": "0".repeat(40),
      "item:b:rebase": true,
      "item:b:finished": null,
      "item:b:onto": null,
    },
  });
  const service = serve(inst);
  await until(
    () =>
      Object.keys(stateOf(inst, 57).retries).some((key) =>
        key.startsWith("item:a:"),
      ) || stateOf(inst, 57).holds.some((h) => h.step.startsWith("item:a:")),
    "the started item runs under the drain",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const state = stateOf(inst, 57);
  const touched = [
    ...Object.keys(state.retries),
    ...Object.keys(state.attempts),
    ...Object.keys(state.done),
    ...state.holds.map((h) => h.step),
  ];
  assert.ok(
    !touched.some((key) => key.startsWith("item:b:")),
    `b started under the drain: ${touched.join(", ")}`,
  );
  assert.equal(cli(inst, "cancel", "57").code, 0);
  await stopped(service);
});

test("an amendment comes before the build: intake is checked where it enters, a rejection asks replace or continue", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 3 },
    },
  );
  const accepted = "2026-01-01T00:00:00.000Z";
  const discovery = {
    scope: "in-scope",
    reason: "b needs a shared helper",
    evidence: ["src/b.ts imports src/helper.ts, which no item owns"],
    ownership: ["src/helper.ts"],
    acceptance: ["src/helper.ts exports parse"],
    dependencies: [],
  };
  // Each owns its own path, so none waits for another's.
  const own = (issue) =>
    plan([item("a", { ownedPaths: [`src/${issue}.ts`] })], {
      base: "0".repeat(40),
    });
  const rejected = {
    "amend:op-1:plan": { rejected: "The amendment removes Work Item a" },
    "amend:op-1": { rejected: "The amendment removes Work Item a" },
  };
  const proposal = {
    id: "op-1",
    actor: "octo",
    at: "2026-01-01T01:00:00.000Z",
    plan: accepted,
    discovery,
  };
  // The planner's answer an amendment revises; #82's plan has none, as
  // after factory reset.
  const round = { "plan:1:1": { draft: {}, answer: {} } };
  for (const issue of [81, 82])
    seed(inst, issue, "building", {
      done: {
        check: {},
        plan: own(issue),
        ...rejected,
        ...(issue === 81 ? round : {}),
      },
      kept: { "plan:acceptedAt": accepted, "amend:op-1:proposal": proposal },
    });
  seed(inst, 83, "building", {
    done: { check: {}, plan: own(83), ...round },
    kept: { "plan:acceptedAt": accepted },
  });
  // A worker's discovery, proposed at once, waits on its amendment.
  seed(inst, 84, "building", {
    done: { check: {}, plan: own(84), ...round },
    kept: {
      "plan:acceptedAt": accepted,
      "item:a:base": "0".repeat(40),
      "amend:worker-a-1:proposal": {
        ...proposal,
        id: "worker-a-1",
        actor: "Work Item a's worker",
        worker: { itemId: "a", attempt: 1 },
      },
      // Taken in while worker-a-1 was in flight (a race intake can't see).
      "amend:op-2:proposal": {
        ...proposal,
        id: "op-2",
        at: "2026-01-01T02:00:00.000Z",
      },
    },
  });
  const file = join(inst.root, "proposal.json");
  writeFileSync(file, JSON.stringify(discovery));
  const touched = (state, prefix) =>
    [
      ...Object.keys(state.retries),
      ...Object.keys(state.attempts),
      ...Object.keys(state.done),
      ...state.holds.map((h) => h.step),
    ].filter((key) => key.startsWith(prefix));
  const service = serve(inst);

  // The rejection holds the Objective before any Work Item starts.
  await until(() => stateOf(inst, 81).holds.length, "#81's rejection asks");
  const [question] = stateOf(inst, 81).holds;
  assert.equal(question.step, "amend:op-1:continue");
  assert.deepEqual(
    question.options.map((option) => option.answer),
    ["replace", "replace-validation", "continue", "cancel"],
  );
  assert.match(question.question, /removes Work Item a/);
  // A new proposal waits for the rejection to be settled.
  const refusedNew = cli(inst, "propose-amendment", "81", "--file", file);
  assert.equal(refusedNew.code, 1);
  assert.equal(refusal(refusedNew), "amendment_refused");
  assert.match(refusedNew.err, /op-1 was rejected/);
  // `replace` takes in a replacement with the same discovery, and it is
  // planned next.
  assert.equal(
    cli(
      inst,
      "answer",
      "81",
      "replace",
      "--question",
      question.id,
      "--text",
      "Keep a; add a helper item",
    ).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 81), "amend:op-1-r2:plan").length,
    "the replacement is planned",
  );
  const replacement = stateOf(inst, 81).kept["amend:op-1-r2:proposal"];
  assert.deepEqual(replacement.discovery, discovery);
  assert.deepEqual(replacement.replacement, {
    amendmentId: "op-1",
    diagnosis: "The amendment removes Work Item a",
    correction: "Keep a; add a helper item",
  });
  assert.deepEqual(touched(stateOf(inst, 81), "item:"), []);

  // `continue` runs the plan without it.
  await until(() => stateOf(inst, 82).holds.length, "#82's rejection asks");
  const [held] = stateOf(inst, 82).holds;
  assert.equal(
    cli(inst, "answer", "82", "continue", "--question", held.id).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 82), "item:a:work").length,
    "a's work starts after continue",
  );
  assert.ok(stateOf(inst, 82).done["amend:op-1:continue"]);
  // A plan with no planner answer to revise takes amendments too: the
  // planner answers with the whole plan.
  assert.equal(cli(inst, "propose-amendment", "82", "--file", file).code, 0);

  // An operator's proposal is taken in and planned before a's work; a
  // second waits for the first, and a malformed one names what passes.
  await until(
    () => touched(stateOf(inst, 83), "item:a:").length,
    "#83's build runs",
  );
  assert.equal(cli(inst, "propose-amendment", "83", "--file", file).code, 0);
  const taken = Object.entries(stateOf(inst, 83).kept).filter(([key]) =>
    /^amend:.+:proposal$/.test(key),
  );
  assert.equal(taken.length, 1);
  const [[, operator]] = taken;
  assert.deepEqual(operator.discovery, discovery);
  assert.equal(operator.plan, accepted);
  await until(
    () => touched(stateOf(inst, 83), `amend:${operator.id}:plan`).length,
    "the operator's amendment is planned",
  );
  const second = cli(inst, "propose-amendment", "83", "--file", file);
  assert.equal(refusal(second), "amendment_refused");
  assert.match(second.err, /still being planned/);
  writeFileSync(file, JSON.stringify({ ...discovery, ownership: [] }));
  const malformed = cli(inst, "propose-amendment", "83", "--file", file);
  assert.equal(refusal(malformed), "amendment_refused");
  assert.match(malformed.err, /lacks ownership/);
  for (const issue of [81, 82])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);

  // The operator's override declines the pending worker proposal: the
  // amendment settles as declined, and a's work goes on.
  await until(
    () => touched(stateOf(inst, 84), "amend:worker-a-1:plan").length,
    "#84's worker proposal is planned",
  );
  const unknown = cli(
    inst,
    "decline-discovery",
    "84",
    "--item",
    "z",
    "--reason",
    "x",
  );
  assert.equal(refusal(unknown), "amendment_refused");
  assert.equal(
    cli(inst, "decline-discovery", "84", "--item", "a", "--reason", "obsolete")
      .code,
    0,
  );
  const declined = stateOf(inst, 84);
  assert.match(declined.done["amend:op-2"].rejected, /in flight/);
  assert.match(
    declined.done["amend:worker-a-1"].rejected,
    /Declined by .*: obsolete/,
  );
  assert.ok(declined.done["amend:worker-a-1:continue"]);
  assert.equal(declined.kept["item:a:declined"].reason, "obsolete");
  // op-2's rejection stays until its own answer settles it.
  await until(
    () => stateOf(inst, 84).holds.some((h) => h.step === "amend:op-2:continue"),
    "op-2's rejection asks",
  );
  assert.deepEqual(touched(stateOf(inst, 84), "item:a:work"), []);
  const [overlap] = stateOf(inst, 84).holds;
  assert.equal(
    cli(inst, "answer", "84", "continue", "--question", overlap.id).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 84), "item:a:work").length,
    "a's work goes on after the decline",
  );
  for (const issue of [83, 84])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);
  await stopped(service);
});
