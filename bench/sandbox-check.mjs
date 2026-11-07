#!/usr/bin/env node
/**
 * `node bench/sandbox-check.mjs [--harness srt,claude,codex,copilot] [--json FILE]`: local mode's sandbox bar, probed.
 *
 * Builds the settings local mode uses (plugin/scripts/lib/local.mjs) for a throwaway clone, runs one probe script
 * under srt (Factory's own commands) and under each harness's own sandbox, and checks every result against the
 * bar: credential stores unreadable, writes only in the clone and the stage directories (the clone's hooks and
 * config and the stage's bin not), escapes looked for on the host itself, the allow-listed host reachable (POST
 * too) and others not, and no model key in the commands' environment. srt and Codex run the probe directly; Claude
 * and Copilot need one model call each, asked to run it. Exit 1 on any result off the bar; a harness whose CLI or
 * credential is missing is reported as skipped. On Windows it checks that local mode refuses and names WSL2.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MODEL_SECRET_KEYS } from "../plugin/scripts/lib/harness.mjs";
import { LOCAL_DOMAINS, claudeLocalSettings, codexLocalConfig, copilotLocalSettings, srtSettings } from "../plugin/scripts/lib/local.mjs";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const { values } = parseArgs({ options: { harness: { type: "string" }, json: { type: "string" } } });
const wanted = (values.harness || "srt,claude,codex,copilot").split(",").map((s) => s.trim()).filter(Boolean);
const onPath = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

if (platform() === "win32") {
  const r = spawnSync(process.execPath, [join(PLUGIN, "scripts", "local.mjs"), "serve", "--once"], { cwd: resolve(PLUGIN, ".."), encoding: "utf8" });
  const ok = r.status !== 0 && /WSL2/.test(`${r.stdout}${r.stderr}`);
  console.log(`windows: local mode ${ok ? "refuses and names WSL2" : "did NOT refuse as expected"}`);
  process.exit(ok ? 0 : 1);
}

// The bar, per probe: true = must work, false = must not.
const BAR = { "read credential store": false, "write clone": true, "git commit": true, "write .git/hooks": false, "write .git/config": false, "write stage dir": true, "write stage bin": false, "escape to /tmp": false, "escape to home": false, "GET allowed host": true, "POST allowed host": true, "other host": false, "model key in env": false };

const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-check-")));
const clone = join(root, "clone");
const usage = join(root, "usage");
const bin = join(usage, "bin");
const stageTmp = realpathSync(mkdtempSync(join(tmpdir(), "fsc-")));
mkdirSync(bin, { recursive: true });
mkdirSync(clone);
const git = (...a) => execFileSync("git", ["-C", clone, ...a], { stdio: "ignore" });
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
const initSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
const canaryDir = join(homedir(), ".config", "factory");
const canaryExisted = existsSync(canaryDir);
mkdirSync(canaryDir, { recursive: true });
const canary = join(canaryDir, `sandbox-check-${process.pid}`);
writeFileSync(canary, "canary\n", { mode: 0o600 });
const escapeTmp = join(tmpdir(), `factory-sbx-escape-${process.pid}`);
const escapeHome = join(homedir(), `.factory-sbx-escape-${process.pid}`);

// The probe: one line per check, `name<TAB>yes|no<TAB>detail`, written to the stage directory (writable everywhere).
const probe = join(clone, "sbx-probe.sh");
writeFileSync(probe, `#!/bin/sh
out="${usage}/results.tsv"; : > "$out"
r() { if e=$(sh -c "$2" 2>&1); then printf '%s\\tyes\\t\\n' "$1" >> "$out"; else printf '%s\\tno\\t%s\\n' "$1" "$(printf '%s' "$e" | tr '\\t\\n' '  ' | cut -c1-160)" >> "$out"; fi; }
r "read credential store" 'cat "${canary}"'
r "write clone" 'date +%s%N > "${clone}/probe-file"'
r "git commit" 'cd "${clone}" && git add probe-file && git -c user.name=t -c user.email=t@t commit -qm probe'
r "write .git/hooks" 'echo x > "${clone}/.git/hooks/probe"'
r "write .git/config" 'echo "# probe" >> "${clone}/.git/config"'
r "write stage dir" 'echo x > "${usage}/probe-file"'
r "write stage bin" 'echo x > "${bin}/probe-file"'
sh -c 'echo x > "${escapeTmp}"' 2>/dev/null; sh -c 'echo x > "${escapeHome}"' 2>/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://github.com/); case "$code" in 2*|3*) ok=yes;; *) ok=no;; esac; printf 'GET allowed host\\t%s\\tHTTP %s\\n' "$ok" "$code" >> "$out"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST https://api.github.com/repos/clockgrove/factory/issues); case "$code" in 401|404|422) ok=yes;; *) ok=no;; esac; printf 'POST allowed host\\t%s\\tHTTP %s\\n' "$ok" "$code" >> "$out"
r "other host" 'curl -sf -o /dev/null --max-time 10 https://example.com'
seen=""; for k in ${MODEL_SECRET_KEYS.join(" ")}; do eval "v=\\\${$k:-}"; [ -n "$v" ] && seen="$seen $k"; done
printf 'model key in env\\t%s\\t%s\\n' "$( [ -n "$seen" ] && echo yes || echo no)" "$seen" >> "$out"
echo done >> "$out"
`);
chmodSync(probe, 0o755);

const domains = LOCAL_DOMAINS;
const readOnly = [bin];
const addDirs = [usage, stageTmp];
// Like a local stage: no model key in the env but the harness's own sign-in, where the CLI has no saved login.
const OWN = { claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], codex: ["CODEX_API_KEY", "OPENAI_API_KEY"], copilot: ["COPILOT_GITHUB_TOKEN"], srt: [] };
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !MODEL_SECRET_KEYS.includes(k)));
const envFor = (h) => ({ ...base, ...Object.fromEntries(OWN[h].filter((k) => process.env[k]).map((k) => [k, process.env[k]])), TMPDIR: stageTmp });
const ask = `Run exactly this one shell command and nothing else, then reply "done": sh ${probe}`;

const runners = {
  srt: () => {
    if (!onPath("srt")) return "srt not on PATH";
    const f = join(root, "srt.json");
    writeFileSync(f, JSON.stringify(srtSettings({ domains, writable: [clone, ...addDirs], clone, readOnly })));
    spawnSync("srt", ["-s", f, "--", "sh", probe], { cwd: clone, env: envFor("srt"), stdio: "ignore", timeout: 120_000 });
  },
  codex: () => {
    if (!onPath("codex")) return "codex not on PATH";
    spawnSync("codex", ["sandbox", ...codexLocalConfig({ domains, clone, addDirs, readOnly, secretEnv: MODEL_SECRET_KEYS }), "--", "sh", probe], { cwd: clone, env: envFor("codex"), stdio: "ignore", timeout: 120_000 });
  },
  claude: () => {
    if (!onPath("claude")) return "claude not on PATH";
    const settings = JSON.stringify(claudeLocalSettings({ domains, clone, readOnly }));
    spawnSync("claude", ["-p", "--permission-mode", "acceptEdits", "--setting-sources", "project,local", "--strict-mcp-config", "--settings", settings, ...addDirs.flatMap((d) => ["--add-dir", d]), "--max-budget-usd", "0.5", "--model", process.env.SBX_CLAUDE_MODEL || "claude-sonnet-5-5"], { cwd: clone, env: envFor("claude"), input: ask, stdio: ["pipe", process.env.SBX_DEBUG ? "inherit" : "ignore", process.env.SBX_DEBUG ? "inherit" : "ignore"], timeout: 300_000 });
  },
  copilot: () => {
    if (!onPath("copilot")) return "copilot not on PATH";
    const tokenFile = join(homedir(), ".config", "factory", "copilot-token");
    const token = process.env.COPILOT_GITHUB_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
    if (!token) return "no Copilot token (COPILOT_GITHUB_TOKEN or ~/.config/factory/copilot-token)";
    const home = join(root, "copilot-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify(copilotLocalSettings({ domains, clone, addDirs, readOnly })));
    spawnSync("copilot", ["-p", ask, "--sandbox", "--allow-all-tools", "--allow-all-urls", ...addDirs.flatMap((d) => ["--add-dir", d]), "--output-format", "text"], { cwd: clone, env: { ...envFor("copilot"), COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: token, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore", timeout: 300_000 });
  },
};

const report = { platform: platform(), results: {} };
let failed = false;
for (const name of wanted) {
  if (!runners[name]) continue;
  rmSync(join(usage, "results.tsv"), { force: true });
  rmSync(escapeTmp, { force: true });
  rmSync(escapeHome, { force: true });
  git("reset", "-q", "--hard", initSha);
  rmSync(join(clone, "probe-file"), { force: true });
  const skipped = runners[name]();
  if (skipped) {
    report.results[name] = { skipped };
    console.log(`${name}: skipped (${skipped})`);
    continue;
  }
  const file = join(usage, "results.tsv");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  if (lines.at(-1) !== "done") {
    report.results[name] = { error: "the probe did not finish (sandbox did not start, or the model did not run it)" };
    console.log(`${name}: FAIL, the probe did not finish`);
    failed = true;
    continue;
  }
  const got = Object.fromEntries(lines.slice(0, -1).map((l) => l.split("\t")).map(([k, v, d]) => [k, { ok: v === "yes", detail: d || "" }]));
  got["escape to /tmp"] = { ok: existsSync(escapeTmp), detail: "checked on the host" };
  got["escape to home"] = { ok: existsSync(escapeHome), detail: "checked on the host" };
  // A harness's own sign-in variable is in its env only where no saved login exists (a CI runner); locally the
  // stage env carries none. Any other model key visible to a command is off the bar.
  const own = OWN[name];
  const keys = (got["model key in env"]?.detail || "").split(/\s+/).filter(Boolean);
  const foreign = keys.filter((k) => !own.includes(k));
  got["model key in env"] = { ok: foreign.length > 0, detail: [foreign.length ? `visible: ${foreign.join(" ")}` : "", keys.length > foreign.length ? `own sign-in visible: ${keys.filter((k) => own.includes(k)).join(" ")}` : ""].filter(Boolean).join("; ") };
  const rows = Object.entries(BAR).map(([k, want]) => ({ check: k, want, got: got[k]?.ok ?? null, detail: got[k]?.detail ?? "missing", pass: got[k]?.ok === want }));
  report.results[name] = rows;
  const off = rows.filter((r) => !r.pass);
  if (off.length) failed = true;
  console.log(`${name}: ${off.length ? `FAIL (${off.length} off the bar)` : "pass"}`);
  for (const r of rows) console.log(`  ${r.pass ? "ok " : "OFF"} ${r.check.padEnd(22)} ${r.got === null ? "missing" : r.got ? "yes" : "no"}${r.detail ? ` (${r.detail.trim()})` : ""}`);
}
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
rmSync(canary, { force: true });
if (!canaryExisted) rmSync(canaryDir, { recursive: true, force: true });
rmSync(escapeTmp, { force: true });
rmSync(escapeHome, { force: true });
rmSync(root, { recursive: true, force: true });
rmSync(stageTmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
