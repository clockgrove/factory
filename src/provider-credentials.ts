import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { FactoryConfig } from "./config.js";

export function requiredProviderCredential(
  config: FactoryConfig,
): string | undefined {
  if (config.execution.kind !== "managed-agent") return undefined;
  const name =
    config.execution.provider === "claude-managed-agents"
      ? config.execution.config.credentialEnv
      : config.execution.config.apiKeyEnv;
  if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error("Invalid managed provider credential variable name");
  return name;
}

export function validateCredentialFile(
  config: FactoryConfig,
  path: string,
): string {
  if (!isAbsolute(path)) throw new Error("Credential file must be absolute");
  const actual = realpathSync(path);
  const inside = relative(realpathSync(config.checkout), actual);
  const info = statSync(actual);
  if (
    !inside.startsWith("../") ||
    !info.isFile() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "Credential file must be owner-private and outside the target checkout",
    );
  readCredential(actual, requiredProviderCredential(config) ?? "provider");
  return actual;
}

function readCredential(path: string, name: string): string {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(
      `Controller credential ${name} is unavailable; restore its configured private file and restart the service`,
    );
  }
  if (!value || /[\r\n\0]/.test(value))
    throw new Error(
      `Controller credential ${name} is empty or invalid; update its private file and restart the service`,
    );
  return value;
}

/** Values exist only in the caller's memory; an explicit service binding never falls back to ambient environment. */
export function resolveProviderCredential(
  config: FactoryConfig,
  serviceName?: string,
): string | undefined {
  const name = requiredProviderCredential(config);
  if (!name) return undefined;
  if (serviceName !== undefined) {
    if (serviceName !== name)
      throw new Error("Service credential does not match selected provider");
    const directory = process.env.CREDENTIALS_DIRECTORY;
    if (!directory || !isAbsolute(directory))
      throw new Error(
        `systemd credential directory is unavailable for ${name}; use LoadCredential-capable supervision`,
      );
    return readCredential(join(directory, name), name);
  }
  const value = process.env[name];
  if (!value?.trim())
    throw new Error(
      `Set ${name} in the controller environment before starting Factory; for supervision use --credential-file ABSOLUTE_PRIVATE_FILE`,
    );
  return value;
}
