# OpenAI managed execution

This adapter runs a Work Item in an OpenAI-hosted environment through the Agents
API. Factory still owns planning, independent review, scheduling, media selection,
validation and GitHub delivery. It does not use the Agents SDK or replace the local
Codex harness.

**Qualification status:** development candidate for [#258](https://github.com/clockgrove/factory/issues/258).
Credential-free tests exercise the real Git and controller paths. Actual hosted
execution, publication isolation and cancellation cessation still require the
issue's public qualification; this document does not claim that proof exists.

## Using the adapter

Installing Factory does not authorize this provider, source disclosure or API
spending. First approve the target, source and asset scope, OpenAI project/model,
resource limits and spending authority. The controller uses an OpenAI Platform
API credential; local Codex login is not its substitute. Keep the key outside the
target checkout and outside worker input.

The existing `factory install` command retains local execution defaults. For an
explicitly authorized managed run, edit the printed installation configuration's
`execution` object and worker policy. For example, replace the model and resource
choices with the actual approved values:

```json
{
  "execution": {
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
  },
  "policy": {
    "network": "off",
    "allowedSecretNames": [],
    "deployments": "denied"
  }
}
```

This is a partial configuration example, not a complete installation file. Do not
put a secret value in it. The worker has disabled network access, no GitHub
credentials, no additional tools, plugins or vaults, and no provider subagents.
The controller requires network access to the API and GitHub. Models, container
sizes and the attempt deadline are explicit installation choices. Reported
provider capacity remains unknown; Factory still enforces configured concurrency.

Use the ordinary installed `plan`, `run`, `status` and `cancel` commands with the
matching configuration. Review the source before authorizing upload: the complete
pinned baseline and declared source/selected assets leave the controller. OpenAI
API data handling and account access must be acceptable for that target.

## Supported inputs and results

The initial transfer supports regular Git files and executable modes. It sends
only exact shallow baseline objects, without unrelated history or local Git
configuration. A setup command checks the archive digest and exact commit before
Factory submits the Work Item. Symlink and submodule baselines are rejected before
creating a session. The inline archive must fit the provider's 5 MiB per-file
limit; larger inputs currently require another execution mode.

The worker exports ordinary file bytes, including untracked files and declared
media staging, into a tar artifact. Factory checks session, environment, turn,
path, length and binding, rejects unsafe entries, and verifies every file against
the exported inventory of paths, modes, byte lengths and SHA-256 digests.
Deleted files and executable modes survive import. The normal media capture,
whole-AssetSet selection, target-owned LFS rules, secret scan and independent
acceptance then apply. An artifact, successful turn or final response is not
product acceptance. An output archive must fit the provider's 200 MiB file limit.

## Restart, cancellation and accounting

Factory saves provider identity and submission disposition in its existing
continuation snapshot. A stopped stream and an idle session do not establish
success. Restart reads current session and paginated turn/artifact history.
Unexpected additional turns stop the attempt.

A response lost in transit (network error, timeout, HTTP 408, 429 or 5xx) is
resolved without spending a step interruption:

- **Session create:** the API used here cannot list sessions by attempt tag, so
  the attempt ends at once as an interruption and the Work Item repeats with a
  fresh attempt. A session the lost request created never receives input, but
  it holds the input archive; see operator cleanup below.
- **Work Item input:** a recorded turn means the input was accepted, and the
  attempt continues. Without one, Factory cancels and deletes the session and
  repeats the Work Item with a fresh attempt.
- **Restart during hosted setup:** Factory waits for setup and submits the input.

Collection retries transient reads in place for up to two minutes before it
interrupts the step, which then reattaches to the same session. Any other
failure deletes the session and fails the attempt as an implementation failure,
so a repeated attempt never runs beside it. This includes a refused request, a
session that no longer exists (HTTP 404), a failed turn, a rejected result and a
passed attempt deadline.

The configured `timeoutSeconds` bounds the whole attempt, including setup and
artifact retrieval; each request uses only the remaining time. Each cleanup
receives a fresh window of the same duration, so cleanup resumed after an outage
still runs.

**Operator cleanup:** a lost create is recorded as a `possible-orphan`
diagnostic with the attempt identity and time (see `factory diagnostics`).
Delete any session with metadata `factory_attempt` equal to that attempt.

Cancellation requests a stop and then confirms owned environment disposition.
Successful collection retains its result, artifact identities and best-effort
usage before requesting session deletion. Failed cleanup remains visible and
prevents claiming resource cessation. Local failed transfers remain available for
diagnosis. Null usage is unknown, never zero; token counts do not establish the
complete model, tool and container bill.

## Building this adapter

The wire contract is pinned to `OpenAI-Beta: agents=v1` and the documented REST
resources. It uses Node's existing fetch rather than adding a second OpenAI SDK.
The pinned `tar` dependency parses provider-controlled archives; it avoids a
custom archive decoder. The shared execution checkpoint writes the existing
atomic snapshot before effects and rejects stale lifecycle writers. No new queue,
journal or provider control plane is introduced.

Official references: [hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted),
[session lifecycle](https://developers.openai.com/api/docs/guides/agents-api/sessions),
[artifacts and limits](https://developers.openai.com/api/docs/guides/agents-api/environments/files),
[usage](https://developers.openai.com/api/docs/guides/agents-api/observability).

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
