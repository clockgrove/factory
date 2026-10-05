# Short title of the result

## Outcome

One paragraph: what changes, for whom, and what is out of scope for this Objective.

## Acceptance

- One observable fact per bullet. A reviewer must be able to check it against the delivered code and test results.
- Put any constraint that must be verified here, not only under Constraints. For example: "Install, checks and tests leave the Git tree clean."
- `npm test`

## Sources

- `docs/spec.md#Exact Heading`
- `docs/protocol.md`

## Constraints

- Non-goals and limits workers must respect, such as no deployment, no new dependencies, or paths that must not change.

## Workspace package additions

Optional. Only when adding packages to an existing `pnpm-workspace.yaml`. One exact backticked package directory per bullet; planning refuses a Work Item that creates a package manifest not listed here.

- `packages/example`

## Package manager update

Optional. Only when refreshing an existing exact stable npm or pnpm `packageManager` pin. Exactly one backticked pin in one bullet; preserve the manager, acceptance scripts, lifecycle hooks and security configuration. Omit this section when no update is authorized.

- `pnpm@10.34.5`
