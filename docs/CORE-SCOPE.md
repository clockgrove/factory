# Core scope ledger

The rebuilt core keeps every capability of the old Factory. It simplifies the mechanisms, not the scope. This ledger maps each old capability to where it stands, and it is updated at every milestone. A capability is dropped, or deferred past cutover, only with the maintainer's explicit approval.

Each entry is marked **ported**, **in progress**, **slice N**, or **replaced**. The old tree is deleted only when no entry is left unported.

## Slices

1. Skeleton, queue and check (done).
2. Planning: plan, review, questions, the plan comment. Also: detecting Objective edits after planning (`changedSincePlanning`), tying answers to the question they answer, and command checks at queue time (done 2026-10-22). Two parts moved on: edits after plan acceptance go to slice 3, and binding CLI answers to their question goes to slice 5.
3. One Work Item end to end: worktree, worker, validation, review, PR, CI, merge. Also: origin-binding checks, flaky-check rerun, predecessor blame, `requiredEnvironment`, and detecting Objective edits after the plan is accepted.
4. Several Work Items at once and the delivery modes (regular PRs, native stacks, LFS assets). Cancel closes PRs and removes worktrees.
5. Operator surface:
   - queue pause, resume and drain, plus per-Objective pause;
   - `queue list`, `watch` and `status --issue`;
   - `factory run N` (queues one Objective and follows it, with the old exit codes);
   - a deadline per Objective;
   - Objective dependencies through blocked-by;
   - Work Item issues, sub-issues and Live comments;
   - stable refusal codes in JSON output;
   - binding CLI answers to the question they answer;
   - redaction and display time zone.
6. Capability ports:
   - Planning options: context lookup, recipes, discovery, expansions, conditions, splits, amendments.
   - Retained conversations: resuming a session by id across revisions.
   - Several Objectives at once (`maxActiveObjectives`) with owned-path waits.
   - Several named providers, and provider selection.
   - Learning, Dream and proposals, with their own curated store kept outside run-log rotation.
   - `propose`, the library API, and the Codex app-server transport.
   - Diagnostics, capture export, accounting, scorecard and analysis on the run log.
7. Cutover: setup in both modes, the systemd install, the readiness checklist, plugin and skills packaging, migration.

## Decisions

These are the maintainer's decisions (2026-10-22):

- **The queue.** The GitHub Project is the source of truth for the queue. Setting the Factory field to its queued option admits an Objective. Edits made after planning are detected (slice 2).
- **Answers by comment.** Answers come from `/factory <answer>` comments by users with write access, as well as from the CLI.
- **Concurrency.** Version 1 runs one Objective at a time. More than one at once arrives in slice 6.
- **One installation per repository.** Two machines serving one queue are not supported. That would need a real distributed lock, such as a database.
- **Commands authorized in answers.** An operator answer may authorize an exact validation command for an Objective. It is recorded in the plan.
- **Plan approval.** A clean, reviewed plan runs without an approval step. Factory asks only about operator-decision findings.

## Ledger

I checked the new core on 2026-10-22, after the planning milestone. Ported code is in `core/src`: cli.ts, config.ts, engine.ts, service.ts, state.ts, requests.ts, log.ts, queue.ts, github.ts, github-sync.ts, objective.ts, workflow.ts, crash.ts, `planning/*` (steps.ts, wire.ts, graph.ts, checks.ts, facts.ts, executables.ts, prompts.ts, rubric.ts, review.ts, repository.ts, types.ts) and `providers/*` (planner.ts, codex.ts, claude.ts). The workflow runs the `check` and `plan` steps. The build, final and report steps hold with "This Factory build can't run the step yet". Evidence paths point to the old tree (`src/`, `docs/`).

Status words:

- **ported**: in core/src now; the file is named.
- **in progress**: partly in core/src. The entry says what is missing and which slice carries it.
- **slice N**: the slice that should carry it (2 planning, 3 one item end to end, 4 parallel items and delivery modes, 5 holds/answers/status/report, 6 capability ports).
- **replaced**: same user guarantee, delivered another way; I say how.
- **planned**: assigned to a slice in the list above.

## Objectives and checks

- Objective = GitHub issue with Goal, Acceptance, optional Context, Sources and Constraints. Old: USER-GUIDE#Objective format. **ported** (objective.ts parseObjective).
- A Goal under the heading "Outcome" was accepted. Old: src/compiler/sources.ts:742. **ported** (objective.ts accepts Outcome as the Goal).
- A "Non-goals" heading is a known section. Old: sources.ts:742. **ported** (objective.ts treats it as a known section).
- Retired headings (Final validation, Planning sources, What must be true) are refused with a fix. Old: sources.ts:739-762. **ported** (objective.ts RETIRED).
- A malformed Sources line is refused, naming where the content goes. Old: USER-GUIDE#Objective format. **ported** (objective.ts).
- Each Source path and pinned heading must exist exactly once at base. Old: sources.ts. **ported** (facts.ts planningSources, run by the check through objectiveCommandProblems).
- An Acceptance bullet that is exactly one backticked command is a final validation command. Old: USER-GUIDE#Objective format. **ported** (facts.ts finalObjectiveCommands; steps.ts records them as the plan's finalCommands).
- Backticked commands in Objective prose are declared command authority. Old: PLANNING#Plan checks. **ported** (facts.ts authorizedCommands, used by buildFacts and the plan checks).
- The queue-add check refuses base-declared commands that have no Acceptance bullet (objective_preflight_failed). Old: PLANNING#Plan checks. **ported** (workflow.ts checkStep calls facts.ts objectiveCommandProblems).
- The check runs once at queue time, with the same checks planning uses. Old: queue add preflight. **ported** (workflow.ts checkStep and a `replan` both run steps.ts readObjective).
- A failed check holds, naming every problem; you edit the issue and answer `recheck`. Old: objective_preflight_failed. **ported** (workflow.ts).
- Optional "Quality checkpoint" section. Old: src/quality-checkpoint.ts. **in progress**: planning is ported (prompts.ts qualityCheckpointInstructions, on when the section reads `enabled`). Missing: the check doesn't refuse a malformed section; it is read as off. This is left over from slice 2, and no later slice carries it yet.
- Optional "Workspace package additions" section. Old: src/workspace-membership.ts. **in progress**: planning tells the planner the rule (prompts.ts), and wire.ts makes each `newPackages` owner own its manifest. Missing: the section is not parsed or checked, so nothing ties pnpm-workspace.yaml ownership to it. That is left over from slice 2, with no later slice yet. Enforcement in validation is **slice 3**.
- Optional "Package manager update" section, an exact pin required by validation. Old: src/package-manager-update.ts. **in progress**: planning is ported (prompts.ts packageManagerUpdate), and the check refuses a pin whose manager differs from the base pin (executables.ts). Missing: a malformed pin is read as no update instead of being refused. That is left over from slice 2, with no later slice yet. Enforcing it in validation is **slice 3**.
- Optional "Adaptive workflow" section with planningContext. Old: src/adaptive-workflow.ts. **slice 6** (Planning options seam).
- Optional "Workflow recipe" section with repository or packaged recipes. Old: USER-GUIDE#Workflow recipes, assets/recipes. **slice 6**.
- Objective source assets (user-attachment URLs, repository files, private local files) imported as worker inputs. Old: src/media.ts:139-160. **in progress**: plans may cite them, and checks.ts mediaFindings refuses unknown assets. Import is **slice 6**.
- Objective dependencies through native blocked-by: wait for predecessors' accepted evidence, and refuse if a predecessor's body changed. Old: src/objective-prerequisites.ts. **planned** (see Slices).
- Editing the Objective or its Sources after planning is detected (changedSincePlanning). Old: USER-GUIDE#Status. **in progress**: an issue edit is detected up to plan acceptance (see the Planning entry below). Missing: nothing compares the body after the plan is accepted; the build steps must, in **slice 3**. A Source file changed on the default branch is not compared either; the plan stays pinned to its base.
- The check looks up the host executables each final command needs and refuses one that is missing or the wrong version, naming the fix. Old: src/local-preflight.ts. **ported** (executables.ts observeLocalExecutables, called by workflow.ts checkStep).
- An Objective template and GitHub issue form are shipped. Old: docs/templates. **ported**: the templates are unchanged in docs/templates.
- Plans may name only base PR workflow jobs, and delivery re-checks a renamed job. Old: src/check-names.ts. **in progress**: planning is ported (facts.ts workflowCheckNames, unknownCheckNames). The delivery re-check is **slice 4**.

## Queue and control

- Background queue on a GitHub Project, read every queue.pollSeconds (30 s). Old: USER-GUIDE#Queue and background. **ported** (queue.ts, github-sync.ts).
- `queue add` as explicit consent, with approval bound to the exact issue body; labels and cards never admit work. Old: USER-GUIDE#Queue. **replaced**: the operator sets the Project Status option to "queued". Consent is now "whoever can edit the Project" and is not tied to the body. See Contradictions.
- `queue list` shows unqueued candidates and inert cards. Old: cli.ts queueCommand. **planned** (see Slices): core status lists only Objectives that have state.
- `queue remove` withdraws an Objective and archives its card. Old: queueCommand. **replaced**: move Status out of "queued" before the Objective starts. After it starts, use cancel.
- `queue sync`. Old: queueCommand. **replaced**: the 30 s poll.
- Ordered queue. Old: order NUMBER field. **ported** (queue.ts queued: order field, then issue number).
- `queue pause|resume|drain`, a queue-wide hold. Old: control card. **planned** (see Slices): CORE.md removes the control card and names no replacement.
- Per-Objective `pause|drain|resume`, surviving restarts. Old: USER-GUIDE#Run. **planned** (see Slices).
- `cancel` from every non-terminal state, under changed config, with no provider call. Old: LIFECYCLE#Invariants. **ported** (engine.ts, service.ts: a cancel request is applied even under a hold).
- Cancel closes open Factory PRs and removes worktrees. Old: LIFECYCLE#Cancel exits. **slice 4** (workflow.ts cleanup is a stub).
- `cancel --provider NAME` for a stranded Objective. Old: LIFECYCLE#Cancel exits. **replaced**: cancel doesn't need a provider.
- `factory run --objective N` foreground run with exit codes 0, 2 and 1. Old: USER-GUIDE#Run. **planned** (see Slices): CORE.md says "No foreground runs", and `run` is only the dev service. See Contradictions.
- Several Objectives run in parallel from separate terminals; a second live run of the same Objective is refused. Old: USER-GUIDE#Run. **replaced** by the single `serve` with a lock (lock.ts). Parallel Objectives are **planned** (see Slices), because v1 runs one at a time.
- queue.maxActiveObjectives 1-8, with waits on overlapping owned paths and shared host limits. Old: USER-GUIDE#Several Objectives. **planned** (see Slices): service.ts has maxActive=1, and CORE.md says "later" with no slice.
- An absolute deadline (`--deadline`, queue.objectiveDeadlineSeconds) that restarts can't extend. Old: USER-GUIDE#Run. **planned** (see Slices).
- A Project queue requires a current admission before a foreground run. Old: USER-GUIDE#Queue. **replaced**: there are no foreground runs.
- Two hosts never consume the same admission. Old: USER-GUIDE#Queue. **planned** (see Slices): there is only a per-host flock, and nothing stops two installations on one Project. CORE.md assumes one installation.
- One control plane: the service applies CLI commands. Old: LIFECYCLE#Matrix. **ported** (requests.ts, service.ts).
- Stable lifecycle refusal codes as JSON on stderr. Old: LIFECYCLE#Refusal codes. **planned** (see Slices): core prints prose. answer/cancel/retry return 0 or 1 plus a message.
- Upgrade by handoff (drain, safe-point handoff). Old: USER-GUIDE#Upgrade by handoff. **replaced**: stop, install, start. Crash-only restart continues from the last step.
- Settle deadline: end steps are bounded. Old: LIFECYCLE#Settle deadline. **replaced** by per-step deadlines (engine.ts Step.deadlineMs).
- Unknown or misplaced flags are refused with a fix hint. Old: src/cli-flags.ts assertKnownFlags. **planned** (see Slices): core cli.ts parse ignores unknown flags.
- `factory help` lists every command and option. Old: cli.ts help. **ported** for the 4 core commands (cli.ts USAGE). The rest is **slice 6**, as commands are ported.
- `--config PATH` on every command, with XDG config and state roots. Old: cli.ts. **replaced**: FACTORY_CONFIG and `--repo`. Config lives in ~/.config/factory (config.ts), not XDG_CONFIG_HOME/clockgrove-factory. Paths are in paths.ts.

## Planning

- Plan from a pinned base (default-branch head at the first plan), ignoring uncommitted edits. Old: USER-GUIDE#Prerequisites. **ported** (workflow.ts defaultHead, saved in the check result).
- The planner compiles a Work Item graph (goal, contract, acceptance, owned paths, deps, validation, design note) from a read-only export at base. Old: PLANNING#A Work Item. **ported** (steps.ts planRoundStep, wire.ts, graph.ts, repository.ts exportTree).
- Coverage: each acceptance criterion and source exit item has exactly one owner; exclusions need reasons. Old: ARCHITECTURE:111. **ported** (graph.ts checkCoverageShape and checkCoverageSources, run by checks.ts checkPlan).
- Deterministic plan lint before paid review, returned as one correction. Old: PLANNING#Lint before review. **ported** (checks.ts checkPlan runs in the plan round; steps.ts sends only a clean draft to review).
- Independent graph review; fix findings auto-revise within planningRevisions. Old: PLANNING#How review holds. **ported** (steps.ts reviewStep and decideStep, review.ts, config.ts planning.revisions). The default is now 4 rounds; the old planningRevisions default was 1.
- Operator-decision findings and planner questions (decisionRequired) stop for the operator, and the answer revises the draft. Old: USER-GUIDE#Decisions. **ported** (steps.ts decideStep and questionFor: `answer <text>` goes back to the planner as an operator correction, then the draft is revised and reviewed again).
- Granting 2 more revisions when revisions run out. Old: USER-GUIDE#Decisions. **ported** (the `more` answer, steps.ts questionFor and granted).
- `decide --outcome refuse` discards the plan. Old: USER-GUIDE#Decisions. **replaced**: `replan` discards the draft and plans again from the re-read issue, and `cancel` ends the Objective (steps.ts). There is no separate refuse answer.
- The planner and reviewer are told worker capability, authorized commands, CI-only commands and the validation environment. Old: PLANNING#Plan checks. **ported** (prompts.ts with rubric.ts workerCapability, facts.ts commandInstructions and VALIDATION_ENVIRONMENT). Workers are fixed as a sandboxed shell (steps.ts WORKERS) until slice 3.
- Target design checklist (AGENTS.md) and doc map honored by briefs, workers and review; DESIGN_CHECKLIST and ENGINEERING_STANDARD. Old: PLANNING#Design checklist. **in progress**: planning is ported (rubric.ts design note, prompts.ts doc map, facts.ts pins AGENTS.md and README.md). The worker and review side is **slice 3**.
- Child Objective split (sub-issues, factory:objective, blocked-by), with the parent closing when all children are accepted. Old: USER-GUIDE#Child Objectives. **in progress**: planning is ported (wire.ts split, checks.ts splitFindings; the plan comment lists the children). Creating issues, queueing children and closing the parent is **slice 6** (splits are in the Planning options seam).
- Scheduling hints (estimatedDurationMs) and critical-path ordering. Old: USER-GUIDE scheduling paragraph. **in progress**: planning is ported (graph.ts checks the hints, orderItems orders by critical path). Scheduling use is **slice 4**.
- No plan-only command: a clean plan runs with no extra approval. Old: USER-GUIDE#Run. **ported** (steps.ts decideStep accepts a clean, reviewed plan without asking; `approve` is offered only for the reviewer's operator-decision findings).
- Playbook advice in planning. Old: USER-GUIDE#Learning. **ported** (steps.ts reads planning.playbook at base; prompts.ts playbookAdvice).
- The accepted plan is posted on the Objective as one comment with a marker, edited in place and never duplicated. (new) **ported** (steps.ts postPlan, findComment).
- `allow <exact command>` answers a planner question by authorizing an exact validation command. It is recorded in the plan's decisions and used by later rounds. Old: Decisions above, Commands authorized in answers. **ported** (steps.ts allowedCommands; facts.ts authorizedCommands takes it, except a CI-only command).
- Each planning answer is recorded with the question it answered, who answered and when, and the plan comment lists them. (new) **ported** (steps.ts decideStep record, acceptStep).
- Before a plan is accepted, Factory re-reads the issue. If it was edited since planning read it, Factory holds with `replan`, `continue` and `cancel`. (new) **ported** (steps.ts objectiveChanged and changedHold).
- `replan` re-reads the issue and the default branch, reruns the check's checks, and starts a new plan. (new) **ported** (steps.ts readObjective).
- A revision answers with only its changes to the current plan, and the re-review is scoped to what changed. (new) **ported** (wire.ts applyRevision, prompts.ts revisionScope).
- A round that returns the same findings as the last one asks the operator instead of spending more rounds. (new) **ported** (steps.ts sameFindings).
- An invalid planner answer gets one retry that shows the planner the error; repeated failures hold. Old: AGENTS.md#Model contracts. **ported** (steps.ts INVALID_ANSWER, invalidAnswer).
- Each planning step saves its result, so a restart repeats at most the step that was running. (new) **ported** (steps.ts keys plan:g:n, review:g:n, decide:g:n and plan). The milestone drill passed 8 of 8 crash points.

## Planning options

- Execution profiles: the planner assigns a harness per Work Item. Old: USER-GUIDE#Execution profiles. **slice 6**: wire.ts accepts a profile list, but steps.ts passes none, so the planner can't choose one yet. Profiles arrive with several providers in slice 6; running a profile is **slice 3**.
- Read-only QA Work Items (declared commands and named CI checks); Objectives made only of QA qualify existing bytes. Old: src/qa.ts. **in progress**: planning is ported (the wire offers the qa kind; rubric.ts QA_EVIDENCE_GUIDANCE). Execution is **slice 6**.
- Discovery Work Items and reviewed expansion envelopes. Old: src/graph-expansion.ts. **slice 6**: types.ts and graph.ts know the shapes, but the wire schema doesn't offer discovery items or expansions, so the planner can't produce them.
- Declared work conditions and aggregate nodes. Old: execution-profiles.ts:170. **in progress**: aggregate nodes are planned (wire.ts, graph.ts aggregateAcceptance). Conditions are in types.ts only; the wire doesn't offer them, so they are **slice 6**. Running aggregates is **slice 4**.
- Graph amendments: worker `.factory-discovery.json`, operator `propose-amendment` with independent review, and replacement amendments. Old: USER-GUIDE#Decisions. **slice 6** (Planning options: amendments).
- `decline-discovery` for an obsolete worker discovery. Old: USER-GUIDE#Decisions. **slice 6**.
- planningContext bounds and repository memory (SQLite/FTS). Old: src/repository-memory.ts. **slice 6** (Knowledge).
- `recipe --file` preview with no model call. Old: src/workflow-recipes-cli.ts. **slice 6**.

## Execution and providers

- Codex planning and review (codex-sdk), with gpt-6.1-sol defaults at high/medium/medium. Old: USER-GUIDE#Models. **ported** (providers/codex.ts CodexPlanner; DEFAULT_CODEX_MODELS is gpt-6.1-sol, planner high, reviewer medium).
- Claude planning and review (claude-agent-sdk), with explicit models, maxOutputTokens, and login/OAuth/API key. Old: USER-GUIDE#Local providers. **ported** (providers/claude.ts ClaudePlanner: models from planning.models, maxOutputTokens, login, OAuth token or API key, and LoadCredential values).
- Per-role reasoning effort, per-phase reviewEffort, and Codex serviceTier. Old: USER-GUIDE#Models. **ported** (planner.ts ModelChoice and modelChoice with reviewEffort per phase; codex.ts serviceTier). planning.models goes to the adapter as given; config.ts doesn't validate it at load.
- Codex app-server planning transport (experimental). Old: USER-GUIDE#Retained conversations. **planned** (see Slices): not in CORE.md.
- Provider timeouts and idle bounds, retried within bounds. Old: USER-GUIDE#Models. **replaced**: 45 min step deadlines (steps.ts), an idle watchdog per call (planner.ts IdleWatchdog; 15 min for Codex planning), retry, then hold after 3.
- Codex worker harness with a sandboxed shell and network host|off. Old: config.ts:129-160. **slice 3** (Worker seam).
- Claude worker harness: maxTurns 400 with 2 automatic continuations; tools, permissions, setting sources; Validate, run_command, copy_file and delete_file. Old: USER-GUIDE#Local providers. **slice 6** (Worker seam), unless slice 3 picks Claude.
- FACTORY_CLAUDE_1M opt-in. Old: USER-GUIDE#Local providers. **slice 6**.
- GitHub Copilot worker harness. Old: config.ts:98-105. **slice 6**.
- Managed execution (openai-agents, claude-managed-agents) with budgetCents and orphan reporting. Old: USER-GUIDE#Managed execution. **slice 6**.
- Custom registered adapters through the library API (AgentHarness, composeWithLocalHarness/Profiles). Old: src/index.ts. **planned** (see Slices): CORE.md has no public library API.
- Multiple named providers, defaultProvider, and `setup --provider NAME`. Old: USER-GUIDE#Providers. **planned** (see Slices): core config.ts has one planning.provider, codex or claude.
- Provider selection: a started Objective keeps its frozen provider; `--provider` applies to new work; status shows selectedBy. Old: USER-GUIDE#Providers. **planned** (see Slices): planning.provider is read from config at service start, so a config change also applies to a running Objective.
- Frozen config digest per Objective, and status explains restore or end. Old: config.ts:1334-1470. **planned** (see Slices): CORE.md is silent. Config edits mid-run would change behaviour silently.
- Never fall back to another provider; a missing login stops and names the fix. Old: USER-GUIDE#Local providers. **in progress**: planning is ported (cli.ts builds only the configured planning.provider; a login fault holds and names the fix in codex.ts and claude.ts). The worker side is **slice 3**.
- Retained conversations (planner across compile, correction and diagnosis; worker and reviewer continuations). Old: USER-GUIDE#Retained conversations. **planned** (see Slices): CORE.md says a model call "runs again", and keeps only the worktree.
- Concurrent Work Items in isolated worktrees, with owned-path enforcement. Old: README; ARCHITECTURE:209. **slice 4**. Ownership enforcement on one item is **slice 3**.
- Host-sized concurrency, capacityRecommendation, and scheduling reservations. Old: config.ts:222-270. **planned** (see Slices): CORE.md fixes "up to 2 Work Items at once".
- Ordered setup and probe commands from Sources, run in each fresh checkout. Old: USER-GUIDE#Run. **slice 3**.
- Worker brief with pinned sources (.factory-inputs), handoff notes (.factory-handoff.json) and verification notes. Old: USER-GUIDE#Retained conversations. **slice 3**. Sharing notes with peers is **slice 4**.
- The controller owns commits, under the Factory identity; workers get read-only Git. Old: execution/local.ts:1367. **slice 3**.
- Worker isolation: private HOME and CODEX_HOME, personal configs and MCP disabled, env filtered of GitHub/Git/SSH credentials. Old: USER-GUIDE#Safety. **slice 3** (CORE.md#Security "carries over").
- Provider usage-limit wait until reset, shown in status; retry ends it early. Old: USER-GUIDE#Decisions. **in progress**: ported for planning (codex.ts and claude.ts usage-limit waits, steps.ts guarded retries them without counting an error; engine.ts afterMs; cli retry). The worker signal is **slice 3**.
- Prompt and workspace instructions per profile, and the Claude worktree-read MCP. Old: USER-GUIDE#Execution profiles. **slice 6**.

## Validation and review

- Validate the exact candidate tree in a fresh checkout: declared commands only, offline, FACTORY_BASE_SHA, private TMPDIR. Old: USER-GUIDE#Objective format. **slice 3**.
- Supported dependency bootstrap (npm ci / pnpm frozen with --ignore-scripts) run first; pinned package scripts. Old: USER-GUIDE#Run. **in progress**: planning is ported (facts.ts packageBootstrap, PACKAGE_SCRIPT_FORMS). Running it is **slice 3**.
- finalValidation.requiredCommands. Old: USER-GUIDE#Run. **in progress**: the check refuses one with no authority at base (facts.ts objectiveCommandProblems), and the plan records it in finalCommands. Running it is **slice 3**.
- finalValidation.ciOnlyCommands, never run locally and refused in Objectives. Old: VALIDATION-ENVIRONMENT.md. **ported** (the check refuses them in Acceptance; facts.ts leaves them out of authorized commands and `allow`; checks.ts ci-only refuses them in a plan).
- Flaky check: one fresh rerun when worker Validate passed, then flakyRerun shown in status and the PR. Old: delivery/description.ts:95. **planned** (see Slices): CORE.md says a validation failure means repair.
- Final validation of the integrated tree, re-run when other Objectives merged first. Old: USER-GUIDE#Run. **slice 3** (the final step).
- Independent result review per Work Item against criteria, contract, design checklist and engineering standard, with base/ and changes/ roots. Old: PLANNING#Engineering standard. **slice 3** (Reviewer seam).
- Final Objective review of the integrated tree: every criterion, coverage obligation and integration edge. Old: ARCHITECTURE:125. **slice 3**.
- reviewArtifacts selectors (stdout, stderr, files, located files). Old: src/review-artifacts.ts. **slice 6**.
- Image review evidence (receipt and PNG bound to the candidate), with reuse in final review. Old: USER-GUIDE#Images. **slice 6**.
- Review evidence budget env vars. Old: USER-GUIDE:690. **slice 3**.
- `retry --rereview [--review-artifacts]` within resultRereviews. Old: USER-GUIDE#Decisions. **slice 5** (hold answer).
- `retry --retire-command CMD --reason`. Old: USER-GUIDE#Decisions. **slice 5** (hold answer).
- `decide --item --criterion` for human acceptance of a criterion, or final acceptance. Old: USER-GUIDE#Decisions. **slice 5** (hold answer).

## Delivery

- Regular mode: one PR per Work Item, a branch push, and merge commit only, under branch protection. Old: delivery/regular.ts, github.ts:2940. **slice 3** (CORE.md: branch `factory/<issue>/<item>`).
- Native-stack mode (linear stacked PRs). Old: delivery/native-stack.ts. **slice 4**.
- PR body: Work Item goal, links, changed files, candidate commit and tree, passing commands, no model call. Old: delivery/description.ts. **slice 3**.
- No duplicate PR after a lost response. Old: USER-GUIDE#Models. **replaced**: CORE.md#Idempotence finds the PR by its fixed head branch. **slice 3**.
- Wait for required checks (rulesets and classic protection); failed CI becomes repair with log excerpts. Old: github.ts:2301-2425. **slice 3** (CORE.md: CI wait 60 min, then repair).
- Update the PR branch when behind base. Old: github.ts:2852. **slice 3**.
- Closed, draft or stuck PRs become decisions. Old: delivery/readiness.ts. **slice 5**.
- Never bypass branch protection; recommend "require branches up to date". Old: USER-GUIDE#Decisions. **slice 3**.
- Media AssetSets: `select --output DIR`, `select --set --bind`. Old: USER-GUIDE#Decisions (media). **slice 6** (Delivery: LFS assets).
- Git LFS upload on delivery, and LFS hydration for validation. Old: src/media.ts:56-100. **slice 6**.

## GitHub tracking

- One GitHub issue per Work Item (Task type, factory:work-item label, sub-issue, blocked-by edges, body sections, hidden marker). Old: USER-GUIDE#Run; github.ts:1354. **gap/contradiction**: CORE.md defines a Work Item as "one PR" and posts the plan as a comment.
- Live status comment per Objective, edited in place. Old: USER-GUIDE#GitHub progress. **slice 5** (CORE.md comment markers edit in place).
- Live status comment per Work Item issue. Old: same. **planned** (see Slices), because Work Item issues aren't planned.
- New notification comments only for decisions, failures and outcomes; progress.enabled and includeQuestions. Old: USER-GUIDE#GitHub progress. Hold comments **ported** (github-sync.ts ask). The rest is **slice 5**. The on/off config is **planned** (see Slices).
- Project Status sync per phase. Old: src/github-project-state.ts. **ported** for Objectives (queue.ts QueueDisplay, config.ts options). For Work Item cards it is **planned** (see Slices).
- Explicit projectStatus field binding, or disabled. Old: config.ts:1303. **replaced** by queue.field and queue.options in config.ts. "Disabled" isn't possible, because Status drives the queue.
- Factory reads no human comment as input. Old: USER-GUIDE#GitHub progress. **replaced and reversed**: `/factory <answer>` comments from users with write access (github-sync.ts). See Contradictions.
- Close the Work Item issue on merge and the Objective on sealed acceptance; cancel closes as not_planned; duplicates are closed. Old: github.ts:918-1015, completion.ts. Objective close is **slice 3** (report). Work Item issue closing is **planned** (see Slices).
- Create the role labels and the native issue types (Feature, Task); priority inheritance. Old: github.ts:1242. **planned** (see Slices).
- Display times in the host zone, with FACTORY_DISPLAY_TIMEZONE. Old: USER-GUIDE#GitHub progress. **planned** (see Slices): core prints ISO times.
- A reminder comment after a hold is open 24 h (new). **slice 5**.

## Holds and decisions

- Every stop is a question with named answers, and each answer works. Old: `decide`. **ported** (engine.ts, state.ts Hold).
- Answer from the CLI: `factory answer ISSUE ANSWER [--text]`. Old: `decide --outcome --reason --answer`. **replaced** by cli.ts answer.
- Stale-answer protection: refuse an answer when a different question is open (question digest). Old: USER-GUIDE#Decisions. **in progress**: a `/factory` comment carries its written time, and engine.ts refuses one written more than 60 s before the open question was asked (github-sync.ts, requests.ts writtenAt). Missing: a CLI answer carries no question binding, so a delayed `factory answer` or `retry` can still answer a newer hold. That is **slice 5**.
- The director skill asks holds with AskUserQuestion, recommended answer first. Old: skills/director. **slice 5** (CORE.md#Holds; the skill is not rewritten yet).
- Autonomy allowances (planningRevisions 1, implementationRepairs 6, resultRereviews 1), perPath caps, repairClasses; snapshotted, and running out stops for a decision. Old: src/repair-policy.ts. planningRevisions is **ported** as planning.revisions (config.ts, steps.ts). The repair budget is **slice 3** (CORE.md `repairs`). perPath, repairClasses and snapshotting are **planned** (see Slices).
- autonomy.requiredEnvironment secrets checked before planning. Old: USER-GUIDE#Autonomy limits. **planned** (see Slices).
- policy.allowedSecretNames passed by name and redacted from output. Old: config.ts:342. **slice 3** (CORE.md "Secrets are named by reference"). Redaction in status and diagnostics is **planned** (see Slices).
- Predecessor blame: a failure in a merged predecessor's file stops with a decision and spends no repair. Old: USER-GUIDE#Decisions. **planned** (see Slices).
- `fail` holds with retry, replan and cancel (new). **slice 5**.

## Recovery and restart

- Crash or restart reconciles issues, PRs and merges by stable identity, with no duplicate effects. Old: USER-GUIDE#Stopping and recovery. **replaced**: crash-only steps plus GitHub lookup (CORE.md#Idempotence). The engine side is **ported** (engine.ts, state.ts atomic save, crash.ts). The effect side is **slice 3**.
- Reattach running workers; `collect` freezes a return that finished while the controller was down. Old: USER-GUIDE#Stopping and recovery. **replaced**: workers die with the service, and the work step reruns on its kept worktree. The `collect` command goes.
- Abandoned in-flight model calls start fresh. Old: same. **ported** (engine.ts: an interrupted step counts as an error and reruns).
- Automatic repair: review findings become a correction; failed commands go to diagnosis (repair, question, or blame). Old: USER-GUIDE#Decisions. **slice 3** (repair outcome). The diagnosis planner call is **slice 3**. Blame is **planned** (see Slices) (see above).
- A repair continues from the refused result, three-way rebased onto a moved base; `--fresh` starts from base. Old: USER-GUIDE:723. **slice 3** (CORE.md: the worktree is kept). `--fresh` is **slice 5**.
- `repair --proposal FILE` for an operator-diagnosed correction. Old: USER-GUIDE#Decisions. **slice 5** (a hold answer with text) or **planned** (see Slices): CORE.md has no file input.
- Usage-limit and transient errors retry with backoff. Old: USER-GUIDE#Decisions. **ported** (engine.ts DEFAULT_LIMITS).
- Git checkpoints to a private archive (gitPersistence), with `persistence status|sync|inspect|maintain`. Old: USER-GUIDE#Git checkpoints. **replaced**: state is rebuilt from GitHub (`factory reset`, **slice 5**, not in cli.ts). Learning and receipt archiving is **planned** (see Slices).
- Restore on another machine (`persistence restore`, `reconcile`). Old: USER-GUIDE#Restore. **replaced** by `factory reset --objective N`, which is not built yet.
- An archive bound being exceeded stops with exit 2. Old: USER-GUIDE#Git checkpoints. **replaced**: there is no archive. Log retention is 20 runs and 2 GB (log.ts rotateLogs).
- Retention of finished Objectives, with worktrees and logs reclaimed. Old: USER-GUIDE#Retention. **ported** for logs (log.ts). Worktree reclaim is **slice 3**.
- An incompatible state version is refused with guidance. Old: USER-GUIDE#Queue. **ported** (state.ts STATE_VERSION, an unreadable state holds with cancel). The CORE.md `reset` answer is not offered yet (cli.ts offers cancel only).

## Learning and knowledge

- `dream --record`, preview, approve or reject by digest, `--show`; the playbook is pinned per Objective. Old: src/learning.ts. **slice 6** (Knowledge). Playbook input to planning is **ported** (steps.ts readPlaybook).
- `propose --source DOC#HEADING` drafts Objectives; `--approve SHA [--enqueue]` publishes issues, dependencies and cards. Old: src/proposals.ts. **planned** (see Slices): not in the CORE.md seams.
- Repository memory for adaptive planning. Old: src/repository-memory.ts. **slice 6**.

## Telemetry and diagnostics

- `status` without an Objective shows service, queue, active Objectives and holds. Old: cli.ts serviceStatus. **ported** (cli.ts status: service running or stopped, holds, waits).
- `status --objective N [--json]`: headline phase, the exact Next command, a Work Item table, the provider line, plan, graph, allowances and repairs. Old: USER-GUIDE#Status. **ported** partly (cli.ts status ISSUE). The rest is **slice 5**.
- `status --issue N|URL` resolves a Work Item issue. Old: cli.ts statusForIssue. **planned** (see Slices).
- Status names a command only while Factory would accept it; prerequisiteGuidance. Old: USER-GUIDE#Status. **ported** for holds. prerequisiteGuidance is **planned** (see Slices).
- `watch` live view (liveness, turns, context, compactions, no-progress, last 8 tool calls). Old: cli.ts watchObjective. **planned** (see Slices): CORE.md names `log`, not watch.
- `diagnostics` timeline, `--follow`, `--logs ITEM`, `--summary`. Old: src/diagnostics-cli.ts. **slice 6** (Observers). The run log is **ported** (log.ts).
- Content capture (prompts and responses, 0600, byte cap, retainInRecovery). Old: USER-GUIDE#Diagnostic capture. **slice 6**. CORE.md puts bodies in the run log directory.
- Token and cache accounting per role and phase; native Codex telemetry. Old: same. **slice 6**.
- `diagnostics --captures`, `--analyze`, `--gantt`. Old: src/analysis-cli.ts. **slice 6**.
- `diagnostics --scorecard`, including the codex-direct comparison. Old: diagnostics-cli.ts. **slice 6**.
- `export-captures` OTLP preview then authorized send. Old: src/capture-export-cli.ts. **slice 6**.
- Library analysis API (readInteractionMetadata etc.). Old: src/index.ts. **planned** (see Slices).
- Diagnostics older than the 20-run retention window. Old: the archive kept them. **planned** (see Slices): they are lost.

## Setup and service

- Plugin for Codex and Claude Code (setup and director skills), plus an attested CLI tarball. Old: README#Install. **planned** (see Slices): CORE.md and the slices are silent. The old plugin still points at old commands.
- `setup --config-only` writes and verifies config with JSON status; idempotent; refuses a conflicting option. Old: src/setup.ts. **planned** (see Slices): core has no setup. CORE.md#Migration assumes "run setup".
- `setup --background` checks readiness, then installs and starts the systemd user service. Old: setup.ts:210-488. **planned** (see Slices).
- A blocked setup gives one prerequisite checklist. Old: src/prerequisite-guidance.ts. **planned** (see Slices).
- Setup options for delivery, network, planning transport, models, Claude and Copilot tools, outside-directory and credential-file. Old: src/cli-flags.ts. **planned** (see Slices).
- Service credentials through systemd LoadCredential. Old: supervision.ts:65. **planned** (see Slices).
- `supervisor start|check|stop|upgrade|uninstall` with a rollback hint. Old: src/supervision.ts. **replaced in part**: systemd runs `factory serve`. No install or uninstall command exists, so this is **planned** (see Slices) as a command.
- An idle service makes no model calls. Old: USER-GUIDE#Queue. **ported** (service.ts: only the check step runs).
- A held or failed Objective holds only itself. Old: USER-GUIDE#Several Objectives. **ported** (engine.ts, CORE.md rule 1). With one active Objective, though, a hold blocks the queue unless the service skips held Objectives. Verify service.ts slot counting.
- Installation-wide holds for auth (401/403) and disk faults, lifted by queue resume. Old: USER-GUIDE#Several Objectives. **replaced**: GitHub errors retry forever (github.ts TransientError). Disk faults are **planned** (see Slices).
- The first run checks host and worker readiness without model calls. Old: src/readiness.ts. **planned** (see Slices).
- Validation environment report, and a warning for network tools in scripts. Old: VALIDATION-ENVIRONMENT.md. **in progress**: planning is ported (facts.ts networkToolOfCommand keeps network scripts out of authorized commands; checks.ts network). The setup report is **planned** (see Slices).

## Safety

- Refuse Factory's own repositories, local-path origins, and mismatched fetch and push URLs; re-verify before every fetch and push. Old: src/origin-binding.ts. **planned** (see Slices): core config.ts checks only that the repository name matches.
- Config and state live outside the target checkout. Old: USER-GUIDE#Set up. **ported** in effect (paths.ts, under home). The refusal of an in-checkout config is **planned** (see Slices).
- bubblewrap sandbox for every worker-caused command; refuse without bwrap; refuse as root. Old: USER-GUIDE#Command sandbox. **slice 3** (CORE.md#Security).
- Sandbox setup failures are config faults, not the candidate's failure. Old: same. **slice 3**.
- sandbox.network package-install (registry-only through pasta) and packageStore. Old: execution/package-network.ts. **slice 3**.
- sandbox.readOnlyPaths, and sandbox.environment with a deny-list. Old: same. **slice 3**.
- Sandbox limits (tmpMiB, homeMiB, checkoutMiB, files, candidate size, processes). Old: execution/sandbox.ts. **slice 3**.
- Refuse gitlinks and submodules. Old: src/ownership.ts. **slice 3**.
- Pre-publish scan: changed-path ownership, unsafe links and special files, Secretlint by rule and path. Old: execution/secret-scan.ts. **slice 3**.
- Fixed acceptance scripts and package-manager metadata protected unless authorized. Old: ARCHITECTURE:115. **in progress**: planning is ported (facts.ts fixedScripts in the planner facts). Enforcement is **slice 3**.
- Controller PATH guidance: refuse protected PATH dirs and exclude its own bin. Old: README#Controller PATH. **planned** (see Slices).
- Credentials stay with the service; workers never see them. Old: USER-GUIDE#Safety. **ported** for GitHub (github.ts: the token comes from gh and stays in the service). Workers are **slice 3**.
- Only users with write access can answer through comments (new). **ported** (github-sync.ts canWrite).

## Milestone log

- **2026-10-22, Planning (slice 2).** Planning and the planner and reviewer providers are ported and wired into the workflow. A drill accepted a plan end to end, answered a planner question by a `/factory answer` comment, then revised and accepted the plan, and passed 8 of 8 crash points. Ledger counts after this update: 48 ported, 16 replaced, 30 in progress, 103 planned, and 1 gap (198 lines). A line counts as ported or replaced only when nothing in it is left for later. A line that is partly ported counts as in progress. A line with only a slice or planned mark counts as planned. Planning capabilities still not ported:
  - Edits to the Objective after the plan is accepted: slice 3.
  - Binding CLI answers to the question they answer: slice 5.
  - Refusing a malformed Quality checkpoint or Package manager update section, and parsing Workspace package additions: slice 3 (checked when validation is ported).
  - Validation side of planned facts (required commands, bootstrap, package manager pin, workspace additions, fixed scripts): slice 3.
  - `requiredEnvironment` checked before planning: slice 3.
  - Design checklist in workers and review, and the worker side of provider login holds and usage-limit waits: slice 3.
  - Running aggregates, scheduling use of hints, and the delivery re-check of CI check names: slice 4.
  - Objective dependencies through blocked-by: slice 5.
  - Execution profiles, discovery items, expansions, conditions, amendments, `decline-discovery`, recipes, adaptive planning context, repository memory, child Objective issues, QA execution and source asset import: slice 6.
  - Several named providers, provider selection, retained conversations and the Codex app-server transport: slice 6.
  - A frozen config per Objective: slice 5.
