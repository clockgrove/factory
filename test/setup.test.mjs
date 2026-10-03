import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const consent = [
  "--background",
  "--service-consent",
  "--actor",
  "fixture",
  "--reason",
  "Consented model-free target watcher",
  "--retain-package",
];
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
else if(action==='is-active'){console.log(fs.existsSync(file('start-failure'))?'failed':alive()?'active':'inactive');}
else if(action==='is-enabled'){console.log(fs.existsSync(file('enabled'))?'enabled':'not-found');}
else if(action==='show'){console.log(alive()?fs.readFileSync(file('pid'),'utf8'):'0');}
else if(action==='enable'){if(fs.existsSync(file('enable-failure')))process.exit(1);fs.writeFileSync(file('registered'),process.argv[4]);fs.writeFileSync(file('enabled'),'');}
else if(action==='disable'){fs.rmSync(file('enabled'),{force:true});}
else if(action==='stop'&&fs.existsSync(file('refill-at-stop'))){
 fs.rmSync(file('refill-at-stop'));
 const target=spawnSync(process.execPath,[${JSON.stringify(installedCli)},'intake','enqueue','--objective','1','--config',file('factory.json')],{env:process.env,encoding:'utf8'});
 if(target.status!==0){console.error(target.stderr);process.exit(1);}
}
else if(action==='stop'&&fs.existsSync(file('foreign-at-stop'))){
 const input=JSON.parse(fs.readFileSync(file('foreign-at-stop'),'utf8'));
 fs.mkdirSync(input.directory,{recursive:true});fs.writeFileSync(input.directory+'/state.json',JSON.stringify(input.snapshot));
 fs.rmSync(file('foreign-at-stop'));
}
else if(action==='start'&&!alive()&&!fs.existsSync(file('start-failure'))){
 const unit=fs.readFileSync(fs.readFileSync(file('registered'),'utf8'),'utf8');
 const binding=JSON.parse(unit.split('\\n')[0].slice('# Factory local supervision v1 '.length));
 const args=[binding.cli,'supervisor','serve','--intake','--config',binding.config];
 const env={...process.env,...binding.environment,XDG_STATE_HOME:binding.stateHome};
 for(const credential of binding.credentials??[]){const dir=file('loaded');fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(credential.file,dir+'/'+credential.name);env.CREDENTIALS_DIRECTORY=dir;args.push('--service-credential',credential.name);}
 const child=spawn(binding.node,args,{env,detached:true,stdio:['ignore',fs.openSync(file('service-out'),'a'),fs.openSync(file('service-error'),'a')]});
 fs.writeFileSync(file('pid'),String(child.pid));fs.appendFileSync(file('starts'),'start\\n');child.unref();
}
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
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
  let bodyError;
  try {
    await fn({ root, checkout, configPath, env, run, installArgs });
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

test("actual guided CLI creates a consented idle watcher, verifies its owner and reuses it without duplicate controllers", () =>
  fixture(async ({ root, run, installArgs, configPath }) => {
    writeFileSync(join(root, "open-unapproved"), "");
    const first = run([
      "setup",
      ...consent,
      ...installArgs(),
      "--poll-seconds",
      "0.05",
    ]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(first.document.status, "ready");
    assert.equal(first.document.repository, "example/setup");
    assert.equal(first.document.service.active, "active");
    assert.equal(first.document.service.binding.cli, installedCli);
    assert.equal(first.document.intake.pollSeconds, 0.05);
    assert.deepEqual(first.document.intake.approvedObjectives, []);
    assert.equal(first.document.readiness.status, "not-assessed");
    assert.equal(first.document.host.logoutPersistence, "not-enabled");
    const config = readFileSync(configPath);
    const pid = readFileSync(join(root, "pid"), "utf8");
    const again = run(["setup", ...consent]);
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
    const state = run(["intake", "status"]).document;
    assert.deepEqual(state.observation.unapproved, [99]);
    assert.equal(state.observation.idleReason, "awaiting-approved-work");
    assert.deepEqual(state.objectives, []);
    assert.deepEqual(state.bodyDigests, {});
    const repositoryState = join(
      root,
      "state/clockgrove-factory/repositories/example/setup",
    );
    for (const path of ["objectives", "harness", "model-invocations"])
      assert.equal(existsSync(join(repositoryState, path)), false, path);
    for (const path of ["forbidden-sdk-construction", "forbidden-dispatch"])
      assert.equal(existsSync(join(root, path)), false, path);
    assert.equal(readFileSync(join(root, "service-error"), "utf8"), "");
  }));

test("guided setup refuses to reuse a retired single-credential service binding", () =>
  fixture(async ({ root, run, installArgs }) => {
    const first = run(["setup", ...consent, ...installArgs()]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const unit = readFileSync(join(root, "registered"), "utf8");
    const prefix = "# Factory local supervision v1 ";
    const text = readFileSync(unit, "utf8");
    const value = JSON.parse(text.split("\n")[0].slice(prefix.length));
    value.credential = { name: "KEY", file: join(root, "key") };
    writeFileSync(
      unit,
      `${prefix}${JSON.stringify(value)}\n${text.split("\n").slice(1).join("\n")}`,
      { mode: 0o600 },
    );
    const starts = readFileSync(join(root, "starts"), "utf8");
    const again = run(["setup", ...consent]);
    assert.equal(again.status, 1, again.stderr + again.stdout);
    assert.equal(again.document.blocked.stage, "service-binding");
    assert.match(
      again.document.blocked.detail,
      /retired single `credential` field.*--credential-file NAME=/,
    );
    assert.equal(readFileSync(join(root, "starts"), "utf8"), starts);
    assert.equal(readFileSync(unit, "utf8").includes('"credential":'), true);
  }));

test("actual guided configuration-only setup succeeds with unavailable manager and requires explicit service consent for background", () =>
  fixture(async ({ root, run, installArgs, configPath }) => {
    writeFileSync(join(root, "unsupported"), "");
    const configured = run(["setup", "--config-only", ...installArgs()]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    assert.equal(configured.document.status, "configured");
    assert.equal(existsSync(join(root, "registered")), false);
    const saved = readFileSync(configPath);
    const absent = run(["setup", "--background", "--retain-package"]);
    assert.equal(absent.status, 1);
    assert.equal(absent.document.blocked.stage, "intent");
    assert.match(absent.document.blocked.detail, /explicit --service-consent/);
    const unsupported = run(["setup", ...consent]);
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.document.blocked.stage, "host-readiness");
    assert.deepEqual(readFileSync(configPath), saved);
    assert.equal(existsSync(join(root, "registered")), false);
  }));

test("actual guided setup reports partial registration/start failures and completes a corrected repeat without replacing state", () =>
  fixture(async ({ root, run, installArgs, configPath }) => {
    writeFileSync(join(root, "enable-failure"), "");
    const failed = run(["setup", ...consent, ...installArgs()]);
    assert.equal(failed.status, 1);
    assert.equal(failed.document.blocked.stage, "service-registration");
    assert.ok(failed.document.completed.includes("intake-bound"));
    assert.equal(existsSync(join(root, "starts")), false);
    const saved = readFileSync(configPath);
    rmSync(join(root, "enable-failure"));
    writeFileSync(join(root, "start-failure"), "");
    const start = run(["setup", ...consent]);
    assert.equal(start.status, 1);
    assert.equal(start.document.blocked.stage, "service-start");
    assert.match(start.document.blocked.detail, /exact coordinator owner/);
    rmSync(join(root, "start-failure"));
    const ready = run(["setup", ...consent]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(ready.document.status, "ready");
    assert.deepEqual(readFileSync(configPath), saved);
    assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
  }));

test("actual guided setup checks selected execution readiness and retains a closed finite selection without dispatch", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
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
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const credential = join(root, "credential");
    writeFileSync(credential, "fixture-no-provider-call", { mode: 0o600 });
    const args = [
      "setup",
      ...consent,
      "--objective",
      "1",
      "--credential-file",
      `FACTORY_SERVICE_TEST_KEY=${credential}`,
    ];
    delete env.FACTORY_SERVICE_TEST_KEY;
    const missing = run(["setup", ...consent, "--objective", "1"]);
    assert.equal(missing.status, 1);
    assert.equal(missing.document.blocked.stage, "execution-readiness");
    assert.equal(existsSync(join(root, "registered")), false);
    const ready = run(args);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.deepEqual(ready.document.intake.approvedObjectives, [1]);
    assert.equal(ready.document.readiness.status, "present");
    assert.doesNotMatch(ready.stdout, /fixture-no-provider-call/);
    const status = run(["intake", "status"]);
    assert.equal(status.status, 0);
    assert.deepEqual(status.document.objectives, [1]);
    assert.equal(status.document.serviceConsent.consent, true);
    assert.equal(status.document.observation.reasons[1], "Issue is closed");
  }));

test("actual setup and readiness CLI share the home default and preserve outside overrides before service effects", () =>
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
      const result = run(["setup", ...consent, "--objective", "1", ...args]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.document.blocked.stage, "execution-readiness");
      const readiness = JSON.parse(result.document.blocked.detail);
      assert.equal(readiness.outsideDirectory, realpathSync(selected));
      assert.equal(readiness.outsideHostWritable, true);
      assert.equal(readiness.outsideWriteRefused, false);
      assert.equal(existsSync(join(root, "registered")), false);
      assert.equal(existsSync(join(root, "starts")), false);
    }
    writeFileSync(join(root, "readiness-mode"), "refused");
    const direct = run(["readiness"]);
    assert.equal(direct.status, 0, direct.stdout + direct.stderr);
    assert.equal(direct.document.outsideDirectory, realpathSync(home));
    assert.equal(direct.document.outsideHostWritable, true);
    assert.equal(direct.document.outsideWriteRefused, true);
    const requests = readFileSync(join(root, "readiness-requests"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests.map(({ message }) => message.method),
      Array(3).fill(["initialize", "initialized", "command/exec"]).flat(),
    );
    for (const { args } of requests) {
      assert.ok(args.includes('sandbox_mode="workspace-write"'));
      assert.ok(args.includes('approval_policy="never"'));
    }
  }));

test("guided ready requires the service owner's own GitHub observation and retains a blocked live watcher for correction", () =>
  fixture(async ({ root, run, installArgs }) => {
    writeFileSync(join(root, "service-github-unavailable"), "");
    const blocked = run([
      "setup",
      ...consent,
      ...installArgs(),
      "--poll-seconds",
      "0.05",
    ]);
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
    const ready = run(["setup", ...consent]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(ready.document.status, "ready");
    assert.equal(ready.document.observation.error, undefined);
    assert.equal(readFileSync(join(root, "pid"), "utf8"), pid);
    assert.equal(readFileSync(join(root, "starts"), "utf8"), "start\n");
  }));

test("guided setup upgrades a live settled watcher through compatibility and drain without losing its running mode", () =>
  fixture(async ({ root, run, installArgs, configPath }) => {
    const first = run([
      "setup",
      ...consent,
      ...installArgs(),
      "--poll-seconds",
      "0.05",
    ]);
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
    const upgraded = run(["setup", ...consent]);
    assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
    assert.ok(upgraded.document.completed.includes("artifact-upgraded"));
    assert.equal(upgraded.document.intake.mode, "running");
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
    fixture(async ({ root, run, installArgs, configPath }) => {
      const initial = run([
        "setup",
        ...consent,
        ...installArgs(),
        "--poll-seconds",
        "0.05",
      ]);
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (fault === "refill") {
        writeFileSync(join(root, "refill-at-stop"), "");
      } else {
        const { factoryConfigDigest } = await import("../dist/config.js");
        const snapshot = {
          schemaVersion: 7,
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
      const status = run(["intake", "status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.document.mode, "draining");
      if (fault === "refill") assert.deepEqual(status.document.objectives, [1]);
    }));
}

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

test("setup reuses an identical Objective selection and refuses replacing it while an Objective is active", () =>
  fixture(async ({ root, run, configPath, env, checkout }) => {
    const config = factoryConfig(checkout, "example/setup");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(root, "readiness-mode"), "refused");
    const watching = run([
      "intake",
      "watch",
      "--service-consent",
      "--actor",
      "fixture",
      "--reason",
      "Consented model-free target watcher",
    ]);
    assert.equal(watching.status, 0, watching.stdout + watching.stderr);
    const enqueue = run(["intake", "enqueue", "--objective", "1", "--watch"]);
    assert.equal(enqueue.status, 0, enqueue.stdout + enqueue.stderr);
    const pause = run(["intake", "pause"]);
    assert.equal(pause.status, 0, pause.stdout + pause.stderr);
    const oldStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
    try {
      const { factoryConfigDigest } = await import("../dist/config.js");
      const path = statePath(config.repository, 1);
      saveState(path, {
        schemaVersion: 7,
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
      const intakeBefore = readIntake(config);
      const same = run(["setup", ...consent, "--objective", "1"]);
      assert.equal(same.status, 1, same.stdout + same.stderr);
      assert.match(same.document.blocked.detail, /paused or draining/);
      const changed = run([
        "setup",
        ...consent,
        "--objective",
        "1",
        "--objective",
        "2",
      ]);
      assert.equal(changed.status, 1, changed.stdout + changed.stderr);
      assert.match(
        changed.document.blocked.detail,
        /active Objective prevents replacing the intake selection/,
      );
      assert.deepEqual(readIntake(config), intakeBefore);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(existsSync(join(root, "registered")), false);
      assert.equal(existsSync(join(root, "starts")), false);
    } finally {
      if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldStateHome;
    }
  }));
