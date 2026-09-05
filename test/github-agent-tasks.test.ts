import { describe, expect, it } from "vitest";

import { GitHubReader } from "../src/github.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function taskFetch(
  options: { sessionState?: string; sessionHead?: string; duplicate?: boolean } = {},
) {
  const calls: URL[] = [];
  const summary = {
    id: "task-1",
    creator: { id: 7 },
    repository: { id: 99 },
    state: options.sessionState ?? "completed",
    session_count: 1,
    artifacts: [{ provider: "github", type: "pull", data: { id: 42 } }],
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url);
    if (url.pathname === "/user") return response({ id: 7 });
    if (url.pathname === "/repos/clockgrove/factory/pulls/51") {
      return response({
        id: 42,
        head: { ref: "copilot/factory-51", repo: { id: 99 } },
        base: { repo: { id: 99 } },
      });
    }
    if (url.pathname === "/agents/repos/clockgrove/factory/tasks/task-1") {
      return response({
        ...summary,
        sessions: [
          {
            id: "session-1",
            task_id: "task-1",
            user: { id: 7 },
            repository: { id: 99 },
            state: options.sessionState ?? "completed",
            head_ref: options.sessionHead ?? "copilot/factory-51",
          },
        ],
      });
    }
    if (url.pathname === "/agents/repos/clockgrove/factory/tasks") {
      if (url.searchParams.get("per_page") === "1") return response({ tasks: [] });
      const tasks = url.searchParams.get("is_archived") === "true" ? [] : [summary];
      return response({ tasks: options.duplicate ? [...tasks, ...tasks] : tasks });
    }
    return response({ message: `unexpected ${url.pathname}` }, 404);
  };
  return { fetch, calls };
}

describe("GitHub Copilot Agent Tasks reader", () => {
  it("probes read permission and binds a terminal session to the exact PR artifact", async () => {
    const transport = taskFetch();
    const reader = new GitHubReader({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: transport.fetch,
    });
    await expect(reader.probeCopilotAgentTasks()).resolves.toBeUndefined();
    await expect(
      reader.readCopilotAgentTaskForPull(51, "2026-09-04T00:00:00.000Z"),
    ).resolves.toMatchObject({
      taskId: "task-1",
      taskState: "completed",
      sessionIds: ["session-1"],
      activeSessionIds: [],
    });
    expect(transport.calls.filter((url) => url.pathname === "/user")).toHaveLength(1);
    expect(
      transport.calls
        .filter((url) => url.pathname.endsWith("/tasks"))
        .every((url) => url.searchParams.getAll("creator_id").includes("7")),
    ).toBe(true);
  });

  it("reports an exact nonterminal session instead of treating PR completion as cleanup", async () => {
    const transport = taskFetch({ sessionState: "in_progress" });
    const reader = new GitHubReader({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: transport.fetch,
    });
    await expect(
      reader.readCopilotAgentTaskForPull(51, "2026-09-04T00:00:00.000Z"),
    ).resolves.toMatchObject({
      taskState: "in_progress",
      activeSessionIds: ["session-1"],
    });
  });

  it("fails closed on duplicate task artifacts or a session outside the exact PR ref", async () => {
    const duplicate = taskFetch({ duplicate: true });
    await expect(
      new GitHubReader({
        token: "test-token",
        owner: "clockgrove",
        repo: "factory",
        requestFetch: duplicate.fetch,
      }).readCopilotAgentTaskForPull(51, "2026-09-04T00:00:00.000Z"),
    ).rejects.toThrow(/ambiguous task/);

    const changed = taskFetch({ sessionHead: "copilot/other" });
    await expect(
      new GitHubReader({
        token: "test-token",
        owner: "clockgrove",
        repo: "factory",
        requestFetch: changed.fetch,
      }).readCopilotAgentTaskForPull(51, "2026-09-04T00:00:00.000Z"),
    ).rejects.toThrow(/outside the exact Agent Task binding/);
  });
});
