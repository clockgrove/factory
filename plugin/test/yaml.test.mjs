import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantsWrite, parseYaml, workflowEvents } from "../scripts/lib/yaml.mjs";

test("workflow YAML: events and permissions read from the parsed file; anything doctor cannot read for sure throws", () => {
  const doc = parseYaml(`name: CI
"on":
  pull_request:
    types: [opened, synchronize]
  merge_group: # the queue
permissions: { contents: read, pull-requests: write }
jobs:
  test:
    runs-on: ubuntu-24.04
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@v6
      - name: run
        run: |
          npm ci
          npm test # not a comment inside a block scalar
`);
  assert.deepEqual(workflowEvents(doc), ["pull_request", "merge_group"]);
  assert.equal(grantsWrite(doc.permissions), true);
  assert.equal(grantsWrite(doc.jobs.test.permissions), true);
  assert.equal(doc.jobs.test.steps[1].run, "npm ci\nnpm test # not a comment inside a block scalar\n");
  assert.deepEqual(workflowEvents(parseYaml("on: [push, pull_request]")), ["push", "pull_request"]);
  assert.equal(grantsWrite(parseYaml("permissions: read-all").permissions), false);
  assert.equal(grantsWrite(parseYaml("permissions: write-all").permissions), true);
  assert.equal(grantsWrite(undefined), null, "unset: the repository default applies");
  assert.deepEqual(workflowEvents(parseYaml("on:\n- pull_request\n- merge_group\npermissions:\n  contents: read")), ["pull_request", "merge_group"], "a list at its key's indent");
  assert.deepEqual(parseYaml("steps:\n- uses: a\n  with:\n  - x\n- run: b").steps, [{ uses: "a", with: ["x"] }, { run: "b" }]);
  for (const bad of ["permissions: read-all\njobs: {}\npermissions: write-all", "permissions:\n  contents: read\n  contents: write", "permissions: {contents: read, contents: write}", 'on: push\n"on": pull_request', "permissions: !!map {}", "permissions: !custom write-all", "a: 1\n---\nb: 2", "<<: {a: 1}", "base: &b {contents: write}\npermissions:\n  <<: *b", "a: [1, 2", "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]"]) {
    assert.throws(() => parseYaml(bad), /unsupported YAML/, bad);
  }
});

test("workflow YAML: what GitHub Actions reads, read the same way (anchors, folded and indented block text, quoted text over several lines); plain values stay text", () => {
  // Anchors and aliases: GitHub Actions has read them since 2025-09-18.
  const anchored = parseYaml("on: push\nbase: &perms\n  contents: write\njobs:\n  a:\n    permissions: *perms\n");
  assert.deepEqual(anchored.jobs.a.permissions, { contents: "write" });
  assert.equal(grantsWrite(anchored.jobs.a.permissions), true);
  // A folded condition joins its lines with spaces, as GitHub evaluates it.
  assert.equal(parseYaml("if: >\n  github.event.action == 'closed' ||\n  github.event_name == 'push'\n").if, "github.event.action == 'closed' || github.event_name == 'push'\n");
  // A literal block keeps the extra indentation of its deeper lines.
  assert.equal(parseYaml("run: |\n  if x; then\n    echo y\n  fi\n").run, "if x; then\n  echo y\nfi\n");
  assert.equal(parseYaml('a: "one\n  two"').a, "one two");
  // Plain values are their source text, never booleans or numbers; `on` is a key, not YAML 1.1's true.
  assert.deepEqual(parseYaml("on: [push]\ncancel-in-progress: true\nnode: 24.10\ntimeout: 010\nempty:\ntilde: ~\nquoted: 'true'"), { on: ["push"], "cancel-in-progress": "true", node: "24.10", timeout: "010", empty: null, tilde: null, quoted: "true" });
  assert.equal(parseYaml(""), null);
});
