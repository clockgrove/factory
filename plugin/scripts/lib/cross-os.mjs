// Cross-OS CI (`cross_os_workflow`, `cross_os_checks`, `cross_os_wait_minutes`): an opt-in part of the work stage's
// validation. The repository names one of its CI workflows and the check names of that workflow's macOS and Windows
// legs; on each head the work stage validates, Pendulum dispatches the workflow on the branch (`workflow_dispatch`, the
// head it just pushed) and waits, within the bound, for those legs, read as any required check is (session.mjs
// validationLoop). A red leg goes to the fix pass like any validation red. The same mechanism serves every route: CI on
// the pushed branch, since neither a local machine nor a cloud sandbox runs macOS or Windows itself. Pendulum never infers
// a leg from a job's name: only the names the repository lists count. Off by default, since macOS and Windows runner
// minutes bill at a higher rate than Linux ones.
import { backend } from "./backend.mjs";
import { githubNow, rest } from "./github.mjs";
import { parseYaml, workflowEvents, writeGrants } from "./yaml.mjs";

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
 * Why `doc` (the named workflow, parsed) cannot be dispatched for the legs, or null: no `workflow_dispatch` trigger, or a
 * token that can write. A dispatched run runs the branch tip's copy of the workflow on the branch's code, so a
 * `permissions:` that grants write (any scope at `write`, `write-all`, or any value but `read`, `none`, `read-all` and
 * `{}`; yaml.mjs writeGrants), at the top or on a job, would hand the branch's code a token that writes; the problem
 * names each grant. Unset permissions take the repository's default workflow token, which doctor's own row requires
 * to be read-only.
 */
export function workflowProblem(doc, workflow) {
  if (!workflowEvents(doc).includes("workflow_dispatch")) return `.github/workflows/${workflow} has no workflow_dispatch trigger, so Pendulum cannot run it on a branch`;
  const top = writeGrants(doc?.permissions) || [];
  const writes = [...(top.length ? [`its top-level permissions: ${top.join(", ")}`] : []), ...Object.entries(doc?.jobs || {}).flatMap(([name, job]) => {
    const g = writeGrants(job?.permissions) || [];
    return g.length ? [`job ${name}: ${g.join(", ")}`] : [];
  })];
  if (writes.length) return `.github/workflows/${workflow} grants write (${writes.join("; ")}), and a dispatched run would run the branch's code with that token`;
  return null;
}

/** Whether `w` (a workflow run) is a dispatched run of `workflow` on `sha` that was not cancelled. */
const dispatchedRun = (w, workflow, sha) => w?.event === "workflow_dispatch" && String(w.path || "").replace(/@.*$/, "") === `.github/workflows/${workflow}` && w.head_sha === sha && !(w.status === "completed" && w.conclusion === "cancelled");
/** A check run's suite, as GitHub returns it or as awaitChecks shapes it. */
const suiteOf = (r) => r?.check_suite?.id ?? r?.suite ?? null;
/** Conclusions a required check counts as passing that a cross-OS leg does not: the leg did not run. */
const NOT_RUN = ["skipped", "neutral"];

/**
 * The checks the cross-OS loop waits for (session.mjs validationLoop's `checks`): the legs, read with `token` (the
 * check runs) and `actionsToken` (the workflow file, its runs, the jobs, a rerun, the dispatch), and these hooks:
 * - `request(sha)`, before the wait on a head: the named workflow as `sha` has it must pass workflowProblem; a dispatched,
 *   not cancelled run of it on `sha` is reused; else the workflow is dispatched on `branch`, asking for the run's details
 *   (`return_run_details`: GitHub then answers 200 with the run's id, which must be on `sha`; an answer without one, 204,
 *   leaves the run to be found on `sha`, created at or after the dispatch). {ok},
 *   or {refused: {reason, cause}}.
 * - `select(sha, checkRuns)`: only the check runs of that workflow run's check suites count (a rerun's suite included),
 *   so a check of the same name from another workflow or event on the head never stands for a leg.
 * - `runOf(sha)`: that run as last read, or null.
 * - `verdict(sha, runs)`: on a head whose legs all finished passing as a required check would, a leg that was skipped or
 *   neutral did not run: {reason, cause} for a Block (the work's when another job of the run failed, as a `needs:`
 *   failure skips a leg; else setup), or null.
 * - `resultLine(sha, runs)` (legsLine), `boundMs` (the wait on one head) and `boundText`.
 */
export function crossOsChecks({ setting, repo, issue, prNumber, branch, token, actionsToken = token, stall, route = crossOsRoute(), now = githubNow }) {
  const { workflow } = setting;
  const actions = { token: actionsToken };
  // Per head: the run ({id, suites, since, run}), once requested.
  const heads = new Map();
  const etags = new Map();
  const listRuns = async (sha) => ((await rest(`repos/${repo.full}/actions/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`, { ...actions, cache: etags })) || {}).workflow_runs || [];
  const newest = (runs) => runs.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || b.id - a.id)[0] || null;
  const track = (h, run) => {
    h.id = run.id;
    h.run = run;
    if (run.check_suite_id) h.suites.add(run.check_suite_id);
  };
  // The head's run as GitHub has it now: found by id, else among the head's dispatched runs made since the dispatch.
  const locate = async (sha) => {
    const h = heads.get(sha);
    if (!h) return null;
    if (h.id) {
      const run = await rest(`repos/${repo.full}/actions/runs/${h.id}`, { ...actions, cache: etags }).catch(() => null);
      if (run?.id === h.id) track(h, run);
      // Cancelled, and a newer dispatched run of the workflow on this head replaced it (a re-dispatch, the workflow's own
      // concurrency group): that run's legs count from then on, beside the cancelled one's (the wait reads a cancel a newer
      // run replaced as not finished: github.mjs supersededRun).
      if (run?.status === "completed" && run.conclusion === "cancelled") {
        const next = newest((await listRuns(sha).catch(() => [])).filter((w) => dispatchedRun(w, workflow, sha) && w.id !== run.id && String(w.created_at || "") >= String(run.created_at || "")));
        if (next) track(h, next);
      }
    } else {
      const run = newest((await listRuns(sha).catch(() => [])).filter((w) => dispatchedRun(w, workflow, sha) && Date.parse(w.created_at) >= h.since));
      if (run) track(h, run);
    }
    return h;
  };
  const refused = (reason, cause = "setup") => ({ refused: { reason: `cross-OS CI: ${reason}`, cause } });
  return {
    repo,
    issue,
    prNumber,
    names: setting.checks,
    token,
    actionsToken,
    stall,
    what: "cross-OS legs",
    workflow,
    boundMs: setting.waitMs,
    boundText: `the cross-OS wait on this head reached its bound, ${Math.round(setting.waitMs / 60_000)} min (cross_os_wait_minutes)`,
    request: async (sha) => {
      if (heads.has(sha)) return { ok: true, again: true };
      // The copy of the workflow a dispatched run on this head runs.
      let doc;
      try {
        doc = parseYaml(String(await rest(`repos/${repo.full}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${sha}`, { token: actionsToken, raw: "Accept: application/vnd.github.raw+json" })));
      } catch (e) {
        return e.status === 404 ? refused(`no workflow .github/workflows/${workflow} on ${sha.slice(0, 7)}; fix cross_os_workflow, then re-apply the label`) : refused(`.github/workflows/${workflow} could not be read on ${sha.slice(0, 7)}: ${String(e.message || e).slice(0, 160)}`, e.status === 403 ? "setup" : "outage");
      }
      const problem = workflowProblem(doc, workflow);
      if (problem) return refused(`${problem}; fix the workflow, then re-apply the label`);
      const h = { id: null, run: null, suites: new Set(), since: 0 };
      // A run dispatched on this head already (a stage that ended while it waited, a second loop on the head), reused.
      const before = newest((await listRuns(sha).catch(() => [])).filter((w) => dispatchedRun(w, workflow, sha)));
      if (before) {
        track(h, before);
        heads.set(sha, h);
        return { ok: true, reused: before.id };
      }
      h.since = Math.floor(now() / 1000) * 1000;
      let made;
      try {
        made = await rest(`repos/${repo.full}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ...actions, method: "POST", body: { ref: branch, return_run_details: true } });
      } catch (e) {
        return { refused: dispatchRefusal(e, { workflow, branch, route }) };
      }
      heads.set(sha, h);
      const id = Number(made?.workflow_run_id);
      if (Number.isSafeInteger(id) && id > 0) {
        h.id = id;
        // The run GitHub made must be on the head Pendulum pushed: the branch moved meanwhile, it is not.
        const run = await rest(`repos/${repo.full}/actions/runs/${id}`, actions).catch(() => null);
        if (run?.head_sha && run.head_sha !== sha) {
          heads.delete(sha);
          return refused(`the run GitHub made (${id}) is on ${String(run.head_sha).slice(0, 7)}, not on ${sha.slice(0, 7)}: ${branch} moved; re-apply the label`, "pendulum");
        }
        if (run?.id === id) track(h, run);
      }
      return { ok: true, dispatched: h.id };
    },
    select: async (sha, runs) => {
      const h = await locate(sha);
      return h?.suites.size ? runs.filter((r) => h.suites.has(suiteOf(r))) : [];
    },
    runOf: (sha) => heads.get(sha)?.run ?? null,
    verdict: (sha, runs) => {
      const legs = setting.checks.map((n) => ({ n, r: runs.filter((r) => r.name === n).sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")) || (b.id ?? 0) - (a.id ?? 0))[0] }));
      const skipped = legs.filter((l) => NOT_RUN.includes(l.r?.conclusion));
      if (!skipped.length) return null;
      const failed = runs.filter((r) => r.status === "completed" && !["success", ...NOT_RUN].includes(r.conclusion) && !setting.checks.includes(r.name));
      const what = skipped.map((l) => `${l.n} ${l.r.conclusion}`).join("; ");
      return failed.length
        ? { reason: `cross-OS CI: ${what} on ${sha.slice(0, 7)}, so ${skipped.length > 1 ? "they" : "it"} did not run: the run's job ${failed.map((r) => `${r.name} ended ${r.conclusion}`).join(", ")} first; read that job on GitHub, fix the branch, then re-apply the label`, cause: "work" }
        : { reason: `cross-OS CI: ${what} on ${sha.slice(0, 7)}, so ${skipped.length > 1 ? "they" : "it"} did not run; run the leg on workflow_dispatch in ${workflow}, then re-apply the label`, cause: "setup" };
    },
    resultLine: (sha, runs) => legsLine({ workflow, names: setting.checks, sha, runs }),
  };
}
