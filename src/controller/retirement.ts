import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FactoryReadSnapshot } from "../application/status.js";
import { LocalScopeBatchSchema } from "../protocol/local-scope.js";
import type { RecoveryPlan } from "../recovery/plan.js";
import { recoverySourceEventsDigest } from "../recovery/identity.js";
import { discoverLocalScopeHost, type LocalScopeHost } from "../runtime/local-scope.js";
import { SystemdUserService } from "../service/systemd-user-service.js";

/** The service manager, not the running controller, creates the next process generation. */
export class ControllerGenerationRetirement extends Error {
  constructor() {
    super(
      "Factory controller is retiring its owned launcher generation before successor adoption; the installed service restart policy will reconstruct the acknowledged request",
    );
    this.name = "ControllerGenerationRetirement";
  }
}

export function sourceUsesCurrentProducer(input: {
  plan: RecoveryPlan;
  snapshot: FactoryReadSnapshot;
  host: LocalScopeHost;
  expectedUnit: string;
}): boolean {
  const { plan, snapshot, host } = input;
  if (
    !host.producerUnit ||
    host.producerUnit !== input.expectedUnit ||
    !host.producerInvocationId ||
    snapshot.number !== plan.objective ||
    snapshot.id !== plan.objectiveNodeId ||
    snapshot.repositoryId !== plan.repositoryId
  )
    return false;
  const events = [
    ...(snapshot.factoryEvents ?? []),
    ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ];
  const runIds = plan.history.map((entry) => entry.runId);
  if (
    recoverySourceEventsDigest({
      objective: plan.objective,
      runIds,
      events,
      maxSequence: plan.sourceEventMaxSequence,
    }) !== plan.sourceEventsDigest
  )
    return false;
  return events.some((event) => {
    if (
      !runIds.includes(event.runId) ||
      event.sequence > plan.sourceEventMaxSequence ||
      !(
        (event.kind === "attempt" && event.event === "AttemptReserved") ||
        (event.kind === "capacity" && event.event === "CapacityReserved")
      ) ||
      !event.localScopeBatch
    )
      return false;
    const batch = LocalScopeBatchSchema.parse(event.localScopeBatch);
    return (
      batch.producerPid === host.producerPid &&
      batch.producerStartTicks === host.producerStartTicks &&
      batch.identity.hostIdentity === host.hostIdentity &&
      batch.identity.producerUnit === host.producerUnit &&
      batch.identity.producerInvocationId === host.producerInvocationId
    );
  });
}

/** Read-only check, called only after adoption verified authority/source/accounting and
 * blocked on resource absence. Never stop a foreign unit or install a restart policy. */
export async function shouldRetireController(input: {
  plan: RecoveryPlan;
  snapshot: FactoryReadSnapshot;
  checkout: string;
}): Promise<boolean> {
  const host = await discoverLocalScopeHost();
  if (!host) return false;
  const expectedUnit = new SystemdUserService({ factoryExecutable: process.execPath }).unitName({
    repository: input.plan.repository,
    checkout: input.checkout,
  });
  if (!sourceUsesCurrentProducer({ ...input, host, expectedUnit })) return false;
  try {
    const result = await promisify(execFile)(
      "systemctl",
      [
        "--user",
        "show",
        expectedUnit,
        "--property=Restart,RestartPreventExitStatus,SuccessExitStatus",
        "--no-pager",
      ],
      { timeout: 5000, maxBuffer: 4096 },
    );
    const fields: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
      const index = line.indexOf("=");
      if (index < 1 || Object.hasOwn(fields, line.slice(0, index))) return false;
      fields[line.slice(0, index)] = line.slice(index + 1);
    }
    // Nonzero process exit must really be restartable in the observed unit.
    return (
      ["on-failure", "always"].includes(fields.Restart ?? "") &&
      fields.RestartPreventExitStatus !== undefined &&
      fields.SuccessExitStatus !== undefined &&
      ![fields.RestartPreventExitStatus, fields.SuccessExitStatus].some((value) =>
        value.split(/\s+/).some((status) => status === "1" || status === "FAILURE"),
      )
    );
  } catch {
    return false;
  }
}
