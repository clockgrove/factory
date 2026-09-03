import { execFileSync } from "node:child_process";

type Environment = Readonly<Record<string, string | undefined>>;
type TokenCommand = () => string;

/**
 * Resolve the operator's GitHub credential without storing or printing it.
 *
 * Agent Plugins deliberately has no portable secret-reference field, and a
 * conforming host may sanitize the ambient subprocess environment.  Prefer an
 * explicitly forwarded token when one exists; otherwise ask the already
 * authenticated GitHub CLI.  The latter is especially important for Codex,
 * where `gh auth login` is the normal local credential boundary but plugin MCP
 * processes do not automatically inherit `GH_TOKEN`.
 */
export function resolveGitHubToken(
  env: Environment = process.env,
  readGhToken: TokenCommand = () =>
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }),
): string {
  const forwarded = env["GITHUB_TOKEN"]?.trim() || env["GH_TOKEN"]?.trim();
  if (forwarded) return forwarded;

  try {
    const token = readGhToken().trim();
    if (token) return token;
  } catch {
    // The actionable, credential-free error below is more useful than the
    // platform-specific spawn/exit error from `gh`.
  }

  throw new Error(
    "GitHub authentication unavailable: set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`",
  );
}
