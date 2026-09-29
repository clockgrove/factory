import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeCodexReadiness } from "../dist/harness-readiness.js";

async function fixture(mode, run) {
  const root = mkdtempSync(join(tmpdir(), "factory-harness-readiness-test-"));
  for (const name of ["workspace", "outside", "credentials"])
    mkdirSync(join(root, name));
  const server = join(root, "server.mjs");
  const record = join(root, "requests.jsonl");
  writeFileSync(
    server,
    `import {createInterface} from 'node:readline';import fs from 'node:fs';const mode=${JSON.stringify(mode)};const record=${JSON.stringify(record)};if(mode==='startup-failure'){console.error('state runtime unavailable');process.exit(1)}const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(record,JSON.stringify({method:m.method,args:process.argv.slice(2),params:m.params,githubToken:process.env.GITHUB_TOKEN??null})+'\\n');if(!m.id)return;if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));return}if(m.method!=='command/exec')throw Error('Unexpected method');const [, , ,inside,outside,token]=m.params.command;if(mode!=='forged')fs.writeFileSync(inside,token);if(mode==='outside-allowed')fs.writeFileSync(outside,token);console.log(JSON.stringify({id:m.id,result:{exitCode:0,stdout:JSON.stringify({writable:true,refused:mode!=='outside-allowed'}),stderr:''}}))});`,
  );
  try {
    await run({
      root,
      server,
      record,
      input: {
        workspace: join(root, "workspace"),
        outsideDirectory: join(root, "outside"),
        credentialDirectory: join(root, "credentials"),
        network: "off",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("model-free readiness uses worker policy, private environment, exact sentinel evidence and cleans probes", async () => {
  await fixture("ready", async ({ root, server, record, input }) => {
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "ready");
    const requests = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests.map((x) => x.method),
      ["initialize", "initialized", "command/exec"],
    );
    assert.ok(requests[0].args.includes('sandbox_mode="workspace-write"'));
    assert.ok(requests[0].args.includes('approval_policy="never"'));
    assert.ok(
      requests[0].args.includes("sandbox_workspace_write.network_access=false"),
    );
    assert.equal(requests[0].githubToken, null);
    assert.equal(requests[2].params.cwd, input.workspace);
    assert.equal(requests[2].params.sandboxPolicy, undefined);
    assert.deepEqual(readdirSync(join(root, "workspace")), []);
    assert.deepEqual(readdirSync(join(root, "outside")), []);
  });
});

test("readiness does not accept a claimed write without actual owned sentinel bytes", async () => {
  await fixture("forged", async ({ server, input }) => {
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "unavailable");
    assert.equal(result.workspaceWritable, false);
  });
});

test("outside write success is an unproven boundary and only owned probe files are removed", async () => {
  await fixture("outside-allowed", async ({ root, server, input }) => {
    writeFileSync(join(root, "outside", "keep"), "retained");
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "unavailable");
    assert.equal(result.outsideWriteRefused, false);
    assert.deepEqual(readdirSync(join(root, "outside")), ["keep"]);
  });
});

test("harness startup failure reports unavailable and terminates without a model request", async () => {
  await fixture("startup-failure", async ({ server, input }) => {
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "unavailable");
    assert.match(result.detail, /state runtime unavailable/);
  });
});

test("refusal probe inside workspace is rejected before harness startup", async () => {
  await fixture("ready", async ({ input }) => {
    await assert.rejects(
      probeCodexReadiness({ ...input, outsideDirectory: input.workspace }),
      /outside the workspace/,
    );
  });
});
