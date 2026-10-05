import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hostSchedulingDefaults } from "../dist/config.js";
import { defaultAutonomy } from "../dist/index.js";
import { saveState, statePath } from "../dist/state-store.js";
import { readIntake } from "../dist/intake.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const installedCli = realpathSync(new URL("../dist/cli.js", import.meta.url));
/** Running setup --background is the service consent; nothing else is asked. */
const background = ["--background"];
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "factory-setup-entry-"));
  const checkout = createTarget(root).checkout;
  factoryConfig(checkout, "example/setup");
  const configPath = join(root, "factory.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const preload = join(root, "github.mjs");
  writeFileSync(
    preload,
    `import fs from 'node:fs';
import childProcess from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const root=process.env.FACTORY_SETUP_FIXTURE;
globalThis.__setupDenySdk=()=>{fs.appendFileSync(root+'/forbidden-sdk-construction','attempt\\n');throw Error('Fixture forbids SDK construction')};
registerHooks({resolve(specifier,context,next){
 if(specifier==='@openai/codex-sdk')return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent("export class Codex {constructor(){globalThis.__setupDenySdk()}}")};
 return next(specifier,context);
}});
if(fs.existsSync(root+'/readiness-mode')){
 const spawn=childProcess.spawn;
 childProcess.spawn=(file,args,options)=>args.includes('app-server')?spawn(process.execPath,[root+'/readiness-server.mjs',...args],options):spawn(file,args,options);
 syncBuiltinESMExports();
}
globalThis.fetch=async (url, input={})=>{
 const address=String(url); const method=input.method??'GET';
 fs.appendFileSync(root+'/requests', JSON.stringify({address,method})+'\\n');
 if(method!=='GET'||!address.startsWith('https://api.github.com/repos/example/setup/issues')) throw Error('Fixture forbids provider calls and remote mutations');
 if(fs.existsSync(root+'/open-unapproved')){
  if(new URL(address).pathname.endsWith('/issues/99')){fs.appendFileSync(root+'/forbidden-dispatch','attempt\\n');throw Error('Fixture forbids unapproved Objective reads')};
  return new Response(JSON.stringify([{number:99,state:'open',labels:[{name:'urgent'}]}]),{status:200,headers:{'content-type':'application/json',etag:'fixture-unapproved-99'}});
 }
 if(fs.existsSync(root+'/github-unavailable')||(process.argv.includes('serve')&&fs.existsSync(root+'/service-github-unavailable'))) return new Response(JSON.stringify({message:'Unavailable'}),{status:503,headers:{'content-type':'application/json'}});
 const data=address.match(/\\/issues\\/1(?:$|\\?)/)?{number:1,title:'Closed approved issue',body:fs.existsSync(root+'/objective-body')?fs.readFileSync(root+'/objective-body','utf8'):'fixture exact approved body',state:'closed',labels:[]}:[{number:1,state:'closed',labels:[]}];
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json',etag:'fixture-1'}});
};`,
  );
  writeFileSync(
    join(root, "readiness-server.mjs"),
    `import fs from 'node:fs';import {createInterface} from 'node:readline';
const root=${JSON.stringify(root)};
const lines=createInterface({input:process.stdin});lines.on('line',line=>{
 const message=JSON.parse(line);fs.appendFileSync(root+'/readiness-requests',JSON.stringify({message,args:process.argv.slice(2)})+'\\n');
 if(!message.id)return;
 if(message.method==='initialize'){console.log(JSON.stringify({id:message.id,result:{}}));return;}
 if(message.method!=='command/exec')throw Error('Fixture forbids model requests');
 const [,,,inside,outside,token]=message.params.command;
 if(fs.existsSync(outside))throw Error('Host sentinel must be removed before sandbox probe');
 fs.writeFileSync(inside,token);
 const refused=fs.readFileSync(root+'/readiness-mode','utf8')==='refused';if(!refused)fs.writeFileSync(outside,token);
 console.log(JSON.stringify({id:message.id,result:{exitCode:0,stdout:JSON.stringify({writable:true,refused}),stderr:''}}));
});`,
  );
  writeFileSync(
    join(bin, "gh"),
    "#!/bin/sh\nif test \"$1 $2\" = 'auth token'; then echo fixture-no-live-credential; else exit 1; fi\n",
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "loginctl"), "#!/bin/sh\necho no\n", { mode: 0o700 });
  writeFileSync(
    join(bin, "systemctl"),
    `#!${process.execPath}
import fs from 'node:fs'; import {spawn,spawnSync} from 'node:child_process';
const root=process.env.FACTORY_SETUP_FIXTURE; const action=process.argv[3];
fs.appendFileSync(root+'/calls',process.argv.slice(2).join(' ')+'\\n');
const file=name=>root+'/'+name;
const alive=()=>{try{const text=fs.readFileSync('/proc/'+fs.readFileSync(file('pid'),'utf8')+'/stat','utf8');return !['Z','X'].includes(text.slice(text.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;}};
if(action==='is-system-running'){console.log(fs.existsSync(file('unsupported'))?'offline':'running');}
else if(action==='is-active'){console.log(fs.existsSync(file('start-failure'))||(!alive()&&fs.existsSync(file('unit-failed')))?'failed':alive()?'active':'inactive');}
else if(action==='is-enabled'){console.log(fs.existsSync(file('enabled'))?'enabled':'not-found');}
else if(action==='show'){console.log(alive()?fs.readFileSync(file('pid'),'utf8'):'0');}
else if(action==='enable'){if(fs.existsSync(file('enable-failure')))process.exit(1);fs.writeFileSync(file('registered'),process.argv[4]);fs.writeFileSync(file('enabled'),'');}
else if(action==='disable'){fs.rmSync(file('enabled'),{force:true});}
else if(action==='stop'&&fs.existsSync(file('refill-at-stop'))){
 fs.rmSync(file('refill-at-stop'));
 const target=spawnSync(process.execPath,[${JSON.stringify(installedCli)},'queue','add','1','--config',file('factory.json')],{env:process.env,encoding:'utf8'});
 if(target.status!==0){console.error(target.stderr);process.exit(1);}
}
else if(action==='stop'&&fs.existsSync(file('foreign-at-stop'))){
 const input=JSON.parse(fs.readFileSync(file('foreign-at-stop'),'utf8'));
 fs.mkdirSync(input.directory,{recursive:true});fs.writeFileSync(input.directory+'/state.json',JSON.stringify(input.snapshot));
 fs.rmSync(file('foreign-at-stop'));
}
else if(action==='start'&&!alive()&&!fs.existsSync(file('start-failure'))){
 fs.rmSync(file('unit-failed'),{force:true});
 const unit=fs.readFileSync(fs.readFileSync(file('registered'),'utf8'),'utf8');
 const binding=JSON.parse(unit.split('\\n')[0].slice('# Factory local supervision v1 '.length));
 const args=[binding.cli,'supervisor','serve','--config',binding.config];
 const env={...process.env,...binding.environment,XDG_STATE_HOME:binding.stateHome};
 for(const credential of binding.credentials??[]){const dir=file('loaded');fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(credential.file,dir+'/'+credential.name);env.CREDENTIALS_DIRECTORY=dir;args.push('--service-credential',credential.name);}
 const child=spawn(binding.node,args,{env,detached:true,stdio:['ignore',fs.openSync(file('service-out'),'a'),fs.openSync(file('service-error'),'a')]});
 fs.writeFileSync(file('pid'),String(child.pid));fs.appendFileSync(file('starts'),'start\\n');child.unref();
}
`,
    { mode: 0o700 },
  );
  // The sandbox probe writes a sentinel into the home directory; keep it private to the fixture.
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "readiness-mode"), "refused");
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    FACTORY_SETUP_FIXTURE: root,
    NODE_OPTIONS: `--import=${preload}`,
  };
  function run(commandArgs) {
    const command = spawnSync(
      process.execPath,
      [installedCli, ...commandArgs, "--config", configPath],
      { env, encoding: "utf8", timeout: 25000 },
    );
    assert.equal(command.signal, null, command.stderr);
    return {
      ...command,
      document: command.stdout.trim().startsWith("{")
        ? JSON.parse(command.stdout)
        : undefined,
    };
  }
  function installArgs() {
    return [
      "--repository",
      "example/setup",
      "--checkout",
      checkout,
      "--concurrency",
      "1",
    ];
  }
  /** Write the configuration and poll the queue quickly, so the service observes within the test. */
  function configure(...extra) {
    const configured = run([
      "setup",
      "--config-only",
      ...installArgs(),
      ...extra,
    ]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.queue = { pollSeconds: 0.05 };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  }
  /** Run a read-only command until its document satisfies the check. */
  async function until(commandArgs, check) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = run(commandArgs);
      if (result.document && check(result.document)) return result.document;
      assert.ok(Date.now() < deadline, `waiting for ${commandArgs.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let bodyError;
  try {
    await fn({
      root,
      checkout,
      configPath,
      env,
      run,
      installArgs,
      configure,
      until,
    });
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      rmSync(join(root, "unsupported"), { force: true });
      if (existsSync(configPath)) {
        const stop = run(["supervisor", "uninstall"]);
        assert.equal(stop.status, 0, stop.stderr);
      }
    } catch (cleanupError) {
      if (bodyError)
        throw new AggregateError(
          [bodyError, cleanupError],
          "Setup fixture body and owner cleanup both failed; fixture retained",
        );
      throw cleanupError;
    }
    rmSync(root, { recursive: true, force: true });
  }
  if (bodyError) throw bodyError;
}

test("setup fixture preserves its original failure when owner cleanup also fails", async () => {
  let retainedRoot;
  try {
    await assert.rejects(
      fixture(async ({ root, configPath }) => {
        retainedRoot = root;
        writeFileSync(configPath, "{}");
        throw new Error("Original setup body failure");
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, "Original setup body failure");
        assert.match(error.errors[1].message, /Factory:/);
        assert.equal(existsSync(retainedRoot), true);
        return true;
      },
    );
  } finally {
    if (retainedRoot) rmSync(retainedRoot, { recursive: true, force: true });
  }
});

test("actual guided CLI sets up an idle service, verifies its owner and reuses it without duplicate controllers", () =>
  fixture(async ({ root, run, configure, configPath }) => {
    writeFileSync(join(root, "open-unapproved"), "");
    configure();
    const first = run(["setup", ...background]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(first.document.status, "ready");
    assert.equal(first.document.repository, "example/setup");
    assert.equal(first.document.service.active, "active");
    assert.equal(first.document.service.binding.cli, installedCli);
    assert.equal(first.document.queue.pollSeconds, 0.05);
    assert.deepEqual(first.document.queue.queued, []);
    // The same checks `run` makes on an Objective's first start run here, queued work or not.
    assert.equal(first.document.readiness.status, "ready");
    assert.equal(first.document.readiness.outsideWriteRefused, true);
    assert.equal(first.document.host.logoutPersistence, "not-enabled");
    const config = readFileSync(configPath);
    const pid = readFileSync(join(root, "pid"), "utf8");
    const again = run(["setup", ...background]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(again.document.status, "ready");
    assert.equal(readFileSync(join(root, "pid"), "utf8"), pid);
    assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
    assert.deepEqual(readFileSync(configPath), config);
    const requests = readFileSync(join(root, "requests"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.ok(
      requests.every(
        (request) => !new URL(request.address).pathname.endsWith("/issues/99"),
      ),
    );
    const state = run(["queue", "list"]).document;
    assert.deepEqual(state.observation.unapproved, [99]);
    assert.equal(state.observation.idleReason, "awaiting-approved-work");
    assert.deepEqual(state.objectives, []);
    assert.deepEqual(state.bodyDigests, {});
    assert.equal(state.watch, true);
    const repositoryState = join(
      root,
      "state/clockgrove-factory/repositories/example/setup",
    );
    for (const path of ["objectives", "harness", "model-invocations"])
      assert.equal(existsSync(join(repositoryState, path)), false, path);
    for (const path of ["forbidden-sdk-construction", "forbidden-dispatch"])
      assert.equal(existsSync(join(root, path)), false, path);
    assert.equal(readFileSync(join(root, "service-error"), "utf8"), "");
    // status without an Objective is the service and the queue.
    const shown = run(["status"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Service: active, enabled \(factory-/m);
    assert.match(shown.stdout, /^Queue: running; empty$/m);
    assert.match(shown.stdout, /`factory queue add N` queues an Objective/);
    const json = JSON.parse(run(["status", "--json"]).stdout);
    assert.equal(json.service.active, "active");
    assert.equal(json.queue.watch, true);
  }));

test("actual guided configuration-only setup succeeds with unavailable manager and background setup stops at the host", () =>
  fixture(async ({ root, run, installArgs, configPath }) => {
    writeFileSync(join(root, "unsupported"), "");
    const configured = run(["setup", "--config-only", ...installArgs()]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    assert.equal(configured.document.status, "configured");
    assert.equal(existsSync(join(root, "registered")), false);
    const saved = readFileSync(configPath);
    // Neither mode takes a consent flag: choosing --background is the consent.
    const neither = run(["setup"]);
    assert.equal(neither.status, 1);
    assert.equal(neither.document.blocked.stage, "intent");
    const both = run(["setup", "--background", "--config-only"]);
    assert.equal(both.status, 1);
    assert.match(both.document.blocked.detail, /exactly one of/);
    const unsupported = run(["setup", ...background]);
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.document.blocked.stage, "host-readiness");
    assert.deepEqual(readFileSync(configPath), saved);
    assert.equal(existsSync(join(root, "registered")), false);
  }));

test("actual guided setup reports partial registration/start failures and completes a corrected repeat without replacing state", () =>
  fixture(async ({ root, run, configure, configPath }) => {
    configure();
    writeFileSync(join(root, "enable-failure"), "");
    const failed = run(["setup", ...background]);
    assert.equal(failed.status, 1);
    assert.equal(failed.document.blocked.stage, "service-registration");
    assert.ok(failed.document.completed.includes("queue-bound"));
    assert.equal(existsSync(join(root, "starts")), false);
    const saved = readFileSync(configPath);
    rmSync(join(root, "enable-failure"));
    writeFileSync(join(root, "start-failure"), "");
    const start = run(["setup", ...background]);
    assert.equal(start.status, 1);
    assert.equal(start.document.blocked.stage, "service-start");
    assert.match(start.document.blocked.detail, /exact coordinator owner/);
    rmSync(join(root, "start-failure"));
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(ready.document.status, "ready");
    assert.deepEqual(readFileSync(configPath), saved);
    assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
  }));

test("actual guided setup checks the configured credentials, then the queue keeps a closed Objective without dispatch", () =>
  fixture(async ({ root, run, until, configPath, env, checkout }) => {
    const config = factoryConfig(checkout, "example/setup");
    config.execution = {
      kind: "managed-agent",
      provider: "openai-agents",
      concurrency: 1,
      config: {
        model: "fixture",
        reasoningEffort: "low",
        containerSize: "small",
        apiKeyEnv: "FACTORY_SERVICE_TEST_KEY",
        timeoutSeconds: 10,
      },
    };
    config.queue = { pollSeconds: 0.05 };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const credential = join(root, "credential");
    writeFileSync(credential, "fixture-no-provider-call", { mode: 0o600 });
    const args = [
      "setup",
      ...background,
      "--credential-file",
      `FACTORY_SERVICE_TEST_KEY=${credential}`,
    ];
    delete env.FACTORY_SERVICE_TEST_KEY;
    const missing = run(["setup", ...background]);
    assert.equal(missing.status, 1);
    assert.equal(missing.document.blocked.stage, "execution-readiness");
    assert.match(
      missing.document.blocked.detail,
      /FACTORY_SERVICE_TEST_KEY.* Fix: Provide FACTORY_SERVICE_TEST_KEY/,
    );
    assert.equal(missing.document.readiness.status, "missing");
    assert.equal(existsSync(join(root, "registered")), false);
    const ready = run(args);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.deepEqual(ready.document.queue.queued, []);
    assert.equal(ready.document.readiness.status, "present");
    assert.doesNotMatch(ready.stdout, /fixture-no-provider-call/);
    const added = run(["queue", "add", "1"]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    assert.deepEqual(added.document.objectives, [1]);
    assert.equal(added.document.note, undefined);
    const status = await until(["queue", "list"], (document) =>
      Boolean(document.observation?.reasons?.[1]),
    );
    assert.deepEqual(status.objectives, [1]);
    assert.equal(status.watch, true);
    assert.equal(status.observation.reasons[1], "Issue is closed");
  }));

test("setup and the first run share the readiness checks, the home default and the outside override before service effects", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
    writeFileSync(
      configPath,
      JSON.stringify(factoryConfig(checkout, "example/setup")),
      { mode: 0o600 },
    );
    const home = join(root, "owned-home");
    const override = join(root, "outside-override");
    mkdirSync(home);
    mkdirSync(override);
    env.HOME = home;
    writeFileSync(join(root, "readiness-mode"), "allowed");
    for (const [args, selected] of [
      [[], home],
      [["--outside-directory", override], override],
    ]) {
      const result = run(["setup", ...background, ...args]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.document.blocked.stage, "execution-readiness");
      const readiness = result.document.readiness;
      assert.equal(readiness.outsideDirectory, realpathSync(selected));
      assert.equal(readiness.outsideHostWritable, true);
      assert.equal(readiness.outsideWriteRefused, false);
      assert.match(result.document.blocked.detail, / Fix: /);
      assert.equal(existsSync(join(root, "registered")), false);
      assert.equal(existsSync(join(root, "starts")), false);
    }
    // A first run stops on the same failing check, names its fix and creates no state.
    const first = run(["run", "--objective", "1"]);
    assert.equal(first.status, 2, first.stdout + first.stderr);
    assert.match(first.stdout, /Objective #1 waits before it starts: /);
    assert.match(first.stdout, /\nFix: Make the Codex sandbox usable/);
    assert.match(first.stdout, /run `factory run --objective 1` again/);
    assert.equal(
      existsSync(
        join(
          root,
          "state/clockgrove-factory/repositories/example/setup/objectives",
        ),
      ),
      false,
    );
    writeFileSync(join(root, "readiness-mode"), "refused");
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(ready.document.readiness.outsideDirectory, realpathSync(home));
    assert.equal(ready.document.readiness.outsideHostWritable, true);
    assert.equal(ready.document.readiness.outsideWriteRefused, true);
    const requests = readFileSync(join(root, "readiness-requests"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests.map(({ message }) => message.method),
      Array(4).fill(["initialize", "initialized", "command/exec"]).flat(),
    );
    for (const { args } of requests) {
      assert.ok(args.includes('sandbox_mode="workspace-write"'));
      assert.ok(args.includes('approval_policy="never"'));
    }
  }));

test("guided ready requires the service owner's own GitHub observation and retains a blocked live watcher for correction", () =>
  fixture(async ({ root, run, configure }) => {
    configure();
    writeFileSync(join(root, "service-github-unavailable"), "");
    const blocked = run(["setup", ...background]);
    assert.equal(blocked.status, 1);
    assert.equal(blocked.document.blocked.stage, "service-observation");
    assert.match(
      blocked.document.blocked.detail,
      /Service GitHub observation is unavailable/,
    );
    assert.ok(blocked.document.completed.includes("exact-owner-verified"));
    assert.equal(blocked.document.service.active, "active");
    const pid = readFileSync(join(root, "pid"), "utf8");
    rmSync(join(root, "service-github-unavailable"));
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(ready.document.status, "ready");
    assert.equal(ready.document.observation.error, undefined);
    assert.equal(readFileSync(join(root, "pid"), "utf8"), pid);
    assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
  }));

test("guided setup upgrades a live settled watcher through compatibility and drain without losing its running mode", () =>
  fixture(async ({ root, run, configure, configPath }) => {
    configure();
    const first = run(["setup", ...background]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const before = readFileSync(configPath);
    const oldPackage = join(root, "retained-package");
    mkdirSync(oldPackage);
    cpSync(
      join(dirname(dirname(installedCli)), "package.json"),
      join(oldPackage, "package.json"),
    );
    cpSync(dirname(installedCli), join(oldPackage, "dist"), {
      recursive: true,
    });
    symlinkSync(
      realpathSync(join(dirname(dirname(installedCli)), "node_modules")),
      join(oldPackage, "node_modules"),
    );
    const previousArtifact = join(oldPackage, "dist/cli.js");
    const switchToPrevious = run([
      "supervisor",
      "upgrade",
      "--cli",
      previousArtifact,
    ]);
    assert.equal(
      switchToPrevious.status,
      0,
      switchToPrevious.stdout + switchToPrevious.stderr,
    );
    const upgraded = run(["setup", ...background]);
    assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
    assert.ok(upgraded.document.completed.includes("artifact-upgraded"));
    assert.equal(upgraded.document.queue.mode, "running");
    assert.equal(upgraded.document.service.binding.cli, installedCli);
    assert.equal(upgraded.document.service.active, "active");
    assert.deepEqual(readFileSync(configPath), before);
    assert.equal(
      readFileSync(join(root, "starts"), "utf8"),
      "start\nstart\nstart\n",
    );
  }));

for (const fault of ["refill", "foreign"]) {
  test(`watcher artifact upgrade refuses automatic resume after ${fault} changes its settled boundary`, () =>
    fixture(async ({ root, run, configure, configPath }) => {
      configure();
      const initial = run(["setup", ...background]);
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (fault === "refill") {
        writeFileSync(join(root, "refill-at-stop"), "");
      } else {
        const { factoryConfigDigest } = await import("../dist/config.js");
        const snapshot = {
          schemaVersion: 8,
          kind: "preparing",
          repository: config.repository,
          objective: 2,
          configDigest: factoryConfigDigest(config),
          runId: "retained-foreign-nonterminal",
          autonomy: defaultAutonomy,
          capacity: { concurrency: 1 },
          baseSha: "a".repeat(40),
          objectiveBodyDigest: "b".repeat(64),
          coordinator: {
            mode: "paused",
            phase: "idle",
            phaseStartedAt: new Date().toISOString(),
          },
          error: "Retained submitted outcome requires operator recovery",
          issueByItemId: {},
        };
        writeFileSync(
          join(root, "foreign-at-stop"),
          JSON.stringify({
            directory: join(
              root,
              "state/clockgrove-factory/repositories",
              ...config.repository.split("/"),
              "objectives/2",
            ),
            snapshot,
          }),
        );
      }
      const upgraded = run(["supervisor", "upgrade", "--cli", installedCli]);
      assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
      assert.equal(upgraded.document.restarted, false);
      assert.equal(upgraded.document.resumeRequired, true);
      assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
      const status = run(["queue", "list"]);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.document.mode, "draining");
      if (fault === "refill") assert.deepEqual(status.document.objectives, [1]);
    }));
}

test("supervisor stop drains the service; --disable also stops it starting again, and status says so", () =>
  fixture(async ({ root, run, configure }) => {
    configure();
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(run(["status", "--json"]).document.service.enabled, "enabled");
    const refused = (args, message) => {
      const result = run(args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
    };
    refused(
      ["supervisor"],
      /Unknown supervisor action \(none\); use start, stop, upgrade or uninstall/,
    );
    refused(["supervisor", "restart"], /Unknown supervisor action restart/);
    refused(
      ["supervisor", "upgrade"],
      /upgrade requires --cli ABSOLUTE_INSTALLED_CLI/,
    );
    refused(
      ["supervisor", "start", "--cli", installedCli],
      /--cli belongs to factory supervisor upgrade/,
    );
    const stopped = run(["supervisor", "stop", "--disable"]);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.deepEqual(stopped.document, {
      stopped: true,
      evidenceRetained: true,
    });
    const calls = readFileSync(join(root, "calls"), "utf8");
    assert.match(calls, /--user stop /);
    assert.match(calls, /--user disable /);
    assert.match(calls, /--user link /);
    const service = run(["status", "--json"]).document.service;
    assert.equal(service.registered, true);
    assert.notEqual(service.enabled, "enabled");
  }));

test("guided setup leaves omitted concurrency to host sizing at run time and reports it", () =>
  fixture(async ({ run, installArgs, configPath }) => {
    const omitted = installArgs().slice(0, -2);
    const configured = run(["setup", "--config-only", ...omitted]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    const expected = hostSchedulingDefaults({
      cpus: availableParallelism(),
      memoryBytes: totalmem(),
    });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.execution.concurrency, undefined);
    assert.equal(config.scheduling, undefined);
    const sized = {
      ...expected,
      hostSized: { concurrency: true, scheduling: true },
      sizedFromHost: {
        cpus: availableParallelism(),
        memoryMiB: Math.floor(totalmem() / 1024 ** 2),
      },
    };
    assert.deepEqual(configured.document.capacity, sized);
    // The configuration still omits concurrency, so a repeat reports the same host sizing.
    const repeated = run(["setup", "--config-only"]);
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.deepEqual(repeated.document.capacity, sized);
  }));

test("guided setup keeps an explicit concurrency as the whole capacity choice", () =>
  fixture(async ({ run, installArgs, configPath }) => {
    const configured = run(["setup", "--config-only", ...installArgs()]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.execution.concurrency, 1);
    assert.equal(config.scheduling, undefined);
    assert.deepEqual(configured.document.capacity, { concurrency: 1 });
  }));

test("guided setup rejects configuration inside the target before writing it and preserves conflicting existing choices", () =>
  fixture(async ({ checkout, run, installArgs, configPath }) => {
    const inside = join(checkout, "factory.json");
    const refused = run([
      "setup",
      "--config-only",
      ...installArgs(),
      "--config",
      inside,
    ]);
    assert.equal(refused.status, 1);
    assert.match(
      refused.document.blocked.detail,
      /outside the target checkout/,
    );
    assert.equal(existsSync(inside), false);
    const configured = run(["setup", "--config-only", ...installArgs()]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    const before = readFileSync(configPath);
    const conflict = run(["setup", "--config-only", "--concurrency", "2"]);
    assert.equal(conflict.status, 1);
    assert.match(
      conflict.document.blocked.detail,
      /differs from --concurrency/,
    );
    assert.deepEqual(readFileSync(configPath), before);
  }));

test("setup keeps a paused queue and a retained Objective's state untouched and does not start the service", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
    const config = factoryConfig(checkout, "example/setup");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const added = run(["queue", "add", "1"]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    // The queue exists before the service: it says so and names the command.
    assert.match(added.document.note, /factory setup --background/);
    const pause = run(["queue", "pause"]);
    assert.equal(pause.status, 0, pause.stdout + pause.stderr);
    const oldStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
    try {
      const { factoryConfigDigest } = await import("../dist/config.js");
      const path = statePath(config.repository, 1);
      saveState(path, {
        schemaVersion: 8,
        kind: "preparing",
        repository: config.repository,
        objective: 1,
        runId: "retained-preparation",
        configDigest: factoryConfigDigest(config),
        baseSha: "a".repeat(40),
        objectiveBodyDigest: "b".repeat(64),
        autonomy: defaultAutonomy,
        capacity: { concurrency: 1 },
        issueByItemId: {},
        coordinator: {
          mode: "paused",
          phase: "planning",
          phaseStartedAt: new Date().toISOString(),
        },
      });
      const before = readFileSync(path, "utf8");
      const same = run(["setup", ...background]);
      assert.equal(same.status, 1, same.stdout + same.stderr);
      assert.match(same.document.blocked.detail, /paused or draining/);
      assert.match(same.document.blocked.detail, /factory queue resume/);
      // The queue keeps what was added, now marked as served, still paused.
      const kept = readIntake(config);
      assert.deepEqual(kept.objectives, [1]);
      assert.equal(kept.watch, true);
      assert.equal(kept.mode, "paused");
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(existsSync(join(root, "registered")), false);
      assert.equal(existsSync(join(root, "starts")), false);
    } finally {
      if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldStateHome;
    }
  }));

test("factory queue parses each form, and its stop messages name queue commands that run", () =>
  fixture(async ({ run, configPath, checkout }) => {
    writeFileSync(
      configPath,
      JSON.stringify(factoryConfig(checkout, "example/setup")),
      { mode: 0o600 },
    );
    const refused = (args, message) => {
      const result = run(args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
    };
    refused(["queue"], /Unknown queue action \(none\); use add, list, remove/);
    refused(["queue", "enqueue", "1"], /Unknown queue action enqueue/);
    refused(["queue", "add"], /queue add requires Objective numbers/);
    refused(["queue", "add", "one"], /one is not an Objective number/);
    refused(["queue", "add", "0"], /0 is not an Objective number/);
    refused(["queue", "add", "1", "--watch"], /--watch was removed/);
    refused(
      ["queue", "add", "1", "--priority-label", "x"],
      /--priority-label was removed/,
    );
    refused(["queue", "list", "1"], /queue list takes no Objective numbers/);
    refused(["queue", "remove"], /queue remove requires Objective numbers/);
    refused(["queue", "pause", "--drain"], /Unknown option --drain/);
    // Nothing queued yet: listing is empty, changing the queue names the way in.
    const empty = run(["queue", "list"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(empty.document, { objectives: [], dequeued: [] });
    refused(
      ["queue", "pause"],
      /Nothing is queued; add Objectives with `factory queue add N`/,
    );
    refused(["queue", "remove", "1"], /Nothing is queued/);
    const status = run(["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(
      status.stdout,
      /^Service: not set up; `factory setup --background` sets it up$/m,
    );
    assert.match(status.stdout, /^Queue: running; empty$/m);

    const added = run(["queue", "add", "1", "1"]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    assert.deepEqual(added.document.objectives, [1]);
    assert.equal(added.document.mode, "running");
    assert.equal(added.document.watch, undefined);
    assert.match(run(["status"]).stdout, /^Queue: running; queued #1$/m);
    for (const [verb, mode] of [
      ["pause", "paused"],
      ["drain", "draining"],
      ["resume", "running"],
    ]) {
      const changed = run(["queue", verb]);
      assert.equal(changed.status, 0, changed.stderr);
      assert.equal(changed.document.mode, mode);
      assert.equal(run(["queue", "list"]).document.mode, mode);
    }
    // A paused queue's status line names the command that continues it.
    run(["queue", "pause"]);
    assert.match(
      run(["status"]).stdout,
      /Paused; `factory queue resume` continues it/,
    );
    const removed = run(["queue", "remove", "1"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(removed.document.dequeued, [1]);
    refused(["queue", "remove", "2"], /Objective #2 is not in the queue/);
    const again = run(["queue", "add", "1"]);
    assert.deepEqual(again.document.dequeued, []);
    assert.deepEqual(again.document.objectives, [1]);
  }));

/** Run the command a refusal names, as the operator would; `factory X` becomes the CLI with X. */
function named(run, message, pattern, fill = {}) {
  const command = new RegExp(pattern).exec(message)?.[0];
  assert.ok(command, `${message} names ${pattern}`);
  return run(
    command
      .replace(/^factory /, "")
      .split(" ")
      .map((word) => fill[word] ?? word),
  );
}

/**
 * The commands a refusal names, each runnable as the operator would paste it.
 * `factory X` runs the CLI; anything else runs in a shell. Placeholders are replaced first.
 */
function namedCommands(run, env, message, substitutions = {}) {
  const found = [...message.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((command) => /^(factory|rm|journalctl) /.test(command));
  assert.ok(found.length, `no command named in: ${message}`);
  return found.map((command) => {
    let text = command;
    for (const [from, to] of Object.entries(substitutions))
      text = text.replaceAll(from, to);
    return {
      command,
      exec() {
        const result = text.startsWith("factory ")
          ? run(text.replace(/^factory /, "").split(" "))
          : spawnSync("sh", ["-c", text], { encoding: "utf8", env });
        assert.equal(result.status, 0, `${command}\n${result.stderr}`);
        return result;
      },
    };
  });
}

test("while a foreground run holds the lock, status and queue list still read, and a refusal names a command that works", () =>
  fixture(async ({ run, configPath, checkout, env }) => {
    writeFileSync(
      configPath,
      JSON.stringify(factoryConfig(checkout, "example/setup")),
      { mode: 0o600 },
    );
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {stateRoot} from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)};
import {acquireControllerLock} from ${JSON.stringify(new URL("../dist/state-store.js", import.meta.url).href)};
mkdirSync(stateRoot('example/setup'),{recursive:true,mode:0o700});
acquireControllerLock(join(stateRoot('example/setup'),'controller.lock'),1);
console.log('held');process.stdin.resume();`,
      ],
      { env, stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout.once("data", resolve);
      });
      const refused = run(["queue", "add", "2"]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Controller is running Objective #1/);
      // The command it names works while that run holds the lock.
      const status = named(run, refused.stderr, "factory status[^`]*");
      assert.equal(status.status, 0, status.stderr);
      // Reading the queue and the service needs no control of the run.
      const list = run(["queue", "list"]);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(list.document.activeObjective, 1);
      const overview = run(["status"]);
      assert.equal(overview.status, 0, overview.stderr);
      assert.match(overview.stdout, /^Queue: running; empty; #1 running$/m);
      // Changing the queue still waits for the run, and says what shows it.
      assert.equal(run(["queue", "pause"]).status, 1);
    } finally {
      holder.kill("SIGKILL");
    }
  }));

test("a stopped service leaves its queue draining; status and a refused start name the command that continues it", () =>
  fixture(async ({ run, configure }) => {
    configure();
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    const stopped = run(["supervisor", "stop"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    // The queue is empty and draining: status still names the way out.
    assert.equal(run(["queue", "list"]).document.mode, "draining");
    assert.match(
      run(["status"]).stdout,
      /Draining; `factory queue resume` continues it, then `factory supervisor start`/,
    );
    // The line for the stopped service names the command that continues the queue before the start.
    const line = run(["status"])
      .stdout.split("\n")
      .find((text) => text.includes("Not running"));
    assert.ok(line, "status has a line for the stopped service");
    assert.deepEqual(
      [...line.matchAll(/`(factory [^`]+)`/g)].map((match) => match[1]),
      ["factory queue resume", "factory supervisor start"],
    );
    const refused = run(["supervisor", "start"]);
    assert.equal(refused.status, 1);
    const resumed = named(run, refused.stderr, "factory queue resume");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.document.mode, "running");
    const started = named(run, refused.stderr, "factory supervisor start");
    assert.equal(started.status, 0, started.stdout + started.stderr);
    assert.equal(run(["status", "--json"]).document.service.active, "active");
  }));

test("an intake.json from an earlier build is refused naming the file and the fix, and the fix works", () =>
  fixture(async ({ run, configPath, checkout, env }) => {
    const config = factoryConfig(checkout, "example/setup");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const path = join(
      env.XDG_STATE_HOME,
      "clockgrove-factory/repositories/example/setup/intake.json",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        priorityLabels: ["urgent"],
        mode: "running",
      }),
    );
    for (const args of [["queue", "list"], ["status"]]) {
      const refused = run(args);
      assert.equal(refused.status, 1, args.join(" "));
      assert.ok(refused.stderr.includes(path), refused.stderr);
      assert.match(
        refused.stderr,
        /delete it with `rm \S+`, then run `factory setup --background`/,
      );
    }
    // Deleting the file with the named command leaves a working empty queue.
    const [remove, again] = namedCommands(run, env, run(["status"]).stderr);
    assert.equal(remove.command, `rm ${path}`);
    remove.exec();
    assert.equal(existsSync(path), false);
    assert.match(again.command, /^factory setup --background$/);
    const empty = run(["queue", "list"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(empty.document, { objectives: [], dequeued: [] });
  }));

test("supervisor --credential-file points to the setup command that takes it, and that command accepts it", () =>
  fixture(async ({ run, root, configure }) => {
    configure();
    const refused = run([
      "supervisor",
      "start",
      "--credential-file",
      "NAME=/x",
    ]);
    assert.equal(refused.status, 1);
    const pointer = /factory setup --background --credential-file/.exec(
      refused.stderr,
    );
    assert.ok(pointer, refused.stderr);
    const file = join(root, "credential");
    writeFileSync(file, "secret\n", { mode: 0o600 });
    const setup = run([
      "setup",
      "--background",
      "--credential-file",
      `NAME=${file}`,
    ]);
    // The flag is accepted; setup goes on to judge the credential itself.
    assert.doesNotMatch(
      setup.stderr + JSON.stringify(setup.document ?? {}),
      /Unknown option|belongs to factory setup/,
    );
  }));

test("a queue command holding the installation is not reported as Objective 0", () =>
  fixture(async ({ run, configure, env }) => {
    configure();
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {stateRoot} from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)};
import {acquireControllerLock} from ${JSON.stringify(new URL("../dist/state-store.js", import.meta.url).href)};
mkdirSync(stateRoot('example/setup'),{recursive:true,mode:0o700});
acquireControllerLock(join(stateRoot('example/setup'),'controller.lock'),0);
console.log('held');process.stdin.resume();`,
      ],
      { env, stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout.once("data", resolve);
      });
      const refused = run(["retry", "--objective", "1"]);
      assert.equal(refused.status, 1);
      // No command it names points at Objective 0.
      for (const [command] of refused.stderr.matchAll(/factory [^`;\n]*/g))
        assert.doesNotMatch(command, /--objective 0\b/);
    } finally {
      holder.kill("SIGKILL");
    }
  }));

test("an option that belongs to setup points at the setup command that takes it, and that command runs", () =>
  fixture(async ({ run, configure }) => {
    configure();
    for (const [args, pointer, fill] of [
      [
        ["run", "--objective", "1", "--background"],
        /factory setup --background$/m,
      ],
      [
        ["run", "--objective", "1", "--concurrency", "1"],
        /factory setup --config-only --concurrency VALUE/,
        { VALUE: "1" },
      ],
      [
        ["run", "--objective", "1", "--capture-content"],
        /factory setup --config-only --capture-content /,
      ],
    ]) {
      const refused = run(args);
      assert.equal(refused.status, 1, args.join(" "));
      const command = pointer.exec(refused.stderr)?.[0];
      assert.ok(command, `${args.join(" ")}: ${refused.stderr}`);
      assert.doesNotMatch(command, /--background --background/);
      // The pointer is a command line the CLI parses: it is not refused as unknown or misplaced.
      const followed = named(run, command.trim(), "factory .*", fill);
      assert.doesNotMatch(
        followed.stderr,
        /Unknown option|belongs to factory setup|was removed/,
        command,
      );
    }
  }));

test("factory queue says it takes Objective numbers, and the command it names adds them", () =>
  fixture(async ({ run, configure }) => {
    configure();
    const refused = run(["queue", "add", "1", "--objective", "1"]);
    assert.equal(refused.status, 1);
    const command = /factory queue add 1/.exec(refused.stderr)?.[0];
    assert.ok(command, refused.stderr);
    assert.doesNotMatch(refused.stderr, /Unknown option/);
    const added = named(run, command, "factory .*");
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(added.document.objectives, [1]);
  }));

test("a queue written under another configuration can be read before it is deleted, and nothing is lost", () =>
  fixture(async ({ run, configure, configPath }) => {
    configure();
    assert.equal(run(["queue", "add", "1"]).status, 0);
    // A configuration change leaves the queue record bound to the earlier one.
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.policy.allowedSecretNames = ["EXTRA_SECRET"];
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const refused = run(["queue", "add", "1"]);
    assert.equal(refused.status, 1);
    const read = /factory queue list/.exec(refused.stderr)?.[0];
    assert.ok(read, refused.stderr);
    // Reading the queue is allowed under any configuration and shows the order the advice protects.
    const listed = named(run, read, "factory queue list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.document.objectives, [1]);
    const overview = run(["status", "--json"]);
    assert.equal(overview.status, 0, overview.stderr);
    assert.deepEqual(overview.document.queue.objectives, [1]);
    // Changing it still refuses until the record is deleted and the Objectives are added again.
    assert.equal(run(["queue", "pause"]).status, 1);
  }));

test("the pointer for --objective on queue names the number given, inline or next, and N otherwise", () =>
  fixture(async ({ run, configure }) => {
    configure();
    for (const [args, expected] of [
      [["queue", "add", "--objective", "1"], "factory queue add 1"],
      [["queue", "add", "--objective=1"], "factory queue add 1"],
      [["queue", "add", "--objective"], "factory queue add N"],
      [["queue", "--objective", "--json"], "factory queue add N"],
      [["queue", "--objective=x"], "factory queue add N"],
    ]) {
      const refused = run(args);
      assert.equal(refused.status, 1, args.join(" "));
      assert.match(refused.stderr, /takes Objective numbers/, args.join(" "));
      const command = /factory queue add \S+/.exec(refused.stderr)?.[0];
      assert.equal(command, expected, `${args.join(" ")}: ${refused.stderr}`);
      assert.doesNotMatch(refused.stderr, /Unknown option/);
    }
    const added = named(run, "factory queue add N", "factory queue add N", {
      N: "1",
    });
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(added.document.objectives, [1]);
  }));

function credentialed(checkout, concurrency) {
  const config = factoryConfig(checkout, "example/setup");
  config.execution = {
    kind: "managed-agent",
    provider: "openai-agents",
    concurrency,
    config: {
      model: "fixture",
      reasoningEffort: "low",
      containerSize: "small",
      apiKeyEnv: "FACTORY_SERVICE_TEST_KEY",
      timeoutSeconds: 10,
    },
  };
  config.queue = { pollSeconds: 0.05 };
  return config;
}

/** Write a retained Objective 1 preparation under this configuration. */
async function retainObjective(env, config) {
  const oldStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  try {
    const { factoryConfigDigest } = await import("../dist/config.js");
    const path = statePath(config.repository, 1);
    saveState(path, {
      schemaVersion: 8,
      kind: "preparing",
      repository: config.repository,
      objective: 1,
      runId: "retained-preparation",
      configDigest: factoryConfigDigest(config),
      baseSha: "a".repeat(40),
      objectiveBodyDigest: "b".repeat(64),
      autonomy: defaultAutonomy,
      capacity: { concurrency: 1 },
      issueByItemId: {},
      coordinator: {
        mode: "running",
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
      },
    });
    return path;
  } finally {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldStateHome;
  }
}

test("a continuation written under another configuration names commands that run, with the credential file", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
    const credential = join(root, "credential");
    writeFileSync(credential, "fixture-no-provider-call", { mode: 0o600 });
    delete env.FACTORY_SERVICE_TEST_KEY;
    const path = await retainObjective(env, credentialed(checkout, 1));
    // The queue is written under the changed configuration.
    writeFileSync(configPath, JSON.stringify(credentialed(checkout, 2)), {
      mode: 0o600,
    });
    const queued = run(["queue", "add", "1"]);
    assert.equal(queued.status, 0, queued.stdout + queued.stderr);
    const setup = [
      "setup",
      ...background,
      "--credential-file",
      `FACTORY_SERVICE_TEST_KEY=${credential}`,
    ];
    const refused = run(setup);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const detail = refused.document.blocked.detail;
    assert.match(
      detail,
      /continuation was written with a different configuration/,
    );
    assert.doesNotMatch(detail, /compatib/);
    assert.equal(existsSync(join(root, "registered")), false);
    // Every setup command it names carries the credential the configuration needs.
    const commands = namedCommands(run, env, detail, {
      ABSOLUTE_PRIVATE_FILE: credential,
    });
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /^factory setup --background /);
    assert.match(commands[1].command, /^factory supervisor uninstall /);
    assert.match(commands[2].command, /^rm -r \S+\/objectives\/1$/);
    assert.match(commands[3].command, /^factory setup --background /);
    for (const { command } of [commands[0], commands[3]])
      assert.match(
        command,
        /--credential-file FACTORY_SERVICE_TEST_KEY=ABSOLUTE_PRIVATE_FILE$/,
      );
    // Start fresh: uninstall, remove the Objective's state, set up again.
    for (const fresh of commands.slice(1)) fresh.exec();
    assert.equal(existsSync(path), false);
    assert.equal(run(["status", "--json"]).document.service.active, "active");
  }));

test("a service bound without the credential a configuration now needs is replaced by the commands start names", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
    const credential = join(root, "credential");
    writeFileSync(credential, "fixture-no-provider-call", { mode: 0o600 });
    delete env.FACTORY_SERVICE_TEST_KEY;
    // A service registered for a configuration that needs no credential...
    const plain = factoryConfig(checkout, "example/setup");
    plain.queue = { pollSeconds: 0.05 };
    writeFileSync(configPath, JSON.stringify(plain), { mode: 0o600 });
    const first = run(["setup", ...background]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(run(["supervisor", "stop"]).status, 0);
    // ...then the configuration changes to one that does.
    writeFileSync(configPath, JSON.stringify(credentialed(checkout, 1)), {
      mode: 0o600,
    });
    const refused = run(["supervisor", "start"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /credential bindings \(none\) differ/);
    const commands = namedCommands(run, env, refused.stderr, {
      ABSOLUTE_PRIVATE_FILE: credential,
    });
    assert.match(
      commands[1].command,
      /^factory setup --background --config \S+ --credential-file FACTORY_SERVICE_TEST_KEY=ABSOLUTE_PRIVATE_FILE$/,
    );
    commands[0].exec();
    // The queue record belongs to the earlier configuration: setup refuses and names the way on.
    const stale = run(
      commands[1].command
        .replace(/^factory /, "")
        .replace("ABSOLUTE_PRIVATE_FILE", credential)
        .split(" "),
    );
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    const next = namedCommands(run, env, stale.document.blocked.detail, {
      ABSOLUTE_PRIVATE_FILE: credential,
    });
    // The queue record holds an order, so the refusal first names the command that reads it.
    assert.equal(next[0].command, "factory queue list");
    assert.match(next[1].command, /^rm \S+intake\.json$/);
    next[1].exec();
    next[2].exec();
    assert.equal(run(["status", "--json"]).document.service.active, "active");
  }));

test("a package that does not start says where its refusal is, and the way back leaves the service running", () =>
  fixture(async ({ root, run, configure, env }) => {
    configure();
    writeFileSync(
      join(root, "bin/journalctl"),
      `#!/bin/sh\ncat ${JSON.stringify(join(root, "service-error"))}\n`,
      { mode: 0o700 },
    );
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    const previous = ready.document.artifact;
    const candidate = join(root, "candidate-cli.mjs");
    writeFileSync(
      candidate,
      `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(join(root, "unit-failed"))},"");console.error("State from an earlier Factory version: start fresh");process.exit(1);\n`,
    );
    const failed = run(["supervisor", "upgrade", "--cli", candidate]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(
      failed.stderr,
      /has not established its exact coordinator owner/,
    );
    const all = namedCommands(run, env, failed.stderr);
    const named = (prefix) =>
      all.find(({ command }) => command.startsWith(prefix));
    const log = named("journalctl");
    const back = named("factory supervisor upgrade");
    assert.match(log.command, /^journalctl --user -u factory-/);
    assert.match(log.exec().stdout, /start fresh/);
    assert.match(back.command, new RegExp(`--cli ${previous}`));
    // The way back restarts the service on its own: no start command follows.
    assert.equal(named("factory supervisor start"), undefined);
    back.exec();
    const status = run(["status", "--json"]).document.service;
    assert.equal(status.active, "active");
    assert.equal(status.binding.cli, previous);
  }));

test("start refuses a queue record without the service switch or with an unsupported field, naming commands that run", () =>
  fixture(async ({ run, configure, env }) => {
    configure();
    const ready = run(["setup", ...background]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(run(["queue", "add", "1"]).status, 0);
    assert.equal(run(["supervisor", "stop"]).status, 0);
    assert.equal(run(["queue", "resume"]).status, 0);
    const path = join(
      env.XDG_STATE_HOME,
      "clockgrove-factory/repositories/example/setup/intake.json",
    );
    const record = JSON.parse(readFileSync(path, "utf8"));
    // No service switch: the named setup command establishes it.
    const { watch: _watch, ...unserved } = record;
    writeFileSync(path, JSON.stringify(unserved));
    const unset = run(["supervisor", "start"]);
    assert.equal(unset.status, 1);
    const [setup] = namedCommands(run, env, unset.stderr);
    assert.match(setup.command, /^factory setup --background$/);
    setup.exec();
    assert.equal(run(["status", "--json"]).document.service.active, "active");
    // An unsupported field: delete the record with the named command, then set up again.
    assert.equal(run(["supervisor", "stop"]).status, 0);
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), extra: 1 }),
    );
    const unsupported = run(["supervisor", "start"]);
    assert.equal(unsupported.status, 1);
    assert.doesNotMatch(unsupported.stderr, /compatib/);
    const [remove, again] = namedCommands(run, env, unsupported.stderr);
    assert.equal(remove.command, `rm ${path}`);
    remove.exec();
    again.exec();
    assert.equal(run(["status", "--json"]).document.service.active, "active");
  }));
