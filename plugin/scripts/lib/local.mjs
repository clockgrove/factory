// Local mode: Factory on a developer's own box. The claim that keeps the Actions path and a
// local loop off each other's Objectives, the sandbox the harness and Factory's own shell
// commands run in, the env a child may see, and the adopter's workflow env block read as the
// local configuration. GitHub stays the only state.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listComments, rest, upsertComment } from "./github.mjs";
import { marker } from "./logic.mjs";

/** A claim whose heartbeat is older than this is stale: the box went away. */
export const CLAIM_FRESH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;
/** A heartbeat this far ahead of now is a forgery or a broken clock, never fresh. */
const CLAIM_SKEW_MS = 2 * 60_000;
/** Only people who can push may claim: anyone can comment on a public repository. */
const CLAIM_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const claimMarker = (issue) => marker(issue, "local");

/** The routing label: an Objective carrying it belongs to a developer's local loop, and the Actions path leaves it alone. */
export const LOCAL_LABEL = "factory:local";
export const hasLocalLabel = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === LOCAL_LABEL);

/** True when this process is the local backend (factory run / serve set it). */
export const isLocal = (env = process.env) => env.FACTORY_LOCAL === "1";

/** Which path takes an Objective: Actions takes the unlabelled ones; a local loop takes the labelled ones, or all with FACTORY_LOCAL_ALL=1. */
export const routedHere = (issue, env = process.env) => (isLocal(env) ? env.FACTORY_LOCAL_ALL === "1" || hasLocalLabel(issue) : !hasLocalLabel(issue));

/** The claim comment Factory writes, read back by structure: which loop holds it and its last heartbeat. */
export const claimBody = (holder, at = new Date()) => `Running in local mode (${holder}).\nholder: ${holder}\nheartbeat: ${at.toISOString()}`;

export function parseClaim(body, now = Date.now()) {
  const at = /^heartbeat: (\S+)$/m.exec(body || "")?.[1];
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  const holder = /^holder: (\S+)$/m.exec(body)?.[1] ?? null;
  return { holder, heartbeat: at, fresh: now - t < CLAIM_FRESH_MS && t - now < CLAIM_SKEW_MS };
}

/** The issue's local claim, or null. Only a claim posted by someone who can push counts; `fresh` says whether its loop is alive. */
export async function localClaim(repo, issue, opts, now = Date.now()) {
  const mark = claimMarker(issue);
  const c = (await listComments(repo, issue, opts)).find((x) => (x.body || "").includes(mark) && CLAIM_AUTHORS.has(x.author_association));
  if (!c) return null;
  const parsed = parseClaim(c.body, now);
  return parsed ? { ...parsed, commentId: c.id } : null;
}

export const writeClaim = (repo, issue, holder, opts) => upsertComment(repo, issue, claimMarker(issue), claimBody(holder), opts);

/** Drop the claim only when this loop holds it: another loop's claim is not ours to clear. */
export async function dropClaim(repo, issue, holder, opts) {
  const c = await localClaim(repo, issue, opts).catch(() => null);
  if (c && c.holder === holder) await rest(`repos/${repo.full}/issues/comments/${c.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
}

/** The hosts a sandboxed command may reach: GitHub and the npm registry, plus the adopter's list. */
export const LOCAL_DOMAINS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "registry.npmjs.org"];

/**
 * Credential stores under the home directory that no sandboxed command and no file tool may read.
 * The harness CLI itself runs outside the sandbox, so its own login keeps working.
 */
export const CREDENTIAL_PATHS = [".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".git-credentials", ".config/gh", ".config/hub", ".claude/.credentials.json", ".claude.json", ".codex", ".copilot", ".config/github-copilot", ".vercel", ".local/share/com.vercel.cli", ".config/com.vercel.cli", ".config/factory"];
export const credentialPaths = (home = homedir()) => CREDENTIAL_PATHS.map((p) => join(home, p));

/** A clone's git internals Factory itself runs (hooks, config): no sandboxed command and no edit may change them. */
export const gitGuards = (clone) => [join(clone, ".git", "hooks"), join(clone, ".git", "config")];

/**
 * Claude Code's settings for a local run: shell commands in its sandbox with no unsandboxed
 * escape and the run refused when the sandbox cannot start; network limited to `domains`;
 * credential stores unreadable by shell and file tools alike; the clone's git hooks and config
 * unwritable; file edits auto-approved only inside the working directory and `addDirs` (acceptEdits).
 */
export function claudeLocalSettings({ domains = LOCAL_DOMAINS, clone = null, home = homedir(), readOnly = [] } = {}) {
  const secrets = credentialPaths(home);
  // readOnly: Factory's own helpers inside a writable directory (factory-db in the usage dir): no write, no edit.
  const guards = [...(clone ? gitGuards(clone) : []), ...readOnly];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [...new Set(domains)] },
      filesystem: { denyRead: secrets, denyWrite: guards },
    },
    // Bash is allowed outright: every shell command still runs inside the sandbox (allowUnsandboxedCommands is
    // false), which is what confines it; without the rule, gh writes and commands with variables would need a
    // human approval that a headless run cannot get.
    permissions: {
      allow: ["Bash", "Read", "Glob", "Grep", "Agent", "Task", "TodoWrite", "Skill"],
      deny: [...secrets.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]), ...guards.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
  };
}

/** Settings for `srt`, which runs Factory's own shell commands (setup, install, validation) on a model-edited tree. */
export function srtSettings({ domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), readOnly = [] } = {}) {
  return {
    network: { allowedDomains: [...new Set(domains)], deniedDomains: [] },
    filesystem: { denyRead: credentialPaths(home), allowWrite: writable, denyWrite: [...(clone ? gitGuards(clone) : []), ...readOnly] },
  };
}

/**
 * The local harness flags, from FACTORY_LOCAL_SANDBOX ({addDirs, domains, clone}) in the child env; null on
 * Actions. A local child without them refuses: it must never fall back to a runner's skipped permissions.
 */
export function localSandbox(env = {}) {
  if (!env.FACTORY_LOCAL_SANDBOX) {
    if (env.FACTORY_LOCAL === "1") throw new Error("local mode without its sandbox settings (FACTORY_LOCAL_SANDBOX); refusing to run the harness unsandboxed");
    return null;
  }
  const s = JSON.parse(env.FACTORY_LOCAL_SANDBOX);
  return { addDirs: s.addDirs || [], domains: s.domains || LOCAL_DOMAINS, clone: s.clone || null, readOnly: s.readOnly || [] };
}

/**
 * The env a local child starts from: an allow-list, not the developer's whole shell, so AWS_*, NPM_TOKEN
 * and the like never reach the harness. `extra` names more variables the adopter's commands need
 * (FACTORY_LOCAL_ENV, such as DATABASE_URL).
 */
export function localBaseEnv(env = process.env, extra = []) {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TMPDIR|TZ|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|MISE_[A-Z_]+|NVM_DIR|VOLTA_HOME|PNPM_HOME|COREPACK_HOME|BUN_INSTALL|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|JAVA_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
  const wanted = new Set(extra);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) || wanted.has(k)) out[k] = v;
  return out;
}

/** One YAML scalar from a `KEY: value` line: quoted values unquoted (double quotes JSON-decoded), comments outside quotes dropped. */
export function yamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  return s.replace(/\s+#.*$/, "").trim();
}

/**
 * The adopter workflow's top-level `env:` block, so a local run uses the repository's own
 * configuration. Only FACTORY_* keys at two-space indent are read; a value that is an Actions
 * expression (`${{ ... }}`) has no meaning off a runner and is left out.
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
    const m = /^ {2}(FACTORY_[A-Z0-9_]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = yamlScalar(m[2]);
    if (v === null || v.includes("${{")) continue;
    out[m[1]] = v;
  }
  return out;
}

export function readWorkflowEnv(dir) {
  const file = join(dir, ".github", "workflows", "factory.yml");
  return existsSync(file) ? workflowEnv(readFileSync(file, "utf8")) : {};
}
