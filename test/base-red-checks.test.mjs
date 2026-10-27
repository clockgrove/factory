// A required check that fails on a Work Item's PR may fail on the default
// branch too: Clockgrove's `quality` gate found new npm advisories in its
// locked dependencies, so every PR into main failed it, and Factory spent
// two repairs per item on a failure no change of theirs could fix (#2094).
// Factory now compares a failed check with the default branch's head first:
// red there too is a hold that spends no repair. And a repair's diagnosis
// gets the failed run's artifacts, which named the cause, so it needn't ask
// the operator for them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { observeCi } from "../dist/delivery.js";
import { GitHub, GitHubError, TransientError } from "../dist/github.js";
import { correction } from "../dist/repair.js";
import { zipTexts } from "../dist/zip.js";
import { item, plan, REPO, tempDir } from "./helpers.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RUN = 900;
const DAY = 24 * 60 * 60_000;

/** A completed GitHub Actions check run. */
function check(id, name, conclusion, fields = {}) {
  return {
    id,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    html_url: `https://github.com/o/r/actions/runs/${RUN}/job/${id}`,
    app: { id: 15368, slug: "github-actions" },
    ...fields,
  };
}

/** The same check run on the default branch's head. */
const onBase = (id, name, conclusion, fields = {}) =>
  check(id, name, conclusion, { head_sha: BASE, ...fields });

/**
 * A GitHub whose open PR #7 is ready but for its checks: `runs` and
 * `statuses` on HEAD, `baseRuns` and `baseStatuses` on main's head BASE.
 * `jobs` maps a job to its attempt, failed steps and log; `artifacts` a
 * workflow run to what it uploaded; `downloads` an artifact to its bytes
 * (or an error to throw).
 */
function github({
  runs,
  statuses = [],
  baseRuns = [],
  baseStatuses = [],
  jobs = {},
  attempt = 1,
  artifacts = {},
  downloads = {},
}) {
  const reruns = [];
  const downloaded = [];
  return {
    reruns,
    downloaded,
    repository: "o/r",
    defaultBranch: async () => "main",
    pull: async () => ({
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      head: { sha: HEAD, ref: "factory/1/a" },
      base: { ref: "main" },
    }),
    mergeState: async () => ({
      headRefOid: HEAD,
      headRefName: "factory/1/a",
      baseRefName: "main",
      mergeStateStatus: "UNSTABLE",
    }),
    branchHead: async (branch) => {
      assert.equal(branch, "main");
      return BASE;
    },
    checkRuns: async (sha) => (sha === BASE ? baseRuns : runs),
    commitStatuses: async (sha) => (sha === BASE ? baseStatuses : statuses),
    requiredChecks: async () => [],
    failureAnnotations: async () => [],
    jobLogTail: async (job) => jobs[job]?.log,
    workflowJob: async (job) => ({
      run: RUN,
      attempt: jobs[job]?.attempt ?? 1,
      failedSteps: jobs[job]?.failedSteps ?? [],
    }),
    workflowRunAttempt: async () => ({ attempt, status: "completed" }),
    rerunFailedJobs: async (run) => {
      reruns.push(run);
    },
    runArtifacts: async (run) => artifacts[run],
    artifactDownload: async (id, maxBytes) => {
      assert.equal(maxBytes, 1024 * 1024);
      downloaded.push(id);
      const download = downloads[id];
      if (download instanceof Error) throw download;
      return download;
    },
  };
}

function observe(hub) {
  return observeCi(
    {
      github: hub,
      checkout: "/nonexistent",
      signal: new AbortController().signal,
    },
    {
      issue: 1,
      item: "a",
      pr: 7,
      head: HEAD,
      pushedHeads: [HEAD],
      requiredChecks: [],
    },
  );
}

/** A zip archive of `files` ({ name, data, size? }), deflated. */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = deflateRawSync(file.data);
    const size = file.size ?? file.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const ADVISORIES = JSON.stringify({
  advisories: ["fast-uri", "undici", "zod"],
  source: "package-lock.json",
});

test("a check main fails too holds at once, names main's failed step and error, and spends no repair or rerun", async () => {
  const hub = github({
    // The Clockgrove shape: the checks job and the quality gate after it.
    runs: [check(11, "checks", "failure"), check(12, "quality", "failure")],
    baseRuns: [
      onBase(21, "checks", "failure"),
      onBase(22, "quality", "failure"),
      onBase(23, "tests", "success"),
    ],
    jobs: {
      21: {
        failedSteps: ["Supply-chain gate"],
        log: "2026-10-27T06:52:40.1234567Z npm audit: 3 new advisories (fast-uri, undici, zod)",
      },
    },
    artifacts: { [RUN]: [{ id: 1, name: "x", size: 10, expired: false }] },
  });
  const result = await observe(hub);
  assert.equal(result.kind, "hold", JSON.stringify(result));
  assert.match(
    result.question,
    new RegExp(
      `^main is red: its head ${BASE} fails "checks", "quality" too, which failed on PR #7 at ${HEAD}\\.`,
    ),
  );
  assert.match(result.question, /Factory spent no repair on it/);
  assert.match(result.question, /Failed step: Supply-chain gate/);
  assert.match(result.question, /npm audit: 3 new advisories \(fast-uri/);
  assert.match(
    result.question,
    /Fix "checks", "quality" on main \(another Objective can\), then answer retry; or cancel\.$/,
  );
  assert.deepEqual(
    result.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(result.options[0].consequence, /asks again while main still/);
  // A first attempt would have been rerun, and nothing more was read.
  assert.deepEqual(hub.reruns, []);
  assert.deepEqual(hub.downloaded, []);
});

test("a hold for main's failure names the PR's other failures, which main passes", async () => {
  const hub = github({
    runs: [check(11, "checks", "failure"), check(12, "lint", "failure")],
    baseRuns: [onBase(21, "checks", "failure"), onBase(22, "lint", "success")],
  });
  const result = await observe(hub);
  assert.equal(result.kind, "hold");
  assert.match(
    result.question,
    /PR #7 also fails lint, which main doesn't; Factory repairs that once main passes "checks"\./,
  );
});

test("a commit status main fails too is held the same way", async () => {
  const hub = github({
    runs: [],
    statuses: [{ context: "external", state: "failure" }],
    baseStatuses: [
      {
        context: "external",
        state: "error",
        target_url: "https://ci.example/1",
      },
    ],
  });
  const result = await observe(hub);
  assert.equal(result.kind, "hold");
  assert.match(result.question, /fails "external" too/);
  assert.match(result.question, /external \(error, https:\/\/ci\.example\/1\)/);
});

test("a check main passes, hasn't run or only cancelled is rerun and repaired as before", async () => {
  const cases = {
    passes: [onBase(21, "tests", "success")],
    "has no run": [],
    "was cancelled": [onBase(21, "tests", "cancelled")],
    "is still running": [
      onBase(21, "tests", null, { status: "in_progress", completed_at: null }),
    ],
  };
  for (const [name, baseRuns] of Object.entries(cases)) {
    const first = github({ runs: [check(1, "tests", "failure")], baseRuns });
    const rerun = await observe(first);
    assert.equal(rerun.kind, "rerun", name);
    assert.deepEqual(first.reruns, [RUN], name);
    const again = github({
      runs: [check(1, "tests", "failure")],
      baseRuns,
      jobs: { 1: { attempt: 2 } },
      attempt: 2,
    });
    const repair = await observe(again);
    assert.equal(repair.kind, "repair", name);
    assert.equal(repair.checks, true, name);
    assert.match(
      repair.finding,
      new RegExp(
        `On main's head ${BASE}, as GitHub shows it \\(Factory runs nothing there\\): tests `,
      ),
      name,
    );
  }
});

test("the repair finding says what main shows, and that a pass from days before may not hold now", async () => {
  const failed = Date.now();
  const fresh = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [
      onBase(21, "quality", "success", {
        completed_at: new Date(failed - 60 * 60_000).toISOString(),
      }),
    ],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
  });
  const recent = await observe(fresh);
  assert.equal(recent.kind, "repair");
  assert.match(recent.finding, /quality ended success at \S+Z\./);
  assert.doesNotMatch(recent.finding, /may not hold now/);

  // Clockgrove: main's last quality run passed five days before.
  const old = new Date(failed - 5 * DAY - 60_000).toISOString();
  const stale = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [onBase(21, "quality", "success", { completed_at: old })],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
  });
  const repair = await observe(stale);
  assert.equal(repair.kind, "repair");
  assert.match(
    repair.finding,
    new RegExp(
      `quality ended success at ${old}, 5 days before it failed here\\. A pass that old may not hold now: a check that depends on when it runs \\(new advisories against locked dependencies`,
    ),
  );
  // The finding starts with the failed checks, as before.
  assert.match(repair.finding, /^Checks failed on PR #7 at a{40}: quality/);
});

test("the failed run's artifacts reach the repair finding: names, sizes and small text files", async () => {
  const receipts = zip([
    { name: "vulnerabilities.json", data: Buffer.from(ADVISORIES) },
    { name: "logs/", data: Buffer.alloc(0) },
    { name: "receipt.bin", data: Buffer.from([0x89, 0x50, 0x00, 0xff]) },
    { name: "big.txt", data: Buffer.from("x".repeat(70 * 1024)) },
  ]);
  const hub = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [onBase(21, "quality", "success")],
    jobs: {
      1: {
        attempt: 2,
        failedSteps: ["Run quality gate"],
        log: "quality: the checks job failed",
      },
    },
    attempt: 2,
    artifacts: {
      [RUN]: [
        // The first attempt's upload of the same name, and its rerun's.
        {
          id: 6,
          name: "quality-receipts-checks",
          size: 18_245,
          expired: false,
        },
        {
          id: 9,
          name: "quality-receipts-checks",
          size: 18_240,
          expired: false,
        },
        { id: 7, name: "quality-evidence", size: 2_239_558, expired: false },
        { id: 3, name: "old-report", size: 100, expired: true },
        { id: 8, name: "summary.json", size: 13, expired: false },
      ],
    },
    downloads: { 9: receipts, 8: Buffer.from('{"ok":false}\n') },
  });
  const result = await observe(hub);
  assert.equal(result.kind, "repair", JSON.stringify(result));
  // The latest upload of each name, smallest first; nothing larger or expired.
  assert.deepEqual(
    [...hub.downloaded].sort((a, b) => a - b),
    [8, 9],
  );
  const { finding } = result;
  for (const line of [
    `Artifacts of the workflow run ${RUN} of quality, read as text and never run:`,
    "- quality-receipts-checks (17.8 KiB): text files below: vulnerabilities.json; skipped receipt.bin (not UTF-8 text), big.txt (larger than 65536 bytes)",
    "- quality-evidence (2.1 MiB): not read, larger than 1.0 MiB",
    "- old-report (100 B): expired",
    "- summary.json (13 B): text files below: summary.json",
    `--- quality-receipts-checks: vulnerabilities.json ---\n${ADVISORIES}`,
    '--- summary.json: summary.json ---\n{"ok":false}',
  ])
    assert.ok(finding.includes(line), `${line}\n\nnot in\n\n${finding}`);
  assert.doesNotMatch(finding, /xxxxxxxx/);
  // The log excerpt comes last, where a long finding is kept.
  assert.ok(
    finding.indexOf("vulnerabilities.json ---") <
      finding.indexOf("quality:\nFailed step: Run quality gate"),
  );
  assert.ok(finding.endsWith("quality: the checks job failed"));
});

test("artifacts reach the repair diagnosis's input, so it needn't ask the operator for them", async () => {
  const hub = github({
    runs: [check(1, "quality", "failure")],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
    artifacts: {
      [RUN]: [
        { id: 9, name: "quality-receipts-checks", size: 200, expired: false },
      ],
    },
    downloads: {
      9: zip([{ name: "vulnerabilities.json", data: Buffer.from(ADVISORIES) }]),
    },
  });
  const repair = await observe(hub);
  assert.equal(repair.kind, "repair");

  const checkout = tempDir("factory-base-red-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "src/a.js"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(checkout, "src/a.js"), "export const a = 2;\n");
  git("commit", "-q", "-am", "result");
  const asked = [];
  const result = await correction({
    planner: {
      answer: async (call) => {
        asked.push(call);
        return {
          value: {
            decision: "operator",
            diagnosis: "main's locked dependencies have new advisories",
            predecessor: "",
            path: "",
            correction: "",
            question: "Update the lockfile on main?",
            requestedFiles: [],
            ownership: [],
            evidence: [],
            acceptance: [],
          },
        };
      },
    },
    plan: plan([item("a", { ownedPaths: ["src/a.js"] })]),
    item: item("a", { ownedPaths: ["src/a.js"] }),
    finding: { kind: "failure", detail: repair.finding },
    checkout,
    base,
    commit: git("rev-parse", "HEAD"),
    sources: [],
    prior: [],
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  assert.equal(result.kind, "question");
  assert.equal(asked.length, 1);
  // The request is the prompt's last line, as JSON.
  const { prompt } = asked[0];
  const request = JSON.parse(prompt.slice(prompt.lastIndexOf("\n{") + 1));
  assert.ok(
    request.failure.includes(
      `--- quality-receipts-checks: vulnerabilities.json ---\n${ADVISORIES}`,
    ),
  );
});

test("a rate limit while reading artifacts waits for its reset; other failures leave them out", async () => {
  const limited = new TransientError("rate limited", 60_000, true);
  const listed = {
    [RUN]: [{ id: 9, name: "receipts", size: 200, expired: false }],
  };
  const held = github({
    runs: [check(1, "quality", "failure")],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
    artifacts: listed,
    downloads: { 9: limited },
  });
  await assert.rejects(observe(held), (error) => error === limited);

  const refused = github({
    runs: [check(1, "quality", "failure")],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
    artifacts: listed,
    downloads: { 9: new GitHubError("gone", 410) },
  });
  const result = await observe(refused);
  assert.equal(result.kind, "repair");
  assert.match(
    result.finding,
    /- receipts \(200 B\): GitHub did not serve a readable download/,
  );

  // No Actions read access: no artifacts, the repair as before.
  const unread = github({
    runs: [check(1, "quality", "failure")],
    jobs: { 1: { attempt: 2 } },
    attempt: 2,
  });
  const plain = await observe(unread);
  assert.equal(plain.kind, "repair");
  assert.doesNotMatch(plain.finding, /Artifacts of/);
});

test("a zip entry is read only within its bound, whatever its header claims", () => {
  const listing = zipTexts(
    zip([
      { name: "ok.txt", data: Buffer.from("fine") },
      // Claims 10 bytes, inflates past the bound: a zip bomb.
      { name: "bomb.txt", data: Buffer.alloc(200 * 1024, 0x61), size: 10 },
      // Claims fewer bytes than it holds.
      { name: "short.txt", data: Buffer.from("twelve bytes"), size: 5 },
    ]),
    64 * 1024,
  );
  assert.deepEqual(listing.texts, [{ name: "ok.txt", text: "fine" }]);
  assert.deepEqual(listing.skipped, [
    { name: "bomb.txt", reason: "unreadable" },
    { name: "short.txt", reason: "not UTF-8 text" },
  ]);
  assert.equal(zipTexts(Buffer.from("not a zip"), 64 * 1024), undefined);
});

test("the client reads main's head, a job's failed steps, a run's artifacts and a bounded download, and holds them for a rate limit", async () => {
  const receipts = zip([
    { name: "vulnerabilities.json", data: Buffer.from(ADVISORIES) },
  ]);
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    const path = request.url.split("?")[0];
    requests.push({ path, authorization: request.headers.authorization });
    const json = (status, body, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    const repo = `/repos/${REPO}`;
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (path === `${repo}/git/ref/heads/main`)
      return json(200, { object: { sha: BASE } });
    if (path === `${repo}/actions/jobs/5`)
      return json(200, {
        run_id: RUN,
        run_attempt: 2,
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Supply-chain gate", conclusion: "failure" },
          { name: "Upload receipts", conclusion: "skipped" },
        ],
      });
    if (path === `${repo}/actions/runs/${RUN}/artifacts`)
      return json(200, {
        total_count: 2,
        artifacts: [
          { id: 9, name: "receipts", size_in_bytes: 200, expired: false },
          { id: 10, name: "evidence", size_in_bytes: 3, expired: true },
        ],
      });
    if (path === `${repo}/actions/artifacts/9/zip`)
      return json(302, {}, { location: `${origin}/signed/9` });
    if (path === `${repo}/actions/artifacts/10/zip`)
      return json(302, {}, { location: `${origin}/signed/10` });
    if (path === `${repo}/actions/artifacts/11/zip`)
      return json(410, { message: "Artifact has expired" });
    if (path === "/signed/9") {
      response.writeHead(200, { "content-type": "application/zip" });
      return response.end(receipts);
    }
    if (path === "/signed/10") {
      response.writeHead(200, { "content-type": "application/zip" });
      return response.end(Buffer.alloc(2 * 1024 * 1024));
    }
    if (path === `${repo}/actions/runs/901/artifacts`)
      return json(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 600),
          "x-ratelimit-resource": "core",
        },
      );
    return json(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.FACTORY_GITHUB_TOKEN = "ghs_test";
  const hub = new GitHub(REPO, `http://127.0.0.1:${server.address().port}`);

  assert.equal(await hub.branchHead("main"), BASE);
  assert.deepEqual(await hub.workflowJob(5), {
    run: RUN,
    attempt: 2,
    failedSteps: ["Supply-chain gate"],
  });
  assert.deepEqual(await hub.runArtifacts(RUN), [
    { id: 9, name: "receipts", size: 200, expired: false },
    { id: 10, name: "evidence", size: 3, expired: true },
  ]);
  assert.deepEqual(await hub.artifactDownload(9, 1024 * 1024), receipts);
  // The signed link is read without Factory's login.
  assert.equal(
    requests.find((request) => request.path === "/signed/9").authorization,
    undefined,
  );
  assert.equal(await hub.artifactDownload(10, 1024 * 1024), undefined);
  assert.equal(await hub.artifactDownload(11, 1024 * 1024), undefined);
  assert.equal(await hub.runArtifacts(404), undefined);

  // A rate limit holds the downloads too: none is sent before its reset.
  await assert.rejects(hub.runArtifacts(901), (error) => {
    assert.ok(error instanceof TransientError && error.limited);
    return true;
  });
  const sent = requests.length;
  await assert.rejects(hub.artifactDownload(9, 1024 * 1024), (error) => {
    assert.ok(error instanceof TransientError && error.limited);
    assert.match(error.message, /not sent, GitHub's rate limit holds requests/);
    return true;
  });
  assert.equal(requests.length, sent);
});
