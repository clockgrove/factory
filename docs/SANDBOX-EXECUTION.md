# Sandbox execution

Factory's sandbox driver prepares a pinned repository and bound assets in a provider-owned
workspace, invokes the installed configured harness there, and imports verified ordinary
files and complete AssetSets for the existing validation and delivery path. A sandbox exit
is not acceptance. Managed agent tasks use a different execution driver.

Configure the project execution mode with an explicit provider identity, concurrency,
registered harness identity/configuration, and installed sandbox entrypoint argv:

```json
{
  "kind": "sandbox",
  "concurrency": 2,
  "provider": "your-provider@1",
  "harness": {
    "kind": "registered",
    "adapter": "your-harness@1",
    "config": {}
  },
  "argv": ["node", "/installed/your-sandbox-entry.mjs"]
}
```

The controller calls the package-root `composeWithSandbox(config, { identity, provider })`.
The provider implements the exported `SandboxProvider` infrastructure operations. Its
workspace path and resource/process identities must refer to that exact attempt. The trusted
`prepareRepository` operation fetches the named repository at the exact base SHA and
tree into `workspace/repo`, before any harness starts. It must remove every usable
GitHub credential, credential helper, auth-bearing remote and proxy authentication
capability before returning. A hidden plaintext token is not sufficient if the worker
can still use its placeholder to authenticate. Preparation credentials belong only to
the controller/provider implementation; they never enter configuration, serialized
handles, request files or harness argv. The adapter must refuse preparation when it
cannot establish this separation.

Uploads
and downloads transfer ordinary binary files with SHA-256 and byte counts; execution takes argv,
not a shell command. Cancellation requires confirmed removal of the owned sandbox and all its processes;
`destroy` supplies that proof. Unknown outcomes
and failed cleanup must throw. Provider credentials stay in the controller adapter and
are never included in the input archive or worker request.

The sandbox image must already contain Node, Git, the same installed Factory package and
the selected harness dependencies. Factory does not install or discover them remotely.
The configured entrypoint constructs the existing `LocalHarnessRegistration` inside that
process and passes it to the package-root `runSandboxHarness(registration)`. The helper
reads the serialized request, verifies the registration identity/configuration, and calls
that harness's ordinary start/observe/cancel/collect methods. A controller-side harness
object is never transported. Each invocation uses durable serialized harness identity;
the harness remains responsible for its declared restart-safe semantics and containment.

Factory checkpoints its resource/process identities in the existing atomic Work Item
snapshot before external mutations. A lost response interrupts the step, and the
repeated step resolves it:

- **Create:** `create` tags the sandbox with the attempt and adopts an existing tagged
  sandbox, so repeating it never makes a second one.
- **Preparation or harness start:** neither can repeat inside one sandbox, so Factory
  destroys the sandbox and repeats the Work Item with a fresh attempt.
- **Observe or collect invocation:** these only read the harness, so Factory invokes
  them again.

A restarted controller observes, cancels or collects the same resource. A harness that
ends without a complete result has its sandbox destroyed before the attempt ends, so a
repeated attempt never runs beside it. No provider retry policy, second scheduler,
registry, service installer or operational journal is added. Existing explicit authority
and retry limits still apply.

Repository source comes from the provider's trusted pinned Git preparation, not an uploaded
controller checkout. Current regular delivery uses published integrated bases; native-stack
successors start after their predecessor is published. Preparation fails if the exact base
is unavailable remotely; it never publishes a temporary branch or silently uses a different
base. The worker verifies the prepared HEAD, tree and clean checkout before it starts.

Repository LFS paths remain exact pointers, matching the existing harness contract. For
declared repository source assets, the controller derives raw object SHA-256 and size from
those pointers. The provider fetches only these required LFS objects into `workspace/lfs/<index>`.
The controller verifies and imports those bytes into the existing content store; the harness
receives a bound `.factory-inputs/lfs-<index>` path to the raw content. Private local inputs,
authorized attachments and previously selected assets retain their explicit bound input
paths. The input archive contains only `.factory-inputs`, never repository Git objects,
configuration or credentials. It is verified before extraction.

Output transport uses a binary archive with compact path/mode/digest/size descriptors,
not base64 file bodies in one JSON response. It preserves ordinary file bytes,
executable modes and deletions; symlinks and submodules are unsupported. The controller
rejects unsafe paths and digest/identity mismatches before importing files, then uses the
same ownership, secret scanning, asset capture, validation, media selection, LFS and delivery
boundaries as local execution. An imported checkout scan does **not** establish the history
of ignored files in the original remote workspace, and the driver emits no such receipt.

Credential-free tests use a stateful infrastructure fixture, separate workspaces and real
child processes, including a packed package-root consumer. They qualify this shared driver
and transport contract, not Daytona or every harness/provider combination. Daytona remains
[#9](https://github.com/clockgrove/factory/issues/9), dependent on accepted
[#8](https://github.com/clockgrove/factory/issues/8); live provider qualification retains its
own target, source-egress, credential and spending authority.

The neutral fixture proves the driver and preparation contract with a real published bare
Git remote, separate child processes, explicit raw LFS fixtures and credential canaries.
It does not prove a concrete provider's private Git/LFS authentication or secret-removal
facility. Daytona must demonstrate those properties in #9. Model-service authentication
is separate from repository preparation; no sandbox control-plane credential belongs in
the harness. Typed harness login failures retain their existing status information.

## Daytona public-repository adapter

The built-in `daytona` adapter declares `@daytonaio/sdk@0.220.0` as an optional peer.
Explicitly install that exact package alongside Factory and configure the existing sandbox mode:

```json
{
  "kind": "sandbox",
  "concurrency": 1,
  "provider": "daytona",
  "config": {
    "snapshot": "your-installed-factory-snapshot",
    "target": "us",
    "apiKeyEnv": "DAYTONA_API_KEY",
    "timeoutSeconds": 60,
    "factoryRoot": "/opt/factory/node_modules/@clockgrove/factory"
  },
  "harness": {
    "kind": "registered",
    "adapter": "your-harness@1",
    "config": {}
  },
  "argv": ["node", "/opt/factory/sandbox-entry.mjs"]
}
```

`apiKeyEnv` names a controller credential, resolved through the existing environment
or private systemd credential-file binding. Its value never enters the sandbox,
configuration, checkpoint or harness request. Snapshot resources and account capacity
remain provider/operator constraints; concurrency is the configured attempt count,
not a claim of available Daytona capacity. The adapter creates from that existing
snapshot and disables automatic stop/pause/delete so owned lifecycle remains explicit.
It does not create snapshots, install tools, or provision secrets.

Use a trusted snapshot without GitHub credentials, credential-bearing home directories
or repository authentication services. Trusted preparation checks Node 22 or newer,
Git, Git LFS and the configured installed Factory package's exact version before
starting a harness. The snapshot must also contain the configured entrypoint and
harness dependencies. This version check is readiness, not installed-artifact or
live-provider qualification.

Repository preparation supports anonymous public `github.com` Git and LFS only.
It fetches the exact commit, checks the tree, and uses native Git LFS smudge for each
declared pointer into private staging. System/global Git configuration, credential
helpers and interactive authentication are disabled. Required raw bytes are hashed;
repository paths remain pointers. Authentication-required repositories or objects,
unpublished commits and unavailable tools fail before harness start. Existing explicit
private local inputs and selected assets still use the verified input archive.

Sandbox harnesses must keep their owned execution resources within the attempt's
sandbox. Confirmed destruction of that owned sandbox is terminal cancellation,
including descendant processes. Factory does not subsequently invoke a helper in a
stopped or deleted resource. A failed or unknown deletion remains unresolved and a
restart cleans up the same resource. This does not promise cleanup of arbitrary
external jobs created by a registered harness; separately managed remote agent tasks
belong to managed execution. No controller environment is forwarded to the harness;
its existing authentication contract remains independent. No organization secret
bindings are added by this adapter. A missing harness authentication route is a typed
unavailability, not a successful provider qualification.

The adapter uses SDK streaming upload/download, remote and local SHA-256/size checks,
opaque sandbox/session/command identities, and `delete(timeout, true)` to await
confirmed destruction. It adds no retry loop. Before creating a sandbox it lists
sandboxes labeled with the attempt and adopts one, so a create whose response was
lost never leaves a second sandbox.

Private repository authentication remains unsupported: Daytona's
[secret detachment](https://www.daytona.io/docs/en/typescript-sdk/sandbox/#updatesecrets)
propagates asynchronously, and its
[secret placeholders](https://www.daytona.io/docs/en/secrets/)
retain outbound authentication capability. The current API mapping does not prove a
revocation barrier before harness startup, or the token's lifetime and repository
permissions. No sleep or hidden-placeholder workaround is accepted. Issue #9 remains
open for that boundary and separately scoped installed live qualification. Credential-free
SDK mapping and real local Git/LFS/process tests prove only the source slice; they do
not prove Daytona capacity, authentication, billing, network behavior or live cleanup.

Default/offline installation does not resolve or install Daytona's dependency tree.
The adapter checks the installed SDK version and returns `DAYTONA_SDK_UNAVAILABLE`
when it is absent or mismatched. SDK construction uses its supported polling-only
option and refuses ambient tracing selectors; this avoids
a constructor-created event connection or an implicit trace export destination.
When the SDK can load dotenv and a dotenv file exists, explicitly set both
`DAYTONA_OTEL_ENABLED=false` and `DAYTONA_EXPERIMENTAL_OTEL_ENABLED=false` in the
controller environment. Factory checks selector availability without reading those
files or mutating the process environment.
