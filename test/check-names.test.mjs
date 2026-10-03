import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertKnownCheckNames,
  workflowCheckNames,
} from "../dist/check-names.js";
import {
  knownCheckNames,
  objectiveRequiredChecks,
  planningSources,
} from "../dist/compiler.js";
import { createTarget } from "./support/integration-fixture.mjs";

const step = '    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n';
const workflows = {
  ".github/workflows/ci.yml": `name: CI
on: pull_request
jobs:
  lint:
${step}  test:
    name: test:unit
${step}  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
${step}  dynamic:
    name: Test \${{ matrix.shard }}
${step}  included:
    strategy:
      matrix:
        include: [{ os: ubuntu-latest }]
${step}  computed:
    strategy:
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
${step}  reusable:
    name: Reusable
    uses: ./.github/workflows/reusable.yml
  external:
    uses: octo/shared/.github/workflows/check.yml@v1
  fanned:
    strategy:
      matrix:
        node: [20]
    uses: ./.github/workflows/reusable.yml
`,
  ".github/workflows/reusable.yml": `on: workflow_call
jobs:
  check:
${step}  build:
    strategy:
      matrix:
        node: [20]
${step}`,
  ".github/workflows/push.yml": `on: push\njobs:\n  pushed:\n${step}`,
  ".github/workflows/queue.yml": `on: [push, merge_group]\njobs:\n  queue:\n${step}`,
  ".github/workflows/target.yaml": `on:\n  pull_request_target:\n    types: [opened]\njobs:\n  target:\n${step}`,
  ".github/workflows/nested/inner.yml": `on: pull_request\njobs:\n  inner:\n${step}`,
  ".github/workflows/broken.yml": "on: pull_request\njobs: [unclosed\n",
  ".github/workflows/notes.md": `on: pull_request\njobs:\n  ignored:\n${step}`,
};
const reported = [
  "Reusable / build (20)",
  "Reusable / check",
  "build (macos-latest, 20)",
  "build (macos-latest, 22)",
  "build (ubuntu-latest, 20)",
  "build (ubuntu-latest, 22)",
  "lint",
  "queue",
  "target",
  "test:unit",
];

test("workflow check names are the names GitHub reports on a pull request", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-check-names-"));
  try {
    const target = createTarget(root, workflows);
    // Matrix jobs report only expanded names; a local reusable workflow
    // reports "caller / callee". Only top-level workflows triggered by a
    // pull request or merge queue count; expression names, matrices that need
    // include or expressions, external and matrix calls, workflow_call-only
    // and push-only workflows, nested files and unparseable files report
    // nothing Factory can know.
    assert.deepEqual(
      workflowCheckNames(target.checkout, target.baseSha),
      reported,
    );
    // A base without workflows defines no names.
    const bare = createTarget(join(root, "bare"));
    assert.deepEqual(workflowCheckNames(bare.checkout, bare.baseSha), []);
    // A Git failure is an error, never an empty list.
    assert.throws(
      () => workflowCheckNames(target.checkout, "0".repeat(40)),
      /Cannot read the GitHub workflows at base 0{40}/,
    );
    // The Objective's Required checks add exact names the workflows cannot.
    const body =
      "## Acceptance\n- Done.\n\n## Required checks\n- `codecov/patch`\n- lint\n";
    assert.deepEqual(objectiveRequiredChecks(body), ["codecov/patch", "lint"]);
    assert.deepEqual(knownCheckNames(body, target.baseSha, target.checkout), [
      "codecov/patch",
      "lint",
      ...reported.filter((name) => name !== "lint"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Required checks entries are exact bullets, checked before planning", () => {
  assert.deepEqual(objectiveRequiredChecks("## Acceptance\n- Done.\n"), []);
  for (const entry of ["quality", "- `` ", "```\n- quality\n```"])
    assert.throws(
      () =>
        planningSources(
          `## Acceptance\n- Done.\n\n## Required checks\n${entry}\n\n## Final validation\n- \`true\`\n`,
          "unused",
          "/unused",
        ),
      /Required checks entry/,
    );
});

test("a plan may name only known CI checks, by exact string", () => {
  const plan = (gate, proof) => ({
    objective: 1,
    baseSha: "a".repeat(40),
    items: [],
    requiredPreIntegrationChecks: [
      {
        checkName: gate,
        source: { path: "OBJECTIVE", digest: "0".repeat(64), text: "x" },
      },
    ],
    coverage: [{ proof: { kind: "integrated-ci", checkName: proof } }],
  });
  const known = ["build (ubuntu-latest, 20)", "CI / test"];
  assertKnownCheckNames(plan("CI / test", "build (ubuntu-latest, 20)"), known);
  for (const [gate, proof, name] of [
    ["build", "CI / test", "build"],
    ["CI / test", "test", "test"],
    ["ci / test", "CI / test", "ci / test"],
  ])
    assert.throws(
      () => assertKnownCheckNames(plan(gate, proof), known),
      new RegExp(
        `CI check "${name.replace("/", "\\/")}" is not a job in the base's GitHub workflows or an entry under the Objective's Required checks`,
      ),
    );
});
