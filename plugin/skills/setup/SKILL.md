---
name: setup
description: Set up Factory for a target repository, either configuration only or a verified background service that runs a queue of Objectives. Installs the matching factory CLI first when it is missing or another version.
---

# Factory setup

Set up Factory for one target repository with its `factory` CLI. `factory help` lists the exact options and is the authority over this skill. Never target Factory's own repository: setup refuses it, because Factory never runs on the code that runs it.

## Install the CLI

The CLI must come from the same release as this plugin. Before anything else, run the installer that sits next to this `SKILL.md`, by its absolute path:

```sh
node SKILL_DIRECTORY/install-cli.mjs [--prefix ABSOLUTE_DIR]
```

It reads the version from the plugin's own manifest and keeps a CLI of that version that is already installed. Otherwise it downloads that release's tarball and `SHA256SUMS`, checks the SHA-256 and the build provenance (`gh attestation verify`), and only then installs it with npm, with the Claude and Copilot SDKs. It needs `gh` logged in and the network. Pass `--prefix` only for an installation directory the operator names: absolute, and outside the target repository and any credential, configuration or state root. The default is a directory per version under `~/.local/share/clockgrove-factory` (under `XDG_DATA_HOME` when set), and the launcher `~/.local/share/clockgrove-factory/bin/factory`, which each install points at its own version.

Decide on its JSON:

- `status: "current"` or `"installed"` (exit 0): `cli` is the CLI's absolute path: the launcher (`PREFIX/bin/factory` with `--prefix`), unless a matching CLI was already on PATH. Run it in place of `factory` in every command below. `sdks` says whether the Claude and Copilot SDKs are there; those providers need them.
- `path` not null: the launcher's directory isn't on the operator's PATH, so the `director` skill can't run `factory`. `path` is the line that puts it there; it names no version, so it stays right across releases. Offer to add it to the startup file of the operator's login shell: `~/.profile`, or for bash the first of `~/.bash_profile` and `~/.bash_login` that exists (bash then reads no `~/.profile`), or `~/.zprofile` for zsh. Write the file only on their yes, and never add the line twice:

  ```sh
  grep -qxF 'PATH_LINE' FILE || printf '%s\n' 'PATH_LINE' >> FILE
  ```

  If the file has a line from an earlier setup naming a versioned `clockgrove-factory/X.Y.Z/bin`, offer to replace that line with this one. If they decline, give them the line. It takes effect in new login shells; an agent host started before it still lacks `factory` on its PATH until it restarts, so keep using `cli`.

- `status: "refused"` (exit 1): show the operator `problems` and stop. A release file that fails a check is never installed. Never install another way or skip a check; the README's [manual install](https://github.com/clockgrove/factory/blob/main/README.md#install-the-cli-by-hand) is the operator's fallback.

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
- **Credential files:** `--credential-file` binds a credential the service loads with systemd LoadCredential: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, with Copilot configured `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`, or a managed worker's credential variable. The file must be absolute, owner-only (0600) and not a link. Never ask for a credential's value in chat.
- **Background logins:** the service doesn't keep logins from the setup shell, and `--background` checks readiness without them. Codex needs `codex login` (an API key in the shell doesn't reach the service), GitHub needs `gh auth login`, and a Claude or Copilot token needs `--credential-file`.

## Check the result

Decide on the JSON, never the prose.

- `status: "configured"` (exit 0): saved, it loads, and the target and host are ready.
- `status: "blocked"` (exit 1): saved, but something isn't ready.
  - `problems` names the target's problems: the clone's origin, or the Project fields.
  - `readiness.checks` is the checklist. Each check is `ok`, `warn` or `blocked` with its `fix`: the sandbox, PATH tools, provider logins, GitHub access, merge commits and required checks.
  - Give the operator one checklist of every `blocked` item with its fix. Then repeat the same command.
- `status: "refused"` (exit 1): nothing was saved. `problems` says why: a bad value, or a binding conflict.
- **Installation:** a `warn` named `installation` means another installation serves the repository, and this one's service is refused when it starts. Ask the operator to stop that one (`factory setup --repo OWNER/NAME --stop` on its machine, or stop its `factory serve`). Only if it is gone for good, because its machine is gone or its state was wiped, and the operator says so: run `factory serve --repo OWNER/NAME --take-over` once in the foreground, stop it once it serves, then run `factory setup --repo OWNER/NAME --background`, since the background service can't take over. Then reset the Objectives that were in flight, as in moving the service below.
- **Project:** a service refused because another installation serves another repository on the same Project names that repository. Ask the operator to stop the installation that serves it. Only if it is gone for good, and the operator says so: on a machine set up for that repository, run `factory serve --repo OTHER/NAME --take-over` once in the foreground and stop it once it serves, which frees the Project; then start this one.
- **Branch protection:** a `warn` here recommends "require branches to be up to date". Factory never changes repository settings; that's the operator's call.
- **Capacity:** `capacity` compares the configured slots and memory with the host. It is advice only; keep the operator's limits unless they ask to change them.

For `--background`, the report's `status` is:

- `running`: the unit is active and the service holds its lock;
- `starting`: started, but not serving yet; check with `factory setup --check`;
- `blocked`: nothing started; read `problems`, and `setup` when present. A service refused because another installation serves the repository is the `installation` warn above; one refused for the Project is the Project item above.

The report also has `warnings`, such as lingering off, which means the service stops at logout.

## Operate the service

```sh
factory setup --repo OWNER/NAME --check      # exit 0 only when running
factory setup --repo OWNER/NAME --stop       # stop it and keep it from starting at login
factory setup --repo OWNER/NAME --uninstall  # remove the unit; configuration and state stay
```

After the plugin moves to a new release, run the installer again, then `--background` with the new `cli`: it updates the unit and restarts the service. `--check` reports `service.current: false` until you do.

An idle service with an empty queue makes no model calls.

To move the service to another machine, `--stop` it on the old one, then set up and start it on the new one. Use `factory serve --take-over` only when the old machine is gone or its state was wiped. Then, when the operator asks, run `factory reset N` on the new machine for each Objective that was in flight: until then the new installation doesn't run them.

## Queue work

The operator queues an Objective by setting its card's `Factory` field to Queued, or by asking to run it: `factory run N` queues it and follows it. Only queue Objectives the operator named. Day-to-day operation is the `director` skill.
