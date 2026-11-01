// clockgrove/factory#2340: a seconds-long DNS failure during validation's
// exact install cost a diagnosis, a repair and an operator hold. An install
// that fails for the network now runs again with backoff before any other
// command; past the retry window it is the environment's wait, never a
// repair. Real Git, the real sandbox and real npm, against a registry here
// that closes its first connections.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateStep } from "../dist/work/steps.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";
// Waits of 125 ms, doubling, within 3 s.
process.env.FACTORY_INSTALL_RETRY_MS = "3000";

// One real package with a bin, packed by npm.
const source = tempDir("factory-outage-package-");
writeFileSync(
  join(source, "package.json"),
  JSON.stringify({ name: "tiny-tool", version: "1.0.0", bin: "tool.js" }),
);
writeFileSync(
  join(source, "tool.js"),
  '#!/usr/bin/env node\nconsole.log("tiny-tool ran");\n',
);
const packed = spawnSync("npm", ["pack", "--silent"], {
  cwd: source,
  encoding: "utf8",
});
assert.equal(packed.status, 0, packed.stderr);
const tarball = readFileSync(join(source, packed.stdout.trim()));

/**
 * The registry: it closes the connection of the first `down` tarball
 * requests (Infinity: every one), then serves the tarball.
 */
const registry = { down: 0, requests: 0 };
const server = createServer((request, response) => {
  if (!request.url.endsWith(".tgz")) {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  registry.requests += 1;
  if (registry.requests <= registry.down) {
    request.socket.destroy();
    return;
  }
  response.end(tarball);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const url = `http://127.0.0.1:${server.address().port}`;

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function commit(checkout, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "change");
  return git(checkout, "rev-parse", "HEAD");
}

const lockfile = (packages) =>
  `${JSON.stringify({ name: "target", lockfileVersion: 3, requires: true, packages: { "": { name: "target", ...packages[""] }, ...packages } }, null, 2)}\n`;

/**
 * The validate step on a candidate that adds tiny-tool, so its dependency
 * inputs differ from the base's, with commands that install it and run it.
 * npm retries nothing itself (`fetch-retries=0`): Factory does.
 */
async function validateCandidate() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const sandbox = { ...config.sandbox, network: "host" };
  const checkout = tempDir("factory-outage-");
  git(checkout, "init", "--quiet");
  const base = commit(checkout, {
    ".gitignore": "node_modules\n",
    ".npmrc": `registry=${url}/\nfetch-retries=0\naudit=false\nfund=false\nupdate-notifier=false\n`,
    "package.json": `${JSON.stringify({ name: "target", private: true })}\n`,
    "package-lock.json": lockfile({ "": {} }),
    "src/index.js": "export {};\n",
  });
  const dependencies = { "tiny-tool": "1.0.0" };
  const built = commit(checkout, {
    "package.json": `${JSON.stringify({ name: "target", private: true, dependencies })}\n`,
    "package-lock.json": lockfile({
      "": { dependencies },
      "node_modules/tiny-tool": {
        version: "1.0.0",
        resolved: `${url}/tiny-tool/-/tiny-tool-1.0.0.tgz`,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        bin: { "tiny-tool": "tool.js" },
      },
    }),
  });
  const work = item("a", {
    ownedPaths: ["src/**", "package.json", "package-lock.json"],
    validation: [
      { command: "npm ci --ignore-scripts" },
      { command: "node_modules/.bin/tiny-tool" },
    ],
  });
  const state = {
    issue: 7,
    done: {
      check: { shown: { blocks: [] } },
      plan: plan([work], { base }),
      "item:a:work": {
        base,
        commit: built,
        tree: git(checkout, "rev-parse", `${built}^{tree}`),
        notes: [],
        sets: [],
      },
    },
    kept: {},
  };
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const workDir = tempDir("factory-work-");
  const events = [];
  const outcome = await validateStep(
    work,
    {
      state,
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push(event),
      runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
      keep: () => {},
    },
    {
      config: { ...config, sandbox, checkout },
      workDir: () => workDir,
      github: {},
    },
    undefined,
  );
  return { outcome, events };
}

const retries = (events) =>
  events.filter((event) => event.event === "validation-install-retry");
const ran = (events) =>
  events
    .filter((event) => event.event === "validation-command")
    .map((event) => event.index);

test("an install the registry dropped twice runs again and the item validates", {
  skip,
}, async () => {
  Object.assign(registry, { down: 2, requests: 0 });
  const { outcome, events } = await validateCandidate();
  assert.equal(outcome.kind, "done", JSON.stringify(outcome).slice(0, 1500));
  assert.equal(registry.requests, 3);
  assert.deepEqual(
    retries(events).map((event) => event.outage),
    ["npm failed with ECONNRESET", "npm failed with ECONNRESET"],
  );
  assert.deepEqual(ran(events), [0, 1]);
});

test("a registry down past the retry window is the environment's wait, not a repair", {
  skip,
}, async () => {
  Object.assign(registry, { down: Infinity, requests: 0 });
  const { outcome, events } = await validateCandidate();
  assert.equal(outcome.kind, "retry", JSON.stringify(outcome).slice(0, 1500));
  assert.equal(outcome.wait, undefined);
  assert.match(
    outcome.reason,
    /^Validation command failed \(1\): npm ci --ignore-scripts: npm failed with ECONNRESET, and still did \d+ s after its first run, retried with backoff: the registry is out of reach from this host:\n/,
  );
  assert.ok(retries(events).length >= 2, JSON.stringify(retries(events)));
  // Nothing ran on the half-installed tree.
  assert.deepEqual(ran(events), [0]);
});
