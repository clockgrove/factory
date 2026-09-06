import { execFile } from "node:child_process";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  normalizePinnedLfsFacts,
  parseLfsPointer,
  type PinnedLfsFacts,
} from "../repository-profiles/git-lfs.js";

const execFileAsync = promisify(execFile);

export async function readCheckoutGit(checkout: string, args: string[]): Promise<string> {
  const result = await execFileAsync(
    "git",
    [
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-C",
      checkout,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
      },
    },
  );
  return result.stdout;
}

function githubRepository(remote: string): string | null {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (scp) return scp[1]!.toLowerCase();
  try {
    const url = new URL(remote);
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.hostname !== "github.com" ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Identity and inventory only: no checkout, fetch, hooks, index refresh, or remote request. */
export async function inspectLocalCheckout(checkout: string, expectedRepository?: string) {
  const root = await realpath(checkout);
  const top = await realpath(
    (await readCheckoutGit(root, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (root !== top) throw new Error("checkout path must name the repository root");
  const origin = githubRepository(
    (await readCheckoutGit(root, ["config", "--get", "remote.origin.url"])).trim(),
  );
  if (!origin || (expectedRepository && origin !== expectedRepository.toLowerCase()))
    throw new Error("checkout origin does not match the requested GitHub repository");
  const head = (await readCheckoutGit(root, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/i.test(head))
    throw new Error("checkout HEAD is not a supported commit identity");
  const files = (await readCheckoutGit(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]))
    .split("\0")
    .filter(Boolean);
  if (files.length > 10_000) throw new Error("checkout inventory exceeds the compilation bound");
  return { root, repository: origin, head, files };
}

/** Compare raw Git blobs; git status can execute a repository's clean filters. */
export async function assertCleanPlanningFiles(
  checkout: string,
  repositoryLfs?: PinnedLfsFacts,
): Promise<void> {
  const head = (await readCheckoutGit(checkout, ["rev-parse", "HEAD"])).trim();
  const lfs = repositoryLfs ? normalizePinnedLfsFacts(repositoryLfs) : undefined;
  if (lfs && lfs.baseSha !== head)
    throw new Error("planning LFS facts differ from the selected checkout base");
  const tree = (await readCheckoutGit(checkout, ["ls-tree", "-r", "-z", head]))
    .split("\0")
    .filter(Boolean);
  const index = (await readCheckoutGit(checkout, ["ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean);
  const expectedIndex = tree.map((entry) =>
    entry.replace(/^(\d+) blob ([0-9a-f]+)\t/, "$1 $2 0\t"),
  );
  if (JSON.stringify(index) !== JSON.stringify(expectedIndex))
    throw new Error(
      "planning checkout index differs from selected base or has unsupported submodules",
    );
  if (
    (await readCheckoutGit(checkout, ["ls-files", "--others", "--exclude-standard", "-z"])).length
  )
    throw new Error("planning checkout has untracked changes; refusing mixed-revision compilation");
  let totalBytes = 0;
  for (const entry of tree) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("planning checkout contains an unsupported Git object");
    const [, mode, oid, path] = match;
    const asset = lfs?.assets.find((candidate) => candidate.path === path);
    if (asset) {
      if (asset.pointerBlobOid !== oid || asset.mode !== mode)
        throw new Error("planning LFS pointer/index identity differs from verified source");
      const pointer = parseLfsPointer(
        Buffer.from(await readCheckoutGit(checkout, ["cat-file", "blob", oid!])),
      );
      if (!pointer || pointer.oid !== asset.oid || pointer.size !== asset.size)
        throw new Error("planning LFS content identity differs from its actual Git pointer");
    }
    const target = join(checkout, path!);
    if ((await realpath(dirname(target))) !== dirname(target))
      throw new Error("planning checkout contains a replaced parent directory");
    const stat = await lstat(target);
    if ((mode === "120000") !== stat.isSymbolicLink())
      throw new Error("planning checkout contains a changed file type");
    const bytes =
      mode === "120000" && stat.isSymbolicLink() ? Buffer.from(await readlink(target)) : null;
    if (!bytes && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error("planning checkout contains a changed file type");
    if (mode !== "120000" && ((stat.mode & 0o111) !== 0) !== (mode === "100755"))
      throw new Error("planning checkout contains changed executable permissions");
    const size = bytes?.length ?? stat.size;
    totalBytes += size;
    if (totalBytes > 256 * 1024 * 1024)
      throw new Error("planning checkout content exceeds the 256 MiB read-only verification bound");
    const hash = createHash("sha1").update(`blob ${size}\0`);
    const contentHash = asset ? createHash("sha256") : undefined;
    if (bytes) hash.update(bytes);
    else {
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.size !== size ||
          ((before.mode & 0o111) !== 0) !== (mode === "100755")
        )
          throw new Error("planning checkout file changed during observation");
        let observedBytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          observedBytes += chunk.length;
          if (observedBytes > size)
            throw new Error("planning checkout file grew during observation");
          hash.update(chunk);
          contentHash?.update(chunk);
        }
        const after = await file.stat();
        if (
          observedBytes !== size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("planning checkout file changed during observation");
      } finally {
        await file.close();
      }
    }
    const hydrated = asset && size === asset.size && contentHash?.digest("hex") === asset.oid;
    if (hash.digest("hex") !== oid && !hydrated)
      throw new Error(
        "planning checkout has tracked changes or requires content filters; refusing mixed-revision compilation",
      );
  }
  if ((await readCheckoutGit(checkout, ["rev-parse", "HEAD"])).trim() !== head)
    throw new Error("planning checkout base changed during observation");
}
