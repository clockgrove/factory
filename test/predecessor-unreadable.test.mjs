// A predecessor that finished under the previous state version has a record
// Factory can't read (#2334): GitHub decides whether it delivered, and
// status shows it finished, with no question. GitHub is a local fake that
// serves the blocked-by link and #394's comments and PRs as recorded from
// a scratch repository (fixtures/reset-394.json).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitHub } from "../dist/github.js";
import { predecessorsStep } from "../dist/planning/predecessors.js";
import { newObjective } from "../dist/state.js";
import {
  cli,
  installation,
  REPO,
  refusal,
  serve,
  status,
  stopped,
  until,
} from "./helpers.mjs";

const recorded = JSON.parse(
  readFileSync(new URL("fixtures/reset-394.json", import.meta.url), "utf8"),
);
const ISSUE = 7;
const BLOCKER = 394;

test("a predecessor finished under the previous state version is decided by GitHub", async () => {
  const inst = installation();
  const finished = join(inst.objectives, "finished");
  mkdirSync(finished, { recursive: true });
  const record = newObjective(BLOCKER, new Date());
  writeFileSync(
    join(finished, `${BLOCKER}.json`),
    JSON.stringify({
      ...record,
      version: record.version - 1,
      status: "done",
    }),
  );
  let pulls = recorded.pulls;
  const server = createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, "http://localhost");
    const head = url.searchParams.get("head")?.replace(/^[^:]+:/, "");
    const body =
      url.pathname === "/user"
        ? { login: "factory-app" }
        : url.pathname ===
            `/repos/${REPO}/issues/${ISSUE}/dependencies/blocked_by`
          ? [
              {
                id: 9394,
                number: BLOCKER,
                state: "closed",
                state_reason: "completed",
                title: "Badge",
                body: null,
                user: null,
              },
            ]
          : url.pathname === `/repos/${REPO}/issues/${BLOCKER}/comments`
            ? recorded.comments
            : url.pathname === `/repos/${REPO}/pulls` && head
              ? (pulls[head] ?? [])
              : [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  const github = new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);
  const step = predecessorsStep({ github, objectives: inst.objectives });
  const signal = new AbortController().signal;
  const run = () =>
    step.run({ state: { issue: ISSUE, done: {}, kept: {} }, signal });

  // Factory's report and merged PRs are on GitHub: it delivered.
  const delivered = await run();
  assert.equal(delivered.kind, "done", delivered.question ?? delivered.reason);
  assert.deepEqual(
    delivered.result.predecessors[0].items.map(({ id, pr, merged }) => ({
      id,
      pr,
      merged,
    })),
    [
      {
        id: "badge-image",
        pr: 401,
        merged: "a8e442453726cbf247804aabf7291a09de1db2ca",
      },
      {
        id: "badge-helper",
        pr: 402,
        merged: "a8e442453726cbf247804aabf7291a09de1db2ca",
      },
    ],
  );

  // No merged Factory PR: it holds, never waits.
  pulls = {};
  const held = await run();
  assert.equal(held.kind, "hold");
  assert.match(held.question, /record can't be read \(state version/);
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["replan", "ignore", "cancel"],
  );

  // Status shows it finished, with nothing to answer.
  const row = status(inst).objectives.find((each) => each.issue === BLOCKER);
  assert.deepEqual(
    { phase: row.phase, holds: row.holds, next: row.nextAction.command },
    { phase: "finished, its record unreadable", holds: [], next: null },
  );
  // A cancel is refused, as a done one's is: nothing is written over it.
  const service = serve(inst);
  try {
    await until(() => status(inst).service === "running", "service");
    assert.equal(
      refusal(cli(inst, "cancel", String(BLOCKER))),
      "objective_finished",
    );
  } finally {
    await stopped(service);
  }
});
