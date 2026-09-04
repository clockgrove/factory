# Factory v2 preview release plan

Status: active release goal

Date: 2026-09-04

## Goal

Publish a prize-quality open-source Factory v2 preview that an indie developer or small team can
install, understand, secure, and run without Clockgrove infrastructure. The released product must
turn a GitHub Objective into dependency-aware Work Items, use trusted local Linux compute first,
burst within explicit cost authority, validate every artifact independently, and deliver regular or
native stacked pull requests until the Objective ships or one evidenced human decision is required.

This is one preview product. Native stacks, Daytona, and managed agents are not assigned separate
maturity labels; each must pass its applicable v2 conformance gates. Vercel Sandbox and Codex App
Server are Labs and do not block release.

## Release promise

> Factory v2 runs an unattended, GitHub-native software factory in one Linux environment, bursts
> selected work to Daytona or GitHub-managed agents when authorized, and publishes dependency-aware
> work through regular or native stacked pull requests.

The release includes:

- synchronized Agent Plugin and `@clockgrove/factory` npm artifacts;
- a `factory` CLI and explicitly installed repository controller;
- native Linux, Windows WSL2, and Linux guest on macOS environments;
- local Codex SDK workers, with Codex CLI fallback and adaptive CPU and memory admission;
- GitHub Copilot and OpenAI Codex managed-agent release profiles, with publication blocked until
  both live gates pass and the Codex gate records a stable provider-published identity;
- Daytona sandbox burst with TTL, egress, secret, concurrency, budget, and cleanup controls;
- GitHub issues, native sub-issues/dependencies, versioned refs/receipts, and no required private
  state service;
- native stacked pull requests with exact-head validation, restart recovery, and concurrent
  execution; the regular-PR fallback serializes complete Work Item pipelines to preserve validated
  base integrity;
- chat/MCP and CLI control with no custom UI or required GitHub Action; and
- public security, support, governance, contribution, release, and conformance documentation.

## Workstreams and acceptance

### 1. Reproducible distribution

- Package the CLI/controller as `@clockgrove/factory` with an executable `factory` binary, explicit
  exports, type declarations for any public library surface, and a strict files allowlist.
- Keep plugin and npm versions synchronized from one release source.
- Ensure installation runs no lifecycle script and starts no controller.
- Produce deterministic bundles, validated schemas, dependency audit output, an SBOM, checksums, and
  package provenance appropriate to the publication path.
- Pack and install the staged tarball in a clean environment; after publication, repeat from npm's
  `next` tag and from the published Agent Plugin artifact.

Acceptance: a clean user can install either artifact, run credential-free help/doctor/startup checks,
authenticate deliberately, and start the same controller behavior without a source checkout.

### 2. Supported execution backends

- Make the official Codex SDK local worktree backend the default and preserve Codex CLI as the
  supported portable fallback. Run both through the same Work Packet, sandbox, artifact, validation,
  cancellation, and cleanup contract.
- Qualify Daytona with one real multi-worker Objective, fresh-resource validation, forced
  cancellation, restart reconciliation, hard TTL, restricted egress, named-secret brokerage, cost
  reconciliation, and leak detection/cleanup.
- Bundle GitHub Copilot and OpenAI Codex managed-agent adapters behind the same capability, lifecycle,
  artifact, validation, cancellation, recovery, and economics contract.
- Keep Codex discovery fail-closed until live evidence records a stable provider-published actor
  identity; never derive authorization from its documented display name.
- Exercise the same bounded Work Item through both managed agents and prove no implicit provider
  substitution occurs.

Acceptance: local-only operation works with no cloud credential, and every paid launch is preceded by
durable provider, budget, and concurrency authority.

### 3. Linux environment qualification

- Run the controller, worktree, pressure, cancellation, restart, and service lifecycle matrices on
  native Linux, Windows WSL2, and a Linux guest hosted by macOS.
- Test x64 and ARM64 where the shipped Node.js/provider dependencies support them.
- Document that repositories and Factory state belong on the Linux filesystem.
- Fail clearly when invoked in native Win32 or Darwin rather than partially installing a service.

Acceptance: all three environment shapes pass the same Linux contract. Native Win32/Darwin lifecycle
and multiple-local-machine coordination remain out of scope.

### 4. GitHub delivery qualification

- Run native stack create, extend, observe, lower-layer update, descendant invalidation,
  revalidation, asynchronous merge, merge-queue, partial completion, restart, and cancellation cases
  against a disposable repository.
- Prove the configured regular-PR fallback before it can be selected.
- Exercise branch rules, stale heads, conflicting work, and independent sibling delivery.

Acceptance: Factory never integrates an unvalidated head, silently changes a published topology, or
requires a Factory GitHub workflow.

### 5. Security and open-source readiness

- Keep `SECURITY.md`, `docs/THREAT-MODEL.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SUPPORT.md`,
  issue/PR templates, changelog, license, and release notes complete and mutually consistent.
- Add negative tests for credential stripping, path scope, sensitive files, network policy, budget
  authority, lease loss, provider cleanup, stale validation, and package lifecycle behavior.
- Run dependency, secret, license, and package-content checks over the artifact actually published.

Acceptance: a new contributor can identify the trust boundary, report a vulnerability privately,
reproduce validation, and understand what Factory supports without private context.

### 6. Adversarial installed-product run

- From a clean staged candidate installation, execute a disposable multi-wave Objective that includes
  independent work, a dependency chain, restart, cancellation, failed validation, conflict, budget
  exhaustion, and final closure.
- Reconstruct the run from GitHub in a fresh process and confirm that explanations and economics use
  observed evidence rather than invented values.
- Verify no orphan branch, attempt, process, sandbox, managed session, lease, secret, or paid
  reservation remains.

Acceptance: the Objective ends in validated merged work or a single specific, evidence-backed human
decision, without manual per-Work-Item dispatch.

## Release sequence

1. Freeze public protocol, package, policy, and backend identifiers for the preview.
2. Pass deterministic tests, typecheck, package/plugin verification, audit, schema validation, and
   artifact-content checks from a clean checkout.
3. Complete the Linux, native-stack, Daytona, managed-agent, and adversarial matrices against a clean
   tested commit, then commit only their evidence records and the [`CONFORMANCE.md`](CONFORMANCE.md)
   ledger. All other changes require the affected candidate to be retested.
4. Review the security boundary and public documentation before freezing that tested commit; verify
   the final evidence-enriched package independently as described below.
5. Create the immutable version tag on the evidence commit, then publish synchronized preview
   artifacts under npm's `next` tag and the matching plugin version.
6. Clean-install what was published, repeat startup and one private-repository smoke Objective, and
   verify the release checksum/provenance.
7. Confirm the candidate tag still identifies the exact verified commit, publish release notes, and
   keep all v2 documentation explicit that the complete release is preview.

No live paid-provider gate runs merely because credentials are present. Each requires explicit
authorization naming the provider, disposable target, maximum billable units, and cleanup boundary.

## Recording evidence and publishing

The live-tested commit and the release commit serve different purposes. Freeze and commit all code,
bundles, manifests, tests, and public documentation first. Call that clean tested commit `S`. Build
and install its staged artifact, run the full candidate matrices, and retain sanitized output. The
adversarial candidate gate uses this staged installation; the published-install gate necessarily
happens later.

For each passed gate, create a schema-2 JSON record under `docs/release-evidence/` with these fields:

```json
{
  "schema": 2,
  "gate": "Linux environment matrix",
  "status": "passed",
  "commit": "FULL_40_CHARACTER_TESTED_COMMIT_S",
  "recordedAt": "ISO_8601_TIMESTAMP",
  "commands": ["EXACT_COMMANDS_RUN"],
  "subjects": [
    { "path": "dist/factory.js", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "dist/mcp-server.js", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "dist/bundle-inventory.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "package.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "package-lock.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": ".codex-plugin/plugin.json", "sha256": "SHA256_OF_TESTED_FILE" }
  ],
  "artifacts": [
    { "path": "docs/release-evidence/linux-output.txt", "sha256": "SHA256_OF_SANITIZED_OUTPUT" }
  ]
}
```

The placeholders above describe the format; they cannot pass verification. Record actual hashes,
full commands, environment/provider identity, acceptance-case results, and cleanup outcomes. The
verifier establishes content binding and required gate coverage; maintainers must still review that
the attached observations prove each gate. A single provider smoke does not establish its full matrix.

Change each proven ledger row to `Passed` and link its record relative to `CONFORMANCE.md`, for
example `[record](release-evidence/linux.json)`. Commit the ledger and evidence as `R`. No other path
may differ between `S` and `R`: the verifier checks Git ancestry and the complete tree diff, in
addition to the explicit subject hashes. Evidence records and logs must be tracked regular files,
not symlinks. Any code, bundle, package, test, or other documentation change requires new live
evidence against the changed candidate.

From a clean checkout of `R`, create the matching immutable `vVERSION` tag and run
`npm run verify:publish`. This reruns the complete deterministic/package suite, checks every live
gate, and creates `release/` artifacts with provenance naming `R`. The final tarball includes the
ledger/evidence additions; it is independently packed and install-tested and is not claimed to be
byte-identical to the earlier live-tested tarball. Its executable subjects and all other source are
identical to `S`. Artifact generation from a dirty worktree is useful for inspection but records
`sourceDirty: true` and cannot be published.

Review the generated tarball, SBOM, checksums, and provenance. `npm run release:publish` repeats the
verification before publishing that generated tarball with the `next` dist-tag. Direct invocation
of `scripts/publish-release.mjs` also rechecks the live ledger, clean tree, immutable tag, artifact
digests, and provenance source commit. The local provenance JSON records source and content; it is
not a registry-issued or cryptographically signed npm provenance attestation. Preserve the final
release artifacts as versioned release attachments.

Publish the matching plugin tag and perform the separate clean published-install gate. Record that
result in a later documentation commit or release attachment bound to `R`, the unchanged version
tag, and the registry/plugin digests. Never retag `vVERSION` to include post-publication evidence.
If the gate fails, document the failure and prepare a new version rather than overwriting the release.

## Labs and non-goals

Labs: Vercel Sandbox, Codex App Server, and additional provider/harness adapters. Their deterministic
tests should stay green, but live evidence is not a release gate.

Non-goals: a demo application, a custom Factory UI, GitHub Actions as Factory's scheduler, a
Clockgrove account, a hosted control plane, enterprise policy administration, native Win32/Darwin
lifecycle, multiple local worker computers, production deployment authority, or autonomous budget
increases.
