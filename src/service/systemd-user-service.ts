import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
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
const SYSTEMCTL = "/usr/bin/systemctl";
const MINIMUM_SYSTEMD_VERSION = 254;
const STATUS_PROPERTIES = [
  "Id",
  "LoadState",
  "UnitFileState",
  "ActiveState",
  "Result",
  "ExecMainStatus",
  "NRestarts",
].join(",");
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
  FACTORY_MANAGEMENT_TRANSCRIPT_DIR?: string | undefined;
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
  run?: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<unknown>;
  /** Test seam. Production CLI/MCP transports always use verified current-user runtime facts. */
  currentUserManager?: () => Promise<CurrentUserManager>;
  /** Read at install time only; no credentials or unrelated environment are persisted. */
  commandEnvironment?: () => CommandEnvironment;
  /** A Type=simple service must remain active beyond systemctl's successful start request. */
  startupHealthDelayMs?: number;
}

interface CurrentUserManager {
  uid: number;
  runtimeDirectory: string;
  environment: NodeJS.ProcessEnv;
}

interface UnitManagerState {
  id: string;
  loadState: string;
  unitFileState: string;
  activeState: string;
  result: string | null;
  mainExitStatus: number | null;
  restartCount: number | null;
}

type ActiveStateClassification = "active" | "stopped" | "unsettled";
type UnitFileStateClassification =
  | "enabled"
  | "runtime-enabled"
  | "linked"
  | "alias"
  | "disabled"
  | "unknown";

interface InstalledLauncher {
  command: readonly [string, ...string[]];
  executableIdentity: string;
  guarded: boolean;
  available: boolean;
  artifactCurrent: boolean;
}

export class SystemdUserService {
  readonly #command: readonly [string, ...string[]];
  readonly #directory: string;
  readonly #run: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly #currentUserManager: () => Promise<CurrentUserManager>;
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
    this.#run =
      options.run ??
      (async (args, environment) =>
        execFileAsync(SYSTEMCTL, ["--user", ...args], { env: environment }));
    this.#currentUserManager = options.currentUserManager ?? resolveCurrentUserManager;
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
    const old = await readOptionalFile(path);
    if (old !== undefined && !old.startsWith(FACTORY_UNIT_MARKER)) {
      throw new Error(`refusing to overwrite unmanaged unit ${path}`);
    }
    const [environment, executableIdentity, commandAvailable, installedLauncher] =
      await Promise.all([
        this.#discoverCommandEnvironment(),
        controllerExecutableIdentity(this.#artifactPath()),
        this.#commandAvailable(),
        old === undefined ? undefined : this.#installedLauncher(input, old),
      ]);
    if (!executableIdentity || !commandAvailable) {
      throw new Error(
        "controller-launcher-failure: the exact Factory launch command is unavailable; restore it before installing the controller",
      );
    }
    const manager = await this.#connectUserManager("install", input);
    const before = await this.#managerState(input, manager, "install");
    const beforeActiveState = classifyActiveState(before.activeState);
    const beforeUnitFileState = classifyUnitFileState(before.unitFileState);
    if (beforeActiveState === "unsettled" || beforeUnitFileState === "unknown") {
      throw new Error(
        `controller-lifecycle-outcome-unknown: install cannot safely mutate ${this.unitName(input)} while systemd reports ActiveState=${before.activeState} and UnitFileState=${before.unitFileState || "(empty)"}; ${this.#inspectionAction(input)}`,
      );
    }
    if (unmanagedUnitFileState(beforeUnitFileState)) {
      throw new Error(
        `controller-unit-unmanaged: ${this.unitName(input)} has UnitFileState=${before.unitFileState}, which Factory never creates or owns; ${this.#inspectionAction(input)}`,
      );
    }
    if (
      old === undefined &&
      (before.loadState !== "not-found" ||
        beforeUnitFileState !== "disabled" ||
        beforeActiveState === "active")
    ) {
      throw new Error(
        `controller-unit-unmanaged: ${this.unitName(input)} has manager state without an owned unit file; ${this.#inspectionAction(input)}`,
      );
    }
    const retainedCommand =
      installedLauncher?.available &&
      installedLauncher.artifactCurrent &&
      installedLauncher.executableIdentity === executableIdentity
        ? installedLauncher.command
        : this.#command;
    const body = this.#unit(input, environment, executableIdentity, retainedCommand);
    if (
      old !== undefined &&
      !old.split("\n").includes(this.#execStart(input, executableIdentity, retainedCommand))
    ) {
      // Never arrange for an automatic restart to adopt different bytes while
      // the old service is running, stopping, or its state cannot be verified.
      if (before.activeState !== "inactive" && before.activeState !== "failed") {
        throw new Error(
          `controller-launcher-stale: ${this.unitName(input)}; settle work and owned resources, then stop the exact unit before refreshing its launcher (service state: ${before.activeState})`,
        );
      }
    }
    let mutationAttempted = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      if (old !== body) {
        await atomicWrite(path, body);
        mutationAttempted = true;
      }
      mutationAttempted = true;
      await this.#systemctl(["daemon-reload"], manager);
      if (!persistentlyEnabledUnitFileState(before.unitFileState)) {
        await this.#systemctl(["enable", this.unitName(input)], manager);
      }
      const [installedBody, installedState] = await Promise.all([
        readOptionalFile(path),
        this.#managerState(input, manager, "install verification"),
      ]);
      const status = await this.#statusFrom(input, installedBody, installedState);
      if (!status.installed || !persistentlyEnabledUnitFileState(installedState.unitFileState)) {
        throw new Error(`failed to install and enable ${status.unit}`);
      }
      return status;
    } catch (error) {
      if (!mutationAttempted) throw error;
      return this.#rollbackInstall(input, manager, old, before, error);
    }
  }
  async start(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const manager = await this.#connectUserManager("start", input);
    await this.#requireCurrentLauncher(input, manager);
    await this.#systemctl(["start", this.unitName(input)], manager);
    await delay(this.#startupHealthDelayMs);
    const status = await this.#status(input, manager);
    if (!status.healthy)
      throw new Error(
        `controller-start-unhealthy: ${status.unit} failed its post-start health check (${status.reasonCode ?? "unknown"}); ${status.action ?? "inspect the user service"}`,
      );
    return status;
  }
  async stop(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const manager = await this.#connectUserManager("stop", input);
    const [beforeBody, beforeState] = await Promise.all([
      readOptionalFile(this.unitPath(input)),
      this.#managerState(input, manager, "stop"),
    ]);
    const beforeUnitFileState = classifyUnitFileState(beforeState.unitFileState);
    if (unmanagedUnitFileState(beforeUnitFileState)) {
      throw new Error(
        `controller-unit-unmanaged: ${this.unitName(input)} has UnitFileState=${beforeState.unitFileState}, which Factory never creates or owns; ${this.#inspectionAction(input)}`,
      );
    }
    if (beforeUnitFileState === "unknown") {
      throw new Error(
        `controller-lifecycle-outcome-unknown: stop cannot safely mutate ${this.unitName(input)} while systemd reports UnitFileState=${beforeState.unitFileState || "(empty)"}; ${this.#inspectionAction(input)}`,
      );
    }
    if (classifyActiveState(beforeState.activeState) === "stopped") {
      return this.#statusFrom(input, beforeBody, beforeState);
    }
    await this.#systemctl(["stop", this.unitName(input)], manager);
    const [body, state] = await Promise.all([
      readOptionalFile(this.unitPath(input)),
      this.#managerState(input, manager, "stop verification"),
    ]);
    if (classifyActiveState(state.activeState) !== "stopped") {
      throw new Error(
        `controller-lifecycle-outcome-unknown: stop did not settle ${this.unitName(input)} (systemd reports ActiveState=${state.activeState}); ${this.#inspectionAction(input)}`,
      );
    }
    return this.#statusFrom(input, body, state);
  }
  async restart(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const manager = await this.#connectUserManager("restart", input);
    await this.#requireCurrentLauncher(input, manager);
    await this.#systemctl(["restart", this.unitName(input)], manager);
    await delay(this.#startupHealthDelayMs);
    const status = await this.#status(input, manager);
    if (!status.healthy)
      throw new Error(
        `controller-restart-unhealthy: ${status.unit} failed its post-restart health check (${status.reasonCode ?? "unknown"}); ${status.action ?? "inspect the user service"}`,
      );
    return status;
  }
  async uninstall(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const unit = this.unitName(input);
    const path = this.unitPath(input);
    const old = await readOptionalFile(path);
    if (old !== undefined && !old.startsWith(FACTORY_UNIT_MARKER)) {
      throw new Error(`refusing to remove unmanaged unit ${path}`);
    }
    const manager = await this.#connectUserManager("uninstall", input);
    const beforeState = await this.#managerState(input, manager, "uninstall");
    const beforeActiveState = classifyActiveState(beforeState.activeState);
    const beforeUnitFileState = classifyUnitFileState(beforeState.unitFileState);
    if (beforeActiveState === "unsettled") {
      throw new Error(
        `controller-lifecycle-busy: ${unit} cannot be uninstalled while systemd reports ActiveState=${beforeState.activeState}; ${this.#inspectionAction(input)}`,
      );
    }
    if (unmanagedUnitFileState(beforeUnitFileState)) {
      throw new Error(
        `controller-unit-unmanaged: ${unit} has UnitFileState=${beforeState.unitFileState}, which Factory never creates or owns; ${this.#inspectionAction(input)}`,
      );
    }
    const before = await this.#statusFrom(input, old, beforeState);
    if (
      !old &&
      (beforeUnitFileState !== "disabled" || before.active || beforeState.loadState !== "not-found")
    ) {
      throw new Error(
        `controller-unit-unmanaged: ${unit} has manager state without an owned unit file; ${this.#inspectionAction(input)}`,
      );
    }
    if (!old && !before.enabled && !before.active) return before;
    let mutationAttempted = false;
    let runtimeContinuityLost = false;
    try {
      if (before.active) {
        mutationAttempted = true;
        runtimeContinuityLost = true;
        await this.#systemctl(["stop", unit], manager);
      }
      const disableArguments = disableUnitFileStateArguments(beforeState.unitFileState, unit);
      if (disableArguments) {
        mutationAttempted = true;
        await this.#systemctl(disableArguments, manager);
      }
      mutationAttempted = true;
      await rm(path, { force: true });
      await this.#systemctl(["daemon-reload"], manager);
      let afterState = await this.#managerState(input, manager, "uninstall");
      if (
        afterState.loadState !== "not-found" &&
        (beforeState.activeState === "failed" ||
          (beforeState.result !== null && beforeState.result !== "success"))
      ) {
        runtimeContinuityLost = true;
        await this.#systemctl(["reset-failed", unit], manager);
        await this.#systemctl(["daemon-reload"], manager);
        afterState = await this.#managerState(input, manager, "uninstall");
      }
      const body = await readOptionalFile(path);
      const status = await this.#statusFrom(input, body, afterState);
      if (
        status.installed ||
        status.enabled ||
        status.active ||
        afterState.loadState !== "not-found"
      ) {
        throw new Error(`failed to completely uninstall ${status.unit}`);
      }
      return status;
    } catch (error) {
      if (!mutationAttempted) throw error;
      return this.#rollbackUninstall(
        input,
        manager,
        old!,
        beforeState,
        before,
        runtimeContinuityLost,
        error,
      );
    }
  }
  async status(input: SystemdServiceInput): Promise<SystemdStatus> {
    validateInput(input);
    const manager = await this.#connectUserManager("status", input);
    return this.#status(input, manager);
  }
  async #status(input: SystemdServiceInput, manager: CurrentUserManager): Promise<SystemdStatus> {
    const body = await readOptionalFile(this.unitPath(input));
    const runtime = await this.#managerState(input, manager, "status");
    return this.#statusFrom(input, body, runtime);
  }
  async #statusFrom(
    input: SystemdServiceInput,
    body: string | undefined,
    runtime: UnitManagerState,
  ): Promise<SystemdStatus> {
    const activeState = classifyActiveState(runtime.activeState);
    const unitFileState = classifyUnitFileState(runtime.unitFileState);
    if (activeState === "unsettled" || unitFileState === "unknown") {
      throw new Error(
        `controller-lifecycle-outcome-unknown: systemd reports ActiveState=${runtime.activeState} and UnitFileState=${runtime.unitFileState || "(empty)"} for ${this.unitName(input)}; ${this.#inspectionAction(input)}`,
      );
    }
    const installed = body !== undefined;
    const enabled = unitFileState === "enabled" || unitFileState === "runtime-enabled";
    const active = activeState === "active";
    const managerStatePresent =
      runtime.loadState !== "not-found" || unitFileState !== "disabled" || active;
    const managed =
      !unmanagedUnitFileState(unitFileState) && (body?.startsWith(FACTORY_UNIT_MARKER) ?? false);
    const executableIdentity = installedExecutableIdentity(body);
    const currentExecutableIdentity = await controllerExecutableIdentity(this.#artifactPath());
    const installedLauncher = managed && body ? await this.#installedLauncher(input, body) : null;
    const launcherCurrent = Boolean(
      installedLauncher?.guarded &&
        installedLauncher.available &&
        installedLauncher.artifactCurrent &&
        installedLauncher.executableIdentity === currentExecutableIdentity,
    );
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
    const reasonCode =
      !installed && managerStatePresent
        ? "controller-unit-unmanaged"
        : !installed
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
  async #requireCurrentLauncher(
    input: SystemdServiceInput,
    manager: CurrentUserManager,
  ): Promise<void> {
    const status = await this.#status(input, manager);
    if (!status.installed) throw new Error(`${status.unit} is not installed`);
    if (!status.launcherCurrent)
      throw new Error(
        `${status.reasonCode ?? "controller-launcher-stale"}: ${status.unit}; ${status.action ?? "refresh the installed controller"}`,
      );
    if (!status.enabled)
      throw new Error(
        `${status.reasonCode ?? "controller-disabled"}: ${status.unit}; ${status.action ?? "enable the installed controller"}`,
      );
  }
  async #connectUserManager(
    operation: ControllerLifecycleOperation,
    input: SystemdServiceInput,
  ): Promise<CurrentUserManager> {
    let manager: CurrentUserManager;
    try {
      manager = await this.#currentUserManager();
      const uid = process.getuid?.();
      const runtimeDirectory = uid === undefined ? undefined : `/run/user/${uid}`;
      if (
        uid === undefined ||
        manager.uid !== uid ||
        manager.runtimeDirectory !== runtimeDirectory
      ) {
        throw new Error("current-user runtime facts do not match the effective Linux uid");
      }
      manager = { uid, runtimeDirectory, environment: managerEnvironment(uid) };
      const output = await this.#systemctl(
        ["show", "--property=Version", "--value", "--no-pager"],
        manager,
      );
      const version = outputText(output).trim();
      const major = /^(\d+)/.exec(version)?.[1];
      if (!major || Number(major) < MINIMUM_SYSTEMD_VERSION) {
        throw new Error(
          `systemd ${version || "version unavailable"} is older than required ${MINIMUM_SYSTEMD_VERSION}`,
        );
      }
      return manager;
    } catch (error) {
      const uid = process.getuid?.();
      throw new Error(
        `controller-user-manager-unavailable: cannot verify the current Linux user's systemd user manager${uid === undefined ? "" : ` (uid ${uid})`}: ${errorMessage(error)}; from a Linux/WSL terminal as this same user, first run ${SYSTEMCTL} --user show --property=Version --value --no-pager, then run ${this.#hostCommand(operation, input)}`,
      );
    }
  }
  async #systemctl(args: readonly string[], manager: CurrentUserManager): Promise<unknown> {
    return this.#run(args, manager.environment);
  }
  async #managerState(
    input: SystemdServiceInput,
    manager: CurrentUserManager,
    operation: string,
  ): Promise<UnitManagerState> {
    let output: unknown;
    try {
      output = await this.#systemctl(
        ["show", this.unitName(input), `--property=${STATUS_PROPERTIES}`, "--no-pager"],
        manager,
      );
    } catch (error) {
      // systemctl exits nonzero for an absent unit while still returning a
      // complete LoadState=not-found observation. No other failure is state.
      if (!hasOutputText(error)) {
        throw new Error(
          `controller-user-manager-unavailable: ${operation} could not inspect ${this.unitName(input)} through the verified current-user manager: ${errorMessage(error)}; ${this.#inspectionAction(input)}`,
        );
      }
      output = error;
    }
    const fields = parseSystemdProperties(outputText(output));
    const unit = this.unitName(input);
    if (
      fields.Id !== unit ||
      !fields.LoadState ||
      fields.UnitFileState === undefined ||
      !fields.ActiveState ||
      fields.Result === undefined ||
      fields.ExecMainStatus === undefined ||
      fields.NRestarts === undefined
    ) {
      throw new Error(
        `controller-lifecycle-outcome-unknown: systemd returned a malformed or mismatched observation for ${unit}; ${this.#inspectionAction(input)}`,
      );
    }
    return {
      id: fields.Id,
      loadState: fields.LoadState,
      unitFileState: fields.UnitFileState,
      activeState: fields.ActiveState,
      result: fields.Result || null,
      mainExitStatus: nonNegativeInteger(fields.ExecMainStatus),
      restartCount: nonNegativeInteger(fields.NRestarts),
    };
  }
  async #installedLauncher(
    input: SystemdServiceInput,
    body: string,
  ): Promise<InstalledLauncher | null> {
    const identity = installedExecutableIdentity(body);
    const lines = body.split("\n");
    const starts = lines.filter((line) => line.startsWith("ExecStart="));
    if (!identity || starts.length !== 1) return null;
    const tokens = parseSystemdWords(starts[0]!.slice("ExecStart=".length));
    if (!tokens || tokens.length < 8) return null;
    const suffix = tokens.slice(-7);
    if (
      suffix[0] !== "controller" ||
      suffix[1] !== "run" ||
      suffix[2] !== input.repository ||
      suffix[3] !== "--repo" ||
      suffix[4] !== resolve(input.checkout) ||
      suffix[5] !== "--executable-identity" ||
      suffix[6] !== identity
    ) {
      return null;
    }
    const command = tokens.slice(0, -7);
    if (command.length === 0 || !isAbsolute(command[0]!)) return null;
    const installedCommand = command as [string, ...string[]];
    const artifactPath = this.#artifactPath(installedCommand);
    const [available, actualIdentity] = await Promise.all([
      this.#commandAvailable(installedCommand),
      controllerExecutableIdentity(artifactPath),
    ]);
    const conditions = lines
      .filter((line) => line.startsWith("ExecCondition="))
      .map((line) => `${line}\n`)
      .join("");
    const guarded =
      lines.filter((line) => line.startsWith("WorkingDirectory=")).length === 1 &&
      lines.includes(`WorkingDirectory=${systemdDirectivePath(resolve(input.checkout))}`) &&
      conditions === this.#execConditions(installedCommand);
    return {
      command: installedCommand,
      executableIdentity: identity,
      guarded,
      available,
      artifactCurrent: actualIdentity === identity,
    };
  }
  #hostCommand(operation: ControllerLifecycleOperation, input: SystemdServiceInput): string {
    const requestId =
      input.requestId ?? `cli:${operation}:${input.repository}:${resolve(input.checkout)}`;
    return [
      ...this.#command,
      "controller",
      operation,
      input.repository,
      "--repo",
      resolve(input.checkout),
      "--request-id",
      requestId,
    ]
      .map(shellQuote)
      .join(" ");
  }
  #inspectionAction(input: SystemdServiceInput): string {
    return `from a Linux/WSL terminal as this same user, run ${SYSTEMCTL} --user show ${shellQuote(this.unitName(input))} --property=${STATUS_PROPERTIES} --no-pager`;
  }
  async #rollbackInstall(
    input: SystemdServiceInput,
    manager: CurrentUserManager,
    old: string | undefined,
    before: UnitManagerState,
    cause: unknown,
  ): Promise<never> {
    const unit = this.unitName(input);
    const path = this.unitPath(input);
    const repairErrors: string[] = [];
    const repair = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        repairErrors.push(errorMessage(error));
      }
    };
    if (!persistentlyEnabledUnitFileState(before.unitFileState)) {
      await repair(() => this.#systemctl(["disable", unit], manager));
    }
    await repair(async () => {
      if (old === undefined) await rm(path, { force: true });
      else await atomicWrite(path, old);
    });
    await repair(() => this.#systemctl(["daemon-reload"], manager));
    if (enabledUnitFileState(before.unitFileState)) {
      await repair(() =>
        this.#systemctl(
          runtimeEnabledUnitFileState(before.unitFileState)
            ? ["enable", "--runtime", unit]
            : ["enable", unit],
          manager,
        ),
      );
    }
    let restored = false;
    try {
      const [body, state] = await Promise.all([
        readOptionalFile(path),
        this.#managerState(input, manager, "install rollback"),
      ]);
      restored =
        body === old &&
        state.unitFileState === before.unitFileState &&
        state.activeState === before.activeState &&
        (old !== undefined || state.loadState === "not-found");
    } catch (error) {
      repairErrors.push(errorMessage(error));
    }
    if (!restored || repairErrors.length > 0) {
      throw new Error(
        `controller-lifecycle-outcome-unknown: install failed (${errorMessage(cause)}) and rollback could not be verified${repairErrors.length ? ` (${repairErrors.join("; ")})` : ""}; ${this.#inspectionAction(input)}`,
      );
    }
    throw new Error(
      `controller-install-failed: ${errorMessage(cause)}; the prior unit state was restored and verified; ${this.#inspectionAction(input)}`,
    );
  }
  async #rollbackUninstall(
    input: SystemdServiceInput,
    manager: CurrentUserManager,
    old: string,
    beforeState: UnitManagerState,
    beforeStatus: SystemdStatus,
    runtimeContinuityLost: boolean,
    cause: unknown,
  ): Promise<never> {
    const unit = this.unitName(input);
    const path = this.unitPath(input);
    const repairErrors: string[] = [];
    const repair = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        repairErrors.push(errorMessage(error));
      }
    };
    await repair(() => atomicWrite(path, old));
    await repair(() => this.#systemctl(["daemon-reload"], manager));
    await repair(() =>
      this.#systemctl(
        runtimeEnabledUnitFileState(beforeState.unitFileState)
          ? ["enable", "--runtime", unit]
          : [beforeStatus.enabled ? "enable" : "disable", unit],
        manager,
      ),
    );
    if (beforeStatus.active) {
      await repair(() => this.#systemctl(["start", unit], manager));
    }
    let restored = false;
    try {
      const [body, state] = await Promise.all([
        readOptionalFile(path),
        this.#managerState(input, manager, "uninstall rollback"),
      ]);
      restored =
        body === old &&
        state.unitFileState === beforeState.unitFileState &&
        state.activeState === beforeState.activeState;
    } catch (error) {
      repairErrors.push(errorMessage(error));
    }
    if (!restored || repairErrors.length > 0 || runtimeContinuityLost) {
      throw new Error(
        `controller-lifecycle-outcome-unknown: uninstall failed (${errorMessage(cause)}) and ${runtimeContinuityLost ? "the original controller process or failure state cannot be restored" : "rollback could not be verified"}${restored && repairErrors.length === 0 ? "; unit file, enablement, and active-state repair was verified" : ""}${repairErrors.length ? ` (${repairErrors.join("; ")})` : ""}; ${this.#inspectionAction(input)}`,
      );
    }
    throw new Error(
      `controller-uninstall-failed: ${errorMessage(cause)}; the prior unit state was restored and verified; ${this.#inspectionAction(input)}`,
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
    const transcriptDirectory = environment.FACTORY_MANAGEMENT_TRANSCRIPT_DIR?.trim();
    if (transcriptDirectory) {
      if (!isAbsolute(transcriptDirectory) || unsafeEnvironmentValue(transcriptDirectory)) {
        throw new Error("management transcript directory must be a safe absolute path");
      }
      assignments.push(`FACTORY_MANAGEMENT_TRANSCRIPT_DIR=${resolve(transcriptDirectory)}`);
    }
    return assignments.map((assignment) => `Environment=${systemdQuote(assignment)}\n`);
  }
  #unit(
    input: SystemdServiceInput,
    environment: string[],
    executableIdentity: string | null,
    command: readonly [string, ...string[]] = this.#command,
  ): string {
    const checkout = resolve(input.checkout);
    const identity = executableIdentity
      ? `# FactoryExecutableIdentity=${executableIdentity}\n`
      : "";
    return `${FACTORY_UNIT_MARKER}\n[Unit]\nDescription=Clockgrove Factory repository controller for ${escapeDescription(input.repository)}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdDirectivePath(checkout)}\n${environment.join("")}${identity}${this.#execConditions(command)}${this.#execStart(input, executableIdentity, command)}\nRestart=on-failure\nRestartPreventExitStatus=2 65 70 72 78 130 203\nRestartSec=30\nTimeoutStopSec=90\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
  }
  #execConditions(command: readonly [string, ...string[]] = this.#command): string {
    // These checks live in the unit, outside the disposable plugin generation.
    // ExecCondition exit 1 skips startup without triggering Restart=on-failure.
    // If eviction races ExecStart, the next attempt stops here. Do not classify
    // Node's generic exit 1 as fatal: ordinary controller crashes remain retryable.
    return command
      .flatMap((part, index) =>
        isAbsolute(part)
          ? ["-f", index === 0 ? "-x" : "-r"].map(
              (flag) => `ExecCondition=:/usr/bin/test ${flag} ${systemdQuote(part)}\n`,
            )
          : [],
      )
      .join("");
  }
  #execStart(
    input: SystemdServiceInput,
    executableIdentity?: string | null,
    command: readonly [string, ...string[]] = this.#command,
  ): string {
    const launcher = command.map(systemdQuote).join(" ");
    const identity = executableIdentity
      ? ` --executable-identity ${systemdQuote(executableIdentity)}`
      : "";
    return `ExecStart=${launcher} controller run ${systemdQuote(input.repository)} --repo ${systemdQuote(resolve(input.checkout))}${identity}`;
  }
  async #commandAvailable(
    command: readonly [string, ...string[]] = this.#command,
  ): Promise<boolean> {
    for (const [index, part] of command.entries()) {
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
  #artifactPath(command: readonly [string, ...string[]] = this.#command): string {
    return [...command].reverse().find((part) => isAbsolute(part)) ?? command[0];
  }
}

type ControllerLifecycleOperation =
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "install"
  | "uninstall";

async function resolveCurrentUserManager(): Promise<CurrentUserManager> {
  if (process.platform !== "linux" || !process.getuid) {
    throw new Error("a Linux effective user id is unavailable");
  }
  const uid = process.getuid();
  const runtimeDirectory = `/run/user/${uid}`;
  const bus = `${runtimeDirectory}/bus`;
  const [runtimeFacts, busFacts] = await Promise.all([lstat(runtimeDirectory), lstat(bus)]);
  if (
    !runtimeFacts.isDirectory() ||
    runtimeFacts.uid !== uid ||
    (runtimeFacts.mode & 0o077) !== 0
  ) {
    throw new Error(`${runtimeDirectory} is not a private runtime directory owned by uid ${uid}`);
  }
  if (!busFacts.isSocket() || busFacts.uid !== uid) {
    throw new Error(`${bus} is not a user-bus socket owned by uid ${uid}`);
  }
  return {
    uid,
    runtimeDirectory,
    environment: managerEnvironment(uid),
  };
}

function managerEnvironment(uid: number): NodeJS.ProcessEnv {
  // Deliberately discard inherited bus, host, machine, and authorization
  // variables. This capability can name only the effective Linux user's bus.
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  let facts;
  try {
    facts = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!facts.isFile()) {
    throw new Error(
      `controller-unit-unmanaged: refusing to follow or replace non-regular unit path ${path}`,
    );
  }
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) {
      throw new Error(`controller-unit-unmanaged: refusing to read non-regular unit path ${path}`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") {
      throw new Error(`controller-unit-unmanaged: refusing to follow symbolic unit path ${path}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${createHash("sha256")
    .update(`${Date.now()}\0${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}`;
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function classifyActiveState(state: string): ActiveStateClassification {
  if (state === "active") return "active";
  if (state === "inactive" || state === "failed") return "stopped";
  return "unsettled";
}

function classifyUnitFileState(state: string): UnitFileStateClassification {
  if (state === "enabled") return "enabled";
  if (state === "enabled-runtime") return "runtime-enabled";
  if (state === "linked" || state === "linked-runtime") return "linked";
  if (state === "alias") return "alias";
  if (state === "disabled" || state === "") return "disabled";
  return "unknown";
}

function enabledUnitFileState(state: string): boolean {
  const classification = classifyUnitFileState(state);
  return classification === "enabled" || classification === "runtime-enabled";
}

function persistentlyEnabledUnitFileState(state: string): boolean {
  return classifyUnitFileState(state) === "enabled";
}

function runtimeEnabledUnitFileState(state: string): boolean {
  return classifyUnitFileState(state) === "runtime-enabled";
}

function unmanagedUnitFileState(state: UnitFileStateClassification): boolean {
  return state === "linked" || state === "alias";
}

function disableUnitFileStateArguments(state: string, unit: string): readonly string[] | undefined {
  if (state === "enabled-runtime") return ["disable", "--runtime", unit];
  if (state === "enabled") return ["disable", unit];
  return undefined;
}

function hasOutputText(value: unknown): boolean {
  try {
    return outputText(value).trim().length > 0;
  } catch {
    return false;
  }
}

function outputText(value: unknown): string {
  const stdout = (value as { stdout?: unknown } | null)?.stdout;
  if (typeof stdout === "string" || Buffer.isBuffer(stdout)) return stdout.toString();
  throw new Error("systemctl returned no readable output");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseSystemdWords(value: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " ") index += 1;
    if (index >= value.length) break;
    let word = "";
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index++]!;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (index >= value.length) return null;
          word += value[index++]!;
        } else {
          word += character;
        }
      }
      if (!closed || (index < value.length && value[index] !== " ")) return null;
    } else {
      const start = index;
      while (index < value.length && value[index] !== " ") index += 1;
      word = value.slice(start, index);
      if (!/^[A-Za-z0-9._:/@+=,-]+$/.test(word)) return null;
    }
    words.push(word.replaceAll("%%", "%"));
  }
  return words;
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
