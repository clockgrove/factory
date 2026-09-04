---
name: director
description: Starts, resumes, or inspects a Factory Objective using the unattended v2 Supervisor, which persists orchestration in GitHub and runs local workers by default until completion or evidenced escalation.
---

# Factory Director

Use this skill when the user asks to start, resume, recover, run, or check a Factory Objective.

Factory v2's Supervisor owns the loop. Do not reproduce scheduling with repeated model turns and do
not mutate GitHub with raw `gh`, REST, or GraphQL calls. The bundled MCP tools are the authorized
surface.

## Start or resume

Collect:

- `owner` and `repo`;
- the Objective issue number;
- an absolute local checkout of that exact repository;
- an optional complete run policy.

If no policy was supplied, use Factory's adaptive local-only default (up to eight workers subject to
measured CPU and memory headroom). Never opt into paid backends or broaden trust on the user's behalf.

Call `factory_run` once with `untilTerminal: true`. Keep the call alive. It performs preflight,
records/resumes the run, acquires the fenced GitHub lease, compiles and applies the graph, schedules
ready Work Items, runs workers, validates, reviews, publishes, merges, retries, and closes the
Objective. Its unchanged-state polling is model-free.

On restart, call `factory_run` the same way. The recorded run policy wins over a newly supplied
default; GitHub receipts determine recovery. Do not create replacement issues or branches manually.

Report the terminal result:

- `completed`: the Objective and all Work Items shipped;
- `cancelled`: the operator requested a fenced stop;
- `escalated`: quote the concrete reason and identify the affected Work Item when present.

If the user asks to stop an active Objective, call `factory_cancel` once. Only the GitHub identity
that activated the run may request cancellation. Do not simulate cancellation by closing issues or
pull requests.

## Status only

Use `read_objective` for a read-only status request. Report the Objective, each Work Item's derived
state, open blockers, attempts, and any explicit escalation reason. Do not start `factory_run` unless
the user asked to execute or resume.

## Hard boundaries

- A label alone never activates code execution.
- A plugin cannot wake a stopped harness or powered-off host.
- Missing credentials, unsupported branch rules/capabilities, sensitive changes, and exhausted
  budgets are escalation reasons, not invitations to bypass policy.
- The legacy dispatch tools exist only for already-running v1 Copilot work. Do not use them to start
  a v2 Objective.
