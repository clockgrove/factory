import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionRef, AgentSessionRequest } from "../contracts.js";
import {
  assertAgentSessionRef,
  assertAgentSessionScope,
} from "../agent-session.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  UnsettledSubprocessError,
} from "../process.js";
import { killGroup, type WorkerHandleData } from "./worker-process.js";
import type { ClaudeUsageBaseline } from "./claude-usage.js";

export interface ClaudeNativeProcess {
  pid: number;
  group: number;
  startTime: string;
  namespace: string;
  uid: number;
  /** The kernel boot the process ran in; absent from earlier receipts. */
  boot?: string;
}
export interface ClaudeSessionData {
  root: string;
  selectionDigest: string;
  nativeSessionId: string;
  historyDigest?: string;
  baseline?: ClaudeUsageBaseline;
  nativeTerminal?: true;
  settled?: true;
  process?: ClaudeNativeProcess;
  pendingWorkerIdentity?: string;
  worker?: WorkerHandleData;
  profileId?: string;
}
export interface ClaudeOwnedSession {
  ref: AgentSessionRef;
  data: ClaudeSessionData;
  owner: string;
  resume: boolean;
}
export const claudeDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function privateDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("Claude session directory is not privately owned");
}
function regularBytes(path: string, confidential = true): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (confidential && stat.mode & 0o077)
  )
    throw new Error("Claude private session file is not owned");
  return readFileSync(path);
}
export function readClaudePrivate<T>(path: string): T {
  return JSON.parse(regularBytes(path).toString()) as T;
}
export function claudePrivateWrite(path: string, value: unknown): void {
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
function ownerFor(ref: AgentSessionRef, selectionDigest: string): string {
  return claudeDigest([
    ref.scope,
    ref.identity,
    ref.adapter,
    selectionDigest,
    (ref.data as ClaudeSessionData).nativeSessionId,
  ]);
}
export function requireClaudeSession(
  storage: string,
  ref: AgentSessionRef,
  adapter: string,
): ClaudeOwnedSession {
  assertAgentSessionRef(ref);
  const data = ref.data as ClaudeSessionData | undefined;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(ref.identity) ||
    ref.adapter !== adapter ||
    data?.root !== join(resolve(storage), ref.identity) ||
    !/^[a-f0-9]{64}$/.test(data.selectionDigest) ||
    !/^[a-f0-9-]{36}$/.test(data.nativeSessionId)
  )
    throw new Error("Claude conversation differs from its adapter binding");
  privateDirectory(resolve(storage));
  privateDirectory(data.root);
  const owner = ownerFor(ref, data.selectionDigest);
  if (regularBytes(join(data.root, "owner")).toString() !== owner)
    throw new Error("Claude conversation owner changed");
  return { ref, data, owner, resume: ref.turn > 1 };
}
export function claudeHistoryDigest(session: ClaudeOwnedSession): string {
  const root = join(
    session.data.root,
    "config",
    "projects",
    session.ref.identity,
  );
  const transcript = join(root, `${session.data.nativeSessionId}.jsonl`);
  // A reported session identifier is insufficient without its actual retained transcript.
  regularBytes(transcript, false);
  const entries: [string, string][] = [];
  const visit = (directory: string, prefix: string) => {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Claude transcript directory changed");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const child = lstatSync(path);
      if (child.isDirectory() && !child.isSymbolicLink())
        visit(path, `${prefix}${name}/`);
      else
        entries.push([
          `${prefix}${name}`,
          createHash("sha256").update(regularBytes(path, false)).digest("hex"),
        ]);
    }
  };
  visit(root, "");
  return claudeDigest(entries);
}
export function prepareClaudeSession(
  storage: string,
  request: AgentSessionRequest,
  adapter: string,
  selectionDigest: string,
  executionIdentity?: string,
  profileId?: string,
): ClaudeOwnedSession {
  assertAgentSessionScope(request.scope);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.identity))
    throw new Error("Invalid Claude logical session identity");
  const root = join(resolve(storage), request.identity);
  let data: ClaudeSessionData;
  if (request.retained) {
    const prior = requireClaudeSession(storage, request.retained, adapter);
    if (
      request.retained.identity !== request.identity ||
      !isDeepStrictEqual(request.retained.scope, request.scope) ||
      request.retained.status !== "ready" ||
      prior.data.selectionDigest !== selectionDigest ||
      prior.data.nativeTerminal !== true ||
      prior.data.settled !== true ||
      prior.data.historyDigest !== claudeHistoryDigest(prior)
    )
      throw new Error(
        "Claude continuation has no matching settled native history",
      );
    data = { ...prior.data };
    delete data.settled;
    delete data.nativeTerminal;
    delete data.process;
    delete data.worker;
  } else {
    mkdirSync(resolve(storage), { recursive: true, mode: 0o700 });
    privateDirectory(resolve(storage));
    // Existing uncheckpointed storage represents an ambiguous predecessor, never a free retry.
    mkdirSync(root, { mode: 0o700 });
    data = {
      root,
      selectionDigest,
      nativeSessionId: randomUUID(),
      ...(profileId && { profileId }),
    };
    const seed: AgentSessionRef = {
      scope: request.scope,
      adapter,
      identity: request.identity,
      turn: 1,
      status: "in-flight",
      data,
    };
    writeFileSync(join(root, "owner"), ownerFor(seed, selectionDigest), {
      flag: "wx",
      mode: 0o600,
    });
    mkdirSync(join(root, "config"), { mode: 0o700 });
  }
  const ref: AgentSessionRef = {
    scope: structuredClone(request.scope),
    adapter,
    identity: request.identity,
    turn: (request.retained?.turn ?? 0) + 1,
    status: "in-flight",
    data,
    ...(executionIdentity && { executionIdentity }),
  };
  return {
    ref,
    data,
    owner: ownerFor(ref, selectionDigest),
    resume: Boolean(request.retained),
  };
}
export function claudeSessionEnvironment(
  session: ClaudeOwnedSession,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  privateDirectory(session.data.root);
  const config = join(session.data.root, "config");
  privateDirectory(config);
  // Carry only the existing Linux login credential file, never ambient settings or plugins.
  const loginRoot = environment.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const credentials = join(loginRoot, ".credentials.json");
  const stat = lstatSync(credentials, { throwIfNoEntry: false });
  if (stat) {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        "Claude login credential source is not an owned regular file",
      );
    const destination = join(config, ".credentials.json");
    const previous = lstatSync(destination, { throwIfNoEntry: false });
    if (
      previous &&
      (!previous.isFile() ||
        previous.isSymbolicLink() ||
        previous.uid !== process.getuid?.() ||
        previous.mode & 0o077)
    )
      throw new Error("Claude private credential destination changed");
    const staging = join(config, `.credentials.${randomUUID()}.tmp`);
    writeFileSync(staging, readFileSync(credentials), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      renameSync(staging, destination);
    } finally {
      rmSync(staging, { force: true });
    }
  }
  return {
    ...environment,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PROJECT_DIR_NAME: session.ref.identity,
  };
}
export function claudeResumeOptions(
  session: ClaudeOwnedSession,
): Pick<Options, "resume" | "sessionId" | "persistSession"> {
  return {
    persistSession: true,
    ...(session.resume
      ? { resume: session.data.nativeSessionId }
      : { sessionId: session.data.nativeSessionId }),
  };
}
let kernelBoot: string | undefined;
/** This kernel boot's identity; it cannot change while this process runs. */
function currentBoot(): string {
  kernelBoot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return kernelBoot;
}
/**
 * Whether the recorded process may still run. `settled` is a proof that it
 * and its group ceased: a later boot ended every process of an earlier one,
 * whatever its namespace; within the recorded namespace, the leader is gone
 * or its pid now names another process, and no process remains in its group.
 * `active` is only ever the exact recorded process or its group, so a caller
 * never signals a process it cannot identify. Anything else is `unknown`.
 */
export function claudeProcessDisposition(
  owner: ClaudeNativeProcess | undefined,
): "active" | "settled" | "unknown" {
  if (!owner || owner.uid !== process.getuid?.()) return "unknown";
  if (owner.boot !== undefined && owner.boot !== currentBoot())
    return "settled";
  if (owner.namespace !== readlinkSync("/proc/self/ns/pid")) return "unknown";
  const current = linuxProcessIdentity(owner.pid);
  if (current?.startTime === owner.startTime) {
    // The recorded process itself still runs; outside its group it is unowned.
    if (current.group !== owner.group) return "unknown";
    return processGroupExists(owner.group) ? "active" : "settled";
  }
  // The leader is gone or its pid is reused. A reused pid's group may be
  // another owner's, so only an empty group proves cessation.
  if (processGroupExists(owner.group)) return current ? "unknown" : "active";
  return "settled";
}
export function claudeOwnedSpawn(
  onSpawn: (owner: ClaudeNativeProcess) => void,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => {
    const boot = currentBoot();
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Ensure process errors always have a listener even if ownership/checkpointing throws.
    child.on("error", () => undefined);
    const identity = child.pid && linuxProcessIdentity(child.pid);
    if (!child.pid || !identity || identity.group !== child.pid) {
      child.kill("SIGKILL");
      throw new UnsettledSubprocessError(
        "Claude native process ownership is unresolved",
      );
    }
    const owner: ClaudeNativeProcess = {
      pid: child.pid,
      group: identity.group,
      startTime: identity.startTime,
      namespace: readlinkSync("/proc/self/ns/pid"),
      uid: process.getuid!(),
      boot,
    };
    try {
      onSpawn(owner);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    if (options.signal.aborted) child.kill("SIGTERM");
    options.signal.addEventListener(
      "abort",
      () => {
        if (claudeProcessDisposition(owner) === "active") child.kill("SIGTERM");
      },
      { once: true },
    );
    return child as ChildProcess &
      ReturnType<NonNullable<Options["spawnClaudeCodeProcess"]>>;
  };
}
export async function settleClaudeProcess(
  owner: ClaudeNativeProcess | undefined,
): Promise<void> {
  if (!owner)
    throw new UnsettledSubprocessError(
      "Claude native process was not authenticated",
    );
  const disposition = claudeProcessDisposition(owner);
  if (disposition === "unknown")
    throw new UnsettledSubprocessError(
      "Claude native process namespace or ownership changed",
    );
  if (disposition === "active") await killGroup(owner.group, "Claude planning");
  if (claudeProcessDisposition(owner) !== "settled")
    throw new UnsettledSubprocessError(
      "Claude native process cessation remains unresolved",
    );
}
export function releaseClaudeStorage(
  storage: string,
  ref: AgentSessionRef,
  adapter: string,
): void {
  const root = join(resolve(storage), ref.identity);
  if (!lstatSync(root, { throwIfNoEntry: false })) return;
  const session = requireClaudeSession(storage, ref, adapter);
  if (ref.status === "in-flight" || session.data.settled !== true)
    throw new Error("Cannot release an unsettled Claude conversation");
  rmSync(root, { recursive: true });
}
