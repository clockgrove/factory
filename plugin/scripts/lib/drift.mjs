// The drift advisory: while a worker's harness runs, a decision model is asked at each activity checkpoint whether the
// agent is on task, drifting into scope creep, or looping, from the plan's items, its recent activity and the files it
// has touched. `scope_creep` or `looping` at MIN_CONFIDENCE or more writes one line on the progress comment and in the
// job log, at most once per harness run. It is advice only: it never stops, pauses, blocks or redirects a run.
// The decision model sits behind the decider adapter (adapters/decider.mjs, docs/ADAPTERS.md), with the same key as
// red-check triage (triage.mjs triageKey) and its own model setting. This runs in Factory's own process, never in a
// harness. Only the typed label and its confidence reach code; the activity is read from the harness's own event stream
// (Claude stream-json, Codex JSONL, Copilot JSON) by structure.
import { openDecider } from "./adapters/decider.mjs";
import { log, mask } from "./inputs.mjs";
import { triageKey } from "./triage.mjs";

/** The default model: no false flag on 367 on-task checkpoints and 7 of 9 drift checkpoints caught at 0.7 (#2564). */
export const DRIFT_MODEL = "baseten/elephant-1";
/** A drift label below this is not reported: at 0.8 the replay caught 2 of 9, at 0.6 it still had no false flag. */
export const MIN_CONFIDENCE = 0.7;
/** A checkpoint at most this often: no more often than the progress comment's activity line (session.mjs progress.live). */
export const EVERY_MS = 120_000;
/** The activity entries a checkpoint shows, and the fewest a run must have before its first checkpoint. */
export const WINDOW = 12;

/** The one question each checkpoint asks, as measured in the replay. */
export const DRIFT_QUESTION = {
  type: "choice",
  name: "drift",
  instructions:
    "You are watching an unattended coding agent at a checkpoint of one stage of its run. " +
    "Given the plan's items, the stage's goal, the agent's most recent activity and the files it has touched, " +
    "is the agent on task, drifting into scope creep, or looping?",
  choices: [
    { value: "on_task", description: "Making progress on the plan's items or on the stage's goal. Reading code, investigating a failure, running or rerunning tests after a change, waiting for CI, rebasing and updating the PR all count as on task." },
    { value: "scope_creep", description: "Changing files or doing work that no plan item and not the stage's goal calls for, such as reworking CI, toolchain or infrastructure, or editing unrelated areas of the repository." },
    { value: "looping", description: "Repeating the same failing or refused action, or the same probe, again and again without new information or a change of approach." },
  ],
};

/** Each stage's goal, as the replay stated it. */
export const GOALS = Object.freeze({
  work: "implement the plan",
  fix: "fix the red required check or validation command on the pushed head",
  answer: "address the reviewer's comments on the PR",
});

/** The labels that are drift. */
export const isDrift = (a, min = MIN_CONFIDENCE) => (a?.verdict === "scope_creep" || a?.verdict === "looping") && typeof a.confidence === "number" && a.confidence >= min;

/** The plan's checklist items (`- [ ]`, `1. [x]`), up to the first heading after them; none: its first lines. */
export function planItems(text, { cap = 8, width = 200 } = {}) {
  const lines = String(text || "").split("\n");
  const one = (s) => s.replace(/\s+/g, " ").trim().slice(0, width);
  const items = [];
  let started = false;
  for (const l of lines) {
    const m = /^\s*(?:\d+\.|[-*])\s*\[[ xX]\]\s*(.*)$/.exec(l);
    if (m) {
      started = true;
      items.push(one(m[1]));
    } else if (started && /^#{1,4} /.test(l)) break;
  }
  if (items.length) return items.slice(0, cap);
  return lines.filter((l) => l.trim() && !l.startsWith("<!--")).slice(0, cap).map(one);
}

const brief = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// Codex wraps each command in a login shell.
const unwrap = (c) => {
  const s = String(c || "");
  const m = /^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
};
const CLAUDE_EDIT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CLAUDE_READ = new Set(["Read", "Grep", "Glob"]);
const COPILOT_SHELL = new Set(["bash", "shell", "powershell"]);
const COPILOT_EDIT = new Set(["edit", "create", "str_replace_editor", "write", "str_replace", "apply_patch"]);
const COPILOT_READ = new Set(["view", "read", "grep", "glob", "rg"]);
const COPILOT_AGENT = new Set(["task", "agent"]);

/**
 * What a harness did, one entry per tool call, edit, sub-agent and message, from its own event stream: feed(line) per
 * stdout line. An entry is {kind: cmd|edit|read|agent|tool|msg, text, file?, ok?, exit?}; a call's result marks it
 * failed (`ok` false) by the harness's own fields (Claude's is_error, Codex's exit_code, Copilot's success and exit code).
 */
export function activityLog() {
  const entries = [];
  const pending = new Map();
  const add = (e, id) => {
    entries.push(e);
    if (id != null) pending.set(id, e);
  };
  const feed = (line) => {
    const t = String(line || "").trim();
    if (!t.startsWith("{")) return;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      return;
    }
    // Claude
    if (e.type === "assistant" && e.message) {
      for (const c of e.message.content || []) {
        if (c?.type === "tool_use") {
          const inp = c.input || {};
          const file = inp.file_path || inp.notebook_path;
          if (c.name === "Bash") add({ kind: "cmd", text: brief(inp.command, 220) }, c.id);
          else if (CLAUDE_EDIT.has(c.name)) add({ kind: "edit", file: String(file || ""), text: `${c.name} ${file || ""}` }, c.id);
          else if (CLAUDE_READ.has(c.name)) add({ kind: "read", text: `${c.name} ${brief(file || inp.pattern || inp.path, 120)}` }, c.id);
          else if (c.name === "Task" || c.name === "Agent") add({ kind: "agent", text: `${c.name}: ${brief(inp.description, 100)}` }, c.id);
          else add({ kind: "tool", text: `${c.name} ${brief(JSON.stringify(inp), 120)}` }, c.id);
        } else if (c?.type === "text" && c.text && !e.parent_tool_use_id) add({ kind: "msg", text: brief(c.text, 200) });
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        const at = c?.type === "tool_result" ? pending.get(c.tool_use_id) : null;
        if (!at) continue;
        pending.delete(c.tool_use_id);
        at.ok = !c.is_error;
      }
    }
    // Codex
    else if (e.type === "item.completed" && e.item) {
      const it = e.item;
      if (it.type === "command_execution") add({ kind: "cmd", text: brief(unwrap(it.command), 220), exit: it.exit_code ?? null, ok: it.exit_code === 0 });
      else if (it.type === "file_change") for (const ch of it.changes || []) add({ kind: "edit", file: String(ch?.path || ""), text: `${ch?.kind || "change"} ${ch?.path || ""}` });
      else if (it.type === "agent_message" && it.text) add({ kind: "msg", text: brief(it.text, 200) });
      else if (it.type === "mcp_tool_call" || it.type === "web_search") add({ kind: "tool", text: `${it.type} ${brief(it.tool || it.query || "", 120)}` });
    }
    // Copilot
    else if (e.type === "tool.execution_start" && e.data) {
      const name = e.data.toolName;
      const a = e.data.arguments || {};
      const id = e.data.toolCallId;
      if (COPILOT_SHELL.has(name)) add({ kind: "cmd", text: brief(a.command, 220) }, id);
      else if (COPILOT_EDIT.has(name)) add({ kind: "edit", file: String(a.path || ""), text: `${name} ${a.path || ""}` }, id);
      else if (COPILOT_READ.has(name)) add({ kind: "read", text: `${name} ${brief(a.path || a.pattern, 120)}` }, id);
      else if (COPILOT_AGENT.has(name)) add({ kind: "agent", text: `${name}: ${brief(a.description || a.prompt, 100)}` }, id);
      else add({ kind: "tool", text: `${name} ${brief(JSON.stringify(a), 120)}` }, id);
    } else if (e.type === "tool.execution_complete" && e.data) {
      const at = pending.get(e.data.toolCallId);
      if (!at) return;
      pending.delete(e.data.toolCallId);
      at.ok = !!e.data.success;
      const ex = e.data.shellExecution?.exitCode;
      if (typeof ex === "number") {
        at.exit = ex;
        at.ok = at.ok && ex === 0;
      }
    } else if (e.type === "assistant.message" && e.data?.content) add({ kind: "msg", text: brief(e.data.content, 200) });
  };
  return { feed, entries };
}

/** A path or command with the checkout's own prefix dropped, so the model reads repository paths. */
export function relative(text, root) {
  if (!root) return String(text || "");
  const r = String(root).replace(/\/+$/, "");
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "")
    .replace(new RegExp(`cd ${esc}(?:/\\S*)?\\s*(?:&&|;)\\s*`, "g"), "")
    .replace(new RegExp(`${esc}/`, "g"), "");
}

/** One activity entry as the replay showed it. */
export function entryLine(e, root) {
  const t = relative(e.text, root);
  if (e.kind === "msg") return `agent says: ${t.slice(0, 150)}`;
  if (e.kind === "edit") return `edit ${relative(e.file, root)}`;
  if (e.kind === "agent") return `sub-agent ${t.slice(0, 120)}`;
  const s = `${e.kind === "cmd" ? "$ " : ""}${t.slice(0, 150)}`;
  if (e.ok === false) return `${s}  -> failed${typeof e.exit === "number" && e.exit !== 0 ? ` (exit ${e.exit})` : ""}`;
  return s;
}

/** The repository files the run has edited, latest last, at most `cap`: paths inside the checkout only. */
export function filesTouched(entries, root, cap = 25) {
  const out = [];
  for (const e of entries) {
    if (e.kind !== "edit" || !e.file) continue;
    const f = relative(e.file, root);
    if (!f || f.startsWith("/")) continue;
    const i = out.indexOf(f);
    if (i >= 0) out.splice(i, 1);
    out.push(f);
  }
  return out.slice(-cap);
}

/** What one checkpoint asks about: the shape the replay measured. */
export function driftInput({ stage, goal, items = [], entries = [], root = null, window = WINDOW }) {
  const files = filesTouched(entries, root);
  return [
    `Stage: ${stage} (goal: ${goal}). Checkpoint after ${entries.length} tool calls.`,
    "Plan items:",
    ...items.map((x, i) => `${i + 1}. ${x}`),
    "",
    "Recent activity, oldest first:",
    ...entries.slice(-window).map((e) => `- ${entryLine(e, root)}`),
    "",
    `Files touched so far: ${files.length ? files.join(", ") : "none"}`,
  ].join("\n");
}

/** The advisory line: the typed label and its confidence only. */
export const driftLine = ({ stage, model, verdict, confidence, entries }) =>
  `drift advisory (${model}): ${verdict} ${confidence.toFixed(2)} in ${stage} after ${entries} activity entries; advice only, the run goes on`;

/**
 * The drift advisory, or null when there is no key (exactly today's path). `progress` is the run's progressReporter.
 * watch({stage, goal, root, plan}) per harness run returns {feed(line), stop()}: feed each stdout line; `plan()` is the
 * plan's text as it stands (read at each checkpoint). `now` and `everyMs` set the checkpoint clock.
 */
export function openDrift({ inputs, env = process.env, progress = null, decider = null, now = () => Date.now(), everyMs = EVERY_MS }) {
  const key = decider ? null : triageKey({ inputs, env });
  if (!decider && !key) return null;
  mask(key);
  const model = inputs?.driftModel || DRIFT_MODEL;
  let ask = decider;
  // A key the gateway refuses is refused at every checkpoint: asked no more in this job.
  let off = false;
  const watch = ({ stage, goal, root = null, plan = () => null }) => {
    const acts = activityLog();
    let last = now();
    let askedAt = 0;
    let busy = null;
    let flagged = false;
    let stopped = false;
    const check = async () => {
      const n = acts.entries.length;
      askedAt = n;
      last = now();
      ask ??= await openDecider({ key, model });
      const input = driftInput({ stage, goal, items: planItems(plan() ?? ""), entries: acts.entries, root });
      const a = await ask.decide(input, DRIFT_QUESTION);
      if (a.error === "auth") off = true;
      log(`drift check (${model}) in ${stage} after ${n} activity entries: ${a.verdict ? `${a.verdict}${typeof a.confidence === "number" ? ` ${a.confidence.toFixed(2)}` : ""}` : `no verdict (${a.error || "?"})`}`);
      if (flagged || !isDrift(a)) return;
      flagged = true;
      const line = driftLine({ stage, model, verdict: a.verdict, confidence: a.confidence, entries: n });
      log(line);
      if (progress) await progress(line);
    };
    const feed = (line) => {
      acts.feed(line);
      if (busy || flagged || stopped || off) return;
      const n = acts.entries.length;
      if (n < WINDOW || n === askedAt || now() - last < everyMs) return;
      busy = check()
        .catch((e) => log(`drift check failed: ${String(e?.message || e).slice(0, 160)}`))
        .finally(() => {
          busy = null;
        });
    };
    // The run is over: no further checkpoint; one in flight still lands.
    const stop = () => {
      stopped = true;
      return busy ?? Promise.resolve();
    };
    return { feed, stop, entries: acts.entries };
  };
  return { model, watch };
}
