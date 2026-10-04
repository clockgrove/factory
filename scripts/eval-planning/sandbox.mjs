// Linux mount-namespace sandbox for plan judges, built with bubblewrap. The
// judge process sees the system directories, the Factory code it runs, its
// own scratch directory and the provider logins bound into it. Every other
// path, including /home, /tmp and the eval's output, does not exist inside.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc"];
/** Environment a judge may inherit; everything else is dropped. */
const ENVIRONMENT = [
  /^PATH$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^TZ$/,
  /^(?:HTTPS?|NO|ALL)_PROXY$/i,
  /^NODE_EXTRA_CA_CERTS$/,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^ANTHROPIC_[A-Z_]+$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^OPENAI_(?:API_KEY|BASE_URL)$/,
  /^CODEX_API_KEY$/,
];

function findBubblewrap() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "bwrap");
    if (directory && existsSync(candidate)) return candidate;
  }
  return null;
}

let available;
/** The bubblewrap binary when it can create a sandbox here, else null. */
export function sandboxBinary() {
  if (available !== undefined) return available;
  const bwrap = findBubblewrap();
  available = null;
  if (bwrap)
    try {
      execFileSync(
        bwrap,
        [
          "--unshare-all",
          "--share-net",
          ...systemBinds(),
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--",
          "true",
        ],
        { stdio: "ignore" },
      );
      available = bwrap;
    } catch {
      // No user namespaces, or bubblewrap is blocked.
    }
  return available;
}

function systemBinds() {
  const args = [];
  for (const path of SYSTEM) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink())
      args.push("--symlink", readlinkSync(path), path);
    else args.push("--ro-bind", path, path);
  }
  // resolv.conf often links outside /etc (systemd-resolved, WSL).
  if (existsSync("/etc/resolv.conf")) {
    const resolv = realpathSync("/etc/resolv.conf");
    if (!SYSTEM.some((path) => resolv.startsWith(`${path}/`)))
      args.push("--ro-bind", resolv, resolv);
  }
  const node = realpathSync(process.execPath);
  if (!SYSTEM.some((path) => node.startsWith(`${path}/`))) {
    const prefix = dirname(dirname(node));
    args.push("--ro-bind", prefix, prefix);
  }
  return args;
}

/** The judge's environment: the allowlist above plus `extra`. */
export function sandboxEnvironment(extra) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        ENVIRONMENT.some((pattern) => pattern.test(name)),
      ),
    ),
    ...extra,
  };
}

/**
 * bubblewrap arguments: system directories and `readOnly` paths read-only, a
 * fresh /tmp, `scratch` writable, and each [source, destination] in
 * `readWrite` bound writable (logins, so token refreshes reach the operator).
 */
export function sandboxArguments({ scratch, readOnly, readWrite, cwd }) {
  return [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    ...systemBinds(),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...readOnly
      .filter((path) => existsSync(path))
      .flatMap((path) => ["--ro-bind", path, path]),
    "--bind",
    scratch,
    scratch,
    ...readWrite
      .filter(([source]) => existsSync(source))
      .flatMap(([source, destination]) => ["--bind", source, destination]),
    "--chdir",
    cwd,
  ];
}
