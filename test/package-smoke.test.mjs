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
    writeFileSync(
      join(checkout, "README.md"),
      "# Local package smoke target\n",
    );
    git("add", "README.md");
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
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    };
    const run = (...args) =>
      execFileSync(cli, args, { encoding: "utf8", env: environment });
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
