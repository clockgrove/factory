/**
 * Validate for a Codex worker (#2156): the shared SelfValidation
 * (work/self-validate.ts) as one MCP tool, the way Codex takes tools
 * (codex-mcp.ts). The tool takes what
 * the Claude and Copilot workers' Validate takes: at most the indices of
 * declared commands for a targeted run (self-validate.ts
 * `VALIDATION_TOOL_INPUT`, #2281), so only the item's declared commands
 * run. Its result is bounded as theirs is, below the tool output Codex
 * keeps (self-validate.ts `VALIDATE_RESULT_CHARS`).
 */
import { errorMessage } from "../text.js";
import { validationDeadlineMs } from "../validate.js";
import {
  type SelfValidateOptions,
  SelfValidation,
  VALIDATION_TOOL_INPUT,
  validationTargets,
  validationToolDescription,
  worktreeGitlinks,
} from "../work/self-validate.js";
import { VALIDATION_TOOL_NAME } from "../work/validate-tool.js";
import type { WorkerInput, WorkerResult } from "../work/worker.js";
import { codexMcpServerConfig, McpSocketServer } from "./codex-mcp.js";
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
export const CODEX_VALIDATE_CALL = `Validate is the MCP tool ${VALIDATION_TOOL_NAME} of Factory's server ${CODEX_VALIDATION_SERVER}, id ${CODEX_VALIDATION_TOOL_ID}. Inside exec, call it as \`const result = await tools.${CODEX_VALIDATION_TOOL_ID}({}); text(result.content.map((part) => part.text).join(""));\` for a full run, or with \`{ commands: [2] }\` for a targeted run of only those declared commands and the earlier ones their after lists (by index, 0 the first, with any other earlier one they need, such as a build) after the install, which never counts as validating your result; where your tools list ${VALIDATION_TOOL_NAME} directly, call it there.`;

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
    /** The item's whole validation deadline, its formatter's command included: one call's limit. */
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
        server = await McpSocketServer.start(CODEX_VALIDATION_SERVER, [
          {
            name: VALIDATION_TOOL_NAME,
            description: validationToolDescription(input.item),
            // It writes only ignored produced files, never the result tree.
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: false,
            },
            inputSchema: VALIDATION_TOOL_INPUT,
            call: (args) => {
              const targets = validationTargets(args);
              return "problem" in targets
                ? Promise.resolve({
                    text: `${VALIDATION_TOOL_NAME} did not run: ${targets.problem}`,
                    isError: true,
                  })
                : validator.call(targets.commands);
            },
          },
        ]);
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
      // The formatter is one more command, as for Claude and Copilot (#2166).
      validationDeadlineMs(
        input.item,
        options.commandTimeoutMs,
        options.formatCommand !== undefined,
      ),
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
          [VALIDATION_TOOL_NAME],
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
