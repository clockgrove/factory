export interface InstalledQuotaStopPort {
  install(): Promise<unknown>;
  arm(installed: unknown): Promise<unknown>;
  start(armed: unknown): Promise<unknown>;
  reached(armed: unknown, started: unknown): Promise<unknown>;
  stop(armed: unknown, reached: unknown): Promise<unknown>;
  disarm(armed: unknown, stopped: unknown): Promise<unknown>;
  telemetry(armed: unknown, stopped: unknown): Promise<unknown>;
  final(armed: unknown, telemetry: unknown): Promise<unknown>;
  cleanup(armed: unknown, final: unknown): Promise<unknown>;
}

export function runInstalledQuotaStopScenario(port: InstalledQuotaStopPort): Promise<{
  installed: unknown;
  armed: unknown;
  started: unknown;
  reached: unknown;
  disarmed: unknown;
  stopped: unknown;
  telemetry: unknown;
  final: unknown;
  cleanup: unknown;
}>;

export function parseSelectedManagerEnvironment(output: string): Record<string, string>;
export function qualificationManagerEnvironment(
  preloadPath: string,
  armPath: string,
): Record<string, string>;
export function assertUnmodifiedInstalledGeneration(
  manager: Record<string, string>,
  unitPath: string,
): void;
export function main(env?: NodeJS.ProcessEnv): Promise<void>;
