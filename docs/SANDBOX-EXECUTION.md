# Sandbox execution

Factory's sandbox driver transfers an exact base and bound assets into a provider-owned
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
workspace path and resource/process identities must refer to that exact attempt. Uploads
and downloads transfer ordinary bytes with SHA-256 and byte counts; execution takes argv,
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

Inputs contain shallow exact Git objects and bound source/selected bytes, without repository
configuration, hooks or source history. Output transport preserves ordinary file bytes,
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
