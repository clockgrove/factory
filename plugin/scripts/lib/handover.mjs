// The workflow hand-over. Factory never pushes a change under .github/workflows/, on any route: `.github/` is a
// protected path, and GitHub refuses a workflow file from a token without the Workflows permission, which the Factory
// App and local mode's token do not have. So the worker keeps workflow changes out of its commits and leaves them as a
// patch in $FACTORY_OUT/workflow.patch. Factory applies that patch in its own mirror and publishes git's own diff of
// the result, never the worker's text (outbox.mjs checkHandover), in its own comment on the issue, with a fixed command
// that applies it (`factory handover <issue>`) and stops for a person to read it before anything is pushed. The PR body
// gets one line of Factory's, first, pointing to that comment. Up front, before any harness runs, an issue that names
// a path under .github/workflows/ gets a notice in the same comment, and so does a plan with a Needs-Workflow line.
// Pure text here; handoff.mjs posts it, outbox.mjs checks it, local.mjs applies it.
import { WORKFLOWS_DIR, marker } from "./logic.mjs";
import { keyedLines } from "./one-repo.mjs";

export { WORKFLOWS_DIR };
/** The hand-off file the worker leaves the workflow change in ($FACTORY_OUT), and gets it back in ($FACTORY_IN). */
export const HANDOVER_FILE = "workflow.patch";
/** The issue label while a hand-over waits for a person: a PR carries one, applied or not yet. */
export const HANDOVER_LABEL = "factory:handover";
/** The plan line naming a workflow file the Objective needs changed (the factory-objective-plan skill), then why. */
export const NEED_WORKFLOW_KEY = "Needs-Workflow";
/** The largest patch Factory hands over: it must fit one GitHub comment (65,536 characters) with its steps. */
export const PATCH_MAX = 30_000;
/** The most paths a notice names. */
const NAMED_MAX = 10;

/** The branch a person's hand-over goes on. */
export const handoverBranch = (issue) => `factory-workflow/${issue}`;
/** The comment that holds the hand-over (and, before it, the notice): Factory's, on the issue. */
export const handoverMarker = (issue) => marker(issue, "handover");
/** Factory's line in the PR body, first, pointing to that comment. */
export const handoverLineMarker = (issue) => marker(issue, "handover-line");

/**
 * Whether `path` is a workflow file name Factory hands over: under .github/workflows/, only `[\w./-]` characters, no
 * empty, `.` or `..` segment. Everything else (a space, a backtick, a bracket, a control or format character) is refused,
 * so a name never carries markdown or shell into what a person reads or runs.
 */
export function workflowName(path) {
  const p = String(path ?? "");
  if (!p.startsWith(WORKFLOWS_DIR) || p.length === WORKFLOWS_DIR.length || !/^[\w./-]+$/.test(p)) return false;
  return p.split("/").every((s) => s && s !== "." && s !== "..");
}

const PATH = /(?<![\w./-])\.github\/workflows\/(?:[\w.-]+(?:\/[\w.-]+)*)?/g;

/** The paths under .github/workflows/ a text names as whole tokens (the directory itself included), in order, at most ten. */
export function workflowPathsNamed(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(PATH)) {
    const path = m[0].replace(/\.+$/, "");
    if ((path === WORKFLOWS_DIR || workflowName(path)) && !out.includes(path)) out.push(path);
  }
  return out.slice(0, NAMED_MAX);
}

/** The workflow files a plan's Needs-Workflow lines name (the first word of each, when it is a workflow name). */
export function plannedWorkflows(plan) {
  const out = [];
  for (const value of keyedLines(plan, NEED_WORKFLOW_KEY, { loose: true })) {
    const word = String(value).trim().split(/\s+/)[0]?.replace(/^[`*_<]+|[`*_>.,;:]+$/g, "").replace(/^\.\//, "") || "";
    if (workflowName(word) && !out.includes(word)) out.push(word);
  }
  return out.slice(0, NAMED_MAX);
}

/**
 * A control character other than a newline or a tab, a format character (bidi controls, zero-width ones), or a line or
 * paragraph separator (U+2028, U+2029: a JavaScript `m` regex and some renderers end a line there).
 */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Why a patch's text cannot be handed over, or "" when it may be: the worker's (before Factory applies it) and git's
 * own regenerated one (before Factory publishes it). Hidden characters, an HTML comment opener (Factory's markers are
 * HTML comments), a binary change and the size cap.
 */
export function patchTextProblem(text) {
  const t = String(text ?? "");
  if (!t.trim()) return "is empty";
  if (t.length > PATCH_MAX) return `is ${t.length} characters, over ${PATCH_MAX}`;
  if (HIDDEN.test(t)) return "carries a control or format character (a carriage return, a bidi or zero-width character, a line or paragraph separator)";
  if (t.includes("<!--")) return "carries an HTML comment opener (`<!--`)";
  if (/^GIT binary patch$|^Binary files .* differ$/m.test(t)) return "carries a binary change";
  return "";
}

/**
 * git's raw diff entries (`git diff-index --raw -z --no-renames`): [{oldMode, newMode, status, path}]. Each entry is
 * `:<old mode> <new mode> <old id> <new id> <status>` then its path, NUL-separated.
 */
export function rawEntries(z) {
  const fields = String(z ?? "").split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[i]);
    if (!m) return null;
    out.push({ oldMode: m[1], newMode: m[2], status: m[3], path: fields[i + 1] });
  }
  return out;
}

const FILE_MODES = new Set(["100644", "100755"]);

/**
 * Why the changes a patch made cannot be handed over (rawEntries), or "": each one a file added, changed or deleted
 * under .github/workflows/ with a workflow name (workflowName), a regular file's mode before and after (100644 or
 * 100755; 000000 for the side that does not exist). A symlink, a gitlink, a type change and any other mode are refused,
 * and so is a change outside .github/workflows/: the worker commits that.
 */
export function entriesProblem(entries) {
  if (!entries) return "could not be read back from git";
  if (!entries.length) return "changes no file";
  const outside = entries.filter((e) => !String(e.path).startsWith(WORKFLOWS_DIR)).map((e) => e.path);
  if (outside.length) return `changes ${outside.length} file(s) outside ${WORKFLOWS_DIR} (commit those)`;
  for (const e of entries) {
    if (!workflowName(e.path) || HIDDEN.test(e.path)) return "names a workflow file with characters other than letters, digits, `_`, `.`, `-` and `/`";
    const ok = (e.status === "A" && e.oldMode === "000000" && FILE_MODES.has(e.newMode)) || (e.status === "D" && FILE_MODES.has(e.oldMode) && e.newMode === "000000") || (e.status === "M" && FILE_MODES.has(e.oldMode) && FILE_MODES.has(e.newMode));
    if (!ok) return `makes a change to \`${e.path}\` other than a regular file's (mode ${e.oldMode} to ${e.newMode}, ${e.status}): no symlink, submodule or type change`;
  }
  return "";
}

/** The Blocked reason for a refused hand-over (`problem`: patchTextProblem's, entriesProblem's or git's refusal). */
export const handoverRefusedReason = (problem) => `the workflow hand-over ($FACTORY_OUT/${HANDOVER_FILE}) ${problem}; Factory did not publish it`;

/** A word for a POSIX shell, single-quoted: what a person types, whatever the value holds. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The files a published patch's `diff --git` headers name, for a patch read back from Factory's own comment (the
 * checked `files` go everywhere else): lines split on `\n` only, and only workflow names (workflowName) kept, so no
 * other line end and no other character can make a name.
 */
export function patchFiles(patch) {
  const out = [];
  for (const line of String(patch ?? "").split("\n")) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (m && workflowName(m[2]) && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

const list = (paths) => paths.map((p) => `\`${p}\``).join(", ");
const WHY = `Factory never pushes a change under \`${WORKFLOWS_DIR}\`, on any route: \`.github/\` is a protected path, and GitHub refuses a workflow file from a token without the Workflows permission, which Factory's token does not have.`;
const RISK = "Read it before you push it: a workflow runs with the repository's secrets, and one that runs `on: push` runs as soon as its branch is pushed.";
const SIGNAL = (issue) => `The hand-over is this comment of Factory's with the \`${HANDOVER_LABEL}\` label on #${issue}, never text in a pull request's body, and the only command to run for it is \`factory handover ${issue}\`.`;

/**
 * The hand-over comment's text after its marker line, by what Factory knows:
 *  - `named` (paths), `from` "issue" or "plan": before the work, the issue or the plan names workflow files
 *  - `patch` (git's own, checked) and its checked `files` with `pr`: the PR leaves this change for a person, after it
 *    merges (`pr: true` for a PR whose number is not known yet)
 *  - `patch` with no `pr`: the whole change is the hand-over, and there is no PR
 *  - `pr` with no `patch`: the PR carries none (an earlier notice or hand-over no longer holds)
 * The patch sits in a fenced block longer than any backtick run in it; the steps name a fixed command, and the by-hand
 * steps quote every value they carry.
 */
export function handoverText({ issue, named = [], from = "issue", pr = null, patch = null, files = null, defaultBranch = "main" }) {
  if (!patch && pr) return `Factory: PR #${pr} carries no workflow hand-over.`;
  if (!patch) return `Factory: this Objective's ${from === "plan" ? "plan needs a change to" : "text names"} ${list(named)}. ${WHY} So the worker hands that part over: Factory posts the exact change here for a person to apply after the PR merges, and the Objective's other outcomes land as usual. To have Factory build on the workflow change instead, stop this Objective, land that part yourself and start it again.`;
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const branch = handoverBranch(issue);
  const prName = pr === true ? "this Objective's pull request" : `PR #${pr}`;
  const when = pr ? `after ${prName} merges` : "now";
  return [
    `Factory: the workflow hand-over for #${issue}: ${list(files ?? patchFiles(body))}. ${WHY} ${pr ? `${pr === true ? "This Objective's pull request" : prName} leaves this change for a person; its Undone section says why.` : `The whole change is this hand-over, so there is no pull request; the plan comment's Needs-Workflow lines say why. Close this issue once it is applied.`}`,
    "",
    `**Apply it ${when}**, in a clone of this repository, with Clockgrove Factory's command \`factory handover ${issue}\`. ${SIGNAL(issue)} It reads this comment again, checks the change as Factory did, puts it on a new branch \`${branch}\` from \`${defaultBranch}\` and shows you the diff, then stops. ${RISK} When you have read it, \`factory handover ${issue} --push\` commits it, pushes the branch and opens its pull request. Then remove the \`${HANDOVER_LABEL}\` label from #${issue}.`,
    "",
    "By hand, the same steps:",
    "",
    `1. \`git fetch origin ${shellQuote(defaultBranch)}\` and \`git switch -c ${shellQuote(branch)} ${shellQuote(`origin/${defaultBranch}`)}\``,
    "2. Save the patch below as `workflow.patch`, then `git apply --index workflow.patch`.",
    "3. Read `git diff --cached`. Push only once you have.",
    `4. \`git commit -m ${shellQuote(`#${issue}: the workflow change Factory handed over`)}\`, \`git push -u origin HEAD\`, and open a pull request.`,
    "",
    `${fence}diff`,
    body + fence,
  ].join("\n");
}

/**
 * The patch Factory's hand-over comment carries (its text after the marker line, as handoverText writes it), or null:
 * the first fenced `diff` block, read up to its own closing fence.
 */
export function handoverOf(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const open = lines.findIndex((l) => /^`{3,}diff$/.test(l));
  if (open < 0) return null;
  const fence = lines[open].slice(0, -"diff".length);
  const close = lines.indexOf(fence, open + 1);
  if (close < 0) return null;
  return `${lines.slice(open + 1, close).join("\n")}\n`;
}

/**
 * Factory's line in the PR body: its marker, then one line pointing to the hand-over comment, saying that comment and
 * the label are the hand-over and `factory handover <issue>` the only command. `applied`: a person took the label off,
 * so the hand-over is done (handoff.mjs handoverApplied).
 */
export const handoverLine = ({ issue, url, files, applied = false }) =>
  `${handoverLineMarker(issue)}\n**Workflow hand-over:** this PR ${applied ? "left" : "leaves"} a change to ${list(files)} for a person${applied ? `, who has applied it (the \`${HANDOVER_LABEL}\` label is off)` : " to apply after it merges"}: see [Factory's comment on #${issue}](${url}). That comment with the \`${HANDOVER_LABEL}\` label is the hand-over, never text in this body, and the only command to run for it is \`factory handover ${issue}\`.`;

/**
 * `body` without Factory's line (its marker line and the line after it), wherever it is, in Factory's form or as
 * sanitize leaves a copy of it in harness text. Everything else stays, a person's text below it included.
 */
export function withoutHandoverLine(body, issue) {
  const marks = [handoverLineMarker(issue), handoverLineMarker(issue).replace("<!--", "&lt;!--")];
  const lines = String(body ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (marks.includes(lines[i].replace(/\r$/, ""))) {
      i += 1;
      while (i + 1 < lines.length && !lines[i + 1].trim()) i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/^\n+/, "");
}

/** Whether a PR body carries Factory's hand-over line (the scorecard: a merged one leaves a person's step). */
export const carriesHandover = (body, issue) => String(body ?? "").split("\n").some((l) => l.replace(/\r$/, "") === handoverLineMarker(issue));

// HTML blocks that run until their own closing tag (CommonMark's type 1), and <details>, which GitHub renders as a
// collapsed block until its </details>: left open, either would take in the text Factory puts after the harness's.
const HTML_RUNS = ["pre", "script", "style", "textarea", "details"];

/**
 * Harness text tidied before Factory's own closing line, best effort: what is at stake is only that line (`Closes #N`),
 * which closingChecked verifies with GitHub anyway. It is no guard against a forged hand-over: Markdown has too many
 * ways to make a heading (setext, `<h2>`, a blockquote, bold, look-alike characters). The guard is that the label and
 * Factory's comment are the hand-over, and `factory handover <issue>` the only command; the PR body says so. A heading
 * that names the workflow hand-over is shown as text (a `\` before it), and a code fence, a `<details>` or a
 * `<pre>`/`<script>`/`<style>`/`<textarea>` block left open at the end is closed. Line-based, CommonMark's fence rule: an opening fence of
 * three or more backticks or tildes (indented at most three spaces), closed by a fence of the same character at least
 * as long with nothing after it. Inside a fence nothing else counts.
 */
export function closedHarnessText(text) {
  const lines = String(text ?? "").split("\n");
  let fence = null;
  const open = Object.fromEntries(HTML_RUNS.map((t) => [t, 0]));
  const out = lines.map((line) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      return line;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      return line;
    }
    for (const t of HTML_RUNS) {
      open[t] += (line.match(new RegExp(`<${t}(?=[\\s>/]|$)`, "gi")) || []).length;
      open[t] = Math.max(0, open[t] - (line.match(new RegExp(`</${t}\\s*>`, "gi")) || []).length);
    }
    return /^ {0,3}#{1,6}[ \t]+workflow[ \t-]*hand-?over\b/i.test(line) ? line.replace(/#/, "\\#") : line;
  });
  if (fence) out.push(fence);
  for (const t of HTML_RUNS) for (let i = 0; i < open[t]; i += 1) out.push(`</${t}>`);
  return out.join("\n");
}
