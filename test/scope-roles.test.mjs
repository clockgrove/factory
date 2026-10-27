// The suite's scope case reads base/top/solo roles from the accepted plan.
// Claude's plan for the prd suite's scope case (run
// 2026-10-27T140641PDT-0b1a) added a read-only aggregate over the three work
// items beside the QA item; the case refused that valid plan before testing
// anything (holds.item-scope).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
