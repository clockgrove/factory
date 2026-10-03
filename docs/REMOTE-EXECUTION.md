# Remote execution

Remote execution runs a Work Item's implementation away from the controller host. Planning, review, validation and delivery stay on the controller. There are two kinds:

- **Managed agent** (`execution.kind: "managed-agent"`): a provider-hosted agent session does the work. Providers: `claude-managed-agents` and `openai-agents`.
- **Sandbox** (`execution.kind: "sandbox"`): Factory runs your registered harness inside a provider sandbox. Provider: the built-in `daytona`, or your own `SandboxProvider`. The installed `factory` CLI wires only Daytona; a custom provider needs your own controller built with `composeWithSandbox`.

All are development candidates. Credential-free tests cover them, but no live run has qualified them yet.

## Before you start

Installing Factory grants no provider or spending authority. First approve the source that leaves the host (the pinned base plus declared and selected assets), the provider account, model, data handling and spending limit. Then edit the `execution` object in your installation config and use the normal `factory` commands.

## What every provider shares

- **Managed input:** Factory sends the exact base commit as a shallow snapshot, without history or local Git config. Only regular files and executable bits are supported. Symlinks and submodules are rejected before a session is created.
- **Sandbox input:** the provider creates the sandbox, then fetches the published base commit inside it. Private inputs and selected assets travel in a verified archive.
- **Output:** file bytes with a path, mode, size and SHA-256 inventory. Claude returns a JSON snapshot with base64 file bodies; OpenAI returns a tar artifact; sandboxes return a binary archive. Factory rejects unsafe paths and mismatches, then applies the same checks, review and delivery as local work.
- **Worker policy:** managed agents need `policy.network: "off"` and an empty `policy.allowedSecretNames`. The controller still needs network access to the provider and GitHub.
- **Concurrency:** `execution.concurrency` is Factory's limit, not provider capacity.
- **Usage:** missing usage is unknown, never zero. Token counts are not a bill.

## Lifecycle and recovery

Factory checkpoints each step in the Work Item snapshot before calling the provider, and attaches the attempt ID where the provider allows it. When a response is lost in transit (network error, timeout, HTTP 408, 429 or 5xx), Factory checks the recorded step against the provider:

- if the step happened, continue;
- if it never happened, send it again;
- otherwise end the attempt and repeat the Work Item with a fresh attempt.

|                   | Claude                                                                                           | OpenAI                                                                                                               | Sandbox                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Attempt tag       | Session metadata `factory_attempt`, listable. Uploads are untagged.                              | Session metadata `factory_attempt`, not listable.                                                                    | Provider `create` and `find` use it; Daytona labels `factory-attempt`. |
| Create lost       | Adopt the tagged session created since submission, or create one.                                | End the attempt and start fresh.                                                                                     | `create` adopts the sandbox `find` returns.                            |
| Input lost        | Continue if history has the exact message; resend if idle with no new message; else start fresh. | Continue if a turn is recorded; else delete the session and start fresh. A restart during setup waits, then submits. | Preparation and harness start cannot repeat: destroy and start fresh.  |
| Other lost        | Upload: upload again.                                                                            | —                                                                                                                    | Observe and collect only read: invoke again.                           |
| Cleanup           | Every tagged session (which removes its sandbox), then the uploads.                              | The session, then confirm the environment is gone.                                                                   | The sandbox.                                                           |
| `possible-orphan` | Lost upload: delete uploaded files from that time that no session references.                    | Lost create: delete sessions with `factory_attempt=<attempt ID>`; they hold the input archive.                       | —                                                                      |

Collection retries transient failures in place for up to two minutes, then interrupts the step; the next pass reattaches to the same resource.

Any other failure stops the remote resource first, then fails the attempt as an implementation failure, so it gets a fresh attempt or a repair. This covers a refused request, a resource that no longer exists, a rejected result, a harness that ends without a result, and a passed deadline. A repeated attempt never runs beside the old one.

- **Deadline:** the managed `timeoutSeconds` bounds the whole attempt. Each cleanup gets a fresh window of the same length, so cleanup still runs after an outage.
- **Cleanup** runs after success and on cancel, and confirms each deletion. A failed or unconfirmed deletion stays visible and is retried on restart.
- **Possible orphans** are recorded in `factory diagnostics` with the attempt ID and time; delete them by hand as the table says.

## Controller credentials

Each provider config names an environment variable holding the controller's API key. The key never enters the config, model input or sandbox, and local CLI logins do not supply it.

- **Foreground:** set the variable in the controller shell. `factory readiness --config /absolute/config.json` checks that it is present. It makes no provider call, so it does not verify account access, billing or hosted support.
- **Background service:** put only the key in a `0600` file outside the target checkout and install with `factory supervisor install ... --credential-file NAME=/absolute/private/file`, one per credential. This uses systemd `LoadCredential`, so it needs a Linux user systemd. The key is read at service start; restart to rotate it. A missing key stops execution, with no fallback to ambient variables.

## Claude Managed Agents

Runs the Work Item in an Anthropic Managed Agents session (`@anthropic-ai/sdk` 0.129.0, beta `managed-agents-2026-04-01`).

```json
{
  "kind": "managed-agent",
  "provider": "claude-managed-agents",
  "concurrency": 1,
  "config": {
    "agentId": "AGENT_ID",
    "agentVersion": 3,
    "environmentId": "ENVIRONMENT_ID",
    "workspaceId": "WORKSPACE_ID",
    "credentialEnv": "FACTORY_ANTHROPIC_API_KEY",
    "agent": { "...": "the full resolved agent snapshot, including model" },
    "environment": {
      "type": "cloud",
      "networking": {
        "type": "limited",
        "allowed_hosts": [],
        "allow_mcp_servers": false,
        "allow_package_managers": false
      },
      "packages": { "type": "packages" }
    },
    "timeoutSeconds": 900
  }
}
```

- Pin `agentVersion`. The `agent` snapshot must match it: no MCP servers, skills or subagents; the default toolset disabled; only `bash`, `read`, `write`, `edit`, `glob` and `grep` enabled. `bash` is required.
- The environment must deny outbound networking and install no packages.
- `timeoutSeconds` defaults to 900. Optional `budgetCents` (positive integer string) sets a session cost threshold; a request can cross it, so it is not a hard cap.
- A bootstrap turn runs a Factory script that unpacks the input, so the model never writes binary bytes. Factory verifies the tool history and input receipt before sending the implementation prompt. This assumes Factory owns the session exclusively.
- The result must match the attempt, base and file digests.
- Factory never deletes the reusable agent or environment.

## OpenAI Agents API

Runs the Work Item in an OpenAI-hosted environment over REST (`OpenAI-Beta: agents=v1`).

```json
{
  "kind": "managed-agent",
  "provider": "openai-agents",
  "concurrency": 1,
  "config": {
    "model": "APPROVED_MODEL",
    "reasoningEffort": "low",
    "containerSize": "small",
    "apiKeyEnv": "FACTORY_OPENAI_API_KEY",
    "timeoutSeconds": 600
  }
}
```

- All five fields are required. `reasoningEffort` is `low`, `medium` or `high`; `containerSize` is `small`, `medium` or `large`.
- The worker gets no network, GitHub credentials, extra tools, plugins, vaults or subagents.
- The input archive must fit 5 MiB and the output 200 MiB (provider file limits).
- A setup command checks the archive digest and base commit before Factory submits the Work Item.
- More than one turn, or any subagent turn, stops the attempt.

## Sandbox providers

```json
{
  "kind": "sandbox",
  "concurrency": 1,
  "provider": "your-provider@1",
  "harness": {
    "kind": "registered",
    "adapter": "your-harness@1",
    "config": {}
  },
  "argv": ["node", "/installed/your-sandbox-entry.mjs"]
}
```

- **Controller:** call the package-root `composeWithSandbox(config, { identity, provider })` with a [`SandboxProvider`](https://github.com/clockgrove/factory/blob/main/src/contracts.ts).
- **Sandbox image:** must already contain Node, Git, the same installed Factory package and the harness dependencies. Factory installs nothing remotely.
- **Entrypoint:** constructs the `LocalHarnessRegistration` and passes it to the package-root `runSandboxHarness(registration)`. The harness runs its ordinary start, observe, cancel and collect inside the sandbox; see [agent harnesses](AGENT-HARNESSES.md).
- **Repository:** `prepareRepository` fetches the exact base commit into `workspace/repo` and declared LFS objects into `workspace/lfs/<index>`. Before returning it must remove every usable GitHub credential, credential helper and auth-bearing remote, or refuse.
- **Cleanup:** `destroy` must confirm that the sandbox and its processes are gone, or throw. Factory does not clean up external jobs that a harness creates.
- **Boundary:** the controller's environment never reaches the harness. Model authentication belongs to the harness and is separate from repository preparation.

### Daytona

The built-in `daytona` provider supports anonymous public `github.com` repositories only.

```json
{
  "kind": "sandbox",
  "concurrency": 1,
  "provider": "daytona",
  "config": {
    "snapshot": "your-installed-factory-snapshot",
    "target": "us",
    "apiKeyEnv": "DAYTONA_API_KEY",
    "timeoutSeconds": 60,
    "factoryRoot": "/opt/factory/node_modules/@clockgrove/factory"
  },
  "harness": {
    "kind": "registered",
    "adapter": "your-harness@1",
    "config": {}
  },
  "argv": ["node", "/opt/factory/sandbox-entry.mjs"]
}
```

- Install `@daytonaio/sdk@0.220.0` next to Factory. Without it Factory reports `DAYTONA_SDK_UNAVAILABLE`.
- `timeoutSeconds` bounds each SDK call.
- Use a trusted snapshot with Node 22+, Git, Git LFS, the same Factory version, the entrypoint and harness dependencies, and no GitHub credentials. Preparation checks the tools and version.
- Auto-stop, pause and delete are disabled, so Factory owns the sandbox lifecycle.
- Private repositories are unsupported: Daytona secret removal is asynchronous and placeholders keep outbound auth, so the worker could still authenticate.
- If `.env` or `.env.local` exists, set `DAYTONA_OTEL_ENABLED=false` and `DAYTONA_EXPERIMENTAL_OTEL_ENABLED=false` in the controller environment. Factory refuses to start if either variable is `true`.
