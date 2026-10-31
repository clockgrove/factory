// The package as it ships: what it bundles, the files it packs, and its CLI
// run from where an install puts it. The Release workflow packs the real
// tarball, with the bundled Codex runtime (427 MB), and installs it offline
// as the README does; here only the package's own files are packed, since
// the runtime changes only with the lockfile and gzipping it took most of
// a minute on every run.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const project = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(project, "package.json"), "utf8"),
);

test("every dependency is bundled, so the tarball installs offline", () => {
  assert.deepEqual(
    [...manifest.bundleDependencies].sort(),
    Object.keys(manifest.dependencies).sort(),
  );
});

test("the packed package ships the CLI and its assets, and its installed CLI runs", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-package-"));
  try {
    // The package's own files, packed by npm from its files list, without
    // the bundled dependencies.
    const stage = join(root, "stage");
    mkdirSync(stage);
    for (const path of manifest.files)
      if (existsSync(join(project, path)))
        cpSync(join(project, path), join(stage, path), { recursive: true });
    const { bundleDependencies: _, ...unbundled } = manifest;
    writeFileSync(join(stage, "package.json"), JSON.stringify(unbundled));
    const pack = join(root, "pack");
    mkdirSync(pack);
    const tarball = join(
      pack,
      // npm test built dist; prepack would rebuild it.
      execFileSync(
        "npm",
        ["pack", "--silent", "--ignore-scripts", "--pack-destination", pack],
        { cwd: stage, encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .at(-1),
    );
    const listed = execFileSync("tar", ["tzf", tarball], {
      encoding: "utf8",
    }).split("\n");
    assert.ok(listed.includes("package/dist/cli.js"), "dist ships");
    assert.ok(
      !listed.some((path) => /^package\/(src|test)\//.test(path)),
      "no source or test ships",
    );

    // Where an install puts it, with its dependencies beside it.
    const prefix = join(root, "prefix");
    const installed = join(prefix, "node_modules", "@clockgrove", "factory");
    mkdirSync(installed, { recursive: true });
    execFileSync("tar", [
      "xzf",
      tarball,
      "-C",
      installed,
      "--strip-components=1",
    ]);
    symlinkSync(join(project, "node_modules"), join(installed, "node_modules"));
    for (const path of [
      "plugin/.codex-plugin/plugin.json",
      "plugin/.claude-plugin/plugin.json",
      "plugin/skills/director/SKILL.md",
      "plugin/skills/setup/SKILL.md",
      "plugin/skills/setup/install-cli.mjs",
      "plugin/assets/factory-mark.svg",
      "docs/USER-GUIDE.md",
      "docs/DESIGN.md",
      "docs/reference/setup.md",
      "docs/templates/objective.md",
      "THIRD_PARTY_NOTICES.md",
    ])
      assert.ok(existsSync(join(installed, path)), `missing: ${path}`);

    const cli = join(installed, manifest.bin.factory);
    const env = {
      ...process.env,
      FACTORY_CONFIG: join(root, "config.json"),
      FACTORY_STATE_DIR: join(root, "state"),
    };
    const help = spawnSync(process.execPath, [cli, "help"], {
      encoding: "utf8",
      env,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^ {2}setup /m);

    // The installed CLI finds its own package.json: a target loads, and
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
      process.execPath,
      [cli, "status", "--repo", "example/target", "--capacity", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(loads.status, 0, loads.stderr);
    assert.ok(JSON.parse(loads.stdout).recommendation, loads.stderr);

    rmSync(env.FACTORY_CONFIG);
    const own = spawnSync(
      process.execPath,
      [
        cli,
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
