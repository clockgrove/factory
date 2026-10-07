import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitAsync } from "../dist/process.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import { validateTree } from "../dist/validation.js";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

test("controller Git ignores executable configuration shared by a worker worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-git-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "notes.txt"), "base\n");
  git(checkout, "add", ".");
  const identity = [
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
  ];
  git(checkout, ...identity, "commit", "-m", "base");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const worker = join(root, "worker");
  git(checkout, "worktree", "add", "--detach", worker, "HEAD");
  const marker = join(root, "ran");
  const executable = join(root, "repository-program");
  writeFileSync(executable, `#!/bin/sh\necho ran >>'${marker}'\nexit 1\n`, {
    mode: 0o755,
  });
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "pre-commit"),
    `#!/bin/sh\necho hook >>'${marker}'\nexit 1\n`,
    { mode: 0o755 },
  );
  git(worker, "config", "core.fsmonitor", executable);
  git(worker, "config", "diff.external", executable);
  git(worker, "config", "core.hooksPath", hooks);
  git(worker, "config", "commit.gpgSign", "true");
  git(worker, "config", "gpg.program", executable);
  // Prove this is live executable configuration, rather than an inert input.
  git(worker, "status", "--porcelain");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  writeFileSync(join(worker, "notes.txt"), "changed\n");
  await gitAsync(worker, "status", "--porcelain");
  await gitAsync(worker, "diff");
  await gitAsync(worker, "add", "notes.txt");
  await gitAsync(worker, ...identity, "commit", "-m", "safe controller commit");
  assert.equal(existsSync(marker), false);
  assert.equal(git(worker, "show", "HEAD:notes.txt"), "changed");
  assert.doesNotMatch(git(worker, "cat-file", "commit", "HEAD"), /gpgsig/);
  const changeRef = git(worker, "rev-parse", "HEAD");
  const treeSha = git(worker, "rev-parse", "HEAD^{tree}");
  const command = `node -e 'if (require("node:fs").readFileSync("notes.txt", "utf8") !== "changed\\n") process.exit(1)'`;
  const validation = await validateTree(
    checkout,
    join(root, "validation"),
    changeRef,
    treeSha,
    [command],
  );
  const request = {
    item: {
      goal: "Update the published note while keeping repository-provided Git programs disabled. Controller reads and commits must use the hardened Git environment so worker configuration cannot execute code.",
      validation: [{ command }],
    },
    baseSha,
    changeRef,
    treeSha,
  };
  const context = {
    repository: "example/notes",
    objective: 1,
    issue: 2,
    validation,
  };
  const body = deliveryDescription(checkout, request, context);
  t.diagnostic(body);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/2/);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/1/);
  assert.match(body, /Updates <code>notes\.txt<\/code>/);
  assert.match(body, /Controller validation passed on this candidate/);
  assert.ok(body.includes(command));
  assert.equal(existsSync(marker), false);
  assert.match(
    deliveryDescription(checkout, request, {
      ...context,
      validation: {
        ...validation,
        treeSha: git(checkout, "rev-parse", `${baseSha}^{tree}`),
      },
    }),
    /receipts are unavailable/,
  );
  assert.throws(
    () =>
      deliveryDescription(checkout, { ...request, treeSha: "0".repeat(40) }),
    /tree mismatch/,
  );
  assert.doesNotMatch(
    deliveryDescription(
      checkout,
      {
        ...request,
        item: {
          ...request.item,
          goal: "Configured value private-example-value",
        },
      },
      context,
      ["private-example-value"],
    ),
    /private-example-value/,
  );
});
