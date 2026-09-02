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
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
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
  "graph_apply",
  "read_objective",
  "read_pull_request_diff",
  "read_repository_file",
  "read_repository_layout",
].sort();

console.log("\n# manifests\n");

const plugin = readJson("plugin.json");
check(
  plugin.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "plugin.json declares the Agent Plugins 1.0.0 schema",
);
check(typeof plugin.name === "string" && plugin.name.length > 0, "plugin.json has a name");
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

  const thin = tools.filter((t) => (t.description ?? "").length < 40).map((t) => t.name);
  check(thin.length === 0, "every tool has a description", `thin: ${thin.join(", ")}`);

  const noSchema = tools.filter((t) => !t.inputSchema?.properties).map((t) => t.name);
  check(noSchema.length === 0, "every tool has an input schema", `no schema: ${noSchema.join(", ")}`);

  console.log(`\n      ${tools.length} tools: ${names.join(", ")}`);
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
async function listTools() {
  if (!launchCommand || launchArgs.length === 0) return null;

  const child = spawn(launchCommand, launchArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
  });

  // Without this, a `command` that is not on PATH surfaces as a 20-second
  // timeout and an unrelated-looking message instead of the real cause.
  let spawnFailure = null;
  const failed = new Promise((_, rej) => {
    child.on("error", (error) => {
      spawnFailure = error;
      rej(new Error(`could not launch \`${launchCommand}\`: ${error.message}`));
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
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
