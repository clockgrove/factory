import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * A target checkout's origin is bound to the configured GitHub repository
 * when Factory validates the target. Its configuration stays writable by
 * workers, so Factory's remote git commands re-verify the binding before
 * every fetch or push.
 */

/** Parse only supported GitHub clone URLs; never return credentials or raw URLs. */
export function remoteRepository(remote: string): string | undefined {
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

/** Origin's fetch or push repositories, after insteadOf rewriting. */
export function originRepositories(
  checkout: string,
  push: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
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
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
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
export function validateLfsRouting(
  checkout: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
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
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
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
        env,
        stdio: "ignore",
      });
    } catch {
      continue;
    }
    check(["--blob", blob]);
  }
}

/** Origin no longer resolves to the repository it was bound to. */
export class OriginBindingChanged extends Error {}

/** Origin (fetch and push, after rewriting) and its LFS route serve `repository`. */
export function assertOrigin(
  checkout: string,
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    for (const push of [false, true])
      for (const remote of originRepositories(checkout, push, env))
        if (remote !== repository.toLowerCase())
          throw new Error(
            `Origin ${push ? "push" : "fetch"} repository does not match configured repository ${repository.toLowerCase()}; correct the remote binding before using Factory`,
          );
    validateLfsRouting(checkout, env);
  } catch (error) {
    throw new OriginBindingChanged(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/** Bound repositories by git common directory. */
const bindings = new Map<string, string>();

function commonDirectory(directory: string): string | undefined {
  try {
    return realpathSync(
      execFileSync(
        "git",
        [
          "-C",
          directory,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim(),
    );
  } catch {
    return undefined;
  }
}

/** Record that `checkout` (and its linked worktrees) serves `repository`. */
export function bindOrigin(checkout: string, repository: string): void {
  const key = commonDirectory(checkout);
  if (!key)
    throw new Error(`Cannot bind origin of ${checkout}: not a Git repository`);
  bindings.set(key, repository.toLowerCase());
}

/** The repository `directory`'s origin was bound to, if any. */
export function boundRepository(directory: string): string | undefined {
  const key = existsSync(directory) ? commonDirectory(directory) : undefined;
  return key ? bindings.get(key) : undefined;
}

/** Whether `repository` is bound for any checkout. */
export function isBoundRepository(repository: string): boolean {
  return [...bindings.values()].includes(repository.toLowerCase());
}
