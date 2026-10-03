import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  exportEndpoint,
  mapOtlpCaptures,
  otlpHeaders,
  prepareOtlpExport,
  selectCaptures,
  sendOtlpExport,
} from "../dist/capture-export.js";
import { parseCaptureExportOptions } from "../dist/capture-export-cli.js";

const options = { endpoint: "https://example.test", content: "metadata" };
const record = (id, sequence, extras = {}) => ({
  schemaVersion: 1,
  recordId: id,
  at: `2026-01-01T00:00:0${sequence}.000Z`,
  sequence,
  repository: "example/target",
  objective: 1,
  runId: "run-one",
  itemId: "item-one",
  attemptId: "attempt-one",
  invocationId: "invocation-one",
  providerAttempt: 1,
  phase: "result-review",
  kind: "request",
  factoryVersion: "synthetic",
  adapter: "synthetic",
  configured: {
    provider: "synthetic",
    model: "configured-model",
    reasoningEffort: "medium",
  },
  coverage: "boundary",
  content: { status: "capture-disabled", redacted: false, truncated: false },
  ...extras,
});
const records = [
  record("request", 1),
  record("usage", 2, {
    kind: "usage",
    usage: {
      scope: "invocation-cumulative",
      terminal: false,
      completeness: "available-categories",
      normalized: { inputTokens: 10 },
    },
  }),
  record("response", 3, {
    kind: "response",
    reportedModel: "reported-model",
    outcome: { stage: "provider", status: "completed" },
  }),
  record("terminal-usage", 4, {
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
  record("child-usage", 5, {
    kind: "usage",
    usage: {
      scope: "provider-call",
      terminal: true,
      completeness: "available-categories",
      normalized: { inputTokens: 10, outputTokens: 5 },
    },
  }),
  record("semantic", 6, {
    kind: "outcome",
    outcome: { stage: "semantic", status: "refused" },
  }),
  record("parallel", 2, {
    invocationId: "parallel-invocation",
    itemId: "parallel-item",
    attemptId: "parallel-attempt",
  }),
];
function selected(
  opts = options,
  entries = records,
  contentReader = () => {
    throw new Error("must not open content");
  },
  diagnostics = [],
) {
  return selectCaptures(
    "example/target",
    1,
    opts,
    entries,
    contentReader,
    diagnostics,
  );
}

test("metadata export uses capture identities, concurrency, latest cumulative usage and distinct outcomes without reading content", () => {
  const capture = selected();
  const prepared = prepareOtlpExport(capture);
  assert.equal(prepared.preview.observationCount, 7);
  assert.equal(prepared.preview.identities.length, 2);
  assert.equal(prepared.preview.usage.inputTokens.total, 10);
  assert.equal(prepared.preview.usage.outputTokens.total, 5);
  assert.equal(prepared.preview.usage.inputTokens.coverage, "partial");
  assert.equal(prepared.preview.usage.reasoningOutputTokens.total, null);
  const spans = mapOtlpCaptures(capture).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.ok(
    spans.every(
      (span) =>
        /^[0-9a-f]{32}$/.test(span.traceId) &&
        /^[0-9a-f]{16}$/.test(span.spanId),
    ),
  );
  assert.notEqual(spans[0].traceId, spans[1].traceId);
  const full = spans.find(
    (span) =>
      JSON.parse(
        span.attributes.find((a) => a.key === "factory.metadata").value
          .stringValue,
      ).observations.length === 6,
  );
  assert.equal(full.startTimeUnixNano, "1767225601000000000");
  assert.equal(full.endTimeUnixNano, "1767225603000000000");
  assert.equal(full.parentSpanId, undefined);
  const metadata = JSON.parse(
    full.attributes.find((a) => a.key === "factory.metadata").value.stringValue,
  );
  assert.equal(metadata.identity.model, "configured-model");
  assert.equal(metadata.identity.reportedModel, "reported-model");
  assert.equal(metadata.outcomes.provider[0].status, "completed");
  assert.equal(metadata.outcomes.semantic[0].status, "refused");
  assert.equal(metadata.usage.categories.totalTokens, 15);
  assert.equal(metadata.costEstimate, null);
});

test("selection rejects missing identities and conflicting duplicate capture records; exact duplicates produce stable bytes", () => {
  assert.throws(
    () => selected({ ...options, runs: ["missing"] }),
    /No retained capture matches/,
  );
  assert.throws(
    () =>
      selected(
        { ...options, runs: ["run-one"], invocations: ["parallel-invocation"] },
        records.map((r) =>
          r.invocationId === "parallel-invocation"
            ? { ...r, runId: "run-two" }
            : r,
        ),
      ),
    /No retained captures match/,
  );
  assert.throws(
    () => selected(options, [...records, { ...records[0], phase: "changed" }]),
    /Conflicting capture record/,
  );
  const one = prepareOtlpExport(selected());
  const two = prepareOtlpExport(
    selected(options, [...records].reverse().concat(records[0])),
  );
  assert.equal(one.payload, two.payload);
  assert.equal(
    one.preview.authorizationDigest,
    two.preview.authorizationDigest,
  );
  const filtered = prepareOtlpExport(
    selected({ ...options, invocations: ["parallel-invocation"] }),
  );
  assert.equal(filtered.preview.identities.length, 1);
  assert.notEqual(
    one.preview.authorizationDigest,
    filtered.preview.authorizationDigest,
  );
});

test("retained export keeps redacted/truncated text, unavailable references and tool relationships faithfully", () => {
  const entries = [
    record("request", 1, {
      content: {
        status: "captured",
        redacted: true,
        truncated: true,
        retainedBytes: 12,
        reference: {
          invocationId: "invocation-one",
          providerAttempt: 1,
          recordId: "request",
        },
      },
    }),
    record("tool", 2, {
      kind: "interaction",
      role: "tool",
      tool: "read",
      toolCallId: "tool-call",
      providerMessageId: "message",
      coverage: "sdk-exposed",
      content: {
        status: "captured",
        redacted: false,
        truncated: false,
        reference: {
          invocationId: "invocation-one",
          providerAttempt: 1,
          recordId: "tool",
        },
      },
    }),
    record("missing", 3, {
      content: { status: "not-exposed", redacted: false, truncated: false },
    }),
  ];
  const prepared = prepareOtlpExport(
    selected({ ...options, content: "retained" }, entries, (_repo, ref) => {
      if (ref.recordId === "request") return '{"[REDACTED]';
      throw new Error("missing private file");
    }),
  );
  assert.ok(prepared.payload.includes("[REDACTED]"));
  assert.ok(!prepared.payload.includes("missing private file"));
  assert.equal(prepared.preview.contentStatus[0].redacted, true);
  assert.equal(prepared.preview.contentStatus[0].truncated, true);
  assert.equal(prepared.preview.contentStatus[1].exportStatus, "unavailable");
  assert.equal(prepared.preview.contentStatus[2].exportStatus, "not-exposed");
  const span = JSON.parse(prepared.payload).resourceSpans[0].scopeSpans[0]
    .spans[0];
  const metadata = JSON.parse(
    span.attributes.find((a) => a.key === "factory.metadata").value.stringValue,
  );
  assert.equal(metadata.observations[1].toolCallId, "tool-call");
});

test("controller validation/delivery retain recorded scope without becoming model outcomes", () => {
  const diagnostics = [
    {
      eventId: "validation",
      at: records[5].at,
      repository: "example/target",
      objective: 1,
      runId: "run-one",
      itemId: "item-one",
      attemptId: "attempt-one",
      operation: "validation",
      outcome: "failed",
      metadata: { treeSha: "synthetic" },
    },
    {
      eventId: "other",
      at: records[5].at,
      repository: "example/target",
      objective: 1,
      itemId: "other-item",
      operation: "delivery",
      outcome: "success",
    },
  ];
  const capture = selected(options, records, undefined, diagnostics);
  assert.equal(capture.controllerObservations.length, 1);
  assert.ok(prepareOtlpExport(capture).payload.includes("validation"));
  assert.ok(!prepareOtlpExport(capture).payload.includes("other-item"));
});

test("export CLI requires explicit endpoint/content and exact send authorization", () => {
  for (const flag of ["--destination", "--project-id", "--workspace-id"])
    assert.throws(
      () => parseCaptureExportOptions([flag, "value"]),
      /Unknown export-captures option/,
    );
  assert.throws(
    () => parseCaptureExportOptions(["--endpoint", "https://example.test"]),
    /content/,
  );
  assert.throws(
    () =>
      parseCaptureExportOptions([
        "--endpoint",
        "https://example.test",
        "--content",
        "metadata",
        "--send",
      ]),
    /authorize/,
  );
  assert.throws(
    () =>
      parseCaptureExportOptions([
        "--content",
        "metadata",
        "--content",
        "retained",
      ]),
    /Duplicate/,
  );
  assert.throws(
    () => exportEndpoint("https://key:secret@example.test", "/api"),
    /HTTPS/,
  );
  for (const plain of [
    "http://example.test",
    "http://10.0.0.1:4318",
    "http://localhost.example.test",
    "http://127.example.test",
  ])
    assert.throws(() => exportEndpoint(plain, "/api"), /HTTPS/);
  for (const [base, expected] of [
    ["https://example.test/base/", "https://example.test/base/api"],
    ["http://localhost:4318", "http://localhost:4318/api"],
    ["http://127.0.0.1:4318/", "http://127.0.0.1:4318/api"],
    ["http://127.8.9.10", "http://127.8.9.10/api"],
    ["http://[::1]:4318", "http://[::1]:4318/api"],
  ])
    assert.equal(exportEndpoint(base, "/api"), expected);
  for (const full of [
    "https://example.test/v1/traces",
    "https://example.test/otlp/v1/traces/",
  ])
    assert.throws(
      () => exportEndpoint(full, "/v1/traces"),
      /Pass the base URL; Factory appends \/v1\/traces/,
    );
});

const keys = {
  OTEL_EXPORTER_OTLP_HEADERS:
    "Authorization=Basic%20test-secret, x-tenant = one",
};

test("send is one authorized HTTP request with no redirects, retries or incidental secrets", async () => {
  const prepared = prepareOtlpExport(selected(), keys);
  assert.deepEqual(prepared.preview.headerNames, ["Authorization", "x-tenant"]);
  assert.ok(!JSON.stringify(prepared.preview).includes("test-secret"));
  let calls = 0;
  const request = async (url, init) => {
    calls++;
    assert.equal(url, "https://example.test/v1/traces");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, {
      Authorization: "Basic test-secret",
      "x-tenant": "one",
      "Content-Type": "application/json",
    });
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    () => sendOtlpExport(prepared, "not-authorized", keys, request),
    /preview/,
  );
  await assert.rejects(
    () =>
      sendOtlpExport(
        prepared,
        prepared.preview.authorizationDigest,
        { OTEL_EXPORTER_OTLP_HEADERS: "no-separator" },
        request,
      ),
    /malformed/,
  );
  // Changing a header value (here the tenant) after preview invalidates it.
  for (const changedHeaders of [
    {
      OTEL_EXPORTER_OTLP_HEADERS:
        "Authorization=Basic%20test-secret, x-tenant = two",
    },
    { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20test-secret" },
    {},
  ])
    await assert.rejects(
      () =>
        sendOtlpExport(
          prepared,
          prepared.preview.authorizationDigest,
          changedHeaders,
          request,
        ),
      /changed/,
    );
  assert.equal(calls, 0);
  const receipt = await sendOtlpExport(
    prepared,
    prepared.preview.authorizationDigest,
    keys,
    request,
  );
  assert.equal(calls, 1);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.retries, 0);
  assert.ok(!JSON.stringify(receipt).includes("test-secret"));
  const changed = { ...prepared, payload: `${prepared.payload} ` };
  await assert.rejects(
    () =>
      sendOtlpExport(
        changed,
        prepared.preview.authorizationDigest,
        keys,
        request,
      ),
    /changed/,
  );
});

test("OTLP acknowledgements: empty partialSuccess is success; partial, refusal and uncertain replies stay visible without response text", async () => {
  const prepared = prepareOtlpExport(selected(), keys);
  for (const [reply, status, rejectedSpans] of [
    ['{"partialSuccess":{}}', "accepted"],
    ['{"partialSuccess":{"rejectedSpans":"0","errorMessage":""}}', "accepted"],
    [
      '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"test-secret"}}',
      "partial-or-warning",
      1,
    ],
    ['{"partialSuccess":{"rejectedSpans":2}}', "partial-or-warning", 2],
    [
      '{"partialSuccess":{"errorMessage":"test-secret warning"}}',
      "partial-or-warning",
      0,
    ],
    ['{"partialSuccess":{"rejectedSpans":"x"}}', "partial-or-warning", null],
    [["test-secret", 429], "rejected-or-unknown"],
    ['{"error":"test-secret"}', "unknown"],
    ['{"partialSuccess":null}', "unknown"],
    ["not JSON", "unknown"],
  ]) {
    let calls = 0;
    const [text, httpStatus] = Array.isArray(reply) ? reply : [reply, 200];
    const receipt = await sendOtlpExport(
      prepared,
      prepared.preview.authorizationDigest,
      keys,
      async () => {
        calls++;
        return new Response(text, { status: httpStatus });
      },
    );
    assert.equal(receipt.status, status, text);
    if (rejectedSpans !== undefined)
      assert.equal(receipt.rejectedSpans, rejectedSpans, text);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(receipt).includes("test-secret"));
  }
  const receipt = await sendOtlpExport(
    prepared,
    prepared.preview.authorizationDigest,
    keys,
    async () => {
      throw new Error("test-secret content");
    },
  );
  assert.equal(receipt.status, "unknown");
  assert.ok(!JSON.stringify(receipt).includes("test-secret"));
});

test("OTLP headers prefer the traces-specific variable and refuse malformed names or values without echoing them", () => {
  assert.deepEqual(
    otlpHeaders({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=generic",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=traces",
    }),
    { Authorization: "traces" },
  );
  assert.deepEqual(otlpHeaders({}), {});
  for (const value of [
    "=test-secret",
    "Authorization=%E0%A4%A-test-secret",
    "Bad Name=test-secret",
    "x(test-secret)=1",
    "x-tenant:test-secret=1",
    "Authorization=test-secret%0D%0AInjected: 1",
  ])
    assert.throws(
      () => otlpHeaders({ OTEL_EXPORTER_OTLP_TRACES_HEADERS: value }),
      (error) =>
        /OTEL_EXPORTER_OTLP_TRACES_HEADERS is malformed/.test(error.message) &&
        !error.message.includes("test-secret"),
    );
});

test("a local OTLP/HTTP collector on loopback gets one standard JSON trace request", async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      // The OpenTelemetry Collector acknowledges full success this way.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"partialSuccess":{}}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const environment = {
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20local",
    };
    const prepared = prepareOtlpExport(
      selected({ ...options, endpoint: `http://127.0.0.1:${port}/otlp` }),
      environment,
    );
    assert.equal(
      prepared.preview.endpoint,
      `http://127.0.0.1:${port}/otlp/v1/traces`,
    );
    const receipt = await sendOtlpExport(
      prepared,
      prepared.preview.authorizationDigest,
      environment,
    );
    assert.equal(receipt.status, "accepted");
    assert.equal(received.length, 1);
    const [request] = received;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/otlp/v1/traces");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.authorization, "Bearer local");
    assert.equal(request.body, prepared.payload);
    const [resourceSpans] = JSON.parse(request.body).resourceSpans;
    assert.deepEqual(resourceSpans.resource.attributes, [
      { key: "service.name", value: { stringValue: "factory" } },
    ]);
    const spans = resourceSpans.scopeSpans[0].spans;
    assert.equal(spans.length, 2);
    for (const span of spans)
      assert.deepEqual(
        span.attributes.map((attribute) => attribute.key),
        ["session.id", "factory.metadata"],
      );
    assert.ok(!/langfuse|langsmith/i.test(request.body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
