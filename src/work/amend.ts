import {
  failure,
  type Offer,
  type Outcome,
  type StepContext,
} from "../engine.js";
import { code } from "../markdown.js";
import {
  type AmendmentProposal,
  amendmentLedger,
  amendmentStatus,
  askedAgain,
  authorizationText,
  authorizeReplacement,
  discoveryText,
  itemAttempt,
  proposalProblems,
  REPLACE_VALIDATION,
  replaceValidationOption,
  type WorkDiscovery,
} from "../planning/amendments.js";
import { ACCEPTED_AT, currentPlan, proposalKey } from "../planning/plan.js";
import type { ValidationAuthorization, WorkItem } from "../planning/types.js";
import type { RepairFinding } from "../repair.js";
import type { Answer, HoldOption, ObjectiveState } from "../state.js";
import { failureExcerpt } from "../text.js";
import type { Collection } from "./collect.js";
import { fact, facts, type ItemFacts, written } from "./facts.js";
import { refusedOf } from "./refused.js";
import {
  diagnosisQuestion,
  freed,
  mergedBlame,
  missingPrerequisite,
} from "./repair-context.js";
import { repairOutcome } from "./step-deliver.js";
import { withKeep } from "./step-work.js";
import { MINUTE, type StackPlace, stepKey } from "./steps.js";

// ---------------------------------------------------------------------------
// Amendments a Work Item proposes (planning/amendments.ts runs them)

export const AMEND: HoldOption = {
  answer: "amend",
  family: "repair",
  consequence:
    "Asks the planner to amend the plan for it, reviewed independently; uses a planning revision, and the Work Item runs again on the amended plan with no repair charged.",
};

export const DECLINE: HoldOption = {
  answer: "decline-discovery",
  family: "refuse",
  consequence:
    "Records your reason and carries on with this result as the worker left it.",
  needsText: true,
};

/** Take in `proposal` (a worker's, or a blame's on `amend`); else ask with why. */
export function propose(
  state: ObjectiveState,
  proposal: AmendmentProposal,
  keep: Record<string, unknown>,
  ask: (problems: string) => Outcome,
): Outcome {
  const problems = proposalProblems(proposal, state);
  if (problems.length) return withKeep(ask(problems.join("; ")), keep);
  // The amendment runs before every other step (workflow.ts); this step
  // runs again once it settles.
  return {
    kind: "retry",
    reason: `Proposed amendment ${proposal.id}`,
    progress: true,
    keep: { ...keep, [proposalKey(proposal.id)]: proposal },
  };
}

/**
 * The item's new attempt once the amendment it proposed, or one that made
 * it wait for another item (`enabledAttempt`), was accepted: a
 * repair that counts against no allowance (`free`), its correction saved
 * so no diagnosis runs, moved onto the current start with the change so
 * far replayed. It runs with the amended plan's owned paths, acceptance
 * and dependencies, so it waits for any item the amendment put first.
 * The amendment refused nothing: the kept refused result is marked with
 * it, so the change so far, left as it is, is a result under the amended
 * plan until a repair refuses a result again (refused.ts `refusedTreeFor`).
 */
export function amendedAttempt(
  item: WorkItem,
  state: ObjectiveState,
  place: StackPlace | undefined,
  amendment: string,
  keep: Record<string, unknown>,
): Outcome {
  const target = stepKey(item.id, "work");
  const repair = (state.repairs?.[target]?.count ?? 0) + 1;
  const finding = `Amendment ${amendment} was accepted, so the plan changed for this Work Item. Work to its owned paths, acceptance and dependencies as they read now, continuing from the change so far.`;
  const outcome = repairOutcome(item, "work", finding, state, place, {
    keep: {
      ...keep,
      ...facts(
        {
          rebase: true,
          diagnosis: {
            repair,
            context: { finding },
            applied: fact(state, "diagnosis", item.id)?.applied ?? [],
          },
          discovered: null,
          blamed: null,
          prerequisite: null,
          enabled: null,
        },
        item.id,
      ),
    },
  });
  if (outcome.kind !== "repair") return outcome;
  // Only a repair that refuses a result writes a refused fact again, so a
  // repair that refuses none (a collection finding) keeps this mark.
  const moved = outcome.keep ?? {};
  const kept = written(moved, "refused", item.id);
  const refused = kept === undefined ? fact(state, "refused", item.id) : kept;
  return {
    ...outcome,
    free: { target, repair },
    ...(refused && !refused.replayOnly
      ? {
          keep: {
            ...moved,
            ...facts({ refused: { ...refused, amended: amendment } }, item.id),
          },
        }
      : {}),
  };
}

/**
 * A worker's in-scope `.factory-discovery.json` is proposed at once as
 * amendment `worker-<item>-<attempt>`: the item
 * waits for its outcome with no question, and the amendment's independent
 * review judges it. Accepted, the item starts a new attempt
 * (`amendedAttempt`); rejected and continued past, settled with the plan
 * unchanged (the discovery showed no gap), or declined by the operator
 * (`factory decline-discovery`, planning/amendments.ts
 * `declineDiscovery`), it carries on with the result as collected. Only a
 * proposal intake refuses (`proposalProblems`) asks, offering
 * `decline-discovery <reason>`. A backlog discovery is only logged: it is
 * for later Objectives. Undefined: collection goes on.
 */
export function discoveryOutcome(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  collected: Collection,
  keep: Record<string, unknown>,
): Outcome | undefined {
  if (collected.kind !== "collected" && collected.kind !== "repair")
    return undefined;
  const { state, answer } = context;
  const attempt = itemAttempt(state, item.id);
  const kept = fact(state, "discovered", item.id);
  const discovery: WorkDiscovery | undefined =
    kept?.attempt === attempt ? kept.discovery : collected.discovery;
  if (!discovery) return undefined;
  if (discovery.scope !== "in-scope") {
    context.log({
      event: "backlog-discovery",
      item: item.id,
      attempt,
      discovery,
    });
    return undefined;
  }
  if (fact(state, "declined", item.id)?.attempt === attempt) return undefined;
  const id = `worker-${item.id}-${attempt}`;
  const amendment = amendmentStatus(state, id);
  if (amendment?.status === "continued") return undefined;
  if (amendment?.status === "accepted")
    return amendedAttempt(item, state, place, amendment.id, {
      ...keep,
      // The change so far, replayed onto the new start.
      ...(collected.kind === "collected"
        ? facts(
            {
              refused: {
                commit: collected.commit,
                tree: collected.tree,
                notes: collected.notes,
                replayOnly: true,
              },
            },
            item.id,
          )
        : {}),
    });
  if (amendment)
    return {
      kind: "retry",
      reason: `Waits for amendment ${amendment.id}`,
      afterMs: MINUTE,
      keep,
    };
  const held = {
    ...keep,
    ...facts({ discovered: { attempt, discovery } }, item.id),
  };
  if (answer?.answer === DECLINE.answer)
    return {
      kind: "retry",
      reason: "Recorded the operator's decline of the worker's discovery",
      progress: true,
      keep: {
        ...held,
        ...facts(
          {
            declined: {
              attempt,
              reason: (answer.text ?? "").trim(),
              by: answer.by,
              at: answer.at,
            },
          },
          item.id,
        ),
      },
    };
  // The files it cites are read from the worker's result: the one
  // collected, the refused one it resubmitted unchanged, or the item's
  // start when it left no change. That start is this step's `keep`'s: a
  // first attempt hasn't kept one in the state yet (its files would be read
  // at the plan's base, which lacks what landed on main since intake), and
  // an attempt moved onto a new start kept its previous one there.
  const commit =
    collected.kind === "collected"
      ? collected.commit
      : collected.unchanged
        ? refusedOf(state, item.id)?.commit
        : (written(keep, "base", item.id) ?? fact(state, "base", item.id));
  return propose(
    state,
    {
      id,
      actor: `Work Item ${item.id}'s worker`,
      at: new Date().toISOString(),
      plan: String(state.kept[ACCEPTED_AT]),
      discovery,
      worker: { itemId: item.id, attempt },
      ...(commit ? { commit } : {}),
    },
    held,
    (problems) =>
      failure(
        `Work Item ${item.id}'s worker (attempt ${attempt}) stopped to propose work the plan lacks:\n\n${discoveryText(discovery)}\n\nIt can't be proposed as amendment ${code(id)}: ${problems}\n\n\`decline-discovery <reason>\` carries on with the result as the worker left it.`,
        [DECLINE, "cancel"],
      ),
  );
}

/**
 * A merged predecessor's blame answered `amend` (`mergedBlame`): propose
 * a follow-up Work Item after it as amendment `blame-<item>-<repair>`.
 * Accepted, the item starts a new attempt on the amended plan
 * (`amendedAttempt`); rejected and continued past, or settled with the
 * plan unchanged, it asks again without `amend`. Undefined: the repair
 * goes on as usual.
 */
export function blameAmendment(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown>,
): Outcome | undefined {
  const { state, answer } = context;
  const repair = state.repairs?.[stepKey(item.id, "work")]?.count ?? 0;
  const blamed = fact(state, "blamed", item.id);
  if (!blamed || blamed.repair !== repair) return undefined;
  const { predecessor, correction } = blamed;
  const id = `blame-${item.id}-${repair}`;
  const amendment = amendmentStatus(state, id);
  if (amendment?.status === "accepted")
    return amendedAttempt(item, state, place, amendment.id, keep);
  if (amendment?.status === "continued")
    return answer?.answer === AMEND.answer
      ? withKeep(
          mergedBlame(
            state,
            item,
            predecessor,
            correction,
            `Amendment ${amendment.id} didn't change the plan, which continues as it is.`,
          ),
          keep,
        )
      : undefined;
  if (amendment)
    return {
      kind: "retry",
      reason: `Waits for amendment ${amendment.id}`,
      afterMs: MINUTE,
      keep,
    };
  if (answer?.answer !== AMEND.answer) return undefined;
  const owned =
    currentPlan(state)!.items.find((entry) => entry.id === predecessor)
      ?.ownedPaths ?? [];
  // The files it cites are read from the failed result, or the item's start.
  const commit =
    refusedOf(state, item.id)?.commit ?? fact(state, "base", item.id);
  return propose(
    state,
    {
      id,
      actor: answer.by,
      at: new Date().toISOString(),
      plan: String(state.kept[ACCEPTED_AT]),
      discovery: {
        scope: "in-scope",
        reason: `Work Item ${item.id}'s failure comes from merged Work Item ${predecessor}'s result: ${correction.diagnosis} Add a Work Item after ${predecessor} that makes this correction; ${item.id}, which failed and waits, then depends on it and runs again on the integrated result.`,
        evidence: [correction.failure, correction.diagnosis].filter((text) =>
          text.trim(),
        ),
        ownership: correction.path ? [correction.path] : owned,
        acceptance: [correction.correction],
        dependencies: [predecessor],
      },
      ...(commit ? { commit } : {}),
    },
    keep,
    (problems) =>
      mergedBlame(
        state,
        item,
        predecessor,
        correction,
        `The amendment can't be proposed: ${problems}`,
      ),
  );
}

// ---------------------------------------------------------------------------
// `depend`: a missing prerequisite another Work Item provides (#2233)

export const DEPEND: HoldOption = {
  answer: "depend",
  family: "repair",
  consequence:
    "Asks the planner to amend the plan so this Work Item depends on the one that provides its missing prerequisite, reviewed independently; uses a planning revision, and the Work Item waits for that one's merge, then runs again on the default branch with no repair charged.",
};

/** The amendment a missing prerequisite of repair `repair` proposes. */
export const prerequisiteAmendmentId = (itemId: string, repair: number) =>
  `prerequisite-${itemId}-${repair}`;

/**
 * A repair diagnosis's missing prerequisite (repair-context.ts
 * `repairContext`), its repair `free`: proposed at once as amendment
 * `prerequisite-<item>-<repair>` by the diagnosis, with no question, as a
 * worker's discovery is, and the amendment's review judges it
 * (`prerequisiteAmendment` reads its outcome). It asks instead
 * (`missingPrerequisite`, offering `depend` where it would) while the
 * provider has a question open, when the dependency would change a started
 * native stack (`found.stack`), when this repair's amendment was proposed
 * already, or when intake refuses the proposal.
 */
export function diagnosedPrerequisite(
  state: ObjectiveState,
  item: WorkItem,
  found: NonNullable<ItemFacts["prerequisite"]>,
): Outcome {
  const asks =
    found.stack !== undefined ||
    state.holds.some((hold) => hold.item === found.provider) ||
    amendmentStatus(state, prerequisiteAmendmentId(item.id, found.repair));
  return freed(
    asks
      ? missingPrerequisite(state, item, found)
      : proposePrerequisite(
          state,
          item,
          found,
          `Work Item ${item.id}'s repair diagnosis`,
          {},
        ),
    stepKey(item.id, "work"),
    found.repair,
  );
}

/**
 * The outcome of a missing prerequisite's amendment, or the operator's
 * `depend` to its question (repair-context.ts `missingPrerequisite`),
 * which proposes it as theirs. The amendment makes the item depend on the
 * provider (`AmendmentProposal.prerequisite`; its fence refuses a round
 * that doesn't) with its own review. The item waits for its outcome, as
 * for a discovery. Accepted, the item depends on the provider, so it
 * runs only once the provider merged: then a new attempt on the amended
 * plan (`amendedAttempt`) moves its change onto the default branch with
 * the provider's result and checks it again, its refused change replayed,
 * which may end on the same tree. Rejected and continued past, or settled
 * with the plan unchanged, it asks once more without `depend`, and its
 * answer goes on as usual. Undefined: the repair goes on as usual.
 */
export function prerequisiteAmendment(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown>,
): Outcome | undefined {
  const { state, answer } = context;
  const repair = state.repairs?.[stepKey(item.id, "work")]?.count ?? 0;
  const found = fact(state, "prerequisite", item.id);
  if (!found || found.repair !== repair) return undefined;
  const amendment = amendmentStatus(
    state,
    prerequisiteAmendmentId(item.id, repair),
  );
  if (amendment?.status === "accepted")
    return amendedAttempt(item, state, place, amendment.id, keep);
  // Asked once: with the fact gone, its answer goes on as usual.
  if (amendment?.status === "continued")
    return withKeep(
      missingPrerequisite(
        state,
        item,
        found,
        `Amendment ${amendment.id} didn't change the plan, which continues as it is.`,
      ),
      { ...keep, ...facts({ prerequisite: null }, item.id) },
    );
  if (amendment)
    return {
      kind: "retry",
      reason: `Waits for amendment ${amendment.id}`,
      afterMs: MINUTE,
      keep,
    };
  // A started native stack's layers keep it from being offered.
  if (answer?.answer !== DEPEND.answer || found.stack !== undefined)
    return undefined;
  return proposePrerequisite(state, item, found, answer.by, keep);
}

/**
 * Take in amendment `prerequisite-<item>-<repair>` for `found`, as
 * `actor`'s; else ask (`missingPrerequisite`) with why.
 */
function proposePrerequisite(
  state: ObjectiveState,
  item: WorkItem,
  found: NonNullable<ItemFacts["prerequisite"]>,
  actor: string,
  keep: Record<string, unknown>,
): Outcome {
  // The files it cites are read from the failed result, or the item's start.
  const commit =
    refusedOf(state, item.id)?.commit ?? fact(state, "base", item.id);
  const { provider } = found;
  return propose(
    state,
    {
      id: prerequisiteAmendmentId(item.id, found.repair),
      actor,
      at: new Date().toISOString(),
      plan: String(state.kept[ACCEPTED_AT]),
      discovery: {
        scope: "in-scope",
        reason: `Work Item ${item.id}'s failure is a missing prerequisite that Work Item ${provider} provides, and ${item.id} doesn't depend on ${provider}: ${found.diagnosis} Make ${item.id} depend on ${provider} by naming ${item.id} in ${provider}'s enables entry, so it waits for ${provider}'s merge and is checked again with it; every other item and field stays as it is.`,
        evidence: [
          failureExcerpt(found.failure, EVIDENCE_CHARS),
          found.diagnosis,
        ].filter((text) => text.trim()),
        ownership: item.ownedPaths,
        acceptance: [
          `${item.id} depends on ${provider}, so it is checked again only once ${provider}'s result is on the default branch.`,
        ],
        dependencies: [provider],
      },
      worker: { itemId: item.id, attempt: itemAttempt(state, item.id) },
      prerequisite: { itemId: item.id, provider },
      ...(commit ? { commit } : {}),
    },
    keep,
    (problems) =>
      missingPrerequisite(
        state,
        item,
        found,
        `The amendment can't be proposed: ${problems}`,
      ),
  );
}

/**
 * An accepted amendment made this started item depend on the items whose
 * `enables` named it (its `enabled` fact), and those merged, or the item
 * wouldn't run: its result was refused, or kept, on a base without them.
 * Unless its own amendment's route took it first, its next work step is
 * a new attempt on the amended plan (`amendedAttempt`), as its proposer's
 * would be: moved onto the default branch with what it now depends on, its
 * change replayed and free to end on the same tree, then checked again,
 * with no diagnosis of the failure that predates them. Undefined: no such
 * fact.
 */
export function enabledAttempt(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown>,
): Outcome | undefined {
  const { state } = context;
  const enabled = fact(state, "enabled", item.id);
  if (!enabled) return undefined;
  return amendedAttempt(item, state, place, enabled.amendment, keep);
}

// ---------------------------------------------------------------------------
// `replace-validation` (planning/amendments.ts `authorizeReplacement`)

/** The `replace-validation` option a repair diagnosis's question offers. */
export const REPLACE_FOR_REPAIR: HoldOption = replaceValidationOption(
  "Authorizes replacing those validation commands in an amendment, which its review judges on your reason; uses a planning revision, and the Work Item runs again on the amended plan with no repair charged.",
);

/** The `replace-validation` option a read-only QA item's refusal offers. */
export const REPLACE_FOR_QA: HoldOption = replaceValidationOption(
  "Authorizes replacing those validation commands in an amendment, which its review judges on your reason; uses a planning revision, and the QA item checks again on the plan as it then stands.",
);

/** The amendment `replace-validation` proposes from repair `repair`'s diagnosis question. */
export const validationAmendmentId = (itemId: string, repair: number) =>
  `validation-${itemId}-${repair}`;

/** The failure a discovery's evidence keeps, at most. */
const EVIDENCE_CHARS = 4000;

/**
 * The discovery an operator's `replace-validation` proposes: only the
 * authorized commands are replaced, by commands that prove what each was
 * there to prove, with the failure its question was asked on as evidence.
 */
function replacementDiscovery(
  authorized: readonly ValidationAuthorization[],
  failed: string,
  ownership: string[],
): WorkDiscovery {
  return {
    scope: "in-scope",
    reason: `${authorizationText(authorized)}\n\nReplace only these validation commands, each with commands that prove what it was there to prove; every other command stays as it is, and so does every other field, except the acceptance, brief and non-goals restated to match.`,
    evidence: [
      ...authorized.map(
        (entry) =>
          `${entry.itemId}'s validation command ${entry.index}: ${entry.command}`,
      ),
      ...(failed.trim() ? [failureExcerpt(failed, EVIDENCE_CHARS)] : []),
    ],
    ownership,
    acceptance: authorized.map(
      (entry) =>
        `${entry.itemId} no longer runs ${JSON.stringify(entry.command)}; the commands in its place prove what it proved, keeping every assertion it makes, unless it re-implements or tightens a repository policy check, which the repository's own command replaces.`,
    ),
    dependencies: [],
  };
}

/** A repair finding as a discovery's evidence. */
function findingText(finding: RepairFinding | undefined): string {
  if (!finding) return "";
  return finding.kind === "review"
    ? finding.refused
        .map((refused) => `${refused.criterion}: ${refused.detail}`)
        .join("\n")
    : finding.detail;
}

/**
 * Take in `proposal`, recording the authorization behind it (`recorded`)
 * with it; else ask with why, recording nothing.
 */
function proposeReplacement(
  state: ObjectiveState,
  proposal: AmendmentProposal,
  keep: Record<string, unknown>,
  recorded: Record<string, unknown>,
  ask: (problem: string) => Outcome,
): Outcome {
  const problems = proposalProblems(proposal, state);
  if (problems.length)
    return withKeep(
      ask(
        `it can't be proposed as amendment ${proposal.id}: ${problems.join("; ")}`,
      ),
      keep,
    );
  // The amendment runs before every other step (workflow.ts); this step
  // runs again once it settles.
  return {
    kind: "retry",
    reason: `Proposed amendment ${proposal.id}`,
    progress: true,
    keep: { ...keep, ...recorded, [proposalKey(proposal.id)]: proposal },
  };
}

/**
 * A repair diagnosis's question answered `replace-validation`: the
 * operator's authorization is recorded and proposed as amendment
 * `validation-<item>-<repair>`, whose review judges the replacement on the
 * operator's reason. The item waits for its outcome, as for a discovery.
 * Accepted, it starts a new attempt on the amended plan (`amendedAttempt`)
 * with its refused change replayed, which may now end on the same tree;
 * rejected and continued past, or settled with the plan unchanged, its
 * repair goes on as usual. An answer that names no command it can
 * authorize asks again with why. Undefined: the repair goes on as usual.
 */
export function validationAmendment(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown>,
): Outcome | undefined {
  const { state, answer } = context;
  const repair = state.repairs?.[stepKey(item.id, "work")]?.count ?? 0;
  const id = validationAmendmentId(item.id, repair);
  const amendment = amendmentStatus(state, id);
  if (amendment?.status === "accepted")
    return amendedAttempt(item, state, place, amendment.id, keep);
  if (amendment?.status === "continued") return undefined;
  if (amendment)
    return {
      kind: "retry",
      reason: `Waits for amendment ${amendment.id}`,
      afterMs: MINUTE,
      keep,
    };
  if (answer?.answer !== REPLACE_VALIDATION) return undefined;
  // Asked again as the diagnosis asked it (repair-context.ts keeps it).
  const ask = (problem: string) =>
    withKeep(
      askedAgain(
        fact(state, "asked", item.id),
        problem,
        diagnosisQuestion(
          state,
          item,
          fact(state, "finding", item.id),
          "",
          repair,
        ),
      ),
      keep,
    );
  const authorized = authorizeReplacement(state, answer);
  if ("problem" in authorized) return ask(authorized.problem);
  // The files it cites are read from the refused result, or the item's start.
  const commit =
    refusedOf(state, item.id)?.commit ?? fact(state, "base", item.id);
  return proposeReplacement(
    state,
    {
      id,
      actor: answer.by,
      at: new Date().toISOString(),
      plan: String(state.kept[ACCEPTED_AT]),
      discovery: replacementDiscovery(
        authorized.authorized,
        findingText(fact(state, "finding", item.id)),
        item.ownedPaths,
      ),
      worker: { itemId: item.id, attempt: itemAttempt(state, item.id) },
      ...(commit ? { commit } : {}),
    },
    keep,
    { ...authorized.keep, ...facts({ asked: null }, item.id) },
    ask,
  );
}

/**
 * A read-only QA item's refusal answered `replace-validation`: the
 * operator's authorization is recorded and proposed as their amendment
 * `validation-<item>-<n>` (the Objective's n-th proposal), whose review
 * judges the replacement on the reason. It runs before every other step,
 * and the QA item's step runs again on the plan as it then stands. A QA
 * item owns nothing, so its discovery's ownership is what it checks: its
 * dependencies' owned paths. An answer that can't be taken asks the
 * refusal again as it was asked (step-qa.ts `qaRefusal` keeps it; else
 * with `offers`), with why. Undefined: no such answer, or one taken in
 * already.
 */
export function qaReplacement(
  item: WorkItem,
  context: StepContext,
  offers: readonly Offer[],
): Outcome | undefined {
  const { state, answer } = context;
  if (answer?.answer !== REPLACE_VALIDATION || replacementTaken(state, answer))
    return undefined;
  const asked = fact(state, "asked", item.id);
  const ask = (problem: string) =>
    askedAgain(asked, problem, {
      question: `Read-only QA item ${item.id} refused the integrated result.`,
      offers: [...offers],
    });
  const authorized = authorizeReplacement(state, answer);
  if ("problem" in authorized) return ask(authorized.problem);
  const plan = currentPlan(state)!;
  const ownership = [
    ...new Set(
      item.dependencies.flatMap(
        (id) => plan.items.find((entry) => entry.id === id)?.ownedPaths ?? [],
      ),
    ),
  ];
  if (!ownership.length)
    return ask(
      `${item.id} depends on no Work Item that owns paths, so an amendment has none to name; answer \`replan\` instead`,
    );
  return proposeReplacement(
    state,
    {
      id: `validation-${item.id}-${amendmentLedger(state).used + 1}`,
      actor: answer.by,
      at: new Date().toISOString(),
      plan: String(state.kept[ACCEPTED_AT]),
      discovery: replacementDiscovery(
        authorized.authorized,
        asked?.question ?? answer.question ?? "",
        ownership,
      ),
    },
    {},
    { ...authorized.keep, ...facts({ asked: null }, item.id) },
    ask,
  );
}

/** Whether `answer` is a `replace-validation` already taken in (`qaReplacement`). */
export function replacementTaken(
  state: ObjectiveState,
  answer: Answer | undefined,
): boolean {
  return (
    answer?.answer === REPLACE_VALIDATION &&
    (fact(state, "validation:authorized") ?? []).some(
      (entry) => entry.holdId === answer.holdId,
    )
  );
}
