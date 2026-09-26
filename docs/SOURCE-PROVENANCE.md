# Source provenance

The clean implementation starts from the Factory plan reviewed September 22, 2026. The archived source at `clockgrove/factory` commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` is reference material only. No runtime source, test, fixture, snapshot, or generated artifact was copied into the clean implementation.

The MIT license text is retained from the archived repository. Runtime code does not read this ledger.

## Settled provider wait subscriptions (#133)

Issue #133, accepted public `src/provider-turn.ts`, and the new synthetic
high-event-count fixture supplied this leaf correction. Per-wait timeout
subscriptions detach in finally while one resettable timer retains the existing
timeout/AbortSignal/error policy. A referenced guard no longer retains settled
fulfilled or rejected Buffer payloads through a shared pending timeout promise.
Focused tests preserve active waits, terminal finish, original failure and
already-settled cleanup ordering. No archived source, provider credentials,
payload diagnostics, live target or new event/byte policy was inspected or added.
The separately accepted #55 source/artifact is not edited or requalified here.

The final normal merge retains accepted #127 streaming and #121 preflight source,
tests and documentation. A single provenance conflict kept both issue records;
the #133 guard, focused tests, fixture and dependency identities are unchanged.
The refreshed full gate and actual Node22 affected checks cover those accepted
changes together without copying historical payloads or invoking providers.

## Interrupted regular-delivery contract (#121)

The public #121 reproduction and current clean regular runner supplied this
contract. Ambiguous active `deliver` state still refuses rather than replaying
workers or inferring continuation from remote publication. The refusal now names
the unsupported recovery window and preservation/bypass guidance; focused tests
verify refusal both with and without a recorded PR, including resumable execution,
validation and selected-asset peers in either graph order. A whole-graph preflight
refuses before any peer operation or state change. The outer controller may still record its last error. No archived
source, historical run mutation, automatic retry or recovery journal was used.

## Provider idle timeout subscription (#130)

Issue #130 and the accepted public `src/provider-turn.ts` supplied the
delayed-callback progress reproduction. The focused fix keeps the guard's
existing timeout promise subscribed while resetting only its idle timer.
Independent read-only review also reproduced cleanup-window callbacks restarting
that timer after finish. The existing guard now ends idempotently and ignores
later progress; synthetic delayed-cleanup and isolated process-exit tests verify
no late abort or referenced idle timer. No optional SDK implementation is added.
Standalone tests use synthetic pending operations, delayed progress, original
provider failure and successful completion; no archived source, private material,
provider authentication or live target was inspected or used. The optional-worker
callback regression remains separately evidenced in draft PR #62; no harness or
dependency change is included here.

Independent exact-source, full/static, actual Node 22.0 and scripted cleanup
checks accepted PR #132; integrated-main Quality passed at
`8735797c84c65abd4537c807be4b5590559a5ea9`. The late shared-promise retention
finding was independently reproduced with synthetic buffers and queued as
nonblocking #133; no OOM, private-target or new live-provider claim follows.

## Repository quality tooling (#105)

Issue #105, the repository's effective ESLint/TypeScript-ESLint and Prettier
configuration, and official Biome 2.5.14 release, package, migration, formatter,
and rule-source documentation supplied the tooling migration. No archived
Factory source, test, fixture, state, or qualification implementation was
inspected or copied. Biome owns supported TypeScript lint and repository format
checks; current supported ESLint and Prettier versions retain only the rules and
file formats Biome cannot cover. Secretlint remains the unchanged packaged
prepublication security check. [QUALITY-TOOLING.md](QUALITY-TOOLING.md) records
the complete old/new mapping.

## Trunk issue #24 — changed-file safety

Inspected the archived `docs/THREAT-MODEL.md`, `src/runtime/pinned-git-environment.ts`, and `src/execution/artifacts.ts` at commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8`. The clean local driver retains exact-base collection, pinned Git environment, changed-path ownership, and the trusted-local worker boundary. It checks staged candidate modes and traversal, rejects newly introduced special entries, scans only changed staged and working bytes with maintained Secretlint rules, and filters the worker's effective environment to a small ambient allowlist. The archived artifact protocol, blanket file-size/count limits, receipt machinery, and claim of hostile-code containment were not retained. A reviewed operator-owned Secretlint config outside the target checkout is the explicit false-positive path.

## Slice 1 extraction

Audited commit for every row: `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8`. Each destination was reimplemented after inspection behind the clean contracts; no archived source file, protocol, helper, or test was copied.

| Archived path                           | Clean destination                          | Behavior retained                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/local-worktree.ts`         | `src/execution/local.ts`                   | Verify the exact base commit, create an isolated worktree, collect changed paths, and remove an owned worktree. Old artifact patch and LFS transfer machinery was not retained.                                                                                       |
| `src/runtime/pinned-git-environment.ts` | `src/process.ts`                           | Clear inherited `GIT_*` overrides and pin local Git configuration for exact-tree operations. Controller publication remains separately authenticated.                                                                                                                 |
| `src/backends/codex-sdk-local.ts`       | `src/execution/local.ts`                   | Bind the SDK thread to the worker worktree, use workspace-write and no approval prompts, carry abort and authoritative thread result, and keep GitHub credentials out of the worker environment. Old scope, quota, deadline, and recovery machinery was not retained. |
| `src/validation/clean-run.ts`           | `src/validation.ts`                        | Validate in a fresh worktree, compare the exact tree, and run the admitted commands in order. Old toolchain provisioning and qualification machinery was not retained.                                                                                                |
| `src/validation/evidence.ts`            | `src/validation.ts`                        | Tie command evidence to the validated tree. The old digest envelope and protocol fields were not retained.                                                                                                                                                            |
| `src/github.ts`                         | `src/github.ts`, `src/delivery/regular.ts` | Reimplement the issue, PR, check observation, and exact-head merge operations needed for one regular PR. Native stack operations remain Slice 3.                                                                                                                      |
| `src/runtime/process-group.ts`          | `src/execution/local.ts`                   | Retain the worker environment sanitization principle. Process-group cancellation and verified cleanup follow in Slice 2.                                                                                                                                              |
| `src/graph-analysis.ts`                 | `src/compiler.ts`                          | Inspect dependency and scope validation; DAG order and conflict logic follow in Slice 2.                                                                                                                                                                              |

## Slice 2 extraction

The same archived commit was inspected for these behaviors. The clean destinations use the Slice 0 contracts and a new implementation; no archived source or tests were copied.

| Archived path                     | Clean destination                                   | Behavior retained                                                                                                              |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/graph-analysis.ts`           | `src/scheduler.ts`                                  | Validate a dependency DAG, produce stable dependency order, admit ready items, and serialize path or named-resource conflicts. |
| `src/graph.ts`, `src/github.ts`   | `src/github.ts`                                     | Project linked Work Item issues and native blocked-by dependencies alongside the Objective.                                    |
| `src/runtime/process-group.ts`    | `src/process.ts`, `src/execution/local.ts`          | Bind a detached worker to a Linux PID and start time, signal only the owned group, and verify that live group members exit.    |
| `src/backends/codex-sdk-local.ts` | `src/execution/worker.ts`, `src/execution/local.ts` | Run one SDK attempt in an identifiable worker process and collect its durable result after controller restart.                 |

## Slice 3 extraction

The same audited commit supplied the delivery checklist. GitHub's current versioned stack and asynchronous merge API was also checked against official documentation before implementation. The clean delivery code retains only the behavior needed by regular and immutable native linear PR paths.

| Archived path                      | Clean destination                                          | Behavior retained                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/publication/delivery.ts`      | `src/delivery/plan.ts`                                     | Partition maximal unbranched linear chains; end a chain at forks and start a new one at multi-parent joins. No archived delivery-hint protocol was copied.                                     |
| `src/publication/publisher.ts`     | `src/delivery/regular.ts`, `src/delivery/native-runner.ts` | Push deterministic branches, open predecessor-based PRs, and check exact publication heads.                                                                                                    |
| `src/publication/github-stacks.ts` | `src/delivery/native-stack.ts`                             | Use the versioned GitHub native-stack create/read API and asynchronous merge result; reconcile stack identity and wait for merged PR evidence.                                                 |
| `src/publication/stack-manager.ts` | `src/delivery/native-runner.ts`                            | Persist stack and pending merge identity, stop on external head/topology mutation, and verify the integrated default-branch result. The archived receipt and lease machinery was not retained. |

## Slice 4 extraction

The same audited commit supplied the media and LFS checklist. The clean implementation uses one local content-addressed store, one harness-declared AssetSet result, and the existing Work Item delivery path. No archived media orchestrator, receipt protocol, or test was copied.

Trunk gap #23 extends that clean media path with structured-only source bindings, authorized local and recognized Objective attachment ingress, durable selection decisions, and explicit downstream bindings. The new work stays in the same content store, local driver, and ordinary validation/delivery path. It adds no media producer, catalog, or second orchestrator; model/tool/request/parameter details are retained only if a harness or authoritative tool supplies them.

| Archived path                                                             | Clean destination                                | Behavior retained                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/assets/import.ts`, `src/assets/materialize.ts`                       | `src/content/local.ts`, `src/media.ts`           | Import source and produced bytes from regular files, reject redirected paths, preserve SHA-256 identity, and materialize only a selected complete set.                                                                                                   |
| `src/media/contracts.ts`, `src/media/review.ts`                           | `src/contracts.ts`, `src/media.ts`, `src/cli.ts` | Keep multi-file candidate roles, provenance, rights, visibility, lineage, explicit human review and whole-set selection. The configured Codex harness produces candidates; Factory does not select a media provider.                                     |
| `src/repository-profiles/git-lfs.ts`, `src/publication/git-lfs-output.ts` | `src/media.ts`, `src/delivery/regular.ts`        | Follow the target's `.gitattributes`, check required role assignment and exact pointer identity, upload before publication, and verify hydrated bytes from a fresh clone. Old content-transfer receipts and implicit file-size limits were not retained. |

## Deterministic integration suite

The application integration tests were written from the current public acceptance criteria and controlling contracts. No archived test, fixture, helper, snapshot, transcript, or qualification protocol was inspected or copied for them. They use current public target inputs, temporary Git repositories and worktrees, a scripted planning/harness adapter, and a small domain-level GitHub fake.

## GitHub projection and completion hardening

Issue #22 reuses the existing clean GitHub projection and delivery code named above. No additional archived path, state format, test, or recovery protocol was consulted or copied. The completion changes follow the public issue acceptance: marker-based Work Item reconciliation, dependency checks, PR identity verification, and replayable issue/comment closure in the one atomic snapshot. New interruption tests use the current stateful GitHub fake at the application boundary.

## Native dependency waves and retry

Issue #21 extends the clean `src/delivery/native-runner.ts` using the existing `src/scheduler.ts` conflict rule and `src/delivery/plan.ts` unit partition. No additional archived source or test was consulted or copied. New application tests use the current disposable Git target and stateful GitHub fake to prove a post-foundation readiness wave and explicit retry after a terminal native failure.

## Pinned planning and graph review gap (#19)

The audited archive commit's `src/application/plan.ts`, `src/application/compiler-preflight.ts`, and `src/compiler/judge-context.ts` were inspected for the read-only planning boundary, pinned Git authority, and complete independent review packet. The clean `src/compiler.ts`, `src/runner.ts`, and `src/cli.ts` implement only the required current path: exact named sources/headings from the pinned base, a zero-run-state preview, one independent source-backed graph review, at most one automatic revision, and a specific recorded human fallback. The archived policy matrix, repository inventory caps, compiler judge byte cap, obligation inventory, and recovery protocols were not copied.

## Agent-readable diagnostics (#28)

The public plan and issue #28 supplied this slice's behavior. No archived telemetry source, log format, or recovery journal was inspected or copied. The clean `src/diagnostics.ts` reads snapshot-derived status and appends private observations; `src/validation.ts` captures actual command output and `src/execution/worker.ts` records SDK stream events when supplied. These local records are never read for continuation, replay, or scheduling.

## Planning and review model telemetry (#73)

Issue #73, the current clean model/configuration contracts, and the installed `@openai/codex-sdk` event and usage types supplied this correction. Official Codex SDK and App Server documentation was consulted to confirm the supported streamed event and usage concepts; no archived Factory telemetry, prompt journal, billing model, retry policy, or provider-specific lifecycle state was inspected or copied. The clean implementation adds one provider-neutral observation contract, translates current Codex events inside `CodexPlanningModel`, and emits only safe identities, counts, timestamps, and digests through the existing private diagnostics sink. Raw prompts, source packets, and responses remain outside exportable metadata, and diagnostics remain observational rather than continuation truth.

## Bounded reviewer-capacity retry (#94)

Issue #94, the preserved fresh installed v0.1.16 qualification diagnostics, and the current clean model-observation and acceptance contracts supplied this correction. No archived retry policy, provider fallback, state format, or test was inspected or copied. The clean adapter retries only the same selected reviewer after a classified provider-capacity failure, reusing the exact in-memory structured request with two bounded delays. Attempt metadata remains observational; the atomic snapshot is still the only continuation truth. Non-capacity failures and exhausted capacity retain the existing fail-closed decision path.

## Manifest provenance capture receipt (#99)

Issue #99, the preserved fresh installed v0.1.17 qualification state, and the current clean media, atomic-state, and review-observation contracts supplied this correction. No archived receipt format, provenance protocol, state schema, prompt, or test was inspected or copied. The clean change extends the existing controller capture receipt with an exact clone of the provenance declaration already parsed from `.factory-assets.json`, validates that clone against the captured AssetSet on state ingress, and projects only the validated fields into result-review observations. Harness-declared selected-asset metadata remains separately labeled and absence of the controller fields proves nothing.

## Imported source identity capture receipt (#102)

Issue #102, the preserved fresh installed v0.1.18 qualification state, and the current clean source-import, media-capture, atomic-state, and review-observation contracts supplied this correction. No archived receipt format, content-transfer protocol, state schema, prompt, or test was inspected or copied. The clean change clones each controller-imported source binding and content ref into the existing capture receipt, validates the ordered clone against the captured AssetSet on state ingress, and projects only those bounded identities to result review. Matching input and member digest, byte count, and media type can therefore prove identity of the exact imported bytes; harness-declared fields and absence of a controller input receipt prove nothing.

## Graph-review rejection diagnostics (#76)

Issue #76, the live #55 qualification evidence, and the current graph-review and diagnostic contracts supplied this correction. No archived reviewer parser, error format, prompt journal, or test was inspected or copied. The clean validator rejects each malformed field independently, emits only its bounded path and fixed reason plus an exact recognized supplied-source label when available, and preserves the existing fail-closed human-decision path. Provider quotes, details, questions, and unknown source text remain outside diagnostic metadata. The prompt and focused current-repository tests also establish an empty findings array as the only clean no-defect result.

## Command trust and result acceptance (#20)

The clean implementation extends `src/compiler.ts`, `src/validation.ts`, and the existing regular/native runners from the public #20 acceptance and current #19 planning contract. No additional archived source, test, state format, or validator protocol was inspected or copied. Command authority is checked against pinned source lines or a named tracked base file; selected npm/pnpm scripts and lifecycle hooks are compared with the accepted base before execution, while unrelated package metadata remains editable. One exact script-disabled pnpm bootstrap form provisions a fresh validation worktree from a tracked lockfile. Result review uses one exact-tree packet with text diffs and blob descriptors and one specific human fallback, with decisions in the existing atomic snapshot. There is no judge loop or secondary validation ledger.

## Explicit Codex phase selection follow-up

After the v0.1.6 public gate exposed ambient Codex reasoning inheritance, the archived `src/protocol/policy.ts` at commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` was inspected for its named model-profile behavior. The archive bound `compile`, `implement`, `review`, and `recover` phases to explicit model/reasoning profiles, but its shipped run policy constrained new runs to one shared profile and included broader provider/economics machinery. No archived implementation was copied. The clean correction keeps model policy inside the current Codex SDK adapters, exposes independent planner, reviewer, and worker selections, writes explicit Factory defaults, and retains the generic `AgentHarness` and execution contracts unchanged.

## Role-specific Factory defaults (#59)

Issue #59 and the current explicit-selection implementation supplied this change. No additional archived source or provider policy was inspected or copied. Factory now resolves planner, reviewer, and worker defaults separately at installation, persists the resulting explicit values, and keeps provider-neutral harness work in issue #55. A post-merge boundary audit rejected a shared-default compatibility alias that was not required by #59; the package root exposes only the role-specific defaults.

## Controller media guarantees and same-path LFS migration (#81)

Issue #81 and the current public compiler, media, delivery, validation, and atomic-state contracts supplied this correction. No additional archived source, test, receipt format, or media protocol was inspected or copied. The clean implementation adds one code-owned versioned controller-capability manifest, a narrowly authorized byte-identical repository-source-to-LFS migration at the same path, and one bounded hydration receipt inside existing final validation evidence. It does not add a second receipt journal, target command authority, provider-specific media behavior, or worker control over final destinations.

The fresh installed v0.1.12 public gate then supplied the validation-worktree correction: its exact content-hash command observed the committed LFS pointer because pinned Git intentionally disabled smudging. The correction extends the same validation and local content-store contracts to verify the committed pointer, restore only selected required-LFS members locally, verify exact bytes before and after commands, and fail before command zero on missing or corrupt content. No archived source, new network authority, global smudge configuration, or pointer-only weakening was used.

The fresh installed v0.1.14 public gate supplied the provider-stream terminal correction. A real result-review provider turn was interrupted after `turn.started`; the SDK event iterator neither produced a terminal event nor ended, so Factory kept the invocation active indefinitely. The correction uses the current SDK `AbortSignal` contract, requires explicit `turn.completed` authority, and applies one reset-on-real-event idle watchdog to both planning/review and detached Work Item turns. It adds no provider-task polling, inferred response, retry policy, lifecycle journal, or archived deadline machinery.

## Controller materialization review evidence (#111)

The immutable public v0.1.21 artifact subsequently completed #81's fresh disposable installed-artifact gate. Independent audit verified exact worker/controller Git attribution, unchanged selected bytes, final commands and remote LFS hydration at the integrated commit. [Acceptance evidence](V0.1.21-ACCEPTANCE.md) records public identities and distinguishes controller-attested manifest provenance from independently rehashed content. This acceptance added no runtime code or archived-source dependency.

Issue #111, the preserved fresh installed v0.1.20 result-review packet, and the current clean Git, media-selection, atomic-state, and review-evidence contracts supplied this correction. No archived source, receipt format, state schema, journal, diagnostic record, or qualification implementation was inspected or copied. The clean implementation derives one bounded supervisor evidence source from the validated selected-set state and immutable Git commit graph: the controller materialization commit retains the worker result as its sole parent; exact commit/tree resolution and changed-path checks distinguish the worker delta from the selected-destination-only controller delta. The same source reaches regular/native Work Item review and final Objective review. Existing local collection still rejects final-destination mutation; the new Git evidence describes the delivered worker result and does not claim to trace transient filesystem operations.

## Post-gate focused leaves (#108, #110, #112, #114, #122, #123)

The current public issues, source contracts and fresh public v0.1.21 gate/postmortem supplied these changes; no additional archived source, tests, operational journal or private adopter requirements were inspected or copied. Exact resource-name guidance preserves whitespace-sensitive scheduler identities. Resume messages follow the existing state branch rather than adding a second lifecycle read. Final review shares its existing text budget across ordinary and materialization packets without weakening truncated-evidence rejection. The Codex citation adapter uses bounded integer choices mapped back to exact canonical source/heading pairs; strict semantic validation remains authoritative.

Media brief guidance and actual worker packet regressions preserve accepted requirements, immutable-byte obligations, ordinary owned code and staging declarations while excluding controller operations. Optional provider-neutral worker usage observations normalize supplied counters at the adapter seam and feed the existing private observational progress stream. Usage summaries label scope, cumulative deduplication, supplied-category coverage and matched cache denominators; they do not parse arbitrary evidence, infer charges or reconstruct execution state. The startup correction records the observation before guarded provider stream creation, without changing timeout or result authority. These source acceptances are not new installed-artifact or private-adopter qualification.

## Local host executable preflight (#70)

The public #70 failure, current admitted command contracts and local validator
environment supplied this leaf. Fresh activation resolves reliably literal host
entrypoints and reports unresolved dynamic coverage before projection or attempts.
Lookup uses fixed non-login shell builtins, never target command text. The
validator now uses the same non-login environment so supplied PATH is not replaced
by login profiles. Only explicit exact pinned-base npm/pnpm `packageManager`
versions permit host `--version` probes outside the target; unsupported policies
stay unverified, with no invented version or provisioning policy. Source command
authority and later-tree package script/hook checks are unchanged. Temporary-Git
tests use task-private synthetic host tools and ordinary validation, not live
provider qualification. No archive, private adopter material, lifecycle journal,
fallback or retry machinery was inspected or added.

## Summary transcript retention (#127)

Issue #127 and the current public diagnostic reader, correlation and usage
aggregation contracts supplied this focused leaf. The summary-only reader parses
private NDJSON incrementally, validates every complete record and discards
unrelated transcript fields before retention or sorting. It preserves restrictive
regular-file/no-follow checks, ignores the final unterminated record, and retains
the existing controller and snapshot correlation precedence. Ordinary timeline,
follow, logs and usage aggregation remain unchanged. Memory still depends on the
largest current record, selected usage observations and correlation identities;
this is not a fixed memory cap or a streaming JSON-field parser. Synthetic public
transcript parity and isolated retained-heap probes demonstrate the difference
without claiming an observed OOM, lifecycle authority or live provider proof.
No archived or private material, provider calls, new limits or journals were used.

## Default Node 22.0 scanner compatibility (#129)

Issue #129, the accepted changed-file guard, installed Secretlint 13.0.5 public Node client declarations and implementation, and the complete production dependency metadata supplied this correction. No archived implementation, private adopter content or provider execution was inspected or copied. The Secretlint CLI's unused configuration-creation dependencies excluded early Node 22 releases, and its negative-option parsing rejected Factory's scanner arguments on actual Node 22.0. The clean child entry instead invokes the same-version supported `@secretlint/node` file API with the unchanged recommended preset, explicit configuration, compact masked output and literal files. The parent retains isolated synchronous execution, sanitized environment, restricted report files, staged and working-byte checks, and fail-closed rule/path-only reporting. It adds no timeout policy, config discovery, ignored-file exception, scanner downgrade, lifecycle authority or global Node-floor increase. Source and packed security regressions are separate from live-provider, published-release and private-adopter acceptance.

PR #131's reviewed source and independently reproduced package passed a normal
offline Node 22.0/npm 10.5.1 installation with lifecycle scripts enabled,
installed clean/refused/fatal scanner checks and exact required-dependency
verification. Integrated-main Quality passed at
`57abc0a43b605148a6b3ec191bcedb34c7cf9bc2`; #129 is closed. No immutable public
v0.1.21 release bytes were rewritten or newly qualified by these source checks.
