// Known Factory races the interleaving explorer reproduces. Each pinned
// schedule forces one race on any runner and is inverted: its test passes
// while the race reproduces with its diagnosis pattern and fails once the
// race is fixed, and then its entry must be removed. An explored schedule
// that breaks an invariant must fail with one of these patterns, otherwise
// it is a new race.
//
// Labels are `<Work Item> <effect> #<n>` (see test/support/interleave.mjs).
// Families (test/interleaving.test.mjs): `dependent` is alpha → beta and
// `independent` is alpha and beta with no dependency, both with regular
// delivery; `native` is alpha → beta with native-stack delivery.

export const DIAGNOSES = {
  START_WINDOW: {
    diagnosis:
      "regular-runner checkpoints a Work Item at running/execute before driver.start returns its handle; a crash in between (after the checkpoint, around `git worktree add`, or after driver.start returns) leaves the item running/execute without a handle, which a restart refuses as 'ambiguous active state at execute; operator direction required' (fault matrix START_AMBIGUOUS, r1 #4)",
    pattern: /ambiguous active state at execute/,
  },
  START_REPEAT: {
    diagnosis:
      "native delivery repeats driver.start with the same attempt id after a crash between `git worktree add` and the handle checkpoint; the local driver's `git worktree add` fails because the attempt's worktree exists, and the run stops uncertain (fault matrix START_REPEAT, r1 #4)",
    pattern: /worktree add[\s\S]*already exists/,
  },
  CLOSURE_START: {
    diagnosis:
      "regular-runner calls phases.release(alpha) before `await closeWorkItem(alpha)`, so beta is checkpointed at running/execute and its driver.start runs while alpha's completion comment and close are in flight; a crash at alpha's closure then lands in beta's START_WINDOW and the restart stops with beta 'ambiguous active state at execute' (the racy fault-matrix closure cases)",
    pattern: /Work Item beta has ambiguous active state at execute/,
  },
  REGISTRY: {
    diagnosis:
      "Factory runs `git fetch` and `git worktree remove` for different Work Items concurrently in one checkout without a lock; a removal that lands inside a fetch's registry walk kills the fetch ('fatal: Invalid path', modelled by the shim) and the Objective stops, and one inside another removal kills that removal, whose failure Factory ignores, stranding the worktree (#555)",
    pattern: /Invalid path|stranded worktrees/,
  },
  INTEGRATION_ORDER: {
    diagnosis:
      "regular-runner sets state.integratedSha to each Work Item's own merge commit when it records the item done; after a crash between beta's merge and its done checkpoint, the restart merges alpha first and then records beta, so state.integratedSha names beta's older merge and final validation stops with 'Default branch changed before final validation' although only Factory merged",
    pattern: /Default branch changed before final validation/,
  },
  COLLECT_WINDOW: {
    diagnosis:
      "LocalExecutionDriver.collect commits the worker's result in the attempt worktree and then removes the worktree before the runner records the commit; a crash before the removal makes the repeated collect fail with 'Worker changed HEAD; expected uncommitted changes at exact base', and one after it with 'cannot change to <worktree>', both recorded as implementation failures that need an operator (fault matrix COLLECT_REPEAT, r1 #5)",
    pattern: /Worker changed HEAD|cannot change to/,
  },
  STRANDED_VALIDATION: {
    diagnosis:
      "validation adds a worktree under validation/<uuid> and removes it when the commands finish; after a crash in between, the restart validates in a fresh worktree and never removes the old one, which stays registered in the checkout",
    pattern: /stranded worktrees/,
  },
};

/** Deterministic reproductions, one or more per diagnosis. */
export const PINNED = [
  {
    known: "CLOSURE_START",
    family: "dependent",
    name: "crash before alpha's completion comment while beta is between its execute checkpoint and driver.start",
    schedule: {
      holds: [
        {
          hold: "alpha POST /issues/{number}/comments #1",
          until: "beta state running/execute #1",
        },
        {
          hold: "beta driver.start #1",
          until: "alpha POST /issues/{number}/comments #1",
        },
      ],
      crash: { at: "alpha POST /issues/{number}/comments #1" },
    },
  },
  {
    known: "CLOSURE_START",
    family: "dependent",
    name: "crash after alpha's issue close while beta is between its execute checkpoint and driver.start",
    schedule: {
      holds: [
        {
          hold: "alpha PATCH /issues/{number} #1",
          at: "done",
          until: "beta state running/execute #1",
        },
        {
          hold: "beta driver.start #1",
          until: "alpha PATCH /issues/{number} #1",
        },
      ],
      crash: { at: "alpha PATCH /issues/{number} #1", phase: "done" },
    },
  },
  {
    known: "START_WINDOW",
    family: "dependent",
    name: "crash right after alpha's execute checkpoint",
    schedule: {
      crash: { at: "alpha state running/execute #1", phase: "done" },
    },
  },
  {
    known: "REGISTRY",
    family: "independent",
    name: "beta's validation worktree removal lands inside alpha's post-merge fetch",
    schedule: {
      holds: [
        { hold: "alpha git fetch #1", until: "beta git worktree add #2" },
        {
          hold: "beta git worktree remove #2",
          until: "alpha git fetch #1",
          phase: "mid",
        },
        {
          hold: "alpha git fetch #1",
          at: "mid",
          until: "beta git worktree remove #2",
        },
      ],
      models: ["alpha git fetch #1"],
    },
  },
  {
    known: "REGISTRY",
    family: "independent",
    name: "beta's validation worktree removal lands inside alpha's",
    schedule: {
      holds: [
        {
          hold: "alpha git worktree remove #2",
          until: "beta git worktree add #2",
        },
        {
          hold: "beta git worktree remove #2",
          until: "alpha git worktree remove #2",
          phase: "mid",
        },
        {
          hold: "alpha git worktree remove #2",
          at: "mid",
          until: "beta git worktree remove #2",
        },
      ],
      models: ["alpha git worktree remove #2"],
    },
  },
  {
    known: "INTEGRATION_ORDER",
    family: "independent",
    name: "crash after beta's post-merge fetch while alpha waits to merge",
    schedule: {
      holds: [
        {
          hold: "alpha git push #1",
          until: "beta POST /pulls #1",
          phase: "start",
        },
        { hold: "beta git fetch #1", until: "alpha state published/- #1" },
      ],
      crash: { at: "beta git fetch #1", phase: "done" },
    },
  },
  {
    known: "COLLECT_WINDOW",
    family: "dependent",
    name: "crash before collect removes alpha's attempt worktree",
    schedule: { crash: { at: "alpha git worktree remove #1" } },
  },
  {
    known: "COLLECT_WINDOW",
    family: "dependent",
    name: "crash after collect removes alpha's attempt worktree",
    schedule: { crash: { at: "alpha git worktree remove #1", phase: "done" } },
  },
  {
    known: "STRANDED_VALIDATION",
    family: "dependent",
    name: "crash after alpha's validation worktree is added",
    schedule: { crash: { at: "alpha git worktree add #2", phase: "done" } },
  },
  {
    known: "START_REPEAT",
    family: "native",
    name: "crash after alpha's attempt worktree is added",
    schedule: { crash: { at: "alpha git worktree add #1", phase: "done" } },
  },
];
