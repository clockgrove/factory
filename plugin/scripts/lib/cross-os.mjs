// Cross-OS CI (`cross_os_workflow`, `cross_os_checks`, `cross_os_wait_minutes`): an opt-in part of the work stage's
// validation. The repository names one of its CI workflows and the check names of that workflow's macOS and Windows
// legs; on each head the work stage validates, Pendulum dispatches the workflow on the branch (`workflow_dispatch`, the
// head it just pushed) and waits, within the bound, for those legs, read as any required check is (session.mjs
// validationLoop). A red leg goes to the fix pass like any validation red. The same mechanism serves every route: CI on
// the pushed branch, since neither a local machine nor a cloud sandbox runs macOS or Windows itself. Pendulum never infers
// a leg from a job's name: only the names the repository lists count. Off by default, since macOS and Windows runner
// minutes bill at a higher rate than Linux ones. A cloud sandbox stage holds only the App's token, which has no Actions
// write: it asks its launcher job to dispatch the run (launcherRelay, stage.mjs, launch.mjs relayCrossOs), as it asks
// for fresh tokens, and the launcher dispatches exactly the configured workflow on the stage's own branch and head with
// its job token (launcherDispatch), then hands the run's id back.
import { backend } from "./backend.mjs";
import { githubNow, rest } from "./github.mjs";
import { BLOCK_CAUSES } from "./logic.mjs";
import { grantsWrite, parseYaml, workflowEvents } from "./yaml.mjs";

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

/**
 * Where this stage runs: `local`, `sandbox` (a cloud sandbox stage, whose launcher dispatches the run) or `actions`;
 * it also names a refused dispatch's fix.
 */
export const crossOsRoute = (env = process.env) => (backend(env).name === "local" ? "local" : env.PENDULUM_STAGE_SANDBOX === "1" ? "sandbox" : "actions");

/**
 * A refused workflow dispatch (`e`, rest's error) as the stage's Block: {reason, cause}. A 403 is the token's missing
 * Actions write (on the sandbox route the launcher's job token: launcherDispatch); a 404 no such workflow file on the
 * default branch; a 422 GitHub's refusal of the dispatch itself (a workflow with no `workflow_dispatch` trigger); any of
 * them a setup gap. A throttled call is the provider's quota; anything else (5xx, the network) an outage.
 */
export function dispatchRefusal(e, { workflow, branch, route = "actions" }) {
  const status = e?.status ?? null;
  const head = `cross-OS CI: GitHub refused to run ${workflow} on ${branch}${status ? ` (${status})` : ""}`;
  if (e?.rateLimited) return { reason: `${head}: rate limited; re-apply the label once the limit resets`, cause: "provider-quota" };
  if (status === 403) {
    const fix = route === "sandbox" ? "the launcher dispatches it for a cloud sandbox stage with its job token: give the workflow's launch-event job `actions: write`" : route === "local" ? "give the repository token Actions read and write" : "give the workflow's work job `actions: write`";
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
 * `permissions:` that grants write (contents, pull-requests, issues or actions; yaml.mjs grantsWrite), at the top or on a
 * job, would hand the branch's code a token that writes. Unset permissions take the repository's default workflow token,
 * which doctor's own row requires to be read-only.
 */
export function workflowProblem(doc, workflow) {
  if (!workflowEvents(doc).includes("workflow_dispatch")) return `.github/workflows/${workflow} has no workflow_dispatch trigger, so Pendulum cannot run it on a branch`;
  const writes = [...(grantsWrite(doc?.permissions) === true ? ["its top-level permissions"] : []), ...Object.entries(doc?.jobs || {}).filter(([, job]) => grantsWrite(job?.permissions) === true).map(([name]) => `job ${name}`)];
  if (writes.length) return `.github/workflows/${workflow} grants write (${writes.join(", ")}), and a dispatched run would run the branch's code with that token`;
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
 *   leaves the run to be found on `sha`, created at or after the dispatch). On the sandbox route `relay` (launcherRelay)
 *   asks the launcher for all of that (launcherDispatch) and takes the run's id and check suite from its answer. {ok},
 *   or {refused: {reason, cause}}.
 * - `select(sha, checkRuns)`: only the check runs of that workflow run's check suites count (a rerun's suite included),
 *   so a check of the same name from another workflow or event on the head never stands for a leg.
 * - `runOf(sha)`: that run as last read, or null.
 * - `verdict(sha, runs)`: on a head whose legs all finished passing as a required check would, a leg that was skipped or
 *   neutral did not run: {reason, cause} for a Block (the work's when another job of the run failed, as a `needs:`
 *   failure skips a leg; else setup), or null.
 * - `resultLine(sha, runs)` (legsLine), `boundMs` (the wait on one head) and `boundText`.
 */
export function crossOsChecks({ setting, repo, issue, prNumber, branch, token, actionsToken = token, stall, route = crossOsRoute(), relay = route === "sandbox" ? launcherRelay() : null, now = githubNow }) {
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
      // A cloud sandbox stage: its launcher dispatches the run (or reuses one on the head) and names it.
      if (route === "sandbox") {
        h.since = Math.floor(now() / 1000) * 1000;
        const a = relay ? await relay({ workflow, ref: branch, sha, boundMs: setting.waitMs }) : null;
        if (!a) return refused(`the stage has no channel to its launcher, which dispatches the run for a cloud sandbox stage; re-apply the label`, "pendulum");
        if (a.timedOut) return refused(`the launcher did not answer the stage's request to run ${workflow} on ${sha.slice(0, 7)} within ${Math.round(setting.waitMs / 60_000)} min (cross_os_wait_minutes); check the workflow's launch jobs run, then re-apply the label`, "outage");
        if (a.refused) return { refused: a.refused };
        heads.set(sha, h);
        if (a.run) {
          h.id = a.run;
          // The run as the launcher read it: its id, head and check suite, so its legs count without an Actions read here.
          h.run = { id: a.run, head_sha: sha, check_suite_id: a.suite };
          if (a.suite) h.suites.add(a.suite);
        }
        return { ok: true, [a.reused ? "reused" : "dispatched"]: h.id, via: "launcher" };
      }
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

// ------------------------------------------------------------------ the sandbox route: the launcher dispatches
// The stage (worker.mjs, a child of stage.mjs) asks over its IPC channel; stage.mjs sends the ask as a repository
// dispatch (`pendulum-stage`, `want: cross-os`); the launcher (launch.mjs relayCrossOs) runs launcherDispatch with its
// job token and hands the answer to stage.mjs over its socket (stage.mjs --deliver), which passes it on to the child.

const SHA = /^[0-9a-f]{40}$/;
const id = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
/** How long the stage waits for its launcher's answer before it asks again: a pending launch can be replaced (ADAPTERS.md). */
export const RELAY_RETRY_MS = 5 * 60_000;

/**
 * What the stage asks its launcher for, from the child's IPC message `m` ({type: "pendulum-cross-os-ask", workflow,
 * ref, sha, ask}): the dispatch's extra client-payload fields, or null when `m` is not one. Only plain shapes pass; the
 * launcher decides whether the workflow and the ref are the ones it may dispatch.
 */
export function crossOsAsk(m) {
  if (m?.type !== "pendulum-cross-os-ask" || !SHA.test(String(m.sha)) || !id(m.ask)) return null;
  const plain = (v, n) => (typeof v === "string" && v.length <= n ? v : "");
  return { ask: m.ask, sha: m.sha, workflow: plain(m.workflow, 200), ref: plain(m.ref, 255) };
}

/**
 * The launcher's answer as the stage takes it (`a`, from the socket): {sha, run, suite, reused} with the run's id and
 * check suite (either null when the launcher could not name them), or {sha, refused: {reason, cause}}; null when `a` is
 * not one.
 */
export function crossOsAnswer(a) {
  if (!a || typeof a !== "object" || !SHA.test(String(a.sha))) return null;
  if (a.refused) {
    const reason = typeof a.refused.reason === "string" && a.refused.reason ? a.refused.reason.slice(0, 600) : "cross-OS CI: the launcher refused the dispatch";
    return { sha: a.sha, refused: { reason, cause: Object.hasOwn(BLOCK_CAUSES, a.refused.cause) ? a.refused.cause : "pendulum" } };
  }
  return { sha: a.sha, run: id(a.run), suite: id(a.suite), reused: a.reused === true };
}

/**
 * The stage's side of the relay: `relay({workflow, ref, sha, boundMs})` sends the ask to stage.mjs over `send` (the
 * IPC channel) and resolves with the launcher's answer for `sha` (crossOsAnswer), asking again every `retryMs` until
 * `boundMs` has passed, then {timedOut: true}. Each ask names itself (`ask`, ms), so the launcher answers each once.
 * Null without a channel.
 */
export function launcherRelay({ send = typeof process.send === "function" ? process.send.bind(process) : null, on = process, retryMs = RELAY_RETRY_MS, clock = Date.now } = {}) {
  if (!send) return null;
  return ({ workflow, ref, sha, boundMs }) =>
    new Promise((resolve) => {
      const started = clock();
      let timer = null;
      let last = 0;
      const done = (v) => {
        clearTimeout(timer);
        on.removeListener("message", listen);
        resolve(v);
      };
      function listen(m) {
        if (m?.type !== "pendulum-cross-os") return;
        const a = crossOsAnswer(m);
        if (a?.sha === sha) done(a);
      }
      const ask = () => {
        if (clock() - started >= boundMs) return done({ timedOut: true });
        last = Math.max(clock(), last + 1);
        try {
          send({ type: "pendulum-cross-os-ask", workflow, ref, sha, ask: last });
        } catch {
          // The channel closed: the next ask, or the bound, ends the wait.
        }
        timer = setTimeout(ask, Math.min(retryMs, Math.max(1, started + boundMs - clock())));
      };
      on.on("message", listen);
      ask();
    });
}

/**
 * The launcher's dispatch for a sandbox stage of Objective `issue` that asked (`ask`: {workflow, ref, sha}): the answer
 * crossOsAnswer reads. Only the configured workflow (crossOs(inputs)) on the stage's own branch `pendulum/<issue>`, and
 * only while that branch is at `sha`: anything else is refused, and what is dispatched is the launcher's own setting and
 * branch name, never the ask's. The workflow as `sha` has it must pass workflowProblem. A dispatched, not cancelled run
 * of it on `sha` is reused; else it is dispatched with `actionsToken` (the launch job's token, Actions write), the run
 * GitHub names checked to be on `sha`, or found on `sha` (`tries` reads, `pauseMs` apart) when GitHub names none.
 * `token` (the App's) reads the branch and the workflow file.
 */
export async function launcherDispatch({ inputs, repo, issue, ask = {}, token, actionsToken, now = githubNow, tries = 3, pauseMs = 5000 }) {
  const sha = SHA.test(String(ask.sha)) ? ask.sha : null;
  const branch = `pendulum/${issue}`;
  const no = (reason, cause = "pendulum") => ({ sha: sha ?? "0".repeat(40), refused: { reason: `cross-OS CI: ${reason}`, cause } });
  const { setting } = crossOs(inputs);
  if (!setting) return no("the launcher's settings have cross-OS CI off (cross_os_workflow, cross_os_checks), so it dispatches nothing; set both in the workflow's env block, then re-apply the label", "setup");
  const { workflow } = setting;
  if (ask.workflow !== workflow) return no(`the stage asked the launcher for another workflow than ${workflow} (cross_os_workflow), the only one it dispatches; re-apply the label`);
  if (ask.ref !== branch) return no(`the stage asked the launcher for another ref than its branch ${branch}, the only one it dispatches on; re-apply the label`);
  if (!sha) return no(`the stage asked the launcher with no head; re-apply the label`);
  if (!actionsToken) return no(`the launch job has no token of its own (github_token) to dispatch ${workflow} with; give the workflow's launch-event job \`actions: write\`, then re-apply the label`, "setup");
  const actions = { token: actionsToken };
  const head = await rest(`repos/${repo.full}/git/ref/heads/${branch}`, { token }).then((r) => r?.object?.sha ?? null, () => null);
  if (head !== sha) return no(`${branch} is ${head ? `at ${head.slice(0, 7)}` : "not readable"}, not at ${sha.slice(0, 7)}, the head the stage asked for: the branch moved; re-apply the label`);
  let doc;
  try {
    doc = parseYaml(String(await rest(`repos/${repo.full}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${sha}`, { token, raw: "Accept: application/vnd.github.raw+json" })));
  } catch (e) {
    return e.status === 404 ? no(`no workflow .github/workflows/${workflow} on ${sha.slice(0, 7)}; fix cross_os_workflow, then re-apply the label`, "setup") : no(`.github/workflows/${workflow} could not be read on ${sha.slice(0, 7)} (${e.status ?? "error"})`, e.status === 403 ? "setup" : "outage");
  }
  const problem = workflowProblem(doc, workflow);
  if (problem) return no(`${problem}; fix the workflow, then re-apply the label`, "setup");
  const listRuns = async () => ((await rest(`repos/${repo.full}/actions/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`, actions)) || {}).workflow_runs || [];
  const newest = (runs) => runs.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || b.id - a.id)[0] || null;
  // A run dispatched on this head already (an earlier ask whose answer was lost, a second launcher): reused.
  const before = newest((await listRuns().catch(() => [])).filter((w) => dispatchedRun(w, workflow, sha)));
  if (before) return { sha, run: before.id, suite: id(before.check_suite_id), reused: true };
  const since = Math.floor(now() / 1000) * 1000;
  let made;
  try {
    made = await rest(`repos/${repo.full}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ...actions, method: "POST", body: { ref: branch, return_run_details: true } });
  } catch (e) {
    return { sha, refused: dispatchRefusal(e, { workflow, branch, route: "sandbox" }) };
  }
  const runId = id(Number(made?.workflow_run_id));
  if (runId) {
    const run = await rest(`repos/${repo.full}/actions/runs/${runId}`, actions).catch(() => null);
    if (run?.head_sha && run.head_sha !== sha) return no(`the run GitHub made (${runId}) is on ${String(run.head_sha).slice(0, 7)}, not on ${sha.slice(0, 7)}: ${branch} moved; re-apply the label`);
    return { sha, run: runId, suite: id(run?.check_suite_id) };
  }
  // GitHub named no run (204): the head's dispatched run made since the dispatch, read a few times while GitHub makes it.
  for (let i = 0; i < tries; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const run = newest((await listRuns().catch(() => [])).filter((w) => dispatchedRun(w, workflow, sha) && Date.parse(w.created_at) >= since));
    if (run) return { sha, run: run.id, suite: id(run.check_suite_id) };
  }
  return { sha, run: null, suite: null };
}
