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
import { AuthenticationRequiredError } from "../contracts.js";
import type { JsonValue } from "../config.js";
import { assertDurableValue } from "./checkpoint.js";
import { collectWorktreeResult } from "./local.js";
import { prepareManagedBase } from "./managed-base.js";
import {
  importSandboxFiles,
  prepareSandboxInputs,
  sandboxDigest,
  sandboxFileDigest,
  sandboxRepositoryInput,
  type SandboxFile,
} from "./sandbox-files.js";
import {
  sandboxJsonValue,
  type SandboxInvocation,
  type SandboxReply,
} from "./sandbox-worker.js";

interface Active {
  request: ExecutionRequest;
  terminal?: "complete" | "cancelled";
  result?: ExecutionResult;
  harnessStarted?: boolean;
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
  repository: string;
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
    if (operation === "start") a.harnessStarted = true;
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
        request: sandboxJsonValue({
          ...request,
          attemptId: identity,
        }) as ExecutionRequest,
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
    const repositoryInput = sandboxRepositoryInput(
      this.options.checkout,
      this.options.repository,
      a.request,
    );
    await this.options.provider.prepareRepository(a.sandbox!, repositoryInput);
    const lfsSources = [];
    for (const [index, source] of repositoryInput.lfsSources.entries()) {
      const localPath = join(root, `lfs-${index}`);
      const receipt = await this.options.provider.download(a.sandbox!, {
        remotePath: join(a.sandbox!.workspace, "lfs", String(index)),
        localPath,
      });
      const actual = await sandboxFileDigest(localPath);
      if (
        actual.digest !== source.digest ||
        actual.bytes !== source.bytes ||
        receipt.digest !== actual.digest ||
        receipt.bytes !== actual.bytes
      )
        throw new Error("Sandbox LFS source digest mismatch");
      lfsSources.push({ path: source.path, localPath });
    }
    const prepared = await prepareSandboxInputs(
      this.options.checkout,
      join(root, "repo"),
      a.request,
      this.options.contentStore,
      lfsSources,
    );
    a.request = prepared.request;
    const archive = join(root, "input.tar");
    const inputRoot = join(root, "repo");
    mkdirSync(join(inputRoot, ".factory-inputs"), {
      recursive: true,
      mode: 0o700,
    });
    const inputs = [".factory-inputs"];
    await create(
      { file: archive, cwd: inputRoot, portable: true, noMtime: true },
      inputs,
    );
    const transfer = await sandboxFileDigest(archive);
    a.inputDigest = transfer.digest;
    this.save(handle, context);
    const invocation: SandboxInvocation = {
      attemptId: identity,
      baseSha: request.baseSha,
      treeSha: repositoryInput.treeSha,
      inputDigest: a.inputDigest,
      inputBytes: transfer.bytes,
      registration: this.options.harness,
      request: prepared.harness,
    };
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify(invocation), { mode: 0o600 });
    for (const [file, name] of [
      [archive, "input.tar"],
      [input, "request.json"],
    ]) {
      const value = await sandboxFileDigest(file!);
      await this.options.provider.upload(a.sandbox!, {
        localPath: file!,
        remotePath: join(a.sandbox!.workspace, name!),
        digest: value.digest,
        bytes: value.bytes,
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
    if (a.result) return { state: "complete" };
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
    if (a.phase !== "destroyed") {
      a.phase = "destroying";
      a.terminal = terminal;
      this.save(handle, context);
      await this.options.provider.destroy(a.sandbox!);
      a.phase = "destroyed";
      this.save(handle, context);
    }
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
    if (a.phase === "destroyed") {
      await this.destroy(handle, a.terminal!, context);
      return;
    }
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
    if (a.phase === "destroying" || !a.harnessStarted) {
      await this.destroy(handle, a.terminal ?? "cancelled", context);
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
    if (a.result) {
      await this.destroy(handle, "complete", context);
      return a.result;
    }
    if (a.operation !== "collect") {
      let observed = await this.observe(handle, context);
      while (observed.state === "running") {
        if (context?.cancelled())
          throw new Error(
            "Sandbox collection interrupted; owned attempt retained",
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
        observed = await this.observe(handle, context);
      }
      if (observed.state !== "complete" && observed.authentication)
        throw new AuthenticationRequiredError(
          observed.detail ?? "Sandbox harness authentication required",
          observed.authentication,
        );
      if (observed.state !== "complete")
        throw new Error(
          `Sandbox harness ${observed.state}; no complete result`,
        );
    }
    const value = (await this.invoke(handle, "collect", context)) as {
      files: SandboxFile[];
      result: HarnessResult;
      archive: { path: string; digest: string; bytes: number };
    };
    const worktree = join(this.options.workRoot, handle.identity, "collected");
    await prepareManagedBase(
      this.options.checkout,
      worktree,
      a.request.baseSha,
    );
    if (!/^[a-z0-9-]+\.tar$/.test(value.archive.path))
      throw new Error("Unsafe sandbox result archive path");
    const resultArchive = join(
      this.options.workRoot,
      handle.identity,
      "result.tar",
    );
    const receipt = await this.options.provider.download(a.sandbox!, {
      remotePath: join(a.sandbox!.workspace, value.archive.path),
      localPath: resultArchive,
    });
    const actual = await sandboxFileDigest(resultArchive);
    if (
      actual.digest !== value.archive.digest ||
      actual.bytes !== value.archive.bytes ||
      actual.digest !== receipt.digest ||
      actual.bytes !== receipt.bytes
    )
      throw new Error("Sandbox result archive digest mismatch");
    await importSandboxFiles(
      worktree,
      value.files,
      resultArchive,
      join(this.options.workRoot, handle.identity, `unpacked-${randomUUID()}`),
    );
    const inputs = sandboxRepositoryInput(
      this.options.checkout,
      this.options.repository,
      a.request,
    );
    for (const [index, source] of inputs.lfsSources.entries()) {
      const actual = await sandboxFileDigest(
        join(worktree, ".factory-inputs", `lfs-${index}`),
      );
      if (actual.digest !== source.digest || actual.bytes !== source.bytes)
        throw new Error("Sandbox LFS input changed");
    }
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
    a.result = result;
    this.save(handle, context);
    await this.destroy(handle, "complete", context);
    return result;
  }
}
