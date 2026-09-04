/** Opt-in installed-plugin Supervisor exercise; never part of offline release checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localBackends = ["codex-sdk/local-worktree", "codex-cli/local-worktree"];

export function installedIdentity({
  manifest,
  portable,
  packageManifest,
  listed,
  pluginRoot,
  codexHome,
}) {
  assert.equal(manifest.name, "factory");
  assert.equal(portable.name, "factory");
  assert.equal(packageManifest.name, "@clockgrove/factory");
  const version = packageManifest.version;
  assert.equal(portable.version, version, "portable plugin and package versions differ");
  assert.equal(typeof version, "string");
  const suffix = manifest.version?.slice(version.length);
  assert.ok(
    manifest.version === version ||
      (manifest.version?.startsWith(version) && /^\+codex\.\d{14}$/.test(suffix)),
    "Codex manifest must match canonical version or its documented cachebuster",
  );
  const matches = (listed.installed ?? []).filter(
    (entry) =>
      entry.name === "factory" &&
      entry.installed === true &&
      entry.enabled === true &&
      entry.version === version &&
      entry.pluginId === `factory@${entry.marketplaceName}` &&
      typeof entry.marketplaceName === "string" &&
      /^[\w.-]+$/.test(entry.marketplaceName) &&
      resolve(pluginRoot) ===
        join(
          resolve(codexHome),
          "plugins",
          "cache",
          entry.marketplaceName,
          "factory",
          entry.version,
        ),
  );
  assert.equal(
    matches.length,
    1,
    "the exact cache path must match one enabled installed Factory marketplace/version receipt",
  );
  return { version, codexManifestVersion: manifest.version, pluginId: matches[0].pluginId };
}

export function assertMcpSurface(tools) {
  for (const name of ["factory_run", "factory_status"]) {
    const definition = tools.find((tool) => tool.name === name);
    assert.ok(definition, `installed MCP server lacks ${name}`);
    for (const field of ["owner", "repo", "objectiveNumber"]) {
      assert.ok(definition.inputSchema.required?.includes(field), `${name} must require ${field}`);
    }
    if (name === "factory_run") {
      assert.ok(
        definition.inputSchema.properties?.repository,
        "factory_run must accept repository",
      );
      assert.ok(definition.inputSchema.properties?.policy, "factory_run must accept policy");
      assert.ok(
        definition.inputSchema.required?.includes("untilTerminal"),
        "factory_run must require untilTerminal",
      );
    }
  }
}

export const objectiveBody = `Build three tiny dependency-free ESM modules with node:test tests.

Compile three Work Items: two independent foundational modules, followed by one integration module that depends on both. Use native blocked-by relationships for that final Work Item. Keep each module and its own tests in its Work Item's allowed paths. Do not modify package.json or existing tests.

1. src/clamp.js exports clamp(value, min, max): return value bounded inclusively to min and max; throw RangeError when min > max. Add test/clamp.test.js covering below, within, above, equal bounds, and inverted bounds.
2. src/slugify.js exports slugify(text): lowercase ASCII text, replace each run of non-ASCII-alphanumeric characters with one hyphen, remove leading and trailing hyphens. Add test/slugify.test.js covering spaces, punctuation, repeated separators, empty input, and uppercase.
3. src/describe.js imports those two modules and exports describe(name, value, min, max), returning slugify(name) + ':' + clamp(value, min, max). Add test/describe.test.js: describe(' Hello World ', 12, 0, 10) equals 'hello-world:10', and inverted bounds propagate RangeError.

Use node --test test/<module>.test.js as each foundation's independent validation, and npm test for the final integration. No dependencies, services, credentials, cloud workers, workflows, or network access are needed by these modules. Preserve the existing repository. Complete publication, independent validation, integration, and issue closure through Factory.`;

export function assertRetryableObjective({ issue, actorId, status, children, events, runId }) {
  assert.equal(issue.state, "open", "retry requires an open Objective");
  assert.ok(!issue.pull_request, "retry target must be an issue");
  assert.equal(issue.body, objectiveBody, "retry Objective differs from this fixture");
  assert.ok(Number.isInteger(actorId) && actorId > 0, "authenticated actor ID required");
  assert.equal(issue.user?.id, actorId, "retry Objective belongs to another actor");
  assert.equal(status.objective?.number, issue.number, "status belongs to another Objective");
  assert.ok(typeof runId === "string" && runId.length > 0, "prior run ID required");
  assert.equal(status.run?.runId, runId, "latest run differs from acknowledged failed run");
  assert.equal(status.run?.state, "escalated", "retry requires a terminal escalated run");
  assert.equal(children.length, 0, "retry cannot replace existing Work Items");
  assert.equal(status.workItems?.length, 0, "retry cannot replace projected work");
  assert.equal(status.summary?.attempts?.total, 0, "retry cannot replace attempted work");
  const beforeCompilation = new Set([
    "FactoryRunStarted",
    "ControllerObserved",
    "DeliverySelected",
    "FactoryRunEscalated",
    "BudgetReserved",
    "BudgetReconciled",
  ]);
  assert.ok(
    events.some((event) => event.runId === runId && event.event === "FactoryRunEscalated"),
    "missing terminal failure receipt",
  );
  assert.ok(
    events.every((event) => beforeCompilation.has(event.event)),
    "retry requires failure before graph or execution receipts",
  );
}

export function boundedPolicy(delivery = "regular-prs") {
  assert.ok(["regular-prs", "stacked-prs"].includes(delivery), "unsupported delivery mode");
  return {
    backendOrder: localBackends,
    maxParallel: 2,
    workItemTimeoutMinutes: 10,
    objectiveTimeoutMinutes: 45,
    maxAttemptsPerItem: 2,
    allowedPaidBackends: [],
    cloudFallback: "never",
    maxSandboxMinutes: 0,
    maxManagedAgentSessions: 0,
    trust: "explicitly_activated_repo",
    managementBackend: "codex-cli/local",
    allowedNetworkDestinations: ["api.openai.com"],
    economics: {
      maxModelTokens: 150_000,
      maxSandboxMinutes: 0,
      maxManagedSessions: 0,
      minCloudTimeSavedMinutes: 0,
    },
    delivery: { mode: delivery, onUnavailable: "regular-prs", merge: "bottom-up" },
    capacity: {
      mode: "adaptive-local",
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
  };
}

export function assertCompletion(evidence) {
  assert.equal(evidence.status.run.state, "completed", "Supervisor did not complete");
  assert.equal(evidence.objective.state, "closed", "Objective remains open");
  assert.ok(evidence.children.length >= 3, "expected a multi-wave compiled graph");
  assert.ok(
    evidence.dependencies.some((entry) => entry.blockedBy.length >= 2),
    "missing two-parent join",
  );
  const runId = evidence.status.run.runId;
  const events = evidence.events.filter((event) => event.runId === runId);
  assert.ok(
    events.some((event) => event.event === "GraphProjected"),
    "missing compilation receipt",
  );
  assert.ok(
    events.some((event) => event.event === "FactoryRunCompleted"),
    "missing completion receipt",
  );
  const starts = events.filter((event) => event.event === "AttemptStarted");
  assert.ok(starts.length >= 3, "fewer than three workers started");
  for (const start of starts)
    assert.ok(localBackends.includes(start.backend), "nonlocal worker used");
  for (const child of evidence.children) {
    assert.equal(child.state, "closed", `Work Item #${child.number} remains open`);
    const integrated = events.find(
      (event) => event.workItem === child.number && event.event === "AttemptIntegrated",
    );
    assert.ok(integrated, `Work Item #${child.number} missing integration receipt`);
    const published = events.find(
      (event) =>
        event.workItem === child.number &&
        event.attempt === integrated.attempt &&
        event.event === "AttemptPublished",
    );
    assert.ok(
      published?.artifactDigest && published.headSha,
      "missing published artifact identity",
    );
    assert.ok(
      events.some(
        (event) =>
          event.workItem === child.number &&
          event.attempt === integrated.attempt &&
          event.event === "AttemptValidated" &&
          event.artifactDigest === published.artifactDigest,
      ),
      `Work Item #${child.number} lacks independent validation for its published artifact`,
    );
    const publication = events.find(
      (event) =>
        event.workItem === child.number &&
        event.attempt === integrated.attempt &&
        event.event === "PublicationRecorded" &&
        event.headSha === published.headSha,
    );
    assert.ok(publication?.pullRequest, "missing publication PR identity");
    assert.ok(
      evidence.pulls.some(
        (pull) =>
          pull.number === publication.pullRequest &&
          pull.merged === true &&
          pull.merge_commit_sha === integrated.headSha,
      ),
      "integration receipt differs from GitHub merge commit",
    );
  }
  assert.ok(evidence.pulls.length >= 3, "expected published PRs");
  for (const pull of evidence.pulls)
    assert.equal(pull.merged, true, `PR #${pull.number} was not merged`);
}

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main() {
  if (process.env.FACTORY_LIVE_OBJECTIVE !== "1") {
    console.log(
      "Not exercised: set FACTORY_LIVE_OBJECTIVE=1 and explicit disposable-repository inputs.",
    );
    return;
  }
  assert.equal(process.platform, "linux", "live Objective harness requires Linux");
  const repository = required("FACTORY_LIVE_OBJECTIVE_REPOSITORY");
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.notEqual(repository.toLowerCase(), "clockgrove/factory", "use a disposable repository");
  assert.equal(
    required("FACTORY_LIVE_OBJECTIVE_MUTATION_ACK"),
    repository,
    "acknowledge the exact disposable repository",
  );
  const [owner, repo] = repository.split("/");
  const checkout = realpathSync(required("FACTORY_LIVE_OBJECTIVE_CHECKOUT"));
  assert.ok(!checkout.startsWith("/mnt/"), "checkout must reside on the Linux filesystem");
  assert.equal(run("git", ["status", "--porcelain"], checkout), "", "fixture must start clean");
  for (const name of ["clamp", "slugify", "describe"]) {
    assert.ok(
      !existsSync(join(checkout, "src", `${name}.js`)) &&
        !existsSync(join(checkout, "test", `${name}.test.js`)),
      "use a fresh fixture without previous Objective output",
    );
  }
  const origin = run("git", ["remote", "get-url", "origin"], checkout).replace(/\.git$/, "");
  assert.ok(
    origin === `https://github.com/${repository}` || origin === `git@github.com:${repository}`,
    "checkout origin differs from approved repository",
  );
  const pluginRoot = realpathSync(required("FACTORY_LIVE_OBJECTIVE_PLUGIN_ROOT"));
  const codexHome = realpathSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
  assert.ok(
    pluginRoot.startsWith(`${join(codexHome, "plugins", "cache")}${sep}`),
    "use the plugin installed in this Codex home's cache",
  );
  assert.ok(
    pluginRoot !== sourceRoot && !pluginRoot.startsWith(`${sourceRoot}${sep}`),
    "development worktree is not an installation",
  );
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  const listed = JSON.parse(run("codex", ["plugin", "list", "--json"], checkout));
  const identity = installedIdentity({
    manifest,
    listed,
    pluginRoot,
    codexHome,
    portable: JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")),
    packageManifest: JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")),
  });
  const mcp = manifest.mcpServers?.factory;
  assert.equal(mcp?.command, "node");
  const token =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run("gh", ["auth", "token"], checkout);
  const octokit = new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2026-03-10" } },
  });
  const request = (route, parameters = {}) =>
    octokit.request(route, { owner, repo, ...parameters });
  const list = async (route, parameters = {}) => {
    const results = [];
    for (let page = 1; ; page++) {
      const { data } = await request(route, { ...parameters, per_page: 100, page });
      assert.ok(Array.isArray(data), "paginated GitHub response must be an array");
      results.push(...data);
      if (data.length < 100) return results;
    }
  };
  const info = (await request("GET /repos/{owner}/{repo}")).data;
  assert.ok(!info.archived && info.permissions?.push, "target must permit fixture integration");
  const base = (
    await request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: info.default_branch })
  ).data.sha;
  assert.equal(
    run("git", ["rev-parse", "HEAD"], checkout),
    base,
    "fixture must match GitHub default branch",
  );
  const suffix = randomUUID();
  const output = resolve(required("FACTORY_LIVE_OBJECTIVE_EVIDENCE"));
  assert.ok(
    !existsSync(join(output, "objective-evidence.json")),
    "preserve prior run evidence; use a fresh output directory",
  );
  mkdirSync(output, { recursive: true });
  const evidence = {
    schemaVersion: 1,
    scope: "installed-local-objective-happy-path",
    startedAt: new Date().toISOString(),
    repository,
    base,
    pluginVersion: identity.version,
    codexManifestVersion: identity.codexManifestVersion,
    pluginId: identity.pluginId,
    bundleSha256: sha256(join(pluginRoot, "dist/mcp-server.js")),
    policy: boundedPolicy(process.env.FACTORY_LIVE_OBJECTIVE_DELIVERY),
    objective: null,
    status: null,
    children: [],
    dependencies: [],
    events: [],
    pulls: [],
  };
  const save = () =>
    writeFileSync(
      join(output, "objective-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
  const client = new Client({ name: "factory-live-objective", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot)),
    cwd: checkout,
    env: { ...process.env, GITHUB_TOKEN: token },
    stderr: "pipe",
  });
  const call = async (name, args, timeout = 60_000) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout,
      maxTotalTimeout: timeout,
    });
    assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`);
    return JSON.parse(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  };
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    assert.equal(
      client.getServerVersion()?.version,
      identity.version,
      "installed server version mismatch",
    );
    assertMcpSurface((await client.listTools()).tools);
    const retryNumber = process.env.FACTORY_LIVE_OBJECTIVE_NUMBER;
    if (retryNumber !== undefined) {
      assert.match(retryNumber, /^[1-9]\d*$/, "invalid retry Objective number");
      const issueNumber = Number(retryNumber);
      assert.ok(Number.isSafeInteger(issueNumber), "invalid retry Objective number");
      const issue = (
        await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          issue_number: issueNumber,
        })
      ).data;
      const status = await call("factory_status", { owner, repo, objectiveNumber: issueNumber });
      const children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        issue_number: issueNumber,
      });
      const comments = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        issue_number: issueNumber,
      });
      const actorId = (await octokit.request("GET /user")).data.id;
      const events = comments.flatMap((comment) =>
        [...(comment.body ?? "").matchAll(/<!-- clockgrove-factory:event\n([\s\S]*?)\n-->/g)].map(
          (match) => JSON.parse(match[1]),
        ),
      );
      const runId = required("FACTORY_LIVE_OBJECTIVE_PRIOR_RUN_ID");
      assertRetryableObjective({ issue, actorId, status, children, events, runId });
      evidence.objective = issue;
      evidence.retryOfRunId = runId;
      evidence.priorStatus = status;
    } else
      evidence.objective = (
        await request("POST /repos/{owner}/{repo}/issues", {
          title: `Factory installed local Objective ${suffix}`,
          body: objectiveBody,
        })
      ).data;
    save();
    console.log(
      `${retryNumber ? "Retrying" : "Created"} disposable Objective ${evidence.objective.html_url}; installed Factory is running.`,
    );
    evidence.runResult = await call(
      "factory_run",
      {
        owner,
        repo,
        objectiveNumber: evidence.objective.number,
        repository: checkout,
        untilTerminal: true,
        policy: evidence.policy,
      },
      48 * 60_000,
    );
    evidence.status = await call("factory_status", {
      owner,
      repo,
      objectiveNumber: evidence.objective.number,
    });
    evidence.objective = (
      await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: evidence.objective.number,
      })
    ).data;
    evidence.children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      issue_number: evidence.objective.number,
    });
    for (const issue of [evidence.objective, ...evidence.children]) {
      const comments = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        issue_number: issue.number,
      });
      for (const comment of comments) {
        for (const match of (comment.body ?? "").matchAll(
          /<!-- clockgrove-factory:event\n([\s\S]*?)\n-->/g,
        ))
          evidence.events.push({
            ...JSON.parse(match[1]),
            receiptUrl: comment.html_url,
            author: comment.user?.login,
          });
      }
      if (issue.number !== evidence.objective.number)
        evidence.dependencies.push({
          workItem: issue.number,
          blockedBy: await list(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
            { issue_number: issue.number },
          ),
        });
    }
    const pullNumbers = new Set(
      evidence.events
        .filter((event) => event.runId === evidence.status.run.runId)
        .map((event) => event.pullRequest)
        .filter(Number.isInteger),
    );
    for (const number of pullNumbers)
      evidence.pulls.push(
        (await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { pull_number: number }))
          .data,
      );
    save();
    assertCompletion(evidence);
    const verified = join(output, "merged-fixture");
    run("git", ["clone", "--depth", "1", `https://github.com/${repository}.git`, verified], output);
    evidence.finalSha = run("git", ["rev-parse", "HEAD"], verified);
    evidence.testOutput = run("node", ["--test"], verified);
    evidence.behaviorOutput = run(
      "node",
      [
        "--input-type=module",
        "-e",
        "import assert from 'node:assert/strict'; import {clamp} from './src/clamp.js'; import {slugify} from './src/slugify.js'; import {describe} from './src/describe.js'; assert.equal(clamp(-2,0,10),0); assert.equal(clamp(4,0,10),4); assert.equal(clamp(12,0,10),10); assert.throws(()=>clamp(1,2,0),RangeError); assert.equal(slugify(' Hello, WORLD!! '),'hello-world'); assert.equal(slugify('---'),''); assert.equal(describe(' Hello World ',12,0,10),'hello-world:10'); assert.throws(()=>describe('x',1,2,0),RangeError); console.log('Independent merged-artifact assertions passed');",
      ],
      verified,
    );
    evidence.result = "passed";
    evidence.finishedAt = new Date().toISOString();
    save();
    console.log(
      `Passed installed local Objective happy path; evidence: ${join(output, "objective-evidence.json")}`,
    );
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (evidence.objective) {
      try {
        evidence.status = await call("factory_status", {
          owner,
          repo,
          objectiveNumber: evidence.objective.number,
        });
      } catch {
        // The durable Objective URL remains available even if the MCP transport died.
      }
    }
    save();
    throw error;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
