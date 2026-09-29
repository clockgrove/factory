import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseAnalysisOptions,
  runAnalysisCommand,
  writeAnalysisReport,
} from "../dist/analysis-cli.js";
import { readInteractionContent } from "../dist/capture.js";
import { diagnosticPath } from "../dist/diagnostics.js";
import { stateRoot } from "../dist/config.js";

test("analysis option parsing is exact and rejects ambiguous duplicate filters", () => {
  assert.deepEqual(
    parseAnalysisOptions([
      "--objective",
      "12",
      "--group-by",
      "phase",
      "--group-by",
      "model",
      "--filter",
      "phase=result-review",
      "--json",
    ]),
    {
      filters: { phase: "result-review" },
      groupBy: ["phase", "model"],
      json: true,
    },
  );
  assert.throws(
    () => parseAnalysisOptions(["--filter", "phase=a", "--filter", "phase=b"]),
    /Duplicate analysis filter/,
  );
  assert.throws(
    () => parseAnalysisOptions(["--content"]),
    /Unknown analyze option/,
  );
  assert.throws(
    () => parseAnalysisOptions(["--group-by", "--json"]),
    /requires a value/,
  );
});

test("report files are private, exclusive and stay outside the target even through a symlink", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-analysis-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const output = join(root, "report.json");
  writeAnalysisReport(output, checkout, "private report\n");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(output, "utf8"), "private report\n");
  assert.throws(
    () => writeAnalysisReport(output, checkout, "replacement"),
    /EEXIST/,
  );
  assert.throws(
    () => writeAnalysisReport(join(checkout, "report"), checkout, "private"),
    /outside the target/,
  );
  const link = join(root, "alias");
  symlinkSync(checkout, link);
  assert.throws(
    () => writeAnalysisReport(join(link, "report"), checkout, "private"),
    /symlink/,
  );
  assert.throws(
    () => writeAnalysisReport("relative.json", checkout, "private"),
    /absolute/,
  );
});

test("local analysis reads metadata and recorded validation without opening a captured transcript", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-analysis-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  t.after(() => {
    if (old === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = old;
  });
  const repository = "example/analysis-target",
    objective = 12;
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const invocationId = "11111111-1111-4111-8111-111111111111";
  const capture = {
    schemaVersion: 1,
    recordId: "record-one",
    at: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    repository,
    objective,
    invocationId,
    providerAttempt: 1,
    phase: "compile",
    kind: "request",
    factoryVersion: "synthetic",
    adapter: "synthetic",
    configured: { provider: "example", model: "example" },
    coverage: "boundary",
    content: {
      status: "captured",
      redacted: true,
      truncated: true,
      reference: { invocationId, providerAttempt: 1, recordId: "record-one" },
    },
  };
  const path = diagnosticPath(repository, objective);
  mkdirSync(join(stateRoot(repository), "objectives", String(objective)), {
    recursive: true,
    mode: 0o700,
  });
  const shared = { repository, objective, at: capture.at };
  writeFileSync(
    path,
    [
      {
        ...shared,
        eventId: "capture",
        operation: "model-capture",
        outcome: "observed",
        capture,
      },
      {
        ...shared,
        eventId: "command",
        operation: "validation-command",
        outcome: "completed",
        detail: "PRIVATE COMMAND OUTPUT",
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const contentRoot = join(stateRoot(repository), "captures");
  mkdirSync(contentRoot);
  // The capture reference intentionally resolves to an unreadable/invalid content
  // entry. Metadata-first analysis must never touch it.
  writeFileSync(
    join(
      contentRoot,
      `${createHash("sha256").update(invocationId).digest("hex")}-1.ndjson`,
    ),
    "INVALID PRIVATE TRANSCRIPT",
    { mode: 0o000 },
  );
  assert.throws(() =>
    readInteractionContent(repository, capture.content.reference),
  );
  const json = runAnalysisCommand({ repository, checkout }, objective, [
    "--objective",
    "12",
    "--json",
  ]);
  const report = JSON.parse(json);
  assert.equal(report.invocationCount, 1);
  assert.equal(report.controllerObservations.length, 1);
  assert.equal(
    report.controllerObservations[0].operation,
    "validation-command",
  );
  assert.equal(json.includes("PRIVATE"), false);
  assert.equal(report.invocations[0].observations[0].content.truncated, true);
});
