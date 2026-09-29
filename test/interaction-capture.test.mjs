import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CaptureWriter,
  readInteractionContent,
  readInteractionMetadata,
} from "../dist/capture.js";
import { CodexPlanningModel } from "../dist/compiler.js";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import {
  DiagnosticEmitter,
  readDiagnosticMetadata,
} from "../dist/diagnostics.js";
import { reviewPacket } from "../dist/review-evidence.js";

const context = {
  repository: "example/capture",
  objective: 1,
  invocationId: "invocation",
  providerAttempt: 1,
  phase: "compile",
  adapter: "synthetic@1",
  configured: { provider: "synthetic", model: "configured" },
};
function home(t) {
  const previous = process.env.XDG_STATE_HOME;
  const path = mkdtempSync(join(tmpdir(), "factory-capture-"));
  process.env.XDG_STATE_HOME = path;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  return path;
}
test("private capture is opt-in, bounded, redacted, ordered and metadata-only readable", (t) => {
  home(t);
  const metadata = [];
  const budget = { retained: 0 };
  const sink = new DiagnosticEmitter(context.repository, 1);
  const emit = (m) => {
    metadata.push(m);
    sink.emit({ operation: "model-capture", outcome: "observed", capture: m });
  };
  new CaptureWriter(context, undefined, [], emit).record(
    { kind: "request" },
    () => {
      throw Error("disabled serializer must not run");
    },
  );
  assert.equal(metadata[0].content.status, "capture-disabled");
  const writer = new CaptureWriter(
    context,
    { enabled: true, maxBytesPerInvocation: 80 },
    ["private-secret"],
    emit,
    budget,
  );
  writer.record({ kind: "request" }, () => ({
    prompt: "private-secret",
    schema: { type: "object" },
  }));
  writer.record(
    { kind: "interaction", toolCallId: "tool1", role: "tool" },
    () => ({ text: "😀".repeat(100) }),
  );
  assert.equal(metadata[1].content.redacted, true);
  assert.equal(metadata[2].content.truncated, true);
  assert.ok(budget.retained <= 80);
  assert.equal(metadata[2].sequence, 2);
  const raw = readInteractionContent(
    context.repository,
    metadata[1].content.reference,
  );
  assert.ok(!raw.includes("private-secret"));
  assert.ok(raw.includes("[REDACTED]"));
  const retry = new CaptureWriter(
    { ...context, providerAttempt: 2 },
    { enabled: true, maxBytesPerInvocation: 80 },
    [],
    emit,
    budget,
  );
  retry.record({ kind: "response" }, () => ({ text: "more" }));
  assert.equal(metadata[3].content.truncated, true);
  const root = join(stateRoot(context.repository), "captures");
  for (const name of readdirSync(root)) chmodSync(join(root, name), 0o644);
  assert.equal(readInteractionMetadata(context.repository, 1).length, 4);
  assert.equal(readDiagnosticMetadata(context.repository, 1).length, 4);
  assert.throws(
    () =>
      readInteractionContent(context.repository, metadata[1].content.reference),
    /restricted/,
  );
  assert.notEqual(
    factoryConfigDigest({ a: 1 }),
    factoryConfigDigest({
      a: 1,
      capture: { enabled: true, maxBytesPerInvocation: 80 },
    }),
  );
});
test("capture serializer/sink failures and symlinks are visible but never thrown into work", (t) => {
  home(t);
  const root = join(stateRoot(context.repository), "captures");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const elsewhere = join(process.env.XDG_STATE_HOME, "elsewhere");
  writeFileSync(elsewhere, "untouched");
  symlinkSync(
    elsewhere,
    join(
      root,
      `${createHash("sha256").update("invocation").digest("hex")}-1.ndjson`,
    ),
  );
  const records = [];
  const writer = new CaptureWriter(
    context,
    { enabled: true, maxBytesPerInvocation: 100 },
    [],
    (r) => records.push(r),
  );
  assert.doesNotThrow(() =>
    writer.record({ kind: "request" }, () => ({ prompt: "test" })),
  );
  assert.equal(records[0].content.status, "unavailable");
  assert.equal(readFileSync(elsewhere, "utf8"), "untouched");
  const cycle = {};
  cycle.self = cycle;
  assert.doesNotThrow(() => writer.record({ kind: "response" }, () => cycle));
  assert.doesNotThrow(() =>
    new CaptureWriter(context, undefined, [], () => {
      throw Error("sink");
    }).record({ kind: "outcome" }),
  );
});
test("all four model phases retain actual request/schema/original evidence IDs and parse-failure response", async (t) => {
  home(t);
  const old = Codex.prototype.startThread;
  const sent = [];
  let response = '{"findings":[]}';
  Codex.prototype.startThread = function () {
    return {
      id: "session",
      async runStreamed(prompt, options) {
        sent.push({ prompt, schema: options.outputSchema });
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "session" };
            yield {
              type: "item.completed",
              item: { id: "message", type: "agent_message", text: response },
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 7,
                cached_input_tokens: 2,
                output_tokens: 3,
              },
            };
          })(),
        };
      },
    };
  };
  t.after(() => {
    Codex.prototype.startThread = old;
  });
  const emitter = new DiagnosticEmitter(
    context.repository,
    1,
    [],
    { enabled: true, maxBytesPerInvocation: 1024 * 1024 },
    "config",
  );
  const model = new CodexPlanningModel(
    "/tmp",
    { model: "planner", reasoningEffort: "medium" },
    { model: "reviewer", reasoningEffort: "medium" },
  );
  const packet = reviewPacket(
    ["criterion"],
    [{ path: "source", content: "pinned literal", origin: "source" }],
  );
  const invocation = (phase) => ({
    invocationId: phase,
    phase,
    ordinal: 0,
    observe: emitter.modelObserver({ scopeId: "scope" }),
  });
  await model.generateStructured({
    objective: "objective",
    baseSha: "a".repeat(40),
    sources: [{ path: "source", content: "pinned literal" }],
    schema: { type: "object" },
    controllerCapabilities: {},
    controllerCapabilitiesDigest: "cap",
    invocation: invocation("compile"),
  });
  await model.reviewGraph({
    objective: "objective",
    baseSha: "a".repeat(40),
    sources: [{ path: "source", content: "pinned literal" }],
    graph: { items: [] },
    reviewPacket: packet,
    invocation: invocation("graph-review"),
  });
  for (const phase of ["result-review", "objective-review"])
    await model.reviewResult({
      criteria: ["criterion"],
      reviewPacket: packet,
      baseSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      sources: [],
      change: "",
      commands: [],
      reviewPhase: phase,
      invocation: invocation(phase),
    });
  let records = readInteractionMetadata(context.repository, 1);
  const requests = records.filter((r) => r.kind === "request");
  assert.equal(requests.length, 4);
  for (const [index, r] of requests.entries()) {
    const actual = JSON.parse(
      readInteractionContent(context.repository, r.content.reference),
    );
    assert.equal(actual.prompt, sent[index].prompt);
    assert.deepEqual(actual.schema, sent[index].schema);
  }
  assert.ok(
    JSON.parse(
      readInteractionContent(context.repository, requests[2].content.reference),
    ).prompt.includes(packet.evidence[0].id),
  );
  response = "not JSON";
  await assert.rejects(
    model.reviewResult({
      criteria: ["criterion"],
      reviewPacket: packet,
      baseSha: "a",
      treeSha: "b",
      sources: [],
      change: "",
      commands: [],
      invocation: invocation("bad"),
    }),
  );
  records = readInteractionMetadata(context.repository, 1);
  assert.ok(
    records.some(
      (r) =>
        r.invocationId === "bad" &&
        r.outcome?.stage === "provider" &&
        r.outcome.status === "completed",
    ),
  );
  assert.ok(
    records.some(
      (r) =>
        r.invocationId === "bad" &&
        r.outcome?.stage === "parse" &&
        r.outcome.status === "invalid",
    ),
  );
  assert.ok(
    records.some(
      (r) =>
        r.invocationId === "bad" &&
        r.kind === "response" &&
        readInteractionContent(
          context.repository,
          r.content.reference,
        ).includes("not JSON"),
    ),
  );
});
