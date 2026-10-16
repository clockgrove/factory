import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentSessionCapabilities,
  AgentSessionContinuation,
  AgentSessionReconciliation,
  AgentSessionRef,
  ModelInvocationContext,
  ModelInvocationPhase,
  ModelInvocationUsage,
  PlanningRequest,
  RetainedPlannerCheckpointCoverage,
  ReviewImageInput,
} from "../contracts.js";
import type { Fault } from "../fault.js";
import { attachFault } from "../fault.js";
import type { PromptSection } from "../prompt-bytes.js";
import {
  assertReviewImageBytes,
  MAX_REVIEW_IMAGE_BYTES,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_TOTAL_IMAGE_BYTES,
} from "../review-artifacts.js";
import type { ReviewBodyFile, ReviewPacket } from "../review-evidence.js";
import type { PlanningSourceDelivery } from "./source-delivery.js";

export interface PlanningModelOptions {
  /** Nonrenewable elapsed budget for one admitted planning invocation, including capacity backoff. */
  providerTurnElapsedTimeoutMs?: number;
  reviewCapacityRetryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}

export interface CodexPlanningModelOptions extends PlanningModelOptions {
  /** Capture redaction only; never sent to the provider. */
  redactionValues?: string[];
  /** Installation-owned private reviewer session storage; absence uses fresh turns. */
  sessionRoot?: string;
  /** Explicit planning transport; no runtime fallback. */
  transport?: "exec" | "app-server";
  /** Canonical-source-only file reads for exec planners; enabled by default. */
  sourceArtifacts?: boolean;
}

/** Which configured model selection a planning call uses. */
export type PlanningRole = "planner" | "reviewer";

/** What one provider attempt reported; read even when the transport throws. */
export interface PlanningTurn {
  /** Final structured-output text, or partial text when the attempt failed. */
  response: string;
  usage?: ModelInvocationUsage;
  providerThreadId?: string;
  /** The provider reported a terminal success or failure for this attempt. */
  ended: boolean;
  /** Native invocation and owned process group have demonstrably ceased. */
  stopped?: boolean;
  /** Transport-classified failure; otherwise the shared classifier applies. */
  failureClass?: string;
  /** Fault from structured provider facts (billing, a limit's reset time). */
  fault?: Fault;
  /** Native invocation was admitted; provider dispatch may have happened. */
  nativeInvocationStarted?: boolean;
  /** Observed model activity; absence never proves an unpaid native invocation. */
  started?: boolean;
}

/**
 * Provider-specific transport for one structured planning attempt. Prompts,
 * schemas, retries, parsing, decoding and outcome observations are shared by
 * StructuredPlanningModel, so providers differ only here.
 */
export interface PlanningTransport {
  readonly provider: string;
  /** Pinned adapter identity recorded with opt-in captures. */
  readonly adapter: string;
  /** The selected native route can acknowledge the logical callback with complete native intent before its first effect. */
  logicalDispatchAdmission?(
    tree?: string,
  ): "native-before-effect-v1" | undefined;
  readonly sessionCapabilities?: AgentSessionCapabilities;
  /** Native image observations; absence is unsupported, never silent omission. */
  readonly retainedPlannerCheckpointCoverage?: RetainedPlannerCheckpointCoverage;
  readonly reviewImageInput?: "png-local-file-v1";
  reconcileSession?(
    session: AgentSessionRef,
  ): Promise<AgentSessionReconciliation>;
  releaseSession?(session: AgentSessionRef): Promise<void>;
  /** Authenticated immutable source reads; absence retains full inline context. */
  sourceDelivery?(
    request: PlanningRequest<unknown>,
    recover?: boolean,
  ): PlanningSourceDelivery | undefined;
  /** Own fresh files from before rendering through native resource settlement. */
  withSourceDelivery?<T>(
    request: PlanningRequest<unknown>,
    run: (delivery?: PlanningSourceDelivery) => Promise<T>,
  ): Promise<T>;
  /** Graph review reads canonical packet bodies, never the target checkout. */
  withGraphReviewFiles?<T>(
    packet: ReviewPacket,
    run: (files: ReviewBodyFile[], root: string) => Promise<T>,
  ): Promise<T>;
  selection(role: PlanningRole): {
    model: string;
    reasoningEffort?: string;
    serviceTier?: import("../config.js").CodexServiceTier;
  };
  /** Provider settings recorded with opt-in request capture content. */
  settings(role: PlanningRole, tree?: string): Record<string, unknown>;
  /**
   * Run one attempt, filling `turn`; progress observations are optional. With
   * `tree`, the session may read that directory with read-only tools. An
   * exec planner reads only its current canonical source artifacts, offline.
   * Tool-free adapters retain their existing inline delivery.
   */
  run(args: {
    role: PlanningRole;
    prompt: string;
    schema: unknown;
    sourcePacket?: string;
    planningSources?: {
      baseSha: string;
      sources: PlanningRequest<unknown>["sources"];
      suppliedSourceIndices: number[];
      delivery?: PlanningSourceDelivery;
    };
    candidateDigest?: string;
    invocation: ModelInvocationContext;
    /** Confirm complete logical/native acknowledgment only after it succeeds; void callers retain native admission. */
    beforeNativeDispatch?: NonNullable<
      ModelInvocationContext["beforeProviderDispatch"]
    >;
    turn: PlanningTurn;
    tree?: string;
    reviewImages?: ReviewImageInput[];
    session?: AgentSessionContinuation;
    continuation?: StructuredCall["continuation"];
    /** Optional caller deadline; the transport still proves owned process settlement. */
    signal?: AbortSignal;
    /** Admitted elapsed ceiling; native activity never renews it. */
    deadlineAt?: string;
  }): Promise<void>;
}

export interface StructuredCall {
  promptSections?: PromptSection[];
  exportedEvidenceFileBytes?: number;
  /** Opt-in private capture only; full backing evidence is not provider input. */
  reviewPacket?: import("../review-evidence.js").ReviewPacket;
  role: PlanningRole;
  prompt: string;
  schema: unknown;
  invocation: ModelInvocationContext | undefined;
  defaultPhase: ModelInvocationPhase;
  sourcePacket?: string;
  planningSources?: {
    baseSha: string;
    sources: PlanningRequest<unknown>["sources"];
    suppliedSourceIndices: number[];
    delivery?: PlanningSourceDelivery;
  };
  candidateDigest?: string;
  /** A directory holding the exact tree under review, readable read-only. */
  tree?: string;
  reviewImages?: ReviewImageInput[];
  session?: AgentSessionContinuation;
  /**
   * The same request for a conversation that already holds it: `prompt`
   * carries only what changed, and `base` digests everything else. An
   * adapter may send `prompt` instead only after a completed turn of that
   * conversation received the same base; `prompt` stays the logical request.
   */
  continuation?: { base: string; prompt: string };
}

export const CODEX_PLANNING_PROVIDER = "openai-codex-sdk";

export const CODEX_PLANNING_ADAPTER = "@openai/codex@0.160.0/exec-session-v2";
export const CODEX_APP_SERVER_PLANNING_ADAPTER =
  "@openai/codex@0.160.0/tool-free-app-server-tree-exec-v1";

/** Only the qualified retained-planner producers declare this exact coverage. */
export function assertRetainedPlannerCheckpointCoverage(
  value: unknown,
): asserts value is RetainedPlannerCheckpointCoverage {
  const proof = value as RetainedPlannerCheckpointCoverage | undefined;
  if (
    !proof ||
    Object.keys(proof).sort().join() !== "adapter,contract" ||
    proof.contract !== "retained-planner-native-checkpoint-v1" ||
    ![CODEX_PLANNING_ADAPTER, CODEX_APP_SERVER_PLANNING_ADAPTER].includes(
      proof.adapter,
    )
  )
    throw new Error(
      "Planning resource coverage has no recognized native checkpoint producer",
    );
}

/** Exact rendered turn input, shared with authenticated recovery decoding. */
export function structuredRequestDigest(
  prompt: string,
  schema: unknown,
  images?: readonly ReviewImageInput[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        images?.length
          ? [prompt, schema, reviewImageIdentities(images)]
          : [prompt, schema],
      ),
    )
    .digest("hex");
}

/** Stable identities authenticate the actual ordered image input, not its temporary location. */
export function reviewImageIdentities(images: readonly ReviewImageInput[]) {
  return images.map(({ mediaType, bytes, digest, evidencePath }) => ({
    mediaType,
    bytes,
    digest,
    evidencePath,
  }));
}

export function unsupportedReviewImages(adapter: string): Error {
  const detail = `${adapter} does not support direct PNG review input on this route`;
  return attachFault(new Error(detail), {
    kind: "config",
    detail,
    fix: "Use a reviewer adapter with native PNG input support; preserve the pending result and its existing allowances.",
  });
}

/** Verify complete bounded raw bytes before admission and again at native dispatch. */
export function assertReviewImages(
  images: readonly ReviewImageInput[] | undefined,
  tree: string | undefined,
): void {
  if (!images?.length) return;
  try {
    verifyReviewImages(images, tree);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw attachFault(error, {
      kind: "config",
      detail,
      fix: "Restore the exact controller-materialized PNG evidence within the recorded bounds before another admitted review.",
    });
  }
}

function verifyReviewImages(
  images: readonly ReviewImageInput[],
  tree: string | undefined,
): void {
  const invalid = (detail: string): never => {
    throw attachFault(new Error(detail), {
      kind: "config",
      detail,
      fix: "Restore the exact controller-materialized PNG evidence within the recorded bounds before another admitted review.",
    });
  };
  if (!tree || !isAbsolute(tree) || images.length > MAX_REVIEW_IMAGES)
    invalid(
      "Image review needs a private evidence root and at most eight PNG inputs",
    );
  const root = resolve(tree!);
  if (realpathSync(root) !== root)
    invalid("Image review root must not be a symlink");
  let total = 0;
  const seen = new Set<string>();
  for (const image of images) {
    if (
      image.mediaType !== "image/png" ||
      !Number.isSafeInteger(image.bytes) ||
      image.bytes < 8 ||
      image.bytes > MAX_REVIEW_IMAGE_BYTES ||
      !/^[a-f0-9]{64}$/.test(image.digest) ||
      !isAbsolute(image.path)
    )
      invalid(
        "Image review descriptor has an invalid PNG identity or byte bound",
      );
    total += image.bytes;
    if (total > MAX_REVIEW_TOTAL_IMAGE_BYTES || seen.has(image.evidencePath))
      invalid(
        "Image review exceeds its aggregate bound or repeats an evidence identity",
      );
    seen.add(image.evidencePath);
    const local = relative(root, image.path);
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local) ||
      local.split(sep).join("/") !== image.evidencePath ||
      realpathSync(image.path) !== image.path
    )
      invalid(
        "Image review file must match its identity within the private evidence root",
      );
    const info = lstatSync(image.path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0)
      invalid(
        "Image review input must be a regular read-only materialized file",
      );
    const fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd);
      if (
        !actual.isFile() ||
        actual.size !== image.bytes ||
        (actual.mode & 0o222) !== 0
      )
        invalid("Image review byte count differs from the admitted identity");
      const bytes = Buffer.alloc(image.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read)
          invalid("Image review file ended before its complete admitted bytes");
        offset += read;
      }
      if (fstatSync(fd).size !== image.bytes)
        invalid("Image review file size changed during admission");
      assertReviewImageBytes(bytes);
      if (
        bytes.length !== image.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== image.digest
      )
        invalid("Image review raw PNG bytes differ from the admitted identity");
    } finally {
      closeSync(fd);
    }
  }
}
