import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A stateful credential-free infrastructure provider. Harness runs only in real child processes. */
export class FixtureSandboxProvider {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.resources = new Map();
    this.processes = new Map();
    this.starts = 0;
    this.maxActive = 0;
    this.autoRelease = false;
  }
  own(h) {
    assert.equal(this.resources.get(h.identity)?.attemptId, h.attemptId);
    assert.equal(h.workspace, this.resources.get(h.identity)?.workspace);
    return h;
  }
  async create({ attemptId }) {
    const h = {
      identity: randomUUID(),
      attemptId,
      workspace: join(this.root, attemptId),
    };
    mkdirSync(h.workspace);
    this.resources.set(h.identity, h);
    this.maxActive = Math.max(this.maxActive, this.resources.size);
    if (this.createUnknown) throw Error("create acknowledgement lost");
    return structuredClone(h);
  }
  async prepareRepository(h, input) {
    this.own(h);
    if (!this.repository) throw Error("Fixture repository not configured");
    this.preparations ??= [];
    this.preparations.push(structuredClone(input));
    const repo = join(h.workspace, "repo");
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("fetch", "--depth=1", "--no-tags", this.repository, input.baseSha);
    git("checkout", "-q", "--detach", input.baseSha);
    git(
      "config",
      "http.extraHeader",
      "Authorization: fixture-preparation-canary",
    );
    assert.equal(git("rev-parse", "HEAD^{tree}"), input.treeSha);
    for (const [index, source] of input.lfsSources.entries()) {
      if (!this.lfsObjects?.has(source.digest))
        throw Error("Fixture LFS object unavailable");
      mkdirSync(join(h.workspace, "lfs"), { recursive: true });
      copyFileSync(
        this.lfsObjects.get(source.digest),
        join(h.workspace, "lfs", String(index)),
      );
    }
    for (const name of ["config", "hooks", "logs", "FETCH_HEAD"])
      rmSync(join(repo, ".git", name), { recursive: true, force: true });
    if (this.wrongBase) git("update-ref", "HEAD", this.wrongBase);
  }
  async upload(h, input) {
    this.own(h);
    assert(resolve(input.remotePath).startsWith(h.workspace + "/"));
    const b = readFileSync(input.localPath);
    assert.equal(sha(b), input.digest);
    assert.equal(b.length, input.bytes);
    copyFileSync(input.localPath, input.remotePath);
    if (this.autoRelease) writeFileSync(join(h.workspace, "release"), "go");
    if (this.corruptInput && input.remotePath.endsWith("input.tar"))
      writeFileSync(input.remotePath, "corrupt");
  }
  async execute(h, command) {
    this.own(h);
    assert.equal(command.cwd, h.workspace);
    this.starts++;
    const p = {
      identity: randomUUID(),
      sandboxIdentity: h.identity,
      attemptId: h.attemptId,
    };
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: h.workspace },
    });
    const state = {
      child,
      sandboxIdentity: h.identity,
      state: "running",
      detail: "",
    };
    child.stdout.on("data", (b) => {
      state.detail += b;
    });
    child.stderr.on("data", (b) => {
      state.detail += b;
    });
    child.once("error", (e) => {
      state.state = "failed";
      state.detail = e.message;
    });
    child.once("exit", (code) => {
      state.state =
        code === 0 ? "complete" : state.cancelled ? "cancelled" : "failed";
    });
    this.processes.set(p.identity, state);
    if (this.executeUnknown) throw Error("execute acknowledgement lost");
    return p;
  }
  async observe(h, p) {
    this.own(h);
    assert.equal(p.sandboxIdentity, h.identity);
    assert.equal(p.attemptId, h.attemptId);
    const s = this.processes.get(p.identity);
    assert(s);
    return { state: s.state, detail: s.detail };
  }
  async cancel(h, p) {
    this.own(h);
    const s = this.processes.get(p.identity);
    if (s.state === "running") {
      s.cancelled = true;
      s.child.kill("SIGTERM");
      await new Promise((r) => s.child.once("exit", r));
    }
  }
  async download(h, { remotePath, localPath }) {
    this.own(h);
    assert(resolve(remotePath).startsWith(h.workspace + "/"));
    let b = readFileSync(remotePath);
    if (this.mutateReply && remotePath.endsWith(".json")) {
      const d = JSON.parse(b);
      this.mutateReply(d);
      b = Buffer.from(JSON.stringify(d));
    }
    writeFileSync(localPath, b);
    return {
      digest: this.badDigest ? "0".repeat(64) : sha(b),
      bytes: b.length,
    };
  }
  async destroy(h) {
    if (!this.resources.has(h.identity)) return;
    this.own(h);
    if (this.destroyFailure) throw Error("sandbox destruction not confirmed");
    for (const s of this.processes.values())
      if (s.sandboxIdentity === h.identity) assert.notEqual(s.state, "running");
    // This fixture's harness creates one leaf child. Dispose only its recorded owned PID.
    const handlePath = join(h.workspace, "harness.json");
    if (existsSync(handlePath)) {
      const harness = JSON.parse(readFileSync(handlePath, "utf8"));
      if (!harness.data) {
        rmSync(h.workspace, { recursive: true });
        this.resources.delete(h.identity);
        return;
      }
      assert.equal(harness.data.root, h.workspace);
      assert.equal(harness.identity, h.attemptId);
      const proc = `/proc/${harness.data.pid}/cmdline`;
      if (existsSync(proc)) {
        const argv = readFileSync(proc, "utf8").split("\0");
        if (argv.includes(join(h.workspace, "fixture-request.json"))) {
          try {
            process.kill(harness.data.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    }
    rmSync(h.workspace, { recursive: true });
    this.resources.delete(h.identity);
  }
}

export function writeSandboxInvoker(root, packageEntry) {
  const script = join(root, "sandbox-entry.mjs");
  writeFileSync(
    script,
    `
import {runSandboxHarness} from ${JSON.stringify(packageEntry)};
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2];
const harness={capabilities:{protocolVersion:1,worktree:'factory-owned-read-write',head:'preserve',lifecycle:'restart-safe-durable-handle',publication:'controller-only',assetSets:true,authentication:'none'},
 async start(request){
  if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.DAYTONA_API_KEY || existsSync(join(request.worktree,'.git/config')))throw Error('Repository authority leaked into harness');
  const requestPath=join(root,'fixture-request.json');writeFileSync(requestPath,JSON.stringify(request));
  const child=spawn(process.execPath,[${JSON.stringify(join(root, "fixture-agent.mjs"))},requestPath,root],{cwd:request.worktree,detached:true,stdio:'ignore'});child.unref();
  return {identity:request.attemptId,data:{pid:child.pid,root}};
 },
 async observe(handle){const p=join(handle.data.root,'fixture-result.json');if(existsSync(p))return JSON.parse(readFileSync(p)).observation;return {state:'running'};},
 async cancel(handle){try{process.kill(handle.data.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}writeFileSync(join(handle.data.root,'fixture-result.json'),JSON.stringify({observation:{state:'cancelled'}}));},
 async collect(handle){const r=JSON.parse(readFileSync(join(handle.data.root,'fixture-result.json')));if(r.observation.state!=='complete')throw Error('No complete fixture result');return r.result;}
};
await runSandboxHarness({identity:'fixture-harness@1',config:{},harness});
`,
  );
  writeFileSync(
    join(root, "fixture-agent.mjs"),
    `
import {readFileSync,writeFileSync,mkdirSync,rmSync,chmodSync,existsSync} from 'node:fs';import {join} from 'node:path';
const request=JSON.parse(readFileSync(process.argv[2])),root=process.argv[3];
while(!existsSync(join(root,'release')))await new Promise(r=>setTimeout(r,10));
const base=request.worktree;
if(request.item.id==='successor'&&!readFileSync(join(base,'keep.txt'),'utf8').includes('changed'))throw Error('Successor did not receive exact integrated base');
for(const source of [...(request.sourceAssets??[]),...(request.selectedAssets??[])])if(source.path&&!existsSync(source.path))throw Error('Missing bound source');
let assets;
if(request.item.id==='media'){mkdirSync(join(base,'.factory-media'));const bytes=readFileSync(request.sourceAssets[0].path);writeFileSync(join(base,'.factory-media/copy.bin'),bytes);assets=[{id:'complete-set',members:[{role:'image',path:'.factory-media/copy.bin',mediaType:'application/octet-stream',destination:'image.bin'}],provenance:{source:'fixture-original',rights:'fixture-owned',visibility:'repository',lineage:['exact original']}}];}
else if(request.item.id==='application'){writeFileSync(join(base,'sandbox.txt'),'separate process result\\n');}
else if(request.item.id==='application-second'){if(!readFileSync(join(base,'sandbox.txt'),'utf8').includes('separate process result'))throw Error('Missing published predecessor');writeFileSync(join(base,'sandbox-next.txt'),'published successor\\n');}
else {writeFileSync(join(base,'keep.txt'),'changed\\n');rmSync(join(base,'old.txt'),{force:true});writeFileSync(join(base,'new.bin'),Buffer.from([0,1,255,254]));writeFileSync(join(base,'run.sh'),'#!/bin/sh\\nexit 0\\n');chmodSync(join(base,'run.sh'),0o755);}
writeFileSync(join(root,'fixture-result.json'),JSON.stringify({observation:{state:'complete'},result:{...(assets?{assets}:{}),evidence:{harness:"fixture-harness@1",childPid:process.pid,attempt:request.attemptId}}}));
`,
  );
  return [process.execPath, script];
}
