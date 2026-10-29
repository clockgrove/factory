// The suite files its Objectives with gh_issue_file. Run
// 2026-10-28T181930PDT-fb54 (codex, main) lost its codex case 12 s in:
// `gh issue create` failed once with `Post "https://api.github.com/graphql":
// EOF`, the suite didn't retry, and the case returned 1 before it queued
// anything. A retry must not file a second copy when the failed create did
// file the issue.
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

// A stand-in for gh: `issue create` and `api repos/R/issues`, over a JSON
// list of issues. FAKE_GH_FAIL holds how the next creates fail, one word each:
// "filed" (files the issue, then EOF), "lost" (EOF, nothing filed), "ok".
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const file = dir + "/issues.json";
const issues = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] === "issue" && args[1] === "create") {
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
  process.stdout.write(JSON.stringify([...issues].reverse()));
} else {
  process.stderr.write("fake gh: unexpected " + args.join(" ") + "\\n");
  process.exit(2);
}
`;

function file(fail, { issues = [], recorded = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "suite-file-issue-"));
  try {
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
    writeFileSync(join(dir, "fail"), fail);
    writeFileSync(join(dir, "creates"), "");
    writeFileSync(join(dir, "issues"), recorded);
    writeFileSync(join(dir, "body.md"), "Add `padEndQabcd`.\n");
    const r = spawnSync(
      "bash",
      [
        "-c",
        // No waiting between tries here.
        'source "$1/common.sh"; source "$1/gh.sh"; sleep() { :; }; gh_issue_file "$2" "$RUN_DIR/body.md"',
        "_",
        LIB,
        "Suite 10281819: codex stack happy path",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FAKE_GH_DIR: dir,
          RUN_DIR: dir,
          REPO,
          INST: "M",
          CASE: "codex",
        },
      },
    );
    return {
      status: r.status,
      stdout: r.stdout,
      creates: readFileSync(join(dir, "creates"), "utf8").length,
      issues: JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")),
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
