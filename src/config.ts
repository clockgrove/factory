import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "persistent";

export interface CodexModelSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export const DEFAULT_PLANNER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
};

export const DEFAULT_REVIEWER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
};

export const DEFAULT_WORKER_MODEL_SELECTION: CodexModelSelection = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
};

export type ExecutionConfig =
  | {
      kind: "local";
      concurrency: number;
      harness: { kind: "codex-sdk" } & CodexModelSelection;
    }
  | { kind: "managed-agent"; concurrency: number; provider: string }
  | {
      kind: "sandbox";
      concurrency: number;
      provider: string;
      harness: { kind: string };
    };

export interface FactoryConfig {
  schemaVersion: 1;
  repository: string;
  checkout: string;
  planning: {
    kind: "codex-sdk";
    planner: CodexModelSelection;
    reviewer: CodexModelSelection;
  };
  execution: ExecutionConfig;
  delivery: { kind: "regular" | "native-stack" };
  contentStore: { kind: "local" };
  policy: {
    network: "host" | "off";
    allowedSecretNames: string[];
    deployments: "denied";
  };
}

const codexReasoningEfforts = new Set<CodexReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

const factoryRepositories = new Set([
  "clockgrove/factory",
  "clockgrove/factory-rebuild",
  "clockgrove/factory-archive",
]);

function isFactorySource(checkout: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ) as { name?: string };
    return manifest.name === "@clockgrove/factory";
  } catch {
    return false;
  }
}

function assertObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertCodexModelSelection(
  value: unknown,
  name: string,
): asserts value is CodexModelSelection {
  assertObject(value, name);
  if (typeof value.model !== "string" || value.model.trim().length === 0)
    throw new Error(`${name}.model must be a non-empty string`);
  if (
    typeof value.reasoningEffort !== "string" ||
    !codexReasoningEfforts.has(value.reasoningEffort as CodexReasoningEffort)
  )
    throw new Error(`${name}.reasoningEffort is unsupported`);
}

/** Parse only supported GitHub clone URLs; never return credentials or raw URLs. */
function remoteRepository(remote: string): string | undefined {
  const scp =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      remote,
    );
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(remote);
    const https =
      url.protocol === "https:" && url.hostname === "github.com" && !url.port;
    const ssh =
      url.protocol === "ssh:" &&
      url.username === "git" &&
      !url.password &&
      ((url.hostname === "github.com" && (!url.port || url.port === "22")) ||
        (url.hostname === "ssh.github.com" && url.port === "443"));
    if ((!https && !ssh) || url.search || url.hash) return undefined;
    const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.pathname,
    );
    return path ? `${path[1]}/${path[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function originRepositories(checkout: string, push: boolean): string[] {
  const direction = push ? "push" : "fetch";
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        checkout,
        "remote",
        "get-url",
        ...(push ? ["--push"] : []),
        "--all",
        "origin",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error(
      `Cannot resolve origin ${direction} URLs; configure origin for the target GitHub repository`,
    );
  }
  const repositories = output.split("\n").map(remoteRepository);
  if (repositories.some((repository) => !repository))
    throw new Error(
      `Origin ${direction} URL is not a supported GitHub repository URL; use the target repository's HTTPS or SSH clone URL`,
    );
  return repositories as string[];
}

/** Custom LFS routing cannot be proven from Git clone URLs; keep the default origin route. */
function validateLfsRouting(checkout: string): void {
  const keys =
    "^(lfs\\.(url|pushurl|remote\\.(autodetect|searchall)|standalonetransferagent|customtransfer\\..*|transfer\\.enablehrefrewrite)|remote\\.(lfsdefault|lfspushdefault|.+\\.(lfsurl|lfspushurl)))$";
  const check = (source: string[]) => {
    let output: string;
    try {
      output = execFileSync(
        "git",
        [
          "-C",
          checkout,
          "config",
          "--includes",
          ...source,
          "--null",
          "--get-regexp",
          keys,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      if ((error as { status?: number }).status === 1) return;
      throw new Error(
        "Cannot inspect LFS routing configuration; repair Git/.lfsconfig settings before using Factory",
      );
    }
    for (const entry of output.split("\0").filter(Boolean)) {
      const newline = entry.indexOf("\n");
      const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
      const value = newline < 0 ? undefined : entry.slice(newline + 1).trim();
      if (value === "") continue;
      if (
        /^lfs\.(remote\.(autodetect|searchall)|transfer\.enablehrefrewrite)$/.test(
          key,
        ) &&
        value !== undefined &&
        /^(false|no|off|0)$/i.test(value)
      )
        continue;
      if (/^remote\.lfs(push)?default$/.test(key) && value === "origin")
        continue;
      throw new Error(
        "Custom LFS routing is unsupported for target binding; remove LFS URL, alternate-remote, rewrite, or custom-transfer settings and use origin's default GitHub LFS endpoint",
      );
    }
  };
  check([]);
  // A fresh clone can use committed settings even when the working file overrides them.
  const file = join(checkout, ".lfsconfig");
  if (existsSync(file)) check(["--file", file]);
  for (const blob of [":.lfsconfig", "HEAD:.lfsconfig"]) {
    try {
      execFileSync("git", ["-C", checkout, "cat-file", "-e", blob], {
        stdio: "ignore",
      });
    } catch {
      continue;
    }
    check(["--blob", blob]);
  }
}

export function validateTarget(repository: string, checkout: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be an owner/name GitHub repository");
  }
  if (!isAbsolute(checkout) || !existsSync(checkout)) {
    throw new Error("checkout must be an existing absolute directory");
  }
  const actual = realpathSync(checkout);
  const repo = repository.toLowerCase();
  if (factoryRepositories.has(repo) || isFactorySource(actual)) {
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  }
  let root: string;
  try {
    root = execFileSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("checkout must be a Git repository");
  }
  if (isFactorySource(root))
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  for (const push of [false, true]) {
    for (const remote of originRepositories(actual, push)) {
      if (factoryRepositories.has(remote))
        throw new Error(
          "Factory cannot be installed or run against a Factory repository",
        );
      if (remote !== repo)
        throw new Error(
          `Origin ${push ? "push" : "fetch"} repository does not match configured repository ${repo}; correct the remote binding before using Factory`,
        );
    }
  }
  validateLfsRouting(root);
}

export function validateConfig(value: unknown): FactoryConfig {
  assertObject(value, "configuration");
  if (value.schemaVersion !== 1)
    throw new Error("Only Factory schemaVersion 1 is supported");
  if (
    typeof value.repository !== "string" ||
    typeof value.checkout !== "string"
  ) {
    throw new Error("repository and checkout are required");
  }
  validateTarget(value.repository, value.checkout);
  assertObject(value.planning, "planning");
  if (value.planning.kind !== "codex-sdk")
    throw new Error("Unsupported planning model");
  assertCodexModelSelection(value.planning.planner, "planning.planner");
  assertCodexModelSelection(value.planning.reviewer, "planning.reviewer");
  assertObject(value.execution, "execution");
  if (value.execution.kind !== "local") {
    throw new Error(
      `Execution mode ${String(value.execution.kind)} is not implemented; select local`,
    );
  }
  if (
    !Number.isSafeInteger(value.execution.concurrency) ||
    (value.execution.concurrency as number) <= 0
  ) {
    throw new Error(
      "execution.concurrency must be a positive operator-selected integer",
    );
  }
  assertObject(value.execution.harness, "execution.harness");
  if (value.execution.harness.kind !== "codex-sdk")
    throw new Error("Unsupported local harness");
  assertCodexModelSelection(value.execution.harness, "execution.harness");
  assertObject(value.delivery, "delivery");
  if (
    value.delivery.kind !== "regular" &&
    value.delivery.kind !== "native-stack"
  ) {
    throw new Error("Unsupported delivery strategy");
  }
  assertObject(value.contentStore, "contentStore");
  if (value.contentStore.kind !== "local")
    throw new Error("Unsupported content store");
  assertObject(value.policy, "policy");
  if (value.policy.network !== "host" && value.policy.network !== "off")
    throw new Error("Unsupported network policy");
  if (
    !Array.isArray(value.policy.allowedSecretNames) ||
    !value.policy.allowedSecretNames.every(
      (name: unknown) => typeof name === "string",
    )
  ) {
    throw new Error("policy.allowedSecretNames must be a string array");
  }
  if (value.policy.deployments !== "denied")
    throw new Error("Deployments are unsupported");
  return value as unknown as FactoryConfig;
}

export function configPath(): string {
  const root =
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return resolve(root, "clockgrove-factory", "config.json");
}

export function stateRoot(repository: string): string {
  const root =
    process.env.XDG_STATE_HOME ??
    join(process.env.HOME ?? "", ".local", "state");
  const [owner, repo] = repository.split("/");
  return resolve(root, "clockgrove-factory", "repositories", owner!, repo!);
}

export function readConfig(path = configPath()): FactoryConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
