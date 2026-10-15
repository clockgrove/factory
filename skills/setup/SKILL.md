---
name: setup
description: Set up Factory for a target repository, either configuration only or a verified background service that runs a queue of Objectives.
---

# Factory setup

Set up the installed Factory CLI for a target repository. `factory help` lists the exact options and is the authority over this skill. Never target Factory's own source, rebuild or archive repositories.

Check the CLI package identity and enabled Factory plugin against the selected release using the [installation checks](https://github.com/clockgrove/factory/blob/main/README.md#cli). A host plugin and CLI can come from different releases. Report a mismatch before setup; use the installed CLI's help for supported commands.

## Choose the outcome

- **Configuration only:** the request says install, configure, or "do not start work". No service.
- **Background:** the request is to keep processing approved work. It needs a Linux or WSL systemd user manager, and the service keeps running after the terminal closes.

Running `setup --background` is the service consent. It grants no provider spending and runs no Objective. Reuse choices the operator already gave. Ask once, together, for what is missing.

## Gather

- GitHub `OWNER/REPO` and the trusted absolute checkout path. Read the target's instructions.
- For background operation, the existing Project, dedicated TEXT metadata and NUMBER order field IDs, and existing control card. Bind them under `queue.project` with explicit managed-field consent and a private-history Git checkpoint destination. Reuse approved bindings; verify access and actual field types. Missing Project/field or archive choices belong to the operator; setup does not create them or infer consent from roadmap cards.
- On a replacement installation with an approved Git archive, use `factory persistence restore` and inspect retained ownership before activation. Restore supplies no provider login, runtime preparation, watch consent or proof that a foreign owner ceased. Never copy native homes or clear a restored hold by editing state.
- Optional: `--concurrency N` (omit it and Factory sizes workers from the host), `--delivery regular|native-stack`, `--network host|off`, and role models with `--planning-model`, `--review-model`, `--worker-model` plus matching `--*-reasoning`.
- For `--planning claude-agent-sdk`, ask for the planning and review models. It uses the operator's `claude auth login`.

A fresh Codex configuration persists these defaults when no model choices are given: planner `gpt-6.1-sol` with `high` reasoning, reviewer `gpt-6.1-sol` with `medium` reasoning, and worker `gpt-6.1-sol` with `medium` reasoning. For explicitly selected Claude planning, both models remain required; planner reasoning defaults to `high` and reviewer reasoning to `medium`. The reviewer setting covers graph, Work Item result and final Objective reviews. Preserve explicit choices and matching existing configurations.

A configuration holds named providers (planning plus execution). New work uses `defaultProvider` unless a command names another with `--provider NAME`; the calling host never switches it. The service runs new work with `defaultProvider` and continues a started Objective on the provider it froze. To add a provider, run setup with `--provider NAME` and that provider's options; other providers stay unchanged. Ask for the models of a new provider rather than copying another's. Verify the selected provider's login and the target toolchain in the controller's non-login shell; configuration-only setup does not establish worker readiness.

Use the host's supported ordinary-host execution route for the controller. Codex may inject private runtime aliases into PATH: follow the [controller PATH guidance](https://github.com/clockgrove/factory/blob/main/README.md#controller-path-in-an-agent-host), bind the complete reviewed literal PATH and verified absolute CLI after shell startup, and preserve that environment for subsequent commands. Include all selected project and validation tools; never append inherited `$PATH`, mount credential roots or weaken worker isolation to get past a PATH or socket error.

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
- `starting`: the start request succeeded and the exact live service is still awaiting authenticated ownership. Preserve it and inspect `factory supervisor check`; ownership and fresh remote queue authorization are not yet verified. Repeat the approved setup verification once the owner is ready.
- `ready`: the service is active and its owner verified. Report the binding, the poll interval (`queue.pollSeconds`, default 30), the queued IDs or idle reason, and that sleep pauses and shutdown stops the service.
- `blocked`: collect all available readiness stages, retained findings and source-verified prerequisites, not just the first error. Give one concise checklist of what is missing or unknown, why it is needed, its source, supported setup step and verification command. Unchecked stages stay unknown. Ask for required operator choices together; reuse answers already given. Fix verified prerequisites and repeat the same approved command. Never remove completed stages to get past a stop.

For local execution, report `capacityRecommendation`: measured cores/memory, coding workers, validation/review ceilings and per-phase reservations. Compare it with the effective `capacity`; explicit overrides and recorded Objective limits stay fixed. A host recommendation grants no additional provider usage or spending. Keep existing limits unless the operator authorizes a change.

Name the approved secret store or private credential file for each required secret; never ask for its value in chat or issues. A checklist is guidance, not authority to create accounts, activate a service, spend, deploy or admit work. Continue independent work only if already authorized and current gates permit it. The `director` skill describes the same prerequisite flow for a stopped Objective.

An idle service with an empty queue makes no model calls.

## Queue work

Only for Objectives the operator named:

```sh
factory queue add N [N ...]
```

They run one at a time, in Project order, within the [autonomy limits](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#autonomy-limits). Labels and roadmap cards never select an Objective. Manage the queue with `factory queue list|sync|remove N|pause|resume|drain` and the service with `factory supervisor start|check|stop [--disable]|upgrade --cli ABSOLUTE_INSTALLED_CLI|uninstall`. Queue changes have one sixty-second deadline through durable completion. Local status retains its one-second deadline; the local pause acknowledgment targets a one-second response. The pause acknowledgment does not prove remote completion or worker cessation. List/sync observe current Project data; they grant no authority or mutation replay. Preserve a timed-out operation identity and inspect its recorded outcome before any further action; never repeat an uncertain mutation. Legacy local queue files are ignored and preserved, never automatically imported or reapproved. Restored Git receipts do not activate a service or prove foreign ownership settled. Day-to-day operation is the `director` skill.
