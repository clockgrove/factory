// Clockgrove #800 (Factory 0.5.7/0.5.8): while waiting on CI, every poll
// read main's classic branch protection, which Factory's GitHub App (no
// Administration access) may never read: 110 refusals (403) of
// .../protection/required_status_checks and 3 of .../protection. After the
// first 403 the client reads no protection route for the rest of the
// service run, takes the fallback each read already had, and says so once
// (#2174).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, beforeEach, test } from "node:test";
import { GitHub } from "../dist/github.js";
import {
  newTransport,
  requestEvents,
  transport,
} from "../dist/github-trace.js";
import { REPO } from "./helpers.mjs";

const PROTECTION = `/repos/${REPO}/branches/main/protection`;
const CHECKS = `${PROTECTION}/required_status_checks`;
const REFUSED = [403, { message: "Resource not accessible by integration" }];

let requests = [];
let routes = {};
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;
    requests.push(path);
    const [status, answer] = routes[path] ?? [404, { message: "Not Found" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
});
after(() => server.close());
beforeEach(() => {
  requests = [];
});

async function github() {
  process.env.FACTORY_GITHUB_TOKEN = "unused";
  if (!server.listening)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);
}

/** Runs `read` in a step's scope; its result and the scope's events. */
async function scoped(read) {
  const counted = newTransport(true);
  const result = await transport.run(counted, read);
  return { result, events: requestEvents("item:a:ci", counted) };
}

const notices = (events) =>
  events.filter((event) => event.event === "branch-protection-unreadable");

/** The App's view of main: a ruleset requires "quality", classic protection "tests", which the branch read shows. */
function refusing() {
  routes = {
    [`/repos/${REPO}/rules/branches/main`]: [
      200,
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "quality" }] },
        },
      ],
    ],
    [CHECKS]: REFUSED,
    [PROTECTION]: REFUSED,
    [`/repos/${REPO}/branches/main`]: [
      200,
      {
        name: "main",
        protection: {
          required_status_checks: { contexts: ["tests"], checks: [] },
        },
      },
    ],
  };
}

test("after a 403, the CI poll reads no branch protection again for the rest of the run, takes the branch read's checks, and says so once", async () => {
  refusing();
  const client = await github();
  const first = await scoped(() => client.checksPolicy("main"));
  assert.deepEqual(first.result, {
    names: ["quality", "tests"],
    strict: undefined,
  });
  assert.equal(requests.filter((path) => path === CHECKS).length, 1);
  const [notice, ...more] = notices(first.events);
  assert.equal(more.length, 0);
  assert.equal(notice.job, "item:a:ci");
  assert.equal(notice.status, 403);
  assert.equal(notice.route, CHECKS);
  assert.match(
    notice.message,
    /^The GitHub login can't read .*'s branch protection \(GitHub answered 403\), so Factory reads it no more until the service restarts/,
  );
  // It follows the 403 it reports, after the step's requests.
  assert.equal(first.events.at(-1), notice);
  // Every later poll: the same answer, from the fallback alone, and no
  // second notice.
  requests = [];
  for (let poll = 0; poll < 3; poll++) {
    const later = await scoped(() => client.requiredChecks("main"));
    assert.deepEqual(later.result, ["quality", "tests"]);
    assert.deepEqual(notices(later.events), []);
  }
  assert.equal(
    requests.filter((path) => path.startsWith(PROTECTION)).length,
    0,
    requests.join("\n"),
  );
  assert.equal(
    requests.filter((path) => path === `/repos/${REPO}/branches/main`).length,
    3,
  );
  // The merge step's reads of the same settings: their fallback (none
  // known; merge commits allowed), with no request.
  assert.deepEqual(await client.requiredReviews("main"), []);
  assert.deepEqual(await client.threadResolution("main"), []);
  routes[`/repos/${REPO}`] = [200, { allow_merge_commit: true }];
  assert.equal(await client.mergeCommitsAllowed("main"), true);
  assert.equal(
    requests.filter((path) => path.startsWith(PROTECTION)).length,
    0,
    requests.join("\n"),
  );
});

test("a 403 on the protection route stops the required checks' read too", async () => {
  refusing();
  const client = await github();
  const { events } = await scoped(() => client.threadResolution("main"));
  assert.equal(notices(events).length, 1);
  assert.equal(notices(events)[0].route, PROTECTION);
  requests = [];
  assert.deepEqual(await client.checksPolicy("main"), {
    names: ["quality", "tests"],
    strict: undefined,
  });
  assert.deepEqual(
    requests.filter((path) => path.startsWith(PROTECTION)),
    [],
  );
});

test("a 404 (unprotected) is an answer, not a refusal: protection is read again on the next poll", async () => {
  routes = { [`/repos/${REPO}/rules/branches/main`]: [200, []] };
  const client = await github();
  for (let poll = 0; poll < 2; poll++) {
    const { result, events } = await scoped(() => client.checksPolicy("main"));
    assert.deepEqual(result, { names: [], strict: false });
    assert.deepEqual(notices(events), []);
  }
  assert.equal(requests.filter((path) => path === CHECKS).length, 2);
});

test("the refusal is the client's, per repository and service run: a new client reads protection again", async () => {
  refusing();
  await (await github()).checksPolicy("main");
  // Granted since (a restart reads the configuration, and so protection, again).
  routes[CHECKS] = [200, { strict: true, contexts: ["tests"] }];
  requests = [];
  const { result, events } = await scoped(async () =>
    (await github()).checksPolicy("main"),
  );
  assert.deepEqual(result, { names: ["quality", "tests"], strict: true });
  assert.deepEqual(notices(events), []);
  assert.deepEqual(
    requests.filter((path) => path.startsWith(PROTECTION)),
    [CHECKS],
  );
});
