import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { SandboxExecutionDriver } from "../dist/index.js";
import { sandboxFiles } from "../dist/execution/sandbox-files.js";
import { LocalContentStore } from "../dist/content/local.js";
import { executionContext } from "../dist/execution/checkpoint.js";
import { SettledAttemptFailure } from "../dist/work-repair.js";
import {
  FixtureSandboxProvider,
  writeSandboxInvoker,
} from "./support/sandbox-provider.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(checkout, "keep.txt"), "baseline\n");
  writeFileSync(join(checkout, "old.txt"), "delete\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const provider = new FixtureSandboxProvider(join(root, "remote"));
  const remote = join(root, "published.git");
  execFileSync("git", ["clone", "--bare", checkout, remote], { stdio: "pipe" });
  provider.repository = remote;
  const argv = writeSandboxInvoker(
    root,
    pathToFileURL(resolve("dist/index.js")).href,
  );
  const options = {
    repository: "example/fixture",
    checkout,
    workRoot: join(root, "controller"),
    contentStore: new LocalContentStore(join(root, "content")),
    providerIdentity: "fixture@1",
    provider,
    harness: { identity: "fixture-harness@1", config: {} },
    argv,
    concurrency: 2,
  };
  const request = {
    attemptId: "attempt-one",
    baseSha: git("rev-parse", "HEAD"),
    item: {
      id: "first",
      title: "Exact bytes",
      goal: "Exact bytes",
      acceptance: ["Exact bytes"],
      nonGoals: [],
      citations: [],
      dependencies: [],
      ownedPaths: ["keep.txt", "old.txt", "new.bin", "run.sh"],
      validation: [],
      brief: "Exact bytes",
    },
  };
  const work = { attempt: request.attemptId };
  const context = executionContext(work, () => {});
  const driver = new SandboxExecutionDriver(options);
  return {
    root,
    checkout,
    git,
    provider,
    options,
    request,
    work,
    context,
    driver,
  };
}
const release = (f, h) =>
  writeFileSync(join(h.data.sandbox.workspace, "release"), "go");
async function complete(driver, h, context) {
  for (let i = 0; i < 100; i++) {
    const s = await driver.observe(h, context);
    if (s.state !== "running") {
      assert.equal(s.state, "complete");
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Fixture did not settle");
}
test("separate sandbox attempts overlap and restarted controller collects exact bytes/modes/deletions and successor inputs", async (t) => {
  const f = fixture(t);
  const h = await f.driver.start(f.request, f.context);
  const second = await f.driver.start({
    ...f.request,
    attemptId: "attempt-two",
  });
  assert.equal(f.provider.maxActive, 2);
  assert.equal((await f.driver.observe(h, f.context)).state, "running");
  const restored = JSON.parse(JSON.stringify(f.work.execution));
  const next = new SandboxExecutionDriver(f.options);
  release(f, h);
  release(f, second);
  await complete(next, restored, f.context);
  const result = await next.collect(restored, f.context);
  assert.equal(result.collection, undefined);
  assert.equal(f.git("show", result.changeRef + ":keep.txt"), "changed");
  assert.equal(f.git("ls-tree", result.changeRef, "old.txt"), "");
  assert.match(f.git("ls-tree", result.changeRef, "run.sh"), /^100755/);
  assert.deepEqual(
    execFileSync("git", [
      "-C",
      f.checkout,
      "show",
      result.changeRef + ":new.bin",
    ]),
    Buffer.from([0, 1, 255, 254]),
  );
  await complete(f.driver, second);
  await f.driver.collect(second);
  f.git(
    "push",
    f.provider.repository,
    `${result.changeRef}:refs/heads/accepted-predecessor`,
  );
  const successor = await next.start({
    ...f.request,
    baseSha: result.changeRef,
    attemptId: "successor",
    item: {
      ...f.request.item,
      id: "successor",
      ownedPaths: ["keep.txt", "new.bin", "run.sh"],
    },
  });
  release(f, successor);
  await complete(next, successor);
  await next.cancel(successor);
  assert.equal(f.provider.resources.size, 0);
});
test("restarted controller cancels the same owned attempt without another harness start", async (t) => {
  const f = fixture(t);
  const h = await f.driver.start(f.request, f.context);
  const starts = f.provider.starts;
  await new SandboxExecutionDriver(f.options).cancel(
    JSON.parse(JSON.stringify(h)),
    f.context,
  );
  assert.equal(f.provider.starts, starts);
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.terminal, "cancelled");
});
test("lost create acknowledgement adopts the tagged sandbox and completes", async (t) => {
  const f = fixture(t);
  f.provider.createUnknown = true;
  f.provider.autoRelease = true;
  // The lost response leaves a recorded phase for collection to resolve.
  await f.driver.start(f.request, f.context);
  assert.equal(f.work.execution.data.phase, "creating");
  const result = await new SandboxExecutionDriver(f.options).collect(
    JSON.parse(JSON.stringify(f.work.execution)),
    f.context,
  );
  assert.equal(f.git("show", result.changeRef + ":keep.txt"), "changed");
  assert.equal(f.provider.creates, 2);
  assert.equal(f.provider.maxActive, 1);
  assert.equal(f.provider.resources.size, 0);
});
test("lost harness start destroys the sandbox and interrupts the attempt directly", async (t) => {
  const f = fixture(t);
  f.provider.executeUnknown = true;
  // Harness start cannot repeat in one sandbox, so no step interruption is spent first.
  await assert.rejects(
    f.driver.start(f.request, f.context),
    (error) =>
      error instanceof SettledAttemptFailure &&
      error.classification === "interruption",
  );
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.phase, "destroyed");
  const observed = await new SandboxExecutionDriver(f.options).observe(
    JSON.parse(JSON.stringify(f.work.execution)),
    f.context,
  );
  assert.equal(observed.interrupted, true);
});
test("cancellation after a lost create finds and destroys the tagged sandbox without creating one", async (t) => {
  const f = fixture(t);
  f.provider.createUnknown = true;
  await f.driver.start(f.request, f.context);
  assert.equal(f.provider.resources.size, 1);
  const creates = f.provider.creates;
  await new SandboxExecutionDriver(f.options).cancel(
    JSON.parse(JSON.stringify(f.work.execution)),
    f.context,
  );
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.terminal, "cancelled");
  // With nothing tagged, cancellation still never creates a sandbox.
  const other = fixture(t);
  other.provider.createUnknown = true;
  other.provider.create = async () => {
    throw Object.assign(Error("create never arrived"), { status: 503 });
  };
  await other.driver.start(other.request, other.context);
  await new SandboxExecutionDriver(other.options).cancel(
    JSON.parse(JSON.stringify(other.work.execution)),
    other.context,
  );
  assert.equal(other.provider.resources.size, 0);
  assert.equal(f.provider.creates, creates);
});
test("wrong reply digest, identity and unsafe result path fail closed and settle the sandbox; cleanup failure remains visible", async (t) => {
  for (const variant of [
    "digest",
    "identity",
    "path",
    "file-digest",
    "cleanup",
  ]) {
    const f = fixture(t);
    const h = await f.driver.start(f.request, f.context);
    release(f, h);
    await complete(f.driver, h, f.context);
    if (variant === "digest") f.provider.badDigest = true;
    if (variant === "identity")
      f.provider.mutateReply = (d) => {
        d.attemptId = "other";
      };
    if (variant === "path")
      f.provider.mutateReply = (d) => {
        if (d.operation === "collect") d.value.files[0].path = "../outside";
      };
    if (variant === "file-digest")
      f.provider.mutateReply = (d) => {
        if (d.operation === "collect") d.value.files[0].digest = "0".repeat(64);
      };
    if (variant === "cleanup") f.provider.destroyFailure = true;
    await assert.rejects(f.driver.collect(h, f.context), (error) =>
      variant === "cleanup"
        ? /destruction/.test(error.message)
        : error instanceof SettledAttemptFailure &&
          error.classification === "implementation" &&
          /digest|identity|Unsafe/.test(error.message),
    );
    assert.equal(f.provider.resources.size, variant === "cleanup" ? 1 : 0);
    assert.equal(
      f.work.execution.data.phase,
      variant === "cleanup" ? "destroying" : "destroyed",
    );
  }
});
test("source and selected bytes reach the sandbox, and a complete AssetSet returns through controller capture", async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 17, 31]);
  writeFileSync(join(f.checkout, "source.bin"), bytes);
  f.git("add", "source.bin");
  f.git("commit", "-qm", "source");
  f.git("push", f.provider.repository, "HEAD:refs/heads/source");
  const selected = await f.options.contentStore.importFile(
    join(f.checkout, "source.bin"),
    { mediaType: "application/octet-stream" },
  );
  const request = {
    ...f.request,
    baseSha: f.git("rev-parse", "HEAD"),
    selectedAssets: [
      {
        setId: "prior",
        role: "image",
        destination: "prior.bin",
        ref: selected,
      },
    ],
    item: {
      ...f.request.item,
      id: "media",
      ownedPaths: ["image.bin"],
      sourceAssets: [
        {
          path: "source.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["image"],
      minimumAssetSets: 1,
    },
  };
  const h = await f.driver.start(request, f.context);
  release(f, h);
  await complete(f.driver, h, f.context);
  const result = await f.driver.collect(h, f.context);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].capture.complete, true);
  assert.equal(result.assets[0].members[0].ref.digest, selected.digest);
  assert.equal(result.assets[0].members[0].ref.bytes, 4);
  assert.equal(f.provider.resources.size, 0);
});

test("immediate collection waits for the running harness without a premature collect RPC", async (t) => {
  const f = fixture(t);
  const h = await f.driver.start(f.request, f.context);
  let releaseAfterObservation;
  const observed = new Promise((resolve) => {
    releaseAfterObservation = resolve;
  });
  const download = f.provider.download.bind(f.provider);
  f.provider.download = async (handle, output) => {
    const transfer = await download(handle, output);
    if (!output.localPath.endsWith(".json")) return transfer;
    const reply = JSON.parse(readFileSync(output.localPath, "utf8"));
    if (reply.operation === "observe" && reply.value.state === "running")
      releaseAfterObservation();
    return transfer;
  };
  const collecting = f.driver.collect(h, f.context);
  await observed;
  assert.equal(f.provider.resources.size, 1);
  release(f, h);
  const result = await collecting;
  assert.equal(f.git("show", result.changeRef + ":keep.txt"), "changed");
  assert.equal(f.provider.resources.size, 0);
});

test("completed result survives restart after destruction and a recoverable cleanup failure", async (t) => {
  for (const failure of ["after-destroy", "cleanup"]) {
    const f = fixture(t);
    const h = await f.driver.start(f.request, f.context);
    release(f, h);
    if (failure === "cleanup") f.provider.destroyFailure = true;
    let latest;
    const context = {
      cancelled: () => false,
      checkpoint(handle) {
        latest = structuredClone(handle);
        if (failure === "after-destroy" && handle.data.phase === "destroyed")
          throw Error("controller stopped");
      },
    };
    await assert.rejects(
      f.driver.collect(h, context),
      /controller stopped|destruction/,
    );
    assert(latest.data.result.changeRef);
    const starts = f.provider.starts;
    f.provider.destroyFailure = false;
    const restored = JSON.parse(JSON.stringify(latest));
    const next = new SandboxExecutionDriver(f.options);
    const result = await next.collect(restored);
    assert.deepEqual(result, latest.data.result);
    assert.equal(
      existsSync(join(f.options.workRoot, restored.identity)),
      false,
    );
    assert.equal(f.git("show", result.changeRef + ":keep.txt"), "changed");
    assert.equal(f.provider.starts, starts);
    assert.equal(f.provider.resources.size, 0);
  }
});

test("tracked file beneath an ignored symlinked parent cannot export outside bytes", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, "nested"));
  writeFileSync(join(f.checkout, "nested/tracked.txt"), "inside");
  f.git("add", ".");
  f.git("commit", "-qm", "nested baseline");
  writeFileSync(join(f.checkout, ".gitignore"), "nested\n");
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "tracked.txt"), "outside-sensitive-bytes");
  rmSync(join(f.checkout, "nested"), { recursive: true });
  symlinkSync(outside, join(f.checkout, "nested"));
  await assert.rejects(
    () => sandboxFiles(f.checkout),
    /Unsupported sandbox result parent/,
  );
});

test("failed input verification destroys its known resource without a nonexistent harness handle", async (t) => {
  const f = fixture(t);
  f.provider.corruptInput = true;
  await assert.rejects(
    f.driver.start(f.request, f.context),
    (error) =>
      error instanceof SettledAttemptFailure &&
      /input digest mismatch/.test(error.message),
  );
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.terminal, "failed");
  const starts = f.provider.starts;
  await new SandboxExecutionDriver(f.options).cancel(
    JSON.parse(JSON.stringify(f.work.execution)),
    f.context,
  );
  assert.equal(f.provider.starts, starts);
});

test("trusted preparation pulls the published exact base and uploads no repository or authentication", async (t) => {
  const f = fixture(t);
  const uploaded = [];
  const upload = f.provider.upload.bind(f.provider);
  f.provider.upload = async (handle, input) => {
    if (input.remotePath.endsWith("input.tar")) {
      const { list } = await import("tar");
      await list({
        file: input.localPath,
        onReadEntry: (entry) => uploaded.push(entry.path),
      });
    }
    return upload(handle, input);
  };
  const h = await f.driver.start(f.request, f.context);
  assert.deepEqual(f.provider.preparations[0], {
    repository: "example/fixture",
    baseSha: f.request.baseSha,
    treeSha: f.git("rev-parse", "HEAD^{tree}"),
    lfsSources: [],
  });
  assert(uploaded.every((path) => path.startsWith(".factory-inputs")));
  assert.equal(
    existsSync(join(h.data.sandbox.workspace, "repo/.git/config")),
    false,
  );
  await f.driver.cancel(h, f.context);
});

test("unpublished base fails preparation without starting a harness or inventing a publication", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "unpublished.txt"), "local only");
  f.git("add", ".");
  f.git("commit", "-qm", "unpublished");
  await assert.rejects(
    f.driver.start(
      { ...f.request, baseSha: f.git("rev-parse", "HEAD") },
      f.context,
    ),
    /fetch|remote|upload-pack/,
  );
  assert.equal(f.provider.starts, 0);
  await f.driver.cancel(structuredClone(f.work.execution), f.context);
  assert.equal(f.provider.resources.size, 0);
});

test("declared LFS source binds verified raw bytes while the repository retains its pointer", async (t) => {
  const f = fixture(t);
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from([7, 0, 255, 6, 3]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const object = join(f.root, "raw-lfs.bin");
  writeFileSync(object, bytes);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`;
  writeFileSync(join(f.checkout, "source.bin"), pointer);
  f.git("add", "source.bin");
  f.git("commit", "-qm", "LFS source pointer");
  f.git("push", f.provider.repository, "HEAD:refs/heads/source");
  f.provider.lfsObjects = new Map([[digest, object]]);
  const request = {
    ...f.request,
    baseSha: f.git("rev-parse", "HEAD"),
    item: {
      ...f.request.item,
      id: "media",
      ownedPaths: ["image.bin"],
      sourceAssets: [
        {
          path: "source.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["image"],
      minimumAssetSets: 1,
    },
  };
  const h = await f.driver.start(request, f.context);
  assert.equal(
    readFileSync(join(h.data.sandbox.workspace, "repo/source.bin"), "utf8"),
    pointer,
  );
  const invocation = JSON.parse(
    readFileSync(
      join(h.data.sandbox.workspace, "fixture-request.json"),
      "utf8",
    ),
  );
  assert.equal(invocation.sourceAssets[0].ref.digest, digest);
  assert.deepEqual(readFileSync(invocation.sourceAssets[0].path), bytes);
  await f.options.contentStore.verify(invocation.sourceAssets[0].ref);
  release(f, h);
  const result = await f.driver.collect(h, f.context);
  assert.equal(result.assets[0].members[0].ref.digest, digest);
  assert.equal(f.git("show", result.changeRef + ":source.bin"), pointer.trim());
});

test("corrupt required LFS bytes stop before harness execution", async (t) => {
  const f = fixture(t);
  const digest = "a".repeat(64);
  const object = join(f.root, "bad-lfs.bin");
  writeFileSync(object, "bad");
  writeFileSync(
    join(f.checkout, "source.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize 3\n`,
  );
  f.git("add", ".");
  f.git("commit", "-qm", "pointer");
  f.git("push", f.provider.repository, "HEAD:refs/heads/source");
  f.provider.lfsObjects = new Map([[digest, object]]);
  await assert.rejects(
    f.driver.start(
      {
        ...f.request,
        baseSha: f.git("rev-parse", "HEAD"),
        item: {
          ...f.request.item,
          sourceAssets: [
            {
              path: "source.bin",
              role: "source",
              mediaType: "application/octet-stream",
              visibility: "repository",
            },
          ],
        },
      },
      f.context,
    ),
    /LFS source digest mismatch/,
  );
  assert.equal(f.provider.starts, 0);
  await f.driver.cancel(structuredClone(f.work.execution), f.context);
});

test("sandbox preserves typed authentication failure and omits optional undefined reply properties", async (t) => {
  const f = fixture(t);
  const script = join(f.root, "sandbox-entry.mjs");
  let source = readFileSync(script, "utf8");
  source = source.replace(
    "if(existsSync(p))return JSON.parse(readFileSync(p)).observation;return {state:'running'};",
    "return {state:'failed',detail:undefined,authentication:{provider:'fixture',command:'fixture login'}};",
  );
  writeFileSync(script, source);
  const h = await f.driver.start(f.request, f.context);
  await assert.rejects(
    f.driver.collect(h, f.context),
    (error) =>
      error.name === "AuthenticationRequiredError" &&
      error.authentication.command === "fixture login",
  );
  await f.driver.cancel(h, f.context);
});

test("400 MiB binary output round-trips without a repository-sized JavaScript string", async (t) => {
  const f = fixture(t);
  const module = pathToFileURL(resolve("dist/execution/sandbox-files.js")).href;
  execFileSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {writeFileSync,truncateSync,mkdirSync,statSync} from 'node:fs';
    import {join} from 'node:path';
    import {exportSandboxFiles,importSandboxFiles,sandboxFileDigest} from ${JSON.stringify(module)};
    const root=${JSON.stringify(f.root)}, checkout=${JSON.stringify(f.checkout)};
    const path=join(checkout,'large.bin');writeFileSync(path,'');truncateSync(path,400*1024*1024);
    const archive=join(root,'large.tar');const files=await exportSandboxFiles(checkout,archive);
    assert(JSON.stringify(files).length<2000);
    const output=join(root,'imported');mkdirSync(output);
    await importSandboxFiles(output,files,archive,join(root,'unpacked'));
    assert.equal(statSync(join(output,'large.bin')).size,400*1024*1024);
    assert.deepEqual(await sandboxFileDigest(join(output,'large.bin')),await sandboxFileDigest(path));
  `,
    ],
    { stdio: "pipe" },
  );
});

test("authorized private local input is explicitly transferred and verified through collection", async (t) => {
  const f = fixture(t);
  const source = join(f.root, "private-source.bin");
  const bytes = Buffer.from([13, 27, 0, 255]);
  writeFileSync(source, bytes);
  const h = await f.driver.start(
    {
      ...f.request,
      objectiveBody: `Use the private input ${source}`,
      item: {
        ...f.request.item,
        id: "media",
        ownedPaths: ["image.bin"],
        sourceAssets: [
          {
            kind: "local",
            path: source,
            role: "source",
            mediaType: "application/octet-stream",
            visibility: "private",
          },
        ],
        expectedOutputRoles: ["image"],
        minimumAssetSets: 1,
      },
    },
    f.context,
  );
  const request = JSON.parse(
    readFileSync(
      join(h.data.sandbox.workspace, "fixture-request.json"),
      "utf8",
    ),
  );
  assert(
    request.sourceAssets[0].path.startsWith(
      join(h.data.sandbox.workspace, "repo/.factory-inputs"),
    ),
  );
  assert.deepEqual(readFileSync(request.sourceAssets[0].path), bytes);
  release(f, h);
  const result = await f.driver.collect(h, f.context);
  assert.equal(
    result.assets[0].members[0].ref.digest,
    request.sourceAssets[0].ref.digest,
  );
  assert.equal(f.provider.resources.size, 0);
});

test("optional undefined properties in resource, process, harness and collected result checkpoints are omitted", async (t) => {
  const f = fixture(t);
  const create = f.provider.create.bind(f.provider);
  f.provider.create = async (request) => ({
    ...(await create(request)),
    data: undefined,
  });
  const execute = f.provider.execute.bind(f.provider);
  f.provider.execute = async (handle, command) => ({
    ...(await execute(handle, command)),
    data: undefined,
  });
  writeFileSync(
    join(f.root, "sandbox-entry.mjs"),
    `
    import {runSandboxHarness} from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)};
    import {writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    await runSandboxHarness({identity:'fixture-harness@1',config:{},harness:{
      capabilities:{protocolVersion:1,worktree:'factory-owned-read-write',head:'preserve',lifecycle:'restart-safe-durable-handle',publication:'controller-only',assetSets:true,authentication:'none'},
      async start(request){writeFileSync(join(request.worktree,'keep.txt'),'optional result');return {identity:request.attemptId,data:undefined};},
      async observe(){return {state:'complete',detail:undefined};},
      async cancel(){},
      async collect(){return {evidence:undefined,assets:undefined};}
    }});
  `,
  );
  const h = await f.driver.start(f.request, f.context);
  assert.equal(Object.hasOwn(h.data.sandbox, "data"), false);
  const resource = h.data.sandbox.workspace;
  assert.equal(
    Object.hasOwn(
      JSON.parse(readFileSync(join(resource, "harness.json"), "utf8")),
      "data",
    ),
    false,
  );
  const result = await f.driver.collect(h, f.context);
  assert.equal(Object.hasOwn(result, "evidence"), false);
  assert.equal(Object.hasOwn(f.work.execution.data.result, "evidence"), false);
  assert.equal(
    f.git("show", result.changeRef + ":keep.txt"),
    "optional result",
  );
  assert.equal(f.provider.resources.size, 0);
  assert.deepEqual(
    await new SandboxExecutionDriver(f.options).collect(
      structuredClone(f.work.execution),
    ),
    result,
  );
});

test("optional normalization does not accept invalid array values or non-JSON values", async () => {
  const { sandboxJsonValue } = await import(
    "../dist/execution/sandbox-worker.js"
  );
  const { assertDurableValue } = await import(
    "../dist/execution/checkpoint.js"
  );
  for (const value of [
    [undefined],
    { value: NaN },
    { value: 1n },
    { value: () => true },
    { value: new Date() },
    { [Symbol("unsupported")]: "value" },
  ])
    assert.throws(
      () => assertDurableValue(sandboxJsonValue(value), "reply"),
      /JSON/,
    );
});
