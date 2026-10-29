// A dry run of bench/provision.mjs prints every GitHub, Git and setup action
// of a benchmark run, in order, and does none: with no gh or git on PATH it
// still succeeds and leaves no run directory behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bench-provision-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a dry run prints the whole provisioning and touches nothing", () => {
  const host = join(dir, "host.json");
  writeFileSync(
    host,
    JSON.stringify({
      benchRoot: join(dir, "bench"),
      workDir: join(dir, "work"),
      cacheDir: join(dir, "cache"),
      sourceState: join(dir, "state"),
      toolchain: "/opt/toolchain",
      githubApp: { id: "1", keyPath: join(dir, "app.pem") },
      operator: "operator-login",
    }),
  );
  const run = spawnSync(
    process.execPath,
    [
      join(root, "bench", "provision.mjs"),
      "--benchmark",
      "clockgrove-800",
      "--host",
      host,
      "--factory",
      join(root, "dist", "cli.js"),
      "--run-id",
      "t1",
      "--dry-run",
    ],
    { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
  );
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  const repo = "clockgrove/bench-clockgrove-800-t1";
  const steps = [
    "check: read clockgrove/clockgrove#800",
    "would: check its title and body digest (e22ce1842efc)",
    "git clone --no-checkout https://github.com/clockgrove/clockgrove.git",
    `gh repo create ${repo} --private`,
    `gh api -X PUT repos/${repo}/actions/permissions -F enabled=false`,
    "-F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=true -F allow_auto_merge=false -F delete_branch_on_merge=false",
    `push --no-verify https://github.com/${repo}.git 46a206678b4b8446aeb162553b07151647a28536:refs/heads/main`,
    "lfs push --object-id",
    "would: mirror the ruleset protected-main",
    `gh variable set QUALITY_RUNNER --repo ${repo} --body <clockgrove/clockgrove's value>`,
    "-F enabled=true -f allowed_actions=all",
    "would: disable every workflow but .github/workflows/quality.yml",
    "would: create the Project Factory bench clockgrove-800 t1",
    "--name 'Factory admission' --data-type TEXT",
    `gh label create factory:objective --repo ${repo}`,
    "would: configure Factory (setup)",
    "--codex-network host --sandbox-network package-install --read-only-path /opt/toolchain/ms-playwright",
    "--toolchain-path /opt/toolchain/postgresql-18.6/bin",
    "--objective-tokens 200000000 --day-tokens 400000000 --json",
    "would: seed memory from",
    "without #800's entries or any from 2026-10-28T11:06:00Z on",
    "would: start the background service (setup --background)",
    "--background --json",
    "would: file the Objective",
    "would: check the filed body against the digest",
  ];
  let at = 0;
  for (const step of steps) {
    const found = out.indexOf(step, at);
    assert.ok(found >= 0, `missing, or out of order: ${step}\n${out}`);
    at = found;
  }
  // The service runs on its own configuration and state, never ~/.config/factory.
  assert.match(
    out,
    /FACTORY_CONFIG=\S+\/bench\/clockgrove-800\/t1\/factory\.json FACTORY_STATE_DIR=\S+\/bench\/clockgrove-800\/t1\/state factory setup/,
  );
  assert.ok(!existsSync(join(dir, "bench")), "a dry run creates nothing");
});
