# Agent harnesses

A harness runs one Work Item attempt inside a worktree Factory owns. Factory owns everything else: planning, scheduling, validation, review and GitHub delivery. Planning and review use the separate `planning` provider, so choosing a harness changes only Work Item execution.

Factory ships three harnesses and a seam for your own:

| Harness               | Package                                           | Login it reuses                                   |
| --------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `codex-sdk` (default) | bundled `@openai/codex-sdk@0.156.0`               | Codex local login                                 |
| `claude-agent-sdk`    | optional `@anthropic-ai/claude-agent-sdk@0.3.281` | Claude local profile or Claude auth environment   |
| `github-copilot-sdk`  | optional `@github/copilot-sdk@1.0.13`             | Copilot local profile or Copilot auth environment |
| `registered`          | your adapter package                              | whatever the adapter declares                     |

To run a harness in a remote sandbox instead of locally, see [remote execution](REMOTE-EXECUTION.md).

## Choose a harness

Codex is used when `--harness` is omitted. Select another at install:

```sh
factory install --repository OWNER/REPO --checkout /absolute/target \
  --harness claude-agent-sdk --worker-model MODEL --worker-reasoning medium \
  --claude-max-turns 12

factory install --repository OWNER/REPO --checkout /absolute/target \
  --harness github-copilot-sdk --worker-model MODEL --worker-reasoning medium \
  --copilot-timeout-seconds 900
```

- **Optional packages:** a normal `npm install` includes the Claude and Copilot SDKs. With `--omit=optional`, only Codex and registered adapters work.
- **Node:** Factory needs Node 22+. The Copilot SDK needs Node 22.12+ and fails before starting on older versions.
- **Reasoning:** every built-in takes `reasoningEffort`; Claude maps it to its own `effort` option.
- **Default tools:** Claude gets `Read`, `Edit`, `Write`, `Glob`, `Grep`. Copilot gets `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`. Repeat `--claude-tool`, `--claude-allow-tool` or `--copilot-tool` to set them explicitly.
- **Copilot editing:** some models, such as `gpt-5.6-luna`, edit only through `apply_patch`, so keep it in the tool list.
- **Claude settings:** no settings files are loaded by default. Add each source with a repeated `--claude-setting-source`. A selected source's settings and hooks run as trusted local code.

Factory never falls back to another harness. A missing adapter, identity mismatch or config change during a run stops the work.

## Authentication

Built-in harnesses reuse your local login. Factory stores no tokens in its config.

- The worker environment drops controller publication variables such as `GH_TOKEN` and `GITHUB_TOKEN`, and gets an empty `GH_CONFIG_DIR`, so a worker cannot use the controller's `gh` login.
- Copilot runs with `useLoggedInUser: true` in `empty` mode, which disables keytar; a system-keychain login is not used.
- Codex keeps your `CODEX_HOME` and optional `CODEX_SQLITE_HOME`. A supervisor service captures them at install; reinstall the service to change them.
- On WSL2, log in inside the distribution and user that runs the controller; a Windows desktop login does not count.
- Claude planning (`--planning claude-agent-sdk`) uses the same SDK and login; `ANTHROPIC_API_KEY` is optional. Settings files are not loaded, so Bedrock, Vertex and `apiKeyHelper` are not supported yet.

If a login is missing or expired, the attempt fails and `factory status` shows the provider and login command (`codex login`, `claude auth login` or `copilot`). Log in, then start a fresh attempt:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

Factory never prompts for credentials inside a worker or stores them in run state.

## Security boundary

Harnesses are local processes running as your OS user. Path checks, permission callbacks, filtered environments and disabled extensions reduce accidental authority; they are not an OS sandbox for hostile code.

- **Claude:** skills, subagents, session persistence, auto-memory, synced plugins and personal or project instruction files are off. Bundled and administrator-managed components are trusted runtime.
- **Copilot:** shell, task, web, GitHub, MCP, memory, skills, plugins, host Git, remote sessions and config discovery are off.

Workers never commit, push or touch issues and pull requests. Publication stays with the controller.

## Usage

Each worker records token usage tied to the attempt. Missing counters stay unknown, never zero, and no harness derives a cost.

- **Codex:** one completed-turn snapshot.
- **Claude:** the final result's `modelUsage` across models. Error results that may hold SDK-reset zeroes leave usage unknown.
- **Copilot:** per-call `assistant.usage` input and output, deduplicated and summed.

## Execution profiles

Profiles let the compiler assign different harness configs to different Work Items. Use `execution.profiles` and `execution.defaultProfile` instead of `execution.harness`:

```json
{
  "kind": "local",
  "concurrency": 2,
  "defaultProfile": "standard",
  "profiles": {
    "standard": {
      "description": "General implementation and debugging.",
      "selectionHints": ["Default when no stronger match exists."],
      "harness": {
        "kind": "codex-sdk",
        "model": "gpt-5.6-luna",
        "reasoningEffort": "medium"
      }
    },
    "deep": {
      "description": "Complex changes needing more reasoning.",
      "harness": {
        "kind": "codex-sdk",
        "model": "gpt-5.6-sol",
        "reasoningEffort": "high"
      }
    }
  }
}
```

- Listing a profile approves its provider to read the whole worktree and its inputs. Owned paths limit writes, not reads.
- Descriptions and hints go to the compiler and reviewer, so keep credentials and private paths out of them. Hints grant no tools or permissions.
- The compiler honors explicit assignments, then requirements and preferences, and uses the default only when it fits. Each Work Item records its profile and reason; editing the issue cannot change it.
- Each item keeps its original binding through restart, cancel and collect.
- For registered adapters, call `composeWithLocalProfiles(config, registrations)`, keyed by profile ID.

### Profile environment

A profile may add an `environment` beside `harness`:

```json
{
  "instructions": "Explain any incomplete acceptance in your final response.",
  "mcp": { "kind": "factory-worktree-read", "version": 1 }
}
```

- `instructions` works with all three built-ins. Factory appends it to the worker prompt, below its own constraints; it cannot grant permissions or change the model.
- `mcp` is Claude only, and needs `Read` in both `tools` and `allowedTools`. It starts an in-process `read_file` server limited to regular files inside the worktree. All tools stay denied until the session reports exactly that server.
- Registered profiles accept no `environment`. Unknown fields fail validation.

## Writing an adapter

An adapter imports only `@clockgrove/factory` and declares this capability record:

```ts
{
  protocolVersion: 1,
  worktree: "factory-owned-read-write",
  head: "preserve",
  lifecycle: "restart-safe-durable-handle",
  publication: "controller-only",
  assetSets: true,
  authentication: "local-environment" | "adapter-owned" | "none"
}
```

A conforming harness:

- works only in the supplied worktree and leaves `HEAD` unchanged;
- never commits, pushes, deploys or edits issues and pull requests;
- returns an attempt identity and JSON-safe handle data from `start`;
- makes `observe`, `cancel` and `collect` safe to repeat after a controller restart, without starting a second attempt;
- returns evidence and declared `AssetSet` candidates. Factory still checks paths and secrets, validates the result tree, reviews it and publishes it.

`observe` may report a missing login as `{ state: "failed", authentication: { provider, command } }`; `factory status` shows it.

Register the adapter and compose Factory:

```ts
import {
  composeWithLocalHarness,
  type AgentHarness,
} from "@clockgrove/factory";

const identity = "example/acme-agent@2";
const adapterConfig = { model: "acme-code-1" };
const harness: AgentHarness = {
  capabilities: {/* the record above */},
  async start(request) {
    return { identity: request.attemptId!, data: { task: "..." } };
  },
  async observe() {
    return { state: "running" };
  },
  async cancel() {},
  async collect() {
    return { evidence: { adapter: identity } };
  },
};

const factory = composeWithLocalHarness(config, {
  identity,
  config: adapterConfig,
  harness,
});
await factory.runObjective(123);
```

The installation config must match: `execution.harness` is `{ "kind": "registered", "adapter": identity, "config": adapterConfig }`. The adapter owns its config's meaning; the identity and config are part of Factory's config digest. Ship a behavior change under a new identity.
