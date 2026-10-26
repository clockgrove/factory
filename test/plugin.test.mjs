// The plugin both hosts install: the plugin/ directory, pinned to the release
// tag. It holds no npm package, so Claude Code installs no packages for it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const project = resolve(import.meta.dirname, "..");
const plugin = join(project, "plugin");
const json = (path) => JSON.parse(readFileSync(join(project, path), "utf8"));

test("both marketplaces install the plugin/ directory at the release tag", () => {
  const { version } = json("package.json");
  for (const path of [
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ]) {
    const entry = json(path).plugins.find(({ name }) => name === "factory");
    assert.equal(entry.source.source, "git-subdir", path);
    assert.equal(
      entry.source.url,
      "https://github.com/clockgrove/factory.git",
      path,
    );
    assert.equal(entry.source.path.replace(/^\.\//, ""), "plugin", path);
    assert.equal(entry.source.ref, `v${version}`, path);
  }
});

test("the plugin holds only its manifests, skills and logo", () => {
  // Claude Code installs a plugin's npm packages when its root has a
  // package.json and a lockfile (code.claude.com/docs/en/plugins/loading).
  assert.deepEqual(readdirSync(plugin).sort(), [
    ".claude-plugin",
    ".codex-plugin",
    "assets",
    "skills",
  ]);
  const codex = json("plugin/.codex-plugin/plugin.json");
  for (const path of [codex.skills, codex.interface.logo])
    assert.ok(existsSync(join(plugin, path)), path);
  assert.equal(
    json("plugin/.claude-plugin/plugin.json").version,
    codex.version,
  );
  assert.ok(existsSync(join(plugin, "skills", "setup", "install-cli.mjs")));
});
