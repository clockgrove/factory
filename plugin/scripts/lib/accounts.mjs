// Local mode's accounts (#263): several logins of one harness on this machine, each a stage may run on. The machine
// declares them in a host-only file, ~/.config/factory/accounts.json, which no sandbox can read and no repository
// holds. A Claude Code account is a config folder (CLAUDE_CONFIG_DIR), a Codex account a Codex home (CODEX_HOME), a
// Copilot account a token file. The first declared account of a harness is its default; with none declared, a harness
// has one account, named after it, which runs exactly as local mode always ran. Every declared login is hidden from
// every sandbox but its own stage's (local.mjs harnessLogins reads this file), and every account is checked at every
// load: a bad one Blocks the stage, naming the account alone. Paths and tokens never leave this machine's process.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SHARED_TMP, factoryKeyDir, gatewayKeyFile, harnessLogins, keyDirExposedBy } from "./local.mjs";

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

/**
 * The file's text parsed, with {error} (no path in it) when it cannot be used; {absent: true} when there is no file.
 * Never follows a link. Held to the rules for local secrets (local.mjs localApp): a regular file of this user's, one
 * hard link, no group or world write bit, in a ~/.config/factory that is a real directory no group or world writes.
 * `value` is the parsed object even when a rule fails, for declaredLogins: hiding what it names costs nothing.
 */
function readDeclaration(home, uid = process.getuid?.()) {
  const file = accountsFile(home);
  try {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st) return { absent: true };
    if (!st.isFile()) return { error: "the accounts file is not a regular file (a link or a folder)" };
    let value = null;
    let error = null;
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) value = v;
      else error = "the accounts file is not a JSON object";
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      error = "the accounts file is not valid JSON";
    }
    // The sandboxes deny ~/.config/factory by that literal path: through a link, the file could be where one writes.
    const dir = factoryKeyDir(home);
    const dirSt = lstatSync(dir);
    if (real(dir) !== dir || !dirSt.isDirectory()) error = "~/.config/factory is not a real directory (a link), so the sandboxes' deny of it does not cover the accounts file";
    else if (dirSt.mode & 0o022) error = "~/.config/factory is writable by others; chmod 700 it";
    else if (uid !== undefined && st.uid !== uid) error = "the accounts file belongs to another user";
    else if (st.nlink > 1) error = "the accounts file has more than one hard link; keep one copy";
    else if (st.mode & 0o022) error = "the accounts file is writable by others; chmod 600 it";
    return error ? { error, ...(value ? { value } : {}) } : { value };
  } catch (e) {
    // This user cannot read the file or its folder (EACCES), or it changed under the read: a fixed reason, never a path.
    return { error: `the accounts file cannot be read (${typeof e?.code === "string" ? e.code : "an error"})` };
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

/** Whether `p` is `d` or under it; everything is under `/`. */
const within = (p, d) => p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`);
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
 * - a name that is not lowercase letters, digits and hyphens, or longer than ACCOUNT_NAME_MAX, or used twice, or
 *   another harness's name (that harness's account when it declares none);
 * - a path that is not absolute or is not its own real path (a link on the way, `..`, a trailing slash);
 * - a folder that does not exist or is not a directory (Factory never makes one), or a token file that does not exist;
 * - two accounts on one real path;
 * - a folder in or around another account's, another harness login (local.mjs harnessLogins), ~/.config/factory or a
 *   directory a sandbox may write (`roots`, sandboxRoots);
 * - a token file outside ~/.config/factory, one of Factory's own secrets there (this file, the AI Gateway key, a
 *   repository's GitHub token, the App's key; by path or by the file itself, however its name is spelled), or one
 *   that breaks the rules for secrets (local.mjs localApp): no regular file, a second hard link, group or world bits,
 *   empty or blank, or a ~/.config/factory a harness home or login holds;
 * - a harness whose variable in serve's own environment (`env`: CLAUDE_CONFIG_DIR, CODEX_HOME) names a folder no account
 *   declares and no search finds: a stage's env then names its account's folder instead, and that one would go unhidden.
 * The whole file is refused (readDeclaration) when it, or ~/.config/factory, breaks the rules for secrets or cannot be
 * read; `uid` is the user it must belong to.
 */
export function loadAccounts({ home = homedir(), env = process.env, roots = [], uid = process.getuid?.() } = {}) {
  const d = readDeclaration(home, uid);
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
      // Another harness's implicit account's name: a stage's hold (#264) and the account label (#265) key on names.
      if (ACCOUNT_HARNESSES.includes(name) && name !== harness) return bad(name, "the name is another harness's (its account when none is declared)");
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
    const st = statQuiet(a.home);
    if (!st?.isDirectory()) {
      bad(a.name, st ? "its folder is not a directory" : "its folder does not exist; Factory never makes one");
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
  // Factory's own secrets there, which a Copilot stage would get as its token: this file, the AI Gateway key, the
  // repositories' GitHub tokens and the App's private key (FACTORY_LOCAL_APP_KEY, by its real path).
  const appKey = String(env.FACTORY_LOCAL_APP_KEY || "").trim().replace(/^~(?=\/)/, home);
  const own = [accountsFile(home), gatewayKeyFile(home), ...(appKey ? [real(resolve(appKey))] : [])].filter(Boolean);
  // Each also by the file itself (its device and inode), whatever its name is spelled: on a case-insensitive file system
  // (macOS) `Accounts.json` or `TOKENS/acme/app` is that file under another name, which no path comparison catches.
  // Listed once, and only when an account declares a token file.
  let ownFiles;
  const isOwn = (f) => {
    const st = statQuiet(f);
    ownFiles ??= [...own, ...filesIn(join(keyDir, "tokens"))].map(statQuiet).filter(Boolean);
    return !!st && ownFiles.some((o) => o.dev === st.dev && o.ino === st.ino);
  };
  for (const a of all.filter((x) => x.tokenFile)) {
    if (keyReal !== keyDir) bad(a.name, "~/.config/factory is not a real directory (a link): the sandboxes deny that literal path");
    else if (!a.tokenFile.startsWith(`${keyDir}/`)) bad(a.name, "its token file is not under ~/.config/factory, which no sandbox can read; move it there, don't copy it");
    else if (exposed) bad(a.name, "~/.config/factory is inside a harness home or login, which that harness's sandbox can read");
    else if (own.includes(a.tokenFile) || within(a.tokenFile, join(keyDir, "tokens")) || isOwn(a.tokenFile)) bad(a.name, "its token file is one of Factory's own secrets (the accounts file, the AI Gateway key, a GitHub token or the App's key)");
    else {
      const st = statQuiet(a.tokenFile);
      if (!st) bad(a.name, "its token file does not exist; Factory never makes one");
      else if (!st.isFile()) bad(a.name, "its token file is not a regular file");
      else if (st.nlink > 1) bad(a.name, "its token file has more than one hard link; keep one copy");
      else if (st.mode & 0o077) bad(a.name, "its token file is readable or writable by others; chmod 600 it");
      else if (tokenText(a.tokenFile) === null) bad(a.name, "its token file cannot be read by this user; chmod 600 it");
      else if (!tokenText(a.tokenFile)) bad(a.name, "its token file is empty");
      else if (all.some((b) => b !== a && b.tokenFile === a.tokenFile)) bad(a.name, "another account has the same token file");
    }
  }
  // Serve's own CLAUDE_CONFIG_DIR or CODEX_HOME, which a stage's env no longer names once its harness declares accounts.
  const found = harnessLogins(home, {});
  for (const [harness, k] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) {
    // A relative value too: the harness resolves it against serve's working directory, as resolve() does here.
    if (!accounts[harness].length || !env[k]) continue;
    const at = real(resolve(env[k])) || resolve(env[k]);
    if (!found.some((l) => l.harness === harness && (real(l.dir) || l.dir) === at)) bad(k, `this shell's ${k} names a folder no declared ${harness === "claude" ? "Claude Code" : "Codex"} account has; declare it as one, or unset ${k}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, declared: true, accounts };
}

/** The account a `harness` stage runs on: its first declared one, else the one named after the harness. */
export const defaultAccount = (loaded, harness) => loaded?.accounts?.[harness]?.[0] ?? implicitAccount(harness);

/** Every account a `harness` stage may run on: its declared ones in order, else the one named after the harness. */
export const harnessAccounts = (loaded, harness) => (loaded?.accounts?.[harness]?.length ? loaded.accounts[harness] : [implicitAccount(harness)]);

/**
 * The machine setting that turns on automatic account choice (#266): set in the shell that runs `factory serve` only,
 * never by the workflow file or a repository variable (both leave out a name that is no setting of theirs). `1` is on;
 * unset, empty or `0` is off. {on, problem}: `problem` names any other value, which leaves it off.
 */
export const AUTO_ACCOUNT_ENV = "FACTORY_LOCAL_AUTO_ACCOUNT";
export function autoAccountSetting(env = process.env) {
  const v = env[AUTO_ACCOUNT_ENV];
  if (v === "1") return { on: true, problem: null };
  if (v === undefined || v === "" || v === "0") return { on: false, problem: null };
  return { on: false, problem: `${AUTO_ACCOUNT_ENV} is neither 1 nor 0, so automatic account choice is off` };
}

/**
 * The account a stage with no account label starts on when automatic choice is on (#266), from `list` (harnessAccounts,
 * in declared order). An account is free when `until(a)` (its hold's end, ms) is null. Of the free ones: `prefer` (a
 * name: the account the Objective's last stage paused on, whose session carries over there); else the one whose latest
 * usage limit was met least recently (`limitedAt(a)`, ms, null for none the machine remembers: those first); then the
 * one a stage last started on least recently (`startedAt(a)`, ms or null: the machine's round-robin); then the first
 * declared. With every account held, the one whose hold ends first: the stage is held on it until then.
 */
export function chooseAccount(list, { until, limitedAt = () => null, startedAt = () => null, prefer = null }) {
  const rows = list.map((a, i) => ({ a, i, until: until(a) }));
  const free = rows.filter((r) => r.until === null);
  if (!free.length) return rows.reduce((x, y) => (y.until < x.until ? y : x)).a;
  const own = prefer ? free.find((r) => r.a.name === prefer) : null;
  if (own) return own.a;
  const at = (v) => (Number.isFinite(v) ? v : -Infinity);
  for (const r of free) [r.limited, r.started] = [at(limitedAt(r.a)), at(startedAt(r.a))];
  return free.sort((x, y) => x.limited - y.limited || x.started - y.started || x.i - y.i)[0].a;
}

/** An account label as a notice shows it: code-quoted when its name is an account name, else not echoed at all. */
export const pinLabelText = (label) => (validAccountName(label.slice(ACCOUNT_LABEL_PREFIX.length).trim().toLowerCase()) ? `\`${label}\`` : "an account label whose name is no account name");

/** The account labels among `names` (names, or GitHub's label objects), sorted, once each. */
export const accountLabels = (names = []) => [...new Set((names || []).map((n) => (typeof n === "string" ? n : n?.name)).filter((n) => typeof n === "string" && n.toLowerCase().startsWith(ACCOUNT_LABEL_PREFIX)))].sort();

/**
 * The account an Objective's labels pin it to (#265), decided on the names alone: {label: null} with none; {label, name}
 * with one (the name lower case, as declared); {label: null, two: [labels]} with more than one, which moves nothing.
 */
export function accountPin(names = []) {
  const labels = accountLabels(names);
  if (labels.length > 1) return { label: null, two: labels };
  if (!labels.length) return { label: null };
  return { label: labels[0], name: labels[0].slice(ACCOUNT_LABEL_PREFIX.length).trim().toLowerCase() };
}

/**
 * The account `name` is for a `harness` stage, from a declaration loadAccounts accepted: {account}, or {problem} (a fixed
 * line naming the label and no path) for a name this machine declares for no harness, or declares for another one. A
 * harness that declares none has its one account, named after it.
 */
export function pinnedAccount(loaded, harness, name) {
  const label = pinLabelText(`${ACCOUNT_LABEL_PREFIX}${name}`);
  const mine = harnessAccounts(loaded, harness);
  const hit = mine.find((a) => a.name === name);
  if (hit) return { account: hit };
  const other = ACCOUNT_HARNESSES.find((h) => h !== harness && harnessAccounts(loaded, h).some((a) => a.name === name));
  if (other) return { problem: `${label} names a ${HARNESS_NAMES[other]} account, and this Objective runs on ${HARNESS_NAMES[harness]}` };
  return { problem: `${label} names no ${HARNESS_NAMES[harness]} account this machine declares (${mine.map((a) => `\`${a.name}\``).join(", ")})` };
}

/**
 * The progress line a stage off local mode (GitHub Actions, the cloud sandbox) writes once when the Objective carries an
 * account label, which only local mode acts on; "" in local mode or with none.
 */
export function accountLabelNote(names = [], local = false) {
  const labels = accountLabels(names);
  if (local || !labels.length) return "";
  return `${labels.map(pinLabelText).join(", ")} does nothing on this route: accounts are a local-mode setting (\`factory serve\` on one machine), so this stage runs on the repository's own credential.`;
}

/** The harnesses by the names a person reads. */
export const HARNESS_NAMES = { claude: "Claude Code", codex: "Codex", copilot: "Copilot" };

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

/** A token file's text, trimmed; null when this user cannot read it. */
const tokenText = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};
/** At most this many entries are listed under ~/.config/factory/tokens (filesIn). */
const FILES_IN_MAX = 10_000;
/**
 * Every path in `dir` and its subfolders, as Factory reads them: its real folders first, then what a link to a folder
 * leads to (a token under `tokens/acme`, a link to another folder, is read through it). Each folder is entered once, by
 * its device and inode, so a link to `.` or two links to one tree cost nothing more; the listing stops at FILES_IN_MAX
 * entries, so a link out of ~/.config/factory (to `/`) costs at most that, after every real folder is listed. A folder
 * that cannot be read lists nothing of its own, the rest still listed.
 */
const filesIn = (dir) => {
  const out = [];
  const seen = new Set();
  const links = [];
  const enter = (d) => {
    if (out.length >= FILES_IN_MAX) return;
    const st = statQuiet(d);
    if (!st?.isDirectory() || seen.has(`${st.dev}:${st.ino}`)) return;
    seen.add(`${st.dev}:${st.ino}`);
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= FILES_IN_MAX) return;
      const p = join(d, e.name);
      out.push(p);
      if (e.isDirectory()) enter(p);
      else if (e.isSymbolicLink()) links.push(p);
    }
  };
  enter(dir);
  while (links.length && out.length < FILES_IN_MAX) enter(links.shift());
  return out;
};
/** statSync, or null when the path is gone (a folder removed between its realpath and here) or cannot be read. */
const statQuiet = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/** The Blocked reason for a declaration that cannot be used: the accounts' names alone, never a path or a value. */
export const accountReason = (problems) => {
  const names = [...new Set(problems.map((p) => p.account))];
  return `local mode: ${names.map((n) => `\`${n}\``).join(", ")} in this machine's account declaration cannot be used (account); the local loop's log says why; fix ~/.config/factory/accounts.json, then re-apply \`factory:objective\``;
};
