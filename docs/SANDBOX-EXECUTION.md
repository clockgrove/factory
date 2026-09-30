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
not a shell command. `cancel` must confirm termination of the owned process and descendants;
`destroy` must confirm removal of the sandbox and its owned processes. Unknown outcomes
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
snapshot before external mutations. An unknown create/start acknowledgement stops for
operator direction instead of creating another attempt. A restarted controller observes,
cancels or collects the same resource. No provider retry policy, second scheduler, registry,
service installer or operational journal is added. Existing explicit authority and retry
limits still apply.

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
