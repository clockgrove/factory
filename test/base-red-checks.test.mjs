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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { observeCi, stepLog } from "../dist/delivery.js";
import { GitHubError, TransientError } from "../dist/github.js";
import { correction } from "../dist/repair.js";
import { item, plan, tempDir } from "./helpers.mjs";

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
  behind = 0,
}) {
  const reruns = [];
  const downloaded = [];
  const updates = [];
  return {
    reruns,
    downloaded,
    updates,
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
      failedStepTimes: jobs[job]?.failedStepTimes ?? [],
    }),
    workflowRunAttempt: async () => ({ attempt, status: "completed" }),
    rerunFailedJobs: async (run) => {
      reruns.push(run);
    },
    // `behind`: the commits on main's head that HEAD lacks.
    commitsBeyond: async (base, head) => {
      assert.deepEqual([base, head], [HEAD, BASE]);
      return { total: behind, commits: [] };
    },
    requestBranchUpdate: async (pr, head) => {
      updates.push([pr, head]);
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

/** The CI step on `hub`'s PR #7; `answered`: what the operator answered. */
function observe(hub, answered = {}) {
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
      ...answered,
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
    /Fix "checks", "quality" on main \(another Objective can\), then answer retry; repair if this Work Item's change is meant to fix them there; or cancel\.$/,
  );
  assert.deepEqual(
    result.options.map((option) => option.answer),
    ["retry", "repair", "cancel"],
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
    // What failed, never the head or the logs (#2215).
    assert.deepEqual(
      repair.identity,
      { kind: "ci", checks: [{ name: "tests", conclusion: "failure" }] },
      name,
    );
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

// Clockgrove #821, job 122053441527: the checks job failed in "Bootstrap
// canonical local capability", whose supply-chain assertion is followed by
// the receipts upload and post-job cleanup. The job's tail held only those,
// so the diagnosis asked the operator "what step failed and what error"
// (#2120): the finding holds the failed step's own lines instead.
test("the failed step's own log reaches the finding, not only the job's tail", async () => {
  const at = (second, fraction) =>
    `2026-10-27T06:${second}.${String(fraction).padStart(7, "0")}Z`;
  const step = [
    `${at("51:19", 5722621)} ##[group]Run node scripts/bootstrap.mjs "$CI_EVIDENCE_DIR" --only "install,check,supply-chain"`,
    `${at("51:19", 5781050)} ##[endgroup]`,
    `${at("52:23", 9491559)} $ node scripts/supply-chain.mjs`,
    `${at("52:23", 9492180)} license allowlist and SBOM: dependency vulnerability scan: advisories found; inspect vulnerabilities.json`,
    `${at("52:23", 9493874)} \x1b[31mAssertionError [ERR_ASSERTION]: supply-chain failures: license allowlist and SBOM\x1b[0m`,
    `${at("52:23", 9494999)}     at verifySupplyChain (file:///home/runner/work/clockgrove/clockgrove/scripts/supply-chain.mjs:190:10)`,
    "  actual: 1,",
    `${at("52:23", 9498908)} [ELIFECYCLE] Command failed with exit code 1.`,
    `${at("52:23", 9557000)} ##[error]Process completed with exit code 1.`,
  ];
  // The next step starts within the second the failed one completed.
  const after = [
    `${at("52:23", 9638466)} ##[group]Run actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`,
    ...Array.from(
      { length: 50 },
      (_, n) => `${at("52:25", 4239146 + n)} Post job cleanup line ${n}`,
    ),
  ];
  // Before it, the step before: the read tail starts within it. A line
  // without a timestamp has its line before's.
  const before = [
    `${at("51:18", 5666717)} ##[end-action id=__self.install;outcome=success]`,
    "a line of the step before",
  ];
  const failing = {
    attempt: 2,
    failedSteps: ["Bootstrap canonical local capability (checks)"],
    failedStepTimes: [
      {
        name: "Bootstrap canonical local capability (checks)",
        startedAt: "2026-10-27T06:51:19Z",
        completedAt: "2026-10-27T06:52:23Z",
      },
    ],
    log: [...before, ...step, ...after].join("\n"),
  };
  const hub = github({
    runs: [check(1, "checks", "failure")],
    baseRuns: [onBase(21, "checks", "success")],
    jobs: { 1: failing },
    attempt: 2,
  });
  const result = await observe(hub);
  assert.equal(result.kind, "repair", JSON.stringify(result));
  const { finding } = result;
  assert.ok(
    finding.endsWith(
      [
        "checks:",
        "Failed step: Bootstrap canonical local capability (checks)",
        "Log of failed step Bootstrap canonical local capability (checks):",
        '##[group]Run node scripts/bootstrap.mjs "$CI_EVIDENCE_DIR" --only "install,check,supply-chain"',
        "##[endgroup]",
        "$ node scripts/supply-chain.mjs",
        "license allowlist and SBOM: dependency vulnerability scan: advisories found; inspect vulnerabilities.json",
        "AssertionError [ERR_ASSERTION]: supply-chain failures: license allowlist and SBOM",
        "    at verifySupplyChain (file:///home/runner/work/clockgrove/clockgrove/scripts/supply-chain.mjs:190:10)",
        "  actual: 1,",
        "[ELIFECYCLE] Command failed with exit code 1.",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    ),
    finding,
  );
  assert.doesNotMatch(
    finding,
    /Post job cleanup|upload-artifact|end-action|step before/,
  );

  // Long, it keeps its end, where the error is.
  const long = stepLog(
    [
      `${at("51:19", 1)} first`,
      ...Array.from({ length: 100 }, (_, n) => `${at("51:20", n)} line ${n}`),
      `${at("51:21", 0)} ##[error]boom`,
    ].join("\n"),
    {
      name: "s",
      startedAt: "2026-10-27T06:51:19Z",
      completedAt: "2026-10-27T06:51:21Z",
    },
  );
  assert.equal(long.split("\n").length, 60);
  assert.ok(long.endsWith("line 99\n##[error]boom"));
  // A tail read that starts after the step, or no times: the job's tail.
  assert.equal(
    stepLog(after.slice(1).join("\n"), failing.failedStepTimes[0]),
    undefined,
  );
  const tail = github({
    runs: [check(1, "checks", "failure")],
    jobs: { 1: { ...failing, failedStepTimes: [] } },
    attempt: 2,
  });
  const repaired = await observe(tail);
  assert.ok(repaired.finding.endsWith("Post job cleanup line 49"));
  assert.doesNotMatch(repaired.finding, /Log of failed step/);
});

// The repair diagnosis keeps a finding's first 1000 and last 7000
// characters (repair.ts), and the excerpts come last: three failed checks,
// each with two long failed steps, still each reach it with their errors,
// however long the steps' names (an unnamed step's is its command line).
for (const [gate, report] of [
  ["Gate", "Report"],
  [
    `Run node gate.mjs ${"--flag ".repeat(90)}`,
    `Run report ${"y".repeat(700)}`,
  ],
])
  test(`every excerpted check's error reaches the repair diagnosis, whatever the steps' logs hold (step names of ${gate.length} and ${report.length} characters)`, async () => {
    const names = ["lint", "checks", "quality"];
    const step = (tag, name, second) => [
      `2026-10-27T06:52:${second}.0000000Z ##[group]Run ${name}`,
      ...Array.from(
        { length: 120 },
        (_, n) =>
          `2026-10-27T06:52:${second}.${String(n + 1).padStart(7, "0")}Z ${tag} ${name} output line ${n} ${"x".repeat(40)}`,
      ),
      `2026-10-27T06:52:${second}.9000000Z ERROR-CAUSE-${tag}-${name}: the assertion that failed`,
      `2026-10-27T06:52:${second}.9500000Z ##[error]Process completed with exit code 1.`,
    ];
    const jobs = Object.fromEntries(
      names.map((tag, n) => [
        n + 1,
        {
          attempt: 2,
          failedSteps: [gate, report],
          failedStepTimes: [
            {
              name: gate,
              startedAt: "2026-10-27T06:52:20Z",
              completedAt: "2026-10-27T06:52:20Z",
            },
            {
              name: report,
              startedAt: "2026-10-27T06:52:30Z",
              completedAt: "2026-10-27T06:52:30Z",
            },
          ],
          log: [...step(tag, "gate", 20), ...step(tag, "report", 30)].join(
            "\n",
          ),
        },
      ]),
    );
    const hub = github({
      runs: names.map((name, n) => check(n + 1, name, "failure")),
      baseRuns: names.map((name, n) => onBase(21 + n, name, "success")),
      jobs,
      attempt: 2,
    });
    const result = await observe(hub);
    assert.equal(result.kind, "repair", JSON.stringify(result));
    const { correction: diagnosed } = await correction({
      finding: { kind: "failure", detail: result.finding },
      operatorAnswer: "look at the logs",
      prior: [],
    });
    for (const tag of names)
      for (const name of ["gate", "report"])
        assert.ok(
          diagnosed.failure.includes(`ERROR-CAUSE-${tag}-${name}`),
          `ERROR-CAUSE-${tag}-${name} not in\n\n${diagnosed.failure}`,
        );
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
  // The failure is its own paragraph: a heading line, then JSON.
  const failure = asked[0].prompt
    .split("\n\n")
    .find((part) => part.startsWith("The failure ("));
  const request = JSON.parse(failure.slice(failure.indexOf("\n") + 1));
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

test("a failure on main that a later run of the check there passed or still runs is not main's now", async () => {
  for (const later of [
    onBase(31, "quality", "success"),
    onBase(31, "quality", null, { status: "in_progress", completed_at: null }),
  ]) {
    const hub = github({
      runs: [check(1, "quality", "failure")],
      // An earlier workflow run on main's head failed; a later one, run
      // again by hand, passed or still runs.
      baseRuns: [onBase(21, "quality", "failure"), later],
    });
    const result = await observe(hub);
    assert.equal(result.kind, "rerun", later.status);
  }
  // A later failure of another check does not supersede it.
  const red = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [
      onBase(21, "quality", "failure"),
      onBase(31, "tests", "success"),
    ],
  });
  assert.equal((await observe(red)).kind, "hold");
});

test("the operator's repair repairs a check main fails too at once: the change is meant to fix it", async () => {
  const hub = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [onBase(21, "quality", "failure")],
    jobs: { 1: { log: "quality: 1 advisory left" } },
  });
  const result = await observe(hub, { repairShared: true });
  assert.equal(result.kind, "repair", JSON.stringify(result));
  assert.equal(result.checks, true);
  // A first attempt, but no rerun: main fails it too.
  assert.deepEqual(hub.reruns, []);
  assert.match(
    result.finding,
    new RegExp(
      `On main's head ${BASE}, as GitHub shows it \\(Factory runs nothing there\\), "quality" failed too\\. The operator answered repair: this Work Item's change is meant to fix it on main as well\\.`,
    ),
  );
  assert.ok(result.finding.endsWith("quality: 1 advisory left"));
});

test("the operator's retry once main is fixed brings the PR up to date with it instead of repairing", async () => {
  const fixed = [onBase(21, "quality", "success")];
  // main passes now, and the PR's head lacks its fix: GitHub updates it.
  const behind = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: fixed,
    behind: 2,
  });
  const update = await observe(behind, { retried: true });
  assert.equal(update.kind, "retry", JSON.stringify(update));
  assert.match(update.reason, /Awaiting GitHub's update of PR #7/);
  assert.deepEqual(behind.updates, [[7, HEAD]]);
  assert.deepEqual(behind.reruns, []);

  // main's run of it still runs: wait for it to compare.
  const running = github({
    runs: [check(1, "quality", "failure")],
    baseRuns: [
      onBase(21, "quality", null, {
        status: "in_progress",
        completed_at: null,
      }),
    ],
    behind: 2,
  });
  const wait = await observe(running, { retried: true });
  assert.equal(wait.kind, "retry");
  assert.equal(
    wait.reason,
    `Awaiting main's runs of quality at ${BASE} to compare PR #7's failed checks with them`,
  );
  assert.deepEqual(running.updates, []);

  // The PR has main's head already, or no retry was answered: as before.
  for (const [hub, answered] of [
    [
      github({ runs: [check(1, "quality", "failure")], baseRuns: fixed }),
      { retried: true },
    ],
    [
      github({
        runs: [check(1, "quality", "failure")],
        baseRuns: fixed,
        behind: 2,
      }),
      {},
    ],
  ]) {
    assert.equal((await observe(hub, answered)).kind, "rerun");
    assert.deepEqual(hub.updates, []);
  }
});

// Clockgrove #821 from 06:53 to 15:50 on 2026-10-27: PR #825's `checks`
// job failed on its rerun (attempt 2), main (dc3e310) hadn't moved since
// its checks passed five days before, and the PR's head already had it.
// A `revalidate` then delivered the same head again: nothing new could
// run, so the CI step repaired with the same finding, spending a repair
// the operator's rereview said was not due. It asks instead, until main
// fails them too or has moved on and passes them.
test("a result rereview whose failed checks nothing has run again since asks instead of repairing again", async () => {
  const failedAt = Date.now() - 60_000;
  const stale = new Date(failedAt - 5 * DAY).toISOString();
  const rereviewedAt = new Date(failedAt + 30_000).toISOString();
  const kept = {
    head: HEAD,
    runs: [RUN],
    checks: ["checks"],
    at: new Date(failedAt - 120_000).toISOString(),
  };
  const shape = (fields = {}) =>
    github({
      runs: [
        check(1, "checks", "failure", {
          completed_at: new Date(failedAt).toISOString(),
        }),
      ],
      baseRuns: [onBase(21, "checks", "success", { completed_at: stale })],
      jobs: { 1: { attempt: 2 } },
      attempt: 2,
      ...fields,
    });
  const answered = { retried: true, rereviewedAt, rerun: kept };

  const hub = shape();
  const asked = await observe(hub, answered);
  assert.equal(asked.kind, "hold", JSON.stringify(asked));
  assert.match(
    asked.question,
    new RegExp(
      `^Work Item a's result was checked again on the operator's revalidate and delivered unchanged, and no check has run on PR #7 since: at ${HEAD} it still fails checks \\(failure, \\S+\\)\\. Factory has nothing more to run there .*; it spent none\\.`,
    ),
  );
  // What main shows: its stale pass.
  assert.match(asked.question, /checks ended success at \S+, 5 days before/);
  assert.match(
    asked.question,
    /If main would fail them now too, run them again on main or fix them there \(another Objective can\), then answer retry; repair if the failure is this Work Item's change's; or cancel\.$/,
  );
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["retry", "repair", "cancel"],
  );
  assert.deepEqual(hub.reruns, []);
  assert.deepEqual(hub.updates, []);
  // The operator's retry to it, with nothing changed: asks again.
  assert.equal((await observe(shape(), answered)).kind, "hold");
  // Without the rereview, the same state repairs, as before.
  assert.equal((await observe(shape(), { rerun: kept })).kind, "repair");
  // `repair` to it repairs.
  const repaired = await observe(shape(), {
    ...answered,
    repairShared: true,
  });
  assert.equal(repaired.kind, "repair");
  assert.equal(repaired.checks, true);

  // The operator ran main's checks again and they fail now: main is red.
  const red = await observe(
    shape({
      baseRuns: [
        onBase(21, "checks", "success", { completed_at: stale }),
        onBase(22, "checks", "failure"),
      ],
    }),
    answered,
  );
  assert.equal(red.kind, "hold");
  assert.match(red.question, /^main is red: /);

  // 15:50: main moved on (#828) and passes them: GitHub updates the PR.
  const moved = shape({
    baseRuns: [onBase(21, "checks", "success")],
    behind: 1,
  });
  const update = await observe(moved, answered);
  assert.equal(update.kind, "retry");
  assert.deepEqual(moved.updates, [[7, HEAD]]);

  // A check that ran since the rereview (a head delivered for the first
  // time, or a rerun) is evidence: it is rerun and repaired as usual.
  const fresh = await observe(shape(), {
    ...answered,
    rereviewedAt: new Date(failedAt - 30_000).toISOString(),
  });
  assert.equal(fresh.kind, "repair");
});
