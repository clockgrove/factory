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
  for (const bad of ["permissions: read-all\njobs: {}\npermissions: write-all", "permissions:\n  contents: read\n  contents: write", "permissions: {contents: read, contents: write}", 'on: push\n"on": pull_request', "base: &b {contents: write}\npermissions: *b", "permissions: !!map {}", "a: 1\n---\nb: 2", "a: \"one\n  two\"", "<<: {a: 1}"]) {
    assert.throws(() => parseYaml(bad), /unsupported YAML/, bad);
  }
});
