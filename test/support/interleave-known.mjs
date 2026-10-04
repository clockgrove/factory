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
// Labels are `<Work Item> <effect> #<n>` (see test/support/interleave.mjs).
// Families (test/interleaving.test.mjs): `dependent` is alpha → beta and
// `independent` is alpha and beta with no dependency, both with regular
// delivery; `native` is alpha → beta with native-stack delivery.

const AMBIGUOUS = /Work Item (\w+) has ambiguous active state at execute/;
const ambiguousItem = (message) => AMBIGUOUS.exec(message)?.[1];
const crashedItem = (result) => result.crashed?.label.split(" ")[0];
const REPEATED_ADD =
  /worktree add --detach \S+\/worktrees\/[\w-]+ [0-9a-f]+ failed \(128\)[\s\S]*already exists/;

export const DIAGNOSES = {
  START_WINDOW: {
    diagnosis:
      "regular-runner checkpoints a Work Item at running/execute before driver.start returns its handle; a crash of that Work Item in between (after the checkpoint, around `git worktree add`, or after driver.start returns) leaves it running/execute without a handle, which a restart refuses as 'ambiguous active state at execute; operator direction required' (fault matrix START_AMBIGUOUS, r1 #4)",
    match: { ambiguous: AMBIGUOUS, stop: AMBIGUOUS },
    when: (failure, result) =>
      ambiguousItem(failure.message) === crashedItem(result),
  },
  CLOSURE_START: {
    diagnosis:
      "a crash at one Work Item's effect lands in the other's START_WINDOW: regular-runner calls phases.release(alpha) before `await closeWorkItem(alpha)`, so beta is checkpointed at running/execute and its driver.start runs while alpha's completion comment and close are in flight, and a crash there stops every restart with beta 'ambiguous active state at execute' (the racy fault-matrix closure cases); independent Work Items meet it at any effect",
    match: { ambiguous: AMBIGUOUS, stop: AMBIGUOUS },
    when: (failure, result) => {
      const item = ambiguousItem(failure.message);
      return Boolean(
        item && crashedItem(result) && item !== crashedItem(result),
      );
    },
  },
  START_REPEAT: {
    diagnosis:
      "native-stack delivery repeats driver.start with the same attempt id after a crash between `git worktree add` and the handle checkpoint; the local driver's `git worktree add` fails because the attempt's worktree exists, and the run stops uncertain (fault matrix START_REPEAT, r1 #4)",
    match: { ambiguous: REPEATED_ADD, stop: REPEATED_ADD },
  },
  REGISTRY: {
    diagnosis:
      "MODELLED, not observed: Factory runs `git fetch` and `git worktree remove` for different Work Items concurrently in one checkout without a lock, so the schedule can put a removal inside a fetch's or another removal's registry walk. The git shim models what #555 measured with plain git for that overlap: the fetch dies with 'fatal: Invalid path', the Work Item fails as uncertain and the Objective stops, or the other removal fails, Factory ignores it and the worktree stays registered",
    match: {
      stop: /Invalid path '[^']*': No such file or directory \(interleave model/,
      ambiguous:
        /Invalid path '[^']*': No such file or directory \(interleave model/,
      worktrees: /stranded worktree \S+ \(removal failed\)/,
    },
  },
  INTEGRATION_ORDER: {
    diagnosis:
      "regular-runner sets state.integratedSha to each Work Item's own merge commit when it records the item done; after a crash between beta's merge and its done checkpoint, the restart merges alpha first and then records beta, so state.integratedSha names beta's older merge and final validation stops with 'Default branch changed before final validation' although only Factory merged",
    match: { stop: /Default branch changed before final validation/ },
  },
  COLLECT_WINDOW: {
    diagnosis:
      "LocalExecutionDriver.collect commits the worker's result in the attempt worktree and then removes the worktree before the runner records the commit; a crash before the removal makes the repeated collect fail with 'Worker changed HEAD; expected uncommitted changes at exact base', and one after it with \"cannot change to '<attempt worktree>'\", both recorded as implementation failures that need an operator (fault matrix COLLECT_REPEAT, r1 #5)",
    match: {
      stop: /Worker changed HEAD; expected uncommitted changes at exact base|git rev-parse HEAD failed \(128\): fatal: cannot change to '[^']*\/worktrees\/[\w-]+'/,
    },
  },
  STRANDED_VALIDATION: {
    diagnosis:
      "validation adds a worktree under validation/<uuid> (final validation under final-validation/<uuid>) and removes it when the commands finish; after a crash in between, the restart validates in a fresh worktree and nothing removes or prunes the old one, which stays registered in the checkout",
    match: {
      worktrees:
        /stranded worktree \S+\/(?:validation|final-validation)\/[\w-]+ \(never removed\)/,
    },
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
