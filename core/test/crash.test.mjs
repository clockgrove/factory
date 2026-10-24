// Crash tests kill the real service with SIGKILL at named crash points and
// check that a restart finishes the work exactly once.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  cli,
  installation,
  seed,
  serve,
  stateOf,
  stopped,
  until,
} from "./helpers.mjs";

// Every crash point the hold → cancel path passes. A crash at each one, then
// a clean restart, must end cancelled and cleaned up, with the request
// applied once and no stray files.
// Crash points around GitHub effects: the hold, reply, note, reminder,
// cancel and live status comments, the Work Item issues (create, edit, links, live
// comment, reopen, close, priority labels, card), the Objective's role
// label and type, the role labels' create, the Status write, the plan, report and cancel comments, the
// issue close, the PR close, the branch delete, a re-queue's move of the
// built-in Status off Done and its reopen, and delivery's effects (LFS
// upload, push, PR, branch update, merge, native stack, the final LFS
// re-push). CI has no GitHub, so the drill covers them.
const GITHUB_CRASH_POINTS = [
  "serve:admitted",
  "sync:show:before",
  "sync:show:after",
  "sync:ask:before",
  "sync:ask:after",
  "sync:reply:before",
  "sync:reply:after",
  "sync:note:before",
  "sync:note:after",
  "sync:remind:before",
  "sync:remind:after",
  "sync:cancel:before",
  "sync:cancel:after",
  "sync:status:before",
  "sync:status:after",
  "sync:item-issue:create:before",
  "sync:item-issue:create:after",
  "sync:item-issue:edit:before",
  "sync:item-issue:edit:after",
  "sync:item-issue:link:before",
  "sync:item-issue:link:after",
  "sync:item-issue:comment:before",
  "sync:item-issue:comment:after",
  "sync:item-issue:reopen:before",
  "sync:item-issue:reopen:after",
  "sync:item-issue:close:before",
  "sync:item-issue:close:after",
  "sync:item-issue:label:before",
  "sync:item-issue:label:after",
  "sync:item-issue:card:before",
  "sync:item-issue:card:after",
  "sync:item-issue:status:before",
  "sync:item-issue:status:after",
  "sync:item-duplicate:comment:before",
  "sync:item-duplicate:comment:after",
  "sync:item-duplicate:close:before",
  "sync:item-duplicate:close:after",
  "sync:objective-role:before",
  "sync:objective-role:after",
  "sync:roles:label:before",
  "sync:roles:label:after",
  "plan:data:before",
  "plan:data:after",
  "plan:post:before",
  "plan:post:after",
  "amend:data:before",
  "amend:data:after",
  "amend:post:before",
  "amend:post:after",
  "report:comment:before",
  "report:comment:after",
  "report:close:before",
  "report:close:after",
  "cancel:pr-comment:before",
  "cancel:pr-comment:after",
  "cancel:pr-close:before",
  "cancel:pr-close:after",
  "cancel:branch-delete:before",
  "cancel:branch-delete:after",
  "cancel:close:before",
  "cancel:close:after",
  "rerun:pr-comment:before",
  "rerun:pr-comment:after",
  "rerun:pr-close:before",
  "rerun:pr-close:after",
  "rerun:status:before",
  "rerun:status:after",
  "rerun:reopen:before",
  "rerun:reopen:after",
  "serve:withdrawn",
  "deliver:lfs-push:before",
  "deliver:lfs-push:after",
  "deliver:push:before",
  "deliver:push:after",
  "deliver:pr-create:before",
  "deliver:pr-create:after",
  "deliver:update-branch:before",
  "deliver:update-branch:after",
  "deliver:merge:before",
  "deliver:merge:after",
  "stack:create:before",
  "stack:create:after",
  "stack:merge:before",
  "stack:merge:after",
  "final:lfs-repush:before",
  "final:lfs-repush:after",
  "reset:answered",
  "run:queue:before",
  "run:queue:after",
  "run:unqueue:before",
  "run:unqueue:after",
  "split:create:before",
  "split:sub-issue:before",
  "split:sub-issue:after",
  "split:blocked-by:before",
  "split:blocked-by:after",
  "split:comment:before",
  "split:comment:after",
  "split:done-comment:before",
  "split:done-comment:after",
  "split:close:before",
  "split:close:after",
];
for (const point of GITHUB_CRASH_POINTS)
  test(`crash at ${point}, restart, finish once`, {
    skip: "needs GitHub: covered by the milestone drill",
  });

const CRASH_POINTS = [
  "serve:loaded",
  "state:before-rename",
  "state:saved",
  "state:saved#2",
  "state:saved#3",
  "state:saved#4",
  "state:saved#5",
  "engine:check:started",
  "engine:check:before-apply",
  "engine:check:applied",
  "requests:applied",
  "engine:cancel:cleanup:started",
  "engine:cancel:cleanup:before-apply",
  "engine:cancel:cleanup:applied",
];

for (const point of CRASH_POINTS) {
  test(`crash at ${point}, restart, finish once`, async () => {
    const inst = installation();
    seed(inst, 11);
    const crashing = serve(inst, point);
    // Drive the path: wait for the hold, then cancel. The crash can come at
    // any moment along the way.
    let killedByTest = false;
    const holdOrDeath = await Promise.race([
      crashing.exit.then(() => "died"),
      until(() => stateOf(inst, 11).holds.length, "hold")
        .then(() => "held")
        .catch(() => "no hold"),
    ]);
    if (holdOrDeath === "held") {
      cli(inst, "cancel", "11");
      await Promise.race([
        crashing.exit,
        until(
          () => stateOf(inst, 11).done["cancel:cleanup"] === true,
          "cleanup",
        )
          // The crash point may come just after the save the test sees.
          .then(() => new Promise((resolve) => setTimeout(resolve, 500)))
          .then(() => {
            if (crashing.child.exitCode !== null || crashing.child.signalCode)
              return;
            killedByTest = true;
            crashing.child.kill("SIGKILL");
          })
          .catch(() => {}),
      ]);
    }
    const death = await crashing.exit;
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    assert.equal(killedByTest, false, `${point} was never reached`);

    const service = serve(inst);
    if (stateOf(inst, 11).status !== "cancelled") {
      await until(
        () =>
          stateOf(inst, 11).holds.length ||
          stateOf(inst, 11).status === "cancelled",
        "hold after restart",
      );
      cli(inst, "cancel", "11");
    }
    await until(
      () => stateOf(inst, 11).done["cancel:cleanup"] === true,
      "cleanup after restart",
    );
    await stopped(service);

    const state = stateOf(inst, 11);
    assert.equal(state.status, "cancelled");
    assert.equal(
      new Set(state.appliedRequests).size,
      state.appliedRequests.length,
    );
    const leftovers = readdirSync(inst.objectives).filter(
      (n) => n !== "11.json" && n !== "finished",
    );
    assert.deepEqual(leftovers, [], "temporary files left after restart");
    assert.ok(
      existsSync(inst.requests) &&
        readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
      "requests left unapplied",
    );
  });
}
