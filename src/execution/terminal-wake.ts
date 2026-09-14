import { WakeSignal } from "../scheduling/wake-signal.js";
import type { BackendHandle, ExecutionBackend } from "./backend.js";

/** One terminal subscription per worker, with bounded fallback for unsupported backends. */
export function createBackendObservationWake(
  backend: Pick<ExecutionBackend, "waitForTerminal">,
  handle: BackendHandle,
) {
  const wake = new WakeSignal();
  const stopped = new AbortController();
  // Drop the callback's reference on disposal even if the backend never settles.
  let notify: (() => void) | undefined = () => wake.changed();
  const terminal = () => {
    notify?.();
    notify = undefined;
  };
  if (backend.waitForTerminal) {
    try {
      void backend.waitForTerminal(handle).then(terminal, terminal);
    } catch {
      // A hint is never observation authority; let observe report backend errors.
      terminal();
    }
  }
  return {
    get revision() {
      return wake.revision;
    },
    waitForChange(ms: number, signal?: AbortSignal, observedRevision = wake.revision) {
      return wake.waitForChange(
        ms,
        signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal,
        observedRevision,
      );
    },
    dispose() {
      notify = undefined;
      stopped.abort();
    },
  };
}
