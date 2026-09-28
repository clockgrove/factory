# Local agent harnesses

Factory owns the Objective lifecycle. A local `AgentHarness` owns only one Work
Item attempt inside the exact worktree supplied by Factory. Codex is the default
harness; the package also contains adapters for pinned Claude Agent SDK and GitHub
Copilot SDK adapters and a package-root registration seam for another adapter.

Planning and independent result review remain on the configured Codex SDK
models. Selecting Claude or GitHub Copilot changes only Work Item execution.

This guide covers the local harness interface included in published v0.1.34. Its offline tarball bundles Codex; Claude and Copilot require their optional dependencies. Each provider's live evidence applies only to the artifact and scenario actually exercised; see [release status](https://github.com/clockgrove/factory/issues/26).

**Using the plugin:** start with the [built-in adapter matrix](#built-in-adapter-matrix) and [CLI selection](#cli-selection). **Building Factory or an adapter:** the capability and registration contracts below describe the developer interface. Credential-free checks do not qualify a real provider or authorize a live attempt.

## Capability contract

Every harness must declare this exact capability record before composition:

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

At runtime, `observe` may return a typed local-login request alongside the
failure detail. Built-in `collect` implementations propagate that request and
the runners persist it in Work Item state, so both human-readable and JSON
`factory status` output identify the provider and login command:

```ts
{
  state: "failed",
  detail: "Authentication required ...",
  authentication: { provider: "...", command: "..." }
}
```

Factory rejects a harness with incompatible capabilities. A conforming harness:

- operates only in the supplied Factory-owned worktree and leaves `HEAD`
  unchanged;
- does not commit, push, deploy, open or edit issues or pull requests, or
  receive the controller's GitHub publication credentials;
- returns a non-empty attempt identity plus JSON-safe durable handle data;
- supports restart-safe `observe`, `cancel`, and `collect` without creating a
  second ambiguous attempt;
- returns only normalized evidence and declared `AssetSet` candidates; and
- treats provider completion as an untrusted candidate result. Factory still
  checks owned paths and secrets, validates the exact result tree, performs
  independent acceptance review, publishes, and validates the integrated
  Objective.

The stable adapter identity and exact adapter-owned configuration are part of
Factory's configuration digest. Active local handles are also bound to that
identity. A missing registration, identity mismatch, configuration mismatch, or
mid-run configuration change stops instead of falling back to Codex or another
harness.

## Installed registration seam

An adapter package imports only the package root. It does not construct or
replace Factory's driver, scheduler, validator, GitHub gateway, delivery
strategy, planning models, or content store:

```ts
import {
  composeWithLocalHarness,
  type AgentHarness,
  type FactoryConfig,
} from "@clockgrove/factory";

const identity = "example/acme-agent@2";
const adapterConfig = {
  model: "acme-code-1",
  session: "new-per-attempt",
};

const harness: AgentHarness = {
  capabilities: {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "adapter-owned",
  },
  async start(request) {
    // Start once in request.worktree. Persist provider identity in `data`.
    return { identity: request.attemptId!, data: { providerTask: "..." } };
  },
  async observe(handle) {
    return { state: "running" };
  },
  async cancel(handle) {},
  async collect(handle) {
    return { evidence: { adapter: identity } };
  },
};

const config: FactoryConfig = {
  // ...ordinary Factory installation fields...
  execution: {
    kind: "local",
    concurrency: 1,
    harness: {
      kind: "registered",
      adapter: identity,
      config: adapterConfig,
    },
  },
};

const factory = composeWithLocalHarness(config, {
  identity,
  config: adapterConfig,
  harness,
});
await factory.runObjective(123);
```

The adapter owns the meaning and validation of its opaque JSON-safe config. A
behavior-changing adapter release should use a new stable identity. Factory
schema version 1 selects one harness for an Objective; mixed harnesses and
automatic fallback are intentionally unsupported.

## Built-in adapter matrix

| Harness             | Package and license                                                                                                                                                                                                                | Local runtime                                     | Explicit Factory boundary                                                                                                                                                                                                                   | Authentication                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex SDK (default) | bundled `@openai/codex-sdk@0.156.0`; Apache-2.0                                                                                                                                                                                    | local SDK worker                                  | explicit model/reasoning, workspace-write, approval prompts disabled                                                                                                                                                                        | existing Codex local login/profile                                                                     |
| Claude Agent SDK    | optional [`@anthropic-ai/claude-agent-sdk@0.3.281`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk); [Anthropic proprietary license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) | local SDK worker process                          | exact model/reasoning, tool and allowed-tool lists, permission mode, setting sources, turn limit; MCP, model skills, subagents and session persistence disabled; pinned runtime/managed components trusted; no additional plugins requested | standard Claude local profile or named Claude/Anthropic auth environment                               |
| GitHub Copilot SDK  | optional [`@github/copilot-sdk@1.0.13`](https://www.npmjs.com/package/@github/copilot-sdk); MIT                                                                                                                                    | bundled local Copilot CLI/runtime in `empty` mode | exact model/reasoning/timeout, explicit file tools and read/write permissions; shell, task, web, GitHub, MCP, memory, skills, plugins, host-Git operations, remote sessions, and config discovery disabled                                  | Copilot-local profile or named Copilot auth environment; controller `gh` authentication store excluded |
| Registered adapter  | adopter package                                                                                                                                                                                                                    | adapter-defined local process                     | exact capability declaration, stable identity, opaque JSON-safe config                                                                                                                                                                      | `local-environment`, `adapter-owned`, or `none`, as declared                                           |

Factory names the shared selection `reasoningEffort` for all three built-ins.
The Claude adapter maps that field to the Claude SDK's provider-native `effort`
option; provider vocabulary does not leak into persisted Factory configuration.

The two optional SDK packages are declared as exact optional package
dependencies. A normal online npm installation on a runtime satisfying the
selected SDK's engine requirements installs them. An installation
using `--omit=optional` can still use Codex and the generic registered seam, but
cannot select the Claude or GitHub Copilot built-in adapter.

Factory's default Codex and Claude paths retain Node.js 22.0.0 or later. The
exact Copilot SDK `1.0.13` dependency requires Node.js 22.12.0 or later on
Factory's supported Node range. Selecting it on Node 22.0–22.11 fails before
SDK loading, authentication or an attempt; there is no fallback or automatic
installation. Optional-omitted installations retain the default/root seam at
Factory's Node floor.

Package-manager lifecycle approval policy is separate from SDK availability:
the contributor npm11 install withheld Koffi's unapproved native install script.
That credential-free source gate is not proof of a ready live Copilot runtime.
Operators must satisfy their package-manager policy and verify the selected
runtime normally; Factory never approves scripts or falls back automatically.

Building and checking distribution notices requires a full dependency install:
the generator reads the installed optional SDK license texts. That contributor
prerequisite does not make either SDK necessary for an optional-omitted runtime.

Each built-in worker records a correlated usage invocation before provider
startup, requires an explicit successful terminal event, and bounds idle waits
and cleanup using the existing provider-turn guard. Copilot checks its observed startup worktree,
model and any supplied reasoning effort before sending the accepted Work Item
prompt; missing startup evidence or a mismatch fails before dispatch. Progress
resets only the idle timer, retaining the timeout promise observed by any active
provider operation. These guards do not add a retry or execution-time budget.
Usage stays provider-specific at the adapter boundary. Every private usage record
is correlated to the attempt and available provider session/event identities;
only allowlisted nonnegative safe-integer token fields are retained.

- **Codex:** the SDK exposes a completed-turn usage snapshot, not per-API-call
  counters. Preserve its supplied input, cache, output and reasoning categories
  once; repeated summary reads and the terminal observation do not add them again.
- **Claude:** retain deduplicated assistant-message counters for debugging, but
  normalize only the final result's `modelUsage` snapshot across models. The
  pinned SDK includes the fresh query's main loop and other query-pipeline calls
  there; `result.usage` is main-loop-only and assistant output can be a placeholder.
  SDK `inputTokens` excludes its cache read/write fields, so the common input
  denominator is their sum when all three categories are supplied. Cache reads
  and writes remain subsets, not additional tokens added to that denominator.
  Read the snapshot once, never sum it with assistant observations. Missing model
  categories stay unknown. No result, or `error_during_execution` results that
  can contain SDK-reset zeroes, leave normalized usage unavailable while retaining
  observed private fields. Other error results preserve supplied model counters.
- **Copilot:** retain `assistant.usage` per-call input/output/cache/reasoning
  fields, deduplicate event/call identities, and sum input/output independently
  across observed unique calls. A missing/invalid category or overflowing sum
  leaves that category unknown. Cache and reasoning fields remain private raw
  observations until their normalization semantics are established. Context and
  conversation counters never become consumed tokens.

Claude and Copilot publish normalized counters only at worker termination; an
earlier partial sum cannot survive a later missing category. No observations
means unknown, not zero. No adapter derives a total or billing estimate.
These observations describe SDK-reported scope, not a complete billing ledger;
Claude helpers outside its query pipeline are excluded by the SDK. Telemetry
never authorizes execution, retry or recovery and cannot reconstruct old runs or
relabel qualified artifacts.

Claude's mapping follows the pinned SDK `ModelUsage`/`SDKResultMessage` contract
and [usage scope and duplicate-message guidance](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
with [separate input/cache components](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
The native pinned runtime accumulates `ModelUsage.inputTokens` from
`usage.input_tokens` separately from cache reads/writes. Copilot's pinned
`AssistantUsageData` describes its optional per-call API token fields; its
conversation size is a separate metric.

All three built-in harnesses reuse the developer's local authentication. Factory
does not add tokens to its configuration file. For example, an existing `codex`
CLI login is visible to the Codex SDK worker, an existing Claude profile is
visible to the Claude worker, and the Copilot SDK is started with
`useLoggedInUser: true` against the developer's local Copilot state. The worker
environment excludes controller publication variables such as `GH_TOKEN` and
`GITHUB_TOKEN`. Copilot retains the worker-owned empty `GH_CONFIG_DIR`, even if
the controller sets a different directory or uses HOME/XDG defaults. Its
controller `gh` publication login is not supplied as a Copilot auth source.
The explicitly selected local-auth adapter may use its Copilot-local profile or
named Copilot auth environment; missing login fails with the existing actionable
login-and-explicit-retry request rather than restoring the controller's store.
The pinned SDK's `empty` mode disables keytar; Factory does not claim that this
mode will reuse a system-keychain login. Provider-local state does not authorize
unselected tools, account-synced extensions, settings discovery, memory, or session persistence.

Claude's bundled and administrator-managed components are part of its trusted local
runtime. Its initialization plugin, skill and agent inventories are diagnostic data, not proof of
provenance or an extra permission grant. Factory does not reject a normal runtime
merely because it implements instruction loading or managed policy as a plugin.
It supplies no additional plugin paths, disables account-synced plugins/skills,
auto-memory, bundled skills/workflows and optional telemetry per invocation, and excludes personal/project
instruction files (including the built-in AGENTS.md loader's inputs). Managed
instructions and policy retain precedence. Filesystem settings sources remain an
explicit adapter configuration choice; use `settingSources: []` for no user,
project or local settings discovery. Selecting a source trusts its settings/hooks
as local runtime code; it does not expand Factory's configured model tools.

Empty SDK skill/agent options do not imply empty runtime inventories. The skill
filter hides unselected model skills; the configured tools exclude `Skill` and
`Agent`, and host hooks reject both. Built-in terminal commands may remain listed.

The file-tool hooks and startup tool/MCP checks constrain model-facing operations;
they do not sandbox trusted runtime or plugin code, hide all home-directory files,
or prevent arbitrary host-code network access. Factory supplies an empty controller
GitHub credential directory and strips publication tokens, while retaining local
provider authentication. Scheduling, Git publication, exact validation and final
acceptance remain controller-owned. An API for individually selected developer
plugins is separate follow-up work; the registered harness interface already keeps
adapter-owned customization outside shared orchestration.

On Windows with a WSL2 controller, verify the selected CLI/runtime and authenticate
inside that same WSL distribution and user account. A Windows desktop-app login
does not establish WSL CLI readiness. Check `claude auth status` using the selected
runtime; verify Copilot CLI availability and its own local login separately from
`gh auth status`. Optional native installation warnings are not successful runtime
qualification. Launch the controller from the ordinary authorized WSL host as
explained in `docs/PUBLIC-RELEASE.md`; retain the worker's managed sandbox settings.
An outer chat sandbox failure is not permission to weaken worker safeguards.

If a profile is missing or expired, the attempt fails durably with a specific
request to authenticate in the developer environment:

```sh
codex login
claude auth login
copilot
```

After login, the operator explicitly starts a fresh unpublished attempt:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

Factory never opens an interactive credential prompt inside a detached worker,
stores the resulting credential in run state, or silently changes provider.

## CLI selection

Codex remains the default when `--harness` is omitted. The current source
candidate can install either optional adapter explicitly:

```sh
factory install \
  --repository OWNER/REPO --checkout /absolute/target --concurrency 1 \
  --harness claude-agent-sdk \
  --worker-model CLAUDE_MODEL --worker-reasoning medium \
  --claude-max-turns 12

factory install \
  --repository OWNER/REPO --checkout /absolute/target --concurrency 1 \
  --harness github-copilot-sdk \
  --worker-model COPILOT_MODEL --worker-reasoning medium \
  --copilot-timeout-seconds 900
```

Claude defaults to `Read`, `Edit`, `Write`, `Glob`, and `Grep`. GitHub Copilot
defaults to `view`, `create`, `edit`, `apply_patch`, `grep`, and `glob`. Repeated
`--claude-tool`, `--claude-allow-tool`, and `--copilot-tool` flags make those
sets explicit. Claude setting sources are empty by default; each allowed source
requires a repeated `--claude-setting-source` flag. Provider-specific fields do
not cross adapters.

Copilot resolves editing tools per model. With the pinned runtime, a
`gpt-5.6-luna` session uses `apply_patch`; listing `create` and `edit` alone
leaves that session without an editor even though the general tool catalog
lists both. Use the default file-tool set, or explicitly include `apply_patch`
when selecting that model. Existing explicit configurations are not rewritten:
change the configuration before creating a new plan, since the plan binds its
configuration digest. The patch tool uses the same worktree-only read/write
permission callback; shell and GitHub tools remain unavailable.

The credential-free `test/copilot-tools.test.mjs` checks the resolved session
metadata and invokes the real patch tool against disposable local files. It
creates no model turn and uses no provider login. A tool catalog or configured
allowlist alone is not evidence of the model's resolved session capabilities.
Live qualification and provider usage accounting remain separate checks.

## Security boundary and acceptance

These are local processes running as the developer's OS account. Worktree path
checks, SDK permission callbacks, filtered environments, and disabled extension
surfaces reduce accidental authority; they are not an OS sandbox for hostile
repository code. Source-authorized validation commands also run locally under
operator authority. Managed agents, remote Copilot sessions, sandbox execution,
Daytona, dynamic provider installation, and a provider marketplace are outside
this seam.

Credential-free CI packs Factory, installs it while omitting optional packages,
imports only `@clockgrove/factory`, injects a scripted non-Codex harness, and
runs a complete one-item path through the production local driver, exact-tree
validation, regular delivery, and final validation. Real provider acceptance is
separate: Codex, Claude, and GitHub Copilot must run the same bounded disposable
target from the exact packed artifact. Those live calls require explicit
operator authorization and available provider access; deterministic CI does not
claim that proof.
