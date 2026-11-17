// GitHub's status adapter (docs/ADAPTERS.md): whether GitHub reports an incident on the parts of it Pendulum's requests
// use, from its public status page (githubstatus.com, an Atlassian Statuspage: its v2 JSON API, no key, no SDK). Asked
// by `pendulum serve` for an Objective paused on GitHub answering 5xx past the client's retries (local.mjs resume).
// `GITHUB_STATUS_URL` sets the page's base URL, as `GITHUB_API_URL` does GitHub's API, so a test points it at a fake.
import { causeCode, githubOrigin } from "../network.mjs";

/** The status page's components Pendulum's requests go through: its REST and GraphQL calls on issues and pull requests. */
export const GITHUB_COMPONENTS = Object.freeze(["API Requests", "Issues", "Pull Requests"]);

/** GitHub.com's API origin: the one host githubstatus.com speaks for. */
const GITHUB_COM_API = "https://api.github.com";

/**
 * The status page's base URL: `GITHUB_STATUS_URL`, else githubstatus.com when Pendulum talks to GitHub.com; else null
 * (GitHub Enterprise Server or GHE.com, whose status githubstatus.com does not report).
 */
export const statusBase = (env = process.env) => {
  if (env.GITHUB_STATUS_URL) return env.GITHUB_STATUS_URL.replace(/\/+$/, "");
  return githubOrigin(env) === GITHUB_COM_API ? "https://www.githubstatus.com" : null;
};

/**
 * GitHub's status, read from the page's `summary.json`: {state, components: [{name, status}], incidents, maintenances,
 * error?}. `state` is `degraded` when any of GITHUB_COMPONENTS has a status other than `operational` (Statuspage's
 * `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`), when the page lists an unresolved
 * incident (its `incidents`, any status but `resolved` and `postmortem`) that affects one of them or names no
 * components (one with no `components` list counts, and says so), or when a scheduled maintenance is
 * `in_progress`; `operational` when none of that holds; null when the page cannot say. `incidents` and `maintenances`
 * are the names of those counted (for the log). With `state` null, `error` is the reason as a code: `no page` (no status
 * page speaks for this GitHub host), `HTTP 503`, a connect-level code, `no answer`, `invalid` (no JSON, or no
 * components list), or `missing <name>` (a component of GITHUB_COMPONENTS the page no longer lists: Pendulum's contract
 * with the page broke). Never throws.
 */
export async function githubStatus({ env = process.env, timeoutMs = 10_000 } = {}) {
  const none = (error, components = []) => ({ state: null, components, incidents: [], maintenances: [], error });
  const base = statusBase(env);
  if (!base) return none("no page");
  let body;
  try {
    const r = await fetch(`${base}/api/v2/summary.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      await r.body?.cancel?.().catch(() => {});
      return none(`HTTP ${r.status}`);
    }
    body = await r.json();
  } catch (e) {
    return none(e instanceof SyntaxError ? "invalid" : causeCode(e) || "no answer");
  }
  const all = Array.isArray(body?.components) ? body.components : null;
  if (!all) return none("invalid");
  const components = [];
  for (const name of GITHUB_COMPONENTS) {
    const c = all.find((x) => x?.name === name && typeof x.status === "string");
    if (!c) return none(`missing ${name}`, components);
    components.push({ name, status: c.status });
  }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  // An unresolved incident counts when it names one of GITHUB_COMPONENTS among the components it affects, or names
  // none (GitHub's own scope unknown); one that names only others (Copilot, Pages) does not. An incident with no
  // `components` list at all is counted, and marked so in its name for the log.
  const ours = (i) => !Array.isArray(i.components) || !i.components.length || i.components.some((c) => GITHUB_COMPONENTS.includes(c?.name));
  const incidents = list(body.incidents)
    .filter((i) => !["resolved", "postmortem"].includes(i.status) && ours(i))
    .map((i) => `${String(i.name ?? i.id ?? "an incident")}${Array.isArray(i.components) ? "" : " (it lists no components, so it counts whatever it affects)"}`);
  const maintenances = list(body.scheduled_maintenances).filter((m) => m.status === "in_progress").map((m) => String(m.name ?? m.id ?? "a maintenance"));
  const degraded = components.some((c) => c.status !== "operational") || incidents.length > 0 || maintenances.length > 0;
  return { state: degraded ? "degraded" : "operational", components, incidents, maintenances };
}
