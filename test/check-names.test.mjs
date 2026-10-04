import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertKnownCheckNames,
  workflowCheckNames,
} from "../dist/check-names.js";
import { createHash } from "node:crypto";
import {
  assertCheckSourcesAtIntegration,
  assertProofCheckDefined,
} from "../dist/delivery/check-sources.js";
import { faultOf } from "../dist/fault.js";
import { unreportedGates } from "../dist/delivery/readiness.js";
import {
  validateGraphSources,
  knownCheckNames,
  objectiveRequiredChecks,
  planningSources,
} from "../dist/compiler.js";
import { createTarget, git } from "./support/integration-fixture.mjs";

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
      /Cannot read the GitHub workflows at commit 0{40}/,
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

const objectiveBody = (checks) =>
  `## Acceptance\n- Done.\n\n## Required checks\n${checks}\n\n## Final validation\n- \`true\`\n`;
const planOf = (body, baseSha, gate, proof) => ({
  objective: 1,
  baseSha,
  items: [],
  requiredPreIntegrationChecks: gate
    ? [
        {
          checkName: gate,
          source: {
            path: "OBJECTIVE",
            digest: createHash("sha256").update(body).digest("hex"),
            text: body,
          },
        },
      ]
    : [],
  coverage: proof
    ? [{ proof: { kind: "integrated-ci", checkName: proof } }]
    : [],
});

test("a planned gate or CI proof naming an invented or misspelled check is refused at plan time", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-check-names-"));
  try {
    const target = createTarget(root, workflows);
    const body = objectiveBody("- `codecov/patch`");
    const sources = planningSources(body, target.baseSha, target.checkout);
    const validate = (gate, proof) =>
      validateGraphSources(
        planOf(body, target.baseSha, gate, proof),
        sources,
        target.checkout,
        body,
        target.baseSha,
      );
    for (const [gate, proof, name] of [
      ["lnit", undefined, "lnit"],
      ["lint", "tests", "tests"],
      [undefined, "Lint", "Lint"],
    ])
      assert.throws(
        () => validate(gate, proof),
        new RegExp(`CI check "${name}" is not a job in the base's GitHub`),
      );
    // A workflow job and a Required checks line are the two bindings.
    validate("lint", "codecov/patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function renameLint(root, target) {
  const clone = join(root, "clone");
  git(root, "clone", target.origin, clone);
  const file = join(clone, ".github/workflows/ci.yml");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace("  lint:", "  lint2:"),
  );
  git(clone, "add", "-A");
  git(
    clone,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Rename lint",
  );
  git(clone, "push", "origin", "main");
}

test("delivery refuses a gate that main no longer defines, offering only answers that work", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-check-names-"));
  try {
    const target = createTarget(root, workflows);
    const body = objectiveBody("- `codecov/patch`");
    const at = (gate, proof) =>
      assertCheckSourcesAtIntegration({
        graph: planOf(body, target.baseSha, gate, proof),
        baseSha: target.baseSha,
        objectiveBody: body,
        checkout: target.checkout,
        gates: gate ? [gate] : [],
        defaultBranch: () => "main",
      });
    // A job and a Required checks line both bind a gate.
    await at("lint");
    await at("codecov/patch");
    // No gate: nothing to bind, and a CI proof is bound by QA, not delivery.
    await at(undefined, undefined);
    await at(undefined, "gone");
    renameLint(root, target);
    await assert.rejects(at("lint"), (error) => {
      const fault = faultOf(error);
      assert.equal(fault.kind, "decision");
      assert.match(
        fault.question,
        /CI check "lint" has not reported on the PR head and is no longer a job in main's/,
      );
      assert.match(
        fault.question,
        /Restore the job under that name and run factory retry, or cancel and plan again\?/,
      );
      assert.doesNotMatch(fault.question, /amend|add the new name/);
      return true;
    });
    // A proof naming the renamed job is not a delivery wait.
    await at(undefined, "lint");
    await at("lint2", "codecov/patch");
    // A verified gate stays verified only for its tip: "lint" passed above
    // before the rename and is refused after it.
    // The Objective's Required checks can no longer justify the name.
    await assert.rejects(
      assertCheckSourcesAtIntegration({
        graph: planOf(body, target.baseSha, "codecov/patch"),
        baseSha: target.baseSha,
        objectiveBody: objectiveBody("- `other`"),
        checkout: target.checkout,
        gates: ["codecov/patch"],
        defaultBranch: () => "main",
      }),
      (error) => faultOf(error).kind === "decision",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a QA CI proof is bound to its own commit, only while it must wait", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-check-names-"));
  try {
    const target = createTarget(root, workflows);
    const body = objectiveBody("- `codecov/patch`");
    const at = (checkName, commit = target.baseSha, text = body) =>
      assertProofCheckDefined({
        checkName,
        commit,
        objectiveBody: text,
        checkout: target.checkout,
      });
    at("lint");
    at("codecov/patch");
    for (const name of ["lnit", "Lint"])
      assert.throws(
        () => at(name),
        (error) => {
          const fault = faultOf(error);
          assert.equal(fault.kind, "decision");
          assert.match(
            fault.question,
            new RegExp(
              `CI check "${name}" is not a job in the GitHub workflows at ${target.baseSha.slice(0, 12)}`,
            ),
          );
          assert.match(fault.question, /Cancel and plan again/);
          assert.doesNotMatch(fault.question, /amend|add the new name/);
          return true;
        },
      );
    assert.throws(() =>
      at("codecov/patch", target.baseSha, objectiveBody("- `x`")),
    );
    // The commit decides: a later rename on main does not change it.
    renameLint(root, target);
    at("lint");
    // A commit that is unreadable is a decision that names the commit, not
    // a plain Error.
    assert.throws(
      () => at("lint", "0".repeat(40)),
      (error) => {
        const fault = faultOf(error);
        assert.equal(fault.kind, "decision");
        assert.match(fault.question, /could not read the GitHub workflows/);
        assert.match(fault.question, /factory retry, or cancel and plan again/);
        assert.match(
          fault.evidence.join("\n"),
          /Cannot read the GitHub workflows at commit 0{40}/,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only gates a PR has not reported on at its head can be waiting for a check that never comes", () => {
  const gates = ["lint", "test", "build", "docs"];
  const open = {
    state: "open",
    // The real observe lists a name for a run in any state at the exact head.
    reportedChecks: ["lint"],
    failedChecks: ["build"],
  };
  // Running, ended or failed on the head has reported; nothing at the head
  // has not. Whether a name gets into reportedChecks is tested through the
  // real observe in ci-readiness.test.mjs.
  assert.deepEqual(unreportedGates(open, gates), ["test", "docs"]);
  assert.deepEqual(unreportedGates({ state: "open" }, gates), gates);
  assert.deepEqual(unreportedGates({ state: "merged" }, gates), []);
  assert.deepEqual(unreportedGates({ state: "closed" }, gates), []);
});
