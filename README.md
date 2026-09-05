# Factory

> [!IMPORTANT]
> Factory is under development. See [what works today](docs/CONFORMANCE.md) and
> [what's next](docs/DELIVERY-PLAN.md).

Factory coordinates coding agents to turn a GitHub issue into tested pull requests. Describe what
you want to build; Factory breaks it into Work Items, runs independent tasks concurrently, checks
the results, and integrates accepted changes.

Built for indie developers and small teams, Factory uses your local computer first and can burst
into cloud workers when you authorize the cost. You interact through your agent's chat interface;
GitHub holds the issues, dependencies, pull requests, and execution records.

A local controller keeps work moving while it is running and recovers from GitHub records after a
restart. No Factory GitHub Actions workflow, hosted service, or database is required. Optional
GitHub-managed agents may consume Actions minutes as part of their own runtime.

```text
Objective issue
      │
      ▼
Factory Supervisor ── compile / lease / schedule / budget / recover
      │                                      │
      │ durable receipts                     │ restricted Worker Packets
      ▼                                      ▼
GitHub issues, refs, PRs              local Codex SDK (default)
and native dependencies               or opt-in sandbox/managed backends
      ▲                                      │
      └──── validate / publish / merge ──────┘
```

## What Factory handles

- **Planning:** turns an Objective into GitHub sub-issues with clear acceptance criteria and dependencies.
- **Scheduling:** prioritizes ready tasks and adjusts local concurrency to available CPU and memory.
- **Execution:** runs workers in isolated Git worktrees, with explicitly authorized cloud options.
- **Validation:** independently runs checks and reviews each artifact before publishing a PR.
- **Delivery:** merges validated changes through ordinary PRs or explicitly selected native stacks.
- **Recovery:** reconstructs progress from GitHub and stops for specific safety, budget, or correctness blockers.

Local workers use the Codex SDK by default, with Codex CLI fallback. Cloud execution is opt-in.
Provider availability and outstanding end-to-end checks are listed in [verification status](docs/CONFORMANCE.md).

## Scope

Factory executes on Linux. The supported host configurations are native Linux, a Linux distribution
under Windows WSL2, and a Linux guest hosted by macOS. The repository, controller, worktrees, locks,
and credentials stay inside the Linux filesystem. Native Win32 and native Darwin execution or
service lifecycle are not targets; on macOS, Factory runs inside a Linux VM or equivalent Linux
guest rather than as a `launchd` service.

Factory's target capabilities are:

- the Codex plugin and a formally packaged `@clockgrove/factory` npm CLI/controller;
- local Codex SDK workers, with Codex CLI fallback and adaptive Linux CPU and memory admission;
- GitHub Objectives, native Work Item sub-issues and dependencies, and GitHub-only durable state;
- native stacked pull requests with concurrent execution and cascading revalidation, plus a recorded
  regular-PR fallback that conservatively runs one complete Work Item pipeline at a time so a
  sibling merge cannot invalidate another Work Item's validated base;
- GitHub Copilot and OpenAI Codex managed-agent release targets, subject to explicit session and
  spending limits and the live identity/provider gates in `docs/CONFORMANCE.md`;
- local-to-cloud burst through Daytona, with hard TTL, concurrency, credential, and cost boundaries;
- independent validation, crash recovery, cancellation, replay, explanation, and economic evidence.

Labs contains Vercel Sandbox, Codex App Server, and additional harness/provider adapters. Labs
features are bundled where useful but are not part of the initial delivery scope. Coordinating
multiple local machines, native Windows/macOS lifecycle support, a custom UI, and a required hosted
Factory service are deliberately out of scope.

The authoritative contract and failure model are in [docs/DESIGN.md](docs/DESIGN.md). The concrete
priority and local-to-cloud burst implementation is specified in
[docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md](docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).
The accepted product scope, chat/MCP boundary, repository controller, cost-aware compiler, durable
Codex sessions, native stacked-PR delivery, and implementation details are specified in
[docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md](docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md).
The active task waves and completion checks are in
[docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md).

## Install and activate

### TL;DR

Start with **[the local runner quick start](docs/setup/local.md)**: install the plugin in your Linux
agent environment, authenticate GitHub and Codex there, then ask the Director to inspect your
Objective and absolute checkout before authorizing execution. No sandbox account, npm/npx install,
Factory GitHub workflow, or cloud spending permission is needed for the plugin's local path.
See [verification status](docs/CONFORMANCE.md) for current installation limitations.

### Choose your setup

| Goal | Guide |
|---|---|
| First run on Linux, WSL2, or a Linux guest on macOS | [Local runner](docs/setup/local.md) |
| Continue working after chat disconnects | [Unattended controller](docs/setup/unattended.md) |
| Add sandbox execution or local-to-cloud burst | [Daytona](docs/setup/daytona.md) |
| Use GitHub-managed coding agents | [Managed agents](docs/setup/github-managed.md) |
| Try alternative Labs runners | [Vercel Sandbox](docs/setup/vercel-sandbox.md) · [Codex App Server](docs/setup/codex-app-server.md) |

The **plugin is the entry point**, the **controller supplies unattended scheduling**, and the
**runner executes work**. Installing the plugin neither starts a service nor authenticates a cloud
provider. Configure credentials on the executing Linux process—not in the target repo. Credentials
and permission to spend are separate.

Each [setup guide](docs/setup/README.md) has a TL;DR followed by detailed instructions and checks.
For exact environment placement, service boundaries, paid-capacity gates, and troubleshooting, see
[shared runner configuration](docs/setup/configuration.md).

## Inspect through chat or MCP

The Director skill uses bounded, read-only operations when the user is inspecting a run:

- `factory_status` returns the current Objective/run state, active and queued Work Items, resource
  pressure, burst activity, and aggregate execution economics.
- `factory_explain` returns stable reason codes, policy gates, observed evidence, and the concrete
  action needed to unblock waiting or escalated work.
- `factory_replay` reconstructs durable scheduling receipts and can replay a credential-free pinned
  admission snapshot without writing GitHub or launching a worker.
- `factory_recovery_plan` inspects historical work, graph/PR evidence, and cumulative recorded usage
  after escalation. Its CLI equivalent is `factory recovery-plan OWNER/REPO#NUMBER`. It neither
  authorizes execution nor resets budgets.
- `factory_recovery_propose` builds a read-only, digest-bound successor plan. With explicit user
  authorization, `factory_recovery_request` records that exact plan for controller adoption;
  it preserves the original issues and cumulative allowance. Resource and evidence checks still
  gate execution. See [terminal recovery](docs/setup/unattended.md#continue-after-terminal-escalation).

These reports mark unavailable observations explicitly. They do not invent token counts, provider
costs, capacity readings, or timing data that were not durably observed.

## Policy and paid backends

The default policy is exported as `DEFAULT_RUN_POLICY`. A complete JSON override looks like:

```json
{
  "backendOrder": ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
  "maxParallel": 8,
  "workItemTimeoutMinutes": 30,
  "objectiveTimeoutMinutes": 720,
  "maxAttemptsPerItem": 3,
  "allowedPaidBackends": [],
  "cloudFallback": "never",
  "maxSandboxMinutes": 0,
  "maxManagedAgentSessions": 0,
  "trust": "explicitly_activated_repo",
  "managementBackend": "codex-cli/local",
  "allowedNetworkDestinations": [
    "registry.npmjs.org",
    "*.npmjs.org",
    "api.openai.com"
  ],
  "priority": {
    "source": "subissue-order",
    "unsetRank": 100,
    "onUnavailable": "fallback-to-subissue-order"
  },
  "capacity": {
    "mode": "adaptive-local",
    "local": {
      "maxWorkers": 8,
      "defaultCpu": 1,
      "defaultMemoryMb": 2048,
      "reserveCpu": 0.5,
      "reserveMemoryMb": 1024,
      "minimumFreeMemoryMb": 1024,
      "maxLoadRatio": 0.9,
      "maxMemoryUsageRatio": 0.85,
      "sampleIntervalSeconds": 5,
      "admissionCooldownSeconds": 10
    }
  },
  "burst": {
    "mode": "never",
    "backendOrder": [],
    "maxCloudParallel": 1,
    "queueDelaySeconds": 120,
    "deadlineReserveMinutes": 60,
    "maxPriorityRank": 1000
  },
  "delivery": {
    "mode": "regular-prs",
    "onUnavailable": "regular-prs",
    "merge": "bottom-up"
  }
}
```

Set `delivery.mode` to `stacked-prs` to request native stacks. Factory pins the GitHub stack adapter
to API version `2026-03-10`, probes repository capability before compilation spend, and never
silently changes the recorded delivery selection after publication begins.

To use Daytona, put `codex-cli/daytona` in both `backendOrder` and `allowedPaidBackends`, set
`cloudFallback` to `explicit`, and provide a nonzero sandbox-minute cap. Sandbox validation consumes
its own reservation because it runs in a fresh resource, separate from the worker. Once their
publication-blocking live gates pass, GitHub-managed Copilot and Codex sessions likewise require
explicit managed-session authority. The Codex profile remains unavailable until its gate records a
stable provider-published identity. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for
provider-specific credentials and boundaries.

Optional economics and model-routing policy is evidence-bound. Factory accepts only a
`models.mode` of `single-profile`; all four `phaseProfiles` entries must name the same explicit model
and supported reasoning effort. `task-class` and explicit model routing to GitHub-managed agents are
rejected rather than ignored. `economics.minCloudTimeSavedMinutes` admits overflow burst only when a
Work Packet has a sufficient configured `estimatedDurationMinutes`; missing evidence fails closed.
`economics.maxModelTokens` is a stop-before-next-call threshold over durably observed management and
reporting local-worker tokens, not a provider hard cap. Already-started concurrent invocations can
each overshoot it, and opaque sandbox/managed-agent token use remains unavailable and bounded by
minutes or sessions.

Vercel Sandbox and Codex App Server are Labs adapters. They use the same execution contract but are
not part of the initial delivery scope.

Use native sub-issue order as the zero-configuration priority. To configure an organization
single-select issue field, inspect its stable field and option IDs without writing GitHub:

```bash
node dist/factory.js priority-fields OWNER/REPO
```

Probe without creating paid resources:

```bash
node dist/factory.js backends probe
```

## Safety and escalation

Factory checks repository identity, Objective provenance, fork status, branch rules, backend
capabilities, trust boundary, credentials, and remaining budget before launch. It rejects artifacts
with a wrong base, out-of-scope paths, sensitive execution surfaces, suspected secrets, malformed
evidence, or a validated tree that differs from the tree being published.

Local Codex workers never wait on an approval prompt. They stay inside `workspace-write`, run with
web search and command networking off by default, and receive only the Work Packet's preflighted
domain allowlist when command networking is required. Provider workers run inside an explicitly
selected boundary: Daytona supplies provider-enforced TTL and egress policy, while GitHub-managed
agents are bounded by provider capability, session budget, and exact-head artifact collection.
Local execution is for trusted code: temporary homes, environment filtering, and disabled credential
helpers prevent conventional ambient credential discovery, but a same-user local process is not a
hardened confidentiality boundary and can attempt to read an already-known absolute host path.

It escalates with evidence when autonomy would require human review, unavailable credentials,
privileged/destructive changes, unsupported branch rules, exhausted budgets, repeated failure, or
semantic judgment below the acceptance bar.

Retries receive the prior attempt's bounded failure evidence as explicitly untrusted diagnostic
data. Factory never widens scope, trust, backend permissions, or budget to make a retry succeed.

## Development

```bash
npm ci
npm run verify:release
```

`verify:dist` rebuilds into a temporary directory and verifies that the committed bundles match.
`verify:package` validates every manifest/skill/schema, starts the bundled MCP server with no token,
installs a staged copy through an isolated Codex home, and starts both installed executables without
using worktree configuration. `verify:release` also runs the full test suite, typecheck, and
production dependency audit. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules.

Current release evidence and the external gates that still require real provider credentials or a
published installation are tracked in [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

Factory is MIT licensed. See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md),
[SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing or reporting a problem.
