> Historical snapshot retained on September 28, 2026. Status and instructions below describe earlier checkpoints, not current work. See the [current release procedure](../PUBLIC-RELEASE.md) and [artifact record](../BUILD-STATUS.md). Do not execute historical preparation or restart preserved runs from this record.

# Public release and third-party installation

This is the reusable release and installation procedure. [#25](https://github.com/clockgrove/factory/issues/25) accepted `v0.1.0`, the v0.1.7 gate completed [#46](https://github.com/clockgrove/factory/issues/46), [#48](https://github.com/clockgrove/factory/issues/48), and [#51](https://github.com/clockgrove/factory/issues/51), and v0.1.8 proved [#60](https://github.com/clockgrove/factory/issues/60)'s deterministic activation. The fresh installed v0.1.10 gate completed and closed [#44](https://github.com/clockgrove/factory/issues/44), [#64](https://github.com/clockgrove/factory/issues/64), and [#67](https://github.com/clockgrove/factory/issues/67). The public v0.1.13 gate remained nonqualifying when result review lacked controller-owned capture and selection evidence, v0.1.14 remained nonqualifying after a provider stream never emitted a terminal result, v0.1.15 was superseded before a live Objective because its installed setup skill misstated the worker default, v0.1.16 preserved a validated Work Item result after reviewer capacity was converted directly into a human decision, v0.1.17 preserved a selected result whose digest-bound receipt lacked manifest provenance, v0.1.18 preserved a selected result whose capture receipt lacked controller-imported input identity, v0.1.19 preserved a fail-closed planning attempt whose response used Markdown-prefixed citation headings, and v0.1.20 preserved a validated selected result whose automatic review packet did not distinguish the worker result from controller materialization. Public v0.1.21 independently completed [#81](https://github.com/clockgrove/factory/issues/81)'s installed-artifact gate; see [exact acceptance evidence](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/V0.1.21-ACCEPTANCE.md) Keep every tag, marketplace entry, tarball, and evidence record tied to the same source commit. The [build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md) distinguishes publication from installed Objective acceptance. Do not run Factory against this repository.

## Distribution shape

Published [v0.1.30](https://github.com/clockgrove/factory/releases/tag/v0.1.30)
uses frozen reviewed source `7bcc6388cbef75721033f550b59127273487c430`, tree
`14e1524e45f61e45a3d67d3f451c9ce8fd931ba0`. The 150230063-byte tarball has SHA-256
`cac13bc37ca7c23d3c19b97ed6c4731b25312467b4e38850658fee32a0eb91e8`.
[PR #188](https://github.com/clockgrove/factory/pull/188) records source/artifact
review, integrated-tree verification, byte-identical reproduction and independent
public download/offline installation. It contains #185 and previously integrated
#180. Later repository-rename metadata is excluded; never repack from later main.

Published [v0.1.29](https://github.com/clockgrove/factory/releases/tag/v0.1.29)
uses frozen reviewed source `401d74da56d234ba6958a3b1ce9e0b7b5f5eeecb`, tree
`63f2471e0acba681f5c5c2f831543bc7d424af33`. The 150224627-byte tarball's SHA-256 is
`e59163f5c69f7002f3efd7274fdf724e95453de187df051d29cd0d41983748ec`.
[PR #183](https://github.com/clockgrove/factory/pull/183) records exact
source/artifact and separate metadata integration evidence. Concurrent #180 is
excluded from these release bytes even though it is present in main.

The published v0.1.30 [Clockgrove marketplace](https://github.com/clockgrove/factory/blob/v0.1.30/.agents/plugins/marketplace.json) pins the plugin at this repository's root to that immutable tag. Public installation below uses that published marketplace. Codex loads its manifest and use skills from the Git tag. The TypeScript CLI and its bundled production dependency tree are supplied in a separate npm tarball attached to the matching public GitHub Release; marketplace installation does not build the CLI. The bundled Codex path installs offline and needs no npm publishing account. Optional Claude/Copilot SDK installation is separate. The tarball targets Linux x64 with Node.js 22 or later. The repo marketplace is a public distribution source for people who add it; a listing in the universal Plugins Directory would require a separate submission and review.

Published [v0.1.28](https://github.com/clockgrove/factory/releases/tag/v0.1.28)
uses source `dc7097b487701cab94aa1d3f5aa561faa3416998`. Exact source/artifact
checks and byte-identical reproduction are recorded in [build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md).
For those historical bytes, follow [their immutable publication instructions](https://github.com/clockgrove/factory/blob/79abc5784164da4c6de133074fdce0dceb06261b/README.md#install-published-v0128); fresh
public live qualification and actual adopter acceptance remain separate in #26.

Published [v0.1.27](https://github.com/clockgrove/factory/releases/tag/v0.1.27)
passed publication and independent public-download/offline installation checks.
Its representative public Objective remains failed after the final note-only
worker refused its pointer checkout in the original attempt and one explicit
retry. Preserve that run and artifact; source correction #174 / PR #175 belongs
to the new candidate. See [build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md) for exact identities.
Current published installation uses v0.1.30 as described above.

Published [v0.1.26](https://github.com/clockgrove/factory/releases/tag/v0.1.26)
includes the accepted #159 planning lifecycle correction. Its exact source, tree,
tarball digest, full Node 22/24 gates and independent public-download/offline
installation proof are recorded in [build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md). Public live
qualification and actual adopter acceptance remain pending in
[issue #26](https://github.com/clockgrove/factory/issues/26).
Current published installation uses v0.1.30 as described above.
The earlier release evidence below applies only to those immutable artifacts.

Published [v0.1.25](https://github.com/clockgrove/factory/releases/tag/v0.1.25) carries the accepted #150 contained ignored-link correction
from [PR #151](https://github.com/clockgrove/factory/pull/151), integrated
at `92ef6eeac89e792016b5f20ad69cefb707e9debb`, reviewed tree
`60ad230af22450f46d00e2ccece8555dc883d6cb`. Metadata PR #152 produced release
source `b641ccdccdb969f14c64a66da751c22f6be5bd6d`, tree
`3569c631cdc6c878836d190e0069cd87f828d6c3`; the 150177209-byte tarball has
SHA-256 `953324353b903624dbe2471c10310ed60fcf419538e058906b2e22b855ff5e09`.
Metadata/CI, reproduction, public download, offline installation and pinned
marketplace checks passed; [build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md) links their durable
evidence. The first combined gate is nonqualifying after a provider idle timeout,
not a product finding. The [wholly fresh public gate](https://github.com/clockgrove/factory-v0125-gate-20260927-fresh/issues/1)
has not yet qualified; automatic gate and actual #26 adopter acceptance remain pending.
Historical v0.1.24 evidence below remains immutable and does not qualify changed bytes.

Published [v0.1.24](https://github.com/clockgrove/factory/releases/tag/v0.1.24) carries the accepted and closed #145 required-shape correction
from integration `2f3d4f5a820b1001f41cff731640fc4085552630`. Its metadata does
not change runtime, tests, skills, dependencies, scripts or license bodies.
Its release source is `e0fc91343563e6a3b19eb92dd64d419ba03b487a`, tree
`25f80920ebb5848db019c384fcefbce6738f562a`; the 150176214-byte tarball has SHA-256
`513f46100ce1956c481d26a6ef96f63a62035527c4437268afac3c10e322ef31`.
Publication, independent public-download/offline installation and marketplace
verification passed. The [fresh public installed Objective](https://github.com/clockgrove/factory-v0124-gate-20260926-batched/issues/1)
completed with whole-set human selection, automatic final review and independent
fresh-clone LFS proof at `5ed4b237d51943c52ea5d2f1f84c9eb1820bb199`, tree
`f5d247803aa6a83599e22c7531d06affdd5900df`.
[Build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md) records exact checks and selected-byte identity.
This is the public prerequisite only; actual adopter #26 remains OPEN/unaccepted.
Install only its immutable published bytes; do not rebuild or retag v0.1.24
from this later documentation handoff.

Published [v0.1.23](https://github.com/clockgrove/factory/releases/tag/v0.1.23)
includes the heading-source result-review correction and later accepted source
leaves, not deferred #55 optional harness work. [Build status](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md)
records its exact source/tree, digest and passing artifact/installation checks.
Its three fresh heading-rich planning attempts remain historical and
nonqualifying. The first fresh public plan is preserved after a
temporary-staging versus delivered-ownership wording contradiction; no override,
replan or activation occurred. A second staging-clarified plan also remains
nonqualifying, and the third minimum-clarified invocation failed initial
required-shape validation before a plan file or activation. The raw real failed
field is unknown. [#145](https://github.com/clockgrove/factory/issues/145)
is now accepted and closed for its bounded source correction; v0.1.24 is the
published artifact with its own accepted public gate recorded above. Do not patch
v0.1.23 or continue editing fixtures to evade generated-graph failures.
The failed v0.1.21 adopter run is preserved without reuse. Version
0.1.22 remains reserved by the frozen unreleased #55 candidate.

Publish a candidate tag and release asset only after its code, CI, packaging, and notice checks pass; then run the disposable gate from a fresh public download. Publication is not acceptance and does not authorize the Clockgrove pilot. Do not point the marketplace at a moving branch. If the candidate version changes, update the package, manifest, marketplace ref, changelog, README status, and commands here together before tagging.

## Prepare v0.1.30

This completed procedure is historical. v0.1.30 is published; do not repeat
publication or replace its tag/assets. Reviewed source `7bcc6388cbef75721033f550b59127273487c430`
was integrated at `28ca49d65ffdccb66d49bfe0da246f3126c326d1` with the identical
tree. Later rename metadata is not part of the release.

Independent metadata and artifact reviews, source/static/notices checks,
actual Node22.0 tests (232 pass, one optional-provider runtime skip), hosted
Node24 tests (233 pass), normal offline installation and CLI/scanner checks passed.
Node22.0 tests used dependencies installed on Node24. Fresh Node22.0 source
bootstrap omitted optional SDK types and failed; #190 tracks the source-build
minimum. Reproduction used Node24.20 installation/build and Node22.0/npm10
packing and was byte-identical. Independent public download/installation passed.

Publication and installation do not qualify model behavior or authorize another
public/adopter attempt. #26 owns the separately authorized artifact-bound
qualification decision, including resource limits and preserved unknown accounting.
#162/#164 remain deferred.

## Prepare v0.1.29

This completed procedure is historical. v0.1.29 is published; do not repeat
publication or replace its tag/assets. The release source is the reviewed
`401d74d` commit, which is in main's ancestry. Metadata merge `e324b4c` contains
concurrent #180 and is not the release source. Reproduction from `401d74d` was
byte-identical. Normal controls accepted fresh human approval for this exact
publication after the initial approval-control stop; #26 preserves that history.

This release includes accepted #179 / PR #181 exact-tree inventory evidence
and #170 / PR #178's Copilot editor correction. The metadata-only release change
adds no runtime, dependency, skill or accounting scope. Concurrent #180 is excluded.

Freeze and independently review the exact candidate, then run source/static/full
test/notices gates, including the supported Node22 floor and exact-head CI.
Pack `clockgrove-factory-0.1.29.tgz` once at the stable candidate; record its
source/tree, SHA-256, size and source/tar/install parity. Use a normal empty-cache
offline installation and verify bundled dependencies and CLI/scanner behavior.
After guarded merge, verify the integrated tree and byte-identical reproduction.

Standing human Factory release delegation covers readiness and publication
after these checks through normal controls; the earlier source-only #179 assignment
did not itself authorize publication. If controls require renewed consent, pause
for the exact request rather than bypassing them. Publish a new v0.1.29 tag and
release, preserving v0.1.28, then independently verify its public download and
normal installation. Record concise exact evidence in #26 and the release/PR.

Only then prepare one artifact-bound fresh public qualification approval retaining
the four outcomes, concurrency 2, seven commands, public source/image bytes and
stop conditions. No live execution, old-run continuation, retry or override is
authorized by release publication. Earlier provider qualification belongs to its
own artifact; the offline install proves the bundled Codex path only.

## Prepare v0.1.28

This section records the completed candidate procedure. v0.1.28 is now published;
do not repeat publication, rebuild it from later main or replace its assets.

This metadata-only candidate starts from accepted #174 / PR #175 integration
`2948de665f7d0abc9c98df701b2a03178fcea773`, tree
`1767b32283cb61d49bb353fe0eda94219f518ce4`, including accepted #55, #149, #167 and
#168. It adds no runtime or dependency changes beyond that integration. Keep
public installation pinned to v0.1.27 until the new release exists; never retag
it or modify its preserved failed run.

First check metadata parity, documentation links and formatting, then freeze
the candidate for independent review. At that stable boundary run the coordinated
source/static/full-test/notices gates, preserve actual Node22 floor coverage,
and pack `clockgrove-factory-0.1.28.tgz` once. Record exact source/tree, CI,
SHA-256 and package/dependency parity; verify a normal empty-cache offline
installation. Earlier #55 installed Codex/Claude proof and v0.1.27 publication
checks are not evidence for these new combined artifact bytes.

After guarded integration and verification of the reviewed tree, reproduce from
the exact merged source before guarded tag/release publication. Within the
operator-delegated Factory release scope, the release owner decides readiness
after required review and checks; normal approval controls remain in force.
Independently verify its public download and install before using the separately
reviewed full public qualification source and then the authorized actual adopter.
No live call, release, installation or target mutation is authorized by this
metadata preparation. Live execution still requires its applicable target and
provider authority. Copilot live qualification remains separately deferred in #170.

## Qualify published v0.1.26

The immutable release includes accepted #159 / PR #160 plus the merged offline
regression and host-launch guidance. Publication and independent installation
checks passed; do not rebuild, retag or replace its release assets from this later
documentation checkout. Version 0.1.22 remains reserved for the separate #55
candidate. Preserve v0.1.25 and its paused plans/runs.

Use the [host readiness procedure](#controller-host-and-worker-readiness) and
the bounded representative public Objective to qualify the downloaded artifact
before the separately authorized actual adopter. Preserve the public scenario's
full coverage; scripted prompt tests do not establish live model adherence.
Record exact artifact, source, plan, host and final result identities in issue #26.
Publication alone does not establish live acceptance, and this procedure does
not authorize provider execution.

## Build one candidate

For historical v0.1.28 reproduction, use its exact published tag, never later
main or replacement release assets. The following commands retain that version
as an example; a future release must use its own reviewed version and identity.

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
sha256sum clockgrove-factory-0.1.28.tgz > SHA256SUMS
```

Inspect the tarball file list for the manifest, installed skills, CLI, license, logo, notices, and bundled production dependency tree. In a separate empty prefix, install the tarball with `npm install --offline --prefix /absolute/private/check-prefix ./clockgrove-factory-0.1.28.tgz` using an empty npm cache; verify `factory help`, compare every installed bundled package version with `package-lock.json`, and check that notices cover the same tree. Record `git rev-parse HEAD`, package version, tarball SHA-256, and the passing CI run. Preserve all existing protected release tags and assets. Publication uses the operator-delegated release authority, normal controls and a protected tag at the exact accepted commit. Record the expected SHA-256 outside mutable Release assets in [BUILD-STATUS.md](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md). This procedure does not itself publish or tag anything.

## Install from public artifacts

In a clean Linux x64 environment with Node.js 22 or later, after the release exists, set aside fresh Factory roots outside the target checkout while keeping GitHub CLI authentication reachable:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
FACTORY_TRIAL_ROOT=$(mktemp -d)
export XDG_CONFIG_HOME="$FACTORY_TRIAL_ROOT/config"
export XDG_STATE_HOME="$FACTORY_TRIAL_ROOT/state"
gh auth status
```

Then install from the current public tag and release assets:

```sh
codex plugin marketplace add clockgrove/factory --ref v0.1.30
codex plugin add factory@clockgrove
gh release download v0.1.30 --repo clockgrove/factory \
  --pattern clockgrove-factory-0.1.30.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Also compare the digest with the independently recorded release value in PR #188.
npm install --offline --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.30.tgz
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

## Controller host and worker readiness

Launch the Factory controller through an operator-authorized ordinary host
terminal or approved host execution mechanism. A controller started inside an
agent command sandbox passes that enclosing filesystem and mount namespace to
its workers. Backgrounding, `nohup`, or detaching the child does not escape it.
Keep the worker's own sandbox, approval policy, credential filtering, network
policy and target ownership checks in force. Host launch authority does not
waive those safeguards or authorize new target access or provider spending.

Before model-backed work, use the exact installed harness's supported model-free
sandbox diagnostic from that same host launch context, with the intended worker
policy and managed requirements retained. In disposable paths, prove shell
execution, an allowed workspace write and refusal of an out-of-scope write;
record the executable/version, launch context, effective policy and results.
Check the installed CLI help rather than assuming another version's syntax.
For bundled Codex 0.156.0 the command is `codex sandbox -- COMMAND`, with no
`linux` subcommand; its named workspace diagnostic is
`codex sandbox --permission-profile :workspace --include-managed-config --cd ABSOLUTE_DISPOSABLE_DIRECTORY -- COMMAND`.
Use the bundled executable, and reconcile its effective permissions and network
policy with the worker configuration before treating the probe as comparable.
Do not change security policy to make a probe pass.

If Codex reports `app-server socket directory must be a user-owned directory
with mode 0700`, stop and inspect host versus enclosing-sandbox metadata before
another model call. In Codex 0.156.0, the shared socket directory is the
canonical `/tmp/codex-daemon-<effective-uid>`, independent of `CODEX_HOME` and
`TMPDIR`. An outer Codex sandbox deliberately masks it with read-only mode
`000`; the underlying host directory may already be correctly owned and `0700`.
Do not chmod, unmask, bind-mount, relocate or bypass that protection, move
credentials, or retry a failed worker to test host readiness. Correct the
controller launch context under explicit host authority and repeat only the
model-free preflight. Preserve failed run identities and evidence; any new
worker attempt still needs its existing explicit authority. The matching
[upstream directory check](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/uds/src/daemon_directory.rs)
and [sandbox mask](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/linux-sandbox/src/bwrap.rs)
explain this version's behavior.

Successful installation, login, planning or model replies do not prove worker
tools can run. After the model-free check, use the already required bounded
public installed Objective to prove a real worker's shell/file tools,
collection, exact-tree validation and GitHub delivery before private execution.
When that same scenario covers these paths, do not add another preliminary live
smoke or another fixture. The public scenario must still finish its declared
integration, media and hydration acceptance; the preflight alone is not
qualification. Keep evidence specific to the artifact, harness/provider, host,
policy and scenario actually exercised. Codex proof does not qualify Claude or
Copilot; unavailable or deferred provider proof remains separately pending
under its existing milestone rather than blocking an independently authorized
Codex-only pilot.

## Fresh disposable Objective

1. Create a new GitHub repository you control from the [public disposable target fixture](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/test/fixtures/disposable-target) and push its initial `main`. Create its Objective issue from the [same-path Git LFS Objective](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/test/fixtures/objectives/same-path-lfs.md), which requires the existing ordinary `assets/source.png` blob to become required LFS at the same path without changing its exact bytes. Use a new repository and fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
2. Complete the model-free preflight in [controller host and worker readiness](#controller-host-and-worker-readiness); this Objective supplies its real-worker qualification. Follow only public instructions and the installed interface. Use `factory install --repository OWNER/REPO --checkout /absolute/target --concurrency 2 --delivery native-stack --planning-model gpt-5.6-sol --planning-reasoning medium --review-model gpt-5.6-sol --review-reasoning medium --worker-model gpt-5.6-luna --worker-reasoning medium` (or record other explicit operator-selected Codex values); run `factory plan --objective N --output /absolute/private/plan.json`; inspect the exact two-item graph, source and command-authority receipts, the canonical controller-capability value and digest, and every validation command. A clean review must not add a target Work Item or command solely to reimplement the supplied controller guarantees. Resolve any genuine named review question; then run `factory run --objective N --plan /absolute/private/plan.json`.
3. Use `factory status --objective N` and `factory status --objective N --json` for the current atomic snapshot. Use `factory diagnostics --objective N` for a private timeline and `factory logs --objective N --item ID` for a recorded attempt's worker output; add `--follow` only while observation is needed. These outputs can include private target content and never authorize continuation by themselves. When requested, use `factory review` and `factory select` with the complete chosen AssetSet and explicit `--bind` for each dependent. Resume with `factory run --objective N`. If status pauses on a result criterion, inspect its named evidence and exact tree; a bounded text excerpt or opaque blob descriptor is not a complete large file. A truncated text excerpt requires exact-tree operator decision even if the reviewer reported pass; inspect the full tree or repeat review with a larger `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` and reviewer context. Ask the operator to accept or refuse that criterion, record `factory decide-result --objective N [--item ID] --tree EXACT_TREE_SHA --outcome accept|refuse --actor NAME --reason TEXT`, then resume `factory run --objective N` after acceptance. Include `--item` for a Work Item and omit it for final Objective acceptance. Inspect the final validation result, GitHub issues/PRs, merged default-branch head, and hydrated media bytes.
4. Record the release URL, tag and commit, tarball digest, marketplace source and installed version, target Objective and PR identities, selected AssetSet and same-path LFS evidence, validated tree, exact final head, final commands, pre-publication object proof, hydration receipt, and operator acceptance in [BUILD-STATUS.md](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md). The target repository may be private, but the public report must omit its sensitive content, worker logs, and diagnostic details.

Issue #26 is a separate private adopter smoke using the new exact published artifact after its public disposable gate succeeds. The `v0.1.0` proof is historical and does not qualify changed code. The published v0.1.2 artifact was blocked at read-only graph review; v0.1.3 reached a human-accepted exact graph but paused at Work Item result review because the review packet omitted authoritative attempt provenance. The v0.1.4 gate then proved the added packet for the first root, but native replay exposed that its mutable delivery base had been mislabeled as immutable execution provenance for the second root. The v0.1.5 gate proved immutable start facts across replay, and v0.1.6 proved native predecessor/layer facts before pausing on missing ownership/resource evidence and ambient Codex model policy. The v0.1.7 combined gate passed those corrections, while its dedicated greenfield-pnpm gate exposed that planning review omitted command receipts/final commands and activation re-reviewed an unchanged preview. The v0.1.8 gate proved the complete planning packet and zero-review activation, then paused because result-review command receipts were not individually bound to their exact tree and delivery observations did not separately name the result commit and tree. The v0.1.9 gate proved that corrected Work Item path, then paused at final Objective review because the aggregate packet did not expose authoritative per-Work-Item Git deltas. Those outcomes remain recorded in [BUILD-STATUS.md](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/docs/BUILD-STATUS.md); v0.1.10 then passed its own fresh installed disposable gate and closed #44, #64, and #67 without a result override or retry.

## Open release decisions

An interrupted regular Work Item still `running` at `deliver` is not a supported
automatic continuation. Follow the [interrupted-delivery guidance](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/README.md#interrupted-regular-delivery):
preserve its original snapshot and exact remote evidence, do not replay or edit
state, and do not treat a repeated `run` or result decision as reconciliation.
The interrupted run remains nonqualifying; use a separately approved fresh
disposable target/run for a new release gate.

The published [`@azu/format-text@1.0.2` metadata](https://www.npmjs.com/package/@azu/format-text/v/1.0.2) declares BSD-3-Clause and names `azu` as author. Its npm tarball and [exact `gitHead` source tree](https://github.com/azu/format-text/tree/2f72a7bf808c0818a395c2323d77128352539297) provide no license file or copyright holder/year. [THIRD_PARTY_NOTICES.md](https://github.com/clockgrove/factory/blob/1b7d517a0ada4054027bea8a166dce4cb1fe297e/THIRD_PARTY_NOTICES.md) includes the [canonical SPDX BSD-3-Clause terms](https://spdx.org/licenses/BSD-3-Clause.html), preserves the unfilled copyright variables, and records the publisher metadata without inventing attribution. **A maintainer must review this documented upstream omission before release**; the generic text cannot replace a package-specific copyright notice the publisher never supplied. All other non-optional production packages provide a license file or an explicit publisher licensing statement. The optional Codex platform packages declare Apache-2.0; the notices include the Codex SDK's Apache-2.0 text for the same version.

Public tags and GitHub Releases require operator authority, which the recorded delegation to the release owner can satisfy within its agreed scope. The owner decides readiness only after the code/CI/package gates pass and follows normal approval controls. The installed disposable Objective is a subsequent, separately authorized acceptance gate. npm publication is not part of this route and requires no npm publishing credentials.
