// The suite files its Objectives with gh_issue_file. Run
// 2026-10-28T181930PDT-fb54 (codex, main) lost its codex case 12 s in:
// `gh issue create` failed once with `Post "https://api.github.com/graphql":
// EOF`, the suite didn't retry, and the case returned 1 before it queued
// anything. A retry must not file a second copy when the failed create did
// file the issue. The prd suite's p_bot_issue files its non-writer Objective
// by dispatching drill-issue.yml, and retries a failed dispatch the same way
// (#2207).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const LIB = join(import.meta.dirname, "../integration/lib");
const REPO = "clockgrove/fd-test-m";

// A stand-in for gh: `issue create`, `workflow run drill-issue.yml` (which
// files its issue as github-actions[bot]) and `api repos/R/issues`, over a
// JSON list of issues. The file "fail" holds how the next creates fail, one
// word each: "filed" (files the issue, then EOF), "lost" (EOF, nothing filed),
// "ok"; the file "dispatch" holds the same for the next dispatches. While the
// file "api-down" exists, every lookup fails with EOF.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const file = dir + "/issues.json";
const issues = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const BOT = "github-actions[bot]";
if (args[0] === "workflow" && args[1] === "run" && args[2] === "drill-issue.yml") {
  fs.appendFileSync(dir + "/dispatches", "x");
  const plan = fs.readFileSync(dir + "/dispatch", "utf8").split(" ").filter(Boolean);
  const how = plan.shift() ?? "ok";
  fs.writeFileSync(dir + "/dispatch", plan.join(" "));
  const input = (name) =>
    args.filter((a, i) => args[i - 1] === "-f" && a.startsWith(name + "=")).map((a) => a.slice(name.length + 1))[0];
  if (how !== "lost") {
    issues.push({ number: issues.length + 1, title: input("title"), body: input("body"), user: { login: BOT }, state: "open" });
    fs.writeFileSync(file, JSON.stringify(issues));
  }
  if (how !== "ok") {
    process.stderr.write("could not create workflow dispatch event: HTTP 502: Server Error\\n");
    process.exit(1);
  }
} else if (args[0] === "api" && args[1].startsWith("repos/${REPO}/issues?creator=github-actions%5Bbot%5D&")) {
  if (fs.existsSync(dir + "/api-down")) {
    process.stderr.write('Get "https://api.github.com/repos": EOF\\n');
    process.exit(1);
  }
  // p_bot_found's --jq: .[]|select(.title=="T")|.number
  const title = /select\\(\\.title=="(.*)"\\)\\|\\.number$/.exec(flag("--jq"))[1];
  for (const i of [...issues].reverse()) {
    if (i.user?.login === BOT && i.state === "open" && i.title === title) process.stdout.write(i.number + "\\n");
  }
} else if (args[0] === "issue" && args[1] === "create") {
  fs.appendFileSync(dir + "/creates", "x");
  const plan = fs.readFileSync(dir + "/fail", "utf8").split(" ").filter(Boolean);
  const how = plan.shift() ?? "ok";
  fs.writeFileSync(dir + "/fail", plan.join(" "));
  const number = issues.length + 1;
  if (how !== "lost") {
    issues.push({ number, title: flag("--title"), body: fs.readFileSync(flag("--body-file"), "utf8") });
    fs.writeFileSync(file, JSON.stringify(issues));
  }
  if (how !== "ok") {
    process.stderr.write('Post "https://api.github.com/graphql": EOF\\n');
    process.exit(1);
  }
  process.stdout.write("https://github.com/" + flag("--repo") + "/issues/" + number + "\\n");
} else if (args[0] === "api" && args[1].startsWith("repos/${REPO}/issues?")) {
  if (fs.existsSync(dir + "/api-down")) {
    process.stderr.write('Get "https://api.github.com/repos": EOF\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([...issues].reverse()));
} else {
  process.stderr.write("fake gh: unexpected " + args.join(" ") + "\\n");
  process.exit(2);
}
`;

// Runs CALL (gh_issue_file by default) against the stand-in gh, whose creates
// go as FAIL says and dispatches as DISPATCH says.
function file(
  fail,
  {
    issues = [],
    recorded = "",
    apiDown = false,
    dispatch = "",
    env = {},
    call = 'gh_issue_file "Suite 10281819: codex stack happy path" "$RUN_DIR/body.md"',
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "suite-file-issue-"));
  try {
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
    writeFileSync(join(dir, "fail"), fail);
    writeFileSync(join(dir, "dispatch"), dispatch);
    writeFileSync(join(dir, "creates"), "");
    writeFileSync(join(dir, "dispatches"), "");
    writeFileSync(join(dir, "clock"), "");
    writeFileSync(join(dir, "issues"), recorded);
    writeFileSync(join(dir, "body.md"), "Add `padEndQabcd`.\n");
    if (apiDown) writeFileSync(join(dir, "api-down"), "");
    const r = spawnSync(
      "bash",
      [
        "-c",
        // No waiting between tries here: sleep only moves a clock that now
        // reads (a byte of the file "clock" a second).
        `source "$1/common.sh"; source "$1/gh.sh"; source "$1/../cases/prd.sh"
        sleep() { printf "%$1s" >>"$RUN_DIR/clock"; }; now() { stat -c %s "$RUN_DIR/clock"; }
        ${call}`,
        "_",
        LIB,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FAKE_GH_DIR: dir,
          RUN_DIR: dir,
          SUITE: join(LIB, ".."),
          SFX: "10281819",
          RUN_ID: "test-run",
          REPO,
          INST: "M",
          CASE: "codex",
          STOP_AT: "1000000",
          ...env,
        },
      },
    );
    return {
      status: r.status,
      stdout: r.stdout,
      creates: readFileSync(join(dir, "creates"), "utf8").length,
      dispatches: readFileSync(join(dir, "dispatches"), "utf8").length,
      elapsed: readFileSync(join(dir, "clock"), "utf8").length,
      issues: JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")),
      recorded: readFileSync(join(dir, "issues"), "utf8"),
      journal: existsSync(join(dir, "journal"))
        ? readFileSync(join(dir, "journal"), "utf8")
        : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a create that works the first time files once, with nothing logged", () => {
  const r = file("ok");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.creates, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.journal, "");
});

test("an EOF that filed nothing is filed again", () => {
  const r = file("lost");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.creates, 2);
  assert.equal(r.issues.length, 1);
  assert.match(
    r.journal,
    /\[codex\] filing issue .* failed \(try 1\): Post "https:\/\/api\.github\.com\/graphql": EOF/,
  );
});

test("an EOF that did file the issue finds it, with no second copy", () => {
  const r = file("filed");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.creates, 1);
  assert.equal(r.issues.length, 1);
  assert.match(r.journal, /was filed by the failed try: #1/);
});

test("an issue the run recorded, or another body, is never taken for the lost one", () => {
  const title = "Suite 10281819: codex stack happy path";
  const r = file("lost", {
    issues: [
      { number: 1, title, body: "Add `padEndQabcd`.\n" },
      { number: 2, title, body: "Something else." },
    ],
    recorded: "1 codex M\n",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "3\n");
  assert.equal(r.creates, 2);
});

test("a failure that lasts fails after three tries, each logged", () => {
  const r = file("lost lost lost");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.creates, 3);
  assert.equal(r.journal.match(/failed \(try [123]\)/g).length, 3);
});

test("a retry that can't look for the lost issue files nothing", () => {
  // The failed create may have filed it: creating again without looking could
  // leave two copies, so the suite gives up instead.
  const r = file("filed", { apiDown: true });
  assert.equal(r.status, 1);
  assert.equal(r.creates, 1);
  assert.equal(r.issues.length, 1);
  assert.match(r.journal, /looking for issue .* failed \(try 2\): Get .*: EOF/);
  assert.match(r.journal, /looking for issue .* failed \(try 3\)/);
});

test("new_issue records the issue a failed create filed, once", () => {
  const r = file("filed", {
    call: 'new_issue withdraw "queue withdraw before planning" ID=q1',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.creates, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(
    r.issues[0].title,
    "Suite 10281819: queue withdraw before planning",
  );
  assert.equal(r.recorded, "1 codex M\n");
  assert.match(r.journal, /filed #1 \(withdraw\)/);
});

// p_bot_issue against the stand-in gh, as the outsider case calls it.
function botIssue(dispatch, options = {}) {
  return file("", {
    dispatch,
    env: { CASE: "outsider", INST: "P" },
    call: 'p_bot_issue "Suite 10281819: non-writer Objective Qabcd" "$RUN_DIR/body.md"',
    ...options,
  });
}

test("a dispatch that works the first time files one bot issue, with no retry", () => {
  const r = botIssue("ok");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.dispatches, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].user.login, "github-actions[bot]");
  assert.equal(r.recorded, "1 outsider P\n");
  assert.doesNotMatch(r.journal, /failed/);
});

test("a failed dispatch that did file the issue finds it, with no second dispatch", () => {
  const r = botIssue("filed");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.dispatches, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.recorded, "1 outsider P\n");
  assert.match(
    r.journal,
    /\[outsider\] dispatching drill-issue\.yml for .* failed \(try 1\): could not create workflow dispatch event: HTTP 502/,
  );
  assert.match(r.journal, /was filed by the failed dispatch: #1/);
});

test("a failed dispatch that filed nothing is dispatched again once the wait shows no issue", () => {
  const r = botIssue("lost");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.dispatches, 2);
  assert.equal(r.issues.length, 1);
  assert.equal(r.recorded, "1 outsider P\n");
  assert.match(r.journal, /failed \(try 1\)/);
  // The retry waited as long as a dispatch that worked is given.
  assert.ok(r.elapsed >= 240, `waited ${r.elapsed} s before the retry`);
  assert.doesNotMatch(r.journal, /filed by the failed dispatch/);
});

test("a dispatch failure that lasts fails after three tries, each logged", () => {
  const r = botIssue("lost lost lost");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.dispatches, 3);
  assert.equal(r.issues.length, 0);
  assert.equal(r.recorded, "");
  assert.equal(r.journal.match(/failed \(try [123]\)/g).length, 3);
});

test("a dispatch that failed late in a lasting failure still finds its issue", () => {
  const r = botIssue("lost lost filed");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(r.dispatches, 3);
  assert.equal(r.issues.length, 1);
  assert.match(r.journal, /was filed by the failed dispatch: #1/);
});

test("a failed dispatch whose issue can't be looked for is never dispatched again", () => {
  // The failed dispatch may have filed it: dispatching again without looking
  // could leave two bot issues, so the suite gives up instead.
  const r = botIssue("filed", { apiDown: true });
  assert.equal(r.status, 1);
  assert.equal(r.dispatches, 1);
  assert.equal(r.issues.length, 1);
  assert.match(r.journal, /looking for bot issue .* failed: Get .*: EOF/);
});
