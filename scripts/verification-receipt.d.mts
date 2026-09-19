export interface SourceIdentity {
  commit: string;
  tree: string;
  clean: boolean;
  status: string;
}

export function sourceIdentity(cwd?: string): Promise<SourceIdentity>;
export function assertExpectedCommit(identity: SourceIdentity, expected?: string): void;
export function createVerificationReceipt(options: {
  gate: "test:main" | "verify:candidate";
  command: string;
  startedAt: string;
  completedAt?: string;
  cwd?: string;
  expectedCommit?: string;
}): Promise<Record<string, unknown>>;
export function writeVerificationReceipt(
  receipt: Record<string, unknown>,
  path: string,
): Promise<string>;
