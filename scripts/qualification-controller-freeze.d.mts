export function inspectFreezeCapability(): {
  python: number[];
  pidfdOpen: true;
  pidfdSendSignalPresent: true;
  signalsDelivered: false;
};
export function assertInnerContentionWindow(input: {
  outer: Record<string, unknown>;
  inner: Record<string, unknown>;
  serverTime: string;
  remainingMs: number;
}): {
  outerExpiry: number;
  innerExpiry: number;
  maximumMs: number;
  serverTime: string;
  separationMs: number;
};
export function assertHeldInnerRefusal(input: {
  response: unknown;
  objective: number;
  inner: unknown;
  afterInner: unknown;
  outer: unknown;
  acquired: unknown;
  released: unknown;
}): void;
export interface FreezeHelper {
  ready: Promise<unknown>;
  ended: Promise<{
    closed: boolean;
    records: Array<{ state: string }>;
    code?: number | null;
    signal?: string | null;
  }>;
  records: Array<{ state: string }>;
  readonly closed?: boolean;
  release(command?: string): void;
}
export function withFrozenController(
  spec: Record<string, unknown>,
  operation: (assertFrozen: () => void) => Promise<unknown>,
  record: (value: Record<string, unknown>) => void,
  start?: (spec: Record<string, unknown>, role: string) => FreezeHelper,
): Promise<unknown>;
