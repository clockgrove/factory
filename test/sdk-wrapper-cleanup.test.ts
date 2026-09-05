import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSdkContainmentWrapper } from "../src/backends/codex-sdk-local.js";
import type { LocalScopeIdentity } from "../src/protocol/local-scope.js";

const identity: LocalScopeIdentity = {
  protocol: "clockgrove.factory/local-scope-v1",
  repository: "fixture/local",
  objective: 1,
  workItem: 2,
  attempt: 1,
  runId: "sdk-collected-cleanup",
  directorEpoch: 1,
  policyDigest: "a".repeat(64),
  phase: "execution",
  commandIndex: 0,
  invocationDigest: "b".repeat(64),
  hostIdentity: "c".repeat(64),
};

describe.skipIf(process.platform !== "linux")("actual generated SDK wrapper cleanup", () => {
  async function fixture(mode: string, childExit = 0) {
    const root = await mkdtemp(join(tmpdir(), "factory-sdk-cleanup-"));
    const state = join(root, "state");
    const calls = join(root, "calls");
    const systemctl = join(root, "systemctl");
    const systemdRun = join(root, "systemd-run");
    await writeFile(
      systemctl,
      `#!${process.execPath}
const fs=require('node:fs');const op=process.argv[3],unit=process.argv[4],mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(calls)},op+'\\n');
let state=fs.existsSync(${JSON.stringify(state)})?fs.readFileSync(${JSON.stringify(state)},'utf8'):'before';
if(op==='stop'){if(mode==='stop-error-collected'){fs.writeFileSync(${JSON.stringify(state)},'absent');process.exit(5);}if(mode==='drain'){fs.writeFileSync(${JSON.stringify(state)},'drain-0');}process.exit(0);}
let absent=state==='before'||state==='absent'||mode==='collected';
if(state.startsWith('drain-')){let n=Number(state.slice(6));if(n>=2)absent=true;else fs.writeFileSync(${JSON.stringify(state)},'drain-'+(n+1));}
const fields={Id:state!=='before'&&mode==='wrong-unit'?'foreign.scope':unit,LoadState:absent?'not-found':mode==='unknown'?'error':'loaded',ActiveState:absent?'inactive':'active',ControlGroup:absent?'':'/fixture/'+unit,Job:state.startsWith('drain-')&&!absent?'3 /pending':'',InvocationID:absent?'':'d'.repeat(32),KillMode:'control-group'};
console.log(Object.entries(fields).map(([k,v])=>k+'='+v).join('\\n'));
`,
    );
    await writeFile(
      systemdRun,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(state)},'after');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}})+'\\n');
process.exitCode=${childExit};
`,
    );
    await chmod(systemctl, 0o700);
    await chmod(systemdRun, 0o700);
    const wrapper = await createSdkContainmentWrapper(
      root,
      { command: "/fixture/fake-cli", args: [] },
      process.pid,
      { identity, deadline: new Date(Date.now() + 30_000) },
    );
    return { root, wrapper, calls };
  }

  it.each(["collected", "stop-error-collected", "drain"])(
    "accepts %s only after exact absence readback",
    async (mode) => {
      const f = await fixture(mode);
      try {
        const result = await promisify(execFile)(f.wrapper, [], {
          env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` },
          timeout: 6000,
        });
        expect(JSON.parse(result.stdout).type).toBe("turn.completed");
        expect(result.stderr).toBe("");
        const operations = (await readFile(f.calls, "utf8")).trim().split("\n");
        expect(operations.filter((op) => op === "stop")).toHaveLength(mode === "collected" ? 0 : 1);
        expect(operations.slice(-2)).toEqual(["show", "show"]);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["unknown", "active", "wrong-unit"])(
    "rejects %s despite successful terminal SDK output",
    async (mode) => {
      const f = await fixture(mode);
      try {
        await expect(
          promisify(execFile)(f.wrapper, [], {
            env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` },
            timeout: 6000,
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("Factory SDK owned scope cleanup unverified"),
        });
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it("preserves the actual nonzero child outcome when a collected scope is absent", async () => {
    const f = await fixture("collected", 7);
    try {
      await expect(
        promisify(execFile)(f.wrapper, [], {
          env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` },
          timeout: 6000,
        }),
      ).rejects.toMatchObject({ code: 7, stderr: "" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps EPERM group probes unknown and returns a bounded failure instead of hanging", async () => {
    const f = await fixture("collected");
    const preload = join(f.root, "permission-probe.cjs");
    await writeFile(
      preload,
      `const kill=process.kill;process.kill=function(pid,signal){if(pid<0&&signal===0){const error=new Error('fixture permission');error.code='EPERM';throw error;}return kill.call(process,pid,signal);};\n`,
    );
    try {
      await expect(
        promisify(execFile)(f.wrapper, [], {
          env: {
            ...process.env,
            PATH: `${f.root}:${process.env.PATH}`,
            NODE_OPTIONS: `--require ${preload}`,
          },
          timeout: 6000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        killed: false,
        stderr: expect.stringContaining("Factory SDK owned scope cleanup unverified"),
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
