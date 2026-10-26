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

   This updates `package.json`, `package-lock.json`, the Codex and Claude Code plugin manifests and both marketplace refs. Format the changed JSON manifests with the repository formatter before review; the version helper can expand arrays that the formatter keeps inline. If production dependencies changed, run `npm run notices`. GitHub Release notes are generated from the merged pull requests; Git history retains the changes.

2. **Review the batch.** Merge the phase's diagnosed fixes through the normal protected pull request path with green Quality checks. Retain focused independent review for changes to credentials, isolation or persisted state. Refresh the release branch after the batch is complete, and independently review its exact candidate.

3. **Accept the phase.** Before merging `X.Y.0`, complete the release issue's recorded phase exits and independent completed-batch review. Confirm acceptance on the completed batch using meaningful affected tests and retained evidence where they still prove the required behavior. A minor version is qualified when every check of the [integration suites](../integration/README.md) (`main`, `edge` and `prd`) has passed live with `--provider codex` and with `--provider claude`, each pass with its retained results file. Evidence follows the code it tests: a pass on an earlier build still counts when Factory's code (`src/`) the check exercises is unchanged since, so changes to the suite, docs or fixtures never reset it. After a fix, re-run only the cases the change can affect (`--only`), on both providers; a full run of all three suites is not repeated for one fix. A failure that is the suite's own bug or a model choice Factory handled as designed is recorded on the release issue with its cause, not treated as a Factory defect. Copilot is not a release qualifier: it is outside the PRD's Done (maintainer decision, 2026-10-24, #1925). Beyond those suites, run a live check only for a specific remaining unproved changed behavior; a separate public fixture qualification is optional diagnosis, not an additional release or adopter-start gate. Retain the final reviewed source commit, tree, packed archive checksum, installation and outcome evidence for the distribution comparison. CI supplies the packed CLI integration check. Keeping the version PR unmerged until these gates pass leaves the marketplaces on an existing release tag.

4. **Merge.** Merge through the normal protected path after the required phase exits pass. For a minor version, verify that the merged tree equals the retained phase-accepted tree before tagging.

5. **Tag.** Tag that verified merged commit:

   ```sh
   git tag -a vX.Y.Z MERGED_COMMIT_SHA -m "Factory X.Y.Z"
   git push origin vX.Y.Z
   ```

   Verify active protection against updates and deletion for that exact `refs/tags/vX.Y.Z`, with no bypass actors or exclusions. Preserve existing tag protections. Recheck the remote annotated tag and its peeled commit after pushing.

The Release workflow then checks that the tag and every version identity agree and that the commit is on `main`. It runs lint, format, notices and Factory's tests, packs the tarball (`prepack` builds `dist`), installs it offline from an empty npm cache, attests its provenance and publishes the GitHub Release with [automatically generated notes](https://cli.github.com/manual/gh_release_create) from the merged pull requests. If it fails before publishing, fix the problem on `main` and release the next patch version; do not move the tag.

## Verify a release

Anyone can verify a downloaded tarball:

```sh
gh attestation verify clockgrove-factory-X.Y.Z.tgz --repo clockgrove/factory
sha256sum --check SHA256SUMS
```

The attestation verification is the independent check: it proves that the bytes were built by this repository's Release workflow, without trusting the release page that served them.

For a minor version, also compare the downloaded archive byte for byte with the retained phase-accepted archive. A mismatch leaves that release unaccepted; preserve both identities and diagnose it without replacing the tag or assets.

## Phase acceptance

The release issue defines the required phase outcomes and their order. Complete those outcomes with the approved providers, targets, substantive acceptance and resource limits. Keep exact candidate identities, real results, failures, usage and consumed allowances. The release issue holds the current roadmap and acceptance evidence; do not duplicate that tracking here.

Qualification scope, evidence reuse, batching and milestone review follow the Delivery and Coverage rules in [AGENTS.md](../AGENTS.md).

## Version numbers

Factory is pre-1.0. Patch versions carry fixes and small improvements. Minor versions mark a qualified baseline or an incompatible change to configuration, state or the CLI. Factory does not migrate state between incompatible versions. Finish or cancel active Objectives before upgrading across a state-version change.

## History

Releases up to v0.1.74 used a manual procedure; their verification is linked from the [historical release record](https://github.com/clockgrove/factory/blob/v0.1.75/CHANGELOG.md). Published release notes and Git history remain the record for those versions.
