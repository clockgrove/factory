import "./temp.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const plugin = join(import.meta.dirname, "..");
const read = (p) => JSON.parse(readFileSync(join(plugin, p), "utf8"));

test("the plugin's manifests: the Agent Plugins 1.0 root plugin.json is valid, and every manifest names the same plugin at the same version", () => {
  const root = read("plugin.json");
  assert.equal(root.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(root.name, /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
  assert.ok(!/--|\.\./.test(root.name));
  const allowed = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  assert.deepEqual(Object.keys(root).filter((k) => !allowed.has(k)), [], "the spec closes the top-level fields");
  assert.deepEqual(Object.keys(root.author).filter((k) => !["name", "email", "url"].includes(k)), []);
  const versions = Object.fromEntries(["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].map((p) => [p, read(p)]).map(([p, m]) => [p, `${m.name}@${m.version}`]));
  assert.equal(new Set(Object.values(versions)).size, 1, JSON.stringify(versions));
});

test("the Claude Code manifest registers every Claude agent definition the plugin ships, so a skill that spawns one finds it", () => {
  const listed = read(".claude-plugin/plugin.json").agents.map((a) => a.replace(/^\.\//, ""));
  const shipped = readdirSync(join(plugin, "agents", "claude")).map((f) => `agents/claude/${f}`);
  assert.deepEqual([...listed].sort(), [...shipped].sort());
});

test("the listing icon: the plugin's copy is docs/img/icon.png byte for byte, a square PNG of 512 to 2048 px, and the Claude Code icon and the Codex logo name it", () => {
  const icon = readFileSync(join(plugin, "assets", "icon.png"));
  assert.ok(icon.equals(readFileSync(join(plugin, "..", "docs", "img", "icon.png"))), "plugin/assets/icon.png differs from docs/img/icon.png");
  assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && icon.toString("latin1", 12, 16) === "IHDR", "not a PNG");
  const [w, h] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.ok(w === h && w >= 512 && w <= 2048, `${w}x${h}`);
  const { interface: codex } = read(".codex-plugin/plugin.json");
  assert.deepEqual([read(".claude-plugin/plugin.json").icon, codex.logo, codex.composerIcon], ["./assets/icon.png", "./assets/icon.png", "./assets/icon.png"]);
});

test("every manifest and marketplace entry lists the plugin with one description and one set of keywords, and the two Codex marketplace files are the same", () => {
  const market = (p) => JSON.parse(readFileSync(join(plugin, "..", p), "utf8"));
  const codexMarket = market(".agents/plugins/marketplace.json");
  assert.deepEqual(read(".agents/plugins/marketplace.json"), codexMarket);
  const listings = {
    "plugin.json": read("plugin.json"),
    ".claude-plugin/plugin.json": read(".claude-plugin/plugin.json"),
    ".codex-plugin/plugin.json": read(".codex-plugin/plugin.json"),
    ".claude-plugin/marketplace.json": market(".claude-plugin/marketplace.json").plugins.find((e) => e.name === "pendulum"),
    ".agents/plugins/marketplace.json": codexMarket.plugins.find((e) => e.name === "pendulum"),
  };
  const descriptions = { ...Object.fromEntries(Object.entries(listings).map(([p, m]) => [p, m.description])), "codex interface.longDescription": listings[".codex-plugin/plugin.json"].interface.longDescription };
  assert.equal(new Set(Object.values(descriptions)).size, 1, JSON.stringify(descriptions, null, 1));
  const keywords = Object.fromEntries(Object.entries(listings).map(([p, m]) => [p, JSON.stringify(m.keywords)]));
  assert.equal(new Set(Object.values(keywords)).size, 1, JSON.stringify(keywords, null, 1));
});
