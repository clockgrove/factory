// Preloaded into the Factory controller by scripts/live-check.mjs with
// `node --import`. Test harness only: no Factory code imports it.
//
// - Appends one NDJSON line per GitHub REST/GraphQL request to LIVE_CHECK_LOG
//   (method, path, status, duration, rate-limit headers; the response body of a
//   4xx/5xx and of every GraphQL response, so the log is private: its dir is 0700).
// - LIVE_CHECK_KILL = {"method","repo","path" (regex source),"nth"}: once the nth
//   matching request (under /repos/REPO/) has a successful (2xx/3xx) response, and
//   before Factory sees it, SIGKILL this process group. GitHub applied the
//   effect; the controller never learned the outcome (a lost response plus a
//   crash). A 4xx/5xx applied nothing, so it is not counted as the kill point.
//
// It acts only in the process live-check.mjs started (LIVE_CHECK_PARENT is the
// harness pid), so a forked child that inherits the environment is untouched.
import { appendFileSync } from "node:fs";

const active = process.ppid === Number(process.env.LIVE_CHECK_PARENT);
const logPath = process.env.LIVE_CHECK_LOG;
const kill = process.env.LIVE_CHECK_KILL
  ? JSON.parse(process.env.LIVE_CHECK_KILL)
  : undefined;
let seen = 0;

/** Whether this response is a request the kill point names (and GitHub applied). */
export function killMatches(kill, method, pathname, ok) {
  return Boolean(
    kill &&
      ok &&
      method === kill.method &&
      pathname.toLowerCase().startsWith(`/repos/${kill.repo}/`.toLowerCase()) &&
      new RegExp(kill.path).test(pathname),
  );
}

function write(entry) {
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
    );
}

if (active) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.github.com") return original(input, init);
    const method = (init.method ?? input.method ?? "GET").toUpperCase();
    const path = url.pathname + url.search;
    const started = Date.now();
    let response;
    try {
      response = await original(input, init);
    } catch (error) {
      write({ method, path, error: String(error?.cause ?? error) });
      throw error;
    }
    const entry = {
      method,
      path,
      status: response.status,
      ms: Date.now() - started,
      remaining: response.headers.get("x-ratelimit-remaining"),
      retryAfter: response.headers.get("retry-after"),
    };
    if (response.status >= 400 || path.startsWith("/graphql"))
      entry.body = (await response.clone().text()).slice(0, 600);
    write(entry);
    if (
      killMatches(kill, method, url.pathname, response.ok) &&
      ++seen === kill.nth
    ) {
      write({ kill: `${method} ${url.pathname}`, status: response.status });
      // The harness starts this process as its group's leader. Never let a
      // failed group kill reach Factory as a fetch error: die regardless.
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {}
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return response;
  };
}
