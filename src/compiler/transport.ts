import type {
  ModelInvocationUsage,
  ModelInvocationContext,
  ModelInvocationPhase,
} from "../contracts.js";
import type { Fault } from "../fault.js";

export interface PlanningModelOptions {
  reviewCapacityRetryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}

export interface CodexPlanningModelOptions extends PlanningModelOptions {
  /** Capture redaction only; never sent to the provider. */
  redactionValues?: string[];
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
  /** The model was reached (a Codex item or usage event, a Claude model message). */
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
  selection(role: PlanningRole): { model: string; reasoningEffort?: string };
  /** Provider settings recorded with opt-in request capture content. */
  settings(role: PlanningRole, tree?: string): Record<string, unknown>;
  /**
   * Run one attempt, filling `turn`; progress observations are optional. With
   * `tree`, the session may read that directory with read-only tools; without
   * it the session has no tools, files or network.
   */
  run(args: {
    role: PlanningRole;
    prompt: string;
    schema: unknown;
    invocation: ModelInvocationContext;
    turn: PlanningTurn;
    tree?: string;
    /** Optional caller deadline; the transport still proves owned process settlement. */
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface StructuredCall {
  role: PlanningRole;
  prompt: string;
  schema: unknown;
  invocation: ModelInvocationContext | undefined;
  defaultPhase: ModelInvocationPhase;
  sourcePacket?: string;
  /** A directory holding the exact tree under review, readable read-only. */
  tree?: string;
}

export const CODEX_PLANNING_PROVIDER = "openai-codex-sdk";

export const CODEX_PLANNING_ADAPTER = "@openai/codex@0.160.0/native-owned";
