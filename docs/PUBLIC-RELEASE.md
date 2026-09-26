# Public release and third-party installation

This is the reusable release and installation procedure. [#25](https://github.com/clockgrove/factory-rebuild/issues/25) accepted `v0.1.0`, the v0.1.7 gate completed [#46](https://github.com/clockgrove/factory-rebuild/issues/46), [#48](https://github.com/clockgrove/factory-rebuild/issues/48), and [#51](https://github.com/clockgrove/factory-rebuild/issues/51), and v0.1.8 proved [#60](https://github.com/clockgrove/factory-rebuild/issues/60)'s deterministic activation. The fresh installed v0.1.10 gate completed and closed [#44](https://github.com/clockgrove/factory-rebuild/issues/44), [#64](https://github.com/clockgrove/factory-rebuild/issues/64), and [#67](https://github.com/clockgrove/factory-rebuild/issues/67). The public v0.1.13 gate remained nonqualifying when result review lacked controller-owned capture and selection evidence, v0.1.14 remained nonqualifying after a provider stream never emitted a terminal result, v0.1.15 was superseded before a live Objective because its installed setup skill misstated the worker default, v0.1.16 preserved a validated Work Item result after reviewer capacity was converted directly into a human decision, v0.1.17 preserved a selected result whose digest-bound receipt lacked manifest provenance, v0.1.18 preserved a selected result whose capture receipt lacked controller-imported input identity, v0.1.19 preserved a fail-closed planning attempt whose response used Markdown-prefixed citation headings, and v0.1.20 preserved a validated selected result whose automatic review packet did not distinguish the worker result from controller materialization. Public v0.1.21 independently completed [#81](https://github.com/clockgrove/factory-rebuild/issues/81)'s installed-artifact gate; see [exact acceptance evidence](V0.1.21-ACCEPTANCE.md) Keep every tag, marketplace entry, tarball, and evidence record tied to the same source commit. The [build status](BUILD-STATUS.md) distinguishes publication from installed Objective acceptance. Do not run Factory against this repository.

## Distribution shape

The [Clockgrove marketplace](../.agents/plugins/marketplace.json) names the plugin at this repository's root and pins `v0.1.21`. Codex loads its manifest and use skills from that Git tag. The TypeScript CLI and its production dependency tree are built into a separate npm tarball attached to the matching public GitHub Release; marketplace installation does not build the CLI. The bundled tree makes the release install independent of later npm dependency resolution and needs no npm publishing account. The first tarball targets Linux x64 with Node.js 22 or later. The repo marketplace is a public distribution source for people who add it; a listing in the universal Plugins Directory would require a separate submission and review.

Publish a candidate tag and release asset only after its code, CI, packaging, and notice checks pass; then run the disposable gate from a fresh public download. Publication is not acceptance and does not authorize the Clockgrove pilot. Do not point the marketplace at a moving branch. If the candidate version changes, update the package, manifest, marketplace ref, changelog, README status, and commands here together before tagging.

## Build one candidate

From a clean Linux x64 source checkout at the accepted commit, with Node.js 22 or later, Git, Git LFS, and public npm access, confirm `git status --porcelain` is empty. Choose an empty absolute release directory outside the checkout, then run:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run notices:check
npm test
mkdir -p /absolute/empty/release-directory
npm pack --pack-destination /absolute/empty/release-directory
cd /absolute/empty/release-directory
sha256sum clockgrove-factory-0.1.21.tgz > SHA256SUMS
```

Inspect the tarball file list for the manifest, installed skills, CLI, license, logo, notices, and bundled production dependency tree. In a separate empty prefix, install the tarball with `npm install --offline --ignore-scripts --prefix /absolute/private/check-prefix ./clockgrove-factory-0.1.21.tgz` using an empty npm cache; verify `factory help`, compare every installed bundled package version with `package-lock.json`, and check that notices cover the same tree. Record `git rev-parse HEAD`, package version, tarball SHA-256, and the passing CI run. Create a protected `v0.1.21` tag at that same commit and attach both `clockgrove-factory-0.1.21.tgz` and `SHA256SUMS` to a public GitHub Release. Record the expected SHA-256 outside the mutable Release assets, in [BUILD-STATUS.md](BUILD-STATUS.md). This procedure does not itself publish or tag anything.

## Install from public artifacts

In a clean Linux x64 environment with Node.js 22 or later, after the release exists, set aside fresh Factory roots outside the target checkout while keeping GitHub CLI authentication reachable:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
FACTORY_TRIAL_ROOT=$(mktemp -d)
export XDG_CONFIG_HOME="$FACTORY_TRIAL_ROOT/config"
export XDG_STATE_HOME="$FACTORY_TRIAL_ROOT/state"
gh auth status
```

Then install from the public tag and release assets:

```sh
codex plugin marketplace add clockgrove/factory-rebuild --ref v0.1.21
codex plugin add factory@clockgrove
gh release download v0.1.21 --repo clockgrove/factory-rebuild \
  --pattern clockgrove-factory-0.1.21.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Also compare the digest with the independently recorded release value in BUILD-STATUS.md.
npm install --offline --ignore-scripts --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.21.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Verify `factory@clockgrove` appears in `codex plugin list --json` before the live Objective. The installed `director` and `setup` skills guide agent use; the `factory` CLI above supplies their documented operations. The CLI prefix, Factory configuration, state, review exports, and planning candidates must stay outside the target checkout. A target still requires GitHub CLI access and an authenticated Codex SDK environment; media Objectives require Git LFS.

## Local host-toolchain check

The automatic preflight below is current-source behavior, not a retrofit to
immutable public v0.1.21. Older published artifacts still need the manual
same-environment check; a new source candidate requires its own exact-artifact gate.

An offline Factory installation does not install the target's host tools. Inspect
all exact admitted Work Item and final commands before activation, including the
package manager needed for package scripts that will be created by a dependency.
Provision a task-private tool directory only under separate operator authority;
Factory never provisions tools or invents a package-manager version. For example,
after that directory has already been prepared:

```sh
FACTORY_TARGET_TOOLCHAIN=/absolute/private/approved-toolchain/bin
export PATH="$FACTORY_TARGET_TOOLCHAIN:$PATH"
sh -c 'command -v sh'
sh -c 'command -v pnpm'
# Check an exact version only when the pinned source/operator policy requires it.
pnpm --version
```

Use this same explicitly supplied PATH for the subsequent `factory run`. Local
validation and preflight now use non-login `sh -c`, not ambient login-profile
tool setup. Fresh activation rechecks current literal executable availability
before GitHub projection, target work or attempt state. Missing tools and
supported exact base `packageManager` npm/pnpm version mismatches produce an
actionable error and structured private diagnostics; status stays `not-started`.
This is not a retry of a previously failed run, and source authorization and
later exact-tree script/hook checks are unchanged.

Read `unverified` preflight observations explicitly: dynamic or nested commands,
target-owned lookup shells (including symlink aliases), unresolved shell PATH
precedence,
quoted compounds, relative PATH entries, generated target executables and
unsupported version policies require separate operator inspection. Preflight
does not execute their commands or bodies. Its version probe runs only a safely
resolved host npm/pnpm `--version`, outside the target, for an exact supported
pin; it never runs a target executable to discover a version. A ready literal
entrypoint is not a claim that script internals, plugins, interpreter dependencies
or all runtime prerequisites are satisfied. A planning preview does not preserve
host readiness across environment changes.

## Fresh disposable Objective

1. Create a new GitHub repository you control from the [public disposable target fixture](../test/fixtures/disposable-target/) and push its initial `main`. Create its Objective issue from the [same-path Git LFS Objective](../test/fixtures/objectives/same-path-lfs.md), which requires the existing ordinary `assets/source.png` blob to become required LFS at the same path without changing its exact bytes. Use a new repository and fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
2. Follow only public instructions and the installed interface. Use `factory install --repository OWNER/REPO --checkout /absolute/target --concurrency 2 --delivery native-stack --planning-model gpt-5.6-sol --planning-reasoning medium --review-model gpt-5.6-sol --review-reasoning medium --worker-model gpt-5.6-luna --worker-reasoning medium` (or record other explicit operator-selected Codex values); run `factory plan --objective N --output /absolute/private/plan.json`; inspect the exact two-item graph, source and command-authority receipts, the canonical controller-capability value and digest, and every validation command. A clean review must not add a target Work Item or command solely to reimplement the supplied controller guarantees. Resolve any genuine named review question; then run `factory run --objective N --plan /absolute/private/plan.json`.
3. Use `factory status --objective N` and `factory status --objective N --json` for the current atomic snapshot. Use `factory diagnostics --objective N` for a private timeline and `factory logs --objective N --item ID` for a recorded attempt's worker output; add `--follow` only while observation is needed. These outputs can include private target content and never authorize continuation by themselves. When requested, use `factory review` and `factory select` with the complete chosen AssetSet and explicit `--bind` for each dependent. Resume with `factory run --objective N`. If status pauses on a result criterion, inspect its named evidence and exact tree; a bounded text excerpt or opaque blob descriptor is not a complete large file. A truncated text excerpt requires exact-tree operator decision even if the reviewer reported pass; inspect the full tree or repeat review with a larger `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` and reviewer context. Ask the operator to accept or refuse that criterion, record `factory decide-result --objective N [--item ID] --tree EXACT_TREE_SHA --outcome accept|refuse --actor NAME --reason TEXT`, then resume `factory run --objective N` after acceptance. Include `--item` for a Work Item and omit it for final Objective acceptance. Inspect the final validation result, GitHub issues/PRs, merged default-branch head, and hydrated media bytes.
4. Record the release URL, tag and commit, tarball digest, marketplace source and installed version, target Objective and PR identities, selected AssetSet and same-path LFS evidence, validated tree, exact final head, final commands, pre-publication object proof, hydration receipt, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). The target repository may be private, but the public report must omit its sensitive content, worker logs, and diagnostic details.

Issue #26 is a separate private adopter smoke using the new exact published artifact after its public disposable gate succeeds. The `v0.1.0` proof is historical and does not qualify changed code. The published v0.1.2 artifact was blocked at read-only graph review; v0.1.3 reached a human-accepted exact graph but paused at Work Item result review because the review packet omitted authoritative attempt provenance. The v0.1.4 gate then proved the added packet for the first root, but native replay exposed that its mutable delivery base had been mislabeled as immutable execution provenance for the second root. The v0.1.5 gate proved immutable start facts across replay, and v0.1.6 proved native predecessor/layer facts before pausing on missing ownership/resource evidence and ambient Codex model policy. The v0.1.7 combined gate passed those corrections, while its dedicated greenfield-pnpm gate exposed that planning review omitted command receipts/final commands and activation re-reviewed an unchanged preview. The v0.1.8 gate proved the complete planning packet and zero-review activation, then paused because result-review command receipts were not individually bound to their exact tree and delivery observations did not separately name the result commit and tree. The v0.1.9 gate proved that corrected Work Item path, then paused at final Objective review because the aggregate packet did not expose authoritative per-Work-Item Git deltas. Those outcomes remain recorded in [BUILD-STATUS.md](BUILD-STATUS.md); v0.1.10 then passed its own fresh installed disposable gate and closed #44, #64, and #67 without a result override or retry.

## Open release decisions

An interrupted regular Work Item still `running` at `deliver` is not a supported
automatic continuation. Follow the [interrupted-delivery guidance](../README.md#interrupted-regular-delivery):
preserve its original snapshot and exact remote evidence, do not replay or edit
state, and do not treat a repeated `run` or result decision as reconciliation.
The interrupted run remains nonqualifying; use a separately approved fresh
disposable target/run for a new release gate.

The published [`@azu/format-text@1.0.2` metadata](https://www.npmjs.com/package/@azu/format-text/v/1.0.2) declares BSD-3-Clause and names `azu` as author. Its npm tarball and [exact `gitHead` source tree](https://github.com/azu/format-text/tree/2f72a7bf808c0818a395c2323d77128352539297) provide no license file or copyright holder/year. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) includes the [canonical SPDX BSD-3-Clause terms](https://spdx.org/licenses/BSD-3-Clause.html), preserves the unfilled copyright variables, and records the publisher metadata without inventing attribution. **A maintainer must review this documented upstream omission before release**; the generic text cannot replace a package-specific copyright notice the publisher never supplied. All other non-optional production packages provide a license file or an explicit publisher licensing statement. The optional Codex platform packages declare Apache-2.0; the notices include the Codex SDK's Apache-2.0 text for the same version.

An operator must authorize each public tag and GitHub Release after the code/CI/package gates pass; the installed disposable Objective is the subsequent acceptance gate. npm publication is not part of this route and requires no npm publishing credentials.
