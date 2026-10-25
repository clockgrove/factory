// Publish replaces a branch head Factory made with its new result. When
// the PR still shows the replaced head (GitHub catching up with the push)
// and no record of pushing it survives (a reset, a moved stack layer), it
// waits for GitHub; it never holds on its own commit as someone else's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publish } from "../dist/delivery.js";
import { FACTORY_EMAIL } from "../dist/work/collect.js";
import { githubOrigin, REPO } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A commit on HEAD as Factory makes them, with `file` holding `text`. */
function factoryCommit(directory, file, text) {
  writeFileSync(join(directory, file), text);
  git(directory, "add", file);
  git(
    directory,
    "-c",
    "user.name=Factory",
    "-c",
    `user.email=${FACTORY_EMAIL}`,
    "commit",
    "--quiet",
    "-m",
    `Factory: ${file}`,
  );
  return git(directory, "rev-parse", "HEAD");
}

test("a PR still showing the head Factory just replaced waits for GitHub, with no record of that push", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-publish-"));
  const bare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, checkout);
  githubOrigin(checkout, bare);
  git(checkout, "checkout", "--quiet", "-b", "main");
  const base = factoryCommit(checkout, "README.md", "target\n");
  git(checkout, "push", "--quiet", "origin", "main");
  // Factory's earlier result is on the branch; this run doesn't know it.
  const branch = "factory/1/a";
  git(checkout, "checkout", "--quiet", "-b", "earlier");
  const replaced = factoryCommit(checkout, "a.js", "export const a = 1;\n");
  git(checkout, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  git(checkout, "checkout", "--quiet", "-b", "result", base);
  const commit = factoryCommit(checkout, "a.js", "export const a = 2;\n");
  const tree = git(checkout, "rev-parse", `${commit}^{tree}`);

  const pull = {
    number: 7,
    state: "open",
    merged_at: null,
    head: { sha: replaced, ref: branch },
    base: { ref: "main" },
    body: "",
  };
  const answers = {
    repository: REPO,
    defaultBranch: async () => "main",
    made: () => {},
    // GitHub has not caught up: the PR shows the replaced head throughout.
    pullsByHead: async () => [pull],
    commit: async (sha) => ({
      sha,
      parents: [git(checkout, "rev-parse", `${sha}^`)],
      committer: "Factory",
    }),
    commitsBeyond: async () => ({
      total: 1,
      commits: [
        { sha: replaced, committerEmail: FACTORY_EMAIL, parents: [base] },
      ],
    }),
  };
  const github = new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
  const context = { github, checkout, signal: new AbortController().signal };
  const input = {
    issue: 1,
    item: { id: "a", title: "A", ownedPaths: ["a.js"] },
    base,
    commit,
    tree,
    pushedHeads: [],
    validation: { commands: [] },
    secrets: [],
  };
  const result = await publish(context, input);
  assert.equal(result.kind, "retry", JSON.stringify(result));
  assert.match(result.reason, /does not show the pushed head/);
  // The push replaced Factory's own head with the result.
  assert.equal(
    git(checkout, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0],
    commit,
  );
  // The retry, with the branch already holding the result and still no
  // record of the replaced head, waits again instead of holding.
  const again = await publish(context, input);
  assert.equal(again.kind, "retry", JSON.stringify(again));
  // A head Factory did not make is still someone else's change.
  answers.commitsBeyond = async () => ({
    total: 1,
    commits: [
      { sha: replaced, committerEmail: "someone@example.com", parents: [base] },
    ],
  });
  const foreign = await publish(context, input);
  assert.equal(foreign.kind, "hold", JSON.stringify(foreign));
  assert.match(foreign.question, /a change Factory did not make/);
});
