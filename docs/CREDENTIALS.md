# Credentials and execution boundaries

Factory separates Director credentials from worker credentials. The Supervisor may use GitHub; an
implementation worker may not.

## Core local operation

Factory resolves GitHub authentication from `GITHUB_TOKEN`, then `GH_TOKEN`, then the existing
`gh auth` session. It does not persist or print the token. The token needs access to the target
repository's issues, pull requests, contents, and custom Git refs.

The local Codex CLI backend uses the operator's existing Codex login unless an explicitly configured
model credential or local inference provider is selected. It creates a temporary `CODEX_HOME`, links
only the auth file, removes GitHub and ambient secret variables, disables interactive Git credential
helpers, and deletes the temporary home after the attempt. Every unattended invocation uses
`--ask-for-approval never`: a request outside the configured sandbox fails instead of becoming an
approval queue. Management calls are read-only with command networking and web search disabled.
Implementation workers use `workspace-write`; command networking is off unless the preflighted Work
Packet names destinations, in which case Factory enables Codex's network proxy with exactly those
allow-first domain rules. Web search remains disabled because it is outside the command proxy.

Installing Factory creates no repository secret, environment, workflow, service account, or daemon.

## Daytona

Daytona requires its normal SDK authentication (`DAYTONA_API_KEY`, or the documented JWT plus
organization identity). The worker's model credential is not copied from the host environment.
`FACTORY_DAYTONA_MODEL_SECRET` must name a Daytona organization Secret; Factory maps that named
secret to `OPENAI_API_KEY` inside the ephemeral worker.

Independent validation creates a second ephemeral Daytona sandbox and receives no model credential.
Both resources use hard TTLs, deterministic labels/names, an allow-listed domain policy, and
best-effort deletion on completion. Codex runs without its inner OS sandbox only inside this outer,
provider-enforced sandbox boundary. The configured provider-side spending cap remains the absolute
limit during a host/network partition.

## Vercel Sandbox

Vercel Sandbox requires `VERCEL_OIDC_TOKEN` and a host `OPENAI_API_KEY` for the worker. The worker
process sees only a placeholder; Vercel's network-policy transformer injects the real Authorization
header solely for `api.openai.com`.

Independent validation uses a fresh non-persistent microVM with no model key. Worker and validator
resources have hard timeouts, deterministic tags/names, restricted egress, and are stopped after use.

## GitHub managed compatibility backend

`github-copilot/github-managed` uses the Director's GitHub identity and the repository's assignable
coding-agent integration. It is an explicit paid compatibility backend, never the default. Because
the managed worker publishes its own branch and pull request, Factory collects that exact diff,
validates it independently, and refuses integration unless the remote head tree equals the validated
tree.

## Named secrets in Work Items

A Worker Packet may declare secret names that policy could permit; it never contains values. Factory
v2 currently brokers only the model credential mechanisms documented above. It does not inject
arbitrary named application secrets. A Work Item requiring one therefore needs a future audited
broker adapter or human handling; it must not receive ambient host credentials as a workaround.
