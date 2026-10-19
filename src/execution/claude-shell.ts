/**
 * A Claude worker's shell: `run_command` runs `sh -c` in the same OS sandbox
 * as validation, with the worker's worktree as the writable checkout, no
 * network, bounded wall time and bounded output. It grants nothing Write and
 * Validate do not already grant together (write files, run code in the
 * sandbox), so both authorize it, and only when the sandbox is available:
 * it never runs unsandboxed. Factory still validates the result itself.
 */
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { validateToolConfigName } from "../config.js";
import {
  localValidationEnvironment,
  subprocessAsync,
  UnsettledSubprocessError,
} from "../process.js";
import {
  type CommandSandboxPolicy,
  commandSandboxAvailability,
  STRICT_COMMAND_SANDBOX,
  sandboxedCommand,
} from "./sandbox.js";

export const factoryShellServerName = "factory-shell";
const factoryShellServerVersion = "1.0.0";
export const factoryShellToolName = "mcp__factory-shell__run_command";
export const defaultCommandTimeoutMs = 120_000;
export const maxCommandTimeoutMs = 600_000;
/** Bytes of combined output kept while a command runs: its start and its end. */
const keptHeadBytes = 16 * 1024;
const keptTailBytes = 256 * 1024;
/** Characters returned to the model: the start, then the end, where failures report. */
const returnedHeadChars = 2_000;
const returnedTailChars = 14_000;

interface ShellInput {
  config: {
    tools: readonly string[];
    allowedTools: readonly string[];
    settingSources?: readonly string[];
  };
}

/**
 * Write and Validate together authorize the shell, on a host with the
 * sandbox. Not when project or local Claude settings load: the shell could
 * write their hooks into the worktree, and the Claude CLI runs those
 * outside the sandbox.
 */
export function factoryShellAuthorized(input: ShellInput): boolean {
  const granted = (tool: string) =>
    input.config.tools.includes(tool) &&
    input.config.allowedTools.includes(tool);
  return (
    granted("Write") &&
    granted(validateToolConfigName) &&
    !input.config.settingSources?.some(
      (source) => source === "project" || source === "local",
    ) &&
    commandSandboxAvailability().available
  );
}

/** Both SDK permission callbacks use the same exact provenance check. */
export function factoryShellToolAllowed(
  input: ShellInput,
  toolName: string,
  toolInput: unknown,
  provenance: unknown,
): boolean {
  if (
    !factoryShellAuthorized(input) ||
    toolName !== factoryShellToolName ||
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    !toolInput ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput)
  )
    return false;
  const source = provenance as Record<string, unknown>;
  const args = toolInput as Record<string, unknown>;
  const keys = Object.keys(args).sort().join(",");
  return (
    source.name === factoryShellServerName &&
    source.source === "sdk" &&
    typeof args.command === "string" &&
    (keys === "command" ||
      (keys === "command,timeoutMs" && typeof args.timeoutMs === "number"))
  );
}

function assertFactoryShellReady(status: McpServerStatus): void {
  if (
    status.name !== factoryShellServerName ||
    status.source !== "sdk" ||
    status.status !== "connected" ||
    status.serverInfo?.name !== factoryShellServerName ||
    status.serverInfo.version !== factoryShellServerVersion ||
    status.tools?.length !== 1 ||
    status.tools[0]?.name !== "run_command"
  )
    throw new Error("Factory shell MCP readiness verification failed");
}

/** Combined output, keeping the first and the last bytes once it overflows. */
function boundedOutput() {
  const head: Buffer[] = [];
  let headBytes = 0;
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let dropped = 0;
  return {
    add(chunk: Buffer) {
      let rest = chunk;
      if (headBytes < keptHeadBytes) {
        const taken = rest.subarray(0, keptHeadBytes - headBytes);
        head.push(Buffer.from(taken));
        headBytes += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (!rest.length) return;
      tail.push(Buffer.from(rest));
      tailBytes += rest.length;
      if (tailBytes > keptTailBytes * 2) {
        const joined = Buffer.concat(tail);
        dropped += joined.length - keptTailBytes;
        tail = [joined.subarray(joined.length - keptTailBytes)];
        tailBytes = keptTailBytes;
      }
    },
    text(): string {
      const joined = Buffer.concat(tail);
      const kept = joined.subarray(Math.max(0, joined.length - keptTailBytes));
      dropped += joined.length - kept.length;
      const start = Buffer.concat(head).toString("utf8");
      const end = kept.toString("utf8");
      return dropped
        ? `${start}\n[${dropped} bytes of output omitted]\n${end}`
        : start + end;
    },
  };
}

/** Plain text, cut to the start and the end. */
function returned(text: string): string {
  const plain = stripVTControlCharacters(text);
  const limit = returnedHeadChars + returnedTailChars;
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, returnedHeadChars)}\n[${plain.length - limit} characters omitted; redirect long output to a file and read it]\n${plain.slice(-returnedTailChars)}`;
}

/**
 * Run one command in the sandbox with `worktree` writable, a private HOME
 * and TMPDIR under `root` that last the whole attempt, and no network.
 */
export async function runSandboxedCommand(input: {
  worktree: string;
  root: string;
  command: string;
  timeoutMs: number;
  policy: CommandSandboxPolicy;
  /** Stops the command early, as the deadline does (the worker is closing). */
  signal?: AbortSignal;
}): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}> {
  const home = join(input.root, "home");
  const temporary = join(input.root, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const launch = sandboxedCommand({
    command: input.command,
    checkout: input.worktree,
    temporary,
    home,
    env: {
      ...localValidationEnvironment(join(input.root, "empty-gh-config")),
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    },
    network: false,
    packageInstall: false,
    // The shell never runs unsandboxed, whatever `required` allows.
    policy: { ...input.policy, required: true },
  });
  if (launch.sandbox !== "bubblewrap")
    throw new Error("The command sandbox is unavailable");
  const output = boundedOutput();
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const started = Date.now();
  try {
    const result = await subprocessAsync(
      launch.file,
      launch.args,
      {
        cwd: input.worktree,
        env: launch.env,
        signal: input.signal
          ? AbortSignal.any([deadline, input.signal])
          : deadline,
      },
      undefined,
      (_stream, chunk) => output.add(chunk),
      undefined,
      { stdout: false, stderr: false },
    );
    return {
      exitCode: result.status,
      timedOut: false,
      durationMs: Date.now() - started,
      output: output.text(),
    };
  } catch (error) {
    // Cancellation stops the whole process group and proves it gone first;
    // an unproved stop stays an error.
    if (input.signal?.aborted && !(error instanceof UnsettledSubprocessError))
      throw new Error("the Factory shell closed while the command ran");
    if (!deadline.aborted || error instanceof UnsettledSubprocessError)
      throw error;
    return {
      exitCode: null,
      timedOut: true,
      durationMs: Date.now() - started,
      output: output.text(),
    };
  }
}

/** One adapter-owned server whose only tool runs a command in the sandbox. */
export async function createFactoryShellMcp(input: {
  worktree: string;
  /** Scratch beside the worktree for the sandbox's HOME and TMPDIR. */
  root: string;
  config: ShellInput["config"];
  sandbox?: CommandSandboxPolicy;
  /** A command whose stop is unproved: the attempt's outcome is unknown. */
  onUnsettled?: (error: UnsettledSubprocessError) => void;
}) {
  if (!factoryShellAuthorized(input))
    throw new Error(
      "Factory shell MCP requires Write and Validate authority and the command sandbox",
    );
  const worktree = realpathSync(input.worktree);
  const policy = input.sandbox ?? STRICT_COMMAND_SANDBOX;
  const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  let ready = false;
  // An unproved stop leaves the outcome unknown: no further commands, and
  // the owner ends the attempt.
  let unsettled = false;
  const closed = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  const server = createSdkMcpServer({
    name: factoryShellServerName,
    version: factoryShellServerVersion,
    tools: [
      tool(
        "run_command",
        `Run a shell command (sh -c) in your checkout, inside an OS sandbox: your checkout is writable (its .git is read-only), HOME and TMPDIR are private and last this attempt, the network is off and only loopback works, and nothing else on the host is visible. Use it to inspect generated files, compute hashes, run a test or build, or copy and move files. Returns the exit code and the combined output (long output keeps its start and end; redirect it to a file and read that). Commands run one at a time, for at most timeoutMs (default ${defaultCommandTimeoutMs}, at most ${maxCommandTimeoutMs}); a command still running then is stopped with everything it started. Factory still runs the declared validation itself after you finish: run Validate before you finish.`,
        {
          command: z.string().min(1),
          timeoutMs: z
            .number()
            .int()
            .min(1_000)
            .max(maxCommandTimeoutMs)
            .optional(),
        },
        async ({ command, timeoutMs }) => {
          const result = queue.then(() => {
            if (
              !ready ||
              unsettled ||
              realpathSync(input.worktree) !== worktree
            )
              throw new Error("the Factory shell is not ready");
            return runSandboxedCommand({
              worktree,
              root: input.root,
              command,
              timeoutMs: timeoutMs ?? defaultCommandTimeoutMs,
              policy,
              signal: closed.signal,
            });
          });
          queue = result.catch(() => undefined);
          try {
            const ran = await result;
            const status = ran.timedOut
              ? `Stopped after ${timeoutMs ?? defaultCommandTimeoutMs} ms, with everything it started`
              : `Exit code ${ran.exitCode ?? "none (ended by a signal)"}`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${status} (${ran.durationMs} ms)\n${returned(ran.output)}`,
                },
              ],
            };
          } catch (error) {
            if (error instanceof UnsettledSubprocessError) {
              unsettled = true;
              input.onUnsettled?.(error);
            }
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Command not run: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
        {
          alwaysLoad: true,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close: async () => {
      ready = false;
      // A running command stops with the worker, proved gone like a timeout.
      closed.abort();
      closing ??= server.instance.close();
      await closing;
      await queue;
      if (!unsettled) rmSync(input.root, { recursive: true, force: true });
    },
    isReady: () => ready,
    markReady: (status: McpServerStatus) => {
      ready = false;
      assertFactoryShellReady(status);
      ready = true;
    },
  };
}

export type PreparedClaudeShell = Awaited<
  ReturnType<typeof createFactoryShellMcp>
>;
