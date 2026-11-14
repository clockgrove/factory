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
  for (const bad of ["permissions: read-all\njobs: {}\npermissions: write-all", "permissions:\n  contents: read\n  contents: write", "permissions: {contents: read, contents: write}", 'on: push\n"on": pull_request', "permissions: !!map {}", "permissions: !custom write-all", "a: 1\n---\nb: 2", "<<: {a: 1}", "base: &b {contents: write}\npermissions:\n  <<: *b", "a: [1, 2", "permissions: !!str write-all", "t: &t !!str write\npermissions:\n  contents: *t", "permissions: {!!str contents: write}", "permissions: ! write-all", "%YAML 1.1\n---\nb: &b {contents: write}\npermissions:\n  <<: *b", "b: &b {contents: write}\npermissions:\n  !!merge \"<<\": *b", "b: &b {contents: write}\npermissions:\n  \"<<\": *b", "x: &k permissions\npermissions: read-all\n*k : write-all", "true: a\n\"true\": b", "jobs:\n  1: {}\n  \"1\": {}", "[contents]: write", "? {a: 1}\n: b", "a: *nowhere", "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]"]) {
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

test("workflow YAML: aliases copy their anchor against a budget, so many aliases read and an alias bomb throws; a caller can refuse aliases", () => {
  const job = (i) => `  j${i}:\n    runs-on: ubuntu-latest\n    steps: *steps\n`;
  const many = `on: push\nx-steps: &steps\n  - &c {run: echo}\n${Array.from({ length: 10 }, () => "  - *c\n").join("")}jobs:\n${Array.from({ length: 120 }, (_, i) => job(i)).join("")}`;
  const doc = parseYaml(many);
  assert.equal(Object.keys(doc.jobs).length, 120);
  assert.deepEqual(doc.jobs.j119.steps.at(-1), { run: "echo" });
  doc.jobs.j0.steps[0].run = "changed";
  assert.equal(doc.jobs.j1.steps[0].run, "echo", "an alias is a copy, not a shared object");
  assert.throws(() => parseYaml("a: &a x\nb: *a", { aliases: false }), /unsupported YAML \(an alias\)/);
  assert.throws(() => parseYaml("a: *x"), /an alias to no anchor/);
  const proto = parseYaml("__proto__: {polluted: yes}");
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal({}.polluted, undefined);
});
