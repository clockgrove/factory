import { writeFileSync } from "node:fs";

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
            tools: scenario === "startup-tool" ? ["Bash"] : [],
            mcp_servers:
              scenario === "startup-mcp"
                ? [{ name: "ambient", status: "connected" }]
                : [],
            plugins: [
              { name: "agents-md", path: "builtin" },
              { name: "sec-default", path: "builtin" },
            ],
            skills: [],
            agents: [],
          },
        };
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
      async sendAndWait() {
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
