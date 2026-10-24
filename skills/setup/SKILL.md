---
name: setup
description: Set up Factory for a target repository, either configuration only or a verified background service that runs a queue of Objectives.
---

# Factory setup

Set up the installed `factory` CLI for one target repository. `factory help` lists the exact options and is the authority over this skill. Never target Factory's own repository: setup refuses it, because Factory never runs on the code that runs it.

Check that the installed CLI and the enabled plugin come from the same release (see the [installation checks](https://github.com/clockgrove/factory/blob/main/README.md#check-the-installation)). Report a mismatch before setup.

## Choose the outcome

- **Configuration only** (`factory setup`): the request says install, configure, or "don't start work". Nothing runs.
- **Background** (`factory setup --background`): the request is to keep running queued Objectives. It needs Linux or WSL with a systemd user manager. Running it is the operator's consent to a service; it grants no provider spending and admits no Objective.

Reuse choices the operator already gave. Ask once, together, for what is missing.

## Gather

- **Target:** the repository `OWNER/NAME`, and an absolute path to a clone of it that Factory owns (not the operator's working copy). The clone's origin must name the repository.
- **Queue:** the GitHub Project node id (`PVT_...`). The Project needs a single-select field `Factory` with the options Queued, Planning, Building, Needs you, Done and Cancelled, plus a number field `Factory order`. Setup checks them and never creates them; creating them is the operator's step (`gh project field-create`).
- **Providers:** `codex` is the default (planner and worker). For Claude or Copilot, add a named provider with `--provider NAME --planner KIND --worker KIND`, and `--default` to make it the default. Ask for the models rather than copying another provider's.
- **Optional:**
  - limits: `--max-active`, `--workers`, `--validations`;
  - delivery: `--delivery regular|native-stack`;
  - the sandbox: `--sandbox-network`, `--package-store`, `--read-only-path`, `--sandbox-env`;
  - final commands: `--required-command`, `--ci-only-command`;
  - worker settings, such as `--codex-network host` or `--claude-model`.

  docs/reference/setup.md#Setup lists every option and the key it sets.

Keep the configuration, credentials and state outside the target checkout. Setup refuses a configuration or state directory inside it.

## Run

```sh
factory setup --repo OWNER/NAME --checkout ABSOLUTE_CLONE --project-id PVT_... [options] --json
factory setup --repo OWNER/NAME --provider claude --planner claude --worker claude [--default] --json
factory setup --repo OWNER/NAME --background [--credential-file NAME=ABSOLUTE_FILE]... --json
```

- **Create:** the first run creates the configuration (mode 0600). A repeat with the same options changes nothing (`changed: []`).
- **Bindings:** setup never changes `--checkout`, `--project-id`, `--field` or `--order-field` once set. A different value is refused, because it would move running Objectives to another target. Report it, and don't work around it.
- **Credential files:** `--credential-file` binds a credential the service loads with systemd LoadCredential: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or a managed worker's credential variable. The file must be absolute, owner-only (0600) and not a link. Never ask for a credential's value in chat.

## Check the result

Decide on the JSON, never the prose.

- `status: "configured"` (exit 0): saved, it loads, and the target and host are ready.
- `status: "blocked"` (exit 1): saved, but something isn't ready.
  - `problems` names the target's problems: the clone's origin, or the Project fields.
  - `readiness.checks` is the checklist. Each check is `ok`, `warn` or `blocked` with its `fix`: the sandbox, PATH tools, provider logins, GitHub access, merge commits and required checks.
  - Give the operator one checklist of every `blocked` item with its fix. Then repeat the same command.
- `status: "refused"` (exit 1): nothing was saved. `problems` says why: a bad value, or a binding conflict.
- **Branch protection:** a `warn` here recommends "require branches to be up to date". Factory never changes repository settings; that's the operator's call.
- **Capacity:** `capacity` compares the configured slots and memory with the host. It is advice only; keep the operator's limits unless they ask to change them.

For `--background`, the report's `status` is:

- `running`: the unit is active and the service holds its lock;
- `starting`: started, but not serving yet; check with `factory setup --check`;
- `blocked`: nothing started; read `problems`, and `setup` when present.

The report also has `warnings`, such as lingering off, which means the service stops at logout.

## Operate the service

```sh
factory setup --repo OWNER/NAME --check      # exit 0 only when running
factory setup --repo OWNER/NAME --stop       # stop it and keep it from starting at login
factory setup --repo OWNER/NAME --uninstall  # remove the unit; configuration and state stay
```

After installing a new release, run `--background` again: it updates the unit and restarts the service. `--check` reports `service.current: false` until you do.

An idle service with an empty queue makes no model calls.

## Queue work

The operator queues an Objective by setting its card's `Factory` field to Queued; `factory run N` does the same and follows it. Only queue Objectives the operator named. Day-to-day operation is the `director` skill.
