export const releasePreflightDiagnostic: string;

export interface ReleasePreflightCommandOptions {
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  windowsHide: boolean;
}

export type ReleasePreflightRunner = (
  command: string,
  args: readonly string[],
  options: ReleasePreflightCommandOptions,
) => Promise<{ stdout: string; stderr?: string }>;

export function verifyReleasePreflight(options?: {
  platform?: NodeJS.Platform;
  run?: ReleasePreflightRunner;
}): Promise<void>;
