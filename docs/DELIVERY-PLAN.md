# Release delivery

Factory aims to provide an open-source, GitHub-native coding agent orchestrator that a developer
or small team can install and operate without Clockgrove infrastructure. The
[Factory Project](https://github.com/orgs/clockgrove/projects/1) owns priorities and progress;
[the design](DESIGN.md) owns the product contract. This document covers release scope and delivery.

## Product outcome

The Initial Beta release scope includes synchronized Agent Plugin and `@clockgrove/factory` npm
packages; a CLI and explicitly installed repository controller; local execution on Windows WSL2
through Codex SDK, CLI fallback, and explicit App Server sessions; adaptive single-host admission;
independent validation; regular and native stacked PR delivery; GitHub Copilot managed execution;
durable recovery, accounting, cleanup; and installed application qualification. Repositories and
Factory state belong on the WSL2 Linux filesystem.

Copilot retains operator-assisted lifecycle boundaries. Managed Codex stays unavailable until its
authoritative identity and lifecycle interfaces exist and are qualified. Native Linux, a Linux
guest hosted by macOS, and Daytona are implemented targets with separately tracked live
qualification; they are not Initial Beta support claims. Vercel Sandbox and additional harness
adapters remain Labs integrations. Missing provider interfaces do not prevent local-only operation.

These are implementation and qualification commitments, not claims that all live gates have passed.
Use the [release verification contract](CONFORMANCE.md) for required acceptance and the
[publication issue](https://github.com/clockgrove/factory/issues/88) and
[published-artifact issue](https://github.com/clockgrove/factory/issues/89) for release work.

## Final completion sequence

Follow the single [release verification procedure](CONFORMANCE.md#release-verification-procedure).
Freeze and review a candidate, pass integrated checks, build artifacts once, and run all six
prepublication gates against that exact source and package. `npm run verify:publish` validates
existing proof and artifacts without rebuilding or rerunning the suite. Authorized publication
uses the same tarball, followed by the separate published-artifact installation gate.

Review public installation, support, security, compatibility, and release notes before freezing
the candidate. Versions must agree across the plugin, npm package, changelog, tag, and provenance.
Installation must run no lifecycle script and start no controller without an explicit action.

## Recording evidence and publishing

Store temporary gate records and observations under ignored `release/evidence/`, using the
[index and record format](CONFORMANCE.md#recording-evidence). The source commit and
`release/release-manifest.json` hash bind qualification to the exact artifacts. Do not commit
logs, receipts, accounting dumps, evidence indexes, or follow-up evidence-only commits. Historical
records remain available in Git history; new run investigations and concise verification results
belong in the relevant issues and PRs.

Keep sensitive observations private. Retain raw output locally or as access-controlled build
artifacts only as long as needed for review, unresolved accounting, or diagnosis. Before removing a
fixture, follow [fixture retirement](LIVE-OBJECTIVE-HARNESS.md#fixture-retirement).

For an actual release, attach a small sanitized verification report identifying the version,
source commit, artifact hashes, exercised environments/scenarios, results, and material limits.
Attach the checksums, SBOM, and provenance too. Inspect all attachments for secrets and private
repository or account details before uploading. This retention policy does not introduce an
automatic export or upload step. The generated local provenance describes source and content; it
is not a registry-issued or cryptographically signed npm provenance attestation.

The immutable `vVERSION` tag identifies the exact tested and published commit. The publisher checks
that tag, clean tree, required gate proof, artifact digests, and provenance even when invoked
directly. Record the selected version and distribution channel before freezing the candidate;
Initial Beta should use a prerelease version and beta channel rather than silently becoming the
stable `latest` release. Publish the synchronized plugin tag only with the same explicit publication
authority. Add the later published-install result as a release attachment bound to that unchanged
tag and the registry/plugin digests. Never retag to add observations; a failed release needs a new
version.

## Labs and non-goals

Later host/provider routes and Labs integrations retain deterministic tests but do not add live
gates to Initial Beta. Paid work still requires explicit provider, target, spending, and cleanup
authority.

Factory does not require a hosted control plane, Clockgrove account, custom UI, or GitHub Action.
Native Linux, a Linux guest hosted by macOS, and Daytona remain later qualification targets. Native
Win32/Darwin lifecycle, multiple local worker computers, enterprise policy administration,
production deployment authority, and autonomous budget increases remain outside product scope.
