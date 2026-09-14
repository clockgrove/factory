/**
 * Install a staged copy of Factory through a clean Codex home, then execute the
 * installed CLI and MCP bundles. This is deliberately separate from source
 * tests: a worktree-relative MCP override must not be able to satisfy it.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPluginRoot, optionalHostQualification } from "./qualify-linux-host.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexCommand = process.env.FACTORY_CODEX_COMMAND || "codex";
const temporaryRoot = mkdtempSync(join(tmpdir(), "factory-plugin-install-"));
const marketplaceRoot = join(temporaryRoot, "marketplace");
const stagedRoot = join(marketplaceRoot, "plugins", "factory");
const codexHome = join(temporaryRoot, "codex-home");

const shippedEntries = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".github",
  ".mcp.json",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.txt",
  "assets",
  "bin",
  "dist",
  "docs",
  "mcp.json",
  "package.json",
  "plugin.json",
  "schemas",
  "skills",
  "templates",
];

function cleanEnvironment() {
  const result = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|COOKIE|AUTH/i.test(name)) continue;
    if (/^FACTORY_/i.test(name)) continue;
    if (value !== undefined) result[name] = value;
  }
  return {
    ...result,
    HOME: temporaryRoot,
    CODEX_HOME: codexHome,
    GH_CONFIG_DIR: join(temporaryRoot, "gh-config"),
    XDG_CACHE_HOME: join(temporaryRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"),
    XDG_DATA_HOME: join(temporaryRoot, "xdg-data"),
    XDG_STATE_HOME: join(temporaryRoot, "xdg-state"),
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    OPENAI_API_KEY: "",
    DAYTONA_API_KEY: "",
    VERCEL_OIDC_TOKEN: "",
  };
}

function copyPackage() {
  mkdirSync(stagedRoot, { recursive: true });
  for (const entry of shippedEntries) {
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) throw new Error(`shipped entry is missing: ${entry}`);
    cpSync(source, join(stagedRoot, entry), { recursive: true });
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? temporaryRoot,
    env: cleanEnvironment(),
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${(
        result.stderr || result.stdout
      ).trim()}`,
    );
  }
  return result.stdout.trim();
}

function json(command, args, options) {
  const output = run(command, args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} did not return JSON: ${output.slice(0, 500)}`);
  }
}

async function inspectMcp(command, args, cwd, options = {}) {
  const child = spawn(command, args, {
    cwd,
    env: options.env ?? cleanEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const resolveMessage = pending.get(message.id);
        if (resolveMessage) {
          pending.delete(message.id);
          resolveMessage(message);
        }
      } catch {
        // MCP logs belong on stderr; a stray stdout line is not a response.
      }
    }
  });
  const failed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`installed MCP server exited ${code}: ${stderr.trim()}`));
      }
    });
  });
  let id = 0;
  const request = (method, params) => {
    const requestId = ++id;
    return Promise.race([
      failed,
      new Promise((resolveMessage, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`installed MCP server timed out during ${method}`));
        }, 20_000);
        pending.set(requestId, (message) => {
          clearTimeout(timer);
          resolveMessage(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      }),
    ]);
  };
  try {
    if (options.codexLoader) {
      const initialized = await request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: { name: "factory-clean-install", version: "1" },
      });
      if (initialized.error) throw new Error(JSON.stringify(initialized.error));
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const status = await request("mcpServerStatus/list", {});
      if (status.error) throw new Error(JSON.stringify(status.error));
      const factory = status.result?.data?.find((server) => server.name.includes("factory"));
      if (!factory?.tools?.factory_run)
        throw new Error(
          `Codex did not discover the installed Factory MCP tools: ${JSON.stringify(status.result)} ${stderr.trim()}`,
        );
      return factory;
    }
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "factory-clean-install", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    const missingLoginDoctor = await request("tools/call", {
      name: "factory_doctor",
      arguments: {
        owner: "clockgrove",
        repo: "factory",
        objectiveNumber: 345,
        repository: options.repository ?? cwd,
      },
    });
    const missingLoginStatus = await request("tools/call", {
      name: "factory_status",
      arguments: { owner: "clockgrove", repo: "factory", objectiveNumber: 345 },
    });
    return {
      serverInfo: initialized.result?.serverInfo,
      tools: listed.result?.tools,
      missingLoginDoctor: missingLoginDoctor.result,
      missingLoginStatus: missingLoginStatus.result,
    };
  } finally {
    child.kill();
  }
}

async function main() {
  copyPackage();
  mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const marketplace = {
    name: "factory-install-test",
    interface: { displayName: "Factory Install Test" },
    plugins: [
      {
        name: "factory",
        source: { source: "local", path: "./plugins/factory" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  };
  writeFileSync(
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(marketplace, null, 2)}\n`,
  );

  json(codexCommand, ["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
  json(codexCommand, ["plugin", "add", "factory@factory-install-test", "--json"]);
  const listed = json(codexCommand, ["plugin", "list", "--json"]);
  const version = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
  const installedRoot = installedPluginRoot(listed, codexHome, version);
  if (installedRoot === sourceRoot || installedRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("clean install resolved back to the development worktree");
  }

  const objectiveFormPath = join(installedRoot, "templates", "github", "objective.yml");
  const objectiveForm = readFileSync(objectiveFormPath, "utf8");
  if (
    !objectiveForm.includes("name: Factory Objective") ||
    !objectiveForm.includes("factory:objective") ||
    !objectiveForm.includes("id: outcome") ||
    !objectiveForm.includes("id: authority")
  ) {
    throw new Error("installed Factory plugin has no canonical human Objective issue form");
  }
  const setupSkill = readFileSync(
    join(installedRoot, "skills", "factory-setup", "SKILL.md"),
    "utf8",
  );
  if (
    !setupSkill.includes("templates/github/objective.yml") ||
    !setupSkill.includes("Never add the form automatically")
  ) {
    throw new Error("installed Factory setup guidance omits the Objective form boundary");
  }

  const manifest = JSON.parse(
    readFileSync(join(installedRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const mcp = manifest.mcpServers?.factory;
  const mcpArgs = (mcp?.args ?? []).map((value) => value.replace("${PLUGIN_ROOT}", installedRoot));
  if (
    mcp?.command !== "sh" ||
    mcpArgs.length !== 2 ||
    mcpArgs[0] !== join(installedRoot, "bin", "factory-mcp") ||
    mcpArgs[1] !== join(installedRoot, "dist", "mcp-server.js")
  ) {
    throw new Error("installed Codex manifest has no runnable Factory MCP server");
  }
  const nodeLessPath = join(temporaryRoot, "path-without-node");
  mkdirSync(nodeLessPath);
  // The portable manifest resolves the POSIX shell on PATH; isolate only Node.
  symlinkSync("/bin/sh", join(nodeLessPath, "sh"));
  const nodeLess = spawnSync(mcp.command, mcpArgs, {
    cwd: installedRoot,
    env: { ...cleanEnvironment(), PATH: nodeLessPath },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (
    nodeLess.status !== 127 ||
    !nodeLess.stderr.includes("the Codex host process cannot resolve 'node' on PATH") ||
    !nodeLess.stderr.includes("fully restart Codex")
  ) {
    throw new Error(
      `installed Factory MCP launcher did not diagnose a Node-less Codex host: ${nodeLess.stderr.trim()}`,
    );
  }
  const codexMcp = await inspectMcp(codexCommand, ["app-server", "--stdio"], installedRoot, {
    codexLoader: true,
  });
  const mcpResult = await inspectMcp(mcp.command, mcpArgs, installedRoot);
  const toolNames = (mcpResult.tools ?? []).map((tool) => tool.name);
  if (toolNames.some((name) => !codexMcp.tools[name]))
    throw new Error("Codex plugin discovery omitted an installed Factory MCP tool");
  for (const required of [
    "factory_run",
    "factory_status",
    "factory_explain",
    "factory_replay",
    "factory_recovery_plan",
    "factory_recovery_propose",
    "factory_recovery_request",
    "factory_controller_start",
  ]) {
    if (!toolNames.includes(required)) {
      throw new Error(`installed MCP server is missing ${required}`);
    }
  }
  if (mcpResult.serverInfo?.version !== manifest.version) {
    throw new Error("installed MCP server version differs from its manifest");
  }
  for (const name of ["factory_doctor", "factory_status"]) {
    const definition = (mcpResult.tools ?? []).find((tool) => tool.name === name);
    if (
      definition?.annotations?.readOnlyHint !== true ||
      definition.annotations.destructiveHint !== false
    ) {
      throw new Error(`installed ${name} is not declared as a read-only MCP operation`);
    }
  }
  for (const [operation, result] of [
    ["doctor", mcpResult.missingLoginDoctor],
    ["status", mcpResult.missingLoginStatus],
  ]) {
    const output = result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
    if (result?.isError !== true || !output.includes("GitHub authentication unavailable")) {
      throw new Error(`installed ${operation} did not return the specific missing-login action`);
    }
  }
  let authenticatedReadOnlyInspection = false;
  let doctorOverall = null;
  let doctorAttentionAreas = [];
  let statusRunState = null;
  const qualificationToken = process.env.FACTORY_PLUGIN_INSTALL_GITHUB_TOKEN?.trim();
  if (qualificationToken) {
    const authenticated = await inspectMcp(mcp.command, mcpArgs, installedRoot, {
      env: { ...cleanEnvironment(), GITHUB_TOKEN: qualificationToken },
      repository: sourceRoot,
    });
    const doctorText =
      authenticated.missingLoginDoctor?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
    const statusText =
      authenticated.missingLoginStatus?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
    const doctor = JSON.parse(doctorText);
    const status = JSON.parse(statusText);
    if (
      authenticated.missingLoginDoctor?.isError === true ||
      authenticated.missingLoginStatus?.isError === true ||
      doctor.operation !== "doctor" ||
      doctor.activationAuthorized !== false ||
      status.operation !== "status" ||
      status.objective?.number !== 345 ||
      status.run?.state !== "not-started" ||
      status.github?.admitted !== 0 ||
      status.github?.transported !== 0 ||
      status.github?.successful !== 0
    ) {
      throw new Error("authenticated installed doctor/status inspection did not stay read-only");
    }
    authenticatedReadOnlyInspection = true;
    doctorOverall = doctor.overall;
    doctorAttentionAreas = doctor.diagnostics
      .filter((diagnostic) => diagnostic.status !== "pass")
      .map((diagnostic) => diagnostic.area);
    statusRunState = status.run?.state ?? null;
  }
  const isolatedControllerConfig = join(temporaryRoot, "xdg-config", "systemd", "user");
  if (existsSync(isolatedControllerConfig)) {
    const controllerFiles = readdirSync(isolatedControllerConfig).filter((entry) =>
      entry.includes("factory"),
    );
    if (controllerFiles.length > 0) {
      throw new Error(`read-only inspection created controller configuration: ${controllerFiles}`);
    }
  }
  const controllerConfigCreated = existsSync(isolatedControllerConfig);

  const cliBundle = join(installedRoot, "dist", "factory.js");
  if (!existsSync(cliBundle) || !statSync(cliBundle).isFile()) {
    throw new Error("installed Factory controller bundle is missing");
  }
  const probes = json("node", [cliBundle, "backends", "probe"], {
    cwd: installedRoot,
    timeout: 45_000,
  });
  const probeIds = Array.isArray(probes) ? probes.map((probe) => probe.id) : [];
  for (const required of [
    "codex-sdk/local-worktree",
    "codex-app-server/local-worktree",
    "codex-cli/local-worktree",
  ]) {
    if (!probeIds.includes(required)) {
      throw new Error(`installed controller entry point did not report ${required}`);
    }
  }
  const sdkProbe = Array.isArray(probes)
    ? probes.find((probe) => probe.id === "codex-sdk/local-worktree")
    : undefined;
  if (sdkProbe?.probe?.available !== true) {
    throw new Error(
      `installed controller could not run its default Codex SDK backend: ${sdkProbe?.probe?.reason ?? "unknown reason"}`,
    );
  }

  await optionalHostQualification({
    installedRoot,
    artifactKind: "plugin",
    installation: { source: "staged-codex-marketplace", cleanInstall: true },
  });
  console.log(
    JSON.stringify({
      installed: true,
      marketplace: "factory-install-test",
      plugin: "factory",
      version: manifest.version,
      mcpTools: toolNames.length,
      codexDiscoveredMcpTools: Object.keys(codexMcp.tools).length,
      controllerEntryPoint: "dist/factory.js",
      sdkLocalAvailable: true,
      cleanConfiguration: true,
      missingLoginDiagnostics: ["doctor", "status"],
      readOnlyInspection: {
        toolsCalled: ["factory_doctor", "factory_status"],
        annotationsVerified: true,
        controllerConfigCreated,
      },
      authenticatedReadOnlyInspection,
      doctorOverall,
      doctorAttentionAreas,
      statusRunState,
    }),
  );
}

try {
  await main();
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
