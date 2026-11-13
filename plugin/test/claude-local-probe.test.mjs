import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_DECOY_LAUNCH, CLAUDE_PROBE_RESULT, anthropicProbeModel, claudeProbeDriver } from "../scripts/lib/claude-local-probe.mjs";
import { CLAUDE_PROBE_SCRIPT, claudeLocalCheck } from "../scripts/lib/harness.mjs";
import { CONFINEMENT_PROBE, PROBE_MARKER, PROBE_PASS } from "../scripts/lib/codex-runner.mjs";
import { PROBE_PERSIST, TOOLCHAIN_RULE } from "../scripts/lib/copilot-runner.mjs";
import { GitRefusal, LOCAL_DOMAINS, gitRefusalReason } from "../scripts/lib/local.mjs";
import { localToolchainRows } from "../scripts/doctor.mjs";

test("Claude Code's local probe: the driver proves the toolchain, tries the home, runs the confinement probe and writes its result", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-"));
  const [tmp, home, bin] = ["t", "h", "b"].map((d) => join(root, d));
  for (const d of [tmp, home, bin]) mkdirSync(d);
  const result = join(tmp, CLAUDE_PROBE_RESULT);
  const drive = (driver, extra = {}) => {
    execFileSync("/bin/sh", ["-c", driver], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: `${bin}:/usr/bin:/bin`, FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE, FACTORY_PROBE_DECOY: "999999999", [PROBE_MARKER]: "m1", ...extra } });
    return readFileSync(result, "utf8");
  };
  const base = { gitConfig: "", host: "", marker: "m1", result, tmp, persist: [home] };
  // Unconfined here: the marker is in this shell's parent, so the confinement probe names it; the home write lands.
  assert.equal(drive(claudeProbeDriver(base)), "4\nthe credential stand-in is readable in a process environment\n");
  assert.ok(existsSync(join(home, PROBE_PERSIST)), "Factory checks the home from outside");
  assert.equal(drive(claudeProbeDriver(base), { FACTORY_PROBE_SCRIPT: "" }), "4\nthe probe script is missing\n");
  assert.equal(drive(claudeProbeDriver(base), { FACTORY_PROBE_DECOY: "" }), "4\nthe probe's decoy is missing\n");
  writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(drive(claudeProbeDriver({ ...base, toolchain: { pm: "pnpm" } })), `4\n${TOOLCHAIN_RULE}\n`, "the package manager must run");
  assert.equal(drive(claudeProbeDriver({ ...base, toolchain: { node: "/nowhere/node" } })), `4\n${TOOLCHAIN_RULE}\n`, "the stage's node must be the one found");
  assert.equal(drive(claudeProbeDriver(base), { FACTORY_PROBE_SCRIPT: "true", [PROBE_MARKER]: "" }), "0\n\n", "a script that checks nothing leaves no pass line");
  assert.ok(!CLAUDE_DECOY_LAUNCH.includes("${") && !claudeProbeDriver(base).includes("${"));
});

test("Claude Code's local probe model: one Bash call, then the end; a stand-in key, never a real one", async () => {
  const model = await anthropicProbeModel();
  try {
    assert.equal(model.env.ANTHROPIC_API_KEY, "sk-ant-factory-probe");
    const ask = async (body) => (await fetch(`${model.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: JSON.stringify(body) })).json();
    const first = await ask({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] });
    assert.deepEqual(first.content[0].input.command, 'sh -c "$FACTORY_CLAUDE_PROBE"', "no path in the command line");
    assert.equal(first.stop_reason, "tool_use");
    const end = await ask({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_probe", content: "ran" }] }] });
    assert.equal(end.stop_reason, "end_turn");
    assert.equal(model.toolOutput(), "ran");
    const streamed = await (await fetch(`${model.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: JSON.stringify({ stream: true, tools: [{ name: "Bash" }], messages: [] }) })).text();
    assert.match(streamed, /event: content_block_start\ndata: .*"tool_use"/);
    assert.match(streamed, /"stop_reason":"tool_use"/);
  } finally {
    await model.close();
  }
});

test("Claude Code's local probe before every start: launched as the run, the marker kept from commands; its result decides; a home write Blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "clc-"));
  const [tmp, home, usage, clone] = ["t", "h", "u", "w"].map((d) => join(root, d));
  for (const d of [tmp, home, join(usage, "harness"), join(clone, ".git")]) mkdirSync(d, { recursive: true });
  const local = { clone, addDirs: [tmp], cacheDirs: [], readDirs: [usage], readOnly: [usage], domains: LOCAL_DOMAINS, toolchain: { node: "/usr/bin/node", pm: "pnpm" }, readable: ["/opt/pm"], claudeEnv: join(usage, "claude-env.sh") };
  const env = { PATH: "/usr/bin", TMPDIR: tmp, FACTORY_USAGE_DIR: usage, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-real", ANTHROPIC_API_KEY: "sk-ant-real", MY_SECRET: "s" };
  const calls = [];
  const leaving = (text, { persist = false } = {}) => async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    if (text !== null) writeFileSync(join(tmp, CLAUDE_PROBE_RESULT), text);
    if (persist) writeFileSync(join(home, PROBE_PERSIST), "");
    return { code: 0, stdout: "", stderr: "" };
  };
  await claudeLocalCheck(local, "/o.json", env, { drop: ["MY_SECRET"], run: leaving(`0\n${PROBE_PASS}\n`), home });
  const [call] = calls;
  assert.equal(call.cmd, "srt");
  assert.deepEqual(call.args.slice(0, 8), ["-s", "/o.json", "--", "env", `TMPDIR=${tmp}`, process.execPath, CLAUDE_PROBE_SCRIPT, "/bin/sh"], "in the outer sandbox, as the run");
  assert.ok(call.args.includes(CLAUDE_DECOY_LAUNCH));
  const settings = JSON.parse(call.args[call.args.indexOf("--settings") + 1]);
  assert.ok(settings.sandbox.credentials.envVars.some((v) => v.name === PROBE_MARKER && v.mode === "deny"), "the marker kept from commands as the credential is");
  assert.deepEqual(settings.sandbox.filesystem.allowRead, ["/opt/pm"], "the run's own settings");
  assert.equal(call.env.CLAUDE_ENV_FILE, local.claudeEnv);
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in call.env) && !("ANTHROPIC_API_KEY" in call.env) && !("MY_SECRET" in call.env), "none of the run's credentials (the launcher adds a stand-in key)");
  assert.match(call.env[PROBE_MARKER], /^[0-9a-f]{32}$/);
  assert.equal(call.env.CLAUDE_CONFIG_DIR, join(usage, "harness", "claude-probe"));
  assert.ok(call.env.FACTORY_CLAUDE_PROBE.includes("command -v node") && call.env.FACTORY_CLAUDE_PROBE.includes("pnpm --version"));
  assert.ok(!existsSync(call.env.CLAUDE_CONFIG_DIR), "its config is removed afterwards");
  await assert.rejects(claudeLocalCheck(local, null, env, { run: leaving("4\nexample.com, off the allow-list, is reachable\n"), home }), (e) => e instanceof GitRefusal && e.rule === "a host off the allow-list is reachable" && e.harness === "claude" && e.local);
  assert.equal(calls.at(-1).cmd, process.execPath, "no outer sandbox: the launcher directly");
  await assert.rejects(claudeLocalCheck(local, null, env, { run: leaving(`0\n${PROBE_PASS}\n`, { persist: true }), home }), (e) => e.rule === "the agent home is writable");
  assert.ok(!existsSync(join(home, PROBE_PERSIST)), "and the file is removed");
  await assert.rejects(claudeLocalCheck(local, null, env, { run: leaving(`4\n${TOOLCHAIN_RULE}\n`), home }), (e) => e.rule === TOOLCHAIN_RULE && /Claude Code's sandbox does not give commands the stage's toolchain: \/usr\/bin\/node, pnpm/.test(e.message));
  await assert.rejects(claudeLocalCheck(local, null, env, { run: leaving("0\n\n"), home }), (e) => e.rule === "the probe ended without its pass line");
  calls.length = 0;
  await assert.rejects(claudeLocalCheck(local, null, env, { run: leaving(null), home }), (e) => e.code === "sandbox" && !e.rule && /Claude Code's sandbox could not start here/.test(e.message));
  assert.equal(calls.length, 2, "no result is tried once more");
  assert.match(gitRefusalReason("sandbox", 1, { rule: "the agent home is writable", harness: "claude", local: true }), /^Claude Code's sandbox started but does not confine here/);
  assert.match(gitRefusalReason("sandbox", 1, { harness: "claude", local: true }), /^Claude Code's sandbox could not start in local mode/);
  assert.match(gitRefusalReason("sandbox", 1, { rule: TOOLCHAIN_RULE, harness: "claude", local: true }), /^Claude Code's sandbox started but its commands do not find/);
});

test("doctor --local names the node and the package manager local mode resolves; a pinned one not resolved FAILs", () => {
  const root = mkdtempSync(join(tmpdir(), "cdr-"));
  const repo = join(root, "r");
  const pmDir = join(root, "corepack");
  for (const d of [repo, join(pmDir, "dist"), join(root, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(pmDir, "package.json"), '{"name":"corepack"}');
  writeFileSync(join(pmDir, "dist", "pnpm.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  execFileSync("ln", ["-s", join(pmDir, "dist", "pnpm.js"), join(root, "bin", "pnpm")]);
  writeFileSync(join(root, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(repo, "package.json"), '{"packageManager":"pnpm@12.18.0+sha512.abc"}');
  const rows = localToolchainRows({ checkout: repo, env: { PATH: join(root, "bin") }, os: "linux", run: () => "v24.21.0\n" });
  assert.deepEqual(rows.map((r) => [r.status, r.name]), [["PASS", "node"], ["PASS", "package manager"]]);
  assert.match(rows[0].detail, /^v24\.21\.0 → .*\/bin\/node/);
  assert.equal(rows[1].detail, `pnpm 12.18.0 (corepack) → ${join(pmDir, "dist", "pnpm.js")}`);
  const missing = localToolchainRows({ checkout: repo, env: { PATH: "/nowhere" }, os: "linux", run: () => "" });
  assert.deepEqual(missing.map((r) => r.status), ["FAIL", "FAIL"], "no node, and a pinned pnpm not resolved");
  assert.match(missing[1].detail, /^pnpm 12\.18\.0 \(packageManager\) is not resolved from PATH; local stages Block before the run/);
  writeFileSync(join(repo, "package.json"), "{}");
  assert.deepEqual(localToolchainRows({ checkout: repo, env: { PATH: join(root, "bin") }, os: "linux", run: () => "v1\n" }).map((r) => r.name), ["node"], "npm: no package manager row");
});
