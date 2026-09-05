export interface ProviderAuthority {
  profile: "daytona-burst" | "github-copilot" | "openai-codex";
  repository: string;
  sandboxMinutes: number;
  modelTokens: number;
  managedSessions: number;
}
export function providerAuthority(
  env: Record<string, string | undefined>,
): ProviderAuthority | null;
export function providerPolicy(authority: ProviderAuthority): unknown;
export function providerObjective(profile: ProviderAuthority["profile"]): string;
export function assessProviderCompletion(
  evidence: unknown,
  authority: ProviderAuthority,
): { result: string; scope: string; reason?: string };
export function observeProviderAbsence(
  daytona: unknown,
  evidence: unknown,
): Promise<{ state: string; reason?: string }>;
export function observeManagedAgentTermination(
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>,
  evidence: unknown,
): Promise<{ state: string; reason?: string; bindings?: unknown[]; active?: unknown[] }>;
export function main(): Promise<void>;
