// Cross-OS CI (`cross_os_workflow`, `cross_os_checks`, `cross_os_wait_minutes`): an opt-in part of the work stage's
// validation. The repository names one of its CI workflows and the check names of that workflow's macOS and Windows
// legs; on each head the work stage validates, Pendulum dispatches the workflow on the branch (`workflow_dispatch`, the
// head it just pushed) and waits, within the bound, for those legs, read as any required check is (session.mjs
// validationLoop). A red leg goes to the fix pass like any validation red. The same mechanism serves every route: CI on
// the pushed branch, since neither a local machine nor a cloud sandbox runs macOS or Windows itself. Pendulum never infers
// a leg from a job's name: only the names the repository lists count. Off by default, since macOS and Windows runner
// minutes bill at a higher rate than Linux ones.
import { backend } from "./backend.mjs";
import { rest } from "./github.mjs";

/** A workflow file in .github/workflows, by its file name: what GitHub's workflow dispatch takes. */
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;

/**
 * The setting from resolved inputs (inputs.mjs resolveInputs): `setting` {workflow, checks, waitMs} when it is on, null
 * when off; `problem`, why a setting that is half set or names no workflow file cannot run (the stage Blocks on it as a
 * setup gap, and doctor FAILs). `workflow` may be given as `.github/workflows/<file>`.
 */
export function crossOs(inputs = {}) {
  const given = String(inputs.crossOsWorkflow || "").trim();
  const checks = [...new Set((inputs.crossOsChecks || []).map((c) => String(c).trim()).filter(Boolean))];
  if (!given && !checks.length) return { setting: null, problem: null };
  if (!given) return { setting: null, problem: "cross_os_checks names the cross-OS legs, but cross_os_workflow, the workflow that runs them, is empty; set both, or neither to turn cross-OS CI off" };
  if (!checks.length) return { setting: null, problem: `cross_os_workflow names ${given}, but cross_os_checks, the legs that count, is empty; Pendulum never infers them from job names: list each leg's check name, one per line` };
  const workflow = given.replace(/^\.github\/workflows\//, "");
  if (!WORKFLOW_FILE.test(workflow)) return { setting: null, problem: `cross_os_workflow ${JSON.stringify(given)} is no workflow file name in .github/workflows (such as ci.yml)` };
  return { setting: { workflow, checks, waitMs: inputs.crossOsWaitMs }, problem: null };
}

/** Where this stage runs, for a refused dispatch's fix: `local`, `sandbox` (a cloud sandbox stage) or `actions`. */
export const crossOsRoute = (env = process.env) => (backend(env).name === "local" ? "local" : env.PENDULUM_STAGE_SANDBOX === "1" ? "sandbox" : "actions");

/**
 * A refused workflow dispatch (`e`, rest's error) as the stage's Block: {reason, cause}. A 403 is the token's missing
 * Actions write (the cloud sandbox's App token has none, and Pendulum's App does not ask for it); a 404 no such workflow
 * file on the default branch; a 422 GitHub's refusal of the dispatch itself (a workflow with no `workflow_dispatch`
 * trigger); any of them a setup gap. A throttled call is the provider's quota; anything else (5xx, the network) an outage.
 */
export function dispatchRefusal(e, { workflow, branch, route = "actions" }) {
  const status = e?.status ?? null;
  const head = `cross-OS CI: GitHub refused to run ${workflow} on ${branch}${status ? ` (${status})` : ""}`;
  if (e?.rateLimited) return { reason: `${head}: rate limited; re-apply the label once the limit resets`, cause: "provider-quota" };
  if (status === 403) {
    const fix = route === "sandbox" ? "a cloud sandbox stage holds the App's token, which has no Actions write, and Pendulum's App does not ask for one: run this repository's Objectives on Actions or locally, or turn cross-OS CI off (empty cross_os_workflow)" : route === "local" ? "give the repository token Actions read and write" : "give the workflow's work job `actions: write`";
    return { reason: `${head}: the token cannot dispatch a workflow (Actions write); ${fix}, then re-apply the label`, cause: "setup" };
  }
  if (status === 404) return { reason: `${head}: no workflow .github/workflows/${workflow} on the default branch; fix cross_os_workflow, then re-apply the label`, cause: "setup" };
  if (status === 422) return { reason: `${head}: ${String(e?.message || "").replace(/^.*?failed \(422\): /, "").slice(0, 200)}; give the workflow a \`workflow_dispatch:\` trigger, then re-apply the label`, cause: "setup" };
  return { reason: `${head}: ${String(e?.message || e).slice(0, 200)}`, cause: "outage" };
}

/**
 * The latest check run of each leg in `runs` (session.mjs's run shape: name, status, conclusion), as one progress line
 * naming each leg's result: its conclusion when completed, else its status, else `not reported`.
 */
export function legsLine({ workflow, names, sha, runs = [] }) {
  const latest = (n) => runs.filter((r) => r.name === n).sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")) || (b.id ?? 0) - (a.id ?? 0))[0];
  const each = names.map((n) => {
    const r = latest(n);
    return `${n}: ${!r ? "not reported" : r.status === "completed" ? r.conclusion || "completed" : r.status || "pending"}`;
  });
  return `cross-OS CI (${workflow}) on ${String(sha).slice(0, 7)}: ${each.join("; ")}`;
}

/**
 * The checks the cross-OS loop waits for (session.mjs validationLoop's `checks`): the legs, read with `token` (the
 * check runs) and `actionsToken` (the jobs, a rerun, the dispatch), and three hooks. `request(sha)` dispatches
 * `workflow` on `branch` once per head (the head Pendulum just pushed): {ok}, or {refused: {reason, cause}}.
 * `resultLine(sha, runs)` is legsLine. `boundMs` bounds each wait on a head, and `boundText` says it in the Block.
 */
export function crossOsChecks({ setting, repo, issue, prNumber, branch, token, actionsToken = token, stall, route = crossOsRoute() }) {
  const asked = new Set();
  return {
    repo,
    issue,
    prNumber,
    names: setting.checks,
    token,
    actionsToken,
    stall,
    what: "cross-OS legs",
    workflow: setting.workflow,
    boundMs: setting.waitMs,
    boundText: `the cross-OS wait reached its bound, ${Math.round(setting.waitMs / 60_000)} min (cross_os_wait_minutes)`,
    request: async (sha) => {
      if (asked.has(sha)) return { ok: true, again: true };
      try {
        await rest(`repos/${repo.full}/actions/workflows/${encodeURIComponent(setting.workflow)}/dispatches`, { token: actionsToken, method: "POST", body: { ref: branch } });
      } catch (e) {
        return { refused: dispatchRefusal(e, { workflow: setting.workflow, branch, route }) };
      }
      asked.add(sha);
      return { ok: true };
    },
    resultLine: (sha, runs) => legsLine({ workflow: setting.workflow, names: setting.checks, sha, runs }),
  };
}
