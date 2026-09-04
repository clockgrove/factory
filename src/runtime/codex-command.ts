import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface CodexCommand {
  command: string;
  args: string[];
}

const moduleRequire = createRequire(import.meta.url);

/** Resolve the CLI bundled transitively with the Codex SDK before consulting PATH. */
export async function resolveCodexCommand(explicit?: string): Promise<CodexCommand> {
  const configured = explicit ?? process.env["FACTORY_CODEX_PATH"]?.trim();
  if (configured) return { command: configured, args: [] };
  try {
    const manifest = moduleRequire.resolve("@openai/codex/package.json");
    const executable = join(dirname(manifest), "bin", "codex.js");
    await access(executable, fsConstants.R_OK);
    return { command: process.execPath, args: [executable] };
  } catch {
    return { command: "codex", args: [] };
  }
}
