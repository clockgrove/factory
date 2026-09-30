import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { extract, list } from "tar";
import type { LocalHarnessRegistration } from "../application.js";
import type {
  HarnessHandle,
  HarnessRequest,
  HarnessResult,
} from "../contracts.js";
import { pinnedGit } from "../process.js";
import { assertDurableValue } from "./checkpoint.js";
import { sandboxDigest, sandboxFiles } from "./sandbox-files.js";

export interface SandboxInvocation {
  attemptId: string;
  baseSha: string;
  inputDigest: string;
  inputBytes: number;
  registration: { identity: string; config: unknown };
  request: Omit<HarnessRequest, "worktree">;
}
export interface SandboxReply {
  attemptId: string;
  baseSha: string;
  inputDigest: string;
  operation: string;
  value: unknown;
}
/** Call from the installed sandbox entrypoint after constructing its configured #55 registration. */
export async function runSandboxHarness(
  registration: LocalHarnessRegistration,
  args = process.argv.slice(2),
): Promise<void> {
  const [root, operation, output] = args;
  if (
    !root ||
    !isAbsolute(root) ||
    resolve(root) === "/" ||
    !["start", "observe", "cancel", "collect"].includes(operation ?? "") ||
    !output ||
    !/^[a-z0-9-]+\.json$/.test(output)
  )
    throw new Error("Invalid sandbox invocation");
  const input = JSON.parse(
    readFileSync(join(root, "request.json"), "utf8"),
  ) as SandboxInvocation;
  assertDurableValue(input, "Sandbox invocation");
  if (
    !input.attemptId ||
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    !/^[a-f0-9]{64}$/.test(input.inputDigest)
  )
    throw new Error("Invalid sandbox input identity");
  if (
    registration.identity !== input.registration.identity ||
    !isDeepStrictEqual(registration.config, input.registration.config)
  )
    throw new Error("Sandbox harness registration mismatch");
  const c = registration.harness.capabilities;
  if (
    c.protocolVersion !== 1 ||
    c.worktree !== "factory-owned-read-write" ||
    c.head !== "preserve" ||
    c.lifecycle !== "restart-safe-durable-handle" ||
    c.publication !== "controller-only" ||
    c.assetSets !== true
  )
    throw new Error("Incompatible sandbox harness");
  const repo = join(root, "repo"),
    handlePath = join(root, "harness.json");
  let value: unknown;
  if (operation === "start") {
    // A failed/ambiguous start cannot be replayed as a fresh harness attempt.
    writeFileSync(join(root, "start-submitted"), input.attemptId, {
      flag: "wx",
      mode: 0o600,
    });
    const archive = join(root, "input.tar"),
      bytes = readFileSync(archive);
    if (
      bytes.length !== input.inputBytes ||
      sandboxDigest(bytes) !== input.inputDigest
    )
      throw new Error("Sandbox input digest mismatch");
    await list({
      file: archive,
      strict: true,
      onReadEntry(entry) {
        const parts = entry.path.replace(/\/$/, "").split("/");
        if (
          parts[0] !== "repo" ||
          parts.some((p) => !p || p === ".." || p === ".") ||
          entry.path.includes("\\") ||
          !["File", "Directory"].includes(entry.type)
        )
          throw new Error("Unsafe sandbox input archive");
      },
    });
    if (existsSync(repo))
      throw new Error("Sandbox workspace already initialized");
    mkdirSync(root, { recursive: true });
    await extract({ file: archive, cwd: root, strict: true });
    if (pinnedGit(repo, "rev-parse", "HEAD") !== input.baseSha)
      throw new Error("Sandbox exact base mismatch");
    const path = (p: string) => {
      if (
        p.startsWith("/") ||
        p.split("/").some((x) => !x || x === ".." || x === ".")
      )
        throw new Error("Unsafe sandbox input path");
      return join(repo, p);
    };
    const request: HarnessRequest = {
      ...input.request,
      worktree: repo,
      sourceAssets: input.request.sourceAssets?.map((s) => ({
        ...s,
        ...(s.path ? { path: path(s.path) } : {}),
      })),
      selectedAssets: input.request.selectedAssets?.map((s) => ({
        ...s,
        path: path(s.path),
      })),
    };
    const handle = await registration.harness.start(request);
    assertDurableValue(handle, "Sandbox harness handle");
    if (!handle.identity) throw new Error("Missing harness identity");
    writeFileSync(handlePath, JSON.stringify(handle), {
      flag: "wx",
      mode: 0o600,
    });
    value = { started: true };
  } else {
    const handle = JSON.parse(
      readFileSync(handlePath, "utf8"),
    ) as HarnessHandle;
    assertDurableValue(handle, "Sandbox harness handle");
    if (operation === "observe")
      value = await registration.harness.observe(handle);
    else if (operation === "cancel") {
      await registration.harness.cancel(handle);
      value = await registration.harness.observe(handle);
    } else {
      const observed = await registration.harness.observe(handle);
      if (observed.state !== "complete")
        throw new Error("Sandbox harness has no complete result");
      const result: HarnessResult = await registration.harness.collect(handle);
      if (pinnedGit(repo, "rev-parse", "HEAD") !== input.baseSha)
        throw new Error("Sandbox worker changed HEAD");
      value = { result, files: sandboxFiles(repo) };
    }
  }
  assertDurableValue(value, "Sandbox reply");
  const reply: SandboxReply = {
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    inputDigest: input.inputDigest,
    operation: operation!,
    value,
  };
  writeFileSync(join(root, output), JSON.stringify(reply), {
    flag: "wx",
    mode: 0o600,
  });
}
