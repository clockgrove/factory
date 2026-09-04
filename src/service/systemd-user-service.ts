import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FACTORY_UNIT_MARKER = "# Managed by Clockgrove Factory v2";
export interface SystemdServiceInput {
  repository: string;
  checkout: string;
  requestId?: string;
}
export interface SystemdStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  unit: string;
}
export interface SystemdUserServiceOptions {
  /** Absolute command prefix used to launch the installed Factory bundle. */
  factoryCommand?: readonly [string, ...string[]];
  /** Backward-compatible shorthand for a one-element command. */
  factoryExecutable?: string;
  unitDirectory?: string;
  run?: (args: readonly string[]) => Promise<unknown>;
}

export class SystemdUserService {
  readonly #command: readonly [string, ...string[]];
  readonly #directory: string;
  readonly #run: (args: readonly string[]) => Promise<unknown>;
  constructor(options: SystemdUserServiceOptions) {
    if (options.factoryCommand && options.factoryExecutable) {
      throw new Error(
        "configure factoryCommand or factoryExecutable, not both",
      );
    }
    const command =
      options.factoryCommand ??
      (options.factoryExecutable
        ? ([resolve(options.factoryExecutable)] as const)
        : undefined);
    if (!command || !isAbsolute(command[0])) {
      throw new Error(
        "Factory service command must start with an absolute executable path",
      );
    }
    if (command.some((part) => !part || /[\r\n]/.test(part))) {
      throw new Error("Factory service command contains an invalid argument");
    }
    this.#command = [...command] as [string, ...string[]];
    const config =
      process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    if (!options.unitDirectory && !config)
      throw new Error("cannot determine systemd user unit directory");
    this.#directory = resolve(
      options.unitDirectory ?? join(config, "systemd/user"),
    );
    this.#run =
      options.run ??
      (async (args) => execFileAsync("systemctl", ["--user", ...args]));
  }

  unitName(input: SystemdServiceInput): string {
    const key = `${input.repository.toLowerCase()}\0${resolve(input.checkout)}`;
    return `clockgrove-factory-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.service`;
  }
  unitPath(input: SystemdServiceInput): string {
    return join(this.#directory, this.unitName(input));
  }

  async install(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const path = this.unitPath(input);
    const body = this.#unit(input);
    await mkdir(dirname(path), { recursive: true });
    let old: string | undefined;
    try {
      old = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      old !== undefined &&
      old !== body &&
      !old.startsWith(FACTORY_UNIT_MARKER)
    ) {
      throw new Error(`refusing to overwrite unmanaged unit ${path}`);
    }
    if (old !== body) {
      const temporary = `${path}.tmp-${process.pid}`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, path);
    }
    await this.#run(["daemon-reload"]);
    await this.#run(["enable", this.unitName(input)]);
    const status = await this.status(input);
    if (!status.installed || !status.enabled)
      throw new Error(`failed to install and enable ${status.unit}`);
    return status;
  }
  async start(input: SystemdServiceInput): Promise<SystemdStatus> {
    await this.#requireInstalled(input);
    await this.#run(["start", this.unitName(input)]);
    const status = await this.status(input);
    if (!status.active) throw new Error(`failed to start ${status.unit}`);
    return status;
  }
  async stop(input: SystemdServiceInput): Promise<SystemdStatus> {
    await this.#bestEffort(["stop", this.unitName(input)]);
    const status = await this.status(input);
    if (status.active) throw new Error(`failed to stop ${status.unit}`);
    return status;
  }
  async restart(input: SystemdServiceInput): Promise<SystemdStatus> {
    await this.#requireInstalled(input);
    await this.#run(["restart", this.unitName(input)]);
    const status = await this.status(input);
    if (!status.active) throw new Error(`failed to restart ${status.unit}`);
    return status;
  }
  async uninstall(input: SystemdServiceInput): Promise<SystemdStatus> {
    const unit = this.unitName(input);
    // Both commands are idempotent for an absent/inactive unit with --quiet.
    await this.#bestEffort(["stop", unit]);
    await this.#bestEffort(["disable", unit]);
    await rm(this.unitPath(input), { force: true });
    await this.#run(["daemon-reload"]);
    await this.#run(["reset-failed", unit]).catch(() => undefined);
    const status = await this.status(input);
    if (status.installed || status.enabled || status.active)
      throw new Error(`failed to completely uninstall ${status.unit}`);
    return status;
  }
  async status(input: SystemdServiceInput): Promise<SystemdStatus> {
    const installed = await exists(this.unitPath(input));
    // Query systemd even after the file is removed: its manager may still
    // have a loaded or enabled unit, which uninstall must never conceal.
    const enabled = await this.#is([
      "is-enabled",
      "--quiet",
      this.unitName(input),
    ]);
    const active = await this.#is([
      "is-active",
      "--quiet",
      this.unitName(input),
    ]);
    return { installed, enabled, active, unit: this.unitName(input) };
  }
  async #is(args: readonly string[]): Promise<boolean> {
    try {
      await this.#run(args);
      return true;
    } catch {
      return false;
    }
  }
  async #bestEffort(args: readonly string[]): Promise<void> {
    try {
      await this.#run(args);
    } catch {
      /* desired state is verified below */
    }
  }
  async #requireInstalled(input: SystemdServiceInput): Promise<void> {
    if (!(await exists(this.unitPath(input))))
      throw new Error(`${this.unitName(input)} is not installed`);
  }
  #unit(input: SystemdServiceInput): string {
    const checkout = resolve(input.checkout);
    const command = this.#command.map(systemdQuote).join(" ");
    return `${FACTORY_UNIT_MARKER}\n[Unit]\nDescription=Clockgrove Factory repository controller for ${escapeDescription(input.repository)}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdDirectivePath(checkout)}\nExecStart=${command} controller run ${systemdQuote(input.repository)} --repo ${systemdQuote(checkout)}\nRestart=on-failure\nRestartPreventExitStatus=2 130\nRestartSec=30\nTimeoutStopSec=90\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function validateInput(input: SystemdServiceInput): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository))
    throw new Error("repository must be OWNER/REPO");
  if (!isAbsolute(input.checkout))
    throw new Error("checkout must be an absolute path");
}
function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function systemdDirectivePath(value: string): string {
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replace(
      /[\s"]/g,
      (character) =>
        `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}
function escapeDescription(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}
