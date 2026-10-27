// The suite's scope case reads base/top/solo roles from the accepted plan.
// Claude's plan for the prd suite's scope case (run
// 2026-10-27T140641PDT-0b1a) added a read-only aggregate over the three work
// items beside the QA item; the case refused that valid plan before testing
// anything (holds.item-scope).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopeRoles } from "../integration/lib/scope-roles.mjs";

const WORK = [
  "scope-base work -",
  "scope-top work scope-base",
  "scope-solo work -",
];
const QA = "qa-integrated qa scope-base,scope-top,scope-solo";
const AGGREGATE = "scope-all aggregate scope-base,scope-top,scope-solo";

test("a plan with QA and an aggregate over the work items fits the case", () => {
  assert.deepEqual(scopeRoles([...WORK, QA, AGGREGATE].join("\n")), [
    "scope-base",
    "scope-top",
    "scope-solo",
  ]);
  assert.deepEqual(scopeRoles([...WORK, AGGREGATE].join("\n")), [
    "scope-base",
    "scope-top",
    "scope-solo",
  ]);
  assert.deepEqual(scopeRoles(WORK.join("\n")), [
    "scope-base",
    "scope-top",
    "scope-solo",
  ]);
});

test("a plan without exactly base, top and solo work items doesn't fit", () => {
  // A fourth work item, an unknown kind, solo depending on base, no solo.
  assert.equal(
    scopeRoles([...WORK, "scope-more work -", QA].join("\n")),
    undefined,
  );
  assert.equal(
    scopeRoles([...WORK, "scope-x grader scope-top"].join("\n")),
    undefined,
  );
  assert.equal(
    scopeRoles(
      [
        "scope-base work -",
        "scope-top work scope-base",
        "scope-solo work scope-base",
      ].join("\n"),
    ),
    undefined,
  );
  assert.equal(scopeRoles(WORK.slice(0, 2).join("\n")), undefined);
  assert.equal(scopeRoles(""), undefined);
});

test("a work item that depends on solo or on a read-only node doesn't fit", () => {
  // Top over both base and solo: solo is no longer independent.
  assert.equal(
    scopeRoles(
      [
        "scope-base work -",
        "scope-top work scope-base,scope-solo",
        "scope-solo work -",
      ].join("\n"),
    ),
    undefined,
  );
  // Top over the QA or aggregate (alone or beside base): its start would wait
  // on a node, not on base's held merge.
  for (const topDeps of ["qa-base", "scope-base,qa-base", "scope-all"])
    assert.equal(
      scopeRoles(
        [
          "scope-base work -",
          `scope-top work ${topDeps}`,
          "scope-solo work -",
          "qa-base qa scope-base",
          "scope-all aggregate scope-base",
        ].join("\n"),
      ),
      undefined,
      topDeps,
    );
  // Base and top depending on each other.
  assert.equal(
    scopeRoles(
      [
        "scope-base work scope-top",
        "scope-top work scope-base",
        "scope-solo work -",
      ].join("\n"),
    ),
    undefined,
  );
});

test("the case's command line prints the roles, or nothing", () => {
  const script = join(
    import.meta.dirname,
    "../integration/lib/scope-roles.mjs",
  );
  const run = (items) =>
    spawnSync(process.execPath, [script, items], { encoding: "utf8" });
  const fits = run([...WORK, QA, AGGREGATE].join("\n"));
  assert.equal(fits.status, 0, fits.stderr);
  assert.equal(fits.stdout, "scope-base scope-top scope-solo\n");
  const not = run(WORK.slice(0, 2).join("\n"));
  assert.equal(not.status, 0, not.stderr);
  assert.equal(not.stdout, "\n");
});

test("the command line works through a symlinked suite directory", () => {
  // run-suite.sh's $SUITE is `pwd` of its directory, which keeps symlinks;
  // Node resolves them for the main module's import.meta.url only.
  const dir = mkdtempSync(join(tmpdir(), "scope-roles-"));
  try {
    const lib = join(dir, "lib");
    symlinkSync(join(import.meta.dirname, "../integration/lib"), lib);
    const run = spawnSync(
      process.execPath,
      [join(lib, "scope-roles.mjs"), [...WORK, QA, AGGREGATE].join("\n")],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "scope-base scope-top scope-solo\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
