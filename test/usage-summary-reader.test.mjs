import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import {
  diagnosticPath,
  readAgentTimeline,
  readUsageSummaryEvents,
  summarizeDiagnosticUsage,
} from "../dist/diagnostics.js";

const repository = "example/summary-reader";
const attempt = "11111111-1111-4111-8111-111111111111";
const unrelated = "22222222-2222-4222-8222-222222222222";
const missing = "33333333-3333-4333-8333-333333333333";
const usage = (type, inputTokens, at = "2026-01-01T00:00:00Z") => ({
  at,
  operation: "worker-usage",
  attemptId: unrelated,
  workerUsage: {
    type,
    role: "worker",
    phase: "implementation",
    invocationId: "worker",
    providerAttempt: 1,
    usage: { inputTokens, cachedInputTokens: inputTokens / 2 },
    detail: "discard this unneeded field",
  },
});

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-summary-reader-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const path = diagnosticPath(repository, 1);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const controller = [
      {
        at: "2026-01-01",
        operation: "harness",
        attemptId: attempt,
        itemId: "old",
        runId: "old-run",
      },
      {
        at: "2026-01-01",
        operation: "validation-output",
        attemptId: attempt,
        itemId: "item",
        runId: "run",
        detail: "private",
      },
      {
        at: "2026-01-01",
        operation: "harness",
        attemptId: missing,
        itemId: "missing",
      },
      {
        at: "2026-01-01",
        operation: "model-invocation",
        detail: "private model detail",
        metadata: {
          invocationId: "model",
          scopeId: "plan",
          phase: "compile",
          observationType: "completed",
          usageAvailable: true,
          inputTokens: 7,
        },
      },
    ];
    writeFileSync(path, controller.map(JSON.stringify).join("\n") + "\n", {
      mode: 0o600,
    });
    const harness = join(stateRoot(repository), "harness");
    mkdirSync(harness, { mode: 0o700 });
    const progress = join(harness, `${attempt}.progress.ndjson`);
    writeFileSync(
      progress,
      [
        usage("completed", 20, "2026-01-03"),
        usage("progress", 10, "2026-01-02"),
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(harness, `${unrelated}.progress.ndjson`),
      "malformed unrelated\n",
      { mode: 0o600 },
    );
    run({ root, path, progress, harness });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("streamed summary preserves ordering, controller correlation and missing coverage", () => {
  fixture(({ progress }) => {
    const expected = summarizeDiagnosticUsage(readAgentTimeline(repository, 1));
    const selected = readUsageSummaryEvents(repository, 1);
    assert.deepEqual(summarizeDiagnosticUsage(selected), expected);
    assert.equal(expected.workerUsage.tokenTotals.inputTokens, 20);
    assert.equal(expected.workerUsage.coverage.unobservedAttemptCount, 1);
    assert.equal(
      Object.values(expected.workerUsage.byInvocation)[0].attemptId,
      attempt,
    );
    assert.equal(
      Object.values(expected.workerUsage.byInvocation)[0].itemId,
      "item",
    );
    assert.equal(
      Object.values(expected.workerUsage.byInvocation)[0].runId,
      "run",
    );
    assert.doesNotMatch(JSON.stringify(selected), /private|discard/);
    const state = { runId: "snapshot-run", work: { override: { attempt } } };
    assert.deepEqual(
      summarizeDiagnosticUsage(readUsageSummaryEvents(repository, 1, state)),
      summarizeDiagnosticUsage(readAgentTimeline(repository, 1, state)),
    );
    appendFileSync(
      progress,
      '\nnull\n42\n"string"\n' + JSON.stringify(usage("failed", 99)),
    );
    assert.deepEqual(
      summarizeDiagnosticUsage(readUsageSummaryEvents(repository, 1)),
      expected,
    );
    const unicode = "π🧪".repeat(20_000);
    const largeRecord = usage("completed", 30);
    largeRecord.workerUsage.invocationId = unicode;
    writeFileSync(progress, JSON.stringify(largeRecord) + "\n");
    const unicodeSummary = summarizeDiagnosticUsage(
      readUsageSummaryEvents(repository, 1),
    );
    assert.equal(
      Object.values(unicodeSummary.workerUsage.byInvocation)[0].invocationId,
      unicode,
    );
    assert.deepEqual(
      unicodeSummary,
      summarizeDiagnosticUsage(readAgentTimeline(repository, 1)),
    );
  });
});

test("streamed summary deliberately preserves malformed, truncated and private-file failures", () => {
  fixture(({ path, progress, harness }) => {
    for (const file of [path, progress]) {
      chmodSync(file, 0o644);
      assert.throws(
        () => readUsageSummaryEvents(repository, 1),
        /restricted regular/,
      );
      chmodSync(file, 0o600);
    }
    appendFileSync(progress, '{"operation":"command","detail":invalid}\n');
    assert.throws(() => readUsageSummaryEvents(repository, 1), SyntaxError);
    assert.throws(() => readAgentTimeline(repository, 1), SyntaxError);
    writeFileSync(progress, "not-json-without-newline", { mode: 0o600 });
    assert.doesNotThrow(() => readUsageSummaryEvents(repository, 1));
    rmSync(progress);
    symlinkSync(path, progress);
    assert.throws(() => readUsageSummaryEvents(repository, 1), /ELOOP/);
    rmSync(progress);
    mkdirSync(progress, { mode: 0o700 });
    assert.throws(
      () => readUsageSummaryEvents(repository, 1),
      /restricted regular/,
    );
    rmSync(progress, { recursive: true });
    writeFileSync(progress, "\n", { mode: 0o600 });
    appendFileSync(path, "invalid-controller-record\n");
    assert.throws(() => readUsageSummaryEvents(repository, 1), SyntaxError);
    assert.ok(harness);
  });
});

test("large transcript parity and isolated retained-memory behavior", () => {
  fixture(({ path, progress }) => {
    const expected = summarizeDiagnosticUsage(
      readUsageSummaryEvents(repository, 1),
    );
    // UTF-8 records span read chunks; one large record spans multiple chunks.
    const detail = "public synthetic 🧪 transcript ".repeat(2200);
    const line =
      JSON.stringify({ at: "2026-01-02", operation: "command", detail }) + "\n";
    const count = 800;
    for (let i = 0; i < count; i++) appendFileSync(progress, line);
    appendFileSync(
      path,
      JSON.stringify({ operation: "validation-output", detail }) + "\n",
    );
    const module = new URL("../dist/diagnostics.js", import.meta.url).href;
    const probes = {};
    for (const reader of ["readAgentTimeline", "readUsageSummaryEvents"]) {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          "--input-type=module",
          "-e",
          `
        import { ${reader} as read, summarizeDiagnosticUsage } from ${JSON.stringify(module)};
        global.gc(); const before = process.memoryUsage().heapUsed;
        const events = read(${JSON.stringify(repository)}, 1);
        global.gc(); const retained = process.memoryUsage().heapUsed - before;
        console.log(JSON.stringify({ retained, records: events.length,
          maxRssKiB: process.resourceUsage().maxRSS, summary: summarizeDiagnosticUsage(events) }));
      `,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      probes[reader] = JSON.parse(child.stdout);
      assert.deepEqual(probes[reader].summary, expected);
    }
    const textBytes = Buffer.byteLength(line) * count;
    assert.ok(probes.readAgentTimeline.retained > textBytes / 2);
    assert.ok(probes.readUsageSummaryEvents.retained < textBytes / 4);
    assert.equal(probes.readUsageSummaryEvents.records, 5);
    console.log(
      JSON.stringify({
        textBytes,
        probes: Object.fromEntries(
          Object.entries(probes).map(
            ([name, { summary: _summary, ...measurements }]) => [
              name,
              measurements,
            ],
          ),
        ),
      }),
    );
  });
});
