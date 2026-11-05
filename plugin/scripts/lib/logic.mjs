// Pure logic shared by the Factory scripts: no I/O, no GitHub, no harness.
// Everything here is covered by test/ with `node --test`.

// ---------------------------------------------------------------- task card

/** Render a `{{key}}` template. Every placeholder must be supplied; none may be left. */
export function renderTaskCard(template, values) {
  const missing = new Set();
  const out = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      missing.add(key);
      return "";
    }
    return String(values[key]);
  });
  if (missing.size) throw new Error(`task card: missing values for ${[...missing].join(", ")}`);
  return out;
}

/** The values the task card needs, from the job's inputs. */
export function taskCardValues({ issue, maxUsd, timeoutMinutes, validation, budgetCommand, protectedPaths, ciChecks = [] }) {
  const hours = Math.round((Number(timeoutMinutes) / 60) * 10) / 10;
  const checks = (ciChecks || []).filter(Boolean);
  return {
    issue: String(issue),
    usd: String(maxUsd),
    hours: String(hours),
    validation: (validation || []).length ? validation.join("; ") : "none",
    validation_note: checks.length
      ? `Factory's validation pass is the repository's required check${checks.length > 1 ? "s" : ""} (${checks.join(", ")}) on the head you push, run by CI in parallel; before you push, run the tests your change touches, not the whole suite.`
      : "Run the validation commands before you push; Factory runs them again.",
    budget_command: budgetCommand && budgetCommand.trim() ? budgetCommand.trim() : "none",
    protected_paths: protectedPaths.join(", "),
    branch: `factory/${issue}`,
  };
}

/** The protected list: Factory's fixed entries plus the repository's additions, deduped. */
export const FACTORY_PROTECTED = [
  ".github/",
  "CODEOWNERS",
  ".agents/skills/",
  ".claude/",
  ".codex/",
];

export function protectedPaths(additions = []) {
  const all = [...FACTORY_PROTECTED, ...additions.map((p) => p.trim()).filter(Boolean)];
  return [...new Set(all)];
}

/** Changed files that fall under a protected path (a directory entry ends with `/`). */
export function protectedTouched(files, protectedList) {
  const hits = [];
  for (const file of files) {
    const path = file.replace(/^\.\//, "");
    for (const rule of protectedList) {
      const clean = rule.replace(/^\.\//, "");
      if (clean.endsWith("/") ? path.startsWith(clean) : path === clean || path.endsWith(`/${clean}`)) {
        hits.push(path);
        break;
      }
    }
  }
  return hits;
}

/** The PR label the App applies after validation is green; `pull_request(labeled)` on it fires the review job. */
export const REVIEW_LABEL = "factory:review";

// ----------------------------------------------------------------- dispatch

const PRIORITY = { P0: 0, P1: 1, P2: 2 };

/** 0 for P0, 1 for P1, 2 for P2, 3 for no priority label. */
export function priorityOf(issue) {
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  let best = 3;
  for (const n of names) if (n in PRIORITY && PRIORITY[n] < best) best = PRIORITY[n];
  return best;
}

/** Issue numbers named by `Blocked by #N` (or `blocked-by: #N, #M`) lines in a body. */
export function parseBlockedBy(body) {
  const out = new Set();
  for (const line of String(body || "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s*)?blocked[\s-]*by\s*:?\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const ref of m[1].matchAll(/#(\d+)/g)) out.add(Number(ref[1]));
  }
  return [...out];
}

/** The statuses that keep an issue out of the ready list, as the card shows them or the label says. */
export const NOT_READY_STATUSES = new Set(["Running", "Blocked", "Question", "In review", "Done"]);
export const STATE_LABELS = {
  "factory:running": "Running",
  "factory:blocked": "Blocked",
  "factory:question": "Question",
  "factory:in-review": "In review",
};

/** The issue's state from its Project card, else from its fallback label, else Queued. */
export function stateOf(issue, cardStatus) {
  if (cardStatus && cardStatus !== "Queued") return cardStatus;
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  for (const n of names) if (STATE_LABELS[n]) return STATE_LABELS[n];
  return cardStatus || "Queued";
}

/**
 * Choose the issues to start. Pure: the caller supplies what GitHub said.
 *  issues:      open issues with the objective label; each {number, labels, body, blockedBy?: [{number, state}]}
 *  statuses:    {number: cardStatus|null}
 *  openIssues:  Set of open issue numbers (to resolve body references)
 *  maxConcurrent, dailyUsd, spentToday
 * Returns {ready: [numbers], skipped: [{number, reason}], running, reason}
 */
export function selectReady({ issues, statuses = {}, openIssues = new Set(), maxConcurrent, dailyUsd, spentToday = 0 }) {
  const skipped = [];
  let running = 0;
  const candidates = [];
  for (const issue of issues) {
    const state = stateOf(issue, statuses[issue.number] ?? null);
    if (state === "Running") running += 1;
    if (NOT_READY_STATUSES.has(state)) {
      skipped.push({ number: issue.number, reason: state });
      continue;
    }
    const relations = issue.blockedBy ?? parseBlockedBy(issue.body).map((n) => ({ number: n, state: openIssues.has(n) ? "open" : "closed" }));
    const open = relations.filter((r) => r.state === "open").map((r) => r.number);
    if (open.length) {
      skipped.push({ number: issue.number, reason: `blocked by #${open.join(", #")}` });
      continue;
    }
    candidates.push(issue);
  }
  candidates.sort((a, b) => priorityOf(a) - priorityOf(b) || a.number - b.number);

  if (dailyUsd !== undefined && dailyUsd !== null && Number(dailyUsd) > 0 && spentToday >= Number(dailyUsd)) {
    for (const c of candidates) skipped.push({ number: c.number, reason: `daily_usd reached ($${spentToday.toFixed(2)} of $${Number(dailyUsd)})` });
    return { ready: [], skipped, running, reason: "daily_usd reached" };
  }
  const slots = Math.max(0, Number(maxConcurrent) - running);
  const ready = candidates.slice(0, slots).map((c) => c.number);
  for (const c of candidates.slice(slots)) skipped.push({ number: c.number, reason: "max_concurrent reached" });
  return { ready, skipped, running, reason: ready.length ? "" : slots === 0 ? "max_concurrent reached" : "nothing ready" };
}

/** Sum today's dollars from usage records; unmetered (null) counts as zero. */
export function sumSpend(records) {
  let total = 0;
  for (const r of records) if (r && typeof r.usd === "number" && Number.isFinite(r.usd)) total += r.usd;
  return total;
}

// --------------------------------------------------------------- exit logic

/**
 * The worker's exit, from what the run left behind.
 *  harness:    {ok: boolean, error?: string, budgetExceeded?: boolean, timedOut?: boolean, died?: number}
 *  pr:         {exists, draft, body} | null
 *  commits:    number of commits on the branch beyond the base
 *  validation: {passes: number, green: boolean, lastOutput?: string}
 *  protectedHits: string[]
 *  record:     the harness's exit record {exit, reason, questions} (parseExitRecord), or null
 *  question:   boolean, when the caller has already decided whether a question is open
 *              (the review job: the PR's draft state after the answer pass, so a human's
 *              "mark ready" answers it)
 *  reviewUnaddressed: number (review pass: comments without a worker reply)
 * Nothing here reads prose: the record is JSON the harness wrote (or answered with), the
 * rest are GitHub fields, exit codes and counts.
 * Returns {exit: 'delivered'|'question'|'blocked', reason}
 */
export function decideExit({ harness, pr, commits = 0, validation, protectedHits = [], record = null, question, reviewUnaddressed = 0 }) {
  if (harness?.died >= 2) return { exit: "blocked", reason: "worker process died twice" };
  if (harness?.timedOut) return { exit: "blocked", reason: "time cap reached" };
  if (harness?.budgetExceeded) return { exit: "blocked", reason: "dollar cap reached" };
  if (protectedHits.length) return { exit: "blocked", reason: `touched protected path ${protectedHits.join(", ")}` };
  if (!pr?.exists) {
    if (commits === 0) return { exit: "blocked", reason: harness?.error ? `worker ended without commits: ${harness.error}` : "worker ended without commits or a PR" };
    return { exit: "blocked", reason: "no PR could be opened for the branch" };
  }
  if (validation && !validation.green) {
    return { exit: "blocked", reason: `validation red after Factory's ${validation.passes >= 2 ? "second" : "first"} pass${validation.command ? ` (${validation.command})` : ""}` };
  }
  if (reviewUnaddressed > 0) return { exit: "blocked", reason: `${reviewUnaddressed} reviewer finding(s) unaddressed after the one pass` };
  if (record?.exit === "blocked") return { exit: "blocked", reason: `worker blocked: ${(record.reason || "no reason given").slice(0, 200)}` };
  const open = question !== undefined ? question : record?.exit === "question";
  if (open) return { exit: "question", reason: record?.questions?.length ? `question: ${record.questions[0].slice(0, 200)}` : "an assumption would change a public contract or a recorded decision" };
  if (harness && !harness.ok) return { exit: "blocked", reason: harness.error || "harness reported an error" };
  return { exit: "delivered", reason: "" };
}

export const EXITS = ["delivered", "question", "blocked"];

/**
 * What a running harness is doing, from its own event stream (Claude stream-json, Codex JSONL,
 * Copilot JSON): turns, tool calls, sub-agents started and finished, tokens, the last event's
 * time. Pure: feed(line) per stdout line, snapshot() at any time. The one line this renders is
 * the progress comment's status while the harness runs, so a reader needs no log.
 */
export function harnessActivity(now = () => Date.now()) {
  const s = { startedAt: now(), lastEventAt: null, events: 0, turns: 0, toolCalls: 0, lastTool: null, subagents: new Map(), tokens: { input: 0, output: 0 }, usd: null, ended: false, lastText: "" };
  const brief = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const feed = (line) => {
    const t = String(line || "").trim();
    if (!t.startsWith("{")) return;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      return;
    }
    s.events += 1;
    s.lastEventAt = now();
    // Claude
    if (e.type === "assistant" && e.message) {
      if (!e.parent_tool_use_id) s.turns += 1;
      for (const c of e.message.content || []) {
        if (c.type === "tool_use") {
          s.toolCalls += 1;
          s.lastTool = c.name === "Bash" && c.input?.command ? `Bash: ${brief(c.input.command)}` : c.input?.description ? `${c.name}: ${brief(c.input.description)}` : c.name;
        } else if (c.type === "text" && c.text) s.lastText = brief(c.text);
      }
      const u = e.message.usage;
      if (u) {
        s.tokens.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        s.tokens.output += u.output_tokens || 0;
      }
    } else if (e.type === "system" && e.subtype === "task_started" && e.task_id) {
      s.subagents.set(e.task_id, { description: brief(e.description), type: e.subagent_type || e.task_type || "agent", kind: e.task_type === "local_bash" ? "command" : "agent", startedAt: now(), done: false });
    } else if (e.type === "system" && e.subtype === "task_notification" && e.task_id) {
      const a = s.subagents.get(e.task_id);
      if (a) {
        a.done = true;
        a.status = e.status || "completed";
        a.endedAt = now();
      }
    } else if (e.type === "result") {
      s.ended = true;
      if (typeof e.total_cost_usd === "number") s.usd = e.total_cost_usd;
    }
    // Codex
    else if (e.type === "turn.started") s.turns += 1;
    else if (e.type === "turn.completed" && e.usage) {
      s.tokens.input += (e.usage.input_tokens || 0) + (e.usage.cached_input_tokens || 0);
      s.tokens.output += (e.usage.output_tokens || 0) + (e.usage.reasoning_output_tokens || 0);
    } else if (e.type === "item.started" && e.item) {
      s.toolCalls += 1;
      s.lastTool = e.item.type === "command_execution" && e.item.command ? `command: ${brief(e.item.command)}` : e.item.type || "item";
    } else if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) s.lastText = brief(e.item.text);
  };
  const snapshot = () => {
    const t = now();
    const all = [...s.subagents.values()];
    const active = all.filter((a) => !a.done && a.kind !== "command").map((a) => ({ ...a, minutes: Math.round((t - a.startedAt) / 60000) }));
    const done = all.filter((a) => a.done && a.kind !== "command").length;
    const commands = all.filter((a) => !a.done && a.kind === "command").length;
    return { elapsedMin: Math.round((t - s.startedAt) / 60000), idleMin: s.lastEventAt ? Math.round((t - s.lastEventAt) / 60000) : null, events: s.events, turns: s.turns, toolCalls: s.toolCalls, lastTool: s.lastTool, lastText: s.lastText, subagentsActive: active, subagentsDone: done, backgroundCommands: commands, tokens: { ...s.tokens }, usd: s.usd, ended: s.ended };
  };
  return { feed, snapshot };
}

/** The status line for a running or finished harness, from a snapshot. */
export function activityLine(snap, { harness = "harness", model = null, label = "working" } = {}) {
  const who = `${harness}${model ? ` (${model})` : ""}`;
  if (!snap.events) return `${who} started ${snap.elapsedMin} min ago; no event from it yet`;
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const agents = snap.subagentsActive.length ? `; sub-agents ${snap.subagentsActive.length} active (${snap.subagentsActive.map((a) => `${a.type}: ${a.description || "?"}, ${a.minutes} min`).join("; ")})${snap.subagentsDone ? `, ${snap.subagentsDone} done` : ""}` : snap.subagentsDone ? `; sub-agents ${snap.subagentsDone} done` : "";
  const bg = snap.backgroundCommands ? `; ${snap.backgroundCommands} background command${snap.backgroundCommands > 1 ? "s" : ""} running` : "";
  const last = snap.ended ? "ended" : snap.idleMin === null ? "" : snap.idleMin === 0 ? "active now" : `last event ${snap.idleMin} min ago`;
  const cost = snap.usd !== null ? `, $${snap.usd.toFixed(2)}` : "";
  return `${who} ${snap.ended ? "finished" : label}: ${snap.elapsedMin} min, ${snap.turns} turns, ${snap.toolCalls} tool calls${agents}${bg}; ${last}; ${k(snap.tokens.input)} tokens in, ${k(snap.tokens.output)} out${cost}${snap.lastTool ? `; last tool ${snap.lastTool}` : ""}`;
}

/**
 * Required checks on a head, from the check-runs GitHub lists for it:
 *   { done, green, missing: [name], failed: [{name, conclusion, id}], pending: [name] }
 * Only the latest run of each name counts (a re-run supersedes). A check with no run yet is
 * missing, not red: the caller decides how long to wait for it.
 */
export function evaluateChecks(names, checkRuns) {
  const latest = new Map();
  for (const r of checkRuns || []) {
    const have = latest.get(r.name);
    if (!have || String(r.started_at || "") > String(have.started_at || "") || (r.id ?? 0) > (have.id ?? 0)) latest.set(r.name, r);
  }
  const out = { done: true, green: true, missing: [], failed: [], pending: [] };
  for (const name of names) {
    const r = latest.get(name);
    if (!r) {
      out.missing.push(name);
      out.done = false;
      continue;
    }
    if (r.status !== "completed") {
      out.pending.push(name);
      out.done = false;
      continue;
    }
    if (!["success", "neutral", "skipped"].includes(r.conclusion)) out.failed.push({ name, conclusion: r.conclusion, id: r.id });
  }
  if (out.failed.length) out.green = false;
  if (!out.done) out.green = false;
  return out;
}

/**
 * The harness's exit record: the first JSON object in `text` (a file the task card names, or
 * the harness's answer to EXIT_PROMPT) with `exit` in EXITS. `questions` and `reason` are
 * normalized to strings. Null when there is no such object: the caller then asks the harness.
 */
export function parseExitRecord(text) {
  const s = String(text || "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          let v;
          try {
            v = JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
          if (v && typeof v === "object" && EXITS.includes(v.exit)) {
            const questions = (Array.isArray(v.questions) ? v.questions : []).map((q) => (typeof q === "string" ? q : q?.question ?? JSON.stringify(q))).filter(Boolean);
            return { exit: v.exit, reason: typeof v.reason === "string" ? v.reason : "", questions };
          }
          break;
        }
      }
    }
  }
  return null;
}

/** What Factory asks a harness that left no exit record (resumed in its own session where it can). */
export const EXIT_PROMPT = 'Reply with only one JSON object and nothing else: {"exit": "delivered" | "question" | "blocked", "questions": ["each open question a human must answer, verbatim"], "reason": "why you are blocked, else empty"}. "question" means an assumption in your plan still needs a human decision; "blocked" means you stopped short of the acceptance; otherwise "delivered".';

/** Factory's own line comment when a review pass has nothing line-tied to say; the worker never answers it. */
export const PLACEHOLDER_MARKER = "<!-- factory:placeholder -->";
export const isPlaceholder = (body) => String(body || "").includes(PLACEHOLDER_MARKER);

// -------------------------------------------------------------- review diff

/** The right-side line numbers a unified diff touches, per file: {path: Set(lines)} and first changed line. */
export function diffLines(diff) {
  const files = {};
  let path = null;
  let line = 0;
  let inHeader = false; // between `diff --git` and the first hunk: `---`/`+++` are file names, not content
  for (const raw of String(diff || "").split("\n")) {
    if (raw.startsWith("diff ")) {
      inHeader = true;
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "").trim();
      path = p === "/dev/null" ? null : p;
      if (path) files[path] ??= { lines: new Set(), first: null };
      continue;
    }
    if (inHeader && (raw.startsWith("--- ") || raw.startsWith("index ") || /^(new|deleted) file mode|^similarity|^rename|^old mode|^new mode|^Binary/.test(raw))) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (raw.startsWith("+")) {
      files[path].lines.add(line);
      if (files[path].first === null) files[path].first = line;
      line += 1;
    } else if (raw.startsWith("-")) {
      // removed line: no right-side number
    } else if (raw.startsWith(" ")) {
      files[path].lines.add(line);
      line += 1;
    }
    // anything else ("\ No newline", "new file mode", "similarity index", "") is metadata
  }
  return files;
}

/**
 * Fit reviewer findings to the diff: a comment on a line the diff does not show
 * moves to the file's first changed line; a comment on a file outside the diff
 * moves to the first changed file. Returns the comments GitHub will accept.
 */
export function snapComments(findings, diff) {
  const files = diffLines(diff);
  const paths = Object.keys(files).filter((p) => files[p].first !== null);
  if (!paths.length) return [];
  const out = [];
  for (const f of findings || []) {
    if (!f || typeof f.body !== "string" || !f.body.trim()) continue;
    let path = typeof f.path === "string" ? f.path.replace(/^\.\//, "") : paths[0];
    let note = "";
    if (!files[path] || files[path].first === null) {
      note = path !== paths[0] ? ` (on ${path})` : "";
      path = paths[0];
    }
    let line = Number(f.line);
    if (!Number.isInteger(line) || !files[path].lines.has(line)) line = files[path].first;
    out.push({ path, line, side: "RIGHT", body: f.body.trim() + note });
  }
  return out;
}

/** Find the reviewer's JSON findings in free text: a fenced ```json block or a bare {"comments": [...]}. */
export function parseFindings(text) {
  const s = String(text || "");
  const candidates = [];
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const bare = s.lastIndexOf('{"comments"');
  if (bare >= 0) candidates.push(s.slice(bare));
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c.trim());
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.comments)) return v.comments;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

// ------------------------------------------------------- no-queue fallback

/**
 * The dispatcher's decision for an In-review PR (its review pass is done) that cannot merge:
 *  - with a merge queue, a conflicting PR ("dirty") is evicted by the queue and auto-merge is
 *    dropped; a PR merely behind is the queue's own job and is left alone;
 *  - without a queue, strict required checks refuse a PR that is behind or conflicting and
 *    nothing updates it.
 * Either way: "rebase" sends it back to a worker job once; "blocked" is the second time
 * (integration failed twice); "ignore" covers drafts, clean and unknown states.
 */
export function staleDecision({ pr, rebaseMarkers = 0, queue = false }) {
  if (!pr || pr.draft) return "ignore";
  const stale = queue ? pr.mergeable_state === "dirty" : ["behind", "dirty"].includes(pr.mergeable_state);
  if (!stale) return "ignore";
  return rebaseMarkers >= 1 ? "blocked" : "rebase";
}

// ---------------------------------------------------------------- markers

export const marker = (issue, kind, id = "") => `<!-- factory:${issue}:${kind}${id ? `:${id}` : ""} -->`;

