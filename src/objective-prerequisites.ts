import { createHash } from "node:crypto";
import type { FactoryConfig } from "./config.js";
import type { GitHubGateway, PlanningPrerequisites } from "./contracts.js";
import { objectiveComplete } from "./completion.js";
import { decision, StepFault } from "./fault.js";
import { git, gitAsync } from "./process.js";
import { readContinuation } from "./state-store.js";

/** Reuse native GitHub relationships and the original sealed snapshot; save no new ledger. */
export async function planningPrerequisites(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  baseSha: string,
  dependencies?: number[],
): Promise<PlanningPrerequisites | undefined> {
  const predecessors =
    dependencies ?? (await github.objectiveDependencies?.(objective)) ?? [];
  if (!predecessors.length) return;
  const evidence: PlanningPrerequisites = {
    provenance: "authenticated-native-dependencies-and-sealed-continuations",
    repository: config.repository,
    objective,
    baseSha,
    predecessors: [],
  };
  /** The operator restores the predecessor's evidence; the amend step waits. */
  const refusal = (predecessor: number, reason: string) =>
    new StepFault(
      decision(
        `Predecessor #${predecessor} ${reason}; restore it`,
        `predecessor #${predecessor}`,
      ),
    );
  for (const predecessor of [...predecessors].sort((a, b) => a - b)) {
    const previous = readContinuation(config.repository, predecessor);
    if (
      previous?.schemaVersion !== 7 ||
      !objectiveComplete(previous) ||
      !previous.finalAcceptance
    )
      throw refusal(predecessor, "lacks bound accepted candidate evidence");
    const remote = await github.objective(predecessor);
    if (
      createHash("sha256").update(remote.body).digest("hex") !==
      previous.objectiveBodyDigest
    )
      throw refusal(predecessor, "body changed after acceptance");
    const {
      sealedAt,
      commit,
      tree,
      graphDigest,
      configDigest,
      evidenceDigest,
    } = previous.finalAcceptance;
    const ancestor = await gitAsync(
      config.checkout,
      "merge-base",
      "--is-ancestor",
      commit,
      baseSha,
    ).then(
      () => true,
      () => false,
    );
    if (!ancestor)
      throw refusal(
        predecessor,
        `accepted commit ${commit} is not in base ${baseSha}`,
      );
    let gitTree: string | undefined;
    try {
      gitTree = git(config.checkout, "rev-parse", `${commit}^{tree}`);
    } catch {
      gitTree = undefined;
    }
    if (gitTree !== tree)
      throw refusal(predecessor, "accepted tree differs from Git");
    evidence.predecessors.push({
      objective: predecessor,
      bodyDigest: previous.objectiveBodyDigest,
      acceptance: {
        ...(previous.finalAcceptance.candidateBasis === undefined
          ? {}
          : { candidateBasis: previous.finalAcceptance.candidateBasis }),
        sealedAt,
        commit,
        tree,
        graphDigest,
        configDigest,
        evidenceDigest,
      },
      status: "accepted-and-closed",
      baseRelationship: commit === baseSha ? "equal" : "descendant",
    });
  }
  return evidence;
}
