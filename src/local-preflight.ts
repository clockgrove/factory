import { plannedPackageManager } from "./package-manager-update.js";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { finalObjectiveCommands, planningSources } from "./compiler.js";
import type { FactoryConfig } from "./config.js";
import type { PlanningLocalExecutables, WorkGraph } from "./contracts.js";
import {
  localValidationEnvironment,
  resolveLocalExecutable,
  pinnedGitRaw,
} from "./process.js";
import { redactDiagnosticDetail } from "./diagnostics.js";

export interface ExecutablePreflightObservation {
  origin: "work-item" | "final";
  source: string;
  itemId?: string;
  commandIndex: number;
  executable: string;
  status: "ready" | "missing" | "unverified" | "version-mismatch";
  pathContext: string;
  detail: string;
}

/** Deliberately not a shell parser: complex/dynamic positions stay unverified. */
function literalEntrypoints(command: string): {
  names: string[];
  partial: boolean;
} {
  const first = (value: string) =>
    value.trim().match(/^([A-Za-z_][A-Za-z0-9_.+-]*|\[|:)(?:\s|$)/)?.[1];
  const background = /(^|[^&])&([^&]|$)/.test(command);
  const complex = /["'`$\\(){}<>#]/.test(command) || background;
  const segments = complex ? [command] : command.split(/&&|\|\||[;|\n]/);
  const names = segments
    .map(first)
    .filter(
      (name): name is string =>
        Boolean(name) &&
        ![
          "if",
          "then",
          "else",
          "elif",
          "fi",
          "for",
          "do",
          "done",
          "while",
          "until",
          "case",
          "esac",
          "in",
        ].includes(name!),
    );
  // A literal outer shell/env wrapper does not qualify its nested commands.
  const partial =
    names.length !== segments.length ||
    /[`$\\(){}<>#]/.test(command) ||
    background ||
    (complex && /[;|&\n]/.test(command)) ||
    names.some((name) =>
      [
        "sh",
        "bash",
        "dash",
        "env",
        "eval",
        "exec",
        "command",
        "if",
        "for",
        "while",
        "case",
        "cd",
        "export",
      ].includes(name),
    );
  return { names: [...new Set(names)], partial };
}

/** Resolve only fixed host lookups; never evaluate an admitted target command. */
export function preflightLocalExecutables(input: {
  checkout: string;
  baseSha: string;
  graph: WorkGraph;
  objectiveBody?: string;
  finalCommands: string[];
  privateRoot: string;
  credentialDirectory: string;
  secrets?: string[];
  observe: (entry: ExecutablePreflightObservation) => void;
}): void {
  const env = localValidationEnvironment(input.credentialDirectory);
  const redact = (value: string) =>
    redactDiagnosticDetail(value, input.secrets);
  const pathContext = redact(env.PATH ?? "(unset: validation shell default)");
  const policy = plannedPackageManager(
    input.objectiveBody ?? "",
    input.checkout,
    input.baseSha,
  );
  const targetRoot = `${realpathSync(
    pinnedGitRaw(input.checkout, "rev-parse", "--show-toplevel")
      .toString("utf8")
      .replace(/\r?\n$/, ""),
  )}${sep}`;
  const checks = [
    ...input.graph.items.flatMap((item) =>
      item.validation.map((check, commandIndex) => ({
        origin: "work-item" as const,
        source: check.source ?? "unknown",
        itemId: item.id,
        commandIndex,
        command: check.command,
      })),
    ),
    ...input.finalCommands.map((command, commandIndex) => ({
      origin: "final" as const,
      source: "OBJECTIVE",
      commandIndex,
      command,
    })),
  ];
  let failure: string | undefined;
  // Inspect the effective shell without executing it. Relative precedence cannot
  // be qualified against a future worktree, and target-owned shells are not host
  // lookup tools. Never fall back to a different shell behind the operator's PATH.
  let shell: string | undefined;
  let shellStatus: "missing" | "unverified" = "missing";
  let shellDetail =
    "Provide an executable host sh on the effective validation PATH; Factory does not substitute shells.";
  for (const directory of (env.PATH ?? "/usr/bin:/bin").split(":")) {
    if (!isAbsolute(directory)) {
      shellStatus = "unverified";
      shellDetail =
        "Relative PATH precedence depends on the future validation worktree; no lookup shell was executed.";
      break;
    }
    const candidate = resolve(directory, "sh");
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      const physical = realpathSync(candidate);
      if (candidate.startsWith(targetRoot) || physical.startsWith(targetRoot)) {
        shellStatus = "unverified";
        shellDetail =
          "The selected sh belongs to the target checkout; no target-controlled lookup shell was executed. Provide a host shell to qualify this toolchain.";
      } else shell = candidate;
      break;
    } catch {
      // Match PATH search by continuing past absent/non-executable candidates.
    }
  }
  for (const check of checks) {
    const report = (
      executable: string,
      status: ExecutablePreflightObservation["status"],
      detail: string,
    ) => {
      const message = redact(
        `Local executable preflight ${status}: ${check.origin}${"itemId" in check ? ` ${check.itemId}` : ""} source ${check.source}, command index ${check.commandIndex}, executable ${executable}; PATH=${pathContext}. ${detail}`,
      );
      input.observe({
        origin: check.origin,
        source: redact(check.source),
        ...("itemId" in check ? { itemId: redact(check.itemId) } : {}),
        commandIndex: check.commandIndex,
        executable: redact(executable),
        status,
        pathContext,
        detail: message,
      });
      if (status === "missing" || status === "version-mismatch")
        failure ??= message;
    };
    const { names, partial } = literalEntrypoints(check.command);
    if (partial)
      report(
        "(dynamic/complex positions)",
        "unverified",
        "Only reliably literal host entrypoints are checked; inspect this command's effective toolchain separately.",
      );
    for (const executable of new Set(["sh", ...names])) {
      if (!shell) {
        report(executable, shellStatus, shellDetail);
        continue;
      }
      const lookup = resolveLocalExecutable(
        executable,
        input.privateRoot,
        env,
        shell,
      );
      if (lookup.error) {
        report(
          "sh",
          "missing",
          "The validation shell must be available on the supplied PATH before host entrypoints can be resolved.",
        );
        continue;
      }
      const resolved = lookup.stdout.trim();
      const relativePath = env.PATH?.split(":").some(
        (part) => !isAbsolute(part),
      );
      if (lookup.status !== 0 || !resolved) {
        report(
          executable,
          relativePath ? "unverified" : "missing",
          relativePath
            ? "Relative PATH entries depend on the future validation worktree; host availability is not established."
            : "Provide this host tool on the effective validation PATH before activating; Factory does not install or substitute tools.",
        );
        continue;
      }
      const builtin = [
        ":",
        ".",
        "[",
        "alias",
        "bg",
        "break",
        "cd",
        "command",
        "continue",
        "echo",
        "eval",
        "exec",
        "exit",
        "export",
        "false",
        "fc",
        "fg",
        "getopts",
        "hash",
        "jobs",
        "kill",
        "pwd",
        "read",
        "readonly",
        "return",
        "set",
        "shift",
        "test",
        "times",
        "trap",
        "true",
        "type",
        "ulimit",
        "umask",
        "unalias",
        "unset",
        "wait",
        "printf",
      ].includes(resolved);
      if (!builtin && (relativePath || !isAbsolute(resolved))) {
        report(
          executable,
          "unverified",
          "Relative PATH precedence or resolution depends on the future validation worktree; inspect it separately.",
        );
        continue;
      }
      if (!builtin) {
        try {
          accessSync(resolved, constants.X_OK);
          if (!statSync(resolved).isFile())
            throw new Error("Not a regular file");
          if (
            resolve(resolved).startsWith(targetRoot) ||
            realpathSync(resolved).startsWith(targetRoot)
          ) {
            report(
              executable,
              "unverified",
              "The resolved executable belongs to the target checkout, not the host toolchain; target executables are not run or qualified by preflight.",
            );
            continue;
          }
        } catch {
          report(
            executable,
            "missing",
            "The resolved host entrypoint must be an executable regular file; correct the host tool installation or PATH.",
          );
          continue;
        }
      }
      report(
        executable,
        "ready",
        `Literal entrypoint resolves to ${resolved}; script bodies and runtime behavior are not qualified.`,
      );
      if (!["npm", "pnpm"].includes(executable) || policy === undefined)
        continue;
      const version =
        typeof policy === "string"
          ? policy.match(/^(npm|pnpm)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/)
          : undefined;
      if (!version) {
        report(
          executable,
          "unverified",
          "Pinned packageManager policy is not a supported exact npm/pnpm version; verify it separately. No version requirement is invented.",
        );
        continue;
      }
      if (version[1] !== executable) continue;
      let actualPath: string;
      try {
        actualPath = realpathSync(resolved);
      } catch {
        report(
          executable,
          "unverified",
          "Version probe requires a resolved host executable.",
        );
        continue;
      }
      if (
        !isAbsolute(resolved) ||
        resolve(resolved).startsWith(targetRoot) ||
        actualPath.startsWith(targetRoot)
      ) {
        report(
          executable,
          "unverified",
          "Target or relative executables are never run by version preflight.",
        );
        continue;
      }
      const probe = spawnSync(actualPath, ["--version"], {
        cwd: input.privateRoot,
        env,
        encoding: "utf8",
      });
      const observed = probe.stdout?.trim();
      if (
        probe.error ||
        probe.status !== 0 ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(observed)
      ) {
        report(
          executable,
          "unverified",
          "Host --version did not supply a recognized exact version; verify the pinned policy separately.",
        );
      } else if (observed !== version[2]) {
        report(
          executable,
          "version-mismatch",
          `Pinned packageManager ${executable}@${version[2]} does not match observed host version ${observed}.`,
        );
      }
    }
  }
  if (failure) throw new Error(failure);
}

/** Observe the Objective's final-command executables; no target commands, state or GitHub writes. */
export function preflightObjective(
  config: FactoryConfig,
  body: string,
  baseSha: string,
): PlanningLocalExecutables | undefined {
  planningSources(body, baseSha, config.checkout);
  const finalCommands = finalObjectiveCommands(body);
  const observations: PlanningLocalExecutables["observations"] = [];
  const root = mkdtempSync(join(tmpdir(), "factory-preflight-"));
  try {
    preflightLocalExecutables({
      checkout: config.checkout,
      baseSha,
      graph: { objective: 1, baseSha, items: [], coverage: [] },
      finalCommands,
      objectiveBody: body,
      privateRoot: root,
      credentialDirectory: join(root, "empty-gh-config"),
      secrets: config.policy.allowedSecretNames.flatMap((name) =>
        process.env[name] ? [process.env[name]!] : [],
      ),
      observe: (entry) => {
        if (entry.origin === "final") observations.push(entry);
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return finalCommands.length
    ? {
        provenance: "controller-local-validation-executable-preflight",
        baseSha,
        finalCommands,
        observations,
      }
    : undefined;
}
