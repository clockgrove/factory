import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { FactoryConfig } from "./config.js";

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The controller credential the configured execution provider needs, if any. */
export function executionCredential(config: FactoryConfig): string | undefined {
  if (
    config.execution.kind === "sandbox" &&
    config.execution.provider === "daytona"
  ) {
    const name = config.execution.config?.apiKeyEnv;
    if (typeof name !== "string" || !VARIABLE_NAME.test(name))
      throw new Error("Invalid Daytona credential variable name");
    return name;
  }
  if (config.execution.kind !== "managed-agent") return undefined;
  const name =
    config.execution.provider === "claude-managed-agents"
      ? config.execution.config.credentialEnv
      : config.execution.config.apiKeyEnv;
  if (typeof name !== "string" || !VARIABLE_NAME.test(name))
    throw new Error("Invalid managed provider credential variable name");
  return name;
}

/** The controller credential the configured planning provider needs, if any. */
export function planningCredential(config: FactoryConfig): string | undefined {
  return config.planning.kind === "claude-api"
    ? config.planning.credentialEnv
    : undefined;
}

/** Every controller credential the configured providers need, deduplicated. */
export function requiredProviderCredentials(config: FactoryConfig): string[] {
  return [
    ...new Set(
      [executionCredential(config), planningCredential(config)].filter(
        (name): name is string => name !== undefined,
      ),
    ),
  ];
}

export function validateCredentialFile(
  config: FactoryConfig,
  name: string,
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
  readCredential(actual, name);
  return actual;
}

/**
 * Bind each required credential to exactly one `NAME=ABSOLUTE_PRIVATE_FILE`
 * entry; a missing, unknown or repeated name is refused.
 */
export function credentialFileBindings(
  config: FactoryConfig,
  entries: string[],
): { name: string; file: string }[] {
  const required = requiredProviderCredentials(config);
  const files = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (separator < 1 || !VARIABLE_NAME.test(name))
      throw new Error("--credential-file must be NAME=ABSOLUTE_PRIVATE_FILE");
    if (!required.includes(name))
      throw new Error(
        `Credential ${name} is not required by the configured providers`,
      );
    if (files.has(name))
      throw new Error(`Credential ${name} is bound more than once`);
    files.set(name, entry.slice(separator + 1));
  }
  return required.map((name) => {
    const file = files.get(name);
    if (!file)
      throw new Error(
        `Supervision requires --credential-file ${name}=ABSOLUTE_PRIVATE_FILE`,
      );
    return { name, file: validateCredentialFile(config, name, file) };
  });
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

/**
 * Values exist only in the caller's memory. A supervised service passes the
 * names systemd loaded and never falls back to the ambient environment.
 */
export function resolveProviderCredential(
  config: FactoryConfig,
  name: string,
  serviceCredentials?: string[],
): string {
  if (!requiredProviderCredentials(config).includes(name))
    throw new Error(
      `Credential ${name} is not required by the configured providers`,
    );
  if (serviceCredentials !== undefined) {
    if (!serviceCredentials.includes(name))
      throw new Error(
        `Service credential binding lacks ${name}; reinstall with --credential-file ${name}=ABSOLUTE_PRIVATE_FILE`,
      );
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
      `Set ${name} in the controller environment before starting Factory; for supervision use --credential-file ${name}=ABSOLUTE_PRIVATE_FILE`,
    );
  return value;
}
