import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ValidationCommandReceipt } from "./contracts.js";
import type { HydrationReceipt } from "./media.js";
import type { ReviewEvidenceReference } from "./review-evidence.js";

export interface CriterionEvidence {
  criterion: string;
  verdict: "pass" | "human-accept";
  source?: string;
  quote?: string;
  evidence?: ReviewEvidenceReference[];
  detail: string;
}

export interface AcceptanceDecision {
  criterion: string;
  treeSha: string;
  actor: string;
  at: string;
  outcome: "accept" | "refuse";
  reason: string;
}

export interface ValidationEvidence {
  treeSha: string;
  commands: ValidationCommandReceipt[];
  selectedLfs?: SelectedLfsValidation[];
  hydrationReceipt?: HydrationReceipt;
  worktreeObservation?: ValidationWorktreeObservation;
  criteria?: CriterionEvidence[];
}

export interface ValidationWorktreeObservation {
  treeSha: string;
  initialStatus: "clean";
  /** Status may differ from empty only because selected bytes were hydrated. */
  postHydrationStatus: { porcelainSha256: string; empty: boolean };
  postCommandStatus: "unchanged";
  selectedLfsMembers: number;
  subprocessOwnership: "settled";
}

/** Retained absence is not a fabricated successful observation. */
export function assertValidationWorktreeObservation(
  value: unknown,
  treeSha: string,
  selectedLfs: SelectedLfsValidation[] = [],
): asserts value is ValidationWorktreeObservation | undefined {
  if (value === undefined) return;
  const observation = value as ValidationWorktreeObservation;
  const emptyDigest = createHash("sha256").update("").digest("hex");
  if (
    !observation ||
    typeof observation !== "object" ||
    Array.isArray(observation) ||
    Object.keys(observation).sort().join() !==
      [
        "treeSha",
        "initialStatus",
        "postHydrationStatus",
        "postCommandStatus",
        "selectedLfsMembers",
        "subprocessOwnership",
      ]
        .sort()
        .join() ||
    observation.treeSha !== treeSha ||
    !/^[a-f0-9]{40}$/.test(observation.treeSha) ||
    observation.initialStatus !== "clean" ||
    observation.postCommandStatus !== "unchanged" ||
    observation.subprocessOwnership !== "settled" ||
    !Number.isSafeInteger(observation.selectedLfsMembers) ||
    observation.selectedLfsMembers !== selectedLfs.length ||
    !observation.postHydrationStatus ||
    typeof observation.postHydrationStatus !== "object" ||
    Array.isArray(observation.postHydrationStatus) ||
    Object.keys(observation.postHydrationStatus).sort().join() !==
      "empty,porcelainSha256" ||
    typeof observation.postHydrationStatus.empty !== "boolean" ||
    typeof observation.postHydrationStatus.porcelainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(observation.postHydrationStatus.porcelainSha256) ||
    observation.postHydrationStatus.empty !==
      (observation.postHydrationStatus.porcelainSha256 === emptyDigest) ||
    (!observation.postHydrationStatus.empty && !selectedLfs.length)
  )
    throw new Error(
      "Validator worktree observation differs from its canonical exact-tree evidence",
    );
}

export interface SelectedLfsValidation {
  treeSha: string;
  destination: string;
  digest: string;
  bytes: number;
  filter: "lfs";
}

export function assertSelectedLfsValidation(
  value: unknown,
  treeSha: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new Error("Invalid selected LFS validation evidence");
  const destinations = new Set<string>();
  for (const receipt of value) {
    if (
      !receipt ||
      receipt.treeSha !== treeSha ||
      typeof receipt.destination !== "string" ||
      !safeValidationPath(receipt.destination) ||
      destinations.has(receipt.destination) ||
      typeof receipt.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.digest) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.filter !== "lfs"
    )
      throw new Error(
        "Selected LFS validation evidence differs from the exact tree or member",
      );
    destinations.add(receipt.destination);
  }
}

export function safeValidationPath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    path !== ".git" &&
    !path.startsWith(".git/")
  );
}
