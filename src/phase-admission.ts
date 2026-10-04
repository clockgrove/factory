import { liveCapacity, type ResourcePhase } from "./config.js";
import { StepFault } from "./fault.js";
import type { FactoryState } from "./state.js";
import { clearWait, setWait } from "./step.js";

/**
 * Why a phase cannot be admitted now. `fix` is set when waiting can never
 * admit it (the configuration declares no or too large a reservation).
 */
interface Blocked {
  detail: string;
  fix?: string;
}

/** Shared by both concrete runners. The snapshot owns reservations; waiters only wake it. */
export function phaseAdmission(
  state: FactoryState,
  save: () => void,
  cancelled: () => boolean,
) {
  // Stored capacity binds the plan; scheduling never exceeds what this host offers now.
  const capacity = liveCapacity(state.capacity);
  const effectivePhase = (work: FactoryState["work"][string]) =>
    work.phaseReservation ??
    (!work.requestedPhase &&
    work.status === "running" &&
    work.step === "execute" &&
    work.execution
      ? "coding"
      : undefined);
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };
  const changed = (checkCancellation = false) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve();
      };
      const timer = checkCancellation ? setTimeout(wake, 250) : undefined;
      waiters.add(wake);
    });
  const codingCount = () =>
    Object.values(state.work).filter(
      (work) => effectivePhase(work) === "coding",
    ).length;
  const availableSlots = (reported: number | "unknown") => {
    if (
      reported !== "unknown" &&
      (!Number.isSafeInteger(reported) || reported < 0)
    )
      throw new Error(
        "Driver availableSlots must be a nonnegative integer or unknown",
      );
    const operator = capacity.concurrency;
    // Driver reports remaining slots, not total capacity. Subtract owned coding only from the operator ceiling.
    return Math.max(
      0,
      Math.min(
        operator - codingCount(),
        reported === "unknown" ? operator : reported,
      ),
    );
  };
  const blocker = (id: string, phase: ResourcePhase): Blocked | undefined => {
    const reservations = Object.entries(state.work)
      .map(
        ([other, work]) =>
          [other, { ...work, phaseReservation: effectivePhase(work) }] as const,
      )
      .filter(([other, work]) => other !== id && work.phaseReservation);
    const ceiling =
      phase === "coding"
        ? capacity.concurrency
        : phase === "review"
          ? (capacity.scheduling?.reviewConcurrency ?? capacity.concurrency)
          : phase === "validation"
            ? (capacity.scheduling?.validationConcurrency ??
              capacity.concurrency)
            : undefined;
    if (
      ceiling !== undefined &&
      reservations.filter(([, work]) => work.phaseReservation === phase)
        .length >= ceiling
    )
      return { detail: `${phase} concurrency ceiling` };
    const declaration = capacity.scheduling?.phases?.[phase];
    for (const resource of ["cpu", "memoryMiB"] as const) {
      const limit = capacity.scheduling?.[resource];
      if (limit === undefined) continue;
      const requested = declaration?.[resource];
      if (requested === undefined)
        return {
          detail: `unknown ${phase} ${resource} reservation`,
          fix: `Declare capacity.scheduling.phases.${phase}.${resource} in the configuration`,
        };
      if (requested > limit)
        return {
          detail: `${phase} ${resource} reservation exceeds ceiling`,
          fix: `Lower capacity.scheduling.phases.${phase}.${resource} to at most capacity.scheduling.${resource}`,
        };
      let total = requested;
      for (const [, work] of reservations) {
        const amount =
          capacity.scheduling?.phases?.[work.phaseReservation!]?.[resource];
        if (amount === undefined)
          return {
            detail: `unknown active ${resource} reservation`,
            fix: `Declare capacity.scheduling.phases.${work.phaseReservation}.${resource} in the configuration`,
          };
        total += amount;
      }
      if (total > limit) return { detail: `${resource} ceiling` };
    }
    // A ready completion phase receives the next fitting grant. It never waits behind new coding.
    if (
      phase === "coding" &&
      Object.entries(state.work).some(
        ([other, work]) =>
          other !== id &&
          work.requestedPhase &&
          work.requestedPhase !== "coding",
      )
    )
      return { detail: "completion phase waiting" };
    return undefined;
  };
  const reason = (id: string, phase: ResourcePhase): string | undefined =>
    blocker(id, phase)?.detail;
  const release = (id: string) => {
    delete state.work[id]!.phaseReservation;
    delete state.work[id]!.requestedPhase;
    save();
    notify();
  };
  const reserve = async (id: string, phase: ResourcePhase) => {
    const work = state.work[id]!;
    // Callers transfer only after the previous effect has settled. No coding slot is held while awaiting review.
    delete work.phaseReservation;
    work.requestedPhase = phase;
    save();
    notify();
    while (true) {
      if (cancelled())
        throw new StepFault({
          kind: "cancelled",
          detail: "Objective cancelled",
        });
      // The runner cancels the Objective when its deadline passes.
      if (
        state.coordinator?.deadlineAt &&
        Date.now() >= Date.parse(state.coordinator.deadlineAt)
      )
        throw new StepFault({
          kind: "cancelled",
          detail: "Objective deadline reached before phase admission",
        });
      const blocked = blocker(id, phase);
      if (!blocked) break;
      if (blocked.fix)
        throw new StepFault({
          kind: "config",
          detail: blocked.detail,
          fix: blocked.fix,
        });
      if (
        setWait(
          state,
          { item: id },
          { kind: "capacity", detail: blocked.detail },
        )
      )
        save();
      await changed(true);
    }
    delete work.requestedPhase;
    clearWait(state, { item: id });
    work.phaseReservation = phase;
    save();
    notify();
  };
  return { reason, reserve, release, changed, codingCount, availableSlots };
}
export type PhaseAdmission = ReturnType<typeof phaseAdmission>;
