// `factory propose --approve` creates each issue of a draft once, however
// soon it runs again. GitHub's issue lists can lag a create by seconds: in
// the 0.5.2 qualification a second approval started 0.5 s after the first
// created #10, missed it, and created #11 (#2081). The fake GitHub here
// leaves a just-created issue out of its lists, and can answer a read of
// it by number 404 for a moment; an approval reads the issue it recorded
// by number, and finds the others among the lists and past them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { loadConfig } from "../dist/config.js";
import { GitHub, GitHubError } from "../dist/github.js";
import { approveProposal, ProposalRefused } from "../dist/proposals.js";
import { githubOrigin, REPO, tempDir } from "./helpers.mjs";

const LOGIN = "factory-bot";

function git(cwd, ...args) {
  const run = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * A GitHub serving REPO's issues. Issue #9 is someone else's. `lag.lists`
 * holds numbers every issue list leaves out, `lag.mine` numbers only the
 * list of Factory's own issues (`creator=`) leaves out, and `lag.reads`
 * numbers a read by number answers 404 for. Each create is left out of
 * `creator=` lists until `settle()`. `loseNext` answers the next create
 * 502 after making it, as a lost answer; `refuseNext` answers it 422
 * without making it.
 */
async function fakeGitHub() {
  const issues = new Map([
    [
      9,
      {
        id: 1009,
        number: 9,
        state: "open",
        title: "Someone else's",
        body: "Theirs.",
        user: { login: "github-actions[bot]" },
        created_at: new Date().toISOString(),
      },
    ],
  ]);
  const lag = { lists: new Set(), mine: new Set(), reads: new Set() };
  const fake = {
    issues,
    lag,
    creates: 0,
    reads: 0,
    loseNext: false,
    refuseNext: false,
    settle() {
      lag.lists.clear();
      lag.mine.clear();
      lag.reads.clear();
    },
  };
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url, "http://fake");
    const path = url.pathname;
    const repo = `/repos/${REPO}`;
    if (request.method === "GET" && path === "/user")
      return json(response, 200, { login: LOGIN });
    if (request.method === "POST" && path === "/markdown") {
      // GitHub drops the HTML comment (the marker) from what it shows.
      const { text: markdown } = JSON.parse(text);
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(
        micromark(markdown.replace(/^<!--.*-->\n/, ""), {
          extensions: [gfm()],
          htmlExtensions: [gfmHtml()],
        }),
      );
    }
    if (request.method === "GET" && path === `${repo}/issues`) {
      if (url.searchParams.get("page") > "1") return json(response, 200, []);
      const creator = url.searchParams.get("creator");
      const listed = [...issues.values()]
        .filter(
          (issue) =>
            !lag.lists.has(issue.number) &&
            (!creator ||
              (issue.user.login === creator && !lag.mine.has(issue.number))),
        )
        .sort((a, b) => b.number - a.number)
        .slice(0, Number(url.searchParams.get("per_page") ?? 30));
      return json(response, 200, listed);
    }
    const one = new RegExp(`^${repo}/issues/(\\d+)(/dependencies/blocked_by)?$`)
      .exec(path)
      ?.slice(1);
    if (request.method === "GET" && one) {
      const number = Number(one[0]);
      if (!one[1]) fake.reads++;
      if (!issues.has(number) || lag.reads.has(number))
        return json(response, 404, { message: "Not Found" });
      return json(response, 200, one[1] ? [] : issues.get(number));
    }
    if (request.method === "POST" && path === `${repo}/issues`) {
      if (fake.refuseNext) {
        fake.refuseNext = false;
        return json(response, 422, { message: "Validation Failed" });
      }
      const { title, body } = JSON.parse(text);
      const number = Math.max(...issues.keys()) + 1;
      const issue = {
        id: 1000 + number,
        number,
        state: "open",
        title,
        body,
        user: { login: LOGIN },
        created_at: new Date().toISOString(),
        url: `${fake.api}${repo}/issues/${number}`,
      };
      issues.set(number, issue);
      fake.creates++;
      lag.mine.add(number);
      if (fake.loseNext) {
        fake.loseNext = false;
        return json(response, 502, { message: "Bad Gateway" });
      }
      return json(response, 201, issue);
    }
    json(response, 404, { message: `no fake for ${request.method} ${path}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  fake.api = `http://127.0.0.1:${server.address().port}`;
  return fake;
}

const PAD = {
  key: "pad",
  dependencies: [],
  title: "Add a left-padding helper",
  goal: "Add a helper that pads text on the left with spaces to a given width.",
  acceptance: ["Padding cat to width 5 gives two spaces, then cat."],
  context: [],
  sources: [],
  constraints: [],
  nonGoals: [],
};

/** An installation with a checkout of REPO, a reviewed one-Objective draft and a fake GitHub. */
async function approval() {
  const root = tempDir("factory-approve-");
  git(root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "--quiet", "origin.git", "work");
  const work = join(root, "work");
  writeFileSync(join(work, "README.md"), "target\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "base");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(root, "clone", "--quiet", "origin.git", "checkout");
  const checkout = join(root, "checkout");
  githubOrigin(checkout, join(root, "origin.git"));
  const configFile = join(root, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      repository: REPO,
      checkout,
      queue: { projectId: "PVT_none" },
      github: { login: true },
    }),
  );
  process.env.FACTORY_CONFIG = configFile;
  process.env.FACTORY_GITHUB_TOKEN = "unused";
  const config = loadConfig(REPO);
  const installation = join(root, "installation");
  const paths = {
    root: installation,
    objectives: join(installation, "objectives"),
    requests: join(installation, "requests"),
    logs: join(installation, "logs"),
    lockName: `\0factory-test-${randomUUID()}`,
  };
  const draft = join(root, "draft.json");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  // The draft with `objectives`, as the operator saved it: its SHA-256.
  const save = (objectives) => {
    const text = `${JSON.stringify(
      {
        id,
        createdAt,
        intent: "Pad text on the left.",
        sources: [],
        objectives,
      },
      null,
      2,
    )}\n`;
    writeFileSync(draft, text);
    return createHash("sha256").update(text).digest("hex");
  };
  let digest = save([PAD]);
  const fake = await fakeGitHub();
  const events = [];
  // Each approval is its own CLI process: its own GitHub client.
  const approve = () =>
    approveProposal(draft, digest, {
      config,
      paths,
      github: new GitHub(REPO, fake.api),
      log: (event) => events.push(event),
      out: () => {},
    });
  const edit = (objectives) => {
    digest = save(objectives);
  };
  const record = join(installation, "proposals", `${id}.approval.json`);
  const recorded = () => JSON.parse(readFileSync(record, "utf8"));
  return { fake, approve, edit, events, record, recorded };
}

test("approving a draft again finds its issue though GitHub's list of Factory's issues doesn't show it yet", async () => {
  const { fake, approve, recorded } = await approval();
  const first = await approve();
  assert.deepEqual(first, [{ key: "pad", issue: 10, created: true }]);
  // GitHub lists #10 among all issues, not yet among Factory's own (#2081).
  assert.ok(fake.lag.mine.has(10));
  const again = await approve();
  assert.deepEqual(again, [{ key: "pad", issue: 10, created: false }]);
  assert.equal(fake.creates, 1);
  assert.deepEqual(Object.keys(recorded().issues), ["pad"]);
  assert.equal(recorded().issues.pad.number, 10);
  // No issue list shows it either: the record's number still finds it.
  fake.lag.lists.add(10);
  assert.deepEqual(await approve(), again);
  assert.equal(fake.creates, 1);
});

test("a recorded issue GitHub doesn't serve yet by number is read again, not refused or made twice", async () => {
  const { fake, approve } = await approval();
  await approve();
  // Right after the create, no list shows #10 and a read of it is a 404.
  fake.lag.lists.add(10);
  fake.lag.reads.add(10);
  const reads = fake.reads;
  setTimeout(() => fake.lag.reads.delete(10), 300);
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
  ]);
  assert.equal(fake.creates, 1);
  assert.ok(fake.reads - reads >= 2, "read again after the 404");
});

test("an approval with no record finds an issue the list of all issues shows though Factory's list doesn't", async () => {
  // As on another machine, or with the record removed: the newest issue
  // the list shows is #10 itself, so it is found among them, not past it.
  const { fake, approve, record } = await approval();
  await approve();
  rmSync(record);
  assert.ok(fake.lag.mine.has(10));
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
  ]);
  assert.equal(fake.creates, 1);
});

test("a create whose answer was lost is found by number, never made twice", async () => {
  const { fake, approve, record, recorded } = await approval();
  fake.loseNext = true;
  await assert.rejects(approve(), /502|Bad Gateway/);
  assert.equal(fake.creates, 1);
  // The create was recorded before its request, with the newest number
  // GitHub showed then.
  const pending = existsSync(record) ? recorded() : undefined;
  assert.deepEqual(pending?.issues, {});
  assert.equal(pending?.creating?.key, "pad");
  assert.equal(pending?.creating?.after, 9);
  // No list shows #10 yet: the numbers past the newest seen before the
  // create are read.
  fake.lag.lists.add(10);
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
  ]);
  assert.equal(fake.creates, 1);
  const settled = recorded();
  assert.equal(settled.issues.pad.number, 10);
  assert.equal(settled.creating, undefined);
});

test("a lost create GitHub shows nowhere yet refuses until it can be found", async () => {
  const { fake, approve, recorded } = await approval();
  fake.loseNext = true;
  await assert.rejects(approve(), /502|Bad Gateway/);
  // Neither the lists nor a read by number show #10 yet.
  fake.lag.lists.add(10);
  fake.lag.reads.add(10);
  await assert.rejects(approve(), (error) => {
    assert.ok(error instanceof ProposalRefused, String(error));
    assert.match(error.message, /didn't learn its number/);
    assert.match(error.message, /never created twice/);
    return true;
  });
  assert.equal(fake.creates, 1);
  fake.settle();
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
  ]);
  assert.equal(fake.creates, 1);
  assert.equal(recorded().issues.pad.number, 10);
  assert.equal(recorded().creating, undefined);
  // A create that never reached GitHub (a crash before its request), past
  // the 2 min GitHub may lag: the lists are trusted, and it is made once.
  const other = await approval();
  other.fake.loseNext = true;
  await assert.rejects(other.approve(), /502|Bad Gateway/);
  other.fake.issues.delete(10);
  const lost = other.recorded();
  lost.creating.at = new Date(Date.now() - 3 * 60_000).toISOString();
  writeFileSync(other.record, JSON.stringify(lost));
  assert.deepEqual(await other.approve(), [
    { key: "pad", issue: 10, created: true },
  ]);
  assert.equal(other.fake.creates, 2);
  assert.equal(other.recorded().issues.pad.number, 10);
  assert.equal(other.recorded().creating, undefined);
});

test("a create GitHub refuses with a 4xx made nothing, so the next approval creates at once", async () => {
  const { fake, approve, recorded } = await approval();
  fake.refuseNext = true;
  await assert.rejects(
    approve(),
    (error) => error instanceof GitHubError && error.status === 422,
  );
  assert.equal(fake.creates, 0);
  assert.deepEqual(recorded(), { issues: {} });
  assert.deepEqual(await approve(), [{ key: "pad", issue: 10, created: true }]);
  assert.equal(fake.creates, 1);
});

test("an edited draft publishes the Objective it adds and refuses one whose text changed", async () => {
  const { fake, approve, edit, recorded } = await approval();
  await approve();
  const trim = {
    ...PAD,
    key: "trim",
    title: "Add a trimming helper",
    goal: "Add a helper that removes spaces from both ends of text.",
    acceptance: ["Trimming a padded cat gives cat."],
  };
  edit([PAD, trim]);
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
    { key: "trim", issue: 11, created: true },
  ]);
  assert.equal(fake.creates, 2);
  assert.equal(recorded().issues.trim.number, 11);
  edit([{ ...PAD, title: "Add a padding helper" }, trim]);
  await assert.rejects(approve(), (error) => {
    assert.ok(error instanceof ProposalRefused, String(error));
    assert.match(
      error.message,
      /already published as #10, and its text differs/,
    );
    return true;
  });
  assert.equal(fake.creates, 2);
});

test("a recorded issue GitHub no longer shows refuses rather than publish it again", async () => {
  const { fake, approve, record, recorded } = await approval();
  await approve();
  fake.issues.delete(10);
  // Made past the 2 min GitHub may lag: its 404 stands.
  const made = recorded();
  made.issues.pad.at = new Date(Date.now() - 3 * 60_000).toISOString();
  writeFileSync(record, JSON.stringify(made));
  await assert.rejects(approve(), (error) => {
    assert.ok(error instanceof ProposalRefused, String(error));
    assert.match(
      error.message,
      /was published as #10, which GitHub doesn't show now/,
    );
    assert.ok(error.message.includes(record));
    return true;
  });
  assert.equal(fake.creates, 1);
});

test("two approvals of a draft at once: one is refused while the other runs, and one issue is made", async () => {
  const { fake, approve } = await approval();
  const results = await Promise.allSettled([approve(), approve()]);
  const done = results.filter((result) => result.status === "fulfilled");
  for (const result of results)
    if (result.status === "rejected")
      assert.match(String(result.reason), /Another approval of this draft/);
  assert.ok(done.length >= 1);
  assert.equal(fake.creates, 1);
  assert.deepEqual(await approve(), [
    { key: "pad", issue: 10, created: false },
  ]);
});
