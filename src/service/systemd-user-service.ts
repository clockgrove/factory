import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CONTROLLER_FATAL_EXIT_STATUS,
  controllerExecutableIdentity,
  controllerFatalAction,
  type ControllerFatalDiagnosticCode,
} from "../controller/failure.js";

const execFileAsync = promisify(execFile);
const FACTORY_UNIT_MARKER = "# Managed by Clockgrove Factory v2";
const SYSTEM_COMMAND_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
type CommandEnvironment = Readonly<{
  PATH?: string | undefined;
  FACTORY_CODEX_PATH?: string | undefined;
}>;
export interface SystemdServiceInput {
  repository: string;
  checkout: string;
  requestId?: string;
}
export interface SystemdStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  launcherCurrent: boolean;
  executableIdentity: string | null;
  currentExecutableIdentity: string | null;
  restartCount: number | null;
  fuseState: "armed" | "tripped" | "unavailable";
  lastSafeDiagnosticCode:
    | ControllerFatalDiagnosticCode
    | "controller-process-signal"
    | "controller-process-failure"
    | null;
  serviceResult: string | null;
  mainExitStatus: number | null;
  healthy: boolean;
  reasonCode:
    | "controller-not-installed"
    | "controller-unit-unmanaged"
    | "controller-launcher-stale"
    | "controller-disabled"
    | "controller-inactive"
    | ControllerFatalDiagnosticCode
    | null;
  action: string | null;
  unit: string;
}
export interface SystemdUserServiceOptions {
  /** Absolute command prefix used to launch the installed Factory bundle. */
  factoryCommand?: readonly [string, ...string[]];
  /** Backward-compatible shorthand for a one-element command. */
  factoryExecutable?: string;
  unitDirectory?: string;
  run?: (args: readonly string[]) => Promise<unknown>;
  /** Read at install time only; no credentials or unrelated environment are persisted. */
  commandEnvironment?: () => CommandEnvironment;
  /** A Type=simple service must remain active beyond systemctl's successful start request. */
  startupHealthDelayMs?: number;
}

export class SystemdUserService {
  readonly #command: readonly [string, ...string[]];
  readonly #directory: string;
  readonly #run: (args: readonly string[]) => Promise<unknown>;
  readonly #commandEnvironment: () => CommandEnvironment;
  readonly #startupHealthDelayMs: number;
  constructor(options: SystemdUserServiceOptions) {
    if (options.factoryCommand && options.factoryExecutable) {
      throw new Error("configure factoryCommand or factoryExecutable, not both");
    }
    const command =
      options.factoryCommand ??
      (options.factoryExecutable ? ([resolve(options.factoryExecutable)] as const) : undefined);
    if (!command || !isAbsolute(command[0])) {
      throw new Error("Factory service command must start with an absolute executable path");
    }
    if (command.some((part) => !part || /[\r\n]/.test(part))) {
      throw new Error("Factory service command contains an invalid argument");
    }
    this.#command = [...command] as [string, ...string[]];
    const config = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    if (!options.unitDirectory && !config)
      throw new Error("cannot determine systemd user unit directory");
    this.#directory = resolve(options.unitDirectory ?? join(config, "systemd/user"));
    this.#run = options.run ?? (async (args) => execFileAsync("systemctl", ["--user", ...args]));
    this.#commandEnvironment = options.commandEnvironment ?? (() => process.env);
    this.#startupHealthDelayMs = options.startupHealthDelayMs ?? 500;
    if (!Number.isFinite(this.#startupHealthDelayMs) || this.#startupHealthDelayMs < 0)
      throw new Error("startup health delay must be a finite nonnegative number");
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
    let old: string | undefined;
    try {
      old = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (old !== undefined && !old.startsWith(FACTORY_UNIT_MARKER)) {
      throw new Error(`refusing to overwrite unmanaged unit ${path}`);
    }
    const [environment, executableIdentity, commandAvailable] = await Promise.all([
      this.#discoverCommandEnvironment(),
      controllerExecutableIdentity(this.#artifactPath()),
      this.#commandAvailable(),
    ]);
    if (!executableIdentity || !commandAvailable) {
      throw new Error(
        "controller-launcher-failure: the exact Factory launch command is unavailable; restore it before installing the controller",
      );
    }
    const body = this.#unit(input, environment, executableIdentity);
    if (
      old !== undefined &&
      !old.split("\n").includes(this.#execStart(input, executableIdentity))
    ) {
      // Never arrange for an automatic restart to adopt different bytes while
      // the old service is running, stopping, or its state cannot be verified.
      const output = await this.#run([
        "show",
        this.unitName(input),
        "--property=ActiveState",
        "--no-pager",
      ]);
      const stdout = (output as { stdout?: unknown } | null)?.stdout;
      const state =
        typeof stdout === "string" || Buffer.isBuffer(stdout)
          ? parseSystemdProperties(stdout.toString()).ActiveState
          : undefined;
      if (state !== "inactive" && state !== "failed") {
        throw new Error(
          `controller-launcher-stale: ${this.unitName(input)}; settle work and owned resources, then stop the exact unit before refreshing its launcher (service state: ${state ?? "unknown"})`,
        );
      }
    }
    await mkdir(dirname(path), { recursive: true });
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
    await this.#requireCurrentLauncher(input);
    await this.#run(["start", this.unitName(input)]);
    await delay(this.#startupHealthDelayMs);
    const status = await this.status(input);
    if (!status.healthy)
      throw new Error(
        `controller-start-unhealthy: ${status.unit} failed its post-start health check (${status.reasonCode ?? "unknown"}); ${status.action ?? "inspect the user service"}`,
      );
    return status;
  }
  async stop(input: SystemdServiceInput): Promise<SystemdStatus> {
    await this.#bestEffort(["stop", this.unitName(input)]);
    const status = await this.status(input);
    if (status.active) throw new Error(`failed to stop ${status.unit}`);
    return status;
  }
  async restart(input: SystemdServiceInput): Promise<SystemdStatus> {
    await this.#requireCurrentLauncher(input);
    await this.#run(["restart", this.unitName(input)]);
    await delay(this.#startupHealthDelayMs);
    const status = await this.status(input);
    if (!status.healthy)
      throw new Error(
        `controller-restart-unhealthy: ${status.unit} failed its post-restart health check (${status.reasonCode ?? "unknown"}); ${status.action ?? "inspect the user service"}`,
      );
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
    let body: string | undefined;
    try {
      body = await readFile(this.unitPath(input), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const installed = body !== undefined;
    // Query systemd even after the file is removed: its manager may still
    // have a loaded or enabled unit, which uninstall must never conceal.
    const enabled = await this.#is(["is-enabled", "--quiet", this.unitName(input)]);
    const activeProbe = await this.#is(["is-active", "--quiet", this.unitName(input)]);
    const managed = body?.startsWith(FACTORY_UNIT_MARKER) ?? false;
    const executableIdentity = installedExecutableIdentity(body);
    const currentExecutableIdentity = await controllerExecutableIdentity(this.#artifactPath());
    const launcherCurrent = Boolean(
      managed &&
        body?.split("\n").includes(this.#execStart(input, executableIdentity)) &&
        body.includes(this.#execConditions()) &&
        executableIdentity &&
        executableIdentity === currentExecutableIdentity &&
        (await this.#commandAvailable()),
    );
    const runtime = await this.#runtimeState(input);
    const active = runtime.active ?? activeProbe;
    const fatalCode =
      !active && runtime.result === "exec-condition"
        ? "controller-launcher-failure"
        : !active && runtime.mainExitStatus !== null
          ? fatalCodeForExitStatus(runtime.mainExitStatus)
          : null;
    const lastSafeDiagnosticCode = fatalCode
      ? fatalCode
      : runtime.result === "signal" || runtime.result === "core-dump"
        ? "controller-process-signal"
        : runtime.result === "exit-code" && runtime.mainExitStatus !== null
          ? "controller-process-failure"
          : null;
    const reasonCode = !installed
      ? "controller-not-installed"
      : !managed
        ? "controller-unit-unmanaged"
        : !launcherCurrent
          ? "controller-launcher-stale"
          : fatalCode
            ? fatalCode
            : !enabled
              ? "controller-disabled"
              : !active
                ? "controller-inactive"
                : null;
    const action =
      reasonCode === "controller-not-installed"
        ? "install the repository controller"
        : reasonCode === "controller-unit-unmanaged"
          ? "resolve the unmanaged unit conflict before installing Factory"
          : reasonCode === "controller-launcher-stale"
            ? "preserve the installed generation until work and owned resources settle; then stop this exact unit, run controller install for this repository and checkout, and explicitly restart it"
            : reasonCode === "controller-disabled"
              ? "run the idempotent controller install operation to enable the unit"
              : fatalCode
                ? controllerFatalAction(fatalCode)
                : reasonCode === "controller-inactive"
                  ? "start the repository controller"
                  : null;
    return {
      installed,
      enabled,
      active,
      launcherCurrent,
      executableIdentity,
      currentExecutableIdentity,
      restartCount: runtime.restartCount,
      fuseState: !installed || !managed ? "unavailable" : fatalCode ? "tripped" : "armed",
      lastSafeDiagnosticCode,
      serviceResult: runtime.result,
      mainExitStatus: runtime.mainExitStatus,
      healthy: reasonCode === null,
      reasonCode,
      action,
      unit: this.unitName(input),
    };
  }
  async #runtimeState(input: SystemdServiceInput): Promise<{
    active: boolean | null;
    result: string | null;
    mainExitStatus: number | null;
    restartCount: number | null;
  }> {
    try {
      const output = await this.#run([
        "show",
        this.unitName(input),
        "--property=ActiveState,Result,ExecMainStatus,NRestarts",
        "--no-pager",
      ]);
      const stdout = (output as { stdout?: unknown } | null)?.stdout;
      if (typeof stdout !== "string" && !Buffer.isBuffer(stdout))
        return { active: null, result: null, mainExitStatus: null, restartCount: null };
      const fields = parseSystemdProperties(stdout.toString());
      return {
        active:
          fields.ActiveState === "active" ? true : fields.ActiveState === undefined ? null : false,
        result: fields.Result || null,
        mainExitStatus: nonNegativeInteger(fields.ExecMainStatus),
        restartCount: nonNegativeInteger(fields.NRestarts),
      };
    } catch {
      return { active: null, result: null, mainExitStatus: null, restartCount: null };
    }
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
  async #requireCurrentLauncher(input: SystemdServiceInput): Promise<void> {
    const status = await this.status(input);
    if (!status.installed) throw new Error(`${status.unit} is not installed`);
    if (!status.launcherCurrent)
      throw new Error(
        `${status.reasonCode ?? "controller-launcher-stale"}: ${status.unit}; ${status.action ?? "refresh the installed controller"}`,
      );
  }
  async #discoverCommandEnvironment(): Promise<string[]> {
    const environment = this.#commandEnvironment();
    // A service does not inherit a login shell's PATH. Retain only directories
    // that actually supply our command dependencies, never the whole shell PATH.
    const search = [
      ...new Set(
        (environment.PATH ?? "")
          .split(":")
          .filter(safeDirectory)
          .map((path) => resolve(path)),
      ),
    ];
    const find = async (name: string): Promise<string | undefined> => {
      for (const directory of search) {
        const path = join(directory, name);
        if (await executableFile(path)) return path;
      }
      return undefined;
    };
    const gh = await find("gh");
    const configured = environment.FACTORY_CODEX_PATH?.trim();
    let codex: string | undefined;
    if (configured) {
      if (unsafeEnvironmentValue(configured))
        throw new Error("configured Codex executable contains unsupported characters");
      codex = configured.includes("/") ? resolve(configured) : await find(configured);
      if (!codex || !safeDirectory(dirname(codex)) || !(await executableFile(codex))) {
        throw new Error("configured Codex executable is unavailable at service installation");
      }
    } else {
      codex = await find("codex");
    }
    const discovered = new Set([gh, codex].flatMap((path) => (path ? [dirname(path)] : [])));
    const directories = [
      // Preserve lookup precedence if both selected directories contain Codex or gh.
      ...search.filter((directory) => discovered.has(directory)),
      ...discovered,
      dirname(process.execPath),
      dirname(this.#command[0]),
      ...SYSTEM_COMMAND_DIRECTORIES,
    ];
    if (!directories.every(safeDirectory))
      throw new Error("service command directory contains unsupported characters");
    const assignments = [`PATH=${[...new Set(directories)].join(":")}`];
    // A custom basename or explicit pinned launcher cannot be represented by PATH alone.
    if (configured && codex) assignments.push(`FACTORY_CODEX_PATH=${codex}`);
    return assignments.map((assignment) => `Environment=${systemdQuote(assignment)}\n`);
  }
  #unit(
    input: SystemdServiceInput,
    environment: string[],
    executableIdentity: string | null,
  ): string {
    const checkout = resolve(input.checkout);
    const identity = executableIdentity
      ? `# FactoryExecutableIdentity=${executableIdentity}\n`
      : "";
    return `${FACTORY_UNIT_MARKER}\n[Unit]\nDescription=Clockgrove Factory repository controller for ${escapeDescription(input.repository)}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdDirectivePath(checkout)}\n${environment.join("")}${identity}${this.#execConditions()}${this.#execStart(input, executableIdentity)}\nRestart=on-failure\nRestartPreventExitStatus=2 65 70 72 78 130 203\nRestartSec=30\nTimeoutStopSec=90\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
  }
  #execConditions(): string {
    // These checks live in the unit, outside the disposable plugin generation.
    // ExecCondition exit 1 skips startup without triggering Restart=on-failure.
    // If eviction races ExecStart, the next attempt stops here. Do not classify
    // Node's generic exit 1 as fatal: ordinary controller crashes remain retryable.
    return this.#command
      .flatMap((part, index) =>
        isAbsolute(part)
          ? ["-f", index === 0 ? "-x" : "-r"].map(
              (flag) => `ExecCondition=:/usr/bin/test ${flag} ${systemdQuote(part)}\n`,
            )
          : [],
      )
      .join("");
  }
  #execStart(input: SystemdServiceInput, executableIdentity?: string | null): string {
    const command = this.#command.map(systemdQuote).join(" ");
    const identity = executableIdentity
      ? ` --executable-identity ${systemdQuote(executableIdentity)}`
      : "";
    return `ExecStart=${command} controller run ${systemdQuote(input.repository)} --repo ${systemdQuote(resolve(input.checkout))}${identity}`;
  }
  async #commandAvailable(): Promise<boolean> {
    for (const [index, part] of this.#command.entries()) {
      if (!isAbsolute(part)) continue;
      try {
        await access(part, index === 0 ? fsConstants.X_OK : fsConstants.R_OK);
        if (!(await stat(part)).isFile()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  #artifactPath(): string {
    return [...this.#command].reverse().find((part) => isAbsolute(part)) ?? this.#command[0];
  }
}

function installedExecutableIdentity(body: string | undefined): string | null {
  const match = body?.match(/^# FactoryExecutableIdentity=(sha256:[a-f0-9]{64})$/m);
  return match?.[1] ?? null;
}

function fatalCodeForExitStatus(status: number): ControllerFatalDiagnosticCode | null {
  for (const [code, exitStatus] of Object.entries(CONTROLLER_FATAL_EXIT_STATUS)) {
    if (exitStatus === status) return code as ControllerFatalDiagnosticCode;
  }
  return null;
}

function parseSystemdProperties(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (!/^\d+$/.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function unsafeEnvironmentValue(value: string): boolean {
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}
function safeDirectory(value: string): boolean {
  return isAbsolute(value) && !value.includes(":") && !unsafeEnvironmentValue(value);
}
async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function validateInput(input: SystemdServiceInput): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository))
    throw new Error("repository must be OWNER/REPO");
  if (!isAbsolute(input.checkout)) throw new Error("checkout must be an absolute path");
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
      (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}
function escapeDescription(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}
