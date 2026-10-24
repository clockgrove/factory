// The release tarball, packed and installed offline as the README says:
// it ships the core and its assets, and the installed CLI is the core's.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Packing and installing a 170 MB tarball takes about a minute.
test("the packed tarball installs offline and runs the core's CLI", {
  timeout: 300_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "factory-package-"));
  try {
    const project = resolve(import.meta.dirname, "..", "..");
    const pack = join(root, "pack");
    mkdirSync(pack);
    const tarball = join(
      pack,
      // test:core built core/dist; rebuilding it here (prepack) would
      // rewrite modules other tests are loading.
      execFileSync(
        "npm",
        ["pack", "--silent", "--ignore-scripts", "--pack-destination", pack],
        {
          cwd: project,
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n")
        .at(-1),
    );
    const listed = execFileSync("tar", ["tzf", tarball], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 ** 2,
    }).split("\n");
    assert.ok(listed.includes("package/core/dist/cli.js"), "core/dist ships");
    assert.ok(
      !listed.some((path) => /^package\/(dist|src|core\/src)\//.test(path)),
      "neither the old dist nor any source ships",
    );

    const prefix = join(root, "prefix");
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--omit=optional",
        "--ignore-scripts",
        "--prefix",
        prefix,
        tarball,
      ],
      {
        stdio: "pipe",
        env: { ...process.env, npm_config_cache: join(root, "empty-cache") },
      },
    );
    const installed = join(prefix, "node_modules", "@clockgrove", "factory");
    for (const path of [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "skills/director/SKILL.md",
      "skills/setup/SKILL.md",
      "docs/USER-GUIDE.md",
      "docs/DESIGN.md",
      "docs/templates/objective.md",
      "assets/recipes/repository-migration.json",
      "THIRD_PARTY_NOTICES.md",
    ])
      assert.ok(existsSync(join(installed, path)), `missing: ${path}`);

    const cli = join(prefix, "node_modules", ".bin", "factory");
    const env = {
      ...process.env,
      FACTORY_CONFIG: join(root, "config.json"),
      FACTORY_STATE_DIR: join(root, "state"),
    };
    const help = spawnSync(cli, ["help"], { encoding: "utf8", env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^ {2}setup /m);

    // The installed core finds its own package.json: a target loads, and
    // Factory's own repository is refused.
    const checkout = join(root, "target");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    writeFileSync(
      env.FACTORY_CONFIG,
      JSON.stringify({
        repository: "example/target",
        checkout,
        queue: { projectId: "PVT_x" },
      }),
    );
    const loads = spawnSync(
      cli,
      ["status", "--repo", "example/target", "--capacity", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(loads.status, 0, loads.stderr);
    assert.ok(JSON.parse(loads.stdout).recommendation, loads.stderr);

    // The library: a host program imports the installed package, registers
    // a kind the configuration names, and reads the run log's analysis.
    // Only a process that registered the kind serves it.
    writeFileSync(
      env.FACTORY_CONFIG,
      JSON.stringify({
        repository: "example/target",
        checkout,
        queue: { projectId: "PVT_x" },
        providers: {
          host: {
            planner: "host:echo",
            models: {
              planner: { model: "echo-1", effort: "none" },
              reviewer: { model: "echo-1", effort: "none" },
            },
            worker: { kind: "host:echo", greeting: "hi" },
          },
        },
      }),
    );
    const host = join(prefix, "host.mjs");
    copyFileSync(join(import.meta.dirname, "host-program.mjs"), host);
    const ran = spawnSync(
      process.execPath,
      [host, join(installed, "core", "dist", "log.js"), "example/target"],
      {
        encoding: "utf8",
        // The served runs reach no GitHub: every call fails at once.
        env: {
          ...env,
          FACTORY_GITHUB_API: "http://127.0.0.1:9",
          FACTORY_GITHUB_TOKEN: "unused",
          FACTORY_TICK_MS: "50",
        },
        timeout: 60_000,
      },
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), {
      answer: { echo: "hello" },
      worked: "hi",
      call: ["host:echo", "done"],
      content: { request: "hello", response: "echoed" },
      grouped: [[{ provider: "host:echo" }, 1]],
      served: ["service_running", 0, 0],
      ended: ["run-end", "log-health"],
    });
    const served = spawnSync(cli, ["serve", "--repo", "example/target"], {
      encoding: "utf8",
      env,
    });
    assert.equal(served.status, 78, served.stderr);
    assert.match(served.stderr, /hasn't registered providers\.host: host:echo/);
    rmSync(env.FACTORY_CONFIG);
    const own = spawnSync(
      cli,
      [
        "setup",
        "--repo",
        "clockgrove/factory",
        "--checkout",
        checkout,
        "--project-id",
        "PVT_x",
        "--json",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(JSON.parse(own.stdout).status, "refused", own.stderr);
    assert.equal(existsSync(env.FACTORY_CONFIG), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
