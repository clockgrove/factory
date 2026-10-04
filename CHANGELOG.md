# Changelog

This file records public releases of Factory. Release artifacts and provenance attestations are on [GitHub Releases](https://github.com/clockgrove/factory/releases); evidence for releases up to v0.1.74 is in the [historical artifact records](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md).

## Unreleased

- A fetch for one Work Item no longer dies with `Invalid path '.git/worktrees/<id>'` while another Work Item's worktree is being added or removed. Git commands that change a checkout's worktree registry (`worktree add/remove/prune`, `gc`, `prune`, `maintenance`, `pull`) hold a per-repository lock exclusively; fetches and `worktree list` share it. Worktree creation and removal hold it only to register and unregister; files are checked out and deleted outside it.
- Factory reads the default branch head without FETCH_HEAD or the remote-tracking ref, so concurrent fetches no longer race on them. A locked fetch stops after 15 minutes, or after 60 seconds below 1000 bytes per second over HTTP, and the step repeats later.
- Factory's git commands never start automatic background maintenance.
- Factory's git commands never run the target repository's git hooks (`core.hooksPath=/dev/null`, which also overrides a hooks path the repository or a worker sets). Hooks are code from a worker-modified tree and would run with the controller's environment. This includes the `post-checkout` hook, which no longer runs when Factory creates a worktree; validation dependencies come from the declared validation commands. Git LFS is set up without its hooks (`git lfs install --local --skip-repo`); Factory pushes and pulls LFS objects explicitly.
- A locked fetch over SSH stops after 60 seconds without a server response (`ServerAliveInterval=15`, `ServerAliveCountMax=4`), unless the operator set `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`, which Factory then uses unchanged.
- When a command Factory ran has exited but left processes in its group (such as git's HTTP helper after a connection reset, or a validation command's background job), Factory waits up to 5 seconds, then stops them and keeps the command's own result instead of recording an unknown outcome. A validation command's changes to the tree are judged after its leftovers stop, and its receipt records how many leftover processes were stopped (`stoppedLeftovers`), which the independent review sees.
- Restart cleanup and `factory cancel` treat a recorded subprocess whose pid now belongs to a different process (a reused pid after a crash or reboot) as ended, and never signal that process, instead of stopping for operator direction.
- Factory requires Git 2.31 or later and checks it with the target checkout.
- `export-captures` sends standard OpenTelemetry (OTLP/HTTP JSON) traces instead of Langfuse- or LangSmith-specific uploads. Pass the OTLP base URL with `--endpoint` (HTTPS, or HTTP to a loopback collector) and authentication through `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`. `--destination`, `--project-id` and `--workspace-id` are removed, along with the `LANGFUSE_*` and `LANGSMITH_API_KEY` variables. Langfuse remains reachable through its OTLP endpoint.

## 0.1.75 — 2026-10-03

- Publish releases from a tag-triggered GitHub Actions workflow that runs the complete checks and tests, installs the packed tarball offline, and attaches a build provenance attestation alongside the tarball and `SHA256SUMS`. Verify a download with `gh attestation verify clockgrove-factory-0.1.75.tgz --repo clockgrove/factory`.
- Install instructions now select the latest release and verify its attestation; the maintainer procedure is in [RELEASING.md](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md). Earlier release records are at [this commit](https://github.com/clockgrove/factory/tree/3ddcf5c16d5f067853654b520339029da25e1026/docs/history).
- Add `scripts/version.mjs` to keep package, lockfile, plugin and marketplace versions and the changelog in step.
- No runtime behavior changes from 0.1.74.

## 0.1.74 — 2026-10-02

- Unify explicit permanent abandonment under one request and controller-derived effect classification for stopped uncertain read-only reviews and synchronous initial/amendment GitHub graph projection (#499).
- Preserve original unknown outcomes, pending graph/review facts, each Work Item’s acceptance or failure status, evidence, accounting and spent allowances. Permanently fence continuation, intake and acceptance of the abandoned unaccepted Objective/run.
- Retain verified stopped ownership and exact repository/run/configuration/source binding. Refuse live or unsupported resources, sealed acceptance and other uncertain external effects; abandonment submits no provider work, remote mutation, cleanup or replay.
- Keep generated dependency notices independent of Factory-only version bumps, while retaining strict dependency and license freshness checks (#508).
- Build once in Quality CI and test that output, removing duplicate compiler passes and the unexamined package dry run while preserving actual packed/installed tests (#509).

The [v0.1.74 distribution gate](https://github.com/clockgrove/factory/issues/505) owns independent source/guidance review, installed qualification and immutable public artifact verification. Actual historical disposition follows installed acceptance and fresh cessation/action binding; the complete [public service gate](https://github.com/clockgrove/factory/issues/448) must then precede separately owned [private readiness and watcher acceptance](https://github.com/clockgrove/factory/issues/445) on the same artifact. Earlier published artifacts and failed runs retain their original evidence and scope. This adds no automatic worker/adopter abandonment, retry or service authority.

## 0.1.73 — 2026-10-02

- Keep intake status read-only so an idle status check does not wake observation and race the next authorized refill (#444 / PR #494).
- Reconcile reviewed native hierarchy changes using authenticated previous and desired parent relationships. Move a child only from its verified previous parent, retain unrelated-parent conflicts, and verify all final parent memberships before graph activation (#495 / PR #496).
- Persist typed whole-call initial and amendment projection outcomes before dispatch. Cancel only completed rejected projections after GET-only authentication of recorded issue subsets and reviewed intermediate relationships; refuse unresolved calls before cancellation intent, preserving original failures and consumed limits (#498 / PR #496).
- Publish complete synced controller owner records atomically without replacing another owner; treat actual lease removal as absence while retaining malformed and uncertain ownership refusals (#501).

The first unpublished installed gate passed 703 of 704 tests and stopped during initial service startup, before external preflights or publication. Its evidence remains preserved; the diagnosed shared lock correction requires a fresh bounded gate. Exact distribution verification is tracked in [#497](https://github.com/clockgrove/factory/issues/497). The failed v0.1.72 public scenario preserves its original results, partial projection identities, accounting and consumed limits. A corrected one-artifact public successor remains [#448](https://github.com/clockgrove/factory/issues/448), followed by separately owned private [#445](https://github.com/clockgrove/factory/issues/445). This correction grants no acceptance or new worker, provider, security or spending authority; earlier releases and failures remain unchanged.

## 0.1.72 — 2026-10-02

- Derive aggregate acceptance according to child roles: implementation results are integrated, while read-only QA and aggregate children provide accepted proof against the selected candidate without a worker or delivery (#483).
- Align compiler and independent-review guidance while preserving prior accepted obligations, exact candidate evidence, command authority and semantic rejection.
- Bind the original archive/checksum and complete extracted/installed file and link inventories through tests and every preflight, refusing later mutation or topology changes before publication (#486).

Published with [independent public distribution verification](https://github.com/clockgrove/factory/issues/485#issuecomment-5953125869): all 514 tests across 50 whole installed files and seven model-free preflights passed without skips. The complete aggregate replay preserves all 49 original files and the unrelated unsupported command/rejection; it does not accept the proposal. The first producer and restricted-host diagnostic failures remain preserved, followed by the reviewed external-context correction with unchanged product bytes. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0172-artifact-record). Actual [#448](https://github.com/clockgrove/factory/issues/448) and [#445](https://github.com/clockgrove/factory/issues/445) remain unaccepted. The #448 artifact-transition decision was pending at publication; the later [approved named continuation](https://github.com/clockgrove/factory/issues/448#issuecomment-5957494560) preserves the failed one-artifact attempt and requires fresh independent mixed-phase acceptance. Historical releases and failures retain their original scope.

## 0.1.71 — 2026-10-02

- Reuse valid execution authority after JSON object properties are reordered, so guided setup preserves its finite selection and durable planning preserves its prepared work (#479).
- Keep ordered arrays, real policy values, optional-field presence and invalid authority fenced. Exact serialized admission receipt verification remains unchanged; reuse makes no new planning call or allowance reset.

Published with [independent public distribution verification](https://github.com/clockgrove/factory/issues/480#issuecomment-5950722931): all 514 tests across 50 whole installed files and six model-free preflights passed without skips. The focused authority preflight proves setup/preparation reuse and first exact admission binding, retains the legitimate closed-Objective stop, and refuses changed policy or already-bound receipt replacement. Scripted boundaries prove mechanics, not live execution. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0171-artifact-record). Live service acceptance remains [#448](https://github.com/clockgrove/factory/issues/448), followed by the separately authorized adopter handoff in [#445](https://github.com/clockgrove/factory/issues/445). All earlier release and failed-run evidence remains preserved.

## 0.1.70 — 2026-10-02

- Choose the operator-owned home directory as the single default outside-write probe for guided Codex setup, preserving explicit overrides and canonical outside-workspace checks (#474).
- Verify controller writability before using a sandbox refusal as boundary evidence. Unsuitable paths remain blocked; no sandbox policy or execution authority changes.

Published with [independent public distribution verification](https://github.com/clockgrove/factory/issues/475#issuecomment-5949114107): all 512 tests across 50 whole installed files and five model-free preflights passed without skips. The fifth uses the actual bundled harness to prove the named workspace/outside boundary and reject sandbox-allowed or host-denied outside locations. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0170-artifact-record). Public service qualification remains [#448](https://github.com/clockgrove/factory/issues/448), followed by the separately authorized private handoff in [#445](https://github.com/clockgrove/factory/issues/445). Earlier published artifacts and failed evidence remain unchanged.

## 0.1.69 — 2026-10-02

- Hydrate source-required CI evidence from one pinned source choice and supply actual controller execution bounds and rejected canonical graphs to review and diagnosis (#458).
- Reject malformed native planner fields before review or projection (#460).
- Qualify an unchanged pinned baseline with read-only QA and final acceptance, using an explicit candidate basis without fabricating integration (#459).
- Retain bounded structured dirty-path evidence from settled post-validation mutations (#438).
- Project ordinary Work Item role labels and native Objective parent context without replacing existing issue metadata (#443).
- Distinguish diagnosis from compilation in invocation and diagnostic metadata (#461).
- Preserve exact private discovery staging evidence in the settled owned worktree when collection rejects a result; successful collection still excludes private proposals from Git and cleans up (#465).
- Retain the original initial-planning review packet with its complete context and response across continuation; changed or unbound evidence stops before calls or allowance consumption (#464).
- Keep the private control socket bound to its own directory until the native listener closes, preventing file descriptor reuse from deleting another live socket (#468).

The first distribution attempt passed 501 of 502 installed tests, then stopped on the pilot test's production-only pnpm lookup. The test-only correction uses the existing separately supplied locked tool and retains the complete offline pnpm/LFS and final-evidence assertions (#471 / PR #472). The failed attempt is preserved.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/466#issuecomment-5948017279). All 502 tests across 49 whole installed files and four model-free preflights passed without skips. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0169-artifact-record). Live public service acceptance remains [#448](https://github.com/clockgrove/factory/issues/448), followed by the separately authorized adopter handoff in [#445](https://github.com/clockgrove/factory/issues/445). Earlier artifacts, failed runs, original evidence and accounting remain unchanged.

## 0.1.68 — 2026-10-01

- Establish background observation through guided target setup, including explicit service consent, retained package binding and verified service-owned GitHub observation (#447). A separately approved persistent watcher waits after finite work and accepts supported explicit refill while idle (#444).
- Report unusable or stale service package/configuration bindings without hiding the actual manager state (#442).
- Bind source-required named CI into the reviewed graph and require authenticated successful exact-head receipts before regular or native integration (#446).
- Supply the actual post-validation worktree observation to independent Work Item, QA and final review, while preserving absent historical evidence and dirty-tree refusal (#452).

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/451#issuecomment-5946087196). All 317 tests across 30 whole installed files and two model-free preflights passed without skips. The [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0168-artifact-record) preserves the external preflight assertion failure and its reviewed correction without changed product bytes. Public live service qualification remains [#448](https://github.com/clockgrove/factory/issues/448), followed by the separately scoped adopter rollout in [#445](https://github.com/clockgrove/factory/issues/445). Distribution verification grants no Objective acceptance or execution authority; earlier releases retain their exact evidence.

## 0.1.67 — 2026-10-01

- Allow supported local cancellation when the recorded worker has ceased without a durable result and its owned process group is absent (#437). Preserve live-descendant and reused/foreign identity fences across the local Codex, Claude and Copilot harnesses.
- Retain the original failed attempt, missing result and unknown accounting. Cancellation grants no implementation acceptance, retry or migration authority.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/439#issuecomment-5944288283). All 63 installed tests and one model-free CLI preflight passed without skips. The fresh synthetic cancellation scenario also passed from the verified public bytes for #437. These checks do not accept live Objectives or adopter pilots; earlier releases and their evidence retain their exact artifact and scenario scope.

## 0.1.66 — 2026-10-01

- Clarify private Objective Gantt views with elapsed-time ticks, adapter/provider/model identities, recorded command indexes and honest unavailable labels. Keep SDK invocation intervals distinct from individual model calls and shell commands; unknown CPU/network time remains unknown (#428 / PR #430).
- Preserve explicitly configured `CODEX_SQLITE_HOME` through local Codex planning, review, readiness, worker execution and installed service environments, retaining the existing Codex home and credential filtering. Factory does not choose a directory or alter shared Codex databases (#429 / PR #432).

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/431#issuecomment-5941198440). All 205 installed tests and nine model-free preflights passed without skips. These distribution checks do not accept live Objectives or adopter pilots; earlier releases and Objective acceptance retain their exact artifact and scenario scope.

## 0.1.65 — 2026-10-01

- Retain the native predecessor acceptance binding when amending successor Objectives, while reobserving current executable availability (#376 / PR #424). Existing admissions remain readable; native amendments without the required original binding refuse without discarding evidence or accounting.
- Recognize actual Codex final-answer and agent-message events in contributor Gantt metadata without exporting message content (#396 / PR #421).
- Use eight isolated test-file workers for installed contributor release checks, based on the same-artifact concurrency benchmark (#422 / PR #423). Release stages and tests within each file remain sequential; Factory runtime scheduling is unchanged.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/425#issuecomment-5939722740). All 145 installed tests and nine model-free preflights passed without skips. These distribution checks do not accept live Objectives or adopter pilots; earlier releases and Objective acceptance retain their exact artifact and scenario scope.

## 0.1.64 — 2026-10-01

- Permit equivalent acceptance wording for never-started ordinary Work Items during graph amendments (#415). Preserve every substantive obligation through the existing independent review of complete previous/proposed graphs.
- Retain exact started/completed definitions, controller-derived aggregate acceptance, source criteria, coverage, command authority and native delivery guards. No new state, model call, retry or permission is introduced.

Published with [independent public verification](https://github.com/clockgrove/factory/issues/417). The autonomous local Objective qualification completed under [#243](https://github.com/clockgrove/factory/issues/243); all earlier failed runs, consumed allowances and unknown accounting remain preserved.

## 0.1.63 — 2026-10-01

- Reuse the retained worker discovery capture in current, completed dependency and final review, with its actual attempt/result binding (#412).
- Supply the matching accepted graph-revision receipt, independent-review digest, parent/successor bindings and exact added QA/parent definitions. Keep submitted proposals, reviewed amendments and completed acceptance distinct.
- Clarify that absent or stale supplied discovery is missing proof, not a negative submission observation. Missing or mismatched facts still cannot pass a required source obligation; no new state, API, call or permission is introduced.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/413). All 139 whole installed tests and nine model-free preflights passed without skips. One bounded final-packet diagnostic passed all four criteria, granting no Objective acceptance. Full same-artifact autonomous Objective acceptance remains #253, #331, #254 and #243; historical failures, consumed allowances and unavailable accounting remain preserved.

## 0.1.62 — 2026-10-01

- Supply exact retained failed-candidate Git descriptors and an ownership-scoped comparison with the corrected result to current, dependency and final review (#409). Preserve attempt and execution-base bindings while allowing legitimate native result-base and whole-tree changes.
- Supply the validated admission binding, permitted repair class and finite objective/path limits with actual consumption. Keep operator diagnosis and host-action declarations separate from controller facts and source-required successful probe receipts.
- Preserve all existing acceptance, ownership, uncertainty and allowance fences without a new recovery operation, persistent record or model call.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/410). All 139 whole installed tests and nine model-free preflights passed with zero skips. The bounded final-packet review passed the repaired-candidate obligation and exposed missing discovery evidence in #412; it granted no Objective acceptance. Full same-artifact autonomous Objective acceptance remains #253, #331, #254 and #243; historical evidence and accounting retain their original scope.

## 0.1.61 — 2026-10-01

- Permit a diagnosed correction of a known, completed, unprojected amendment review finding through the existing bounded replacement operation (#406). Keep unknown calls, invalid responses, projected work and terminal states fenced.
- Retain the rejected candidate, original evidence, started definitions, immutable discovery and consumed allowance. Fresh compilation charges one remaining revision and still requires canonical validation and complete independent review before projection.
- Preserve initial executable observations and later QA/repair evidence without granting acceptance or expanding source, provider or spending authority.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/407). All 138 whole installed tests and eight model-free preflights passed with zero skips. Full same-artifact autonomous Objective acceptance remains #253, #331, #254 and #243. Historical releases and rejected runs retain their exact evidence and accounting.

## 0.1.60 — 2026-10-01

- Supply existing controller-local executable observations for exact final commands to compilation, independent graph review and bounded diagnosis (#403). Keep presence separate from acceptance success, script-body behavior and remote worker readiness.
- Bind the facts through the existing compiler context, preparation and review packets; repeat the existing check at admission and activation. Graph amendments observe their own scoped facts, and missing tools still fail before model calls.
- Preserve stopped preparation, rejected responses, consumed allowances and unknown accounting without adding automatic continuation or resetting limits.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/404). All 133 whole installed tests and seven model-free preflights passed with zero skips. These distribution checks do not accept live Objectives or adopter pilots. Complete autonomous Objective acceptance remains #253, #331, #254 and #243; earlier releases retain their original artifact and scenario evidence.

## 0.1.59 — 2026-10-01

- Supply the selected integrated commit/tree and actual validation phase to independent read-only QA review, without a worker or PR identity (#397).
- Supply compact retained failure, correction, original candidate and admitted consumption facts to current, dependency and final review. Original failed candidates remain distinct from later native replay results; declared diagnosis does not prove external effects.
- Preserve source phase ownership and conditional failure semantics: a passing conditional check does not require an invented failed execution. Missing evidence and exhausted repair authority retain their existing stop boundaries.

Published with [independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/399). All 92 installed tests and six model-free preflights passed. These distribution checks do not accept live Objectives or adopter pilots. Stopped qualification evidence and consumed allowances retain their original identities; complete autonomous Objective acceptance remains #253, #331, #254 and #243.

## 0.1.58 — 2026-10-01

- Add a private SVG Gantt view for target-repository Objectives with `factory analyze --gantt --output ABSOLUTE_NEW_FILE`. It reads retained local metadata, distinguishes provider invocations from controller observations, and preserves incomplete intervals without loading captured content or making provider calls (#389 / PR #391).
- Add a separate repository-local contributor Gantt skill for developers building Factory, streamline completion of independently verified releases, and select proportionate PR checks while retaining the complete main gate (#388, #386, #390). Contributor tooling is outside the installed plugin skills.

Published with all 35 installed checks and five model-free preflights. [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/394#issuecomment-5926979213) passed. These artifact checks do not establish complete autonomous Objective or adopter acceptance; #243 and its required dependencies retain that scope. Earlier releases and their evidence keep their original identities.

## 0.1.57 — 2026-09-30

- Retain the v0.1.56 runtime. The contributor public-audit command now creates its private Codex home before the first CLI invocation (#382 / PR #383).
- Measure a clean complete sequential release after candidate review and CI under #384, with detailed timing attribution. This does not establish live autonomous Objective or adopter acceptance.

Published with all 27 installed checks and five model-free preflights. [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/384#issuecomment-5925566535) passed. The clean contributor release measurement and its original source, archive and accounting evidence remain bound to #384; they do not establish autonomous Objective or adopter acceptance.

## 0.1.56 — 2026-09-30 (candidate)

- Retain the v0.1.55 sequential-planning runtime correction. This candidate aligns the next public artifact with the single-owner contributor release workflow introduced by #378 / PR #379.
- Measure packaging, installed/model-free checks, protected publication and independent public verification sequentially under #380. This does not establish live autonomous Objective or adopter acceptance.

Publication and public verification are pending. Earlier releases and evidence keep their original identities.

## 0.1.55 — 2026-09-30 (candidate)

- Supply authenticated native Objective dependencies, sealed accepted predecessor identity and the actual selected-base relationship to compilation, graph review and planning diagnosis. Bind these phase-available facts to their original body and acceptance evidence, and refuse unavailable, changed or mismatched prerequisites (#374).
- Keep a Work Item's own independent-review completion in final Objective acceptance under the original whole criterion. Preserve source-required commands, independent review, unique obligations and existing admission limits (#374).

Candidate preparation only. Matching archive, offline installation, focused installed proof, protected publication and independent public archive/pinned-plugin verification are pending. Earlier evidence retains its original bytes and scenarios; complete autonomous Objective qualification remains [#253](https://github.com/clockgrove/factory/issues/253).

## 0.1.54 — 2026-09-30

- Align compilation, graph review and planning diagnosis around one owner and complete proof for each whole source obligation. Use the existing final-review proof for compound final criteria that no single controller guarantee covers; preserve unique obligation indices, duplicate rejection and independent final acceptance (#370).

Published with fresh-cache offline installation and all 40 installed compiler/QA checks, without skips. [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/pull/372#issuecomment-5922896684) passed. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0154-artifact-record). Earlier release evidence retains its original bytes and scenarios; full autonomous Objective qualification remains [#253](https://github.com/clockgrove/factory/issues/253), with #331 final-evidence acceptance and #254 interruption reconciliation still required by #243.

## 0.1.53 — 2026-09-30

- Retain one actual identified delivery check receipt when every current same-name run is completed and successful on the exact head and repeated runs identify the same valid GitHub app. Preserve refusal of failed, pending, stale, conflicting or incomplete evidence, target protections and singular QA ambiguity (#357).
- Retain read-only QA and aggregate dependency evidence while excluding those structural nodes from coding merge groups. Place item and final review submission fences after local evidence and packet preparation; preserve uncertain provider outcomes and historical markers (#361).

- Allow explicit permanent abandonment of an exact stopped Objective whose only unresolved effects are read-only result reviews, after identity-bound cessation evidence and ownership checks. Preserve original markers, results, errors, evidence, consumed limits and unknown accounting; permanently refuse continuation of the abandoned run and retain refusal of unresolved mutating effects (#363).

Published with fresh-cache offline installation and all 109 whole-file installed checks, without skips. [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/357#issuecomment-5920335558) passed. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0153-artifact-record). Full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253); actual historical run disposition and adopter acceptance remain separate outcomes. Earlier releases and qualification evidence retain their original bytes and scenarios.

## 0.1.52 — 2026-09-30

- Retain exact controller-owned started Work Items through transient amendment references instead of asking the planner to regenerate historical definitions. Keep source-owned coverage choices and complete independent graph validation/review (#350).
- Expose a controller-derived original amendment failure digest and redact configured-secret echoes in existing preparation/execution status projections, retaining original rejection binding and snapshot authority (#348).

Published with fresh-cache offline installation and 38 exact installed correction checks. [Independent public archive and pinned-plugin verification](https://github.com/clockgrove/factory/issues/350#issuecomment-5917330492) passed. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0152-artifact-record). Full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253); earlier published records retain their original bytes and scenarios.

## 0.1.51 — 2026-09-30

- Require source-owned QA coverage at the emitted planner choice and strict decoder boundary, preserving work/aggregate alternatives and original final obligations (#345).
- Allow explicit diagnosed replacement of a known unprojected compiler amendment rejection through existing controls and the same planning allowance, retaining rejected evidence and accepted work (#346).

Published with [independent public artifact/plugin verification](https://github.com/clockgrove/factory/issues/345#issuecomment-5915659441), fresh-cache offline installation and four exact installed correction cases. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0151-artifact-record). Full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253); earlier release evidence retains its original artifact and scenario.

## 0.1.50 — 2026-09-30

- Derive new aggregate acceptance from completed, integrated child results; retain prior accepted criteria exactly and keep semantic QA and final Objective obligations at their supported phases (#341).
- Supply the harness discovery captured for the current attempt in independent result review, bound to the reviewed result and marked as untrusted proposal data (#342).

Published with [independent public artifact/plugin verification](https://github.com/clockgrove/factory/issues/341#issuecomment-5913718125), fresh-cache offline installation and seven exact installed correction cases. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0150-artifact-record). Earlier release and v0.1.47 workspace evidence retain their original artifact and scenario scope; full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253).

## 0.1.49 — 2026-09-30

- Classify settled, unpublished Work Item failures from their own outcome while an independent sibling's controller collection remains active. Keep diagnosed candidate repair fenced until global quiescence (#338).

Publication, independent public download, pinned plugin verification, offline installation and both exact installed correction checks passed under [#338](https://github.com/clockgrove/factory/issues/338). See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0149-artifact-record). Published v0.1.48 distribution evidence and accepted v0.1.47 public workspace evidence retain their original artifact and scenario scope; full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253).

## 0.1.48 — 2026-09-30

- Retain reviewed published results while required checks or target protections become ready, then continue exact-head delivery without rerunning workers (#335).
- Correct supervisor registration and lifecycle when the installation uses an isolated XDG configuration directory (#327).
- Supply supported controller review and protected-delivery guarantees during planning, and compact exact-result review and pre-integration check evidence during final acceptance (#331).
- Allow diagnostics to inspect supported preparing continuations without treating them as executing Work Items (#328).
- Include version-matched installation guidance in the frozen package and check the actual archived guidance before publication (#325).

Publication, independent public download, pinned plugin verification, offline installation and exact installed model-free checks passed under [#333](https://github.com/clockgrove/factory/issues/333). Full autonomous qualification remains [#253](https://github.com/clockgrove/factory/issues/253). Earlier release and qualification evidence remains bound to its original artifact and scenario. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0148-artifact-record).

## 0.1.47 — 2026-09-30

- Require an exact readiness-probe selection for real environments in the structured compiler contract. Distinguish pre-worker readiness from validation of work that has yet to be delivered, preserving canonical command authority (#319).
- Include provider-neutral sandbox execution and the optional Daytona public-source adapter, with verified transfer and owned-resource cleanup. Private authentication and live Daytona qualification remain open (#8, #9).
- Add explicit, preview-bound export of selected captures to LangSmith while retaining redaction, incomplete content and unknown usage (#218).

Publication and source checks do not establish full installed Objective acceptance. Public workspace and autonomy qualification remain tracked in #263 and #253.

## 0.1.46 — 2026-09-29

- Show the existing optional AssetSet format-metadata shape in worker inputs, and omit it when no authoritative format fields are supplied. Preserve strict manifest validation and source-byte identity (#310).
- Include the Claude Managed Agents adapter and managed-provider credential readiness and private systemd credential bindings (#259, #308). Source integration does not establish hosted-provider qualification.
- Add explicit, preview-bound export of selected captures to Langfuse, retaining redaction, incomplete content and unknown usage (#217).
- Add reproducible offline pattern-analysis evidence and the bounded deterministic interruption matrix (#220, #254), without a new analysis or recovery framework.

Publication and source checks do not establish full installed Objective acceptance. Public workspace and autonomy qualification remain tracked in #263 and #253.

## 0.1.45 — 2026-09-29

- Expose configured built-in MCP capability and additive-instruction presence/equality to planning and graph review while retaining private instruction text, opaque registered configuration and exact runtime bindings (#301 / PR #302).
- Distinguish configured capability from successful readiness or invocation, and instruction equality from instruction semantics; preserve native tool and permission restrictions.
- Include the integrated OpenAI hosted Work Item execution adapter and durable provider checkpoints from PR #300. Deterministic source checks do not establish live provider qualification.

Publication and source checks do not establish installed Objective qualification; see [#303](https://github.com/clockgrove/factory/issues/303) and the continuing release gates.

## 0.1.44 — 2026-09-29

- Confirm ordinary guarded merges from the successful merge response and current PR identity under GitHub REST API `2026-03-10`, which no longer returns `merge_commit_sha` (#293 / PR #294).
- Resolve native-stack merge commits from authenticated, paginated merge timeline events, rejecting missing, malformed or conflicting evidence while preserving layer identity, async-result agreement and exact default-head checks.
- Exercise current-version response fixtures across regular delivery and native completion, saved-UUID and already-merged reconciliation without adding merge replay or API fallback.

Publication and source checks do not establish installed Objective qualification; see [#295](https://github.com/clockgrove/factory/issues/295) and the continuing release gates.

## 0.1.43 — 2026-09-29

- Replace model-authored controller bookkeeping with one compiler choice protocol and packet-bound reviewer indices.
- Derive exact source commands, coverage identities and pinned worker inputs, including operator-supplied graph amendments.
- Use typed proof alternatives that reject unsupported published command/semantic evidence; preserve exact-head CI and integrated proof freshness.
- Classify completed decoder failures through the existing bounded planning repair path.
- Keep intake lifecycle control reachable across Objective handoffs without rebinding its socket.
- Change current plan and state formats without compatibility adapters or migrations; preserve historical evidence.

Source verification and publication do not establish installed Objective qualification. See [#285](https://github.com/clockgrove/factory/issues/285) and the continuing release gates.

## 0.1.42 — 2026-09-29

- Select Codex readiness probes by an owning validation-command index or null, preserving canonical command authority and rejecting prose probes. Failed bounded plan revisions retain the original graph and findings while reporting the actual failure and attempted revision (#280 / PR #282).
- Publication, independent public download, offline installation and pinned plugin verification passed. Installed schema/input diagnostics pass without creating an accepted plan; live workspace/compiler qualification remains in #263/#276/#280 and full autonomous qualification in #253. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0142-artifact-record).

## 0.1.41 — 2026-09-29

- Constrain planner schema identities: non-CI coverage uses an empty target, and source-declared commands reference exact supplied source paths. Preserve runtime validators and base-observed command provenance (#276 / PR #278).
- Publication, independent public download, offline installation and pinned plugin verification passed. Installed compiler diagnostics pass; live workspace/compiler qualification remains in #263/#276 and full autonomous qualification in #253. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0141-artifact-record).

## 0.1.40 — 2026-09-29

- Add explicit Objective-bound exact package additions to existing pnpm workspaces, preserving non-membership configuration and enforcing the same authority during planning, item/QA and final validation (#263 / PR #268).
- Include reviewed autonomous admission, local coordinator/supervision, graph amendments and aggregates, executable QA coverage, resource scheduling and current-graph completion (#244–#249, #251). Dedicated autonomous program qualification remains #253.
- Publication, independent public download, pinned plugin identity and offline installation passed. This does not transfer earlier live Objective evidence to these bytes; live acceptance is tracked separately. See the [immutable artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0140-artifact-record).

## 0.1.39 — 2026-09-29

- Clarify phase-available planning evidence: immutable ordinary blob equality can prove committed-byte preservation without proving hydration, opaque semantics or transient history (#197 / PR #239).
- Add opt-in, bounded private interaction capture for planning/review and all shipped local worker adapters, preserving actual SDK-exposed content, identities, usage availability and provider-estimate completeness (#214 / PR #240).
- Add local metadata-only analysis with exact grouping/filtering, separate outcomes, usage and time coverage, and restrictive report output (#219 / PR #241).
- Publication, independent public-download/offline-installation verification and installed capture/analysis smoke checks passed. No live Objective was rerun; the accepted v0.1.38 workflow and earlier private implementation retain their original scope. See the [artifact record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0139-artifact-record).

## 0.1.38 — 2026-09-29

- Replace graph, Work Item and final review quotation transcription with packet-local evidence and criterion IDs. Preserve strict identity validation, semantic review and existing exact-tree operator decisions; malformed protocol responses remain distinct from substantive findings (#233 / PR #235).
- Allocate bounded review text by actual emitted bytes and separate metadata from independently complete file patches, so unrelated omitted text does not discard complete evidence (#234 / PR #235).
- Parse selected Markdown sections with a shared fence-aware ATX scanner, preserving exact source bodies, optional closing hashes and literal C# headings (#232 / PR #235).
- Preserve dependencies, provider/model authority and lifecycle limits. Publication, independent public-download/offline-installation verification and public workspace/LFS qualification passed on this exact artifact. The bounded Clockgrove pilot passed final verification under #206 and explicit operator acceptance under #207. Earlier artifacts and failures retain their own evidence.

## 0.1.37 — 2026-09-28

- Record accepted ignored relative link paths during the existing original-worker collection safety scan, preserving provider evidence and carrying completed observations through existing regular/native private diagnostics with attempt and result-tree identities (#225 / PR #227).
- Keep collection safety and lifecycle rules unchanged. Observations prove presence during the scan; missing or truncated detail cannot prove an exact path, and later validation installations do not establish original-worker history.
- Publication, independent public-download/offline-installation verification and isolated pinned plugin installation passed. The aggregate public qualification is independently accepted: retained original-worker collection and policy evidence plus current media/documentation/final acceptance and an independent exact-final-clone seven-command check. Earlier cancelled/failed runs, their receipts and setup-command limits remain preserved in [the immutable record](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md#immutable-v0137-artifact-record). The private Codex-only pilot and final adopter acceptance remain separate under #206 and #207. Qualification required no new runtime release.

## 0.1.36 — 2026-09-28

- Assign installation-approved execution profiles during Objective compilation and preserve exact bindings through review, issue projection and local lifecycle (#162 / PR #221).
- Prepare private additive worker instructions and the bounded Claude in-process worktree-read MCP capability, with explicit Read authority, runtime provenance/readiness verification and descriptor confinement (#164 / PR #222).
- Publication, independent public-download/offline-installation checks and isolated pinned marketplace installation passed. Existing published artifacts remain immutable. Combined exact-artifact public workspace/LFS and mixed-provider/environment qualification remains pending in #162 and #164 before the private Codex-only pilot; earlier pilot evidence does not transfer.

## 0.1.35 — 2026-09-28

- Present bounded Git patch excerpts literally for current-result and controller-materialization review (#212 / PR #213), reusing ordinary Work Item delta rendering. Review prompts and citation grounding share the same text; exact-source matching, identity, ownership and truncation checks remain intact.
- Dependency versions, provider scope and lifecycle behavior are unchanged. Publication and independent public-download/offline-installation verification passed; [PR #215](https://github.com/clockgrove/factory/pull/215) records release gates and reproduction. Exact-artifact live qualification remains pending in [#206](https://github.com/clockgrove/factory/issues/206); final adopter acceptance remains in [#207](https://github.com/clockgrove/factory/issues/207). Preserve previous artifacts and evidence.

## 0.1.34 — 2026-09-28

- Make successful command receipts directly quotable during automatic result review (#208 / PR #209). Share literal command rendering between model input and citation grounding while preserving exact-source matching and receipt index, tree and success identities.
- Dependencies, providers, worker authority and lifecycle behavior are unchanged. Publication and independent public-download/offline-installation verification passed; [PR #210](https://github.com/clockgrove/factory/pull/210) records release gates and reproduction. Exact-artifact public/adopter qualification remains pending in [#206](https://github.com/clockgrove/factory/issues/206), with final acceptance in [#207](https://github.com/clockgrove/factory/issues/207). Previous artifacts and evidence remain immutable.

## 0.1.33 — 2026-09-28

- Add explicit `rereview` for an exact pending Work Item result (#202 / PR #203), followed by `run` to repeat validation and automatic review without restarting implementation or recording acceptance. Preserve earlier decisions, result identities and unknown usage. Final Objective review retains its existing `run` continuation.
- Include matching user and director guidance. Dependency versions, provider scope and automatic-retry limits are unchanged. Publication and independent public-download/offline-installation verification passed; [PR #204](https://github.com/clockgrove/factory/pull/204) records source/artifact checks and reproduction. Fresh public qualification and actual adopter acceptance remain pending in [#26](https://github.com/clockgrove/factory/issues/26); prior releases and runs stay immutable.

## 0.1.32 — 2026-09-28

- Supply declared completed dependency deltas and ordered own-tree validation receipts to Work Item acceptance review (#198 / PR #199). Keep current and predecessor identities distinct; native published predecessors retain explicitly absent integration identities. Reuse final-review evidence without new persisted state or prior model verdicts as authority.
- Preserve dependency versions, provider and selection-authority boundaries, final validation and release gates. Publication and independent public-download/offline-installation verification passed; [PR #200](https://github.com/clockgrove/factory/pull/200) records source/artifact checks and reproduction. Fresh public qualification and actual adopter acceptance remain pending in [#26](https://github.com/clockgrove/factory/issues/26); previous releases and runs stay immutable.

## 0.1.31 — 2026-09-28

- Ship the accepted plugin onboarding from PR #194: setup and director distinguish ordinary target-repository operation from Factory development and contributor release fixtures. Director confirms the configured repository and checkout before every Objective command.
- Present separate user and contributor entrypoints, a plugin user guide, copyable target Objective form, and clear support and release documentation. Preserve exact historical release evidence.
- Align package, plugin and marketplace identity. Runtime, dependency versions, provider boundaries and release gates are unchanged. Publication and independent public-download/offline-installation verification passed; [PR #195](https://github.com/clockgrove/factory/pull/195) records source/artifact checks and reproduction. Fresh public qualification and actual adopter acceptance remain pending in [#26](https://github.com/clockgrove/factory/issues/26); earlier artifacts stay immutable.

## 0.1.30 — 2026-09-28

- Require self-contained source-backed implementation briefs and independent worker-input completeness review (#185 / PR #186). Preserve ownership, dependencies and later validation timing. Synthetic coverage does not establish live model adherence.
- Include the already-integrated local-harness usage normalization (#180 / PR #182), which was excluded from immutable v0.1.29. Missing usage remains unknown.
- This metadata-only successor changes no runtime, dependencies or skills beyond those accepted source changes. Public installed qualification and adopter acceptance remain separate in #26. Preserve all previous artifacts and terminal runs.

## 0.1.29 — 2026-09-27

- Supply a bounded recursive inventory of the exact validated Git tree to item and final acceptance review, including unchanged tracked paths. Preserve completeness, configured text budgets and path-only proof limits (#179 / PR #181).
- Include the accepted Copilot session-editor correction to use the pinned runtime's `apply_patch` tool (#170 / PR #178). Its earlier installed qualification belongs to that exact artifact; this release does not inherit provider or public-gate acceptance.
- Publish frozen reviewed source `401d74da56d234ba6958a3b1ce9e0b7b5f5eeecb`, tree `63f2471e0acba681f5c5c2f831543bc7d424af33`, from accepted #179 plus release metadata. Concurrent #180 is present in main but excluded from these immutable bytes. Preserve published v0.1.28 and its waiting public run; fresh automatic qualification remains separate in #26.

## 0.1.28 — 2026-09-27

- Publish reviewed PR #176 source `dc7097b487701cab94aa1d3f5aa561faa3416998`, tree `6f552925f9a6f2e464f9a46af1236a16537305df`. Full220 actualNode22 and hostedNode24 gates, independent artifact review, normal offline installation and byte-identical merged-source reproduction passed. Fresh public live qualification and actual adopter acceptance remain separate in #26; publication does not inherit earlier provider evidence.

- Explain selected required-LFS pointer checkouts and subsequent controller byte restoration in the shared worker prompt. Preserve owned deliverables, read-only inputs and exact commands; no worker hydration or acceptance override. Accepted #174 / PR #175 at `2948de665f7d0abc9c98df701b2a03178fcea773`; live adherence remains unqualified.
- Include accepted delivery-origin binding (#149), aggregate review-budget reuse (#167), and exact selected-LFS receipt binding (#168). Prepare the combined public candidate without inheriting live acceptance from earlier #55 artifacts.

- Accept the pinned Claude runtime's bundled/managed components without treating plugin inventory as a security attestation. Disable optional telemetry, account sync, auto-memory and personal/project instruction loading per invocation; retain configured model-tool, managed-policy and controller lifecycle boundaries.
- Reconcile current main including early Objective acceptance preflight and validated selected-LFS review evidence. Earlier 0.1.22 artifacts and live evidence remain historical; this candidate requires its own installed proof.

- Keep Copilot workers on Factory's owned empty GitHub CLI authentication directory instead of exposing ambient or default controller publication stores; retain separately selected Copilot-local authentication and explicit session settings.
- Validate observed Copilot startup identity before dispatching the Work Item prompt, with the existing bounded event wait and no fallback. Keep one stable provider-turn timeout promise across progress resets so callback-driven stalls fail durably (#130).

- Expose a capability-checked package-root local `AgentHarness` registration seam with stable adapter identity, adapter-owned configuration, durable lifecycle handles, and a packed full-path conformance test.
- Add pinned optional Claude Agent SDK 0.3.281 and GitHub Copilot SDK 1.0.13 Work Item adapters while preserving Codex as the default and planning/review provider.
- Reuse developer-local provider authentication, fail with actionable login-and-retry guidance when it is absent, and keep controller GitHub publication credentials out of worker environments.
- Preserve every exact Work Item validation command with its provenance and source in the common Codex, Claude, and GitHub Copilot worker prompt while retaining controller-only command execution and validation authority.
- Derive Claude and GitHub Copilot client telemetry versions from the installed Factory package metadata instead of a stale release literal.
- Refresh the harness candidate onto accepted main, preserving controller capabilities, media receipts, shared staging/stop boundaries, exact validation constraints, terminal/idle guards, worker-usage correlation, and the Biome/Node 22 quality gate. Claude and Copilot normalized token counters remain explicitly unavailable rather than estimated.

## 0.1.27 — 2026-09-27

- Reject missing or empty recognized final acceptance before model-backed planning or activation using the existing Objective parser.
- Supply compact exact-tree selected-LFS pointer/filter validation facts to item and final review. Separately include bounded tracked attribute text without treating effective filtering as proof of exact rule contents; retain later delivery and final hydration phases.
- Strengthen the offline real-pnpm/Git/LFS pilot at the production serialized-review boundary, with missing-evidence negatives and early-refusal regressions. Carry accepted #165 / PR #166 integration `058bd7587aa532342ebb77488474258c90930f5d` through published metadata PR #169, source `7d4e926b99cf2446b0d9a3e53a17e270a820b7fb`. Publication and independent public-download/offline installation passed. The public gate remains nonqualifying after a final-integration worker refusal and one explicit retry; actual adopter acceptance remains separate. Preserve all published artifacts and prior runs.

## 0.1.26 — 2026-09-27

- Constrain compiler and independent graph-review acceptance to evidence available before the current Work Item's own delivery, including every clause of compound criteria. Preserve available completed-dependency evidence without presuming native-stack predecessors have merged; keep upload and final hydration at their existing controller phases.
- Include the offline real-pnpm/Git/LFS regression and selected-LFS lifecycle coverage, plus ordinary-host controller launch and worker-preflight guidance. Scripted tests establish instruction delivery and lifecycle ordering, not live model adherence.
- Carry accepted #159 / PR #160 at `5aaf6feb01138ff91acc173ae5961daba8638bff`. Keep published v0.1.25, its paused runs and plans, and frozen #55/PR #62 candidate 0.1.22 unchanged. Publish through metadata PR #161 at `b20cc82c8b63ca231b1f120ce25025836ed8d75b`. Publication and independent public-download/offline installation passed; fresh exact-artifact public qualification and actual adopter acceptance remain pending in issue #26.

## 0.1.25 — 2026-09-27

- Permit new Git-ignored, nondelivered links only when absent from HEAD and the index (including staged descendants), with an existing ordinary-file/directory destination strictly inside the worktree and outside its root and Git metadata.
- Preserve recursive ignored-directory inventory and delivered-path, symlink-ancestor, escape, special-file, mode, ownership and staged/working-byte secret guards. Add real local collection coverage for contained pnpm-style links, owned ignore policy and mixed unsafe candidates.
- Explicitly declare ESM in the existing generic pnpm receipt test fixture for the unchanged Node 22.0 floor; no runtime dependency or packaged skill changes.
- Publish accepted source from PR #151 and metadata PR #152 at `b641ccdccdb969f14c64a66da751c22f6be5bd6d`, without rewriting immutable v0.1.24 or frozen #55 candidate 0.1.22. Publication and installation verification passed; automatic qualification of the wholly fresh public gate and actual adopter acceptance remain separate coordinator-owned requirements. The first combined gate is preserved/nonqualifying after a provider idle timeout, not a product finding; see [build status](https://github.com/clockgrove/factory/blob/3ddcf5c16d5f067853654b520339029da25e1026/docs/history/BUILD-STATUS-2026-10-03.md).

## 0.1.24 — 2026-09-26

- Align planner structured-output lower bounds with existing required graph-shape validation: at least one Work Item; non-empty title, goal and brief; and non-empty acceptance, non-goals, owned paths and citations. Preserve the production indexed-citation schema/decoder seam and legitimate empty optional collections.
- Preserve fail-closed semantic checks, source/command authority, the bounded sourced revision, local Codex execution and Node >=22. No new dependencies, arbitrary maxima, fallback/retry pipeline or manual graph repair is added.
- Carry forward accepted v0.1.23 source corrections without rewriting its immutable artifact or qualifying its preserved failed planning attempts. The actual raw failed fields remain unknown; schema-mismatch tests do not identify those fields.
- Release metadata only here: publication, fresh installed-artifact Objective qualification and the separately approved private adopter pilot remain required. Frozen #55 candidate 0.1.22 and optional Claude/Copilot work are not included.

## 0.1.23 — 2026-09-26

- Permit result and final review to ground exact quotes across separately selected headings from the same source document, without concatenating packets or weakening authoritative evidence label checks.
- Include accepted source corrections since v0.1.21: accurate resume messaging, compact citation schema, resource guidance, aggregate review budgets, worker usage, streaming usage summaries, bounded provider-wait retention, Node 22.0 scanner compatibility, host-tool preflight, interrupted-delivery refusal and the reviewed Biome migration with retained fallback quality coverage.
- Preserve local Codex-only execution and the Node >=22.0 floor. Optional Claude/Copilot harness work and live qualification in #55 remain deferred and are not included.
- Publication and fresh installed-artifact/adopter acceptance remain separate gates. The unreleased #55 candidate uses 0.1.22; this release candidate uses 0.1.23 to avoid conflating their identities.

## 0.1.21 — 2026-09-25

- Bind automatic review to the immutable worker/controller Git boundary for selected media: the retained worker result changes no selected destination, and Factory's exact child commit changes every selected destination and no others.
- Supply the same bounded materialization evidence to regular and native Work Item review and final Objective review without adding state fields, journals, or diagnostic authority.
- Add a strict exact two-item same-path ordinary-blob-to-LFS release rehearsal covering automatic Work Item review, native delivery, LFS upload and hydration, final review, and Objective closure.

## 0.1.20 — 2026-09-25

- Constrain planner citations to exact supplied source paths and bare Markdown heading names in the structured-output schema and production prompt.
- Preserve selected-section scope by allowing the empty whole-source heading only when the pinned planning packet includes an actual whole-source entry.
- Retain strict non-normalizing semantic validation and expose bounded expected-heading diagnostics when a provider response violates the citation contract.

## 0.1.19 — 2026-09-25

- Bind every controller-imported source binding and exact content identity into the controller-owned capture receipt for each candidate set.
- Reject missing, edited, reordered, cross-candidate, accepted-binding-mismatched, or unrecognized input receipt fields during state ingress.
- Expose only bounded controller input/member identities to result review so matching digest, byte count, and media type can prove exact imported-byte identity without trusting harness prose.

## 0.1.18 — 2026-09-25

- Bind the exact source, rights basis, visibility, and lineage parsed from `.factory-assets.json` into the controller-owned capture receipt alongside its declaration digest.
- Reject partial, forged, edited, cross-set, or unrecognized manifest-provenance receipt fields during state ingress while keeping provider-neutral non-manifest captures non-authoritative for manifest claims.
- Expose only the bounded controller-verified declaration to Work Item review, preserving generic selected-asset provenance as separately harness-declared evidence.

## 0.1.17 — 2026-09-25

- Retry classified provider-capacity failures twice for graph, Work Item result, and final Objective review while preserving the selected reviewer model, reasoning, exact prompt, and schema.
- Record each bounded provider attempt and delay independently in diagnostics without replaying workers, validation, planning, or delivery.
- Keep non-capacity failures and exhausted capacity fail-closed through the existing exact human-decision path, with method-authoritative review phases controlling retry and diagnostic attribution.

## 0.1.16 — 2026-09-25

- Align the installed setup skill with the independent runtime defaults for planner, reviewer, and worker model selections.
- Check the packaged setup guidance against the installed runtime default exports during the offline packed-artifact smoke.

## 0.1.15 — 2026-09-25

- Require every streamed provider turn to emit an explicit successful terminal event; classify premature stream exhaustion or interruption instead of treating it as completion.
- Bound planning, review, and detached worker turns with one shared 15-minute reset-on-real-event idle watchdog that does not depend on provider SDK abort cooperation.
- Close provider iterators on terminal paths with bounded cleanup while preserving the authoritative provider failure, and durably record timeout or interruption failures without result evidence.

## 0.1.14 — 2026-09-25

- Emit controller-owned capture receipts only after Factory verifies every complete candidate member beneath `.factory-media/`, and bind optional `.factory-assets.json` provenance only after a descriptor-based regular-file read matches the harness declaration exactly.
- Emit controller-owned selection receipts with fixed CLI/application invocation provenance, selected-set identity, exact destinations, actor, time, optional reason, and downstream bindings.
- Bound every authoritative receipt and selected-asset review observation to its validated schema, strip unknown persisted claims, preserve provider-neutral non-manifest harnesses and documented harness metadata, and treat absent legacy evidence as non-proof.

## 0.1.13 — 2026-09-25

- Hydrate only the selected required-LFS members from Factory's verified local content store into exact-tree validation worktrees, verify their committed pointer and restored SHA-256/size before target commands, and fail closed before command zero when local selected bytes are missing or corrupt.
- Reverify selected bytes after validation and compare the final worktree state with its controller-hydrated baseline, preserving clean-tree enforcement without globally enabling Git LFS smudging or fetching from the network.
- Strengthen the regular/native application gate so both Work Item and final Objective validation must hash the exact selected content rather than merely accept a non-empty LFS pointer.

## 0.1.12 — 2026-09-25

- Bind planning and independent graph review to a canonical installed-artifact manifest of controller-enforced media and Git LFS guarantees, rejecting edited or stale capability identities before activation.
- Let the controller migrate an explicitly captured repository asset from an ordinary Git blob to required Git LFS at the same path only when the selected, captured, and current bytes are identical; workers may not mutate final asset destinations.
- Verify post-integration fresh-clone hydration before final Objective review, persist an exact commit/tree/member receipt that the reviewer can cite and resumed state must reproduce, and bound clone/LFS failures without exposing origin URLs.

## 0.1.11 — 2026-09-25

- Default planner and reviewer execution to `gpt-5.6-sol` with medium reasoning, and Work Item execution to `gpt-5.6-luna` with medium reasoning, while preserving independent explicit overrides for every role.
- Stream provider-neutral diagnostics for compile and review model invocations, preserving explicit model policy, provider progress, supplied token/cache usage, safe request/response digests, and parse or semantic rejection reasons.
- Add `factory diagnostics --summary` with per-Objective, phase, and invocation-scope counts, explicit unavailable usage, available token totals, and cache-read numerator/denominator.
- Constrain graph-review finding sources to the exact supplied path enum so heading-qualified aliases cannot produce invalid independent-review evidence.
- Reject every malformed graph-review finding with its exact field path and bounded reason while preserving clean `{"findings":[]}` as the unambiguous no-defect result; private diagnostics never copy provider quotes or unknown source labels.

## 0.1.10 — 2026-09-24

- Ground final Objective acceptance in bounded, supervisor-generated per-Work-Item Git deltas tied to exact result and integration identities.
- Exclude nested Work Item reviewer prose from final review while preserving canonical command receipts, selected-asset facts, and exact source quotations.
- Fail closed on truncated or identity-inconsistent evidence and preserve every rejected final-review candidate with its field-level rejection reason.

## 0.1.9 — 2026-09-24

- Bind every ordered validation-command receipt to its exact result tree, stable index, and successful exit code for Work Item and final Objective review.
- Name result and integrated commit/tree identities separately in reviewer observations, and explicitly teach the reviewer that Git commits and trees are different object types.
- Move durable run state to schemaVersion 2 and reject missing, misordered, cross-tree, or command-substituted receipts before resumed state can be trusted.

## 0.1.8 — 2026-09-23

- Review the complete proposed plan, including command-authority receipts and exact final integrated-head commands, rather than only the inner Work Item graph.
- Bind the canonical plan packet, independent review result, and installation configuration to schemaVersion 2 planning candidates and exact-digest human decisions.
- Activate an unchanged accepted preview with deterministic verification and no second planning-review model call; reject stale, configuration-drifted, or review-tampered candidates before GitHub projection.

## 0.1.7 — 2026-09-23

- Persist explicit, independently selectable Codex model and reasoning choices for planning, review, and Work Item execution instead of inheriting ambient user configuration.
- Supply result review with the accepted graph's owned paths and named resources for each relevant attempt, so disjoint scheduling criteria can be proved from bounded authoritative observations.
- Add installed-package, adapter-routing, configuration-validation, and exact resource-observation regressions for the v0.1.6 public-gate failures.

## 0.1.6 — 2026-09-23

- Supply Work Item review with each relevant attempt's validated result head so a native successor can prove its exact predecessor base before the stack is integrated.
- Add bounded runner-derived delivery context: regular delivery, or native unit identity, one-based layer number/count, and immediate predecessor item.
- Add focused observation coverage and a three-layer temporary-Git regression that proves the second and third native layers without result decisions.

## 0.1.5 — 2026-09-23

- Persist the immutable worker execution base and integration head observed at attempt start; native replay advances only the mutable validation and delivery base.
- Label legacy missing start provenance explicitly in Work Item review observations instead of inferring it from later delivery state.
- Add a focused replay-versus-attempt unit regression and a staggered native temporary-Git scenario in which one concurrent root integrates before its peer is reviewed.

## 0.1.4 — 2026-09-23

- Supply Work Item result review with a bounded scheduling-provenance packet derived from the authoritative atomic snapshot and accepted graph.
- Ground exact attempt, start-time, execution-base, dependency, peer-start, and integration-state findings in `Delivery observations`, while preserving criterion-specific human fallback for missing or contradictory evidence.
- Add temporary-Git concurrent-root and negative provenance regressions, plus persisted attempt start-time validation.

## 0.1.3 — 2026-09-23

- Turn an invalid independent graph-review response into an explicit planning decision on the pinned graph, never a clean automated pass.
- Let a recorded human acceptance of that exact graph proceed without repeating the malformed review; refusal still stops activation.
- Add temporary-Git planning and application regressions for the paused and accepted paths.

## 0.1.2 — 2026-09-23

- Keep result-review findings independent per acceptance criterion, so one malformed citation cannot erase separate valid proofs.
- Accept only exact quotes from pinned source, the supplied Git change packet, exact-tree command-pass evidence, or delivery observations. Retain human fallback for missing evidence and truncated result text.
- Add temporary-Git regressions for evidence-backed automatic passes and an unsupported finding that pauses only its own criterion.

## 0.1.1 — 2026-09-23

- Allow an Objective to create a pnpm workspace and run its exactly source-declared bootstrap, check, and test commands at the validated result tree.
- Keep pre-existing scripts pinned to the Objective base, pin newly established scripts to later Work Item predecessors, and reject new lifecycle hooks or nested package-manager wrappers.
- Backfill the `v0.1.0` exact-public-artifact acceptance record and require a new installed-artifact gate before the Clockgrove pilot.

## 0.1.0 — 2026-09-23

- Compile pinned repository Objectives into reviewed Work Item DAGs with independently admitted validation commands and exact-tree acceptance decisions.
- Run local Codex SDK attempts through concurrent regular pull requests or native linear stacks, with restart, cancellation, explicit retry, and verified GitHub closure.
- Preserve human-selected media AssetSets, structured source bindings, target-owned Git LFS policy, and changed-file safety checks before publication.
- Expose private agent-readable status, diagnostics, and worker output without using logs as lifecycle authority.
- Add the public Clockgrove Git marketplace, bundled Linux x64 CLI tarball, packaged use skills, community policies, and third-party license notices.
