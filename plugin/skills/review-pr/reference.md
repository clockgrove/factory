# review-pr: reference

Lookup detail for the review-pr skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Placing a comment

A comment that fits no line of the diff goes on the file's first changed line.

## Repository checklists

Findings to look for where the repository has a design checklist or checklist questions of its own:

- A design-checklist answer whose `file:line` evidence does not say what the answer claims.
- A number without a source, a new power on a broad grant, unbounded growth, a per-request cost: the repository's own checklist questions, where it has them.

## The final message

`{"acceptance": [...], "comments": [...]}`, only JSON, no prose around it.

- `acceptance` has one `{entry, met, path, line, evidence}` per acceptance entry of the issue.
- `comments` holds `{path, line, entry, body}` and may be empty, but every entry not met has one.
