import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FACTORY_SCRIPTED_PROVIDER_SCENARIO;
const stall = () => new Promise(() => undefined);

export function query({ options }) {
  let step = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (scenario === "creation") return stall();
      if (scenario === "auth") throw new Error("Not authenticated");
      if (step++ === 0)
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            cwd: options.cwd,
            model: options.model,
            permissionMode: options.permissionMode,
            effort: options.effort,
            tools: scenario.startsWith("startup-tool")
              ? [
                  scenario === "startup-tool-skill"
                    ? "Skill"
                    : scenario === "startup-tool-agent"
                      ? "Agent"
                      : "Bash",
                ]
              : [],
            mcp_servers:
              scenario === "startup-mcp"
                ? [{ name: "ambient", status: "connected" }]
                : [],
            plugins: [
              { name: "agents-md", path: "builtin" },
              { name: "sec-default", path: "builtin" },
            ],
            skills: ["verify"],
            agents: ["Explore", "general-purpose"],
          },
        };
      if (scenario.startsWith("claude-usage")) {
        if (step <= 4)
          return {
            done: false,
            value: {
              type: "assistant",
              uuid: `frame-${step}`,
              session_id: "scripted-claude",
              parent_tool_use_id: null,
              message: {
                id: step < 4 ? "call-one" : "call-two",
                content: [{ type: "text", text: "private-payload" }],
                usage: {
                  input_tokens: 10,
                  output_tokens: 9999,
                  cache_read_input_tokens: 20,
                  cache_creation_input_tokens: 5,
                  private: "private-payload",
                },
              },
            },
          };
        if (scenario === "claude-usage-no-result")
          throw new Error("provider stream failed after usage");
        const crash = scenario === "claude-usage-crash";
        return {
          done: false,
          value: {
            type: "result",
            subtype: crash
              ? "error_during_execution"
              : scenario === "claude-usage-failure"
                ? "error_max_turns"
                : "success",
            is_error: crash || scenario === "claude-usage-failure",
            errors: ["authoritative provider failure"],
            uuid: "result-frame",
            result: "scripted completion",
            session_id: "scripted-claude",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              private: "private-payload",
            },
            modelUsage: crash
              ? {
                  main: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                  },
                }
              : {
                  main: {
                    inputTokens: 10,
                    outputTokens: 8,
                    cacheReadInputTokens: 20,
                    cacheCreationInputTokens: 5,
                    thinkingTokens: 2,
                    contextWindow: 1000000,
                    private: "private-payload",
                  },
                  helper: {
                    inputTokens: 2,
                    outputTokens: 3,
                    cacheReadInputTokens: 4,
                    ...(scenario === "claude-usage-missing"
                      ? {}
                      : { cacheCreationInputTokens: 1 }),
                    thinkingTokens: 1,
                  },
                },
            total_cost_usd: 0,
          },
        };
      }
      if (scenario === "timeout") return stall();
      if (scenario === "nonterminal") return { done: true };
      return {
        done: false,
        value: {
          type: "result",
          subtype:
            scenario === "failure" ? "error_during_execution" : "success",
          is_error: scenario === "failure",
          errors: ["authoritative provider failure"],
          result: "scripted completion",
          session_id: "scripted-claude",
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            cache_read_input_tokens: 100,
          },
          modelUsage: {},
          total_cost_usd: 0,
        },
      };
    },
    async return() {
      if (scenario === "cleanup") return stall();
      return { done: true };
    },
  };
}

export class CopilotClient {
  async start() {
    if (scenario === "creation") return stall();
  }
  async getAuthStatus() {
    return {
      isAuthenticated: scenario !== "auth",
      statusMessage: "Not authenticated",
      authType: "scripted",
    };
  }
  async createSession(options) {
    const event = (type, data = {}) =>
      options.onEvent({ type, timestamp: new Date().toISOString(), data });
    const initialized = () =>
      event("session.start", {
        context: {
          cwd:
            scenario === "startup-cwd"
              ? "/sentinel/wrong-worktree"
              : options.workingDirectory,
        },
        selectedModel:
          scenario === "startup-model" ? "wrong-model" : options.model,
        reasoningEffort:
          scenario === "startup-effort"
            ? "wrong-effort"
            : options.reasoningEffort,
      });
    if (scenario === "startup-async") setTimeout(initialized, 10);
    else if (scenario === "startup-error")
      event("session.error", { message: "authoritative startup failure" });
    else if (scenario !== "startup-missing") initialized();
    if (scenario === "startup-idle") event("session.idle");
    return {
      sessionId: "scripted-copilot",
      async sendAndWait(message) {
        if (scenario === "profile-instructions") {
          const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
          assert.ok(
            message.prompt.includes(input.request.environment.instructions),
          );
          assert.match(
            message.prompt,
            /subordinate to required Factory worker constraints/,
          );
          assert.match(message.prompt, /Do not commit, push/);
        }
        writeFileSync(process.env.FACTORY_SCRIPTED_PROVIDER_SENT, "sent");
        if (scenario === "progress-timeout") {
          setTimeout(
            () =>
              event("assistant.message_delta", {
                deltaContent: "scripted progress",
              }),
            20,
          );
          return stall();
        }
        if (scenario === "timeout") return stall();
        if (scenario.startsWith("usage")) {
          const first = {
            type: "assistant.usage",
            id: "usage-first",
            timestamp: new Date().toISOString(),
            data: {
              model: options.model,
              apiCallId: "call-1",
              inputTokens: 10,
              outputTokens: 3,
              cacheReadTokens: 5,
              prompt: "private-payload",
            },
          };
          options.onEvent(first);
          options.onEvent(first);
          options.onEvent({ ...first, id: "usage-duplicate" });
          options.onEvent({
            ...first,
            id: "usage-second",
            data: {
              model: options.model,
              apiCallId: "call-2",
              ...(scenario !== "usage-partial" && scenario !== "usage-missing"
                ? { inputTokens: 20 }
                : {}),
              ...(scenario !== "usage-missing" ? { outputTokens: 4 } : {}),
            },
          });
          event("session.usage_info", {
            conversationTokens: 1000,
            inputTokens: 500,
            outputTokens: 500,
          });
          if (scenario === "usage-failure") {
            event("session.error", {
              message: "authoritative provider failure after usage",
            });
            return;
          }
        }
        if (scenario === "failure") {
          event("session.error", { message: "authoritative provider failure" });
          return;
        }
        if (!["nonterminal", "startup-idle"].includes(scenario))
          event("session.idle");
        event("session.shutdown", {
          conversationTokens: 123,
          currentModel: options.model,
        });
        return { data: { content: "scripted completion" } };
      },
      async abort() {},
      async disconnect() {
        if (scenario !== "cleanup-progress") return;
        // Match the SDK boundary: handlers remain registered until detach RPC
        // resolves, so a notification can arrive after the worker ends its turn.
        await new Promise((resolve) => {
          setTimeout(() => {
            const cleanupProgressAt = performance.now();
            event("session.shutdown", { currentModel: options.model });
            process.once("beforeExit", () => {
              writeFileSync(
                process.env.FACTORY_SCRIPTED_PROVIDER_CLEANUP,
                JSON.stringify({
                  callbacks: 1,
                  elapsed: performance.now() - cleanupProgressAt,
                }),
              );
            });
            resolve();
          }, 10);
        });
      },
    };
  }
  async deleteSession() {}
  async stop() {
    return scenario === "cleanup"
      ? [new Error("scripted cleanup failure")]
      : [];
  }
  async forceStop() {}
}
