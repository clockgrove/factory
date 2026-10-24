// The operator's commands against the real service: answers, deadlines,
// pause/drain/resume, option checks, the run log, run, status and reset.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLI,
  children,
  cli,
  closedPort,
  configured,
  installation,
  item,
  offered,
  REPO,
  refusal,
  retirement,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("an answer or retry bound to a question that changed is refused", async () => {
  const inst = installation();
  seed(inst, 51);
  const service = serve(inst);
  await until(() => stateOf(inst, 51).holds.length, "hold");
  const first = stateOf(inst, 51).holds[0].id;
  const unbound = cli(inst, "retry", "51");
  assert.equal(unbound.code, 1);
  assert.equal(refusal(unbound), "question_required");
  assert.ok(unbound.err.includes(first), "the refusal names the question");
  assert.equal(refusal(cli(inst, "answer", "51", "retry")), "usage");
  assert.equal(cli(inst, "retry", "51", "--question", first).code, 0);
  await until(
    () =>
      stateOf(inst, 51).holds.length && stateOf(inst, 51).holds[0].id !== first,
    "the next question",
  );
  // A delayed answer to the first question never answers the second.
  for (const late of [
    cli(inst, "answer", "51", "retry", "--question", first),
    cli(inst, "retry", "51", "--question", first),
  ]) {
    assert.equal(late.code, 1);
    assert.equal(refusal(late), "stale_question");
  }
  assert.notEqual(stateOf(inst, 51).holds[0].id, first);
  assert.equal(status(inst).objectives[0].status, "holding");
  await stopped(service);
});

test("the deadline cancels an Objective whatever it waits on, shows in status and in a late question", async () => {
  const inst = installation();
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  seed(inst, 61, "checking", { deadline: soon });
  // Paused and held: neither stops the clock.
  seed(inst, 62, "checking", {
    deadline: new Date(Date.now() + 1500).toISOString(),
    control: { mode: "paused", by: "octo", at: new Date().toISOString() },
  });
  const service = serve(inst);
  await until(() => stateOf(inst, 61).holds.length, "#61's question");
  assert.match(
    stateOf(inst, 61).holds[0].question,
    /deadline is .*min from now/,
  );
  const row = status(inst).objectives.find((each) => each.issue === 61);
  assert.equal(row.deadline.at, soon);
  assert.ok(row.deadline.leftSeconds > 0 && row.deadline.leftSeconds <= 1800);
  assert.match(cli(inst, "status", "61").out, /Deadline: .* \(\d+ min left\)/);
  await until(
    () => stateOf(inst, 62).done["cancel:cleanup"] === true,
    "#62 cancelled at its deadline and cleaned up",
  );
  assert.equal(stateOf(inst, 62).ended.by, "deadline");
  const ended = status(inst).objectives.find((each) => each.issue === 62);
  assert.equal(ended.endedBy, "deadline");
  assert.equal(ended.deadline, undefined);
  assert.match(ended.nextAction.reason, /cancelled at its deadline/);
  assert.equal(stateOf(inst, 61).status, "holding");
  await stopped(service);
});

for (const point of [
  "engine:deadline:before-cancel",
  "engine:deadline:cancelled",
])
  test(`crash at ${point}, restart, cancel once at the deadline`, async () => {
    const inst = installation();
    seed(inst, 63, "checking", {
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    const death = await serve(inst, point).exit;
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    const service = serve(inst);
    await until(
      () => stateOf(inst, 63).done["cancel:cleanup"] === true,
      "cleanup after restart",
    );
    await stopped(service);
    const state = stateOf(inst, 63);
    assert.equal(state.status, "cancelled");
    assert.equal(state.ended.by, "deadline");
  });

test("pause, drain and resume, per Objective and for the queue, survive restarts", async () => {
  const inst = installation();
  seed(inst, 52);
  seed(inst, 53);
  // Sent while the service is stopped: it applies before any step starts.
  cli(inst, "pause", "52");
  cli(inst, "queue", "pause");
  let service = serve(inst);
  await until(
    () =>
      stateOf(inst, 52).control?.mode === "paused" &&
      status(inst).queue.mode === "paused",
    "paused",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    stateOf(inst, 52).holds.length,
    0,
    "a paused Objective starts nothing",
  );
  assert.equal(
    stateOf(inst, 53).holds.length,
    0,
    "a paused queue starts nothing",
  );
  const [row52, row53] = status(inst).objectives;
  assert.equal(row52.mode, "paused");
  assert.equal(row52.nextAction.command, "factory resume 52");
  assert.equal(row53.nextAction.command, "factory queue resume");
  assert.match(cli(inst, "status").out, /#52: checking \(paused\)/);
  service.child.kill("SIGKILL");
  await service.exit;

  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    stateOf(inst, 52).holds.length,
    0,
    "the pause survives a restart",
  );
  assert.equal(
    stateOf(inst, 53).holds.length,
    0,
    "the queue pause survives too",
  );
  assert.equal(cli(inst, "queue", "drain").code, 0);
  // A draining queue admits nothing new, but admitted Objectives run on.
  await until(() => stateOf(inst, 53).holds.length, "#53 runs under a drain");
  assert.equal(stateOf(inst, 52).holds.length, 0, "#52 is still paused");
  assert.equal(cli(inst, "drain", "52").code, 0);
  assert.equal(stateOf(inst, 52).control.mode, "draining");
  // Draining stops only new Work Items: the check still runs.
  await until(
    () => stateOf(inst, 52).holds.length,
    "#52 runs its check under a drain",
  );
  assert.equal(cli(inst, "resume", "52").code, 0);
  assert.equal(stateOf(inst, 52).control, undefined);
  assert.equal(cli(inst, "queue", "resume").code, 0);
  assert.equal(status(inst).queue.mode, "running");
  await stopped(service);
});

test("unknown and misplaced options are refused with the fix", () => {
  const inst = installation();
  const cases = [
    [
      ["status", "--objective", "5"],
      /factory status takes the issue as an argument/,
    ],
    [
      ["cancel", "5", "--json"],
      /--json belongs to factory setup, status, log, diagnostics, export-captures, watch, queue/,
    ],
    [
      ["status", "--bogus"],
      /Unknown option --bogus for factory status; see factory help/,
    ],
    [["frobnicate"], /Unknown command: frobnicate; see factory help/],
    [["answer", "5", "retry", "--question"], /--question needs a value/],
    [["cancel", "5", "6"], /factory cancel takes ISSUE; unexpected 6/],
    [["log", "5", "--tail", "x"], /--tail takes a whole number/],
  ];
  for (const [args, message] of cases) {
    const result = cli(inst, ...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(refusal(result), "usage");
    assert.match(result.err, message);
  }
  const help = cli(inst, "help");
  assert.equal(help.code, 0);
  for (const args of [[], ["--help"], ["status", "--help"], ["-h"]]) {
    const shown = spawnSync(process.execPath, [CLI, ...args], {
      env: inst.env,
      encoding: "utf8",
    });
    assert.equal(shown.status, 0, args.join(" "));
    assert.equal(shown.stdout, help.out);
  }
  // Options may come before the command, values included.
  const leading = spawnSync(
    process.execPath,
    [CLI, "--repo", REPO, "status", "--json"],
    { env: inst.env, encoding: "utf8" },
  );
  assert.equal(leading.status, 0, leading.stderr);
  assert.equal(JSON.parse(leading.stdout).service, "stopped");
  for (const command of [
    "serve",
    "run",
    "status",
    "log",
    "diagnostics",
    "watch",
    "answer",
    "retry",
    "cancel",
    "reset",
    "pause",
    "drain",
    "resume",
    "queue list|pause|resume|drain",
  ])
    assert.match(
      help.out,
      new RegExp(`\\n  ${command.replace(/\|/g, "\\|")}\\b`),
    );
});

test("the run log: tail, follow, and status reads its end", async () => {
  const inst = installation();
  seed(inst, 54);
  const service = serve(inst);
  await until(() => stateOf(inst, 54).holds.length, "hold");
  const lines = cli(inst, "log", "54", "--tail", "2", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].at <= lines[1].at);
  assert.ok(status(inst).objectives[0].lastEvent.event);
  const follow = spawn(
    process.execPath,
    [CLI, "log", "54", "--tail", "0", "--follow", "--json", "--repo", REPO],
    { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(follow);
  let out = "";
  follow.stdout.on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(cli(inst, "cancel", "54").code, 0);
  await until(() => /"event":"cancelled"/.test(out), "the cancel, followed");
  follow.kill("SIGINT");
  // watch: the rows from the log, then a worker's activity as it lands,
  // redacted (a worker's event, appended as an adapter's ActivityLog would).
  const watching = spawn(
    process.execPath,
    [CLI, "watch", "54", "--repo", REPO],
    {
      env: inst.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(watching);
  let view = "";
  watching.stdout.on("data", (chunk) => {
    view += chunk;
  });
  await until(
    () => /#54 - \S+(?: #\d+)? (hold|cancelled|done)/.test(view),
    "the rows",
  );
  const run = readdirSync(join(inst.logs, "54")).sort().at(-1);
  // Item a's validation failed 3 minutes ago; b's worker went quiet 20
  // minutes ago without reporting its context.
  const ago = (minutes) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  appendFileSync(
    join(inst.logs, "54", run),
    [
      {
        at: ago(3),
        step: "item:a:work",
        event: "validation-result",
        index: 0,
        command: "npm test",
        passed: false,
      },
      {
        at: new Date().toISOString(),
        step: "item:a:work",
        event: "worker-activity",
        item: "a",
        counts: {
          toolsStarted: 2,
          toolsFinished: 1,
          edits: 1,
          commands: 1,
          turns: 3,
          compactions: 2,
        },
        tools: ["Bash"],
        paths: ["src/a.ts"],
        command: "npm test ghp_abcdefghijklmnop",
        context: { tokens: 84_000, window: 272_000 },
      },
      {
        at: ago(20),
        step: "item:b:work",
        event: "worker-activity",
        item: "b",
        counts: { turns: 1 },
        tools: [],
        paths: [],
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  await until(() => /#54 a work running .*3 turns/.test(view), "the activity");
  await until(() => /#54 b work running/.test(view), "the quiet worker");
  assert.match(
    view,
    /2 tools \(Bash\) · 1 edits \(src\/a\.ts\) · \$ npm test \[REDACTED\] · context 84K\/272K \(31%\) · 2 compactions · validation failing for 3m/,
  );
  assert.match(
    view,
    /#54 b work running .*1 turns · context and compactions unknown · no progress for 20m/,
  );
  watching.kill("SIGINT");
  assert.equal(refusal(cli(inst, "log", "77")), "no_factory_state");
  // diagnostics: a repaired step and a model call, as the engine and an
  // adapter write them, then each mode; every mode is redacted.
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  appendFileSync(
    join(inst.logs, "54", run),
    [
      { at: at(1), step: "item:a:review", event: "start" },
      {
        at: at(2),
        step: "item:a:review",
        event: "model-usage",
        role: "reviewer",
        phase: "result-review",
        provider: "codex",
        model: "m1",
        outcome: "done",
        ms: 4000,
        tokens: {
          input: 100,
          output: 20,
          cached: 50,
          reasoning: 5,
          total: 120,
        },
        costUsd: null,
        error: "sk-abcdefghijklmnop",
        capture: "c1",
        callId: "call-1",
        reportedModel: "m1-2026",
        requestBytes: 300,
        promptComponents: { prompt: 200, schema: 100 },
        promptDigest: "p1",
        nativeTools: { rounds: 2, outputs: 3, failures: 1, ms: 50 },
        sessionMode: "fresh",
        sessionTurn: 1,
      },
      {
        at: at(3),
        step: "item:a:review",
        event: "model-refused",
        callId: "call-1",
        stage: "semantic",
        reason: "criterion 0 has no verdict",
      },
      {
        at: at(3000),
        step: "item:a:review",
        event: "outcome",
        outcome: "repair",
        target: "item:a:work",
        finding: "the test fails",
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  const captures = join(inst.logs, "54", `${run.split(".")[0]}.captures`);
  mkdirSync(captures, { recursive: true });
  writeFileSync(
    join(captures, "c1.json"),
    JSON.stringify({
      id: "c1",
      request: "review ghp_abcdefghijklmnop",
      response: "refused",
      truncated: false,
    }),
  );
  const timeline = cli(inst, "diagnostics", "54");
  assert.equal(timeline.code, 0, timeline.err);
  assert.match(timeline.out, /^Run \S+ · started /);
  assert.match(timeline.out, /\+\d\d:\d\d {2}\S+ asks/);
  assert.match(
    timeline.out,
    /model reviewer result-review codex m1 · done · 4 s · 120 tokens \(50 cached\) · \[REDACTED\]/,
  );
  assert.match(
    timeline.out,
    /item:a:review repair of item:a:work after 3 s: the test fails/,
  );
  assert.match(timeline.out, /activity a: 3 turns .* still running/);
  assert.doesNotMatch(timeline.out, /ghp_|sk-a/);
  const entries = cli(inst, "diagnostics", "54", "--logs", "a", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(entries.length >= 4);
  assert.match(
    cli(inst, "diagnostics", "54", "--logs", "a", "--show-captures").out,
    /capture: \S+c1\.json\n {8}request:\nreview \[REDACTED\]\n {8}response:\nrefused\n/,
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--logs", "b").out,
    /No captured model calls for b: .*capture\.enabled/,
  );
  assert.ok(
    entries.every(
      (entry) => entry.item === "a" && entry.run === run.split(".")[0],
    ),
  );
  const summary = JSON.parse(
    cli(inst, "diagnostics", "54", "--summary", "--json", "--all-runs").out,
  );
  assert.equal(summary.roles.reviewer.calls, 1);
  assert.equal(summary.phases["result-review"].tokens.total, 120);
  assert.equal(summary.phases.review.steps, 1);
  assert.equal(summary.repairs.a, 1);
  assert.ok(summary.holds.length >= 1);
  assert.ok(summary.criticalPath.length >= 1);
  assert.match(
    cli(inst, "diagnostics", "54", "--summary").out,
    /By role:\n {2}reviewer: 1 calls · 120 tokens/,
  );
  // --captures, --analyze and --gantt read the same log, redacted.
  const listed = JSON.parse(
    cli(inst, "diagnostics", "54", "--captures", "--json").out,
  );
  assert.deepEqual(
    listed.captures.map((row) => [row.id, row.role, row.item]),
    [["c1", "reviewer", "a"]],
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--captures", "--content", "c1").out,
    /^c1 · reviewer result-review · item a .*\nrequest:\nreview \[REDACTED\]\nresponse:\nrefused\n/,
  );
  assert.equal(
    refusal(cli(inst, "diagnostics", "54", "--captures", "--content", "c9")),
    "no_factory_state",
  );
  const analysis = JSON.parse(
    cli(inst, "diagnostics", "54", "--analyze", "--json", "--group-by", "role")
      .out,
  );
  assert.equal(analysis.groups[0].key.role, "reviewer");
  assert.equal(analysis.calls.cache.hitRate, 0.5);
  // The per-call fields and the formal history: the service's own lines
  // carry seq after a run-header naming the version; the appended ones don't.
  assert.deepEqual(analysis.calls.stages, { semantic: 1 });
  assert.equal(analysis.calls.modelMismatches, 1);
  assert.equal(analysis.calls.toolStats.failures, 1);
  assert.equal(analysis.calls.request.components.schema, 100);
  const [history] = analysis.history.runs;
  assert.equal(
    history.factoryVersion,
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
  assert.match(history.sourceDigest, /^[0-9a-f]{64}$/);
  assert.ok(history.lines > 1 && history.gaps === 0 && history.unsequenced);
  assert.equal(analysis.repairs.byItem.a, 1);
  assert.equal(analysis.phases.review.outcomes.repair, 1);
  assert.equal(
    JSON.parse(
      cli(
        inst,
        "diagnostics",
        "54",
        "--analyze",
        "--json",
        "--filter",
        "provider=claude",
      ).out,
    ).calls.usage.calls,
    0,
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--analyze").out,
    /Model calls, all:\n {2}1 calls · 120 tokens[^]*cache: 50\.0% of input/,
  );
  const bars = JSON.parse(
    cli(inst, "diagnostics", "54", "--gantt", "--json").out,
  ).bars;
  const review = bars.find(
    (bar) => bar.lane === "a review" && bar.kind === "step",
  );
  assert.equal(review.outcome, "repair");
  assert.ok(review.ms >= 2000 && review.start < review.end);
  assert.match(
    cli(inst, "diagnostics", "54", "--gantt").out,
    /\n {2}a review +\|[ r]*r[ r]*\|\n {4}model calls +\|[ m]*m/,
  );
  // --scorecard: #54 against a codex-direct session, with one of #54's
  // runs rotated away, which must show, never vanish.
  const scratch = mkdtempSync(join(tmpdir(), "factory-scorecard-"));
  const stream = join(scratch, "direct.jsonl");
  writeFileSync(
    stream,
    [
      { type: "thread.started", thread_id: "t-direct" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 200,
          cached_input_tokens: 150,
          output_tokens: 40,
          reasoning_output_tokens: 0,
        },
      },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(""),
    { mode: 0o600 },
  );
  writeFileSync(
    join(inst.logs, "54", "rotated"),
    `${JSON.stringify({ run: "2000-01-01T00-00-00-000Z-1", lastAt: at(0) })}\n`,
  );
  const base =
    JSON.parse(
      readFileSync(join(inst.objectives, "finished", "54.json"), "utf8"),
    ).done.check?.base ?? "base";
  const bindings = {
    sourceDigest: "s",
    baseCommit: base,
    acceptanceReference: "a",
    environmentReference: "e",
  };
  const selection = join(scratch, "selection.json");
  const packets = [
    {
      id: "f",
      task: "task ghp_abcdefghijklmnop",
      route: "factory",
      pairId: "p",
      scope: "adopter",
      factoryObjectives: [54],
      bindings,
      // Cancelled: Factory's state says failed, and the packet must agree.
      acceptance: { outcome: "failed" },
    },
    {
      id: "d",
      task: "task ghp_abcdefghijklmnop",
      route: "codex-direct",
      pairId: "p",
      scope: "adopter",
      codexSessions: [
        {
          path: stream,
          sessionId: "t-direct",
          freshThread: true,
          freshThreadReference: "launch receipt",
          startedAt: at(0),
          endedAt: at(60_000),
          outcome: "completed",
          role: "implementation",
          cliVersion: "0.160.0",
          provider: "codex",
          model: "m1",
          reasoningEffort: "high",
          configDigest: "c",
        },
      ],
      bindings,
      acceptance: { outcome: "unfinished" },
    },
  ];
  const window = { startedAt: at(-3_600_000), endedAt: at(3_600_000) };
  writeFileSync(
    selection,
    JSON.stringify({ schemaVersion: 1, window, packets }),
  );
  const card = cli(inst, "diagnostics", "--scorecard", selection, "--json");
  assert.equal(card.code, 0, card.err);
  const scored = JSON.parse(card.out);
  assert.deepEqual(scored.runs, { available: 1, total: 2 });
  const [factoryPacket, directPacket] = scored.packets;
  assert.deepEqual(factoryPacket.factory[0].runs.rotated, [
    "2000-01-01T00-00-00-000Z-1",
  ]);
  assert.deepEqual(factoryPacket.tokens.total, {
    known: 120,
    availability: "partial",
  });
  assert.ok(factoryPacket.factory[0].holds >= 1);
  // The run's header and the appended call's prompt digest bind the packet.
  assert.deepEqual(factoryPacket.factory[0].bindings.factoryVersions, [
    JSON.parse(readFileSync("package.json", "utf8")).version,
  ]);
  assert.deepEqual(factoryPacket.factory[0].bindings.promptDigests, ["p1"]);
  assert.equal(factoryPacket.firstTryPlanning, null);
  assert.deepEqual(
    [directPacket.tokens.total, directPacket.tokens.reasoning],
    [
      { known: 240, availability: "available" },
      { known: null, availability: "unavailable" },
    ],
  );
  assert.equal(directPacket.cacheEffectiveness.hitRate, 0.75);
  assert.equal(scored.pairs[0].comparable, false);
  assert.ok(
    scored.pairs[0].reasons.includes("Factory's run log has 1 of 2 runs"),
  );
  assert.doesNotMatch(card.out, /ghp_/);
  assert.match(
    cli(inst, "diagnostics", "--scorecard", selection).out,
    /Factory: 1 of 2 runs available \(1 rotated away[^]*Pair p: not comparable/,
  );
  writeFileSync(
    selection,
    JSON.stringify({
      schemaVersion: 1,
      window,
      packets: [{ ...packets[0], factoryObjectives: [77] }],
    }),
  );
  assert.equal(
    refusal(cli(inst, "diagnostics", "--scorecard", selection)),
    "no_factory_state",
  );
  for (const wrong of [
    ["54", "--scorecard", selection],
    ["--scorecard", "selection.json"],
    ["--scorecard", selection, "--summary"],
  ])
    assert.equal(cli(inst, "diagnostics", ...wrong).code, 2, wrong);
  // export-captures: a preview sends nothing; a send to a loopback
  // collector needs the digest of that exact preview.
  const received = [];
  const collector = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"partialSuccess":{}}');
    });
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${collector.address().port}`;
  const exporting = (...args) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, "export-captures", "54", ...args, "--repo", REPO],
        {
          env: {
            ...inst.env,
            OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
            OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20s3cret-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  const preview = await exporting("--json");
  assert.equal(preview.code, 0, preview.err);
  const shown = JSON.parse(preview.out);
  assert.equal(shown.status, "preview");
  assert.equal(shown.spans, 1);
  assert.equal(shown.authorizationDigest, null);
  assert.deepEqual(shown.headerNames, ["authorization"]);
  const file = join(mkdtempSync(join(tmpdir(), "factory-export-")), "o.jsonl");
  const retained = await exporting(
    "--content",
    "retained",
    "--endpoint",
    endpoint,
    "--output",
    file,
  );
  assert.equal(retained.code, 0, retained.err);
  assert.match(retained.out, /nothing sent/);
  assert.doesNotMatch(retained.out, /s3cret/);
  const digest = /--authorize ([0-9a-f]{64})/.exec(retained.out)[1];
  const written = readFileSync(file, "utf8");
  assert.match(written, /review \[REDACTED\]/);
  assert.doesNotMatch(written, /ghp_|sk-a|s3cret/);
  assert.equal(received.length, 0, "a preview sends nothing");
  assert.equal(
    refusal(
      await exporting(
        "--content",
        "retained",
        "--send",
        "--endpoint",
        endpoint,
        "--authorize",
        "0".repeat(64),
      ),
    ),
    "export_refused",
  );
  assert.equal(
    refusal(await exporting("--endpoint", "http://collector.invalid")),
    "export_refused",
    "plain HTTP only to loopback",
  );
  assert.equal((await exporting("--send", "--endpoint", endpoint)).code, 2);
  assert.equal(received.length, 0, "no send without the preview's digest");
  // --invocation selects one call by its capture or span id; the digest binds it.
  const one = JSON.parse(
    (
      await exporting(
        "--content",
        "retained",
        "--endpoint",
        endpoint,
        "--invocation",
        "c1",
        "--json",
      )
    ).out,
  );
  assert.deepEqual(
    one.invocations.map((call) => call.capture),
    ["c1"],
  );
  assert.notEqual(one.authorizationDigest, digest);
  assert.equal(
    JSON.parse(
      (await exporting("--invocation", shown.invocations[0].spanId, "--json"))
        .out,
    ).spans,
    1,
  );
  assert.equal(
    refusal(await exporting("--invocation", "nope")),
    "export_refused",
  );
  assert.equal(
    refusal(
      await exporting(
        "--content",
        "retained",
        "--send",
        "--endpoint",
        endpoint,
        "--invocation",
        "c1",
        "--authorize",
        digest,
      ),
    ),
    "export_refused",
    "the digest binds the selection",
  );
  assert.equal(received.length, 0);
  const sent = await exporting(
    "--content",
    "retained",
    "--send",
    "--endpoint",
    endpoint,
    "--authorize",
    digest,
    "--json",
  );
  assert.equal(sent.code, 0, sent.err);
  assert.equal(JSON.parse(sent.out).status, "accepted");
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/traces");
  assert.equal(received[0].headers.authorization, "Bearer s3cret-token");
  const span = JSON.parse(received[0].body).resourceSpans[0].scopeSpans[0]
    .spans[0];
  const attributes = Object.fromEntries(
    span.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
  );
  assert.equal(attributes["factory.role"], "reviewer");
  assert.equal(attributes["factory.request"], "review [REDACTED]");
  assert.equal(attributes["factory.error"], "[REDACTED]");
  assert.doesNotMatch(sent.out, /s3cret/);
  collector.close();
  for (const wrong of [
    ["--analyze", "--gantt"],
    ["--analyze", "--group-by", "colour"],
    ["--content", "c1"],
    ["--gantt", "--follow"],
  ])
    assert.equal(cli(inst, "diagnostics", "54", ...wrong).code, 2, wrong);
  assert.equal(
    refusal(cli(inst, "diagnostics", "54", "--run", "nope")),
    "no_factory_state",
  );
  assert.equal(cli(inst, "diagnostics", "54", "--summary", "--follow").code, 2);
  const following = spawn(
    process.execPath,
    [CLI, "diagnostics", "54", "--follow", "--repo", REPO],
    { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(following);
  let followed = "";
  following.stdout.on("data", (chunk) => {
    followed += chunk;
  });
  await until(() => /repair of item:a:work/.test(followed), "the timeline");
  appendFileSync(
    join(inst.logs, "54", run),
    `${JSON.stringify({ at: at(4000), step: "item:a:work", event: "start" })}\n`,
  );
  await until(() => /item:a:work started/.test(followed), "a new line");
  following.kill("SIGINT");
  await stopped(service);
});

test("run: a request plus a follower; it exits 2 when it needs a person, 1 when cancelled or refused", async () => {
  const inst = installation();
  /** `factory run`, followed in the background; resolves with its exit and output. */
  const follow = (...args) => {
    const child = spawn(
      process.execPath,
      [CLI, "run", ...args, "--repo", REPO],
      { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const exit = new Promise((resolve) =>
      child.on("exit", (code) => resolve({ code, out, err })),
    );
    return { child, exit, out: () => out };
  };
  for (const deadline of ["soon", "0m", "2020-01-01T00:00:00Z"]) {
    const wrong = cli(inst, "run", "81", "--deadline", deadline);
    assert.equal(wrong.code, 2, deadline);
    assert.equal(refusal(wrong), "usage");
  }
  // The service isn't running: it needs a person, and the request waits.
  const waiting = cli(inst, "run", "81", "--deadline", "2h");
  assert.equal(waiting.code, 2);
  assert.match(waiting.out, /isn't running.*factory run 81 follows it/);
  const [sent] = readdirSync(inst.requests).filter((n) => n.endsWith(".json"));
  const { request } = JSON.parse(
    readFileSync(join(inst.requests, sent), "utf8"),
  );
  assert.equal(request.kind, "run");
  assert.ok(Date.parse(request.deadline) > Date.now() + 119 * 60_000);
  seed(inst, 82);
  seed(inst, 83, "checking", {
    control: { mode: "paused", by: "octo", at: new Date().toISOString() },
  });
  const service = serve(inst);
  // Without configuration there is no queue to run #81 from.
  await until(
    () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
    "the waiting request answered",
  );
  // A deadline that passed before the admission is refused, not frozen.
  writeFileSync(
    join(inst.requests, "late-run.json"),
    JSON.stringify({
      id: "late-run",
      at: new Date().toISOString(),
      by: "octo",
      request: { kind: "run", issue: 81, deadline: new Date(0).toISOString() },
    }),
  );
  await until(
    () => existsSync(join(inst.requests, "late-run.result")),
    "the late run's result",
  );
  assert.equal(
    JSON.parse(readFileSync(join(inst.requests, "late-run.result"), "utf8"))
      .code,
    "deadline_passed",
  );
  const refused = cli(inst, "run", "81");
  assert.equal(refused.code, 1);
  assert.equal(refusal(refused), "no_configuration");
  // Running already: it follows, with no second admission, until its
  // question needs a person.
  const held = await follow("82").exit;
  assert.equal(held.code, 2, held.err);
  assert.match(held.out, /Next: factory answer 82 retry --question \S+/);
  assert.equal(stateOf(inst, 82).appliedRequests.length, 0);
  // Ctrl-C stops the following only.
  const paused = follow("83");
  await until(() => /following it/.test(paused.out()), "following #83");
  paused.child.kill("SIGINT");
  const interrupted = await paused.exit;
  assert.equal(interrupted.code, 130);
  assert.equal(stateOf(inst, 83).status, "checking");
  // Cancelled while followed: exit 1.
  const cancelled = follow("83");
  await until(() => /following it/.test(cancelled.out()), "following again");
  assert.equal(cli(inst, "cancel", "83").code, 0);
  const ended = await cancelled.exit;
  assert.equal(ended.code, 1, ended.err);
  assert.match(ended.out, /#83: cancelled/);
  // A paused queue admits nothing new, but a running Objective still follows.
  assert.equal(cli(inst, "queue", "pause").code, 0);
  const closed = cli(inst, "run", "84");
  assert.equal(closed.code, 1);
  assert.equal(refusal(closed), "queue_not_running");
  assert.equal((await follow("82").exit).code, 2);
  await stopped(service);
});

test("status: one model, the Work Item table, the full --json and the list view", () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1", { MY_TOKEN: "s3cret-value-123" });
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.policy = { allowedSecretNames: ["MY_TOKEN"] };
  config.autonomy = { allowances: { implementationRepairs: 5 } };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  seed(inst, 55, "holding", {
    done: {
      check: {},
      plan: {
        items: [item("a"), item("b", { kind: "aggregate" })],
        coverage: [
          {
            source: {
              path: "OBJECTIVE",
              text: "Audit is clean",
              command: "npm run audit",
            },
            itemId: "a",
            proof: { kind: "final-review" },
          },
        ],
      },
      "item:a:validate": { tree: "t1" },
      "item:a:publish": { pr: 12, head: "h1", merged: false },
    },
    holds: [
      {
        id: "q1",
        step: "item:b:merge",
        item: "b",
        question: "Which way?",
        options: offered("retry", "cancel"),
        cause: "question",
        askedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    kept: {
      "item:a:flaky": { tree: "t1", command: "npm test" },
      "allowances:rereviews": 1,
      "allowances:granted": { "perPath:item:a:work": 3, resultRereviews: 1 },
      // Retirements count only against the plan accepted now.
      "plan:acceptedAt": "2026-01-01T00:00:00.000Z",
      "final:retired": [
        retirement("npm run audit", "covered by CI"),
        retirement("npm run stale", "from an earlier plan", "2025-12-01"),
      ],
    },
    repairs: { "item:a:work": { count: 4, findings: ["refused"] } },
    modules: {
      github: {
        itemId: "PVTI_55",
        commentsSince: "2026-01-01T00:00:00.000Z",
        tracking: { items: { a: { issue: 101, id: 9101, body: "h" } } },
      },
    },
    retries: {
      build: {
        count: 0,
        attempts: 1,
        since: "2026-01-01T00:00:00.000Z",
        nextAt: "2026-01-01T00:30:00.000Z",
        lastError: "push failed: token s3cret-value-123 refused",
      },
    },
  });
  // Finished two days ago: the list view hides it, --all and ISSUE show it.
  seed(inst, 56, "done", {
    ended: { at: new Date(Date.now() - 48 * 3600_000).toISOString() },
  });
  inst.env.FACTORY_DISPLAY_TIMEZONE = "Asia/Tokyo";
  const text = cli(inst, "status").out;
  assert.match(
    text,
    /#55: building, a question open\n {2}Next: factory answer 55 retry --question q1\n/,
  );
  assert.match(
    text,
    / {4}ID +KIND +PHASE +PR +REPAIRS +HOLD\n {4}a +work +published +#12 +4 +-\n {4}b +aggregate +merge \(held\) +- +0 +q1\n/,
  );
  assert.match(
    text,
    /Question q1 \(Work Item b\): Which way\?\n {4}retry \(recommended\)/,
  );
  assert.doesNotMatch(text, /#56/);
  assert.match(text, /1 Objective finished more than 24 h ago/);
  assert.match(cli(inst, "status", "--all").out, /#56: done/);
  assert.match(cli(inst, "status", "56").out, /#56: done/);
  assert.match(text, /retries at 2026-01-01 09:30:00 GMT\+9/);
  assert.match(text, /Possibly flaky: a: `npm test` failed once/);
  assert.match(
    text,
    /Retired: command `npm run audit` \(final validation\): retired by kirk at 2026-01-01 09:00:00 GMT\+9: covered by CI\. Judged by review instead: Audit is clean\n/,
  );
  assert.doesNotMatch(text, /npm run stale/);
  assert.match(
    text,
    /Allowances: planning revisions 0\/4, implementation repairs 4\/5, result rereviews 1\/2; repairs per path: item:a:work 4\/6/,
  );
  assert.match(
    text,
    /Provider: codex \(selectedBy: defaultProvider\); configuration [0-9a-f]{12}/,
  );
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /\[REDACTED\]/);
  const json = cli(inst, "status", "--json").out;
  assert.doesNotMatch(json, /s3cret/);
  const [row, old] = JSON.parse(json).objectives;
  assert.equal(old.issue, 56, "--json is the full model");
  assert.deepEqual(
    row.plan.items.map((each) => each.id),
    ["a", "b"],
  );
  assert.deepEqual(
    row.items.map(({ id, kind, phase, pr, repairs, hold }) => ({
      id,
      kind,
      phase,
      pr,
      repairs,
      hold,
    })),
    [
      {
        id: "a",
        kind: "work",
        phase: "published",
        pr: 12,
        repairs: 4,
        hold: null,
      },
      {
        id: "b",
        kind: "aggregate",
        phase: "merge (held)",
        pr: null,
        repairs: 0,
        hold: "q1",
      },
    ],
  );
  assert.equal(
    row.waiting[0].nextAt,
    "2026-01-01T00:30:00.000Z",
    "JSON stays ISO",
  );
  assert.deepEqual(row.flakyRerun, [{ item: "a", command: "npm test" }]);
  assert.deepEqual(
    row.plan.retired.map((entry) => entry.command),
    ["npm run audit"],
  );
  assert.deepEqual(row.allowances, {
    planningRevisions: { used: 0, allowed: 4 },
    implementationRepairs: { used: 4, allowed: 5 },
    resultRereviews: { used: 1, allowed: 2 },
    perPath: { "item:a:work": { used: 4, allowed: 6 } },
  });
  assert.equal(row.frozen.provider, "codex");
  assert.equal(row.frozen.selectedBy, "defaultProvider");
  assert.match(row.frozen.digest, /^[0-9a-f]{64}$/);
  inst.env.FACTORY_DISPLAY_TIMEZONE = "UTC";
  assert.match(cli(inst, "status").out, /retries at 2026-01-01 00:30:00 UTC/);
  // --issue: an Objective or a Work Item issue, from local state only (the
  // API is a closed port).
  const byItem = cli(inst, "status", "--issue", "101");
  assert.equal(byItem.code, 0, byItem.err);
  assert.match(byItem.out, /^Issue #101 is Work Item a of Objective #55\.\n/);
  assert.match(byItem.out, /#55: building/);
  assert.doesNotMatch(byItem.out, /#56/);
  assert.deepEqual(
    JSON.parse(
      cli(
        inst,
        "status",
        "--json",
        "--issue",
        `https://github.com/${REPO}/issues/101`,
      ).out,
    ).focus,
    { issue: 101, objective: 55, item: "a" },
  );
  assert.match(
    cli(inst, "status", "--issue", "56").out,
    /^Issue #56 is the Objective\.\n[^]*#56: done/,
  );
  assert.equal(
    refusal(cli(inst, "status", "--issue", "102")),
    "no_factory_state",
  );
  assert.equal(refusal(cli(inst, "status", "55", "--issue", "101")), "usage");
});

// A reset saves a resetting record at once (the old state kept inside it),
// and its one step, `rebuild`, reads GitHub. A crash at any point reruns the
// rebuild, which only reads; with GitHub down it waits like any step;
// cancel (either form) replaces it, and its request is answered
// `superseded`. Creating an Objective is an admission: refused while the
// queue isn't running.
for (const point of ["reset:recorded", "engine:rebuild:started"])
  test(`crash at ${point}, restart, the rebuild waits while GitHub is down, cancel replaces it`, async () => {
    const inst = installation();
    configured(inst, `http://127.0.0.1:${await closedPort()}`);
    const control = { mode: "paused", by: "op", at: new Date().toISOString() };
    seed(inst, 56, "building", {
      control,
      done: { check: {}, plan: { items: [] } },
    });
    const before = stateOf(inst, 56);
    // Sent while stopped: the reset applies before any step of #56 starts.
    assert.match(cli(inst, "reset", "56").out, /isn't running/);
    const crashing = serve(inst, point);
    const death = await crashing.exit;
    assert.equal(death.signal, "SIGKILL", death.stderr);
    const recorded = stateOf(inst, 56);
    assert.equal(recorded.status, "resetting");
    assert.deepEqual(recorded.control, control, "the pause carries over");
    assert.deepEqual(recorded.kept.reset.old.done, before.done);

    const service = serve(inst);
    await until(
      () => stateOf(inst, 56).retries.rebuild?.attempts >= 1,
      "the rebuild waits on GitHub after the restart",
    );
    const [row] = status(inst).objectives;
    assert.equal(row.status, "resetting");
    assert.ok(row.reset, "status shows the reset");
    assert.match(row.waiting[0].lastError, /GitHub/);
    const pending = readdirSync(inst.requests).filter((n) =>
      n.endsWith(".json"),
    );
    assert.equal(pending.length, 1, "the reset is answered when it lands");
    // A second reset is refused while this one rebuilds, and a control
    // sent meanwhile applies to the live record (the rebuild carries the
    // live record's controls over when it lands).
    const again = cli(inst, "reset", "56");
    assert.equal(again.code, 1);
    assert.equal(refusal(again), "reset_in_progress");
    assert.equal(cli(inst, "drain", "56").code, 0);
    assert.equal(stateOf(inst, 56).control.mode, "draining");
    // Creating an Objective is an admission: not while the queue drains.
    assert.equal(cli(inst, "queue", "drain").code, 0);
    assert.equal(refusal(cli(inst, "reset", "77")), "queue_not_running");
    // The question's own `cancel` answer replaces the reset.
    assert.equal(
      cli(inst, "answer", "56", "cancel", "--question", "any").code,
      0,
    );
    await until(() => stateOf(inst, 56).status === "cancelled", "cancelled");
    await until(
      () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
      "no request left",
    );
    const reset = pending[0].replace(/\.json$/, "");
    assert.equal(
      stateOf(inst, 56).appliedRequests.find((r) => r.id === reset)?.code,
      "superseded",
    );
    assert.equal(status(inst).objectives[0].reset, undefined);
    await stopped(service);
  });
