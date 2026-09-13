# Maintaining Factory

This guide covers maintainer scheduling and live-test fixture procedures. Start with
[CONTRIBUTING.md](../CONTRIBUTING.md) for development setup, checks, and submitting a change.
[AGENTS.md](../AGENTS.md) defines agent review and integration rules;
[release verification](CONFORMANCE.md#release-verification-procedure) covers release candidates.

## Tracking work

Use the [Factory Project](https://github.com/orgs/clockgrove/projects/1) for scheduling and progress.
The Backlog view contains open work; the Now board shows the small set currently selected.
Issues describe a concrete problem, scope, acceptance and evidence. Link implementation PRs to
their issues. Use native issue dependencies for actual blockers and describe the clearing condition
in the issue. A shared topic or possible future benefit is not a dependency.

| Field | Meaning |
| --- | --- |
| Status | Backlog: unselected; Ready: selected next; In Progress: actively owned; Blocked: selected work waiting on a concrete prerequisite; Deferred: intentionally outside current work; Done: issue acceptance met and issue closed. |
| Priority | Now: current committed work; Next: selected follow-on work; Later: unselected or deferred. |
| Milestone | Use the native issue milestone only for a real delivery target. Do not invent release dates or create a duplicate Project field. |

Add a work issue to the Project once. Update fields at meaningful transitions, including when a PR
closes its issue; do not maintain a separate written status summary. Project membership is not
permission to start unselected work. Closing an implementation issue does not imply broad installed
qualification: put any remaining required scenario in a concrete linked issue before closing.
Assignees identify people actually owning work; do not invent agent identities or owner fields.

The former #69 summary is historical. Bounded parent issues may group a coherent feature, but must
not become another project-wide backlog. Repository documents describe contracts and procedures;
PRs and issues retain checks and relevant evidence. Publication is deferred in #88 until a release
is selected; #89 verifies its published artifacts afterward.

Use GitHub's native UI/API for updates. No polling controller, custom synchronization workflow,
second database or new tracking service is needed. If Project permissions are missing, continue
authorized work and report the specific pending update. Maintainers using `gh` need the `project`
scope for writes; request it with `gh auth refresh -h github.com -s project` when needed.

## Retire qualification fixtures

Include the disposable repository and local checkout's retirement owner and authorization in the
smoke plan. Finish every smoke with the [fixture retirement checklist](LIVE-OBJECTIVE-HARNESS.md#fixture-retirement):
record deletion, or a specific retention reason and expiry/review trigger. Preserve private evidence
before disposal, and keep fixtures needed by concurrent tasks or unresolved accounting. Worker
cleanup and a closed Objective do not by themselves authorize or prove repository retirement.

