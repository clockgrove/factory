---
name: setup
description: Set up Factory for a target repository, either configuration only or a verified background service that runs a queue of Objectives.
---

# Factory setup

Set up the installed Factory CLI for a target repository. `factory help` lists the exact options and is the authority over this skill. Never target Factory's own source, rebuild or archive repositories.

## Choose the outcome

- **Configuration only:** the request says install, configure, or "do not start work". No service.
- **Background:** the request is to keep processing approved work. It needs a Linux or WSL systemd user manager, and the service keeps running after the terminal closes.

Running `setup --background` is the service consent. It grants no provider spending and runs no Objective. Reuse choices the operator already gave. Ask once, together, for what is missing.

## Gather

- GitHub `OWNER/REPO` and the trusted absolute checkout path. Read the target's instructions.
- Optional: `--concurrency N` (omit it and Factory sizes workers from the host), `--delivery regular|native-stack`, `--network host|off`, and role models with `--planning-model`, `--review-model`, `--worker-model` plus matching `--*-reasoning`.
- For `--planning claude-agent-sdk`, ask for the planning and review models. It uses the operator's `claude auth login`.

A fresh configuration persists these defaults when no model choices are given: planner `gpt-5.6-sol` with `medium` reasoning, reviewer `gpt-5.6-sol` with `medium` reasoning, and worker `gpt-5.6-luna` with `medium` reasoning.

Keep configuration, credentials and state outside the target repository. Reuse a matching existing configuration. If the binding conflicts, report it and stop, because deleting state or choosing another root hides the conflict.

## Run

```sh
factory setup --config-only --repository OWNER/REPO --checkout ABSOLUTE_PATH [--config PATH]
factory setup --background --repository OWNER/REPO --checkout ABSOLUTE_PATH [--config PATH]
```

Use exactly one. For a matching existing configuration, leave out the options it already binds. Background setup also runs the model-free readiness checks. Pass `--outside-directory ABSOLUTE_EXISTING_DIRECTORY` if home is inside the checkout or writable by the worker. A service takes provider credentials only as `--credential-file NAME=ABSOLUTE_PRIVATE_FILE`, one per credential.

## Check the result

The command prints JSON and sets its exit status.

- `configured`: configuration-only setup is finished.
- `ready`: the service is active and its owner verified. Report the binding, the poll interval (`queue.pollSeconds`, default 30), the queued IDs or idle reason, and that sleep pauses and shutdown stops the service.
- `blocked`: names the failed stage. Fix the stated prerequisite and repeat the same command. Never remove completed stages to get past it.

An idle service with an empty queue makes no model calls.

## Queue work

Only for Objectives the operator named:

```sh
factory queue add N [N ...]
```

They run one at a time, in the order added, within the [autonomy limits](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#autonomy-limits). Labels and discovery never select an Objective. Manage the queue with `factory queue list|remove N|pause|resume|drain` and the service with `factory supervisor start|stop [--disable]|upgrade --cli ABSOLUTE_INSTALLED_CLI|uninstall`. Day-to-day operation is the `director` skill.
