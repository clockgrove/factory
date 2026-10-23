# Core scope ledger

The rebuilt core keeps every capability of the old Factory. It simplifies the mechanisms, not the scope. This ledger maps each old capability to where it stands, and it is updated at every milestone. A capability is dropped, or deferred past cutover, only with the maintainer's explicit approval.

Each entry is marked **ported**, **in progress**, **slice N**, or **replaced**. The old tree is deleted only when no entry is left unported.

## Slices

1. Skeleton, queue and check (done).
2. Planning: plan, review, questions, the plan comment. Also: detecting Objective edits after planning (`changedSincePlanning`), tying answers to the question they answer, and command checks at queue time (done 2026-10-22). Two parts moved on: edits after plan acceptance go to slice 3, and binding CLI answers to their question goes to slice 5.
3. One Work Item end to end: worktree, worker, validation, review, PR, CI, merge, final validation, final review and report. Also: origin-binding checks, flaky-check rerun, and detecting Objective edits after the plan is accepted (done 2026-10-22). Several Work Items at once and cancel cleanup came in from slice 4. Several Objectives at once (`maxActiveObjectives`, owned-path waits, host-wide limits) came in from slice 6. Moved on: predecessor blame and `requiredEnvironment` go to slice 5; refusing Factory's own repositories and checking origin before a fetch go to slice 7; worker settings in config go to slice 7; running execution profiles goes to slice 6.
4. Delivery modes: native stacks and LFS assets. Also: scheduling by the plan's hints, and sharing worker notes with peers (done 2026-10-22). Came in from slice 6: Media AssetSets (capture, selection, binding), LFS upload and hydration, Objective source asset import, review artifacts and image review evidence.
5. Operator surface:
   - queue pause, resume and drain, plus per-Objective pause;
   - `queue list`, `watch` and `status --issue`;
   - `factory run N` (queues one Objective and follows it, with the old exit codes);
   - a deadline per Objective;
   - Objective dependencies through blocked-by;
   - Work Item issues, sub-issues and Live comments;
   - stable refusal codes in JSON output;
   - binding CLI answers to the question they answer;
   - redaction and display time zone;
   - predecessor blame and `requiredEnvironment`;

   Done early, in the lean sweep after slice 3: the check refuses a malformed Quality checkpoint, Package manager update or Workspace package additions section.

6. Capability ports:
   - Planning options: context lookup, recipes, discovery, expansions, conditions, splits, amendments.
   - Retained conversations: resuming a session by id across revisions.
   - Objective knowledge in review: peers' handoff notes in result review, and every item's notes in final review (found missing at the slice 4 milestone).
   - Several named providers, and provider selection (done 2026-10-22, with the Copilot planner and worker and managed execution; managed execution is not live-qualified).
   - Learning, Dream and proposals, with their own curated store kept outside run-log rotation.
   - `propose`, the library API, and the Codex app-server transport.
   - Diagnostics, capture export, accounting, scorecard and analysis on the run log.
7. Cutover: setup in both modes, the systemd install, the readiness checklist, plugin and skills packaging, migration. Also: setup flags for the worker settings (the settings themselves are in config since the lean sweep after slice 3), refusing Factory's own repositories, and the branch-protection recommendation.

## Decisions

These are the maintainer's decisions (2026-10-22):

- **The queue.** The GitHub Project is the source of truth for the queue. Setting the Factory field to its queued option admits an Objective. Edits made after planning are detected (slice 2).
- **Answers by comment.** Answers come from `/factory <answer>` comments by users with write access, as well as from the CLI.
- **Concurrency.** Push concurrency to use the local machine (maintainer, 2026-10-22). Up to 3 Objectives run at once by default with owned-path waits, 8 Work Items per Objective, and host caps sized from the CPU count. This supersedes the earlier one-at-a-time v1 decision.
- **One installation per repository.** Two machines serving one queue are not supported. That would need a real distributed lock, such as a database.
- **Commands authorized in answers.** An operator answer may authorize an exact validation command for an Objective. It is recorded in the plan.
- **Plan approval.** A clean, reviewed plan runs without an approval step. Factory asks only about operator-decision findings.

## Ledger

I checked the new core on 2026-10-22, after the slice 4 milestone. Ported code is in `core/src`: cli.ts, config.ts, engine.ts, service.ts, state.ts, requests.ts, log.ts, queue.ts, github.ts, github-sync.ts, objective.ts, workflow.ts, crash.ts, git.ts, sandbox.ts, package-network.ts, worktree.ts, paths.ts, validate.ts, repair.ts, delivery.ts, media.ts, `planning/*` (steps.ts, wire.ts, graph.ts, checks.ts, facts.ts, executables.ts, prompts.ts, rubric.ts, review.ts, repository.ts, schedule.ts, units.ts, types.ts), `work/*` (steps.ts, worker.ts, prompt.ts, collect.ts), `review/*` (result.ts, final.ts, artifacts.ts) and `providers/*` (planner.ts, codex.ts, claude.ts, codex-worker.ts, claude-worker.ts). The workflow runs every step: check, plan, the item steps (work, select for media items, validate, review, publish, ci, merge), final, final-review and report, and cancel cleanup. QA and discovery items hold with "this Factory build can't run" them. Evidence paths point to the old tree (`src/`, `docs/`).

Status words:

- **ported**: in core/src now; the file is named.
- **in progress**: partly in core/src. The entry says what is missing and which slice carries it.
- **slice N**: the slice that should carry it (4 delivery modes, 5 operator surface, 6 capability ports, 7 cutover).
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
- Optional "Quality checkpoint" section. Old: src/quality-checkpoint.ts. **ported**: planning (prompts.ts qualityCheckpointInstructions, on when the section reads `enabled`), and the check refuses a malformed section (planning/steps.ts readObjective calls validate.ts declarationProblems).
- Optional "Workspace package additions" section. Old: src/workspace-membership.ts. **ported**: planning tells the planner the rule (prompts.ts), wire.ts makes each `newPackages` owner own its manifest, validation enforces the section (validate.ts workspaceAdditions and pinRefusal), and the check refuses a malformed section (declarationProblems).
- Optional "Package manager update" section, an exact pin required by validation. Old: src/package-manager-update.ts. **ported**: planning (prompts.ts packageManagerUpdate); the check refuses a malformed pin (declarationProblems) and one whose manager differs from the base pin (executables.ts); validation enforces the pin, required at final validation (validate.ts pinRefusal).
- Optional "Adaptive workflow" section with planningContext. Old: src/adaptive-workflow.ts. **slice 6** (Planning options seam).
- Optional "Workflow recipe" section with repository or packaged recipes. Old: USER-GUIDE#Workflow recipes, assets/recipes. **slice 6**.
- Objective source assets (user-attachment URLs, repository files, private local files) imported as worker inputs. Old: src/media.ts:139-160. **ported**: plans cite them and checks.ts mediaFindings refuses unknown assets. media.ts resolveInputs copies each into private staging with its sha256 and size: a base blob, or its LFS object from the local store or origin; a private local file only when the Objective names its exact path (objective.ts namesPath), read without following links; a GitHub attachment, with the service token sent only to its own URL, redirects only to GitHub hosts, at most 256 MiB. work/prompt.ts stages them read-only under .factory-inputs/assets.
- Objective dependencies through native blocked-by: wait for predecessors' accepted evidence, and refuse if a predecessor's body changed. Old: src/objective-prerequisites.ts. **planned** (see Slices).
- Editing the Objective or its Sources after planning is detected (changedSincePlanning). Old: USER-GUIDE#Status. **in progress**: an issue edit is detected up to plan acceptance (planning/steps.ts), and after it, before each publish and before the report (work/steps.ts objectiveEdited holds with `continue`, `replan` and `cancel`; a closed issue holds too). Missing: a Source file changed on the default branch is not compared; the plan stays pinned to its base. No slice carries it yet.
- The check looks up the host executables each final command needs and refuses one that is missing or the wrong version, naming the fix. Old: src/local-preflight.ts. **ported** (executables.ts observeLocalExecutables, called by workflow.ts checkStep).
- An Objective template and GitHub issue form are shipped. Old: docs/templates. **ported**: the templates are unchanged in docs/templates.
- Plans may name only base PR workflow jobs, and delivery re-checks a renamed job. Old: src/check-names.ts. **ported** (facts.ts workflowCheckNames, unknownCheckNames; delivery.ts renamedChecks).

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
- Cancel closes open Factory PRs and removes worktrees. Old: LIFECYCLE#Cancel exits. **ported** (work/steps.ts cancelCleanupStep: finds each item's open PR by its branch, comments once by marker, closes it, then removes the worktrees). Running workers and sandboxed commands are killed with their process groups (sandbox.ts processGroups).
- `cancel --provider NAME` for a stranded Objective. Old: LIFECYCLE#Cancel exits. **replaced**: cancel doesn't need a provider.
- `factory run --objective N` foreground run with exit codes 0, 2 and 1. Old: USER-GUIDE#Run. **planned** (see Slices): CORE.md says "No foreground runs", and `run` is only the dev service. See Contradictions.
- Several Objectives run in parallel from separate terminals; a second live run of the same Objective is refused. Old: USER-GUIDE#Run. **replaced** by the single `serve` with a lock (lock.ts), which runs several Objectives at once (see the next entry).
- queue.maxActiveObjectives 1-8, with waits on overlapping owned paths and shared host limits. Old: USER-GUIDE#Several Objectives. **ported** (config.ts queue.maxActiveObjectives, default 3, no upper bound; service.ts slots and waitsOnPaths: an Objective builds only while no earlier unfinished one owns an overlapping path, and planning never waits; engine.ts HostLimiter).
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
- The planner and reviewer are told worker capability, authorized commands, CI-only commands and the validation environment. Old: PLANNING#Plan checks. **ported** (prompts.ts with rubric.ts workerCapability, facts.ts commandInstructions and VALIDATION_ENVIRONMENT). Worker capability is a sandboxed shell (steps.ts WORKERS), which both worker adapters give.
- Target design checklist (AGENTS.md) and doc map honored by briefs, workers and review; DESIGN_CHECKLIST and ENGINEERING_STANDARD. Old: PLANNING#Design checklist. **ported**: planning (rubric.ts design note, prompts.ts doc map, facts.ts reads AGENTS.md and README.md), workers (work/prompt.ts design notes and the standard; claude-worker.ts asks for unanswered design notes), result review (review/result.ts) and final review (review/final.ts).
- Child Objective split (sub-issues, factory:objective, blocked-by), with the parent closing when all children are accepted. Old: USER-GUIDE#Child Objectives. **in progress**: planning is ported (wire.ts split, checks.ts splitFindings; the plan comment lists the children). Creating issues, queueing children and closing the parent is **slice 6** (splits are in the Planning options seam).
- Scheduling hints (estimatedDurationMs) and critical-path ordering. Old: USER-GUIDE scheduling paragraph. **ported**: graph.ts checks the hints; planning/schedule.ts rank orders runnable items (in flight first, then QA and aggregates, then priority, then the remaining critical path, by the estimates when every open item has one and by stages otherwise, then plan order), and work/steps.ts buildSteps emits the steps in that order.
- Declared resources are exclusive: an item doesn't start while an in-flight item declares the same resource, and waits without a question. Old: src/scheduler.ts pendingItemBlocker. **ported** (planning/schedule.ts resourceGate, used by work/steps.ts buildSteps; a native stack holds its layers' resources as one until it merges).
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
- AGENTS.md and README.md are read as context, not as Sources: a source obligation that cites one is refused unless the Objective pins it. (new) **ported** (facts.ts planningSources marks them `context`; wire.ts decodePlan refuses the obligation).
- `replan` after the plan is accepted: any build, final, final-review or report hold offers it, and it clears the plan and the build and checks the Objective again from the issue and the default branch. Merged work stays on the default branch, so the new plan starts from it. (new) **ported** (work/steps.ts replanOutcome).

## Planning options

- Execution profiles: the planner assigns a harness per Work Item. Old: USER-GUIDE#Execution profiles. **slice 6**: wire.ts accepts a profile list, but steps.ts passes none, so the planner can't choose one yet. Every item runs on its Objective's frozen provider's worker (providers/selection.ts). Profiles, and running them, arrive with several providers in slice 6.
- Read-only QA Work Items (declared commands and named CI checks); Objectives made only of QA qualify existing bytes. Old: src/qa.ts. **in progress**: planning is ported (the wire offers the qa kind; rubric.ts QA_EVIDENCE_GUIDANCE). Execution is **slice 6**; a QA item holds today (work/steps.ts notYet).
- Discovery Work Items and reviewed expansion envelopes. Old: src/graph-expansion.ts. **slice 6**: types.ts and graph.ts know the shapes, but the wire schema doesn't offer discovery items or expansions, so the planner can't produce them.
- Declared work conditions and aggregate nodes. Old: execution-profiles.ts:170. **in progress**: aggregate nodes are planned (wire.ts, graph.ts aggregateAcceptance) and run (work/steps.ts aggregateStep completes once its children merge). Conditions are in types.ts only; the wire doesn't offer them, so they are **slice 6**.
- Graph amendments: worker `.factory-discovery.json`, operator `propose-amendment` with independent review, and replacement amendments. Old: USER-GUIDE#Decisions. **slice 6** (Planning options: amendments).
- `decline-discovery` for an obsolete worker discovery. Old: USER-GUIDE#Decisions. **slice 6**.
- planningContext bounds and repository memory (SQLite/FTS). Old: src/repository-memory.ts. **slice 6** (Knowledge).
- `recipe --file` preview with no model call. Old: src/workflow-recipes-cli.ts. **slice 6**.

## Execution and providers

- Codex planning and review (codex-sdk), with gpt-6.1-sol defaults at high/medium/medium. Old: USER-GUIDE#Models. **ported** (providers/codex.ts CodexPlanner; DEFAULT_CODEX_MODELS is gpt-6.1-sol, planner high, reviewer medium).
- Claude planning and review (claude-agent-sdk), with explicit models, maxOutputTokens, and login/OAuth/API key. Old: USER-GUIDE#Local providers. **ported** (providers/claude.ts ClaudePlanner: models from the provider's `models`, maxOutputTokens, login, OAuth token or API key, and LoadCredential values).
- Per-role reasoning effort, per-phase reviewEffort, and Codex serviceTier. Old: USER-GUIDE#Models. **ported** (planner.ts ModelChoice and modelChoice with reviewEffort per phase; codex.ts serviceTier). A provider's `models` goes to the adapter as given; providers/config.ts doesn't validate its fields at load.
- Codex app-server planning transport (experimental). Old: USER-GUIDE#Retained conversations. **planned** (see Slices): not in CORE.md.
- Provider timeouts and idle bounds, retried within bounds. Old: USER-GUIDE#Models. **replaced**: step deadlines (45 min for planning and review, 2 h for a worker run; work/steps.ts), an idle watchdog per call (planner.ts IdleWatchdog; 15 min for Codex planning and Codex workers), retry, then hold after 3.
- Codex worker harness with a sandboxed shell and network host|off. Old: config.ts:129-160. **ported**: the worker runs in Codex's sandbox under Factory's permission profile, `.git` read-only (providers/codex-worker.ts), with the network from the provider's `worker.network` (providers/config.ts; off by default). The setup flag is in the setup options entry.
- Claude worker harness: maxTurns 400 with 2 automatic continuations; tools, permissions, setting sources; Validate, run_command, copy_file and delete_file. Old: USER-GUIDE#Local providers. **ported**: the harness with these defaults and every tool (providers/claude-worker.ts), changed through the provider's `worker` object (providers/config.ts; merged over the defaults, its fields not checked at load). The setup flags are in the setup options entry.
- FACTORY_CLAUDE_1M opt-in. Old: USER-GUIDE#Local providers. **ported** (claude-worker.ts).
- GitHub Copilot worker harness. Old: config.ts:98-105. **ported** (providers/copilot.ts CopilotWorker: Copilot SDK and the operator's Copilot login, file tools only with a configurable ceiling (`worker.tools`, default view, create, edit, apply_patch, grep, glob), every read and write checked inside the worktree, discovery items get read tools only; a login fault holds and names the fix, quota and rate limits retry). Copilot planning and review is new: providers/copilot.ts CopilotPlanner reports every session event through `PlannerCall.activity()`, so HedgedPlanner hedges it.
- Managed execution (openai-agents, claude-managed-agents) with budgetCents and orphan reporting. Old: USER-GUIDE#Managed execution. **in progress**: ported (providers/managed.ts). The worktree's files go to the hosted sandbox as one archive, the agent works without network and exports what Git keeps, and Factory checks every entry before writing it back for the usual collection, validation and review. Claude sessions carry `budgetCents` as their list-cost budget, and a reached budget holds. Every session is tagged with its Work Item's key and deleted when the run ends; a lost create or upload response, or a failed deletion, is logged as `possible-orphan`, and Claude sessions a crashed run left behind are found by tag and deleted when the step runs again. Missing: live qualification against either API (no API keys on the build host); the old snapshot-equality checks of agent and environment are replaced by checking the environment's networking and the session's agent tools at run time.
- Custom registered adapters through the library API (AgentHarness, composeWithLocalHarness/Profiles). Old: src/index.ts. **planned** (see Slices): CORE.md has no public library API.
- Multiple named providers, defaultProvider, and `setup --provider NAME`. Old: USER-GUIDE#Providers. **ported** (providers/config.ts: `providers.<name>` pairs a planner, codex, claude or copilot, with a worker, codex, claude, copilot, openai-agents or claude-managed-agents; without `providers` there is one, codex. cli.ts `setup --provider NAME [--planner K] [--worker K] [--default]` adds or changes one in an existing configuration and verifies it loads; the first becomes defaultProvider). Writing a whole configuration is setup, slice 7.
- Provider selection: a started Objective keeps its frozen provider; `--provider` applies to new work; status shows selectedBy. Old: USER-GUIDE#Providers. **ported** (state.ts `provider` is frozen at admission by service.ts; `serve --provider NAME` chooses for new work, else defaultProvider; providers/selection.ts providerWorkflow runs each Objective on its frozen provider's planner and worker, and holds with `retry` and `cancel` when that provider is no longer configured; `status` shows the provider and selectedBy). `run --provider` arrives with `factory run`, slice 5.
- Frozen config digest per Objective, and status explains restore or end. Old: config.ts:1334-1470. **planned** (see Slices): CORE.md is silent. Config edits mid-run would change behaviour silently.
- Never fall back to another provider; a missing login stops and names the fix. Old: USER-GUIDE#Local providers. **ported** (an Objective runs only its frozen provider's planner and worker, providers/selection.ts; a login fault holds and names the fix in codex.ts, claude.ts, copilot.ts, codex-worker.ts and claude-worker.ts, and a missing or refused managed API key holds in managed.ts).
- Retained conversations (planner across compile, correction and diagnosis; worker and reviewer continuations). Old: USER-GUIDE#Retained conversations. **planned** (see Slices): CORE.md says a model call "runs again", and keeps only the worktree.
- Concurrent Work Items in isolated worktrees, with owned-path enforcement. Old: README; ARCHITECTURE:209. **ported** (work/steps.ts buildSteps runs every item whose dependencies merged, each in its own kept worktree from worktree.ts; work/collect.ts refuses changes outside the item's owned paths; execution.concurrency bounds the steps of one Objective).
- Host-sized concurrency, capacityRecommendation, and scheduling reservations. Old: config.ts:222-270. **in progress**: the host-wide limits default from the CPU count (config.ts execution.workers and execution.validations). Missing: capacityRecommendation and scheduling reservations. They are **slice 6**.
- Ordered setup and probe commands from Sources, run in each fresh checkout. Old: USER-GUIDE#Run. **ported** (validate.ts: an item's commands run in order in a fresh checkout; final validation runs the plan's declared prerequisites first, finalSequence).
- Worker brief with pinned sources (.factory-inputs), handoff notes (.factory-handoff.json) and verification notes. Old: USER-GUIDE#Retained conversations. **ported**: the brief, pinned sources and notes (work/prompt.ts, work/collect.ts; the notes reach the item's result review). Peer notes: planning/schedule.ts peerNotes gives a worker the learnings of accepted earlier items that it depends on, that name it as a consumer or that touch its owned paths (verification and design notes stay with their item), and work/prompt.ts marks them advisory. The old tree also shipped each note's cited source bytes with their availability (src/objective-knowledge.ts); the core worker reads the cited paths in its own checkout instead. Notes in review beyond the item's own are a separate entry under Validation and review.
- The controller owns commits, under the Factory identity; workers get read-only Git. Old: execution/local.ts:1367. **ported** (work/collect.ts commits as the Factory identity; codex-worker.ts and sandbox.ts mount `.git` read-only).
- Worker isolation: private HOME and CODEX_HOME, personal configs and MCP disabled, env filtered of GitHub/Git/SSH credentials. Old: USER-GUIDE#Safety. **ported** (codex-worker.ts workerHome writes its own config; claude-worker.ts loads no setting sources; worktree.ts workerEnvironment allow-lists the environment).
- Provider usage-limit wait until reset, shown in status; retry ends it early. Old: USER-GUIDE#Decisions. **ported** for planning, review and workers (codex.ts codexFailure and claude.ts usage-limit waits, used by both worker adapters; engine.ts afterMs; cli retry).
- Hedged planner calls: a call silent for 45 s (review) or 120 s (planning), or 3 min with no events, starts an identical second call; the first answer wins. (new) **ported** (providers/planner.ts HedgedPlanner, wrapped around every planner, reviewer and diagnosis call in cli.ts). Worker runs are not hedged.
- A shared Codex model list, so each private Codex home skips the fetch at start. (new) **ported** (codex.ts privateCodexHome seeds each planner and worker home from it; saveModelsCache keeps a fetched list).
- Provider event timing and tracing: each provider event is logged with its kind and time since the call started; FACTORY_PROVIDER_TRACE keeps each Codex call's home, session record and stderr. (new) **ported** (codex.ts codex-event and traceWrapper, claude.ts claude-event; codex-worker.ts logs worker commands and edits).
- Host-wide resource limits shared by all Objectives: worker runs (execution.workers) and CPU-heavy validation (execution.validations), plus Work Item steps per Objective (execution.concurrency). (new) **ported** (engine.ts HostLimiter and Step.resource; config.ts; cli.ts).
- Prompt and workspace instructions per profile, and the Claude worktree-read MCP. Old: USER-GUIDE#Execution profiles. **slice 6**.

## Validation and review

- Validate the exact candidate tree in a fresh checkout: declared commands only, offline, FACTORY_BASE_SHA, private TMPDIR. Old: USER-GUIDE#Objective format. **ported** (validate.ts validateTree, every command through sandbox.ts).
- Supported dependency bootstrap (npm ci / pnpm frozen with --ignore-scripts) run first; pinned package scripts. Old: USER-GUIDE#Run. **ported** (facts.ts packageBootstrap; validate.ts runs the bootstrap first and pins package scripts to the base).
- finalValidation.requiredCommands. Old: USER-GUIDE#Run. **ported** (the check refuses one with no authority at base, facts.ts objectiveCommandProblems; the plan records it in finalCommands; work/steps.ts finalStep runs them).
- finalValidation.ciOnlyCommands, never run locally and refused in Objectives. Old: VALIDATION-ENVIRONMENT.md. **ported** (the check refuses them in Acceptance; facts.ts leaves them out of authorized commands and `allow`; checks.ts ci-only refuses them in a plan).
- Flaky check: one fresh rerun when worker Validate passed, then flakyRerun shown in status and the PR. Old: delivery/description.ts:95. **in progress**: the rerun is ported, tied to the exact tree (work/steps.ts validateStep), and the PR body names it (delivery.ts). Missing: status doesn't show it. That is **slice 5**.
- Final validation of the integrated tree, re-run when other Objectives merged first. Old: USER-GUIDE#Run. **ported** (work/steps.ts finalStep validates the default branch head after the last merge, so other Objectives' merges are in it, and holds if one of this Objective's merges is no longer on the head).
- Independent result review per Work Item against criteria, contract, design checklist and engineering standard, with base/ and changes/ roots. Old: PLANNING#Engineering standard. **ported** (review/result.ts).
- Final Objective review of the integrated tree: every criterion, coverage obligation and integration edge. Old: ARCHITECTURE:125. **ported** (review/final.ts).
- Final review judges only this Objective's merges (each merge's first-parent diff), with the integrated tree as context, so other Objectives' work is not under review. (new) **ported** (review/final.ts, work/steps.ts finalReviewStep).
- reviewArtifacts selectors (stdout, stderr, files, located files). Old: src/review-artifacts.ts. **ported** (review/artifacts.ts): config.ts loads and checks the selectors once; validate.ts captures after each passing, non-preparation command of the validate step and final validation (never the worker's own Validate), with a coding item taking text selectors only for sources it owns, each body within its bounds; review/result.ts and review/final.ts get the rows. The plan records the selectors it was compiled with, and validation holds when one is no longer configured.
- Image review evidence (receipt and PNG bound to the candidate), with reuse in final review. Old: USER-GUIDE#Images. **ported** (review/artifacts.ts image selectors): the command's last stdout line locates a receipt by its sha256, and the receipt binds a complete PNG to the exact candidate bytes in the validated tree (an LFS file by its object); at most 8 images and 64 MiB. codex.ts and claude.ts attach the PNGs to the review call. Final review takes fresh captures of the integrated tree first and reuses an accepted item's capture of the same tree, marked as reused.
- A controller candidate receipt for review: every captured set with its provenance and members, the capture checks every set passed, which roles differ across sets, the selection (who, when, bound items), and digest-checked review copies within bounds. Result and final review judge criteria about the alternatives from it and the delivered bytes from the selection; planning flags criteria that require every candidate to pass validation. (new) **ported** (media.ts candidateReceipts; review/result.ts candidateRows and CANDIDATE_GUIDANCE; review/final.ts; planning/rubric.ts CANDIDATE_SETS).
- Objective knowledge in review: the old result review saw peers' handoff notes and the final review every item's notes, as advisory claims. Old: src/objective-knowledge.ts reviewObjectiveKnowledge. **slice 6**: core result review gets only the item's own notes, and final review none.
- Review evidence budget env vars. Old: USER-GUIDE:690. **replaced** by fixed bounds in review/result.ts (inline patch budget, per-file export bounds); there are no env vars.
- `retry --rereview [--review-artifacts]` within resultRereviews. Old: USER-GUIDE#Decisions. **in progress**: `revalidate` (Recovery and restart) runs validation, review and delivery again on the same refused result from a repair diagnosis hold. Rereview from other holds, `--review-artifacts` and the resultRereviews budget are **slice 5** (hold answers).
- `retry --retire-command CMD --reason`. Old: USER-GUIDE#Decisions. **slice 5** (hold answer).
- `decide --item --criterion` for human acceptance of a criterion, or final acceptance. Old: USER-GUIDE#Decisions. **slice 5** (hold answer).

## Delivery

- Regular mode: one PR per Work Item, a branch push, and merge commit only, under branch protection. Old: delivery/regular.ts, github.ts:2940. **ported** (delivery.ts publish and merge on `factory/<issue>/<item>`; github.ts mergePull with the head as guard; a repo that forbids merge commits holds).
- Native-stack mode (linear stacked PRs). Old: delivery/native-stack.ts. **ported**: config.ts delivery.kind; planning/units.ts splits the plan into linear chains, and an item off a chain is an ordinary PR. Each layer's PR targets the branch below and starts from its delivered head (work/steps.ts). The top layer's merge step merges the whole stack through GitHub's stack API with one shared merge commit (delivery.ts mergeUnit; github.ts findStack, createStack, mergeAsync), and confirms every layer at its head on every path, after a crash too. A failed check or conflict is pinned to its layer; a layer that doesn't contain the head below it is moved onto that head; a layer's repair moves every layer above onto its new head. Layers merged by other means are a question with `accept`.
- PR body: Work Item goal, links, changed files, candidate commit and tree, passing commands, no model call. Old: delivery/description.ts. **ported** (delivery.ts pullRequestBody).
- No duplicate PR after a lost response. Old: USER-GUIDE#Models. **replaced**: the PR is found by its fixed head branch before one is opened, and a push uses a lease on the head Factory pushed (delivery.ts publish).
- Wait for required checks (rulesets and classic protection); failed CI becomes repair with log excerpts. Old: github.ts:2301-2425. **ported** (github.ts required checks from rulesets and classic protection; delivery.ts judge turns any failed check or conflict into a repair with annotations and log tails, and the repair pushes to the same PR).
- Update the PR branch when behind base. Old: github.ts:2852. **ported** (delivery.ts updateBranch).
- Closed, draft or stuck PRs become decisions. Old: delivery/readiness.ts. **ported** (delivery.ts judge: a draft, a PR closed without merging (answer `republish`), only cancelled checks, no checks, or the same checks pending for a day holds).
- Never bypass branch protection; recommend "require branches up to date". Old: USER-GUIDE#Decisions. **in progress**: Factory never bypasses (delivery.ts merges through the API with the head as guard and holds on a blocked merge). Missing: the recommendation; it belongs in setup, **slice 7**.
- A delivery repair (failed CI or a conflict) moves the item's kept worktree onto the current default branch and replays the refused change with a three-way apply; the worker resolves what conflicts. (new) **ported** (work/steps.ts rebaseWorktree).
- Media AssetSets: `select --output DIR`, `select --set --bind`. Old: USER-GUIDE#Decisions (media). **replaced** by the select step: the worker stages candidate sets with a manifest, and media.ts captureAssets checks it and keeps digest-checked private copies. The step holds with every set (members, sizes, provenance) and the private directory that holds them; the answer is the set id, with `bind ITEM...` to give the set to direct dependents as read-only inputs. materializeSelection writes only the chosen set at its owned destinations, through the target's .gitattributes LFS rules, and checks each pointer.
- Git LFS upload on delivery, and LFS hydration for validation. Old: src/media.ts:56-100. **ported**: publish uploads the objects behind every pointer the result adds before it pushes (media.ts lfsPushIfPointers, called by delivery.ts publish). Validation restores every LFS file of the checkout from the local store or origin, checked against its pointer, and refuses a command that rewrites one (media.ts hydrateTree and rewrittenMedia, called by validate.ts, the Claude worker's Validate included). Final validation proves origin serves every selected member, pushing missing objects once more (media.ts verifyOriginMedia).

## GitHub tracking

- One GitHub issue per Work Item (Task type, factory:work-item label, sub-issue, blocked-by edges, body sections, hidden marker). Old: USER-GUIDE#Run; github.ts:1354. **gap/contradiction**: CORE.md defines a Work Item as "one PR" and posts the plan as a comment.
- Live status comment per Objective, edited in place. Old: USER-GUIDE#GitHub progress. **slice 5** (CORE.md comment markers edit in place).
- Live status comment per Work Item issue. Old: same. **planned** (see Slices), because Work Item issues aren't planned.
- New notification comments only for decisions, failures and outcomes; progress.enabled and includeQuestions. Old: USER-GUIDE#GitHub progress. **in progress**: hold comments (github-sync.ts ask) and the outcome report (work/steps.ts reportStep) are ported. Failure comments are **slice 5**. The on/off config is **planned** (see Slices).
- Project Status sync per phase. Old: src/github-project-state.ts. **ported** for Objectives (queue.ts QueueDisplay, config.ts options). For Work Item cards it is **planned** (see Slices).
- Explicit projectStatus field binding, or disabled. Old: config.ts:1303. **replaced** by queue.field and queue.options in config.ts. "Disabled" isn't possible, because Status drives the queue.
- Factory reads no human comment as input. Old: USER-GUIDE#GitHub progress. **replaced and reversed**: `/factory <answer>` comments from users with write access (github-sync.ts). See Contradictions.
- Close the Work Item issue on merge and the Objective on sealed acceptance; cancel closes as not_planned; duplicates are closed. Old: github.ts:918-1015, completion.ts. **in progress**: the report closes the Objective as completed after final review passes (work/steps.ts reportStep), and cancel closes it as not planned (cancelCleanupStep). Work Item issue closing is **planned** (see Slices).
- Create the role labels and the native issue types (Feature, Task); priority inheritance. Old: github.ts:1242. **planned** (see Slices).
- Display times in the host zone, with FACTORY_DISPLAY_TIMEZONE. Old: USER-GUIDE#GitHub progress. **planned** (see Slices): core prints ISO times.
- A reminder comment after a hold is open 24 h (new). **slice 5**.

## Holds and decisions

- Every stop is a question with named answers, and each answer works. Old: `decide`. **ported** (engine.ts, state.ts Hold).
- Answer from the CLI: `factory answer ISSUE ANSWER [--text]`. Old: `decide --outcome --reason --answer`. **replaced** by cli.ts answer.
- Stale-answer protection: refuse an answer when a different question is open (question digest). Old: USER-GUIDE#Decisions. **in progress**: a `/factory` comment carries its written time, and engine.ts refuses one written more than 60 s before the open question was asked (github-sync.ts, requests.ts writtenAt). Missing: a CLI answer carries no question binding, so a delayed `factory answer` or `retry` can still answer a newer hold. That is **slice 5**.
- The director skill asks holds with AskUserQuestion, recommended answer first. Old: skills/director. **slice 5** (CORE.md#Holds; the skill is not rewritten yet).
- Autonomy allowances (planningRevisions 1, implementationRepairs 6, resultRereviews 1), perPath caps, repairClasses; snapshotted, and running out stops for a decision. Old: src/repair-policy.ts. **in progress**: planningRevisions is ported as planning.revisions (config.ts, steps.ts), and the repair budget as config.ts execution.repairs (6 per Work Item by default, then a hold where `retry` allows one more). resultRereviews, perPath, repairClasses and snapshotting are **planned** (see Slices).
- autonomy.requiredEnvironment secrets checked before planning. Old: USER-GUIDE#Autonomy limits. **slice 5** (moved from slice 3; nothing in core reads it).
- policy.allowedSecretNames passed by name and redacted from output. Old: config.ts:342. **in progress**: the setting and the plumbing are ported (config.ts policy.allowedSecretNames; worktree.ts workerEnvironment; codex-worker.ts and claude-worker.ts pass the named variables). Every text Factory writes to GitHub (comments, PR bodies and titles, holds, reports) is redacted at one choke point (github.ts `redacting`, set in cli.ts from the named values). Missing: local status and diagnostics output don't redact; **slice 5**.
- Predecessor blame: a failure in a merged predecessor's file stops with a decision and spends no repair. Old: USER-GUIDE#Decisions. **slice 5** (moved from slice 3). validate.ts uses the predecessor only to pin package scripts; a failure is always the item's repair.
- `fail` holds with retry, replan and cancel (new). **slice 5**.

## Recovery and restart

- Crash or restart reconciles issues, PRs and merges by stable identity, with no duplicate effects. Old: USER-GUIDE#Stopping and recovery. **replaced**: crash-only steps plus GitHub lookup (CORE.md#Idempotence). Ported in engine.ts, state.ts (atomic save) and crash.ts, and for effects in delivery.ts (branch, PR by head, merge by head) and work/steps.ts (report and cancel comments by marker). The milestone drill passed 7 of 7 crash points.
- Reattach running workers; `collect` freezes a return that finished while the controller was down. Old: USER-GUIDE#Stopping and recovery. **replaced**: workers die with the service, and the work step reruns on its kept worktree. The `collect` command goes.
- Abandoned in-flight model calls start fresh. Old: same. **ported** (engine.ts: an interrupted step counts as an error and reruns).
- Automatic repair: review findings become a correction; failed commands go to diagnosis (repair, question, or blame). Old: USER-GUIDE#Decisions. **in progress**: repair and question are ported (repair.ts correction: the first review refusal is the correction, everything else is diagnosed; a repeated correction is refused; an operator question holds). Blame is **slice 5** (see above).
- A repair continues from the refused result, three-way rebased onto a moved base; `--fresh` starts from base. Old: USER-GUIDE:723. **in progress**: the worker continues in the kept worktree, and a delivery repair three-way applies the refused change onto the current default branch (work/steps.ts). `--fresh` is **slice 5**.
- Facts that must outlive a repair (base, pushed heads, the refused commit and tree, the saved correction, the flaky rerun) are kept apart from the step results a repair clears. (new) **ported** (engine.ts Outcome.keep into state.kept; work/steps.ts). A correction is diagnosed once per repair and reused after a restart.
- `revalidate` on a repair diagnosis hold: when Factory's own check was at fault, the kept refused result becomes the work result again, unchanged (no worker run, no collection, not counted as a repair), and selection, validation, review and delivery run again. (new) **ported** (work/steps.ts refusedResult and workStep; CORE.md#Holds).
- An operator's media selection stands across a repair that isn't about the media (the finding names no selected destination and doesn't cite the candidate receipt): the repaired attempt stages no candidates, and the select step writes the same set on the new commit. A repair from the select step, one about the media, or one whose private copies are gone asks again. (new) **ported** (work/steps.ts KeptSelection and aboutMedia; work/prompt.ts mediaContract).
- A repair stops the running steps it clears, so a late outcome of cleared work is never saved. (new) **ported** (engine.ts abortRunning).
- `repair --proposal FILE` for an operator-diagnosed correction. Old: USER-GUIDE#Decisions. **slice 5** (a hold answer with text) or **planned** (see Slices): CORE.md has no file input.
- Usage-limit and transient errors retry with backoff. Old: USER-GUIDE#Decisions. **ported** (engine.ts DEFAULT_LIMITS).
- Git checkpoints to a private archive (gitPersistence), with `persistence status|sync|inspect|maintain`. Old: USER-GUIDE#Git checkpoints. **replaced**: state is rebuilt from GitHub (`factory reset`, **slice 5**, not in cli.ts). Learning and receipt archiving is **planned** (see Slices).
- Restore on another machine (`persistence restore`, `reconcile`). Old: USER-GUIDE#Restore. **replaced** by `factory reset --objective N`, which is not built yet.
- An archive bound being exceeded stops with exit 2. Old: USER-GUIDE#Git checkpoints. **replaced**: there is no archive. Log retention is 20 runs and 2 GB (log.ts rotateLogs).
- Retention of finished Objectives, with worktrees and logs reclaimed. Old: USER-GUIDE#Retention. **ported** (log.ts for logs; work/steps.ts reportStep and cancelCleanupStep remove the worktrees).
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
- A held or failed Objective holds only itself. Old: USER-GUIDE#Several Objectives. **ported** (engine.ts, CORE.md rule 1; service.ts tick gives no slot to a holding Objective unless it has a step still running).
- Installation-wide holds for auth (401/403) and disk faults, lifted by queue resume. Old: USER-GUIDE#Several Objectives. **replaced**: GitHub errors retry forever (github.ts TransientError). Disk faults are **planned** (see Slices).
- The first run checks host and worker readiness without model calls. Old: src/readiness.ts. **planned** (see Slices).
- Validation environment report, and a warning for network tools in scripts. Old: VALIDATION-ENVIRONMENT.md. **in progress**: planning is ported (facts.ts networkToolOfCommand keeps network scripts out of authorized commands; checks.ts network). The setup report is **planned** (see Slices).

## Safety

- Refuse Factory's own repositories, local-path origins, and mismatched fetch and push URLs; re-verify before every fetch and push. Old: src/origin-binding.ts. **in progress**: local-path and mismatched fetch or push URLs, and custom LFS routing, hold before every push and merge (worktree.ts originProblem, delivery.ts originHold). Missing: the check before a fetch (git.ts defaultHead), and refusing Factory's own repositories. Both are **slice 7**.
- Config and state live outside the target checkout. Old: USER-GUIDE#Set up. **ported** in effect (paths.ts, under home). The refusal of an in-checkout config is **planned** (see Slices).
- bubblewrap sandbox for every worker-caused command; refuse without bwrap; refuse as root. Old: USER-GUIDE#Command sandbox. **ported** (sandbox.ts runSandboxed for validation and the Claude worker's run_command; ROOT_REFUSAL; sandbox.required). Codex workers run in Codex's own sandbox (codex-worker.ts).
- Sandbox setup failures are config faults, not the candidate's failure. Old: same. **ported** (sandbox.ts returns a fault; validate.ts turns it into a hold).
- sandbox.network package-install (registry-only through pasta) and packageStore. Old: execution/package-network.ts. **ported** (package-network.ts, sandbox.ts, config.ts).
- sandbox.readOnlyPaths, and sandbox.environment with a deny-list. Old: same. **ported** (config.ts sandboxConfig, sandbox.ts).
- Sandbox limits (tmpMiB, homeMiB, checkoutMiB, files, candidate size, processes). Old: execution/sandbox.ts. **ported** (config.ts sandbox.limits, sandbox.ts, work/collect.ts candidate bounds).
- Refuse gitlinks and submodules. Old: src/ownership.ts. **ported** (worktree.ts hasGitlink, used by collect.ts, validate.ts and claude-worker.ts).
- Pre-publish scan: changed-path ownership, unsafe links and special files, Secretlint by rule and path. Old: execution/secret-scan.ts. **ported** (work/collect.ts).
- Fixed acceptance scripts and package-manager metadata protected unless authorized. Old: ARCHITECTURE:115. **ported** (facts.ts fixedScripts in the planner facts and worker prompt; validate.ts pinRefusal enforces them).
- Controller PATH guidance: refuse protected PATH dirs and exclude its own bin. Old: README#Controller PATH. **ported** (sandbox.ts toolchainDirectories refuses a PATH directory that would show a login or Factory's files; worktree.ts workerToolchainPath drops Factory's own launcher).
- Credentials stay with the service; workers never see them. Old: USER-GUIDE#Safety. **ported** (github.ts: the token comes from gh and stays in the service; worktree.ts workerEnvironment and validationEnvironment give workers and validation no GitHub, Git or SSH credentials).
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
- **2026-10-22, Execution (slice 3) and concurrency.** Execution is ported onto the core: worktrees, Codex and Claude workers, the sandbox, validation, result review, repair, regular PR delivery with CI and merge, final validation, final review, the report and cancel cleanup. Several Work Items and several Objectives run at once, with owned-path waits and host-wide limits; this came forward from slices 4 and 6. Drills on the scratch repository finished a single-item and an 8-item Objective, ran 3 Objectives at once with an owned-path wait, passed 7 of 7 crash points, repaired a CI failure on the same PR, and cancelled during 8 workers and during CI with PRs closed, worktrees removed and no processes left. Ledger counts after this update, by the same rules: 90 ported, 20 replaced, 34 in progress, 62 planned, and 1 gap (207 lines). Execution capabilities still not ported:
  - Refusing a malformed Quality checkpoint, Package manager update or Workspace package additions section at the check (validate.ts declarationProblems exists but is not called): slice 5.
  - Predecessor blame, `requiredEnvironment`, `--fresh` repairs, closing a cancelled Objective as not_planned, flaky reruns in status, and the policy.allowedSecretNames setting: slice 5.
  - The repair budget and other allowances in config (resultRereviews, perPath, repairClasses, snapshotting): planned, no slice yet.
  - Comparing Source files changed on the default branch after planning: no slice yet.
  - Scheduling by the plan's hints, and sharing worker notes with peers: slice 4.
  - Native stacks and LFS delivery: slices 4 and 6.
  - QA and discovery items, execution profiles, conditions, capacityRecommendation and scheduling reservations: slice 6.
  - Worker settings in config (Codex network host, Claude tools, permissions, setting sources and maxTurns), the origin check before a fetch, refusing Factory's own repositories, and the branch-protection recommendation: slice 7.
  - The Decisions entry and CORE.md#One at a time still say one Objective at a time; the code runs up to queue.maxActiveObjectives (default 3).
- **2026-10-22, Delivery modes (slice 4).** Native stacks, media and LFS, review artifacts, scheduling hints and peer notes are ported and wired into the item steps. Media came in from slice 6: source asset import, candidate capture, the select step with binding, LFS upload, hydration and origin verification, and the controller candidate receipt. Review artifacts and image review evidence came in from slice 6 too. Drills on the scratch repository, each finished and closed as completed:
  - Drill 51, a native stack of 3 layers plus an independent item: the stack merged as one, with one shared merge commit (353cc13), after CI repairs on the bottom and middle layers and a recovery from a stale upper layer (built on an older head of the layer below, then moved onto the current one).
  - Drill 57, glb and png candidate sets: the operator chose a set that was not the recommended one, and the LFS pointers were verified on origin.
  - Drill 59: the selection stood across a CI repair that wasn't about the media, every LFS file was restored for validation, and `revalidate` recovered a result Factory's own check had refused.

  Gaps the drills found, all fixed on this milestone: steps kept running after a repair cleared them and could save stale results (engine.ts abortRunning); the reviewer had no record of the candidate sets (the controller candidate receipt); an unrelated repair made the operator select again (the selection stands); validation restored only the selected members, not the LFS files already in the repository (hydrateTree restores every LFS file); and there was no way to resubmit an unchanged result after a wrong refusal (`revalidate`).

  Ledger counts after this update, by the same rules: 107 ported, 21 replaced, 27 in progress, 57 planned, and 1 gap (213 lines). Delta from the slice 3 milestone: +17 ported, +1 replaced, -7 in progress, -5 planned, +6 lines. Of the lines that became ported, 5 had been done by the lean sweep after slice 3 and were still marked open: refusing malformed Quality checkpoint, Workspace package additions and Package manager update sections at the check, and the Codex and Claude worker settings in config. Still not ported from this area:
  - Peers' notes in result review, and every item's notes in final review: slice 6 (found at this milestone; the old tree had them).
  - Secret values weren't redacted from GitHub writes (found at this milestone); fixed at the GitHub write choke point.
  - `retry --rereview` from holds other than repair diagnosis, `--review-artifacts` and the resultRereviews budget: slice 5.
  - Setup flags for delivery and the worker settings: slice 7.
  - QA and discovery items, execution profiles, conditions, capacityRecommendation and scheduling reservations: slice 6.
