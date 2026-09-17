/** Credential-free installed-artifact qualification for the foreground
 * management-compilation reconnect boundary. When preloaded into the installed
 * MCP process this module supplies a bounded, stateful GitHub read fixture. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OWNER = "fixture";
const REPO = "installed-reconnect";
const OBJECTIVE = 7;
const RUN_ID = "installed-interrupted-management-run";
const CANCELLATION_ID = "installed-cancel-management-run";
const BASE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const CAPACITY_SHA = "c".repeat(40);
const LEASE_SHA = "d".repeat(40);
const OBSERVED_AT = "2026-09-15T08:00:00.000Z";

const POLICY = {
  backendOrder: ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
  maxParallel: 2,
  workItemTimeoutMinutes: 30,
  objectiveTimeoutMinutes: 720,
  maxAttemptsPerItem: 3,
  allowedPaidBackends: [],
  cloudFallback: "never",
  maxSandboxMinutes: 0,
  maxManagedAgentSessions: 0,
  trust: "explicitly_activated_repo",
  managementBackend: "codex-cli/local",
  allowedNetworkDestinations: ["registry.npmjs.org", "*.npmjs.org", "api.openai.com"],
  compilerMediaEgress: {
    mode: "denied",
    maxAssets: 0,
    deterministicReviewRuleIds: [],
  },
  repositoryCaptureEgress: {
    deterministicGateIds: [],
    review: { mode: "denied", maxAssets: 0, reviewerCapabilityIds: [] },
  },
  priority: {
    source: "subissue-order",
    unsetRank: 100,
    onUnavailable: "fallback-to-subissue-order",
  },
  capacity: {
    mode: "fixed",
    local: {
      maxWorkers: 2,
      defaultCpu: 1,
      defaultMemoryMb: 2048,
      reserveCpu: 0.5,
      reserveMemoryMb: 1024,
      minimumFreeMemoryMb: 1024,
      maxLoadRatio: 0.9,
      maxMemoryUsageRatio: 0.85,
      sampleIntervalSeconds: 5,
      admissionCooldownSeconds: 10,
    },
  },
  burst: {
    mode: "never",
    backendOrder: [],
    maxCloudParallel: 1,
    queueDelaySeconds: 120,
    deadlineReserveMinutes: 60,
    maxPriorityRank: 1000,
  },
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const POLICY_DIGEST = createHash("sha256").update(canonical(POLICY)).digest("hex");

function event(fields) {
  return {
    protocol: "clockgrove.factory/v2",
    objective: OBJECTIVE,
    runId: RUN_ID,
    at: OBSERVED_AT,
    ...fields,
  };
}

const EVENTS = [
  event({
    kind: "run",
    event: "FactoryRunStarted",
    sequence: 1,
    actor: "operator",
    repository: `${OWNER}/${REPO}`,
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: BASE_SHA,
    policy: POLICY,
    policyDigest: POLICY_DIGEST,
  }),
  event({
    kind: "delivery",
    event: "DeliverySelected",
    sequence: 2,
    requested: "regular-prs",
    selected: "regular-prs",
    capabilityVersion: "2026-03-10",
    reason: "installed qualification fixture",
  }),
  event({
    kind: "budget",
    event: "BudgetReserved",
    sequence: 3,
    phase: "management",
    unit: "model_tokens",
    amount: 0,
    usageId: "invocation-installed-interrupted-compile",
    modelInvocationId: "installed-interrupted-compile",
    directorEpoch: 8,
    policyDigest: POLICY_DIGEST,
  }),
  event({
    kind: "run",
    event: "FactoryRunCancellationRequested",
    sequence: 4,
    requestedBy: "operator",
    requestId: CANCELLATION_ID,
    reason: "cancel installed interrupted management compilation",
  }),
];

function eventComment(value) {
  return `Installed foreground reconnect qualification\n\n<!-- clockgrove-factory:event\n${JSON.stringify(value)}\n-->`;
}

const LEASE_EVENT = {
  protocol: "clockgrove.factory/v2",
  kind: "lease",
  event: "LeaseAcquired",
  objective: OBJECTIVE,
  runId: RUN_ID,
  sequence: 5,
  at: OBSERVED_AT,
  holder: "interrupted-original-holder",
  epoch: 8,
  expiresAt: "2099-01-01T00:00:00.000Z",
  policyDigest: POLICY_DIGEST,
};

const CAPACITY_STATE = {
  protocol: "clockgrove.factory/shared-capacity-v2",
  repository: `${OWNER}/${REPO}`,
  generation: 1,
  limits: {
    maxParallel: 8,
    maxLocalParallel: 8,
    maxCloudParallel: 8,
    backendMaxParallel: {},
    cpuCapacity: Number.MAX_SAFE_INTEGER,
    memoryCapacityMb: Number.MAX_SAFE_INTEGER,
    maxPaidUnits: Number.MAX_SAFE_INTEGER,
  },
  claims: [],
  retired: { count: 0, markerOid: null },
};

function commit(sha, message, parents = [BASE_SHA]) {
  return {
    sha,
    tree: { sha: TREE_SHA },
    parents: parents.map((parent) => ({ sha: parent })),
    message,
    committer: { date: OBSERVED_AT },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      date: OBSERVED_AT,
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "4102444800",
    },
  });
}

async function requestBody(input, init) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body) return Buffer.from(init.body).toString("utf8");
  if (input instanceof Request) return input.clone().text();
  return "";
}

async function installedReconnectFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = await requestBody(input, init);
  const decodedPath = decodeURIComponent(url.pathname);
  const graphql = decodedPath === "/graphql" ? JSON.parse(body || "{}") : null;
  const operationMatch = graphql?.query?.match(/\b(query|mutation)\s+(\w+)/);
  const operationType = operationMatch?.[1] ?? null;
  const operation = operationMatch?.[2] ?? null;
  appendFileSync(
    process.env.FACTORY_INSTALLED_RECONNECT_LOG,
    `${JSON.stringify({ method, path: decodedPath, operationType, operation })}\n`,
  );

  if (decodedPath === "/graphql" && operation === "ObjectiveCardinality") {
    return jsonResponse({
      data: {
        repository: {
          owner: { __typename: "User" },
          issue: { subIssues: { totalCount: 0 } },
        },
      },
    });
  }
  if (decodedPath === "/graphql" && operation === "Objective") {
    return jsonResponse({
      data: {
        rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
        repository: {
          id: "R_installed_reconnect",
          defaultBranchRef: { name: "main" },
          workItemLabel: null,
          suggestedActors: { nodes: [] },
          issue: {
            id: "I_installed_reconnect",
            number: OBJECTIVE,
            title: "Installed interrupted management compilation",
            body: "Credential-free installed reconnect qualification",
            state: "OPEN",
            author: { login: "operator" },
            authorAssociation: "OWNER",
            comments: {
              totalCount: EVENTS.length,
              nodes: EVENTS.map((value, index) => ({
                fullDatabaseId: String(index + 1),
                body: eventComment(value),
                author: { login: "operator" },
                authorAssociation: "OWNER",
              })),
            },
            subIssues: { totalCount: 0, nodes: [] },
          },
        },
      },
    });
  }
  if (decodedPath === `/repos/${OWNER}/${REPO}` && method === "GET") {
    return jsonResponse({
      full_name: `${OWNER}/${REPO}`,
      fork: false,
      private: true,
      default_branch: "main",
      permissions: { push: true },
    });
  }
  if (decodedPath === "/user" && method === "GET")
    return jsonResponse({ id: 7, login: "operator" });
  if (decodedPath.endsWith("/collaborators/operator/permission") && method === "GET")
    return jsonResponse({ permission: "write" });
  if (decodedPath.endsWith("/rules/branches/main") && method === "GET") return jsonResponse([]);
  if (decodedPath.endsWith("/branches/main/protection") && method === "GET")
    return jsonResponse({ message: "Not Found" }, 404);
  if (decodedPath.endsWith("/actions/runs") && method === "GET")
    return jsonResponse({ total_count: 0, workflow_runs: [] });
  if (decodedPath.includes("/git/ref/") && method === "GET") {
    const ref = decodedPath.split("/git/ref/")[1];
    const sha =
      ref === "heads/main"
        ? BASE_SHA
        : ref === "clockgrove-factory/coordination/capacity"
          ? CAPACITY_SHA
          : ref === `clockgrove-factory/leases/objective-${OBJECTIVE}`
            ? LEASE_SHA
            : null;
    return sha
      ? jsonResponse({ ref: `refs/${ref}`, object: { type: "commit", sha } })
      : jsonResponse({ message: "Not Found" }, 404);
  }
  if (decodedPath.endsWith(`/git/commits/${BASE_SHA}`) && method === "GET")
    return jsonResponse(commit(BASE_SHA, "installed qualification base", []));
  if (decodedPath.endsWith(`/git/commits/${CAPACITY_SHA}`) && method === "GET")
    return jsonResponse(
      commit(
        CAPACITY_SHA,
        `Factory shared capacity\n\nFactory-Shared-Capacity: ${Buffer.from(JSON.stringify(CAPACITY_STATE)).toString("base64url")}`,
      ),
    );
  if (decodedPath.endsWith(`/git/commits/${LEASE_SHA}`) && method === "GET")
    return jsonResponse(
      commit(
        LEASE_SHA,
        `Factory lease LeaseAcquired for Objective #${OBJECTIVE}\n\nFactory-Event: ${Buffer.from(JSON.stringify(LEASE_EVENT)).toString("base64url")}`,
      ),
    );

  return jsonResponse(
    { message: `unexpected installed qualification request: ${method} ${decodedPath}` },
    500,
  );
}

if (process.env.FACTORY_INSTALLED_RECONNECT_FETCH === "1") {
  if (!process.env.FACTORY_INSTALLED_RECONNECT_LOG)
    throw new Error("installed reconnect qualification has no request log");
  globalThis.fetch = installedReconnectFetch;
}

function initializeRepository(repository) {
  mkdirSync(repository, { recursive: true });
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(result.stderr || `git ${args.join(" ")} failed`);
  };
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Installed Qualification");
  run("config", "user.email", "installed@example.invalid");
  run("remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`);
  writeFileSync(join(repository, "README.md"), "Installed reconnect qualification\n");
  run("add", "README.md");
  run("commit", "-q", "-m", "qualification base");
}

export async function qualifyInstalledForegroundReconnect({
  command,
  args,
  installedRoot,
  temporaryRoot,
  environment,
}) {
  const repository = resolve(temporaryRoot, "installed-reconnect-repository");
  const requestLog = resolve(temporaryRoot, "installed-reconnect-requests.jsonl");
  initializeRepository(repository);
  writeFileSync(requestLog, "");
  const child = spawn(command, args, {
    cwd: installedRoot,
    env: {
      ...environment,
      GITHUB_TOKEN: "installed-reconnect-fixture-token",
      NODE_OPTIONS: `--import=${resolve(import.meta.dirname, "qualification-foreground-reconnect.mjs")}`,
      FACTORY_INSTALLED_RECONNECT_FETCH: "1",
      FACTORY_INSTALLED_RECONNECT_LOG: requestLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const failed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0)
        reject(new Error(`installed reconnect MCP exited ${code}: ${stderr.trim()}`));
    });
  });
  let nextId = 0;
  const request = (method, params, timeoutMs = 20_000) => {
    const id = ++nextId;
    return Promise.race([
      failed,
      new Promise((resolveMessage, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`installed reconnect qualification timed out during ${method}`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolveMessage(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    ]);
  };
  const started = Date.now();
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "factory-installed-reconnect", version: "1" },
    });
    if (initialized.error) throw new Error(JSON.stringify(initialized.error));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const response = await request(
      "tools/call",
      {
        name: "factory_run",
        arguments: {
          owner: OWNER,
          repo: REPO,
          objectiveNumber: OBJECTIVE,
          repository,
          untilTerminal: true,
        },
      },
      30_000,
    );
    if (response.error || response.result?.isError)
      throw new Error(
        `installed reconnect call failed: ${JSON.stringify(response.error ?? response.result)} ${stderr.trim()}`,
      );
    const text = response.result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
    const result = JSON.parse(text);
    if (
      result.status !== "draining" ||
      result.objective !== OBJECTIVE ||
      result.runId !== RUN_ID ||
      !result.reason?.includes(CANCELLATION_ID)
    )
      throw new Error(`installed reconnect returned the wrong identity: ${text}`);
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const mutations = requests.filter(
      (entry) =>
        (entry.path === "/graphql" && entry.operationType === "mutation") ||
        (entry.path !== "/graphql" && !["GET", "HEAD"].includes(entry.method)),
    );
    if (mutations.length > 0)
      throw new Error(`installed reconnect emitted mutations: ${JSON.stringify(mutations)}`);
    return {
      status: result.status,
      runId: result.runId,
      cancellationRequestId: CANCELLATION_ID,
      unresolvedManagementInvocations: 1,
      graphWrites: 0,
      workItems: 0,
      workerAttempts: 0,
      mutations: 0,
      durationMs: Date.now() - started,
    };
  } finally {
    child.kill();
  }
}
