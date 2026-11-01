/**
 * Factory's own tools for Codex, served over MCP: Codex 0.160 offers a
 * model only its own tools and those of the MCP servers its configuration
 * names, so a turn's private CODEX_HOME configuration names a stdio server
 * whose command is a relay: Node, piping its standard streams to a Unix
 * socket Factory listens on in-process. Codex starts its MCP servers itself,
 * outside the shell's sandbox; the socket's directory is private (0700)
 * under the host's temporary directory, which no Codex shell is granted, so
 * only Codex reaches it. A worker's Validate (codex-validate.ts) and a
 * review's run_command (codex.ts) are each one such server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One tool the server offers. */
export interface McpTool {
  name: string;
  description: string;
  /** MCP tool annotations (readOnlyHint, destructiveHint, openWorldHint). */
  annotations: Record<string, boolean>;
  /** Its arguments' JSON Schema. */
  inputSchema: Readonly<Record<string, unknown>>;
  /** One call with its arguments: the result text, and whether it is an error. */
  call(args: unknown): Promise<{ text: string; isError: boolean }>;
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
export class McpSocketServer {
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
                inputSchema: this.tool.inputSchema,
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
        let result: { text: string; isError: boolean };
        try {
          result = await this.tool.call(params.arguments);
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
export function codexMcpServerConfig(
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
