import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml, workflowEvents, writeGrants } from "../scripts/lib/yaml.mjs";

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
  assert.deepEqual(writeGrants(doc.permissions), ["pull-requests: write"]);
  assert.deepEqual(writeGrants(doc.jobs.test.permissions), ["issues: write"]);
  assert.equal(doc.jobs.test.steps[1].run, "npm ci\nnpm test # not a comment inside a block scalar\n");
  assert.deepEqual(workflowEvents(parseYaml("on: [push, pull_request]")), ["push", "pull_request"]);
  assert.deepEqual(writeGrants(parseYaml("permissions: read-all").permissions), []);
  assert.deepEqual(writeGrants(parseYaml("permissions: write-all").permissions), ["write-all"]);
  assert.equal(writeGrants(undefined), null, "unset: the repository default applies");
  assert.deepEqual(workflowEvents(parseYaml("on:\n- pull_request\n- merge_group\npermissions:\n  contents: read")), ["pull_request", "merge_group"], "a list at its key's indent");
  assert.deepEqual(parseYaml("steps:\n- uses: a\n  with:\n  - x\n- run: b").steps, [{ uses: "a", with: ["x"] }, { run: "b" }]);
  for (const bad of ["permissions: read-all\njobs: {}\npermissions: write-all", "permissions:\n  contents: read\n  contents: write", "permissions: {contents: read, contents: write}", 'on: push\n"on": pull_request', "permissions: !!map {}", "permissions: !custom write-all", "a: 1\n---\nb: 2", "<<: {a: 1}", "base: &b {contents: write}\npermissions:\n  <<: *b", "a: [1, 2", "permissions: !!str write-all", "t: &t !!str write\npermissions:\n  contents: *t", "permissions: {!!str contents: write}", "permissions: ! write-all", "%YAML 1.1\n---\nb: &b {contents: write}\npermissions:\n  <<: *b", "b: &b {contents: write}\npermissions:\n  !!merge \"<<\": *b", "b: &b {contents: write}\npermissions:\n  \"<<\": *b", "x: &k permissions\npermissions: read-all\n*k : write-all", "true: a\n\"true\": b", "jobs:\n  1: {}\n  \"1\": {}", "[contents]: write", "? {a: 1}\n: b", "a: *nowhere", "on: pull_request\nenv: &a {A: &a write-all}\npermissions: *a", "p: &p read\npermissions: &p {contents: *p}", "a: &x 1\nb: &x 2", "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]"]) {
    assert.throws(() => parseYaml(bad), /unsupported YAML/, bad);
  }
});

test("#556: writeGrants reads a permissions block exactly: every scope at write, write-all and any value that is no read-only level is a grant, named; read, none, read-all and {} grant nothing", () => {
  const scopes = ["id-token", "packages", "checks", "statuses", "deployments", "security-events", "pages", "attestations", "discussions", "repository-projects", "a-scope-github-adds-later"];
  for (const scope of scopes) {
    assert.deepEqual(writeGrants(parseYaml(`permissions:\n  contents: read\n  ${scope}: write\n`).permissions), [`${scope}: write`], scope);
  }
  assert.deepEqual(writeGrants(parseYaml(`permissions: {${scopes.map((s) => `${s}: write`).join(", ")}}`).permissions), scopes.map((s) => `${s}: write`), "every grant named");
  assert.deepEqual(writeGrants(parseYaml("jobs:\n  t:\n    permissions: write-all\n").jobs.t.permissions), ["write-all"], "a job's write-all");
  // Not a permission level: GitHub would refuse the file, so none of these is read as read-only.
  assert.deepEqual(writeGrants(parseYaml("permissions:\n  contents: Write\n  issues: admin\n  pages:\n  checks: [read]\n").permissions), ["contents: Write", "issues: admin", "pages: null", 'checks: ["read"]']);
  assert.deepEqual(writeGrants(parseYaml("permissions: read").permissions), ["read"], "read is a scope's level, not the whole block's");
  assert.deepEqual(writeGrants(parseYaml('permissions: ""').permissions), ['""']);
  // Read-only: each scope read or none, read-all, or {}.
  assert.deepEqual(writeGrants(parseYaml(`permissions:\n${scopes.map((s, i) => `  ${s}: ${i % 2 ? "read" : "none"}\n`).join("")}`).permissions), []);
  assert.deepEqual(writeGrants(parseYaml("permissions: {}").permissions), []);
  assert.deepEqual(writeGrants(parseYaml("permissions: read-all").permissions), []);
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

// GitHub evaluates `${{ }}` anywhere in an action's metadata, descriptions included, and refuses to load the action when
// an expression names a context an action may not use (`vars`, `secrets`): every job then fails at "Set up job". A
// description holds no expression at all, and no expression names those contexts.
test("action.yml: no expression in any description, and none names a context an action cannot read", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8");
  const action = parseYaml(text);
  const descriptions = [action.description, ...Object.values(action.inputs || {}).map((i) => i?.description), ...Object.values(action.outputs || {}).map((o) => o?.description)];
  for (const d of descriptions) assert.ok(!String(d ?? "").includes("${{"), `an expression in a description: ${String(d).slice(0, 80)}`);
  for (const [, expr] of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) assert.ok(!/(?<![.\w])(vars|secrets)\b/.test(expr), `an action cannot read this context: \${{${expr}}}`);
});
