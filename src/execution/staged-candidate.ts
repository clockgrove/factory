import { workFault } from "../fault.js";
import { ownsPath } from "../ownership.js";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedGit,
  pinnedGitEnvironment,
  pinnedGitRaw,
  sanitizedWorkerEnvironment,
  subprocessAsync,
} from "../process.js";

function inside(path: string, directory: string): boolean {
  const root = resolve(directory);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function changedPaths(worktree: string): string[] {
  const output = pinnedGitRaw(
    worktree,
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "HEAD",
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedEntry(
  worktree: string,
  path: string,
): { mode: string; blob: string } | null {
  const output = pinnedGitRaw(
    worktree,
    "ls-files",
    "--stage",
    "-z",
    "--",
    path,
  );
  if (!output.length) return null;
  const line = output.toString("utf8");
  const match = /^(\d{6}) ([a-f0-9]{40,64}) 0\t([^\0]*)\0$/.exec(line);
  if (!match || match[3] !== path)
    throw new Error(`Cannot verify staged entry at ${JSON.stringify(path)}`);
  return { mode: match[1]!, blob: match[2]! };
}

function checkChangedPath(worktree: string, path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (component) => !component || component === "." || component === "..",
      )
  )
    throw workFault(`Worker changed unsafe path ${JSON.stringify(path)}`);
  const destination = resolve(worktree, path);
  if (!inside(destination, worktree))
    throw workFault(
      `Worker changed path outside worktree: ${JSON.stringify(path)}`,
    );
  let current = worktree;
  for (const component of path.split("/")) {
    current = join(current, component);
    let type;
    try {
      type = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (type.isSymbolicLink() || (!type.isFile() && !type.isDirectory()))
      throw workFault(
        `Worker changed unsafe filesystem entry at ${JSON.stringify(path)}`,
      );
  }
  if (existsSync(destination) && !inside(realpathSync(destination), worktree))
    throw workFault(
      `Worker changed path escaping worktree: ${JSON.stringify(path)}`,
    );
}

/** Ignored links are not delivery candidates, but must still resolve safely. */
function safeIgnoredLink(worktree: string, path: string): boolean {
  if (pinnedGitRaw(worktree, "ls-files", "--stage", "-z", "--", path).length)
    return false; // A staged entry or descendant cannot use this exception.
  const env = pinnedGitEnvironment();
  // check-ignore accepts literal filenames, not pathspecs; that switch is unsupported.
  delete env.GIT_LITERAL_PATHSPECS;
  const ignored = spawnSync(
    "git",
    ["-C", worktree, "check-ignore", "-q", "--", path],
    {
      env,
    },
  );
  if (ignored.error) throw ignored.error;
  if (ignored.status === 1) return false;
  if (ignored.status !== 0)
    throw new Error(`Cannot verify ignored entry at ${JSON.stringify(path)}`);
  try {
    const destination = realpathSync(join(worktree, path));
    if (
      destination === resolve(worktree) ||
      !inside(destination, worktree) ||
      inside(destination, join(worktree, ".git"))
    )
      return false;
    const type = lstatSync(destination);
    return type.isFile() || type.isDirectory();
  } catch {
    return false; // Missing, cyclic or unreadable targets are not safe generated links.
  }
}

/** Recurse even through ignored directories: special files and unsafe links still fail. */
function checkWorktreeEntries(
  worktree: string,
  acceptedIgnoredLinks?: string[],
): void {
  const inspect = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory)) {
      if (!relative && name === ".git") continue;
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(directory, name);
      const type = lstatSync(absolute);
      if (type.isDirectory()) {
        inspect(absolute, path);
      } else if (type.isSymbolicLink()) {
        const base = pinnedGitRaw(
          worktree,
          "ls-tree",
          "HEAD",
          "--",
          path,
        ).toString("utf8");
        if (
          !base.startsWith("120000 blob\t") &&
          !base.startsWith("120000 blob ")
        ) {
          if (base.length === 0 && safeIgnoredLink(worktree, path))
            acceptedIgnoredLinks?.push(path);
          else
            throw workFault(
              `Worker introduced unsafe symlink at ${JSON.stringify(path)}`,
            );
        }
      } else if (!type.isFile()) {
        throw workFault(
          `Worker introduced special file at ${JSON.stringify(path)}`,
        );
      }
    }
  };
  inspect(worktree, "");
}

const secretlint = fileURLToPath(new URL("./secret-scan.js", import.meta.url));
const recommendedRules = JSON.stringify({
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
});

async function scanChangedFile(
  worktree: string,
  path: string,
  source: string,
  report: string,
  checkout: string,
): Promise<void> {
  const config = process.env.FACTORY_SECRETLINT_CONFIG;
  if (
    config &&
    (!isAbsolute(config) ||
      inside(config, checkout) ||
      inside(config, worktree) ||
      !lstatSync(config).isFile() ||
      inside(realpathSync(config), checkout) ||
      inside(realpathSync(config), worktree))
  )
    throw new Error(
      "FACTORY_SECRETLINT_CONFIG must be a regular absolute file outside the target checkout",
    );
  const args = [
    secretlint,
    source,
    config ? readFileSync(config, "utf8") : recommendedRules,
  ];
  const output = openSync(report, "w", 0o600);
  let result;
  try {
    result = await subprocessAsync(process.execPath, args, {
      cwd: worktree,
      stdio: ["ignore", output, output],
      env: sanitizedWorkerEnvironment(
        join(dirname(worktree), "empty-gh-config"),
      ),
    });
  } finally {
    closeSync(output);
  }
  if (![0, 1].includes(result.status ?? -1))
    throw new Error(
      `Secretlint could not check ${JSON.stringify(path)}; publication stopped`,
    );
  if (result.status === 1) {
    const fd = openSync(report, "r");
    const excerpt = Buffer.alloc(8192);
    let count: number;
    try {
      count = readSync(fd, excerpt, 0, excerpt.length, 0);
    } finally {
      closeSync(fd);
    }
    const rules = [
      ...excerpt
        .subarray(0, count)
        .toString("utf8")
        .matchAll(/@secretlint\/secretlint-rule-[A-Za-z0-9-]+/g),
    ].map((match) => match[0]);
    throw workFault(
      `Secretlint found suspected secret in ${JSON.stringify(path)} (${rules.at(-1) ?? "Secretlint recommended rules"}). Publication stopped. Operator: review the finding; remove or rotate the value, or supply a reviewed Secretlint config outside the target checkout via FACTORY_SECRETLINT_CONFIG and explicitly retry.`,
    );
  }
}

/** Private worker notes cross the same secret boundary before retention or dispatch. */
export async function scanPrivateStaging(
  worktree: string,
  checkout: string,
  path: string,
): Promise<void> {
  const scanRoot = mkdtempSync(join(dirname(worktree), "secret-scan-"));
  try {
    await scanChangedFile(
      worktree,
      path,
      join(worktree, path),
      join(scanRoot, "report.txt"),
      checkout,
    );
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
}

/** Guard the staged candidate before any controller-side publication or upload. */
export async function checkStagedCandidate(
  worktree: string,
  checkout: string,
  ownedPaths: string[],
  acceptedIgnoredLinks?: string[],
): Promise<string[]> {
  checkWorktreeEntries(worktree, acceptedIgnoredLinks);
  const paths = changedPaths(worktree);
  const unowned = paths.filter((path) => !ownsPath(path, ownedPaths));
  if (unowned.length)
    throw workFault(
      `Worker changed paths outside ownership: ${unowned.join(", ")}`,
    );
  for (const path of paths) {
    checkChangedPath(worktree, path);
    const entry = stagedEntry(worktree, path);
    if (!entry) continue; // Deletion has no new content to publish.
    if (path === ".gitmodules" || !["100644", "100755"].includes(entry.mode))
      throw workFault(
        `Worker changed unsafe Git entry at ${JSON.stringify(path)}`,
      );
    const scanRoot = mkdtempSync(join(dirname(worktree), "secret-scan-"));
    try {
      const staged = join(scanRoot, "content", path);
      mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
      const output = openSync(staged, "wx", 0o600);
      let copy;
      try {
        copy = await subprocessAsync(
          "git",
          ["-C", worktree, "cat-file", "blob", entry.blob],
          {
            env: pinnedGitEnvironment(),
            stdio: ["ignore", output, "ignore"],
          },
        );
      } finally {
        closeSync(output);
      }
      if (copy.status !== 0)
        throw new Error(
          `Cannot read staged content at ${JSON.stringify(path)}`,
        );
      const report = join(scanRoot, "report.txt");
      await scanChangedFile(worktree, path, staged, report, checkout);
      if (
        pinnedGit(worktree, "hash-object", "--no-filters", "--", path) !==
        entry.blob
      )
        await scanChangedFile(
          worktree,
          path,
          join(worktree, path),
          report,
          checkout,
        );
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  }
  return paths;
}
