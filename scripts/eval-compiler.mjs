#!/usr/bin/env node
// Contributor-only compiler experiment. No Objective, GitHub or worker execution.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  prepareCompilationRequest,
  validateCompiledGraph,
} from "../dist/compiler/planning.js";
import {
  renderCompilationCall,
  CodexPlanningModel,
} from "../dist/compiler/model.js";
import {
  createCodexHome,
  CODEX_PLANNING_CONFIG,
} from "../dist/codex-planning-isolation.js";
import { runCodexExec } from "../dist/codex-exec.js";
import {
  UnsettledSubprocessError,
  withProcessCancellation,
} from "../dist/process.js";
import { codexTokenUsage, tokenCategories } from "../dist/usage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(value);
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) =>
  writeFileSync(file, typeof value === "string" ? value : json(value), {
    mode: 0o600,
    flag: "wx",
  });
const git = (checkout, ...args) =>
  execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function directory(path) {
  mkdirSync(path, { mode: 0o700 });
}
function requireValue(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}
function positive(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer`);
  return n;
}
function parse(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith("--") ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Options require --name value pairs");
    const key = args[i].slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate --${key}`);
    options[key] = args[i + 1];
  }
  const allowed = {
    prepare: [
      "checkout",
      "objective",
      "base",
      "out",
      "concurrency",
      "context",
      "objective-number",
    ],
    run: ["packet", "out", "cells", "repeats", "timeout-ms", "max-calls"],
    report: ["run"],
  };
  if (!allowed[command])
    throw new Error(
      "Usage: eval-compiler.mjs prepare|run|report --name value ...",
    );
  for (const key of Object.keys(options))
    if (!allowed[command].includes(key)) throw new Error(`Unknown --${key}`);
  return { command, options };
}
function candidateBinding() {
  const files = {};
  function walk(path) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const next = join(path, item.name);
      if (item.isDirectory()) walk(next);
      else if (item.isFile() && item.name.endsWith(".js"))
        files[next.slice(root.length + 1)] = hash(readFileSync(next));
    }
  }
  walk(join(root, "dist"));
  return {
    sourceHead: git(root, "rev-parse", "HEAD"),
    trackedDiffSha256: hash(git(root, "diff", "--binary", "HEAD")),
    scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    runtimeFiles: files,
    nodeVersion: process.version,
    codexSDKVersion: readJSON(
      join(root, "node_modules/@openai/codex-sdk/package.json"),
    ).version,
  };
}
function makeRequest(manifest, body, context) {
  return prepareCompilationRequest({
    objective: manifest.objectiveNumber,
    body,
    baseSha: manifest.baseSha,
    checkout: manifest.checkout,
    ...context,
    executionBounds: { configuredConcurrency: manifest.configuredConcurrency },
  });
}
function prepare(options) {
  const checkout = resolve(requireValue(options, "checkout"));
  const baseSha = git(
    checkout,
    "rev-parse",
    "--verify",
    `${requireValue(options, "base")}^{commit}`,
  );
  const body = readFileSync(
    resolve(requireValue(options, "objective")),
    "utf8",
  );
  const context = options.context ? readJSON(resolve(options.context)) : {};
  const permitted = [
    "extraSources",
    "prerequisites",
    "localExecutables",
    "executionProfiles",
    "approvedPlaybookPin",
    "executionBounds",
  ];
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    Object.keys(context).some((key) => !permitted.includes(key))
  )
    throw new Error(`Context accepts only ${permitted.join(", ")}`);
  if (context.approvedPlaybookPin != null)
    throw new Error(
      "This small suite does not support planning-advisory body expansion; use no advisory or explicit null pin",
    );
  const manifest = {
    schemaVersion: 1,
    kind: "compiler-eval-packet",
    createdAt: new Date().toISOString(),
    checkout,
    baseSha,
    baseTree: git(checkout, "rev-parse", `${baseSha}^{tree}`),
    objectiveNumber: positive(
      options["objective-number"] ?? 1,
      "objective-number",
    ),
    configuredConcurrency: positive(
      options.concurrency ??
        context.executionBounds?.configuredConcurrency ??
        2,
      "concurrency",
    ),
    candidate: candidateBinding(),
    effects:
      "Preparation reads Git and writes this packet only; no provider calls or Objective lifecycle",
  };
  if (
    context.executionBounds &&
    JSON.stringify(context.executionBounds) !==
      JSON.stringify({ configuredConcurrency: manifest.configuredConcurrency })
  )
    throw new Error(
      "Context executionBounds must match configured concurrency exactly",
    );
  const started = performance.now();
  const request = makeRequest(manifest, body, context);
  const { call } = renderCompilationCall(request);
  manifest.preparationMs = performance.now() - started;
  const contents = {
    "objective.md": body,
    "context.json": json(context),
    "request.json": json(request),
    "prompt.txt": call.prompt,
    "schema.json": json(call.schema),
  };
  manifest.files = Object.fromEntries(
    Object.entries(contents).map(([name, content]) => [
      name,
      { sha256: hash(content), bytes: bytes(content) },
    ]),
  );
  manifest.promptSha256 = hash(call.prompt);
  manifest.schemaSha256 = hash(JSON.stringify(call.schema));
  const out = resolve(requireValue(options, "out"));
  directory(out);
  for (const [name, content] of Object.entries(contents))
    save(join(out, name), content);
  save(join(out, "manifest.json"), manifest);
  console.log(
    json({
      packet: out,
      promptBytes: bytes(call.prompt),
      schemaBytes: bytes(JSON.stringify(call.schema)),
      preparationMs: manifest.preparationMs,
      providerCalls: 0,
    }),
  );
}
function loadPacket(path) {
  const manifest = readJSON(join(path, "manifest.json"));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "compiler-eval-packet")
    throw new Error("Unsupported packet");
  for (const [name, receipt] of Object.entries(manifest.files)) {
    const value = readFileSync(join(path, name));
    if (hash(value) !== receipt.sha256 || value.length !== receipt.bytes)
      throw new Error(`Packet bytes changed: ${name}`);
  }
  if (JSON.stringify(candidateBinding()) !== JSON.stringify(manifest.candidate))
    throw new Error(
      "Compiler candidate changed since preparation; prepare a new immutable packet",
    );
  const request = readJSON(join(path, "request.json"));
  const body = readFileSync(join(path, "objective.md"), "utf8");
  const prepared = makeRequest(
    manifest,
    body,
    readJSON(join(path, "context.json")),
  );
  if (JSON.stringify(prepared) !== JSON.stringify(request))
    throw new Error("Prepared compiler request differs from pinned packet");
  const { wire, call } = renderCompilationCall(request);
  if (
    hash(call.prompt) !== manifest.promptSha256 ||
    hash(JSON.stringify(call.schema)) !== manifest.schemaSha256
  )
    throw new Error("Rendered prompt/schema changed");
  return { manifest, request, body, wire, call };
}
function cellsFrom(file) {
  const cells = readJSON(file);
  if (!Array.isArray(cells) || cells.length < 1)
    throw new Error("Cells must be a nonempty JSON array");
  const seen = new Set();
  for (const cell of cells) {
    if (
      !cell ||
      typeof cell !== "object" ||
      Object.keys(cell).some(
        (key) =>
          !["model", "reasoningEffort", "harness", "label"].includes(key),
      )
    )
      throw new Error(
        "Cells accept model, reasoningEffort, harness, optional label only",
      );
    if (
      typeof cell.model !== "string" ||
      !cell.model.trim() ||
      !["none", "minimal", "low", "medium", "high", "xhigh"].includes(
        cell.reasoningEffort,
      ) ||
      !["factory-transport", "native-cli"].includes(cell.harness)
    )
      throw new Error(
        "Each cell needs an explicit model, reasoningEffort and supported harness",
      );
    const key = JSON.stringify([
      cell.model,
      cell.reasoningEffort,
      cell.harness,
    ]);
    if (seen.has(key)) throw new Error("Duplicate configured cell");
    seen.add(key);
  }
  return cells;
}
function captureSink(file, started, observations) {
  return (kind, data, content) => {
    const row = {
      at: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      kind,
      data,
    };
    if (content) {
      try {
        row.content = content();
      } catch (error) {
        row.contentUnavailable = String(error);
      }
    }
    observations.push(row);
    appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  };
}
async function nativeCall({ checkout, call, selection, signal, turn, sink }) {
  const home = createCodexHome({ config: CODEX_PLANNING_CONFIG });
  let retainHome = false;
  let streamError;
  try {
    await runCodexExec({
      env: home.env,
      prompt: call.prompt,
      schema: call.schema,
      signal,
      options: {
        workingDirectory: checkout,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        model: selection.model,
        modelReasoningEffort: selection.reasoningEffort,
      },
      event: (event) => {
        sink("sdk-event", event);
        if (event.type === "thread.started")
          turn.providerThreadId = event.thread_id;
        if (event.type.startsWith("item.")) turn.started = true;
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        )
          turn.response = event.item.text;
        if (event.type === "turn.completed") {
          turn.ended = true;
          turn.usage = codexTokenUsage(event.usage);
        }
        if (event.type === "turn.failed") {
          turn.ended = true;
          throw new Error(event.error.message);
        }
        if (event.type === "error") streamError = new Error(event.message);
      },
    });
    turn.stopped = true;
    if (!turn.ended)
      throw (
        streamError ??
        new Error("Native call ended without completed provider turn")
      );
  } catch (error) {
    retainHome = error instanceof UnsettledSubprocessError;
    turn.stopped = !retainHome;
    throw error;
  } finally {
    if (!retainHome) {
      home.nativeCapture(turn.providerThreadId, (event, content) =>
        sink("capture", event, content),
      );
      home.dispose();
    }
  }
}
function accounting(observations, fallback) {
  const captures = observations.filter((row) => row.kind === "capture");
  const responses = new Map();
  for (const row of captures)
    if (
      row.data.kind === "usage" &&
      row.data.usage?.scope === "provider-call"
    ) {
      const key = row.data.usage.deduplicationKey;
      if (!key) continue;
      const previous = responses.get(key);
      const normalized = row.data.usage.normalized ?? {};
      if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
        throw new Error("Conflicting native usage receipts");
      responses.set(key, normalized);
    }
  const hasFallback = fallback && Object.keys(fallback).length > 0;
  const rows = responses.size
    ? [...responses.values()]
    : hasFallback
      ? [fallback]
      : [];
  const rollouts = captures
    .filter((row) => row.data.providerEvent === "codex.native-rollout-coverage")
    .map((row) => row.data.nativeRollout);
  const ownRollout = [...rollouts]
    .reverse()
    .find((row) => row && !row.inheritedHistory && !row.childHistory);
  const nativeResponsesComplete =
    responses.size > 0 &&
    ownRollout?.status === "available" &&
    ownRollout.observedCompletedResponses === responses.size &&
    ownRollout.conflictingResponseRecords === 0;
  const coverage = Object.fromEntries(
    tokenCategories.map((key) => [
      key,
      {
        availableRows: rows.filter((row) => Number.isSafeInteger(row[key]))
          .length,
        totalRows: rows.length,
        knownSubtotal: rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
      },
    ]),
  );
  const responseTotals = Object.fromEntries(
    tokenCategories.map((key) => [
      key,
      rows.length && coverage[key].availableRows === rows.length
        ? coverage[key].knownSubtotal
        : null,
    ]),
  );
  if (nativeResponsesComplete && hasFallback)
    for (const key of ["inputTokens", "outputTokens"]) {
      if (
        responseTotals[key] !== null &&
        fallback[key] !== undefined &&
        responseTotals[key] !== fallback[key]
      )
        throw new Error(
          `Native response totals disagree with cumulative exec usage: ${key}`,
        );
    }
  const usage = Object.fromEntries(
    tokenCategories.map((key) => [
      key,
      nativeResponsesComplete && responseTotals[key] !== null
        ? responseTotals[key]
        : (fallback?.[key] ?? null),
    ]),
  );
  const aligned = rows.filter(
    (row) =>
      Number.isSafeInteger(row.inputTokens) &&
      Number.isSafeInteger(row.cachedInputTokens),
  );
  const alignedInput = aligned.reduce((sum, row) => sum + row.inputTokens, 0);
  const alignedCached = aligned.reduce(
    (sum, row) => sum + row.cachedInputTokens,
    0,
  );
  return {
    source: nativeResponsesComplete
      ? "native-disjoint-provider-call-receipts-complete"
      : hasFallback
        ? "native-exec-cumulative-with-response-coverage"
        : "unavailable",
    nativeResponsesComplete,
    nativeRolloutStatus: ownRollout?.status ?? "unavailable",
    responseRows: rows.length,
    usage,
    coverage,
    inputPlusOutputTokens:
      usage.inputTokens !== null && usage.outputTokens !== null
        ? usage.inputTokens + usage.outputTokens
        : null,
    cache: {
      alignedRows: aligned.length,
      totalRows: rows.length,
      alignedInputTokens: alignedInput,
      alignedCachedInputTokens: alignedCached,
      alignedHitFraction:
        alignedInput > 0 ? alignedCached / alignedInput : null,
      inputCoverageFraction:
        usage.inputTokens > 0 ? alignedInput / usage.inputTokens : null,
    },
    observedSelection: {
      model: ownRollout?.reportedModel ?? null,
      reasoningEffort: ownRollout?.reportedReasoningEffort ?? null,
      cliVersion: ownRollout?.cliVersion ?? null,
    },
    limitations: [
      "Absent/default-zero optional native usage categories remain unknown",
      "Reasoning is an output subset; it is never added to output",
      "Provider queue time, inference CPU/GPU time and billed role split are unavailable",
      "Factory transport and native-cli use the same native inference core",
    ],
  };
}
async function run(options, cancellation) {
  const packetPath = resolve(requireValue(options, "packet"));
  const packet = loadPacket(packetPath);
  const packetManifestSha256 = hash(
    readFileSync(join(packetPath, "manifest.json")),
  );
  const cells = cellsFrom(resolve(requireValue(options, "cells")));
  const repeats = positive(options.repeats ?? 3, "repeats");
  const timeoutMs = positive(options["timeout-ms"] ?? 600000, "timeout-ms");
  const maxCalls = positive(options["max-calls"] ?? 9, "max-calls");
  if (cells.length * repeats > maxCalls)
    throw new Error(
      "Planned calls exceed --max-calls; choose a bounded matrix explicitly",
    );
  const plan = [];
  for (let repeat = 0; repeat < repeats; repeat++)
    for (let i = 0; i < cells.length; i++) {
      const cellIndex = (i + repeat) % cells.length;
      plan.push({
        ordinal: plan.length + 1,
        repeat: repeat + 1,
        cellIndex,
        ...cells[cellIndex],
      });
    }
  const out = resolve(requireValue(options, "out"));
  directory(out);
  save(join(out, "plan.json"), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    packetPath,
    packetManifestSha256,
    candidate: packet.manifest.candidate,
    promptSha256: packet.manifest.promptSha256,
    schemaSha256: packet.manifest.schemaSha256,
    timeoutMs,
    maxCalls,
    configuredCalls: plan.length,
    concurrency: 1,
    perCaseAttempts: 1,
    repair: false,
    cells,
    plan,
  });
  let halted = false;
  for (const entry of plan) {
    if (cancellation.aborted) {
      halted = true;
      break;
    }
    // Authenticate the complete frozen packet/candidate before every provider dispatch.
    if (
      hash(readFileSync(join(packetPath, "manifest.json"))) !==
      packetManifestSha256
    )
      throw new Error("Packet manifest changed during run");
    loadPacket(packetPath);
    const caseDir = join(out, String(entry.ordinal).padStart(3, "0"));
    directory(caseDir);
    const started = performance.now();
    const observations = [];
    const sink = captureSink(
      join(caseDir, "events.ndjson"),
      started,
      observations,
    );
    const turn = { response: "", ended: false };
    const invocation = {
      invocationId: randomUUID(),
      phase: "compile",
      ordinal: entry.ordinal,
      providerAttempt: 1,
      providerMaxAttempts: 1,
      observe: (row) => {
        const { capture, ...metadata } = row;
        sink("factory-observation", metadata);
        if (capture) sink("capture", capture.event, capture.content);
      },
    };
    const result = {
      schemaVersion: 1,
      ...entry,
      startedAt: new Date().toISOString(),
      configuredSelection: {
        model: entry.model,
        reasoningEffort: entry.reasoningEffort,
      },
      promptSha256: packet.manifest.promptSha256,
      schemaSha256: packet.manifest.schemaSha256,
      invocationId: invocation.invocationId,
      providerAttempts: 1,
      status: "running",
    };
    save(join(caseDir, "dispatch.json"), result);
    let transportError;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Compiler eval deadline exceeded: ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    const signal = AbortSignal.any([controller.signal, cancellation]);
    const providerStarted = performance.now();
    try {
      if (entry.harness === "factory-transport") {
        const selection = {
          model: entry.model,
          reasoningEffort: entry.reasoningEffort,
        };
        const model = new CodexPlanningModel(
          packet.manifest.checkout,
          selection,
          selection,
          timeoutMs,
        );
        await model.transport.run({
          role: "planner",
          prompt: packet.call.prompt,
          schema: packet.call.schema,
          invocation,
          turn,
          signal,
        });
      } else
        await nativeCall({
          checkout: packet.manifest.checkout,
          call: packet.call,
          selection: entry,
          signal,
          turn,
          sink,
        });
    } catch (error) {
      transportError = error;
    } finally {
      clearTimeout(timer);
    }
    result.providerElapsedMs = performance.now() - providerStarted;
    result.providerEnded = turn.ended;
    result.processSettled = turn.stopped === true;
    result.deadlineExceeded = controller.signal.aborted;
    result.interrupted = cancellation.aborted;
    if (result.interrupted)
      result.interruptionReason = String(cancellation.reason);
    save(join(caseDir, "response.txt"), turn.response);
    result.responseBytes = bytes(turn.response);
    result.responseSha256 = hash(turn.response);
    try {
      result.accounting = accounting(observations, turn.usage);
    } catch (error) {
      result.accounting = {
        source: "conflicting-receipts",
        error: String(error),
      };
      halted = true;
    }
    if (transportError || result.interrupted) {
      transportError ??= cancellation.reason;
      result.status = result.interrupted ? "cancelled" : "transport-failed";
      result.failure = {
        name: transportError.name,
        detail: String(transportError),
      };
      // Refusals/invalid output finish the transport normally; transport failures stop the run.
      halted = true;
    } else {
      const validationStarted = performance.now();
      try {
        const graph = packet.wire.decode(JSON.parse(turn.response));
        const request = { ...structuredClone(packet.request), invocation };
        validateCompiledGraph({
          graph,
          request,
          body: packet.body,
          checkout: packet.manifest.checkout,
        });
        save(join(caseDir, "graph.json"), graph);
        result.status = "compiler-valid";
        result.itemCount = graph.items.length;
        result.briefBytes = graph.items.reduce(
          (sum, item) => sum + bytes(item.brief ?? ""),
          0,
        );
        result.graphSha256 = hash(JSON.stringify(graph));
      } catch (error) {
        result.status = "compiler-invalid";
        result.failure = { name: error.name, detail: String(error) };
      }
      result.decodeAndValidationMs = performance.now() - validationStarted;
    }
    result.elapsedMs = performance.now() - started;
    result.completedAt = new Date().toISOString();
    save(join(caseDir, "result.json"), result);
    console.log(
      json({
        ordinal: entry.ordinal,
        model: entry.model,
        effort: entry.reasoningEffort,
        harness: entry.harness,
        status: result.status,
        elapsedMs: result.elapsedMs,
        settled: result.processSettled,
      }),
    );
    if (halted || !result.processSettled) {
      halted = true;
      break;
    }
  }
  save(join(out, "completion.json"), {
    completedAt: new Date().toISOString(),
    status: halted ? "halted" : "completed",
    plannedCalls: plan.length,
    observedResults: readdirSync(out).filter(
      (name) =>
        /^\d+$/.test(name) && existsSync(join(out, name, "result.json")),
    ).length,
  });
  report({ run: out });
  if (halted) process.exitCode = 1;
}
function stats(values) {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n: 0, median: null, min: null, max: null, sampleSD: null };
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  return {
    n,
    median:
      n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    min: sorted[0],
    max: sorted[n - 1],
    sampleSD:
      n > 1
        ? Math.sqrt(
            sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (n - 1),
          )
        : null,
  };
}
function report(options) {
  const path = resolve(requireValue(options, "run"));
  const plan = readJSON(join(path, "plan.json"));
  const results = readdirSync(path)
    .filter(
      (name) =>
        /^\d+$/.test(name) && existsSync(join(path, name, "result.json")),
    )
    .map((name) => readJSON(join(path, name, "result.json")));
  const groups = plan.cells.map((cell, index) => {
    const rows = results.filter((row) => row.cellIndex === index);
    const valid = rows.filter((row) => row.status === "compiler-valid");
    const metric = (source, name) => stats(source.map((row) => row[name]));
    return {
      ...cell,
      attempted: rows.length,
      planned: plan.plan.filter((row) => row.cellIndex === index).length,
      compilerValid: valid.length,
      compilerValidFraction: rows.length ? valid.length / rows.length : null,
      statuses: rows.map((row) => row.status),
      providerElapsedMsAllAttempts: metric(rows, "providerElapsedMs"),
      providerElapsedMsCompilerValid: metric(valid, "providerElapsedMs"),
      totalElapsedMsAllAttempts: metric(rows, "elapsedMs"),
      decodeAndValidationMs: metric(rows, "decodeAndValidationMs"),
      responseBytes: metric(rows, "responseBytes"),
      briefBytesCompilerValid: metric(valid, "briefBytes"),
      itemCountCompilerValid: metric(valid, "itemCount"),
      tokens: Object.fromEntries(
        tokenCategories.map((key) => [
          key,
          stats(rows.map((row) => row.accounting?.usage?.[key])),
        ]),
      ),
      inputPlusOutputTokens: stats(
        rows.map((row) => row.accounting?.inputPlusOutputTokens),
      ),
      cacheHitFractionAligned: stats(
        rows.map((row) => row.accounting?.cache?.alignedHitFraction),
      ),
      cacheInputCoverageFraction: stats(
        rows.map((row) => row.accounting?.cache?.inputCoverageFraction),
      ),
      observedSelections: rows.map(
        (row) => row.accounting?.observedSelection ?? null,
      ),
    };
  });
  const summary = {
    schemaVersion: 1,
    packetManifestSha256: plan.packetManifestSha256,
    groups,
    observedResults: results.length,
    plannedCalls: plan.configuredCalls,
    interpretation: [
      "Compiler-valid is deterministic plan validity, not delivered app acceptance or equal quality",
      "Failed attempts remain in all-attempt statistics; valid-only latency is separate",
      "Small n describes variance; no statistical significance or downstream acceleration claimed",
      "Cache warmth and service load are uncontrolled; order is rotated and serial",
      "Native-cli and Factory transport use the same Codex native core and tool-free configuration",
      "Unknown categories stay null; reasoning is not added to output",
      "Compare elapsed only alongside validity and blind semantic review",
    ],
  };
  const output = join(path, "summary.json");
  // Reports are derived from preserved case receipts; repeated reporting never overwrites them.
  writeFileSync(output, json(summary), { mode: 0o600 });
  console.log(
    json({
      summary: output,
      groups: groups.map((group) => ({
        model: group.model,
        effort: group.reasoningEffort,
        harness: group.harness,
        valid: `${group.compilerValid}/${group.attempted}`,
        providerMs: group.providerElapsedMsAllAttempts,
      })),
    }),
  );
}
try {
  const { command, options } = parse(process.argv.slice(2));
  if (command === "prepare") prepare(options);
  else if (command === "run") {
    const cancellation = new AbortController();
    const interrupt = (signal) =>
      cancellation.abort(
        Object.assign(new Error(`Compiler eval interrupted: ${signal}`), {
          signal,
        }),
      );
    const onSIGINT = () => interrupt("SIGINT");
    const onSIGTERM = () => interrupt("SIGTERM");
    process.on("SIGINT", onSIGINT);
    process.on("SIGTERM", onSIGTERM);
    try {
      await withProcessCancellation(cancellation.signal, () =>
        run(options, cancellation.signal),
      );
    } finally {
      process.off("SIGINT", onSIGINT);
      process.off("SIGTERM", onSIGTERM);
      if (cancellation.signal.aborted)
        process.exitCode =
          cancellation.signal.reason.signal === "SIGINT" ? 130 : 143;
    }
  } else report(options);
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
