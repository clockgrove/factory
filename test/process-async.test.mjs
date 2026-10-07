import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInteractionContent } from "../dist/capture.js";
import { stateRoot } from "../dist/config.js";
import { CodexHarness } from "../dist/execution/local.js";
import { killGroup } from "../dist/execution/worker-process.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  sanitizedWorkerEnvironment,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";

test("trusted child captures roundtrip through the configured private state root", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-capture-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  const repository = "integration/worker-capture";
  process.env.XDG_STATE_HOME = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const result = await subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureWriter } from ${JSON.stringify(new URL("../dist/capture.js", import.meta.url).href)};
import { stateRoot } from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)};
import { createCodexHome } from ${JSON.stringify(new URL("../dist/codex-planning-isolation.js", import.meta.url).href)};
const home = createCodexHome({ config: "", sandbox: { directory: process.cwd(), workspace: "write", network: false } });
try {
  assert.equal(home.env.XDG_STATE_HOME, undefined);
  assert.equal(readFileSync(join(home.env.CODEX_HOME, "config.toml"), "utf8").includes(process.env.XDG_STATE_HOME), false);
} finally { home.dispose(); }
const privateBin = join(stateRoot(${JSON.stringify(repository)}), "bin");
mkdirSync(privateBin, { recursive: true });
assert.throws(() => createCodexHome({ config: "", source: { ...process.env, PATH: privateBin }, sandbox: { directory: process.cwd(), workspace: "write", network: false } }), /Factory's own files/);
new CaptureWriter({ repository: ${JSON.stringify(repository)}, objective: 1, invocationId: "actual-child-capture", providerAttempt: 1, phase: "integration", adapter: "local-process", configured: { provider: "not-invoked", model: "none" } }, { enabled: true, maxBytesPerInvocation: 1024 }, [], metadata => process.stdout.write(JSON.stringify(metadata))).record({ kind: "interaction" }, () => ({ text: "real child process capture" }));`,
      ],
      {
        cwd: workspace,
        env: sanitizedWorkerEnvironment(join(root, "credentials")),
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    const metadata = JSON.parse(result.stdout.toString());
    assert.equal(metadata.content.status, "captured");
    assert.deepEqual(
      JSON.parse(
        readInteractionContent(repository, metadata.content.reference),
      ),
      { text: "real child process capture" },
    );
    const captures = join(stateRoot(repository), "captures");
    assert.equal(statSync(captures).mode & 0o777, 0o700);
    const [file] = readdirSync(captures);
    assert.equal(statSync(join(captures, file)).mode & 0o777, 0o600);
    assert.equal(
      existsSync(
        join(
          process.env.HOME,
          ".local",
          "state",
          "clockgrove-factory",
          "repositories",
          "integration",
          "worker-capture",
        ),
      ),
      false,
    );
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation stops an owned shell and its process group", async () => {
  const controller = new AbortController();
  let pid;
  const result = withProcessCancellation(controller.signal, () =>
    subprocessAsync(
      "sh",
      ["-c", "echo $$; sleep 120 & wait"],
      {},
      undefined,
      (stream, chunk) => {
        if (stream === "stdout") {
          pid = Number(chunk.toString().trim());
          controller.abort();
        }
      },
    ),
  );
  await assert.rejects(result, /cancelled after verified cessation/);
  assert.ok(pid > 0);
  assert.equal(processGroupExists(pid), false);
});

test("collection settles an exited owned group before removing scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-owned-exit-"));
  const harnessRoot = join(root, "harness");
  mkdirSync(harnessRoot);
  const requestPath = join(harnessRoot, "exited.request.json");
  const scratch = `${requestPath}.codex-home`;
  mkdirSync(scratch);
  // A real shell exits with no result, leaving a child that ignores SIGTERM.
  // No provider, SDK or scripted harness response is involved.
  const child = spawn(
    "sh",
    ["-c", 'trap "" TERM; sleep 120 & echo ready; read -r hold; exit 23'],
    { detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    const identity = linuxProcessIdentity(child.pid);
    assert.ok(identity);
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.stdin.end("\n");
    assert.equal((await exited)[0], 23);
    assert.equal(processGroupExists(child.pid), true);
    const harness = new CodexHarness(join(root, "credentials"), "off", {
      model: "unused",
      reasoningEffort: "low",
    });
    await assert.rejects(
      harness.collect({
        identity: "exited",
        data: {
          pid: child.pid,
          startTime: identity.startTime,
          requestPath,
          resultPath: join(harnessRoot, "exited.result.json"),
          logPath: join(harnessRoot, "exited.log"),
        },
      }),
      /worker exited without a durable result/,
    );
    assert.equal(processGroupExists(child.pid), false);
    assert.equal(existsSync(scratch), false);
  } finally {
    if (processGroupExists(child.pid))
      await killGroup(child.pid, "integration shell");
    rmSync(root, { recursive: true, force: true });
  }
});
