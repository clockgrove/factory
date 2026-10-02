import { createHash } from "node:crypto";

export interface ControllerCapabilitiesManifest {
  schemaVersion: 1;
  manifestId: "factory-controller-capabilities/v1";
  guarantees: {
    id: string;
    statement: string;
  }[];
}

const manifest: ControllerCapabilitiesManifest = {
  schemaVersion: 1,
  manifestId: "factory-controller-capabilities/v1",
  guarantees: [
    {
      id: "independent-result-review",
      statement:
        "For ordinary regular and native-stack Work Items, Factory validates the exact result tree and requires a separate configured acceptance review before publishing that result. Human acceptance is recorded separately and never counts as an automatic passing independent review. Final Objective review receives controller-derived review completion facts for each exact delivered result, without treating prior reviewer prose as product proof.",
    },
    {
      id: "reviewed-head-publication",
      statement:
        "Only the controller publishes Work Item branches and pull requests. It verifies that each published PR head is the exact result commit whose tree passed validation and acceptance review; workers receive no publication authority.",
    },
    {
      id: "protected-exact-head-integration",
      statement:
        "Factory observes authenticated exact PR identities and check readiness before submitting regular or native-stack integration, requires every source-required named check admitted in the graph to have successful exact-head evidence (including waiting when it has not registered), supplies expected heads, and honors the target's existing GitHub protection and required checks without bypass. Final Objective review receives compact successful uniquely named check identities actually observed on each published head before integration. Missing, ambiguous, stale, pending, neutral, skipped or failing check results do not become successful named-check evidence; configured guarantees never claim that future checks have already passed.",
    },
    {
      id: "selected-set-materialization",
      statement:
        "Factory captures complete candidate AssetSets in private staging and stops for explicit human whole-set selection. It then materializes only selected bytes to Work Item-owned destinations, enforces the target Git attributes for every required LFS role, scans the staged result, and verifies each committed LFS pointer against the captured SHA-256 digest and byte count.",
    },
    {
      id: "required-lfs-publication",
      statement:
        "Factory uploads required selected Git LFS objects for the exact validated result commit before publishing its Git branch or pull request.",
    },
    {
      id: "post-integration-hydration",
      statement:
        "After target Final commands pass at the exact integrated default-branch commit and before Objective completion, Factory fresh-clones the target origin, checks out that exact commit, pulls Git LFS objects, and verifies every selected member against its captured SHA-256 digest and byte count.",
    },
    {
      id: "hydration-review-evidence",
      statement:
        "Factory supplies a bounded successful hydration receipt tied to the exact integrated commit, tree, selected set, destination, SHA-256 digest, and byte count to final Objective acceptance review; a hydration failure prevents review success and Objective closure.",
    },
  ],
};

const serializedManifest = JSON.stringify(manifest);

export const CONTROLLER_CAPABILITIES_DIGEST = createHash("sha256")
  .update(serializedManifest)
  .digest("hex");

export function installedControllerCapabilities(): ControllerCapabilitiesManifest {
  return JSON.parse(serializedManifest) as ControllerCapabilitiesManifest;
}

export function assertInstalledControllerCapabilities(
  candidate: unknown,
  candidateDigest: unknown,
): asserts candidate is ControllerCapabilitiesManifest {
  if (
    JSON.stringify(candidate) !== serializedManifest ||
    candidateDigest !== CONTROLLER_CAPABILITIES_DIGEST
  )
    throw new Error(
      "Plan controller capabilities differ from the installed Factory artifact; run plan again",
    );
}
