// The service's PATH keeps toolchains mise doesn't pin (#2182): setup puts
// toolchain.path on the unit's PATH after the mise pins, refuses a
// --background that would drop a directory the installed unit has unless
// --drop-path is given, and readiness checks toolchain.executables on the
// PATH the unit will run with.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { freezeConfig } from "../dist/providers/selection.js";
import { toolchainChecks } from "../dist/readiness.js";
import { lostPathProblems, serviceEnvironment } from "../dist/setup.js";
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
  // `/bin` is lost only where it isn't `/usr/bin`: on a merged-/usr host
  // it links there, and the new PATH has it by that name.
  assert.deepEqual(
    droppedDirectories(before, `${newNode}:${pnpm}:${pg}:/usr/bin`),
    realpathSync("/bin") === realpathSync("/usr/bin") ? [] : ["/bin"],
  );
  assert.deepEqual(droppedDirectories(before, before), []);
  // A link to a directory the new PATH has isn't lost; the link alone is.
  const linked = join(root, "linked-bin");
  symlinkSync(pg, linked);
  assert.deepEqual(
    droppedDirectories(`${linked}:/usr/bin`, `${pg}:/usr/bin`),
    [],
  );
  assert.deepEqual(
    droppedDirectories(`${pg}:/usr/bin`, `${linked}:/usr/bin`),
    [],
  );
  assert.deepEqual(droppedDirectories(`${linked}:/usr/bin`, "/usr/bin"), [
    linked,
  ]);
});

test("the refusal's --toolchain-path flags paste into a shell, and WSL's Windows directories aren't offered toolchain.path", () => {
  const spaced = "/opt/Program Files (x86)/it's/bin";
  const config = {
    checkout: tempDir("factory-lost-checkout-"),
    toolchain: { path: ["/opt/pg/bin"], executables: [] },
  };
  const problems = lostPathProblems(
    [spaced, "/mnt/c/Program Files/nodejs", "/mnt/c/WINDOWS"],
    config,
    undefined,
  );
  assert.equal(problems.length, 2, problems.join("\n"));
  const flags =
    /give (--toolchain-path .*?) \(saved in toolchain\.path, which goes after the mise pins and before the shell's PATH/.exec(
      problems[0],
    )?.[1];
  assert.ok(flags, problems[0]);
  // The flags as a shell reads them back: each directory one word.
  const words = spawnSync("bash", ["-c", `printf '%s\\n' ${flags}`], {
    encoding: "utf8",
  });
  assert.equal(words.status, 0, words.stderr);
  assert.deepEqual(words.stdout.trimEnd().split("\n"), [
    "--toolchain-path",
    "/opt/pg/bin",
    "--toolchain-path",
    spaced,
  ]);
  assert.match(
    problems[0],
    /if the service doesn't need it, give --drop-path$/,
  );
  // Ahead of the shell's PATH, Windows' npm would shadow Linux's.
  assert.equal(
    problems[1],
    "The service's PATH would lose /mnt/c/Program Files/nodejs, /mnt/c/WINDOWS, Windows directories WSL adds to a shell's PATH: the unit has them now, and this shell's PATH doesn't. Run setup from a shell that has them on its PATH, or, if the service doesn't need them, give --drop-path",
  );
});

test("a lost mise install names mise's fix, never toolchain.path", () => {
  const checkout = tempDir("factory-lost-mise-");
  const config = { checkout, toolchain: { path: [], executables: [] } };
  const old = "/home/k/.local/share/mise/installs/node/24.21.0/bin";
  const source = join(checkout, "mise.toml");
  const lost = (toolchain) => {
    const problems = lostPathProblems([old], config, toolchain);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0],
      new RegExp(
        `^The service's PATH would lose ${old}, mise's install of node: the unit has it now, and the PATH setup would write takes no mise install of that tool\\. `,
      ),
    );
    assert.doesNotMatch(problems[0], /toolchain-path|toolchain\.path/);
    assert.match(
      problems[0],
      /; or, to run it from this shell's PATH instead, give --drop-path$/,
    );
    return problems[0];
  };
  const pin = { name: "node", version: "24.99.0", source, bins: [] };
  assert.match(
    lost({ status: "resolved", tools: [], missing: [pin] }),
    new RegExp(
      `node 24\\.99\\.0, pinned in ${source}, isn't installed: run \`mise install\` in ${checkout}, then repeat`,
    ),
  );
  assert.match(
    lost({ status: "untrusted", file: source }),
    new RegExp(`run \`mise trust ${source}\`, then repeat`),
  );
  assert.match(
    lost({ status: "failed", detail: "boom" }),
    /mise can't resolve the checkout's pins \(boom\): run `mise ls --current`/,
  );
  assert.match(
    lost({ status: "resolved", tools: [], missing: [] }),
    new RegExp(`${checkout} no longer pins node`),
  );
  // No mise configuration: nothing pins it now.
  assert.match(lost(undefined), /has no mise configuration now/);
  // A mise configuration, and no mise on this shell's PATH.
  writeFileSync(source, '[tools]\nnode = "24.99.0"\n');
  assert.match(
    lost(undefined),
    /mise isn't on this shell's PATH, so setup can't put .*'s pins first: run setup from a shell that has mise on its PATH/,
  );
});

test("the unit records the service's environment: the mise pins, then toolchain.path, then the shell's PATH, without the logins it doesn't keep", async () => {
  const inst = installation();
  const pg = toolDirectory("pg_ctl");
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    { toolchain: { path: [pg] } },
  );
  const saved = { ...process.env };
  let config;
  try {
    Object.assign(process.env, {
      FACTORY_CONFIG: inst.env.FACTORY_CONFIG,
      FACTORY_STATE_DIR: inst.env.FACTORY_STATE_DIR,
    });
    config = loadConfig(REPO);
  } finally {
    for (const name of ["FACTORY_CONFIG", "FACTORY_STATE_DIR"])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  }
  const nodeBin = "/home/k/.local/share/mise/installs/node/24.0.0/bin";
  const shell = {
    PATH: `/usr/bin:${pg}:/bin`,
    HOME: inst.env.HOME,
    GH_TOKEN: "gho_unkept",
    CODEX_API_KEY: "unkept",
  };
  const pins = {
    status: "resolved",
    tools: [{ name: "node", version: "24.0.0", source: "/x", bins: [nodeBin] }],
    missing: [],
  };
  const environment = serviceEnvironment(config, pins, shell);
  assert.equal(environment.PATH, `${nodeBin}:${pg}:/usr/bin:/bin`);
  assert.equal(environment.HOME, inst.env.HOME);
  for (const name of ["GH_TOKEN", "CODEX_API_KEY"])
    assert.equal(name in environment, false, name);
  assert.equal(
    shell.GH_TOKEN,
    "gho_unkept",
    "the shell's environment is untouched",
  );
  // The PATH line the unit is written with.
  const unit = unitText(REPO, [], { node: process.execPath, env: environment });
  const [line] = unit.split("\n").filter((each) => /PATH=/.test(each));
  assert.match(line, /^Environment=/);
  assert.ok(
    line.includes(`PATH=${nodeBin}:${pg}:/usr/bin:/bin`),
    `${line} has the mise pins, then toolchain.path, then the shell's PATH`,
  );
  assert.doesNotMatch(unit, /gho_unkept/);
  // Pins mise can't resolve add nothing; toolchain.path still comes first.
  for (const toolchain of [
    undefined,
    { status: "untrusted", file: "/x/mise.toml" },
    { status: "failed", detail: "boom" },
  ])
    assert.equal(
      serviceEnvironment(config, toolchain, shell).PATH,
      `${pg}:/usr/bin:/bin`,
    );
});

test("toolchain checks: a toolchain.path entry that isn't a directory warns, a missing executable blocks, and both are read on the service's PATH", () => {
  const bin = toolDirectory("pg_ctl");
  const missingDirectory = join(tempDir("factory-gone-"), "bin");
  const file = "/home/k/.config/factory/o__r.json";
  assert.deepEqual(
    toolchainChecks(
      { path: [], executables: [] },
      { service: "/usr/bin" },
      file,
    ),
    [],
  );
  assert.equal(onPathOf("pg_ctl", `relative:${bin}`), join(bin, "pg_ctl"));
  assert.equal(onPathOf("pg_ctl", "/usr/bin:/bin"), undefined);

  const found = toolchainChecks(
    { path: [bin], executables: ["pg_ctl"] },
    { service: `${bin}:/usr/bin:/bin` },
    file,
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
    { service: `${bin}:${missingDirectory}:/usr/bin:/bin` },
    file,
  );
  assert.deepEqual(
    missing.map(({ status }) => status),
    ["warn", "blocked"],
  );
  assert.match(
    missing[0].detail,
    new RegExp(`${missingDirectory}, which isn't a directory`),
  );
  assert.match(
    missing[0].fix,
    new RegExp(`to drop it, remove it from toolchain\\.path in ${file}$`),
  );
  assert.equal(
    missing[1].detail,
    "Not on the PATH the service runs with: tofu (toolchain.executables), so validation that starts it fails",
  );
  // A toolchain removed on purpose: setup can't empty the list, so the fix
  // names the file.
  assert.equal(
    missing[1].fix,
    `Install it, or add its directory to the service's PATH with factory setup --toolchain-path DIR... (kept in toolchain.path, after the mise pins and before the shell's PATH); if the service no longer needs it, remove it from toolchain.executables in ${file}`,
  );
});

test("toolchain checks without --background read the installed unit's PATH: what only --background would add warns until it runs", () => {
  const bin = toolDirectory("pg_ctl");
  const file = "/home/k/.config/factory/o__r.json";
  const toolchain = { path: [bin], executables: ["pg_ctl"] };
  const service = `${bin}:/usr/bin:/bin`;
  // The unit was written before toolchain.path had the directory.
  const pending = toolchainChecks(
    toolchain,
    { service, installed: "/usr/bin:/bin" },
    file,
  );
  assert.deepEqual(pending, [
    {
      name: "toolchain",
      status: "warn",
      detail: `The installed unit's PATH lacks ${bin} (toolchain.path), pg_ctl's directory (toolchain.executables; ${join(bin, "pg_ctl")} on the PATH --background would write), so the running service doesn't have them yet`,
      fix: "Run factory setup --background: it writes the unit with them and restarts the service",
    },
  ]);
  // Nowhere at all: blocked, as with --background.
  const nowhere = toolchainChecks(
    { path: [], executables: ["tofu"] },
    { service, installed: "/usr/bin:/bin" },
    file,
  );
  assert.deepEqual(
    nowhere.map(({ status }) => status),
    ["blocked"],
  );
  // The unit has it (by a link's name, too): ok, on the unit's PATH.
  const linked = join(tempDir("factory-linked-"), "bin");
  symlinkSync(bin, linked);
  assert.deepEqual(
    toolchainChecks(
      toolchain,
      { service, installed: `${linked}:/usr/bin` },
      file,
    ),
    [
      {
        name: "toolchain",
        status: "ok",
        detail: `${bin} on the installed unit's PATH; found pg_ctl (${join(linked, "pg_ctl")})`,
      },
    ],
  );
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
    `The service's PATH would lose ${pg}: the unit has it now, and neither toolchain.path nor this shell's PATH does. To keep it, give --toolchain-path ${pg} (saved in toolchain.path, which goes after the mise pins and before the shell's PATH, so every later setup keeps it), or run setup from a shell that has it on its PATH; if the service doesn't need it, give --drop-path`,
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
      `would lose ${tofu}: .* To keep it, give --toolchain-path ${pg} --toolchain-path ${tofu} \\(`,
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

test("setup without --background checks the toolchain on the installed unit's PATH, and says --background adds it", async () => {
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
  // Written before toolchain.path had pg's directory.
  const written = unitText(REPO, [], {
    node: process.execPath,
    env: { PATH: inst.env.PATH, HOME: inst.env.HOME },
  });
  writeFileSync(unit, written);
  const pg = toolDirectory("pg_ctl");
  const report = JSON.parse(
    cli(
      inst,
      "setup",
      "--toolchain-path",
      pg,
      "--toolchain-executable",
      "pg_ctl",
      "--json",
    ).out,
  );
  const checks = report.readiness.checks.filter(
    ({ name }) => name === "toolchain",
  );
  assert.deepEqual(
    checks.map(({ status }) => status),
    ["warn"],
    JSON.stringify(checks),
  );
  assert.match(
    checks[0].detail,
    new RegExp(
      `^The installed unit's PATH lacks ${pg} \\(toolchain\\.path\\), pg_ctl's directory`,
    ),
  );
  assert.match(checks[0].fix, /factory setup --background/);
  assert.equal(readFileSync(unit, "utf8"), written, "the unit is untouched");

  // Once the unit has it, it is ok there.
  writeFileSync(
    unit,
    unitText(REPO, [], {
      node: process.execPath,
      env: { PATH: `${pg}:${inst.env.PATH}`, HOME: inst.env.HOME },
    }),
  );
  const again = JSON.parse(cli(inst, "setup", "--json").out);
  assert.deepEqual(
    again.readiness.checks.find(({ name }) => name === "toolchain"),
    {
      name: "toolchain",
      status: "ok",
      detail: `${pg} on the installed unit's PATH; found pg_ctl (${join(pg, "pg_ctl")})`,
    },
  );
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
