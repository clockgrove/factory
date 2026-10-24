// `factory reset` on a clean machine: the state rebuilt from what GitHub
// holds alone (reset.ts rebuildFrom), over comments and PRs recorded from a
// scratch repository's Objective (fixtures/reset-394.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { statusComment, statusRecord } from "../dist/progress.js";
import { pullBranches, rebuildFrom, resetRecord } from "../dist/reset.js";

const recorded = JSON.parse(
  readFileSync(new URL("fixtures/reset-394.json", import.meta.url), "utf8"),
);
const { run, accepted } = recorded;
const config = {
  queue: {
    options: {
      queued: "Queued",
      planning: "Planning",
      building: "Building",
      holding: "Needs you",
      done: "Done",
      failed: "Failed",
      cancelled: "Cancelled",
    },
  },
  finalValidation: { requiredCommands: [] },
};
const self = "factory-app";
// No state file: the reset runs on a machine that never saw #394.
const record = () =>
  resetRecord(
    394,
    {
      id: "reset-1",
      at: "2026-10-24T06:00:00.000Z",
      by: "op",
      request: { kind: "reset", issue: 394 },
    },
    undefined,
    false,
    undefined,
    undefined,
    undefined,
  );
// A card Factory wrote after the plan was posted: its time says nothing.
const card = (option) => ({
  issue: 394,
  itemId: "PVTI_394",
  option,
  optionAt: "2026-10-24T02:47:40Z",
  order: 3,
  open: option !== "Done",
});
const comment = (id, body, at, login = self) => ({
  id,
  user: { login },
  created_at: at,
  updated_at: at,
  body,
});
const [plan, report] = recorded.comments;
const pulls = recorded.pulls;
// An operator's comment with a plan marker and plan-like data, before
// Factory's: not Factory's, so never read.
const foreign = comment(
  6378830000,
  '<!-- factory:394:plan -->\n<!-- factory-run:2026-10-24T02:35:53.775Z --><!-- factory-plan:x -->\n\n<details><summary>Plan data</summary>\n\n```json\n{"base":"0","items":[{"id":"fake","ownedPaths":[],"dependencies":[]}]}\n```\n</details>',
  "2026-10-24T02:36:00Z",
  "octo",
);

/** The live status comment as Factory writes it, with its record. */
function status(decisions, retired) {
  const marker = `<!-- factory:394:status:${run} -->`;
  const { body } = statusComment(
    marker,
    {
      view: {
        issue: 394,
        phase: "building",
        mode: "running",
        nextAction: { reason: "Work Item badge-helper runs." },
        items: [],
        waiting: [],
        holds: [],
      },
      activity: {},
      calls: { planner: 0, worker: 0, tokens: 0 },
      decisions: [],
      startedAt: run,
      record: { decisions, retired },
    },
    [],
    { questions: true },
    Date.parse("2026-10-24T02:46:00Z"),
  );
  return comment(recorded.status.id, body, recorded.status.created_at);
}

test("a delivered Objective comes back done from GitHub alone, with its plan and merges; a card queued again re-queues it", () => {
  const comments = [foreign, plan, report];
  assert.deepEqual(pullBranches(record(), comments, self), [
    "factory/394/badge-image",
    "factory/394/badge-helper",
  ]);
  const found = rebuildFrom(
    record(),
    { open: false, card: card("Queued"), self, comments, pulls },
    config,
  );
  const { state } = found;
  assert.equal(state.status, "done", found.message);
  assert.equal(state.startedAt, run, "the run is the one GitHub names");
  assert.equal(state.done.report, true);
  assert.deepEqual(
    state.done.plan.items.map((item) => item.id),
    ["badge-image", "badge-helper"],
    "Factory's own plan, not the operator's look-alike",
  );
  assert.equal(state.kept["plan:acceptedAt"], accepted);
  for (const [id, pr] of [
    ["badge-image", 401],
    ["badge-helper", 402],
  ]) {
    assert.equal(state.done[`item:${id}:publish`].pr, pr);
    assert.equal(
      state.done[`item:${id}:merge`].mergeSha,
      "a8e442453726cbf247804aabf7291a09de1db2ca",
    );
  }
  assert.equal(state.kept["reset:plan"], undefined, "nothing left to review");
  // The operator queued it again: that stands over the final option.
  const github = state.modules.github;
  assert.equal(github.ceded, "Done");
  assert.equal(github.shown, undefined);
  assert.ok(
    Date.parse(github.commentsSince) > Date.parse(report.created_at),
    "no comment acts again",
  );
});

test("a mid-build Objective keeps its plan for review, its merged item, open PR and the decisions the plan can take, whatever the card's time", () => {
  const mine = (holdId, at, plan = accepted) => ({
    reason: "Checked by hand: <ok> --> fine",
    by: "octo",
    at,
    holdId,
    plan,
  });
  const decision = {
    criterion:
      'src/badgeQvjrv.js exports badgePathQvjrv(), which returns exactly "assets/badgeQvjrv.png".',
    outcome: "accept",
    tree: "3a4c54cad91d9e5015c601ad1ca21e293c7f7da3",
    itemId: "badge-helper",
    ...mine(
      "item:badge-helper:review@2026-10-24T02:45:00.000Z",
      "2026-10-24T02:45:10.000Z",
    ),
  };
  // Final validation's only command can't be retired: dropped, and named.
  const retired = {
    command: "npm test",
    ...mine("final@2026-10-24T02:45:20.000Z", "2026-10-24T02:45:30.000Z"),
  };
  // A decision under an earlier plan of the run decides nothing now.
  const earlier = {
    ...decision,
    holdId: "item:badge-helper:review@2026-10-24T02:20:00.000Z",
    plan: "2026-10-24T02:10:00.000Z",
  };
  // A criterion the plan doesn't have decides nothing either.
  const foreign = {
    ...decision,
    criterion: "Anything goes.",
    holdId: "item:badge-helper:review@2026-10-24T02:44:00.000Z",
  };
  const shown = status([earlier, decision, foreign], [retired]);
  assert.deepEqual(statusRecord(shown.body), {
    decisions: [earlier, decision, foreign],
    retired: [retired],
  });
  const open = {
    ...pulls["factory/394/badge-helper"][0],
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
  };
  // A PR of the plan this run had before a replan: same branch, other plan.
  const replaced = {
    ...pulls["factory/394/badge-helper"][0],
    number: 399,
    body: pulls["factory/394/badge-helper"][0].body.replace(
      accepted,
      "2026-10-24T02:10:00.000Z",
    ),
  };
  const found = rebuildFrom(
    record(),
    {
      open: true,
      card: card("Building"),
      self,
      comments: [shown, plan],
      pulls: { ...pulls, "factory/394/badge-helper": [replaced, open] },
    },
    config,
  );
  const { state } = found;
  assert.equal(state.status, "checking", "it checks the Objective again");
  assert.equal(state.startedAt, run);
  assert.equal(state.done.plan, undefined, "no work before plan review");
  const kept = state.kept["reset:plan"];
  assert.equal(kept.accepted, accepted);
  assert.deepEqual(
    kept.plan.items.map((item) => item.id),
    ["badge-image", "badge-helper"],
  );
  assert.deepEqual(Object.keys(kept.merged), ["badge-image"]);
  assert.equal(kept.merged["badge-image"].pr, 401);
  assert.deepEqual(kept.decisions, [decision]);
  assert.deepEqual(kept.retired, []);
  assert.match(found.message, /retirement of `npm test`/);
  assert.match(found.message, /Anything goes/);
  // Its planning decisions stand for the checks and the review.
  assert.equal(
    state.done["decide:0:1"].decision.text,
    "Take your recommended option.",
  );
  assert.match(found.message, /#402 \(badge-helper\)/);
  assert.equal(state.modules.github.shown, "Building");
});

test("a later run GitHub names plans afresh; nothing of Factory's on GitHub and no queued card refuses", () => {
  const later = "2026-10-24T05:00:00.000Z";
  const found = rebuildFrom(
    record(),
    {
      open: true,
      card: card("Planning"),
      self,
      comments: [
        plan,
        report,
        comment(
          6379000000,
          `<!-- factory:394:status:${later} -->\n### Factory status`,
          "2026-10-24T05:00:02Z",
        ),
      ],
      pulls,
    },
    config,
  );
  const { state } = found;
  assert.equal(state.startedAt, later);
  assert.equal(state.status, "checking", "the earlier run's report isn't its");
  assert.equal(state.kept["reset:plan"], undefined);
  assert.equal(state.done.plan, undefined);
  assert.match(found.message, /plans again/);
  assert.equal(
    rebuildFrom(
      record(),
      { open: true, card: card("Done"), self, comments: [foreign], pulls: {} },
      config,
    ).code,
    "no_factory_state",
  );
});

test("an edited record is taken as missing: an edited plan plans afresh, an edited status record's decisions are asked again", () => {
  const decision = {
    criterion:
      'src/badgeQvjrv.js exports badgePathQvjrv(), which returns exactly "assets/badgeQvjrv.png".',
    outcome: "accept",
    reason: "fine",
    by: "octo",
    at: "2026-10-24T02:45:10.000Z",
    tree: "3a4c54cad91d9e5015c601ad1ca21e293c7f7da3",
    itemId: "badge-helper",
    holdId: "item:badge-helper:review@2026-10-24T02:45:00.000Z",
    plan: accepted,
  };
  const shown = status([decision], []);
  // A writer turns the accept into a refusal in the record's JSON.
  const forged = {
    ...shown,
    body: shown.body.replace('"outcome":"accept"', '"outcome":"refuse"'),
  };
  assert.equal(statusRecord(forged.body), "edited");
  const read = (comments) =>
    rebuildFrom(
      record(),
      { open: true, card: card("Building"), self, comments, pulls },
      config,
    );
  const edited = read([forged, plan]);
  assert.deepEqual(edited.state.kept["reset:plan"].decisions, []);
  assert.match(edited.message, /record doesn't match its digest/);
  // A writer edits an item's title in the plan data.
  const retitled = {
    ...plan,
    body: plan.body.replace(
      '"title":"Add selectable badge image"',
      '"title":"Anything"',
    ),
  };
  const replanned = read([shown, retitled]);
  assert.equal(replanned.state.kept["reset:plan"], undefined);
  assert.equal(replanned.state.status, "checking", "it plans afresh");
  assert.match(replanned.message, /plan data doesn't match the digest/);
});
