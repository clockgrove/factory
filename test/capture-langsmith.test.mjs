import assert from "node:assert/strict";
import test from "node:test";
import { selectCaptures } from "../dist/capture-export.js";
import {
  mapLangSmithCaptures,
  prepareLangSmithExport,
  sendLangSmithExport,
} from "../dist/capture-langsmith.js";
import { parseCaptureExportOptions } from "../dist/capture-export-cli.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const options = {
  endpoint: "https://api.smith.langchain.com",
  content: "metadata",
};
const record = (recordId, invocationId, sequence, extras = {}) => ({
  schemaVersion: 1,
  recordId,
  at: `2026-01-01T00:00:0${sequence}.000Z`,
  sequence,
  repository: "example/target",
  objective: 1,
  runId: "actual-run",
  invocationId,
  providerAttempt: 1,
  phase: "result-review",
  kind: "request",
  factoryVersion: "synthetic",
  adapter: "synthetic",
  configured: { provider: "synthetic", model: "configured" },
  coverage: "boundary",
  content: { status: "capture-disabled", redacted: false, truncated: false },
  ...extras,
});
const records = [
  record("one-request", "one", 1),
  record("one-response", "one", 3, {
    kind: "response",
    reportedModel: "reported",
    outcome: { stage: "provider", status: "completed" },
  }),
  record("one-usage", "one", 4, {
    kind: "usage",
    usage: {
      scope: "invocation-cumulative",
      terminal: true,
      completeness: "available-categories",
      normalized: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 5,
        totalTokens: 15,
      },
    },
  }),
  record("one-child", "one", 5, {
    kind: "usage",
    usage: {
      scope: "provider-call",
      terminal: true,
      completeness: "available-categories",
      normalized: { inputTokens: 10, outputTokens: 5 },
    },
  }),
  record("one-review", "one", 6, {
    kind: "outcome",
    outcome: { stage: "semantic", status: "refused" },
  }),
  record("two-request", "two", 2, { attemptId: "two-attempt" }),
  record("three-request", "three", 2, { attemptId: "three-attempt" }),
];
const select = (
  entries = records,
  opts = options,
  read = () => {
    throw new Error("metadata must not read content");
  },
) => selectCaptures("example/target", 1, opts, entries, read, []);
const prepare = () =>
  prepareLangSmithExport(select(), { projectId, workspaceId });
const environment = { LANGSMITH_API_KEY: "synthetic-api-key" };

test("LangSmith mapping preserves concurrency, exact identities, cumulative usage provenance and separate evaluation outcomes", () => {
  const runs = mapLangSmithCaptures(select(), { projectId });
  assert.equal(runs.length, 3);
  assert.ok(
    runs.every((run) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        run.id,
      ),
    ),
  );
  assert.equal(new Set(runs.map((run) => run.id)).size, 3);
  const one = runs.find((run) => run.events.length === 5);
  assert.equal(one.trace_id, one.id);
  assert.equal(one.session_id, projectId);
  assert.equal(one.parent_run_id, undefined);
  assert.equal(one.run_type, "chain");
  assert.equal(one.start_time, records[0].at);
  assert.equal(one.end_time, records[1].at);
  assert.deepEqual(one.inputs, {});
  assert.equal(one.outputs.outcomes.provider[0].status, "completed");
  assert.equal(one.outputs.outcomes.semantic[0].status, "refused");
  const factory = one.extra.metadata.factory;
  assert.equal(factory.identity.model, "configured");
  assert.equal(factory.identity.reportedModel, "reported");
  assert.equal(factory.usage.categories.totalTokens, 15);
  assert.equal(factory.usage.categories.reasoningOutputTokens, null);
  assert.equal(factory.costEstimate, null);
  assert.equal(one.total_tokens, undefined);
  const partial = runs.find(
    (run) => run.extra.metadata.factory.identity.invocationId === "two",
  );
  assert.equal(partial.end_time, undefined);
  assert.equal(partial.extra.metadata.factory.interval.complete, false);
});

test("LangSmith destination and payload are preview-bound, stable across order and distinct by attempt", () => {
  const prepared = prepare();
  const repeat = prepareLangSmithExport(
    select([...records].reverse().concat(records[0])),
    { projectId, workspaceId },
  );
  assert.equal(prepared.payload, repeat.payload);
  assert.equal(
    prepared.preview.authorizationDigest,
    repeat.preview.authorizationDigest,
  );
  assert.equal(
    prepared.preview.endpoint,
    "https://api.smith.langchain.com/api/v1/runs",
  );
  assert.equal(prepared.preview.projectId, projectId);
  assert.equal(prepared.preview.workspaceId, workspaceId);
  assert.equal(prepared.preview.requestCount, 3);
  const alternate = prepareLangSmithExport(select(), {
    projectId,
    workspaceId: "33333333-3333-4333-8333-333333333333",
  });
  assert.notEqual(
    prepared.preview.authorizationDigest,
    alternate.preview.authorizationDigest,
  );
  assert.throws(
    () =>
      prepareLangSmithExport(select(), { projectId: "implicit-project-name" }),
    /UUID/,
  );
  const attempts = mapLangSmithCaptures(
    select([
      records[0],
      { ...records[0], recordId: "retry-request", providerAttempt: 2 },
    ]),
    { projectId },
  );
  assert.notEqual(attempts[0].id, attempts[1].id);
});

test("LangSmith retained mode preserves truncated redacted strings and tool-call correlation", () => {
  const request = record("retained", "one", 1, {
    content: {
      status: "captured",
      redacted: true,
      truncated: true,
      reference: {
        invocationId: "one",
        providerAttempt: 1,
        recordId: "retained",
      },
    },
  });
  const tool = record("tool", "one", 2, {
    kind: "interaction",
    role: "tool",
    tool: "read",
    toolCallId: "call-id",
    providerMessageId: "message-id",
    content: { status: "not-exposed", redacted: false, truncated: false },
  });
  const prepared = prepareLangSmithExport(
    select(
      [request, tool],
      { ...options, content: "retained" },
      () => '{"[REDACTED]',
    ),
    { projectId },
  );
  const [run] = JSON.parse(prepared.payload);
  assert.equal(run.inputs.observations[0].text, '{"[REDACTED]');
  assert.equal(run.events[1].kwargs.factory.toolCallId, "call-id");
  assert.equal(
    run.events[1].kwargs.factory.exportedContent.status,
    "not-exposed",
  );
  assert.equal(prepared.preview.contentStatus[0].truncated, true);
  assert.ok(!JSON.stringify(prepared.preview).includes("[REDACTED]"));
});

test("one direct REST call per run sends only bound project/workspace and acknowledges documented HTTP 202", async () => {
  const prepared = prepare();
  const requests = [];
  const receipt = await sendLangSmithExport(
    prepared,
    prepared.preview.authorizationDigest,
    environment,
    async (url, init) => {
      assert.equal(url, prepared.preview.endpoint);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["x-api-key"], "synthetic-api-key");
      assert.equal(init.headers["x-tenant-id"], workspaceId);
      const run = JSON.parse(init.body);
      assert.equal(run.session_id, projectId);
      assert.equal(run.session_name, undefined);
      requests.push(run.id);
      return new Response('{"message":"accepted"}', { status: 202 });
    },
  );
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(requests, prepared.preview.runIds);
  assert.ok(
    receipt.uploads.every((upload) => upload.status === "acknowledged"),
  );
  assert.equal(receipt.retries, 0);
  assert.ok(!JSON.stringify(receipt).includes("synthetic-api-key"));
});

test("partial LangSmith HTTP failures preserve accepted, refused and unsent IDs without retry or echoed secrets", async () => {
  const prepared = prepare();
  let calls = 0;
  const receipt = await sendLangSmithExport(
    prepared,
    prepared.preview.authorizationDigest,
    environment,
    async () => {
      calls++;
      return new Response("synthetic-api-key private content", {
        status: calls === 1 ? 202 : 429,
      });
    },
  );
  assert.equal(calls, 2);
  assert.equal(receipt.status, "incomplete");
  assert.deepEqual(
    receipt.uploads.map((upload) => upload.status),
    ["acknowledged", "rejected-or-unknown", "not-sent"],
  );
  assert.ok(!JSON.stringify(receipt).includes("private content"));
  assert.ok(!JSON.stringify(receipt).includes("synthetic-api-key"));
});

test("unknown transport, duplicate conflict and authorization mutation never silently succeed or retry", async () => {
  const prepared = prepare();
  let calls = 0;
  const request = async () => {
    calls++;
    throw new Error("synthetic-api-key");
  };
  await assert.rejects(
    () => sendLangSmithExport(prepared, "wrong", environment, request),
    /changed/,
  );
  await assert.rejects(
    () =>
      sendLangSmithExport(
        prepared,
        prepared.preview.authorizationDigest,
        {},
        request,
      ),
    /LANGSMITH_API_KEY/,
  );
  await assert.rejects(
    () =>
      sendLangSmithExport(
        { ...prepared, preview: { ...prepared.preview, workspaceId: null } },
        prepared.preview.authorizationDigest,
        environment,
        request,
      ),
    /changed/,
  );
  assert.equal(calls, 0);
  const uncertain = await sendLangSmithExport(
    prepared,
    prepared.preview.authorizationDigest,
    environment,
    request,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    uncertain.uploads.map((upload) => upload.status),
    ["unknown", "not-sent", "not-sent"],
  );
  const conflict = await sendLangSmithExport(
    prepared,
    prepared.preview.authorizationDigest,
    environment,
    async () => new Response("conflict", { status: 409 }),
  );
  assert.equal(conflict.status, "incomplete");
  assert.equal(conflict.uploads[0].httpStatus, 409);
});

test("CLI requires explicit existing LangSmith project, rejects cross-destination options and accepts scoped preview", () => {
  const args = [
    "--destination",
    "langsmith",
    "--endpoint",
    options.endpoint,
    "--content",
    "metadata",
  ];
  assert.throws(() => parseCaptureExportOptions(args), /project-id/);
  const parsed = parseCaptureExportOptions([
    ...args,
    "--project-id",
    projectId,
    "--workspace-id",
    workspaceId,
    "--run",
    "actual-run",
  ]);
  assert.equal(parsed.destination, "langsmith");
  assert.equal(parsed.projectId, projectId);
  assert.equal(parsed.workspaceId, workspaceId);
  assert.deepEqual(parsed.options.runs, ["actual-run"]);
  assert.throws(
    () =>
      parseCaptureExportOptions([
        "--destination",
        "langfuse",
        "--endpoint",
        options.endpoint,
        "--content",
        "metadata",
        "--project-id",
        projectId,
      ]),
    /for LangSmith/,
  );
});
