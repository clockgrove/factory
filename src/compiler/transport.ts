import { createHash } from "node:crypto";
import type {
  AgentSessionCapabilities,
  AgentSessionContinuation,
  AgentSessionReconciliation,
  AgentSessionRef,
  ModelInvocationContext,
  ModelInvocationPhase,
  ModelInvocationUsage,
  PlanningRequest,
} from "../contracts.js";
import type { Fault } from "../fault.js";
import type { PromptSection } from "../prompt-bytes.js";
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
  /** Explicitly enable canonical-source-only file reads for new exec planners. */
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
  readonly sessionCapabilities?: AgentSessionCapabilities;
  reconcileSession?(
    session: AgentSessionRef,
  ): Promise<AgentSessionReconciliation>;
  releaseSession?(session: AgentSessionRef): Promise<void>;
  /** Authenticated immutable source reads; absence retains full inline context. */
  sourceDelivery?(
    request: PlanningRequest<unknown>,
    recover?: boolean,
  ): PlanningSourceDelivery | undefined;
  selection(role: PlanningRole): { model: string; reasoningEffort?: string };
  /** Provider settings recorded with opt-in request capture content. */
  settings(role: PlanningRole, tree?: string): Record<string, unknown>;
  /**
   * Run one attempt, filling `turn`; progress observations are optional. With
   * `tree`, the session may read that directory with read-only tools. An
   * explicitly configured retained planner may instead read only its current
   * canonical source artifacts, offline; other planning calls are tool-free.
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
    turn: PlanningTurn;
    tree?: string;
    session?: AgentSessionContinuation;
    /** Optional caller deadline; the transport still proves owned process settlement. */
    signal?: AbortSignal;
    /** Admitted elapsed ceiling; native activity never renews it. */
    deadlineAt?: string;
  }): Promise<void>;
}

export interface StructuredCall {
  promptSections?: PromptSection[];
  exportedEvidenceFileBytes?: number;
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
  session?: AgentSessionContinuation;
}

export const CODEX_PLANNING_PROVIDER = "openai-codex-sdk";

export const CODEX_PLANNING_ADAPTER = "@openai/codex@0.160.0/exec-session-v2";

/** Exact rendered turn input, shared with authenticated recovery decoding. */
export function structuredRequestDigest(
  prompt: string,
  schema: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([prompt, schema]))
    .digest("hex");
}
