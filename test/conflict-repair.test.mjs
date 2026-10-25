// A conflict repair moves the result onto the new base and refuses none of
// it: a resolution that ends on the result's own tree is a change, while a
// repair that refused the result still reads that tree as no change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { collect } from "../dist/work/collect.js";
import { fact } from "../dist/work/facts.js";
import { refusedOf } from "../dist/work/refused.js";
import { deliveryRepair } from "../dist/work/step-deliver.js";
import { configured, installation, item, REPO } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return loadConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

test("a conflict repair whose resolution is the result's own tree on the moved base is collected as a change", async () => {
  const worktree = join(mkdtempSync(join(tmpdir(), "factory-conflict-")), "w");
  const file = join(worktree, "src", "shared.js");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(file, "export const shared = (s) => s;\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const start = git(worktree, "rev-parse", "HEAD");
  // Factory's result, then a person's push to main changing only that file.
  const factory = "export const shared = (s) => s + s;\n";
  writeFileSync(file, factory);
  git(worktree, "commit", "--quiet", "-am", "Factory: shared");
  const commit = git(worktree, "rev-parse", "HEAD");
  const tree = git(worktree, "rev-parse", "HEAD^{tree}");
  git(worktree, "checkout", "--quiet", "--detach", start);
  writeFileSync(file, "export function shared(s) {\n  return s + s;\n}\n");
  git(worktree, "commit", "--quiet", "-am", "person: shared");
  const base = git(worktree, "rev-parse", "HEAD");

  const work = item("shared", { ownedPaths: ["src/shared.js"] });
  const state = {
    kept: {},
    done: {
      "item:shared:work": { base: start, commit, tree, notes: [], sets: [] },
    },
    issue: 3,
  };
  const { sandbox, planning } = loaded();
  const repaired = (repair) => {
    const outcome = deliveryRepair(work, { state }, undefined, repair, "ci");
    return { ...state, kept: outcome.keep };
  };
  // The worker resolves by keeping Factory's version: exactly the old tree.
  const resolve = (after) => {
    writeFileSync(file, factory);
    return collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: [],
      playbook: planning.playbook,
      sandbox,
      finalResponse: "Resolved the conflict.",
      refusedTree: refusedOf(after, "shared")?.tree,
      signal: AbortSignal.timeout(60_000),
    });
  };

  // Failed checks refused that tree: resubmitting it is no change.
  const failed = await resolve(
    repaired({ finding: "Checks failed on PR #23", checks: true }),
  );
  assert.equal(failed.kind, "repair");
  assert.match(failed.finding, /^Worker produced no repository change/);

  const moved = repaired({
    finding: "PR #23 conflicts with its base branch; rebase the change",
    conflict: {},
  });
  // The change is still replayed onto the new base.
  assert.equal(fact(moved, "refused", "shared").commit, commit);
  const collected = await resolve(moved);
  assert.equal(collected.kind, "collected", collected.finding);
  assert.equal(collected.tree, tree);
  assert.equal(git(worktree, "rev-parse", "HEAD^"), base);
});
