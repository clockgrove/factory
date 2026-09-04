---
name: director
description: Starts, resumes, or inspects a Factory Objective using the unattended v2 Supervisor, which persists orchestration in GitHub and runs local workers by default until completion or evidenced escalation.
---

# Factory Director

Use this skill when the user asks to start, resume, recover, run, or check a Factory Objective.

Factory v2's Supervisor owns the loop. Do not reproduce scheduling with repeated model turns and do
not mutate GitHub with raw `gh`, REST, or GraphQL calls. The bundled MCP tools are the authorized
surface.

## Choose the execution mode

Collect:

- `owner` and `repo`;
- the Objective issue number;
- an absolute local checkout of that exact repository;
- an optional complete run policy.

If no policy was supplied, use Factory's adaptive local-only default (up to eight workers subject to
measured CPU and memory headroom). Never opt into paid backends or broaden trust on the user's behalf.

Prefer **durable unattended mode** when the user asks Factory to run autonomously, survive chat
disconnects, resume after login/boot, or process work in the background:

1. Call `factory_doctor` for the Objective and report any permanent preflight failure.
2. Call `factory_controller_status` for the checkout. If no repository controller is installed,
   call `factory_controller_install` and then `factory_controller_start` only when the user's request
   authorizes starting unattended execution on this host. Give each lifecycle request a unique,
   stable `requestId`; retry the same action with the same ID after an uncertain response.
3. Call `factory_activate` with the Objective and a unique, stable `requestId`. Pass the complete
   policy when the user supplied one. Omit `baseSha` to let Factory atomically record the current
   default-branch head, or pass the user's explicit 40-character SHA for reproducibility. Activation
   is durable and returns without holding the chat open.
4. Call `factory_status` to confirm the request/controller state. Do not poll it in a model loop;
   later user status requests are separate read-only calls.

Use **foreground mode** for a one-shot interactive run, or when the supported Linux host cannot run
the controller lifecycle. Call `factory_run` once with `untilTerminal: true` and keep the call alive.
It performs the same Supervisor workflow, but its process lifetime remains coupled to the client.
Tell the user when this fallback removes unattended wake/resume behavior; never silently downgrade a
request for durable operation.

For a foreground restart, call `factory_run` the same way. For durable mode, inspect or restart the
repository controller; do not submit a second activation. The recorded run policy wins over a newly
supplied default, and GitHub receipts determine recovery. Do not create replacement issues or
branches manually.

Report the terminal result:

- `completed`: the Objective and all Work Items shipped;
- `cancelled`: the operator requested a fenced stop;
- `escalated`: quote the concrete reason and identify the affected Work Item when present.

If the user asks to stop an active Objective, call `factory_cancel` once. Only the GitHub identity
that activated the run may request cancellation. Do not simulate cancellation by closing issues or
pull requests.

## Status only

Use `factory_status` for a read-only status request. Report its bounded Objective and run state,
Work Item counts and active details, open blockers, attempts, scheduling decisions, burst activity,
and cost totals. If the user asks why work is waiting or what evidence would unblock it, call
`factory_explain` and preserve its stable reason code, gate, evidence, and required action.

Use `factory_replay` only when the user asks to audit or reproduce scheduling. It is read-only: it
reconstructs durable scheduling receipts and can evaluate supplied credential-free admission
snapshots without writing GitHub or launching a worker. Report unavailable observations as
unavailable; do not infer missing provider, token, capacity, cost, or timing values.

Do not activate, install/start a controller, or start `factory_run` unless the user asked to execute
or resume. Controller installation changes local service state; an inspection request alone never
authorizes it.

## Hard boundaries

- A label alone never activates code execution.
- A plugin cannot wake a stopped harness or powered-off host.
- Missing credentials, unsupported branch rules/capabilities, sensitive changes, and exhausted
  budgets are escalation reasons, not invitations to bypass policy.
- The legacy dispatch tools exist only for already-running v1 Copilot work. Do not use them to start
  a v2 Objective.
