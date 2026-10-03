import { classifyFaults } from "../fault.js";
import { daytonaFault } from "./fault.js";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Daytona, Sandbox } from "@daytonaio/sdk";
import type {
  RemoteProcess,
  SandboxCommand,
  SandboxHandle,
  SandboxInput,
  SandboxOutput,
  SandboxProvider,
  SandboxRepositoryInput,
  SandboxRequest,
} from "../contracts.js";
import { FACTORY_VERSION } from "../package-metadata.js";
import { sandboxFileDigest } from "./sandbox-files.js";
import { daytonaPrepareScript } from "./daytona-prepare.js";

export class DaytonaUnavailableError extends Error {
  readonly code = "DAYTONA_SDK_UNAVAILABLE";
}

export interface DaytonaConfig {
  snapshot: string;
  target: string;
  apiKeyEnv: string;
  timeoutSeconds: number;
  factoryRoot: string;
}
export function validateDaytonaConfig(value: unknown): DaytonaConfig {
  const v = value as Partial<DaytonaConfig> | null;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some(
      (k) =>
        ![
          "snapshot",
          "target",
          "apiKeyEnv",
          "timeoutSeconds",
          "factoryRoot",
        ].includes(k),
    ) ||
    typeof v.snapshot !== "string" ||
    !v.snapshot.trim() ||
    typeof v.target !== "string" ||
    !v.target.trim() ||
    typeof v.apiKeyEnv !== "string" ||
    !/^[A-Z_][A-Z0-9_]*$/.test(v.apiKeyEnv) ||
    !Number.isSafeInteger(v.timeoutSeconds) ||
    v.timeoutSeconds! <= 0 ||
    typeof v.factoryRoot !== "string" ||
    !isAbsolute(v.factoryRoot) ||
    v.factoryRoot.includes("\0")
  )
    throw new Error(
      "Daytona requires snapshot, target, apiKeyEnv, positive timeoutSeconds and absolute installed factoryRoot",
    );
  return v as DaytonaConfig;
}
function quote(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid Daytona command argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function shell(argv: string[]): string {
  return argv.map(quote).join(" ");
}
function data(h: SandboxHandle): { owner: string } {
  const d = h.data as { owner?: unknown } | undefined;
  if (
    !/^[a-zA-Z0-9_-]+$/.test(h.attemptId) ||
    !h.identity ||
    typeof d?.owner !== "string" ||
    !/^[a-f0-9-]{36}$/.test(d.owner) ||
    h.workspace !== `/tmp/factory/${h.attemptId}`
  )
    throw new Error("Invalid Daytona ownership handle");
  return { owner: d.owner };
}
function within(h: SandboxHandle, path: string): void {
  if (
    !path.startsWith(`${h.workspace}/`) ||
    posix.resolve(path) !== path ||
    path.includes("\0")
  )
    throw new Error("Daytona path escapes owned workspace");
}
function missing(error: unknown): boolean {
  return error instanceof Error && error.name === "DaytonaNotFoundError";
}
/** Provider SDK and API types remain confined to this adapter. No adapter retry loop or repository credentials. */
export class DaytonaSandboxProvider implements SandboxProvider {
  private clientPromise?: Promise<Pick<Daytona, "create" | "get" | "list">>;
  readonly config: DaytonaConfig;
  constructor(
    config: unknown,
    private apiKey: string,
    private suppliedClient?: Pick<Daytona, "create" | "get" | "list">,
  ) {
    this.config = validateDaytonaConfig(config);
    if (!apiKey.trim())
      throw new Error("Daytona controller API key is unavailable");
  }
  private client(): Promise<Pick<Daytona, "create" | "get" | "list">> {
    this.clientPromise ??= this.suppliedClient
      ? Promise.resolve(this.suppliedClient)
      : this.loadClient();
    return this.clientPromise;
  }
  private async loadClient(): Promise<Daytona> {
    let sdk: typeof import("@daytonaio/sdk");
    try {
      const manifest = JSON.parse(
        readFileSync(
          createRequire(import.meta.url).resolve("@daytonaio/sdk/package.json"),
          "utf8",
        ),
      ) as { version: string };
      if (manifest.version !== "0.220.0")
        throw new Error("SDK version mismatch");
      sdk = await import("@daytonaio/sdk");
    } catch {
      throw new DaytonaUnavailableError(
        "Daytona SDK 0.220.0 unavailable; explicitly install @daytonaio/sdk@0.220.0 alongside Factory",
      );
    }
    const names = ["DAYTONA_OTEL_ENABLED", "DAYTONA_EXPERIMENTAL_OTEL_ENABLED"];
    if (names.some((name) => process.env[name] === "true"))
      throw new DaytonaUnavailableError(
        "Disable Daytona SDK tracing selectors before starting Factory; implicit telemetry export is unsupported",
      );
    const sdkRequire = createRequire(
      createRequire(import.meta.url).resolve("@daytonaio/sdk/package.json"),
    );
    let parsesDotenv = false;
    try {
      sdkRequire.resolve("dotenv");
      parsesDotenv = true;
    } catch {
      /* The selected SDK also ignores an unavailable dotenv parser. */
    }
    if (
      parsesDotenv &&
      [".env.local", ".env"].some((file) => existsSync(file)) &&
      names.some((name) => process.env[name] === undefined)
    )
      throw new DaytonaUnavailableError(
        "Set DAYTONA_OTEL_ENABLED=false and DAYTONA_EXPERIMENTAL_OTEL_ENABLED=false explicitly; dotenv SDK tracing selection is unavailable",
      );
    return new sdk.Daytona({
      apiKey: this.apiKey,
      apiUrl: "https://app.daytona.io/api",
      target: this.config.target,
      otelEnabled: false,
      useDeprecatedPolling: true,
      requestTimeoutMs: this.config.timeoutSeconds * 1000,
    });
  }

  private async owned(h: SandboxHandle): Promise<Sandbox> {
    const { owner } = data(h);
    const s = await (await this.client()).get(h.identity);
    if (
      s.id !== h.identity ||
      s.labels["factory-owner"] !== owner ||
      s.labels["factory-attempt"] !== h.attemptId
    )
      throw new Error("Daytona sandbox ownership mismatch");
    return s;
  }
  /** Lists sandboxes labeled with the attempt, keeps one and deletes any extras. */
  @classifyFaults(daytonaFault)
  async find({
    attemptId,
  }: SandboxRequest): Promise<SandboxHandle | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(attemptId))
      throw new Error("Invalid Daytona attempt");
    const tagged: Sandbox[] = [];
    for await (const s of (await this.client()).list({
      labels: { "factory-attempt": attemptId },
    }))
      if (s.state !== "destroyed" && s.state !== "destroying") tagged.push(s);
    const found = tagged.find((s) =>
      /^[a-f0-9-]{36}$/.test(s.labels["factory-owner"] ?? ""),
    );
    for (const s of tagged)
      if (s !== found) await s.delete(this.config.timeoutSeconds, true);
    return (
      found && this.handle(found, attemptId, found.labels["factory-owner"]!)
    );
  }
  private handle(s: Sandbox, attemptId: string, owner: string): SandboxHandle {
    return {
      identity: s.id,
      attemptId,
      workspace: `/tmp/factory/${attemptId}`,
      data: { owner },
    };
  }
  @classifyFaults(daytonaFault)
  async create({ attemptId }: SandboxRequest): Promise<SandboxHandle> {
    // Adopt a sandbox an earlier call created before its response was lost.
    const found = await this.find({ attemptId });
    if (found) return found;
    const created = randomUUID();
    const s = await (await this.client()).create(
      {
        snapshot: this.config.snapshot,
        labels: { "factory-owner": created, "factory-attempt": attemptId },
        public: false,
        autoStopInterval: 0,
        autoPauseInterval: 0,
        autoDeleteInterval: -1,
      },
      { timeout: this.config.timeoutSeconds },
    );
    return this.handle(s, attemptId, created);
  }
  @classifyFaults(daytonaFault)
  async prepareRepository(
    h: SandboxHandle,
    input: SandboxRepositoryInput,
  ): Promise<void> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !/^[a-f0-9]{40}$/.test(input.baseSha) ||
      !/^[a-f0-9]{40}$/.test(input.treeSha) ||
      input.lfsSources.some(
        (s) =>
          !/^[a-f0-9]{64}$/.test(s.digest) ||
          !Number.isSafeInteger(s.bytes) ||
          s.bytes < 0,
      )
    )
      throw new Error("Invalid pinned Daytona repository input");
    const s = await this.owned(h);
    const r = await s.process.executeCommand(
      shell([
        "node",
        "-e",
        daytonaPrepareScript,
        h.workspace,
        this.config.factoryRoot,
        FACTORY_VERSION,
        JSON.stringify(input),
      ]),
      undefined,
      undefined,
      this.config.timeoutSeconds,
    );
    if (r.exitCode !== 0)
      throw new Error(
        "Daytona readiness or anonymous Git/LFS preparation failed; authenticated repositories are unsupported",
      );
  }
  private async remoteDigest(
    s: Sandbox,
    path: string,
  ): Promise<{ digest: string; bytes: number }> {
    const script = `const fs=require('node:fs'),crypto=require('node:crypto');(async()=>{const p=process.argv[1];if(!fs.lstatSync(p).isFile())throw Error('regular file required');let bytes=0;const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(p)){bytes+=chunk.length;hash.update(chunk);}console.log(JSON.stringify({digest:hash.digest('hex'),bytes}));})().catch(()=>{process.exitCode=1;});`;
    const r = await s.process.executeCommand(
      shell(["node", "-e", script, path]),
      undefined,
      undefined,
      this.config.timeoutSeconds,
    );
    if (r.exitCode !== 0) throw new Error("Daytona file digest unavailable");
    const result = JSON.parse(r.result) as { digest: string; bytes: number };
    if (
      !/^[a-f0-9]{64}$/.test(result.digest) ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 0
    )
      throw new Error("Invalid Daytona file digest");
    return result;
  }
  @classifyFaults(daytonaFault)
  async upload(h: SandboxHandle, input: SandboxInput): Promise<void> {
    within(h, input.remotePath);
    const digest = await sandboxFileDigest(input.localPath);
    if (digest.digest !== input.digest || digest.bytes !== input.bytes)
      throw new Error("Daytona upload input mismatch");
    const sandbox = await this.owned(h);
    await sandbox.fs.uploadFileStream(input.localPath, input.remotePath, {
      timeout: this.config.timeoutSeconds,
    });
    const remote = await this.remoteDigest(sandbox, input.remotePath);
    if (remote.digest !== input.digest || remote.bytes !== input.bytes)
      throw new Error("Daytona uploaded bytes mismatch");
  }
  @classifyFaults(daytonaFault)
  async execute(
    h: SandboxHandle,
    command: SandboxCommand,
  ): Promise<RemoteProcess> {
    if (command.cwd !== h.workspace || !command.argv.length)
      throw new Error("Invalid Daytona execution workspace");
    const s = await this.owned(h);
    const session = randomUUID();
    await s.process.createSession(session);
    const result = await s.process.executeSessionCommand(
      session,
      {
        command: `cd ${quote(command.cwd)} && exec ${shell(command.argv)}`,
        runAsync: true,
      },
      this.config.timeoutSeconds,
    );
    if (!result.cmdId)
      throw new Error("Daytona execution acknowledgement missing");
    return {
      identity: result.cmdId,
      sandboxIdentity: h.identity,
      attemptId: h.attemptId,
      data: { session },
    };
  }
  private process(h: SandboxHandle, p: RemoteProcess): string {
    const session = (p.data as { session?: unknown })?.session;
    if (
      p.sandboxIdentity !== h.identity ||
      p.attemptId !== h.attemptId ||
      !p.identity ||
      typeof session !== "string" ||
      !/^[a-f0-9-]{36}$/.test(session)
    )
      throw new Error("Daytona process ownership mismatch");
    return session;
  }
  @classifyFaults(daytonaFault)
  async observe(
    h: SandboxHandle,
    p: RemoteProcess,
  ): Promise<{ state: "running" | "complete" | "failed" }> {
    const session = this.process(h, p);
    const command = await (await this.owned(h)).process.getSessionCommand(
      session,
      p.identity,
    );
    if (command.id !== p.identity)
      throw new Error("Daytona command identity mismatch");
    return {
      state:
        command.exitCode === undefined
          ? "running"
          : command.exitCode === 0
            ? "complete"
            : "failed",
    };
  }
  @classifyFaults(daytonaFault)
  async cancel(h: SandboxHandle, p: RemoteProcess): Promise<void> {
    this.process(h, p);
    await this.destroy(h);
  }
  @classifyFaults(daytonaFault)
  async download(
    h: SandboxHandle,
    output: SandboxOutput,
  ): Promise<{ digest: string; bytes: number }> {
    within(h, output.remotePath);
    const sandbox = await this.owned(h);
    const expected = await this.remoteDigest(sandbox, output.remotePath);
    const stream = await sandbox.fs.downloadFileStream(output.remotePath, {
      timeout: this.config.timeoutSeconds,
    });
    await pipeline(
      stream,
      createWriteStream(output.localPath, { mode: 0o600 }),
    );
    const actual = await sandboxFileDigest(output.localPath);
    if (actual.digest !== expected.digest || actual.bytes !== expected.bytes)
      throw new Error("Daytona downloaded bytes mismatch");
    return actual;
  }
  @classifyFaults(daytonaFault)
  async destroy(h: SandboxHandle): Promise<void> {
    data(h);
    let s: Sandbox;
    try {
      s = await this.owned(h);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (s.state === "destroyed") return;
    await s.delete(this.config.timeoutSeconds, true);
  }
}
