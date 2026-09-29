import type { FactoryConfig, ResourcePhase } from "./config.js";
import type { FactoryState } from "./state.js";

/** Shared by both concrete runners. The snapshot owns reservations; waiters only wake it. */
export function phaseAdmission(
  config: FactoryConfig,
  state: FactoryState,
  save: () => void,
  cancelled: () => boolean,
) {
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
    const operator = Math.min(
      config.execution.concurrency,
      state.admission?.authority.resources.maxConcurrency ??
        config.execution.concurrency,
    );
    // Driver reports remaining slots, not total capacity. Subtract owned coding only from the operator ceiling.
    return Math.max(
      0,
      Math.min(
        operator - codingCount(),
        reported === "unknown" ? operator : reported,
      ),
    );
  };
  const reason = (id: string, phase: ResourcePhase): string | undefined => {
    const reservations = Object.entries(state.work)
      .map(
        ([other, work]) =>
          [other, { ...work, phaseReservation: effectivePhase(work) }] as const,
      )
      .filter(([other, work]) => other !== id && work.phaseReservation);
    const ceiling =
      phase === "coding"
        ? Math.min(
            config.execution.concurrency,
            state.admission?.authority.resources.maxConcurrency ??
              config.execution.concurrency,
          )
        : phase === "review"
          ? (config.scheduling?.reviewConcurrency ??
            config.execution.concurrency)
          : phase === "validation"
            ? (config.scheduling?.validationConcurrency ??
              config.execution.concurrency)
            : undefined;
    if (
      ceiling !== undefined &&
      reservations.filter(([, work]) => work.phaseReservation === phase)
        .length >= ceiling
    )
      return `${phase} concurrency ceiling`;
    const declaration = config.scheduling?.phases?.[phase];
    for (const resource of ["cpu", "memoryMiB"] as const) {
      const limit = config.scheduling?.[resource];
      if (limit === undefined) continue;
      const requested = declaration?.[resource];
      if (requested === undefined)
        return `unknown ${phase} ${resource} reservation`;
      if (requested > limit)
        return `${phase} ${resource} reservation exceeds ceiling`;
      let total = requested;
      for (const [, work] of reservations) {
        const amount =
          config.scheduling?.phases?.[work.phaseReservation!]?.[resource];
        if (amount === undefined)
          return `unknown active ${resource} reservation`;
        total += amount;
      }
      if (total > limit) return `${resource} ceiling`;
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
      return "completion phase waiting";
    return undefined;
  };
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
      if (cancelled()) throw new Error("Objective cancelled");
      if (
        state.coordinator?.deadlineAt &&
        Date.now() >= Date.parse(state.coordinator.deadlineAt)
      )
        throw new Error("Objective deadline reached before phase admission");
      const blocked = reason(id, phase);
      if (!blocked) break;
      work.waitingReason = blocked;
      save();
      if (blocked.startsWith("unknown") || blocked.includes("exceeds ceiling"))
        throw new Error(blocked);
      await changed(true);
    }
    delete work.requestedPhase;
    delete work.waitingReason;
    work.phaseReservation = phase;
    save();
    notify();
  };
  return { reason, reserve, release, changed, codingCount, availableSlots };
}
export type PhaseAdmission = ReturnType<typeof phaseAdmission>;
