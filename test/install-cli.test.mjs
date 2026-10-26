// The setup skill's CLI installer: it installs the plugin's own version, keeps
// a matching installation, and installs nothing from a release file that
// fails verification. Its launcher follows the installed version under one
// PATH line, never back to an older release unless asked, and stays off
// workers' PATH even once the release it runs is deleted, when readiness
// warns of it. Nothing here reaches the network: a fake gh stands in for the
// release download and the attestation check, and npm runs offline.
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
import { launcherChecks } from "../dist/readiness.js";
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

/**
 * A gh that logs its arguments, answers `release view` with the shell
 * command `view`, copies the files in `files` into a `release download`'s
 * --dir and passes the attestation check.
 */
function releaseGh(root, view, files = root) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> '${log}'
case "$1 $2" in
"release view") ${view} ;;
"release download")
  while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done
  cp '${files}'/* "$dir"/ ;;
esac
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

/** A `release view` answer: the release with `assets` ({name, state}). */
const viewAssets = (...assets) =>
  `echo '${JSON.stringify({ assets: assets.map((asset) => ({ state: "uploaded", ...asset })) })}'`;

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

/** A minimal Factory package of version `v`, packed as npm does: its tarball. */
function packed(root, v, env) {
  const source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "@clockgrove/factory",
      version: v,
      bin: { factory: "./dist/cli.js" },
    }),
  );
  writeFileSync(join(source, "dist", "cli.js"), "#!/usr/bin/env node\n");
  const dir = join(root, "packed");
  mkdirSync(dir);
  execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", dir],
    { cwd: source, env, stdio: "pipe" },
  );
  return join(dir, tarballName(v));
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
 * Default installs of `releases` (9.8.7 and 9.8.8) under `root`/data: their
 * prefixes, each holding that version, the shared launcher, and a run of the
 * plugin of version `v` with `args`.
 */
function versions(root, releases = ["9.8.7", "9.8.8"]) {
  const data = join(root, "data", "clockgrove-factory");
  const each = (make) => Object.fromEntries(releases.map((v) => [v, make(v)]));
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
    env,
    scripts,
    run: (v, path = env.PATH, args = []) =>
      install(args, { script: scripts[v], env: { ...env, PATH: path } }),
  };
}

test("the launcher follows each installed version under one PATH line", () =>
  withRoot((root) => {
    const { data, installed, bin, run } = versions(root);
    const lines = new Set();
    for (const v of ["9.8.7", "9.8.8", "9.8.7"]) {
      const { status, report } = run(v, undefined, ["--downgrade"]);
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
        const { status, report } = run(v, undefined, ["--downgrade"]);
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

test("the launcher moves to a newer or the same release, and back only with --downgrade", () =>
  withRoot((root) => {
    const { data, installed, bin, run } = versions(root);
    const launcher = join(bin, "factory");
    const runs = (v) => realpathSync(join(installed[v], "dist", "cli.js"));
    assert.equal(run("9.8.7").status, 0);
    for (const [v, args] of [
      ["9.8.8", []],
      ["9.8.8", []],
      ["9.8.7", ["--downgrade"]],
    ]) {
      const { status, report } = run(v, undefined, args);
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.status, "current");
      assert.equal(report.cli, launcher);
      assert.equal(report.launcher, undefined);
      assert.equal(realpathSync(launcher), runs(v));
    }
    assert.equal(run("9.8.8").status, 0);

    // An older plugin's release is there, but the launcher stays newer.
    const { status, report } = run("9.8.7");
    assert.equal(status, 0, JSON.stringify(report));
    assert.equal(report.status, "current");
    assert.equal(report.version, "9.8.7");
    assert.equal(
      report.cli,
      join(data, "9.8.7", "node_modules", ".bin", "factory"),
    );
    assert.equal(realpathSync(report.cli), runs("9.8.7"));
    assert.equal(report.path, `export PATH="${bin}:$PATH"`);
    assert.deepEqual(report.launcher, {
      cli: launcher,
      version: "9.8.8",
      kept: true,
    });
    assert.equal(realpathSync(launcher), runs("9.8.8"));
    assert.deepEqual(readdirSync(bin), ["factory"]);
  }));

test("the launcher's releases are ordered as semantic versions", () =>
  withRoot((root) => {
    const releases = [
      "9.8.8-rc.1",
      "9.8.8",
      "9.8.9",
      "9.8.10",
      "9.8.11-rc.2",
      "9.8.11-rc.10",
      "9.8.11-beta",
    ];
    const { run } = versions(root, releases);
    // Each run's plugin version, and the newer one the launcher keeps.
    for (const [v, kept] of [
      ["9.8.8-rc.1"],
      ["9.8.8"],
      ["9.8.10"],
      ["9.8.9", "9.8.10"],
      ["9.8.11-rc.2"],
      ["9.8.11-rc.10"],
      ["9.8.11-rc.2", "9.8.11-rc.10"],
      ["9.8.11-beta", "9.8.11-rc.10"],
      ["9.8.8", "9.8.11-rc.10"],
    ]) {
      const { status, report } = run(v);
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.launcher?.version, kept, `${v}: ${kept}`);
    }
  }));

test(
  "an older plugin's release is installed beside a launcher it leaves on a newer one",
  { timeout: 120_000 },
  () =>
    withRoot((root) => {
      const { data, installed, bin, env, scripts, run } = versions(root);
      assert.equal(run("9.8.8").status, 0);
      rmSync(join(data, "9.8.7"), { recursive: true });
      const npmEnv = {
        ...env,
        npm_config_offline: "true",
        npm_config_cache: join(root, "npm-cache"),
      };
      const files = release(root, "9.8.7", {
        tarball: packed(root, "9.8.7", npmEnv),
      });
      const gh = fakeGh(root, 0);
      const { status, report } = install(["--from", files], {
        script: scripts["9.8.7"],
        env: { ...npmEnv, PATH: `${gh.bin}:${process.env.PATH}` },
      });
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.status, "installed");
      assert.equal(
        report.cli,
        join(data, "9.8.7", "node_modules", ".bin", "factory"),
      );
      assert.equal(installedVersion(join(data, "9.8.7")), "9.8.7");
      assert.deepEqual(report.launcher, {
        cli: join(bin, "factory"),
        version: "9.8.8",
        kept: true,
      });
      assert.equal(
        realpathSync(join(bin, "factory")),
        realpathSync(join(installed["9.8.8"], "dist", "cli.js")),
      );
    }),
);

test("a matching CLI on PATH is used, and the launcher kept on a newer release is reported", () =>
  withRoot((root) => {
    const { data, installed, bin, run } = versions(root);
    assert.equal(run("9.8.8").status, 0);
    rmSync(join(data, "9.8.7"), { recursive: true });
    const own = prefixWith(join(root, "own"), "9.8.7");
    const path = join(root, "path-bin");
    mkdirSync(path);
    symlinkSync(join(own, "dist", "cli.js"), join(path, "factory"));
    // No gh or npm on PATH: any download or install would be refused.
    const { status, report } = run("9.8.7", path);
    assert.equal(status, 0, JSON.stringify(report));
    assert.equal(report.status, "current");
    assert.equal(report.cli, join(path, "factory"));
    assert.deepEqual(report.launcher, {
      cli: join(bin, "factory"),
      version: "9.8.8",
      kept: true,
    });
    assert.equal(
      realpathSync(join(bin, "factory")),
      realpathSync(join(installed["9.8.8"], "dist", "cli.js")),
    );
  }));

test("with --prefix, the installer won't replace the launcher's newer release without --downgrade", () =>
  withRoot((root) => {
    const prefix = join(root, "prefix");
    prefixWith(prefix, "9.8.8");
    const env = { ...process.env, XDG_DATA_HOME: join(root, "data") };
    const newer = install(["--prefix", prefix], {
      script: pluginOf(root, "9.8.8"),
      env,
    });
    assert.equal(newer.status, 0, JSON.stringify(newer.report));
    const gh = fakeGh(root, 0);
    const { status, report } = install(["--prefix", prefix], {
      script: pluginOf(root, "9.8.7"),
      env: { ...env, PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(status, 1);
    assert.equal(report.status, "refused");
    assert.match(report.problems[0], /runs Factory 9\.8\.8 .*--downgrade/);
    assert.equal(installedVersion(prefix), "9.8.8");
    assert.equal(readFileSync(gh.log, "utf8"), "");
  }));

test("workers' PATH leaves out a launcher whose release was deleted, and no other broken link", () =>
  withRoot((root) => {
    const { data, bin, run } = versions(root);
    assert.equal(run("9.8.8").status, 0);
    rmSync(join(data, "9.8.8"), { recursive: true });
    assert.equal(existsSync(join(bin, "factory")), false);
    // A --prefix launcher whose package was removed.
    const prefix = join(root, "prefix");
    prefixWith(prefix, version);
    assert.equal(install(["--prefix", prefix]).status, 0);
    rmSync(join(prefix, "node_modules"), { recursive: true });
    // Broken `factory` links alone in a bin, outside the launcher's layout.
    const broken = (name, target) => {
      const dir = join(root, name, "bin");
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, join(dir, "factory"));
      return dir;
    };
    const cli = ["node_modules", "@clockgrove", "factory", "dist", "cli.js"];
    const kept = [
      broken(
        "elsewhere",
        join(root, "gone", "clockgrove-factory", "9.8.8", ...cli),
      ),
      broken("other", join(root, "other", "missing")),
      broken("relative", join("..", "9.8.8", ...cli)),
      "/usr/bin",
    ];
    assert.equal(
      workerToolchainPath([bin, join(prefix, "bin"), ...kept].join(":")),
      kept.join(":"),
    );
  }));

test("readiness warns of a launcher whose release was deleted", () =>
  withRoot((root) => {
    const { data, bin, env, scripts, run } = versions(root);
    assert.equal(run("9.8.8").status, 0);
    const checks = (PATH) => launcherChecks({ ...env, PATH });
    assert.deepEqual(checks(`${bin}:/usr/bin`), []);
    rmSync(join(data, "9.8.8"), { recursive: true });
    // On the PATH under any name, or only at its default place: one warning.
    for (const PATH of [`${bin}:/usr/bin`, `${bin}/:${bin}`, "/usr/bin"]) {
      const found = checks(PATH);
      assert.equal(found.length, 1, JSON.stringify(found));
      assert.equal(found[0].name, "launcher");
      assert.equal(found[0].status, "warn");
      assert.ok(found[0].detail.includes(join(bin, "factory")));
      assert.match(found[0].fix, /setup again/);
      assert.doesNotMatch(found[0].fix, /--prefix/);
    }

    // A --prefix launcher is fixed with that prefix.
    const prefix = join(root, "prefix");
    prefixWith(prefix, "9.8.8");
    assert.equal(
      install(["--prefix", prefix], { script: scripts["9.8.8"], env }).status,
      0,
    );
    rmSync(join(prefix, "node_modules"), { recursive: true });
    const found = checks(`${join(prefix, "bin")}:/usr/bin`);
    assert.deepEqual(
      found.map((check) => check.fix),
      [
        `Run the Factory plugin's setup again (in Claude Code or Codex) with its installer's --prefix ${prefix}: it installs the plugin's CLI and points the launcher at it`,
        "Run the Factory plugin's setup again (in Claude Code or Codex): it installs the plugin's CLI and points the launcher at it",
      ],
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

test("the installer reports a release that isn't published yet, to try again later, and downloads nothing", () => {
  const tarball = tarballName(version);
  for (const [why, view, problem] of [
    [
      "no release for the tag",
      "echo 'release not found' >&2; exit 1",
      new RegExp(`no release v${version.replaceAll(".", "\\.")}\\.`),
    ],
    [
      "no tarball yet",
      viewAssets({ name: "SHA256SUMS" }),
      new RegExp(`doesn't have ${tarball.replaceAll(".", "\\.")} yet`),
    ],
    [
      "the tarball still uploading",
      viewAssets({ name: tarball, state: "starter" }, { name: "SHA256SUMS" }),
      /doesn't have clockgrove-factory-\S+ yet/,
    ],
  ])
    withRoot((root) => {
      const prefix = join(root, "prefix");
      prefixWith(prefix, "0.0.1");
      const gh = releaseGh(root, view);
      const { status, report } = install(["--prefix", prefix], {
        env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
      });
      assert.equal(status, 1, why);
      assert.equal(report.status, "unpublished", why);
      assert.match(report.problems[0], /isn't published yet/, why);
      assert.match(report.problems[0], problem, why);
      assert.match(report.problems[0], /again in a few minutes/, why);
      assert.equal(
        readFileSync(gh.log, "utf8"),
        `release view v${version} --repo clockgrove/factory --json assets\n`,
        why,
      );
      assert.equal(installedVersion(prefix), "0.0.1", why);
      assert.equal(existsSync(join(prefix, "bin")), false, why);
    });
});

test("a release lookup that fails for another reason is refused, not unpublished", () =>
  withRoot((root) => {
    const prefix = join(root, "prefix");
    prefixWith(prefix, "0.0.1");
    const gh = releaseGh(root, "echo 'HTTP 401: Bad credentials' >&2; exit 1");
    const { status, report } = install(["--prefix", prefix], {
      env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(status, 1);
    assert.equal(report.status, "refused");
    assert.match(report.problems[0], /gh is logged in/);
    assert.doesNotMatch(readFileSync(gh.log, "utf8"), /release download/);
    assert.equal(installedVersion(prefix), "0.0.1");
  }));

test(
  "the installer downloads a published release with gh, then verifies and installs it",
  { timeout: 120_000 },
  () =>
    withRoot((root) => {
      const env = {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: join(root, "npm-cache"),
      };
      const files = release(root, version, {
        tarball: packed(root, version, env),
      });
      const prefix = join(root, "prefix");
      const gh = releaseGh(
        root,
        viewAssets({ name: tarballName(version) }, { name: "SHA256SUMS" }),
        files,
      );
      const { status, report } = install(["--prefix", prefix], {
        env: { ...env, PATH: `${gh.bin}:${process.env.PATH}` },
      });
      assert.equal(status, 0, JSON.stringify(report));
      assert.equal(report.status, "installed");
      assert.equal(installedVersion(prefix), version);
      assert.deepEqual(
        readFileSync(gh.log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ").slice(0, 2).join(" ")),
        ["release view", "release download", "attestation verify"],
      );
    }),
);

test(
  "the installer replaces a stale CLI with a verified release",
  {
    timeout: 120_000,
  },
  () =>
    withRoot((root) => {
      const env = {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: join(root, "npm-cache"),
      };
      const files = release(root, version, {
        tarball: packed(root, version, env),
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
