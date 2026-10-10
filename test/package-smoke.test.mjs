import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("packed Factory installs offline and runs its CLI and bundled scanner", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-package-smoke-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("init", "--initial-branch=main");
    git(
      "remote",
      "add",
      "origin",
      "https://github.com/example/package-smoke.git",
    );
    const npmVersion = execFileSync("npm", ["--version"], {
      encoding: "utf8",
    }).trim();
    const versionProbe = `npm --version && test "$(npm --version)" = "${npmVersion}"`;
    writeFileSync(
      join(checkout, "README.md"),
      `# Local package smoke target\n\n${versionProbe}\n\nnpm test\n\n${versionProbe} && npm test\n\nnpm --version"=false" run test\n`,
    );
    writeFileSync(
      join(checkout, "package.json"),
      `${JSON.stringify({
        name: "package-smoke-target",
        private: true,
        packageManager: `npm@${npmVersion}`,
        scripts: { test: "node --check app.mjs" },
      })}\n`,
    );
    writeFileSync(join(checkout, "app.mjs"), "export const ready = true;\n");
    writeFileSync(join(checkout, ".npmrc"), "fund=false\n");
    git("add", "README.md", "package.json", "app.mjs", ".npmrc");
    git(
      "-c",
      "user.name=Factory Integration",
      "-c",
      "user.email=factory-integration@example.com",
      "commit",
      "-m",
      "Initialize local target",
    );

    const pack = join(root, "pack");
    const prefix = join(root, "prefix");
    mkdirSync(pack);
    const project = resolve(import.meta.dirname, "..");
    const packageName = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", pack],
      { cwd: project, encoding: "utf8" },
    ).trim();
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--omit=optional",
        "--engine-strict",
        "--prefix",
        prefix,
        "--ignore-scripts",
        join(pack, packageName),
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          npm_config_cache: join(root, "empty-npm-cache"),
        },
      },
    );
    const installedRoot = join(
      prefix,
      "node_modules",
      "@clockgrove",
      "factory",
    );
    for (const path of [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "skills/director/SKILL.md",
      "skills/setup/SKILL.md",
      "docs/USER-GUIDE.md",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.ok(
        existsSync(join(installedRoot, path)),
        `release asset missing: ${path}`,
      );
    }

    const cli = join(prefix, "node_modules", ".bin", "factory");
    const config = join(root, "selected config's", "factory.json");
    const environment = {
      ...process.env,
      PATH: `${join(prefix, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      CODEX_HOME: root,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    };
    const run = (...args) =>
      execFileSync(cli, args, { encoding: "utf8", env: environment });
    // Real packed npm launcher beneath the credential root: omit only its
    // authenticated sole launcher, retaining the controller validation PATH.
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexHome } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "codex-planning-isolation.js")).href)};
import { localValidationEnvironment, sanitizedWorkerEnvironment } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "process.js")).href)};
const bin = ${JSON.stringify(join(prefix, "node_modules", ".bin"))};
assert.equal(localValidationEnvironment(${JSON.stringify(join(root, "credentials"))}).PATH, process.env.PATH);
assert.equal(sanitizedWorkerEnvironment(${JSON.stringify(join(root, "credentials"))}).PATH.split(":").includes(bin), false);
const home = createCodexHome({ config: "", sandbox: { directory: ${JSON.stringify(checkout)}, workspace: "write", network: false } });
try {
  assert.equal(home.env.PATH.split(":").includes(bin), false);
  assert.equal(readFileSync(join(home.env.CODEX_HOME, "config.toml"), "utf8").includes(bin), false);
} finally { home.dispose(); }
`,
      ],
      { encoding: "utf8", env: environment },
    );
    // Exercise the installed compiler's source gate and actual fresh-tree
    // validation using the same pinned commands. A version assertion is not
    // a package script; combining it with a script still cannot evade pinning.
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planningSources, hydrateWorkerInputSources, validateGraphSources } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "compiler.js")).href)};
import { deliveredPlanningSources, materializePlanningSources, planningSourceDirectory, assertPlanningSourceDelivery } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "compiler", "source-delivery.js")).href)};
import { validatePlanning } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "config.js")).href)};
import { assertPinnedNpmScripts, validateWorkItem } from ${JSON.stringify(pathToFileURL(join(installedRoot, "dist", "validation.js")).href)};
const checkout = ${JSON.stringify(checkout)};
const probe = ${JSON.stringify(versionProbe)};
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const baseSha = git("rev-parse", "HEAD");
const body = "## Outcome\\nQualify the pinned tooling.\\n\\n## Acceptance\\n- \u0060" + probe + "\u0060\\n- \u0060npm test\u0060\\n\\n## Sources\\n- README.md\\n\\n## Constraints\\nKeep package configuration fixed.\\n";
const sources = planningSources(body, baseSha, checkout);
const configured = { kind: "codex-sdk", planner: { model: "gpt-5.4", reasoningEffort: "high" }, reviewer: { model: "gpt-5.4", reasoningEffort: "high" } };
validatePlanning(configured);
assert.equal(configured.codex, undefined);
validatePlanning({ ...configured, codex: { sourceArtifacts: true } });
assert.throws(() => validatePlanning({ ...configured, codex: { sourceArtifacts: true, transport: "app-server" } }), /require the exec transport/);
assert.throws(() => validatePlanning({ ...configured, codex: { sourceArtifacts: "true" } }), /must be boolean/);
const sourceRoot = planningSourceDirectory(${JSON.stringify(root)}, baseSha, sources);
const delivered = materializePlanningSources(sourceRoot, baseSha, sources, deliveredPlanningSources(baseSha, sources));
assert.equal(delivered.reusedSourceIndices.length, sources.length);
for (const file of delivered.files) assert.equal(readFileSync(join(sourceRoot, file.file), "utf8"), sources[file.sourceIndex].content);
rmSync(join(sourceRoot, delivered.files[0].file));
assertPlanningSourceDelivery(delivered, baseSha, sources);
assert.equal(readFileSync(join(sourceRoot, delivered.files[0].file), "utf8"), sources[0].content);
const item = { id: "tooling", kind: "qa", title: "Verify tooling", acceptance: [], citations: [{ path: "README.md", heading: "" }], dependencies: [], ownedPaths: [], validation: [{ command: probe, provenance: "source-declared", source: "README.md" }, { command: "npm test", provenance: "base-observed", source: "package.json" }], brief: "Run the pinned tooling checks.", minimumAssetSets: 0 };
const graph = { objective: 1, baseSha, items: [item], coverage: [] };
hydrateWorkerInputSources(graph, sources);
validateGraphSources(graph, sources, checkout, body, baseSha);
const evidence = await validateWorkItem(checkout, ${JSON.stringify(join(root, "command-validation"))}, item, baseSha, git("rev-parse", "HEAD^{tree}"), baseSha);
assert.equal(evidence.commands.length, 2);
assert.ok(evidence.commands.every(command => command.passed && command.exitCode === 0));
assert.equal(evidence.worktreeObservation.subprocessOwnership, "settled");
item.validation = [{ command: probe + " && npm test", provenance: "source-declared", source: "README.md" }];
assert.throws(() => validateGraphSources(graph, sources, checkout, body, baseSha), /Work Item tooling has no exact source-declared command authority/);
item.validation[0].command = 'npm --version"=false" run test';
assert.throws(() => validateGraphSources(graph, sources, checkout, body, baseSha), /Work Item tooling has no exact source-declared command authority/);
const packagePath = join(checkout, "package.json");
const originalPackage = readFileSync(packagePath, "utf8");
const changed = JSON.parse(originalPackage);
changed.scripts.test = "node --check missing.mjs";
writeFileSync(packagePath, JSON.stringify(changed) + "\\n");
const commit = (message) => { git("add", "package.json", ".npmrc"); git("-c", "user.name=Factory Integration", "-c", "user.email=factory-integration@example.com", "commit", "-m", message); return git("rev-parse", "HEAD"); };
const changedScript = commit("Change pinned acceptance script");
assert.throws(() => assertPinnedNpmScripts(checkout, baseSha, changedScript, ["npm test"]), /script test differs from the accepted base/);
writeFileSync(packagePath, originalPackage);
writeFileSync(join(checkout, ".npmrc"), "fund=true\\n");
const changedConfig = commit("Change pinned package configuration");
assert.throws(() => assertPinnedNpmScripts(checkout, baseSha, changedConfig, [probe], { sourceDeclared: [probe] }), /\\.npmrc differs from the accepted base/);
writeFileSync(join(checkout, ".npmrc"), "fund=false\\n");
commit("Restore pinned package configuration");
`,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.match(run("--help"), /setup --config-only/);
    const setup = JSON.parse(
      run(
        "setup",
        "--config-only",
        "--repository",
        "example/package-smoke",
        "--checkout",
        checkout,
        "--concurrency",
        "1",
        "--config",
        config,
      ),
    );
    assert.equal(setup.status, "configured");
    assert.equal(setup.capacity.concurrency, 1);
    assert.equal(setup.capacityRecommendation.configuredLimitsPreserved, true);
    assert.ok(setup.capacityRecommendation.host.cpus > 0);
    const installedConfig = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(installedConfig.repository, "example/package-smoke");
    assert.equal(installedConfig.checkout, checkout);
    const nativeAnalysis = JSON.parse(
      run(
        "diagnostics",
        "--analyze",
        "--native-tool-content",
        "--json",
        "--objective",
        "1",
        "--config",
        config,
      ),
    );
    assert.equal(
      nativeAnalysis.nativeToolContent,
      "explicit-private-content-read",
    );
    assert.equal(nativeAnalysis.nativeToolActivity.uniqueCalls, null);
    assert.equal(nativeAnalysis.nativeToolActivity.availability, "unavailable");
    const status = run("status", "--objective", "1", "--config", config);
    assert.equal(
      status.split("\n")[0],
      "Objective #1: not started — no Factory run recorded",
    );
    assert.equal(
      status.split("\n")[1],
      `Next: factory run --objective 1 --config '${root}/selected config'"'"'s/factory.json'`,
    );
    // A freshly installed target has no historical provider accounting. The installed
    // observation command must keep that absence visible and require no credentials.
    const summary = JSON.parse(
      run(
        "diagnostics",
        "--objective",
        "1",
        "--summary",
        "--json",
        "--config",
        config,
      ),
    );
    assert.equal(summary.outcome, "unfinished");
    assert.equal(summary.bindings.runId, null);
    assert.equal(
      summary.combinedUsage.coverage.byCategory.inputTokens,
      "unavailable",
    );
    assert.equal(summary.efficiency.tokens.worker.inputTokens, null);

    const scanner = join(installedRoot, "dist", "execution", "secret-scan.js");
    const descriptor = JSON.stringify({
      rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
    });
    const fixture = join(root, "scanner-input.txt");
    writeFileSync(fixture, "Public credential-free scanner input.\n");
    const clean = spawnSync(process.execPath, [scanner, fixture, descriptor], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
    const syntheticSecret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(fixture, `GITHUB_TOKEN=${syntheticSecret}\n`);
    const refused = spawnSync(
      process.execPath,
      [scanner, fixture, descriptor],
      {
        encoding: "utf8",
      },
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stdout, /@secretlint\/secretlint-rule-github/);
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes(syntheticSecret));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
