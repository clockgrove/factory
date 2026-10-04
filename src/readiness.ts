import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeClaudeLogin } from "./claude-planning.js";
import { type FactoryConfig, stateRoot } from "./config.js";
import { probeCodexReadiness } from "./harness-readiness.js";
import {
  credentialFileBindings,
  executionCredential,
  optionalProviderCredentials,
  requiredProviderCredentials,
  resolveProviderCredential,
} from "./provider-credentials.js";

/**
 * What the preflight found. `document` is the full model-free report; a failing check also
 * names `detail` and `fix`, which setup and run print and stop on.
 */
export interface Readiness {
  ready: boolean;
  document: { status: string; [key: string]: unknown };
  detail?: string;
  fix?: string;
}

const fail = (
  document: Readiness["document"],
  detail: string,
  fix: string,
): Readiness => ({ ready: false, document, detail, fix });

/**
 * The checks `factory setup --background` and a first `factory run` share, before any model
 * is called: the configured provider credentials, the Claude login planning needs, and the
 * default local Codex harness's sandbox. Service bindings are checked as files; a foreground
 * run uses the environment.
 */
export async function checkReadiness(
  config: FactoryConfig,
  input: { credentialFiles?: string[]; outsideDirectory?: string } = {},
): Promise<Readiness> {
  const credentialFiles = input.credentialFiles ?? [];
  const required = requiredProviderCredentials(config);
  let bindings: { name: string; file: string }[] = [];
  try {
    if (credentialFiles.length)
      bindings = credentialFileBindings(config, credentialFiles);
    else for (const name of required) resolveProviderCredential(config, name);
  } catch (error) {
    return fail(
      {
        status: "missing",
        credentials: required,
        detail: String(error),
        accountAccess: "not verified",
      },
      String(error),
      `Provide ${required.join(", ") || "the configured credentials"} in the environment of the shell that runs Factory (the service takes --credential-file NAME=ABSOLUTE_PRIVATE_FILE on factory setup --background)`,
    );
  }
  // Claude planning needs a login the Agent SDK resolves; check it model-free.
  let planning: Record<string, unknown> | undefined;
  if (config.planning.kind === "claude-agent-sdk") {
    const optional = optionalProviderCredentials(config);
    const login = await probeClaudeLogin(
      Object.fromEntries(
        bindings
          .filter(({ name }) => optional.includes(name))
          .map(({ name, file }) => [name, readFileSync(file, "utf8").trim()]),
      ),
    );
    if (login.status !== "present")
      return fail(
        { status: "missing", planning: login },
        String(login.detail ?? "No Claude login is available for planning"),
        "Run `claude auth login` on this host",
      );
    planning = { ...login, accountAccess: "not verified" };
  }
  // Remote execution has no local harness to probe beyond its credential.
  if (executionCredential(config))
    return {
      ready: true,
      document: {
        status: "present",
        credentials: required,
        ...(planning && { planning }),
        source: credentialFiles.length
          ? "owner-private service credential"
          : "controller environment",
        accountAccess: "not verified",
      },
    };
  const harness =
    config.execution.kind === "local"
      ? (config.execution.profiles?.[config.execution.defaultProfile ?? ""]
          ?.harness ?? config.execution.harness)
      : undefined;
  if (harness?.kind !== "codex-sdk")
    return {
      ready: true,
      document: {
        status: "not-assessed",
        ...(planning && { planning }),
        detail:
          "The model-free sandbox probe covers the default local Codex harness only; this harness is not probed",
        controllerValidation: "not assessed",
      },
    };
  const credentials = join(stateRoot(config.repository), "empty-gh-config");
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const result = await probeCodexReadiness({
    workspace: config.checkout,
    outsideDirectory: input.outsideDirectory,
    credentialDirectory: credentials,
    network: config.policy.network,
    allowedSecretNames: config.policy.allowedSecretNames,
  });
  const document = {
    ...result,
    ...(planning && { planning }),
    scope: "configured default implementation harness",
    controllerValidation:
      "not assessed; run source-declared acceptance commands in their declared environment",
  };
  return result.status === "ready"
    ? { ready: true, document }
    : fail(
        document,
        result.detail,
        "Make the Codex sandbox usable on this host as the detail says (setup --background takes --outside-directory DIR for a directory the probe may write)",
      );
}
