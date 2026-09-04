import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type CodexHomeKind = "management" | "worker";
export type CodexHomeFactory = (kind: CodexHomeKind) => Promise<string>;

export interface CodexHomeRootOptions {
  homeDirectory?: string;
  tempDirectory?: string;
  xdgStateHome?: string;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Codex intentionally refuses to create helper binaries under an operating-system
 * temporary directory. Factory therefore keeps ephemeral, isolated Codex homes in
 * the user's durable state directory and removes each one after the run.
 */
export function resolveCodexHomeRoot(options: CodexHomeRootOptions = {}): string {
  const userHome = resolve(options.homeDirectory ?? homedir());
  const temporaryRoot = resolve(options.tempDirectory ?? tmpdir());
  const configuredState = options.xdgStateHome ?? process.env["XDG_STATE_HOME"];
  const stateRoot =
    configuredState?.trim() && isAbsolute(configuredState)
      ? resolve(configuredState)
      : join(userHome, ".local", "state");
  const candidate = join(stateRoot, "clockgrove-factory", "codex-homes");
  if (isWithin(temporaryRoot, candidate)) {
    const fallback = join(userHome, ".local", "state", "clockgrove-factory", "codex-homes");
    if (!isWithin(temporaryRoot, fallback)) return fallback;
    throw new Error(
      `Factory cannot place isolated Codex homes outside temporary directory ${temporaryRoot}`,
    );
  }
  return candidate;
}

export async function createIsolatedCodexHome(kind: CodexHomeKind): Promise<string> {
  const root = resolveCodexHomeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${kind}-`));
}

export function resolveCodexAuthFile(explicit?: string): string {
  if (explicit) return explicit;
  const configuredHome = process.env["CODEX_HOME"]?.trim();
  return configuredHome && isAbsolute(configuredHome)
    ? join(configuredHome, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

/** Redirect conventional host credential/config discovery into the isolated attempt home. */
export function isolateCodexEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const locations = {
    HOME: codexHome,
    USERPROFILE: codexHome,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(codexHome, "xdg-config"),
    XDG_CACHE_HOME: join(codexHome, "xdg-cache"),
    XDG_DATA_HOME: join(codexHome, "xdg-data"),
    XDG_STATE_HOME: join(codexHome, "xdg-state"),
    NPM_CONFIG_USERCONFIG: join(codexHome, "npmrc"),
    NETRC: join(codexHome, "netrc"),
    KUBECONFIG: join(codexHome, "kubeconfig"),
    DOCKER_CONFIG: join(codexHome, "docker"),
    AWS_CONFIG_FILE: join(codexHome, "aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(codexHome, "aws-credentials"),
    AZURE_CONFIG_DIR: join(codexHome, "azure"),
    CLOUDSDK_CONFIG: join(codexHome, "gcloud"),
    GNUPGHOME: join(codexHome, "gnupg"),
  };
  return Object.assign(environment, locations);
}
