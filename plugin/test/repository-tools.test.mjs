import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessCommand } from "../scripts/lib/harness.mjs";
import { repositoryTools } from "../scripts/lib/copilot-runner.mjs";
import { gitPinFile, localSandbox, pinGitDir } from "../scripts/lib/local.mjs";
import { logTo } from "../scripts/lib/inputs.mjs";

const tool = (dir, name, body = "#!/bin/sh\n") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  return join(dir, name);
};

test("a repository tool never opens the home, a credential store or what a sandbox may write", () => {
  const home = mkdtempSync(join(tmpdir(), "rhome-"));
  const cargo = tool(join(home, ".cargo", "bin"), "cargo");
  writeFileSync(join(home, ".cargo", "credentials.toml"), "token = 'x'\n");
  const own = tool(join(home, "bin"), "mine");
  tool(join(home, ".config", "pendulum", "bin"), "leak");
  const writable = join(home, "work");
  tool(join(writable, "bin"), "planted");
  const clone = mkdtempSync(join(home, "c-"));
  const path = ["/usr/bin", join(home, ".cargo", "bin"), join(home, "bin"), join(home, ".config", "pendulum", "bin"), join(writable, "bin")].join(":");
  const r = repositoryTools({ clone, commands: { validation: ["cargo test", "mine", "leak", "planted", "ls"] }, path, off: [writable], home });
  assert.deepEqual(r.tools, [
    { word: "cargo", from: "validation", real: cargo, dirs: [cargo], denied: [], link: true },
    { word: "mine", from: "validation", real: own, dirs: [own], denied: [], link: true },
    { word: "ls", from: "validation", real: "/usr/bin/ls", dirs: [], denied: [], link: false },
  ], "~/.cargo is a directory directly in the home (and holds a registry token): the executable alone; never the home; the system's own needs nothing");
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
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "o/r", wf: { PENDULUM_VALIDATION: "mytool check, npm test, nosuchtool-371 run" }, stopping: false, firstSetup: new Map(), children: new Set() });
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
  assert.ok(box.readable.includes(join(root, "opt", "mytool", "bin")), "a configured command's tool: its install's bin, read-only");
  assert.ok(box.readable.includes(realpathSync(scripted)) && !box.readable.includes(join(root, "opt", "st", "bin")), "a script's tool: the executable alone");
  assert.match(readFileSync(box.claudeEnv, "utf8"), new RegExp(`'${toolBin}'`), "the toolbin leads each command's PATH");
  assert.equal(lines.filter((l) => l.includes("nosuchtool-371")).length, 1, "named once per loop");
  assert.match(lines.find((l) => l.includes("nosuchtool-371")), /`nosuchtool-371` \(validation\) is not visible to Claude Code's commands: not on PATH/);
  // Claude Code's settings: the tools readable, the credential stores and Pendulum's own settings still denied.
  const { args } = harnessCommand({ harness: "claude", prompt: "p", local: box });
  const fs = JSON.parse(args[args.indexOf("--settings") + 1]).sandbox.filesystem;
  assert.ok(fs.allowRead.includes(join(root, "opt", "mytool", "bin")));
  for (const secret of [".ssh", ".config/pendulum", ".cargo/credentials.toml"]) assert.ok(fs.denyRead.includes(join(homedir(), secret)), `${secret} stays denied`);
});

test("who wrote a word decides its reach: a script's tool is its executable alone, a configured one its install's bin and lib, never a directory directly in the home", () => {
  const home = mkdtempSync(join(tmpdir(), "rwho-"));
  const fly = tool(join(home, ".fly", "bin"), "flyctl");
  writeFileSync(join(home, ".fly", "config.yml"), "access_token: x\n");
  const proj = tool(join(home, "proj", "bin"), "mytool");
  writeFileSync(join(home, "proj", ".env"), "SECRET=x\n");
  const deep = tool(join(home, "tools", "kit", "bin"), "kit");
  mkdirSync(join(home, "tools", "kit", "lib"));
  writeFileSync(join(home, "tools", "kit", ".env"), "SECRET=x\n");
  const path = [join(home, ".fly", "bin"), join(home, "proj", "bin"), join(home, "tools", "kit", "bin"), "/usr/bin"].join(":");
  const clone = mkdtempSync(join(tmpdir(), "rwc-"));
  writeFileSync(join(clone, "package.json"), JSON.stringify({ scripts: { test: "flyctl version && mytool && kit" } }));
  const reach = (commands) => Object.fromEntries(repositoryTools({ clone, commands, path, home }).tools.map((t) => [t.word, t.dirs]));
  assert.deepEqual(reach({ validation: ["npm test"] }), { flyctl: [fly], mytool: [proj], kit: [deep] }, "from package.json: the executable alone, never ~/.fly (its token) or the checkout (its .env)");
  assert.deepEqual(reach({ validation: ["flyctl version", "mytool", "kit"] }), { flyctl: [fly], mytool: [proj], kit: [join(home, "tools", "kit", "bin"), join(home, "tools", "kit", "lib")] }, "configured: bin and lib of a deeper prefix, never a directory directly in the home");
});

test("an install that is all the tool's own is bound whole but its etc, which is denied (a second node's npmrc holds a registry token)", () => {
  const home = mkdtempSync(join(tmpdir(), "retc-"));
  const v22 = join(home, ".nvm", "versions", "node", "v22.1.0");
  const t = tool(join(v22, "bin"), "tsx");
  mkdirSync(join(v22, "lib"));
  mkdirSync(join(v22, "etc"));
  writeFileSync(join(v22, "etc", "npmrc"), "//registry.npmjs.org/:_authToken=x\n");
  const clone = mkdtempSync(join(tmpdir(), "retcc-"));
  writeFileSync(join(clone, "package.json"), JSON.stringify({ scripts: { test: "tsx t.ts" } }));
  const [got] = repositoryTools({ clone, commands: { validation: ["npm test"] }, path: join(v22, "bin"), home }).tools;
  assert.deepEqual(got, { word: "tsx", from: "package.json scripts.test", real: t, dirs: [join(v22, "bin"), join(v22, "lib")], denied: [join(v22, "etc")], link: true });
});

test("a package.json script never makes Pendulum's front end, a harness or its sandbox visible, by name or by a link to one", () => {
  const root = mkdtempSync(join(tmpdir(), "rharn-"));
  const bin = join(root, "opt", "bin");
  const claude = tool(bin, "claude");
  for (const w of ["pendulum", "codex", "copilot", "srt", "bwrap"]) tool(bin, w);
  symlinkSync(claude, join(bin, "cc"));
  const clone = mkdtempSync(join(root, "c-"));
  writeFileSync(join(clone, "package.json"), JSON.stringify({ scripts: { test: "pendulum run; claude -p x; codex; copilot; srt x; bwrap x; cc" } }));
  const r = repositoryTools({ clone, commands: { validation: ["npm test"] }, path: bin, home: join(root, "h") });
  assert.deepEqual(r.tools, []);
  assert.deepEqual(r.unresolved.map((u) => u.word), ["pendulum", "claude", "codex", "copilot", "srt", "bwrap", "cc"]);
  assert.match(r.unresolved[0].why, /never made visible from a package\.json script/);
});
