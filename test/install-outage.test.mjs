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
/**
 * The install retry window, read when each install starts. Its waits are
 * 1/24 of it, doubling, and a run's own time counts against it, so a
 * loaded host spends it on the runs: tests that need a number of retries
 * get a window several times their runs, and the registry decides when
 * the outage ends by counting requests, never by the clock.
 */
const window = (ms) => {
  process.env.FACTORY_INSTALL_RETRY_MS = String(ms);
};

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
 * requests (Infinity: every one), then serves the tarball. Its ping
 * (`/-/ping`) answers with `ping`, else closes the connection too.
 */
const registry = { down: 0, requests: 0, ping: false };
const server = createServer((request, response) => {
  if (request.url === "/-/ping") {
    if (registry.ping) response.end("{}");
    else request.socket.destroy();
    return;
  }
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
      workDir: (issue) => join(workDir, "work", String(issue)),
      github: {},
    },
    undefined,
  );
  return { outcome, events };
}

// Long enough for a first retry after a run of several seconds, short
// enough to end within a few seconds on an idle host.
const RETRY_WINDOW = 6000;

const retries = (events) =>
  events.filter((event) => event.event === "validation-install-retry");
const result = (events) =>
  events.find(
    (event) => event.event === "validation-result" && event.index === 0,
  );
const ran = (events) =>
  events
    .filter((event) => event.event === "validation-command")
    .map((event) => event.index);

test("an install the registry dropped twice runs again and the item validates", {
  skip,
}, async () => {
  // Waits of 0.5 s and 1 s: two runs of 5 s still fit.
  window(12_000);
  Object.assign(registry, { down: 2, requests: 0, ping: false });
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
  window(RETRY_WINDOW);
  Object.assign(registry, { down: Infinity, requests: 0, ping: false });
  const { outcome, events } = await validateCandidate();
  assert.equal(outcome.kind, "retry", JSON.stringify(outcome).slice(0, 1500));
  assert.equal(outcome.wait, undefined);
  assert.match(
    outcome.reason,
    /^Validation command failed \(1\): npm ci --ignore-scripts: npm failed with ECONNRESET, and still did \d+ s after its first run, retried with backoff, and the registry does not answer its ping from this host:\n/,
  );
  // Every refused request but the last was followed by a retry.
  assert.ok(retries(events).length >= 1, JSON.stringify(retries(events)));
  assert.equal(registry.requests, retries(events).length + 1);
  assert.equal(result(events).registry, "unreachable");
  // Nothing ran on the half-installed tree.
  assert.deepEqual(ran(events), [0]);
});

test("a registry that answers its ping after the window makes the install's failure the result's", {
  skip,
}, async () => {
  // Reachable, but every tarball request breaks off: no outage of the host.
  window(RETRY_WINDOW);
  Object.assign(registry, { down: Infinity, requests: 0, ping: true });
  const { outcome, events } = await validateCandidate();
  assert.equal(outcome.kind, "repair", JSON.stringify(outcome).slice(0, 1500));
  assert.match(
    outcome.finding,
    /^Validation command failed \(1\): npm ci --ignore-scripts: npm failed with ECONNRESET, though the registry answers its ping:\n/,
  );
  assert.equal(result(events).registry, "answered");
  assert.deepEqual(ran(events), [0]);
});
