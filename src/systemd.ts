/**
 * The background service: a systemd user unit that runs `factory serve
 * --repo` for one installation, restarts it when it fails, and hands it
 * the service's credentials with LoadCredential. Setup writes, starts,
 * checks, stops and removes it. A unit whose first line isn't Factory's
 * marker is never touched.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreConfig } from "./config.js";
import type { Paths } from "./paths.js";
import { CLAUDE_LOGIN_CREDENTIALS } from "./providers/claude.js";
import { COPILOT_SECRETS, copilotConfigured } from "./providers/config.js";

/** Exit code of a serve whose configuration doesn't load (EX_CONFIG): not restarted. */
export const CONFIGURATION_EXIT = 78;

/** The unit's first line; the binding (its credential files) follows as JSON. */
const MARKER = "# Factory core service ";

/** The variables the service keeps from the shell that ran setup, when set. */
const KEPT = [
  "PATH",
  "HOME",
  "LANG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "FACTORY_CONFIG",
  "FACTORY_STATE_DIR",
  "FACTORY_DISPLAY_TIMEZONE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "COPILOT_HOME",
  "COPILOT_API_URL",
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
  "GH_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export interface Credential {
  name: string;
  file: string;
}

export interface ServiceState {
  unit: string;
  path: string;
  /** Factory's unit file exists. */
  installed: boolean;
  /** `systemctl --user is-enabled` and `is-active`. */
  enabled: string;
  active: string;
  /** The service holds its lock: a `factory serve` for this installation runs. */
  serving: boolean;
  credentials: string[];
  /**
   * The unit runs this Factory with this environment: false after an
   * upgrade or a changed environment, until `--background` again.
   */
  current: boolean;
  /** Whether the user manager outlives a logout (loginctl Linger). */
  linger: "yes" | "no" | "unknown";
}

/** One unit per installation, named by its state directory. */
export function unitName(paths: Paths): string {
  return `factory-${createHash("sha256").update(paths.root).digest("hex").slice(0, 24)}.service`;
}

function unitPath(paths: Paths): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd",
    "user",
    unitName(paths),
  );
}

function systemctl(...args: string[]): { status: number; out: string } {
  const run = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: run.status ?? 1,
    out: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim(),
  };
}

/** Why this host can't run a user service, or undefined. */
export function hostProblem(): string | undefined {
  if (process.platform !== "linux" || !existsSync("/run/systemd/system"))
    return "The background service needs Linux with systemd; run `factory serve --repo` yourself instead";
  const state = systemctl("is-system-running").out;
  if (state !== "running" && state !== "degraded")
    return `The systemd user manager is ${state || "unavailable"}; start a user session with systemd (or enable lingering), then repeat`;
  return undefined;
}

/**
 * A quoted unit value: systemd expands `%` specifiers everywhere and
 * `$` in ExecStart, so both are escaped; a line break can't be written.
 */
function quoted(value: string, exec = false): string {
  if (/[\n\r\0]/.test(value))
    throw new Error("A service value can't contain a line break");
  return JSON.stringify(
    (exec ? value.replaceAll("$", "$$$$") : value).replaceAll("%", "%%"),
  );
}

/** The names Factory reads from the service's credentials. */
function credentialNames(config: CoreConfig): Set<string> {
  const readable = new Set<string>(CLAUDE_LOGIN_CREDENTIALS);
  if (copilotConfigured(config.providers))
    for (const name of COPILOT_SECRETS) readable.add(name);
  return readable;
}

/**
 * The logins a shell may set that the unit doesn't keep: the service has
 * them only as its credentials (`--credential-file`), or not at all. The
 * Codex and GitHub keys are never kept, so the service logs in with Codex's
 * auth.json and the GitHub CLI's stored login.
 */
export const unkeptLogins = (config: CoreConfig): string[] => [
  ...credentialNames(config),
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "FACTORY_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * `NAME=ABSOLUTE_FILE` bindings, checked: a name Factory reads from the
 * service's credentials, and a regular file only its owner can read. The
 * file is never read here.
 */
export function credentialFiles(
  bindings: readonly string[],
  config: CoreConfig,
): Credential[] {
  const readable = credentialNames(config);
  const credentials: Credential[] = [];
  for (const binding of bindings) {
    const at = binding.indexOf("=");
    const name = binding.slice(0, at);
    const file = binding.slice(at + 1);
    if (at < 1 || !readable.has(name))
      throw new Error(
        `--credential-file takes NAME=ABSOLUTE_FILE, where NAME is one Factory reads from the service's credentials: ${[...readable].join(", ")}`,
      );
    // Written into the unit as is: no space, quote, backslash or specifier.
    // Not a link, and in a directory only its owner can change, since
    // systemd reads the path again at every start.
    const info =
      isAbsolute(file) && /^[\w./@+,=-]+$/.test(file)
        ? lstatSync(file, { throwIfNoEntry: false })
        : undefined;
    const parent = info && statSync(dirname(file));
    if (
      !info?.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      !parent ||
      (parent.mode & 0o022) !== 0
    )
      throw new Error(
        `--credential-file ${name}: ${file} must be an absolute path (letters, digits and . / @ + , = - _ only) of a regular file (not a link) you own that only you can read (chmod 600), in a directory only you can write`,
      );
    if (credentials.some((credential) => credential.name === name))
      throw new Error(`--credential-file ${name} is given twice`);
    credentials.push({ name, file });
  }
  return credentials;
}

/** The credentials Factory's unit binds now; empty without one. */
export function boundCredentials(paths: Paths): Credential[] {
  const text = ours(paths);
  if (!text) return [];
  try {
    const { credentials } = JSON.parse(
      text.slice(MARKER.length, text.indexOf("\n")),
    ) as { credentials?: Credential[] };
    return Array.isArray(credentials) ? credentials : [];
  } catch {
    return [];
  }
}

/** Factory's unit file text, or undefined when there's none (or it isn't Factory's). */
function ours(paths: Paths): string | undefined {
  try {
    const text = readFileSync(unitPath(paths), "utf8");
    return text.startsWith(MARKER) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The CLI this process runs: the service runs the same installation. */
const cli = () =>
  realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));

/** The unit for this installation, as setup writes it. */
export function unitText(
  repository: string,
  credentials: readonly Credential[],
): string {
  const exec = [process.execPath, cli(), "serve", "--repo", repository];
  const environment = KEPT.flatMap((name) =>
    process.env[name]
      ? [`Environment=${quoted(`${name}=${process.env[name]}`)}`]
      : [],
  );
  return [
    `${MARKER}${JSON.stringify({ credentials })}`,
    "[Unit]",
    // OWNER/NAME has no specifier or line break (cli.ts checks it).
    `Description=Factory service for ${repository}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "UMask=0077",
    `ExecStart=${exec.map((word) => quoted(word, true)).join(" ")}`,
    ...environment,
    ...credentials.map(({ name, file }) => `LoadCredential=${name}:${file}`),
    // The service stops at its next tick; then its children are killed.
    "KillMode=mixed",
    "TimeoutStopSec=30s",
    "Restart=on-failure",
    "RestartSec=5s",
    // Usage, and a configuration that doesn't load: a restart can't fix them.
    `RestartPreventExitStatus=2 ${CONFIGURATION_EXIT}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Write the unit, then enable and start it. A changed unit, or `restart`,
 * restarts the service; otherwise a running one is left alone. Throws a
 * refusal naming the fix.
 */
export function install(
  repository: string,
  paths: Paths,
  credentials: readonly Credential[],
  /** Restart even when the unit is unchanged: its configuration or credentials changed. */
  restart: boolean,
): { changed: boolean } {
  const path = unitPath(paths);
  if (existsSync(path) && !ours(paths))
    throw new Error(
      `${path} exists and isn't Factory's; move it away, then repeat`,
    );
  const text = unitText(repository, credentials);
  const changed = ours(paths) !== text;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
    const reload = systemctl("daemon-reload");
    if (reload.status !== 0)
      throw new Error(`systemctl --user daemon-reload failed: ${reload.out}`);
  }
  const unit = unitName(paths);
  for (const args of [
    ["enable", unit],
    [changed || restart ? "restart" : "start", unit],
  ]) {
    const run = systemctl(...args);
    if (run.status !== 0)
      throw new Error(
        `systemctl --user ${args.join(" ")} failed: ${run.out}; see journalctl --user -u ${unit}`,
      );
  }
  return { changed };
}

/** `--stop`: stop the service and keep it from starting at the next login. */
export function stop(paths: Paths): void {
  if (!ours(paths)) return;
  const run = systemctl("disable", "--now", unitName(paths));
  if (run.status !== 0)
    throw new Error(`systemctl --user disable --now failed: ${run.out}`);
}

/** `--uninstall`: stop the service and remove its unit; configuration and state stay. */
export function uninstall(paths: Paths): void {
  if (!ours(paths)) return;
  stop(paths);
  rmSync(unitPath(paths), { force: true });
  systemctl("daemon-reload");
  systemctl("reset-failed", unitName(paths));
}

/** The unit's active state, and its automatic restarts since it was last started. */
export function unitHealth(paths: Paths): { active: string; restarts: number } {
  const unit = unitName(paths);
  return {
    active: systemctl("is-active", unit).out,
    restarts:
      Number(systemctl("show", "--property=NRestarts", "--value", unit).out) ||
      0,
  };
}

/** The unit's health when this installation has one; undefined without (no systemctl run). */
export function installedUnitHealth(
  paths: Paths,
): { active: string; restarts: number } | undefined {
  return ours(paths) ? unitHealth(paths) : undefined;
}

/** What `--check` reports. `serving` comes from the caller, which probes the lock. */
export function serviceState(
  repository: string,
  paths: Paths,
  serving: boolean,
): ServiceState {
  const unit = unitName(paths);
  const text = ours(paths);
  const installed = !!text;
  const linger = spawnSync(
    "loginctl",
    ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
    { encoding: "utf8", timeout: 10_000 },
  ).stdout?.trim();
  return {
    unit,
    path: unitPath(paths),
    installed,
    enabled: installed ? systemctl("is-enabled", unit).out : "not-found",
    active: installed ? systemctl("is-active", unit).out : "inactive",
    serving,
    credentials: boundCredentials(paths).map(({ name }) => name),
    current: text === unitText(repository, boundCredentials(paths)),
    linger: linger === "yes" || linger === "no" ? linger : "unknown",
  };
}
