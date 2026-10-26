// The setup skill's CLI installer: it installs the plugin's own version, keeps
// a matching installation, and installs nothing from a release file that
// fails verification. Its launcher follows the installed version under one
// PATH line, and stays off workers' PATH. Nothing here reaches the network: a
// fake gh stands in for the release download and the attestation check, and
// npm runs offline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { workerToolchainPath } from "../dist/worktree.js";

const project = resolve(import.meta.dirname, "..");
const installer = join(project, "plugin", "skills", "setup", "install-cli.mjs");
const version = JSON.parse(
  readFileSync(
    join(project, "plugin", ".claude-plugin", "plugin.json"),
    "utf8",
  ),
).version;
const tarballName = (v) => `clockgrove-factory-${v}.tgz`;

/** A prefix as npm leaves it, holding Factory `installed`. */
function prefixWith(prefix, installed) {
  const root = join(prefix, "node_modules", "@clockgrove", "factory");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "cli.js"), "");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@clockgrove/factory", version: installed }),
  );
  mkdirSync(join(prefix, "node_modules", ".bin"));
  symlinkSync(
    "../@clockgrove/factory/dist/cli.js",
    join(prefix, "node_modules", ".bin", "factory"),
  );
  return root;
}

const installedVersion = (prefix) =>
  JSON.parse(
    readFileSync(
      join(prefix, "node_modules", "@clockgrove", "factory", "package.json"),
      "utf8",
    ),
  ).version;

/** A gh that logs its arguments and exits `status`. */
function fakeGh(root, status) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho "$*" >> '${log}'\nexit ${status}\n`,
    { mode: 0o755 },
  );
  return { bin, log };
}

/** Release files for `v` in a new directory, as the release workflow writes them. */
function release(root, v, content, digest) {
  const dir = join(root, "release");
  mkdirSync(dir);
  const file = join(dir, tarballName(v));
  if (typeof content === "string") writeFileSync(file, content);
  else copyFileSync(content.tarball, file);
  const sum =
    digest ?? createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${sum}  ./${tarballName(v)}\n`);
  return dir;
}

function install(args, { script = installer, env = process.env } = {}) {
  const run = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
  });
  assert.ok(run.stdout, run.stderr);
  return { status: run.status, report: JSON.parse(run.stdout) };
}

function withRoot(body) {
  const root = mkdtempSync(join(tmpdir(), "factory-install-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the installer keeps a CLI of the plugin's own version and links it alone in bin", () =>
  withRoot((root) => {
    const prefix = join(root, "prefix");
    const installed = prefixWith(prefix, version);
    const { status, report } = install(["--prefix", prefix]);
    assert.equal(status, 0);
    assert.deepEqual(report, {
      status: "current",
      version,
      cli: join(prefix, "bin", "factory"),
      path: `export PATH="${join(prefix, "bin")}:$PATH"`,
      sdks: {
        "@anthropic-ai/claude-agent-sdk": false,
        "@github/copilot-sdk": false,
      },
    });
    assert.equal(
      realpathSync(report.cli),
      realpathSync(join(installed, "dist", "cli.js")),
    );
  }));

test("the installer takes its version from the plugin's own manifests", () =>
  withRoot((root) => {
    // A copy of the plugin whose manifests name another release.
    const plugin = join(root, "plugin");
    mkdirSync(join(plugin, "skills", "setup"), { recursive: true });
    const script = join(plugin, "skills", "setup", "install-cli.mjs");
    copyFileSync(installer, script);
    const manifests = (claude, codex) => {
      for (const [dir, v] of [
        [".claude-plugin", claude],
        [".codex-plugin", codex],
      ]) {
        mkdirSync(join(plugin, dir), { recursive: true });
        writeFileSync(
          join(plugin, dir, "plugin.json"),
          JSON.stringify({ name: "factory", version: v }),
        );
      }
    };
    const prefix = join(root, "prefix");
    prefixWith(prefix, "9.8.7");

    manifests("9.8.7", "9.8.7");
    const kept = install(["--prefix", prefix], { script });
    assert.equal(kept.status, 0);
    assert.equal(kept.report.status, "current");
    assert.equal(kept.report.version, "9.8.7");

    manifests("9.8.7", "9.8.8");
    const split = install(["--prefix", prefix], { script });
    assert.equal(split.status, 1);
    assert.equal(split.report.status, "refused");
    assert.match(split.report.problems[0], /no single version/);
  }));

test("with no prefix, the installer keeps a matching CLI on PATH and downloads nothing", () =>
  withRoot((root) => {
    const own = join(root, "own");
    const installed = prefixWith(own, version);
    const bin = join(root, "path-bin");
    mkdirSync(bin);
    symlinkSync(join(installed, "dist", "cli.js"), join(bin, "factory"));
    // No gh or npm on PATH: any download or install would be refused.
    const { status, report } = install([], {
      env: {
        PATH: bin,
        HOME: join(root, "home"),
        XDG_DATA_HOME: join(root, "data"),
      },
    });
    assert.equal(status, 0, JSON.stringify(report));
    assert.equal(report.status, "current");
    assert.equal(report.cli, join(bin, "factory"));
    assert.equal(report.path, null);
    assert.equal(existsSync(join(root, "data")), false);
  }));

/** A copy of the plugin whose manifests both name `v`; its installer's path. */
function pluginOf(root, v) {
  const plugin = join(root, `plugin-${v}`);
  mkdirSync(join(plugin, "skills", "setup"), { recursive: true });
  for (const dir of [".claude-plugin", ".codex-plugin"]) {
    mkdirSync(join(plugin, dir));
    writeFileSync(
      join(plugin, dir, "plugin.json"),
      JSON.stringify({ name: "factory", version: v }),
    );
  }
  const script = join(plugin, "skills", "setup", "install-cli.mjs");
  copyFileSync(installer, script);
  return script;
}

/**
 * Default installs of 9.8.7 and 9.8.8 under `root`/data: their prefixes,
 * each holding that version, the shared launcher, and a run of the plugin
 * of version `v`.
 */
function versions(root) {
  const data = join(root, "data", "clockgrove-factory");
  const each = (make) =>
    Object.fromEntries(["9.8.7", "9.8.8"].map((v) => [v, make(v)]));
  const installed = each((v) => prefixWith(join(data, v), v));
  const scripts = each((v) => pluginOf(root, v));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
  };
  return {
    data,
    installed,
    bin: join(data, "bin"),
    run: (v, path = env.PATH) =>
      install([], { script: scripts[v], env: { ...env, PATH: path } }),
  };
}

test("the launcher follows each installed version under one PATH line", () =>
  withRoot((root) => {
    const { data, installed, bin, run } = versions(root);
    const lines = new Set();
    for (const v of ["9.8.7", "9.8.8", "9.8.7"]) {
      const { status, report } = run(v);
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.version, v);
      assert.equal(report.cli, join(bin, "factory"));
      assert.equal(
        realpathSync(report.cli),
        realpathSync(join(installed[v], "dist", "cli.js")),
      );
      // Only the launcher, in bin and beside it: no link left half-made.
      assert.deepEqual(readdirSync(bin), ["factory"]);
      assert.deepEqual(readdirSync(data).sort(), ["9.8.7", "9.8.8", "bin"]);
      lines.add(report.path);
    }
    assert.deepEqual([...lines], [`export PATH="${bin}:$PATH"`]);
  }));

test("the launcher is never missing while it moves to another version", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-install-"));
  try {
    const { bin, run } = versions(root);
    assert.equal(run("9.8.7").status, 0);
    const stop = join(root, "stop");
    // Resolve the launcher and list its directory until told to stop.
    const watcher = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
const [cli, bin, stop] = process.argv.slice(1);
let reads = 0, missing = 0, crowded = 0;
while (!fs.existsSync(stop)) {
  reads++;
  try { fs.realpathSync(cli); } catch { missing++; }
  if (fs.readdirSync(bin).length !== 1) crowded++;
}
console.log(JSON.stringify({ reads, missing, crowded }));`,
        join(bin, "factory"),
        bin,
        stop,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    watcher.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const closed = once(watcher, "close");
    for (let i = 0; i < 4; i++)
      for (const v of ["9.8.8", "9.8.7"]) {
        const { status, report } = run(v);
        assert.equal(status, 0, JSON.stringify(report));
        assert.ok(realpathSync(report.cli).includes(`/${v}/`), report.cli);
      }
    writeFileSync(stop, "");
    await closed;
    const seen = JSON.parse(out);
    assert.ok(seen.reads > 0);
    assert.deepEqual(
      { missing: seen.missing, crowded: seen.crowded },
      { missing: 0, crowded: 0 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installer gives no PATH line when the launcher's directory is on PATH", () =>
  withRoot((root) => {
    const { bin, run } = versions(root);
    const { status, report } = run("9.8.8", `${bin}:${process.env.PATH}`);
    assert.equal(status, 0, JSON.stringify(report));
    assert.equal(report.cli, join(bin, "factory"));
    assert.equal(report.path, null);
  }));

test("workers' PATH leaves out the launcher's directory, whichever version it runs", () =>
  withRoot((root) => {
    const { bin, run } = versions(root);
    assert.equal(run("9.8.8").status, 0);
    // A `factory` alone in its directory that isn't Factory's stays.
    const other = join(root, "other");
    mkdirSync(join(other, "dist"), { recursive: true });
    writeFileSync(join(other, "package.json"), '{"name":"other"}');
    writeFileSync(join(other, "dist", "cli.js"), "");
    const tools = join(root, "tools");
    mkdirSync(tools);
    symlinkSync(join(other, "dist", "cli.js"), join(tools, "factory"));
    assert.equal(
      workerToolchainPath(`${bin}:${tools}:/usr/bin`),
      `${tools}:/usr/bin`,
    );
  }));

test("the installer installs nothing from a tarball that fails its checksum", () =>
  withRoot((root) => {
    // A stale CLI is not kept, and the release files are checked before
    // anything is installed over it.
    const prefix = join(root, "prefix");
    prefixWith(prefix, "0.0.1");
    const gh = fakeGh(root, 0);
    const files = release(root, version, "not the release", "0".repeat(64));
    const { status, report } = install(["--prefix", prefix, "--from", files], {
      env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(status, 1);
    assert.equal(report.status, "refused");
    assert.match(report.problems[0], /doesn't match SHA256SUMS/);
    assert.equal(installedVersion(prefix), "0.0.1");
    assert.equal(readFileSync(gh.log, "utf8"), "");
    assert.equal(existsSync(join(prefix, "bin")), false);
  }));

test("the installer installs nothing from a tarball that fails its attestation", () =>
  withRoot((root) => {
    const prefix = join(root, "prefix");
    prefixWith(prefix, "0.0.1");
    const gh = fakeGh(root, 1);
    const files = release(root, version, "an unattested tarball");
    const { status, report } = install(["--prefix", prefix, "--from", files], {
      env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(status, 1);
    assert.equal(report.status, "refused");
    assert.match(report.problems[0], /build provenance attestation/);
    assert.match(
      readFileSync(gh.log, "utf8"),
      /^attestation verify \S+ --repo clockgrove\/factory$/m,
    );
    assert.equal(installedVersion(prefix), "0.0.1");
  }));

test(
  "the installer replaces a stale CLI with a verified release",
  {
    timeout: 120_000,
  },
  () =>
    withRoot((root) => {
      // A minimal Factory package of the plugin's version, packed as npm does.
      const source = join(root, "source");
      mkdirSync(join(source, "dist"), { recursive: true });
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({
          name: "@clockgrove/factory",
          version,
          bin: { factory: "./dist/cli.js" },
        }),
      );
      writeFileSync(join(source, "dist", "cli.js"), "#!/usr/bin/env node\n");
      const packed = join(root, "packed");
      mkdirSync(packed);
      const env = {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: join(root, "npm-cache"),
      };
      execFileSync(
        "npm",
        ["pack", "--silent", "--ignore-scripts", "--pack-destination", packed],
        { cwd: source, env, stdio: "pipe" },
      );
      const files = release(root, version, {
        tarball: join(packed, tarballName(version)),
      });

      const prefix = join(root, "prefix");
      prefixWith(prefix, "0.0.1");
      const gh = fakeGh(root, 0);
      const { status, report } = install(
        ["--prefix", prefix, "--from", files],
        { env: { ...env, PATH: `${gh.bin}:${process.env.PATH}` } },
      );
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.status, "installed");
      assert.equal(report.cli, join(prefix, "bin", "factory"));
      assert.equal(installedVersion(prefix), version);
      assert.equal(
        realpathSync(report.cli),
        realpathSync(
          join(
            prefix,
            "node_modules",
            "@clockgrove",
            "factory",
            "dist",
            "cli.js",
          ),
        ),
      );
      assert.match(
        readFileSync(gh.log, "utf8"),
        /^attestation verify \S+ --repo clockgrove\/factory$/m,
      );
    }),
);
