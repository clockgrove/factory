/**
 * The plan standard (docs/PLANNING.md): a plan says what must be true and what
 * other items rely on; the worker decides how from the real code. Model
 * guidance only: code checks the plan's structure, never this prose.
 */

/** What a configured worker can execute. */
export type WorkerCommandAccess = "shell" | "validation-only" | "undeclared";

/**
 * Acceptance entries above which an item states why it is one outcome. A
 * signal, not a target: precise plans with 40-64 entries per item drew most
 * review findings, because each detail written from a partial read can
 * contradict the real code.
 */
export const WORK_ITEM_ENTRY_SIGNAL = 15;

/** Shared by the planner and the graph reviewer. */
export const QA_EVIDENCE_GUIDANCE =
  "Read-only QA has no implementation turn or interpreter for brief prose: it executes only declared validation commands and named CI checks. Required dependency inspection and runtime artifacts need complete supplied source or an explicitly selected validation-evidence mechanism. A brief promising inspection or retention does not execute it. A passing cacheable command does not by itself establish fresh execution or missing runtime facts; absent proof remains unavailable.";

/** One phrase per worker command access; the shell-less phrase is what the planner must plan around. */
const COMMAND_ACCESS: Record<WorkerCommandAccess, string> = {
  shell:
    "have a sandboxed shell: besides the item's validation commands, they can run commands in the checkout.",
  "validation-only":
    "cannot run arbitrary commands: they run only the item's validation commands and read and write files in the checkout.",
  undeclared:
    "use an adapter that declares no shell, so plan as if they cannot run arbitrary commands: they run only the item's validation commands and read and write files in the checkout.",
};

/** What the configured workers can execute, shown to the planner and the graph reviewer. */
export function workerCapability(
  access: Readonly<Record<string, WorkerCommandAccess>>,
): string {
  const groups = new Map<WorkerCommandAccess, string[]>();
  for (const [profile, kind] of Object.entries(access))
    groups.set(kind, [...(groups.get(kind) ?? []), profile]);
  if (groups.size === 1)
    return `Worker capability. Workers ${COMMAND_ACCESS[[...groups.keys()][0]!]}`;
  return `Worker capability, by execution profile. ${[...groups]
    .map(
      ([kind, profiles]) =>
        `Workers on profile${profiles.length > 1 ? "s" : ""} ${profiles.join(", ")} ${COMMAND_ACCESS[kind]}`,
    )
    .join(" ")}`;
}

/** Validation's network under `sandbox.network: host`, as the planner and the graph reviewer read it. */
export const HOST_VALIDATION_NETWORK =
  "the host's network (sandbox.network host)";

/** The Validation line's network rule: what a validation command can reach. */
function validationNetworkRule(hostNetwork: boolean): string {
  return hostNetwork
    ? `Validation has ${HOST_VALIDATION_NETWORK}, including services on its loopback, so a command that reaches the network may run in it.`
    : "A script that runs a network tool (an init, install, fetch or audit) fails in validation, which has no network: never select one.";
}

/** What every Work Item contains and leaves out; shared by the planner and the graph reviewer. */
export function workItemStandard(hostNetwork: boolean): string {
  return `Work Item standard. A plan says what must be true when the work is done and what other items rely on. The worker decides how from the real code, and its result reviewer checks the result against that code. A result is reviewed only against its own item's fields, so each item is complete and checkable on its own.
A Work Item has:
- Goal: one sentence, the outcome.
- Contract: only what other items or users rely on (names, semantics, formats), stated once in the brief. Settle it up front, choosing a coherent contract where the sources leave the architecture open, and give it to each consumer's brief too: workers never see sibling briefs.
- Acceptance: observable behaviour, invariants and refusal classes at the contract level. Each entry is one behaviour, checkable from outside the code, naming the public names, commands or inputs it concerns.
- Evidence: the repository tests or commands that prove the acceptance, run by the item's validation. Every acceptance entry has local executable evidence: one of the item's validation commands, or a test the item owns that one of them runs. Final review and hosted or post-publication CI run nothing in Factory validation, so they are never the only proof; where proof truly needs an environment local validation lacks, ask through decisionRequired instead of deferring it. A prose claim, an unchecked summary file or a manual inspection is not evidence.
- Validation: the commands this item's owned paths affect, plus the repository's standard check command when it declares one (for example a check or test script its AGENTS.md or CI names). Never copy every declared script onto every item. ${validationNetworkRule(hostNetwork)}
- Constraints: what must not change or must not be used, from the Objective or the repository's rules, as non-goals.
- Docs: what a reader needs documented, where the repository's AGENTS.md doc map or documented conventions put it (otherwise an existing docs/ location). A package README changes only for a user-facing usage change.
- Design note: where the repository's AGENTS.md, a document it maps or a pinned source declares a design checklist, the brief answers each of its questions for this item in a short line (the settled decision or "not applicable" with the reason), so the worker and its reviewer start from the same design. Cite the checklist.
A Work Item never contains internal mechanisms (which function does what, a helper to add, where data is frozen or stored), line numbers or ranges, file-by-file edit lists, names for new internal symbols, classes or tests, test prose, reading lists, one entry per malformed field or error path, prose that existing tests stay unchanged, or restated source text. Each is written from a partial read, goes stale against the real code, and then blocks the worker or the review on wording.
Identifiers: acceptance and briefs (not ownedPaths, which name each file literally) name only identifiers that already exist at the base (types, endpoints, files, commands, tests). A new type, endpoint path, migration number or file or test name is described by its role and data, and the worker chooses it, unless the Objective or a pinned source fixes it. A consumer learns a producer's new name from its dependency's result, not from a plan that guessed it.
Keep these, because they raise result quality:
- invariants that must hold across inputs or steps (step-size, ordering or aggregation independence, determinism), each naming what varies, with every budget or state rule the invariant depends on stated in the contract;
- consuming the real upstream producer, named by its type, never a restated schema;
- reusing the repository's existing helpers, types and conventions, named by name;
- for a total or never-throws contract, malformed input kept apart from internal defects: a catch-all that reports every error as invalid input does not meet it.
Existing tests are protected by default: an item changes an existing assertion, golden or baseline only when its acceptance states that behaviour change and why, and an exact-membership list grows by exactly the item's additions.
Generated values: a worker that cannot run arbitrary commands learns only from its validation output and the checkout. Where an item must commit values only running code produces (hashes, snapshots, goldens, generated files), one of its validation commands produces them, or reports the actual values in its output or in a Git-ignored file under the item's owned paths, which comes back to the checkout; otherwise the worker cannot learn what to commit. If no command does, plan that capability in the item that owns the harness or tool (for example, the check reports the actual value on mismatch, or a generator writes the file), and have dependent items consume it.
Size: one outcome per item. Split by independently verifiable capability, never by layer; each item includes its own tests and docs. About ${WORK_ITEM_ENTRY_SIGNAL} acceptance entries is a signal, not a target: above it, split the item or state why it is one outcome (Factory adds the reason to the brief).`;
}

/** The planner's job, how it works, and the rules for its output fields. */
export function workItemPlanningRules(hostNetwork: boolean): string {
  return `Compile this Objective into Work Items. The Objective is short prose: a goal, observable outcomes (its Acceptance), context, optional pinned Sources and constraints. It does not specify Work Items, their criteria, ownership or evidence: you plan those from the Objective, the pinned sources and the repository. The default join is QA validation on the integrated result and one independent final Objective review.
How to work (guidance, not a script):
- Research first. Explore wide, then narrow, until you know what the plan rests on: the repository's conventions, the real producers and types the work consumes, the existing behaviour it changes and the constraints that apply. Tie each fact to the file it came from. These facts stay in this session; they are not part of your answer.
- Then write the plan from the Objective and those facts only. Where you have not read something, state the outcome and leave the how to the worker, who reads the code.
- Before submitting, check the plan against the checklist below, the judgments the graph reviewer will apply, and fix what it would flag.
${workItemStandard(hostNetwork)}
Rules for the plan as a whole:
1. Grouping. Worker and review cost grow faster than an item, while separate items can run concurrently. Dependency edges go to the item that owns the exact interface needed, and independent sub-surfaces run in parallel: when an item needs one sub-surface of an upstream item, split the upstream item there. Spread coverage proofs across the items that own each claim, so no single test carries every criterion. Still keep cohesive work in one item when handoff, preparation, validation and review cost more than the overlap saves; configured concurrency is a ceiling, not a target. A settled contract needs no dependency: depend only on changed outputs, artifacts or preparation a consumer actually needs, and do not serialize independent work for a combined later check. Plan within the repository's documented budgets and layout rules; where an addition could exceed one, plan the structural change in the owning item.
2. Product questions. When the Objective leaves a product or authority choice open (semantics a user can observe, what a policy means, a public interface, scope), do not decide it silently. Set decisionRequired to the obligation the choice affects with a question that states the specific choice, your recommendation and the consequences of each option, and still return your best graph built on that recommendation; Factory asks the operator before using it, and the answer arrives as an operator finding. A criterion the Objective as written forbids covering is also a decision. Choosing fixture or test values the sources call policy, internal names, file layout and other implementation details is your job, not a product question. Set decisionRequired to null when no such choice is open. Never encode a decision as a missing environment.
3. Source obligations. The source sections the Objective pins under Sources can state exit items beyond the Acceptance outcomes: deliverables, behaviours, proofs or listed assertions the delivered result must meet. List every one in sourceObligations, located by its exact lines, and either cover it like an Acceptance criterion or mark it out of scope with a reason citing the Objective's constraints or out-of-scope lines; never skip one silently. Descriptive, background and how-to text is context, not an exit item, and an exit item an Acceptance criterion already states fully needs no entry. AGENTS.md, README.md and the Objective itself are not such sections unless the Objective lists them, and neither are repository files you read or cite as worker inputs: sourceIndex always names a pinned source. Return [] only when the cited sections state no exit items. When whether an exit item is in scope is a product choice the Objective leaves open, use rule 2.`;
}

/** What the graph reviewer judges, and why. */
export const GRAPH_REVIEW_INTRO =
  "Independently review this complete proposed Factory plan against the exact pinned Objective and sources. The Objective is short prose (goal, observable outcomes, context, constraints); the planner owns the plan: Work Item decomposition, acceptance criteria, evidence, ownership and validation, held to the Work Item standard below. Decide whether carrying out this plan would deliver the Objective, and whether each Work Item's contract lets its worker deliver it and its result reviewer check it, since that reviewer judges the result only against the item's own fields. Report only material defects: problems that would make the delivered result fail the Objective, break the repository, leave work impossible to complete or verify, or materially prevent justified parallel execution. Item count alone is not a defect.";

/*
 * Plan-shaping judgments. Each is quoted verbatim in the reviewer's numbered
 * checks and in the planner's short checklist, so the two cannot drift.
 */
/** Check 1: every criterion has an owner and a producible proof. */
const COVERAGE = `Every Objective acceptance criterion has one owner and a proof the plan can actually produce: an item or QA validation command, item or QA review, a required CI check, or final review. A criterion proved by final review or a CI check still has an owner whose validation commands prove it locally; Factory refuses one whose owner runs none.`;

/** Check 1: pinned-source exit items are obligations too. */
const SOURCE_OBLIGATIONS =
  "Exit items in the source sections the Objective pins under Sources are obligations too: coverage entries with source lines and a statement prove them, and sourceExclusions leave them out of scope with a reason citing Objective lines.";

/** Check 3: ownership that lets independent items run concurrently. */
const OWNERSHIP =
  "Owned paths are as narrow as the change needs: files, or a directory only when the item creates or changes most of it, never a whole source tree or a shared folder for one file. A shared file (index, contracts barrel, router, registry, manifest, docs map) has exactly one owner, and every other item that needs its change depends on that owner. Where a shared layer (contracts, schema) must land first, one item owns it and the items consuming it depend on it and run in parallel with each other. Factory refuses two items that own the same or overlapping paths unless one depends on the other.";

/** Check 3: one outcome per item. */
const ONE_OUTCOME =
  "Items split by independently verifiable capability, never by layer, and each includes its own tests and documentation. Flag an item that delivers more than one outcome, naming the outcomes to split it into; settled shared interfaces, data meanings and files do not make one outcome.";

/** Check 4: when an item's acceptance is judged. */
const PHASES =
  "An item's acceptance is judged after its own validation and before its own delivery, LFS upload, publication, merge and hydration, so it cannot require its own merge, later items, or the final Objective validation; a native-stack dependency is not yet merged when its dependent runs. Full cross-component obligations normally belong to QA commands on the integrated result and final review.";

/** Check 7: required proof modes. */
const PROOF_MODES =
  "A source-required negative control is planned, and a test the worker writes is not by itself proof of that control or of a golden or baseline change. Golden or baseline changes need source authority, and real-system evidence is not replaced by mocks.";

/** Check 8: acceptance is behaviour with named evidence. */
const BEHAVIOUR_FINDINGS =
  "an acceptance entry that prescribes a mechanism, a line or line range, or a file edit instead of behaviour (name the behaviour it should state); an entry bundling unrelated behaviours; an outcome without the repository's executable evidence";

/** Check 10: the choices the operator owns. */
const OPEN_CHOICE =
  "a product or authority choice the Objective leaves open (semantics a user can observe, what a policy means, a public interface, scope)";

/**
 * Check 8: the new-identifier rule stops at ownedPaths. A reviewer that
 * applied it there refused a new test file as an invented name and `test/`
 * as too broad, which left a planned test no valid owner (#2108).
 */
export const OWNED_NEW_FILES =
  'The rule is for acceptance and briefs, not ownedPaths: an item owns each new file it creates, a new test file included, by the literal path the planner chooses for it, or by a directory prefix ending in "/" where the ownership rule allows one, and neither is a new-identifier finding.';

/** Check 8: the worker names what is new. */
const NEW_IDENTIFIERS = `Flag acceptance or a brief that names a NEW identifier (a type, endpoint path, migration number, file or test name) the Objective and sources do not fix: describe it by role and data and leave the name to the worker. Existing identifiers at the base may be named. ${OWNED_NEW_FILES}`;

/** Check 3: dependency edges follow the interface needed. */
const INTERFACE_EDGES =
  "A dependency edge points to the item that owns the exact interface the dependent needs, and independent sub-surfaces of one upstream item run in parallel: flag an item that waits on a whole upstream item when it needs only one sub-surface, or a plan that is serial where the interfaces are independent; split the upstream item at that interface.";

/** Check 1: proofs are spread over their owners. */
const PROOF_SPREAD =
  "Spread coverage proofs across the items that own each claim: flag a criterion-to-proof mapping where one item's single command proves more than half of the Objective's criteria.";

/** Check 8: cross-item contracts. */
const CONTRACT_ONCE =
  "A contract other items rely on (names, semantics, formats) is stated once and is in each consumer's brief, because workers never see sibling briefs.";

/** Check 8: cross-item consistency. */
const CROSS_ITEM =
  "One item's change must not break what another item relies on or protects (its contract, invariants or protected tests): flag such a conflict, naming both items.";

/** Check 8: an item's acceptance can be met as a whole. */
const ACCEPTANCE_CONSISTENCY =
  "Read each item's acceptance entries against each other, its brief and the Objective's constraints, non-goals and operator decisions. Flag a contradiction, such as one entry capping what another entry or the brief requires to hold independently of that cap, and an entry no implementation can satisfy together with the others, naming the conflicting entries and stating which one must change.";

/** Check 8: every number in a plan has an origin. */
const SOURCED_NUMBERS =
  "Every numeric limit, budget, retry count, timeout or threshold in a plan comes from a pinned source, the repository's code or documentation, or an operator decision. Flag one with no such origin: the item either cites where the value comes from, or states the property the value protects (for example, retries are bounded) and leaves the value to the worker; a value users would observe is an open choice (check 10).";

/** Check 8: claims about existing code. */
const CODE_CLAIMS =
  "Claims about existing code (names, types, behaviour, conventions) rest on what was read: flag one the repository contradicts; where the code was not read, the item states the outcome and leaves the how to the worker.";

/** Check 8: a shell-less worker can learn generated values only from its commands. */
const GENERATED_VALUES =
  "Flag an item whose worker cannot run arbitrary commands but must commit values only running code produces (hashes, snapshots, goldens, generated files), when none of its validation commands produces them or reports the actual values in its output or in a Git-ignored file under the item's owned paths and no item it depends on delivers that capability: its worker cannot learn what to commit.";

/** Check 3: durable data needs storage the item owns. */
const STORAGE_OWNERSHIP =
  "Storage that new durable data (a new table or persisted record) needs is owned by the item, with the module that writes the data, or by an item it depends on.";

/** Check 5: a work item's directory-scoped command follows its owned paths (checks.ts `boundaryFindings`). */
const VALIDATION_OWNERSHIP =
  "On a work item, a validation command whose package script body works in one directory (it starts with `cd DIR &&`, or is one command naming DIR after --prefix, --dir or -C) needs the item to own a path in that directory; Factory refuses one that doesn't. A read-only QA item owns no paths by design: its commands check the integrated result of the items it depends on, so it is never flagged for owning no paths or for running a whole-repository command.";

/**
 * Check 5: a validation command checks the result's files, never Git's
 * record of them (#2107). The worker's checkout holds its change
 * uncommitted, and selected media only once Factory writes them; Factory
 * validates a commit it makes, with every Git LFS file's real bytes
 * restored (validate.ts, media.ts `hydrateTree`).
 */
const UNCOMMITTED_RESULT =
  "Validation runs on the uncommitted result. The worker writes and runs an item's validation commands in its checkout, where its change is not committed and selected media are not yet there; Factory runs them in a fresh checkout of a commit it makes of the result. So what HEAD, the index and the history hold differs between those runs, and every Git LFS file holds its real bytes, never its pointer. A command, and every test it runs, checks the files in the working tree and must not depend on the result being committed: flag one that does, such as `git show HEAD:<new file>`, `git log` or `git diff HEAD` to find the change, `git ls-files` or `git lfs ls-files` of a path the item adds, or a test that reads a Git LFS file expecting its pointer text. A Work Item's base-relative check that compares the working tree with $FACTORY_BASE_SHA does not depend on it, though in the worker's checkout `git diff` leaves out files the change adds. Flag a command its tool can't run as written, too, such as `git lfs ls-files -- <path> <path>`: `git lfs ls-files` reads its arguments as revisions, not paths. Either fails whatever the result holds, and a started item's commands can be replaced only through an amendment. Git LFS storage of selected media is a Factory controller guarantee (selected-set-materialization): an item checks that a destination is routed through Git LFS from the output of `git check-attr filter -- <path>`, which must name `lfs` (the command exits zero for an unrouted path too, so it proves nothing alone), never by reading pointers.";

/** Check 9: candidate media sets are offered for choice; only the selection is delivered. */
const CANDIDATE_SETS =
  "Candidate media sets are alternatives the operator chooses from: Factory validates, reviews and delivers only the selected set, and unselected sets are never committed or validated. An item with candidate sets states its alternatives as offered (how many, each complete with its roles, how they should differ) and its repository checks (format, content, tests) about the delivered selection at its destinations. Flag a criterion that requires each or every candidate, or an unselected alternative, to pass validation, tests or repository checks: no result can prove it.";

/** Check 1: safety claims need local proof that names them. */
const SAFETY_PROOF =
  "A privacy, authority (authorization, permission) or accessibility criterion is proved by a command: the owner delivers a test that names the claim, and a validation command that runs it is the criterion's proof; flag one proved only by review judgement, CI or a whole-suite command.";

/** The numbered rubric; checks 1-9 are fix findings (except an open source scope question in check 1), check 10 is an operator decision. */
export const GRAPH_REVIEW_CHECKS = `Check:
1. Acceptance coverage. ${COVERAGE} Item or QA review judges the obligation itself on the owner's result, so check that the owner's acceptance as a whole delivers it; it names no acceptance entry. ${PROOF_SPREAD} ${SAFETY_PROOF} Check that each proof kind fits its criterion's wording. A criterion that requires a command to pass ("\`npm test\` passes", or a command the Objective says the result must pass) is proved by running that exact command, unchanged, on the integrated result: a read-only QA item that depends on every item the command covers and runs it as its validation. Flag a missing, altered, split or weaker command as a fix finding. A command in the installation's CI-only list never runs in validation: it is proved by an integrated-ci proof of a CI check that runs it, or it is an operator decision; never a fix finding asking the plan to run it. ${SOURCE_OBLIGATIONS} Factory has checked only their structure (line ranges exist in the pinned sources and do not overlap; owners and commands exist; cited Objective lines exist). Judge fidelity: flag an exit item a cited section states that neither an entry nor an Objective criterion captures, a statement that drops or weakens a clause of its lines, a proof that cannot show it, or an exclusion whose reason does not follow from the Objective text it cites. Descriptive, background and how-to text in a cited section is context for building the work, not an exit item, so do not demand that the plan restate every clause of a document. Whether an exit item is in scope, when the Objective leaves that open, is an operator decision.
2. Constraints and scope. Briefs and ownership respect the Objective's constraints and non-goals, and the plan does not add unrequested scope.
3. Decomposition and ownership. ${ONE_OUTCOME} ${INTERFACE_EDGES} An item above about ${WORK_ITEM_ENTRY_SIGNAL} acceptance entries needs a brief that says why it is one outcome; entry count alone is not a defect. Every file the work must create or change has an owner, using literal paths or directory prefixes ending in "/". ${OWNERSHIP} Flag ownership wider than an item's change when it serializes items that could otherwise run in parallel. ${STORAGE_OWNERSHIP} An item depends on actual required outputs, not a shared contract already settled in supplied briefs or a later combined check. Flag avoidable serialization only with concrete independent outputs and useful concurrency within the configured bound; a small cohesive single item is valid when splitting adds no useful benefit.
4. Phases. ${PHASES} Do not require a component's acceptance to prove an unfinished sibling's behavior; preserve every original end-to-end obligation with its actual required evidence at the final phase. Final-review coverage on an implementation owner is valid when final validation and supplied current evidence can prove that obligation. A downstream implementation item must need actual completed peer outputs; QA must supply named required evidence or material-risk proof absent from final validation/review, including source-required late named CI. Do not demand a generic tests/docs phase or duplicate integrated semantic review.
5. Commands. The plan writes its validation commands; any command line may run. Judge whether each proves what its item claims. They must terminate deterministically with exit zero on success and cleanup of owned resources. Flag a bare persistent service launch used as validation even when its brief promises managed startup/shutdown; executable lifecycle proof needs a finite harness. Judge semantics, not command names. ${UNCOMMITTED_RESULT} ${VALIDATION_OWNERSHIP} Preserve source-required launch documentation and actual startup/request/shutdown proof; a required nonterminating acceptance command needs a source decision, not a dropped requirement. Environment prerequisites select only exact preimplementation setup explicitly needed by the readiness probe, before that probe in the owner's validation order; a null probe has no selected setup. Check the selected setup/probe sequence can run in preflight and the actual worker checkout before provider dispatch, preserving prerequisite dependencies; each fresh result/final validation checkout needs its setup before its own phase checks. Ignored installations do not prove fresh readiness. Commands needing the new implementation belong to semantic acceptance, and setup cannot replace it. Missing or unsupported setup remains an unresolved source decision. Required CI checks that must pass before merging are listed as pre-integration checks. A source-required check missing from the known CI check names is an unresolved source decision: ask the operator. ${QA_EVIDENCE_GUIDANCE}
6. Briefs. A worker receives its item fields and pinned inputSources, and works in a full checkout of the repository, so it can read AGENTS.md, documentation and code itself. A brief carries settled decisions and cross-item contracts the worker cannot get from the repository. Flag a brief only when it depends on information that exists solely in this review's inputs (for example an exact interface given only in the Objective) and is not in its fields or inputSources; never ask for reading lists, file lists or implementation steps.
7. Proof modes. ${PROOF_MODES} Check architecture-derived proof responsibilities against the stated flows; for selection-dependent asynchronous work, a proposed happy-path check alone does not address material stale-completion risks. Keep verification within the Objective's and pinned sources' required scope and proof modes; flag unrequested stronger obligations, including mandatory browser causal interleavings where meaningful real journeys with production component/source proof are permitted. Preserve explicitly required execution layers, orderings and negative controls. Do not require a particular API/framework, extra Work Item or checklist. Component-authored combined tests may execute only after integration, provided their full required runtime evidence is supplied to final review and the component's own acceptance makes no premature passing claim.
8. Work Item contracts. Each item meets the Work Item standard above. Fix findings: ${BEHAVIOUR_FINDINGS}; ${NEW_IDENTIFIERS} Also flag acceptance that only enumerates cases where the sources or conventions imply invariants, real-producer input or shared helpers to reuse; semantics that contradict a stated invariant or the real producer's actual type (a budget or state rule that breaks when inputs or steps are split, a restated input schema, a total criterion a catch-all would meet); an existing assertion, golden or baseline changed without stating the behaviour change and why. ${CONTRACT_ONCE} ${CROSS_ITEM} ${ACCEPTANCE_CONSISTENCY} ${SOURCED_NUMBERS} ${CODE_CLAIMS} ${GENERATED_VALUES} The plan stays within the repository's documented budgets and conventions (size bounds, layout rules), planning the structural change where an addition could exceed one. Flag a contract only where the gap would let a worker deliver the wrong result or leave the result reviewer unable to check it, and state the exact entries to change. Never ask for more detail than the standard requires: no entry per field or error path, no prose that existing tests stay unchanged.
9. Repository-checkable criteria. Item criteria state facts checkable in the target repository's result. Flag a criterion that restates a Factory controller guarantee (review, publication, integration, LFS upload, hydration), because the result reviewer cannot check it there, and a plan that grants deployment, service or retry authority or weakens the Objective's acceptance. ${CANDIDATE_SETS}
10. Open product decisions. When the plan silently decides ${OPEN_CHOICE}, report it as an operator-decision finding whose question states the specific choice, recommends the plan's choice when it is sound and gives the consequences of each option. Fixture or test values the sources call policy, internal names and file layout are the planner's choice: never an operator question.

Examples: do not flag a brief for omitting an API that its complete inputSources already supply. Do flag a required negative control with no planned evidence, a source-required CI check absent from the known check names, or an acceptance entry such as "parseConfig returns a frozen copy (config.ts line 120)" that prescribes a mechanism and a line: ask for the behaviour it protects, such as "a returned config cannot be changed by the caller". Cite the actual evidence and ask only for the unresolved decision; examples supply no new authority.`;

/**
 * The planner's self-check: the plan-shaping judgments of GRAPH_REVIEW_CHECKS,
 * quoted from the same constants, without the review mechanics.
 */
export const PLANNER_CHECKLIST = `Checklist: the graph reviewer applies these judgments, quoted from its own checks, to your plan. Where one says flag, fix the plan before submitting.
- Coverage. ${COVERAGE} ${SOURCE_OBLIGATIONS}
- One outcome. ${ONE_OUTCOME}
- Ownership. ${OWNERSHIP} ${STORAGE_OWNERSHIP}
- Validation follows ownership. ${VALIDATION_OWNERSHIP}
- Uncommitted result. ${UNCOMMITTED_RESULT}
- Safety claims. ${SAFETY_PROOF}
- Contracts. ${CONTRACT_ONCE}
- Acceptance is behaviour. Fix findings: ${BEHAVIOUR_FINDINGS}.
- New identifiers. ${NEW_IDENTIFIERS}
- Dependencies. ${INTERFACE_EDGES}
- Proof spread. ${PROOF_SPREAD}
- Consistency. ${CROSS_ITEM} ${ACCEPTANCE_CONSISTENCY}
- Sourced numbers. ${SOURCED_NUMBERS}
- Existing code. ${CODE_CLAIMS}
- Generated values. ${GENERATED_VALUES}
- Decisions. Never silently decide ${OPEN_CHOICE}: raise it as decisionRequired (rule 2).
- Phases. ${PHASES}
- Candidate sets. ${CANDIDATE_SETS}
- Proof modes. ${PROOF_MODES}`;

/** How findings are shaped; the caller appends the human-prerequisite guidance. */
export const GRAPH_REVIEW_FINDINGS =
  "Final commands are the installation's required final-validation commands, and no plan revision can add, drop or change them. A defect in them is never a fix finding; report it as an operator-decision asking the operator to correct the installation's required commands. If there is no material defect, return an empty findings array. Otherwise return one finding per defect, each naming the graph item ids it concerns (empty only for a defect in the plan as a whole), citing the evidence indices from the review packet it rests on (none when it rests only on item fields, which itemIds name) and stating what must change. Set each finding's kind: fix when the planner can correct the plan within the Objective and supplied sources (checks 1-9 and 11; it then receives the finding as a correction); operator-decision when the correction needs a product, scope or authority decision the Objective leaves to the operator (check 10, an open scope question about a source exit item under check 1, an unresolved source decision, or a defect in the Final commands), stated as a specific operator question (the operator is asked once the plan has no fix finding left; a review with both sends only its fixes to the planner, and the revised plan is reviewed again). Do not report observations, confirmations or speculative questions.";

/** A plan's first review: later rounds only verify its findings and the revision's changes. */
export const GRAPH_REVIEW_FIRST_ROUND =
  "This is the one full review of this plan: report every finding you can establish in this pass, grouped by item, because later rounds only verify these findings and review what each revision changes.";

/** A revision round: verify the last findings, review the change, and keep unchanged parts stable. */
export const GRAPH_REVIEW_REVISION_ROUND =
  "This is a revision round: the planner revised the plan for the previous review's findings below, and Factory's deterministic checks passed on the whole revised plan. (a) Report each previous finding again, with its kind, unless the revision resolved it. (b) Review the changed and added items, and whatever a change affects (dependencies, dependents, coverage, ownership, shared files), against every check. (c) On unchanged parts, report a new finding only if it would let a worker deliver a wrong result or make the Objective fail, or needs an operator decision under check 10; wording, style and \"could be more precise\" are not findings there.";

/** What the review of an amendment planner's cannotPlan judges (amendments.ts `amendReviewStep`). */
export const REFUSAL_REVIEW_INTRO =
  "Independently review a planner's refusal to amend the accepted Factory plan. A worker or the operator proposed further work: FACTORY_AMENDMENT in the review packet holds the discovery, the plan being amended as previousPlan, and the started-item rule with the items it binds; evidence rows of origin repository are the files the discovery names, as they read where it was proposed, and one with complete false holds a note saying why its body isn't supplied. The amendment's planner was asked for the changes to previousPlan that serve the discovery: it may add new Work Items for further work, which may depend on started items, and change existing items as the started-item rule allows. It answered cannotPlan instead, with the reason and the change below. Decide whether the refusal is right. The discovery is evidence from its worker or operator, not a new source of acceptance or authority. Judge the refusal's reason against the Objective, the pinned sources, the review packet and the repository, never from the planner's word alone.";

/** How a refusal review's findings are shaped. */
export const REFUSAL_REVIEW_FINDINGS =
  "If the refusal is right, because the obstacle it names is real and no amended plan within the rules the planner was given can serve the discovery, return an empty findings array: Factory then rejects the amendment with the planner's reason and asks the operator. Otherwise return a fix finding that names the rule or evidence that allows a plan (for example, the started-item rule lets a reattempt item's dependencies grow to wait for a new item that delivers what its own acceptance or validation needs) and outlines the plan it allows. Its itemIds name the previousPlan items that plan changes or that a new item depends on, and its evidenceIndices the rows it rests on. The planner receives it as a correction and plans the amendment again. Never report a finding whose plan the started-item rule refuses. When only the operator can decide whether a plan is allowed (a product, scope or authority choice the Objective leaves open), return an operator-decision finding whose question states that choice instead. Do not report observations, confirmations or speculative questions.";

/**
 * The code-quality bar every worker gets up front and every Work Item result
 * review enforces on changed code. Generic for any repository; the target's
 * own conventions win where they differ.
 */
export const ENGINEERING_STANDARD = `Engineering standard. Each rule names a defect a senior reviewer flags:
- Precise types: no casts that escape the type system (\`as unknown as\`, \`as any\`, a non-null assertion that silences an error); model data with the repository's types, not untyped records.
- Reuse: search for an existing helper before writing one. Never copy a function or test setup: import it, or move it to a shared module in your owned paths.
- Structure, not prose: decide on error types, codes or fields, never on message text.
- Handle or propagate every error; never swallow one (no empty catch).
- Tests assert exact values that fail if the behaviour changes: no presence or type checks, tautologies or a value compared with itself.
- Docs, comments and READMEs state only what the code does.
- No dead code, debug leftovers, placeholder assertions or unrelated changes.
- Validate input once at the boundary, with the repository's parsers and validators; do not re-check what a callee validates or hand-roll a parser.
- Scope configuration changes (timeouts, lint rules) to what needs them, never globally for one case.
Where the repository's AGENTS.md, documented conventions or CI checks differ, the repository wins.`;

/**
 * Design risks every worker answers and every Work Item result review checks:
 * defects acceptance criteria rarely name and passing tests do not reveal.
 * Each key is a design note's `designRisk`; the target's own design checklist
 * adds to these under `repository`.
 */
export const DESIGN_QUESTIONS = {
  authority:
    "Authority: each new action, command, endpoint or permission is gated by the narrowest grant that fits it, not by an existing broad grant that happens to cover it.",
  "state-growth":
    "Growth and retention: new stored state (tables, logs, caches, queues, files) has a bound or a retention rule, and code enforces it.",
  attribution:
    "Identity and attribution: every recorded actor, owner or author is the principal that actually acted, never an arbitrary, default or first-found one.",
  "hot-path":
    "Hot-path cost: per-request or per-item paths gain no avoidable work, such as an extra transaction, round trip, full scan or unbounded loop.",
  "test-independence":
    "Test independence: a parity, reference or golden test computes its expected side without running the code under test.",
  "sourced-numbers":
    "Sourced numbers: each numeric limit, budget, retry count or timeout the change adds comes from the item, a pinned source, the repository or an operator decision, and its origin is named.",
} as const;

/** A design note's risk: a generic question, or the repository's own checklist. */
export type DesignRisk = keyof typeof DESIGN_QUESTIONS | "repository";

/** Shared by the worker's design notes and the result reviewer's check of them. */
export const DESIGN_CHECKLIST = `Design checklist. One design note per question, its designRisk the key in brackets; "not applicable" with the reason is an answer:
${Object.entries(DESIGN_QUESTIONS)
  .map(([risk, question]) => `- [${risk}] ${question}`)
  .join("\n")}
Where the repository's AGENTS.md, or a document it maps, declares its own design checklist, answer its questions too in one note with designRisk "repository": it adds to these questions and never removes one.`;
