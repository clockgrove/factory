import { failure, type Outcome, type StepContext } from "../engine.js";
import { code } from "../markdown.js";
import {
  type AmendmentProposal,
  amendmentStatus,
  discoveryText,
  itemAttempt,
  proposalProblems,
  type WorkDiscovery,
} from "../planning/amendments.js";
import { ACCEPTED_AT, currentPlan, proposalKey } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import type { HoldOption, ObjectiveState } from "../state.js";
import type { Collection } from "./collect.js";
import { fact, facts } from "./facts.js";
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
 * (`amendedAttempt`); rejected and continued past, or declined by the
 * operator (`factory decline-discovery`, planning/amendments.ts
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
  // The files it cites are read from the worker's result, or from the
  // item's start when it left no change.
  const commit =
    collected.kind === "collected"
      ? collected.commit
      : fact(state, "base", item.id);
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
 * (`amendedAttempt`); rejected and continued past, it asks again without
 * `amend`. Undefined: the repair goes on as usual.
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
            `Amendment ${amendment.id} was rejected, and the plan continues without it.`,
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
