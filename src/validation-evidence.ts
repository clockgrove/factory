import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ContentRef, ValidationCommandReceipt } from "./contracts.js";
import type { ReviewArtifactEvidence } from "./review-artifacts.js";
import type { HydrationReceipt } from "./media.js";
import type {
  ReviewEvidenceReference,
  ReviewPacket,
} from "./review-evidence.js";

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
  /** Original native review returns; observations, never replacement acceptance. */
  nativeReturns?: ContentRef[];
  treeSha: string;
  commands: ValidationCommandReceipt[];
  /** Complete command-selected raw artifacts retained before checkout cleanup. */
  reviewArtifacts?: ReviewArtifactEvidence[];
  /** Source-authorized setup in this same fresh tree; never criterion evidence. */
  preparation?: ValidationCommandReceipt[];
  selectedLfs?: SelectedLfsValidation[];
  hydrationReceipt?: HydrationReceipt;
  worktreeObservation?: ValidationWorktreeObservation;
  criteria?: CriterionEvidence[];
  /** Bounded complete literal entries cited by this tree's successful review. */
  reviewEvidence?: ReviewPacket["evidence"];
}

/** Validate observed scope only; an absent control remains unknown. */
export function assertValidationExecutionControl(value: unknown): void {
  if (value === undefined) return;
  const control = value as NonNullable<
    ValidationCommandReceipt["executionControl"]
  >;
  if (
    !control ||
    typeof control !== "object" ||
    Array.isArray(control) ||
    Object.keys(control).sort().join() !==
      (control.deadlineAt === undefined
        ? "cancellation,scope,settlement"
        : "cancellation,deadlineAt,scope,settlement") ||
    control.scope !== "controller-owned-process-group" ||
    control.cancellation !== "active-at-dispatch" ||
    control.settlement !== "verified" ||
    (control.deadlineAt !== undefined &&
      (typeof control.deadlineAt !== "string" ||
        !Number.isFinite(Date.parse(control.deadlineAt))))
  )
    throw new Error(
      "Validation execution control is not an observed owned scope",
    );
}

/** The fields every review citation declares (#1254). */
function declaredReference(value: object): Record<string, unknown> {
  const { id, origin, path, digest, complete } = value as Record<
    string,
    unknown
  >;
  return { id, origin, path, digest, complete };
}

/** Retention never manufactures missing bodies or changes a citation's identity. */
export function assertRetainedReviewEvidence(
  value: Pick<ValidationEvidence, "criteria" | "reviewEvidence">,
): void {
  if (value.reviewEvidence === undefined) return;
  if (!Array.isArray(value.reviewEvidence) || !Array.isArray(value.criteria))
    throw new Error("Retained review evidence lacks its original findings");
  const cited = new Map<string, ReviewEvidenceReference>();
  for (const finding of value.criteria) {
    if (finding.verdict !== "pass") continue;
    if (!Array.isArray(finding.evidence) || !finding.evidence.length)
      throw new Error("Retained passing finding lacks literal citations");
    for (const reference of finding.evidence) {
      if (
        !reference ||
        typeof reference.id !== "string" ||
        !reference.id ||
        typeof reference.path !== "string" ||
        !reference.path ||
        !["source", "controller"].includes(reference.origin) ||
        reference.complete !== true ||
        typeof reference.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(reference.digest) ||
        (cited.has(reference.id) &&
          !isDeepStrictEqual(cited.get(reference.id), reference))
      )
        throw new Error(
          "Retained review citation is incomplete or conflicting",
        );
      cited.set(reference.id, reference);
    }
  }
  const seen = new Set<string>();
  for (const entry of value.reviewEvidence) {
    if (!entry || typeof entry.content !== "string")
      throw new Error("Retained review literal body is invalid");
    const { content, reusableBody } = entry;
    // A citation carries its declared reference (#1254); a retained body keeps
    // its input's other fields, such as a pinned source's heading. A citation
    // saved before #1254 also carries those fields, and they must match.
    const citation = cited.get(entry.id) as Record<string, unknown> | undefined;
    if (
      seen.has(entry.id) ||
      !citation ||
      !isDeepStrictEqual(
        declaredReference(citation),
        declaredReference(entry),
      ) ||
      Object.keys(citation).some(
        (key) =>
          !(key in declaredReference(citation)) &&
          !isDeepStrictEqual(
            citation[key],
            (entry as unknown as Record<string, unknown>)[key],
          ),
      ) ||
      entry.complete !== true ||
      Buffer.from(content).toString("utf8") !== content ||
      createHash("sha256").update(content).digest("hex") !== entry.digest
    )
      throw new Error(
        "Retained review body differs from its complete citation",
      );
    if (
      reusableBody &&
      (!Number.isSafeInteger(reusableBody.start) ||
        !Number.isSafeInteger(reusableBody.length) ||
        reusableBody.start < 0 ||
        reusableBody.length < 0 ||
        reusableBody.start + reusableBody.length > content.length ||
        createHash("sha256")
          .update(
            content.slice(
              reusableBody.start,
              reusableBody.start + reusableBody.length,
            ),
          )
          .digest("hex") !== reusableBody.digest)
    )
      throw new Error("Retained review body selector differs from its bytes");
    seen.add(entry.id);
  }
}

export interface ValidationWorktreeObservation {
  treeSha: string;
  /** The owning validator created this checkout before executing this sequence. */
  checkoutPreparation?: {
    kind: "fresh-detached-worktree";
    commitSha: string;
    commandSequence: "after-checkout-creation";
    /** Only finalization of a recorded current-graph integration supplies this. */
    afterIntegrationSha?: string;
  };
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
  commitSha?: string,
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
        ...(observation.checkoutPreparation === undefined
          ? []
          : ["checkoutPreparation"]),
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
  const prepared = observation.checkoutPreparation;
  if (
    prepared !== undefined &&
    (!prepared ||
      typeof prepared !== "object" ||
      Array.isArray(prepared) ||
      Object.keys(prepared).sort().join() !==
        [
          "kind",
          "commitSha",
          "commandSequence",
          ...(prepared.afterIntegrationSha === undefined
            ? []
            : ["afterIntegrationSha"]),
        ]
          .sort()
          .join() ||
      prepared.kind !== "fresh-detached-worktree" ||
      typeof prepared.commitSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(prepared.commitSha) ||
      (commitSha !== undefined && prepared.commitSha !== commitSha) ||
      prepared.commandSequence !== "after-checkout-creation" ||
      (prepared.afterIntegrationSha !== undefined &&
        (typeof prepared.afterIntegrationSha !== "string" ||
          !/^[a-f0-9]{40}$/.test(prepared.afterIntegrationSha))))
  )
    throw new Error(
      "Validation checkout preparation differs from its exact candidate",
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
