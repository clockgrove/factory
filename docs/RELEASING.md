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

3. **Tag.** On the merged commit:

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

## Live qualification

Deterministic tests run on every release. A live qualification, a real Objective against a disposable public target with real models and GitHub delivery, is required for **minor** versions (`X.Y.0`) and optional for patches. Use the [autonomous target](../test/fixtures/autonomous-target/) with its [first](../test/fixtures/objectives/autonomy-first.md) and [second](../test/fixtures/objectives/autonomy-second.md) Objectives ([#448](https://github.com/clockgrove/factory/issues/448) simplifies this), and link the result from the release notes. A failed qualification is fixed in a patch release and rerun.

## Version numbers

Factory is pre-1.0. Patch versions carry fixes and small improvements. Minor versions mark a qualified baseline or an incompatible change to configuration, state or the CLI. Factory does not migrate state between incompatible versions; the changelog says when an upgrade requires finishing or cancelling active Objectives first.

## History

Releases up to v0.1.74 used a manual procedure; their verification is linked from each [changelog](../CHANGELOG.md) entry.
