# ADR 0009 — Content-addressed managed toolchain runtime bundles

Date: 2026-09-10

Status: accepted

## Context

Deferred repository capabilities must execute with an exact runtime after their provider has been
integrated. A package-manager program without its interpreter, or any tool resolved from the
controller's `PATH`, leaves part of the runtime identity ambient and does not provide durable
provenance.

Runtime absence is a temporal readiness condition. It must not invalidate or recompile an already
persisted graph, and installing a newer release must not silently change the runtime used by a graph
whose authority has already been resolved.

## Decision

Factory uses a content-addressed runtime bundle contract. A bundle receipt names its adapter
contract, supported platform, one or more immutable components, official origin and release
identities, published and observed SHA-256 digests, executable roles, and a digest of the canonical
receipt. Provisioning is an explicit operator action. It resolves the latest stable upstream release,
verifies every downloaded asset before extraction, installs atomically into Factory's private data
directory, and records an active selection without deleting older bundles.

The immutable graph records an abstract runtime requirement, not a local cache path or bundle digest.
Only after the graph and compiler accounting are durable does exact-base activation select a receipt
that satisfies the requirement. For a new or otherwise unbound generation, the active pointer is the
operator-selected default. An integrated-base consumer instead inherits the exact receipt from its
provider generation's authenticated `AttemptReserved` record. The provider identity binds that
reservation's object ID, the digest-identical complete immutable trailer/comment receipt, and
runtime-activation digest; it never substitutes the host's later active selection. Provider and
current-base authority bytes are inspected independently and must agree for the same generation. A
missing, ambiguous, or changed provider activation fails readiness rather than falling back to active
or ambient state.

The consumer's durable attempt reservation binds the inherited receipt, its activated Worker Packet,
proof digests, source ref, and base commit. Dispatch rereads the protected ref, provider lineage,
authority bytes, and exact receipt components before launch. Workers and validators receive only
those verified bundle assets and typed executable/argument plans; they never consult the mutable
active pointer. Activation never downloads, self-updates, or falls back to ambient tools or
configuration. Missing or corrupt assets produce a readiness refusal while the graph and its
accounting remain intact.

Historical authenticated graphs that predate the top-level abstract `managedRuntimes` field retain
their original bytes, digest, projection, and Work Item bodies. Only the graph read path may derive a
non-persisted abstract pnpm execution view from an omitted field. Fresh compilation and issue-only
reconstruction remain strict; an exact record already authenticated from the durable graph store may
be copied by reusing its exact blob object for recovery. Issue-only inspection must reconstruct every
raw packet field, and foreground completion reapplies the exact reservation activation before
checking the invocation digest. Otherwise omission, explicit empty data for a managed command, or
a selected bundle digest at the top level or inside capability bindings is rejected. No selected
receipt, cache path, or active pointer enters the compatibility view, and historical integrated
providers without an authenticated runtime activation remain unavailable rather than inferred.

The reservation persists the complete receipt and immutable upstream origin identity, not only its
bundle digest. An operator can pass that receipt to `factory toolchains restore RECEIPT.json` to
reacquire the historical GitHub release asset and Node distribution by their exact recorded
identities, recheck every asset, executable, tree and canonical bundle digest, and reinstall the
content-addressed bundle. Restore never resolves a latest release and never changes the active
pointer. Recovery can then reverify the reservation and continue without recompiling the graph.

The core owns bundle shapes, receipt verification, platform matching, typed direct-executable plans,
active selection, exact restoration and readiness. The bounded provisioning catalog owns each
official release origin and asset pattern. Repository adapters own pins, authority files, finite
operations, preparation, environment isolation and source/lock policy. The first qualified platform
is Linux x64 glibc.

Factory initially exposes three provisioned bundles:

- `node-pnpm`: the latest stable official Node Linux x64 distribution plus the latest stable pnpm
  standalone program. Repository authority is `package.json`, `pnpm-lock.yaml`, and any explicitly
  enumerated workspace/task files.
- `javascript-bun`: the latest stable official baseline Linux x64 Bun ZIP. Factory extracts ZIPs in
  its bounded materializer rather than requiring an ambient archive utility. Repository authority is
  an exact `packageManager` pin, `bun.lock`, and declared direct-child workspace manifests.
- `python-uv`: the latest stable official uv Linux x64 archive plus the newest stable CPython
  install-only archive from the latest stable `python-build-standalone` release. Repository authority
  requires exact uv and Python pins, wheel-only locked registry dependencies, and a finite
  `python -m pytest` operation; automatic Python acquisition and source builds remain disabled.

Old receipts remain addressable so a reserved or recovered attempt does not move to a newer active
selection. Provisioning `all` resolves each tool independently and activates a bundle only after all
of its components pass digest, extraction, executable-version and tree verification. Tree identity
uses deterministic code-unit path ordering plus file bytes and bounded symlink targets, independent
of the provisioning or backend process umask; executable bytes and permissions are checked and
normalized separately.

## Rejected alternatives

- Shipping every runtime inside the npm package couples Factory releases to large platform-specific
  assets and cannot scale to multi-component runtimes.
- Ambient `PATH`, Corepack and user-managed runtimes make runtime authority host-dependent and are
  rejected.
- Treating one backend container image as the core identity would make a backend-specific mechanism
  fundamental and weaken the local-first contract.
- A package-manager-only program without its interpreter is rejected because it leaves runtime
  identity incomplete.
- Moving the active pointer during restore is rejected because it races independent Objectives and
  cannot represent old and new provider generations concurrently.
- Persisting a selected bundle in the graph is rejected because it makes compilation depend on one
  host's cache and would change historical graph identity.
- A separate capability-generation event is unnecessary while the authenticated provider
  reservation and integration lineage already carry the exact generation receipt.
- Shelling out to ambient `unzip` for Bun is rejected because host utilities would become an
  undeclared readiness and parsing boundary.

## Consequences

- Runtime acquisition requires explicit network authority and a writable private toolchain store.
- Backend adapters must materialize and attest every component or report the capability unavailable.
- Provisioning and adapter qualification remain separate evidence boundaries; one installed bundle
  does not qualify its adapter or an adjacent platform.
- Native Win32/Darwin, Linux arm64/musl, arbitrary Bun commands, uv source/editable/native builds,
  and toolchains outside the catalog remain unsupported until a dedicated contract and evidence
  exist.
- Loss or corruption of an already selected local bundle fails readiness closed. Automatic network
  restoration is intentionally outside this change; an operator must explicitly restore the exact
  durable receipt before recovery can continue.
- Unmanaged isolated validation stops at the first failed command so its evidence is exactly the
  successful prefix plus the first failure; an all-success plan still runs every command.
