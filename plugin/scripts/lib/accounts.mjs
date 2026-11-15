// Local mode's accounts (#263): several logins of one harness on this machine, each a stage may run on. The machine
// declares them in a host-only file, ~/.config/factory/accounts.json, which no sandbox can read and no repository
// holds. A Claude Code account is a config folder (CLAUDE_CONFIG_DIR), a Codex account a Codex home (CODEX_HOME), a
// Copilot account a token file. The first declared account of a harness is its default; with none declared, a harness
// has one account, named after it, which runs exactly as local mode always ran. Every declared login is hidden from
// every sandbox but its own stage's (local.mjs harnessLogins reads this file), and every account is checked at every
// load: a bad one Blocks the stage, naming the account alone. Paths and tokens never leave this machine's process.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SHARED_TMP, factoryKeyDir, harnessLogins, keyDirExposedBy } from "./local.mjs";

export const ACCOUNT_HARNESSES = ["claude", "codex", "copilot"];
/** The label a person moves a stage to an account with (#265): GitHub caps a label at 50 characters, so a name gets 34. */
export const ACCOUNT_LABEL_PREFIX = "factory:account:";
export const ACCOUNT_NAME_MAX = 50 - ACCOUNT_LABEL_PREFIX.length;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const validAccountName = (name) => typeof name === "string" && name.length <= ACCOUNT_NAME_MAX && NAME.test(name);
/** The key of an account's path in the file: a folder for Claude Code and Codex, a token file for Copilot. */
const PATH_KEY = { claude: "home", codex: "home", copilot: "token_file" };

/** The host-only declaration: in ~/.config/factory, which every sandbox denies by that literal path. */
export const accountsFile = (home = homedir()) => join(factoryKeyDir(home), "accounts.json");

/** The one account a harness has with none declared: named after the harness, on the login it always ran on. */
export const implicitAccount = (harness) => ({ name: harness, harness, declared: false });

/** The file's text parsed, or {error} (no path in it); {absent: true} when there is no file. Never follows a link. */
function readDeclaration(home) {
  const file = accountsFile(home);
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { absent: true };
  // The sandboxes deny ~/.config/factory by that literal path: through a link, the file could be where one writes.
  const dir = factoryKeyDir(home);
  if (real(dir) !== dir) return { error: "~/.config/factory is not a real directory (a link), so the sandboxes' deny of it does not cover the accounts file" };
  if (!st.isFile()) return { error: "the accounts file is not a regular file (a link or a folder)" };
  if (st.mode & 0o022) return { error: "the accounts file is writable by others; chmod 600 it" };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "the accounts file is not a JSON object" };
    return { value: v };
  } catch {
    return { error: "the accounts file is not valid JSON" };
  }
}

/**
 * The Claude Code and Codex folders the file declares, as [{harness, dir}], for local.mjs harnessLogins (its `declared`
 * hook): every one is hidden from every sandbox but its own stage's. Read leniently (a file loadAccounts refuses still
 * hides what it names), never throwing; an entry that is no absolute path is left out (loadAccounts refuses it).
 */
export function declaredLogins(home = homedir()) {
  let d;
  try {
    d = readDeclaration(home);
  } catch {
    return [];
  }
  if (!d.value) return [];
  const out = [];
  for (const harness of ["claude", "codex"]) {
    const list = d.value[harness];
    if (!Array.isArray(list)) continue;
    for (const a of list) if (typeof a?.home === "string" && isAbsolute(a.home)) out.push({ harness, dir: resolve(a.home) });
  }
  return out;
}

const within = (p, d) => p === d || p.startsWith(`${d}/`);
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The directories a sandbox on this machine may write, which no account may be in or around: this repository's clone
 * (its `.factory` holds every Objective's clone, caches and stage directories), the stages' temp directories
 * (local.mjs stageTmpBase) and srt's and Claude Code's shared scratch directory (local.mjs SHARED_TMP).
 */
export const sandboxRoots = (dev, home = homedir(), os = osPlatform()) => [...(dev ? [dev] : []), os === "darwin" ? `/private/tmp/fct-${process.getuid?.() ?? 0}` : join(home, ".cache", "factory", "s"), ...SHARED_TMP];

/**
 * Every account this machine declares, checked: {ok: true, declared, accounts: {claude: [...], codex: [...], copilot:
 * [...]}} (each {name, harness, home | tokenFile, declared: true}, the first of a harness its default), or {ok: false,
 * problems: [{account, why}]}, where `account` is the account's name (for an invalid name, its harness and place) and
 * `why` names no path. Refused, for any one account:
 * - a name that is not lowercase letters, digits and hyphens, or longer than ACCOUNT_NAME_MAX, or used twice;
 * - a path that is not absolute or is not its own real path (a link on the way, `..`, a trailing slash);
 * - a folder that does not exist or is not a directory (Factory never makes one), or a token file that does not exist;
 * - two accounts on one real path;
 * - a folder in or around another account's, another harness login (local.mjs harnessLogins), ~/.config/factory or a
 *   directory a sandbox may write (`roots`, sandboxRoots);
 * - a token file outside ~/.config/factory or that breaks its rules for secrets (local.mjs localApp): no regular file,
 *   a second hard link, group or world bits, empty, or a ~/.config/factory a harness home or login holds;
 * - a harness whose variable in serve's own environment (`env`: CLAUDE_CONFIG_DIR, CODEX_HOME) names a folder no account
 *   declares and no search finds: a stage's env then names its account's folder instead, and that one would go unhidden.
 */
export function loadAccounts({ home = homedir(), env = process.env, roots = [] } = {}) {
  const d = readDeclaration(home);
  const accounts = { claude: [], codex: [], copilot: [] };
  if (d.absent) return { ok: true, declared: false, accounts };
  if (d.error) return { ok: false, problems: [{ account: "the accounts file", why: d.error }] };
  const problems = [];
  const bad = (account, why) => problems.push({ account, why });
  for (const k of Object.keys(d.value)) if (!ACCOUNT_HARNESSES.includes(k)) bad("the accounts file", `it names no harness Factory runs: ${JSON.stringify(k).slice(0, 40)}`);
  const seen = new Set();
  const all = [];
  for (const harness of ACCOUNT_HARNESSES) {
    const list = d.value[harness];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      bad(`${harness} accounts`, "they are not a list");
      continue;
    }
    list.forEach((a, i) => {
      const where = `${harness} account ${i + 1}`;
      if (!a || typeof a !== "object" || !validAccountName(a.name)) return bad(where, `its name must be lowercase letters, digits and hyphens, starting with a letter or digit, at most ${ACCOUNT_NAME_MAX} characters`);
      const name = a.name;
      if (seen.has(name)) return bad(name, "the name is declared twice");
      seen.add(name);
      const p = a[PATH_KEY[harness]];
      if (typeof p !== "string" || !p) return bad(name, `it has no "${PATH_KEY[harness]}"`);
      if (!isAbsolute(p) || resolve(p) !== p) return bad(name, `its ${harness === "copilot" ? "token file" : "folder"} is not an absolute, normal path`);
      const r = real(p);
      if (!r) return bad(name, `its ${harness === "copilot" ? "token file" : "folder"} does not exist; Factory never makes one`);
      if (r !== p) return bad(name, `its ${harness === "copilot" ? "token file" : "folder"} is not at its real path (a link is on the way); declare the real path`);
      const acct = { name, harness, declared: true, ...(harness === "copilot" ? { tokenFile: p } : { home: p }) };
      all.push(acct);
      accounts[harness].push(acct);
    });
  }
  const keyDir = factoryKeyDir(home);
  const logins = harnessLogins(home, env);
  const homes = all.filter((a) => a.home);
  for (const a of homes) {
    if (!statSync(a.home).isDirectory()) {
      bad(a.name, "its folder is not a directory");
      continue;
    }
    const twin = homes.find((b) => b !== a && b.home === a.home);
    if (twin) {
      bad(a.name, `it is on the same folder as account ${twin.name}`);
      continue;
    }
    const nest = homes.find((b) => b !== a && (within(a.home, b.home) || within(b.home, a.home)));
    if (nest) {
      bad(a.name, `its folder is in or around account ${nest.name}'s`);
      continue;
    }
    if (within(a.home, keyDir) || within(keyDir, a.home)) {
      bad(a.name, "its folder is in or around ~/.config/factory");
      continue;
    }
    if (roots.flatMap((r) => [r, real(r)]).some((r) => r && (within(a.home, r) || within(r, a.home)))) {
      bad(a.name, "its folder is in or around a directory a sandbox may write (this repository's clone, the stages' temp directories, /tmp/claude)");
      continue;
    }
    // Another login: one on the same folder must be this harness's; none may be in or around it, nor any of its files.
    const other = logins.find((l) => {
      const at = real(l.dir) || l.dir;
      if (at === a.home) return l.harness !== a.harness;
      return within(at, a.home) || within(a.home, at) || l.files.some((f) => !within(f, l.dir) && within(f, a.home));
    });
    if (other) bad(a.name, `its folder is in or around another ${other.harness === "claude" ? "Claude Code" : other.harness === "codex" ? "Codex" : "Copilot"} login`);
  }
  const keyReal = real(keyDir);
  const exposed = keyDirExposedBy("copilot", { ...env, COPILOT_HOME: "" }, home);
  for (const a of all.filter((x) => x.tokenFile)) {
    if (keyReal !== keyDir) bad(a.name, "~/.config/factory is not a real directory (a link): the sandboxes deny that literal path");
    else if (!a.tokenFile.startsWith(`${keyDir}/`)) bad(a.name, "its token file is not under ~/.config/factory, which no sandbox can read; move it there, don't copy it");
    else if (exposed) bad(a.name, "~/.config/factory is inside a harness home or login, which that harness's sandbox can read");
    else {
      const st = statSync(a.tokenFile);
      if (!st.isFile()) bad(a.name, "its token file is not a regular file");
      else if (st.nlink > 1) bad(a.name, "its token file has more than one hard link; keep one copy");
      else if (st.mode & 0o077) bad(a.name, "its token file is readable or writable by others; chmod 600 it");
      else if (!st.size) bad(a.name, "its token file is empty");
      else if (all.some((b) => b !== a && b.tokenFile === a.tokenFile)) bad(a.name, "another account has the same token file");
    }
  }
  // Serve's own CLAUDE_CONFIG_DIR or CODEX_HOME, which a stage's env no longer names once its harness declares accounts.
  const found = harnessLogins(home, {});
  for (const [harness, k] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) {
    if (!accounts[harness].length || !env[k] || !isAbsolute(env[k])) continue;
    const at = real(env[k]) || resolve(env[k]);
    if (!found.some((l) => l.harness === harness && (real(l.dir) || l.dir) === at)) bad(k, `this shell's ${k} names a folder no declared ${harness === "claude" ? "Claude Code" : "Codex"} account has; declare it as one, or unset ${k}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, declared: true, accounts };
}

/** The account a `harness` stage runs on: its first declared one, else the one named after the harness. */
export const defaultAccount = (loaded, harness) => loaded?.accounts?.[harness]?.[0] ?? implicitAccount(harness);

/**
 * A stage's env for `account`: with a declared Claude Code or Codex account, its folder set explicitly (never what
 * serve's own environment held): CODEX_HOME, or CLAUDE_CONFIG_DIR unset for the default `~/.claude` (Claude Code keeps
 * that login's `.claude.json` in the home directory) and set for any other folder. Unchanged for the implicit account.
 */
export function accountEnv(env, account, home = homedir()) {
  if (!account?.declared || account.harness === "copilot") return env;
  const out = { ...env };
  if (account.harness === "claude") {
    delete out.CLAUDE_CONFIG_DIR;
    if (account.home !== join(home, ".claude")) out.CLAUDE_CONFIG_DIR = account.home;
  }
  if (account.harness === "codex") out.CODEX_HOME = account.home;
  return out;
}

/** A declared Copilot account's token, read from its file (loadAccounts checked it); "" for any other account. */
export const accountToken = (account) => (account?.declared && account.tokenFile ? readFileSync(account.tokenFile, "utf8").trim() : "");

/** The Blocked reason for a declaration that cannot be used: the accounts' names alone, never a path or a value. */
export const accountReason = (problems) => {
  const names = [...new Set(problems.map((p) => p.account))];
  return `local mode: ${names.map((n) => `\`${n}\``).join(", ")} in this machine's account declaration cannot be used (account); the local loop's log says why; fix ~/.config/factory/accounts.json, then re-apply \`factory:objective\``;
};
