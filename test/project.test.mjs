// Single player per Project (host.ts projectCheck): the holder records of
// the Project's other repositories, read with real Git from local bare
// repositories behind github.com URLs. The Project's list of repositories
// (a GraphQL read) is given where that read supplies it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./helpers.mjs";

const OTHER = "drill/other";

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/**
 * A checkout of REPO whose origin is github.com over SSH, served by local
 * bare repositories: REPO's and OTHER's by path, any other one missing.
 */
function repositories() {
  const dir = mkdtempSync(join(tmpdir(), "factory-project-"));
  const bare = (name) => join(dir, `${name}.git`);
  for (const name of ["target", "other"])
    git("init", "--quiet", "--bare", bare(name));
  const checkout = join(dir, "checkout");
  git("clone", "--quiet", bare("target"), checkout);
  const serve = `case "$2" in *${OTHER}.git*) b=${bare("other")};; *${REPO}.git*) b=${bare("target")};; *) echo "no such repository" >&2; exit 128;; esac; case "$2" in git-receive-pack*) exec git receive-pack "$b";; *) exec git upload-pack "$b";; esac`;
  for (const args of [
    ["remote", "set-url", "origin", `ssh://git@github.com/${REPO}.git`],
    ["config", "ssh.variant", "simple"],
    ["config", "core.sshCommand", `sh -c '${serve}' ssh`],
  ])
    git("-C", checkout, ...args);
  const root = join(dir, "state");
  mkdirSync(root);
  return { dir, checkout, root, bare };
}

/** Write a holder record into the bare repository `bare`. */
function hold(bare, record) {
  const tree = git(
    "--git-dir",
    bare,
    "hash-object",
    "-t",
    "tree",
    "-w",
    "/dev/null",
  );
  const commit = spawnSync(
    "git",
    ["--git-dir", bare, "commit-tree", tree, "-m", JSON.stringify(record)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    },
  ).stdout.trim();
  git("--git-dir", bare, "update-ref", "refs/factory/holder", commit);
  return commit;
}

const record = (bare) =>
  git(
    "--git-dir",
    bare,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/factory/holder",
  );

test("a start is refused while another installation serves a repository on the Project, and goes on when the Project can't be read", async () => {
  const { holderFor } = await import("../dist/host.js");
  const { checkout, root, bare } = repositories();
  const context = {
    checkout,
    repository: REPO,
    root,
    project: "PVT_drill",
    repositories: async () => [OTHER],
  };
  const start = (takeOver = false) =>
    holderFor(context, takeOver, new AbortController().signal);
  hold(bare("other"), {
    installation: "a".repeat(24),
    host: "far",
    user: "someone",
    since: "2026-01-01T00:00:00.000Z",
  });

  for (const takeOver of [false, true])
    await assert.rejects(start(takeOver), (error) => {
      assert.equal(error.constructor.name, "ConfigurationError");
      assert.match(
        error.message,
        /^Project PVT_drill is served by another installation, on drill\/other: someone@far \(installation a{24}, .*factory serve --repo drill\/other --take-over/,
      );
      return true;
    });
  assert.equal(record(bare("target")), "", "a refused start writes nothing");

  context.repositories = async () => {
    throw new Error("GitHub is down");
  };
  assert.equal((await start()).sha, record(bare("target")));
});
