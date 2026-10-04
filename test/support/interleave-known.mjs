// Known Factory races the interleaving explorer reproduces. Each pinned
// schedule forces one race on any runner and is inverted: its test passes
// while the race reproduces and fails once the race is fixed, and then its
// entry must be removed.
//
// A diagnosis explains a failure of a named invariant (see checkInvariants
// in test/support/interleave.mjs) whose message matches that invariant's
// pattern, and `when` holds. A schedule passes only if every invariant it
// breaks, other than consequences of a stop, is explained; anything else is
// a new race, even next to a known one.
//
// A `fixed` entry pins a race that is fixed (#515, the item steps): its
// schedule must hold every invariant.
//
// Labels are `<Work Item> <effect> #<n>` (see test/support/interleave.mjs).
// Families (test/interleaving.test.mjs): `dependent` is alpha → beta and
// `independent` is alpha and beta with no dependency, both with regular
// delivery; `native` is alpha → beta with native-stack delivery.

export const DIAGNOSES = {};

/** Deterministic reproductions, one or more per diagnosis, and fixed races kept pinned. */
export const PINNED = [
  // CLOSURE_START is fixed by serializing: the regular runner frees alpha's
  // delivery slot only after its closure is durable, so beta never reaches
  // its execute checkpoint while alpha closes. A hold that waits for that
  // cannot be satisfied (the explorer reports it infeasible), so these pins
  // schedule only the crash in alpha's closure.
  {
    fixed: "CLOSURE_START",
    family: "dependent",
    name: "crash before alpha's completion comment",
    schedule: {
      crash: { at: "alpha POST /issues/{number}/comments #1" },
    },
  },
  {
    fixed: "CLOSURE_START",
    family: "dependent",
    name: "crash after alpha's issue close",
    schedule: {
      crash: { at: "alpha PATCH /issues/{number} #1", phase: "done" },
    },
  },
  {
    fixed: "START_WINDOW",
    family: "dependent",
    name: "crash right after alpha's execute checkpoint",
    schedule: {
      crash: { at: "alpha state running/execute #1", phase: "done" },
    },
  },
  {
    fixed: "INTEGRATION_ORDER",
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
    fixed: "COLLECT_WINDOW",
    family: "dependent",
    name: "crash before collect removes alpha's attempt worktree",
    schedule: { crash: { at: "alpha git worktree remove #1" } },
  },
  {
    fixed: "COLLECT_WINDOW",
    family: "dependent",
    name: "crash after collect removes alpha's attempt worktree",
    schedule: { crash: { at: "alpha git worktree remove #1", phase: "done" } },
  },
  {
    fixed: "STRANDED_VALIDATION",
    family: "dependent",
    name: "crash after alpha's validation worktree is added",
    schedule: { crash: { at: "alpha git worktree add #2", phase: "done" } },
  },
  {
    fixed: "START_REPEAT",
    family: "native",
    name: "crash after alpha's attempt worktree is added",
    schedule: { crash: { at: "alpha git worktree add #1", phase: "done" } },
  },
];
