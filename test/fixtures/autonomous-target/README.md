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
`factory-fixture-prerequisite`. This is a task-private host readiness probe supplied
by the qualification operator. It must exist before planning; its successful exit
means the named public test environment is ready. It does not inspect source,
modify target files, or call a model. Workers must not create or change this tool.
