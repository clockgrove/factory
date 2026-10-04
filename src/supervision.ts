import {
  credentialFileBindings,
  optionalProviderCredentials,
  requiredProviderCredentials,
  validateCredentialFile,
} from "./provider-credentials.js";
import {
  readIntake,
  intakeSettled,
  resumeWatcherAfterUpgrade,
} from "./intake.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FactoryConfig,
  factoryConfigDigest,
  readConfig,
  stateRoot,
} from "./config.js";
import { requestControl } from "./coordinator-control.js";
import { command, linuxProcessIdentity } from "./process.js";
import {
  readContinuation,
  readControllerOwner,
  statePath,
} from "./state-store.js";

interface ServiceBinding {
  /** Set by a unit that an earlier build bound to one Objective; only teardown reads it. */
  objective?: number;
  /** One systemd LoadCredential per credential the configured providers need. */
  credentials?: { name: string; file: string }[];
  version: 1;
  node: string;
  cli: string;
  config: string;
  stateHome: string;
  environment: Record<string, string>;
}
const serviceEnvironment = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "GH_CONFIG_DIR",
  // Claude login location and the network settings needed to reach providers.
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;
const marker = "# Factory local supervision v1 ";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const serviceName = (repository: string) =>
  `factory-${createHash("sha256").update(stateRoot(repository)).digest("hex").slice(0, 24)}.service`;
function unitPath(config: FactoryConfig): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "systemd",
    "user",
    serviceName(config.repository),
  );
}
function quoted(value: string, expandDollar = true): string {
  if (/[\n\r\0]/.test(value))
    throw new Error("Service arguments cannot contain line breaks or NUL");
  return JSON.stringify(
    (expandDollar ? value.replaceAll("$", () => "$$") : value).replaceAll(
      "%",
      "%%",
    ),
  );
}
function systemctl(...args: string[]): string {
  return command("systemctl", ["--user", ...args]);
}
function inspect(...args: string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
  });
  if (result.error || result.status === null) return "unavailable";
  const value = result.stdout?.trim();
  const states: Record<string, string[]> = {
    "is-system-running": [
      "initializing",
      "starting",
      "running",
      "degraded",
      "maintenance",
      "stopping",
      "offline",
      "unknown",
    ],
    "is-active": [
      "active",
      "reloading",
      "inactive",
      "failed",
      "activating",
      "deactivating",
      "maintenance",
      "refreshing",
      "unknown",
    ],
    "is-enabled": [
      "enabled",
      "enabled-runtime",
      "linked",
      "linked-runtime",
      "alias",
      "masked",
      "masked-runtime",
      "static",
      "indirect",
      "disabled",
      "generated",
      "transient",
      "not-found",
      "bad",
    ],
  };
  return value && (!states[args[0]!] || states[args[0]!]!.includes(value))
    ? value
    : "unavailable";
}
export function supervisorHost(): {
  supported: boolean;
  manager: string;
  logoutPersistence: string;
  limitation: string;
} {
  const manager =
    process.platform === "linux" && existsSync("/run/systemd/system")
      ? inspect("is-system-running")
      : "unavailable";
  let logoutPersistence = "unknown";
  try {
    logoutPersistence =
      command("loginctl", [
        "show-user",
        String(process.getuid!()),
        "--property=Linger",
        "--value",
      ]) === "yes"
        ? "enabled"
        : "not-enabled";
  } catch {
    /* report uncertainty */
  }
  return {
    supported: manager === "running" || manager === "degraded",
    manager,
    logoutPersistence,
    limitation:
      "Runs independently of chat while the user manager is available. Sleep suspends execution; shutdown stops it. Logout persistence is reported, never changed.",
  };
}
function requireHost(): void {
  if (!supervisorHost().supported)
    throw new Error(
      "A running Linux systemd user manager is required for the background service; use `factory run --objective N` in the foreground on this host",
    );
}
function privateFile(path: string): void {
  const info = statSync(path);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid!()
  )
    throw new Error(`Expected an owner-private file: ${path}`);
}
export const LEGACY_SERVICE_BINDING =
  "This service was bound to one Objective by an earlier Factory version; run `factory supervisor uninstall`, then `factory setup --background`";

/**
 * Only stop and uninstall may act on a retired binding (one bound to an Objective), so an operator can remove it; nothing reuses or rewrites it.
 */
function decodeBinding(text: string, teardown = false): ServiceBinding {
  if (!text.startsWith(marker))
    throw new Error("Refusing a service not registered by Factory");
  const value = JSON.parse(text.split("\n")[0]!.slice(marker.length));
  if (
    !teardown &&
    value &&
    typeof value === "object" &&
    ("objective" in value || "intake" in value)
  )
    throw new Error(LEGACY_SERVICE_BINDING);
  const path = (value: unknown) =>
    typeof value === "string" && isAbsolute(value) && !/[\n\r\0]/.test(value);
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    ![value.node, value.cli, value.config, value.stateHome].every(path) ||
    !value.environment ||
    typeof value.environment !== "object" ||
    Array.isArray(value.environment) ||
    !Object.values(value.environment).every(
      (value) => typeof value === "string",
    ) ||
    (value.credentials !== undefined &&
      (!Array.isArray(value.credentials) ||
        !value.credentials.length ||
        !value.credentials.every(
          (entry: { name?: unknown; file?: unknown }) =>
            entry &&
            typeof entry.name === "string" &&
            /^[A-Z_][A-Z0-9_]*$/.test(entry.name) &&
            path(entry.file),
        ) ||
        new Set(value.credentials.map((entry: { name: string }) => entry.name))
          .size !== value.credentials.length))
  )
    throw new Error("Malformed Factory service binding");
  return value as ServiceBinding;
}
function binding(config: FactoryConfig, teardown = false): ServiceBinding {
  const value = decodeBinding(readFileSync(unitPath(config), "utf8"), teardown);
  if (
    value.stateHome !==
      resolve(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      ) ||
    readConfig(value.config).repository !== config.repository
  )
    throw new Error("Service binding differs from this installation");
  return value;
}
interface BindingDiagnostic {
  code: string;
  message: string;
  action: string;
}
interface BindingHealth {
  status: "usable" | "unusable" | "unregistered";
  limitation: string;
  checks?: { node: boolean; cli: boolean; config: boolean };
  diagnostics: BindingDiagnostic[];
}
function inspectBinding(
  config: FactoryConfig,
  registered: boolean,
): {
  binding?: ServiceBinding;
  bindingHealth: BindingHealth;
} {
  const health: BindingHealth = {
    status: registered ? "unusable" : "unregistered",
    limitation:
      "Local binding checks only; provider readiness, the state version and running ownership are not verified.",
    diagnostics: [],
  };
  const report = (code: string, message: string, action: string) =>
    health.diagnostics.push({ code, message, action });
  if (!registered) {
    report(
      "unregistered",
      "No local Factory service unit is registered.",
      "Run `factory setup --background` to install the service; no work has been started.",
    );
    return { bindingHealth: health };
  }
  let text: string;
  try {
    text = readFileSync(unitPath(config), "utf8");
  } catch {
    report(
      "unreadable-unit",
      "The local service unit cannot be read.",
      "Inspect the unit's availability and owner permissions; preserve continuation state.",
    );
    return { bindingHealth: health };
  }
  let value: ServiceBinding;
  try {
    value = decodeBinding(text);
  } catch (error) {
    if (error instanceof Error && error.message === LEGACY_SERVICE_BINDING)
      report(
        "legacy-service-binding",
        "The unit is bound to one Objective, as earlier Factory versions did.",
        LEGACY_SERVICE_BINDING,
      );
    else
      report(
        "malformed-binding",
        "The unit does not contain a valid Factory service binding.",
        "Inspect the retained unit before any lifecycle operation. Do not delete continuation state or start this binding.",
      );
    return { bindingHealth: health };
  }
  const available = (path: string, mode: number) => {
    try {
      accessSync(path, mode);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  health.checks = {
    node: available(value.node, constants.X_OK),
    cli: available(value.cli, constants.R_OK),
    config: available(value.config, constants.R_OK),
  };
  if (!health.checks.node)
    report(
      "unavailable-node",
      "The bound Node executable is missing or cannot be executed.",
      "Restore the bound runtime, then use supported supervisor lifecycle commands. Preserve continuation state.",
    );
  if (!health.checks.cli)
    report(
      "missing-cli",
      "The bound installed CLI is missing or unreadable.",
      "Use `factory supervisor upgrade --cli ABSOLUTE_INSTALLED_CLI` to point the service at an installed package. The upgrade drains the owner first and does not check the package; the new package refuses state it cannot read when the service starts.",
    );
  if (!health.checks.config)
    report(
      "missing-config",
      "The bound configuration is missing or unreadable.",
      "Restore the exact authorized configuration before lifecycle operations; do not replace or reset continuation state.",
    );
  let matches =
    value.stateHome ===
    resolve(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  if (health.checks.config) {
    try {
      const bound = readConfig(value.config);
      matches =
        matches &&
        bound.repository === config.repository &&
        factoryConfigDigest(bound) === factoryConfigDigest(config);
    } catch {
      report(
        "invalid-config",
        "The bound configuration cannot be validated.",
        "Restore the exact authorized configuration before lifecycle operations; no binding has been executed.",
      );
    }
  }
  if (!matches)
    report(
      "installation-mismatch",
      "The bound state root or configuration differs from this installation.",
      "Select the original configuration and state environment. Do not overwrite another installation's unit or evidence.",
    );
  health.status = health.diagnostics.length ? "unusable" : "usable";
  // Unit markers are local input, not a trusted source of safe output fields.
  const safeBinding: ServiceBinding = {
    version: value.version,
    node: value.node,
    cli: value.cli,
    config: value.config,
    stateHome: value.stateHome,
    ...(value.credentials === undefined
      ? {}
      : {
          credentials: value.credentials.map(({ name, file }) => ({
            name,
            file,
          })),
        }),
    environment: Object.fromEntries(
      serviceEnvironment.flatMap((key) =>
        value.environment[key] === undefined
          ? []
          : [[key, value.environment[key]]],
      ),
    ),
  };
  return {
    ...(matches ? { binding: safeBinding } : {}),
    bindingHealth: health,
  };
}
export function renderService(value: ServiceBinding): string {
  const args = [
    value.node,
    value.cli,
    "supervisor",
    "serve",
    "--config",
    value.config,
    ...(value.credentials ?? []).flatMap(({ name }) => [
      "--service-credential",
      name,
    ]),
  ];
  return `${marker}${JSON.stringify(value)}\n[Unit]\nDescription=Factory local Objective coordinator\n[Service]\nType=exec\nUMask=0077\nExecStart=${args.map((value) => quoted(value)).join(" ")}\n${Object.entries(
    { ...value.environment, XDG_STATE_HOME: value.stateHome },
  )
    .map(([key, val]) => `Environment=${quoted(`${key}=${val}`, false)}`)
    .join(
      "\n",
    )}\n${(value.credentials ?? []).map(({ name, file }) => `LoadCredential=${quoted(`${name}:${file}`, false)}\n`).join("")}KillMode=process\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\nRestart=on-failure\nSuccessExitStatus=2\nRestartPreventExitStatus=1 2\nRestartSec=5s\n[Install]\nWantedBy=default.target\n`;
}
/** A shell word for a command shown to the operator: plain when safe, single-quoted otherwise. */
function word(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
/** The exact `factory supervisor ACTION` command an operator can paste. */
function supervisorCommand(
  action: string,
  configPath: string,
  target: { cli?: string } = {},
): string {
  const parts = ["factory", "supervisor", action];
  if (target.cli) parts.push("--cli", word(target.cli));
  parts.push("--config", word(resolve(configPath)));
  return parts.join(" ");
}
/** The exact `factory setup --background` command that registers the service again, with a credential file for each required provider. */
function setupCommand(configPath: string, credentials: string[]): string {
  return [
    "factory setup --background --config",
    word(resolve(configPath)),
    ...credentials.map(
      (name) => `--credential-file ${name}=ABSOLUTE_PRIVATE_FILE`,
    ),
  ].join(" ");
}
/** Continuation state an Objective already has must match this installation. */
export function checkServiceState(
  config: FactoryConfig,
  objective: number,
  configPath: string,
): void {
  const state = readContinuation(config.repository, objective);
  if (state && state.configDigest !== factoryConfigDigest(config)) {
    const setup = setupCommand(configPath, requiredProviderCredentials(config));
    throw new Error(
      `Objective ${objective} continuation was written with a different configuration. To continue it, restore that configuration at ${resolve(configPath)}, then run \`${setup}\`. To start fresh instead, run \`${supervisorCommand("uninstall", configPath)}\`, then \`rm -r ${word(dirname(statePath(config.repository, objective)))}\`, then \`${setup}\``,
    );
  }
}
function hasOwner(config: FactoryConfig): boolean {
  const owner = readControllerOwner(
    join(stateRoot(config.repository), "controller.lock"),
  );
  const current = owner && linuxProcessIdentity(owner.pid);
  return Boolean(
    current && current.startTime === owner?.startTime && current.state !== "Z",
  );
}
export function checkIntakeServiceState(
  config: FactoryConfig,
  configPath: string,
): void {
  const intake = readIntake(config);
  if (!intake?.watch)
    throw new Error(
      "The background service is not set up; run `factory setup --background`",
    );
  for (const id of intake.objectives) checkServiceState(config, id, configPath);
}

/**
 * Ask the service to drain and release the installation. The queue is
 * objective 0; a service an earlier build bound to one Objective answers only
 * for that Objective.
 */
export async function handoffService(
  config: FactoryConfig,
  timeoutMs = 30_000,
  objective = 0,
): Promise<void> {
  const reply = await requestControl(config.repository, {
    objective,
    action: "handoff",
  });
  if (!reply.handled) return;
  const deadline = Date.now() + timeoutMs;
  while (hasOwner(config)) {
    if (Date.now() >= deadline)
      throw new Error(
        "Drain is not yet quiescent; service and evidence retained. Inspect `factory status` before another stop or upgrade",
      );
    await pause(100);
  }
}
/** A stopped service whose run exited 2 is waiting for a human decision, not failed. */
function awaitsDecision(name: string): boolean {
  return (
    inspect("is-active", name) !== "active" &&
    inspect("show", name, "--property=ExecMainStatus", "--value") === "2"
  );
}
async function verifyServiceOwner(
  config: FactoryConfig,
  name: string,
): Promise<"owner" | "needs-decision"> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const owner = readControllerOwner(
      join(stateRoot(config.repository), "controller.lock"),
    );
    const pid = Number(inspect("show", name, "--property=MainPID", "--value"));
    if (owner?.pid === pid && owner.intake && hasOwner(config)) {
      const reply = await requestControl(config.repository, {
        objective: 0,
        action: "status",
      });
      if (reply.handled) return "owner";
    }
    if (awaitsDecision(name)) return "needs-decision";
    if (inspect("is-active", name) === "failed") break;
    await pause(100);
  }
  throw new Error(
    `Service has not established its exact coordinator owner. The service log has the reason (a package that refuses the retained state says so there): \`journalctl --user -u ${name} -n 50 --no-pager\`. Inspect \`factory status\` and retained evidence, which are untouched${readIntake(config)?.mode === "draining" ? "; the queue is draining, so `factory queue resume` is needed before the service stays up" : ""}`,
  );
}
function saveUnit(path: string, value: ServiceBinding): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, renderService(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
export async function supervise(
  action: string,
  configPath: string,
  input: {
    cli?: string;
    /** `stop` also stops the service from starting again at login. */
    disable?: boolean;
    /** `NAME=ABSOLUTE_PRIVATE_FILE` for each required provider credential. */
    credentialFiles?: string[];
  } = {},
): Promise<unknown> {
  const config = readConfig(configPath);
  const path = unitPath(config),
    name = serviceName(config.repository);
  if (action === "status") {
    const registered = existsSync(path);
    return {
      ...supervisorHost(),
      unit: name,
      registered,
      active: inspect("is-active", name),
      enabled: inspect("is-enabled", name),
      ...(registered && awaitsDecision(name)
        ? { waitingFor: "human-decision" }
        : {}),
      ...inspectBinding(config, registered),
    };
  }
  requireHost();
  if (action === "install") {
    const configFile = realpathSync(configPath);
    privateFile(configFile);
    const environment: Record<string, string> = {};
    for (const key of serviceEnvironment)
      if (process.env[key]) environment[key] = process.env[key]!;
    const credentials = credentialFileBindings(
      config,
      input.credentialFiles ?? [],
    );
    const value: ServiceBinding = {
      ...(credentials.length ? { credentials } : {}),
      version: 1,
      node: realpathSync(process.execPath),
      cli: realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url))),
      config: configFile,
      stateHome: resolve(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      ),
      environment,
    };
    checkIntakeServiceState(config, configPath);
    if (existsSync(path)) {
      if (JSON.stringify(binding(config)) !== JSON.stringify(value))
        throw new Error(
          `Different service already registered. To replace it, run \`${supervisorCommand("uninstall", configPath)}\`, then \`${setupCommand(configPath, requiredProviderCredentials(config))}\`. \`supervisor upgrade --cli ABSOLUTE_INSTALLED_CLI\` changes only the package`,
        );
    } else saveUnit(path, value);
    systemctl("daemon-reload");
    // The running manager may use a different XDG root. Let systemd link
    // this exact private unit into its own search path.
    systemctl("enable", realpathSync(path));
    return { registered: name, started: false, ...supervisorHost() };
  }
  if (!existsSync(path) && ["uninstall", "stop"].includes(action))
    return { registered: false };
  const value = binding(config, ["stop", "uninstall"].includes(action));
  if (action === "start") {
    const required = requiredProviderCredentials(config);
    const optional = optionalProviderCredentials(config);
    const bound = (value.credentials ?? []).map(({ name }) => name);
    if (
      required.some((name) => !bound.includes(name)) ||
      bound.some((name) => !required.includes(name) && !optional.includes(name))
    )
      throw new Error(
        `Service credential bindings (${bound.join(", ") || "none"}) differ from the configured providers (${required.join(", ") || "none"}). Run \`${supervisorCommand("uninstall", configPath)}\`, then \`${setupCommand(configPath, required)}\``,
      );
    for (const { name, file } of value.credentials ?? [])
      validateCredentialFile(config, name, file);
    // Refuse retained state this installation cannot continue here, with its
    // remedy, instead of starting a service that exits with it in the log.
    checkIntakeServiceState(config, configPath);
    if (hasOwner(config) && inspect("is-active", name) !== "active")
      throw new Error(
        "An existing foreground owner must hand off before service start",
      );
    // A stopped service leaves its queue draining, and a draining queue ends the service at once.
    if (!hasOwner(config) && readIntake(config)?.mode === "draining")
      throw new Error(
        "The queue is draining, so a started service would exit at once; run `factory queue resume`, then `factory supervisor start`",
      );
    systemctl("start", name);
    const outcome = await verifyServiceOwner(config, name);
    return {
      active: inspect("is-active", name),
      ...(outcome === "needs-decision" ? { waitingFor: "human-decision" } : {}),
    };
  }
  if (["stop", "uninstall", "upgrade"].includes(action)) {
    let candidate: ServiceBinding | undefined;
    if (action === "upgrade") {
      if (!input.cli || !isAbsolute(input.cli))
        throw new Error("upgrade requires --cli ABSOLUTE_INSTALLED_CLI");
      candidate = { ...value, cli: realpathSync(input.cli) };
    }
    // A failed unit is one that should be running: upgrading it, as when returning from a
    // package that refused the retained state, starts it again.
    const wasActive = ["active", "failed"].includes(inspect("is-active", name));
    const beforeIntake = candidate ? readIntake(config) : undefined;
    const resumeIdleWatcher =
      wasActive &&
      beforeIntake?.watch &&
      beforeIntake.mode === "running" &&
      intakeSettled(config);
    await handoffService(config, undefined, value.objective);
    systemctl("stop", name);
    if (candidate) {
      saveUnit(path, candidate);
      systemctl("daemon-reload");
      const restart = beforeIntake?.watch
        ? !!resumeIdleWatcher && resumeWatcherAfterUpgrade(config, beforeIntake)
        : wasActive;
      if (restart) {
        systemctl("start", name);
        try {
          await verifyServiceOwner(config, name);
        } catch (error) {
          throw new Error(
            `${(error as Error).message}. The unit now runs ${candidate.cli}; to return to the previous package run \`${supervisorCommand("upgrade", configPath, { cli: value.cli })}\`, then \`${supervisorCommand("start", configPath)}\` (upgrade leaves a stopped service stopped; if start says the queue is draining, run \`factory queue resume --config ${word(resolve(configPath))}\` first)`,
          );
        }
      }
      return {
        artifact: candidate.cli,
        restarted: restart,
        ...(wasActive && !restart ? { resumeRequired: true } : {}),
      };
    }
    if (action !== "stop" || input.disable) systemctl("disable", name);
    // Disable removes external-unit links too. Keep the owned unit discoverable
    // for explicit start, upgrade and uninstall, without enabling future starts.
    if (action === "stop" && input.disable)
      systemctl("link", realpathSync(path));
    if (action === "uninstall") {
      rmSync(path);
      systemctl("daemon-reload");
    }
    return { stopped: true, evidenceRetained: true };
  }
  throw new Error(`Unknown supervisor action: ${action}`);
}
