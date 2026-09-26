<img src="https://raw.githubusercontent.com/clockgrove/factory-rebuild/main/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

# Factory

Factory turns a repository development Objective into source-grounded Work Items, runs bounded coding attempts, validates their exact result trees, and delivers the changes through GitHub. It is an open-source Clockgrove plugin installed for one target repository at a time.

**Version:** `v0.1.21`. Factory runs the local Codex SDK path with a source-grounded dependency DAG, regular pull requests or native linear stacks, human-selected AssetSets, Git LFS, and private diagnostics. See [current build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md) for the published artifact identity and exact Objective acceptance evidence.

## How it works

1. A human writes an Objective as a GitHub Issue in the target repository.
2. Factory previews a pinned-source Work Item graph with owned paths, dependencies, acceptance, non-goals, source citations, and validation commands. One independent source-backed review checks the graph before run.
3. An isolated local Codex attempt works each ready item. Independent lanes may run together; path and named-resource conflicts wait.
4. Factory validates each resulting tree in a fresh worktree, opens GitHub pull requests, integrates them, and validates the complete Objective at the observed default-branch head.

The target repository owns its product and runtime truth. Factory state and credentials stay outside the target checkout. Factory refuses to run against any Factory source repository.

## Install v0.1.21

Install the plugin from the pinned Clockgrove marketplace and its bundled CLI from the matching [release page](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.21) on Linux x64 with Node.js 22 or later. Compare the tarball digest with the independent value in [build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md):

```sh
codex plugin marketplace add clockgrove/factory-rebuild --ref v0.1.21
codex plugin add factory@clockgrove
gh release download v0.1.21 --repo clockgrove/factory-rebuild \
  --pattern clockgrove-factory-0.1.21.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Compare the tarball digest with the independently recorded build status value.
npm install --offline --ignore-scripts --prefix /absolute/private/factory-prefix \
  ./clockgrove-factory-0.1.21.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

The plugin supplies the packaged `director` and `setup` skills; the verified CLI tarball supplies their commands. Both are pinned to the same tag. You need Git, GitHub CLI authentication for the target, and an authenticated Codex SDK environment; media Objectives also require Git LFS. Keep Factory configuration and state outside the target checkout. The [public release procedure](https://github.com/clockgrove/factory-rebuild/blob/main/docs/PUBLIC-RELEASE.md) covers isolated setup and the fresh third-party Objective gate.

## Build from source

For development, the following commands build and install the current checkout as a local candidate. A local build has its own package identity and does not count as installation of the published `v0.1.21` artifact. The [release checklist](https://github.com/clockgrove/factory-rebuild/blob/main/docs/RELEASE-CHECKLIST.md) and [public release procedure](https://github.com/clockgrove/factory-rebuild/blob/main/docs/PUBLIC-RELEASE.md) describe the exact-artifact gate.

Requires Node.js 22 or later, Git, GitHub CLI authentication for the target repository, and an authenticated Codex SDK environment. Media Objectives also require Git LFS. Clone this repository, then build and install its package in an isolated prefix:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm pack
npm install --prefix /tmp/factory-candidate ./clockgrove-factory-0.1.21.tgz
```

The repository's [quality-tooling map](docs/QUALITY-TOOLING.md) records the
pinned Biome release and the exact remaining compatibility checks.

Bind one target checkout, inspect a read-only plan, and run that exact candidate with the installed CLI:

```sh
/tmp/factory-candidate/node_modules/.bin/factory install \
  --repository OWNER/REPO \
  --checkout /absolute/path/to/target \
  --concurrency 2 \
  --planning-model gpt-5.6-sol --planning-reasoning medium \
  --review-model gpt-5.6-sol --review-reasoning medium \
  --worker-model gpt-5.6-luna --worker-reasoning medium
/tmp/factory-candidate/node_modules/.bin/factory plan --objective ISSUE_NUMBER \
  --output /absolute/private/plan.json
/tmp/factory-candidate/node_modules/.bin/factory run --objective ISSUE_NUMBER \
  --plan /absolute/private/plan.json
/tmp/factory-candidate/node_modules/.bin/factory status --objective ISSUE_NUMBER
/tmp/factory-candidate/node_modules/.bin/factory status --objective ISSUE_NUMBER --json
/tmp/factory-candidate/node_modules/.bin/factory diagnostics --objective ISSUE_NUMBER --follow
/tmp/factory-candidate/node_modules/.bin/factory diagnostics --objective ISSUE_NUMBER --summary
/tmp/factory-candidate/node_modules/.bin/factory logs --objective ISSUE_NUMBER --item WORK_ITEM_ID --follow
```

An Objective may name additional canonical source paths or a section by exact heading:

```markdown
## Planning sources

- `docs/INDEX.md`
- `docs/WAVE-0.md#Acceptance`
```

Factory reads those bytes from the exact Git base, includes them in the preview with source digests, and ignores dirty checkout edits. Root `AGENTS.md` and `README.md`, when present, are also read from that base. `plan` creates no Work Item issues or run state; its output contains target source text and should stay outside the target checkout. A missing or ambiguous heading stops planning. The independent reviewer receives one complete plan packet: Objective, base, pinned sources, Work Item graph, command-authority receipts, and exact final commands. A deterministic digest binds that packet and the Factory installation configuration to the preview. A sourced finding allows one revision and re-review. If it remains unresolved, the plan names a specific question; the operator can record an answer with `factory decide --objective ISSUE_NUMBER --plan /absolute/private/plan.json --outcome accept --actor NAME --reason TEXT --answer TEXT --output /absolute/private/decided.json`, or refuse it with `--outcome refuse`. If the independent reviewer returns malformed or ungrounded findings, the preview instead records the failure and asks for inspection of the exact pinned plan. An explicit `decide` acceptance is bound to that digest, preserves the reviewed packet as `human-accepted`, and does not compile or review again; it is not labeled an automated clean review. A clean or human-accepted decided plan can be passed to `run --plan`. Activation deterministically verifies the unchanged packet and makes no new planning-review call. Running without `--plan` explicitly compiles and reviews a fresh plan. A changed Objective, base, source packet, command surface, or installation configuration requires a new plan.
Run `/tmp/factory-candidate/node_modules/.bin/factory help` for the installed command list. Factory stores configuration and state outside the target checkout. Never bind it to a Factory source repository.

Factory writes explicit Codex selections for the planner, independent graph/result reviewer, and Work Item worker. Each model flag accepts a non-empty Codex model ID; each reasoning flag accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `persistent`. Omitted flags use Factory-owned role defaults: planner `gpt-5.6-sol`/`medium`, reviewer `gpt-5.6-sol`/`medium`, and worker `gpt-5.6-luna`/`medium`. Each role is resolved independently, so overriding one role leaves the other defaults unchanged. Factory never inherits these choices from the operator's ambient Codex configuration. The installed selections are part of the configuration digest, so changing one during an active Objective stops resumption instead of silently changing the run.

`status --json` reports the current step, scheduler eligibility, ready or blocked reason, pending result criterion and question, issue/PR/stack identity, exact base/tree/head, final validation, and last error from Factory's atomic state snapshot. `eligible` means dependencies and resources permit scheduling. `ready` is `false` when blocked and `null` when admission depends on provider capacity, which is not persisted in the snapshot. Configured concurrency exhaustion appears as `blockedReason: "capacity"`. Its provider progress flag reflects whether the current attempt has produced an SDK stream. `diagnostics` prints private newline-delimited JSON events; `--follow` streams new events until interrupted, while `--summary` derives Objective, phase, and invocation-scope model totals. Validation stdout/stderr is emitted while the command runs, including partial lines, followed by exit evidence; split credentials are buffered until they can be redacted. `logs --item` reads the current attempt's worker stdout/stderr, with the same follow option, and reports when no worker output exists. The timeline correlates repository, Objective, run, item, attempt, invocation, and operation where known. It includes planning, scheduling, worker lifecycle and SDK progress, validation command output, result review and pending decisions, GitHub delivery, media review/selection, and finalization.

Every Factory-owned compile, graph-review, Work Item result-review, and final Objective-review call emits a correlated model-invocation start, provider progress when actually supplied, and completion, failure, or invalid-response observation. Safe metadata includes configured adapter/model/reasoning, provider thread identity, phase and revision/attempt ordinal, durations, byte counts and stable prompt/schema/source-packet/response digests, and structured-output or semantic-validation failure class. A rejected graph-review response records each exact failing field path, a bounded reason such as `unknown-source`, `quote-not-found`, or `empty`, and only an exact supplied source label when one was recognized; it never copies the provider's quote, detail, question, or unknown source text. Raw prompts, target source, responses, and command output are excluded from exportable model metadata. Provider-reported input, cached-input, cache-write-input, output, reasoning-output, and total tokens are preserved only when supplied; an absent category remains absent and terminal invocations without usage increment `usageUnavailableCount`. The summary reports the cache-read numerator and exact input-token denominator as well as their ratio. A silent provider produces no fabricated heartbeat: `--follow` shows the last real progress event and its timestamp. Treat diagnostic output as sensitive: it may include separate worker command output and validation stdout/stderr. Factory redacts known credential patterns and configured allowed secret values, but arbitrary target commands may print other private data. Keep terminal capture and any export outside the target checkout.

The summary's existing `objective`, `byPhase`, and `byScope` fields retain planning-and-review model scope, explicitly labeled by `scope`. `modelUsage`, `workerUsage`, and `combinedUsage` distinguish model-only, worker-only, and combined observed counters. Workers may supply a typed `WorkerUsageObservation` in the existing private progress stream (`operation: "worker-usage"`, payload `workerUsage`); the Codex worker normalizes its SDK counters there. No arbitrary result evidence is parsed. Worker invocation/provider-attempt identities deduplicate cumulative progress and terminal snapshots; explicit implementation retries remain separate attempts. Terminal failures retain any supplied usage, including failures after provider completion. Active invocations are counted but their counters are not included until terminal. Per-category coverage is `available`, `partial`, or `unavailable`; `unobservedAttemptCount` identifies known harness attempts without typed telemetry. Missing counters never become zero. Cache ratios use only invocations supplying both cached-input and input counters; cached input is a subset, not extra input. These are cumulative provider counters, not prompt size, context occupancy, billing, or cost. Coverage describes observed invocations, not proof that all historical calls were recorded.

Every Codex SDK turn must emit an explicit `turn.completed` event before Factory accepts its structured response or Work Item result. Factory aborts a turn after 15 minutes without a real provider event; planning and review diagnostics classify that terminal failure as `provider-timeout`, while a stream that ends without completion is `provider-interrupted`. The detached Work Item worker applies the same idle bound and terminal requirement to its durable result. These failures never infer a response or retry an implementation attempt.

Diagnostic and worker progress files live under the private Factory state root with mode `0600`; containing directories are private. The local log is observational and is never used to reconstruct or retry work. A write failure appears on controller stderr and does not alter execution. Operators may delete old `diagnostics.ndjson` and `harness/*.progress.ndjson` files after runs have stopped, subject to their own retention policy. The event `metadata` field holds identities suitable for a future exporter; `detail` is local-only and must not be exported without explicit redaction policy. No hosted telemetry backend is required.

The preview lists each Work Item command and every final Objective command with its exact source and host execution status. A source-declared command must appear as a complete line in its cited pinned source. A base-observed command must name a tracked file at the accepted base containing that exact line, or a matching `package.json` script invocation. A blocked command stops activation; editing a plan file cannot grant authority. A source-declared package command whose script or lockfile is not yet in the accepted base appears as authorized but explicitly deferred: Factory checks that entrypoint in the exact result tree before execution.

At runtime Factory runs admitted commands on the exact result tree. For root `npm test`, `npm run NAME`, `pnpm test`, `pnpm check`, and `pnpm run NAME`, a script that existed at the Objective base remains pinned there. A script newly established by an Objective is permitted only through an exact source declaration; later Work Items pin it to their exact predecessor. Selected scripts cannot add pre/post hooks or nested package-manager wrappers without separate authority. Existing package-manager configuration stays pinned; a new pnpm workspace file may be created under source-declared command authority. Metadata, dependency, and unrelated script edits may proceed. A fresh validation worktree may run the exact source-declared bootstrap `pnpm install --frozen-lockfile --ignore-scripts` before its pnpm checks, using a lockfile tracked in the result tree and no pnpmfile hooks; plain install remains blocked. A new `.npmrc` remains blocked by this narrow path. Source-declared validation can still run candidate code on the local host under the target operator's authority; Factory does not sandbox that code.

Factory then independently checks each stated Work Item and Objective acceptance criterion against the pinned sources, canonical command receipts, and an exact-tree change packet with a conservative 48,000-byte text excerpt budget, explicit truncation markers, and blob descriptors for opaque files. Every command receipt records its stable zero-based order, exact command, successful exit code, and exact validated tree after Factory verifies that the result commit resolves to that tree. Persisted Work Item receipts must exactly match the accepted graph commands; final receipts must exactly match the accepted Objective commands. A Work Item review also receives bounded `Delivery observations` from the authoritative atomic snapshot, accepted graph, and active delivery runner: the reviewed attempt, its declared dependencies, owned paths, named resources, start time, immutable worker execution-base commit, integration commit observed at attempt start, separately named result commit and result tree, current integration state, relevant dependency or acceptance-named peer attempts, and explicit regular or native-stack unit/layer context. Final review likewise names the integrated commit and integrated tree separately. Native replay may advance the mutable validation and delivery base without changing worker-start facts. Legacy attempts that lack immutable start provenance are labeled as unrecorded rather than inferred. This observation packet does not derive continuation truth from diagnostics or worker prose. Operators using a reviewer with a larger context can set `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` to a positive byte budget. A truncated text excerpt cannot auto-pass a criterion even if the reviewer returns pass; the criterion waits for an exact-tree operator decision or a retry with a larger text budget and reviewer context. Reviewer failures also wait with their specific error. A source-backed clean result review passes without routine operator approval. Missing, conflicting, or human-owned evidence pauses on one specific criterion. `factory status --objective ISSUE_NUMBER` shows its question and tree. To answer, run `factory decide-result --objective ISSUE_NUMBER [--item WORK_ITEM_ID] --tree EXACT_TREE_SHA --outcome accept|refuse --actor NAME --reason TEXT`, then `factory run --objective ISSUE_NUMBER`. Omit `--item` for final Objective acceptance. The recorded decision is valid only for that criterion and tree; a refusal stops delivery. This decision approves the result criterion, while the target repository's branch protection and GitHub checks still govern PR integration.

Use `--delivery native-stack` at install time to deliver maximal linear chains through GitHub's native stacked pull requests. The default is regular PR delivery.

### Interrupted regular delivery

An ordinary restart may reattach to an identifiable worker or continue a supported validation or decision pause. It does not guarantee recovery from every controller interruption. If a regular Work Item remains `running` at `deliver`, `run` refuses ambiguous active state, even when its exact result branch or PR already exists. Repeating `run`, supplying the same plan, or accepting a result criterion cannot reconcile that publication window. The refusal may be recorded as the controller's last error; it is not a promise of zero snapshot writes.

Stop and preserve the original private snapshot, plan/configuration identities, attempt, validated result commit/tree, validation/review evidence, and exact remote branch/PR heads. Inspect `status --json` and read-only GitHub evidence under target authority; keep private captures outside the target checkout. Do not edit state, republish, replay a worker, or use `retry`/`decide-result` to bypass the refusal. There is currently no supported automatic continuation for this ambiguous regular-delivery state. Any manual target disposition requires a separate explicit operator decision and does not complete the original Factory Objective. A new disposable qualification must use a separately approved fresh target/run; the interrupted run remains nonqualifying evidence.

The historical `clockgrove/objective-fixture` target is private, so its linked Issues and PRs are available only to maintainers. To reproduce the combined release gate without any Clockgrove private material, start with [the public target fixture](https://github.com/clockgrove/factory-rebuild/tree/main/test/fixtures/disposable-target/) in a new GitHub repository you control. Copy its files into an empty directory, initialize and push `main`, then create a GitHub issue from [the release-candidate Objective template](https://github.com/clockgrove/factory-rebuild/blob/main/test/fixtures/objectives/release-candidate.md). Install this package with `--delivery native-stack --concurrency 2` and that target checkout, then run the new issue number. Use a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for an isolated installation. The Objective owns its requirements; Factory derives the Work Item graph and validation commands from the issue and target checkout.

For a media Work Item, the harness returns complete candidate AssetSets and Factory stops for human review. `factory status --objective ISSUE_NUMBER` lists their IDs and digests. Export a candidate outside the target checkout, inspect its image and sidecar, then select the whole set and resume:

```sh
factory review --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --set CANDIDATE_ID --output /absolute/new/review-directory
factory select --objective ISSUE_NUMBER --item WORK_ITEM_ID --set CANDIDATE_ID \
  --reason "Reviewed complete set" --bind DEPENDENT_WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

`select` records the current OS user (or `--actor NAME`), decision time, optional reason, selected destinations and digests, and each explicitly bound direct dependent (`--bind` may be repeated). A bound dependent receives only the selected set's immutable member files and descriptors in a temporary input area. Factory verifies they were not changed and removes them before delivery. The harness may report its representation of those inputs; Factory does not assert that every model call receives raw bytes. Unselected candidates are never passed to the dependent attempt.

The target owns its `.gitattributes` policy. Factory checks selected bytes against the committed LFS pointer, uploads required LFS objects before branch publication, and verifies exact selected bytes in a fresh clone after integration. Before any Work Item or final Objective validation command, Factory verifies each applicable committed pointer, restores only its selected required-LFS bytes from the verified local content store, and checks the exact SHA-256 and size; unavailable or corrupt local content stops before command zero, without a network fetch or global smudge. Selected bytes are checked again after commands and clean-tree enforcement compares against that controller-hydrated baseline. A canonical installed-artifact capability manifest tells planning and independent review which of those controller guarantees must not be reimplemented as target Work Items or invented target commands; its exact value and digest are part of the immutable plan. Successful fresh-clone hydration produces bounded exact-commit/tree evidence before final Objective review and closure. Source bindings are structured records with `path`, `role`, `mediaType`, `visibility`, and optional `kind`. `kind: repository` (the default) names a file in the pinned target checkout. When that exact source path is also a selected required-LFS destination, Factory may migrate it in place only if the selected, captured, and current bytes are identical; the worker leaves final destinations untouched. `kind: local` names an absolute private file explicitly cited in the Objective; Factory imports its bytes into the private content store. `kind: github-attachment` names a GitHub Objective attachment URL explicitly present in the issue body, in either `github.com/user-attachments/assets/UUID` or `github.com/OWNER/REPO/assets/ID/NAME` form. Factory downloads it with the GitHub CLI identity, allows redirects only to GitHub content hosts, and retains the URL, declared authorization/visibility, and immutable digest. A private source is supplied to the harness as a temporary file plus descriptor and is removed before delivery. GitHub attachment availability still depends on that identity's access to the Objective. Media contracts preserve output roles, lineage, and optional tool-supplied format metadata without interpreting the format. The [public PNG fixture](https://github.com/clockgrove/factory-rebuild/blob/main/test/fixtures/objectives/media-lfs.md) shows one source, role, and validation example; an integration test covers an opaque multi-file set consumed downstream under target-owned LFS. If you use a temporary `XDG_CONFIG_HOME` for Factory, keep the controller's GitHub CLI authentication visible through `GH_CONFIG_DIR` or its normal configuration path.

`factory cancel --objective ISSUE_NUMBER` stops owned local processes. `factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID` starts a new explicit attempt for a failed or cancelled unpublished item. Managed-agent and sandbox modes are reserved contract shapes and fail preflight until their branches ship.

Before publication, Factory checks only a Work Item's changed paths against its ownership, rejects newly introduced unsafe links and special files, and runs the packaged Secretlint recommended rules on changed staged content and working bytes (including LFS inputs). The isolated scanner uses the supported `@secretlint/node` file API with explicit configuration, literal paths and secret masking; target configuration discovery, globs and ignore files cannot bypass it. The scanner and default packaged dependency graph support Node 22.0 without the unused Secretlint CLI configuration-creation dependencies. A positive result stops publication and reports the rule and path without the value. Review a suspected false positive outside the worker checkout; an operator can set `FACTORY_SECRETLINT_CONFIG` to an absolute, reviewed Secretlint configuration file outside the target checkout, then explicitly retry the failed item. The default recommended rules apply when no override is set. The worker receives only basic ambient variables and secret names explicitly listed in `policy.allowedSecretNames`; GitHub, Git, and SSH credential variables stay excluded even if listed. A local worktree and filtered worker environment do not isolate hostile code from files readable by the operator's OS user.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` (or `~/.config/clockgrove-factory`); durable run state lives under `$XDG_STATE_HOME/clockgrove-factory` (or `~/.local/state/clockgrove-factory`). Do not put either in the target repository.

## Local host-tool preflight

Before running any lookup, preflight inspects the selected `sh` on the effective
PATH using filesystem checks. Target-owned shells (including symlink aliases)
and unresolved relative precedence remain `unverified` without execution or a
fallback shell; provide an approved host shell to qualify that toolchain.

This describes current source; immutable public v0.1.21 bytes are unchanged.

Factory's package supplies Factory, not the target's package manager or toolchain.
Fresh local activation checks reliably literal Work Item and final validation
entrypoints against the sanitized validation environment before projecting issues
or creating an attempt. A missing executable or an explicitly pinned exact
`packageManager` npm/pnpm version mismatch stops with command origin, source,
item/index and redacted PATH context in the error and private diagnostics. Status
remains `not-started`; no attempt is made retryable. A planning preview is not a
host-readiness receipt: activation checks the current environment again.

Validation now uses non-login `sh -c` with the explicitly supplied PATH. Shell
login profiles do not provision or change that environment. Provide approved
tools in a task-private host directory before activation; see the
[public gate toolchain check](docs/PUBLIC-RELEASE.md#local-host-toolchain-check).
Preflight runs only fixed host executable lookups and, for a supported explicit
pin, the resolved host package manager's `--version` outside the target. It does
not run target commands, scripts or hooks, install tools, choose versions or
substitute a manager. Newly created package scripts still require the manager;
their bodies and hooks remain subject to ordinary exact-result-tree checks.

This is not a shell interpreter or complete toolchain qualification. Dynamic
substitution, wrapper bodies, quoted compound commands, relative/worktree PATH
entries and unsupported version policies are visibly `unverified`, not silently
approved or newly banned. Literal lookups do not qualify script internals,
plugins, interpreter dependencies or runtime behavior. Inspect those prerequisites
under the target's source and operator authority before running.

## Deterministic contributor gate

Run the complete credential-free gate with one command:

```sh
npm test
```

In addition to the focused DAG, delivery-plan, state-ingress, content, media, and transplant tests, this runs bounded application-path scenarios against real temporary Git repositories. A scripted planning model and harness enter through the same composition boundary as the production Codex adapters, while a small stateful GitHub-domain fake records stable Issue, pull-request, and native-stack identities and integrates real commits through a local bare remote. The scenarios prove concurrent regular DAG execution and final-head validation, restart reattachment/cancel/explicit retry, a native linear stack beside an independently replayed and revalidated lane, whole-set media selection, target-owned Git LFS policy, and exact hydrated bytes.

The same gate packs the current working tree, installs the tarball into an isolated prefix with isolated configuration and state, and exercises the public `install`, `status`, and application `planObjective` operations. Live Codex/GitHub disposable Objectives remain separate release evidence; deterministic CI does not replace them. The [release checklist](https://github.com/clockgrove/factory-rebuild/blob/main/docs/RELEASE-CHECKLIST.md) tracks the exact public artifact and fresh third-party run required for #25.

## Project and provenance

The [Factory Rebuild project](https://github.com/orgs/clockgrove/projects/2) tracks one acceptance issue per trunk slice and later capability branches. [The implementation plan](https://github.com/clockgrove/factory-rebuild/blob/main/docs/IMPLEMENTATION-PLAN.md), [current build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md), and [source provenance](https://github.com/clockgrove/factory-rebuild/blob/main/docs/SOURCE-PROVENANCE.md) provide the complete public contributor handoff. The archived source is reference material; this repository is a clean implementation. Generic acceptance uses [public disposable fixtures](https://github.com/clockgrove/factory-rebuild/tree/main/test/fixtures/disposable-target/) and requires no private adopter documents.

Contributions are welcome through focused issues and pull requests. See [CONTRIBUTING.md](https://github.com/clockgrove/factory-rebuild/blob/main/CONTRIBUTING.md), [GOVERNANCE.md](https://github.com/clockgrove/factory-rebuild/blob/main/GOVERNANCE.md), and [SUPPORT.md](https://github.com/clockgrove/factory-rebuild/blob/main/SUPPORT.md). Security concerns have a [private reporting route](https://github.com/clockgrove/factory-rebuild/blob/main/SECURITY.md). Releases are recorded in [CHANGELOG.md](https://github.com/clockgrove/factory-rebuild/blob/main/CHANGELOG.md). Licensed under [MIT](https://github.com/clockgrove/factory-rebuild/blob/main/LICENSE); production dependency licenses are listed in [THIRD_PARTY_NOTICES.md](https://github.com/clockgrove/factory-rebuild/blob/main/THIRD_PARTY_NOTICES.md).
