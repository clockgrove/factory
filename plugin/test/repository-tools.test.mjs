import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessCommand } from "../scripts/lib/harness.mjs";
import { CONFINEMENT_PROBE, PROBE_MARKER } from "../scripts/lib/codex-runner.mjs";
import { PROBE_RESULT, TOOLCHAIN_RULE, probeDriver, repositoryTools, repositoryWords } from "../scripts/lib/copilot-runner.mjs";
import { gitPinFile, localSandbox, pinGitDir } from "../scripts/lib/local.mjs";
import { logTo } from "../scripts/lib/inputs.mjs";
import { simpleCommands } from "../scripts/lib/logic.mjs";
import { localToolchainRows } from "../scripts/doctor.mjs";

const tool = (dir, name, body = "#!/bin/sh\n") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  return join(dir, name);
};

test("the command words of a shell command: prefixes, keywords, redirections and builtins skipped; the repository's own files left out", () => {
  const words = (c) => simpleCommands(c).map((s) => s.word);
  assert.deepEqual(words("FOO=1 sudo -E env uv run pytest && cargo test 2> err.log; if make check; then echo ok; fi | tee out"), ["uv", "cargo", "make", "tee"]);
  assert.deepEqual(words("cd sub && ./scripts/check.sh && scripts/x.sh; $TOOL run; ~/bin/t; /opt/go/bin/go vet ./..."), ["/opt/go/bin/go"]);
  assert.deepEqual(simpleCommands("pnpm --filter app run lint")[0], { word: "pnpm", args: ["--filter", "app", "run", "lint"] });
});

test("the words of the repository's commands: validation, setup and install, and one level of the package.json scripts they run", () => {
  const clone = mkdtempSync(join(tmpdir(), "rw-"));
  writeFileSync(join(clone, "package.json"), JSON.stringify({ scripts: { pretest: "deno fmt --check", test: "uv run pytest && npm run lint", lint: "ruff check", posttest: "/opt/x/bin/planted" } }));
  const got = repositoryWords({ clone, commands: { validation: ["npm test", "/usr/local/go/bin/go test ./..."], setup: "bun install", install: "uv sync --frozen" } });
  assert.deepEqual(got, [
    { word: "npm", from: "validation" },
    { word: "deno", from: "package.json scripts.pretest" },
    { word: "uv", from: "package.json scripts.test" },
    { word: "/usr/local/go/bin/go", from: "validation" },
    { word: "bun", from: "setup" },
  ], "one level: `npm run lint` inside a script is not followed; an absolute word only from the configured commands");
});

test("a version manager's shim resolves to the version the repository pins, else the only install, never by running it; several unpinned are named", () => {
  const root = mkdtempSync(join(tmpdir(), "rshim-"));
  const home = join(root, "h");
  const data = join(home, ".local", "share", "mise");
  const marker = join(root, "ran");
  tool(home, "mise", `#!/bin/sh\ntouch '${marker}'\n`);
  mkdirSync(join(data, "shims"), { recursive: true });
  symlinkSync(join(home, "mise"), join(data, "shims", "uv"));
  const uv = tool(join(data, "installs", "uv", "0.13.7", "uv-x86_64-unknown-linux-gnu"), "uv");
  symlinkSync(join(data, "installs", "uv", "0.13.7"), join(data, "installs", "uv", "latest"));
  const clone = mkdtempSync(join(root, "c-"));
  const commands = { validation: ["uv run pytest"] };
  const path = `${join(data, "shims")}:/usr/bin`;
  assert.deepEqual(repositoryTools({ clone, commands, path, home }).tools, [{ word: "uv", from: "validation", real: uv, dirs: [join(data, "installs", "uv", "0.13.7")], link: true }], "its only install (an alias to it is the same one)");
  const newer = tool(join(data, "installs", "uv", "0.14.0", "bin"), "uv");
  assert.match(repositoryTools({ clone, commands, path, home }).unresolved[0].why, /uv has several versions installed and none pinned/);
  writeFileSync(join(clone, ".tool-versions"), "uv 0.14.0\n");
  assert.equal(repositoryTools({ clone, commands, path, home }).tools[0].real, newer, ".tool-versions pins it");
  writeFileSync(join(clone, ".tool-versions"), "");
  writeFileSync(join(clone, "mise.toml"), '[tools]\nuv = "0.13.7"\n');
  assert.equal(repositoryTools({ clone, commands, path, home }).tools[0].real, uv, "mise.toml pins it");
  assert.ok(!existsSync(marker), "the manager never ran");
});

test("a repository tool never opens the home, a credential store or what a sandbox may write", () => {
  const home = mkdtempSync(join(tmpdir(), "rhome-"));
  const cargo = tool(join(home, ".cargo", "bin"), "cargo");
  writeFileSync(join(home, ".cargo", "credentials.toml"), "token = 'x'\n");
  const own = tool(join(home, "bin"), "mine");
  tool(join(home, ".config", "factory", "bin"), "leak");
  const writable = join(home, "work");
  tool(join(writable, "bin"), "planted");
  const clone = mkdtempSync(join(home, "c-"));
  const path = ["/usr/bin", join(home, ".cargo", "bin"), join(home, "bin"), join(home, ".config", "factory", "bin"), join(writable, "bin")].join(":");
  const r = repositoryTools({ clone, commands: { validation: ["cargo test", "mine", "leak", "planted", "ls"] }, path, off: [writable], home });
  assert.deepEqual(r.tools, [
    { word: "cargo", from: "validation", real: cargo, dirs: [cargo], link: true },
    { word: "mine", from: "validation", real: own, dirs: [own], link: true },
    { word: "ls", from: "validation", real: "/usr/bin/ls", dirs: [], link: false },
  ], "~/.cargo holds a registry token, so the executable alone; never the home; the system's own needs nothing");
  assert.deepEqual(r.unresolved.map((u) => u.word), ["leak", "planted"]);
});

test("local mode (#371), the real path: a validation tool outside node, npm, pnpm and yarn is visible to Claude Code's commands; an unresolvable word is named once; secrets stay denied", async () => {
  const { Local } = await import("../scripts/local.mjs");
  const root = mkdtempSync(join(tmpdir(), "rtl-"));
  const mytool = tool(join(root, "opt", "mytool", "bin"), "mytool");
  const scripted = tool(join(root, "opt", "st", "bin"), "scripttool");
  mkdirSync(join(root, "stages"));
  const stageTmp = mkdtempSync(join(root, "stages", "s-"));
  const dev = mkdtempSync(join(root, "dev-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "o/r", wf: { FACTORY_VALIDATION: "mytool check, npm test, nosuchtool-371 run" }, stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(8), "repo");
  mkdirSync(join(clone, ".git"), { recursive: true });
  pinGitDir(clone, gitPinFile(local.ws(8)));
  writeFileSync(join(clone, "package.json"), JSON.stringify({ scripts: { test: "scripttool --all" } }));
  const usage = join(local.ws(8), "usage-work-1");
  mkdirSync(usage, { recursive: true });
  const path = process.env.PATH;
  const lines = [];
  process.env.PATH = `${join(root, "opt", "mytool", "bin")}:${join(root, "opt", "st", "bin")}:${path}`;
  logTo({ write: (s) => lines.push(s) });
  let env;
  try {
    env = local.stageEnv(8, usage, clone, stageTmp, "worker.mjs", "claude");
    local.stageEnv(8, usage, clone, stageTmp, "worker.mjs", "claude");
  } finally {
    process.env.PATH = path;
    logTo(null);
  }
  const box = localSandbox(env);
  const toolBin = join(usage, "toolbin");
  assert.deepEqual(box.toolchain.tools, [join(toolBin, "mytool"), join(toolBin, "scripttool")], "the probe proves both");
  assert.equal(realpathSync(join(toolBin, "mytool")), realpathSync(mytool));
  assert.equal(realpathSync(join(toolBin, "scripttool")), realpathSync(scripted));
  for (const d of [join(root, "opt", "mytool"), join(root, "opt", "st")]) assert.ok(box.readable.includes(d), `${d} read-only in its sandbox`);
  assert.match(readFileSync(box.claudeEnv, "utf8"), new RegExp(`'${toolBin}'`), "the toolbin leads each command's PATH");
  assert.equal(lines.filter((l) => l.includes("nosuchtool-371")).length, 1, "named once per loop");
  assert.match(lines.find((l) => l.includes("nosuchtool-371")), /`nosuchtool-371` \(validation\) is not visible to Claude Code's commands: not on PATH/);
  // Claude Code's settings: the tools readable, the credential stores and Factory's own settings still denied.
  const { args } = harnessCommand({ harness: "claude", prompt: "p", local: box });
  const fs = JSON.parse(args[args.indexOf("--settings") + 1]).sandbox.filesystem;
  assert.ok(fs.allowRead.includes(join(root, "opt", "mytool")));
  for (const secret of [".ssh", ".config/factory", ".cargo/credentials.toml"]) assert.ok(fs.denyRead.includes(join(homedir(), secret)), `${secret} stays denied`);
});

test("the probe's toolchain rule: a repository tool linked from the toolbin must be found and reach an executable", () => {
  const root = mkdtempSync(join(tmpdir(), "rprobe-"));
  const [tmp, bin] = [join(root, "t"), join(root, "toolbin")];
  mkdirSync(tmp);
  mkdirSync(bin);
  const real = tool(join(root, "opt", "bin"), "mytool");
  symlinkSync(real, join(bin, "mytool"));
  symlinkSync(join(root, "gone", "other"), join(bin, "other"));
  const drive = (tools) => {
    const driver = probeDriver({ gitConfig: "", host: "", marker: "m9", toolchain: { tools }, copilotTmp: join(root, "no-copilot-tmp") });
    execFileSync("/bin/sh", ["-c", driver], { stdio: ["ignore", "pipe", "ignore"], env: { HOME: process.env.HOME, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE, FACTORY_PROBE_DECOY: "999999999", [PROBE_MARKER]: "m9" } });
    return readFileSync(join(tmp, PROBE_RESULT), "utf8");
  };
  assert.equal(drive([join(bin, "other")]), `4\n${TOOLCHAIN_RULE}\n`, "a link whose executable the sandbox does not show");
  assert.equal(drive([join(bin, "mytool")]), "4\nthe credential stand-in is readable in a process environment\n", "found: on to the confinement rules (unconfined here)");
});

test("doctor --local names each repository tool Claude Code's and Copilot's commands would not find", () => {
  const root = mkdtempSync(join(tmpdir(), "rdoc-"));
  const repo = join(root, "r");
  mkdirSync(repo);
  tool(join(root, "bin"), "node");
  const uv = tool(join(root, "opt", "uv", "bin"), "uv");
  const env = { PATH: `${join(root, "bin")}:${join(root, "opt", "uv", "bin")}` };
  const rows = localToolchainRows({ checkout: repo, env, commands: { validation: ["uv run pytest", "nosuchtool-371b x"], setup: "", install: null }, os: "linux", run: () => "v1\n" });
  const row = rows.find((r) => r.name === "repository tools");
  assert.equal(row.status, "WARN");
  assert.match(row.detail, /^nosuchtool-371b \(validation\): not on PATH; Claude Code's and Copilot's commands cannot run it\. Visible: uv → /);
  assert.ok(row.detail.includes(uv));
  const ok = localToolchainRows({ checkout: repo, env, commands: { validation: ["uv run pytest"] }, os: "linux", run: () => "v1\n" }).find((r) => r.name === "repository tools");
  assert.equal(ok.status, "PASS");
});
