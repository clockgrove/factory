import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { SandboxExecutionDriver } from "../dist/index.js";
import { sandboxFiles } from "../dist/execution/sandbox-files.js";
import { LocalContentStore } from "../dist/content/local.js";
import { executionContext } from "../dist/execution/checkpoint.js";
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
  const argv = writeSandboxInvoker(
    root,
    pathToFileURL(resolve("dist/index.js")).href,
  );
  const options = {
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
  assert.equal(f.provider.starts, starts + 1);
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.terminal, "cancelled");
});
test("unknown create or execute acknowledgement cannot duplicate external work", async (t) => {
  for (const field of ["createUnknown", "executeUnknown"]) {
    const f = fixture(t);
    f.provider[field] = true;
    await assert.rejects(
      f.driver.start(f.request, f.context),
      /acknowledgement lost/,
    );
    const starts = f.provider.starts;
    await assert.rejects(
      new SandboxExecutionDriver(f.options).observe(
        f.work.execution,
        f.context,
      ),
      /unknown/,
    );
    assert.equal(f.provider.starts, starts);
    for (const h of f.provider.resources.values()) {
      if (field === "executeUnknown") {
        for (const p of f.provider.processes.values())
          if (p.state === "running")
            await new Promise((r) => p.child.once("exit", r));
      }
      f.provider.resources.delete(h.identity);
    }
  }
});
test("wrong reply digest, identity and unsafe result path fail closed; cleanup failure remains visible", async (t) => {
  for (const variant of ["digest", "identity", "path", "cleanup"]) {
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
    if (variant === "cleanup") f.provider.destroyFailure = true;
    await assert.rejects(
      f.driver.collect(h, f.context),
      /digest|identity|Unsafe|destruction/,
    );
    assert.equal(f.provider.resources.size, 1);
    assert.equal(
      f.work.execution.data.phase,
      variant === "cleanup"
        ? "destroying"
        : "invoked" === f.work.execution.data.phase
          ? "invoked"
          : "ready",
    );
  }
});
test("source and selected bytes reach the sandbox, and a complete AssetSet returns through controller capture", async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 17, 31]);
  writeFileSync(join(f.checkout, "source.bin"), bytes);
  f.git("add", "source.bin");
  f.git("commit", "-qm", "source");
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
    assert.equal(f.git("show", result.changeRef + ":keep.txt"), "changed");
    assert.equal(f.provider.starts, starts);
    assert.equal(f.provider.resources.size, 0);
  }
});

test("tracked file beneath an ignored symlinked parent cannot export outside bytes", (t) => {
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
  assert.throws(
    () => sandboxFiles(f.checkout),
    /Unsupported sandbox result parent/,
  );
});

test("failed input verification can cancel its known resource without a nonexistent harness handle", async (t) => {
  const f = fixture(t);
  f.provider.corruptInput = true;
  await assert.rejects(
    f.driver.start(f.request, f.context),
    /input digest mismatch/,
  );
  const starts = f.provider.starts;
  await new SandboxExecutionDriver(f.options).cancel(
    JSON.parse(JSON.stringify(f.work.execution)),
    f.context,
  );
  assert.equal(f.provider.starts, starts);
  assert.equal(f.provider.resources.size, 0);
  assert.equal(f.work.execution.data.terminal, "cancelled");
});
