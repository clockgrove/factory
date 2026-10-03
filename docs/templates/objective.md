# Short title of the result

## Outcome

One paragraph: what changes, for whom, and what is out of scope for this Objective.

## Acceptance

- One observable fact per bullet. A reviewer must be able to check it against the delivered code and test results.
- Put any constraint that must be verified here, not only under Constraints. For example: "Install, checks and tests leave the Git tree clean."

## Final validation

- `npm ci`
- `npm test`

## Constraints

- Non-goals and limits workers must respect, such as no deployment, no new dependencies, or paths that must not change.

## Workspace package additions

- `packages/new-package`

## Planning sources

- `docs/spec.md#Exact Heading`
- `docs/protocol.md`
