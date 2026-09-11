import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { repositoryArchive } from "../src/backends/sandbox-common.js";
import { materializePinnedCompilationTree } from "../src/execution/pinned-compilation-tree.js";
import { streamCommandFile } from "../src/runtime/artifact-patch.js";
import { processGroupExists } from "../src/runtime/process-group.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function expectAbsent(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function fixture(): Promise<{ repository: string; baseSha: string }> {
  const repository = await mkdtemp(join(tmpdir(), "factory-archive-deadline-repository-"));
  cleanup.push(repository);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: repository,
  });
  await writeFile(join(repository, "input.txt"), "source\n");
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "source"], { cwd: repository });
  return {
    repository,
    baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
  };
}

async function signalIgnoringExecutable(root: string, name: string): Promise<string> {
  const executable = join(root, name);
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s' "$$" > "$STALL_PID_FILE"
if [ -n "$STALL_CWD_FILE" ]; then pwd > "$STALL_CWD_FILE"; fi
trap '' TERM
(
  trap '' TERM
  sleep 0.5
  printf late > "$LATE_MARKER"
) &
while :; do sleep 1; done
`,
    { mode: 0o700 },
  );
  return executable;
}

async function installSignalIgnoringGit(root: string, stallOn: string): Promise<void> {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  await mkdir(bin);
  const git = join(bin, "git");
  await writeFile(
    git,
    `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "$STALL_ON" ]; then
    exec "$STALL_EXECUTABLE"
  fi
done
exec "$REAL_GIT" "$@"
`,
    { mode: 0o700 },
  );
  vi.stubEnv("REAL_GIT", realGit);
  vi.stubEnv("STALL_ON", stallOn);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
}

describe.skipIf(process.platform !== "linux")("source archive process deadlines", () => {
  it("kills and reaps the pinned-tree process group before removing its owned root", async () => {
    const source = await fixture();
    const root = await mkdtemp(join(tmpdir(), "factory-pinned-deadline-test-"));
    cleanup.push(root);
    const pidFile = join(root, "pid");
    const cwdFile = join(root, "cwd");
    const lateMarker = join(root, "late");
    const executable = await signalIgnoringExecutable(root, "stall");
    await installSignalIgnoringGit(root, "init");
    vi.stubEnv("STALL_EXECUTABLE", executable);
    vi.stubEnv("STALL_PID_FILE", pidFile);
    vi.stubEnv("STALL_CWD_FILE", cwdFile);
    vi.stubEnv("LATE_MARKER", lateMarker);
    const controller = new AbortController();

    const preparation = materializePinnedCompilationTree(source.repository, source.baseSha, {
      deadline: new Date(Date.now() + 30_000),
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    controller.abort(new Error("pinned tree deadline elapsed"));
    await expect(preparation).rejects.toThrow("pinned compilation Git object read failed");

    const pid = Number(await readFile(pidFile, "utf8"));
    const ownedRoot = (await readFile(cwdFile, "utf8")).trim();
    expect(processGroupExists(pid)).toBe(false);
    await expectAbsent(ownedRoot);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expectAbsent(lateMarker);
  });

  it("kills and reaps git archive before unlinking its destination", async () => {
    const source = await fixture();
    const root = await mkdtemp(join(tmpdir(), "factory-git-archive-deadline-test-"));
    cleanup.push(root);
    const pidFile = join(root, "pid");
    const lateMarker = join(root, "late");
    const executable = await signalIgnoringExecutable(root, "stall");
    await installSignalIgnoringGit(root, "archive");
    vi.stubEnv("STALL_EXECUTABLE", executable);
    vi.stubEnv("STALL_PID_FILE", pidFile);
    vi.stubEnv("LATE_MARKER", lateMarker);
    const controller = new AbortController();

    const preparation = repositoryArchive(source.repository, source.baseSha, {
      deadline: new Date(Date.now() + 30_000),
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    controller.abort(new Error("git archive deadline elapsed"));
    await expect(preparation).rejects.toThrow(/bounded Git content command failed/);

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(processGroupExists(pid)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expectAbsent(lateMarker);
  });

  it("bounds the reusable streamed-command path and removes its partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-stream-command-deadline-test-"));
    cleanup.push(root);
    const pidFile = join(root, "pid");
    const lateMarker = join(root, "late");
    const destination = join(root, "output");
    const executable = await signalIgnoringExecutable(root, "stall");
    vi.stubEnv("STALL_PID_FILE", pidFile);
    vi.stubEnv("LATE_MARKER", lateMarker);
    const controller = new AbortController();

    const preparation = streamCommandFile(executable, [], root, destination, 1_024, {
      deadline: new Date(Date.now() + 30_000),
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    controller.abort(new Error("stream command deadline elapsed"));
    await expect(preparation).rejects.toThrow(/bounded Git content command failed/);

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(processGroupExists(pid)).toBe(false);
    await expectAbsent(destination);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expectAbsent(lateMarker);
  });
});
