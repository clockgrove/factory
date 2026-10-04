// Infrastructure retries for planning evals. A provider usage limit or a DNS
// outage says nothing about planning quality, so the eval backs off, resumes
// the same run and records every wait instead of scoring an error. Retries are
// bounded by a count and by the total time one run may wait.

/** The provider says the login's allowance is used up until a reset. */
const USAGE_LIMIT = /session limit|usage limit|hit your (?:\w+ )?limit/i;
/** HTTP-level throttling; only an error's own text is trusted to mean it. */
const THROTTLED = /rate.?limit|too many requests|\b429\b/i;
/** The host could not reach the provider: DNS, refused, unreachable, reset. */
const NETWORK =
  /Reconnecting\.\.\. \d+\/\d+|stream disconnected|failed to lookup address|workspace routing discovery failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|UND_ERR_CONNECT_TIMEOUT|getaddrinfo|Can't reach the API|Could not resolve host|fetch failed|socket hang up/i;

/**
 * Provider and process errors reach the eval as text, so this is the one place
 * that reads it. Anything else is a real error and is never retried.
 */
export function infrastructureKind(text, { error = true } = {}) {
  if (typeof text !== "string") return null;
  if (USAGE_LIMIT.test(text) || (error && THROTTLED.test(text)))
    return "usage-limit";
  if (NETWORK.test(text)) return "network";
  return null;
}

/** Wait before retry number `retry` (1 is the first): doubles up to a cap. */
export function backoffMs(kind, retry, policy) {
  const base =
    policy.baseSeconds !== undefined
      ? policy.baseSeconds * 1000
      : kind === "usage-limit"
        ? 15 * 60_000
        : 30_000;
  const cap =
    policy.baseSeconds !== undefined
      ? base * 8
      : kind === "usage-limit"
        ? 60 * 60_000
        : 5 * 60_000;
  return Math.min(base * 2 ** (retry - 1), cap);
}

/**
 * One pause shared by every lane: a usage limit or an outage hits all of them,
 * so the first lane to see it holds the rest until it passes.
 */
export function createGate({
  now = () => Date.now(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  let until = 0;
  const gate = {
    /** Total time every lane was held, counting overlapping pauses once. */
    pausedMs: 0,
    pause(ms) {
      const start = Math.max(until, now());
      const end = now() + ms;
      if (end > start) {
        gate.pausedMs += end - start;
        until = end;
      }
    },
    async ready() {
      for (let left = until - now(); left > 0; left = until - now())
        await sleep(left);
    },
  };
  return gate;
}

/**
 * Run `attempt` until `failureOf(result)` stops reporting an infrastructure
 * failure, a retry limit is reached, or the run has waited `maxWaitMs`. Returns
 * `{ result, retries, exhausted }`; each retry names the failure and the wait.
 */
export async function withRetries(
  attempt,
  { failureOf, gate, maxRetries, maxWaitMs, baseSeconds, onRetry },
) {
  const retries = [];
  let waited = 0;
  for (;;) {
    await gate.ready();
    const result = await attempt(retries.length);
    const failure = failureOf(result);
    if (!failure) return { result, retries, exhausted: false };
    const wait = backoffMs(failure.kind, retries.length + 1, { baseSeconds });
    if (retries.length >= maxRetries || waited + wait > maxWaitMs)
      return { result, retries, exhausted: retries.length > 0 };
    waited += wait;
    const retry = { kind: failure.kind, waitMs: wait, detail: failure.detail };
    retries.push(retry);
    gate.pause(wait);
    onRetry?.(retry, retries.length);
  }
}

/** The first line of an error, for the record. */
const firstLine = (text) =>
  String(text ?? "")
    .split("\n")[0]
    .slice(0, 300);

/**
 * The infrastructure failure of a run. An unclassified provider error during
 * review is reported as an invalid review and one during planning as a stop,
 * so their text counts too, but only for the provider's own wording: a plan
 * may legitimately talk about rate limits.
 */
export function planFailure(run) {
  const texts = [
    ...(run.outcome === "error" ? [{ text: run.error, error: true }] : []),
    ...(run.judges ?? [])
      .filter((grade) => grade.verdict === "error")
      .map((grade) => ({ text: grade.error, error: true })),
    { text: run.failure?.detail, error: false },
    { text: run.stop, error: false },
  ];
  for (const { text, error } of texts) {
    const kind = infrastructureKind(text, { error });
    if (kind) return { kind, detail: firstLine(text) };
  }
  return null;
}

/** The infrastructure failure of a review run. */
export function reviewFailure(run) {
  return planFailure({
    outcome: run.review === "error" ? "error" : "ok",
    error: run.error,
    judges: run.judges,
    failure: run.failure,
  });
}

/** The infrastructure failure of a judge call's grades. */
export const gradesFailure = (grades) => planFailure({ judges: grades });

/** Retry settings for the report: how many runs waited, how often, how long. */
export function retrySummary(runs, pausedMs = 0) {
  const retried = runs.filter((run) => run.retries?.length);
  const byKind = {};
  for (const run of retried)
    for (const retry of run.retries)
      byKind[retry.kind] = (byKind[retry.kind] ?? 0) + 1;
  return {
    runs: retried.length,
    retries: retried.reduce((total, run) => total + run.retries.length, 0),
    exhausted: runs.filter((run) => run.retriesExhausted).length,
    byKind,
    pausedMs,
  };
}
