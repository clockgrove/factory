// GitHub's status adapter (docs/ADAPTERS.md): whether GitHub reports an incident on the parts of it Factory's requests
// use, from its public status page (githubstatus.com, an Atlassian Statuspage: its v2 JSON API, no key, no SDK). Asked
// by `factory serve` for an Objective paused on GitHub answering 5xx past the client's retries (local.mjs resume).
// `GITHUB_STATUS_URL` sets the page's base URL, as `GITHUB_API_URL` does GitHub's API, so a test points it at a fake.
import { causeCode } from "../network.mjs";

/** The status page's components Factory's requests go through: its REST and GraphQL calls on issues and pull requests. */
export const GITHUB_COMPONENTS = Object.freeze(["API Requests", "Issues", "Pull Requests"]);

/** The status page's base URL. */
export const statusBase = (env = process.env) => (env.GITHUB_STATUS_URL || "https://www.githubstatus.com").replace(/\/+$/, "");

/**
 * GitHub's status for GITHUB_COMPONENTS, read from `components.json`: {state, components: [{name, status}], error?}.
 * `state` is `degraded` when any of them has a status other than `operational` (Statuspage's `degraded_performance`,
 * `partial_outage`, `major_outage`, `under_maintenance`), `operational` when all three are, and null when the page
 * cannot say: no answer, an answer that is no JSON, or one that lacks any of them; `error` then names why (`HTTP 503`,
 * a connect-level code, `no answer`, `invalid`, `missing <name>`). Never throws.
 */
export async function githubStatus({ env = process.env, timeoutMs = 10_000 } = {}) {
  let body;
  try {
    const r = await fetch(`${statusBase(env)}/api/v2/components.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      await r.body?.cancel?.().catch(() => {});
      return { state: null, components: [], error: `HTTP ${r.status}` };
    }
    body = await r.json();
  } catch (e) {
    return { state: null, components: [], error: e instanceof SyntaxError ? "invalid" : causeCode(e) || "no answer" };
  }
  const all = Array.isArray(body?.components) ? body.components : null;
  if (!all) return { state: null, components: [], error: "invalid" };
  const components = [];
  for (const name of GITHUB_COMPONENTS) {
    const c = all.find((x) => x?.name === name && typeof x.status === "string");
    if (!c) return { state: null, components, error: `missing ${name}` };
    components.push({ name, status: c.status });
  }
  return { state: components.every((c) => c.status === "operational") ? "operational" : "degraded", components };
}
