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
import { fact, facts, written } from "./facts.js";
import { refusedOf } from "./refused.js";
import { mergedBlame } from "./repair-context.js";
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
 * The item's new attempt once the amendment it proposed was accepted: a
 * repair that counts against no allowance (`free`), its correction saved
 * so no diagnosis runs, moved onto the current start with the change so
 * far replayed. It runs with the amended plan's owned paths, acceptance
 * and dependencies, so it waits for any item the amendment put first.
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
        },
        item.id,
      ),
    },
  });
  return outcome.kind === "repair"
    ? { ...outcome, free: { target, repair } }
    : outcome;
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
// `replace-validation` (planning/amendments.ts `authorizeReplacement`)

/** The `replace-validation` option a repair diagnosis's question offers. */
export const REPLACE_FOR_REPAIR: HoldOption = replaceValidationOption(
  "Authorizes replacing those validation commands in an amendment, which its review judges on your reason; uses a planning revision, and the Work Item runs again on the amended plan with no repair charged.",
);

/** The `replace-validation` option a read-only QA item's refusal offers. */
export const REPLACE_FOR_QA: HoldOption = replaceValidationOption(
  "Authorizes replacing those validation commands in an amendment, which its review judges on your reason; uses a planning revision, and the QA item checks again on the plan as it then stands.",
);

/** What a repair diagnosis's question offers when it is asked again. */
const DIAGNOSIS_OFFERS: readonly Offer[] = [
  "answer",
  REPLACE_FOR_REPAIR,
  {
    answer: "retry",
    family: "retry",
    consequence: "Diagnoses the failure again.",
  },
  "replan",
  "cancel",
];

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
    reason: `${authorizationText(authorized)}\n\nReplace only these validation commands, each with commands that prove what it was there to prove; every other command and field stays as it is.`,
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
        `${entry.itemId} no longer runs ${JSON.stringify(entry.command)}; the commands in its place prove what it proved, keeping every assertion it makes.`,
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
  if (amendment?.status === "accepted") {
    const refused = fact(state, "refused", item.id);
    return amendedAttempt(item, state, place, amendment.id, {
      ...keep,
      ...(refused
        ? facts({ refused: { ...refused, replayOnly: true } }, item.id)
        : {}),
    });
  }
  if (amendment?.status === "continued") return undefined;
  if (amendment)
    return {
      kind: "retry",
      reason: `Waits for amendment ${amendment.id}`,
      afterMs: MINUTE,
      keep,
    };
  if (answer?.answer !== REPLACE_VALIDATION) return undefined;
  const ask = (problem: string) =>
    withKeep(
      askedAgain(
        answer,
        problem,
        DIAGNOSIS_OFFERS,
        `Work Item ${item.id} needs your decision before it is repaired.`,
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
    authorized.keep,
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
 * dependencies' owned paths. An answer that can't be taken asks again with
 * why, `offers` the refusal's. Undefined: no such answer, or one taken in
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
  const ask = (problem: string) =>
    askedAgain(
      answer,
      problem,
      offers,
      `Read-only QA item ${item.id} refused the integrated result.`,
    );
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
        answer.question ?? "",
        ownership,
      ),
    },
    {},
    authorized.keep,
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
