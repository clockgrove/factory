import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
