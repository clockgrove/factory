/** Internal committed-driver ports, not an installed execution API or an authorization grant. */
export interface LargeFileRefusalContext {
  authority: {
    repository: string;
    namespace: string;
    checkout: string;
    policy: { maxAttemptsPerItem: number; allowedPaidBackends: string[] };
    largeFile: { scenario: string };
  };
  evidence: {
    objective: { number: number };
    base: string;
    actor: { id: number; login: string };
    largeFileRefusal?: Record<string, unknown>;
  };
  request(route: string, args: Record<string, unknown>): Promise<unknown>;
  list(route: string, args: Record<string, unknown>): Promise<unknown[]>;
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
  save(): void | Promise<void>;
  port?: unknown;
}
export interface LargeFileRefusalFixture {
  namespace: string;
  baseSha: string;
  paths: { prefix: string; payload: string };
  lfs: Array<{ oid: string }>;
}
export function createLargeFileRefusalPorts(
  context: LargeFileRefusalContext,
  fixture: LargeFileRefusalFixture,
): {
  compileRefusal(): Promise<Record<string, unknown>>;
  artifactRefusal(observation: unknown): Promise<Record<string, unknown>>;
};
