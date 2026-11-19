// A local work stage that paused on its harness's usage limit continues where it stopped (#257): on the clone it left,
// kept in place (nothing is snapshotted), and in the same harness session where the harness can carry it. It continues
// only when nothing it was built on has changed since the pause: the branch on GitHub (its head, or its absence), the
// newest restart record, the Objective's Running stint and its text. The paused stage records all four in its
// result.json (`usageLimit.continue`); the next work stage on this machine (worker.mjs) is the one decider between
// continuing and starting fresh, and when it starts fresh it cleans the abandoned pass's untracked files itself. Review
// stages, fix passes and rebase send-backs never record a pause to continue: they start fresh, as every stage did.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { decisionsShown } from "./logic.mjs";

/** Why a fresh work stage Blocks (cause setup) when its clone's untracked leftovers could not be removed: no local path. */
export const CLEAN_REFUSED = "local mode: the untracked files an earlier stage left in the Objective's clone could not be removed, so the work stage does not run on them; the local loop's log has the error. Fix it on that machine, then resume through Draft.";

/** What a continued stage needs unchanged since its pause, by the key its record and the decision use. */
export const CONTINUE_GUARDS = { branch: "the branch on GitHub", restart: "the newest restart record", running: "the Objective's Running stint", text: "the Objective's text" };

/**
 * The login a harness runs on here, as a short hash of its state folder's real path (Claude Code's config folder, the
 * Codex home), so no path is recorded; null for a harness with no such folder (Copilot's home is Pendulum's own).
 */
export function loginOf(harness, env = process.env, home = homedir()) {
  const dir = harness === "claude" ? env.CLAUDE_CONFIG_DIR || join(home, ".claude") : harness === "codex" ? env.CODEX_HOME || join(home, ".codex") : null;
  if (!dir) return null;
  let real = resolve(dir);
  try {
    real = realpathSync(dir);
  } catch {
    // not made yet: its path as given
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/**
 * The pause's record (result.json `usageLimit.continue`), written only by a local work stage whose work pass met the
 * limit: the four guards as they stood at the pause, and the harness and login the session ran on. `branch` is the head
 * on GitHub the kept checkout builds on ("" when the branch did not exist), `restart` the newest restart record's time,
 * `running` when the Objective's Running stint began, `text` the Objective's text (objective-trust.mjs objectiveSha).
 */
export function pauseRecord({ branch, restart, running, text, harness, env = process.env }) {
  return { stage: "work", branch: branch || "", restart: restart ?? null, running: running ?? null, text: text ?? null, harness, login: loginOf(harness, env) };
}

/** A stage directory's start, from its name (local.mjs startStage: `usage-<stage>-<ISO time with - for : and .>`). */
const STAGE_DIR = /^usage-[a-z]+-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)$/;

/**
 * Whether a stage directory counts as a stage that may have changed the clone. Every one but a work stage's: any other
 * stage's start cleans the clone before its process runs (local.mjs startStage), so its directory counts from the
 * moment it exists. A work stage's start leaves the clone alone (its worker decides, enterStage), so its directory
 * counts once its process ran: its result.json, its process record (local.mjs STAGE_RECORD, left by a stage whose loop
 * was killed) or its log (local.mjs stageRelay: a worker logs before it touches the clone). A work directory with none
 * of them was made by a start that stopped before its process (a stopping serve): it changed nothing.
 */
const counts = (ws, name) => !name.startsWith("usage-work-") || ["result.json", "stage-process.json", "stage.log"].some((f) => lstatSync(join(ws, name, f), { throwIfNoEntry: false }));

/**
 * The newest stage of this Objective on this machine before the one in `own` (its usage directory) that counts,
 * from the stage directories in `ws`: {name, result} (result.json as written, or null for a stage that ended without
 * one), or null.
 */
export function lastStage(ws, own) {
  let names = [];
  try {
    names = readdirSync(ws);
  } catch {
    return null;
  }
  const mine = own ? basename(own) : null;
  const name = names
    .filter((n) => n !== mine && STAGE_DIR.test(n) && counts(ws, n))
    .sort((a, b) => (STAGE_DIR.exec(a)[1] < STAGE_DIR.exec(b)[1] ? 1 : -1))[0];
  if (!name) return null;
  let result = null;
  try {
    const f = join(ws, name, "result.json");
    if (lstatSync(f).isFile()) result = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    // no record: the stage ended without one
  }
  return { name, result };
}

/** The pause `last` recorded for a work stage to continue, or null. */
const pauseOf = (last) => {
  const p = last?.result?.exit === "paused" ? last.result.usageLimit?.continue : null;
  return p && typeof p === "object" && p.stage === "work" ? p : null;
};

/**
 * Whether the work stage continues the pause `last` recorded, given the guards as they stand now (`now`: branch,
 * restart, running, text, harness, login). {continue: true, from, pause, carry} when every guard is unchanged: `carry`
 * is "" when the harness session carries over, else why the stage runs a fresh session on the kept checkout. Claude
 * Code resumes its session under any config folder; Codex only on the login that wrote the thread (another login's
 * resume is refused); Copilot and another harness never. Otherwise {continue: false, from, changed, reason}: `changed`
 * the guards that moved, `reason` naming them; reason null when there was no pause to continue.
 */
export function continueDecision({ last, now }) {
  const pause = pauseOf(last);
  if (!pause) return { continue: false, from: null, changed: [], reason: null };
  const from = last.name;
  if (typeof pause.branch !== "string" || typeof pause.text !== "string" || !pause.text || typeof pause.running !== "string") return { continue: false, from, changed: [], reason: "the pause's record is incomplete" };
  const changed = Object.keys(CONTINUE_GUARDS).filter((k) => (pause[k] ?? null) !== (now[k] ?? null));
  if (changed.length) {
    const named = changed.map((k) => CONTINUE_GUARDS[k]);
    return { continue: false, from, changed, reason: `${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]} changed since the pause` };
  }
  const carry =
    pause.harness !== now.harness
      ? `the pause ran ${pause.harness}; this stage runs ${now.harness}`
      : now.harness === "claude"
        ? ""
        : now.harness === "codex"
          ? pause.login && pause.login === now.login
            ? ""
            : "another Codex login: a Codex thread never resumes under another login"
          : `${now.harness} starts a fresh session`;
  return { continue: true, from, pause, carry };
}

/**
 * Whether the kept checkout still holds the paused pass's work: on the Objective's branch, its head built on the branch
 * head the pause recorded. `git(args)` runs git in the checkout (in its sandbox) and returns {code, stdout}. "" when it
 * does, else why not.
 */
export async function checkoutHolds(git, branch, pause) {
  const on = await git(["symbolic-ref", "-q", "HEAD"]);
  if (on.code !== 0 || String(on.stdout).trim() !== `refs/heads/${branch}`) return "the checkout is no longer on the paused pass's branch";
  if (pause.branch && (await git(["merge-base", "--is-ancestor", pause.branch, "HEAD"])).code !== 0) return "the checkout no longer holds the branch head the paused pass built on";
  return "";
}

/**
 * The one decision a local work stage makes as it enters, before its checkout is put on the branch: continue the pause
 * the newest earlier stage recorded, or start fresh. `ws` the Objective's directory and `own` this stage's usage
 * directory; `now()` the guards as they stand (read only when there is a pause to weigh); `holds(pause)` checkoutHolds;
 * on every fresh entry `putOn()` (the checkout on the branch as GitHub has it: outbox.mjs putOn), then `clean()`, which
 * removes what an abandoned pass left untracked (lib/local.mjs prepareClone, fresh). In that order: a pass that ignored
 * its own files in a changed .gitignore has them cleaned once putOn has put the branch's .gitignore back. A failure of
 * either is the caller's to end the stage on. `restore(from)` puts the paused stage's session back (session.mjs
 * restoreTranscript) and returns {id, from, reason}. Returns continueDecision's answer, with `session` (restore's) when it
 * continues and the session carries.
 */
export async function enterStage({ ws, own, now, holds, putOn, clean, restore }) {
  const last = lastStage(ws, own);
  let d = { continue: false, from: null, changed: [], reason: null };
  if (pauseOf(last)) {
    let guards = null;
    try {
      guards = await now();
    } catch {
      guards = null;
    }
    d = guards ? continueDecision({ last, now: guards }) : { continue: false, from: last.name, changed: [], reason: "the guards could not be read" };
    if (d.continue) {
      const why = await holds(d.pause).catch(() => "the checkout could not be checked");
      if (why) d = { continue: false, from: last.name, changed: [], reason: why };
    }
  }
  if (!d.continue) {
    await putOn();
    await clean();
    return d;
  }
  if (d.carry) return d;
  const session = await restore(d.from).catch(() => ({ id: null, reason: "the saved session could not be put back" }));
  return { ...d, session, carry: session?.id ? "" : session?.reason || "no session was saved" };
}

/**
 * What a resumed session is told when its stage continues a pause: the checkout as it left it, and Pendulum's hand-off
 * folders, which are new for every stage (`dirs`: handoff.mjs handoffDirs), restated so a path it remembers is not used.
 */
export function continuePrompt(dirs, { note = "" } = {}) {
  return `Your previous run stopped at the provider's usage limit, which has now reset. Continue the same task from where it stopped, in the same checkout: your commits and uncommitted changes are as you left them. Do not redo finished steps. Pendulum's hand-off folders are new for this run and the earlier ones are gone: PENDULUM_IN is now ${dirs.in} and PENDULUM_OUT is now ${dirs.out}. $PENDULUM_IN/plan.md is your plan as Pendulum last saved it. Read $PENDULUM_IN/decisions.md again: it holds every maintainer decision, those made since you stopped included. Keep the current plan in $PENDULUM_OUT/plan.md, and write every other output the task card names (pr.md, exit.json) to the new $PENDULUM_OUT.${note ? ` ${note}` : ""}`;
}

/** The task card for a fresh session on a kept checkout (a continued stage whose session does not carry over). */
export function keptPrompt(prompt, { note = "" } = {}) {
  return `${prompt.trimEnd()}\n\n---\n\nAn earlier pass of this Objective stopped at the provider's usage limit before it finished. Its work is still in this checkout: its commits on the branch and its uncommitted changes. $PENDULUM_IN/plan.md is its plan as Pendulum last saved it. Continue from there; do not redo finished items.${note ? ` ${note}` : ""}`;
}

/**
 * What a failed install (checkout.mjs installDeps: {ok, reason}) means for a work stage: `block` with its reason, as for
 * any stage; but on a continued stage's kept checkout, whose pass may have stopped mid-way through a dependency change
 * (a manifest edited, its lockfile not yet), the pass goes on and is told (`note`), so it can finish that change,
 * unless a program the install runs is missing (`absent`), which no pass can fix. {} when the install succeeded.
 */
export function installEnd(result, { continued, command }) {
  if (result.ok) return {};
  // A program the install needs that is not there (installDeps `absent`) is setup's to bring, never the pass's.
  if (!continued || result.absent?.length) return { block: result.reason };
  return { note: `Pendulum's install (${command}) failed on this checkout, which keeps your unfinished changes: finish any dependency change, its lockfile included, and install before you validate.` };
}

/**
 * The maintainers' decisions a work pass is recorded as having read (logic.mjs decisionsRead), or null for none: a pass
 * given the whole task card reads those that fit it (decisionsShown); a continued session's resumed pass is told to read
 * $PENDULUM_IN/decisions.md, which holds every one (continuePrompt); a conflict pass is told only to rebase.
 */
export function decisionsFed({ decisions, full, continued, rebaseConflict }) {
  if (rebaseConflict) return null;
  if (full) return decisionsShown(decisions);
  return continued ? decisions || [] : null;
}
