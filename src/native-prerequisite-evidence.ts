import { createHash } from "node:crypto";
import type {
  PlanningPrerequisites,
  ResultReviewEvidenceSource,
} from "./contracts.js";
import { pinnedGit } from "./process.js";
import type { FactoryState } from "./state.js";

export function prerequisitesDigest(facts: PlanningPrerequisites): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

/** Validate retained admission facts without reconstructing legacy missing facts. */
export function assertNativePrerequisites(
  state: Pick<
    FactoryState,
    | "repository"
    | "objective"
    | "baseSha"
    | "prerequisites"
    | "prerequisitesDigest"
  >,
): void {
  const facts = state.prerequisites;
  if (facts === undefined) return;
  const fail = () => {
    throw new Error(
      "Native Objective prerequisite facts differ from their activation binding",
    );
  };
  const object = (
    value: unknown,
    keys: string[],
  ): value is Record<string, unknown> =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
  const sha = (value: unknown, length: number) =>
    typeof value === "string" &&
    new RegExp(`^[a-f0-9]{${length}}$`).test(value);
  if (
    !object(facts, [
      "provenance",
      "repository",
      "objective",
      "baseSha",
      "predecessors",
    ]) ||
    facts.provenance !==
      "authenticated-native-dependencies-and-sealed-continuations" ||
    facts.repository !== state.repository ||
    facts.objective !== state.objective ||
    facts.baseSha !== state.baseSha ||
    !sha(facts.baseSha, 40) ||
    !Array.isArray(facts.predecessors) ||
    !facts.predecessors.length ||
    state.prerequisitesDigest === undefined ||
    prerequisitesDigest(facts) !== state.prerequisitesDigest
  )
    fail();
  let previous = 0;
  for (const predecessor of facts.predecessors) {
    if (
      !object(predecessor, [
        "objective",
        "bodyDigest",
        "acceptance",
        "status",
        "baseRelationship",
      ]) ||
      !Number.isSafeInteger(predecessor.objective) ||
      predecessor.objective <= previous ||
      predecessor.objective === state.objective ||
      !sha(predecessor.bodyDigest, 64) ||
      predecessor.status !== "accepted-and-closed" ||
      !object(predecessor.acceptance, [
        "candidateBasis",
        "sealedAt",
        "commit",
        "tree",
        "graphDigest",
        "configDigest",
        "evidenceDigest",
      ])
    )
      fail();
    const acceptance = predecessor.acceptance;
    if (
      typeof acceptance.sealedAt !== "string" ||
      !Number.isFinite(Date.parse(acceptance.sealedAt)) ||
      !sha(acceptance.commit, 40) ||
      !sha(acceptance.tree, 40) ||
      !sha(acceptance.graphDigest, 64) ||
      !sha(acceptance.configDigest, 64) ||
      !sha(acceptance.evidenceDigest, 64) ||
      (acceptance.candidateBasis !== undefined &&
        acceptance.candidateBasis !== "pinned-baseline" &&
        acceptance.candidateBasis !== "current-graph-integration") ||
      predecessor.baseRelationship !==
        (acceptance.commit === state.baseSha ? "equal" : "descendant")
    )
      fail();
    previous = predecessor.objective;
  }
}

/** Historical sealed admission is evidence, never this candidate's acceptance. */
export function nativePrerequisiteReviewEvidence(args: {
  state: FactoryState;
  checkout: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
}): ResultReviewEvidenceSource[] {
  const { state, checkout, candidateCommitSha, candidateTreeSha } = args;
  assertNativePrerequisites(state);
  if (state.prerequisitesDigest === undefined) return [];
  const binding = {
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    acceptedPlanGraphDigest: state.planGraphDigest,
    acceptedBaseCommitSha: state.baseSha,
    prerequisitesDigest: state.prerequisitesDigest,
    reviewedCommitSha: candidateCommitSha,
    reviewedTreeSha: candidateTreeSha,
  };
  if (!state.prerequisites)
    return [
      {
        path: "Native Objective prerequisite evidence",
        complete: true,
        content: JSON.stringify({
          availability: "unavailable",
          binding,
          reason:
            "Historical activation retained only the prerequisite digest; sealed predecessor facts are unavailable.",
        }),
      },
    ];
  const ancestor = (commit: string, descendant: string) => {
    try {
      pinnedGit(checkout, "merge-base", "--is-ancestor", commit, descendant);
    } catch {
      throw new Error(
        "Native Objective prerequisite accepted commit is not in the reviewed baseline or candidate",
      );
    }
  };
  if (
    pinnedGit(checkout, "rev-parse", `${candidateCommitSha}^{tree}`) !==
    candidateTreeSha
  )
    throw new Error(
      "Native Objective prerequisite reviewed candidate tree differs from Git",
    );
  ancestor(state.baseSha, candidateCommitSha);
  for (const predecessor of state.prerequisites.predecessors) {
    if (
      pinnedGit(
        checkout,
        "rev-parse",
        `${predecessor.acceptance.commit}^{tree}`,
      ) !== predecessor.acceptance.tree
    )
      throw new Error(
        "Native Objective prerequisite sealed tree differs from Git",
      );
    ancestor(predecessor.acceptance.commit, state.baseSha);
  }
  return [
    {
      path: "Native Objective prerequisite evidence",
      complete: true,
      content: JSON.stringify({
        availability: "available",
        binding: {
          ...binding,
          reviewedBaseRelationship:
            candidateCommitSha === state.baseSha ? "equal" : "descendant",
        },
        facts: state.prerequisites,
        meaning:
          "Historical accepted-and-closed predecessor admission at the pinned base; current result and final acceptance require their own evidence.",
      }),
    },
  ];
}
