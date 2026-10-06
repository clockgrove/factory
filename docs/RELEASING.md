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

   This updates `package.json`, `package-lock.json`, the Codex and Claude Code plugin manifests and both marketplace refs. If production dependencies changed, run `npm run notices`. GitHub Release notes are generated from the merged pull requests; Git history retains the changes.

2. **Review the batch.** Merge the phase's diagnosed fixes through the normal protected pull request path with green Quality checks. Retain focused independent review for changes to credentials, isolation or persisted state. Refresh the release branch after the batch is complete, and independently review its exact candidate.

3. **Accept the phase.** Before merging `X.Y.0`, complete the release issue's recorded phase exits and independent completed-batch review. Run the phase acceptance after the batch is complete; a separate public fixture qualification is optional diagnosis, not an additional release or adopter-start gate. Retain the final reviewed source commit, tree, packed archive checksum, installation and outcome evidence for the distribution comparison. CI supplies the packed CLI integration check. Keeping the version PR unmerged until these gates pass leaves the marketplaces on an existing release tag.

4. **Merge.** Merge through the normal protected path after the required phase exits pass. For a minor version, verify that the merged tree equals the retained phase-accepted tree before tagging.

5. **Tag.** Tag that verified merged commit:

   ```sh
   git tag -a vX.Y.Z MERGED_COMMIT_SHA -m "Factory X.Y.Z"
   git push origin vX.Y.Z
   ```

   Verify active protection against updates and deletion for that exact `refs/tags/vX.Y.Z`, with no bypass actors or exclusions. Preserve existing tag protections. Recheck the remote annotated tag and its peeled commit after pushing.

The Release workflow then checks that the tag and every version identity agree and that the commit is on `main`. It runs the complete build, lint, format, notices and test suite (including the packed-artifact tests), packs the tarball, installs it offline from an empty npm cache, attests its provenance and publishes the GitHub Release with [automatically generated notes](https://cli.github.com/manual/gh_release_create) from the merged pull requests. If it fails before publishing, fix the problem on `main` and release the next patch version; do not move the tag.

## Verify a release

Anyone can verify a downloaded tarball:

```sh
gh attestation verify clockgrove-factory-X.Y.Z.tgz --repo clockgrove/factory
sha256sum --check SHA256SUMS
```

The attestation verification is the independent check: it proves that the bytes were built by this repository's Release workflow, without trusting the release page that served them.

For a minor version, also compare the downloaded archive byte for byte with the retained phase-accepted archive. A mismatch leaves that release unaccepted; preserve both identities and diagnose it without replacing the tag or assets.

## Phase acceptance

The release issue defines the required phase outcomes and their order. Complete those outcomes with the approved providers, targets, substantive acceptance and resource limits. Keep exact candidate identities, real results, failures, usage and consumed allowances. Local checks and historical accepted work do not substitute for the current outcome's acceptance.

For v0.2.0, finish B (#516), C (#517), D (#518), G (#520), H (#522) and I (#523), then perform one completed-batch evaluation and independent review under E (#519), then publish and verify the release under #521. Adopter staging deployment and staging qualification follow the release; they are not a pre-release gate. The authoritative exits are recorded in #519 and #521.

Batch corrections before the phase review. Repeat an affected failed check after a demonstrated correction; do not add a separate qualification cycle for every fix. Preserve terminal public runs and their accounting without reviving them or treating them as successful evidence. Use an approved target for a concrete reproduction when needed.

## Version numbers

Factory is pre-1.0. Patch versions carry fixes and small improvements. Minor versions mark a qualified baseline or an incompatible change to configuration, state or the CLI. Factory does not migrate state between incompatible versions. Finish or cancel active Objectives before upgrading across a state-version change.

## History

Releases up to v0.1.74 used a manual procedure; their verification is linked from the [historical release record](https://github.com/clockgrove/factory/blob/v0.1.75/CHANGELOG.md). Published release notes and Git history remain the record for those versions.
