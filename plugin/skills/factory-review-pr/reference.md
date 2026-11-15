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

## Foundation review

Only when the prompt says this is the foundation pass: the Objective is labelled `factory:foundation`, so later work builds on what it adds. Another pass reviews the rest of the PR and judges the acceptance entries; this one returns comments only.

A shared contract is what other code builds on: an exported function, class or constant; a type, schema or config key; an error code or error table; a CLI command, flag or exit code; a file, wire or event format; a test fixture or helper other tests import. For each one the diff adds or changes, find its callers and readers in the checkout (`git grep`, the tests included, and those the diff adds), then check:

- Every value the contract can produce (an error code, a status, an enum member, a field) reaches the caller meant to handle it, and every value a caller, a doc or the issue expects is one the contract can produce. A mapping that folds new codes into an old one, so the new ones never reach the result, is a finding.
- Each caller passes and reads what the changed signature, field names, types, defaults and units now say; nothing still uses a removed or renamed name.
- The contract's docs, schema and help text say what the code does.
- A shared test fixture or helper isolates what a test touches: home, state, config, cache and temp directories inside the test's own temp root; variables that redirect I/O (`HOME`, `XDG_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, tokens) set or cleared; no network the repository's testing guide does not allow; its files removed after. One that could read or write the developer's real state is a finding.

Each finding is a comment on the new-side line of the contract or fixture, naming the caller's `path:line`, its body starting `foundation review:`, and its `entry` the acceptance entry it falls under, else `foundation`. Skip a finding the PR body answers, as in any pass; general findings are the other pass's.

## Workflow hand-over

Factory never pushes a change under `.github/workflows/`; the worker hands one over, and Factory posts it in its comment on the issue for a person to apply after the merge. The prompt gives it under `## Workflow hand-over`. That patch is part of the change: review it like the diff, against the acceptance entries and the repository's rules, and check each workflow it adds or changes for what it can run and reach: its triggers (`push`, `pull_request_target`, `workflow_run`), its `permissions:`, every secret it uses, third-party actions not pinned to a full commit SHA, and any checkout of pull-request head code (under `pull_request_target` or `workflow_run` that runs untrusted code with the repository's token and secrets). A finding on it names the workflow file as `path` and the patch's new-side line as `line`; Factory moves it onto the diff with a note naming where it is. Each workflow change the body's Undone names and the patch lacks, or the patch makes and Undone does not explain, is a finding too. Never ask for the workflow change to be committed instead.

## The final message

`{"acceptance": [...], "comments": [...]}`, only JSON, no prose around it.

- `acceptance` has one `{entry, met, path, line, evidence}` per acceptance entry of the issue, plus `"deferred": true` on an entry deferred to a later part ("Split parts").
- `comments` holds `{path, line, entry, body}` and may be empty, but every entry not met and not deferred has one.
- The foundation pass ("Foundation review") answers `{"comments": [...]}` only.

## SDK first

The factory-implement-split skill has the worker use the official SDK or a maintained library for a protocol, a file format, a codec or a provider's API, and write that code by hand only when none fits (no library, a licence that does not fit, an unwanted install script or native binary, byte-for-byte deterministic output), naming the choice or the reason under Assumptions. Hand-written code of that kind is a finding, citing that rule, when neither the PR body's Assumptions nor a repository decision names the SDK or library it uses or why none fits.
