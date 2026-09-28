# Public release procedure

This is the maintainer procedure for preparing, publishing and qualifying a Factory release. For ordinary installation and use, start with the [README](../README.md). Use the [release checklist](RELEASE-CHECKLIST.md) to check the deliverables.

## Distribution shape

Candidate v0.1.35 carries [PR #213](https://github.com/clockgrove/factory/pull/213): literal Git patch evidence shared by review prompts and exact citation grounding. Publication, distribution verification and exact-artifact qualification are pending. The earlier v0.1.34 public scenario was accepted; its evidence does not qualify changed bytes. Execution remains in [#206](https://github.com/clockgrove/factory/issues/206), with final adopter acceptance in [#207](https://github.com/clockgrove/factory/issues/207). Earlier artifact records remain immutable.

Earlier published artifacts and their evidence remain unchanged. Publication and installation checks do not establish Objective qualification.

The pinned Git marketplace supplies the plugin manifest and use skills. The matching GitHub Release supplies a separate Linux x64 CLI tarball with the default Codex dependency tree bundled for offline installation. Optional Claude and Copilot SDKs are installed separately; consult [local harnesses](AGENT-HARNESSES.md). Installed default runtime requires Node.js 22 or later. Building from source has separate tooling requirements below. npm registry publication and a universal Plugins Directory listing are not part of this distribution route.

Keep tag, package version, plugin version, marketplace ref and artifact identity aligned. Never rebuild a published version from later main, replace its assets or transfer qualification from different bytes.

## Build one candidate

For a new release, freeze the reviewed candidate and its version before running the coordinated gates. Preserve all published releases and their evidence; never rebuild them to include later source changes.

From a clean Linux x64 source checkout at the accepted commit, with Node.js 22.12 or later, Git, Git LFS, and public npm access, with optional dependencies enabled for source checks and notice generation, confirm `git status --porcelain` is empty. Choose an empty absolute release directory outside the checkout, then run:

```sh
FACTORY_RELEASE_VERSION=$(node -p "require('./package.json').version")
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
sha256sum "clockgrove-factory-${FACTORY_RELEASE_VERSION}.tgz" > SHA256SUMS
```

Inspect the tarball file list for the manifest, installed skills, CLI, license, logo, notices, and bundled production dependency tree. In a separate empty prefix, install the tarball with `npm install --offline --prefix /absolute/private/check-prefix "./clockgrove-factory-${FACTORY_RELEASE_VERSION}.tgz"` using an empty npm cache; verify `factory help`, compare every installed bundled package version with `package-lock.json`, and check that notices cover the same tree. Record `git rev-parse HEAD`, package version, tarball SHA-256, and the passing CI run. Preserve all existing protected release tags and assets. Publication uses the operator-delegated release authority, normal controls and a protected tag at the exact accepted commit. Record the expected SHA-256 outside mutable Release assets in [BUILD-STATUS.md](BUILD-STATUS.md). This procedure does not itself publish or tag anything.

## Install from public artifacts

In a clean Linux x64 environment with Node.js 22 or later, after the release exists, set aside fresh Factory roots outside the target checkout while keeping GitHub CLI authentication reachable:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
FACTORY_TRIAL_ROOT=$(mktemp -d)
export XDG_CONFIG_HOME="$FACTORY_TRIAL_ROOT/config"
export XDG_STATE_HOME="$FACTORY_TRIAL_ROOT/state"
gh auth status
```

After publication, install the v0.1.35 tag and matching release assets:

```sh
codex plugin marketplace add clockgrove/factory --ref v0.1.35
codex plugin add factory@clockgrove
gh release download v0.1.35 --repo clockgrove/factory \
  --pattern clockgrove-factory-0.1.35.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Also compare the digest with the independent value in the release preparation PR.
npm install --offline --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.35.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Verify `factory@clockgrove` appears in `codex plugin list --json` before the live Objective. The installed `director` and `setup` skills guide agent use; the `factory` CLI above supplies their documented operations. The CLI prefix, Factory configuration, state, review exports, and planning candidates must stay outside the target checkout. A target still requires GitHub CLI access and an authenticated Codex SDK environment; media Objectives require Git LFS.

## Local host-toolchain check

Use the same host environment and exact installed artifact for preflight and qualification. Successful package installation alone does not establish host readiness.

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

The release owner records the exact artifact, scenario, source scope, owner, acceptance, resource/concurrency bounds and per-run attempt limits before execution. For the current release, [#206](https://github.com/clockgrove/factory/issues/206) owns the approved representative foundation, policy, same-path media and final-integration scenario. Preserve its complete requirements. The [public fixture](../test/fixtures/disposable-target/) and [same-path LFS example](../test/fixtures/objectives/same-path-lfs.md) are reusable inputs, not permission to substitute a smaller gate.

1. Verify predecessor termination and owned-process cleanup before creating a fresh disposable target. Preserve original runs, artifact identities and accounting. Use supported lifecycle operations and existing authority; new state roots must never bypass an active run or resource fence.
2. Install the exact public artifact and complete [host and worker readiness](#controller-host-and-worker-readiness). Bind the authorized target with its approved concurrency, delivery and model selections. Create a preview with `factory plan --objective N --output /absolute/private/plan.json`; review all source obligations, worker inputs, dependencies, ownership and exact Work Item/final commands. Run the unchanged accepted preview with `factory run --objective N --plan /absolute/private/plan.json`.
3. Observe with `factory status`, `factory diagnostics` and `factory logs`. Use installed `factory review` and `factory select` for complete human-selected AssetSets. Prove independent concurrent work, exact-tree item acceptance, protected delivery, byte-identical LFS migration, final validation, automatic Objective acceptance and independent fresh-clone hydration. Human decisions and retries are supported product operations, but must not be substituted for a gate that requires automatic acceptance.
4. Audit terminal state, accounting and owned-resource cleanup. Missing usage remains unknown. Record exact source/artifact, host, configuration, Objective, issue/PR, result/integrated tree, selected bytes, LFS upload/hydration and acceptance identities in the qualification issue; retain private logs and target information in their authorized private destination. Every fixture is deleted under applicable disposal authority or retained with reason, owner and review trigger.
5. Only after public acceptance and independent audit, run the separately authorized actual Clockgrove pilot with the same artifact. Actual adopter acceptance completes #207; a successful public fixture alone does not.

On failure, stop and preserve the evidence, diagnose the concrete blocker, and establish a meaningful correction before a bounded successor. Do not revive terminal runs, blindly retry unchanged failures or carry successful evidence onto changed bytes.

## Open release decisions

An interrupted regular Work Item still `running` at `deliver` is not a supported automatic continuation. Preserve its snapshot and exact remote evidence; do not replay delivery, edit state or treat a result decision as reconciliation. The interrupted run remains nonqualifying. A corrected successor must meet the existing qualification and resource requirements.

The published [`@azu/format-text@1.0.2` metadata](https://www.npmjs.com/package/@azu/format-text/v/1.0.2) declares BSD-3-Clause and names `azu` as author, but its tarball and [exact source tree](https://github.com/azu/format-text/tree/2f72a7bf808c0818a395c2323d77128352539297) omit a license file and copyright holder/year. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) preserves canonical terms and the documented omission without inventing attribution. Retain maintainer review of that omission in the release evidence; do not represent generic terms as a supplied package-specific notice.

Publication and model-backed qualification use existing delegated authority and normal tool controls within their recorded scope. These procedures do not expand target access, source disclosure, provider usage, security policy or spending limits.

## Historical release procedures

Previous preparation instructions and status are preserved as [historical release records](history/PUBLIC-RELEASE-2026-09-28.md). They are not current execution instructions.

### Prepare v0.1.30

See the [completed preparation record](history/PUBLIC-RELEASE-2026-09-28.md#prepare-v0130).

### Prepare v0.1.29

See the [completed preparation record](history/PUBLIC-RELEASE-2026-09-28.md#prepare-v0129).

### Prepare v0.1.28

See the [completed preparation record](history/PUBLIC-RELEASE-2026-09-28.md#prepare-v0128).

### Qualify published v0.1.26

See the [historical qualification instructions](history/PUBLIC-RELEASE-2026-09-28.md#qualify-published-v0126).
