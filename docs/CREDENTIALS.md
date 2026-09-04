# Credentials and execution boundaries

Factory separates Director credentials from worker credentials. The Supervisor may use GitHub; an
implementation worker may not.

## Core local operation

Factory resolves GitHub authentication from `GITHUB_TOKEN`, then `GH_TOKEN`, then the existing
`gh auth` session. It does not persist or print the token. The token needs access to the target
repository's issues, pull requests, contents, and custom Git refs.

The preferred local backend uses the official Codex SDK; Codex CLI remains the supported portable
fallback. Both use the operator's existing Codex login unless an explicitly configured model
credential or local inference provider is selected. Factory creates a temporary `CODEX_HOME`, links
only the auth file, removes GitHub and ambient secret variables, disables interactive Git credential
helpers, and deletes the temporary home after the attempt. Every unattended invocation sets approval
policy to `never`: a request outside the configured sandbox fails instead of becoming an approval
queue. Management calls are read-only with command networking and web search disabled.
Implementation workers use `workspace-write`; command networking is off unless the preflighted Work
Packet names destinations, in which case Factory enables Codex's network proxy with exactly those
allow-first domain rules. Web search remains disabled because it is outside the command proxy.

These are conventional credential-isolation controls for explicitly trusted local work, not a
same-user confidentiality sandbox. Redirecting `HOME`, `XDG_CONFIG_HOME`, and related paths prevents
normal tool discovery, but it cannot make an already-known absolute path disappear. A local worker
may attempt to read files that the operator account and underlying Codex sandbox can read, including
credential files named by an absolute path. Do not route untrusted repositories, dependencies, or
commands to a local backend; use an explicitly authorized hardened sandbox or escalate.

Installing Factory creates no repository secret, environment, workflow, service account, or daemon.

## Release verification

The clean-install verifier copies only committed package surfaces into a temporary marketplace,
uses an isolated `CODEX_HOME`, removes environment variables whose names indicate tokens, keys,
credentials, cookies, passwords, authentication, or secrets, and explicitly blanks known Factory
provider credentials. It installs Factory with the real Codex plugin commands, starts the installed
MCP bundle, and runs the installed controller's read-only backend probe. The probe reports capability
and authentication availability but creates no worker, sandbox, session, repository mutation, or
billable resource.

Production dependency auditing is part of `npm run verify:release`. Live Daytona or managed-agent
conformance is a separate gate and requires explicit authorization for the
credentials, target repository, hard spending cap, and billable run. Passing a fake-provider or
credential-free package test is never presented as evidence that a paid provider was exercised.

## Daytona

Daytona requires its normal SDK authentication (`DAYTONA_API_KEY`, or the documented JWT plus
organization identity). The worker's model credential is not copied from the host environment.
`FACTORY_DAYTONA_MODEL_SECRET` must name a Daytona organization Secret; Factory maps that named
secret to `OPENAI_API_KEY` inside the ephemeral worker. Factory resolves its metadata before every
worker creation and requires exactly one exact-name match whose `hosts` is exactly
`["api.openai.com"]`. Empty hosts are unrestricted; wildcard or additional hosts fail closed. The
worker receives Daytona's opaque `dtn_secret_...` placeholder, and Daytona substitutes the value
only for requests to that host; Factory never reads the plaintext value.

Independent validation creates a second ephemeral Daytona sandbox and receives no model credential.
Both resources use hard TTLs, deterministic labels/names, an allow-listed domain policy, and
confirmed deletion on completion. A deletion failure retains the resource identity, blocks unsafe
replacement, and reports actionable leak evidence until reconciliation confirms absence; provider
TTL is the final bound. Validation result JSON is capped at 256 KiB and validation diagnostics at
64 KiB before streaming either file into host memory. Codex runs without its inner OS sandbox only
inside this outer, provider-enforced sandbox boundary. The configured provider-side spending cap remains the absolute
limit during a host/network partition.

## Vercel Sandbox (Labs)

Vercel Sandbox requires `VERCEL_OIDC_TOKEN` and a host `OPENAI_API_KEY` for the worker. The worker
process sees only a placeholder; Vercel's network-policy transformer injects the real Authorization
header solely for `api.openai.com`.

Independent validation uses a fresh non-persistent microVM with no model key. Worker and validator
resources have hard timeouts, deterministic tags/names, restricted egress, and are stopped after use.

Vercel Sandbox is a Labs adapter and is not required for the v2 release matrix.

## GitHub managed agents

`github-copilot/github-managed` uses the Director's GitHub identity and the repository's assignable
Copilot coding-agent integration. `openai-codex/github-managed` uses the corresponding OpenAI Codex
coding agent enabled through GitHub. Both are explicit paid release targets, never the default.
Factory does not receive either agent's model credential; the operator enables the agent for the
repository and authorizes a bounded number of managed sessions in the immutable run policy. These
provider sessions can consume GitHub Actions minutes even though Factory itself installs and
requires no GitHub Actions workflow.

GitHub documents the Copilot suggested-actor login used for discovery. It currently documents the
Codex GitHub App by display name but does not publish a stable suggested-actor login or app identity
that Factory can safely pin. The bundled Codex profile therefore reports unavailable until the live
release gate captures and records a stable provider-published identity. Factory never substitutes a
guessed login, fuzzy display-name match, or a different paid provider.

Because a managed worker publishes its own branch and pull request, Factory collects that exact
diff, validates it independently, and refuses integration unless the remote head tree equals the
validated tree. Missing agent policy, repository enablement, or assignability makes the provider
unavailable and cannot cause Factory to select a different paid backend implicitly.

## Codex App Server (Labs)

The App Server adapter uses the operator's existing local Codex authentication and speaks the local
`codex app-server` protocol. It is a Factory Labs integration, not a managed GitHub agent and not a
Factory-hosted service. The supported local v2 default remains the Codex SDK, with Codex CLI as its
portable fallback.

## Named secrets in Work Items

A Worker Packet may declare secret names that policy could permit; it never contains values. Factory
v2 currently brokers only the model credential mechanisms documented above. It does not inject
arbitrary named application secrets. A Work Item requiring one therefore needs a future audited
broker adapter or human handling; it must not receive ambient host credentials as a workaround.
