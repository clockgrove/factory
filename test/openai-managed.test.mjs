import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { create } from "tar";
import {
  OpenAIManagedExecutionDriver,
  OpenAIAgentsClient,
  validateOpenAIManagedConfig,
} from "../dist/execution/openai-managed.js";
import { LocalContentStore } from "../dist/content/local.js";
import { executionContext } from "../dist/execution/checkpoint.js";

const config = {
  model: "explicit-model",
  reasoningEffort: "low",
  containerSize: "small",
  apiKeyEnv: "FACTORY_TEST_UNUSED_KEY",
  timeoutSeconds: 10,
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-managed-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  writeFileSync(join(checkout, "old.txt"), "delete me\n");
  writeFileSync(join(checkout, "keep.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const request = {
    attemptId: "attempt-one",
    baseSha,
    item: {
      id: "item",
      title: "managed fixture",
      goal: "edit",
      acceptance: ["done"],
      nonGoals: [],
      citations: [],
      dependencies: [],
      ownedPaths: ["old.txt", "keep.txt", "new.bin", "run.sh"],
      validation: [],
      brief: "edit fixture",
    },
  };
  const work = {
    attempt: request.attemptId,
    status: "running",
    step: "execute",
  };
  const saved = [];
  const context = executionContext(work, () =>
    saved.push(structuredClone(work.execution)),
  );
  const state = {
    phase: "completed",
    artifact: undefined,
    deleted: false,
    calls: [],
    createFailure: false,
    inputFailure: false,
  };
  const transport = {
    async json(method, path, body) {
      state.calls.push({ method, path, body });
      if (method === "POST" && path === "/agents/sessions") {
        assert.equal(saved.at(-1).data.phase, "create-submitted");
        assert.equal(body.input, undefined);
        assert.equal(body.environment.network.access, "disabled");
        assert.equal(body.agent.multi_agent.enabled, false);
        assert.deepEqual(body.agent.tools, []);
        state.binding = JSON.parse(
          Buffer.from(body.environment.files[1].data, "base64"),
        );
        if (state.createFailure) throw new Error("lost create acknowledgement");
        return { id: "session_one", environment: { id: "environment_one" } };
      }
      if (path === "/agents/environments/environment_one")
        return state.deleted ? null : { status: "connected" };
      if (method === "POST" && path.endsWith("/events")) {
        if (body.events[0].type === "agent.session.input.cancel") {
          state.phase = "cancelled";
          return {};
        }
        assert.equal(saved.at(-1).data.phase, "input-submitted");
        assert.equal(saved.at(-1).data.sessionId, "session_one");
        assert.equal(body.events[0].input[0].role, "user");
        if (state.inputFailure) throw new Error("lost input acknowledgement");
        const repo = join(root, "work", "attempt-one", "repo");
        writeFileSync(join(repo, "keep.txt"), "changed\n");
        rmSync(join(repo, "old.txt"));
        writeFileSync(join(repo, "new.bin"), Buffer.from([0, 1, 2, 255, 254]));
        writeFileSync(join(repo, "run.sh"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(repo, "run.sh"), 0o755);
        writeFileSync(
          join(repo, ".factory-result.json"),
          JSON.stringify(state.binding),
        );
        const archive = join(root, "output.tar");
        await create(
          { cwd: repo, file: archive, portable: true, noMtime: true },
          ["keep.txt", "new.bin", "run.sh", ".factory-result.json"],
        );
        state.artifact = readFileSync(archive);
        return {};
      }
      if (method === "DELETE") {
        state.deleted = true;
        return {};
      }
      if (path.includes("/turns?"))
        return {
          data: [
            {
              id: "turn_one",
              session_id: "session_one",
              status: state.phase,
              subagent_id: null,
              usage: null,
            },
          ],
          has_more: false,
        };
      if (path.includes("/artifacts?"))
        return {
          data: [
            {
              id: "artifact_one",
              session_id: "session_one",
              environment_id: "environment_one",
              turn_id: "turn_one",
              path: "/workspace/outputs/factory-result.tar",
              size_bytes: state.artifact.length,
            },
          ],
          has_more: false,
        };
      if (path === "/agents/sessions/session_one") return { status: "idle" };
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async content() {
      return new Response(state.artifact);
    },
  };
  const driver = new OpenAIManagedExecutionDriver({
    checkout,
    workRoot: join(root, "work"),
    contentStore: new LocalContentStore(join(root, "store")),
    config,
    transport,
  });
  return { root, checkout, git, request, work, saved, context, state, driver };
}

test("managed complete result round-trips binary bytes, deletion, executable mode and null usage through real Git", async (t) => {
  const f = fixture(t);
  const handle = await f.driver.start(f.request, f.context);
  const restarted = new OpenAIManagedExecutionDriver({ ...f.driver.args });
  const result = await restarted.collect(handle, f.context);
  assert.equal(f.git("show", `${result.changeRef}:keep.txt`), "changed");
  assert.deepEqual(
    execFileSync("git", [
      "-C",
      f.checkout,
      "show",
      `${result.changeRef}:new.bin`,
    ]),
    Buffer.from([0, 1, 2, 255, 254]),
  );
  assert.match(f.git("ls-tree", result.changeRef, "run.sh"), /^100755/);
  assert.equal(f.git("ls-tree", result.changeRef, "old.txt"), "");
  assert.equal(result.evidence.usage, null);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
  assert.equal(f.state.deleted, true);
  assert.equal(await f.driver.availableSlots(), "unknown");
});

test("lost create or input acknowledgement preserves exact disposition and never resubmits", async (t) => {
  for (const kind of ["createFailure", "inputFailure"]) {
    const f = fixture(t);
    f.state[kind] = true;
    await assert.rejects(f.driver.start(f.request, f.context), /lost/);
    const checkpoint = structuredClone(f.work.execution);
    assert.equal(
      checkpoint.data.phase,
      kind === "createFailure" ? "create-submitted" : "input-submitted",
    );
    if (kind === "inputFailure")
      assert.equal(checkpoint.data.sessionId, "session_one");
    const count = f.state.calls.filter((c) => c.method === "POST").length;
    await assert.rejects(f.driver.observe(checkpoint, f.context), /unresolved/);
    assert.equal(
      f.state.calls.filter((c) => c.method === "POST").length,
      count,
    );
  }
});

test("session idle never turns a failed turn into success; cancellation confirms resource disposition", async (t) => {
  const f = fixture(t);
  const handle = await f.driver.start(f.request, f.context);
  f.state.phase = "failed";
  assert.equal((await f.driver.observe(handle, f.context)).state, "failed");
  await assert.rejects(f.driver.collect(handle, f.context), /failed/);
  f.state.phase = "in_progress";
  await f.driver.cancel(handle, f.context);
  assert.equal(f.state.deleted, true);
  assert.equal(f.saved.at(-1).data.terminal, "cancelled");
});

test("checkpoints reject stale lifecycle writers and non-JSON handles", () => {
  const work = { attempt: "one" };
  const a = executionContext(work, () => {});
  const b = executionContext(work, () => {});
  a.checkpoint({
    provider: "provider",
    identity: "one",
    data: { phase: "first" },
  });
  assert.throws(
    () =>
      b.checkpoint({
        provider: "provider",
        identity: "one",
        data: { phase: "stale" },
      }),
    /superseded/,
  );
  assert.throws(
    () =>
      a.checkpoint({
        provider: "provider",
        identity: "one",
        data: { x: () => {} },
      }),
    /JSON/,
  );
});

test("configured API origin and beta header are exact; ambiguous mutation is never retried", async () => {
  const prior = process.env.FACTORY_TEST_UNUSED_KEY;
  process.env.FACTORY_TEST_UNUSED_KEY = "fixture-only";
  try {
    let calls = 0;
    const client = new OpenAIAgentsClient(
      "FACTORY_TEST_UNUSED_KEY",
      async (url, options) => {
        calls++;
        assert.equal(url, "https://api.openai.com/v1/agents/sessions");
        assert.equal(options.headers["OpenAI-Beta"], "agents=v1");
        throw new Error("disconnect");
      },
    );
    await assert.rejects(
      client.json("POST", "/agents/sessions", {}),
      /disconnect/,
    );
    assert.equal(calls, 1);
  } finally {
    if (prior === undefined) delete process.env.FACTORY_TEST_UNUSED_KEY;
    else process.env.FACTORY_TEST_UNUSED_KEY = prior;
  }
  assert.throws(
    () =>
      validateOpenAIManagedConfig({ ...config, endpoint: "https://elsewhere" }),
    /configuration/,
  );
});

test("result import refuses corrupted bytes, wrong binding and unsafe entries before publication", async (t) => {
  for (const kind of ["truncated", "wrong-base", "symlink"]) {
    const f = fixture(t);
    const handle = await f.driver.start(f.request, f.context);
    if (kind === "truncated")
      f.state.artifact = f.state.artifact.subarray(0, 100);
    else {
      const repo = join(f.root, "work", "attempt-one", "repo");
      if (kind === "wrong-base")
        writeFileSync(
          join(repo, ".factory-result.json"),
          JSON.stringify({ ...f.state.binding, baseSha: "0".repeat(40) }),
        );
      else {
        const { symlinkSync } = await import("node:fs");
        symlinkSync("/tmp/escape", join(repo, "link"));
      }
      const archive = join(f.root, "bad.tar");
      await create(
        { cwd: repo, file: archive, portable: true, noMtime: true },
        kind === "symlink"
          ? ["link", ".factory-result.json"]
          : ["keep.txt", ".factory-result.json"],
      );
      f.state.artifact = readFileSync(archive);
    }
    await assert.rejects(
      f.driver.collect(handle, f.context),
      /archive|TAR|binding|different|unsafe/i,
    );
    assert.equal(f.state.deleted, false);
  }
});

test("turn pagination detects foreign additional work instead of accepting the first completed page", async (t) => {
  const f = fixture(t);
  const handle = await f.driver.start(f.request, f.context);
  const transport = f.driver.args.transport;
  const original = transport.json.bind(transport);
  let pages = 0;
  transport.json = async (method, path, body) => {
    if (path.includes("/turns?")) {
      pages++;
      return path.includes("after=")
        ? {
            data: [
              { id: "turn_other", status: "completed", subagent_id: null },
            ],
            has_more: false,
          }
        : {
            data: [
              {
                id: "turn_one",
                session_id: "session_one",
                status: "completed",
                subagent_id: null,
              },
            ],
            has_more: true,
            last_id: "turn_one",
          };
    }
    return original(method, path, body);
  };
  await assert.rejects(f.driver.observe(handle, f.context), /unexpected work/);
  assert.equal(pages, 2);
});

test("controller cancellation during hosted setup prevents the first work input", async (t) => {
  const f = fixture(t);
  let cancelled = false;
  const context = executionContext(
    f.work,
    () => {
      f.saved.push(structuredClone(f.work.execution));
      if (f.work.execution.data.phase === "prepared") cancelled = true;
    },
    () => cancelled,
  );
  await assert.rejects(
    f.driver.start(f.request, context),
    /cancelled before submission/,
  );
  assert.equal(
    f.state.calls.filter((c) => c.path.endsWith("/events")).length,
    0,
  );
  await f.driver.cancel(
    structuredClone(f.work.execution),
    executionContext(
      f.work,
      () => {},
      () => true,
    ),
  );
  assert.equal(f.work.execution.data.phase, "disposed");
});

test("managed artifact usage is cumulative diagnostic data and absent counters remain unknown", async (t) => {
  const f = fixture(t);
  const observations = [];
  const context = executionContext(
    f.work,
    () => f.saved.push(structuredClone(f.work.execution)),
    () => false,
    (o) => observations.push(o),
  );
  const handle = await f.driver.start(f.request, context);
  await f.driver.observe(handle, context);
  await f.driver.observe(handle, context);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].usage, undefined);
  assert.equal(observations[1].invocationId, handle.identity);
});

test("documented void event acknowledgements accept empty successful HTTP bodies", async () => {
  const previous = process.env.FACTORY_TEST_UNUSED_KEY;
  process.env.FACTORY_TEST_UNUSED_KEY = "fixture-only";
  try {
    const client = new OpenAIAgentsClient(
      "FACTORY_TEST_UNUSED_KEY",
      async () => new Response(null, { status: 200 }),
    );
    assert.equal(
      await client.json("POST", "/agents/sessions/session/events", {
        events: [],
      }),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_TEST_UNUSED_KEY;
    else process.env.FACTORY_TEST_UNUSED_KEY = previous;
  }
});
