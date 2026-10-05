# Agent harnesses

A harness runs one Work Item attempt inside a worktree Factory owns. Factory owns everything else: planning, scheduling, validation, review and GitHub delivery. Planning and review use the separate `--planning` provider (`codex-sdk` or `claude-agent-sdk`), so choosing a harness changes only Work Item execution.

Factory ships three harnesses, plus a `registered` seam for your own adapter:

|                      | `codex-sdk` (default)                                                     | `claude-agent-sdk`                                                                                                                                                | `github-copilot-sdk`                                                                                                  |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Package              | bundled `@openai/codex-sdk@0.160.0`                                       | optional `@anthropic-ai/claude-agent-sdk@0.3.281`                                                                                                                 | optional `@github/copilot-sdk@1.0.13`                                                                                 |
| Required flags       | none                                                                      | `--worker-model`, `--claude-max-turns`                                                                                                                            | `--worker-model`, `--copilot-timeout-seconds`                                                                         |
| `--network`          | `host` or `off`                                                           | `host` only                                                                                                                                                       | `host` only                                                                                                           |
| `--worker-reasoning` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent` | `low`, `medium`, `high`, `xhigh`, `max`                                                                                                                           | `low`, `medium`, `high`, `xhigh`, `max`                                                                               |
| Other flags          | —                                                                         | `--claude-permission acceptEdits\|dontAsk` (default `acceptEdits`), `--claude-tool`, `--claude-allow-tool`, `--claude-setting-source`                             | `--copilot-tool`                                                                                                      |
| Login                | Codex local login                                                         | Claude local profile, or `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` | Copilot local profile, or `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_API_URL`, `COPILOT_PROVIDER_*` |

## Choose a harness

Codex is used when `--harness` is omitted. Select another when you set up:

```sh
factory setup --config-only --repository OWNER/REPO --checkout /absolute/target \
  --harness claude-agent-sdk --worker-model MODEL --worker-reasoning medium \
  --claude-max-turns 12

factory setup --config-only --repository OWNER/REPO --checkout /absolute/target \
  --harness github-copilot-sdk --worker-model MODEL --worker-reasoning medium \
  --copilot-timeout-seconds 900
```

- **Optional packages:** a normal `npm install` includes the Claude and Copilot SDKs. With `--omit=optional`, only Codex and registered adapters work.
- **Node:** Factory needs Node 22+. The Copilot SDK needs Node 22.12+ and fails before starting on older versions.
- **Default tools:** Claude gets `Read`, `Edit`, `Write`, `Glob`, `Grep`. Copilot gets `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`. The tool flags replace these lists.
- **Copilot editing:** some models edit only through `apply_patch`, so keep it in the tool list.
- **Claude settings:** no settings files are loaded by default. A source added with `--claude-setting-source` runs its settings and hooks as trusted local code.

Factory never falls back to another harness. A missing adapter, identity mismatch or config change during a run stops the work.

## Authentication

Built-in harnesses reuse your local login. Factory stores no tokens in its config.

- The worker environment drops controller publication variables such as `GH_TOKEN` and `GITHUB_TOKEN`, and gets an empty `GH_CONFIG_DIR`, so a worker cannot use the controller's `gh` login.
- Copilot runs with `useLoggedInUser: true` in `empty` mode, which disables keytar; a system-keychain login is not used.
- Codex workers, the Codex result reviewer and the readiness probe run with a private `HOME`, `CODEX_HOME` and `TMPDIR`. The private `CODEX_HOME` holds Factory's config and a link to your login (`auth.json` from your `CODEX_HOME`, which a supervisor service captures at install); your `config.toml`, `AGENTS.md`, skills, MCP servers and `CODEX_SQLITE_HOME` do not apply.
- On WSL2, log in inside the distribution and user that runs the controller; a Windows desktop login does not count.
- Claude planning uses the same SDK and login, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. It loads no settings files, so Bedrock, Vertex and `apiKeyHelper` are unsupported.

If a login is missing or expired, the attempt fails and `factory status` shows the provider and login command (`codex login`, `claude auth login` or `copilot`). Log in, then start a fresh attempt:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

## Security boundary

Harnesses are local processes running as your OS user. Path checks, permission callbacks, filtered environments and disabled extensions reduce accidental authority; they are not an OS sandbox for hostile code.

- **Codex:** a Codex permission profile and `approvalPolicy: "never"`. Shell commands see only Codex's `:minimal` platform paths, the Codex runtime, the worktree (its `.git` link read-only) and the private `HOME` and `TMPDIR`; your `HOME`, logins, SSH keys, `gh` config, Factory's state and the rest of the checkout's git directory are not mounted. Network is on only when `policy.network` is `host`. The result reviewer's shell reads the exact tree only, offline.
- **Codex worker toolchains:** a worker also reads, never writes, the tools on the `PATH` Factory runs with: each `PATH` directory, and the directory of the real file behind each link in one. A directory named `bin` or `sbin` counts as its whole install prefix (`~/tools/node-24/bin` mounts `~/tools/node-24`), unless the prefix is a hidden directory such as `~/.local` or `~/.cargo`, where settings and logins live; then only the `bin` directory is mounted. A `PATH` directory that is your `HOME`, holds it, or touches a login (`~/.ssh`, `~/.claude`, `~/.copilot`, your `CODEX_HOME`, `gh` config), Factory's config or state, or the checkout's git directory is refused with an error that names it: remove it from the `PATH` or move its tools to their own directory. A link that leads into one of those is not mounted, so that tool does not run in a worker. A tool that needs files elsewhere (a version manager's shims, for example) does not run either; put its real `bin` directory on the `PATH`.
- **Codex worker git:** read-only git commands (`git ls-files`, `status`, `diff`, `log`, `rev-parse`) work in a worker's own worktree, so a repository check that reads git runs as it does in validation. A worker reads, never writes, its worktree's administrative directory (`<checkout>/.git/worktrees/<name>`: `HEAD`, `index`) and, from the checkout's git directory, `objects`, `refs`, `packed-refs`, `HEAD`, `config`, `info`, `shallow` and `reftable` where they exist, each at its real path. Other worktrees' directories, `hooks`, `logs` and the checkout's files are not mounted. `git commit`, `update-ref` and any write into these paths fail (`Read-only file system`), and `GIT_OPTIONAL_LOCKS=0` keeps `git status` from trying to rewrite the index. The checkout's git `config` is readable, so keep credentials out of it (no token in a remote URL or `http.extraHeader`); credential helpers run in the controller only.
- **Codex worker package stores:** your package-manager stores and caches are not mounted. A worker's package manager fills its own under the private `HOME` or the worktree (pnpm: `node_modules/.pnpm-store`), so a first install needs `policy.network: "host"`.
- **Claude and Copilot:** the SDK process keeps your `HOME`, where its login lives. The model has no shell, and Factory allows its file tools only inside the worktree (the Claude result reviewer: read-only tools inside the tree).
- **Claude:** skills, subagents, session persistence, auto-memory, synced plugins and personal or project instruction files are off. Bundled and administrator-managed components are trusted runtime.
- **Copilot:** shell, task, web, GitHub, MCP, memory, skills, plugins, host Git, remote sessions and config discovery are off.

Workers never commit, push or touch issues and pull requests. Publication stays with the controller.

## Usage

Each worker records token usage tied to the attempt: Codex's completed-turn snapshot, Claude's final `modelUsage`, or Copilot's per-call `assistant.usage`, deduplicated and summed. Missing counters stay unknown, never zero, and no harness derives a cost.

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
        "model": "gpt-6.1-sol",
        "reasoningEffort": "medium"
      }
    },
    "claude": {
      "description": "Complex changes needing more reasoning.",
      "harness": {
        "kind": "claude-agent-sdk",
        "model": "CLAUDE_MODEL",
        "reasoningEffort": "high",
        "permissionMode": "acceptEdits",
        "settingSources": [],
        "tools": ["Read", "Edit", "Write", "Glob", "Grep"],
        "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep"],
        "maxTurns": 12
      }
    }
  }
}
```

- Factory refuses a config field it does not know, naming the field. Fields from older versions (`contentStore`, `policy.deployments`, `session`, `authentication`, and `adapter` on a Claude or Copilot harness) do nothing now; remove them. The edit changes the config digest, so an Objective started before it stops at its next step; `factory status` names the way out.
- Claude and Copilot profiles need `policy.network: "host"`. Copy a built-in harness object from the config `factory setup --config-only` writes.
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
