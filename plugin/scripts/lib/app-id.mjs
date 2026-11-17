// Pendulum's App id on this machine (#564), which `pendulum report` needs to tell the App's comments from another App's:
// - the repository variable PENDULUM_APP_ID (inputs.mjs APP_ID_VARIABLE), read with a token and, when GitHub refuses that
//   token (403, or a 404 a token without Variables: read may get), once more with the gh login's;
// - a readable local copy of it beside local mode's token, ~/.config/pendulum/repos/<owner>/<name>.json, which setup and
//   local mode's serve and doctor save. The id is no secret (GitHub shows it on every comment the App writes), so the
//   copy is no secrets file; it decides whose comments count as Pendulum's, so it is taken only when its owner alone can
//   write it: a real file of this user's, behind no symbolic link, no group or world write bit on it or its folders.
import { chmodSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ghLoginToken, rest } from "./github.mjs";
import { APP_ID_VARIABLE } from "./inputs.mjs";

/** A GitHub App's id as a number, from the variable's text or the copy's JSON number; null for anything else. */
export function appIdOf(value) {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** OWNER/NAME's two parts as GitHub allows them, so a path built from them stays under its folder; else null. */
const repoParts = (repoFull) => {
  const parts = String(repoFull ?? "").split("/");
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..") ? parts : null;
};

/** Where the local copy of a repository's App id lives: ~/.config/pendulum/repos/<owner>/<name>.json, `{"appId": N}`. */
export function appIdFile(repoFull, home = homedir()) {
  const [owner, name] = String(repoFull).split("/");
  return join(home, ".config", "pendulum", "repos", owner, `${name}.json`);
}

/** Why a place of the copy (`st`, its lstat or fstat) may not be trusted, else null: not this user's, or others may write it. */
function entryProblem(st, at, uid) {
  if (uid !== null && st.uid !== uid) return `${at} belongs to another user (uid ${st.uid}); remove it and save the copy again`;
  if (st.mode & 0o022) return `${at} is writable by others (mode ${(st.mode & 0o777).toString(8)}); chmod go-w ${at}`;
  return null;
}
const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/**
 * Why the local copy's place may not be trusted, else null: ~/.config/pendulum, its `repos` folder, the owner's folder or
 * the file is a symbolic link, is not this user's, or is writable by its group or the world; or the file is no regular
 * file. A part not there yet is no problem.
 */
export function appIdPlaceProblem(repoFull, home = homedir()) {
  const file = appIdFile(repoFull, home);
  const base = join(home, ".config", "pendulum");
  const uid = ownUid();
  for (const at of [base, join(base, "repos"), dirname(file), file]) {
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return `${at} is a symbolic link; replace it with a real ${at === file ? "file" : "folder"} of your own`;
    if (at === file && !st.isFile()) return `${at} is not a regular file`;
    const why = entryProblem(st, at, uid);
    if (why) return why;
  }
  return null;
}

/**
 * The local copy of a repository's App id: {id, file}; {id: null, file} when there is none; {id: null, file, problem}
 * when its place may not be trusted (appIdPlaceProblem) or it names no App id. The file is opened with O_NOFOLLOW and
 * checked again on its open descriptor (fstat), which is what is read, so a swap after the check reads nothing else.
 * Never throws.
 */
export function readLocalAppId(repoFull, home = homedir()) {
  if (!repoParts(repoFull)) return { id: null, file: null };
  const file = appIdFile(repoFull, home);
  try {
    lstatSync(file);
  } catch {
    return { id: null, file };
  }
  const problem = appIdPlaceProblem(repoFull, home);
  if (problem) return { id: null, file, problem };
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    return { id: null, file, problem: e?.code === "ELOOP" ? `${file} is a symbolic link; replace it with a real file of your own` : `${file} could not be opened (${e?.code || e?.message})` };
  }
  let text;
  try {
    const st = fstatSync(fd);
    const why = st.isFile() ? entryProblem(st, file, ownUid()) : `${file} is not a regular file`;
    if (why) return { id: null, file, problem: why };
    text = readFileSync(fd, "utf8");
  } catch (e) {
    return { id: null, file, problem: `${file} could not be read (${e?.code || e?.message})` };
  } finally {
    closeSync(fd);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { id: null, file, problem: `${file} is not JSON (${String(e?.message || e).slice(0, 80)})` };
  }
  const id = appIdOf(data?.appId);
  return id === null ? { id: null, file, problem: `${file} names no numeric App id in "appId"` } : { id, file };
}

/**
 * Saves a repository's App id as its local copy (appIdFile), readable (0644) and written by its owner alone, in folders
 * only its owner reads (0700, as local mode's token's): a new file, synced and put in place by rename. Nothing is written
 * when the copy already names that id. Refuses a repository that is not OWNER/NAME, an id that is no App id and a place
 * appIdPlaceProblem names. Returns {file, saved}.
 */
export function saveLocalAppId(repoFull, appId, home = homedir()) {
  if (!repoParts(repoFull)) throw new Error(`the repository must be OWNER/NAME, not ${JSON.stringify(repoFull)}; the App id was not saved`);
  const id = appIdOf(appId);
  if (id === null) throw new Error(`${JSON.stringify(appId)} is no GitHub App id (a number); it was not saved`);
  const file = appIdFile(repoFull, home);
  const placed = () => {
    const problem = appIdPlaceProblem(repoFull, home);
    if (problem) throw new Error(`${problem}; the App id was not saved`);
  };
  placed();
  if (readLocalAppId(repoFull, home).id === id) return { file, saved: false };
  const owner = dirname(file);
  mkdirSync(owner, { recursive: true, mode: 0o700 });
  placed();
  const temp = join(owner, `.${basename(file)}.${process.pid}.tmp`);
  rmSync(temp, { force: true });
  try {
    const fd = openSync(temp, "wx", 0o644);
    try {
      writeSync(fd, `${JSON.stringify({ appId: id })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o644);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return { file, saved: true };
}

/** The line that sets the variable, as every message that asks for it names it. */
export const appIdSetLine = (repoFull) => `gh variable set ${APP_ID_VARIABLE} --repo ${repoFull} --body <the App's numeric id, shown on its settings page>`;
/** How a variable that gave no id is said: `unset`, set to no App id (`notId`), or `forbidden`. */
export const appIdWhyText = (v) => (v.from === "forbidden" ? "could not be read" : v.notId ? "is no App id (a number)" : "is not set");

/**
 * The repository variable PENDULUM_APP_ID, read with `token`; when GitHub refuses that token (403) or says it is not
 * there (404, also what a token without Variables: read may get) and `fallback()` gives another token (the gh login's,
 * github.mjs ghLoginToken), read once more with that. `take()` comes before each read, `plan()` before the second (the
 * report's call budget). Returns {id, from, notId}: `from` is `variable` (read with `token`), `variable-gh` (with the
 * fallback's), or why there is no id: `unset` (a 404 to the last token that read it, or a value that is no App id:
 * `notId`) or `forbidden` (403 to the last token that read it). The first read's rate limit or other failure throws; the
 * second's never does (a refused gh login, its rate limit: said through `log`, and the first read's reason stands),
 * unless `isStop(e)` (the call budget's stop), which is thrown with `appFirst`, the first read's reason.
 */
export async function readAppIdVariable(repo, { token, fallback = null, take = () => {}, plan = () => {}, isStop = () => false, log = () => {} } = {}) {
  const once = async (t) => {
    take();
    try {
      const v = await rest(`repos/${repo.full}/actions/variables/${APP_ID_VARIABLE}`, { token: t });
      const id = appIdOf(v?.value);
      return id === null ? { id: null, from: "unset", notId: true } : { id, from: "variable" };
    } catch (e) {
      if (!e?.rateLimited && e?.status === 404) return { id: null, from: "unset" };
      if (!e?.rateLimited && e?.status === 403) return { id: null, from: "forbidden" };
      throw e;
    }
  };
  const first = await once(token);
  if (first.id !== null || first.notId) return first;
  const other = fallback ? fallback() : null;
  if (!other || other === token) return first;
  try {
    plan();
    const second = await once(other);
    return second.id !== null ? { id: second.id, from: "variable-gh" } : second;
  } catch (e) {
    if (isStop(e)) throw Object.assign(e, { appFirst: first.from });
    log(`the gh login's read of the repository variable ${APP_ID_VARIABLE} failed (${e?.status ? `HTTP ${e.status}${e.rateLimited ? ", rate limited" : ""}` : String(e?.message || e).slice(0, 80)}); the first read's answer stands`);
    return first;
  }
}

/**
 * Local mode's serve and doctor: Pendulum's App id from the repository variable, and its local copy saved or brought up
 * to date for `pendulum report`. `listed`: the variables as already read ({vars} or {refused: status}, github.mjs
 * repositoryVariables), so a list that holds it costs no call; a refused list reads the one variable with the gh login's
 * token (`fallback`), unless that is `token` itself, which was refused. Returns {id, from, notId, file, copy, saved,
 * problem}: `from` as readAppIdVariable's (`variable`, `variable-gh`, `unset`, `forbidden`), `copy` the local copy's id
 * when the variable gave none, and `problem` the copy's place refused (appIdPlaceProblem) or its save's failure. Throws
 * what the gh login's read throws.
 */
export async function learnAppId(repo, { listed, token = null, fallback = ghLoginToken, home = homedir() } = {}) {
  const copy = readLocalAppId(repo.full, home);
  let v;
  if (listed?.vars) {
    const id = appIdOf(listed.vars[APP_ID_VARIABLE]);
    v = id !== null ? { id, from: "variable" } : { id: null, from: "unset", notId: Object.hasOwn(listed.vars, APP_ID_VARIABLE) };
  } else {
    const t = fallback?.() ?? null;
    v = t && t !== token ? await readAppIdVariable(repo, { token: t }).then((r) => (r.from === "variable" ? { ...r, from: "variable-gh" } : r)) : { id: null, from: "forbidden" };
  }
  if (v.id === null) return { ...v, file: copy.file, copy: copy.id, saved: false, problem: copy.problem ?? null };
  try {
    const { file, saved } = saveLocalAppId(repo.full, v.id, home);
    return { ...v, file, saved, problem: null };
  } catch (e) {
    return { ...v, file: copy.file, saved: false, problem: String(e?.message || e) };
  }
}
