import { installedControllerCapabilities } from "./controller-capabilities.js";
import type {
  ModelInvocationContext,
  PlanningModel,
  ResultReviewEvidenceSource,
} from "./contracts.js";
import { StepFault, transient, attachFault } from "./fault.js";
import { pinnedGit } from "./process.js";
import {
  decodeReview,
  resolveReviewReferences,
  reviewPacket,
} from "./review-evidence.js";
import type { AcceptancePending } from "./state.js";
import {
  type CriterionEvidence,
  type AcceptanceDecision,
  type ValidationEvidence,
  assertValidationWorktreeObservation,
} from "./validation-evidence.js";
import {
  selectedLfsReviewEvidence,
  configuredResultReviewTextBudget,
  resultTreeInventory,
  resultChangePacket,
  materializeResultTree,
  assertCommandReceipts,
  gitChangeEvidenceSources,
  commandPassEvidence,
} from "./result-evidence.js";

/** A separate read-only review evaluates each criterion on an exact-tree packet. */
export async function reviewAcceptance(args: {
  model: PlanningModel;
  reviewPhase?: "result-review" | "objective-review";
  checkout: string;
  baseSha: string;
  commit: string;
  evidence: ValidationEvidence;
  criteria: string[];
  sources: { path: string; content: string }[];
  evidenceSources?: ResultReviewEvidenceSource[];
  decisions?: AcceptanceDecision[];
  observations?: string;
  invocation?: ModelInvocationContext;
  beforeSubmit?: () => void;
  /** Why the previous answer was invalid; the reviewer is asked again with it. */
  previousInvalid?: string;
  /** Called with the validation error before an invalid answer is reported. */
  onInvalid?: (detail: string) => void;
}): Promise<ReviewOutcome> {
  const { model, checkout, baseSha, commit, evidence, criteria, sources } =
    args;
  if (!criteria.length) throw new Error("No acceptance criteria to prove");
  const observedTree = pinnedGit(checkout, "rev-parse", `${commit}^{tree}`);
  if (observedTree !== evidence.treeSha)
    throw new Error("Acceptance result tree differs from command evidence");
  assertCommandReceipts(evidence, evidence.treeSha, "Acceptance");
  const selectedLfsEvidence = selectedLfsReviewEvidence(checkout, evidence);
  assertValidationWorktreeObservation(
    evidence.worktreeObservation,
    evidence.treeSha,
    evidence.selectedLfs,
  );
  const worktreeEvidence = evidence.worktreeObservation
    ? [
        {
          path: "Validator worktree observation",
          content: JSON.stringify(evidence.worktreeObservation),
          complete: true,
        },
      ]
    : [];
  const remainingBudget =
    configuredResultReviewTextBudget() - selectedLfsEvidence.textBytes;
  const inventory = resultTreeInventory(
    checkout,
    evidence.treeSha,
    Math.floor(remainingBudget / 2),
  );
  const { change } = resultChangePacket(
    checkout,
    baseSha,
    commit,
    // Only emitted inventory and attribute bytes reduce patch capacity.
    remainingBudget - Buffer.byteLength(inventory.content),
  );
  const suppliedEvidence = [
    inventory,
    ...selectedLfsEvidence.sources,
    ...worktreeEvidence,
    ...(args.evidenceSources ?? []),
  ];
  // Evidence that does not depend on the candidate comes first, so reviews of
  // different candidates share a provider-cache prefix.
  const evidenceSources: ResultReviewEvidenceSource[] = [
    {
      path: "Factory controller capabilities",
      content: JSON.stringify(installedControllerCapabilities()),
    },
    ...gitChangeEvidenceSources(change, {
      path: "Exact Git change packet",
      metadata: {
        baseCommitSha: baseSha,
        resultCommitSha: commit,
        resultTreeSha: evidence.treeSha,
      },
    }),
    commandPassEvidence(evidence.commands),
    {
      path: "Delivery observations",
      content: args.observations ?? "",
    },
    ...suppliedEvidence,
  ];
  const packet = reviewPacket(criteria, [
    ...sources.map((source) => ({ ...source, origin: "source" as const })),
    ...evidenceSources.map((source) => ({
      ...source,
      origin: "controller" as const,
    })),
  ]);
  const request: Parameters<NonNullable<PlanningModel["reviewResult"]>>[0] = {
    reviewPhase: args.reviewPhase ?? ("result-review" as const),
    criteria,
    reviewPacket: packet,
    baseSha,
    treeSha: evidence.treeSha,
    sources,
    change,
    commands: evidence.commands,
    evidence: suppliedEvidence,
    observations: args.observations,
    invocation: args.invocation,
    ...(args.previousInvalid ? { previousInvalid: args.previousInvalid } : {}),
  };
  // Criteria the operator decided on this tree need no reviewer.
  const undecided = criteria.some(
    (criterion) =>
      !args.decisions?.some(
        (item) =>
          item.criterion === criterion && item.treeSha === evidence.treeSha,
      ),
  );
  args.beforeSubmit?.();
  if (undecided && !model.reviewResult)
    throw attachFault(
      new Error("No independent result reviewer is configured"),
      {
        kind: "config",
        detail: "No independent result reviewer is configured",
        fix: "Configure a reviewer model, then `factory run`",
      },
    );
  // A failed call keeps the fault its adapter classified: the review step
  // repeats a lost answer and waits out a limit.
  // The reviewer reads the exact tree itself instead of asking for contents.
  const tree = undecided
    ? materializeResultTree(checkout, evidence.treeSha)
    : undefined;
  let response: Awaited<ReturnType<NonNullable<PlanningModel["reviewResult"]>>>;
  try {
    response = undecided
      ? await model.reviewResult!({ ...request, tree: tree!.directory })
      : { packetId: packet.id, findings: [] };
  } finally {
    tree?.remove();
  }
  let decoded: ReturnType<typeof decodeReview>;
  try {
    decoded = decodeReview(response, packet);
  } catch (error) {
    // The decoder refused the answer's shape: an invalid answer.
    observeInvalidReview(args.invocation, "finding", "invalid-response");
    const detail = `Independent review answer was invalid: ${error instanceof Error ? error.message : String(error)}`;
    args.onInvalid?.(detail);
    throw new StepFault(transient(detail, true), { cause: error });
  }
  const invalidAnswers: string[] = [];
  /** The first criterion whose answer was invalid. */
  let firstInvalid: string | undefined;
  const proven: CriterionEvidence[] = [];
  /** Every criterion that needs a human, by its place in `criteria`. */
  const questions = new Map<number, Omit<AcceptancePending, "more">>();
  const invalidIndices: number[] = [];
  let refused: string | undefined;
  for (const [index, criterion] of criteria.entries()) {
    const decision = args.decisions?.find(
      (item) =>
        item.criterion === criterion && item.treeSha === evidence.treeSha,
    );
    if (decision?.outcome === "refuse") {
      refused ??= `Acceptance criterion refused by ${decision.actor}: ${criterion}`;
      continue;
    }
    if (decision?.outcome === "accept") {
      proven.push({
        criterion,
        verdict: "human-accept",
        source: "OPERATOR",
        quote: decision.reason,
        detail: `${decision.actor} at ${decision.at}`,
      });
      continue;
    }
    const finding = decoded.findings[index];
    // The decoder gives every criterion a finding or an error. A missing
    // finding is an invalid answer, never a question the reviewer did not ask.
    const invalid =
      decoded.errors[index] ??
      (finding ? undefined : "Review omitted this criterion");
    if (invalid || !finding) {
      observeInvalidReview(args.invocation, "finding", "invalid-response");
      invalidAnswers.push(`criterion ${index}: ${invalid}`);
      firstInvalid ??= criterion;
      invalidIndices.push(index);
      continue;
    }
    if (finding.verdict === "pass") {
      proven.push({
        criterion,
        verdict: "pass",
        evidence: resolveReviewReferences(finding.evidenceIds, packet, true),
        detail: finding.detail,
      });
      continue;
    }
    if (finding.verdict === "refuse") {
      refused ??= `Acceptance criterion disproved: ${criterion}: ${finding.detail}`;
      continue;
    }
    questions.set(index, {
      criterion,
      treeSha: evidence.treeSha,
      detail: finding.detail,
      question: finding.question,
    });
  }
  const automaticCriterion = criteria.find(
    (criterion) =>
      !proven.some(
        (item) =>
          item.criterion === criterion && item.verdict === "human-accept",
      ),
  );
  if (decoded.packetError && automaticCriterion !== undefined) {
    observeInvalidReview(args.invocation, "finding", "invalid-response");
    invalidAnswers.unshift(decoded.packetError);
    firstInvalid ??= automaticCriterion;
  }
  // Preserve independent valid assessments on existing item evidence; final raw
  // response remains in existing diagnostics rather than a second durable store.
  evidence.criteria = proven;
  {
    const protocolInvalid = Boolean(
      decoded.packetError || decoded.errors.some(Boolean),
    );
    const observeOutcome = (stage: "protocol" | "semantic", status: string) => {
      try {
        args.invocation?.observe?.({
          invocationId: args.invocation.invocationId,
          phase: args.invocation.phase,
          ordinal: args.invocation.ordinal,
          providerAttempt: args.invocation.providerAttempt,
          type: "progress",
          capture: {
            event: { kind: "outcome", outcome: { stage, status } },
            content: () => ({
              criteria: proven,
              findings: decoded?.findings,
              errors: decoded?.errors,
              packetError: decoded?.packetError,
            }),
          },
        });
      } catch {
        /* best-effort observations cannot affect acceptance */
      }
    };
    observeOutcome("protocol", protocolInvalid ? "invalid" : "valid");
    if (!protocolInvalid)
      observeOutcome(
        "semantic",
        refused ? "refuse" : questions.size ? "needs-human" : "pass",
      );
  }

  // A valid review that refuses a criterion judges the work, not the call.
  if (refused)
    throw new StepFault({ kind: "work", evidence: { detail: refused } });
  // An invalid answer may have been paid for: the review step asks again
  // once with the validation error. An answer still invalid is one the
  // reviewer cannot fix (evidence it may not cite, a source it cannot see
  // whole): the operator decides that criterion, and re-review stays open.
  if (invalidAnswers.length) {
    const detail = `Independent review answer was invalid: ${invalidAnswers.join("; ")}`;
    if (!args.previousInvalid || firstInvalid === undefined) {
      args.onInvalid?.(detail);
      throw new StepFault(transient(detail, true));
    }
    // A packet-level fault has no criterion of its own: it is asked of the first.
    for (const index of invalidIndices.length
      ? invalidIndices
      : [criteria.indexOf(firstInvalid)])
      questions.set(index, {
        criterion: criteria[index]!,
        treeSha: evidence.treeSha,
        detail,
        question: `The independent reviewer could not give a valid answer for this criterion twice. Inspect the evidence and accept or refuse it.`,
      });
  }
  if (questions.size) {
    const [pending, ...more] = [...questions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, question]) => question);
    return { pending: more.length ? { ...pending!, more } : pending! };
  }
  return { evidence: { ...evidence, criteria: proven } };
}

/** A review either accepts the result or names the criterion a human must decide. */
export type ReviewOutcome =
  | { evidence: ValidationEvidence; pending?: undefined }
  | { pending: AcceptancePending; evidence?: undefined };

function observeInvalidReview(
  invocation: ModelInvocationContext | undefined,
  field: string,
  reason: string,
): void {
  try {
    invocation?.observe?.({
      invocationId: invocation.invocationId,
      phase: invocation.phase,
      ordinal: invocation.ordinal,
      ...(invocation.providerAttempt === undefined
        ? {}
        : { providerAttempt: invocation.providerAttempt }),
      ...(invocation.providerMaxAttempts === undefined
        ? {}
        : { providerMaxAttempts: invocation.providerMaxAttempts }),
      type: "response-invalid",
      failureClass: "review-protocol",
      failureField: field,
      detail: reason,
    });
  } catch (error) {
    process.stderr.write(
      `Factory model diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
