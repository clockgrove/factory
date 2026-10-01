# Public release checklist

Published [v0.1.47](https://github.com/clockgrove/factory/releases/tag/v0.1.47) has verified public download, pinned plugin identity and offline installation; see the [exact artifact record](BUILD-STATUS.md#immutable-v0147-artifact-record). Live workspace qualification remains in [#263](https://github.com/clockgrove/factory/issues/263); full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253). Earlier artifact and adopter evidence remain bound to their original bytes and scenarios.

Earlier published artifacts and their evidence remain intact. Distribution checks do not establish live qualification.

Use this checklist for a new release without rebuilding or retagging existing artifacts. The [public release procedure](PUBLIC-RELEASE.md) supplies the commands and operational requirements. Each claim must identify the exact artifact and scenario it proves.

## Repository and package assets

| Deliverable                                    | Release check                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README                                         | Clear purpose, environment, first Objective and limitations; archived install commands select the candidate version and capabilities match its source.                                               |
| LICENSE and third-party notices                | Package the MIT license and notices for the exact production dependency tree; retain maintainer review of documented upstream omissions.                                                             |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Check contact routes, reporting guidance and supported-version statements.                                                                                                                           |
| CONTRIBUTING                                   | Check source-build requirements, local checks and contribution/review workflow.                                                                                                                      |
| Objective issue form                           | Verify its eight fields and pinned-source section render and parse; target owners can copy it.                                                                                                       |
| Package, plugin and marketplace metadata       | Version and immutable ref agree; declared platform, engines, dependencies and package files match the tested artifact.                                                                               |
| Logo                                           | Check SVG rendering and inclusion in the package.                                                                                                                                                    |
| CHANGELOG                                      | Explain changes delivered by this version; link exact evidence rather than duplicating operational history.                                                                                          |
| Installed skills and CLI                       | Read archived `director`, `setup` and packaged use guides; verify plan/decide/run/decide-result/status/diagnostics/logs, media review/selection and provider boundaries against the final interface. |
| Deterministic checks and CI                    | Pass the coordinated source/static/test/notices/package checks on the exact accepted candidate and verify integrated main.                                                                           |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

1. Freeze the independently reviewed source and guidance. Reuse passing Quality CI bound to that exact commit; changes invalidate its evidence.
2. One release owner runs the [sequential contributor command](PUBLIC-RELEASE.md#contributor-release-workflow). Package once, install offline once, compare bundled bytes/versions/notices, run whole installed test files and all required model-free scenario preflights, then publish through exact-tag protection under existing authority. No parallel release stages or separate offline-install owner.
3. One independent auditor verifies anonymous public bytes/checksum against the prepublication fingerprint, the protected annotated tag/source/tree, and the enabled pinned plugin. Reuse identical-byte offline and installed evidence.
4. Retain one immutable acceptance record and separate timing observations. Preserve failed attempts. Report technical completion and end-to-end elapsed time once; publication is not live Objective acceptance.
5. Run any public or adopter qualification only under its own approved scope, limits and acceptance. Release completion does not resume an explicit hold. Later ledger maintenance is not a qualification-start gate.

Preserve earlier artifacts, failed runs, accounting and exact scenario boundaries. This contributor workflow does not change Factory's runtime scheduling or grant provider, target, spending, security or activation authority.

## Historical release checkpoints

The [preserved checklist history](history/RELEASE-CHECKLIST-2026-09-28.md) retains earlier artifact identities, gate results and pending-at-the-time statements. The [historical artifact ledger](history/BUILD-STATUS-2026-09-28.md) retains the detailed evidence. Use current issues and the Project for present work status.
