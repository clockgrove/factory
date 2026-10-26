// Publish replaces a branch head Factory made with its new result. When
// the PR still shows the replaced head (GitHub catching up with the push)
// and no record of pushing it survives (a reset, a moved stack layer), it
// waits for GitHub; it never holds on its own commit as someone else's.
// A push the remote refuses waits too, and asks only if the refusal lasts;
// so does the delete of a merged item's branch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publish } from "../dist/delivery.js";
import { REFUSED_MS } from "../dist/github.js";
import { FACTORY_EMAIL } from "../dist/work/collect.js";
import { deleteBranches } from "../dist/work/step-deliver.js";
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

/**
 * An origin whose `factory/1/a` holds Factory's earlier result, a new
 * result to publish, and a GitHub whose PR still shows the earlier head.
 */
function published() {
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
  return {
    bare,
    checkout,
    branch,
    replaced,
    base,
    commit,
    answers,
    context,
    input,
  };
}

test("a PR still showing the head Factory just replaced waits for GitHub, with no record of that push", async () => {
  const { checkout, branch, replaced, base, commit, answers, context, input } =
    published();
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

// The prd suite's lane Q: two Work Items pushed at once, GitHub answered
// one with `[remote rejected] (failed)`, and the Objective held at once.
test("a push the remote refuses with the branch unmoved retries, and asks only if it lasts", async () => {
  const { bare, checkout, branch, replaced, context, input } = published();
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const result = await publish(context, input);
  assert.equal(result.kind, "retry", JSON.stringify(result));
  assert.match(result.reason, /refused Factory's push of factory\/1\/a/);
  assert.equal(result.holdAfter.scope, "objective");
  assert.match(result.holdAfter.question, /Allow Factory's login to push/);
  // Nothing was pushed.
  assert.equal(
    git(checkout, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0],
    replaced,
  );
});

// The prd suite's lane P: GitHub answered the delete of a merged item's
// branch with `[remote rejected] (Internal Server Error)` once, and Factory
// kept the branch for good.
test("a branch delete the remote refuses once with the branch unmoved retries, then deletes", async () => {
  const { bare, checkout, branch, replaced, context } = published();
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(
    hook,
    "#!/bin/sh\n[ -e refused ] && exit 0\ntouch refused\necho 'Internal Server Error' >&2\nexit 1\n",
  );
  chmodSync(hook, 0o755);
  const logged = [];
  const step = {
    state: { issue: 1 },
    signal: context.signal,
    log: (event) => logged.push(event),
  };
  const deps = { github: context.github, config: { checkout } };
  const items = [{ id: "a", title: "A", ownedPaths: ["a.js"] }];
  const refused = await deleteBranches(step, deps, items);
  assert.equal(refused?.kind, "retry", JSON.stringify(refused));
  assert.match(refused.reason, /refused Factory's delete of factory\/1\/a/);
  assert.equal(refused.holdAfter.ms, REFUSED_MS);
  assert.deepEqual(logged, []);
  assert.equal(
    git(checkout, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0],
    replaced,
  );
  // The merge step's retry finds the PR merged and deletes the branch.
  assert.equal(await deleteBranches(step, deps, items), undefined);
  assert.equal(
    git(checkout, "ls-remote", "origin", `refs/heads/${branch}`),
    "",
  );
  assert.deepEqual(logged, []);
});
