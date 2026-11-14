// One GitHub REST call made synchronously, for a process that is stopping (proc.mjs atStop): the call runs in a worker
// thread while this thread waits on it, at most `ms`, so no other code of the process runs meanwhile.
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData } from "node:worker_threads";
import { redactSecrets } from "./inputs.mjs";

// The worker's progress, in its shared slot: nothing sent yet, the request on its way, an answer posted.
const IDLE = 0;
const SENDING = 1;
const DONE = 2;

/**
 * github.mjs `rest(path, {method, body, token})`, one try (no retry), waited on for at most `ms`. `token`: a string or
 * a getter (TokenKeeper's), read here. `body` has this process's held secrets redacted here (inputs.mjs holdSecrets):
 * the thread's own module state holds none. Never throws. Returns {ok: true, data}, or {ok: false, error, sent}: `sent`
 * is false only when the request certainly never reached GitHub (the thread or token failed before it, a connect-level
 * failure: github.mjs `unsent`) or GitHub answered with a refusal (4xx); true when it may have landed (a 5xx, no answer
 * before `ms`, a connection lost after sending).
 */
export function restSync(path, { method = "GET", body, token }, { ms = 5_000 } = {}) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker;
  try {
    const t = typeof token === "function" ? token() : token;
    const data = { restSync: true, path, method, body: body === undefined ? undefined : redactSecrets(body), token: t || undefined, state, port: port2 };
    // No node options of this process (`--input-type=module -e` would keep the thread from loading this file).
    worker = new Worker(new URL(import.meta.url), { workerData: data, transferList: [port2], execArgv: [], stdout: true, stderr: true });
  } catch (e) {
    port1.close();
    return { ok: false, error: String(e?.message || e).slice(0, 200), sent: false };
  }
  worker.unref();
  const end = Date.now() + ms;
  for (let v = Atomics.load(state, 0); v !== DONE && Date.now() < end; v = Atomics.load(state, 0)) Atomics.wait(state, 0, v, end - Date.now());
  const last = Atomics.load(state, 0);
  const got = last === DONE ? (receiveMessageOnPort(port1)?.message ?? null) : null;
  void worker.terminate();
  port1.close();
  if (got) return got;
  return { ok: false, error: last === DONE ? "the call ended with no answer" : `no answer in ${ms} ms`, sent: last !== IDLE };
}

if (!isMainThread && workerData?.restSync) {
  const { path, method, body, token, state, port } = workerData;
  let answer;
  let github = null;
  try {
    github = await import("./github.mjs");
    Atomics.store(state, 0, SENDING);
    Atomics.notify(state, 0);
    // One try: a deadline that is already here leaves rest no wait to retry in, so the answer says what this request did.
    answer = { ok: true, data: await github.rest(path, { method, body, token, deadlineAt: Date.now(), noRateWait: true }) };
  } catch (e) {
    const status = Number(e?.status) || 0;
    const refused = status > 0 && status < 500;
    const sent = Atomics.load(state, 0) === SENDING && !(github && e instanceof github.GitHubError && (e.unsent === true || refused));
    answer = { ok: false, error: String(e?.message || e).slice(0, 200), sent };
  }
  port.postMessage(answer);
  Atomics.store(state, 0, DONE);
  Atomics.notify(state, 0);
}
