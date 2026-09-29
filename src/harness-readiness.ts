import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { redactDiagnosticDetail } from "./diagnostics.js";
import { sanitizedWorkerEnvironment } from "./process.js";

export interface HarnessReadiness {
  status: "ready" | "unavailable";
  workspace: string;
  workspaceWritable: boolean;
  outsideWriteRefused: boolean;
  detail: string;
}

/** Model-free Codex diagnostic using the same overrides and environment as its worker. */
export async function probeCodexReadiness(
  input: {
    workspace: string;
    outsideDirectory: string;
    credentialDirectory: string;
    network: "host" | "off";
    allowedSecretNames?: string[];
  },
  // Narrow process seam for credential-free protocol conformance tests.
  command?: string[],
): Promise<HarnessReadiness> {
  if (![input.workspace, input.outsideDirectory].every(isAbsolute))
    throw new Error(
      "Readiness requires absolute workspace and outside directory paths",
    );
  const workspace = realpathSync(input.workspace);
  const outside = realpathSync(input.outsideDirectory);
  const location = relative(workspace, outside);
  if (!location.startsWith("../") && location !== "..")
    throw new Error("Readiness refusal probe must be outside the workspace");
  const token = randomUUID();
  const insidePath = join(workspace, `.factory-readiness-${token}`);
  const outsidePath = join(outside, `.factory-readiness-${token}`);
  const result: HarnessReadiness = {
    status: "unavailable",
    workspace,
    workspaceWritable: false,
    outsideWriteRefused: false,
    detail: "Harness readiness has not been established",
  };
  const env = sanitizedWorkerEnvironment(
    input.credentialDirectory,
    input.allowedSecretNames,
  );
  const secrets = (input.allowedSecretNames ?? []).flatMap((name) =>
    env[name] ? [env[name]!] : [],
  );
  const redact = (value: string) => redactDiagnosticDetail(value, secrets);
  const bundled = () => {
    const require = createRequire(import.meta.url);
    return [
      process.execPath,
      join(
        dirname(require.resolve("@openai/codex/package.json")),
        "bin/codex.js",
      ),
    ];
  };
  const argv = command ?? bundled();
  if (!argv.length) throw new Error("Readiness has no harness executable");
  const child = spawn(
    argv[0]!,
    [
      ...argv.slice(1),
      "app-server",
      "--stdio",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-c",
      `sandbox_workspace_write.network_access=${input.network === "host"}`,
    ],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  let sequence = 0;
  let exited = false;
  let exitFailure: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    exitFailure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-4000);
  });
  child.stdin.on("error", fail);
  child.on("error", fail);
  const closed = new Promise<void>((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      fail(
        new Error(`Harness diagnostic exited (${code ?? signal}): ${stderr}`),
      );
      resolve();
    });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      const entry =
        response.id === undefined ? undefined : pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id!);
      if (response.error)
        entry.reject(
          new Error(
            response.error.message ?? "Harness diagnostic request failed",
          ),
        );
      else entry.resolve(response.result);
    } catch {
      fail(new Error("Harness diagnostic returned invalid protocol data"));
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (exitFailure) return reject(exitFailure);
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timer = setTimeout(() => {
    fail(new Error("Model-free harness diagnostic timed out"));
    child.kill("SIGTERM");
  }, 20000);
  try {
    await request("initialize", {
      clientInfo: { name: "factory-readiness", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    // No thread/start or turn/start: this executes only a fixed sentinel probe.
    const script = `const fs=require('node:fs');const [inside,outside,token]=process.argv.slice(1);let writable=false,refused=false;fs.writeFileSync(inside,token,{flag:'wx',mode:0o600});writable=true;try{fs.writeFileSync(outside,token,{flag:'wx',mode:0o600})}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e;refused=true}console.log(JSON.stringify({writable,refused}));`;
    const execution = (await request("command/exec", {
      command: [process.execPath, "-e", script, insidePath, outsidePath, token],
      cwd: workspace,
      timeoutMs: 10000,
      outputBytesCap: 2000,
    })) as { exitCode?: number; stdout?: string; stderr?: string };
    if (execution.exitCode !== 0)
      throw new Error(
        `Harness sandbox diagnostic failed: ${execution.stderr ?? "no command result"}`,
      );
    const proof = JSON.parse(execution.stdout ?? "") as {
      writable?: boolean;
      refused?: boolean;
    };
    result.workspaceWritable =
      proof.writable === true &&
      existsSync(insidePath) &&
      readFileSync(insidePath, "utf8") === token;
    result.outsideWriteRefused =
      proof.refused === true && !existsSync(outsidePath);
    result.status =
      result.workspaceWritable && result.outsideWriteRefused
        ? "ready"
        : "unavailable";
    result.detail =
      result.status === "ready"
        ? "Model-free worker-policy probe wrote in the named workspace and refused the named outside write. This does not prove model authentication, network availability, other workspaces or controller validation readiness."
        : "The named workspace write and outside-write refusal were not both proven under the configured worker policy.";
  } catch (error) {
    result.detail = redact(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (!exited) child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await closed;
    clearTimeout(killTimer);
    lines.close();
    for (const path of [insidePath, outsidePath]) {
      if (existsSync(path) && readFileSync(path, "utf8") === token)
        unlinkSync(path);
    }
  }
  return result;
}
