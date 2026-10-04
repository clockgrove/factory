import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

/**
 * The name recorded on decisions, selections and re-reviews. A container whose UID has no
 * passwd entry has no `userInfo()`, so fall back to `$USER`, then the git identity.
 */
export function operatorName(lookup: { user?: () => string } = {}): string {
  const attempts: (() => string | undefined)[] = [
    lookup.user ?? (() => userInfo().username),
    () => process.env.USER || process.env.LOGNAME,
    () =>
      execFileSync("git", ["config", "--get", "user.name"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
  ];
  for (const attempt of attempts)
    try {
      const name = attempt();
      if (name) return name;
    } catch {
      // Try the next source.
    }
  throw new Error(
    "Cannot tell who you are: this account has no user name. Set USER (for example `USER=you factory decide ...`) or run `git config --global user.name YOU`",
  );
}
