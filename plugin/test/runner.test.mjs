import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { linuxRunner, runnerLabels, runnerMatchCheck, workflowJobs } from "../scripts/doctor.mjs";
import { pickRunner, renderWorkflow, runsOnValue } from "../scripts/setup.mjs";

// The scratch adopter's CI (#314): pinned to 24.04, where its setup script's PostgreSQL packages install.
const QUALITY = `name: Quality
on:
  pull_request:
  merge_group:
jobs:
  quality:
    runs-on: ubuntu-24.04 # ubuntu-latest moved to 26.04
    steps:
      - run: scripts/ci/setup.sh
`;

const ciOf = (text, name = "Quality") => ({ found: true, name, jobs: workflowJobs(text) });

test("workflowJobs: each job's check name, literal runner (a label list as JSON) and run steps; expressions give no runner", () => {
  assert.deepEqual(workflowJobs(QUALITY), [{ check: "quality", runner: "ubuntu-24.04", commands: ["scripts/ci/setup.sh"] }]);
  const many = `on: [pull_request]
jobs:
  a: { name: Lint, runs-on: ubuntu-24.04, steps: [] }
  b:
    runs-on: "\${{ matrix.os }}"
  c:
    runs-on: [self-hosted, linux]
`;
  assert.deepEqual(workflowJobs(many).map((j) => [j.check, j.runner]), [["Lint", "ubuntu-24.04"], ["b", null], ["c", '["self-hosted","linux"]']]);
  assert.deepEqual(workflowJobs("jobs:\n\tbad: tab"), [], "a file the parser refuses names no job");
  assert.ok(linuxRunner("ubuntu-24.04") && linuxRunner('["self-hosted","linux"]') && linuxRunner("linux-arm64-large"));
  assert.ok(!linuxRunner("macos-15") && !linuxRunner("windows-2025") && !linuxRunner('["self-hosted","macOS"]') && !linuxRunner(null));
});

// A cross-platform CI whose first job is macOS: Factory's jobs need Linux (the agent launcher).
const CROSS = `name: CI
on: [pull_request, merge_group]
jobs:
  mac: { runs-on: macos-15, steps: [{ run: npm test }] }
  win: { runs-on: windows-2025, steps: [{ run: npm test }] }
  linux: { runs-on: ubuntu-24.04, steps: [{ run: npm test }] }
`;

// A path filter on ubuntu-latest first, the job that runs setup on a pinned image second (#314's failure, again).
const FILTERED = `name: CI
on: [pull_request, merge_group]
jobs:
  changes: { runs-on: ubuntu-latest, steps: [{ uses: dorny/paths-filter@v3 }] }
  test:
    name: Tests
    runs-on: ubuntu-24.04
    steps: [{ run: "scripts/ci/setup.sh && npm test" }]
`;

test("pickRunner: --runs-on wins, else the CI workflow's Linux runner that runs setup, else ubuntu-latest", () => {
  const ci = ciOf(QUALITY);
  assert.equal(pickRunner("", ci).runsOn, "ubuntu-24.04");
  assert.match(pickRunner("", ci).note, /the runner of Quality's quality job/);
  assert.equal(pickRunner("self-hosted", ci).runsOn, "self-hosted", "the owner's pick");
  const cross = pickRunner("", ciOf(CROSS, "CI"));
  assert.equal(cross.runsOn, "ubuntu-24.04", "macOS and Windows jobs are skipped though they come first");
  assert.equal(pickRunner("", ciOf("jobs:\n  mac: { runs-on: macos-15 }\n", "CI")).runsOn, "ubuntu-latest", "no Linux job");
  assert.match(pickRunner("", ciOf("jobs:\n  mac: { runs-on: macos-15 }\n", "CI")).note, /names no full Linux runner/);
  const filtered = ciOf(FILTERED, "CI");
  assert.equal(pickRunner("", filtered, { commands: ["scripts/ci/setup.sh"] }).runsOn, "ubuntu-24.04", "the job that runs setup");
  assert.match(pickRunner("", filtered, { commands: ["scripts/ci/setup.sh"] }).note, /Tests job, which runs scripts\/ci\/setup\.sh; its Linux jobs also use ubuntu-latest/);
  assert.equal(pickRunner("", filtered, { checks: ["Tests"] }).runsOn, "ubuntu-24.04", "a required check's job");
  assert.equal(pickRunner("", filtered).runsOn, "ubuntu-24.04", "no hint: the pinned image over the -latest alias");
  const label = pickRunner("", ciOf("jobs:\n  t: { runs-on: [self-hosted, linux], steps: [] }\n", "CI"));
  assert.equal(label.runsOn, '["self-hosted","linux"]');
  assert.equal(pickRunner("", { found: false, error: "403" }).runsOn, "ubuntu-latest", "CI unreadable");
});

test("runnerMatchCheck: warns when the rendered runner jobs leave the CI workflow's setup runner; silent in sandbox mode", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const base = { harness: "claude", action: "clockgrove/factory@v1.2.3" };
  const render = (runs_on, extra = {}) => renderWorkflow(template, { ...base, runs_on, ...extra });
  const ci = ciOf(QUALITY);
  const latest = runnerMatchCheck(render("ubuntu-latest"), ci);
  assert.equal(latest.status, "WARN");
  assert.match(latest.detail, /run on ubuntu-latest; Quality runs setup on ubuntu-24\.04/);
  assert.equal(runnerMatchCheck(render(pickRunner("", ci).runsOn), ci).status, "PASS", "setup's default render matches");
  assert.equal(runnerMatchCheck(render("", { sandbox: "vercel", ci_workflow: "Quality", default_branch: "main" }), ci), null, "no runner jobs");
  assert.equal(runnerMatchCheck(render("ubuntu-latest"), { found: true, name: "Quality", jobs: [] }), null, "nothing to compare");
  // A macOS render passed before, because macos-15 is one of CI's runners: now only Linux runners count.
  const cross = ciOf(CROSS, "CI");
  assert.equal(runnerMatchCheck(render("macos-15"), cross).status, "WARN");
  assert.equal(runnerMatchCheck(render(pickRunner("", cross).runsOn), cross).status, "PASS");
  // ubuntu-latest is one of CI's Linux runners, but not the one that runs setup.
  const filtered = ciOf(FILTERED, "CI");
  const hints = { commands: ["scripts/ci/setup.sh"] };
  const off = runnerMatchCheck(render("ubuntu-latest"), filtered, hints);
  assert.equal(off.status, "WARN");
  assert.match(off.detail, /its Tests job, which runs scripts\/ci\/setup\.sh \(its Linux jobs use ubuntu-latest, ubuntu-24\.04\)/);
  assert.equal(runnerMatchCheck(render(pickRunner("", filtered, hints).runsOn), filtered, hints).status, "PASS");
  // A self-hosted label list renders as a YAML sequence and compares equal.
  const selfHosted = ciOf("jobs:\n  t: { runs-on: [self-hosted, linux], steps: [] }\n", "CI");
  const listed = render({ raw: pickRunner("", selfHosted).runsOn });
  assert.match(listed, /runs-on: \["self-hosted","linux"\]/);
  assert.equal(runnerMatchCheck(listed, selfHosted).status, "PASS");
});

// #2608: a path filter on GitHub's container runner, the tests on -latest; nothing names setup or a required check.
const SLIM = `name: CI
on: [pull_request, merge_group]
jobs:
  changes: { runs-on: ubuntu-slim, steps: [{ uses: dorny/paths-filter@v3 }] }
  test: { runs-on: ubuntu-latest, steps: [{ run: npm test }] }
`;

test("a container-only runner (ubuntu-slim) is never picked for work or review, and doctor warns on one", () => {
  assert.ok(!linuxRunner("ubuntu-slim") && !linuxRunner('["ubuntu-slim"]') && linuxRunner("ubuntu-latest"));
  const ci = ciOf(SLIM, "CI");
  assert.equal(pickRunner("", ci).runsOn, "ubuntu-latest", "not the pinned-looking ubuntu-slim");
  assert.equal(pickRunner("", ciOf("jobs:\n  c: { runs-on: ubuntu-slim, steps: [] }\n", "CI")).runsOn, "ubuntu-latest", "only a container job: the default");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const render = (runs_on) => renderWorkflow(template, { harness: "claude", action: "clockgrove/factory@v1.2.3", runs_on });
  assert.equal(runnerMatchCheck(render("ubuntu-latest"), ci).status, "PASS");
  const slim = runnerMatchCheck(render("ubuntu-slim"), ci);
  assert.equal(slim.status, "WARN");
  assert.match(slim.detail, /ubuntu-slim, a container runner/);
  assert.match(runnerMatchCheck(render("ubuntu-slim"), ciOf("jobs:\n  c: { runs-on: ubuntu-slim, steps: [] }\n", "CI")).detail, /container runner/, "warns with no CI runner to compare");
});

test("no runner label makes setup or doctor throw: one that cannot be read is skipped and gives a WARN row", () => {
  for (const bad of ["[self-hosted", "[1]", "[]", '["linux"', "[null]"]) {
    assert.equal(runnerLabels(bad), null, bad);
    assert.equal(linuxRunner(bad), false, bad);
  }
  assert.equal(linuxRunner(undefined), false);
  const text = `on: [pull_request]
jobs:
  odd: { runs-on: "[self-hosted", steps: [{ run: scripts/ci/setup.sh }] }
  test: { runs-on: ubuntu-24.04, steps: [{ run: npm test }] }
`;
  const ci = ciOf(text, "CI");
  assert.equal(ci.jobs[0].runner, "[self-hosted");
  const picked = pickRunner("", ci, { commands: ["scripts/ci/setup.sh"] });
  assert.equal(picked.runsOn, "ubuntu-24.04");
  assert.match(picked.note, /could not read the runner label "\[self-hosted"/);
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const render = (runs_on) => renderWorkflow(template, { harness: "claude", action: "clockgrove/factory@v1.2.3", runs_on });
  const row = runnerMatchCheck(render(picked.runsOn), ci, { commands: ["scripts/ci/setup.sh"] });
  assert.equal(row.status, "WARN");
  assert.match(row.detail, /could not read the runner label "\[self-hosted"/);
  // The Factory workflow's own odd label: quoted when rendered (a scalar, not a broken flow sequence), then a WARN row.
  const mine = render("[self-hosted");
  assert.match(mine, /runs-on: "\[self-hosted"/);
  const own = runnerMatchCheck(mine, ciOf(QUALITY));
  assert.equal(own.status, "WARN");
  assert.match(own.detail, /could not read the runner label "\[self-hosted"/);
  assert.doesNotThrow(() => runnerMatchCheck(mine, { found: true, name: "CI", jobs: [{ check: "x", runner: "[", commands: [] }] }));
});

test("--runs-on takes a label list typed as YAML or JSON and renders it as a list; doctor names each mismatch once", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const render = (runsOn) => renderWorkflow(template, { harness: "claude", action: "clockgrove/factory@v1.2.3", runs_on: runsOnValue(runsOn) });
  for (const typed of ["[self-hosted, linux]", '["self-hosted", "linux"]', ' [ self-hosted , "linux" ] ']) {
    const picked = pickRunner(typed, {});
    assert.equal(picked.runsOn, '["self-hosted","linux"]', typed);
    assert.doesNotMatch(picked.note, /could not read/, typed);
    const text = render(picked.runsOn);
    assert.match(text, /runs-on: \["self-hosted","linux"\]/, typed);
    assert.equal(workflowJobs(text).filter((j) => j.runner === '["self-hosted","linux"]').length, 2, typed);
    assert.ok(linuxRunner(picked.runsOn), typed);
  }
  // Neither JSON nor a YAML list of labels: one quoted label, and setup's note says so.
  for (const bad of ["[self-hosted", "[]", "[self-hosted, [linux]]", "[a, {b: c}]"]) {
    const picked = pickRunner(bad, {});
    assert.equal(picked.runsOn, bad, bad);
    assert.match(picked.note, /could not read the runner label/, bad);
    assert.match(render(picked.runsOn), new RegExp(`runs-on: ${JSON.stringify(JSON.stringify(bad)).slice(1, -1).replace(/[[\]]/g, "\\$&")}`), bad);
  }
  // ubuntu-slim on Factory's side and ubuntu-24.04 in CI: one clause names the container runner, none repeats it.
  const slim = runnerMatchCheck(render("ubuntu-slim"), ciOf(QUALITY));
  assert.equal(slim.status, "WARN");
  assert.equal(slim.detail.split("ubuntu-slim").length, 2, slim.detail);
  const odd = runnerMatchCheck(render("[x"), ciOf(QUALITY));
  assert.equal(odd.detail.split('"[x"').length, 2, odd.detail);
  assert.doesNotMatch(odd.detail, /run on \[x/, odd.detail);
});
