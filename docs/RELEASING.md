# Releasing Factory

This is the maintainer procedure for publishing a Factory version. To install Factory, follow the [README](../README.md#install).

## What a release contains

Each version `X.Y.Z` has one annotated tag `vX.Y.Z` on `main` and one [GitHub Release](https://github.com/clockgrove/factory/releases) with:

- `clockgrove-factory-X.Y.Z.tgz`, the CLI with the default Codex runtime bundled for offline installation;
- `SHA256SUMS` for that tarball;
- a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) proving the tarball was built by the [Release workflow](../.github/workflows/release.yml) from the tagged commit.

The Codex and Claude Code marketplace entries pin the same tag, so the plugin's skills and the CLI always come from one version. Factory is not published to the npm registry.

A version with a suffix, such as `0.2.0-rc.1`, is published as a GitHub prerelease, which the README's latest-release install skips. Tags `v*` cannot be moved or deleted. A published version is never rebuilt or replaced; fix problems in a new version.

## Publish a version

1. **Prepare.** On a branch from current `main`, run:

   ```sh
   node scripts/version.mjs set X.Y.Z
   ```

   This updates `package.json`, `package-lock.json`, the Codex and Claude Code plugin manifests and both marketplace refs, and adds a `## X.Y.Z` heading to `CHANGELOG.md`. Replace its TODO with the user-visible changes. If production dependencies changed, run `npm run notices`.

2. **Merge.** Open a pull request. It merges after review and a green Quality check, like any other change.

3. **Qualify minor versions.** Before tagging `X.Y.0`, complete the [live qualification](#live-qualification) on the frozen packed artifact from the merged commit. Retain its checksum and installation for the final distribution comparison.

4. **Tag.** On the merged commit:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Factory X.Y.Z"
   git push origin vX.Y.Z
   ```

The Release workflow then checks that the tag, every version identity and the changelog agree and that the commit is on `main`. It runs the complete build, lint, format, notices and test suite (including the packed-artifact tests), packs the tarball, installs it offline from an empty npm cache, attests its provenance and publishes the GitHub Release with the changelog section as notes. It takes about ten minutes. If it fails before publishing, fix the problem on `main` and release the next patch version; do not move the tag.

## Verify a release

Anyone can verify a downloaded tarball:

```sh
gh attestation verify clockgrove-factory-X.Y.Z.tgz --repo clockgrove/factory
sha256sum --check SHA256SUMS
```

The attestation verification is the independent check: it proves that the bytes were built by this repository's Release workflow, without trusting the release page that served them.

For a live-qualified minor version, also compare the downloaded archive byte for byte with the retained qualified archive. A mismatch leaves that release unaccepted; preserve both identities and diagnose it without replacing the tag or assets.

## Live qualification

Deterministic tests run on every release. A live qualification, a real Objective against a disposable public target with real models and GitHub delivery, is required for **minor** versions (`X.Y.0`) and optional for patches. Use the [autonomous target](../test/fixtures/autonomous-target/) with its [first](../test/fixtures/objectives/autonomy-first.md) and [second](../test/fixtures/objectives/autonomy-second.md) Objectives ([#519](https://github.com/clockgrove/factory/issues/519)), and link the result from the release notes. Historical failed qualifications remain unaccepted; a corrected successor needs a concrete diagnosis and its own recorded finite bounds.

1. Before creating the target or calling a provider, run `npm run build && node test/autonomy-fixture-preflight.mjs`. It checks the fixture's commands, planner-visible CI check and complete pinned worker sources without model calls. Freeze the source/tree/archive, installed path, fixture bytes, owner, acceptance, providers, concurrency and finite per-run repair limits. Inspect the actual installed compiler, review and worker inputs, exact-tree validator observations, command authority, evidence grounding and hydration. Model-free checks do not accept a live Objective.
2. Pack the merged candidate with the Release workflow's locked dependency/build toolchain and install it offline outside a fresh public target copied from the fixture. Keep this artifact for both Objectives and later distribution verification. Supply the external `factory-fixture-prerequisite` executable on the supervisor's PATH before planning, with its operator-owned condition unavailable. The tool must be present even while the condition fails; it is an acceptance probe, not a coding-readiness prerequisite.
3. Run `factory setup --background --repository OWNER/REPO --checkout ABSOLUTE_TARGET --concurrency 2`. Verify explicit service consent, readiness, the exact manager/controller owner and a successful authenticated service observation. With an empty queue, it must make no model calls. Admit only the first Objective with `factory queue add FIRST`.
4. After a worker starts, perform one supported controlled restart: `factory supervisor stop`, then `factory queue resume` and `factory supervisor start`. Retain and compare the same run, attempt, worker and existing issue/PR identities; the restart must not duplicate submission.
5. Retain beta's actual failed candidate and prerequisite receipt. Restore the operator-owned condition, then submit `factory repair --objective FIRST --proposal FILE` with a diagnosis bound to its failure digest. This permits one new beta implementation attempt through the current supported repair contract, preserving the original failure, candidate, identities, usage and consumed allowance. It is distinct from restart identity preservation. If the service exited for the decision, continue with `factory queue resume` and `factory supervisor start`. Do not repeat an unchanged failure or manually accept it.
6. Require all three implementation items' independent acceptance, successful `source-check` receipts on their exact published heads before integration, and the first Objective's final QA and independent acceptance. Then observe the same active service waiting with an exhausted queue and no model calls.
7. Create the second Objective with a native blocked-by dependency on the accepted first Objective. Leave it unqueued through idle observations, then admit it explicitly with `factory queue add SECOND`. Its plan must pin the actual accepted predecessor head and complete implementation sources. Require guide review, exact-head CI and final guide/QA acceptance on the same installed artifact. Retain the full evidence and accounting for independent scenario review before release acceptance.

## Version numbers

Factory is pre-1.0. Patch versions carry fixes and small improvements. Minor versions mark a qualified baseline or an incompatible change to configuration, state or the CLI. Factory does not migrate state between incompatible versions; the changelog says when an upgrade requires finishing or cancelling active Objectives first.

## History

Releases up to v0.1.74 used a manual procedure; their verification is linked from each [changelog](../CHANGELOG.md) entry.
