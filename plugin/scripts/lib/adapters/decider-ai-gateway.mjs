// Vercel AI Gateway's decisions endpoint behind the decider contract (decider.mjs). Plain fetch, no SDK. The key is held
// in this closure only; an error names a code, never the request or the key.
import { DECIDER_ERRORS, errorOf } from "./decider.mjs";

export const GATEWAY_DECISIONS = "https://ai-gateway.vercel.sh/v1/decisions";

/** One answer of the endpoint as {verdict, confidence}: a refusal, an unknown choice or no answer is no verdict. */
export function parseDecision(json, question) {
  const answers = Array.isArray(json?.answers) ? json.answers : [];
  const a = answers.find((x) => x?.name === question.name) ?? answers[0];
  if (!a) return { verdict: null, confidence: null, error: "no_answer" };
  if (a.type === "refusal") return { verdict: null, confidence: null, error: "refused" };
  if (a.type !== "choice" || !question.choices.some((c) => c.value === a.choice)) return { verdict: null, confidence: null, error: "no_answer" };
  const c = Number(a.confidence);
  return { verdict: a.choice, confidence: Number.isFinite(c) ? c : null };
}

/** One retry on a 429, a 5xx or a network error. */
export function gatewayDecider({ key, model, endpoint = GATEWAY_DECISIONS, timeoutMs = 30_000 }) {
  return {
    name: "ai-gateway",
    model,
    async decide(input, question) {
      const body = JSON.stringify({ model, input, questions: [question] });
      let error = "vendor";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const res = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
          const text = await res.text();
          if (res.ok) {
            try {
              return parseDecision(JSON.parse(text), question);
            } catch {
              return { verdict: null, confidence: null, error: "vendor" };
            }
          }
          error = errorOf(res.status);
          if (res.status !== 429 && res.status < 500) break;
        } catch {
          error = "unavailable";
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
      return { verdict: null, confidence: null, error: DECIDER_ERRORS.includes(error) ? error : "vendor" };
    },
  };
}
