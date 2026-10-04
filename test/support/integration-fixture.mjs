import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unwatchFile,
  watch,
  watchFile,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createApplication } from "../../dist/application.js";
import { resolveCapacity, stateRoot } from "../../dist/config.js";
import { LocalContentStore } from "../../dist/content/local.js";
import { RegularDelivery } from "../../dist/delivery/regular.js";
import { LocalExecutionDriver } from "../../dist/execution/local.js";
import { attachFault, decision } from "../../dist/fault.js";
import { withCoverage } from "./coverage.mjs";
import { resultFindings } from "./review-protocol.mjs";

export function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function createTarget(root, files = {}) {
  const checkout = join(root, "target");
  const origin = join(root, "origin.git");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "--initial-branch=main");
  git(checkout, "init", "-b", "main");
  git(checkout, "remote", "add", "origin", origin);
  const initial = {
    "AGENTS.md":
      "# Target rules\n\nRun the validation commands declared by the Objective.\n",
    "README.md": "# Disposable target\n",
    ...files,
  };
  for (const [path, value] of Object.entries(initial)) {
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  }
  git(checkout, "add", "-A");
  git(
    checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.com",
    "commit",
    "-m",
    "Initial target",
  );
  git(checkout, "push", "-u", "origin", "main");
  return { checkout, origin, baseSha: git(checkout, "rev-parse", "HEAD") };
}

let transportRoot;
const transportRoutes = {};

/** Give offline targets a real GitHub binding and stub only transport to that host. */
export function bindTarget(checkout, repository) {
  if (!transportRoot) {
    transportRoot = mkdtempSync(join(tmpdir(), "factory-test-transport-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const helper = resolve(import.meta.dirname, "fixture-git.mjs");
    const routesFile = join(transportRoot, "routes.json");
    const script = join(transportRoot, "git");
    writeFileSync(
      script,
      `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    push|fetch|clone|pull|checkout) exec ${quote(process.execPath)} ${quote(helper)} ${quote(realGit)} ${quote(routesFile)} "$@" ;;
  esac
done
exec ${quote(realGit)} "$@"
`,
    );
    chmodSync(script, 0o755);
    process.on("exit", () =>
      rmSync(transportRoot, { recursive: true, force: true }),
    );
  }
  if (!process.env.PATH.split(":").includes(transportRoot))
    process.env.PATH = `${transportRoot}:${process.env.PATH}`;
  const original = git(checkout, "remote", "get-url", "origin");
  const origin = transportRoutes[original] ?? original;
  const url = `https://github.com/${repository}.git`;
  transportRoutes[url] = origin;
  // Child processes read this while other tests bind targets: replace it
  // atomically so a reader never sees a partly written file.
  const routes = join(transportRoot, "routes.json");
  const temporary = `${routes}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(transportRoutes));
  renameSync(temporary, routes);
  git(checkout, "remote", "set-url", "origin", url);
}

export function factoryConfig(
  checkout,
  repository,
  delivery = "regular",
  concurrency = 2,
) {
  bindTarget(checkout, repository);
  return {
    schemaVersion: 1,
    repository,
    checkout,
    planning: {
      kind: "codex-sdk",
      planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
    execution: {
      kind: "local",
      concurrency,
      harness: {
        kind: "codex-sdk",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      },
    },
    delivery: { kind: delivery },
    contentStore: { kind: "local" },
    policy: {
      network: "off",
      allowedSecretNames: [],
      deployments: "denied",
    },
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function appendEvent(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Settle on `check` whenever `subscribe` reports a change, and once more after
 * subscribing so a change made before the watch armed is never lost. There is
 * no total-duration budget: a loaded machine only slows the wait. It fails
 * only after `stallMs` with no observed change (and a final check), which
 * means the watched run has stopped making progress.
 */
function settleOn(subscribe, check, message, stallMs) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    let unsubscribe = () => undefined;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      settle(value);
    };
    const evaluate = () => {
      try {
        const result = check();
        if (result) finish(resolvePromise, result);
        return result;
      } catch (error) {
        finish(reject, error);
        return true;
      }
    };
    const poll = () => {
      if (settled || evaluate()) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // A change can land before a stat-polling watch takes its baseline.
        if (!evaluate())
          finish(
            reject,
            new Error(`No progress for ${stallMs}ms waiting for ${message}`),
          );
      }, stallMs);
    };
    unsubscribe = subscribe(poll, (error) => finish(reject, error));
    poll();
  });
}

/** A stalled fixture shows no file activity for this long. */
export const fixtureStallMs = 60_000;

/** Wait for `check` while anything under `directories` changes. */
export async function waitFor(
  check,
  directories,
  message,
  stallMs = fixtureStallMs,
) {
  const watched = [directories].flat();
  for (const directory of watched) mkdirSync(directory, { recursive: true });
  return settleOn(
    (changed, failed) => {
      const observers = watched.map((directory) =>
        watch(directory, { recursive: true }, changed).on("error", failed),
      );
      return () => {
        for (const observer of observers) observer.close();
      };
    },
    check,
    message,
    stallMs,
  );
}

/** Wait for `check` while the file at `path` changes. */
export async function waitForFile(
  check,
  path,
  message,
  stallMs = fixtureStallMs,
) {
  mkdirSync(dirname(path), { recursive: true });
  return settleOn(
    (changed) => {
      watchFile(path, { interval: 20 }, changed);
      return () => unwatchFile(path, changed);
    },
    check,
    message,
    stallMs,
  );
}

export class ScriptedPlanningModel {
  constructor(graph, logPath, resultReviewer) {
    this.graph = graph;
    this.logPath = logPath;
    this.resultReviewer = resultReviewer;
  }

  observe(request) {
    const context = request.invocation;
    if (!context?.observe) return;
    const common = {
      invocationId: context.invocationId,
      phase: context.phase,
      ordinal: context.ordinal,
      provider: "scripted-test-provider",
      model: "scripted-test-model",
      reasoningEffort: "test",
      providerThreadId: `thread-${context.invocationId}`,
    };
    context.observe({ ...common, type: "started", promptBytes: 1 });
    context.observe({
      ...common,
      type: "progress",
      providerEvent: "turn.started",
    });
    context.observe({
      ...common,
      type: "completed",
      durationMs: 1,
      usageAvailable: true,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
    });
  }

  async generateStructured(request) {
    this.observe(request);
    appendEvent(this.logPath, {
      baseSha: request.baseSha,
      objective: request.objective,
      sources: request.sources.map((source) => source.path),
    });
    return withCoverage(request, this.graph);
  }

  async reviewGraph(request) {
    this.observe(request);
    return {
      packetId: request.reviewPacket.id,
      findings: [],
    };
  }

  async reviewResult(request) {
    this.observe(request);
    appendEvent(this.logPath, {
      type: "result-review",
      criteria: request.criteria,
      observations: request.observations
        ? JSON.parse(request.observations)
        : null,
      evidence: request.evidence ?? [],
    });
    if (this.resultReviewer) return this.resultReviewer(request);
    const source = request.sources.find((item) => item.path === "OBJECTIVE");
    return {
      packetId: request.reviewPacket.id,
      findings: resultFindings(
        request,
        request.criteria.map((criterion) => {
          const hydration = request.evidence?.find(
            (item) => item.path === "Controller hydration receipt",
          );
          if (/fresh-clone|hydrat|selected bytes/i.test(criterion) && hydration)
            return {
              criterion,
              verdict: "pass",
              source: hydration.path,
              quote: '"passed":true',
              detail:
                "The controller receipt binds successful hydration to the reviewed result",
              question: "",
            };
          if (
            /worker does not write, remove, or change the final destination/i.test(
              criterion,
            )
          ) {
            const materialization = request.evidence?.find(
              (item) =>
                item.path.startsWith("Work Item Git delta:") &&
                item.path.endsWith("controller materialization"),
            );
            const packet = materialization
              ? JSON.parse(materialization.content.split("\n")[0])
              : null;
            if (
              materialization?.complete === true &&
              packet?.authority ===
                "Factory supervisor controller materialization evidence" &&
              packet.workerDestinationChanges?.length === 0 &&
              packet.materializationChange?.changes?.length ===
                packet.destinations?.length
            )
              return {
                criterion,
                verdict: "pass",
                source: materialization.path,
                quote: '"workerDestinationChanges":[]',
                detail:
                  "Exact supervisor Git evidence separates the unchanged worker destinations from the controller-only selected-set commit",
                question: "",
              };
            return {
              criterion,
              verdict: "needs-human",
              source: "Delivery observations",
              quote: '"assetSelectionReceipt"',
              detail:
                "The review packet does not prove the worker/controller materialization boundary",
              question:
                "Did the worker leave final destinations unchanged and only Factory materialize the selected set?",
            };
          }
          if (/\.factory-assets\.json/.test(criterion)) {
            const observations = request.observations
              ? JSON.parse(request.observations)
              : null;
            const selectedSetId = observations?.assetSelectionReceipt?.setId;
            const receipt = observations?.assetCaptureReceipts?.find(
              (candidate) => candidate?.setId === selectedSetId,
            );
            if (
              receipt?.declarationPath === ".factory-assets.json" &&
              receipt.declarationDigest &&
              receipt.declarationProvenance
            )
              return {
                criterion,
                verdict: "pass",
                source: "Delivery observations",
                quote: JSON.stringify(receipt.declarationProvenance),
                detail:
                  "The controller receipt binds the selected set's manifest provenance to its parsed declaration",
                question: "",
              };
            return {
              criterion,
              verdict: "needs-human",
              source: "Delivery observations",
              quote: '"assetCaptureReceipts"',
              detail:
                "The delivery observations do not contain controller-verified manifest provenance for the selected set",
              question:
                "Was the selected set's provenance declared in the parsed manifest?",
            };
          }
          if (/byte-for-byte from the repository source/i.test(criterion)) {
            const observations = request.observations
              ? JSON.parse(request.observations)
              : null;
            const selectedSetId = observations?.assetSelectionReceipt?.setId;
            const receipt = observations?.assetCaptureReceipts?.find(
              (candidate) => candidate?.setId === selectedSetId,
            );
            const pair = receipt?.inputs
              ?.filter((candidate) => candidate.binding.kind === "repository")
              .map((input) => ({
                input,
                member: receipt.members?.find(
                  (candidate) => candidate.destination === input.binding.path,
                ),
              }))
              .find(({ member }) => member);
            const input = pair?.input;
            const member = pair?.member;
            if (
              input &&
              member &&
              input.ref.digest === member.digest &&
              input.ref.bytes === member.bytes &&
              input.ref.mediaType === member.mediaType
            )
              return {
                criterion,
                verdict: "pass",
                source: "Delivery observations",
                quote: JSON.stringify(receipt),
                detail:
                  "The controller receipt binds equal source-input and captured-member identities to the selected destination",
                question: "",
              };
            return {
              criterion,
              verdict: "needs-human",
              source: "Delivery observations",
              quote: '"assetCaptureReceipts"',
              detail:
                "The controller receipt does not prove matching imported-source and captured-member identities",
              question:
                "Were the selected member bytes copied exactly from the imported repository source?",
            };
          }
          return {
            criterion,
            verdict: "pass",
            source: "OBJECTIVE",
            quote:
              source.content
                .split("\n")
                .find((line) => line.includes("test -s"))
                ?.trim() ?? source.content.split("\n").find(Boolean),
            detail: "Scripted integration fixture confirms its declared result",
            question: "",
          };
        }),
      ),
    };
  }
}

export class ScriptedHarness {
  capabilities = {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "none",
  };

  constructor(root, actions, eventsPath) {
    this.root = resolve(root);
    this.actions = actions;
    this.eventsPath = eventsPath;
    // Factory's own progress (state, diagnostics, worktrees) lands here.
    this.stateHome = process.env.XDG_STATE_HOME;
    mkdirSync(this.root, { recursive: true });
  }

  require(handle) {
    const data = handle.data;
    if (
      !data ||
      typeof data !== "object" ||
      !resolve(data.resultPath).startsWith(`${this.root}${sep}`)
    )
      throw new Error("Unknown scripted harness handle");
    return data;
  }

  async start(request) {
    const identity = request.attemptId;
    const requestPath = join(this.root, `${identity}.request.json`);
    const resultPath = join(this.root, `${identity}.result.json`);
    const logPath = join(this.root, `${identity}.log`);
    writeJson(requestPath, {
      item: request.item.id,
      worktree: request.worktree,
      sourceAssets: request.sourceAssets,
      selectedAssets: request.selectedAssets,
    });
    writeFileSync(logPath, "scripted harness\n");
    appendEvent(this.eventsPath, {
      type: "start",
      item: request.item.id,
      attempt: identity,
      worktree: request.worktree,
      baseSha: git(request.worktree, "rev-parse", "HEAD"),
    });
    return {
      identity,
      data: {
        pid: process.pid,
        startTime: "scripted",
        requestPath,
        resultPath,
        logPath,
        worktree: request.worktree,
        item: request.item.id,
      },
    };
  }

  async observe(handle) {
    const data = this.require(handle);
    if (existsSync(`${data.resultPath}.cancelled`))
      return { state: "cancelled" };
    if (existsSync(`${data.resultPath}.failed`)) return { state: "failed" };
    // The worker ended without writing a result, like a crashed process.
    if (existsSync(`${data.resultPath}.died`))
      return { state: "failed", interrupted: true };
    if (existsSync(data.resultPath)) return { state: "complete" };
    return { state: "running" };
  }

  async cancel(handle) {
    const data = this.require(handle);
    writeFileSync(`${data.resultPath}.cancelled`, "cancelled\n");
    const barrier = this.actions[data.item]?.barrier;
    if (barrier) {
      mkdirSync(dirname(barrier), { recursive: true });
      writeFileSync(`${barrier}.cancelled`, "cancelled\n");
    }
    appendEvent(this.eventsPath, {
      type: "cancel",
      item: data.item,
      attempt: handle.identity,
    });
  }

  async collect(handle) {
    const data = this.require(handle);
    const action = this.actions[data.item] ?? {};
    if (action.barrier) {
      // An explicit sync point held by the test. It opens on release, on
      // cancellation, or when teardown removes the fixture. It fails only when
      // the barrier, harness and Factory state all stop changing, e.g. after a
      // reviewer assertion stopped the run that would have released it.
      const open = () => {
        if (
          existsSync(action.barrier) ||
          existsSync(`${data.resultPath}.cancelled`)
        )
          return true;
        if (!existsSync(this.root) || !existsSync(dirname(action.barrier)))
          throw new Error(`Fixture torn down at barrier for ${data.item}`);
        return false;
      };
      if (existsSync(this.root))
        mkdirSync(dirname(action.barrier), { recursive: true });
      if (!open())
        await waitFor(
          open,
          [dirname(action.barrier), this.root, this.stateHome].filter(Boolean),
          `barrier for ${data.item}`,
        );
    }
    if (existsSync(`${data.resultPath}.cancelled`))
      throw new Error(`Scripted attempt ${data.item} was cancelled`);
    if (existsSync(data.resultPath)) return readJson(data.resultPath);
    const starts = readEvents(this.eventsPath).filter(
      (event) => event.type === "start" && event.item === data.item,
    ).length;
    if (starts <= (action.dieAttempts ?? 0)) {
      appendEvent(this.eventsPath, { type: "died", item: data.item });
      writeFileSync(`${data.resultPath}.died`, "died\n");
      throw new Error(
        `Scripted worker for ${data.item} ended without a result`,
      );
    }
    if (starts <= (action.failAttempts ?? 0)) {
      appendEvent(this.eventsPath, { type: "failed", item: data.item });
      writeFileSync(`${data.resultPath}.failed`, "failed\n");
      throw new Error(`Scripted failure for ${data.item}`);
    }
    for (const file of action.files ?? []) {
      const destination = join(data.worktree, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        file.base64 ? Buffer.from(file.base64, "base64") : file.text,
      );
    }
    for (const [command, ...args] of action.commands ?? []) {
      execFileSync(command, args, {
        cwd: data.worktree,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    if (action.consumeSelected) {
      const request = readJson(data.requestPath);
      const selected = request.selectedAssets ?? [];
      assert.deepEqual(
        selected.map((asset) => asset.role).sort(),
        action.consumeSelected.roles.slice().sort(),
      );
      const output =
        selected
          .map(
            (asset) =>
              `${asset.role}:${readFileSync(asset.path).toString("hex")}`,
          )
          .join("\n") + "\n";
      const destination = join(data.worktree, action.consumeSelected.output);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, output);
    }
    const assets = (action.assets ?? []).map((set) => ({
      id: set.id,
      members: set.members.map((member) => {
        const relative = `.factory-media/${set.id}/${member.file}`;
        const destination = join(data.worktree, relative);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          member.base64 ? Buffer.from(member.base64, "base64") : member.text,
        );
        return {
          role: member.role,
          path: relative,
          mediaType: member.mediaType,
          destination: member.destination,
          ...(member.formatMetadata && {
            formatMetadata: member.formatMetadata,
          }),
        };
      }),
      ...(set.relationships && { relationships: set.relationships }),
      provenance: set.provenance,
    }));
    if (assets.length)
      writeJson(join(data.worktree, ".factory-assets.json"), { sets: assets });
    const result = {
      ...(assets.length && { assets }),
      evidence: { harness: "scripted", threadId: handle.identity },
    };
    writeJson(data.resultPath, result);
    appendEvent(this.eventsPath, {
      type: "complete",
      item: data.item,
      attempt: handle.identity,
    });
    return result;
  }
}

export class StatefulGitHubFake {
  constructor(root, checkout, objectiveBody) {
    this.root = root;
    this.checkout = checkout;
    this.path = join(root, "github.json");
    if (!existsSync(this.path)) {
      writeJson(this.path, {
        objectiveBody,
        nextIssue: 100,
        nextPullRequest: 200,
        nextStack: 300,
        issues: {},
        issueComments: {},
        closedIssues: {},
        dependencies: {},
        projections: {},
        pullRequests: {},
        stacks: {},
        events: [],
      });
    }
  }

  state() {
    return readJson(this.path);
  }

  update(change) {
    const value = this.state();
    const result = change(value);
    writeJson(this.path, value);
    return result;
  }

  async objective(number) {
    return { title: `Objective ${number}`, body: this.state().objectiveBody };
  }

  defaultBranch() {
    return "main";
  }

  async closeIssue(number, comment, expected) {
    this.update((state) => {
      if (expected.workItem) {
        const { id } = expected.workItem;
        if (state.issues[id] !== number)
          throw new Error("Work Item issue identity changed");
      } else if (number !== 1 || state.objectiveBody !== expected.body) {
        throw new Error("Objective issue identity changed");
      }
      state.issueComments[number] ??= [];
      if (!state.issueComments[number].includes(comment))
        state.issueComments[number].push(comment);
    });
    if (this.failCloseAfterComment === number) {
      this.failCloseAfterComment = undefined;
      // Classified as the real gateway classifies a refused permission.
      throw attachFault(new Error("Injected close failure after comment"), {
        kind: "config",
        detail: "Injected close failure after comment",
        fix: "Restore the login's issue permission, then `factory run`",
      });
    }
    this.update((state) => {
      state.closedIssues[number] = true;
      state.events.push({ type: "close-issue", number, comment });
    });
  }

  async projectGraph(request) {
    const issueByItemId = {};
    for (const item of request.graph.items) {
      this.update((state) => {
        state.issues[item.id] ??= state.nextIssue++;
        state.projections[item.id] = structuredClone(item);
        issueByItemId[item.id] = state.issues[item.id];
      });
      if (this.failProjectionAfter === Object.keys(issueByItemId).length) {
        this.failProjectionAfter = undefined;
        throw new Error("Injected partial projection failure");
      }
    }
    for (const item of request.graph.items) {
      this.update((state) => {
        state.dependencies[item.id] ??= [];
        for (const dependency of item.dependencies)
          if (!state.dependencies[item.id].includes(dependency))
            state.dependencies[item.id].push(dependency);
      });
    }
    this.update((state) => {
      state.events.push({
        type: "project",
        objective: request.objectiveIssue,
        issueByItemId,
      });
    });
    return { issueByItemId };
  }

  async findOpenPullRequest(branch, base, headSha) {
    const pull = Object.values(this.state().pullRequests).find(
      (candidate) => candidate.branch === branch && candidate.state === "open",
    );
    if (!pull) return undefined;
    if (pull.base !== base || pull.headSha !== headSha)
      throw new Error(`Existing PR for ${branch} changed head or base`);
    return { number: pull.number, branch, headSha };
  }

  async publish(request) {
    const headSha = git(this.checkout, "rev-parse", `origin/${request.branch}`);
    assert.equal(
      git(this.checkout, "rev-parse", `${headSha}^{tree}`),
      request.treeSha,
    );
    return this.update((state) => {
      const existing = Object.values(state.pullRequests).find(
        (candidate) => candidate.branch === request.branch,
      );
      if (existing) {
        assert.equal(existing.base, request.base);
        assert.equal(existing.headSha, headSha);
        return { number: existing.number, branch: request.branch, headSha };
      }
      const number = state.nextPullRequest++;
      state.pullRequests[number] = {
        number,
        branch: request.branch,
        base: request.base,
        headSha,
        treeSha: request.treeSha,
        state: "open",
        checks: "passing",
      };
      state.events.push({ type: "publish", number, ...request, headSha });
      return { number, branch: request.branch, headSha };
    });
  }

  async observe(identity) {
    const pull = this.state().pullRequests[identity.number];
    if (
      !pull ||
      pull.branch !== identity.branch ||
      pull.headSha !== identity.headSha
    )
      // A foreign change, as the real gateway classifies it.
      throw attachFault(
        new Error("Pull request identity changed"),
        decision("Pull request identity changed. Inspect it, then retry."),
      );
    return { state: pull.state, checks: pull.checks };
  }

  integrate(branch) {
    const directory = mkdtempSync(join(tmpdir(), "factory-github-fake-"));
    try {
      const remote = git(this.checkout, "remote", "get-url", "origin");
      execFileSync("git", ["clone", remote, directory], { stdio: "ignore" });
      git(directory, "config", "user.name", "Factory Test");
      git(directory, "config", "user.email", "factory-test@example.com");
      git(directory, "fetch", "origin");
      git(directory, "checkout", "main");
      git(
        directory,
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=cat",
        "-c",
        "filter.lfs.smudge=cat",
        "-c",
        "filter.lfs.required=false",
        "merge",
        "--no-ff",
        `origin/${branch}`,
        "-m",
        `Merge ${branch}`,
      );
      git(directory, "push", "origin", "HEAD:main");
      return git(directory, "rev-parse", "HEAD");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async merge(identity, expectedHead) {
    const pull = this.state().pullRequests[identity.number];
    // Like the real gateway: an already merged PR at this head is confirmed.
    if (pull?.state === "merged" && pull.headSha === expectedHead)
      return { integratedSha: pull.integratedSha };
    if (!pull || pull.headSha !== expectedHead || pull.state !== "open")
      throw new Error("Pull request is not the expected open head");
    const integratedSha = this.integrate(pull.branch);
    this.update((state) => {
      state.pullRequests[identity.number].state = "merged";
      state.pullRequests[identity.number].integratedSha = integratedSha;
      state.events.push({
        type: "merge",
        number: identity.number,
        integratedSha,
      });
    });
    return { integratedSha };
  }

  async ensureNativeStack(layers, baseBranch) {
    return this.update((state) => {
      const key = layers.map((layer) => layer.pullRequest).join(",");
      if (state.stacks[key]) return state.stacks[key].number;
      for (const [index, layer] of layers.entries()) {
        const pull = state.pullRequests[layer.pullRequest];
        assert.equal(pull.branch, layer.branch);
        assert.equal(pull.headSha, layer.headSha);
        assert.equal(pull.base, index ? layers[index - 1].branch : baseBranch);
      }
      const number = state.nextStack++;
      state.stacks[key] = { number, layers, baseBranch };
      state.events.push({ type: "stack", number, layers, baseBranch });
      return number;
    });
  }

  async mergeNativeStack(layers, baseBranch, expectedStack, options) {
    if (options.cancelled()) throw new Error("Objective cancelled");
    // Like the real gateway: a stack already merged at these heads is confirmed.
    const pulls = layers.map(
      (layer) => this.state().pullRequests[layer.pullRequest],
    );
    if (
      pulls.every(
        (pull, index) =>
          pull?.state === "merged" && pull.headSha === layers[index].headSha,
      )
    )
      return pulls.at(-1).integratedSha;
    assert.equal(
      await this.ensureNativeStack(layers, baseBranch),
      expectedStack,
    );
    options.beforeMerge?.();
    const integratedSha = this.integrate(layers.at(-1).branch);
    this.update((state) => {
      for (const layer of layers) {
        state.pullRequests[layer.pullRequest].state = "merged";
        state.pullRequests[layer.pullRequest].integratedSha = integratedSha;
      }
      state.events.push({
        type: "merge-stack",
        stack: expectedStack,
        integratedSha,
      });
    });
    return integratedSha;
  }
}

/**
 * Simulate a controller crash at one external-effect boundary. The process
 * kills itself with SIGKILL either before the call reaches the service or
 * after the service applied it but before the caller sees the result.
 */
function crashing(target, name, crashAt) {
  if (crashAt?.target !== name) return target;
  let seen = 0;
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (property !== crashAt.method || typeof value !== "function")
        return value;
      return async (...args) => {
        const hit = ++seen === (crashAt.call ?? 1);
        if (hit && crashAt.when === "before")
          process.kill(process.pid, "SIGKILL");
        const result = await value.apply(object, args);
        if (hit && crashAt.when === "after")
          process.kill(process.pid, "SIGKILL");
        return result;
      };
    },
  });
}

export function makeApplication(descriptor) {
  const root = stateRoot(descriptor.config.repository);
  const eventsPath = join(descriptor.fakeRoot, "harness.ndjson");
  const planningPath = join(descriptor.fakeRoot, "planning.ndjson");
  const contentStore = new LocalContentStore(join(root, "content"));
  const github = crashing(
    new StatefulGitHubFake(
      descriptor.fakeRoot,
      descriptor.config.checkout,
      descriptor.objectiveBody,
    ),
    "github",
    descriptor.crashAt,
  );
  const harness = new ScriptedHarness(
    join(root, "harness"),
    descriptor.actions,
    eventsPath,
  );
  const driver =
    descriptor.driver ??
    new LocalExecutionDriver(
      descriptor.config.checkout,
      join(root, "worktrees"),
      harness,
      resolveCapacity(descriptor.config).concurrency,
      contentStore,
      "scripted-test@1",
    );
  return {
    application: createApplication(descriptor.config, {
      planningModel:
        descriptor.planningModel ??
        crashing(
          new ScriptedPlanningModel(
            descriptor.graph,
            planningPath,
            descriptor.resultReviewer,
          ),
          "planning",
          descriptor.crashAt,
        ),
      driver,
      github,
      delivery: new RegularDelivery(descriptor.config.checkout, github),
      contentStore,
      reportRunStatus: descriptor.reportRunStatus,
    }),
    driver,
    eventsPath,
    planningPath,
    github,
    contentStore,
  };
}

export function writeDescriptor(path, descriptor) {
  writeJson(path, descriptor);
}

export function readDescriptor(path) {
  return readJson(path);
}
