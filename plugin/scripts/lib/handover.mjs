// The workflow hand-over. Factory never pushes a change under .github/workflows/, on any route: `.github/` is a
// protected path, and GitHub refuses a workflow file from a token without the Workflows permission, which the Factory
// App and local mode's token do not have. So the worker keeps workflow changes out of its commits and leaves them as a
// patch in $FACTORY_OUT/workflow.patch, the reason in its PR body; Factory checks the patch in its mirror, puts it in
// the PR body as one command a person runs after the merge, labels the issue factory:handover and says so on the issue.
// Up front, before any harness runs, an issue that names a path under .github/workflows/ gets the same notice, and so
// does a plan with a Needs-Workflow line as soon as the harness writes it. Pure text here; handoff.mjs posts it.
import { WORKFLOWS_DIR, marker } from "./logic.mjs";
import { keyedLines } from "./one-repo.mjs";

export { WORKFLOWS_DIR };
/** The hand-off file the worker leaves the workflow change in ($FACTORY_OUT), and gets it back in ($FACTORY_IN). */
export const HANDOVER_FILE = "workflow.patch";
/** The issue label while a hand-over waits for a person: a PR carries one, applied or not yet. */
export const HANDOVER_LABEL = "factory:handover";
/** The plan line naming a workflow file the Objective needs changed (the factory-objective-plan skill), then why. */
export const NEED_WORKFLOW_KEY = "Needs-Workflow";
/** The largest patch Factory hands over: with the worker's PR body it must fit GitHub's 65,536-character body. */
export const PATCH_MAX = 30_000;
/** The heredoc's end line in the command a person runs; a patch with this line is refused. */
const END = "WORKFLOW_PATCH_END";
/** The most paths a notice names. */
const NAMED_MAX = 10;

const PATH = /(?<![\w./-])\.github\/workflows\/(?:[\w.-]+(?:\/[\w.-]+)*)?/g;

/** The paths under .github/workflows/ a text names as whole tokens (the directory itself included), in order, at most ten. */
export function workflowPathsNamed(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(PATH)) {
    const path = m[0].replace(/\.+$/, "");
    if (!out.includes(path)) out.push(path);
  }
  return out.slice(0, NAMED_MAX);
}

/** The workflow files a plan's Needs-Workflow lines name (the first word of each, when it is a path under .github/workflows/). */
export function plannedWorkflows(plan) {
  const out = [];
  for (const value of keyedLines(plan, NEED_WORKFLOW_KEY, { loose: true })) {
    const word = String(value).trim().split(/\s+/)[0]?.replace(/^[`*_<]+|[`*_>.,;:]+$/g, "").replace(/^\.\//, "") || "";
    if (word.startsWith(WORKFLOWS_DIR) && !out.includes(word)) out.push(word);
  }
  return out.slice(0, NAMED_MAX);
}

/** The files a patch's `diff --git` headers name (the new side), in order: what a person reads before running it. */
export function patchFiles(patch) {
  const out = [];
  for (const m of String(patch ?? "").matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/**
 * Why Factory cannot hand `patch` over, or "" when it can. `files`: every path git's own reading of the patch names
 * (outbox.mjs handover: `git apply --numstat`), `binary` when it carries a binary change. The patch is git's own diff:
 * it starts with a `diff --git` header, changes only files under .github/workflows/, no symlink or submodule, no binary,
 * fits PATCH_MAX, and carries nothing the PR body would read as Factory's (an HTML comment opener) or that ends the
 * command early (the heredoc's end line).
 */
export function handoverProblem(patch, { files = [], binary = false } = {}) {
  const text = String(patch ?? "");
  if (!/^diff --git /.test(text)) return "is not a git diff (it must start with a `diff --git` line: `git diff` makes it)";
  if (text.length > PATCH_MAX) return `is ${text.length} characters, over ${PATCH_MAX}`;
  if (text.includes("\r")) return "carries carriage returns";
  if (text.includes("<!--")) return "carries an HTML comment opener (`<!--`), which Factory never publishes from a worker";
  if (text.split("\n").includes(END)) return `carries the line ${END}`;
  if (/^(?:new file|deleted file|old|new) mode 1[26]0000$/m.test(text)) return "makes or changes a symlink or a submodule";
  if (binary || /^GIT binary patch$/m.test(text)) return "carries a binary change";
  if (!files.length) return "changes no file";
  const outside = files.filter((f) => !f.startsWith(WORKFLOWS_DIR));
  if (outside.length) return `changes ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""} outside ${WORKFLOWS_DIR}; commit those`;
  return "";
}

/** The Blocked reason for a refused hand-over (handoverProblem's `problem`). */
export const handoverRefusedReason = (problem) => `the workflow hand-over ($FACTORY_OUT/${HANDOVER_FILE}) ${problem}; Factory did not publish it`;

const list = (paths) => paths.map((p) => `\`${p}\``).join(", ");

/**
 * The section Factory puts in the PR body (or, with no PR, on the issue): the files, and one command that applies the
 * patch on a new branch from the default branch after the PR merges and opens a pull request for it. Its first line is
 * Factory's marker, which harness text can never carry (handoff.mjs sanitize). The fence is longer than any backtick
 * run in the patch; the heredoc's end is quoted, so the shell expands nothing in it.
 */
export function handoverSection({ issue, patch, defaultBranch, pr = true }) {
  const body = String(patch).endsWith("\n") ? String(patch) : `${patch}\n`;
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const branch = `factory-workflow/${issue}`;
  const command = `git fetch origin ${defaultBranch} && git switch -c ${branch} origin/${defaultBranch} && git apply --index <<'${END}' && git commit -m "#${issue}: the workflow change Factory handed over" && git push -u origin HEAD && gh pr create --fill`;
  return [
    marker(issue, "handover"),
    "## Workflow hand-over",
    "",
    `Factory never pushes a change under \`${WORKFLOWS_DIR}\`, so a person applies this part: ${list(patchFiles(body))}. ${pr ? "Why is under Undone above. After this PR merges" : "The plan comment's Needs-Workflow lines say why. Now"}, run this in a clone of the repository: it applies the change on a new branch \`${branch}\` from \`${defaultBranch}\` and opens a pull request for it. Then remove the \`${HANDOVER_LABEL}\` label from #${issue}.`,
    "",
    `${fence}sh`,
    command,
    body + END,
    fence,
  ].join("\n");
}

const MARK = (issue) => marker(issue, "handover");
// The marker as harness text carries it after sanitize (a worker's pr.md copied from the PR body).
const MARK_SANITIZED = (issue) => MARK(issue).replace("<!--", "&lt;!--");

/** The patch Factory's section in `body` hands over (handoverSection), or null when the body has none. */
export function handoverOf(body, issue) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const at = lines.indexOf(MARK(issue));
  if (at < 0) return null;
  const start = lines.findIndex((l, i) => i > at && l.includes(`<<'${END}' && `));
  if (start < 0) return null;
  const end = lines.indexOf(END, start + 1);
  if (end < 0) return null;
  return `${lines.slice(start + 1, end).join("\n")}\n`;
}

/** `body` without Factory's section, whether it is Factory's own or a copy in harness text: everything from its marker on. */
export function withoutHandover(body, issue) {
  const text = String(body ?? "");
  const cut = [MARK(issue), MARK_SANITIZED(issue)].map((m) => text.indexOf(m)).filter((i) => i >= 0);
  return cut.length ? text.slice(0, Math.min(...cut)).trimEnd() : text;
}

/**
 * The issue's hand-over notice (its marker comment), by what Factory knows:
 *  - `named` (paths), `from` "issue" or "plan": before the work, the issue or the plan names workflow files
 *  - `pr` and `patch`: the PR carries a hand-over
 *  - `patch` with no `pr`: the whole change is the hand-over; `section` is it, posted here
 *  - `pr` with no `patch`: the PR carries none (any earlier one is dropped)
 */
export function handoverNotice({ named = [], from = "issue", pr = null, patch = null, section = "" }) {
  const why = `Factory never pushes a change under \`${WORKFLOWS_DIR}\`, on any route: \`.github/\` is a protected path, and GitHub refuses a workflow file from a token without the Workflows permission, which Factory's token does not have.`;
  if (patch && pr) return `Factory: PR #${pr} carries a workflow hand-over for ${list(patchFiles(patch))}. ${why} After the PR merges, a person runs the command in its "Workflow hand-over" section, then removes the \`${HANDOVER_LABEL}\` label from this issue; until then the Objective is done with that step pending.`;
  if (patch) return `Factory: the whole change is a workflow hand-over, so there is no pull request. ${why} A person runs the command below, then removes the \`${HANDOVER_LABEL}\` label and closes this issue.\n\n${section}`;
  if (pr) return `Factory: PR #${pr} carries no workflow hand-over.`;
  return `Factory: this Objective's ${from === "plan" ? "plan needs a change to" : "text names"} ${list(named)}. ${why} So the worker hands that part over: the PR carries the exact patch and why, for a person to apply after it merges, and the Objective's other outcomes land as usual. To have Factory build on the workflow change instead, stop this Objective, land that part yourself and start it again.`;
}
