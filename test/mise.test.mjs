// The service's toolchain from the checkout's mise pins (toolchain.ts), with
// a fake mise on the PATH that logs every call: setup reads the pins in the
// checkout, `--background` puts their bin directories first on the PATH,
// readiness says which tools came from mise and names `mise trust` or
// `mise install` when a pin can't be used. Factory never installs or trusts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { observeLocalExecutables } from "../dist/planning/executables.js";
import { unitName, unitText } from "../dist/systemd.js";
import {
  miseManages,
  misePinFix,
  miseToolchain,
  toolchainPath,
} from "../dist/toolchain.js";
import {
  cli,
  closedPort,
  configured,
  installation,
  REPO,
  tempDir,
} from "./helpers.mjs";

const NODE = process.versions.node;

/**
 * A fake mise in its own directory. `ls --current --json` prints
 * `ls.json`, or refuses an untrusted configuration when `untrusted`
 * exists; `bin-paths TOOL@VERSION` prints `bins/TOOL@VERSION`. Every call
 * is logged as `cwd|MISE_YES|args`.
 */
function fakeMise() {
  const root = tempDir("factory-mise-");
  const bin = join(root, "bin");
  mkdirSync(join(root, "bins"), { recursive: true });
  mkdirSync(bin);
  const log = join(root, "log");
  writeFileSync(
    join(bin, "mise"),
    `#!/bin/sh
printf '%s|%s|%s\\n' "$(pwd -P)" "\${MISE_YES-unset}" "$*" >> '${log}'
case "$1" in
  ls)
    if [ -e '${root}/untrusted' ]; then
      echo "mise ERROR error parsing config file: $(pwd -P)/mise.toml" >&2
      echo "mise ERROR Config files in $(pwd -P)/mise.toml are not trusted." >&2
      echo "Trust them with \\\`mise trust\\\`. See https://mise.jdx.dev/cli/trust.html for more information." >&2
      exit 1
    fi
    cat '${root}/ls.json' ;;
  bin-paths) cat "${root}/bins/$2" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  // A pinned node: this test's own, where mise installs it.
  const nodeBin = join(root, "mise", "installs", "node", NODE, "bin");
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(process.execPath, join(nodeBin, "node"));
  writeFileSync(join(root, "bins", `node@${NODE}`), `${nodeBin}\n`);
  const pins = (
    checkout,
    {
      untrusted = false,
      pnpm = false,
      system = false,
      node = { version: NODE, installed: true },
    } = {},
  ) => {
    const source = join(realpathSync(checkout), "mise.toml");
    const entry = (version, installed, path = source) => [
      {
        version,
        requested_version: version,
        install_path: join(root, "installs", "x", version),
        source: { type: "mise.toml", path },
        installed,
        active: installed,
      },
    ];
    writeFileSync(
      join(root, "ls.json"),
      JSON.stringify({
        node: entry(node.version, node.installed),
        // A global pin is the operator's own, not the checkout's.
        jq: entry("1.7.1", true, join(root, "config", "config.toml")),
        ...(pnpm ? { pnpm: entry("12.9.1", false) } : {}),
        // `system` leaves the tool to the PATH: neither installed nor missing.
        ...(system ? { python: entry("system", true) } : {}),
      }),
    );
    if (untrusted) writeFileSync(join(root, "untrusted"), "");
    else rmSync(join(root, "untrusted"), { force: true });
    return source;
  };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("|"))
      : [];
  return { bin, nodeBin, log, pins, calls };
}

/** PATH without any real mise or its shims, so only a fake one is found. */
const withoutMise = (path) =>
  path
    .split(delimiter)
    .filter(
      (entry) =>
        !existsSync(join(entry, "mise")) && !/\/mise\/shims\/?$/.test(entry),
    )
    .join(delimiter);

test("the checkout's mise pins resolve in the checkout, global pins and missing tools apart; mise never installs or trusts", () => {
  const mise = fakeMise();
  const checkout = tempDir("factory-mise-checkout-");
  const path = process.env.PATH;
  try {
    process.env.PATH = `${mise.bin}:${withoutMise(path)}`;
    // No mise configuration: mise doesn't manage it.
    assert.equal(miseManages(checkout), false);
    assert.equal(miseToolchain(checkout), undefined);
    assert.equal(misePinFix(checkout), undefined);
    // A conf.d directory is a mise configuration too.
    mkdirSync(join(checkout, ".config", "mise", "conf.d"), { recursive: true });
    assert.equal(miseManages(checkout), true);
    rmSync(join(checkout, ".config"), { recursive: true });
    const source = mise.pins(checkout, { pnpm: true, system: true });
    writeFileSync(join(checkout, "mise.toml"), "[tools]\n");
    assert.equal(miseManages(checkout), true);
    const toolchain = miseToolchain(checkout);
    assert.deepEqual(toolchain, {
      status: "resolved",
      tools: [{ name: "node", version: NODE, source, bins: [mise.nodeBin] }],
      missing: [{ name: "pnpm", version: "12.9.1", source, bins: [] }],
    });
    assert.match(
      misePinFix(checkout),
      /mise install.*factory setup --background/,
    );
    // In the checkout, with MISE_YES=0, and only reads.
    assert.deepEqual(mise.calls(), [
      [realpathSync(checkout), "0", "ls --current --json"],
      [realpathSync(checkout), "0", `bin-paths node@${NODE}`],
    ]);
    // Its bin directories go first, once.
    assert.equal(
      toolchainPath(`/usr/bin:${mise.nodeBin}:/bin`, toolchain.tools),
      `${mise.nodeBin}:/usr/bin:/bin`,
    );

    mise.pins(checkout, { untrusted: true });
    assert.deepEqual(miseToolchain(checkout), {
      status: "untrusted",
      file: join(realpathSync(checkout), "mise.toml"),
    });

    // Without mise on the PATH, nothing changes.
    process.env.PATH = withoutMise(path);
    assert.equal(miseManages(checkout), false);
    assert.equal(miseToolchain(checkout), undefined);
  } finally {
    process.env.PATH = path;
  }
  assert.doesNotMatch(
    readFileSync(mise.log, "utf8"),
    /\|(install|trust|use|exec|x)( |$)/m,
  );
});

test("setup reads the checkout's mise pins: --background puts them first on the service's PATH, and readiness names mise trust and mise install", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const checkout = join(inst.root, "checkout");
  // The pin the PATH's node never satisfies, so its detail names the node.
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ engines: { node: "<1" } }),
  );
  writeFileSync(join(checkout, "mise.toml"), `[tools]\nnode = "${NODE}"\n`);
  const mise = fakeMise();
  const source = mise.pins(checkout);
  inst.env.PATH = `${mise.bin}:${withoutMise(process.env.PATH)}`;
  const checks = (...args) => {
    const report = JSON.parse(cli(inst, "setup", ...args, "--json").out);
    return (report.setup ?? report).readiness.checks;
  };
  const named = (all, name) => all.filter((check) => check.name === name);

  const foreground = checks();
  assert.deepEqual(named(foreground, "mise toolchain"), [
    {
      name: "mise toolchain",
      status: "ok",
      detail: `node ${NODE} from mise (${source}): factory setup --background puts them first on the service's PATH`,
    },
  ]);
  const [pin] = named(foreground, "node version");
  assert.match(pin.fix, /mise install/);
  assert.match(pin.fix, /factory setup --background/);

  const background = checks("--background");
  assert.deepEqual(named(background, "mise toolchain"), [
    {
      name: "mise toolchain",
      status: "ok",
      detail: `node ${NODE} from mise (${source}): first on the service's PATH (${mise.nodeBin})`,
    },
  ]);
  // Readiness checks the PATH the unit would get: mise's node first.
  const [served] = named(background, "node version");
  assert.match(served.detail, new RegExp(`\\(${mise.nodeBin}/node\\)`));

  mise.pins(checkout, { pnpm: true });
  const missing = named(checks("--background"), "mise toolchain");
  assert.equal(missing.length, 2, JSON.stringify(missing));
  assert.equal(missing[1].status, "warn");
  assert.match(
    missing[1].detail,
    /pnpm 12\.9\.1, pinned in .*mise\.toml, isn't installed/,
  );
  assert.equal(
    missing[1].fix,
    `Run \`mise install\` in ${checkout}, then repeat`,
  );

  mise.pins(checkout, { untrusted: true });
  const [untrusted] = named(checks("--background"), "mise toolchain");
  assert.equal(untrusted.status, "warn");
  assert.match(
    untrusted.fix,
    new RegExp(`mise trust ${join(realpathSync(checkout), "mise.toml")}`),
  );
  const [unpinned] = named(checks("--background"), "node version");
  assert.equal(
    unpinned.detail.includes(mise.nodeBin),
    false,
    "an untrusted configuration puts nothing on the PATH",
  );
  for (const [cwd, yes, args] of mise.calls()) {
    assert.equal(cwd, realpathSync(checkout));
    assert.equal(yes, "0");
    assert.match(args, /^(ls --current --json|bin-paths \S+)$/);
  }

  // Without mise, nothing changes.
  inst.env.PATH = withoutMise(process.env.PATH);
  const plain = checks("--background");
  assert.deepEqual(named(plain, "mise toolchain"), []);
  assert.equal(
    named(plain, "node version")[0].fix,
    "Put a matching node first on the PATH the service runs with, or change the pin",
  );
});

test("--background that would drop the unit's mise install names mise's fix: mise install, mise trust, or mise on the PATH; a moved pin goes through", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const checkout = join(inst.root, "checkout");
  writeFileSync(join(checkout, "mise.toml"), '[tools]\nnode = "24.99.0"\n');
  const mise = fakeMise();
  inst.env.PATH = `${mise.bin}:${withoutMise(process.env.PATH)}`;
  const units = tempDir("factory-units-");
  inst.env.XDG_CONFIG_HOME = units;
  mkdirSync(join(units, "systemd", "user"), { recursive: true });
  // The unit an earlier setup wrote, with the node the pin named then.
  const oldNode = join(
    tempDir("factory-old-"),
    "mise",
    "installs",
    "node",
    "24.21.0",
    "bin",
  );
  mkdirSync(oldNode, { recursive: true });
  const unit = () =>
    writeFileSync(
      join(
        units,
        "systemd",
        "user",
        unitName({ root: realpathSync(inst.root) }),
      ),
      unitText(REPO, [], {
        node: process.execPath,
        env: { PATH: `${oldNode}:${inst.env.PATH}`, HOME: inst.env.HOME },
      }),
    );
  unit();
  const background = () =>
    JSON.parse(cli(inst, "setup", "--background", "--json").out).setup;
  const refusal = () => {
    const setup = background();
    assert.equal(setup.status, "refused", JSON.stringify(setup));
    assert.equal(setup.problems.length, 1, setup.problems.join("\n"));
    assert.match(
      setup.problems[0],
      new RegExp(
        `^The service's PATH would lose ${oldNode}, mise's install of node: `,
      ),
    );
    // Never toolchain.path, which would hold the old node past the pin.
    assert.doesNotMatch(setup.problems[0], /toolchain/);
    return setup.problems[0];
  };

  // The pin moved, and the new version isn't installed.
  const source = mise.pins(checkout, {
    node: { version: "24.99.0", installed: false },
  });
  assert.match(
    refusal(),
    new RegExp(
      `node 24\\.99\\.0, pinned in ${source}, isn't installed: run \`mise install\` in ${checkout}, then repeat`,
    ),
  );

  mise.pins(checkout, { untrusted: true });
  assert.match(
    refusal(),
    new RegExp(
      `run \`mise trust ${join(realpathSync(checkout), "mise.toml")}\``,
    ),
  );

  // Installed: the moved pin replaces the old install, so nothing is lost.
  mise.pins(checkout);
  const moved = background();
  assert.notEqual(moved.status, "refused", JSON.stringify(moved.problems));

  // No mise on this shell's PATH: the pins can't come first.
  inst.env.PATH = withoutMise(process.env.PATH);
  unit();
  assert.match(
    refusal(),
    /mise isn't on this shell's PATH, so setup can't put .*'s pins first: run setup from a shell that has mise on its PATH/,
  );
});

test("the Objective check's Node pin mismatch names mise install and setup --background when mise manages the checkout", async () => {
  const directory = tempDir("factory-mise-pin-");
  const git = (...args) =>
    assert.equal(spawnSync("git", ["-C", directory, ...args]).status, 0);
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ engines: { node: "<1" } }),
  );
  writeFileSync(join(directory, "mise.toml"), '[tools]\nnode = "0.1.0"\n');
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pin");
  const observe = () =>
    observeLocalExecutables({
      checkout: directory,
      base: "HEAD",
      blocks: [],
      finalCommands: ["npm test"],
    });
  const path = process.env.PATH;
  const mise = fakeMise();
  try {
    process.env.PATH = `${mise.bin}:${withoutMise(path)}`;
    const managed = await observe();
    assert.equal(managed.problems.length, 1, managed.problems.join("\n"));
    assert.match(
      managed.problems[0],
      new RegExp(
        `but node on this host is ${NODE} .*mise manages ${directory}: bring it up to date with the default branch, run \`mise install\` there, then \`factory setup --background\`, so the service runs the new pin; or change the pin\\.$`,
      ),
    );
    process.env.PATH = withoutMise(path);
    const plain = await observe();
    assert.match(
      plain.problems[0],
      /Put a matching node first on the service's PATH, or change the pin\.$/,
    );
  } finally {
    process.env.PATH = path;
  }
  // Planning never asks mise anything.
  assert.deepEqual(mise.calls(), []);
});
