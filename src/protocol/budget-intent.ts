import type { RunPolicy } from "./policy.js";

export interface ModelTokenBudgetIntent {
  mode: "none" | "hard" | "observed-stop" | "legacy-observed-stop";
  limit: number | null;
  hardCapEnforced: false;
}

/** Interpretation only; this neither changes a durable policy nor grants admission. */
export function modelTokenBudgetIntent(policy: RunPolicy): ModelTokenBudgetIntent {
  return {
    mode: policy.economics
      ? (policy.economics.modelTokenBudgetMode ?? "legacy-observed-stop")
      : "none",
    limit: policy.economics?.maxModelTokens ?? null,
    hardCapEnforced: false,
  };
}

/** All currently supported model interfaces lack an enforceable per-call token ceiling. */
export function assertSupportedModelTokenBudgetIntent(policy: RunPolicy): void {
  if (policy.economics?.modelTokenBudgetMode === "hard") {
    throw new Error(
      "economics.modelTokenBudgetMode=hard is unsupported: no supported provider enforces the requested model-token ceiling; explicitly select observed-stop to allow in-flight overshoot, or omit the token threshold",
    );
  }
}

/** Fresh policy admission. Legacy interpretation is reserved for authenticated recorded recovery. */
export function assertNewRunBudgetIntent(policy: RunPolicy): void {
  assertSupportedModelTokenBudgetIntent(policy);
  if (policy.economics && policy.economics.modelTokenBudgetMode === undefined) {
    throw new Error(
      "economics.maxModelTokens requires explicit economics.modelTokenBudgetMode=observed-stop for a new request; terminal usage is not a hard cap and in-flight calls may overshoot",
    );
  }
}
