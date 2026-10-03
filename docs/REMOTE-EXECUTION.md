# Remote execution

Remote execution runs a Work Item's implementation away from the controller host. Planning, review, validation, media selection and GitHub delivery stay on the controller.

There are two kinds:

- **Managed agent** (`execution.kind: "managed-agent"`): a provider-hosted agent session does the work. Providers: `claude-managed-agents` and `openai-agents`.
- **Sandbox** (`execution.kind: "sandbox"`): Factory runs your registered harness inside a provider sandbox. Provider: the built-in `daytona`, or your own `SandboxProvider`.

All are development candidates: credential-free tests cover them, live runs are not yet qualified ([#259](https://github.com/clockgrove/factory/issues/259) Claude, [#258](https://github.com/clockgrove/factory/issues/258) OpenAI, [#9](https://github.com/clockgrove/factory/issues/9) Daytona).

## Before you start

Installing Factory keeps local execution and grants no provider or spending authority. First approve the source that leaves the host (the pinned base plus declared and selected assets), the provider account and model, and the spending limit. Then edit the `execution` object in your installation config and use the normal `factory` commands.

## What every provider shares

- **Input:** the exact base commit as a shallow snapshot, without history or local Git config. Only regular files and executable bits are supported; symlinks and submodules are rejected before anything is created.
- **Output:** an archive of file bytes with a path, mode, size and SHA-256 inventory. Factory rejects unsafe paths and mismatches, then runs the same ownership, secret scan, asset capture, validation, LFS, review and delivery as local work. A provider saying "done" is not acceptance.
- **Worker policy:** managed agents need `policy.network: "off"` and an empty `policy.allowedSecretNames`. The controller still needs network access to the provider and GitHub.
- **Concurrency:** `execution.concurrency` is Factory's limit, not a claim of provider capacity.
- **Usage:** missing usage is unknown, never zero.

## Lifecycle and recovery

Factory checkpoints each step in the Work Item snapshot before calling the provider, and tags every remote resource with the attempt ID, so a restarted controller finds it instead of creating another.

When a response is lost in transit (network error, timeout, HTTP 408, 429 or 5xx), Factory reads the provider's record for the recorded step:

- if the step happened, continue;
- if it never happened, send it again;
- otherwise end the attempt and repeat the Work Item with a fresh attempt.

| Lost response | Claude                                                                                                                             | OpenAI                                                                                                                                       | Sandbox                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Create        | List the agent's sessions tagged with the attempt since submission; adopt it or create one.                                        | Sessions cannot be listed by tag, so end the attempt and start fresh. Records a `possible-orphan`.                                           | `create` adopts the sandbox `find` returns for the attempt.                             |
| Input         | Read session history: continue if the exact message is there, resend if the session is idle with no new message, else start fresh. | A recorded turn means accepted, so continue. No turn: delete the session and start fresh. A restart during hosted setup waits, then submits. | Preparation and harness start cannot repeat in one sandbox: destroy it and start fresh. |
| Other         | File upload: upload again. Records a `possible-orphan`.                                                                            | —                                                                                                                                            | Observe and collect only read, so invoke again.                                         |

Collection retries transient failures in place for up to two minutes, then interrupts the step; the next pass reattaches to the same resource.

Any other failure stops the remote resource first, then fails the attempt as an implementation failure, so it gets a fresh attempt or a repair. This covers a refused request, a resource that no longer exists, a rejected result, a harness that ends without a result, and a passed deadline. A repeated attempt never runs beside the old one.

**Deadline:** the managed `timeoutSeconds` bounds the whole attempt. Each cleanup gets a fresh window of the same length, so cleanup still runs after an outage.

**Cancel:** stops the remote work, deletes the owned resources and confirms they are gone. A failed or unconfirmed deletion stays visible and is retried on restart.

**Possible orphans:** a lost response that may have left an untraceable resource is recorded as a `possible-orphan` diagnostic with the attempt ID and time. Find it in `factory diagnostics` and delete the resource by hand.

## Controller credentials

Each provider config names an environment variable that holds the controller's API key. The key never enters the config, model input or sandbox. Local Claude, Codex or Copilot logins do not supply it.

- **Foreground:** set the variable in the controller shell. `factory readiness --config /absolute/config.json` checks it is present; it does not call the provider.
- **Background service:** put only the key in an owner-private file (mode `0600`) outside the target checkout, then install with `factory supervisor install ... --credential-file NAME=/absolute/private/file`, where `NAME` is the configured variable. Bind one file per credential. Factory uses systemd `LoadCredential`, so the host needs a Linux user systemd; otherwise run in the foreground.
- The service reads the key at start. Rotate it by restarting the service. A missing key stops execution; Factory never falls back to ambient variables.

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
- A bootstrap turn runs a Factory-supplied script that unpacks the input, so binary and LFS bytes are never model-written. Factory checks the full tool history and input receipt before sending the implementation prompt, and rejects any other activity. This assumes Factory owns the session exclusively.
- The result must match the attempt, base and file digests.
- Deleting a session removes its sandbox. Factory never deletes the reusable agent or environment.

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
- The input archive must fit the provider's 5 MiB file limit; larger inputs need another execution mode. The output archive must fit 200 MiB.
- A setup command checks the archive digest and base commit before Factory submits the Work Item.
- More than one turn, or any subagent turn, stops the attempt.

## Sandbox providers

The sandbox driver creates a provider workspace, prepares the repository there, and runs your registered harness through an installed entrypoint.

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

- **Controller:** call the package-root `composeWithSandbox(config, { identity, provider })` with a `SandboxProvider` (see [`src/contracts.ts`](../src/contracts.ts)).
- **Sandbox image:** must already contain Node, Git, the same installed Factory package and the harness dependencies. Factory installs nothing remotely.
- **Entrypoint:** constructs the `LocalHarnessRegistration` and passes it to the package-root `runSandboxHarness(registration)`. The harness runs its ordinary start, observe, cancel and collect inside the sandbox; see [agent harnesses](AGENT-HARNESSES.md).
- **Repository:** `prepareRepository` fetches the exact base commit from the published remote into `workspace/repo`, plus declared LFS objects into `workspace/lfs/<index>`. It must remove every usable GitHub credential, credential helper and auth-bearing remote before returning, or refuse. A hidden token the worker can still use does not count.
- **Inputs:** private inputs and selected assets travel in a verified `.factory-inputs` archive.
- **Cleanup:** `destroy` must confirm the sandbox and its processes are gone, or throw.

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
- Use a trusted snapshot with Node 22+, Git, Git LFS, the same Factory version, the entrypoint and the harness dependencies, and no GitHub credentials. Preparation checks the tools and Factory version before starting the harness.
- Auto-stop, pause and delete are disabled, so Factory owns the sandbox lifecycle.
- Private repositories are unsupported: Daytona secret removal is asynchronous and placeholders keep outbound auth, so the worker could still authenticate.
- If a `.env` file is present, set `DAYTONA_OTEL_ENABLED=false` and `DAYTONA_EXPERIMENTAL_OTEL_ENABLED=false` in the controller environment. Factory refuses SDK tracing.
