# Claude managed execution

Factory can run a Work Item through Anthropic Claude Managed Agents while keeping
planning, independent review, validation, media selection and GitHub delivery in
the controller. This adapter is a development candidate for
[#259](https://github.com/clockgrove/factory/issues/259). Credential-free tests
exercise the SDK and real Git collection. Hosted execution, isolation and
cessation still require public qualification; this is not a qualification claim.

## Using Factory with this provider

Use an approved Anthropic workspace, model and source scope under the account's
actual resource and spending limits. Installation alone does not grant provider
or disclosure authority. Keep the API credential outside the target repository;
local Claude or Codex login does not supply this API credential.

The installed configuration retains local execution by default. For an authorized
managed run, set `execution.kind` to `managed-agent`, `execution.provider` to
`claude-managed-agents`, and an explicit positive `execution.concurrency`. The
provider `execution.config` contains:

- `agentId`, positive `agentVersion`, `environmentId`, and `workspaceId`: approved
  provider identities, with the agent version pinned.
- `credentialEnv`: the environment-variable name containing the controller API key.
- `agent`: the complete expected resolved session agent snapshot, including model.
- `environment`: the expected cloud environment configuration. Packages must be
  empty, networking limited with no allowed hosts, package-manager or MCP access.
- Optional `timeoutSeconds`: positive attempt deadline, default 900 seconds.
- Optional `budgetCents`: positive integer string for an approved session list-cost
  threshold. A crossing request can exceed it; this is not a hard spending cap.

The agent allows only explicitly configured local file tools and bash, with the
default toolset disabled. Skills, MCP, provider subagents, vaults and GitHub
resources are excluded. Factory worker policy must deny network, secrets and
deployments. The controller still needs API and GitHub access. Configuration
checks detect known drift; they do not claim an atomic provider environment
snapshot. Reported provider capacity remains unknown, while Factory enforces the
operator's concurrency setting.

Use the ordinary installed plan, run, status and cancel commands with this
configuration. The complete exact baseline and declared selected/source assets
leave the controller; review their approved disclosure scope beforehand.

## Inputs, results and lifecycle

Factory transfers exact shallow Git baseline objects and regular file bytes,
without unrelated history or local Git configuration. Symlink and submodule
baselines are unsupported. Binary and LFS working bytes travel through a supplied
deterministic script, not model-written byte strings. Provider file size limits
still apply to the encoded input and result.

A bootstrap-only turn executes the supplied foreground script. Factory checks
complete provider tool history and the full base/tree/file receipt before sending
implementation instructions. It rejects intervening activity. This requires
exclusive ownership of each session; it is not remote attestation against
arbitrary outside administrators.

Result acceptance requires the recorded implementation turn, session-scoped output,
matching attempt/input/base identities, and verified paths, lengths and digests.
Output publication can lag an idle session. The normal collector checks returned
immutable asset bytes, owned paths, whole AssetSets and repository LFS policy.
Provider completion is not product acceptance.

## Restart and lost responses

Controller checkpoints record each submission before it is sent, and every
session carries the attempt identity as `factory_attempt` metadata. A lost
response interrupts the step, and the repeated step resolves it from the
provider (see [State and recovery](ARCHITECTURE.md#state-and-recovery)):

- **Session create:** Factory lists the agent's sessions created since the
  recorded submission time. It adopts the session tagged with the attempt, or
  creates one when none exists.
- **Bootstrap or implementation message:** Factory reads the session history.
  It continues when the exact message is recorded and sends it again when the
  session is idle with no new message. Anything else stops the session and
  repeats the Work Item with a fresh attempt.
- **Upload:** Factory uploads the file again. The orphaned file cannot be
  identified and is left behind.

A read that fails in transit (network error, timeout, HTTP 404, 408, 429 or
5xx) interrupts the step, which reattaches to the same session. Any other
failure, including a passed attempt deadline, stops the session and fails the
attempt as an implementation failure, so it gets a fresh attempt or a repair.
The session always stops first, so a repeated attempt never runs beside it.
Cancellation waits for interruption where needed,
then deletes every session tagged with the attempt and verifies absence.
Anthropic documents that session deletion removes its associated sandbox.
Factory preserves result and compact lifecycle/accounting receipts first, then
deletes its uploaded files separately. Deletion repeats until absence is
confirmed. It never deletes the reusable agent or environment.

Attempt and cleanup each receive one recorded deadline window. SDK mutation
retries are disabled. Missing usage remains unknown; token counts alone do not
prove complete charges.

## Building Factory's adapter

The implementation pins `@anthropic-ai/sdk` 0.129.0 and the
`managed-agents-2026-04-01` beta. Provider types and phases remain inside the
adapter; the controller uses the existing execution driver and checkpoint contract.
Run the Claude client, transfer and driver tests when changing it. These tests
make no hosted calls and do not substitute for #259's live acceptance.

The lifecycle contract is documented in Anthropic's
[session operations](https://platform.claude.com/docs/en/managed-agents/session-operations).

## Controller credentials and supervision

The configured credential variable belongs to this Factory installation. For
foreground execution, supply it securely in the controller environment.
`factory readiness --config /absolute/config.json` checks presence without
provider calls; it does not verify account access, billing or hosted support.
Local harness login and subscription routes remain unchanged.

For a background controller, use an existing owner-private regular file outside
the target checkout containing only the API key. Enter the value through your
secure local credential workflow; do not paste it into chat, issues or command
arguments. Keep the file owned by your user with mode `0600`. Register the service
with `factory supervisor install ... --credential-file NAME=/absolute/private/key`,
where `NAME` is the configured credential variable. Bind one file per credential
the configured providers need.
Factory uses systemd `LoadCredential` and retains only the variable name and file
reference. It never copies the key into configuration, service metadata, model
inputs or sandbox environment. A terminal export alone does not authenticate the
service. A LoadCredential-capable Linux user manager is required; unsupported
hosts must use foreground execution.

On each service start the credential is read from the systemd credential
directory into the provider client's private memory. Missing or empty explicit
credentials stop execution without falling back to ambient variables. Restore
the private file, then stop/start the service using the supported lifecycle; key
rotation takes effect on the next start. Unattended workers never ask for keys.
Factory-operated sandbox harness authentication is configured separately through
its provider-supported mechanism; controller keys are not forwarded.
