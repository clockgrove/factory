// Vercel AI Gateway's decisions endpoint behind the decider contract (decider.mjs). Plain fetch, no SDK. The key is held
// in this closure only; an error names a code, never the request or the key. Each call is priced as the gateway relay
// prices one (gateway-relay.mjs): the cost the answer reports, else the generation it names looked up
// (`/v1/generation`, its `total_cost`); a call the gateway refused before any model ran is $0; any other call with no
// figure is of unknown cost (usage.mjs UNKNOWN_WHY, DECISION_UNKNOWN below), never $0 or an estimate. The verdict comes back at once;
// the price settles beside it (`spend.settled`), for the caller to book (lib/decider.mjs).
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
 * What a 2xx answer of the endpoint says it cost, `{usd, id}` (either null): the endpoint answers in the OpenAI
 * Decisions API's shape, so its gateway metadata is at `provider_metadata.gateway` (`cost`, a string such as
 * "0.0000096", and `generationId`), as Vercel's reference for `/v1/decisions` shows it; `providerMetadata.gateway`, the
 * AI SDK protocol's place (gateway-relay.mjs costOf `sdk`), is read when that is absent. The id falls back to the
 * `x-generation-id` header.
 */
export function decisionCostOf(doc, headerId = null) {
  const top = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  const d = top(doc);
  const gw = top(top(d?.provider_metadata)?.gateway) ?? top(top(d?.providerMetadata)?.gateway);
  return costOf({ providerMetadata: { gateway: gw } }, "sdk", null, headerId);
}

/** Whether an answer's `usage` counts tokens: `input_tokens` or `output_tokens` (the endpoint's), or the AI SDK's camelCase. */
const usedTokens = (doc) => {
  const u = doc && typeof doc === "object" && !Array.isArray(doc) && doc.usage && typeof doc.usage === "object" ? doc.usage : null;
  return [u?.input_tokens, u?.output_tokens, u?.inputTokens, u?.outputTokens].some((n) => typeof n === "number" && n > 0);
};

/**
 * What one answer of the endpoint cost, before any lookup, by the relay's rules: `{usd, id, reported}`.
 * - $0 for a call the gateway refused before any model ran: a redirect (never followed); a 400 or 422 whose
 *   `error.type` is one of PRE_MODEL_ERRORS (with any other type, or none, the model may have run: unknown); a 401, 403,
 *   404, 413 or 429; its budget or credits 402 (gatewayRefusalOf); another 4xx with a PRE_MODEL_ERRORS type; a 5xx whose
 *   type is one of UNAVAILABLE_ERRORS that names no generation. A refusal that names a generation is looked up all the
 *   same, as the relay does, and a cost its record gives counts.
 * - A 2xx answer's own reported cost (decisionCostOf): `reported`, and no lookup; a reported $0 for an answer whose
 *   `usage` counts tokens is null (unknown), with no lookup either: under BYOK the gateway may report 0.
 * - Else null (unknown), unless the generation it names (`id`: the gateway's metadata, its top-level `generationId` or
 *   `id`, or the `x-generation-id` header) is looked up and found.
 */
export function answerCost(status, doc, headerId = null) {
  const ok = status >= 200 && status < 300;
  const said = ok ? decisionCostOf(doc, headerId) : { usd: null, id: null };
  const id = said.id || errorGenerationId(doc, headerId);
  if (status >= 300 && status < 400) return { usd: 0, id: null, reported: false };
  const type = errorTypeOf(doc);
  if (status === 400 || status === 422) return type && PRE_MODEL_ERRORS.has(type) ? { usd: 0, id, reported: false } : { usd: null, id, reported: false };
  if (UNBILLED.has(status)) return { usd: 0, id, reported: false };
  if (status === 402 && gatewayRefusalOf(doc)) return { usd: 0, id: null, reported: false };
  // A reported $0 for an answer that used tokens is no figure (#565): under BYOK the provider bills the user's own key
  // and the gateway may report 0, so the call is of unknown cost (`decision-no-cost`), never looked up to a $0 record.
  if (ok && said.usd === 0 && usedTokens(doc)) return { usd: null, id: null, reported: false };
  if (ok) return { usd: said.usd, id, reported: said.usd !== null };
  if (type && status >= 400 && status < 500 && PRE_MODEL_ERRORS.has(type)) return { usd: 0, id, reported: false };
  const top = type ?? errorTypeOf(doc, { topLevel: true });
  if (top && status >= 500 && UNAVAILABLE_ERRORS.has(top) && !id) return { usd: 0, id: null, reported: false };
  return { usd: null, id, reported: false };
}

/** Fetch failures whose request never left this machine (its socket never connected): no generation ran, $0. */
export const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** How many "no record" answers (404) end a lookup: the gateway writes a record seconds after the answer, or not at all. */
export const LOOKUP_NONE_TRIES = 2;

/**
 * A generation's cost from its record, tried at `delaysMs` (the relay's) within `maxMs`: `{usd}`, or `{none: true}` when
 * the gateway said LOOKUP_NONE_TRIES times it has no record (it stops then), or `{failed: true}` when the tries or the
 * bound ran out on failed lookups (a 5xx, a 429, a network error, a record with no cost yet).
 */
async function lookedUp(id, { key, origin, fetchImpl, delaysMs, maxMs }) {
  const started = Date.now();
  let wait = 0;
  let none = 0;
  for (const ms of delaysMs) {
    const delay = Math.max(ms, wait);
    if (Date.now() + delay >= started + maxMs) break;
    await sleep(delay);
    const left = started + maxMs - Date.now();
    if (left <= 0) break;
    const r = await generationCost(id, { key, origin, fetchImpl, signal: AbortSignal.timeout(Math.min(60_000, left)) });
    if (r.usd !== undefined) return { usd: r.usd };
    if (r.none && (none += 1) >= LOOKUP_NONE_TRIES) return { none: true };
    wait = r.retryAfterMs || 0;
  }
  return { failed: true };
}

/**
 * Why a gateway decision try is of unknown cost (usage.mjs UNKNOWN_WHY), decided by what came back, never by text:
 * - `decision-no-cost`: the gateway answered (2xx) and gave no cost for it: its answer reported none, and it named no
 *   generation or its generation has no record;
 * - `decision-lookup`: the generation it named was looked up and every lookup failed, or the lookup's bound passed;
 * - `decision`: the call failed after it was sent, with no figure and no record to price it.
 */
export const DECISION_UNKNOWN = Object.freeze({ noCost: "decision-no-cost", lookup: "decision-lookup", failed: "decision" });

// A decision call can cost under a millionth of a dollar ($0.0000096): its dollars are kept to 1e-10, not rounded to
// the micro-dollar per call, so a sum of many is not inflated (#565).
export const roundCallUsd = (n) => Math.round(n * 1e10) / 1e10;

/**
 * One retry on a 429, a 5xx or a network error. The verdict comes back as soon as the gateway answers; the answer
 * carries `spend`: `calls` (the tries that reached the gateway: one that never left this machine, or that `signal` ended
 * before it was sent, costs nothing and is no call), `model`, `started`, `ended`, and `settled`, a promise (never
 * rejected) of what they cost in usage.mjs's unknown-spend shape: `usd` the known dollars (null when none was priced),
 * `usdUnknown` the tries of unknown cost with `usdUnknownWhy` their reasons (DECISION_UNKNOWN). A lookup runs aside, up to
 * `lookupMaxMs`.
 */
export function gatewayDecider({ key, model, endpoint = GATEWAY_DECISIONS, origin = GATEWAY_ORIGIN, timeoutMs = 30_000, lookupDelaysMs = LOOKUP_DELAYS_MS, lookupMaxMs = LOOKUP_MAX_MS, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  // One try's dollars, or `{why}` (unknown, DECISION_UNKNOWN): the reported cost as is; else the larger of its base and
  // its record's cost. `answered`: the gateway answered 2xx.
  const price = async (cost, answered) => {
    const unknown = (lookup = null) => (typeof cost.usd === "number" ? cost.usd : { why: lookup?.failed ? DECISION_UNKNOWN.lookup : answered ? DECISION_UNKNOWN.noCost : DECISION_UNKNOWN.failed });
    if (cost.reported || !cost.id || !GEN_ID.test(cost.id)) return unknown();
    const looked = await lookedUp(cost.id, { key, origin, fetchImpl, delaysMs: lookupDelaysMs, maxMs: lookupMaxMs }).catch(() => ({ failed: true }));
    return typeof looked.usd === "number" ? Math.max(looked.usd, cost.usd ?? 0) : unknown(looked);
  };
  return {
    name: "ai-gateway",
    model,
    async decide(input, question, { signal = null } = {}) {
      const body = JSON.stringify({ model, input, questions: [question] });
      const started = new Date().toISOString();
      const tries = [];
      const done = (answer) => {
        const settled = Promise.all(tries).then((each) => {
          const known = each.filter((u) => typeof u === "number");
          const why = [...new Set(each.filter((u) => typeof u !== "number").map((u) => u?.why ?? DECISION_UNKNOWN.failed))];
          return { usd: known.length ? roundCallUsd(known.reduce((s, u) => s + u, 0)) : null, ...(why.length ? { usdUnknown: each.length - known.length, usdUnknownWhy: why } : {}) };
        });
        return { ...answer, spend: { model, calls: tries.length, started, ended: new Date().toISOString(), settled } };
      };
      let error = "vendor";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) break;
        try {
          const res = await fetchImpl(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
          const text = await res.text().catch(() => null);
          let doc = null;
          try {
            doc = text === null ? null : JSON.parse(text);
          } catch {
            doc = null;
          }
          // A body that broke off is no answer the cost can be read from: only the generation it names prices it.
          const cost = text === null ? { usd: null, id: res.headers.get("x-generation-id"), reported: false } : answerCost(res.status, doc, res.headers.get("x-generation-id"));
          tries.push(price(cost, res.ok && text !== null));
          if (res.ok) return done(doc ? parseDecision(doc, question) : { verdict: null, confidence: null, error: "vendor" });
          error = errorOf(res.status);
          if (res.status !== 429 && res.status < 500) break;
        } catch (e) {
          // Sent, then timed out, reset or ended: the gateway may have run the model, so the try is of unknown cost.
          if (!NEVER_SENT.has(e?.cause?.code)) tries.push(Promise.resolve({ why: DECISION_UNKNOWN.failed }));
          error = "unavailable";
        }
        if (signal?.aborted) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
      return done({ verdict: null, confidence: null, error: DECIDER_ERRORS.includes(error) ? error : "vendor" });
    },
  };
}
