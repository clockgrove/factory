# Factory

> [!IMPORTANT]
> Factory v2 is being prepared as a preview release. The preview label applies to the product as a
> whole; capabilities in the v2 contract are held to one conformance standard instead of receiving
> separate maturity labels.

Factory is a catalyst and multiplier for an indie developer or small trusted team. It turns one
developer, one computer, and the AI agents they already use into a coordinated software studio. A
human writes an Objective; Factory compiles it into native GitHub sub-issues, schedules
dependency-ready Work Items, runs coding workers, independently validates their artifacts, opens and
integrates pull requests, and continues until the Objective ships or a specific human decision is
required.

Factory is not a coding-agent competitor. Codex, Claude Code, and other agent runtimes perform the
engineering work; Factory supplies the cost-aware compiler, local-first scheduler, durable GitHub
protocol, recovery loop, and pull-request integration that make those sessions work as one system.
Its optimization target is validated progress per dollar and per hour, not raw concurrency.

Factory does **not** require a Factory GitHub Action, workflow, hosted service, database, queue, or
sidecar state. The plugin supplies the orchestration code. GitHub supplies the durable control plane.
A local repository controller supplies the scheduler and reconstructs durable state from GitHub
after restart. Opting into a GitHub-managed coding agent is different: that provider session can
consume GitHub Actions minutes even though Factory installs no workflow.

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

## Product contract

- Work Items are GitHub sub-issues; dependencies are native `blocked by` relationships.
- Pull requests are regular siblings by default. An explicit `stacked-prs` policy uses native GitHub
  stacks after a repository capability probe; an unavailable capability is durably recorded before
  the configured regular-PR fallback or escalation.
- Versioned run, lease, graph, attempt, validation, and budget receipts are reconstructable from
  GitHub. The full compiled graph is stored under an immutable custom ref before the first sub-issue
  is created, so a partial graph application replays facts without another model call. A second
  immutable ref plus an authenticated Objective receipt seal the completed
  compiler-ID-to-GitHub-issue mapping before execution, preventing moved or swapped sub-issues from
  inheriting another Work Item's history after restart.
- Authenticated Objective comments are the single atomic request journal for chat, MCP, and CLI
  commands. Request IDs are normalized through one semantic comparison; response-loss retries may
  create an identical comment, but replay applies those at-least-once duplicates only once and fails
  closed if the same request ID carries different meaning.
- One compare-and-swap Director lease fences competing schedulers per Objective.
- Workers receive no GitHub mutation or merge authority. The host publishes only a bounded,
  content-addressed artifact after independent validation.
- Trusted work runs through the Codex SDK in an exact-SHA local Git worktree by default. Codex CLI
  remains the supported portable fallback.
- Daytona is the supported third-party sandbox target. Factory bundles GitHub Copilot and OpenAI
  Codex managed-agent profiles, but the v2 preview is publication-blocked until both live gates pass.
  The Codex profile deliberately remains unavailable until live conformance records a stable,
  provider-published identity; Factory does not guess one from a display name. All paid execution is
  opt-in, and there is no implicit cloud fallback.
- Mechanical polling never calls a model. Model calls are bounded compilation and semantic-review
  decisions.
- Publication receipts bind every PR to its planned position, base SHA, exact published head, and
  independent validation digest. A lower-layer head change invalidates affected descendants before
  revalidation or integration, and asynchronous stack merges resume from durable GitHub receipts.
- Work Item count is derived from the work. It is never hard-coded.

## V2 preview support boundary

Factory executes on Linux. The supported host configurations are native Linux, a Linux distribution
under Windows WSL2, and a Linux guest hosted by macOS. The repository, controller, worktrees, locks,
and credentials stay inside the Linux filesystem. Native Win32 and native Darwin execution or
service lifecycle are not targets; on macOS, Factory runs inside a Linux VM or equivalent Linux
guest rather than as a `launchd` service.

The v2 preview contract includes:

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
features are bundled where useful but are not required to pass the v2 release matrix. Coordinating
multiple local machines, native Windows/macOS lifecycle support, a custom UI, and a required hosted
Factory service are deliberately out of scope.

The authoritative contract and failure model are in [docs/DESIGN.md](docs/DESIGN.md). The concrete
priority and local-to-cloud burst implementation is specified in
[docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md](docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).
The accepted product scope, chat/MCP boundary, repository controller, cost-aware compiler, durable
Codex sessions, native stacked-PR delivery, and ordered release plan are specified in
[docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md](docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md).
The active release goal, workstreams, and final exit sequence are in
[docs/V2-PREVIEW-RELEASE.md](docs/V2-PREVIEW-RELEASE.md).
The original GitHub-Copilot-specific protocol is preserved in
[docs/PROTOCOL-V1.md](docs/PROTOCOL-V1.md) only for compatibility with already-running work.

## Install and activate

Factory v2's distribution contract has two synchronized artifacts: the Agent Plugins package from
`clockgrove/factory` for chat/MCP use, and `@clockgrove/factory` on npm for the `factory` CLI and
repository controller. Installing either artifact runs no lifecycle scripts, changes no repository,
and starts no daemon. Until the npm `next` artifact has passed the published-artifact gate in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md), use the plugin installation supported by your client or
the source-checkout command below rather than assuming the npm package is available.

After the npm preview is published, the controller installation path is:

```bash
npm install --global @clockgrove/factory@next
factory --help
```

Install the plugin using your Agent Plugins-compatible client, then restart the client so its skills
and bundled MCP server are reloaded. Provider SDK code required by shipped adapters is included in
the committed JavaScript bundle. The plugin artifact does not carry a platform-specific Codex
executable: using the default local Codex SDK worker requires a compatible `codex` CLI on `PATH`.
The npm artifact supplies the pinned Codex CLI transitively.

Authenticate GitHub on the host with `gh auth login`, or expose `GITHUB_TOKEN`/`GH_TOKEN` to the
plugin process. Installing the plugin does not install a GitHub Action and does not activate any
repository.

In a supported harness, invoke the `director` skill with:

- `OWNER/REPO#OBJECTIVE`
- the absolute local checkout path
- an optional complete run-policy object

For unattended work, the skill checks the host, installs/starts one explicitly authorized
repository controller, and writes a durable `factory_activate` request. The chat can then disconnect;
the controller reconstructs work from GitHub. The authenticated Objective comment—not an in-memory
MCP queue—is the cross-process journal; centralized request-ID semantics make exact duplicate writes
safe after a lost response. For one-shot interactive work, the skill can instead make one long-lived
`factory_run` call. Both modes default to
`codex-sdk/local-worktree`, fall back to `codex-cli/local-worktree`, adapt admission to CPU and memory
headroom up to eight workers, and never use paid compute. The equivalent foreground source-checkout
command is:

```bash
npm ci
npm run build
node dist/factory.js run OWNER/REPO#OBJECTIVE --until-terminal --repo /absolute/repo/path
```

The process survives ordinary worker failures and reconstructs interrupted work from GitHub when
restarted. It cannot wake a powered-off machine. The repository controller provides one fenced
service per checkout. Each running controller has one random identity and repository-lease epoch;
every Objective Supervisor it starts carries that same observation, and restart/takeover establishes
a new fenced identity rather than impersonating the prior process. The service can be installed into
an explicitly authorized host scheduler for login or boot recovery. See
[docs/HOST-SCHEDULING.md](docs/HOST-SCHEDULING.md) for the supported Linux environment boundary.

Request a fenced cancellation from another shell with:

```bash
node dist/factory.js cancel OWNER/REPO#OBJECTIVE --request-id cancel-001 --reason "operator request"
```

The request is a durable GitHub event. The active Supervisor stops workers, records terminal attempt
and run receipts, and releases the lease; killing a process is not used as the cancellation record.

## Inspect through chat or MCP

The Director skill uses bounded, read-only operations when the user is inspecting a run:

- `factory_status` returns the current Objective/run state, active and queued Work Items, resource
  pressure, burst activity, and aggregate execution economics.
- `factory_explain` returns stable reason codes, policy gates, observed evidence, and the concrete
  action needed to unblock waiting or escalated work.
- `factory_replay` reconstructs durable scheduling receipts and can replay a credential-free pinned
  admission snapshot without writing GitHub or launching a worker.

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

Optional economics and model-routing policy is evidence-bound. V2 accepts only a
`models.mode` of `single-profile`; all four `phaseProfiles` entries must name the same explicit model
and supported reasoning effort. `task-class` and explicit model routing to GitHub-managed agents are
rejected rather than ignored. `economics.minCloudTimeSavedMinutes` admits overflow burst only when a
Work Packet has a sufficient configured `estimatedDurationMinutes`; missing evidence fails closed.
`economics.maxModelTokens` is a stop-before-next-call threshold over durably observed management and
reporting local-worker tokens, not a provider hard cap. Already-started concurrent invocations can
each overshoot it, and opaque sandbox/managed-agent token use remains unavailable and bounded by
minutes or sessions.

Vercel Sandbox and Codex App Server are Labs adapters. They use the same execution contract but are
not part of the v2 release matrix.

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
