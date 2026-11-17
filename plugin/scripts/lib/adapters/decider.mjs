// The decision-model adapter contract (docs/ADAPTERS.md). Every vendor that answers Pendulum's typed questions sits behind
// this one shape, so a second vendor is one module beside decider-ai-gateway.mjs and decider-harness.mjs, not a
// refactor. No vendor-side state: each question is one stateless call. Callers open a decider through lib/decider.mjs,
// which picks the vendor.

/**
 * @typedef {{ type: "choice", name: string, instructions: string, choices: { value: string, description?: string }[] }} Question
 * @typedef {{ verdict: string | null, confidence: number | null, error?: string, spend?: object }} Answer  `error` is one
 *   of DECIDER_ERRORS. `spend`: what a vendor that bills per call reports it cost (decider-ai-gateway.mjs: `usd`, its
 *   tries of unknown cost as `usdUnknown`/`usdUnknownWhy`, `calls`, `model`, `started`, `ended`); a vendor that keeps its
 *   own usage record (decider-harness.mjs) gives none.
 *
 * @typedef {object} DeciderAdapter
 * @property {string} name  The vendor.
 * @property {string} model  The decision model asked.
 * @property {(input: string, question: Question, options?: { signal?: AbortSignal, issue?: number, repo?: string }) => Promise<Answer>} decide  Never
 *   throws: a failure is `error` with no verdict. `signal` ends the call early; `issue` and `repo` (`owner/name`) name
 *   the Objective a call made outside a stage is about, for its spend record (lib/decision-spend.mjs).
 */

/**
 * The error codes an answer carries. Callers decide on the code, never on a message. `budget` is the interface's own
 * (lib/decider.mjs): a non-essential call not made because the stage's max_usd has less known left than its cap.
 */
export const DECIDER_ERRORS = Object.freeze(["auth", "billing", "rate_limited", "unavailable", "invalid", "refused", "no_answer", "vendor", "budget"]);

/** An HTTP status as one of DECIDER_ERRORS: 402 is the vendor's credits or billing. */
export const errorOf = (status) => (status === 401 || status === 403 ? "auth" : status === 402 ? "billing" : status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : status >= 400 ? "invalid" : "vendor");

/** The vendors: the AI Gateway's decision model, and the stage's own harness on its own login. */
export const DECIDER_VENDORS = Object.freeze(["ai-gateway", "harness"]);

/** The adapter for `vendor` (DECIDER_VENDORS). The vendor module loads only here. */
export async function openVendor({ vendor = "ai-gateway", ...options }) {
  if (vendor === "ai-gateway") {
    const { gatewayDecider } = await import("./decider-ai-gateway.mjs");
    return gatewayDecider(options);
  }
  if (vendor === "harness") {
    const { harnessDecider } = await import("./decider-harness.mjs");
    return harnessDecider(options);
  }
  throw new TypeError(`unknown decider vendor ${vendor}`);
}
