# Public release checklist

Current published artifact: [v0.1.24](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.24), carrying the accepted and closed #145 required-shape correction
from integration `2f3d4f5a820b1001f41cff731640fc4085552630`, without #55 optional
harness work. Version/manifest/marketplace and current instructions agree;
metadata review, full159/static/actual Node22, exact-head/main gates, publication,
independent public download, fresh offline installation and marketplace verification
passed under its own identity. Source is `e0fc91343563e6a3b19eb92dd64d419ba03b487a`,
tree `25f80920ebb5848db019c384fcefbce6738f562a`; tarball is 150176214 bytes,
SHA-256 `513f46100ce1956c481d26a6ef96f63a62035527c4437268afac3c10e322ef31`.
Its [fresh public Objective](https://github.com/clockgrove/factory-v0124-gate-20260926-batched/issues/1)
is CLOSED at `5ed4b237d51943c52ea5d2f1f84c9eb1820bb199`, tree
`f5d247803aa6a83599e22c7531d06affdd5900df`, with whole-set human selection,
automatic final review and independent fresh-clone LFS verification.
This public prerequisite does not accept the separate actual #26 pilot:
that issue remains OPEN/unaccepted. No evidence is inherited from v0.1.23
or the preserved nonqualifying targets. Do not repack or retag this immutable release.

Historical published artifact: [v0.1.23](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.23),
including accepted #140 and later source leaves, not the deferred #55 optional
harnesses. Its source/CI/package, public-download/digest, fresh offline-install
and pinned marketplace verification are complete; [build status](BUILD-STATUS.md)
records the exact source/tree/artifact identity and evidence. These publication
checks do not complete the fresh heading-rich same-path LFS Objective gate or
the separate actual #26 pilot. The v0.1.23 attempts remain nonqualifying; the
fresh v0.1.24 public gate is accepted above, while #26 remains unaccepted. Historical v0.1.21
acceptance remains evidence of that immutable artifact only. Never reuse a
failed or nonqualifying run or treat publication as Objective acceptance.
The third fresh planning invocation failed required-shape validation before a
plan file or activation. [#145](https://github.com/clockgrove/factory-rebuild/issues/145)
is now accepted and closed for bounded source alignment; its v0.1.24
publication/public-gate evidence is recorded above. Do not patch v0.1.23
or infer the real failed field from synthetic schema-mismatch reproductions.

The first release passed [#25](https://github.com/clockgrove/factory-rebuild/issues/25). Public v0.1.10 completed the fresh installed-artifact gate for [#44](https://github.com/clockgrove/factory-rebuild/issues/44), [#64](https://github.com/clockgrove/factory-rebuild/issues/64), and [#67](https://github.com/clockgrove/factory-rebuild/issues/67). Public v0.1.13 remained nonqualifying because result review lacked controller-owned capture and selection evidence, v0.1.14 remained nonqualifying after a provider stream never emitted a terminal result, v0.1.15 was superseded before a live Objective because its installed setup skill misstated the worker default, v0.1.16 preserved a validated Work Item result after reviewer capacity was converted directly into a human decision, v0.1.17 preserved a selected result whose digest-bound receipt lacked manifest provenance, v0.1.18 preserved a selected result whose capture receipt lacked controller-imported input identity, v0.1.19 preserved a fail-closed planning attempt whose response used Markdown-prefixed citation headings, and v0.1.20 preserved a validated selected result whose automatic review packet did not distinguish the worker result from controller materialization. Public v0.1.21 independently completed [#81](https://github.com/clockgrove/factory-rebuild/issues/81)'s installed-artifact gate; see [exact acceptance evidence](V0.1.21-ACCEPTANCE.md) Checking a file into the repository does not satisfy an installed-artifact or live Objective gate.

## Repository and package assets

| Plan §9.6 asset                                | Current preparation                                                                                                   | Release check                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| LICENSE                                        | MIT file present                                                                                                      | Include in published package                                                                                       |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Public policies added                                                                                                 | Review contact routes and supported-version statement at release                                                   |
| Third-party notices                            | Generated from production lock and installed package notices, including SPDX BSD-3-Clause text for `@azu/format-text` | Regenerate for final lock; obtain maintainer review of the publisher's missing copyright notice before publication |
| Project logo                                   | SVG mark in `assets/`                                                                                                 | Review rendering and public use                                                                                    |
| Objective issue form                           | Eight named fields and final pinned-source section in `.github/ISSUE_TEMPLATE/objective.yml`                          | Confirm form renders, submitted body parses, and target owners can copy it                                         |
| Package and marketplace metadata               | Package, manifest, bundled Linux x64 runtime dependencies, and pinned `clockgrove` Git marketplace entry present      | Tag the accepted commit; verify `factory@clockgrove` and an offline CLI install from that public tag               |
| README and CONTRIBUTING                        | Public install and contribution instructions                                                                          | Recheck commands against final CLI                                                                                 |
| CHANGELOG                                      | `0.1.24` release changes listed; earlier entries retained                                                             | Record exact artifact identity and acceptance evidence in BUILD-STATUS                                             |
| Installed use skills                           | `director` and `setup` packaged                                                                                       | Exercise planning, result decisions, media selection, status, and diagnostics in a fresh target                    |
| CLI                                            | Existing commands documented                                                                                          | Recheck plan/decide/run/decide-result/status/diagnostics/logs against the final CLI                                |
| TypeScript, formatter, test, workflow          | Existing build and deterministic CI                                                                                   | Run credential-free integration gate on merged trunk                                                               |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

For v0.1.24, steps 1–4 have passed for the fresh PUBLIC prerequisite under the
exact identity above; [BUILD-STATUS.md](BUILD-STATUS.md) records the evidence.
The separate actual #26 pilot remains unaccepted, not blocked by this docs-only
handoff. v0.1.23 planning attempts remain nonqualifying; historical #81 closure
must not be reopened or applied to changed bytes. The steps below remain the
reusable procedure for a future separately authorized candidate, not permission
to repack, retag or replay the accepted v0.1.24 gate.

1. Confirm accepted #19–#24, #28, #44, #46, #48, #51, #60, #64, #67, and #81 behavior in README, skills, and package tests; obtain review of the release candidate against the final CLI.
2. Follow [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md) to build a versioned tarball from the accepted commit, record its SHA-256 digest, and attach it to a public release at the pinned marketplace tag. Confirm the package contains manifest, CLI, use skills, license, logo, notices, and the exact bundled production dependency tree. Install it with an empty npm cache and compare installed versions with the accepted lock.
3. In a clean environment and fresh third-party repository assembled from the public fixture, install only that public artifact. Use the public same-path Objective to obtain an automatically clean two-item plan, select a byte-identical candidate, migrate the existing ordinary blob to required LFS, and complete final review only after exact fresh-clone hydration evidence.
4. Record package identity and digest, Objective and GitHub issue/PR identities, selected-byte identity, validated tree, exact final head, pre-publication LFS object proof, hydration receipt, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). Do not use a local source path, source-module import, or private instructions.
5. Historical #81 is already closed after the v0.1.21 installed-artifact gate. That acceptance does not qualify v0.1.23. Do not substitute or mutate an older run, retag an older release, or treat source merge as product acceptance. The private adopter smoke remains a separate later gate.
