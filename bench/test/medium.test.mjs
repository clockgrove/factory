import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredRepos, plannedRepos } from "../../plugin/scripts/lib/one-repo.mjs";
import { MEDIUM } from "../lib/medium.mjs";

const SCRATCH = { owner: "acme", name: "scratch", full: "acme/scratch" };

test("medium drill: every Objective changes the scratch adopter alone, the export format included", () => {
  for (const make of MEDIUM) {
    const { body } = make("m1");
    assert.deepEqual(declaredRepos(body, SCRATCH), [], body.split("\n")[1]);
    assert.deepEqual(plannedRepos(body).repos, [], body.split("\n")[1]);
    assert.match(body, /no other file changes\./);
    assert.doesNotMatch(body, /formats\.json|registry|either repository/);
  }
  assert.match(MEDIUM[0]("m1").body, /^## Goal\nA caller can list notes as plain lines: `notes list --format m1`/);
});
