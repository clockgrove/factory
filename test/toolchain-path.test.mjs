// The service's PATH keeps toolchains mise doesn't pin (#2182): setup puts
// toolchain.path on the unit's PATH after the mise pins, refuses a
// --background that would drop a directory the installed unit has unless
// --drop-path is given, and readiness checks toolchain.executables on the
// PATH the unit will run with.
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { freezeConfig } from "../dist/providers/selection.js";
import { toolchainChecks } from "../dist/readiness.js";
import { unitName, unitText } from "../dist/systemd.js";
import {
  droppedDirectories,
  onPathOf,
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

/** A directory holding an executable `name` that prints nothing. */
function toolDirectory(name, root = tempDir("factory-toolchain-")) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(bin, name), 0o755);
  return bin;
}

test("toolchain.path goes after the mise pins and before the shell's PATH, each directory once", () => {
  const mise = [
    { name: "node", version: "24.0.0", source: "/x", bins: ["/m/node"] },
  ];
  assert.equal(
    toolchainPath("/usr/bin:/opt/pg/bin:/bin", mise, [
      "/opt/pg/bin",
      "/opt/tofu",
    ]),
    "/m/node:/opt/pg/bin:/opt/tofu:/usr/bin:/bin",
  );
  // Without pins or toolchain.path, the shell's PATH as it is.
  assert.equal(toolchainPath("/usr/bin:/bin", []), "/usr/bin:/bin");
  assert.equal(toolchainPath(undefined, [], ["/opt/pg/bin"]), "/opt/pg/bin");
});

test("a directory the unit's PATH has and the new PATH lacks is dropped, unless it is gone or a moved mise pin", () => {
  const root = tempDir("factory-dropped-");
  const pg = join(root, "postgresql-18.6", "bin");
  const oldNode = join(root, "mise", "installs", "node", "24.21.0", "bin");
  const newNode = join(root, "mise", "installs", "node", "24.22.0", "bin");
  const pnpm = join(root, "mise", "installs", "pnpm", "12.9.1");
  for (const directory of [pg, oldNode, newNode, pnpm])
    mkdirSync(directory, { recursive: true });
  const gone = join(root, "removed", "bin");
  const before = [
    oldNode,
    pnpm,
    pg,
    gone,
    "relative/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  // The node pin moved, pnpm lost its pin, pg isn't on the new PATH, and
  // a directory that no longer exists (or isn't absolute) can't be needed.
  assert.deepEqual(droppedDirectories(before, `${newNode}:/usr/bin:/bin`), [
    pnpm,
    pg,
  ]);
  assert.deepEqual(
    droppedDirectories(before, `${newNode}:${pnpm}:${pg}:/usr/bin`),
    [
      // `/bin` is a directory the new PATH lacks too.
      "/bin",
    ],
  );
  assert.deepEqual(droppedDirectories(before, before), []);
});

test("toolchain checks: a toolchain.path entry that isn't a directory warns, a missing executable blocks, and both are read on the service's PATH", () => {
  const bin = toolDirectory("pg_ctl");
  const missingDirectory = join(tempDir("factory-gone-"), "bin");
  assert.deepEqual(
    toolchainChecks({ path: [], executables: [] }, "/usr/bin"),
    [],
  );
  assert.equal(onPathOf("pg_ctl", `relative:${bin}`), join(bin, "pg_ctl"));
  assert.equal(onPathOf("pg_ctl", "/usr/bin:/bin"), undefined);

  const found = toolchainChecks(
    { path: [bin], executables: ["pg_ctl"] },
    `${bin}:/usr/bin:/bin`,
  );
  assert.deepEqual(found, [
    {
      name: "toolchain",
      status: "ok",
      detail: `${bin} on the service's PATH after the mise pins; found pg_ctl (${join(bin, "pg_ctl")})`,
    },
  ]);

  const missing = toolchainChecks(
    { path: [bin, missingDirectory], executables: ["pg_ctl", "tofu"] },
    `${bin}:${missingDirectory}:/usr/bin:/bin`,
  );
  assert.deepEqual(
    missing.map(({ status }) => status),
    ["warn", "blocked"],
  );
  assert.match(
    missing[0].detail,
    new RegExp(`${missingDirectory}, which isn't a directory`),
  );
  assert.equal(
    missing[1].detail,
    "Not on the PATH the service runs with: tofu (toolchain.executables), so validation that starts it fails",
  );
  assert.match(missing[1].fix, /factory setup --toolchain-path DIR/);
});

test("setup saves --toolchain-path and --toolchain-executable, refuses values that can't be PATH entries or names, and readiness finds them on the service's PATH", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const bin = toolDirectory("pg_ctl");
  const config = () =>
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  const setup = (...args) => {
    const result = cli(inst, "setup", ...args, "--json");
    return { ...result, report: JSON.parse(result.out) };
  };

  const saved = setup(
    "--toolchain-path",
    bin,
    "--toolchain-executable",
    "pg_ctl",
    "--toolchain-executable",
    "tofu",
  );
  assert.deepEqual(saved.report.changed, [
    "toolchain.path",
    "toolchain.executables",
  ]);
  assert.deepEqual(config().toolchain, {
    path: [bin],
    executables: ["pg_ctl", "tofu"],
  });
  // pg_ctl is only in toolchain.path, not on this shell's PATH: readiness
  // reads the PATH the service would run with. tofu is nowhere.
  const [check] = saved.report.readiness.checks.filter(
    ({ name }) => name === "toolchain",
  );
  assert.equal(check.status, "blocked", JSON.stringify(check));
  assert.match(check.detail, /: tofu \(toolchain\.executables\)/);
  assert.doesNotMatch(check.detail, /pg_ctl/);

  for (const [args, problem] of [
    [["--toolchain-path", "relative/bin"], /toolchain\.path must be absolute/],
    [
      ["--toolchain-path", "/opt/a:/opt/b"],
      /toolchain\.path must be distinct directories, each without a colon/,
    ],
    [
      ["--toolchain-executable", "/usr/bin/pg_ctl"],
      /toolchain\.executables must be distinct executable names/,
    ],
  ]) {
    const refused = setup(...args);
    assert.equal(refused.report.status, "refused", refused.out);
    assert.match(refused.report.problems.join("\n"), problem);
  }
  assert.deepEqual(config().toolchain, {
    path: [bin],
    executables: ["pg_ctl", "tofu"],
  });

  // --drop-path only means something to the background service.
  const usage = cli(inst, "setup", "--drop-path");
  assert.equal(usage.code, 2, usage.err);
  assert.match(usage.err, /--drop-path .*: give --background/);
});

test("--background refuses a PATH that would drop a directory the unit has now, names it and how to keep it; toolchain.path or --drop-path lets it through", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const units = tempDir("factory-units-");
  inst.env.XDG_CONFIG_HOME = units;
  mkdirSync(join(units, "systemd", "user"), { recursive: true });
  const unit = join(
    units,
    "systemd",
    "user",
    unitName({ root: realpathSync(inst.root) }),
  );
  // The unit as an earlier setup wrote it from a shell that had the
  // toolchain; this shell doesn't.
  const pg = toolDirectory("pg_ctl");
  const shell = inst.env.PATH;
  assert.equal(shell.split(":").includes(pg), false);
  writeFileSync(
    unit,
    unitText(REPO, [], {
      node: process.execPath,
      env: { PATH: `${pg}:${shell}`, HOME: inst.env.HOME },
    }),
  );
  const written = readFileSync(unit, "utf8");
  const before = readFileSync(inst.env.FACTORY_CONFIG, "utf8");
  const background = (...args) => {
    const result = cli(inst, "setup", "--background", ...args, "--json");
    return JSON.parse(result.out);
  };

  // An unrelated change, from the shell without the toolchain: refused,
  // and nothing is saved.
  const refused = background("--poll-seconds", "7");
  assert.equal(refused.status, "blocked");
  assert.equal(refused.setup.status, "refused", JSON.stringify(refused));
  assert.deepEqual(refused.setup.problems, [
    `The service's PATH would lose ${pg}: the unit has it now, and neither toolchain.path nor this shell's PATH does. Keep it with --toolchain-path ${pg} (saved in toolchain.path, so every later setup keeps it), or run setup from a shell that has it on its PATH; or give --drop-path to drop it`,
  ]);
  assert.equal(readFileSync(inst.env.FACTORY_CONFIG, "utf8"), before);
  assert.equal(readFileSync(unit, "utf8"), written, "the unit is untouched");

  // The text report names it too.
  const text = cli(inst, "setup", "--background", "--poll-seconds", "7");
  assert.equal(text.code, 1);
  assert.match(text.out, new RegExp(`The service's PATH would lose ${pg}`));

  // Kept in the configuration: no refusal, and readiness sees it on the
  // service's PATH. (The fake GitHub is closed, so setup stays blocked.)
  const kept = background(
    "--poll-seconds",
    "7",
    "--toolchain-path",
    pg,
    "--toolchain-executable",
    "pg_ctl",
  );
  assert.notEqual(
    kept.setup.status,
    "refused",
    JSON.stringify(kept.setup.problems),
  );
  assert.doesNotMatch(kept.setup.problems.join("\n"), /would lose/);
  assert.deepEqual(
    kept.setup.readiness.checks.find(({ name }) => name === "toolchain"),
    {
      name: "toolchain",
      status: "ok",
      detail: `${pg} on the service's PATH after the mise pins; found pg_ctl (${join(pg, "pg_ctl")})`,
    },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8")).toolchain,
    {
      path: [pg],
      executables: ["pg_ctl"],
    },
  );
  // A later setup for something else keeps it.
  const later = background("--poll-seconds", "8");
  assert.notEqual(
    later.setup.status,
    "refused",
    JSON.stringify(later.setup.problems),
  );

  // A second toolchain only on the unit's PATH: the fix it names keeps
  // toolchain.path's entries too, since the list given replaces the list.
  const tofu = toolDirectory("tofu");
  writeFileSync(
    unit,
    unitText(REPO, [], {
      node: process.execPath,
      env: { PATH: `${pg}:${tofu}:${shell}`, HOME: inst.env.HOME },
    }),
  );
  const second = background();
  assert.equal(second.setup.status, "refused");
  assert.match(
    second.setup.problems[0],
    new RegExp(
      `would lose ${tofu}: .* Keep it with --toolchain-path ${pg} --toolchain-path ${tofu} \\(`,
    ),
  );

  // Dropped on purpose: the operator's explicit choice.
  writeFileSync(
    inst.env.FACTORY_CONFIG,
    JSON.stringify({ ...JSON.parse(before), toolchain: undefined }),
  );
  const dropped = background("--drop-path");
  assert.notEqual(
    dropped.setup.status,
    "refused",
    JSON.stringify(dropped.setup.problems),
  );
  assert.doesNotMatch(dropped.setup.problems.join("\n"), /would lose/);
});

test("--background with a missing toolchain executable prints the blocked check", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      toolchain: { executables: ["factory-no-such-tool"] },
    },
  );
  inst.env.XDG_CONFIG_HOME = tempDir("factory-units-");
  const result = cli(inst, "setup", "--background");
  assert.equal(result.code, 1);
  assert.match(
    result.out,
    /BLOCKED toolchain: Not on the PATH the service runs with: factory-no-such-tool \(toolchain\.executables\)/,
  );
  assert.match(result.out, /factory setup --toolchain-path DIR/);
});

test("toolchain is operational: an Objective doesn't freeze it, so changing it holds nothing", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      FACTORY_CONFIG: inst.env.FACTORY_CONFIG,
      FACTORY_STATE_DIR: inst.env.FACTORY_STATE_DIR,
    });
    const without = freezeConfig(loadConfig(REPO), "codex");
    const raw = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
    writeFileSync(
      inst.env.FACTORY_CONFIG,
      JSON.stringify({
        ...raw,
        toolchain: { path: ["/opt/pg/bin"], executables: ["pg_ctl"] },
      }),
    );
    const loaded = loadConfig(REPO);
    assert.deepEqual(loaded.toolchain, {
      path: ["/opt/pg/bin"],
      executables: ["pg_ctl"],
    });
    const withToolchain = freezeConfig(loaded, "codex");
    assert.equal(withToolchain.digest, without.digest);
    assert.equal("toolchain" in withToolchain.config, false);
  } finally {
    for (const name of ["FACTORY_CONFIG", "FACTORY_STATE_DIR"])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  }
});
