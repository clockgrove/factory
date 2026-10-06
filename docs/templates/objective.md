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

Add an optional Workspace package additions or Package manager update section only when this Objective authorizes that change; follow the exact syntax in [the user guide](../USER-GUIDE.md#write-an-objective).
