# Factory operating reference

[Back to Factory](../README.md) · [Local quick start](setup/local.md)

Detailed inspection tools, execution scope, default policy, provider limits, and safety boundaries.
Start with the quick start before configuring an unattended run.

## Scope

Factory executes on Linux. The supported host configurations are native Linux, a Linux distribution
under Windows WSL2, and a Linux guest hosted by macOS. The repository, controller, worktrees, locks,
and credentials stay inside the Linux filesystem. Native Win32 and native Darwin execution or
service lifecycle are not targets; on macOS, Factory runs inside a Linux VM or equivalent Linux
guest rather than as a `launchd` service.

Factory's target capabilities are:

- the Codex plugin and a formally packaged `@clockgrove/factory` npm CLI/controller;
- local Codex SDK workers, with Codex CLI fallback and adaptive Linux CPU and memory admission;
- fair sharing across Objectives on one computer, and explicit durable App Server sessions with
  exact terminal recovery and documented provider limits;
- GitHub Objectives, native Work Item sub-issues and dependencies, and GitHub-only durable state;
- concurrent regular or native stacked pull requests, with serialized integration and exact-head
  revalidation when an authenticated sibling advances the base;
- optional managed-agent integrations with per-provider capability limits: Copilot has limited
  automation; Codex managed execution remains unavailable pending a real identity/lifecycle interface;
- local-to-cloud burst through Daytona, with hard TTL, concurrency, credential, and cost boundaries;
- independent validation, crash recovery, cancellation, replay, explanation, and economic evidence.
- verified local LFS assets, content-bound input and repository-result manifests, and bounded
  large-file transport across passive formats.

Labs contains Vercel Sandbox and additional harness/provider adapters. Labs
features are bundled where useful but are not part of the initial delivery scope. Coordinating
multiple local machines, native Windows/macOS lifecycle support, a custom UI, and a required hosted
Factory service are deliberately out of scope.

For operating boundaries, see [host scheduling](HOST-SCHEDULING.md) and the
[threat model](THREAT-MODEL.md). Contributors can read the
[design contract in the source repository](https://github.com/clockgrove/factory/blob/main/docs/DESIGN.md).

## Inspect through chat or MCP

The Director skill uses bounded, read-only operations when the user is inspecting a run:

- `factory_discover_objectives` finds open Objective candidates when the repository is known but
  the issue number is omitted. It reports whether its fixed scan was complete and never reads issue
  bodies, invokes a model, changes GitHub, or grants execution authority.
- `factory_doctor` checks the requested repository and checkout, GitHub access and branch rules,
  available runners, repository-specific validation tools, measured Linux resource headroom, and
  Objective asset-handler readiness.
- `factory_assets_import` explicitly captures bounded local files or recognized GitHub attachments
  into an immutable Objective asset manifest. `factory_assets_inspect` reads a manifest by its
  pinned SHA-256 digest. See [Objective input assets](OBJECTIVE-ASSETS.md) for supported handlers,
  opaque-content policy, rights/visibility checks and offline materialization.
- `factory_asset_status` inspects one authenticated immutable Asset Set. `factory_asset_export`
  materializes one exact descriptor from its verified immutable content transfer into Factory's
  private read-only review directory and returns the local path plus complete descriptor and receipt
  metadata. `factory_asset_approve`, `factory_asset_reject`, and `factory_asset_revise` record a
  request-indexed review decision; approval also publishes the exact activation used by dependent
  Worker Packets. The CLI forms are `factory asset-status`, `asset-export`, `asset-approve`,
  `asset-reject`, and `asset-revise`. See
  [produced asset lifecycle](OBJECTIVE-ASSETS.md#produced-asset-lifecycle).
- `factory_plan` inspects existing Work Items without model execution. Explicit `compile: true`
  compiles a proposed graph against a clean selected checkout without creating issues or starting
  workers. Pass `assetManifestDigest` to bind an imported manifest for media planning. Compilation
  consumes model quota; its usage is returned, not persisted as run authority.
- `factory_status` returns the current Objective/run state, active and queued Work Items, resource
  pressure, burst activity, and aggregate execution economics. Current GitHub response-header quota
  observations and process-local mutation counters are reported separately with their measurement
  scope/window; absent durable run-attributed mutation measurements remain unavailable. Its
  `operatorAction` says whether autonomous progress remains monitorable or the state is stopped and
  requires one concrete operator action.
- `factory_explain` returns stable reason codes, policy gates, observed evidence, and the concrete
  action needed to unblock waiting or escalated work.
- `factory_replay` reconstructs durable scheduling receipts and can replay a credential-free pinned
  admission snapshot without writing GitHub or launching a worker. Supply an optional
  `pinnedAdmissionSnapshots` array, or use `factory replay OWNER/REPO#NUMBER --snapshots FILE`
  with a JSON array in an explicitly named regular file (symlinks are rejected).
  The [collection schema](../schemas/replay-snapshots.schema.json) limits input to 8 snapshots,
  1 MiB of UTF-8 JSON, depth 32 and 100,000 JSON values; every snapshot must match the requested
  Objective and pass its policy/snapshot digest checks. Results distinguish authenticated receipt
  reconstruction from recomputation of caller-supplied hypothetical inputs. A reproduced simulation
  does not authenticate its inputs as historical facts or grant execution authority. Omitting the
  array/file retains receipt-only inspection; Factory does not capture or invent missing snapshots.
- `factory_recovery_plan` inspects historical work, graph/PR evidence, and cumulative recorded usage
  after escalation. Its CLI equivalent is `factory recovery-plan OWNER/REPO#NUMBER`. It neither
  authorizes execution nor resets budgets.
- `factory_recovery_propose` builds a read-only, digest-bound successor plan. With explicit user
  authorization, `factory_recovery_request` records that exact plan for controller adoption;
  it preserves the original issues and cumulative allowance. Resource and evidence checks still
  gate execution. An evaluated compiler that exhausted its fully explicit auto-repair envelope
  before graph projection may use one successor with the exact same five-field
  `compilerEvaluation` policy. Its plan contains no invented Work Items, and authenticated
  projection supplies execution identities only after compilation. Factory does not translate an
  older compiler receipt or add a missing compiler policy during recovery.
  The proposal's `operatorAction` distinguishes evidence blockers, exact unknown
  usage acknowledgement, and a ready-but-unauthorized request; none is active work to poll. See
  [terminal recovery](setup/unattended.md#continue-after-terminal-escalation).

These reports mark unavailable observations explicitly. They do not invent token counts, provider
costs, capacity readings, or timing data that were not durably observed.

## Policy and paid backends

The default policy is exported as `DEFAULT_RUN_POLICY`. A complete JSON override looks like:

`workItemTimeoutMinutes` is the maximum duration of one supervised execution attempt or management
model invocation. Each use is additionally capped by the remaining authenticated Objective time.

```json
{
  "backendOrder": ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
  "maxParallel": 2,
  "workItemTimeoutMinutes": 30,
  "objectiveTimeoutMinutes": 720,
  "maxAttemptsPerItem": 3,
  "allowedPaidBackends": [],
  "cloudFallback": "never",
  "maxSandboxMinutes": 0,
  "maxManagedAgentSessions": 0,
  "trust": "explicitly_activated_repo",
  "managementBackend": "codex-cli/local",
  "compilerEvaluation": {
    "mode": "auto-repair",
    "maxRepairs": 2,
    "maxInvocations": 7,
    "timeoutSeconds": 600,
    "maxObservedTokens": 500000
  },
  "compilerMediaEgress": {
    "mode": "denied",
    "maxAssets": 0,
    "deterministicReviewRuleIds": []
  },
  "repositoryCaptureEgress": {
    "deterministicGateIds": [],
    "review": {
      "mode": "denied",
      "maxAssets": 0,
      "reviewerCapabilityIds": []
    }
  },
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
    "mode": "fixed",
    "local": {
      "maxWorkers": 2,
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

Media compiler inputs use authority separate from ordinary network policy. `denied` is the
default. `public-assets` or `private-assets` requires a positive `maxAssets`; deterministic review
rules must be named explicitly. Select the exact manifest on `factory_activate` with
`assetManifestDigest` (CLI `--asset-manifest-digest`). That digest is immutable run identity and is
checked again on resume. See [Objective input assets](OBJECTIVE-ASSETS.md#compiler-media-intents).

Repository-result capture has an explicit deterministic-gate allowlist and an independent semantic
review egress grant, which is denied by default. Local and isolated capture commands receive no
expected bytes. Exact comparison uses the returned content digest, while threshold comparison runs
afterward in Factory through the installed trusted comparator. Repository commands cannot provide
the certified scalar. The ordinary backend and network policy must still authorize any provider
destination used for isolated validation.

Semantic review uses the independent `review` gate. Name the selected management adapter's exact
reviewer capability ID and bound the complete unique-payload expected-plus-observed bundle. Recipe,
role, source-path and expected/observed associations remain as bounded uses when one payload serves
several comparisons. The
installed Codex CLI adapter advertises `codex-cli-repository-capture`, at most 64 assets, and semantic
handlers for JSON, inert UTF-8 text/Markdown, and supported raster files. Its capability also declares
allowed MIME types, optional typed profiles, visibility classes, rights bases and the `api.openai.com`
destination. Factory intersects every field with the immutable run policy before reading or
materializing any review byte. `public-assets` excludes private content. `private-assets` permits its
disclosure only when the adapter supports the exact visibility, rights basis, handler and MIME type
and `allowedNetworkDestinations` includes every adapter destination. Opaque bytes can satisfy exact
mechanical equality but cannot enter semantic review without an installed semantic handler. See
[repository-result capture](OBJECTIVE-ASSETS.md#repository-result-capture).

This compiler envelope is recorded for every new activation that omits policy. Its repair count is
shared across obligation-inventory and graph correction, and its invocation and timeout values bound
the whole evaluation. `maxObservedTokens` stops admission before the next invocation after observed
usage reaches the threshold; it is not a hard provider cap and an in-flight call can overshoot it.
Status lists each immutable compiler invocation and cumulative observed usage. Historical and
caller-supplied policies without the field keep their exact digest and single-proposal authority.

The default keeps a fixed two-worker ceiling and still applies CPU, memory and shared-resource
safety checks. Explicitly set `capacity.mode` to `adaptive-local` and your desired worker ceilings
to enable adaptive concurrency. Making adaptive scheduling the default retains its live
qualification prerequisite; existing runs always keep their recorded policy.

Set `delivery.mode` to `stacked-prs` to request native stacks. Factory pins the GitHub stack adapter
to API version `2026-03-10`, probes repository capability before compilation spend, and never
silently changes the recorded delivery selection after publication begins.

To use Daytona, put `codex-cli/daytona` in both `backendOrder` and `allowedPaidBackends`, set
`cloudFallback` to `explicit`, and provide a nonzero sandbox-minute cap. Sandbox validation consumes
its own reservation because it runs in a fresh resource, separate from the worker. Managed execution
also requires explicit session authority and qualification of the specific provider capability being
claimed. Copilot cannot automatically stop an active task through its documented API; some outcomes
require the operator's exact-session intervention. Codex managed execution remains unavailable until
an authoritative identity and provider-specific lifecycle interface are implemented and qualified.
An unavailable third-party feature limits that integration, not the whole Factory release. See
[provider qualification](https://github.com/clockgrove/factory/blob/main/docs/PROVIDER-QUALIFICATION.md)
and [credentials](CREDENTIALS.md).

Optional economics and model-routing policy is evidence-bound. Factory accepts only a
`models.mode` of `single-profile`; all four `phaseProfiles` entries must name the same explicit model
and supported reasoning effort. `task-class` and explicit model routing to GitHub-managed agents are
rejected rather than ignored. `economics.minCloudTimeSavedMinutes` admits overflow burst only when a
Work Packet has a sufficient configured `estimatedDurationMinutes`; missing evidence fails closed.
For new requests, `economics.maxModelTokens` requires an explicit
`economics.modelTokenBudgetMode: "observed-stop"`. This is a stop-before-next-call threshold over
durably observed management and reporting local-worker tokens, not a provider hard cap.
Already-started concurrent invocations can each overshoot it. If you require `"hard"` enforcement,
Factory rejects the request before model work because its current model integrations cannot
enforce that ceiling. It never silently substitutes the observed mode. Resuming a run preserves its
recorded policy and usage. Opaque sandbox/managed-agent token use remains unavailable; Factory instead limits
authorized resource minutes or session admissions. Those limits are not guaranteed dollar caps.
Factory is open-source orchestration for providers with which the user has a direct relationship:
the user owns provider billing, subscriptions and provider-side spending limits. Unavailable costs
are not zero, and billing settlement finality is not a completion requirement. Unknown active compute,
resource ownership or cleanup still blocks unsafe replacement and further spending.

Vercel Sandbox is an optional Labs adapter. Codex App Server is a supported explicit local route,
not the default: its [session contract](CODEX-APP-SERVER-SESSIONS.md) distinguishes durable
terminal recovery from currently unavailable cold repair turns. Required qualification remains
visible in [verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md).

Use native sub-issue order as the zero-configuration priority. To configure an organization
single-select issue field, inspect its stable field and option IDs without writing GitHub:

```bash
node dist/factory.js priority-fields OWNER/REPO
```

Probe without creating paid resources:

```bash
node dist/factory.js backends probe
```

## Repository-result validation and delivery

An `evidence-for` recipe validates the repository artifact already produced by its Work Item. It
does not create an asset-production Work Item or another product. Factory runs ordinary validation,
then repository capture commands, and finally performs grounded thresholds inside its installed
comparator boundary. The recipe declares bounded
output roles and MIME identities; installed handlers supply any semantic parsing. Shared capture,
storage, policy and recovery contracts remain format-neutral. Raster is one optional typed profile,
and visual application fixtures exercise the same path as structured data or other bounded passive
outputs.

Before running capture commands, Factory journals an immutable invocation containing the exact
artifact, base, result tree, recipes, expected content identities, environment and egress policy.
The final invocation result, capture manifest, immutable content-transfer receipts and ordinary
validation evidence all bind that invocation and result tree. Semantic review has a separate durable
receipt that binds the validation evidence digest. A restart first looks for that exact result. For a
retained isolated validator, it recovers and checkpoints captured bytes before provider cleanup or
capacity reconciliation. Missing or ambiguous terminal command evidence blocks replay instead of
running the same command again.

Product delivery follows repository transport rather than capture MIME. Outputs within the ordinary
artifact bounds use Git blobs. A changed path may use Git LFS only when the pinned base already
assigns that exact path `filter=lfs`. Factory requires the installed Git LFS CLI, the repository's
authenticated effective endpoint, a destination allowed by `allowedNetworkDestinations`, and
preflighted credentials. It retains the raw output through the normal immutable artifact transfer,
uploads the exact SHA-256 object, independently reads and verifies it, and commits the canonical LFS
pointer. Artifact identity includes the assignment, tool, endpoint, raw transfer, upload and read-back
receipts.

Native rebase, sibling, merge-candidate and adopted-source reconstruction authenticates the original
artifact receipt and raw transfer under the source attempt reservation. Factory verifies the exact
canonical pointer and then creates a fresh receipt bound to the candidate target base and current
run. Adopted-source reads remain predecessor-bound while writes require the accepted recovery plan
and current successor lease. Stale authority or a pointer-only Git range is refused before LFS
upload or publication.

Factory does not add or modify LFS tracking, accept pointer-only worker output, use custom transfer
agents, or infer LFS from file type. Repository-capture evidence continues through the separate
validation-evidence store. The current LFS output hydration and validation path is host-local;
Daytona and Vercel validators reject an artifact with LFS output receipts before provider creation.
See [large-file support](LARGE-FILES.md#existing-lfs-repositories) for exact size and repository
preconditions.

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
