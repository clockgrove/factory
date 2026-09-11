import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { sanitizedWorkerEnvironment, terminateProcessGroup } from "../runtime/process-group.js";

const MAX_FILES = 5000;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const options = [
  "--no-optional-locks",
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "credential.helper=",
];

async function readPinnedGit(
  cwd: string,
  args: string[],
  input: {
    env: NodeJS.ProcessEnv;
    deadline: number;
    now: () => number;
    maxBuffer: number;
    stdin?: string;
    signal?: AbortSignal;
  },
): Promise<Buffer> {
  const timeoutMs = input.deadline - input.now();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("pinned compilation preparation deadline exceeded");
  }
  input.signal?.throwIfAborted();
  const child = spawn("git", [...options, ...args], {
    cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let diagnostic = "";
  let outputFailure: Error | undefined;
  let deadlineElapsed = false;
  let termination: Promise<void> | undefined;
  let rejectTermination!: (reason: unknown) => void;
  const terminationFailure = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const stop = (): Promise<void> => {
    if (termination) return termination;
    termination = (async () => {
      if (!child.pid) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return;
      }
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return;
      }
      await terminateProcessGroup(child.pid, "SIGKILL", 0);
    })();
    void termination.then(undefined, rejectTermination);
    return termination;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > input.maxBuffer) {
      outputFailure = new Error("pinned compilation Git object read exceeded its byte bound");
      void stop();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8_192);
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input.stdin);
  const onAbort = (): void => {
    void stop();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    deadlineElapsed = true;
    void stop();
  }, timeoutMs);
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      void stop();
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
  try {
    await Promise.race([closed, terminationFailure]);
    if (termination) await termination;
    input.signal?.throwIfAborted();
    if (deadlineElapsed) throw new Error("pinned compilation preparation deadline exceeded");
    if (outputFailure) throw outputFailure;
    if (exitCode !== 0) {
      throw new Error(
        `pinned compilation Git object read failed (${exitCode ?? exitSignal}): ${diagnostic}`,
      );
    }
    return Buffer.concat(stdout, stdoutBytes);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/** Materialize raw exact Git blobs, never checkout hooks, filters, package commands or
 * repository executables. The separate clean Git config gives read-only management an
 * exact index/HEAD without inheriting source repository settings or credentials. */
export async function materializePinnedCompilationTree(
  repository: string,
  baseSha: string,
  input: {
    purpose?: "compilation" | "worktree";
    deadline?: Date;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("invalid compilation base SHA");
  const now = input.now ?? Date.now;
  const deadline = Math.min(now() + 120_000, input.deadline?.getTime() ?? Number.POSITIVE_INFINITY);
  const env = sanitizedWorkerEnvironment(process.env);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  });
  const git = async (cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024, stdin?: string) => {
    try {
      return await readPinnedGit(cwd, args, {
        env,
        deadline,
        now,
        maxBuffer,
        ...(stdin === undefined ? {} : { stdin }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new Error("pinned compilation Git object read failed");
    }
  };
  if (
    (await git(repository, ["rev-parse", "--verify", `${baseSha}^{commit}`]))
      .toString("utf8")
      .trim() !== baseSha
  )
    throw new Error("compilation base did not resolve exactly");
  const listing = await git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseSha]);
  const entries = new TextDecoder("utf-8", { fatal: true })
    .decode(listing)
    .split("\0")
    .filter(Boolean);
  if (entries.length > MAX_FILES) throw new Error("pinned compilation tree exceeds 5000 files");
  let bytes = 0;
  const objectsToRead = entries.map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(entry);
    if (!match)
      throw new Error("pinned compilation tree contains an unsupported path or Git entry mode");
    const mode = match[1]!,
      oid = match[2]!,
      rawSize = match[3]!,
      path = match[4]!;
    if (
      path.includes("\\") ||
      path
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      Array.from(path).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("pinned compilation tree path is unsafe");
    const size = Number(rawSize);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_BLOB_BYTES ||
      bytes + size > MAX_TREE_BYTES
    )
      throw new Error("pinned compilation tree exceeds raw blob or aggregate byte limits");
    bytes += size;
    return { mode, oid, size, path };
  });
  // A single bounded batch reads exactly the listed objects; no lazy fetch,
  // filter conversion or process-per-file overhead is permitted.
  const batch = objectsToRead.length
    ? await git(
        repository,
        ["cat-file", "--batch"],
        MAX_TREE_BYTES + MAX_FILES * 128,
        objectsToRead.map(({ oid }) => `${oid}\n`).join(""),
      )
    : Buffer.alloc(0);
  const root = await mkdtemp(
    join(
      tmpdir(),
      input.purpose === "worktree" ? "clockgrove-factory-worktree-" : "factory-compilation-tree-",
    ),
  );
  const checkout = input.purpose === "worktree" ? join(root, "worktree") : root;
  try {
    if (checkout !== root) await mkdir(checkout);
    const files: string[] = [];
    let cursor = 0;
    for (const { mode, oid, size, path } of objectsToRead) {
      if (now() >= deadline) throw new Error("pinned compilation preparation deadline exceeded");
      const target = resolve(checkout, path);
      if (!target.startsWith(checkout + sep))
        throw new Error("pinned compilation path escaped its owned directory");
      const headerEnd = batch.indexOf(10, cursor);
      if (
        headerEnd < cursor ||
        headerEnd - cursor > 128 ||
        batch.subarray(cursor, headerEnd).toString("ascii") !== `${oid} blob ${size}`
      )
        throw new Error("pinned compilation batch object identity differs");
      cursor = headerEnd + 1;
      if (cursor + size >= batch.length || batch[cursor + size] !== 10)
        throw new Error("pinned compilation blob size changed");
      const blob = batch.subarray(cursor, cursor + size);
      cursor += size + 1;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blob, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
      files.push(path);
    }
    if (cursor !== batch.length)
      throw new Error("pinned compilation batch contains unrequested bytes");
    await git(checkout, ["init", "--quiet", "--template="]);
    const objects = resolve(
      repository,
      (await git(repository, ["rev-parse", "--git-path", "objects"])).toString("utf8").trim(),
    );
    if (/[\r\n]/.test(objects)) throw new Error("unsafe compilation object-store path");
    await writeFile(join(checkout, ".git", "objects", "info", "alternates"), `${objects}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await git(checkout, ["read-tree", baseSha]);
    // read-tree does not populate worktree stat data. Refresh in this new
    // hook/filter-free configuration before hydration so immediate --index
    // application recognizes the exact raw files without a prior `git status`.
    await git(checkout, ["update-index", "--refresh"]);
    await git(checkout, ["update-ref", "--no-deref", "HEAD", baseSha]);
    return {
      path: checkout,
      root,
      files: files.sort(),
      baseSha,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
