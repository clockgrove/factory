# Plan standard

A plan says **what** must be true when the work is done, and **what other items rely on**. The worker decides **how** from the real code, and result review checks the how against that code.

Why: a planner writes every detail from a partial read of the repository. Each mechanism, line number or edit list it adds can contradict the real code, and then becomes a review finding or blocks the worker on wording. Precise plans with 40 or more acceptance entries per item needed far more revision rounds than outcome-level plans.

The rules live in `src/planning/rubric.ts`. The planner and the graph reviewer read the same Work Item standard. The reviewer applies the full checklist; the planner gets a short checklist of its plan-shaping judgments, quoted from the same text, without the review-packet mechanics.

## A Work Item

| Field       | Rule                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Goal        | One sentence: the outcome.                                                                                                                |
| Contract    | Only what other items or users rely on (names, semantics, formats), stated once in the brief and repeated in each consumer's brief.       |
| Acceptance  | Observable behaviour, invariants and refusal classes at the contract level. Each entry is checkable from outside the code.                |
| Evidence    | The repository tests or commands that prove the acceptance, run by the item's own validation. Final review or CI is never the only proof. |
| Validation  | The commands the item's owned paths affect, plus the repository's standard check command. Not every declared script.                      |
| Design note | Where the repository declares a design checklist, a short answer to each question in the brief.                                           |
| Constraints | What must not change or must not be used, as non-goals.                                                                                   |
| Docs        | What a reader needs documented, where the target's AGENTS.md doc map puts it.                                                             |

**Never:** internal mechanisms, line numbers or ranges, file-by-file edit lists, names for new internal symbols, classes or tests, test prose, reading lists, one entry per malformed field or error path, "existing tests unchanged" prose, or restated source text.

**Keep:** invariants across inputs or steps (step-size independence, determinism), the real upstream producer named by its type, and existing helpers and conventions named by name. These raise result quality.

**New identifiers are the worker's.** Acceptance and briefs name only identifiers that exist at the base. A new type, endpoint path, migration number, file or test name is described by role and data, unless the Objective or a pinned source fixes it. The rule stops at owned paths: an item owns each new file it creates, a new test file included, by the literal path the planner chooses, or by a directory prefix ending in `/` where narrow ownership allows one, and graph review never flags either as a new identifier. Why: a reviewer that applied the rule to owned paths refused a new test file's name, its directory as too broad, and dropping the test, which left no valid plan (#2108).

**Size:** one outcome per item. About 15 acceptance entries is a signal, not a target: above it, split the item or say in its brief why it is one outcome.

**Briefs** carry settled decisions and cross-item contracts the worker cannot get from the repository. Workers read the code themselves.

**Ownership is narrow.** An item owns the files its change needs, not a whole source tree or shared folder. A shared file (index, contracts barrel, router, docs map) has one owner, and the items that need its change depend on that owner; consumers of a shared layer then run in parallel.

**Edges follow interfaces.** A dependency points to the item that owns the exact interface needed; independent sub-surfaces of one upstream item run in parallel, so split the upstream item there. Coverage proofs are spread over the items that own each claim: graph review flags one item whose single command proves more than half of the Objective's criteria.

**No silent deferral.** Where proof needs an environment local validation lacks, the planner asks through `decisionRequired` instead of leaving it to final review or hosted CI.

**Existing tests are protected by default.** An item changes an existing assertion, golden or baseline only when its acceptance states that behaviour change and why.

**Generated values need a producing command.** The planner and graph reviewer are told what the configured workers can execute, from the worker harness kind: Codex workers have a sandboxed shell; Claude and Copilot workers run only the item's validation commands and checkout file tools. Where a shell-less worker must commit values only running code produces (hashes, snapshots, goldens, generated files), one of its validation commands produces them or reports the actual values, or an item it depends on delivers that capability; otherwise review flags the item. A check that writes the actual values to a Git-ignored file under the item's owned paths is a valid producing command: Validate copies that file back to the worker's checkout.

**Validation runs on the uncommitted result.** The worker runs its item's commands on its uncommitted change, where selected media aren't yet written, and Factory runs them in a fresh checkout of a commit it makes, with every Git LFS file's real bytes restored. A command, and every test it runs, checks working-tree files: the planner checklist and graph review check 5 (`UNCOMMITTED_RESULT` in `src/planning/rubric.ts`) flag one that depends on the result being committed (`git show HEAD:<new file>`, `git log`, `git diff HEAD`, `git ls-files` or `git lfs ls-files` of a new path, a test that expects a Git LFS pointer) or one its tool can't run as written (`git lfs ls-files` reads its arguments as revisions). A base-relative check that compares the working tree with `$FACTORY_BASE_SHA` is not flagged. Selected media's Git LFS storage is a controller guarantee; an item checks a destination's routing from `git check-attr filter -- <path>`'s output, which must name `lfs`, since the command exits zero for an unrouted path too. Why: such a command fails whatever the result holds, and a started item keeps its commands unless an amendment replaces one (the started-item rule, below) (#2107).

## How the planner works

1. **Research.** Explore wide, then narrow. Collect facts tied to files: conventions, real producers and types, existing behaviour, constraints. These facts stay in the planning session; Factory never stores them.
2. **Write** the plan from the Objective and those facts only.
3. **Check** the plan against the short checklist of the reviewer's plan-shaping judgments before submitting.

All three happen in the planner's one session. Self-checking is a filter; the independent graph review stays the gate.

**Plan changes after acceptance are planned, not asked.** When a Work Item's repair needs files or work outside its owned paths that no item owns (a module a person's new test imports, say), the repair diagnosis decides `discover`, and amendment planning chooses between a new Work Item and a change to an existing one, under the same checks and independent review. The diagnosis asks the operator only what a person alone can decide: their intent, an external fact or an authorization. Why: a question like "add an item to own the file, or drop the test?" hands the plan to the operator, when the planner and its review can make and check that change (see [Holds](reference/holds.md)).

## How review holds the standard

- **Graph review:** an acceptance entry that prescribes a mechanism, a line or a file edit instead of behaviour is a fix finding. Review never asks for more detail than the standard requires.
- **Consistent acceptance.** Graph review reads each item's acceptance entries against each other, its brief and the Objective's constraints, non-goals and operator decisions. A contradiction, such as one entry capping what another requires to hold independently of that cap, or an entry no implementation can meet together with the others, is a fix finding. Why: such a plan passes review and then fails every worker attempt.
- **Sourced numbers.** Every numeric limit, budget, retry count or timeout in a plan comes from a pinned source, the repository or an operator decision. Otherwise the item states the property the value protects and leaves the value to the worker; a value users would observe is an operator decision. Why: an invented number reads as a requirement and binds the worker and reviewer to it.
- **How a criterion is evidenced is the planner's choice.** A command that checks a property of the result, or a semantic proof whose review judges the criterion itself: graph review judges whether the chosen method can show the criterion, and one that can't is a fix finding, never an operator decision (`EVIDENCE_METHOD` in `src/planning/rubric.ts`, quoted in check 1 and the planner's checklist). A perceptual quality of candidate media, such as a preview that depicts its model, is seen by the operator when choosing a set at select and judged by the owner's result review through a semantic proof of its criterion; commands check its format and dimensions. A revision round does not ask to undo a change it asked for, or raise the choice it settled as an operator decision, without a new reason. The planner never asks a question an operator answered again: an answer that leaves the choice to the planner ("choose within the Objective") settles it, and the planner keeps its plan's choice when it is sound. Why: live, review asked for a command proxy of "depicts the cube", raised proxy against result review as an operator decision the next round, and the planner asked the same question every round until the answers ran out (#2117).
- **Judged, not linted.** Graph review, not a check, holds that storage a new table needs is owned by the item or an item it depends on, and that a privacy, access or accessibility claim is proved by a command. Why: a check over English acceptance text misfires, and each false match costs a revision round.
- **Result review** judges behaviour. It does not refuse a criterion because the code reaches the stated behaviour another way than a plan happened to describe. It refuses an unannounced change to an existing test.
- **Lint before review.** Before any paid review, Factory refuses:
  - an item with more than 15 acceptance entries and no `oneOutcomeReason`;
  - an acceptance entry that cites a line number next to a source file name (`store.ts:88`, `store.ts#L88`);
  - two items that own the same or overlapping paths when neither depends on the other, directly or transitively. Why: the scheduler would run them one after the other anyway, and wide shared ownership turns a plan into a serial chain;
  - when the plan selects any validation command (so the repository has one), a work item without a validation command, and a criterion proved only by final review or CI whose owner runs none. Why: final review and hosted CI run nothing inside Factory validation;
  - a validation command whose script (from the base `package.json`) invokes a known network tool. The authorized package bootstrap and npx runs of local bins are not refused. Why: validation has no network, so the command could never pass, whatever the item owns;
  - a validation command whose package script body works in one directory (it starts with `cd DIR &&`, or is one command naming DIR after `--prefix`, `--dir` or `-C`) on a work item that owns no path there. The request lists these scoped commands with their directories. Why: the command checks nothing the item changed;
  - a plan with no media roles in which a work item owns a file the Objective names, the base lacks and a base `filter=lfs` rule routes (the request lists those rules as `lfsRules`). Why: such a file is new media, and as ordinary work it skips candidate capture and the operator's selection. Whether the Objective asks for a choice is prose, so the check reads only these facts.

  The planner gets all of these as one correction. An amendment's plan round gets the same: the plan checks' findings, the amendment fence's (a started item grown though it isn't a reattempt item, or at acceptance one that started while the round was planned changed; an item, coverage entry or source exclusion dropped; a started native stack's layers changed), and its graph review's fix findings, go back to its planner as another round, charged to `planningRevisions`, and only an operator decision or the same findings twice reject it. The amendment planner's `cannotPlan` is reviewed the same way: the review either confirms the refusal, which rejects the amendment and asks the operator, or returns a fix finding naming the rule that allows a plan, which goes back to the planner as another round. Why: live, a planner refused a plan that the started-item rule in its own prompt allowed, and the refusal held the Objective with no review. The planner and the review are told the started-item rule, naming the items it binds: a started item keeps its spec, only a reattempt item (the proposing worker's own unpublished item, or for an operator's proposal a failed, unpublished one) may grow its owned paths or dependencies, or replace or drop a validation command the validate step failed its result on under this plan (the item's `validationFailed` fact, listed as `replaceableValidation`), and only then restate its acceptance, brief and non-goals, and further work goes in a new item. The review reports a replaced command as a fix finding unless the evidence shows it can't pass on any correct result (malformed, or needing the result committed) and its replacement proves what it proved (#2107). Factory applies the rule itself before it checks a round: each started item keeps the accepted spec, with every owned path and dependency it had plus those the answer adds, and a reworked reattempt item takes the answer's validation when it replaces only those commands, and its acceptance, brief and non-goals. Every other change to it is set back, in the round's answer and draft (a round whose draft was set back beyond its answer, as for a plan with no answer of its own, keeps no answer, so what comes next answers in full), and the fields set back are kept with the round (`restored`), logged (`amendment-restored`), shown to its review (`FACTORY_AMENDMENT`'s `restoredFields`), which still finds a started item left with acceptance or validation it can't meet, and, when the round goes back, told to the planner.

- **Obligations are proved at owner level.** A covered Objective criterion or source exit item names its owner and proof kind. For item or QA review, the owner's review judges the obligation itself, with the owner's acceptance as a whole as its proof. No proof points at a single acceptance entry. Code still checks that each obligation has exactly one owner, the owner exists and the proof kind fits the owner. In an amendment, an already-reviewed item keeps only the semantic proofs it had; a newly assigned obligation needs final review or new work.

## Engineering standard

Workers and Work Item result review share one short code-quality bar, `ENGINEERING_STANDARD` in the same file: precise types without escaping casts, reuse instead of copies, decisions on error codes rather than message text, no swallowed errors, exact-value test assertions, docs that match the code, no leftovers, validation once at the boundary, and narrowly scoped configuration changes.

Why: these are the failures a senior reviewer flags first, and acceptance criteria rarely name them, so a result could pass every criterion and still need cleanup.

The worker gets the standard before its self-review. Result review refuses a violation in code the result adds or changes, filed under the criterion whose code contains it, even when every criterion passes. Unchanged existing code is not a finding. Where the target's AGENTS.md or documented conventions differ, the target wins. Final Objective review does not re-apply it.

## Plan checks

When Factory checks something deterministically, it gives the model the facts it checks against, and every refusal says what would pass. The planner request lists the exact authorized validation commands (computed by the function the check uses), the CI-only commands and the validation environment; a refusal names the allowed alternatives or the exact fix, with long lists bounded. A new plan check ships with its facts in the request and an actionable refusal, and runs from `checkPlan` in `src/planning/checks.ts`; its facts come from `src/planning/facts.ts`.

**Commands.** Factory reads no command from an Objective's text. The planner writes every validation command, and a criterion that requires a command to pass is proved by running that command unchanged on the integrated result, in a QA item; plan review checks it. The plan check refuses only a command that can't run: CI-only, reaching a network validation lacks, or checking only a directory its item doesn't own. Final commands are the installation's `finalValidation.requiredCommands`. The service checks a queued Objective at once, whether or not a slot is free ([Check at queue time](reference/queue.md#check-at-queue-time)): a problem holds with its fix, and `recheck` checks the edited issue again, so a bad Objective is caught before it takes a slot.

Why: a planner that must guess what Factory accepts spends revision rounds finding it.

## Design checklist

Workers and result review also share `DESIGN_CHECKLIST`: six questions about design risks that criteria rarely name and passing tests do not reveal. Authority: each new action has the narrowest grant that fits it. Growth: new stored state has an enforced bound or retention. Attribution: a recorded actor is the principal that acted. Hot path: per-request paths gain no avoidable work. Test independence: a reference test's expected side does not run the code under test. Sourced numbers: each new limit names its origin.

The worker answers each question in a `design` note in `.factory-handoff.json` before writing code, with `designRisk` naming the question, and updates the answer with file:line evidence before finishing. Where the target's AGENTS.md, or a document it maps, declares its own design checklist, the worker answers it in one more note with `designRisk: "repository"`; it adds to the generic questions. Result review verifies each answer against the code and refuses the criterion whose implementation contains a design defect, with or without a note. Design notes, like verification notes, index one result's review: other workers and repository memory do not receive them.

The planner sees the repository's checklist too. Where one is declared, each brief carries a short answer per question, so the worker's notes start from a design settled at plan level. Why: the checklist reached only workers and result review, so plans never applied it.

## Example

An Objective asks for a retention limit on a job queue.

**Before (excerpts from a 23-entry item):**

- `JobStore.prune()` in `store.ts` deletes expired rows in one statement and returns a frozen array of removed ids. ← mechanism
- Refuses `retention: null` at `config.queue.retention` with `ConfigError`. Refuses a non-number. Refuses a negative number. ← one entry per field path
- The comment on `store.ts` line 88 names the new limit. ← line number
- Existing tests and golden files are unchanged. ← test prose
- Brief: "Start by reading `store.ts` (around lines 40–210) and `config.ts` (around line 130)." ← reading list

**After (6 entries):**

Goal: finished jobs older than the configured retention are removed from the queue.

Contract: the queue configuration accepts an optional `retention` (a duration). Without it, behaviour and the stored format are exactly as today.

Acceptance:

1. A finished job older than the retention is no longer listed or returned after the next prune.
2. A finished job inside the retention, and every unfinished job, is kept.
3. A malformed retention (null, not a duration, negative) is refused through the existing configuration validation.
4. Invariant: the same jobs remain whether pruning runs once or in several smaller steps.
5. Without `retention`, the queue lists and stores exactly what it does today.
6. The configuration reference documents `retention` and its default.

Evidence: new tests in the repository suite prove 1–5; the full existing suite passes.
Constraints: no new storage dependency.
Docs: the configuration reference, where the doc map puts it.

The worker reads the code and decides which function prunes, how removal is batched and which error path reports a bad value.
