// The decision-model adapter contract (docs/ADAPTERS.md). Every vendor that answers Factory's typed questions about a
// red check sits behind this one shape, so a second vendor is one module beside decider-ai-gateway.mjs, not a refactor.
// No vendor-side state: each question is one stateless call.

/**
 * @typedef {{ type: "choice", name: string, instructions: string, choices: { value: string, description?: string }[] }} Question
 * @typedef {{ verdict: string | null, confidence: number | null, error?: string }} Answer  `error` is one of ERROR_CODES.
 *
 * @typedef {object} DeciderAdapter
 * @property {string} name  The vendor.
 * @property {string} model  The decision model asked.
 * @property {(input: string, question: Question) => Promise<Answer>} decide  Never throws: a failure is `error` with no verdict.
 */

/** The error codes an answer carries. Callers decide on the code, never on a message. */
export const DECIDER_ERRORS = Object.freeze(["auth", "rate_limited", "unavailable", "invalid", "refused", "no_answer", "vendor"]);

/** An HTTP status as one of DECIDER_ERRORS. */
export const errorOf = (status) => (status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : status >= 400 ? "invalid" : "vendor");

/** The adapter for `vendor`; only `ai-gateway` exists. The vendor module loads only here. */
export async function openDecider({ vendor = "ai-gateway", ...options }) {
  if (vendor !== "ai-gateway") throw new TypeError(`unknown decider vendor ${vendor}`);
  const { gatewayDecider } = await import("./decider-ai-gateway.mjs");
  return gatewayDecider(options);
}
