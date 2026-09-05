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
  rmSync,
  statSync,
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
  "dist",
  "docs",
  "mcp.json",
  "package.json",
  "plugin.json",
  "schemas",
  "skills",
];

function cleanEnvironment() {
  const result = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|COOKIE|AUTH/i.test(name)) continue;
    if (value !== undefined) result[name] = value;
  }
  return {
    ...result,
    CODEX_HOME: codexHome,
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

async function listTools(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: cleanEnvironment(),
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
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "factory-clean-install", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    return {
      serverInfo: initialized.result?.serverInfo,
      tools: listed.result?.tools,
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

  const manifest = JSON.parse(
    readFileSync(join(installedRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const mcp = manifest.mcpServers?.factory;
  const mcpArgs = (mcp?.args ?? []).map((value) => value.replace("${PLUGIN_ROOT}", installedRoot));
  if (mcp?.command !== "node" || mcpArgs.length === 0) {
    throw new Error("installed Codex manifest has no runnable Factory MCP server");
  }
  const mcpResult = await listTools(mcp.command, mcpArgs, installedRoot);
  const toolNames = (mcpResult.tools ?? []).map((tool) => tool.name);
  for (const required of [
    "factory_run",
    "factory_status",
    "factory_explain",
    "factory_replay",
    "factory_recovery_plan",
    "factory_controller_start",
  ]) {
    if (!toolNames.includes(required)) {
      throw new Error(`installed MCP server is missing ${required}`);
    }
  }
  if (mcpResult.serverInfo?.version !== manifest.version) {
    throw new Error("installed MCP server version differs from its manifest");
  }

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
      controllerEntryPoint: "dist/factory.js",
      sdkLocalAvailable: true,
    }),
  );
}

try {
  await main();
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
