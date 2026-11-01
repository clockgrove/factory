/**
 * Whether validation's exact install failed for the network (#2340): a
 * registry that a DNS or connection failure kept out of reach for a while,
 * the host's outage and never the candidate's. Read from the package
 * manager's structure only, never its prose: npm's error code (npm 11's
 * `npm error code` line), pnpm's ERR_PNPM_* codes, and, for an install
 * pnpm reports as passed, pnpm's own record of what it installed. pnpm 12
 * drops an optional package whose fetch fails and still exits 0, so a
 * formatter's platform binary can go missing with no error at all; its
 * current lockfile (`node_modules/.pnpm/lock.yaml`) then lacks a snapshot
 * the lockfile wants, while a package it skipped for the platform stays in
 * it. npm 11 drops such a package too, but records nothing that tells the
 * drop from a platform skip, so an npm install that exits 0 counts as
 * passed.
 */
import { isAbsolute } from "node:path";
import { parse } from "yaml";

/** npm's error codes for a request that never got an answer. */
const NPM_NETWORK = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_SOCKET_TIMEOUT",
  "ETIMEDOUT",
]);

/**
 * pnpm 12's: metadata it could not fetch, and a tarball request that broke
 * off. pnpm 12 gives a metadata answer of 404 or 500 the same code, with no
 * other structure to tell them apart, so those count as the network too.
 */
const PNPM_NETWORK = new Set([
  "ERR_PNPM_META_FETCH_FAIL",
  "ERR_PNPM_TARBALL_FETCH_TARBALL",
]);

/**
 * Why the install failed for the network, or undefined when it didn't (or
 * nothing says so). `read` gives a file of the checkout the install ran
 * in, or undefined when it can't be read.
 */
export function installOutage(
  manager: "npm" | "pnpm",
  run: { exitCode: number | null; stdout: string; stderr: string },
  read: (path: string) => string | undefined,
): string | undefined {
  const output = `${run.stdout}${run.stderr}`;
  if (run.exitCode !== 0) {
    const code =
      manager === "npm"
        ? [...output.matchAll(/^npm error code (\S+)$/gm)]
            .map((match) => match[1]!)
            .find((each) => NPM_NETWORK.has(each))
        : [...output.matchAll(/\bERR_PNPM_[A-Z0-9_]+\b/g)]
            .map((match) => match[0])
            .find((each) => PNPM_NETWORK.has(each));
    return code && `${manager} failed with ${code}`;
  }
  if (manager !== "pnpm") return undefined;
  const dropped = droppedPackages(read);
  if (!dropped?.length) return undefined;
  const shown = dropped.slice(0, 5).join(", ");
  return `pnpm exited 0 without installing ${dropped.length === 1 ? "a package" : `${dropped.length} packages`} pnpm-lock.yaml lists (${shown}${dropped.length > 5 ? ", ..." : ""}), as it does when an optional package's fetch fails`;
}

/**
 * The snapshots pnpm-lock.yaml wants that pnpm's current lockfile lacks
 * after the install; undefined when pnpm's record can't be read, or when
 * its configuration left some dependencies out on purpose.
 */
function droppedPackages(
  read: (path: string) => string | undefined,
): string[] | undefined {
  const modules = yaml(read("node_modules/.modules.yaml"));
  if (!record(modules)) return undefined;
  const { included, virtualStoreDir } = modules;
  if (record(included) && Object.values(included).includes(false))
    return undefined;
  if (
    typeof virtualStoreDir !== "string" ||
    isAbsolute(virtualStoreDir) ||
    virtualStoreDir.split("/").includes("..")
  )
    return undefined;
  const wanted = snapshots(yaml(read("pnpm-lock.yaml")));
  const current = snapshots(
    yaml(read(`node_modules/${virtualStoreDir}/lock.yaml`)),
  );
  if (!wanted || !current) return undefined;
  return wanted.filter((key) => !current.includes(key));
}

function yaml(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const snapshots = (lockfile: unknown): string[] | undefined =>
  record(lockfile) && record(lockfile.snapshots)
    ? Object.keys(lockfile.snapshots)
    : undefined;
