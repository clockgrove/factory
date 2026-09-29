import { readIntake } from "./intake.js";
import { objectiveComplete } from "./completion.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  type AutonomousAdmission,
  assertAdmissionBinding,
} from "./admission.js";
import {
  type FactoryConfig,
  factoryConfigDigest,
  readConfig,
  stateRoot,
} from "./config.js";
import { requestControl } from "./coordinator-control.js";
import { command, linuxProcessIdentity } from "./process.js";
import { readContinuation, readControllerOwner } from "./state-store.js";

interface ServiceBinding {
  intake?: boolean;
  version: 1;
  node: string;
  cli: string;
  config: string;
  objective: number;
  stateHome: string;
  environment: Record<string, string>;
  plan?: string;
  admission?: string;
}
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
  return result.stdout?.trim() || "unavailable";
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
      "A running Linux systemd user manager is required; use foreground factory run diagnostics on this host",
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
function binding(config: FactoryConfig): ServiceBinding {
  const text = readFileSync(unitPath(config), "utf8");
  if (!text.startsWith(marker))
    throw new Error("Refusing to modify a service not registered by Factory");
  const value = JSON.parse(
    text.split("\n")[0]!.slice(marker.length),
  ) as ServiceBinding;
  if (
    value.version !== 1 ||
    value.stateHome !==
      resolve(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      ) ||
    readConfig(value.config).repository !== config.repository
  )
    throw new Error("Service binding differs from this installation");
  return value;
}
export function renderService(value: ServiceBinding): string {
  const args = [
    value.node,
    value.cli,
    "supervisor",
    "serve",
    "--config",
    value.config,
    ...(value.intake ? ["--intake"] : ["--objective", String(value.objective)]),
    ...(value.plan ? ["--plan", value.plan] : []),
    ...(value.admission ? ["--admission", value.admission] : []),
  ];
  return `${marker}${JSON.stringify(value)}\n[Unit]\nDescription=Factory local Objective coordinator\n[Service]\nType=exec\nUMask=0077\nExecStart=${args.map((value) => quoted(value)).join(" ")}\n${Object.entries(
    { ...value.environment, XDG_STATE_HOME: value.stateHome },
  )
    .map(([key, val]) => `Environment=${quoted(`${key}=${val}`, false)}`)
    .join(
      "\n",
    )}\nKillMode=process\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\nRestart=on-failure\nRestartPreventExitStatus=1\nRestartSec=5s\n[Install]\nWantedBy=default.target\n`;
}
export function checkServiceState(
  config: FactoryConfig,
  objective: number,
  admissionPath?: string,
): void {
  const state = readContinuation(config.repository, objective);
  if (state) {
    // Older installed artifacts must refuse newer continuation fields rather than silently drop them.
    const fields =
      state.schemaVersion === 3
        ? "schemaVersion kind repository objective runId configDigest baseSha objectiveBodyDigest admission coordinator planning plan issueByItemId projectionPending error cancelRequested cancelledAt"
        : "schemaVersion repository objective runId configDigest baseSha admission coordinator additionalSources graph graphRevisions pendingAmendment allowanceConsumption backlogDiscoveries objectiveCommands issueByItemId work stackNumbers stackMerges integratedSha finalValidation finalAcceptance finalAcceptancePending finalAcceptanceDecisions objectiveBodyDigest objectiveClosure githubClosureError cancelRequested cancelledAt error";
    for (const field of Object.keys(state))
      if (!fields.split(" ").includes(field))
        throw new Error(
          `Artifact cannot validate continuation field ${field}; upgrade/rollback refused`,
        );
  }
  const admission =
    state?.admission ??
    (admissionPath
      ? (JSON.parse(readFileSync(admissionPath, "utf8")) as AutonomousAdmission)
      : undefined);
  if (!admission)
    throw new Error(
      "Background operation requires an existing exact admission",
    );
  assertAdmissionBinding(admission);
  if (
    !admission.authority.serviceConsent ||
    admission.repository !== config.repository ||
    admission.objective !== objective ||
    admission.configDigest !== factoryConfigDigest(config)
  )
    throw new Error(
      "Service consent or exact installation/admission binding is missing",
    );
  if (state && state.configDigest !== factoryConfigDigest(config))
    throw new Error(
      "Continuation configuration differs; refusing compatibility claim",
    );
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
export function checkIntakeServiceState(config: FactoryConfig): void {
  const intake = readIntake(config);
  if (!intake?.authority.serviceConsent)
    throw new Error(
      "Intake background operation requires explicit service consent",
    );
  for (const id of intake.authority.objectives) {
    const state = readContinuation(config.repository, id);
    if (state?.admission) checkServiceState(config, id);
    else if (state && state.schemaVersion !== 3)
      throw new Error("Intake continuation has no admission");
  }
}

export async function handoffService(
  config: FactoryConfig,
  objective: number,
  timeoutMs = 30_000,
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
        "Drain is not yet quiescent; service and evidence retained. Inspect status before another stop or upgrade",
      );
    await pause(100);
  }
}
async function verifyServiceOwner(
  config: FactoryConfig,
  objective: number,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const owner = readControllerOwner(
      join(stateRoot(config.repository), "controller.lock"),
    );
    const pid = Number(inspect("show", name, "--property=MainPID", "--value"));
    if (
      owner?.pid === pid &&
      (owner.objective === objective || (objective === 0 && owner.intake)) &&
      hasOwner(config)
    ) {
      const reply = await requestControl(config.repository, {
        objective,
        action: "status",
      });
      if (reply.handled) return;
    }
    const current = readContinuation(config.repository, objective);
    if (
      current?.cancelledAt ||
      (current?.schemaVersion === 2 && objectiveComplete(current))
    )
      return;
    if (inspect("is-active", name) === "failed") break;
    await pause(100);
  }
  throw new Error(
    "Service has not established its exact coordinator owner; inspect supervisor status and retained evidence",
  );
}
function validateArtifact(value: ServiceBinding): void {
  const result = command(
    value.node,
    [
      value.cli,
      "supervisor",
      "check",
      "--config",
      value.config,
      ...(value.intake
        ? ["--intake"]
        : ["--objective", String(value.objective)]),
      ...(value.admission ? ["--admission", value.admission] : []),
    ],
    undefined,
    { ...process.env, ...value.environment, XDG_STATE_HOME: value.stateHome },
  );
  if (result !== "factory-supervision-compatible-v1")
    throw new Error(
      "Candidate does not affirm state compatibility; no service switch performed",
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
    objective?: number;
    intake?: boolean;
    plan?: string;
    admission?: string;
    cli?: string;
  } = {},
): Promise<unknown> {
  const config = readConfig(configPath);
  if (action === "check") {
    if (input.intake) checkIntakeServiceState(config);
    else checkServiceState(config, input.objective!, input.admission);
    return "factory-supervision-compatible-v1";
  }
  const path = unitPath(config),
    name = serviceName(config.repository);
  if (action === "status")
    return {
      ...supervisorHost(),
      unit: name,
      registered: existsSync(path),
      active: inspect("is-active", name),
      enabled: inspect("is-enabled", name),
      ...(existsSync(path) ? { binding: binding(config) } : {}),
    };
  requireHost();
  if (action === "install") {
    if (
      !input.intake &&
      (!Number.isSafeInteger(input.objective) || input.objective! <= 0)
    )
      throw new Error("supervisor install requires --objective N");
    const configFile = realpathSync(configPath);
    privateFile(configFile);
    for (const file of [input.plan, input.admission])
      if (file) privateFile(file);
    const environment: Record<string, string> = {};
    for (const key of [
      "HOME",
      "PATH",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "CODEX_HOME",
      "GH_CONFIG_DIR",
    ])
      if (process.env[key]) environment[key] = process.env[key]!;
    const value: ServiceBinding = {
      version: 1,
      node: realpathSync(process.execPath),
      cli: realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url))),
      config: configFile,
      objective: input.intake ? 0 : input.objective!,
      ...(input.intake ? { intake: true } : {}),
      stateHome: resolve(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      ),
      environment,
      ...(input.plan ? { plan: realpathSync(input.plan) } : {}),
      ...(input.admission ? { admission: realpathSync(input.admission) } : {}),
    };
    if (
      !value.intake &&
      !readContinuation(config.repository, value.objective) &&
      !(value.plan && value.admission)
    )
      throw new Error("A new service requires both --plan and --admission");
    if (value.intake) checkIntakeServiceState(config);
    else checkServiceState(config, value.objective, value.admission);
    if (existsSync(path)) {
      if (JSON.stringify(binding(config)) !== JSON.stringify(value))
        throw new Error(
          "Different service already registered; use an explicit upgrade after drain",
        );
    } else saveUnit(path, value);
    systemctl("daemon-reload");
    systemctl("enable", name);
    return { registered: name, started: false, ...supervisorHost() };
  }
  if (!existsSync(path) && ["disable", "uninstall", "stop"].includes(action))
    return { registered: false };
  const value = binding(config);
  if (action === "start") {
    validateArtifact(value);
    if (hasOwner(config) && inspect("is-active", name) !== "active")
      throw new Error(
        "An existing foreground owner must hand off before service start",
      );
    systemctl("start", name);
    await verifyServiceOwner(config, value.objective, name);
    return { active: inspect("is-active", name) };
  }
  if (["stop", "disable", "uninstall", "upgrade"].includes(action)) {
    let candidate: ServiceBinding | undefined;
    if (action === "upgrade") {
      if (!input.cli || !isAbsolute(input.cli))
        throw new Error("upgrade requires --cli ABSOLUTE_INSTALLED_CLI");
      candidate = { ...value, cli: realpathSync(input.cli) };
      validateArtifact(candidate);
    }
    const wasActive = inspect("is-active", name) === "active";
    await handoffService(config, value.objective);
    systemctl("stop", name);
    if (candidate) {
      validateArtifact(candidate);
      saveUnit(path, candidate);
      systemctl("daemon-reload");
      if (wasActive) {
        systemctl("start", name);
        await verifyServiceOwner(config, value.objective, name);
      }
      return { artifact: candidate.cli, restarted: wasActive };
    }
    if (action !== "stop") systemctl("disable", name);
    if (action === "uninstall") {
      rmSync(path);
      systemctl("daemon-reload");
    }
    return { stopped: true, evidenceRetained: true };
  }
  throw new Error(`Unknown supervisor action: ${action}`);
}
