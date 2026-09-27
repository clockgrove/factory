# Public release checklist

**Published v0.1.29:** use the [immutable installation](../README.md#install-published-v0129)
and exact evidence in [PR #183](https://github.com/clockgrove/factory-rebuild/pull/183).
The frozen release source excludes concurrent #180 even though metadata integration
includes it. Never rebuild or replace the release from later main. Independent
public-download verification precedes separately authorized fresh automatic
qualification in #26; preserve v0.1.28 and its waiting run.

**Published v0.1.28:** reviewed source, artifact, installation and reproduction
gates passed; exact identities are in [build status](BUILD-STATUS.md). Fresh public
live qualification and actual adopter acceptance remain pending in #26. Do not
rebuild from later main, retag or replace the release. Publication does not
authorize live execution.

**Historical v0.1.28 candidate:** follow [candidate preparation](PUBLIC-RELEASE.md#prepare-v0128)
from accepted #174 / PR #175, including accepted #55, #149, #167 and #168.
Package/manifest and future marketplace ref name 0.1.28; current public
installation remains v0.1.27. Freeze and review this metadata candidate before
the coordinated artifact gates. Earlier #55 installed provider evidence belongs
only to its earlier artifact. No combined v0.1.28 release or live acceptance is
asserted here.

**Published v0.1.27; public gate failed:** publication and independent public
download/offline installation passed. The final-integration worker refused its
pointer checkout twice, before writing its note or reaching final validation.
Three integrated lanes remain partial evidence; no automatic Objective acceptance
occurred. Preserve the original run and its one explicit retry. Exact artifact
identity and retained-fixture disposition appear in [build status](BUILD-STATUS.md).

## Historical release checkpoints

**Published v0.1.26; live acceptance pending:** use the
[published qualification procedure](PUBLIC-RELEASE.md#qualify-published-v0126)
and [current artifact evidence](BUILD-STATUS.md). Publication, source/package
checks and independent public-download/offline installation passed. Public live
qualification and actual adopter acceptance remain separate pending gates in
issue #26. The v0.1.25 identities below remain historical evidence for their own bytes.

**Published v0.1.25; automatic gate pending.** Metadata PR #152 carries accepted #150
from [PR #151](https://github.com/clockgrove/factory-rebuild/pull/151), integration
`92ef6eeac89e792016b5f20ad69cefb707e9debb`, reviewed tree
`60ad230af22450f46d00e2ccece8555dc883d6cb`. Package/lock-root, manifest,
marketplace tag name this identity. Release source is
`b641ccdccdb969f14c64a66da751c22f6be5bd6d`, tree
`3569c631cdc6c878836d190e0069cd87f828d6c3`; the
[published tarball](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.25)
is 150177209 bytes, SHA-256
`953324353b903624dbe2471c10310ed60fcf419538e058906b2e22b855ff5e09`.
Metadata review, full183 Node22/24 and static/notices gates, exact-head/main CI,
pack reproduction, public download, empty-cache offline installation and pinned
marketplace verification passed. [Build status](BUILD-STATUS.md) records evidence.
The first combined gate is preserved/nonqualifying after a 900000 ms provider
idle timeout, with no product finding, result override, retry or replay. Its real
pnpm collection and four passing checks are limited evidence, not acceptance.
The [wholly fresh public gate](https://github.com/clockgrove/factory-v0125-gate-20260927-fresh/issues/1)
has not yet qualified; automatic installed-gate acceptance remains pending. No v0.1.24
evidence transfers to changed bytes. Actual #26 remains OPEN/unaccepted;
frozen/deferred #55 remains unchanged and is not this bounded pilot's prerequisite.

Historical published artifact: [v0.1.24](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.24), carrying the accepted and closed #145 required-shape correction
from integration `2f3d4f5a820b1001f41cff731640fc4085552630`, without #55 optional
harness work. Its tagged version/manifest/marketplace and install instructions agree;
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
| Package and marketplace metadata               | Published 0.1.28 package/manifest and immutable v0.1.28 marketplace pin                                               | Independent public identity and installation verification passed; never rewrite published artifacts                |
| README and CONTRIBUTING                        | Public install and contribution instructions                                                                          | Recheck commands against final CLI                                                                                 |
| CHANGELOG                                      | Published `0.1.28` changes listed; historical entries retained                                                        | Record exact artifact identity and acceptance evidence in BUILD-STATUS                                             |
| Installed use skills                           | `director` and `setup` packaged                                                                                       | Exercise planning, result decisions, media selection, status, and diagnostics in a fresh target                    |
| CLI                                            | Existing commands documented                                                                                          | Recheck plan/decide/run/decide-result/status/diagnostics/logs against the final CLI                                |
| TypeScript, formatter, test, workflow          | Existing build and deterministic CI                                                                                   | Run credential-free integration gate on merged trunk                                                               |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

For published v0.1.28, source/publication/installation checks in steps 1–2 passed.
For historical v0.1.27 those checks passed, but the public gate failed. New-artifact installed
qualification in steps 3–4 and actual adopter acceptance remain required.
[BUILD-STATUS.md](BUILD-STATUS.md) records the exact published identity;
issue #26 tracks remaining acceptance. Use the approved representative foundation,
policy, same-path media and final-integration scenario without reducing its scope.

Historical v0.1.25 publication and installation passed, but its preserved runs
remain nonqualifying. Historical v0.1.24 steps 1–4 passed for its fresh PUBLIC
prerequisite only; v0.1.23 planning attempts remain nonqualifying. Earlier #81
acceptance does not qualify changed bytes. The reusable procedure below does not
authorize repacking, retagging or replaying any published release or preserved run.

1. Confirm accepted #19–#24, #28, #44, #46, #48, #51, #60, #64, #67, and #81 behavior in README, skills, and package tests; obtain review of the release candidate against the final CLI.
2. Follow [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md) to build a versioned tarball from the accepted commit, record its SHA-256 digest, and attach it to a public release at the pinned marketplace tag. Confirm the package contains manifest, CLI, use skills, license, logo, notices, and the exact bundled production dependency tree. Install it with an empty npm cache and compare installed versions with the accepted lock.
3. Complete the [authorized host launch and model-free worker preflight](PUBLIC-RELEASE.md#controller-host-and-worker-readiness). In a clean environment and fresh third-party repository assembled from the public fixture, install only that public artifact. Use this same bounded public scenario for real worker tools, collection and delivery; a separate preliminary live smoke is unnecessary. Use the approved public Objective and its complete source-defined graph, select a byte-identical candidate, migrate the existing ordinary blob to required LFS, and complete final review only after all source-defined final commands and exact fresh-clone hydration evidence.
4. Record package identity and digest, Objective and GitHub issue/PR identities, selected-byte identity, validated tree, exact final head, pre-publication LFS object proof, hydration receipt, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). Do not use a local source path, source-module import, or private instructions.
5. Historical #81 is already closed after the v0.1.21 installed-artifact gate. That acceptance does not qualify later release bytes, including v0.1.26. Do not substitute or mutate an older run, retag an older release, or treat source merge as product acceptance. The private adopter smoke remains a separate later gate.
