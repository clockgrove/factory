// An `ignore` answer on a predecessor hold stands across a replan while its
// blocked-by link and the predecessor's issue state are unchanged (#2304).
// GitHub is a local fake that serves the Objective's blocked-by links.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { GitHub } from "../dist/github.js";
import { predecessorsStep } from "../dist/planning/predecessors.js";
import { replanOutcome } from "../dist/work/step-deliver.js";
import { REPO } from "./helpers.mjs";

const ISSUE = 7;
const BLOCKER = 852;

test("an ignored predecessor stays ignored through a replan until its state changes", async () => {
  const blocker = {
    id: 9852,
    number: BLOCKER,
    state: "closed",
    state_reason: "not_planned",
    title: "Blocker",
    body: null,
    user: null,
  };
  let links = [blocker];
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url.startsWith(
          `/repos/${REPO}/issues/${ISSUE}/dependencies/blocked_by`,
        )
          ? links
          : [],
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  const github = new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);
  const step = predecessorsStep({ github });
  const signal = new AbortController().signal;
  const state = { issue: ISSUE, done: {}, kept: {} };
  const run = (answer) => step.run({ state, answer, signal });
  const keep = (outcome) => {
    for (const [name, value] of Object.entries(outcome.keep ?? {}))
      if (value === null) delete state.kept[name];
      else state.kept[name] = value;
  };

  const asked = await run();
  assert.equal(asked.kind, "hold");
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["replan", "ignore", "cancel"],
  );

  const ignored = await run({
    answer: "ignore",
    arg: String(BLOCKER),
    text: "never needed",
    by: "operator",
    at: new Date().toISOString(),
  });
  assert.equal(ignored.kind, "done");
  keep(ignored);

  // The operator's replan after the plan was accepted forgets the kept
  // facts, but not this answer.
  keep(replanOutcome(state));
  assert.equal(state.kept["predecessors:ignored"]?.[0]?.ref, `#${BLOCKER}`);
  assert.equal((await run()).kind, "done");

  // The predecessor closed another way: the question comes back.
  links = [{ ...blocker, state_reason: "duplicate" }];
  const again = await run();
  assert.equal(again.kind, "hold");
  keep(again);
  assert.equal(state.kept["predecessors:ignored"], undefined);
});
