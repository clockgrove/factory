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
before planning and run during beta result validation and final validation. The
local Node.js implementation environment is already available; this condition is
not required to implement the utility and is not a pre-worker readiness probe. A
failed acceptance probe must retain the produced candidate for an authorized,
diagnosed environment correction. It does not inspect source, modify target files,
or call a model. Workers must not create or change this tool.
