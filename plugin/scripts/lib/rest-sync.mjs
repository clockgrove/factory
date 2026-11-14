// One GitHub REST call made synchronously, for a process that is stopping (proc.mjs atStop): the call runs in a worker
// thread while this thread waits on it, at most `ms`, so no other code of the process runs meanwhile.
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData } from "node:worker_threads";

/**
 * github.mjs `rest(path, {method, body, token})`, waited on for at most `ms` (the call's own retries end then too).
 * Returns {ok: true, data} or {ok: false, error, status}: `status` is GitHub's answer to a refused call, 0 when there was
 * none (no answer in time, the network). Never throws. The token stays in memory: the thread gets it as data.
 */
export function restSync(path, { method = "GET", body, token }, { ms = 5_000 } = {}) {
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker;
  try {
    // No node options of this process (`--input-type=module -e` would keep the thread from loading this file).
    worker = new Worker(new URL(import.meta.url), { workerData: { restSync: true, path, method, body, token, deadlineAt: Date.now() + ms, done, port: port2 }, transferList: [port2], execArgv: [], stdout: true, stderr: true });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), status: 0 };
  }
  worker.unref();
  const waited = Atomics.wait(done, 0, 0, ms);
  const got = receiveMessageOnPort(port1)?.message ?? null;
  void worker.terminate();
  port1.close();
  if (got) return got;
  return { ok: false, error: waited === "timed-out" ? `no answer in ${ms} ms` : "the call ended with no answer", status: 0 };
}

if (!isMainThread && workerData?.restSync) {
  const { path, method, body, token, deadlineAt, done, port } = workerData;
  let answer;
  try {
    const { rest } = await import("./github.mjs");
    answer = { ok: true, data: await rest(path, { method, body, token, deadlineAt, noRateWait: true }) };
  } catch (e) {
    answer = { ok: false, error: String(e?.message || e).slice(0, 200), status: Number(e?.status) || 0 };
  }
  port.postMessage(answer);
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
}
