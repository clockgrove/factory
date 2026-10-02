import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
    `import {createInterface} from 'node:readline';import fs from 'node:fs';const mode=${JSON.stringify(mode)};const record=${JSON.stringify(record)};if(mode==='startup-failure'){console.error('state runtime unavailable');process.exit(1)}const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(record,JSON.stringify({method:m.method,args:process.argv.slice(2),params:m.params,githubToken:process.env.GITHUB_TOKEN??null,sqliteHome:process.env.CODEX_SQLITE_HOME??null,codexHome:process.env.CODEX_HOME??null})+'\\n');if(!m.id)return;if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));return}if(m.method!=='command/exec')throw Error('Unexpected method');const [, , ,inside,outside,token]=m.params.command;if(mode!=='forged')fs.writeFileSync(inside,token);if(mode==='outside-allowed')fs.writeFileSync(outside,token);console.log(JSON.stringify({id:m.id,result:{exitCode:0,stdout:JSON.stringify({writable:true,refused:mode!=='outside-allowed'}),stderr:''}}))});`,
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
    assert.equal(result.outsideDirectory, input.outsideDirectory);
    assert.equal(result.outsideHostWritable, true);
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
    assert.match(requests[2].params.command[2], /flag:'wx',mode:0o600/);
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
    writeFileSync(
      join(root, "outside", ".factory-readiness-unowned"),
      "retained",
    );
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "unavailable");
    assert.equal(result.outsideWriteRefused, false);
    assert.deepEqual(readdirSync(join(root, "outside")), [
      ".factory-readiness-unowned",
    ]);
  });
});

test("harness startup failure reports unavailable and terminates without a model request", async () => {
  await fixture("startup-failure", async ({ server, input }) => {
    const result = await probeCodexReadiness(input, [process.execPath, server]);
    assert.equal(result.status, "unavailable");
    assert.match(result.detail, /state runtime unavailable/);
    assert.deepEqual(readdirSync(input.workspace), []);
    assert.deepEqual(readdirSync(input.outsideDirectory), []);
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

test("readiness uses home as one default and preserves explicit outside selection", async () => {
  const originalHome = process.env.HOME;
  try {
    await fixture("ready", async ({ server, input, record }) => {
      process.env.HOME = input.outsideDirectory;
      const { outsideDirectory, ...defaultInput } = input;
      const result = await probeCodexReadiness(defaultInput, [
        process.execPath,
        server,
      ]);
      assert.equal(result.status, "ready");
      assert.equal(result.outsideDirectory, outsideDirectory);
      const requests = readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        requests[2].params.command[4].startsWith(
          `${outsideDirectory}/.factory-readiness-`,
        ),
        true,
      );
      process.env.HOME = input.workspace;
      await assert.rejects(
        probeCodexReadiness(defaultInput, [process.execPath, server]),
        /choose an owned existing directory with --outside-directory/,
      );
      assert.equal(
        (await probeCodexReadiness(input, [process.execPath, server])).status,
        "ready",
      );
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("canonical outside alias into workspace refuses before process startup", async () => {
  await fixture("ready", async ({ root, server, record, input }) => {
    const alias = join(root, "workspace-alias");
    symlinkSync(input.workspace, alias);
    await assert.rejects(
      probeCodexReadiness({ ...input, outsideDirectory: alias }, [
        process.execPath,
        server,
      ]),
      /outside the workspace/,
    );
    assert.equal(readdirSync(root).includes("requests.jsonl"), false);
  });
});

test("a host-denied outside write is unavailable before harness startup", async () => {
  await fixture("ready", async ({ root, server, record, input }) => {
    const result = await probeCodexReadiness(
      { ...input, outsideDirectory: "/proc/sys" },
      [process.execPath, server],
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.outsideHostWritable, false);
    assert.equal(result.outsideWriteRefused, false);
    assert.equal(result.workspaceWritable, false);
    assert.match(result.detail, /host-writable outside directory/);
    assert.equal(readdirSync(root).includes("requests.jsonl"), false);
    assert.deepEqual(readdirSync(input.workspace), []);
  });
});

test("readiness inherits the host SQLite directory while retaining the same Codex home", async () => {
  const original = { ...process.env };
  try {
    process.env.CODEX_HOME = "/tmp/existing-codex-home";
    process.env.CODEX_SQLITE_HOME = "/tmp/host-local-sqlite";
    process.env.GITHUB_TOKEN = "excluded-publication-token";
    await fixture("ready", async ({ server, record, input }) => {
      assert.equal(
        (await probeCodexReadiness(input, [process.execPath, server])).status,
        "ready",
      );
      const observed = JSON.parse(readFileSync(record, "utf8").split("\n")[0]);
      assert.equal(observed.codexHome, process.env.CODEX_HOME);
      assert.equal(observed.sqliteHome, process.env.CODEX_SQLITE_HOME);
      assert.equal(observed.githubToken, null);
    });
  } finally {
    process.env = original;
  }
});
