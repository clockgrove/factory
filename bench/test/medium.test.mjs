import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredRepos, plannedRepos } from "../../plugin/scripts/lib/one-repo.mjs";
import { MEDIUM, mediumObjectives } from "../lib/medium.mjs";

const SCRATCH = { owner: "acme", name: "scratch", full: "acme/scratch" };

test("medium drill: five Objectives, suffixed so repeated runs never collide, cycling through the set", () => {
  const list = mediumObjectives(7, "1109");
  assert.deepEqual(list.map((o) => o.fn), ["m11090", "m11091", "m11092", "m11093", "m11094", "m11095", "m11096"]);
  assert.match(list[0].title, /^Add the m11090 export format/);
  assert.match(list[5].title, /^Add the m11095 export format/);
  assert.equal(MEDIUM.length, 5);
});

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
