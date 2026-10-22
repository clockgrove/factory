# Plan standard

A plan says **what** must be true when the work is done, and **what other items rely on**. The worker decides **how** from the real code, and result review checks the how against that code.

Why: a planner writes every detail from a partial read of the repository. Each mechanism, line number or edit list it adds can contradict the real code, and then becomes a review finding or blocks the worker on wording. Precise plans with 40 or more acceptance entries per item needed far more revision rounds than outcome-level plans.

The rules live in `src/compiler/work-item-rubric.ts`. The planner and the graph reviewer read the same Work Item standard. The reviewer applies the full checklist; the planner gets a short checklist of its plan-shaping judgments, quoted from the same text, without the review-packet mechanics.

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

**New identifiers are the worker's.** Acceptance and briefs name only identifiers that exist at the base. A new type, endpoint path, migration number, file or test name is described by role and data, unless the Objective or a pinned source fixes it.

**Size:** one outcome per item. About 15 acceptance entries is a signal, not a target: above it, split the item or say in its brief why it is one outcome.

**Briefs** carry settled decisions and cross-item contracts the worker cannot get from the repository. Workers read the code themselves.

**Ownership is narrow.** An item owns the files its change needs, not a whole source tree or shared folder. A shared file (index, contracts barrel, router, docs map) has one owner, and the items that need its change depend on that owner; consumers of a shared layer then run in parallel.

**Edges follow interfaces.** A dependency points to the item that owns the exact interface needed; independent sub-surfaces of one upstream item run in parallel, so split the upstream item there. Coverage proofs are spread over the items that own each claim: graph review flags one item whose single command proves more than half of the Objective's criteria.

**No silent deferral.** Where proof needs an environment local validation lacks, the planner asks through `decisionRequired` instead of leaving it to final review or hosted CI.

**Existing tests are protected by default.** An item changes an existing assertion, golden or baseline only when its acceptance states that behaviour change and why.

**Generated values need a producing command.** The planner and graph reviewer are told what the configured workers can execute, from the worker harness kind: Codex workers have a sandboxed shell; Claude and Copilot workers run only the item's authorized validation commands and checkout file tools. Where a shell-less worker must commit values only running code produces (hashes, snapshots, goldens, generated files), an authorized command produces them or reports the actual values, or an item it depends on delivers that capability; otherwise review flags the item. A check that writes the actual values to a Git-ignored file under the item's owned paths is a valid producing command: Validate copies that file back to the worker's checkout.

## How the planner works

1. **Research.** Explore wide, then narrow. Collect facts tied to files: conventions, real producers and types, existing behaviour, constraints. These facts stay in the planning session; Factory never stores them.
2. **Write** the plan from the Objective and those facts only.
3. **Check** the plan against the short checklist of the reviewer's plan-shaping judgments before submitting.

All three happen in the planner's one session. Self-checking is a filter; the independent graph review stays the gate.

## How review holds the standard

- **Graph review:** an acceptance entry that prescribes a mechanism, a line or a file edit instead of behaviour is a fix finding. Review never asks for more detail than the standard requires.
- **Consistent acceptance.** Graph review reads each item's acceptance entries against each other, its brief and the Objective's constraints, non-goals and operator decisions. A contradiction, such as one entry capping what another requires to hold independently of that cap, or an entry no implementation can meet together with the others, is a fix finding. Why: such a plan passes review and then fails every worker attempt.
- **Sourced numbers.** Every numeric limit, budget, retry count or timeout in a plan comes from a pinned source, the repository or an operator decision. Otherwise the item states the property the value protects and leaves the value to the worker; a value users would observe is an operator decision. Why: an invented number reads as a requirement and binds the worker and reviewer to it.
- **Result review** judges behaviour. It does not refuse a criterion because the code reaches the stated behaviour another way than a plan happened to describe. It refuses an unannounced change to an existing test.
- **Lint before review.** Before any paid review, Factory refuses:
  - an item with more than 15 acceptance entries and no `oneOutcomeReason`;
  - an acceptance entry that cites a line number next to a source file name;
  - two items that own the same or overlapping paths when neither depends on the other, directly or transitively. Why: the scheduler would run them one after the other anyway, and wide shared ownership turns a plan into a serial chain;
  - when the plan selects any validation command (so the repository has one), a work item without a validation command, and a criterion proved only by final review or CI whose owner runs none. Why: final review and hosted CI run nothing inside Factory validation;
  - a validation command whose script (from the base `package.json`) invokes a known network tool, on an item that owns no infrastructure paths. Why: validation has no network, so the command could never pass. Commands the installation lists as CI-only are refused for every item;
  - acceptance that names a migration file number or test file name absent from the base tree. Why: the worker chooses new file names.

  The planner gets all of these as one correction. Amendments skip this lint; graph review judges them.

- **Obligations are proved at owner level.** A covered Objective criterion or source exit item names its owner and proof kind. For item or QA review, the owner's review judges the obligation itself, with the owner's acceptance as a whole as its proof. No proof points at a single acceptance entry. Code still checks that each obligation has exactly one owner, the owner exists and the proof kind fits the owner. In an amendment, an already-reviewed item keeps only the semantic proofs it had; a newly assigned obligation needs final review or new work.

## Engineering standard

Workers and Work Item result review share one short code-quality bar, `ENGINEERING_STANDARD` in the same file: precise types without escaping casts, reuse instead of copies, decisions on error codes rather than message text, no swallowed errors, exact-value test assertions, docs that match the code, no leftovers, validation once at the boundary, and narrowly scoped configuration changes.

Why: these are the failures a senior reviewer flags first, and acceptance criteria rarely name them, so a result could pass every criterion and still need cleanup.

The worker gets the standard before its self-review. Result review refuses a violation in code the result adds or changes, filed under the criterion whose code contains it, even when every criterion passes. Unchanged existing code is not a finding. Where the target's AGENTS.md or documented conventions differ, the target wins. Final Objective review does not re-apply it.

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
