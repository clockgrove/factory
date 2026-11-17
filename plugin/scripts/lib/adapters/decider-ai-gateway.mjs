// Vercel AI Gateway's decisions endpoint behind the decider contract (decider.mjs). Plain fetch, no SDK. The key is held
// in this closure only; an error names a code, never the request or the key. Each call is priced as the gateway relay
// prices one (gateway-relay.mjs): the generation the answer names is looked up (`/v1/generation`, its `total_cost`), and
// the answer's own reported cost counts when the lookup gives none; a call the gateway refused before any model ran is
// $0; any other call with no figure is of unknown cost (usage.mjs UNKNOWN_WHY `decision`), never $0 or an estimate.
import { setTimeout as sleep } from "node:timers/promises";
import { DECIDER_ERRORS, errorOf } from "./decider.mjs";
import { GATEWAY_ORIGIN, GEN_ID, LOOKUP_DELAYS_MS, LOOKUP_MAX_MS, PRE_MODEL_ERRORS, UNAVAILABLE_ERRORS, UNBILLED, costOf, errorGenerationId, errorTypeOf, gatewayRefusalOf, generationCost } from "../gateway-relay.mjs";

export const GATEWAY_DECISIONS = `${GATEWAY_ORIGIN}/v1/decisions`;

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

/**
 * What one answer of the endpoint cost, before any lookup, by the relay's rules: `{usd, id}`. `usd` is $0 for a call the
 * gateway refused before any model ran (a redirect; an UNBILLED status; its budget or credits 402, gatewayRefusalOf; a
 * 4xx whose `error.type` is one of PRE_MODEL_ERRORS; a 5xx whose type is one of UNAVAILABLE_ERRORS that names no
 * generation), the cost a 2xx answer reports (`providerMetadata.gateway.cost`), else null. `id` is the generation it
 * names (the gateway's metadata, its top-level `generationId` or `id`, or the `x-generation-id` header), to look up.
 */
export function answerCost(status, doc, headerId = null) {
  const id = (status >= 200 && status < 300 ? costOf(doc, "sdk", null, headerId).id : null) || errorGenerationId(doc, headerId);
  if (status >= 300 && status < 400) return { usd: 0, id: null };
  if (UNBILLED.has(status)) return { usd: 0, id };
  if (status === 402 && gatewayRefusalOf(doc)) return { usd: 0, id: null };
  if (status >= 200 && status < 300) return { usd: costOf(doc, "sdk", null, headerId).usd, id };
  const type = errorTypeOf(doc);
  if (type && status >= 400 && status < 500 && PRE_MODEL_ERRORS.has(type)) return { usd: 0, id };
  const said = type ?? errorTypeOf(doc, { topLevel: true });
  if (said && status >= 500 && UNAVAILABLE_ERRORS.has(said) && !id) return { usd: 0, id: null };
  return { usd: null, id };
}

/** Fetch failures whose request never left this machine (its socket never connected): no generation ran, $0. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * A generation's cost from its record, tried at `delaysMs` (the gateway writes it seconds after the answer) within
 * `maxMs`, or null when none came. `signal` ends the wait early (null).
 */
async function lookedUp(id, { key, origin, fetchImpl, delaysMs, maxMs, signal }) {
  const started = Date.now();
  let wait = 0;
  for (const ms of delaysMs) {
    const delay = Math.max(ms, wait);
    if (Date.now() + delay >= started + maxMs || signal?.aborted) return null;
    try {
      await sleep(delay, undefined, signal ? { signal } : {});
    } catch {
      return null;
    }
    const left = started + maxMs - Date.now();
    if (left <= 0) return null;
    const timeout = AbortSignal.timeout(Math.min(60_000, left));
    const r = await generationCost(id, { key, origin, fetchImpl, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (r.usd !== undefined) return r.usd;
    wait = r.retryAfterMs || 0;
  }
  return null;
}

/**
 * One retry on a 429, a 5xx or a network error. The answer carries `spend`, what the call cost (usd.mjs's unknown-spend
 * shape): `usd` the known dollars of its tries (null when none was priced), `usdUnknown` the tries of unknown cost with
 * `usdUnknownWhy` ["decision"], `calls` the tries that reached the gateway, `model`, `started` and `ended`. A try
 * that never left this machine, or that `signal` ended before it was sent, costs nothing and is no call.
 */
export function gatewayDecider({ key, model, endpoint = GATEWAY_DECISIONS, origin = GATEWAY_ORIGIN, timeoutMs = 30_000, lookupDelaysMs = LOOKUP_DELAYS_MS, lookupMaxMs = LOOKUP_MAX_MS, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const price = async (cost, signal) => {
    if (!cost.id || !GEN_ID.test(cost.id)) return cost.usd;
    const looked = await lookedUp(cost.id, { key, origin, fetchImpl, delaysMs: lookupDelaysMs, maxMs: lookupMaxMs, signal });
    // The larger of the two counts, as the relay books it.
    return looked === null ? cost.usd : Math.max(looked, cost.usd ?? 0);
  };
  return {
    name: "ai-gateway",
    model,
    async decide(input, question, { signal = null } = {}) {
      const body = JSON.stringify({ model, input, questions: [question] });
      const started = new Date().toISOString();
      const spend = { usd: null, usdUnknown: 0, calls: 0 };
      const count = (usd) => {
        spend.calls += 1;
        if (usd === null) spend.usdUnknown += 1;
        else spend.usd = Math.round(((spend.usd ?? 0) + usd) * 1e6) / 1e6;
      };
      const done = (answer) => ({ ...answer, spend: { model, ...(spend.usd === null ? { usd: null } : { usd: spend.usd }), ...(spend.usdUnknown ? { usdUnknown: spend.usdUnknown, usdUnknownWhy: ["decision"] } : {}), calls: spend.calls, started, ended: new Date().toISOString() } });
      let error = "vendor";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) break;
        try {
          const res = await fetchImpl(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
          const text = await res.text().catch(() => null);
          let doc = null;
          try {
            doc = text === null ? null : JSON.parse(text);
          } catch {
            doc = null;
          }
          // A body that broke off is no answer the cost can be read from: only the generation it names prices it.
          const cost = text === null ? { usd: null, id: res.headers.get("x-generation-id") } : answerCost(res.status, doc, res.headers.get("x-generation-id"));
          count(await price(cost, signal));
          if (res.ok) return done(doc ? parseDecision(doc, question) : { verdict: null, confidence: null, error: "vendor" });
          error = errorOf(res.status);
          if (res.status !== 429 && res.status < 500) break;
        } catch (e) {
          // Sent, then timed out, reset or ended: the gateway may have run the model, so the try is of unknown cost.
          if (!NEVER_SENT.has(e?.cause?.code)) count(null);
          error = "unavailable";
        }
        if (signal?.aborted) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
      return done({ verdict: null, confidence: null, error: DECIDER_ERRORS.includes(error) ? error : "vendor" });
    },
  };
}
