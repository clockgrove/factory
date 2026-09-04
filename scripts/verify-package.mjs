/**
 * Verify the thing we actually ship.
 *
 * Everything else in this repository tests the source. This tests the *package*
 * — the artifact a plugin client installs and runs — because §15's portability
 * claim rests on properties no unit test can see: that `plugin.json` and
 * `mcp.json` are shaped the way the Agent Plugins 1.0 spec requires, that the
 * path in `mcp.json` resolves to a bundle that exists, and that the bundle
 * starts and serves its tools standalone, with no install step and no token.
 *
 * That last part matters more than it sounds. Until this script existed, the
 * plugin-install path had never once been exercised: skills were hand-copied
 * into place and the MCP server was launched from a hard-coded absolute path in
 * a local config, so a broken manifest or a missing bundle would not have shown
 * up in any gate.
 *
 * Deliberately dependency-free — no JSON-schema library — so it can run
 * anywhere, including from a fresh clone before dev dependencies are installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) problems.push(detail ?? label);
};

const readJson = (rel) => JSON.parse(readFileSync(resolve(root, rel), "utf8"));

// The tools Director is documented to have. A tool vanishing from this list
// silently is exactly the kind of regression that only shows up in live use.
const EXPECTED_TOOLS = [
  "approve_held_workflow_runs",
  "close_objective",
  "dispatch_confirm",
  "dispatch_integrate",
  "dispatch_retry_or_escalate",
  "dispatch_start",
  "evaluate_mechanical",
  "factory_activate",
  "factory_controller_install",
  "factory_controller_restart",
  "factory_controller_start",
  "factory_controller_status",
  "factory_controller_stop",
  "factory_controller_uninstall",
  "factory_doctor",
  "factory_drain",
  "factory_explain",
  "factory_pause",
  "factory_pause_cloud",
  "factory_plan",
  "factory_recovery_plan",
  "factory_priority",
  "factory_replay",
  "factory_resume",
  "factory_retry",
  "factory_run",
  "factory_cancel",
  "factory_status",
  "graph_apply",
  "inspect_priority_fields",
  "read_objective",
  "read_pull_request_diff",
  "read_repository_file",
  "read_repository_layout",
  "probe_execution_backends",
].sort();

console.log("\n# manifests\n");

const plugin = readJson("plugin.json");
const packageManifest = readJson("package.json");
check(
  plugin.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "plugin.json declares the Agent Plugins 1.0.0 schema",
);
for (const lifecycle of [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
]) {
  check(
    packageManifest.scripts?.[lifecycle] === undefined,
    `package has no ${lifecycle} lifecycle script`,
  );
}
check(typeof plugin.name === "string" && plugin.name.length > 0, "plugin.json has a name");
check(
  packageManifest.version === plugin.version,
  "package.json and plugin.json agree on the version",
);
check(
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(plugin.name ?? ""),
  `plugin.json name "${plugin.name}" matches the spec's pattern`,
);

const mcp = readJson("mcp.json");
check(
  mcp.$schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcp.json declares the Agent Plugins 1.0.0 schema",
);

const server = mcp.mcpServers?.factory;
check(Boolean(server), "mcp.json defines the `factory` server");
check(server?.type === "stdio", "the factory server is stdio");

// The check that would have caught a manifest pointing at a bundle that was
// never built, which no schema can catch.
const arg = (server?.args ?? []).find((a) => a.includes("${PLUGIN_ROOT}"));
check(Boolean(arg), "mcp.json addresses the bundle through ${PLUGIN_ROOT}");
const bundle = arg?.replace("${PLUGIN_ROOT}", root);
check(Boolean(bundle) && existsSync(bundle), `the path in mcp.json exists: ${arg}`);
if (bundle && existsSync(bundle)) {
  const bundleText = readFileSync(bundle, "utf8");
  for (const removedGraphqlType of [
    "COPILOT_WORK_STARTED_EVENT",
    "COPILOT_WORK_FINISHED_EVENT",
    "COPILOT_WORK_FINISHED_FAILURE_EVENT",
    "CopilotWorkStartedEvent",
    "CopilotWorkFinishedEvent",
    "CopilotWorkFinishedFailureEvent",
  ]) {
    check(
      !bundleText.includes(removedGraphqlType),
      `the bundle does not query removed GraphQL type ${removedGraphqlType}`,
    );
  }
}

const inventoryPath = resolve(root, "dist", "bundle-inventory.json");
const noticesPath = resolve(root, "THIRD_PARTY_NOTICES.txt");
check(existsSync(inventoryPath), "the exact bundle inventory exists");
check(existsSync(noticesPath), "third-party license notices exist");
if (existsSync(inventoryPath) && existsSync(noticesPath)) {
  const inventoryBytes = readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  check(
    inventory.protocol === "clockgrove.factory/bundle-inventory-v1",
    "the bundle inventory pins its public protocol",
  );
  check(
    Array.isArray(inventory.components) && inventory.components.length > 0,
    "the bundle inventory records embedded dependencies",
  );
  check(
    inventory.components?.every(
      (component) =>
        component.name &&
        component.version &&
        component.license &&
        component.licenseFiles?.length > 0,
    ),
    "every embedded dependency has license evidence",
  );
  for (const record of inventory.bundles ?? []) {
    const bytes = readFileSync(resolve(root, "dist", record.file));
    check(
      record.bytes === bytes.length && record.sha256 === sha256(bytes),
      `the bundle inventory matches dist/${record.file}`,
    );
  }
  const notices = readFileSync(noticesPath, "utf8");
  check(
    notices.includes(`Bundle inventory SHA-256: ${sha256(inventoryBytes)}`),
    "third-party notices are tied to the exact bundle inventory",
  );
}

// Substitute ${PLUGIN_ROOT} the way a plugin client would, and launch through
// *these* values below rather than a hard-coded path. Otherwise the manifest is
// read, checked, and then ignored — and a wrong `command`, a missing argument or
// a reordered one would sail through the only check that claims to run the
// shipped artifact the way it actually ships.
const launchCommand = server?.command;
const launchArgs = (server?.args ?? []).map((a) => a.replace("${PLUGIN_ROOT}", root));

// Claude Code reads its own manifest pair; they must not drift apart.
const claude = readJson(".claude-plugin/plugin.json");
check(claude.name === plugin.name, "the Claude manifest agrees on the plugin name");
check(claude.version === plugin.version, "the Claude manifest agrees on the version");
const claudeMcp = readJson(".mcp.json");
const claudeArg = (claudeMcp.mcpServers?.factory?.args ?? []).find((a) =>
  a.includes("${CLAUDE_PLUGIN_ROOT}"),
);
check(Boolean(claudeArg), ".mcp.json addresses the bundle through ${CLAUDE_PLUGIN_ROOT}");
check(
  claudeArg?.replace("${CLAUDE_PLUGIN_ROOT}", "") === arg?.replace("${PLUGIN_ROOT}", ""),
  "both manifests point at the same bundle path",
);

const marketplace = readJson(".github/plugin/marketplace.json");
const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === plugin.name);
check(marketplace.name === "clockgrove", "the Copilot marketplace has a stable name");
check(Boolean(marketplacePlugin), "the Copilot marketplace lists the factory plugin");
check(marketplacePlugin?.source === ".", "the marketplace points at the repository-root plugin");
check(
  marketplacePlugin?.version === plugin.version,
  "the marketplace and plugin manifests agree on the version",
);
check(
  marketplace.metadata?.version === plugin.version,
  "the Copilot marketplace metadata agrees on the version",
);

const agentMarketplace = readJson(".agents/plugins/marketplace.json");
const agentMarketplacePlugin = agentMarketplace.plugins?.find(
  (entry) => entry.name === plugin.name,
);
check(agentMarketplace.name === "clockgrove-factory", "the Agent marketplace has a stable name");
check(
  agentMarketplacePlugin?.source?.source === "url" &&
    agentMarketplacePlugin?.source?.url === "https://github.com/clockgrove/factory.git" &&
    agentMarketplacePlugin?.source?.ref === `v${plugin.version}`,
  "the Agent marketplace points at its immutable public Factory version tag",
);
check(
  agentMarketplacePlugin?.policy?.installation === "AVAILABLE" &&
    agentMarketplacePlugin?.policy?.authentication === "ON_INSTALL" &&
    agentMarketplacePlugin?.policy?.products === undefined,
  "the Agent marketplace declares portable install and authentication policy",
);
check(
  !existsSync(resolve(root, ".github", "workflows")),
  "the package ships no Factory GitHub Actions workflows",
);

// Codex resolves every component and asset path from the plugin root, not from
// the .codex-plugin directory that contains its manifest.
const codex = readJson(".codex-plugin/plugin.json");
check(codex.name === plugin.name, "the Codex manifest agrees on the plugin name");
check(codex.version === plugin.version, "the Codex manifest agrees on the version");
for (const [field, expected] of [["skills", "./skills/"]]) {
  check(codex[field] === expected, `the Codex ${field} path is plugin-root-relative`);
  check(existsSync(resolve(root, codex[field] ?? "")), `the Codex ${field} path exists`);
}
const codexServer = codex.mcpServers?.factory;
const codexBundleArg = (codexServer?.args ?? []).find((value) => value.includes("${PLUGIN_ROOT}"));
check(
  codexServer?.type === "stdio" && codexServer?.command === "node",
  "the Codex manifest declares the Factory stdio server inline",
);
check(
  codexBundleArg?.replace("${PLUGIN_ROOT}", "") === arg?.replace("${PLUGIN_ROOT}", ""),
  "the Codex and Agent Plugins manifests point at the same bundle",
);
check(
  Array.isArray(codex.interface?.defaultPrompt) &&
    codex.interface.defaultPrompt.length > 0 &&
    codex.interface.defaultPrompt.length <= 3 &&
    codex.interface.defaultPrompt.every((prompt) => prompt.length <= 128),
  "the Codex manifest exposes bounded starter prompts",
);
for (const field of ["composerIcon", "logo"]) {
  const path = codex.interface?.[field];
  check(
    typeof path === "string" && path.startsWith("./"),
    `the Codex interface.${field} path is plugin-root-relative`,
  );
  check(
    Boolean(path) && existsSync(resolve(root, path)),
    `the Codex interface.${field} asset exists`,
  );
}

console.log("\n# skills\n");

for (const skill of ["director", "objective-compilation"]) {
  const path = resolve(root, "skills", skill, "SKILL.md");
  if (!existsSync(path)) {
    check(false, `skills/${skill}/SKILL.md exists`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  check(Boolean(front), `skills/${skill}/SKILL.md has YAML frontmatter`);
  const body = front?.[1] ?? "";
  check(
    new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(body),
    `skills/${skill}/SKILL.md declares name: ${skill}`,
  );
  const description = /^description:\s*(.+)$/m.exec(body)?.[1] ?? "";
  check(
    description.length > 40,
    `skills/${skill}/SKILL.md has a description an agent can route on`,
  );
}

console.log("\n# protocol schemas\n");

const schemaFiles = [
  "objective.schema.json",
  "controller-policy.schema.json",
  "work-item.schema.json",
  "worker-packet.schema.json",
  "run-policy.schema.json",
  "factory-event.schema.json",
  "artifact.schema.json",
  "validation-evidence.schema.json",
  "replay-snapshot.schema.json",
];
const schemaIds = new Set();
for (const name of schemaFiles) {
  const path = resolve(root, "schemas", name);
  check(existsSync(path), `schemas/${name} exists`);
  if (!existsSync(path)) continue;
  const schema = readJson(`schemas/${name}`);
  check(typeof schema.$schema === "string", `schemas/${name} declares a JSON Schema dialect`);
  check(typeof schema.$id === "string", `schemas/${name} has a stable id`);
  if (schema.$id) schemaIds.add(schema.$id);
}
check(schemaIds.size === schemaFiles.length, "protocol schema ids are unique");
const replaySnapshotSchema = readJson("schemas/replay-snapshot.schema.json");
check(
  replaySnapshotSchema.properties?.protocol?.const === "clockgrove.factory/replay-v1",
  "replay snapshot schema pins the public replay protocol",
);
check(
  ["capturedAt", "policyDigest", "input", "expected", "snapshotDigest"].every((field) =>
    replaySnapshotSchema.required?.includes(field),
  ),
  "replay snapshot schema requires its complete digest boundary",
);
check(
  replaySnapshotSchema.definitions?.input?.properties?.policy?.$ref === "run-policy.schema.json" &&
    Boolean(replaySnapshotSchema.definitions?.decisionSet?.properties?.admissions) &&
    Boolean(replaySnapshotSchema.definitions?.decisionSet?.properties?.queued),
  "replay snapshot schema publishes policy, admission, and queue decisions",
);
const factoryEventSchema = readJson("schemas/factory-event.schema.json");
const eventKinds = factoryEventSchema.properties?.kind?.enum ?? [];
for (const kind of ["delivery", "publication"]) {
  check(eventKinds.includes(kind), `factory-event schema publishes the ${kind} event kind`);
}
for (const field of [
  "capabilityVersion",
  "unitId",
  "itemId",
  "headSha",
  "validationDigest",
  "exactHeadValidationDigest",
  "operationId",
  "reasonCode",
  "gate",
  "prioritySource",
]) {
  check(Boolean(factoryEventSchema.properties?.[field]), `factory-event schema publishes ${field}`);
}

console.log("\n# the bundle actually runs\n");

const started = await listTools();
const tools = started?.tools ?? null;
check(tools !== null, "the built server starts from mcp.json's own command and args");

// The server's own claim about its version is the one version nothing else
// compares against, so a stale value can survive until a human reads the
// handshake banner after a real plugin install. Manifest-to-manifest agreement
// is necessary but not sufficient: the running artifact has to agree too.
if (started?.serverInfo) {
  check(
    started.serverInfo.version === plugin.version,
    "the running server agrees with the plugin manifest on the version",
    `server: ${started.serverInfo.version}, plugin.json: ${plugin.version}`,
  );
  check(
    started.serverInfo.name === "factory",
    "the running server identifies itself as factory",
    `server: ${started.serverInfo.name}`,
  );
}

if (tools) {
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
  check(missing.length === 0, `no expected tool is missing`, `missing: ${missing.join(", ")}`);
  check(extra.length === 0, `no undocumented tool is exposed`, `unexpected: ${extra.join(", ")}`);

  const replayTool = tools.find((tool) => tool.name === "factory_replay");
  const recoveryTool = tools.find((tool) => tool.name === "factory_recovery_plan");
  check(
    recoveryTool?.annotations?.readOnlyHint === true &&
      recoveryTool?.annotations?.destructiveHint === false &&
      !recoveryTool?.inputSchema?.properties?.requestId,
    "factory_recovery_plan is a read-only observation without command authority",
  );
  check(
    replayTool?.annotations?.readOnlyHint === true &&
      replayTool?.annotations?.destructiveHint === false,
    "factory_replay is published as a read-only MCP operation",
  );

  const thin = tools.filter((t) => (t.description ?? "").length < 40).map((t) => t.name);
  check(thin.length === 0, "every tool has a description", `thin: ${thin.join(", ")}`);

  const noSchema = tools.filter((t) => !t.inputSchema?.properties).map((t) => t.name);
  check(
    noSchema.length === 0,
    "every tool has an input schema",
    `no schema: ${noSchema.join(", ")}`,
  );

  console.log(`\n      ${tools.length} tools: ${names.join(", ")}`);
}

console.log("\n# clean Codex plugin install\n");

const installVerifier = resolve(root, "scripts", "verify-plugin-install.mjs");
check(existsSync(installVerifier), "the clean-install verifier exists");
if (existsSync(installVerifier)) {
  const installed = spawnSync(process.execPath, [installVerifier], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  check(
    !installed.error && installed.status === 0,
    "Codex installs a staged Factory package in a clean home",
    installed.error?.message || installed.stderr || installed.stdout,
  );
  if (!installed.error && installed.status === 0) {
    try {
      const receipt = JSON.parse(installed.stdout.trim());
      check(
        receipt.installed === true && receipt.version === plugin.version,
        "the clean install agrees on the plugin version",
      );
      check(
        receipt.mcpTools === EXPECTED_TOOLS.length,
        "the installed MCP executable serves the complete tool surface",
      );
      check(
        receipt.controllerEntryPoint === "dist/factory.js",
        "the installed controller executable starts successfully",
      );
      check(
        receipt.sdkLocalAvailable === true,
        "the installed controller can run its default Codex SDK backend",
      );
    } catch (error) {
      check(false, "the clean-install verifier returns a JSON receipt", error.message);
    }
  }
}

if (bundle && existsSync(bundle)) {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "factory-package-"));
  try {
    const isolatedBundle = resolve(isolatedRoot, "mcp-server.js");
    copyFileSync(bundle, isolatedBundle);
    const isolatedArgs = launchArgs.map((value) => (value === bundle ? isolatedBundle : value));
    const isolated = await listTools(launchCommand, isolatedArgs, isolatedRoot);
    check(
      isolated?.tools?.length === EXPECTED_TOOLS.length,
      "the MCP bundle starts outside the checkout with no node_modules",
    );
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

console.log("");
if (problems.length) {
  console.log(`FAILED (${problems.length})`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("package verified");

/**
 * Speak just enough MCP to get a tool list.
 *
 * Launched from `mcp.json`'s own `command` and substituted `args` — not from a
 * path this script picks — so that the manifest is genuinely under test and not
 * merely parsed. Deliberately given no credentials: a server that cannot start
 * without a token would be unusable at plugin-install time, when no tool has
 * been called yet.
 */
async function listTools(command = launchCommand, args = launchArgs, cwd = root) {
  if (!command || args.length === 0) return null;

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    cwd,
  });

  // Without this, a `command` that is not on PATH surfaces as a 20-second
  // timeout and an unrelated-looking message instead of the real cause.
  let spawnFailure = null;
  const failed = new Promise((_, rej) => {
    child.on("error", (error) => {
      spawnFailure = error;
      rej(new Error(`could not launch \`${command}\`: ${error.message}`));
    });
  });
  failed.catch(() => {});

  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        // Not JSON-RPC; the server logs to stderr, so ignore stray stdout.
      }
    }
  });

  let id = 0;
  const send = (method, params) =>
    Promise.race([
      failed,
      new Promise((res, rej) => {
        const mine = ++id;
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), 20_000);
        pending.set(mine, (msg) => {
          clearTimeout(timer);
          res(msg);
        });
        if (spawnFailure) return;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
      }),
    ]);

  try {
    const initialized = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "factory-package-check", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await send("tools/list", {});
    return {
      tools: listed.result?.tools ?? null,
      serverInfo: initialized.result?.serverInfo ?? null,
    };
  } catch (error) {
    console.log(`      ${error.message}`);
    return null;
  } finally {
    child.kill();
  }
}
