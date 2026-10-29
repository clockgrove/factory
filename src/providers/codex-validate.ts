/**
 * Validate for a Codex worker (#2156): the shared SelfValidation
 * (work/self-validate.ts) as one MCP tool, the way Codex takes tools. Codex
 * 0.160 offers a model only its own tools and those of the MCP servers its
 * configuration names, so the turn's private CODEX_HOME configuration names
 * a stdio server whose command is a relay: Node, piping its standard
 * streams to a Unix socket Factory listens on in-process. Codex starts its
 * MCP servers itself, outside the shell's sandbox; the socket's directory is
 * private (0700) under the host's temporary directory, which the worker's
 * shell is never granted, so only Codex reaches it. The tool takes no
 * arguments, as the Claude and Copilot workers' Validate: only the item's
 * declared commands run. Its result is bounded as theirs is, below the
 * tool output Codex keeps (self-validate.ts `VALIDATE_RESULT_CHARS`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../text.js";
import { validationDeadlineMs } from "../validate.js";
import {
  type SelfValidateOptions,
  SelfValidation,
  validationToolDescription,
  worktreeGitlinks,
} from "../work/self-validate.js";
import { VALIDATION_TOOL_NAME } from "../work/validate-tool.js";
import type { WorkerInput, WorkerResult } from "../work/worker.js";
import { detail, PlannerError, providerOutcome } from "./planner.js";

/** Factory's MCP server for Validate, as the worker's Codex names it. */
export const CODEX_VALIDATION_SERVER = "factory-validation";

/**
 * The tool's stable id, as Codex names an MCP tool to the model:
 * `mcp__<server>__<tool>`, the server's `-` read as `_`.
 */
export const CODEX_VALIDATION_TOOL_ID = `mcp__${CODEX_VALIDATION_SERVER.replaceAll("-", "_")}__${VALIDATION_TOOL_NAME}`;

/**
 * How a Codex worker calls Validate (#2156). Codex's production models
 * (`tool_mode` code_mode_only) see only `exec`, and call an MCP tool as
 * `tools.<id>` inside an exec script. By default such a tool is a deferred
 * nested tool, named nowhere in the model's request: live (#800), a worker
 * told only of "run_validation" found no such tool. The server's
 * `omit_tools_from = ["deferred"]` (codexMcpServerConfig) lists it in
 * exec's description, and the worker is also given the exact call.
 */
export const CODEX_VALIDATE_CALL = `Validate is the MCP tool ${VALIDATION_TOOL_NAME} of Factory's server ${CODEX_VALIDATION_SERVER}, id ${CODEX_VALIDATION_TOOL_ID}, and takes no arguments. Inside exec, call it as \`const result = await tools.${CODEX_VALIDATION_TOOL_ID}({}); text(result.content.map((part) => part.text).join(""));\`; where your tools list ${VALIDATION_TOOL_NAME} directly, call it there.`;

/**
 * One Codex worker attempt's Validate: the shared runs (`validator`, whose
 * handoff check the worker's finished turn gets too), and the server Codex
 * calls them through, when the worker has the tool.
 */
export class CodexValidate {
  private constructor(
    readonly validator: SelfValidation,
    /** Absent: no tool (no declared commands, or a gitlink). */
    private readonly server: McpSocketServer | undefined,
    private readonly ended: AbortController,
    /** The item's whole validation deadline: one call's limit. */
    readonly deadlineMs: number,
  ) {}

  /**
   * Validate for `input`'s attempt, as the Claude worker's: the tool only
   * with declared commands and never in a checkout with a gitlink, which
   * host Git must not enter. A Git refusal there is the Objective's
   * question, and a socket the host can't make holds.
   */
  static async start(
    input: WorkerInput,
    options: SelfValidateOptions,
  ): Promise<CodexValidate | WorkerResult> {
    const gitlinks = await worktreeGitlinks(input);
    if (typeof gitlinks !== "boolean") return gitlinks;
    const ended = new AbortController();
    const validator = new SelfValidation(
      input,
      options,
      AbortSignal.any([input.signal, ended.signal]),
    );
    let server: McpSocketServer | undefined;
    if (input.commands.length && !gitlinks)
      try {
        server = await McpSocketServer.start(CODEX_VALIDATION_SERVER, {
          name: VALIDATION_TOOL_NAME,
          description: validationToolDescription(input.item),
          // It writes only ignored produced files, never the result tree.
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
          call: () => validator.call(),
        });
      } catch (error) {
        return providerOutcome(
          new PlannerError(
            "hold",
            `Factory could not serve Validate to the Codex worker: ${detail(errorMessage(error))}. Fix the host, then answer retry.`,
          ),
        );
      }
    return new CodexValidate(
      validator,
      server,
      ended,
      validationDeadlineMs(input.item, options.commandTimeoutMs),
    );
  }

  /** Whether the worker has the tool. */
  get tool(): boolean {
    return this.server !== undefined;
  }

  /** The CODEX_HOME configuration that registers the tool; empty without one. */
  config(): string {
    return this.server
      ? codexMcpServerConfig(
          CODEX_VALIDATION_SERVER,
          this.server,
          VALIDATION_TOOL_NAME,
          this.deadlineMs / 1000,
        )
      : "";
  }

  /** The attempt ended: a running validation stops, then the server goes. */
  async close(): Promise<void> {
    this.ended.abort(new Error("the worker attempt ended"));
    await this.validator.idle();
    await this.server?.close();
  }
}

/** One tool the server offers. */
interface McpTool {
  name: string;
  description: string;
  /** MCP tool annotations (readOnlyHint, destructiveHint, openWorldHint). */
  annotations: Record<string, boolean>;
  /** One call: the result text, and whether it is an error. */
  call(): Promise<{ text: string; isError: boolean }>;
}

/** The MCP version answered when the client names none. */
const PROTOCOL_VERSION = "2025-06-18";
/** A request line longer than this ends the connection: a tool call is tiny. */
const MAX_LINE = 1024 * 1024;

/**
 * The relay Codex runs as the server's command: `node -e RELAY <socket>`.
 * Its standard input goes to the socket and the socket's bytes to its
 * standard output; it exits when either side closes.
 */
const MCP_RELAY = `const s=require("node:net").connect(process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",e=>{process.stderr.write(String(e));process.exit(1)});s.on("close",()=>process.exit(0))`;

type Message = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

/**
 * A minimal MCP server (newline-delimited JSON-RPC, the stdio transport)
 * offering one tool, on a private Unix socket: `initialize`, `ping`,
 * `tools/list` and `tools/call`; notifications are read and ignored.
 */
class McpSocketServer {
  private readonly connections = new Set<Socket>();

  private constructor(
    /** The socket's private directory, removed on close. */
    private readonly directory: string,
    readonly socket: string,
    private readonly server: Server,
    private readonly serverName: string,
    private readonly tool: McpTool,
  ) {
    server.on("connection", (connection) => this.serve(connection));
  }

  /** A listening server for `tool`, named `name` to clients. */
  static async start(name: string, tool: McpTool): Promise<McpSocketServer> {
    // mkdtemp makes it 0700: only this user reaches the socket.
    const directory = mkdtempSync(join(tmpdir(), "factory-mcp-"));
    const socket = join(directory, "socket");
    const server = createServer();
    try {
      await new Promise<void>((listening, failed) => {
        server.once("error", failed);
        server.listen(socket, () => {
          server.off("error", failed);
          listening();
        });
      });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return new McpSocketServer(directory, socket, server, name, tool);
  }

  /** Stop listening, end every connection, and remove the socket. */
  async close(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>((closed) => this.server.close(() => closed()));
    rmSync(this.directory, { recursive: true, force: true });
  }

  private serve(connection: Socket): void {
    this.connections.add(connection);
    connection.on("close", () => this.connections.delete(connection));
    // A client that goes away mid-answer is not Factory's failure.
    connection.on("error", () => connection.destroy());
    connection.setEncoding("utf8");
    let buffered = "";
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end < 0) break;
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line) void this.answer(connection, line);
      }
      if (buffered.length > MAX_LINE) connection.destroy();
    });
  }

  private async answer(connection: Socket, line: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return send(connection, {
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    if (!message || typeof message !== "object" || Array.isArray(message))
      return send(connection, {
        id: null,
        error: { code: -32600, message: "Invalid request" },
      });
    const { id, method } = message;
    // A notification (no id) asks for no answer.
    if (id === undefined || id === null) return;
    const params =
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    switch (method) {
      case "initialize":
        return send(connection, {
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.serverName, version: "1.0.0" },
          },
        });
      case "ping":
        return send(connection, { id, result: {} });
      case "tools/list":
        return send(connection, {
          id,
          result: {
            tools: [
              {
                name: this.tool.name,
                description: this.tool.description,
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                annotations: this.tool.annotations,
              },
            ],
          },
        });
      case "tools/call": {
        if (params.name !== this.tool.name)
          return send(connection, {
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${String(params.name)}`,
            },
          });
        const args = params.arguments;
        if (
          args !== undefined &&
          args !== null &&
          (typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).length)
        )
          return send(connection, {
            id,
            result: toolText(`${this.tool.name} takes no arguments`, true),
          });
        let result: { text: string; isError: boolean };
        try {
          result = await this.tool.call();
        } catch (error) {
          result = {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        return send(connection, {
          id,
          result: toolText(result.text, result.isError),
        });
      }
      default:
        return send(connection, {
          id,
          error: {
            code: -32601,
            message: `Method not found: ${String(method)}`,
          },
        });
    }
  }
}

const toolText = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  isError,
});

function send(connection: Socket, message: Record<string, unknown>): void {
  if (connection.destroyed) return;
  connection.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/**
 * The CODEX_HOME configuration that registers `server` as MCP server `name`
 * for Codex 0.160: the relay as its stdio command, required (a server that
 * doesn't start fails the turn, rather than leaving a worker told it has
 * Validate without it), its one tool enabled and approved (the worker runs
 * with approval policy never), a call allowed `toolTimeoutSeconds`
 * (Codex's default is 60 s; a validation takes minutes), and the tool never
 * deferred: `omit_tools_from` (`code_mode`, `deferred` or `direct`) keeps it
 * out of the deferred tools, so a code-mode model sees it declared in exec's
 * description, as a Claude worker's Validate is always loaded (#2156).
 *
 * A code-mode model calls the tool from an `exec` cell, and `exec` yields
 * to the model when its script still runs after its yield time (about 30 s
 * by default); the model can then only poll the cell with `wait`, at most
 * 10 s a call, each a round over its whole context. Live (#800, #2167), 65
 * such rounds during 27 minutes of Validate cost an estimated 6M tokens. With the
 * default yield at the call's own timeout, a cell blocks until Validate
 * answers, as Claude's does: no round while it runs. The `code_mode` table
 * without `enabled` leaves code mode as the model's metadata chooses.
 */
function codexMcpServerConfig(
  name: string,
  server: McpSocketServer,
  toolName: string,
  toolTimeoutSeconds: number,
): string {
  const timeout = Math.ceil(toolTimeoutSeconds);
  return `
[mcp_servers.${name}]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify(["-e", MCP_RELAY, server.socket])}
required = true
startup_timeout_sec = 30
tool_timeout_sec = ${timeout}
enabled_tools = ${JSON.stringify([toolName])}
default_tools_approval_mode = "approve"
omit_tools_from = ["deferred"]

[features.code_mode]
default_exec_yield_time_ms = ${timeout * 1000}
`;
}
