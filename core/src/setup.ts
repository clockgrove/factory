/**
 * `factory setup`: write the installation's configuration from options,
 * check it loads, and check the target it binds. Each option names one
 * configuration key; loadConfig checks the values, so setup never
 * duplicates a rule. Repeating the same command changes nothing. The
 * keys that bind the installation to its target (checkout and the queue's
 * Project fields) are never changed by setup: a different value is a
 * conflict, refused before anything is written.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isObject } from "./checked.js";
import { configPath, loadConfig } from "./config.js";
import { originRefusal } from "./git.js";
import { GitHub } from "./github.js";
import { PLANNERS, WORKERS } from "./providers/config.js";
import { projectProblems } from "./queue.js";
import { type Readiness, readiness } from "./readiness.js";
import { errorMessage } from "./text.js";

/** How an option's value becomes the key's: loadConfig checks the result. */
type Read = "text" | "number" | "list" | "names" | "env";

interface Option {
  /** The key, dotted, from the configuration (or the provider's) root. */
  key: string;
  read: Read;
  /** A key that binds the target: refused when it would change. */
  binding?: true;
}

/** Installation-wide options. `list` and `env` options repeat. */
const CONFIG_OPTIONS: Record<string, Option> = {
  checkout: { key: "checkout", read: "text", binding: true },
  "project-id": { key: "queue.projectId", read: "text", binding: true },
  field: { key: "queue.field", read: "text", binding: true },
  "order-field": { key: "queue.orderField", read: "text", binding: true },
  "poll-seconds": { key: "queue.pollSeconds", read: "number" },
  "max-active": { key: "queue.maxActiveObjectives", read: "number" },
  concurrency: { key: "execution.concurrency", read: "number" },
  workers: { key: "execution.workers", read: "number" },
  validations: { key: "execution.validations", read: "number" },
  "planning-revisions": {
    key: "autonomy.allowances.planningRevisions",
    read: "number",
  },
  "implementation-repairs": {
    key: "autonomy.allowances.implementationRepairs",
    read: "number",
  },
  "per-path-repairs": { key: "autonomy.allowances.perPath", read: "number" },
  "result-rereviews": {
    key: "autonomy.allowances.resultRereviews",
    read: "number",
  },
  "required-env": { key: "autonomy.requiredEnvironment", read: "list" },
  delivery: { key: "delivery.kind", read: "text" },
  "sandbox-network": { key: "sandbox.network", read: "text" },
  "package-store": { key: "sandbox.packageStore", read: "text" },
  "read-only-path": { key: "sandbox.readOnlyPaths", read: "list" },
  "sandbox-env": { key: "sandbox.environment", read: "env" },
  "required-command": { key: "finalValidation.requiredCommands", read: "list" },
  "ci-only-command": { key: "finalValidation.ciOnlyCommands", read: "list" },
  "allowed-secret": { key: "policy.allowedSecretNames", read: "list" },
};

/**
 * One provider's options, under providers.NAME. A `<kind>-` option sets
 * that worker kind's settings and is refused for another kind. `names`
 * take a comma-separated list.
 */
const PROVIDER_OPTIONS: Record<string, Option> = {
  "planner-model": { key: "models.planner.model", read: "text" },
  "planner-effort": { key: "models.planner.effort", read: "text" },
  "reviewer-model": { key: "models.reviewer.model", read: "text" },
  "reviewer-effort": { key: "models.reviewer.effort", read: "text" },
  "codex-network": { key: "worker.network", read: "text" },
  "codex-model": { key: "worker.model", read: "text" },
  "codex-effort": { key: "worker.effort", read: "text" },
  "codex-service-tier": { key: "worker.serviceTier", read: "text" },
  "claude-model": { key: "worker.model", read: "text" },
  "claude-effort": { key: "worker.effort", read: "text" },
  "claude-max-turns": { key: "worker.maxTurns", read: "number" },
  "claude-tools": { key: "worker.tools", read: "names" },
  "claude-allowed-tools": { key: "worker.allowedTools", read: "names" },
  "claude-permission-mode": { key: "worker.permissionMode", read: "text" },
  "claude-setting-sources": { key: "worker.settingSources", read: "names" },
  "copilot-model": { key: "worker.model", read: "text" },
  "copilot-effort": { key: "worker.effort", read: "text" },
  "copilot-tools": { key: "worker.tools", read: "names" },
};

/** Worker kinds setup can write: the managed ones need settings by hand. */
const SETUP_WORKERS = ["codex", "claude", "copilot"];

/** The settings a managed worker needs, which setup doesn't take. */
const MANAGED_FIELDS: Record<string, string> = {
  "openai-agents": '"model", "effort", "containerSize", "apiKeyEnv"',
  "claude-managed-agents":
    '"agentId", "agentVersion", "environmentId", "workspaceId", "credentialEnv"',
};

/** Setup's options for the command table: true takes a value, "many" repeats. */
export const SETUP_FLAGS: Record<string, boolean | "many"> = {
  "config-only": false,
  provider: true,
  planner: true,
  worker: true,
  default: false,
  json: false,
  ...Object.fromEntries(
    Object.entries({ ...CONFIG_OPTIONS, ...PROVIDER_OPTIONS }).map(
      ([flag, { read }]) => [
        flag,
        read === "list" || read === "env" ? "many" : true,
      ],
    ),
  ),
};

/** A refusal before anything is written: the command line is wrong. */
export class SetupUsage extends Error {}

export interface SetupReport {
  /**
   * `configured`: saved, it loads, and the target and host are ready.
   * `blocked`: saved and it loads, but the target isn't ready (`problems`
   * names what) or a readiness check is blocked (it names its fix).
   * `refused`: nothing saved (`problems` names why).
   */
  status: "configured" | "blocked" | "refused";
  config: string;
  created: boolean;
  /** The keys this run changed; empty when the command was repeated. */
  changed: string[];
  defaultProvider?: string;
  problems: string[];
  /** The readiness checklist, once the configuration loads (readiness.ts). */
  readiness?: Readiness;
}

/** Equal as JSON, whatever the order of object keys. */
function same(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): unknown =>
    isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : Array.isArray(value)
        ? value.map(sorted)
        : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/** The value at a dotted key, or undefined. */
function get(root: Record<string, unknown>, key: string): unknown {
  let at: unknown = root;
  for (const part of key.split(".")) at = isObject(at) ? at[part] : undefined;
  return at;
}

/** Set a dotted key, creating the objects on the way. */
function put(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let at = root;
  for (const part of parts) {
    if (!isObject(at[part])) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[last] = value;
}

/** A whole number as a number; anything else as given, for loadConfig to name. */
const number = (value: string) => (/^\d+$/.test(value) ? Number(value) : value);

function optionValue(read: Read, given: string[]): unknown {
  const last = given[given.length - 1]!;
  switch (read) {
    case "text":
      return last;
    case "number":
      return number(last);
    case "list":
      return given;
    case "names":
      return last
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    case "env": {
      const environment: Record<string, string> = {};
      for (const entry of given) {
        const at = entry.indexOf("=");
        if (at < 1)
          throw new SetupUsage(
            `--sandbox-env takes NAME=VALUE; ${JSON.stringify(entry)} has no name`,
          );
        environment[entry.slice(0, at)] = entry.slice(at + 1);
      }
      return environment;
    }
  }
}

/**
 * Write the configuration the options name, check it loads (restoring the
 * file when it doesn't), then check the checkout's origin and the queue's
 * Project fields. `values` holds each option given, every value of a
 * repeated one in order.
 */
export async function setup(
  repository: string,
  values: Record<string, string[]>,
): Promise<SetupReport> {
  const path = configPath(repository);
  const created = !existsSync(path);
  let original = "";
  let raw: Record<string, unknown> = { repository };
  if (!created) {
    try {
      original = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(original);
      if (!isObject(parsed)) throw new Error("it is not a JSON object");
      raw = parsed;
    } catch (error) {
      return refused(path, false, `Can't read ${path}: ${errorMessage(error)}`);
    }
  } else
    for (const flag of ["checkout", "project-id"])
      if (!values[flag])
        throw new SetupUsage(
          `${path} doesn't exist yet: give --checkout PATH and --project-id PVT_... to create it`,
        );
  const changed: string[] = [];
  const set = (key: string, value: unknown, root = raw, prefix = "") => {
    if (same(get(root, key), value)) return;
    put(root, key, value);
    changed.push(prefix + key);
  };
  // A binding compares with the value in effect, its default included;
  // a file that doesn't load has no value in effect to keep.
  let effective: Record<string, unknown> = raw;
  if (!created)
    try {
      effective = { ...loadConfig(repository) };
    } catch (error) {
      const bindings = Object.keys(CONFIG_OPTIONS).filter(
        (flag) => CONFIG_OPTIONS[flag]!.binding && values[flag],
      );
      if (bindings.length)
        return refused(
          path,
          false,
          `--${bindings.join(", --")} can't be checked against a configuration that doesn't load; fix it first: ${errorMessage(error)}`,
        );
    }
  const conflicts: string[] = [];
  for (const [flag, option] of Object.entries(CONFIG_OPTIONS)) {
    const given = values[flag];
    if (!given) continue;
    const value = optionValue(option.read, given);
    const current = get(option.binding ? effective : raw, option.key);
    if (
      option.binding &&
      !created &&
      current !== undefined &&
      current !== value
    )
      conflicts.push(
        `--${flag} ${value} conflicts with ${option.key} ${JSON.stringify(current)}: setup never moves an installation to another target; edit ${path} by hand once no Objective is running`,
      );
    else set(option.key, value);
  }
  if (conflicts.length) return refused(path, created, ...conflicts);
  providerOptions(raw, values, path, set);
  if (!created && !changed.length) {
    const problems = loads(repository);
    if (problems) return refused(path, false, problems);
  } else {
    const save = (body: string) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, path);
    };
    save(`${JSON.stringify(raw, null, 2)}\n`);
    const problems = loads(repository);
    if (problems) {
      if (created) rmSync(path, { force: true });
      else save(original);
      return refused(path, created, problems);
    }
  }
  const config = loadConfig(repository);
  const problems: string[] = [];
  if (!existsSync(config.checkout))
    problems.push(
      `The checkout ${config.checkout} doesn't exist: clone ${repository} there`,
    );
  else {
    const refusal = await originRefusal(config.checkout, repository);
    if (refusal) problems.push(refusal.message);
  }
  const github = new GitHub(repository, process.env.FACTORY_GITHUB_API);
  try {
    problems.push(...(await projectProblems(github, config)));
  } catch (error) {
    problems.push(`Can't read the queue's Project: ${errorMessage(error)}`);
  }
  const ready = await readiness(config, github);
  return {
    status: problems.length || !ready.ready ? "blocked" : "configured",
    config: path,
    created,
    changed,
    defaultProvider: config.defaultProvider,
    problems,
    readiness: ready,
  };
}

function refused(
  path: string,
  created: boolean,
  ...problems: string[]
): SetupReport {
  return { status: "refused", config: path, created, changed: [], problems };
}

/** loadConfig's problems, or undefined when the configuration loads. */
function loads(repository: string): string | undefined {
  try {
    loadConfig(repository);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * `--provider NAME` and its options: add the provider or change its
 * planner, worker and their settings. The first provider, or `--default`,
 * becomes defaultProvider. A provider's model choices belong to its
 * planner kind, and a worker's settings to its kind, so changing a kind
 * drops them.
 */
function providerOptions(
  raw: Record<string, unknown>,
  values: Record<string, string[]>,
  path: string,
  set: (
    key: string,
    value: unknown,
    root?: Record<string, unknown>,
    prefix?: string,
  ) => void,
): void {
  const name = values.provider?.at(-1);
  const given = Object.keys(PROVIDER_OPTIONS).filter((flag) => values[flag]);
  for (const flag of ["planner", "worker", "default"])
    if (values[flag]) given.push(flag);
  if (!name) {
    if (given.length)
      throw new SetupUsage(
        `--${given[0]} sets one provider: name it with --provider NAME`,
      );
    return;
  }
  const planner = values.planner?.at(-1);
  const worker = values.worker?.at(-1);
  if (planner && !(PLANNERS as readonly string[]).includes(planner))
    throw new SetupUsage(`--planner is one of ${PLANNERS.join(", ")}`);
  if (worker && !SETUP_WORKERS.includes(worker))
    throw new SetupUsage(
      (WORKERS as readonly string[]).includes(worker)
        ? `a ${worker} worker needs settings setup doesn't take: write providers.${name}.worker = { "kind": "${worker}", ${MANAGED_FIELDS[worker]} } in ${path} by hand`
        : `--worker is one of ${SETUP_WORKERS.join(", ")}`,
    );
  // Without providers the configuration has one: codex, the default.
  if (!isObject(raw.providers))
    raw.providers = { codex: { planner: "codex", worker: { kind: "codex" } } };
  const providers = raw.providers as Record<string, unknown>;
  // Keep the effective default (the first provider) unless --default moves it.
  if (raw.defaultProvider === undefined)
    set("defaultProvider", Object.keys(providers)[0] ?? name);
  const prefix = `providers.${name}.`;
  if (!isObject(providers[name])) providers[name] = {};
  const provider = providers[name] as Record<string, unknown>;
  const kind = planner ?? (provider.planner as string | undefined) ?? "codex";
  // An absent planner is codex, as loadConfig reads it.
  if ((provider.planner ?? "codex") !== kind)
    set("models", undefined, provider, prefix);
  set("planner", kind, provider, prefix);
  const current = isObject(provider.worker)
    ? (provider.worker.kind as string)
    : undefined;
  const workerKind = worker ?? current ?? kind;
  if (workerKind !== current)
    set("worker", { kind: workerKind }, provider, prefix);
  for (const flag of Object.keys(PROVIDER_OPTIONS)) {
    const value = values[flag];
    if (!value) continue;
    const option = PROVIDER_OPTIONS[flag]!;
    const owner = flag.split("-")[0]!;
    if (SETUP_WORKERS.includes(owner) && owner !== workerKind)
      throw new SetupUsage(
        `--${flag} sets a ${owner} worker, and providers.${name}'s worker is ${workerKind}; add --worker ${owner} to change it`,
      );
    set(option.key, optionValue(option.read, value), provider, prefix);
  }
  if (values.default) set("defaultProvider", name);
}
