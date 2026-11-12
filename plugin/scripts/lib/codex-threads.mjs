// Codex sub-agent threads (#88). A Codex run whose model calls `spawn_agent` (the implementer sub-agent) starts each
// child as a thread of its own: its usage is in neither the parent's `turn.completed` nor the parent's rollout, and its
// rollout is a file of its own beside the parent's under CODEX_HOME/sessions (`YYYY/MM/DD/rollout-<time>-<thread>.jsonl`,
// codex-cli 0.160 to 0.167). So after every Codex run Factory reads the threads the run's rollout names, priced at each
// thread's own model and added to the run's record: the stage's dollars, max_usd between passes, daily_usd, and the
// saved transcript all cover them. Children of children count too.
//
// The structure read, from real rollouts:
// - the parent names each child in an `item_completed` event whose item (`SubAgentActivity`) carries `agent_thread_id`
//   (`kind` started, interacted, completed); a child names its own parent the same way, so a name alone proves nothing;
// - the child's first line is its `session_meta`, whose `source.subagent.thread_spawn.parent_thread_id` is the thread
//   that spawned it: only a thread naming this run's thread (or one of its counted children) as its parent counts;
// - a forked child copies its parent's history first (`subagent_history_start_ordinal`): lines before that ordinal are
//   the parent's and are skipped;
// - `token_count` events carry the thread's running total (`total_token_usage`) and the last request's
//   (`last_token_usage`); the thread's own usage is the last total less what the total held before its first request.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonLines, priceCodex } from "./usage.mjs";

/** A Codex thread id (a UUID, as Codex makes them): safe as a file name, a `find -name` pattern and an object key. */
export const plainThread = (id) => typeof id === "string" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(id);

/** The largest rollout read (the largest real one seen: 13 MB for a 21M-token thread); a larger one is not counted. */
export const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
/** The most rollouts read for one run (its own, then each thread named): more leaves the run's dollars a lower bound. */
export const MAX_THREAD_READS = 256;

/** Codex's sessions directory for a process started with `env` (local mode, a developer's own run). */
export const codexSessionRoot = (env = process.env) => join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

/** A thread's rollout files under `root`, relative to it: `YYYY/MM/DD/rollout-<time>-<id>.jsonl`. */
export function codexRolloutFiles(root, id) {
  if (!root || !/^[A-Za-z0-9._-]+$/.test(String(id || "")) || !existsSync(root)) return [];
  const out = [];
  const walk = (rel, depth) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory() && depth < 3) walk(r, depth + 1);
      else if (e.isFile() && e.name.endsWith(`-${id}.jsonl`)) out.push(r);
    }
  };
  walk("", 0);
  return out;
}

/** A token count: a finite non-negative number, at most Number.MAX_SAFE_INTEGER (so no price overflows); else 0. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0);
const usageOf = (u) => ({ input: num(u?.input_tokens), cached: num(u?.cached_input_tokens), written: num(u?.cache_write_input_tokens), output: num(u?.output_tokens) });
const KEYS = ["input", "cached", "written", "output"];
/** Markers of the only lines read; the rest of a rollout (prompts, tool output) is never parsed. */
const WANTED = ['"token_count"', '"agent_thread_id"', '"thread_settings_applied"', '"turn_context"'];
const NAMES_ONLY = ['"agent_thread_id"'];

/**
 * One rollout's own thread: `{id, parent, model, tokens, names}`, or null when its first line is no `session_meta`.
 * `parent` is the thread that spawned it (null for a thread Factory started); `tokens` its own usage in Factory's shape
 * (input includes the cached and written parts, output the reasoning part, as `turn.completed` reports them), null when
 * it recorded none; `names` the other threads it names. `namesOnly` reads only the names (a run's own rollout, whose
 * usage its stream already reported).
 */
export function codexRollout(text, { namesOnly = false } = {}) {
  const lines = String(text || "").split("\n");
  const first = jsonLines(lines.find((l) => l.trim()) || "")[0];
  const meta = first?.type === "session_meta" ? first.payload : null;
  if (!meta || !plainThread(meta.id)) return null;
  const start = typeof meta.subagent_history_start_ordinal === "number" ? meta.subagent_history_start_ordinal : null;
  const wanted = namesOnly ? NAMES_ONLY : WANTED;
  const counts = [];
  const names = [];
  let model = null;
  let turnModel = null;
  for (const line of lines.slice(1)) {
    if (!wanted.some((w) => line.includes(w))) continue;
    const o = jsonLines(line)[0];
    if (!o) continue;
    // A forked child's copy of its parent's history.
    if (start !== null && typeof o.ordinal === "number" && o.ordinal < start) continue;
    const p = o.payload || {};
    if (p.type === "token_count" && p.info?.total_token_usage) counts.push({ total: usageOf(p.info.total_token_usage), last: p.info.last_token_usage ? usageOf(p.info.last_token_usage) : null });
    else if (p.type === "thread_settings_applied" && p.thread_id === meta.id && typeof p.thread_settings?.model === "string") model = p.thread_settings.model;
    else if (o.type === "turn_context" && typeof p.model === "string") turnModel = p.model;
    const named = p.item?.agent_thread_id;
    if (plainThread(named) && named !== meta.id && !names.includes(named)) names.push(named);
  }
  let tokens = null;
  if (counts.length) {
    // What the total held before the thread's first own request (zero for a fresh thread).
    const base = Object.fromEntries(KEYS.map((k) => [k, Math.max(0, counts[0].total[k] - (counts[0].last?.[k] ?? counts[0].total[k]))]));
    const end = counts.at(-1).total;
    tokens = Object.fromEntries(KEYS.map((k) => [k, Math.max(0, end[k] - base[k])]));
  }
  const parent = meta.source?.subagent?.thread_spawn?.parent_thread_id;
  return { id: meta.id, parent: plainThread(parent) ? parent : null, model: model || turnModel || null, tokens, names };
}

/**
 * Every thread spawned under `rootId`, children of children included: `{threads, missed}`. Each thread is
 * `{id, parent, model, tokens, names}`; `missed` lists `{id, why}` for each rollout not read (absent, too large,
 * unreadable; `id` null for the read limit), empty when every named thread was read. `read(id)` gives `{text}`, `{skip: why}`, or
 * null when the thread has no rollout. A named thread counts only when its own rollout names the thread that named it
 * as its parent. At most `maxReads` rollouts are read.
 */
export async function codexThreads(read, rootId, { maxReads = MAX_THREAD_READS } = {}) {
  const missed = [];
  if (!plainThread(rootId)) return { threads: [], missed };
  const parsed = new Map();
  const get = async (id, opts) => {
    if (parsed.has(id)) return parsed.get(id);
    if (parsed.size >= maxReads) {
      if (!missed.some((m) => m.id === null)) missed.push({ id: null, why: `over ${maxReads} rollouts` });
      return null;
    }
    const got = await read(id);
    const r = got?.text !== undefined ? codexRollout(got.text, opts) : null;
    if (!got) missed.push({ id, why: "no rollout" });
    else if (got.skip) missed.push({ id, why: got.skip });
    else if (!r) missed.push({ id, why: "no thread in its rollout" });
    parsed.set(id, r);
    return r;
  };
  const threads = [];
  const counted = new Set([rootId]);
  const queue = [rootId];
  if (!(await get(rootId, { namesOnly: true }))) return { threads, missed };
  while (queue.length) {
    const id = queue.shift();
    const r = await get(id);
    if (!r || r.id !== id) continue;
    for (const n of r.names) {
      if (counted.has(n)) continue;
      const c = await get(n);
      if (!c || c.id !== n || c.parent !== id) continue;
      counted.add(n);
      threads.push(c);
      queue.push(n);
    }
  }
  return { threads, missed };
}

/** A local reader for codexThreads: the one regular rollout file of a thread under `root`; a larger one is skipped. */
export const localRollouts = (root) => (id) => {
  const files = codexRolloutFiles(root, id);
  if (!files.length) return null;
  if (files.length > 1) return { skip: "more than one rollout" };
  const st = lstatSync(join(root, files[0]), { throwIfNoEntry: false });
  if (!st?.isFile()) return { skip: "not a regular file" };
  if (st.size > MAX_ROLLOUT_BYTES) return { skip: `over ${MAX_ROLLOUT_BYTES} bytes` };
  return { text: readFileSync(join(root, files[0]), "utf8") };
};

const add = (a, b) => (a === null || a === undefined ? b : a + b);
const less = (a, b) => Math.max(0, (a ?? 0) - (b ?? 0));

/**
 * A Codex run's record with its sub-agent threads counted: each thread's own share (its total less `prior(id)`, the
 * total Factory already counted for it in an earlier pass or stage, so a resume never counts a child twice), priced at
 * the thread's own model (the run's when the rollout names none), added to the record's tokens and dollars and listed
 * in `subAgents`. Returns `{rec, totals}`: `totals` maps each thread to its running total, for the next pass's `prior`.
 * A thread whose model has no price leaves the dollars a lower bound (`usdLowerBound`); a run whose own dollars are
 * unknown (no turn completed) gets its threads' dollars as a lower bound, so the caps still count what is known.
 */
export function withSubAgents(rec, threads, prior = () => null) {
  const totals = Object.create(null);
  if (!threads?.length) return { rec, totals };
  const shares = [];
  const tokens = { ...rec.tokens };
  let usd = rec.usd;
  let lowerBound = !!rec.usdLowerBound;
  for (const t of threads) {
    if (!t.tokens) continue;
    const model = t.model || rec.model || null;
    const p = prior(t.id)?.tokens;
    // A total below the one already counted is not this thread's running total: counted as reported.
    const running = p && KEYS.every((k) => (t.tokens[k] ?? 0) >= (p[k] ?? 0));
    const own = running ? Object.fromEntries(KEYS.map((k) => [k, less(t.tokens[k], p[k])])) : { ...t.tokens };
    const price = priceCodex(model, own);
    totals[t.id] = { usd: priceCodex(model, t.tokens), tokens: t.tokens, model };
    shares.push({ id: t.id, parent: t.parent, model, usd: price, tokens: own });
    for (const k of KEYS) tokens[k] = add(tokens[k], own[k]);
    if (price === null) {
      if (KEYS.some((k) => own[k] > 0)) lowerBound = true;
    } else if (usd === null || usd === undefined) {
      // Unmetered stays unmetered unless a thread spent something: never a $0 for a run whose spend is unknown.
      if (price > 0) {
        usd = price;
        lowerBound = true;
      }
    } else usd += price;
  }
  if (!shares.length) return { rec, totals };
  const out = { ...rec, tokens, usd: typeof usd === "number" ? Math.round(usd * 10000) / 10000 : usd, subAgents: shares };
  if (lowerBound) out.usdLowerBound = true;
  return { rec: out, totals };
}
