# Short title of the result

## Goal

One paragraph: what changes, for whom, and what is out of scope for this Objective. A goal paragraph from a PRD works as is.

## Acceptance

- One observable fact per bullet. A reviewer must be able to check it against the delivered code and test results.
- Put any constraint that must be verified here, not only under Constraints. For example: "Install, checks and tests leave the Git tree clean."
- `npm test`

## Context

Optional prose and links (PRD sections, issues, design notes). The planner reads the repository itself. Sources below is optional too: list only files every worker must receive verbatim, one `- path` or `- path#Exact Heading` per bullet, and delete the section otherwise.

## Sources

- `docs/spec.md#Exact Heading`

## Constraints

- Non-goals and limits workers must respect, such as no deployment, no new dependencies, or paths that must not change.

Add an optional Workspace package additions or Package manager update section only when this Objective authorizes that change; follow the exact syntax in [the user guide](../USER-GUIDE.md#write-an-objective).
