// Local mode: Factory on a developer's own box. The claim that keeps the Actions path and a
// local loop off each other's Objectives, the sandbox the harness and Factory's own shell
// commands run in, the env a child may see, and the adopter's workflow env block read as the
// local configuration. GitHub stays the only state.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { listComments, primeWriters, rest, upsertComment } from "./github.mjs";
import { marker, pushAuthor } from "./logic.mjs";

/** A claim whose heartbeat is older than this is stale: the box went away (asleep, off, or serve stopped). */
export const CLAIM_FRESH_MS = 15 * 60_000;
/** A stale claim pauses its Objective this long, for the same machine's serve to resume it; past it, Blocked. */
export const CLAIM_PAUSE_MS = 24 * 60 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;
/** A heartbeat this far ahead of now is a forgery or a broken clock, never fresh. */
const CLAIM_SKEW_MS = 2 * 60_000;
/** Only people who can push may claim (a local loop writes as its developer, never as the App). */

export const claimMarker = (issue) => marker(issue, "local");

/** The routing label: an Objective carrying it belongs to a developer's local loop, and the Actions path leaves it alone. */
export const LOCAL_LABEL = "factory:local";
export const hasLocalLabel = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === LOCAL_LABEL);

/** True when this process is the local backend (factory run / serve set it). */
export const isLocal = (env = process.env) => env.FACTORY_LOCAL === "1";


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
  await primeWriters(repo, opts);
  const c = (await listComments(repo, issue, opts)).find((x) => (x.body || "").includes(mark) && x?.user?.type !== "Bot" && pushAuthor(x));
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
/**
 * The paths srt write-protects in the working directory on its own (its DANGEROUS_FILES and dangerous directories,
 * sandbox-runtime 0.0.81). Where one is absent, srt mounts /dev/null in its place for the command, which a repository
 * check that walks the tree cannot open (nodev: EACCES) or reads as a file where it expects a directory. Factory
 * makes each absent one before any sandbox opens: an empty directory, or an empty file listed in the clone's
 * .git/info/exclude, so srt protects a real, harmless path and git status stays clean.
 */
export const SRT_PROTECTED = {
  dirs: [".vscode", ".idea", ".claude/commands", ".claude/agents"],
  files: [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"],
};

/** Make the absent SRT_PROTECTED paths in the clone (host side, before a stage). Never writes through an existing path. */
export function prepareProtectedPaths(clone) {
  const made = [];
  for (const d of SRT_PROTECTED.dirs) {
    try {
      mkdirSync(join(clone, d), { recursive: true });
    } catch {
      // something else is there (a file, a symlink): srt protects it as it is
    }
  }
  for (const f of SRT_PROTECTED.files) {
    try {
      // wx: O_CREAT|O_EXCL, so an existing file or symlink is left alone and never followed.
      writeFileSync(join(clone, f), f === ".mcp.json" ? '{"mcpServers":{}}\n' : "", { flag: "wx" });
      made.push(f);
    } catch {
      // already there
    }
  }
  if (made.length) {
    const exclude = join(clone, ".git", "info", "exclude");
    mkdirSync(join(clone, ".git", "info"), { recursive: true });
    const have = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
    const add = made.map((f) => `/${f}`).filter((l) => !have.includes(l));
    if (add.length) appendFileSync(exclude, `${have.length && have.at(-1) !== "" ? "\n" : ""}# Factory: srt's protected paths, made empty so the sandbox protects a real path\n${add.join("\n")}\n`);
  }
  return made;
}

/**
 * Where a stage's private temp directory is made. Sockets live under it (srt's, Claude Code's per-uid directory), and
 * a unix socket path is capped at 104 bytes on macOS: its own temp base (/var/folders/…/T/) is too long, and Claude Code
 * then falls back to the box-wide /tmp/claude-<uid>, so macOS uses /private/tmp.
 */
export const stageTmpBase = (os = osPlatform()) => (os === "darwin" ? "/private/tmp" : tmpdir());

/** srt's and Claude Code's own scratch directory, writable in every one of their sandboxes on the box; Factory points nothing there. */
export const SHARED_TMP = ["/tmp/claude", "/private/tmp/claude"];

export const LOCAL_DOMAINS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"];

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
      filesystem: { denyRead: secrets, denyWrite: [...guards, ...SHARED_TMP] },
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

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A TOML basic string (JSON's escaping is a subset TOML reads the same way). */
const tq = JSON.stringify;

/**
 * Codex's `-c` overrides for a local run: model commands under Codex's own sandbox with a permission profile
 * built on read-only, writes only in the working directory and `addDirs` (the clone's .git writable for commits,
 * its hooks and config not), credential stores unreadable, network through Codex's proxy limited to `domains`,
 * no approval prompts and no escalation, and the model API keys kept out of the commands' environment. Codex's
 * own login stays readable to Codex itself, which runs outside the sandbox: the profile denies the login file,
 * not ~/.codex, where Codex keeps the sandbox helper it starts.
 */
export function codexLocalConfig({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), readOnly = [], secretEnv = [] } = {}) {
  const deny = CREDENTIAL_PATHS.map((p) => (p === ".codex" ? ".codex/auth.json*" : p)).map((p) => `${tq(join(home, p))}="deny"`);
  const ro = readOnly.map((p) => `${tq(p)}="read"`);
  const roots = addDirs.map((d) => `${tq(d)}=true`);
  const net = [...new Set(domains)].map((d) => `${tq(d)}="allow"`);
  const profile = `{extends=":read-only",workspace_roots={${roots.join(",")}},filesystem={${[...deny, ...ro, `":workspace_roots"={"."="write",".git"="write",".git/hooks"="read",".git/config"="read"}`].join(",")}},network={enabled=true,mode="full",domains={${net.join(",")}}}}`;
  return [
    `default_permissions="factory"`,
    `permissions.factory=${profile}`,
    // Without the proxy feature the domain list is ignored and the network is open.
    `features.network_proxy=true`,
    `approval_policy="never"`,
    // The developer's ChatGPT connectors (GitHub, Stripe, ...) would reach the model as tools that run outside the sandbox.
    `features.apps=false`,
    // A trusted project's .codex/config.toml merges into this profile, and the model writes the clone: never trust it.
    ...(clone ? [`projects={${tq(clone)}={trust_level="untrusted"}}`] : []),
    `approvals_reviewer="user"`,
    `shell_environment_policy.exclude=[${secretEnv.map(tq).join(",")}]`,
  ].flatMap((c) => ["-c", c]);
}

/**
 * The settings.json for the COPILOT_HOME Factory gives a local Copilot run (`copilot --sandbox`): commands in
 * Copilot's sandbox with no bypass, writes in the working directory and `addDirs` only, the clone's hooks and
 * config and `readOnly` unwritable, credential stores denied, no gh or git login handed in, and the network
 * limited to `domains`. Copilot reads this policy only from its home directory, so the developer's own
 * ~/.copilot is never touched.
 */
export function copilotLocalSettings({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), readOnly = [], platform = osPlatform() } = {}) {
  return {
    sandbox: {
      enabled: true,
      allowBypass: false,
      // On by default, it opens tool configuration such as ~/.npmrc to every command.
      allowDevToolAccess: false,
      addCurrentWorkingDirectory: true,
      sandboxMcpServers: true,
      sandboxLspServers: true,
      sandboxExtensions: true,
      auth: { git: false, gh: false },
      userPolicy: {
        // On Linux a denied file becomes an empty directory, on which libcurl's ~/.netrc reader loops forever and every
        // git fetch hangs; so there only the credential directories are denied (the sandbox's home is an empty tmpfs
        // today, and this does not count on that), and the file tools are kept off the home by path checks (harness.mjs).
        filesystem: { readwritePaths: addDirs, readonlyPaths: [...(clone ? gitGuards(clone) : []), ...readOnly], deniedPaths: platform === "linux" ? credentialPaths(home).filter(isDir) : credentialPaths(home) },
        network: { allowOutbound: true, allowLocalNetwork: false, allowedHosts: [...new Set(domains)] },
      },
    },
  };
}

/** Settings for `srt`, which runs Factory's own shell commands (setup, install, validation) on a model-edited tree. */
export function srtSettings({ domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), readOnly = [] } = {}) {
  return {
    network: { allowedDomains: [...new Set(domains)], deniedDomains: [] },
    filesystem: { denyRead: credentialPaths(home), allowWrite: writable, denyWrite: [...(clone ? gitGuards(clone) : []), ...readOnly, ...SHARED_TMP] },
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
  // Sandboxed code can rename or replace a directory it may write the parent of; a writable path that now resolves
  // elsewhere (a symlink to the home directory) would open that place to the next sandbox. Factory made each one real.
  for (const d of [s.clone, ...(s.addDirs || [])].filter(Boolean)) {
    let real = null;
    try {
      real = realpathSync(d);
    } catch {
      // gone: the sandbox fails on it by itself
    }
    if (real !== null && real !== d) throw new Error(`local sandbox directory ${d} now resolves to ${real}; refusing to run`);
  }
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
