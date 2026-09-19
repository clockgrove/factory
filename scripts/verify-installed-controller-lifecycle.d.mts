interface LifecycleRaceArm {
  requestId: string;
  environment?: Record<string, string>;
}

interface LifecycleRacePort {
  arm(name: string): Promise<LifecycleRaceArm>;
  spawn(operation: string, requestId: string, environment?: Record<string, string>): unknown;
  reached(name: string, arm: LifecycleRaceArm, installing: unknown): Promise<unknown>;
  waiting(name: string, competing: unknown, reached: unknown): Promise<unknown>;
  release(name: string, arm: LifecycleRaceArm, reached: unknown, waiting: unknown): Promise<void>;
  settle(name: string, operation: string, handle: unknown): Promise<unknown>;
  final(
    name: string,
    operation: string,
    settlements: { installSettlement: unknown; secondSettlement: unknown },
  ): Promise<unknown>;
  reset(name: string, final: unknown): Promise<void>;
  contention(): Promise<unknown>;
  cleanup(): Promise<unknown>;
}

export function findPendingFlock(
  text: string,
  expected: { pid: number; major: string; minor: string; inode: string },
): {
  state: "pending";
  class: "FLOCK";
  access: "WRITE";
  pid: number;
  device: string;
  inode: string;
  range: "0:EOF";
} | null;

export function kernelFlockWaitEvidence(
  procLocks: string,
  waitChannel: string,
  expected: { pid: number; major: string; minor: string; inode: string },
):
  | ({ authority: "proc-locks" } & NonNullable<ReturnType<typeof findPendingFlock>>)
  | { authority: "wait-channel"; waitChannel: "locks_lock_inode_wait" }
  | null;

export function isExactLifecycleFlockWaiter(
  argv: readonly string[],
  lockFd: number | null,
): boolean;

export function waitForPrivateJson(
  path: string,
  child: {
    pid?: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  },
  uid: number,
  timeoutMs?: number,
): Promise<string>;

export function runLifecycleRaceMatrix(port: LifecycleRacePort): Promise<{
  cases: Array<{ name: string } & Record<string, unknown>>;
  contention: unknown;
  cleanup: unknown;
}>;

export function main(env?: NodeJS.ProcessEnv): Promise<void>;
