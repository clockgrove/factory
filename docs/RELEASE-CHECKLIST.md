# Public release checklist

Published [v0.1.45](https://github.com/clockgrove/factory/releases/tag/v0.1.45) has verified public download, pinned plugin identity and offline installation; see the [exact artifact record](BUILD-STATUS.md#immutable-v0145-artifact-record). Live workspace qualification remains in [#263](https://github.com/clockgrove/factory/issues/263); full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253). Earlier artifact and adopter evidence remain bound to their original bytes and scenarios.

Earlier published artifacts and their evidence remain intact. Distribution checks do not establish live qualification.

Use this checklist for a new release without rebuilding or retagging existing artifacts. The [public release procedure](PUBLIC-RELEASE.md) supplies the commands and operational requirements. Each claim must identify the exact artifact and scenario it proves.

## Repository and package assets

| Deliverable                                    | Release check                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| README                                         | Clear purpose, supported environment, public installation, first Objective and limitations; commands agree with the CLI.                             |
| LICENSE and third-party notices                | Package the MIT license and notices for the exact production dependency tree; retain maintainer review of documented upstream omissions.             |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Check contact routes, reporting guidance and supported-version statements.                                                                           |
| CONTRIBUTING                                   | Check source-build requirements, local checks and contribution/review workflow.                                                                      |
| Objective issue form                           | Verify its eight fields and pinned-source section render and parse; target owners can copy it.                                                       |
| Package, plugin and marketplace metadata       | Version and immutable ref agree; declared platform, engines, dependencies and package files match the tested artifact.                               |
| Logo                                           | Check SVG rendering and inclusion in the package.                                                                                                    |
| CHANGELOG                                      | Explain changes delivered by this version; link exact evidence rather than duplicating operational history.                                          |
| Installed skills and CLI                       | Package `director` and `setup`; verify plan/decide/run/decide-result/status/diagnostics/logs and media review/selection against the final interface. |
| Deterministic checks and CI                    | Pass the coordinated source/static/test/notices/package checks on the exact accepted candidate and verify integrated main.                           |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

1. Freeze the candidate's capabilities, owner and acceptance. Complete independent review and the applicable source and CI gates.
2. Build one versioned tarball, record source/tree and SHA-256, verify its contents and dependency licenses, and install normally offline from an empty cache. Publish under the matching protected tag through normal controls. Independently download and verify public bytes, installation and marketplace identity.
3. Complete the [host and worker preflight](PUBLIC-RELEASE.md#controller-host-and-worker-readiness), then the approved [public Objective qualification](PUBLIC-RELEASE.md#fresh-disposable-objective) on those exact bytes. For #206, preserve the representative foundation, policy, same-path media and final-integration scope. Do not substitute an earlier two-item example or a preliminary smoke.
4. Record exact delivery, selected-byte, final-validation, fresh-clone hydration, automatic acceptance, accounting and fixture-disposition evidence. Keep private data in its authorized destination. Public success proves only the tested artifact, host and scenario.
5. Complete the actual Clockgrove adopter pilot after public acceptance and independent audit, using the same artifact. Keep #207 open until actual adopter acceptance; publication, source merge and individual PR success are insufficient.

Earlier artifacts and failed or superseded runs remain intact. Source changes invalidate candidate evidence; diagnose failures before a bounded corrected successor rather than rerunning an unchanged failure. Optional-provider evidence remains tied to its own artifact and scope.

## Historical release checkpoints

The [preserved checklist history](history/RELEASE-CHECKLIST-2026-09-28.md) retains earlier artifact identities, gate results and pending-at-the-time statements. The [historical artifact ledger](history/BUILD-STATUS-2026-09-28.md) retains the detailed evidence. Use current issues and the Project for present work status.
