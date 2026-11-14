// One repository per Objective. An issue body that names another repository on a `Factory-Repository: OWNER/NAME`
// line, or a plan that needs a change in another repository (its `Needs-Repository: OWNER/NAME` line, the
// factory-objective-plan skill), is a Question at plan time: the owner splits the Objective into one Objective per repository
// and re-applies the label, or, for a plan's need, answers how to do the work in this repository alone. The body line
// is checked before any harness runs; the plan's line when the harness writes its plan, which stops it there.

/** The issue-body line that names a repository for the Objective to change. */
export const DECLARE_KEY = "Factory-Repository";
/** The plan line that names a repository the Objective needs a change in (the factory-objective-plan skill), then why. */
export const NEED_KEY = "Needs-Repository";

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const key = (full) => String(full).toLowerCase();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The values of every `KEY: value` line (any case for the key, a leading `- ` or `* ` allowed) outside fenced code.
 * `loose` (a plan line, the harness's own markdown) also takes a numbered item (`1. `), a task-list item (`- [ ] `), a
 * blockquote and a bold key. A plan's Needs-Workflow lines (handover.mjs) are read the same way.
 */
export function keyedLines(text, name, { loose = false } = {}) {
  const out = [];
  let fence = null;
  const at = loose ? new RegExp(`^(?:(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?|>\\s*)*(?:\\*\\*|__)?${name}(?:\\*\\*|__)?:(?:\\*\\*|__)?\\s*(.*)$`, "i") : new RegExp(`^(?:[-*]\\s+)?${name}:\\s*(.*)$`, "i");
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (f) {
      if (!fence) fence = f[0];
      else if (f[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = at.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** One word as OWNER/NAME, or "" when it is none: a placeholder, or an owner and a name of one character each (`N/A`). */
function repoWord(word) {
  const trim = (v) => v.replace(/[.,;:]+$/, "");
  let value = trim(String(word || "").trim());
  for (const [a, b] of [["`", "`"], ["**", "**"], ["__", "__"], ["<", ">"], ["`", "`"]]) if (value.length > a.length + b.length && value.startsWith(a) && value.endsWith(b)) value = trim(value.slice(a.length, -b.length).trim());
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)/i.exec(value);
  if (url) value = `${url[1]}/${url[2].replace(/\.git$/i, "")}`;
  value = trim(value.replace(/\/$/, ""));
  const [owner = "", name = ""] = value.split("/");
  return NAME.test(value) && !(owner.length === 1 && name.length === 1) ? value : "";
}

/**
 * The repositories a text's `name` lines name, outside fenced code: {repos: ["owner/name", ...], ignored: count}. The
 * first word of each line is the repository; it may be wrapped in backticks, bold or angle brackets, be a markdown link
 * (its text or, failing that, its target) or a github.com URL. Any other value is no repository, only counted (never
 * repeated: it is the author's or the harness's text): a placeholder such as `none`, `N/A`, `-` or `(dropped: ...)` is
 * how a plan says there is none.
 */
function namedRepos(text, name, opts) {
  const repos = [];
  let ignored = 0;
  for (const value of keyedLines(text, name, opts)) {
    const line = String(value).trim();
    const link = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/.exec(line);
    const repo = (link ? [link[1], link[2]] : [line.split(/\s+/)[0] || ""]).map(repoWord).find((v) => v) || "";
    if (!repo) ignored += 1;
    else if (!repos.some((r) => key(r) === key(repo))) repos.push(repo);
  }
  return { repos, ignored };
}

/** The repositories the plan says the Objective needs a change in (its Needs-Repository lines): {repos, ignored}. */
export const plannedRepos = (plan) => namedRepos(plan, NEED_KEY, { loose: true });

/** The repositories the issue body names on DECLARE_KEY lines, other than `source` (this repository): ["owner/name", ...]. */
export const declaredRepos = (body, source) => namedRepos(body, DECLARE_KEY).repos.filter((r) => !source || key(r) !== key(source.full));

const ONE_REPO = "Factory works in one repository per Objective";

/**
 * The Question for an issue body that names another repository (declaredRepos), or "": asked before any harness runs.
 * The owner splits the Objective, one per repository, takes the line out and re-applies `label`.
 */
export function declaredQuestion(body, { source, label = "factory:objective" }) {
  const repos = declaredRepos(body, source);
  if (!repos.length) return "";
  return `the issue names ${repos.join(", ")} on a ${DECLARE_KEY} line, and ${ONE_REPO}; split it into one Objective per repository (this one changes only ${source.full}), remove the line and re-apply ${label}`;
}

/**
 * The repositories a plan-time Question asked about that the owner has answered since: `asked` maps each (lower-cased)
 * to when Factory asked (logic.mjs planAskedOf, from its own progress comments); an answer is a maintainer decision
 * (objectiveDecisions, already checked for write access) made or edited after that time that names the repository. A
 * Set of lower-cased names. The plan line may stay (a harness that annotates it, or writes no plan.md on the rerun and
 * so keeps the plan comment's): the owner has decided, and Factory does not ask the same thing again. `named: false`
 * counts any decision since the ask, naming the repository or not: the mid-run stop's set (worker.mjs), so a rerun after
 * an answer runs on until the harness has re-planned with it, and the end of the run decides with the named set.
 */
export function answeredRepos(asked, decisions, { named = true } = {}) {
  const out = new Set();
  for (const [repo, at] of Object.entries(asked || {})) {
    const since = Date.parse(at);
    if (!NAME.test(repo) || !Number.isFinite(since)) continue;
    const names = new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(repo)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "i");
    if ((decisions || []).some((d) => Date.parse(d?.seen ?? d?.at) > since && (!named || names.test(String(d?.body ?? ""))))) out.add(key(repo));
  }
  return out;
}

/**
 * The plan-time Question, or {}: {reason, repos} when the plan (plannedRepos) needs a change in a repository other than
 * this one (`source`) that the owner has not answered about since it was asked (`answered`, answeredRepos). `reason` is
 * Factory's own one line, naming only values that are OWNER/NAME: Factory works in one repository per Objective, so the
 * owner splits the Objective, one per repository, and re-applies `label`, or answers in a comment how to do the work in
 * this repository alone. `repos` are the ones asked about, recorded so the answer is recognised on the rerun.
 */
export function planNeeds(plan, { source, label = "factory:objective", answered = new Set() }) {
  const missing = plannedRepos(plan).repos.filter((r) => key(r) !== key(source.full) && !answered.has(key(r)));
  if (!missing.length) return {};
  return { repos: missing, reason: `the plan needs a change in ${missing.join(", ")}, and ${ONE_REPO}; split it into one Objective per repository and re-apply ${label}, or answer in a comment how to do the work in ${source.full} alone` };
}
