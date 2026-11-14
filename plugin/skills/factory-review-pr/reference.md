# factory-review-pr: reference

Lookup detail for the factory-review-pr skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Placing a comment

A comment that fits no line of the diff goes on the file's first changed line.

## Repository checklists

Findings to look for where the repository has a design checklist or checklist questions of its own:

- A design-checklist answer whose `file:line` evidence does not say what the answer claims.
- A number without a source, a new power on a broad grant, unbounded growth, a per-request cost: the repository's own checklist questions, where it has them.

## Split parts

Only when the prompt says the PR is a part of a split Objective and not the last part:

- An entry the PR body's Acceptance table or Undone assigns to a later part is judged `"met": false, "deferred": true`, its evidence naming where the body assigns it, and gets no comment.
- Still a finding: an entry, or a piece of one, the body claims this part delivers and the diff does not; a deferred entry this part's own changes depend on; a schema, constraint, signature or error this part adds that a deferred entry cannot be built on as it stands (a column that cannot hold a record the entry needs, a call with no way to bound or stop it, a refusal whose reason is lost). Put it on this part's line, naming the entry.
- Deferring changes only those judgments. Every line this part changes is reviewed as in any PR: a defect in this part's code, a claim its body makes for this part (a test, a refusal, a bound), a design-checklist answer, a repository rule. A finding on this part's code is posted even when the entry it falls under is deferred.

The last part and an Objective in one PR are judged against every entry, never deferred.

## The final message

`{"acceptance": [...], "comments": [...]}`, only JSON, no prose around it.

- `acceptance` has one `{entry, met, path, line, evidence}` per acceptance entry of the issue, plus `"deferred": true` on an entry deferred to a later part ("Split parts").
- `comments` holds `{path, line, entry, body}` and may be empty, but every entry not met and not deferred has one.

## SDK first

The factory-implement-split skill has the worker use the official SDK or a maintained library for a protocol, a file format, a codec or a provider's API, and write that code by hand only when none fits (no library, a licence that does not fit, an unwanted install script or native binary, byte-for-byte deterministic output), naming the choice or the reason under Assumptions. Hand-written code of that kind is a finding, citing that rule, when neither the PR body's Assumptions nor a repository decision names the SDK or library it uses or why none fits.
