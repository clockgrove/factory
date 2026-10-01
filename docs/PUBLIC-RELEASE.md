# Public release procedure

This is the maintainer procedure for preparing, publishing and qualifying a Factory release. For ordinary installation and use, start with the [README](../README.md). Use the [release checklist](RELEASE-CHECKLIST.md) to check the deliverables.

## Distribution shape

Candidate v0.1.62 supplies retained failed-candidate and corrected-result Git preservation proof within accepted ownership, plus validated admitted repair authority, to current, dependency and final review ([#409](https://github.com/clockgrove/factory/issues/409)). Native replay may change the result base and whole tree while preserving owned implementation. Operator diagnosis remains separate from controller facts; existing source, review, effect and finite allowance fences remain. Package/lock/plugin versions, marketplace ref and installation commands select this same candidate. Publication, installed checks and independent public verification remain pending under [#410](https://github.com/clockgrove/factory/issues/410). This does not grant acceptance, rescue historical runs or qualify the complete autonomous Objective pair.

Published [v0.1.61](https://github.com/clockgrove/factory/releases/tag/v0.1.61) permitted bounded correction of known amendment review findings ([#406](https://github.com/clockgrove/factory/issues/406)). All 138 whole installed tests and eight model-free preflights passed with zero skips, and [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/407) passed. That exact distribution evidence does not establish full autonomous Objective or adopter acceptance.

Published [v0.1.60](https://github.com/clockgrove/factory/releases/tag/v0.1.60) supplied controller-local executable observations to compilation, graph review and diagnosis ([#403](https://github.com/clockgrove/factory/issues/403)). All 133 whole installed tests and seven model-free preflights passed with zero skips, and [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/404) passed. That evidence proves the exact distribution and phase contracts; full autonomous Objective and adopter acceptance remain separate.

Published [v0.1.58](https://github.com/clockgrove/factory/releases/tag/v0.1.58) passed all 35 installed checks, five model-free preflights and [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/394#issuecomment-5926979213). It added the private Objective Gantt view and separate contributor tooling. Its clean release measurement and immutable artifact evidence remain bound to #394.

Published [v0.1.57](https://github.com/clockgrove/factory/releases/tag/v0.1.57) passed all 27 installed checks, five model-free preflights and [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/384#issuecomment-5925566535). Its clean release measurement and original artifact evidence remain preserved in #384. Release verification does not establish complete autonomous Objective or adopter acceptance; #243 and its required dependencies retain that scope.

Published [v0.1.54](https://github.com/clockgrove/factory/releases/tag/v0.1.54) aligns existing compiler, graph-review and planning-diagnosis guidance with one owner and complete proof for each whole source obligation ([#370](https://github.com/clockgrove/factory/issues/370)). Compound final criteria can use the existing final-review proof when one controller guarantee does not cover every clause. Unique obligation indices, duplicate rejection and independent final criterion acceptance remain required. Source gates, fresh-cache offline installation and all 40 installed compiler/QA checks passed without skips. [Independent public byte and pinned-plugin verification](https://github.com/clockgrove/factory/pull/372#issuecomment-5922896684) passed. See the [exact artifact record](BUILD-STATUS.md#immutable-v0154-artifact-record). These distribution and installed contract checks do not establish full autonomous Objective or adopter acceptance; #253, #331 and #254 retain their required acceptance under #243. Clockgrove retesting remains on hold until those gates pass.

Published [v0.1.53](https://github.com/clockgrove/factory/releases/tag/v0.1.53) delivers successful repeated same-app/exact-head check receipts ([#357](https://github.com/clockgrove/factory/issues/357)), complete read-only QA and aggregate dependency evidence, and submission fences after local item/final review preparation ([#361](https://github.com/clockgrove/factory/issues/361)). It also adds explicit permanent abandonment of an exact stopped Objective with uncertain read-only reviews after verified owned cessation ([#363](https://github.com/clockgrove/factory/issues/363)). Original markers, results, errors, evidence, consumed limits and unknown accounting are retained; the abandoned run cannot continue and remains unaccepted. Unresolved mutating effects remain fenced. Its source gates, fresh-cache offline audit and all 109 whole-file installed checks passed without skips. [Independent public byte and pinned-plugin verification](https://github.com/clockgrove/factory/issues/357#issuecomment-5920335558) passed. See the [exact artifact record](BUILD-STATUS.md#immutable-v0153-artifact-record). Actual historical run disposition, full autonomous Objective qualification and adopter acceptance remain separate outcomes.

Published [v0.1.52](https://github.com/clockgrove/factory/releases/tag/v0.1.52) has fresh-cache offline installation and 38 exact installed checks for retained started Work Items, original amendment failure digests and configured-secret status redaction under [#350](https://github.com/clockgrove/factory/issues/350) and [#348](https://github.com/clockgrove/factory/issues/348). [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/350#issuecomment-5917330492) passed. See the [exact artifact record](BUILD-STATUS.md#immutable-v0152-artifact-record). Public workspace qualification in [#263](https://github.com/clockgrove/factory/issues/263) remains bound to v0.1.47; full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253). Earlier evidence remains bound to its original bytes and scenarios.

Earlier published artifacts and their evidence remain unchanged. Publication and installation checks do not establish Objective qualification.

The pinned Git marketplace supplies the plugin manifest and use skills. The matching GitHub Release supplies a separate Linux x64 CLI tarball with the default Codex dependency tree bundled for offline installation. Optional Claude and Copilot SDKs are installed separately; consult [local harnesses](AGENT-HARNESSES.md). Installed default runtime requires Node.js 22 or later. Building from source has separate tooling requirements below. npm registry publication and a universal Plugins Directory listing are not part of this distribution route.

Keep tag, package version, plugin version, marketplace ref and artifact identity aligned. Never rebuild a published version from later main, replace its assets or transfer qualification from different bytes.

## Contributor release workflow

One contributor owns the release from the frozen candidate through publication. Run the stages sequentially with `scripts/release.mjs`: package, inspect, offline install, installed tests, model-free preflights, exact tag protection and publication. Do not delegate individual stages or run them in parallel. Independent source review precedes this command; one independent public audit follows it. This is a contributor procedure, not Factory's runtime scheduler or an adopter permission policy.

Prepare the package, lockfile, plugin and marketplace versions, changelog, notices and version-matched installation guidance before reviewing and freezing the candidate. Read the actual README, both skills and packaged use guides during that review; automate identity and version checks, not judgments about their meaning. Preserve earlier publication and qualification evidence. A later documentation edit cannot repair an already published archive.

Use a clean Linux x64 checkout with Node.js 22.12 or later, npm, Git, Git LFS, GitHub CLI and the Codex CLI needed for the public audit. The exact candidate must have passing Quality CI and an independent source/guidance review. The command reuses CI rather than repeating broad source checks. It installs locked source dependencies and builds once for packaging.

### One owner, one command

Select whole committed test files that exercise the changed installed behavior. There is no test-name filter or fixed case/package count. After passing test accounting, the release command retains standard Node child compile-cache bytes under its private evidence output; unexplained scratch and a cache symlink still stop the release. Select the reviewed model-free preflight scripts required by the intended scenario. Each script receives the actual installed package path and a fresh evidence directory as its two arguments, and must return nonzero on failure. Preflights must inspect actual phase inputs and validators, intercept before SDK/provider construction, preserve failed evidence and stay inside their approved scratch/source scope. They establish readiness, not live Objective acceptance. Their requirements remain candidate- and scenario-specific; do not replace them with a smaller generic smoke.

Run a local baseline without publication first:

```sh
npm run release -- release \
  --ci EXACT_CANDIDATE_QUALITY_RUN \
  --review https://github.com/clockgrove/factory/pull/REVIEWED_PR \
  --output /absolute/fresh-release-directory \
  --test test/affected-behavior.test.mjs \
  --preflight /absolute/reviewed-model-free-preflight.mjs
```

Repeat `--test` and `--preflight` for the actual accepted capability set. When a committed test needs a dev-only CommonJS tool, add `--test-tool NAME` (for example `ajv` for compiler schema tests). The tool must be dev-only in the frozen lockfile; its version and package hash are recorded, and it is supplied separately without modifying the installed package or replacing its production dependencies. An external preflight script is an explicitly reviewed contributor input, not a plugin or alternate release workflow. Its bytes are hashed before execution and verified unchanged afterward. Keep target-specific private evidence in its authorized local destination.

To publish an already authorized new candidate, use the same command with `--publish --issue EXISTING_ACCEPTANCE_ISSUE`. The command runs the local stages once, verifies or creates only the exact new tag's active update/deletion protection with no bypass actors, records the expected fingerprint in that issue before publication, then creates the annotated tag and Release with its archive and checksum. Preserve normal controls and existing authority; this option grants no publication or security authority. Existing tags are refused. Never use it merely to measure elapsed time, replace published assets or retag a version.

The output contains one immutable `acceptance.json`, the archive and `SHA256SUMS`, command logs, and a separate `timing.json`. Timing is observational and excluded from acceptance hashes. Do not add per-stage handoff records, reconciliation reports, configurable stage graphs or a resumable release state machine. Stop on any failed command and preserve the output; diagnose before an explicitly bounded corrected attempt. Publication can have partial external effects, so inspect GitHub before retrying; the command does not automatically retry, roll back or resume.

### One independent audit afterward

Hand the acceptance record, prepublication issue-comment URL, release acceptance issue and its existing Factory Project item to one independent auditor. That auditor owns public verification through completion tracking and returns one concise result. The coordinator does not generate another reporting program. The auditor runs:

```sh
npm run release -- audit \
  --record /absolute/release-directory/acceptance.json \
  --fingerprint https://github.com/clockgrove/factory/issues/ISSUE#issuecomment-COMMENT \
  --output /absolute/fresh-public-audit-directory
```

Use `--codex /absolute/codex` when the CLI is not on PATH. The audit verifies the fingerprint predates publication; downloads the archive and checksum anonymously; verifies the annotated tag, source/tree and exact protection; and installs an enabled plugin pinned to the same tag in an isolated Codex home. Manifest and both skills must match the public archive. Identical public bytes reuse the local offline/installed evidence; do not repeat those stages. A new qualification host still needs its actual installation and readiness checks.

After evaluating the passing audit against the declared release scope, that same auditor completes tracking with the fixed command:

```sh
npm run release -- complete \
  --record /absolute/release-directory/acceptance.json \
  --audit-output /absolute/public-audit-directory \
  --issue EXISTING_RELEASE_ACCEPTANCE_ISSUE \
  --project-item EXISTING_FACTORY_PROJECT_ITEM_ID \
  --output /absolute/fresh-completion-directory
```

The command binds the passing public receipt and terminal audit timing to the sealed acceptance, verifies that the fingerprint belongs to the explicitly selected release issue, and checks the Project item belongs to that issue in Factory Project 2. Only an open `release-gate` issue can complete; this is not a general issue-closing operation. It derives the Done status from the actual Project, renders a concise comment from verified facts, posts it, closes the issue and marks the item Done. Mutation responses must confirm the intended targets and results. Source/guidance meaning, scenario sufficiency and unexpected observations remain independent reviewer decisions; the command does not replace them.

Completion logs and timing identify the pending operation after a partial failure while preserving public PASS and successful earlier operations. Inspect actual GitHub state, then repair only the outstanding tracking operation with ordinary GitHub tools. Do not repeat a comment, rerun publication/audit, automatically retry or invent a resumable completion workflow. Sealed acceptance and the public receipt stay unchanged.

Report completion once with the immutable record, independent public result and completion result. Keep technical public PASS, tracking completion and final auditor delivery distinct. Completion timing measures its own commands and elapsed time, and separately records elapsed from the original release command's start through tracking completion. For a full agent benchmark, retain the external frozen-candidate start and final auditor handoff as well; do not claim script timings include unobserved delivery. Detailed traces and charts are post-hoc diagnostics, not required completion work. Report a concrete blocker instead of routine coordination messages; do not claim an unmeasured full-workflow speedup.

Public verification precedes separately authorized live qualification and private adopter acceptance. Later publication-ledger maintenance is not a pilot-start gate. This workflow does not resume held Objectives, authorize new targets/providers/spending, or waive independent review, acceptance, ownership or security controls.

## Install from public artifacts

Independently verify the actual anonymous public download against the prepublication digest recorded in the release acceptance issue/PR or artifact ledger, and verify the exact pinned marketplace/plugin identity. If the public archive is byte-identical to the candidate already independently installed offline from an empty cache, retain that audit instead of repeating the same offline installation solely because publication occurred. Reuse requires the exact archive identity and retained audit evidence; it does not replace qualification-host setup or readiness checks for its actual configuration and scenario. A new user or qualification host still installs the verified artifact as needed.

In a clean Linux x64 environment with Node.js 22 or later, after the release exists, set aside fresh Factory roots outside the target checkout while keeping GitHub CLI authentication reachable:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
FACTORY_TRIAL_ROOT=$(mktemp -d)
export XDG_CONFIG_HOME="$FACTORY_TRIAL_ROOT/config"
export XDG_STATE_HOME="$FACTORY_TRIAL_ROOT/state"
gh auth status
```

The commands below select prepared v0.1.62 and are for use only after that matching release is published and its actual public bytes and enabled pinned plugin pass independent verification. Compare the tarball digest with the independently recorded prepublication value for that same version in the [owning release acceptance issue or PR](https://github.com/clockgrove/factory/issues/410), or its [exact artifact record](https://github.com/clockgrove/factory/blob/main/docs/BUILD-STATUS.md). Earlier evidence retains its historical artifact scope.

```sh
codex plugin marketplace add clockgrove/factory --ref v0.1.62
codex plugin add factory@clockgrove
gh release download v0.1.62 --repo clockgrove/factory \
  --pattern clockgrove-factory-0.1.62.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Also compare the independently recorded prepublication digest in the owning issue/PR or artifact record.
npm install --offline --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.62.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Verify `factory@clockgrove` appears in `codex plugin list --json` before the live Objective. The installed `director` and `setup` skills guide agent use; the `factory` CLI above supplies their documented operations. The CLI prefix, Factory configuration, state, review exports, and planning candidates must stay outside the target checkout. A target still requires GitHub CLI access and an authenticated Codex SDK environment; media Objectives require Git LFS.

## Autonomous public qualification

The complete autonomous installed scenario for #243 is documented in
[Installed public autonomy qualification](PUBLIC-AUTONOMY.md). It uses a public
fixture and two sequential Objectives; it does not transfer earlier artifact
evidence or authorize private adopter work.

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

A known `published` Work Item waiting for checks or target protection readiness can resume read-only observation of the same exact PR/head without rerunning implementation or review. An interrupted regular Work Item still `running` at `deliver` is not a supported automatic continuation. Preserve its snapshot and exact remote evidence; do not replay delivery, edit state or treat a result decision as reconciliation. The interrupted run remains nonqualifying. A corrected successor must meet the existing qualification and resource requirements.

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
