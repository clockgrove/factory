# Shared runner configuration reference

[Setup home](README.md) · [Local quick start](local.md)

## TL;DR

- Select a repository with explicit Factory arguments; put credentials in the executing Linux
  process's environment, not the repo or plugin manifest.
- A plugin MCP process and an unattended controller are separate processes. Configure both when needed.
- Credentials are not spending permission. Paid policy, controller capacity, and validation gates
  must also permit the work.
- Start with a read-only backend probe. Do not launch a paid worker just to test a key.

Use the [runner guides](README.md) for a task-oriented setup. This page preserves the full shared
contract and troubleshooting detail. Configuration documentation is not proof of live conformance.

## 1. Identify the process that will execute the Objective

The plugin and npm package are alternative entry points to the same Factory runtime, not separate
products and not a required installation sequence. The plugin contains the bundled MCP server and
controller executable. It does **not** require `npm install -g` or `npx` to run that bundle. Conversely,
installing the npm CLI does not install chat skills into your agent client. `npx` is not a background
scheduler or a credential store, and nothing about provider configuration requires it.

| Execution mode | Process that needs the credentials | How the target repo is selected | Lifetime |
|---|---|---|---|
| Plugin, one-shot `factory_run` | Factory's MCP server, launched by the agent client | Explicit `owner`, `repo`, Objective number, and absolute checkout path | Coupled to that MCP/client process |
| Plugin, durable `factory_activate` | The separately installed repository controller; the MCP process also needs its own GitHub access and credentials for any probes it performs | Activation names the GitHub Objective; the controller is bound to `OWNER/REPO` and an absolute checkout | Independent of chat while the controller/host is running |
| Foreground CLI | The shell-launched `factory` process, or `node .../dist/factory.js` | CLI target plus `--repo /absolute/checkout` | Coupled to that foreground process |
| Unattended Linux service | The systemd **user service** running the repository controller | Recorded service command and working directory | Restarted according to the installed service policy |

Running your agent in a repo is convenient context; it is not a credential configuration mechanism.
For Factory execution, name both the GitHub repo/Objective and its corresponding absolute checkout.
Do not rely on an MCP server's implicit working directory to choose the intended repository.

Keep the runtime, checkout, login files, and provider settings inside Linux. In WSL2, use Linux paths
such as `/home/you/src/project`, not `/mnt/c/...`. A Windows app, its integrated terminal, and a WSL
service are not automatically the same environment. Exporting a variable in one does not update the
others. If a client cannot launch Factory inside the supported Linux environment, changing a repo
path or setting Windows environment variables does not make native Windows execution supported.

## 2. Put each setting in the correct place

| Setting | Where it belongs | Where it does **not** belong |
|---|---|---|
| Target repo and checkout | Factory tool arguments or controller/CLI arguments | A provider API key or sandbox setting |
| GitHub authentication | Factory host process environment, or the same Linux user's existing `gh` login | Worker packets, issue bodies, or sandbox GitHub write credentials |
| Local agent login | The Linux user's local Codex authentication, readable by Factory | Daytona's model Secret or a GitHub-managed agent session |
| Sandbox API credentials | Environment of the Factory process that will call that provider | Target repo files, GitHub issue comments, or the plugin's committed manifest |
| Daytona worker model key | A Daytona organization Secret; the host receives only its configured **name** | The value of `FACTORY_DAYTONA_MODEL_SECRET` or a repo `.env` |
| Provider account/repository enablement | The provider/GitHub account and target repo's integration settings | Merely adding a backend ID to Factory policy |
| Backend selection, budgets, burst rules | The explicitly accepted Objective run policy, plus controller capacity ceilings | Credential files as an implicit authorization to spend |

Factory does **not** automatically load a repo `.env`, `.env.local`, a user `providers.env`, or shell
startup files. A file is only effective if a launcher or service explicitly loads it into the correct
process environment. A `.env` file ignored by Git is still not automatically loaded or safely isolated.
GitHub Actions secrets are not delivered to your local Factory process; Factory requires no workflow.
Do not edit a plugin cache or manifest to embed secrets: updates can replace the cache, and manifests
are distributable files.

## 3. Configure the chosen provider, not every provider

All rows below also require host GitHub authentication and the local management backend. Choosing a
remote implementation worker does not move Objective compilation and semantic management into that
provider or eliminate the local management requirements.

| Backend | What the Factory host must have | Additional setup and boundaries |
|---|---|---|
| GitHub control plane, every mode | `GITHUB_TOKEN`, otherwise `GH_TOKEN`, otherwise the same user's `gh auth` session | Identity must have the required access to the exact public or private repo. An inaccessible repo is not fixed by changing its visibility. |
| `codex-sdk/local-worktree` (default) and `codex-cli/local-worktree` (fallback) | Compatible Codex executable and existing Linux Codex login | Plugin users supply `codex` on the launching process's `PATH`; the npm artifact supplies its pinned CLI transitively. Factory resolves login from an absolute `CODEX_HOME` when set, otherwise the user's `.codex` directory. No sandbox API key is required. |
| `codex-cli/daytona` | `DAYTONA_API_KEY` and `FACTORY_DAYTONA_MODEL_SECRET` | The latter is a **Secret name**, not a key. In the selected Daytona organization, create that model-key Secret with `hosts` exactly `["api.openai.com"]`. Factory requires one exact-name match and rejects empty, wildcard, or additional hosts. A local Codex subscription login is not substituted for this sandbox API credential. |
| `codex-cli/vercel-sandbox` (Labs) | `VERCEL_OIDC_TOKEN` and `OPENAI_API_KEY` | Both must reach the executing Factory process. This adapter does not reuse the Daytona Secret name. Vercel's request transformation supplies the model Authorization header; the worker receives a placeholder. Renew expired provider authentication and restart affected Factory processes. |
| `github-copilot/github-managed` | Factory's GitHub identity, with the coding-agent integration enabled and assignable in the target repo | Authorize managed sessions explicitly. No local Copilot model-key variable connects this integration. Provider sessions may also consume GitHub Actions minutes. |
| `openai-codex/github-managed` | Factory's GitHub identity and the corresponding enabled GitHub integration | Bundled profile remains unavailable until its live identity gate supplies a stable provider-published identity. Setting `OPENAI_API_KEY`, renaming an actor, or having a local Codex login cannot bypass that gate. |
| `codex-app-server/local-worktree` (Labs) | Compatible local Codex executable and the existing Linux Codex login | A local protocol adapter, not a hosted Factory service and not the GitHub-managed Codex agent. No Daytona/Vercel credential is needed. |

The Daytona adapter also recognizes its SDK JWT/organization credential pair; the API-key setup
above is the straightforward documented path. See [credential boundaries](../CREDENTIALS.md) for
the exact adapter behavior. Provider authentication and independently isolated validation are
separate requirements: a managed worker's credentials do not automatically supply an authorized
validator or its budget. Factory must resolve both before admission.

Worker access is deliberately narrower than host access. Factory does not forward its GitHub write
credential to a sandbox, nor arbitrary host secrets to workers. Factory does not support generic
application-secret injection just because a Work Item names a secret. Never solve a missing worker
credential by pasting the value into an Objective, Work Item, prompt, or log.

## 4. Foreground/plugin setup: configure the parent before launching it

For a Linux agent client launched from Bash, set the needed variables in **that shell before starting
the client**. Its Factory MCP child can then inherit them, subject to the client's environment
filtering. For a direct Factory CLI invocation, set them before launching that CLI instead.

For example, these prompts avoid putting a literal Daytona API key into shell history:

```bash
read -r -s -p 'Daytona API key: ' DAYTONA_API_KEY
printf '\n'
export DAYTONA_API_KEY
read -r -p 'Daytona organization model Secret name: ' FACTORY_DAYTONA_MODEL_SECRET
export FACTORY_DAYTONA_MODEL_SECRET
cd /absolute/path/to/your/checkout
codex
```

This example launches the **agent client**, not a Factory controller, and authorizes no paid run.
If the client was already open, changing terminal exports does not change its environment: relaunch
the actual client/MCP host from the configured environment. Starting a new chat alone is not proof
that an existing MCP process received new variables. A desktop client's terminal is not necessarily
the parent of its MCP server. Use the client's supported process-environment configuration when it
is not shell-launched; do not assume a universal GUI setting or automatic repo `.env` integration.

On WSL, check whether `CODEX_HOME` intentionally points to the desired Linux login and installation.
If a Windows launcher injected a Windows-mounted Codex home unintentionally, correct the launcher
environment before starting the Linux client. Do not unset a deliberate custom Linux home blindly.
Authentication in a Windows Codex installation is not evidence that the Linux service can read it.

Use the equivalent provider variables from the table for other adapters. Do not configure every
provider merely to silence optional-provider warnings. Never paste real keys into chat for an agent
to insert; enter them through your own terminal, editor, or credential manager.


## 6. Authorize capacity and spending separately

Successful authentication means Factory can inspect the provider. It does **not** mean Factory may
launch a paid worker. For sandbox burst, check all of the following:

- The complete accepted run policy includes the exact backend ID in `backendOrder` and
  `allowedPaidBackends`, has `cloudFallback: "explicit"`, and sets a nonzero `maxSandboxMinutes`.
- Actual overflow burst additionally needs an enabled `burst.mode`, that backend in
  `burst.backendOrder`, and explicit cloud concurrency/trigger limits. Leaving `burst.mode` at
  `never` does not enable local-to-cloud overflow merely because credentials exist.
- GitHub-managed execution needs a nonzero `maxManagedAgentSessions` and its own explicit backend
  authorization. Independent validation must also fit an available, authorized backend and budget.
- When `economics` is present, its sandbox/session limits must agree with the corresponding
  top-level limits. Model-token accounting is a separate observed-usage threshold, not a cloud
  spending authorization or hard provider cap.
- The **repository controller** must have paid capacity. Its default is `--max-paid-workers 0`.
  The generated service command uses that default; environment variables do not raise it. To permit
  a chosen ceiling, explicitly configure the controller's `controller run` command with
  `--max-paid-workers N`. For a systemd override, preserve the installed absolute executable,
  repository, checkout, and other limits; clear `ExecStart=` before supplying the replacement
  `ExecStart=`. Do not launch a second controller merely to work around the existing one's ceiling.
- The policy must permit required provider/bootstrap/model network destinations, trust boundaries,
  and validation resources. Provider-side spending limits remain important, especially if the host
  loses connectivity. Sandbox workers and fresh validators consume separate resource reservations.

For clarity, a paid-capacity service drop-in has the following **template** shape. Replace every
path and repository placeholder with the exact existing service values, preserve any other command
options, and choose the ceiling deliberately. The example ceiling of one is not a recommendation
or permission to spend; the separate run policy is still required.

```ini
[Service]
EnvironmentFile=%h/.config/clockgrove-factory/providers.env
ExecStart=
ExecStart=/absolute/path/to/node /absolute/installed/plugin/dist/factory.js controller run OWNER/REPO --repo /absolute/checkout --max-paid-workers 1
```

Use systemd quoting when real paths contain spaces. Apply this to the same exact unit, then follow
the [drain/reload/restart procedure](unattended.md#detailed-service-configuration). Do not overwrite the generated unit with this partial
drop-in or store it in the target repository as if Factory would discover it there.

Have the agent present the complete policy and intended ceilings for approval; do not copy a
credential example as if it were a complete paid-execution policy. Resuming an existing run preserves
its recorded policy. New defaults or edited local files do not silently widen that run's authority.
See [Policy and paid backends](../../README.md#policy-and-paid-backends) for the policy fields and defaults.


## 7. Verify the same environment that will do the work

Start with read-only checks; do not use a billable launch as your first credential test:

1. Through the plugin, ask for `probe_execution_backends` with the absolute checkout path. For a
   direct CLI process, run `factory backends probe`, or
   `node /absolute/installed/plugin/dist/factory.js backends probe`. These probes create no workers
   or sandboxes. They can contact provider metadata APIs and report missing authentication.
2. Read the specific backend's reported availability, authentication, and reason. A successful
   process exit is not proof that every optional provider is ready. Daytona also checks the named
   Secret's metadata; the generic probe does not establish repository-specific managed-agent
   availability or prove a future billable launch will succeed.
3. Ask for `factory_doctor` for the exact Objective and `factory_controller_status` for its checkout.
   Inspect `factory_status`/`factory_explain` for recorded gates once work has been activated. These
   are complementary checks, not a replacement for provider and execution-time preflight.
4. A shell or MCP probe proves only **that process's** environment. It does not inspect the live
   systemd controller's secret values. Separately verify the correct service user, environment-file
   attachment, executable paths, restart, and controller diagnostics. Never print the complete
   environment, `auth.json`, provider file, or token values to prove configuration.
5. Only after those checks, explicitly approve a bounded smoke Objective in an appropriate test
   repo. Check execution, independent validation, publication, and resource cleanup—not just sandbox
   creation. Passing a probe is not end-to-end provider conformance.

| Symptom | Check first |
|---|---|
| Repo `.env` contains keys, but provider is unavailable | Factory does not auto-load it. Configure the actual launching process or service. |
| Shell probe succeeds, chat probe fails | The client/MCP host was launched elsewhere, predates the export, or filters variables. |
| Chat probe succeeds, unattended work cannot authenticate | The separate controller needs its own environment-file wiring, tool paths, login access, and restart. |
| Daytona key exists, but model Secret probe fails | Correct organization, exact Secret **name**, unique match, and `hosts` exactly `["api.openai.com"]`; not the model key as the name. |
| Local Codex works, Daytona worker cannot authenticate | Local subscription authentication is not Daytona's separately brokered model API key. |
| Provider authenticates, but no cloud worker starts | Paid backend authorization, burst trigger, native budgets, validator availability, and controller paid ceiling. |
| GitHub control works, managed agent remains unavailable | Repository integration/assignability and the bundled provider identity gate, not another model-key export. |
| Keys were rotated, but failures continue | Restart the correct process after updating its source; a different terminal or new chat may leave the old process untouched. |
| Setup works until login/reboot/plugin upgrade | Verify Linux host startup, user service state, persistent environment attachment, tool paths, and pinned installed executable. |

For any future provider, apply the same sequence: identify the executing process, configure only
that adapter's documented credentials, enable required account/repo capabilities, verify without
launching, authorize explicit cost/capacity, and then run bounded live conformance. Do not assume
another provider's variables, local login, or secrets mechanism are interchangeable.
