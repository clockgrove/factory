/**
 * The credentials systemd loads for a supervised service (LoadCredential,
 * `setup --background`): files in CREDENTIALS_DIRECTORY, one per name, kept
 * out of `process.env` so no child inherits them. The Claude and Copilot
 * logins, a managed worker's API key and the GitHub App's private key are
 * read here.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PlannerError } from "./providers/planner.js";

/** Where systemd loaded credential `name` for the service; undefined when it didn't. */
export function credentialPath(name: string): string | undefined {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory || !isAbsolute(directory)) return undefined;
  const path = join(directory, name);
  return existsSync(path) ? path : undefined;
}

/**
 * One credential systemd loaded for the service (LoadCredential), by name.
 * A token is one line, trimmed; `multiline` keeps a PEM key's lines as
 * they are. An unreadable or invalid credential holds with its name.
 */
export function serviceCredential(
  name: string,
  { multiline = false }: { multiline?: boolean } = {},
): string | undefined {
  const path = credentialPath(name);
  if (!path) return undefined;
  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch {
    throw new PlannerError(
      "hold",
      `Controller credential ${name} is unavailable; restore its configured private file and restart the service, then answer retry`,
    );
  }
  if (!multiline) value = value.trim();
  if (!value.trim() || (multiline ? /\0/ : /[\r\n\0]/).test(value))
    throw new PlannerError(
      "hold",
      `Controller credential ${name} is empty or invalid; update its private file and restart the service, then answer retry`,
    );
  return value;
}
