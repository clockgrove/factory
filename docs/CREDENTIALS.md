# Credentials and environments

## What v1 accumulated

| Environment | Contents |
|---|---|
| `copilot` | empty |
| `copilot-initial-assignment` | empty |
| `copilot-initial-model` | `COPILOT_GITHUB_TOKEN` |
| `factory-qualification-consumer` | `FACTORY_CONTROLLER_READ_TOKEN` |

Four environments, two credentials, two empty shells.

## Why this happened

GitHub environments are a **deployment** primitive. They exist to gate a job behind approvals or
branch restrictions and to scope secrets to a deployment target. They answer *"may this job run, and
what may it see?"*

v1 used them as a **configuration lookup keyed by workflow phase**. The names give it away:
`-initial-assignment` and `-initial-model` are steps in a dispatch sequence, not trust boundaries.
Two of them never held anything at all — created speculatively, then abandoned.

This is not an isolated tidiness problem. It is the fossil record of Inversion B (PRD §3). v1 was
trying to pin a model and shape a session per dispatch, which finding F1 says GitHub Agent Tasks
does not support. Unable to get per-session control through the API, v1 reached for the nearest
primitive that *looked* like scoped configuration and bent it into that shape. The environment
sprawl is what an unsupported requirement looks like after it has been routed around.

The correct count of environments is the number of distinct **trust boundaries**, not the number of
steps in a process.

## v2 policy

One rule:

> An environment exists only to separate a credential that must not be visible to the rest of the
> repository. Never to select behavior, pin a model, or mark a phase.

Behavior selection belongs in configuration that is visible in the repository and reviewable in a
diff. A secret store is a bad configuration file: invisible, unversioned, and unreviewable.

Applying that rule, v2's environment requirements mostly vanish as a consequence of decisions
already taken:

| v1 environment | v2 |
|---|---|
| `copilot` | **Keep if needed.** GitHub's Copilot coding agent reads runtime configuration from an environment of this name; it is platform convention, not a Factory invention. Create it only when there is something to put in it. |
| `copilot-initial-assignment` | **Gone.** No phase-keyed configuration. |
| `copilot-initial-model` | **Gone.** PRD §6 accepts F1 and drops per-session model pinning outright. |
| `factory-qualification-consumer` | **Gone.** `factory-controller` is discarded (PRD §11). |

**Target: zero Factory-created environments.** The core loop runs in the harness with the operator's
own credentials and needs no repository secrets at all. If Factory ever appears to need one, that is
a finding to record against the thesis, not a task to complete.

## Consequence for adopters

An adopter installs a plugin and authors an Objective. They should not have to provision
environments, secrets, or tokens to make the loop run. Anything they must configure before first use
is a portability defect, and the requirement in PRD §9 — that installation grants no workflow,
settings, secret, or activation authority — depends on holding this line.
