// Local mode: Factory on a developer's own box. The claim that keeps the Actions path and a
// local loop off each other's Objectives, the Claude Code sandbox the harness runs in, and the
// adopter's workflow env block read as the local configuration. GitHub stays the only state.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listComments, rest, upsertComment } from "./github.mjs";
import { marker } from "./logic.mjs";

/** A claim whose heartbeat is older than this is stale: the box went away. */
export const CLAIM_FRESH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;

export const claimMarker = (issue) => marker(issue, "local");

/** True when this process is the local backend (factory run / serve set it). */
export const isLocal = (env = process.env) => env.FACTORY_LOCAL === "1";

/** The heartbeat line Factory writes into its own claim comment, read back by structure. */
export const claimBody = (host, at = new Date()) => `Running in local mode on ${host}.\nheartbeat: ${at.toISOString()}`;

export function parseClaim(body, now = Date.now()) {
  const at = /^heartbeat: (\S+)$/m.exec(body || "")?.[1];
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  const host = /^Running in local mode on (.+)\.$/m.exec(body)?.[1] ?? null;
  return { host, heartbeat: at, fresh: now - t < CLAIM_FRESH_MS };
}

/** The issue's local claim, or null. `fresh` says whether a loop is still alive on it. */
export async function localClaim(repo, issue, opts, now = Date.now()) {
  const mark = claimMarker(issue);
  const c = (await listComments(repo, issue, opts)).find((x) => (x.body || "").includes(mark));
  if (!c) return null;
  const parsed = parseClaim(c.body, now);
  return parsed ? { ...parsed, commentId: c.id } : null;
}

export const writeClaim = (repo, issue, host, opts) => upsertComment(repo, issue, claimMarker(issue), claimBody(host), opts);

export async function dropClaim(repo, issue, opts) {
  const c = await localClaim(repo, issue, opts).catch(() => null);
  if (c) await rest(`repos/${repo.full}/issues/comments/${c.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
}

/** The hosts a sandboxed harness command may reach: GitHub and the npm registry, plus the adopter's list. */
export const LOCAL_DOMAINS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "registry.npmjs.org"];

/**
 * Claude Code's settings for a local run: shell commands in its sandbox with no unsandboxed
 * escape, the run refused when the sandbox cannot start, network limited to `domains`, and
 * file edits auto-approved only inside the working directory and `addDirs` (acceptEdits).
 * Reads, search, sub-agents and skills need no prompt; anything else that would prompt is denied.
 */
export function claudeLocalSettings({ domains = LOCAL_DOMAINS } = {}) {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, network: { allowedDomains: [...new Set(domains)] } },
    permissions: { allow: ["Read", "Glob", "Grep", "Agent", "Task", "TodoWrite", "Skill"], blockWritesOutsideWorkingDirectories: true },
  };
}

/** The local harness flags, from FACTORY_LOCAL_SANDBOX ({addDirs, domains}) in the child env; null on Actions. */
export function localSandbox(env = {}) {
  if (!env.FACTORY_LOCAL_SANDBOX) return null;
  const s = JSON.parse(env.FACTORY_LOCAL_SANDBOX);
  return { addDirs: s.addDirs || [], domains: s.domains || LOCAL_DOMAINS };
}

/**
 * The adopter workflow's top-level `env:` block (FACTORY_* settings), so a local run uses the
 * repository's own configuration. Only `KEY: value` lines at two-space indent are read.
 */
export function workflowEnv(text) {
  const out = {};
  let inEnv = false;
  for (const raw of text.split("\n")) {
    if (/^env:\s*$/.test(raw)) {
      inEnv = true;
      continue;
    }
    if (!inEnv) continue;
    if (/^\S/.test(raw)) break;
    const m = /^ {2}([A-Z0-9_]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "").trim();
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readWorkflowEnv(dir) {
  const file = join(dir, ".github", "workflows", "factory.yml");
  return existsSync(file) ? workflowEnv(readFileSync(file, "utf8")) : {};
}
