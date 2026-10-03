import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import { verifyHydratedAssets } from "../dist/media.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  withProcessCancellation,
} from "../dist/process.js";
import {
  acquireControllerLock,
  releaseControllerLock,
} from "../dist/state-store.js";
import { createTarget } from "./support/integration-fixture.mjs";

async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Hydration subprocess did not reach the blocking command");
}

for (const phase of ["clone", "lfs-pull"])
  test(`private control cancels blocked final hydration ${phase} after preserving subprocess identity`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-hydration-control-"));
    const previous = {
      PATH: process.env.PATH,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    const abort = new AbortController();
    const observations = [];
    const owned = new Map();
    let server;
    let lock;
    let lockPath;
    let hydration;
    let rejection;
    try {
      const target = createTarget(root, { "asset.bin": "selected bytes\n" });
      const realGit = execFileSync("which", ["git"], {
        encoding: "utf8",
      }).trim();
      const bin = join(root, "bin");
      const marker = join(root, "blocked.json");
      mkdirSync(bin);
      // Only the remote-shaped clone/LFS commands are simulated. Everything
      // else uses real Git against the disposable local target.
      writeFileSync(
        join(bin, "git"),
        `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const isClone = args[0] === "clone" || args[2] === "clone";
const isPull = args[2] === "lfs" && args[3] === "pull";
if ((${JSON.stringify(phase)} === "clone" && isClone) ||
    (${JSON.stringify(phase)} === "lfs-pull" && isPull)) {
  const clone = isClone ? args.at(-1) : args[1];
  mkdirSync(clone, { recursive: true });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, clone }));
  // Bound a regression to synchronous execution without leaving a hung test.
  setTimeout(() => process.exit(17), 10000);
} else if (args[2] === "lfs" && args[3] === "install") {
  process.exit(0);
} else {
  execFileSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
}
`,
        { mode: 0o700 },
      );
      process.env.PATH = `${bin}:${previous.PATH}`;
      process.env.XDG_STATE_HOME = join(root, "state");
      const repository = "example/hydration-control";
      mkdirSync(stateRoot(repository), { recursive: true, mode: 0o700 });
      lockPath = join(stateRoot(repository), "controller.lock");
      lock = acquireControllerLock(lockPath, 1);
      server = await serveControl(repository, lock, async (request) => {
        if (request.action === "status") return [...owned.values()];
        assert.equal(request.action, "cancel");
        abort.abort();
        return "requested";
      });
      hydration = withProcessCancellation(
        abort.signal,
        () =>
          verifyHydratedAssets({
            checkout: target.checkout,
            workRoot: join(root, "hydration"),
            integratedSha: target.baseSha,
            selections: [
              { itemId: "media", set: { id: "selected", members: [] } },
            ],
          }),
        (identity, settled) => {
          observations.push({ ...identity, settled });
          if (settled) {
            assert.equal(processGroupExists(identity.pid), false);
            owned.delete(identity.pid);
          } else owned.set(identity.pid, identity);
        },
      );
      rejection = assert.rejects(
        hydration,
        new RegExp(
          `^Error: Fresh-clone hydration verification failed during ${phase}$`,
        ),
      );
      await until(() => existsSync(marker));
      const blocked = JSON.parse(readFileSync(marker, "utf8"));
      const status = await requestControl(repository, {
        objective: 1,
        action: "status",
      });
      assert.equal(status.handled, true);
      assert.deepEqual(status.result, [owned.get(blocked.pid)]);
      assert.equal(
        owned.get(blocked.pid).startTime,
        linuxProcessIdentity(blocked.pid).startTime,
      );
      assert.equal(processGroupExists(blocked.pid), true);
      assert.equal(existsSync(blocked.clone), true);
      assert.deepEqual(
        await requestControl(repository, { objective: 1, action: "cancel" }),
        {
          handled: true,
          result: "requested",
        },
      );
      await rejection;
      assert.equal(processGroupExists(blocked.pid), false);
      assert.equal(owned.size, 0);
      assert.deepEqual(
        observations
          .filter(({ pid }) => pid === blocked.pid)
          .map(({ settled }) => settled),
        [false, true],
      );
      assert.equal(existsSync(blocked.clone), false);
      assert.deepEqual(readdirSync(join(root, "hydration")), []);
    } finally {
      abort.abort();
      await hydration?.catch(() => undefined);
      await rejection?.catch(() => undefined);
      if (server) await new Promise((resolve) => server.close(resolve));
      if (lock) releaseControllerLock(lockPath, lock);
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

test("cancellation during asynchronous selected-byte hashing cannot produce a hydration receipt", async () => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "factory-hydration-hash-cancel-"));
  const original = fs.createReadStream;
  const abort = new AbortController();
  let hashStarted = false;
  try {
    const bytes = Buffer.alloc(128 * 1024, 42);
    const target = createTarget(root, { "asset.bin": bytes });
    fs.createReadStream = function (path, options) {
      const stream = original(path, options);
      if (String(path).endsWith("/asset.bin"))
        stream.once("data", () => {
          hashStarted = true;
          abort.abort();
        });
      return stream;
    };
    syncBuiltinESMExports();
    await assert.rejects(
      withProcessCancellation(abort.signal, () =>
        verifyHydratedAssets({
          checkout: target.checkout,
          workRoot: join(root, "hydration"),
          integratedSha: target.baseSha,
          selections: [
            {
              itemId: "media",
              set: {
                id: "selected",
                members: [
                  {
                    role: "asset",
                    destination: "asset.bin",
                    ref: {
                      digest: createHash("sha256").update(bytes).digest("hex"),
                      bytes: bytes.length,
                      mediaType: "application/octet-stream",
                    },
                  },
                ],
              },
            },
          ],
        }),
      ),
      /verification failed during selected-byte-verification/,
    );
    assert.equal(hashStarted, true);
    assert.deepEqual(readdirSync(join(root, "hydration")), []);
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
