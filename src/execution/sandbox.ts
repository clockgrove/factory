import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { create } from "tar";
import type {
  ContentStore,
  ExecutionContext,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
  HarnessResult,
  RemoteProcess,
  SandboxHandle,
  SandboxProvider,
  WorkGraph,
} from "../contracts.js";
import type { JsonValue } from "../config.js";
import { assertDurableValue } from "./checkpoint.js";
import { collectWorktreeResult } from "./local.js";
import { prepareManagedBase } from "./managed-base.js";
import {
  importSandboxFiles,
  prepareSandboxInputs,
  sandboxDigest,
  type SandboxFile,
} from "./sandbox-files.js";
import type { SandboxInvocation, SandboxReply } from "./sandbox-worker.js";

interface Active {
  request: ExecutionRequest;
  terminal?: "complete" | "cancelled";
  phase:
    | "creating"
    | "preparing"
    | "ready"
    | "submitting"
    | "invoked"
    | "destroying"
    | "destroyed";
  sandbox?: SandboxHandle;
  inputDigest?: string;
  process?: RemoteProcess;
  operation?: "start" | "observe" | "cancel" | "collect";
  output?: string;
}
export interface SandboxDriverOptions {
  checkout: string;
  workRoot: string;
  contentStore: ContentStore;
  providerIdentity: string;
  provider: SandboxProvider;
  harness: { identity: string; config: { [key: string]: JsonValue } };
  /** Installed sandbox-side entrypoint; receives root, operation and output filename arguments. */
  argv: string[];
  concurrency: number;
}
export class SandboxExecutionDriver implements ExecutionDriver {
  constructor(private options: SandboxDriverOptions) {
    if (
      !options.providerIdentity ||
      !options.argv.length ||
      options.argv.some((x) => typeof x !== "string" || !x || x.includes("\0"))
    )
      throw new Error("Sandbox requires explicit provider and installed argv");
  }
  async availableSlots(): Promise<number> {
    return this.options.concurrency;
  }
  async preflight(graph: WorkGraph): Promise<void> {
    if (graph.items.some((i) => i.executionProfile))
      throw new Error(
        "Sandbox mode uses its project-configured harness, not local execution profiles",
      );
  }
  private active(handle: ExecutionHandle): Active {
    assertDurableValue(handle, "Sandbox checkpoint");
    if (
      handle.provider !== `sandbox:${this.options.providerIdentity}` ||
      !handle.identity ||
      !/^[a-zA-Z0-9_-]+$/.test(handle.identity) ||
      !handle.data
    )
      throw new Error("Sandbox handle provider mismatch");
    const a = handle.data as Active;
    if (a.request.attemptId !== handle.identity)
      throw new Error("Sandbox attempt identity mismatch");
    if (
      a.sandbox &&
      (a.sandbox.attemptId !== handle.identity ||
        !a.sandbox.identity ||
        !isAbsolute(a.sandbox.workspace) ||
        a.sandbox.workspace === "/" ||
        resolve(a.sandbox.workspace) !== a.sandbox.workspace)
    )
      throw new Error("Sandbox resource identity mismatch");
    if (
      a.process &&
      (a.process.sandboxIdentity !== a.sandbox?.identity ||
        a.process.attemptId !== handle.identity ||
        !a.process.identity)
    )
      throw new Error("Sandbox process identity mismatch");
    return a;
  }
  private save(handle: ExecutionHandle, context?: ExecutionContext): void {
    this.active(handle);
    context?.checkpoint(structuredClone(handle));
  }
  private async invoke(
    handle: ExecutionHandle,
    operation: NonNullable<Active["operation"]>,
    context?: ExecutionContext,
  ): Promise<unknown> {
    const a = this.active(handle);
    if (a.phase === "ready") {
      a.operation = operation;
      a.output = `${randomUUID()}.json`;
      a.phase = "submitting";
      delete a.process;
      this.save(handle, context);
      a.process = await this.options.provider.execute(a.sandbox!, {
        argv: [...this.options.argv, a.sandbox!.workspace, operation, a.output],
        cwd: a.sandbox!.workspace,
      });
      a.phase = "invoked";
      this.save(handle, context);
    }
    if (a.phase !== "invoked" || a.operation !== operation || !a.process)
      throw new Error(
        "Sandbox external invocation outcome unknown; operator direction required",
      );
    let observed = await this.options.provider.observe(a.sandbox!, a.process);
    while (observed.state === "running") {
      if (context?.cancelled())
        throw new Error(
          "Sandbox invocation interrupted; owned process retained",
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      observed = await this.options.provider.observe(a.sandbox!, a.process);
    }
    if (observed.state !== "complete")
      throw new Error(
        `Sandbox invocation ${observed.state}: ${observed.detail ?? "no detail"}`,
      );
    const root = join(this.options.workRoot, handle.identity);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, a.output!);
    const transfer = await this.options.provider.download(a.sandbox!, {
      remotePath: join(a.sandbox!.workspace, a.output!),
      localPath: file,
    });
    const bytes = readFileSync(file);
    if (
      sandboxDigest(bytes) !== transfer.digest ||
      bytes.length !== transfer.bytes
    )
      throw new Error("Sandbox reply transfer digest mismatch");
    const reply = JSON.parse(bytes.toString()) as SandboxReply;
    if (
      reply.attemptId !== handle.identity ||
      reply.baseSha !== a.request.baseSha ||
      reply.inputDigest !== a.inputDigest ||
      reply.operation !== operation
    )
      throw new Error("Sandbox reply identity mismatch");
    a.phase = "ready";
    delete a.process;
    delete a.operation;
    delete a.output;
    this.save(handle, context);
    return reply.value;
  }
  async start(
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle> {
    const identity = request.attemptId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(identity))
      throw new Error("Invalid sandbox attempt path");
    const handle: ExecutionHandle = {
      provider: `sandbox:${this.options.providerIdentity}`,
      identity,
      data: {
        request: { ...request, attemptId: identity },
        phase: "creating",
      } satisfies Active,
    };
    const a = this.active(handle);
    this.save(handle, context);
    a.sandbox = await this.options.provider.create({ attemptId: identity });
    a.phase = "preparing";
    this.save(handle, context);
    const root = join(this.options.workRoot, identity);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const prepared = await prepareSandboxInputs(
      this.options.checkout,
      join(root, "repo"),
      a.request,
      this.options.contentStore,
    );
    a.request = prepared.request;
    const archive = join(root, "input.tar");
    await create({ file: archive, cwd: root, portable: true, noMtime: true }, [
      "repo",
    ]);
    const bytes = readFileSync(archive);
    a.inputDigest = sandboxDigest(bytes);
    this.save(handle, context);
    const invocation: SandboxInvocation = {
      attemptId: identity,
      baseSha: request.baseSha,
      inputDigest: a.inputDigest,
      inputBytes: bytes.length,
      registration: this.options.harness,
      request: prepared.harness,
    };
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify(invocation), { mode: 0o600 });
    for (const [file, name] of [
      [archive, "input.tar"],
      [input, "request.json"],
    ]) {
      const value = readFileSync(file!);
      await this.options.provider.upload(a.sandbox!, {
        localPath: file!,
        remotePath: join(a.sandbox!.workspace, name!),
        digest: sandboxDigest(value),
        bytes: value.length,
      });
    }
    a.phase = "ready";
    this.save(handle, context);
    await this.invoke(handle, "start", context);
    return handle;
  }
  async observe(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionObservation> {
    const a = this.active(handle);
    if (a.phase === "destroyed") return { state: a.terminal! };
    if (a.operation === "start") await this.invoke(handle, "start", context);
    const result = (await this.invoke(
      handle,
      "observe",
      context,
    )) as ExecutionObservation;
    if (!["running", "complete", "failed", "cancelled"].includes(result.state))
      throw new Error("Invalid sandbox harness observation");
    return result;
  }
  private async destroy(
    handle: ExecutionHandle,
    terminal: "complete" | "cancelled",
    context?: ExecutionContext,
  ): Promise<void> {
    const a = this.active(handle);
    a.phase = "destroying";
    this.save(handle, context);
    await this.options.provider.destroy(a.sandbox!);
    a.phase = "destroyed";
    a.terminal = terminal;
    this.save(handle, context);
    rmSync(join(this.options.workRoot, handle.identity), {
      recursive: true,
      force: true,
    });
  }
  async cancel(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const a = this.active(handle);
    if (a.phase === "destroyed") return;
    if (!a.sandbox)
      throw new Error(
        "Sandbox create outcome unknown; operator direction required",
      );
    if (a.phase === "submitting")
      throw new Error(
        "Sandbox process start outcome unknown; operator direction required",
      );
    if (a.process) {
      await this.options.provider.cancel(a.sandbox, a.process);
      a.phase = "ready";
      delete a.process;
      this.save(handle, context);
    }
    if (a.phase === "preparing") {
      await this.destroy(handle, "cancelled", context);
      return;
    }
    if (a.inputDigest) {
      const result = (await this.invoke(
        handle,
        "cancel",
        context,
      )) as ExecutionObservation;
      if (!["cancelled", "failed", "complete"].includes(result.state))
        throw new Error("Sandbox harness cancellation unresolved");
    }
    await this.destroy(handle, "cancelled", context);
  }
  async collect(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    const a = this.active(handle);
    const value = (await this.invoke(handle, "collect", context)) as {
      files: SandboxFile[];
      result: HarnessResult;
    };
    const worktree = join(this.options.workRoot, handle.identity, "collected");
    await prepareManagedBase(
      this.options.checkout,
      worktree,
      a.request.baseSha,
    );
    importSandboxFiles(worktree, value.files);
    const result = await collectWorktreeResult(
      this.options.checkout,
      worktree,
      a.request,
      this.options.contentStore,
      value.result,
    );
    // Import the exact collected commit; no remote Git configuration is trusted.
    const { pinnedGitAsync } = await import("../process.js");
    await pinnedGitAsync(
      this.options.checkout,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      worktree,
      result.changeRef,
    );
    delete result.collection;
    await this.destroy(handle, "complete", context);
    return result;
  }
}
