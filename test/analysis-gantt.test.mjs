import { defaultAutonomy } from "../dist/repair-policy.js";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeInteractions } from "../dist/analysis.js";
import {
  parseAnalysisOptions,
  writeAnalysisReport,
} from "../dist/analysis-cli.js";
import { renderAnalysisGantt } from "../dist/analysis-gantt.js";
import { StateDiagnostics } from "../dist/diagnostics.js";

const at = (seconds) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const capture = (id, sequence, seconds, extra = {}) => ({
  schemaVersion: 1,
  repository: "example/target",
  objective: 12,
  recordId: `${id}-${sequence}`,
  at: at(seconds),
  sequence,
  invocationId: id,
  providerAttempt: 1,
  phase: "implementation",
  kind: "request",
  runId: "run-one",
  itemId: id,
  attemptId: `attempt-${id}`,
  factoryVersion: "0.1.57",
  adapter: "synthetic",
  configured: { provider: "synthetic" },
  coverage: "boundary",
  content: { status: "capture-disabled", redacted: false, truncated: false },
  ...extra,
});
const event = (extra = {}) => ({
  eventId: "event-one",
  at: at(8),
  repository: "example/target",
  objective: 12,
  runId: "run-one",
  itemId: "one",
  attemptId: "attempt-one",
  operation: "validation-command",
  outcome: "completed",
  durationMs: 1000,
  ...extra,
});

test("SVG distinguishes scopes, complete invocation boundaries, incomplete dots and reported controller durations", () => {
  const records = [
    capture("one", 1, 0),
    capture("one", 2, 10, {
      kind: "outcome",
      outcome: { stage: "provider", status: "completed" },
    }),
    capture("two", 1, 5),
  ];
  const svg = renderAnalysisGantt(
    analyzeInteractions(records, [
      event(),
      event({
        eventId: "publication",
        operation: "github-publication",
        at: at(9),
        durationMs: undefined,
      }),
    ]),
  );
  assert.match(svg, /Item one \/ Attempt attempt-one/);
  assert.match(svg, /Item two \/ Attempt attempt-two/);
  assert.match(svg, /Provider implementation: one \/ provider attempt 1/);
  assert.match(
    svg,
    /request observed 2026-01-01T00:00:00.000Z; provider terminal observed 2026-01-01T00:00:10.000Z/,
  );
  assert.match(
    svg,
    /duration-derived start 2026-01-01T00:00:07.000Z; terminal observation 2026-01-01T00:00:08.000Z/,
  );
  assert.match(
    svg,
    /Incomplete provider interval: request 2026-01-01T00:00:05.000Z; terminal unavailable/,
  );
  assert.match(svg, /Controller github-publication/);
  assert.match(svg, /interval unavailable/);
  assert.equal((svg.match(/<circle /g) ?? []).length, 2);
  assert.match(svg, /Overlapping rows must not be added/);
  assert.equal(
    svg,
    renderAnalysisGantt(
      analyzeInteractions(records.toReversed(), [
        event({
          eventId: "publication",
          operation: "github-publication",
          at: at(9),
          durationMs: undefined,
        }),
        event(),
      ]),
    ),
  );
});

test("inverted, invalid and missing intervals stay unavailable; labels escape XML without detail content", () => {
  const report = analyzeInteractions(
    [
      capture("<&\"'", 1, 10),
      capture("<&\"'", 2, 0, {
        kind: "outcome",
        outcome: { stage: "provider", status: "failed" },
      }),
    ],
    [
      event({
        at: "invalid",
        durationMs: -1,
        operation: "<script>",
        detail: "PRIVATE CONTENT",
      }),
    ],
  );
  const svg = renderAnalysisGantt(report);
  assert.match(svg, /Incomplete provider interval/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&lt;&amp;&quot;&apos;/);
  assert.doesNotMatch(svg, /PRIVATE CONTENT|NaN|<script>/);
  assert.match(
    renderAnalysisGantt(analyzeInteractions([])),
    /No retained provider or controller observations/,
  );
});

test("Gantt options require private output and exclude JSON; scoped filters retain controller boundary", () => {
  assert.throws(() => parseAnalysisOptions(["--gantt"]), /requires --output/);
  assert.throws(
    () => parseAnalysisOptions(["--gantt", "--json", "--output", "/tmp/a.svg"]),
    /only one/,
  );
  assert.throws(
    () => parseAnalysisOptions(["--gantt", "--gantt"]),
    /Duplicate/,
  );
  assert.equal(
    parseAnalysisOptions(["--gantt", "--output", "/tmp/a.svg"]).gantt,
    true,
  );
  const report = analyzeInteractions([capture("one", 1, 0)], [event()], {
    filters: { model: "absent" },
  });
  assert.equal(report.invocations.length, 0);
  assert.match(renderAnalysisGantt(report), /Controller validation-command/);
  assert.equal(
    analyzeInteractions([], [event()], { filters: { runId: "other" } })
      .controllerObservations.length,
    0,
  );
});

test("SVG uses existing exclusive owner-only report output guards", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-gantt-test-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    const output = join(root, "report.svg");
    const svg = renderAnalysisGantt(analyzeInteractions([]));
    writeAnalysisReport(output, checkout, svg);
    assert.equal(readFileSync(output, "utf8"), svg);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeAnalysisReport(output, checkout, svg), /EEXIST/);
    assert.throws(
      () => writeAnalysisReport(join(checkout, "report.svg"), checkout, svg),
      /outside/,
    );
    assert.throws(
      () => writeAnalysisReport("relative.svg", checkout, svg),
      /absolute/,
    );
    const link = join(root, "link");
    symlinkSync(root, link);
    assert.throws(
      () => writeAnalysisReport(join(link, "symlink.svg"), checkout, svg),
      /symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("StateDiagnostics whole item duration never becomes a delayed closure operation interval", () => {
  const observations = [];
  const state = {
    repository: "example/target",
    objective: 12,
    runId: "run-one",
    autonomy: defaultAutonomy,
    graph: {
      items: [{ id: "one", dependencies: [], ownedPaths: [], resources: [] }],
    },
    issueByItemId: {},
    work: {
      one: {
        status: "done",
        attempt: "attempt-one",
        startedAt: at(0),
        completedAt: at(10),
        githubClosure: "pending",
      },
    },
  };
  const diagnostics = new StateDiagnostics(
    {
      emit: (entry) =>
        observations.push({
          repository: state.repository,
          objective: 12,
          eventId: `event-${observations.length}`,
          at: at(60),
          ...entry,
        }),
    },
    state,
    "regular",
    1,
  );
  diagnostics.observe();
  state.work.one.githubClosure = "complete";
  diagnostics.observe();
  const closure = observations.find(
    (entry) => entry.operation === "github-closure",
  );
  assert.equal(closure.durationMs, 10000);
  const svg = renderAnalysisGantt(analyzeInteractions([], [closure]));
  assert.match(
    svg,
    /operation interval unavailable; reported duration 10000 ms \(scope unavailable\)/,
  );
  assert.match(svg, /2026-01-01T00:01:00.000Z/);
  assert.doesNotMatch(svg, /duration-derived start|2026-01-01T00:00:50.000Z/);
  assert.equal((svg.match(/<circle /g) ?? []).length, 1);
});

test("elapsed axis and recorded invocation/command identities remain metadata-only", () => {
  const svg = renderAnalysisGantt(
    analyzeInteractions(
      [
        capture("one", 1, 0, {
          configured: { provider: "synthetic", model: "model<&" },
          reportedModel: "reported",
        }),
        capture("one", 2, 10, {
          kind: "outcome",
          outcome: { stage: "provider", status: "completed" },
          configured: { provider: "synthetic", model: "model<&" },
          reportedModel: "reported",
        }),
      ],
      [
        event({
          metadata: { commandIndex: 2, command: "PRIVATE COMMAND" },
          detail: "PRIVATE OUTPUT",
        }),
      ],
    ),
  );
  assert.match(
    svg,
    /adapter synthetic \/ configured model model&lt;&amp; \/ reported model reported/,
  );
  assert.match(svg, /command index 2 \(executable unavailable\)/);
  assert.match(svg, /Elapsed wall-clock seconds/);
  assert.match(svg, />0 s<.*\n/s);
  assert.match(svg, />2.5 s</);
  assert.match(svg, />10 s</);
  assert.doesNotMatch(svg, /PRIVATE COMMAND|PRIVATE OUTPUT/);
  const point = renderAnalysisGantt(
    analyzeInteractions([], [event({ durationMs: null })]),
  );
  assert.equal((point.match(/>0 s</g) ?? []).length, 1);
});
