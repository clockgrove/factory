export const QUALIFICATION_INSTALL_RECEIPT_ENV: "FACTORY_QUALIFICATION_INSTALL_RECEIPT";
export const QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV: "FACTORY_MANAGEMENT_TRANSCRIPT_DIR";
export function installedCompilerPreflight(
  input: {
    factoryCli: string;
    checkout: string;
    baseSha: string;
    policy?: unknown;
    executionTrust?: "trusted_local" | "isolated" | "managed";
    environment?: NodeJS.ProcessEnv;
  },
  execute?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    stdout: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  },
): {
  result: "passed" | "blocked";
  baseSha: string;
  pinnedFactsDigest: string;
  toolchains: unknown[];
  validation: { status: string; violations: Array<{ code: string }> };
  execution: {
    protocol: "clockgrove.factory/execution-route-preflight";
    result: "passed" | "blocked";
    required: { trust: string; minimumIsolation: string } | null;
    routes: unknown[];
  };
};
export function installedLocalScopePreflight(
  input: {
    factoryCli: string;
    checkout: string;
    environment?: NodeJS.ProcessEnv;
  },
  execute?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    stdout: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  },
): {
  protocol: "clockgrove.factory/local-scope-preflight-v1";
  result: "passed" | "blocked";
  capability: "durable-local-scopes";
  blocker?: "durable-local-scopes-unavailable";
  reason?: string;
};
export function parseQualificationInstallReceipt(text: string): Record<string, string>;
export function qualificationPluginListEnvironment(
  environment: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv;
export function qualificationRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options?: {
    linuxHome?: string;
    additions?: NodeJS.ProcessEnv;
    repositoryRoot?: string;
    requireManagementTranscripts?: boolean;
    uid?: number;
  },
): NodeJS.ProcessEnv;
export function installedQualificationAuthority(
  env: NodeJS.ProcessEnv,
  options: {
    uid?: number;
    sourceRoot: string;
    committedPaths?: string[];
    gitCommand?: string;
    gitEnvironment?: NodeJS.ProcessEnv;
    listPlugins?: (
      codexCli: string,
      codexHome: string,
      childEnvironment: NodeJS.ProcessEnv,
    ) => unknown;
  },
): Record<string, unknown>;
