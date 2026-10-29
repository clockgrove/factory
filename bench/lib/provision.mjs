/**
 * One benchmark run's world, from a definition and a host profile
 * (bench/README.md#Provisioning): a private test repository at the base
 * commit with its LFS objects, mirrored merge settings, rulesets and
 * variables and only the kept workflows enabled; a checkout; a Project
 * with Factory's fields; an isolated Factory configuration and state
 * directory (FACTORY_CONFIG, FACTORY_STATE_DIR) running the given Factory;
 * repository memory as it stood before the Objective; the background
 * service; and the Objective filed verbatim, its body checked against the
 * definition's digest. The run record (run.json) is what bench/run.mjs and
 * bench/score.mjs read.
 *
 * Every step looks before it acts, so running it again carries on where
 * it stopped. With a dry run, `Runner` prints each GitHub, Git and setup
 * action instead of doing it and answers each look with "not there yet",
 * so the whole sequence prints and nothing outside the process is touched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { hostValue } from "./definition.mjs";

/** Runs commands, or with `dryRun` prints them; `print` gets each line. */
export class Runner {
  constructor({ dryRun, print }) {
    this.dryRun = dryRun;
    this.print = print;
  }

  /** `argv` as a shell would show it. */
  static shown(argv) {
    return argv
      .map((arg) =>
        /^[\w@%+=:,./-]+$/.test(arg)
          ? arg
          : `'${arg.replaceAll("'", "'\\''")}'`,
      )
      .join(" ");
  }

  run(argv, { env, cwd, input } = {}) {
    return execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
      cwd,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  }

  /** An action with an outside effect. `show` replaces argv where it would print a value; `dry` is the dry run's result. */
  act(title, argv, { env, cwd, input, show, dry = "" } = {}) {
    this.print(
      `${this.dryRun ? "would" : "do"}: ${title}\n    ${show ?? Runner.shown(argv)}`,
    );
    return this.dryRun ? dry : this.run(argv, { env, cwd, input });
  }

  /** A read that must succeed: its output; a failure throws. A dry run reads nothing: `dry`. */
  read(title, argv, { env, cwd, dry = "" } = {}) {
    this.print(`check: ${title}\n    ${Runner.shown(argv)}`);
    if (this.dryRun) return dry;
    try {
      return this.run(argv, { env, cwd });
    } catch (error) {
      throw new Error(
        `Couldn't read ${title} (${Runner.shown(argv)}): ${String(error.stderr || error.message).trim()}`,
      );
    }
  }

  /** A read: its output, or null when it fails. A dry run reads nothing: `dry`. */
  look(title, argv, { env, cwd, dry = null } = {}) {
    if (this.dryRun) {
      this.print(`check: ${title}\n    ${Runner.shown(argv)}`);
      return dry;
    }
    try {
      return this.run(argv, { env, cwd });
    } catch {
      return null;
    }
  }

  /** A local effect done in-process. */
  local(title, effect, dry) {
    this.print(`${this.dryRun ? "would" : "do"}: ${title}`);
    return this.dryRun ? dry : effect();
  }
}

const HOST_KEYS = ["benchRoot", "workDir", "cacheDir", "sourceState"];

/** The host profile (bench/README.md#Host profile), checked. */
export function loadHost(file) {
  const host = JSON.parse(readFileSync(file, "utf8"));
  const missing = HOST_KEYS.filter((key) => typeof host[key] !== "string");
  if (missing.length) throw new Error(`${file} needs ${missing.join(", ")}`);
  if (host.githubApp && !(host.githubApp.id && host.githubApp.keyPath))
    throw new Error(`${file}: githubApp needs id and keyPath`);
  return host;
}

/** SHA-256 over a directory's files (relative path and content, in path order): a build's identity. */
export function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const file = join(at, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        hash.update(`${relative(dir, file)}\0`);
        hash.update(readFileSync(file));
        hash.update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/**
 * The Factory to run, from a Factory checkout or a CLI path. The kind comes
 * from where the build lives: a package root that is a Git work tree's top
 * (and not under node_modules) is a candidate, with its commit, branch and
 * whether it has uncommitted changes; anything else (an installed package)
 * is a release. dist/ is gitignored, so the commit alone doesn't say which
 * build ran: `distSha256` does, and scoring checks it again.
 */
export function resolveFactory(path) {
  const given = realpathSync(path);
  const cli = statSync(given).isDirectory()
    ? join(given, "dist", "cli.js")
    : given;
  if (!existsSync(cli))
    throw new Error(
      `${cli} doesn't exist: build the candidate first (npm run build)`,
    );
  let root = dirname(cli);
  while (!existsSync(join(root, "package.json")) && root !== dirname(root))
    root = dirname(root);
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  const build = dirname(cli);
  const distSha256 = treeDigest(build);
  const installed = root.split(sep).includes("node_modules");
  const checkout = !installed && existsSync(join(root, ".git"));
  if (!checkout)
    return {
      cli,
      root,
      version,
      commit: null,
      branch: null,
      dirty: false,
      distSha256,
      kind: "release",
    };
  // A checkout's Git must answer: a candidate is never recorded without its commit.
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  return {
    cli,
    root,
    version,
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    distSha256,
    kind: "candidate",
  };
}

/** A harness run's `run` for scoreRun, with the Factory build checked again now. */
export function harnessRun(record) {
  const factory = record.factory ?? {};
  let distSha256Now = null;
  try {
    if (factory.cli) distSha256Now = treeDigest(dirname(factory.cli));
  } catch {
    // The build is gone: nothing to compare.
  }
  return {
    id: record.runId,
    label: record.label,
    group: record.group,
    source: "harness",
    repository: record.repository,
    factory: {
      kind: factory.kind ?? null,
      cli: factory.cli ?? null,
      version: factory.version ?? null,
      commit: factory.commit ?? null,
      branch: factory.branch ?? null,
      dirty: factory.dirty ?? null,
      distSha256: factory.distSha256 ?? null,
      distSha256Now,
    },
  };
}

/** `factory setup`'s options for this definition, host, repository, checkout and Project. */
export function setupArgs(
  definition,
  host,
  { repository, checkout, projectId },
) {
  const f = definition.factory;
  const value = (text) => hostValue(text, host);
  const each = (flag, list) => list.flatMap((item) => [flag, value(item)]);
  return [
    "setup",
    "--repo",
    repository,
    "--checkout",
    checkout,
    "--project-id",
    projectId,
    ...(host.githubApp
      ? [
          "--github-app-id",
          String(host.githubApp.id),
          "--github-app-key",
          host.githubApp.keyPath,
        ]
      : ["--github-login"]),
    ...(host.operator ? ["--operator", host.operator] : []),
    "--provider",
    f.provider,
    "--planner",
    f.planner,
    "--worker",
    f.worker.kind,
    "--default",
    "--planner-model",
    f.models.planner.model,
    "--planner-effort",
    f.models.planner.effort,
    "--reviewer-model",
    f.models.reviewer.model,
    "--reviewer-effort",
    f.models.reviewer.effort,
    `--${f.worker.kind}-model`,
    f.worker.model,
    `--${f.worker.kind}-effort`,
    f.worker.effort,
    ...(f.worker.network ? ["--codex-network", f.worker.network] : []),
    "--sandbox-network",
    f.sandbox.network,
    ...each("--read-only-path", f.sandbox.readOnlyPaths),
    ...Object.entries(f.sandbox.environment).flatMap(([name, text]) => [
      "--sandbox-env",
      `${name}=${value(text)}`,
    ]),
    ...each("--toolchain-path", f.toolchain.paths),
    ...each("--toolchain-executable", f.toolchain.executables),
    "--format-command",
    f.formatCommand,
    ...each("--required-command", f.requiredCommands),
    ...each("--ci-only-command", f.ciOnlyCommands),
    "--planning-revisions",
    String(f.allowances.planningRevisions),
    "--implementation-repairs",
    String(f.allowances.implementationRepairs),
    "--per-path-repairs",
    String(f.allowances.perPath),
    "--result-rereviews",
    String(f.allowances.resultRereviews),
    "--objective-tokens",
    String(f.spend.objectiveTokens),
    "--day-tokens",
    String(f.spend.dayTokens),
  ];
}

/** Copy `source` (a knowledge store) to `target` without Objective `issue`'s entries or any made at or after `before`. */
export async function seedMemory(source, target, issue, before) {
  // `created` is stored as toISOString text and compared as text: compare it with the same form of the cut.
  const cut = new Date(before);
  if (Number.isNaN(cut.getTime()))
    throw new Error(`memory cut ${before} isn't a time`);
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // VACUUM INTO: a consistent copy of a store a live service may be writing.
  const read = new DatabaseSync(source, { readOnly: true });
  read.prepare("VACUUM INTO ?").run(target);
  read.close();
  const db = new DatabaseSync(target);
  const where = "objective = ? OR created >= ?";
  const removed = db
    .prepare(`SELECT id FROM memory WHERE ${where}`)
    .all(issue, cut.toISOString());
  const drop = db.prepare("DELETE FROM memory_text WHERE id = ?");
  for (const { id } of removed) drop.run(id);
  db.prepare(`DELETE FROM memory WHERE ${where}`).run(issue, cut.toISOString());
  const kept = db.prepare("SELECT count(*) AS n FROM memory").get().n;
  db.close();
  chmodSync(target, 0o600);
  return { kept, removed: removed.length };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** `id state path` lines of a repository's workflows, as listWorkflows asks for them. */
function parseWorkflows(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, state, ...path] = line.split(" ");
      return { id, state, path: path.join(" ") };
    });
}

/**
 * Turn Actions on with only the kept workflows active. Nothing deploy-capable
 * may stay enabled: the listing must succeed, must name every workflow file
 * of the base tree, and is read again after disabling to check that only
 * kept workflows are active. On any failure Actions is turned off again.
 */
export function enableOnlyKeptWorkflows({ def, repository, cache, runner }) {
  const keep = def.ci.keepWorkflows;
  const actions = (enabled) => [
    "gh",
    "api",
    "-X",
    "PUT",
    `repos/${repository}/actions/permissions`,
    "-F",
    `enabled=${enabled}`,
    ...(enabled ? ["-f", "allowed_actions=all"] : []),
  ];
  const list = (title) =>
    parseWorkflows(
      runner.read(title, [
        "gh",
        "api",
        `repos/${repository}/actions/workflows`,
        "--paginate",
        "--jq",
        '.workflows[] | "\\(.id) \\(.state) \\(.path)"',
      ]),
    );
  const files = runner
    .read("the base tree's workflow files", [
      "git",
      "-C",
      cache,
      "ls-tree",
      "--name-only",
      def.source.base,
      ".github/workflows/",
    ])
    .split("\n")
    .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
  const notKept = (workflow) =>
    workflow.state === "active" &&
    workflow.path.startsWith(".github/workflows/") &&
    !keep.includes(workflow.path);
  runner.act("turn Actions on", actions(true));
  try {
    const workflows = list(`${repository}'s workflows`);
    if (!runner.dryRun) {
      const listed = new Set(workflows.map((w) => w.path));
      const missing = files.filter((path) => !listed.has(path));
      if (missing.length)
        throw new Error(
          `${repository}'s workflow listing doesn't name ${missing.join(", ")} of the base tree (${workflows.length} listed); run provisioning again once GitHub lists them`,
        );
    }
    if (runner.dryRun)
      runner.act(`disable every workflow but ${keep.join(", ")}`, [], {
        show: `gh api -X PUT repos/${repository}/actions/workflows/<id>/disable   (each active .github/workflows/* not kept)`,
      });
    for (const workflow of workflows.filter(notKept))
      runner.act(`disable ${workflow.path}`, [
        "gh",
        "api",
        "-X",
        "PUT",
        `repos/${repository}/actions/workflows/${workflow.id}/disable`,
      ]);
    const active = list(
      `${repository}'s workflows again: only ${keep.join(", ")} active`,
    ).filter(notKept);
    if (active.length)
      throw new Error(
        `${repository} still has active workflows that aren't kept: ${active.map((w) => w.path).join(", ")}`,
      );
  } catch (error) {
    if (!runner.dryRun)
      try {
        runner.act(
          "turn Actions off again: the workflows aren't safe",
          actions(false),
        );
      } catch (offError) {
        error.message += `\nTurning Actions off again failed too: ${offError.message}. Turn it off by hand: gh api -X PUT repos/${repository}/actions/permissions -F enabled=false`;
      }
    throw error;
  }
}

/**
 * Provision run `runId` of `definition` on `host` with `factory`
 * (resolveFactory). Returns the run record; also writes it to
 * <benchRoot>/<benchmark>/<run id>/run.json unless dry.
 */
export async function provision({
  definition: def,
  host,
  factory,
  runId,
  label,
  group,
  resultsDir = null,
  runner,
}) {
  const owner = def.repository.owner;
  const name = `${def.repository.namePrefix}-${runId}`;
  const repository = `${owner}/${name}`;
  const remote = `https://github.com/${repository}.git`;
  const source = def.source.repository;
  const runDir = join(host.benchRoot, def.id, runId);
  const stateRoot = join(runDir, "state");
  // An installation's directory (paths.ts installationDir).
  const stateDir = join(stateRoot, repository.toLowerCase().replace("/", "__"));
  const env = {
    FACTORY_CONFIG: join(runDir, "factory.json"),
    FACTORY_STATE_DIR: stateRoot,
    FACTORY_REPOSITORY: repository,
    PATH: [
      ...def.factory.toolchain.paths.map((p) => hostValue(p, host)),
      ...(host.path ?? [process.env.PATH]),
    ].join(":"),
  };
  const checkout = join(host.workDir, name);
  const cache = join(host.cacheDir, source.replace("/", "__"));
  const record = {
    benchmark: def.id,
    definitionFile: def.file ?? null,
    definitionDigest: def.digest,
    // Where bench/run.mjs scores the run into; outside the Factory repository.
    resultsDir,
    runId,
    label,
    group,
    repository,
    issue: null,
    project: null,
    checkout,
    runDir,
    stateDir,
    env,
    factory,
    policyAs: def.operatorPolicy.as,
    provisionedAt: null,
  };
  const save = () =>
    runner.dryRun ||
    writeFileSync(
      join(runDir, "run.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  runner.local(`create the run directory ${runDir}`, () => {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    save();
  });

  // The Objective, verbatim: fetched now, checked against the definition.
  const objectiveFile = join(runDir, "objective.md");
  if (!existsSync(objectiveFile)) {
    const issue = runner.look(`read ${source}#${def.objective.issue}`, [
      "gh",
      "api",
      `repos/${source}/issues/${def.objective.issue}`,
    ]);
    runner.local(
      `check its title and body digest (${def.objective.bodySha256.slice(0, 12)}), save ${objectiveFile}`,
      () => {
        const { title, body } = JSON.parse(issue);
        if (title !== def.objective.title)
          throw new Error(
            `${source}#${def.objective.issue}'s title changed: ${title}`,
          );
        if (sha256(body) !== def.objective.bodySha256)
          throw new Error(
            `${source}#${def.objective.issue}'s body isn't the one the definition names (sha256 ${sha256(body)})`,
          );
        writeFileSync(objectiveFile, body, { mode: 0o600 });
      },
    );
  }

  // The source at its base, with the base tree's LFS objects.
  if (!existsSync(cache))
    runner.act(
      `clone ${source} (no LFS smudge) into the cache`,
      [
        "git",
        "clone",
        "--no-checkout",
        `https://github.com/${source}.git`,
        cache,
      ],
      {
        env: { GIT_LFS_SKIP_SMUDGE: "1" },
      },
    );
  runner.act(`fetch the base ${def.source.base.slice(0, 7)}`, [
    "git",
    "-C",
    cache,
    "fetch",
    "origin",
    def.source.base,
  ]);
  if (def.source.lfs)
    runner.act("fetch the base tree's LFS objects", [
      "git",
      "-C",
      cache,
      "lfs",
      "fetch",
      "origin",
      def.source.base,
    ]);

  // The test repository: nothing may run until the deploy-capable workflows are off.
  const description = runner.look(`does ${repository} exist`, [
    "gh",
    "repo",
    "view",
    repository,
    "--json",
    "description",
    "--jq",
    ".description",
  ]);
  if (description === null)
    runner.act(`create ${repository}, private`, [
      "gh",
      "repo",
      "create",
      repository,
      "--private",
      "--disable-wiki",
      "--description",
      def.repository.description,
    ]);
  else if (description !== def.repository.description)
    throw new Error(
      `${repository} exists and isn't this benchmark's test repository`,
    );
  runner.act("turn Actions off", [
    "gh",
    "api",
    "-X",
    "PUT",
    `repos/${repository}/actions/permissions`,
    "-F",
    "enabled=false",
  ]);
  runner.act("merge settings as the source has them", [
    "gh",
    "api",
    "-X",
    "PATCH",
    `repos/${repository}`,
    ...Object.entries(def.repository.mergeSettings).flatMap(([key, on]) => [
      "-F",
      `${key}=${on}`,
    ]),
  ]);
  runner.act(`push the base as main, without the LFS pre-push hook`, [
    "git",
    "-C",
    cache,
    "push",
    "--no-verify",
    remote,
    `${def.source.base}:refs/heads/main`,
  ]);
  if (def.source.lfs) {
    const listed = runner.look(
      "the base tree's LFS objects",
      ["git", "-C", cache, "lfs", "ls-files", "-l", def.source.base],
      { dry: "" },
    );
    const oids = (listed ?? "")
      .split("\n")
      .map((line) => line.split(" ")[0])
      .filter(Boolean);
    if (oids.length || runner.dryRun)
      runner.act(
        `push the base tree's ${runner.dryRun ? "" : `${oids.length} `}LFS objects by id`,
        ["git", "-C", cache, "lfs", "push", "--object-id", remote, ...oids],
        {
          show: runner.dryRun
            ? `git -C ${cache} lfs push --object-id ${remote} <each oid of git lfs ls-files -l ${def.source.base}>`
            : undefined,
        },
      );
  }
  const rulesets =
    runner.look(
      `${repository}'s rulesets`,
      ["gh", "api", `repos/${repository}/rulesets`, "--jq", ".[].name"],
      { dry: "" },
    ) ?? "";
  const sourceRulesets = def.ci.rulesets.some(
    (n) => !rulesets.split("\n").includes(n),
  )
    ? JSON.parse(
        runner.look(`${source}'s rulesets`, [
          "gh",
          "api",
          `repos/${source}/rulesets`,
        ]) ?? "[]",
      )
    : [];
  for (const rulesetName of def.ci.rulesets) {
    if (rulesets.split("\n").includes(rulesetName)) continue;
    const found = sourceRulesets.find((r) => r.name === rulesetName);
    if (!found && !runner.dryRun)
      throw new Error(`${source} has no ruleset ${rulesetName}`);
    const full = runner.look(
      `${source}'s ruleset ${rulesetName}`,
      ["gh", "api", `repos/${source}/rulesets/${found?.id ?? "<id>"}`],
      { dry: "{}" },
    );
    const file = join(runDir, `ruleset-${rulesetName}.json`);
    runner.local(
      `keep its name, target, enforcement, conditions, rules and bypass actors in ${basename(file)}`,
      () => {
        const { name, target, enforcement, conditions, rules, bypass_actors } =
          JSON.parse(full);
        writeFileSync(
          file,
          JSON.stringify({
            name,
            target,
            enforcement,
            conditions,
            rules,
            bypass_actors,
          }),
        );
      },
    );
    runner.act(`mirror the ruleset ${rulesetName}`, [
      "gh",
      "api",
      "-X",
      "POST",
      `repos/${repository}/rulesets`,
      "--input",
      file,
    ]);
  }
  for (const variable of def.ci.variables) {
    const value = runner.look(
      `${source}'s variable ${variable}`,
      [
        "gh",
        "api",
        `repos/${source}/actions/variables/${variable}`,
        "--jq",
        ".value",
      ],
      { dry: "" },
    );
    if (value === null)
      throw new Error(`${source} has no Actions variable ${variable}`);
    runner.act(
      `copy the Actions variable ${variable}`,
      [
        "gh",
        "variable",
        "set",
        variable,
        "--repo",
        repository,
        "--body",
        value,
      ],
      {
        show: `gh variable set ${variable} --repo ${repository} --body <${source}'s value>`,
      },
    );
  }
  enableOnlyKeptWorkflows({ def, repository, cache, runner });

  // The checkout Factory works in.
  if (!existsSync(checkout)) {
    runner.act(`clone ${repository} for Factory`, [
      "git",
      "clone",
      "--quiet",
      remote,
      checkout,
    ]);
    if (def.source.lfs)
      runner.act("pull its LFS objects", [
        "git",
        "-C",
        checkout,
        "lfs",
        "pull",
      ]);
  }

  // The Project, with Factory's fields.
  const projectTitle = `Factory bench ${def.id} ${runId}`;
  let projectNumber = runner.look(`a Project titled ${projectTitle}`, [
    "gh",
    "project",
    "list",
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    "200",
    "--jq",
    `.projects[] | select(.title == "${projectTitle}") | .number`,
  ]);
  if (!projectNumber) {
    projectNumber = runner.act(
      `create the Project ${projectTitle}`,
      [
        "gh",
        "project",
        "create",
        "--owner",
        owner,
        "--title",
        projectTitle,
        "--format",
        "json",
        "--jq",
        ".number",
      ],
      {
        dry: "<project number>",
      },
    );
    const field = (fieldName, type, extra = []) =>
      runner.act(`its field ${fieldName}`, [
        "gh",
        "project",
        "field-create",
        projectNumber,
        "--owner",
        owner,
        "--name",
        fieldName,
        "--data-type",
        type,
        ...extra,
      ]);
    field("Factory", "SINGLE_SELECT", [
      "--single-select-options",
      "Queued,Planning,Building,Needs you,Done,Cancelled",
    ]);
    field("Factory order", "NUMBER");
    field("Factory admission", "TEXT");
    runner.act(`link it to ${repository}`, [
      "gh",
      "project",
      "link",
      projectNumber,
      "--owner",
      owner,
      "--repo",
      repository,
    ]);
  }
  const projectId = runner.look(
    "the Project's id",
    [
      "gh",
      "project",
      "view",
      projectNumber,
      "--owner",
      owner,
      "--format",
      "json",
      "--jq",
      ".id",
    ],
    {
      dry: "<project id>",
    },
  );
  record.project = { number: projectNumber, id: projectId };
  for (const objectiveLabel of def.objective.labels)
    runner.act(`the label ${objectiveLabel}`, [
      "gh",
      "label",
      "create",
      objectiveLabel,
      "--repo",
      repository,
      "--color",
      "5319E7",
      "--force",
    ]);

  // Factory: an isolated configuration and state directory.
  const factoryArgv = (...args) => [process.execPath, factory.cli, ...args];
  const args = setupArgs(def, host, { repository, checkout, projectId });
  // A setup that refused or is blocked stops here: it names what to fix, and running again carries on.
  const setup = (title, extra, ok) => {
    const out = runner.act(title, factoryArgv(...args, ...extra, "--json"), {
      env,
      show: `FACTORY_CONFIG=${env.FACTORY_CONFIG} FACTORY_STATE_DIR=${env.FACTORY_STATE_DIR} factory ${Runner.shown([...args, ...extra, "--json"])}`,
      dry: '{"status":"configured"}',
    });
    const report = JSON.parse(out);
    if (!ok(report.status))
      throw new Error(
        `factory ${title}: ${report.status}\n${JSON.stringify(report, null, 2)}`,
      );
  };
  setup("configure Factory (setup)", [], (status) => status === "configured");
  if (def.memory.seed === "before-objective") {
    const from = join(
      host.sourceState,
      source.toLowerCase().replace("/", "__"),
      "knowledge",
      "knowledge.sqlite",
    );
    const to = join(stateDir, "knowledge", "knowledge.sqlite");
    if (!existsSync(to))
      await runner.local(
        `seed memory from ${from}, without #${def.objective.issue}'s entries or any from ${def.memory.before} on`,
        async () => {
          const seeded = await seedMemory(
            from,
            to,
            def.objective.issue,
            def.memory.before,
          );
          runner.print(`    kept ${seeded.kept}, removed ${seeded.removed}`);
        },
      );
  }
  setup(
    "start the background service (setup --background)",
    ["--background"],
    (status) => status !== "blocked",
  );

  // The Objective, filed verbatim.
  let number = Number(
    runner.look(`an issue titled like the Objective in ${repository}`, [
      "gh",
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--json",
      "number,title",
      "--jq",
      `.[] | select(.title == ${JSON.stringify(def.objective.title)}) | .number`,
    ]) || 0,
  );
  if (!number) {
    const url = runner.act(
      "file the Objective",
      [
        "gh",
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        def.objective.title,
        "--body-file",
        objectiveFile,
        ...def.objective.labels.flatMap((l) => ["--label", l]),
      ],
      { dry: `https://github.com/${repository}/issues/1` },
    );
    number = Number(url.split("/").pop());
    const filed = runner.look(`#${number} as filed`, [
      "gh",
      "api",
      `repos/${repository}/issues/${number}`,
    ]);
    runner.local("check the filed body against the digest", () => {
      if (sha256(JSON.parse(filed).body) !== def.objective.bodySha256)
        throw new Error(
          `${repository}#${number}'s body differs from the source's`,
        );
    });
  }
  record.issue = number;
  record.provisionedAt = new Date().toISOString();
  runner.local(`write the run record ${join(runDir, "run.json")}`, save);
  return record;
}
