import { createHash } from "node:crypto";
import type { FactoryConfig } from "./config.js";
import type { GitHubGateway, PlanningPrerequisites } from "./contracts.js";
import { objectiveComplete } from "./completion.js";
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
  for (const predecessor of [...predecessors].sort((a, b) => a - b)) {
    const previous = readContinuation(config.repository, predecessor);
    if (
      previous?.schemaVersion !== 4 ||
      !objectiveComplete(previous) ||
      !previous.finalAcceptance
    )
      throw new Error(
        `Predecessor #${predecessor} lacks bound accepted integration evidence`,
      );
    const remote = await github.objective(predecessor);
    if (
      createHash("sha256").update(remote.body).digest("hex") !==
      previous.objectiveBodyDigest
    )
      throw new Error(
        `Predecessor #${predecessor} body changed after acceptance`,
      );
    const {
      sealedAt,
      commit,
      tree,
      graphDigest,
      configDigest,
      evidenceDigest,
    } = previous.finalAcceptance;
    await gitAsync(
      config.checkout,
      "merge-base",
      "--is-ancestor",
      commit,
      baseSha,
    );
    if (git(config.checkout, "rev-parse", `${commit}^{tree}`) !== tree)
      throw new Error(
        `Predecessor #${predecessor} accepted tree differs from Git`,
      );
    evidence.predecessors.push({
      objective: predecessor,
      bodyDigest: previous.objectiveBodyDigest,
      acceptance: {
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
