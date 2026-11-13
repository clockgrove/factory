// A running harness pass's own spend, read live from its stream (#97, Kirk's decision on the review's budget doubling):
// the gateway relay's cap draws on one budget shared with it, so model spend plus key spend in a pass cannot pass what
// max_usd left by more than about two calls (gateway-relay.mjs: the call in flight, and one estimate below its record).
// - Claude Code: each assistant message's usage (stream-json; a message's later lines carry its latest totals), priced
//   from claude-prices.json (an unlisted model at the table's dearest row, never low).
// - Codex: its stream reports usage once per turn (`turn.completed`), and a pass is often one turn, so the thread's own
//   rollout is read too (`rollout(threadId)`: its `token_usage_record` lines, one per model response, written before the
//   response's tool call runs; else its last `token_count` line's running total); the larger counts, priced from the Codex table (usage.mjs priceCodex), a resumed thread's earlier total
//   taken off once. Its sub-agent threads' spend counts once the pass ends. An unset or unlisted model is priced at the
//   table's dearest rates, never $0; a rollout that cannot be read throws, and the relay then refuses the call.
// - Copilot: its usage checkpoints' running AI credits (`session.usage_checkpoint` totalNanoAiu) at the run's dollars per
//   credit; a resumed session's earlier dollars are taken off.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_PRICES, COPILOT_CREDIT_USD, bareModel, priceCodex, priceTokens } from "./usage.mjs";

export const CLAUDE_PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "claude-prices.json"), "utf8"));

const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Codex tokens at the table's dearest rate of each kind: what an unset or unlisted model's tokens cost at most. */
const CODEX_UPPER = (() => {
  const rows = Object.values(CODEX_PRICES.perMillion);
  const most = (k) => Math.max(...rows.map((r) => r[k] ?? r.input));
  return { perMillion: { upper: { input: most("input"), cached: most("cached"), write: most("write"), output: most("output") } } };
})();
/** USD for Codex `tokens` at `model`'s rates, else at the table's dearest. */
export const codexUsd = (model, tokens) => priceCodex(model, tokens) ?? priceTokens(CODEX_UPPER, "upper", tokens) ?? 0;

/** A Claude model's rates: its row by exact id or a dated snapshot of one, else the table's upper bound. */
export function claudeRate(model, table = CLAUDE_PRICES) {
  const id = bareModel(model);
  const base = id.match(/^(.+)-\d{8}$/)?.[1];
  return table.perMillion[id] || (base && table.perMillion[base]) || table.upperBound;
}

/** USD for one Claude message's usage at `model`'s rates. */
export function claudeUsageUsd(usage, model, table = CLAUDE_PRICES) {
  const r = claudeRate(model, table);
  const c = usage?.cache_creation || {};
  const w1h = n(c.ephemeral_1h_input_tokens);
  const w5m = n(c.ephemeral_5m_input_tokens) || Math.max(0, n(usage?.cache_creation_input_tokens) - w1h);
  return (n(usage?.input_tokens) * r.input + n(usage?.output_tokens) * r.output + n(usage?.cache_read_input_tokens) * r.cacheRead + w5m * r.write5m + w1h * r.write1h) / 1e6;
}

/**
 * A Codex rollout's running total for thread `id`: its `token_usage_record` lines' usage summed (one per model response,
 * written as each response arrives), or, failing those, its last `token_count` line's `total_token_usage`; null when it
 * has neither.
 */
export function rolloutTotal(text, id = null) {
  const all = String(text || "").split("\n");
  const sum = { input: 0, output: 0, cached: 0, written: 0 };
  let records = 0;
  for (const l of all) {
    if (!l.includes('"token_usage_record"')) continue;
    try {
      const o = JSON.parse(l);
      if (o?.type !== "token_usage_record" || (id && o.payload?.thread_id !== id)) continue;
      const u = o.payload?.usage || {};
      sum.input += n(u.input_tokens);
      sum.output += n(u.output_tokens);
      sum.cached += n(u.cached_input_tokens);
      sum.written += n(u.cache_write_input_tokens);
      records += 1;
    } catch {
      // not a record
    }
  }
  if (records) return sum;
  const lines = all.filter((l) => l.includes('"token_count"'));
  for (const l of lines.reverse()) {
    try {
      const u = JSON.parse(l)?.payload?.info?.total_token_usage;
      if (u) return { input: n(u.input_tokens), output: n(u.output_tokens), cached: n(u.cached_input_tokens), written: n(u.cache_write_input_tokens) };
    } catch {
      // the line before it
    }
  }
  return null;
}

/**
 * A live meter for one pass: `line(text)` takes each line of the harness's stream, `usd()` is its spend so far, and
 * `estimated()` whether any of it was priced at the table's dearest rates (a model with no row: an over-estimate of the
 * tokens read, not a lower bound). `prior`: a resumed session's running total as Factory last read it (harness.mjs
 * SESSION_TOTALS), taken off once.
 */
export function liveSpend(harness, model = null, { prior = null, creditUsd = COPILOT_CREDIT_USD, rollout = null } = {}) {
  const claude = new Map();
  const codex = { input: 0, output: 0, cached: 0, written: 0, model };
  let codexLast = null;
  let copilotNano = 0;
  let thread = null;
  const line = (text) => {
    const t = String(text || "");
    if (!t.startsWith("{")) return;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      return;
    }
    if (harness === "claude" && e.type === "assistant" && e.message?.usage) claude.set(e.message.id || `m${claude.size}`, { usage: e.message.usage, model: e.message.model || model });
    else if (harness === "codex" && e.type === "thread.started" && typeof e.thread_id === "string") thread ??= e.thread_id;
    else if (harness === "codex" && e.type === "turn.completed" && e.usage) {
      codex.input += n(e.usage.input_tokens);
      codex.output += n(e.usage.output_tokens);
      codex.cached += n(e.usage.cached_input_tokens);
      codex.written += n(e.usage.cache_write_input_tokens);
      // The thread's running total as its last turn reported it: what a resumed session starts from, never summed.
      codexLast = { input: n(e.usage.input_tokens), output: n(e.usage.output_tokens), cached: n(e.usage.cached_input_tokens), written: n(e.usage.cache_write_input_tokens) };
    } else if (harness === "copilot" && e.type === "session.usage_checkpoint") copilotNano = Math.max(copilotNano, n(e.data?.totalNanoAiu));
  };
  // Codex: the thread's running total as read now (its stream's, or its rollout's when larger) and its share since `prior`.
  const codexRead = async () => {
    const p = prior?.tokens || {};
    const since = (t) => ({ input: Math.max(0, n(t.input) - n(p.input)), output: Math.max(0, n(t.output) - n(p.output)), cached: Math.max(0, n(t.cached) - n(p.cached)), written: Math.max(0, n(t.written) - n(p.written)) });
    let best = { total: codexLast ?? {}, usd: codexUsd(codex.model, since(codex)) };
    if (rollout && thread) {
      // A read that fails throws: the relay refuses the call rather than read the spend as $0.
      const total = rolloutTotal(await rollout(thread), thread);
      if (total) {
        const fromRollout = codexUsd(codex.model, since(total));
        best = fromRollout > best.usd ? { total, usd: fromRollout } : { total: best.total, usd: best.usd };
      }
    }
    return best;
  };
  // Async: Codex's rollout is read when asked (once per relayed call).
  const usd = async () => {
    if (harness === "claude") return [...claude.values()].reduce((s, m) => s + claudeUsageUsd(m.usage, m.model), 0);
    if (harness === "codex") return (await codexRead()).usd;
    if (harness === "copilot") return Math.max(0, (copilotNano / 1e9) * creditUsd - n(prior?.usd));
    return 0;
  };
  /**
   * The resumed session's running total as this meter counts it now (`prior` plus the reading, in sinceSession's shape),
   * for the next stage to start from (harness.mjs stageSpendSoFar); null for a fresh session, which no later stage resumes.
   */
  const session = async () => {
    if (typeof prior?.usd !== "number") return null;
    if (harness === "codex") {
      const r = await codexRead();
      const pt = prior.tokens || {};
      const most = (k) => Math.max(n(pt[k]), n(r.total[k]));
      const tokens = { input: most("input"), output: most("output"), cached: most("cached"), written: most("written") };
      // Priced from the same running total, so the next stage's priced total never reads below it (usage.mjs sinceSession).
      const share = codexUsd(codex.model, { input: tokens.input - n(pt.input), output: tokens.output - n(pt.output), cached: tokens.cached - n(pt.cached), written: tokens.written - n(pt.written) });
      return { ...prior, usd: prior.usd + Math.min(r.usd, share), tokens };
    }
    const read = await usd();
    if (harness === "copilot") return { ...prior, usd: prior.usd + read, aiu: Math.max(n(prior.aiu), copilotNano / 1e9) };
    return { ...prior, usd: prior.usd + read };
  };
  const estimated = () => {
    if (harness === "claude") return [...claude.values()].some((m) => claudeRate(m.model) === CLAUDE_PRICES.upperBound);
    if (harness === "codex") return priceCodex(codex.model, { input: 1, output: 1, cached: 0, written: 0 }) === null;
    return false;
  };
  return { line, usd, estimated, session };
}
