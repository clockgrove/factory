/**
 * One benchmark run's world, from a definition and a host profile
 * (bench/README.md#Provisioning): a private test repository at the base
 * commit, with the definition's base patches on it, and its LFS objects,
 * mirrored merge settings, rulesets and variables and only the kept
 * workflows enabled; a checkout; a Project with Factory's fields; an
 * isolated Factory configuration and state directory (FACTORY_CONFIG,
 * FACTORY_STATE_DIR) running the given Factory with the run's capacity
 * and the definition's review artifact selectors;
 * repository memory as it stood before the Objective; the background
 * service; and the Objective filed verbatim, its body checked against the
 * definition's digest. The run record (run.json) is what bench/run.mjs and
 * bench/score.mjs read.
 *
 * Every step looks before it acts, so running it again carries on where
 * it stopped. Runs provisioned at the same time share the host's cache
 * clone of the source, so one at a time fetches into it. With a dry run,
 * `Runner` prints each GitHub, Git and setup action instead of doing it
 * and answers each look with "not there yet", so the whole sequence
 * prints and nothing outside the process is touched. It still reads the
 * Factory CLI's own usage when its version doesn't say whether setup takes
 * --github-reserve (githubReserveSupport): that changes nothing.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  loadReviewArtifacts,
  selectorIdentity,
} from "../../dist/review/artifacts.js";
import { CAPACITY, hostValue } from "./definition.mjs";

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

/**
 * A new run id: the start minute and a random suffix, so runs provisioned
 * in the same minute differ. A run id is part of a repository name:
 * lowercase, digits and -.
 */
export function defaultRunId(now = new Date()) {
  const minute = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${minute}-${randomBytes(3).toString("hex")}`;
}

/** MiB src/capacity.ts keeps for the system and the service itself. */
const SYSTEM_MIB = 4096;

/** The host's CPUs and memory, read as src/capacity.ts hostDefaults reads them. */
export function hostResources() {
  return {
    cpus: availableParallelism(),
    memoryMiB: Math.floor(totalmem() / 2 ** 20),
  };
}

/**
 * About 1/`share` of the host, for `share` runs side by side:
 * src/capacity.ts hostDefaults' formulas over a share of the CPUs and of
 * the memory the system leaves. A share of 1 is Factory's own default.
 */
export function shareCapacity(share, { cpus, memoryMiB } = hostResources()) {
  const shareCpus = cpus / share;
  return {
    workers: Math.max(2, Math.floor(shareCpus / 2)),
    validations: Math.max(2, Math.floor(shareCpus / 4)),
    memoryMib: Math.max(1024, Math.floor((memoryMiB - SYSTEM_MIB) / share)),
  };
}

/**
 * The run's service capacity, as run.json records it: the definition's
 * `factory.capacity`, then `share` (shareCapacity), then each value given,
 * each overriding the one before. A value none of them sets is left to
 * Factory, which sizes it for the whole host. A run provisioned again
 * starts from its `recorded` capacity instead of the definition's: setup
 * changes only the values it is given, so its service keeps the rest.
 */
export function runCapacity(
  definition,
  { share = null, ...given } = {},
  resources = undefined,
  recorded = null,
) {
  return {
    ...(recorded ?? definition.factory.capacity),
    ...(share ? shareCapacity(share, resources) : {}),
    ...Object.fromEntries(
      Object.entries(given).filter(
        ([key, value]) => Object.hasOwn(CAPACITY, key) && value !== undefined,
      ),
    ),
    share: share ?? recorded?.share ?? null,
  };
}

/** Run directory `runDir`'s record (run.json), or null before it is first provisioned. */
export function recordedRun(runDir) {
  const file = join(runDir, "run.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Whether process `pid` is alive; one this user may not signal is. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * `fn`'s result, run while holding the lock `file`: created only when no
 * other holds it, with this process's id, and removed after. A lock whose
 * process is gone (it crashed) is taken over; one still held after
 * `waitMs` throws, naming its holder.
 */
async function withFileLock(
  file,
  fn,
  { waitMs = 30 * 60_000, pollMs = 250 } = {},
) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let holder;
    try {
      holder = readFileSync(file, "utf8");
    } catch {
      continue; // Released meanwhile.
    }
    // An empty lock is being written by its holder.
    const pid = Number(holder);
    if (holder && pid > 0 && !alive(pid)) {
      try {
        if (readFileSync(file, "utf8") === holder)
          rmSync(file, { force: true });
      } catch {
        // Released meanwhile.
      }
      continue;
    }
    if (Date.now() >= until)
      throw new Error(
        `${file} is still held by process ${holder.trim() || "unknown"} after ${Math.round(waitMs / 1000)} s; remove it if that process is gone`,
      );
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Source commit `commit` applied onto `onto` in repository `repo`, as `git
 * cherry-pick -x` would, without a work tree: the new commit's SHA. The
 * commit keeps the patch's author, committer and dates, so the same patches
 * on the same base make the same commits on every provisioning, and a run
 * provisioned again pushes the same main. A merge or root commit, or one
 * that doesn't apply cleanly, throws.
 */
export function cherryPick(repo, onto, commit) {
  const git = (args, { input, env } = {}) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      input,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const parents = git(["rev-list", "--parents", "-n", "1", commit])
    .split(" ")
    .slice(1);
  if (parents.length !== 1)
    throw new Error(
      `The base patch ${commit} is ${parents.length ? "a merge" : "a root commit"}: only a commit with one parent applies`,
    );
  let tree;
  try {
    tree = git([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `--merge-base=${parents[0]}`,
      onto,
      commit,
    ]);
  } catch (error) {
    // Exit 1 is a conflict: the tree, then each conflicted path.
    const conflicted =
      error.status === 1
        ? String(error.stdout).trim().split("\n").slice(1).filter(Boolean)
        : [];
    throw new Error(
      conflicted.length
        ? `The base patch ${commit} doesn't apply cleanly onto ${onto}: it conflicts in ${[...new Set(conflicted)].join(", ")}`
        : `The base patch ${commit} can't be applied onto ${onto}: ${String(error.stderr || error.message).trim()}`,
    );
  }
  if (tree === git(["rev-parse", `${onto}^{tree}`]))
    throw new Error(
      `The base patch ${commit} changes nothing on ${onto}: the base has it already`,
    );
  const [authorName, authorEmail, authorDate, name, email, date] = git([
    "show",
    "-s",
    "--date=raw",
    "--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd",
    commit,
  ]).split("\n");
  const message = git(["show", "-s", "--format=%B", commit]);
  // Unsigned: a signature would make each provisioning's commit differ.
  return git(["commit-tree", "--no-gpg-sign", tree, "-p", onto], {
    input: `${message}\n\n(cherry picked from commit ${commit})\n`,
    env: {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    },
  });
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
    dir: record.runDir ?? null,
    basePatches: record.basePatches ?? [],
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

/**
 * The share of the installation's GitHub budget benchmark traffic leaves
 * to production (`--github-reserve`, github.reserve): the installation's
 * budget is production's too, so benchmark traffic yields first.
 */
export const GITHUB_RESERVE = 2000;

/** The last Factory release whose setup has no --github-reserve: 0.5.12 is the first with it. */
const LAST_WITHOUT_GITHUB_RESERVE = [0, 5, 11];

/** `cli`'s usage: the text `factory help` prints. Running it changes nothing. */
function factoryUsage(cli) {
  try {
    return execFileSync(process.execPath, [cli, "help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(
      `Couldn't read ${cli}'s usage (factory help): ${String(error.stderr || error.message).trim()}`,
    );
  }
}

/**
 * Whether the setup of `factory` (resolveFactory) takes --github-reserve,
 * and how that is known (`by`). Its version says when it can: a build
 * versioned after 0.5.11 has the option, and a release at 0.5.11 or before
 * doesn't. A checkout at 0.5.11 or before may have it or not, as may a
 * version that isn't plain MAJOR.MINOR.PATCH, so its own usage says: the
 * one `setup` line of `factory help` lists `[--github-reserve ...]` or
 * doesn't. A usage without exactly one setup line throws rather than guess.
 */
export function githubReserveSupport(factory, usage = factoryUsage) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(factory.version ?? "");
  if (version) {
    const parts = version.slice(1).map(Number);
    const at = parts.findIndex(
      (part, i) => part !== LAST_WITHOUT_GITHUB_RESERVE[i],
    );
    if (at >= 0 && parts[at] > LAST_WITHOUT_GITHUB_RESERVE[at])
      return { supported: true, by: "version" };
    if (factory.kind === "release") return { supported: false, by: "version" };
  }
  const setup = usage(factory.cli)
    .split("\n")
    .filter((line) => /^ {2}setup\s/.test(line));
  if (setup.length !== 1)
    throw new Error(
      `${factory.cli}'s usage (factory help) has ${setup.length ? setup.length : "no"} setup lines, not one: can't tell whether its setup takes --github-reserve`,
    );
  return {
    supported: /\s\[--github-reserve [A-Z][A-Z-]*\]/.test(setup[0]),
    by: "usage",
  };
}

/**
 * `factory setup`'s options for this definition, host, repository,
 * checkout, Project and capacity (runCapacity), with `githubReserve`
 * (null for a Factory whose setup has no --github-reserve).
 */
export function setupArgs(
  definition,
  host,
  {
    repository,
    checkout,
    projectId,
    capacity = {},
    githubReserve = GITHUB_RESERVE,
  },
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
    // The installation's budget is production's too: benchmark traffic
    // yields first (github.reserve), when this Factory's setup can say so.
    ...(githubReserve === null
      ? []
      : ["--github-reserve", String(githubReserve)]),
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
    ...Object.entries(CAPACITY).flatMap(([key, { flag }]) =>
      capacity[key] === undefined ? [] : [flag, String(capacity[key])],
    ),
  ];
}

/**
 * The top-level `reviewArtifacts` of the configuration `file`, which setup
 * wrote, set to exactly the definition's `selectors`: the definition is
 * what the run is configured with, so selectors it no longer has go. The
 * file is written only when its list differs from them by Factory's
 * selectorIdentity, so a run provisioned again leaves it byte for byte as
 * it is. With no selectors, the key is dropped only when the file has one
 * provisioning wrote (`carried`, as the run record says); otherwise the
 * file is left alone. Setup has no option for them and keeps the key when
 * it writes the file again. Whether the file changed; selectors Factory's
 * own loader refuses, such as more than its limit, throw.
 */
export function carryReviewArtifacts(file, selectors, carried = []) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const has = config.reviewArtifacts ?? [];
  if (!selectors.length) {
    const wrote = new Set(carried.map(selectorIdentity));
    if (!has.some((selector) => wrote.has(selectorIdentity(selector))))
      return false;
    delete config.reviewArtifacts;
  } else {
    if (
      isDeepStrictEqual(
        has.map(selectorIdentity),
        selectors.map(selectorIdentity),
      )
    )
      return false;
    const problems = [];
    loadReviewArtifacts(selectors, problems);
    if (problems.length)
      throw new Error(
        `The definition's reviewArtifacts can't be written into ${file}: ${problems.join("; ")}`,
      );
    config.reviewArtifacts = selectors;
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
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
 * of the base tree (`tree`: the base with its patches), and is read again
 * after disabling to check that only kept workflows are active. On any
 * failure Actions is turned off again.
 */
export function enableOnlyKeptWorkflows({
  def,
  repository,
  cache,
  runner,
  tree = def.source.base,
}) {
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
      tree,
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
 * (resolveFactory) and `capacity` (runCapacity). Returns the run record;
 * also writes it to <benchRoot>/<benchmark>/<run id>/run.json unless dry.
 * Provisioned again, the record keeps its issue, the time it was first
 * provisioned and queued, and its capacity until setup applies the new one.
 */
export async function provision({
  definition: def,
  host,
  factory,
  runId,
  label,
  group,
  resultsDir = null,
  capacity = runCapacity(def),
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
  // An older release under benchmark may have no --github-reserve: setup
  // gets it only when this Factory takes it, so A/B runs of old releases
  // still provision.
  const reserve = githubReserveSupport(factory);
  runner.print(
    `check: whether this Factory's setup takes --github-reserve, by its ${reserve.by}: ${reserve.supported ? "it does" : "it doesn't, so the run's GitHub traffic doesn't yield to production's first"}`,
  );
  // What run.mjs and scoring read stays while this provisioning carries on.
  const previous = recordedRun(runDir);
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
    issue: previous?.issue ?? null,
    project: null,
    checkout,
    runDir,
    stateDir,
    env,
    factory,
    // Whether setup was given --github-reserve, and how support was known.
    githubReserve: {
      applied: reserve.supported,
      reserve: reserve.supported ? GITHUB_RESERVE : null,
      by: reserve.by,
    },
    // The service's capacity, as given to setup; a value missing is Factory's own for the host.
    capacity: previous?.capacity ?? capacity,
    // The source commits put on the base, each with the commit it made on main.
    basePatches: [],
    // The definition's review artifact selectors, carried into factory.json;
    // until this provisioning carries them, those a previous one did.
    reviewArtifacts: previous?.reviewArtifacts ?? [],
    policyAs: def.operatorPolicy.as,
    provisionedAt: previous?.provisionedAt ?? null,
    ...(previous?.queuedAt ? { queuedAt: previous.queuedAt } : {}),
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

  // The source at its base, with the base tree's LFS objects, and the base
  // patches on it. Runs provisioned at once share the cache clone: one at a
  // time clones and fetches into it.
  const patches = def.basePatches ?? [];
  let head = def.source.base;
  const fromSource = () => {
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
    for (const [what, commit] of [
      ["the base", def.source.base],
      ...patches.map((patch) => ["the base patch", patch.commit]),
    ]) {
      runner.act(`fetch ${what} ${commit.slice(0, 7)}`, [
        "git",
        "-C",
        cache,
        "fetch",
        "origin",
        commit,
      ]);
      if (def.source.lfs)
        runner.act(`fetch ${what}'s LFS objects`, [
          "git",
          "-C",
          cache,
          "lfs",
          "fetch",
          "origin",
          commit,
        ]);
    }
    // A patch that doesn't apply cleanly stops provisioning before anything is pushed.
    for (const patch of patches) {
      head = runner.local(
        `apply the base patch ${patch.commit.slice(0, 7)} (${patch.reason})`,
        () => cherryPick(cache, head, patch.commit),
        `<the base with ${patch.commit.slice(0, 7)}>`,
      );
      record.basePatches.push({ ...patch, applied: head });
    }
  };
  const lock = `${cache}.lock`;
  runner.print(
    `${runner.dryRun ? "would" : "do"}: hold ${lock} while cloning and fetching`,
  );
  if (runner.dryRun) fromSource();
  else {
    mkdirSync(host.cacheDir, { recursive: true });
    await withFileLock(lock, fromSource);
  }

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
  runner.act(
    `push the base${patches.length ? ` with its ${patches.length} patch(es)` : ""} as main, without the LFS pre-push hook`,
    [
      "git",
      "-C",
      cache,
      "push",
      "--no-verify",
      remote,
      `${head}:refs/heads/main`,
    ],
  );
  if (def.source.lfs) {
    const listed = runner.look(
      "the base tree's LFS objects",
      ["git", "-C", cache, "lfs", "ls-files", "-l", head],
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
            ? `git -C ${cache} lfs push --object-id ${remote} <each oid of git lfs ls-files -l ${head}>`
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
  enableOnlyKeptWorkflows({ def, repository, cache, runner, tree: head });

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
  const args = setupArgs(def, host, {
    repository,
    checkout,
    projectId,
    capacity,
    githubReserve: record.githubReserve.reserve,
  });
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
  record.capacity = capacity;
  // Setup has no option for reviewArtifacts: they go into the file it
  // wrote, before the service starts and reads it, exactly as the
  // definition has them.
  const selectors = def.factory.reviewArtifacts ?? [];
  if (selectors.length || record.reviewArtifacts.length)
    runner.local(
      selectors.length
        ? `carry the definition's ${selectors.length} reviewArtifacts selector(s) into ${env.FACTORY_CONFIG}`
        : `drop the reviewArtifacts provisioning carried into ${env.FACTORY_CONFIG}: the definition has none`,
      () => {
        if (
          !carryReviewArtifacts(
            env.FACTORY_CONFIG,
            selectors,
            record.reviewArtifacts,
          )
        )
          runner.print(
            selectors.length ? "    there already" : "    none there",
          );
      },
    );
  record.reviewArtifacts = selectors;
  save();
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
  record.provisionedAt ??= new Date().toISOString();
  runner.local(`write the run record ${join(runDir, "run.json")}`, save);
  return record;
}
