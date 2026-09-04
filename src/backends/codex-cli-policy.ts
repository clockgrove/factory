const NETWORK_DESTINATION =
  /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export type CodexSandboxMode = "read-only" | "workspace-write";

function domainPolicy(destinations: string[]): string {
  const unique = validateNetworkDestinations(destinations);
  return `{ ${unique.map((destination) => `${JSON.stringify(destination)} = "allow"`).join(", ")} }`;
}

function validateNetworkDestinations(destinations: string[]): string[] {
  const unique = [...new Set(destinations)].sort();
  for (const destination of unique) {
    if (!NETWORK_DESTINATION.test(destination)) {
      throw new Error(`invalid Codex command-network destination: ${destination}`);
    }
  }
  return unique;
}

export interface RestrictedCodexConfig {
  web_search: "disabled";
  sandbox_workspace_write: { network_access: boolean };
  features?: {
    network_proxy: {
      enabled: true;
      domains: Record<string, "allow">;
    };
  };
}

/** Structured equivalent of {@link restrictedCodexArgs} for the Codex SDK. */
export function restrictedCodexConfig(
  sandbox: CodexSandboxMode,
  networkDestinations: string[] = [],
): RestrictedCodexConfig {
  if (sandbox === "read-only" && networkDestinations.length > 0) {
    throw new Error("read-only Codex management runs cannot request command network access");
  }
  const destinations = validateNetworkDestinations(networkDestinations);
  const networkEnabled = sandbox === "workspace-write" && destinations.length > 0;
  return {
    web_search: "disabled",
    sandbox_workspace_write: { network_access: networkEnabled },
    ...(networkEnabled
      ? {
          features: {
            network_proxy: {
              enabled: true as const,
              domains: Object.fromEntries(
                destinations.map((destination) => [destination, "allow" as const]),
              ),
            },
          },
        }
      : {}),
  };
}

/**
 * Security-critical global arguments shared by every host-local Codex process.
 *
 * `never` makes boundary violations fail instead of turning an unattended run
 * into an approval queue. Web search is disabled because it is outside the
 * command-network proxy. A worker gets command network access only when its
 * preflighted Work Packet names at least one destination, and then the same
 * exact list becomes the proxy's allow-first policy.
 */
export function restrictedCodexArgs(
  sandbox: CodexSandboxMode,
  networkDestinations: string[] = [],
): string[] {
  if (sandbox === "read-only" && networkDestinations.length > 0) {
    throw new Error("read-only Codex management runs cannot request command network access");
  }
  const networkEnabled = sandbox === "workspace-write" && networkDestinations.length > 0;
  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    sandbox,
    "-c",
    'web_search="disabled"',
    "-c",
    `sandbox_workspace_write.network_access=${networkEnabled}`,
  ];
  if (networkEnabled) {
    args.push(
      "-c",
      "features.network_proxy.enabled=true",
      "-c",
      `features.network_proxy.domains=${domainPolicy(networkDestinations)}`,
    );
  }
  return args;
}
