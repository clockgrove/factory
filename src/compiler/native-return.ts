import type { ModelInvocationContext } from "../contracts.js";
import { awaitCheckpointAdmission } from "../recovery-checkpoint.js";

/**
 * Retain the exact terminal return locally before parsing or disposal. Its
 * archive durability is coalesced (`settled`): a return guards no external
 * effect, and every later effect's pre-effect checkpoint carries it.
 */
export async function admitNativeReturn(
  retain: ModelInvocationContext["retainNativeReturn"],
  receipt: Parameters<NonNullable<typeof retain>>[0] | undefined,
  repository: string | undefined,
  checkpointRejected = false,
): Promise<void> {
  const admission = receipt ? await retain?.(receipt) : undefined;
  // Legacy callbacks, absent returns and failure paths keep their existing gate.
  // A rejected checkpoint remains its original fence, never a second submission.
  if (!checkpointRejected && admission !== "admission-complete")
    await awaitCheckpointAdmission(repository, "settled");
}
