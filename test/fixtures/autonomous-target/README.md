# Public summary utility

This dependency-free Node.js fixture is a small summary utility. The initial
implementation intentionally throws. Its two approved Objectives implement the
utility and then explain its accepted behavior. No package installation is needed.

The public check script is immutable acceptance evidence. Commands are:

- `node scripts/check.mjs alpha`
- `node scripts/check.mjs beta`
- `node scripts/check.mjs join`
- `node scripts/check.mjs qa`
- `node scripts/check.mjs guide`

The `qa` command checks a frozen input to detect mutation in addition to the normal
and empty cases. A passing word-presence guide check is only a structural check;
independent review must judge whether the usage explanation is correct.

A contributor qualification may additionally require the source-declared command
`factory-fixture-prerequisite`. This is a task-private acceptance probe supplied
by the qualification operator for a named disposable test condition. It must exist
before planning and run only during beta result validation and Objective final
validation. No other Work Item, including the discovered QA child or aggregate
parent, may run this command in this qualification scenario. The
local Node.js implementation environment is already available; this condition is
not required to implement the utility and is not a pre-worker readiness probe. A
failed acceptance probe must retain the original produced candidate and its
failure history for an authorized, diagnosed environment correction. It does not inspect source, modify target files,
or call a model. Workers must not create or change this tool.

In the first Objective, the discovered read-only QA child runs exactly
`node scripts/check.mjs qa` after summary integration and receives independent
acceptance review. Its aggregate parent only joins accepted child proof against
the exact integrated candidate: the parent must have an empty validation array
and no coding worker or pull request. These restrictions belong to this fixture;
they do not limit Factory's aggregate validation in other target Objectives.

For this native-stack qualification, preserve beta's attempt and execution base,
its original failed commit/tree and command receipts, and the exact owned path
inventory, file mode and blob bytes. After independently accepted alpha integrates,
native delivery may replay those unchanged beta-owned changes onto that exact
accepted integration commit. Retain the original and replayed identities separately
and verify the replay parent and result base. Revalidate both beta commands and
perform full independent result review on the actual replayed tree before delivery.
Require successful authenticated source-check on its exact published head before
integration. Native replay does not create another implementation attempt or beta
worker. It does not prove that the original and replayed whole trees are equal.
