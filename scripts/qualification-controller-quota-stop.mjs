/**
 * External, credential-blind fetch interceptor for the installed controller
 * quota-stop qualifier. The temporary systemd manager environment may preload
 * this file into another Node service, so it changes process state only after
 * the complete installed controller argv and systemd identity match the arm.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const QUOTA_STOP_ARM_ENV = "FACTORY_INSTALLED_QUOTA_STOP_ARM";
const MAX_ARM_BYTES = 16 * 1024;
const FIXTURE_TOKEN = "installed-quota-stop-no-transport";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function privateFile(path, uid, maximum) {
  const facts = lstatSync(path);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${path} must be a regular file`);
  assert.equal(facts.uid, uid, `${path} owner differs`);
  assert.equal(facts.mode & 0o777, 0o600, `${path} must be mode 0600`);
  assert.equal(facts.nlink, 1, `${path} must have one link`);
  assert.ok(facts.size > 0 && facts.size <= maximum, `${path} is outside its byte bound`);
  return readFileSync(path);
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields differ`);
}

export function classifyQuotaStopRequest(input, init, repository) {
  assert.match(repository, /^[^/\s]+\/[^/\s]+$/, "qualification repository is invalid");
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = String(
    init?.method ?? (input instanceof Request ? input.method : "GET"),
  ).toUpperCase();
  const expectedPath = `/repos/${repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  assert.equal(url.protocol, "https:", "qualification request protocol differs");
  assert.equal(url.hostname, "api.github.com", "qualification request host differs");
  assert.equal(url.port, "", "qualification request port differs");
  assert.equal(url.username, "", "qualification request userinfo is unexpected");
  assert.equal(url.password, "", "qualification request userinfo is unexpected");
  assert.equal(url.search, "", "qualification request query string is unexpected");
  assert.equal(url.hash, "", "qualification request fragment is unexpected");
  assert.equal(url.pathname, expectedPath, "qualification request route differs");
  assert.equal(method, "GET", "repository-facts qualification request must be read-only");
  return { method, route: "repository", operation: "repository-facts-rest-read" };
}

function loadArm(path, uid) {
  assert.equal(resolve(path), path, "qualification arm path must be absolute and normalized");
  const runtime = `/run/user/${uid}`;
  assert.equal(
    resolve(dirname(path)),
    runtime,
    "qualification arm must be in the user runtime directory",
  );
  const bytes = privateFile(path, uid, MAX_ARM_BYTES);
  const arm = JSON.parse(bytes.toString("utf8"));
  exactKeys(
    arm,
    [
      "protocol",
      "caseId",
      "unit",
      "createdAt",
      "expiresAt",
      "resetEpoch",
      "reachedPath",
      "telemetryPath",
      "nodeExecutable",
      "factoryCli",
      "repository",
      "checkout",
      "artifactIdentity",
    ],
    "qualification arm",
  );
  assert.equal(arm.protocol, "clockgrove.factory/installed-controller-quota-stop-arm");
  assert.match(arm.caseId, /^[a-f0-9]{32}$/);
  assert.match(arm.unit, /^clockgrove-factory-[a-f0-9]{16}\.service$/);
  assert.match(arm.repository, /^[^/\s]+\/[^/\s]+$/);
  assert.equal(resolve(arm.nodeExecutable), arm.nodeExecutable, "Node path is not absolute");
  assert.equal(resolve(arm.factoryCli), arm.factoryCli, "Factory CLI path is not absolute");
  assert.equal(resolve(arm.checkout), arm.checkout, "checkout path is not absolute");
  assert.match(arm.artifactIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    path,
    `${runtime}/.${arm.unit}.${arm.caseId}.arm.json`,
    "qualification arm path differs",
  );
  const created = Date.parse(arm.createdAt);
  const expires = Date.parse(arm.expiresAt);
  assert.ok(
    Number.isFinite(created) && Number.isFinite(expires),
    "qualification arm time is invalid",
  );
  assert.ok(created <= Date.now() && expires > Date.now(), "qualification arm is not active");
  assert.ok(expires - created <= 120_000, "qualification arm lifetime is unbounded");
  assert.ok(Number.isSafeInteger(arm.resetEpoch) && arm.resetEpoch * 1_000 > Date.now());
  assert.notEqual(arm.reachedPath, arm.telemetryPath, "qualification outputs must be distinct");
  for (const output of [arm.reachedPath, arm.telemetryPath]) {
    assert.equal(
      resolve(dirname(output)),
      runtime,
      "qualification output escaped runtime directory",
    );
    assert.equal(
      output.startsWith(`${runtime}/.${arm.unit}.${arm.caseId}.`),
      true,
      "qualification output name differs",
    );
    assert.match(output, /\.(?:reached|telemetry)\.json$/);
  }
  return { arm, armDigest: sha256(bytes) };
}

function expectedArgv(arm) {
  return [
    arm.nodeExecutable,
    arm.factoryCli,
    "controller",
    "run",
    arm.repository,
    "--repo",
    arm.checkout,
    "--executable-identity",
    arm.artifactIdentity,
  ];
}

function unifiedCgroupUnit(value) {
  const match = /^0::(\/[^\n\0]+)\n?$/.exec(value);
  if (!match) return null;
  const parts = match[1].split("/");
  return parts.at(-1) || null;
}

export function quotaStopTargetMatch(arm, observation) {
  const expected = expectedArgv(arm);
  const factoryControllerCandidate =
    observation.argv[1] === arm.factoryCli &&
    observation.argv[2] === "controller" &&
    observation.argv[3] === "run";
  const argvMatches =
    observation.argv.length === expected.length &&
    observation.argv.every((value, index) => value === expected[index]);
  if (!argvMatches) {
    assert.equal(
      factoryControllerCandidate,
      false,
      "qualification Factory controller target arguments differ",
    );
    return { argvMatches: false, targetMatches: false };
  }
  assert.equal(
    unifiedCgroupUnit(observation.cgroup),
    arm.unit,
    "qualification target cgroup differs",
  );
  assert.match(
    observation.invocationId,
    /^[a-f0-9]{32}$/,
    "systemd invocation identity is invalid",
  );
  return { argvMatches: true, targetMatches: true };
}

function processObservation(env) {
  return {
    argv: process.argv,
    cgroup: readFileSync("/proc/self/cgroup", "utf8"),
    invocationId: env.INVOCATION_ID ?? "",
  };
}

function writeExclusive(path, value) {
  const bytes = `${JSON.stringify(value)}\n`;
  assert.ok(Buffer.byteLength(bytes) <= 16 * 1024, "qualification telemetry exceeds its bound");
  writeFileSync(path, bytes, {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode: 0o600,
  });
}

export function installQuotaStopFetchInterceptor(env = process.env, observation = undefined) {
  const armPath = env[QUOTA_STOP_ARM_ENV]?.trim();
  if (!armPath) return false;
  if (process.platform !== "linux" || !process.getuid) return false;
  const loaded = loadArm(armPath, process.getuid());
  const { arm, armDigest } = loaded;
  const observed = observation ?? processObservation(env);
  const target = quotaStopTargetMatch(arm, observed);
  if (!target.argvMatches) return false;
  assert.equal(target.targetMatches, true);
  assert.equal(env[QUOTA_STOP_ARM_ENV], armPath, "qualification arm environment differs");
  assert.equal(env.NODE_OPTIONS, `--import=${import.meta.url}`, "qualification preload differs");

  // This assignment occurs only after exact target proof. The target cannot
  // fall back to gh auth or inherit a user's real token if interception fails.
  process.env.GITHUB_TOKEN = FIXTURE_TOKEN;
  process.env.GH_TOKEN = "";
  let request = null;
  let delivered = false;
  let signalAt = null;
  let release;
  process.once("SIGTERM", () => {
    signalAt = new Date().toISOString();
    release?.(signalAt);
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(request, null, "qualification observed more than one fetch attempt");
    const classification = classifyQuotaStopRequest(input, init, arm.repository);
    const reachedAt = new Date().toISOString();
    request = { ...classification, reachedAt };
    writeExclusive(arm.reachedPath, {
      protocol: "clockgrove.factory/installed-controller-quota-stop-reached",
      caseId: arm.caseId,
      unit: arm.unit,
      armDigest,
      nodeOptionsDigest: sha256(env.NODE_OPTIONS),
      pid: process.pid,
      invocationId: observed.invocationId,
      ...request,
    });
    const stopped = new Promise((resolveStop) => {
      if (signalAt) {
        resolveStop(signalAt);
        return;
      }
      const keepAlive = setInterval(() => undefined, 60_000);
      release = (at) => {
        clearInterval(keepAlive);
        resolveStop(at);
      };
    });
    const stoppedAt = await stopped;
    assert.equal(delivered, false, "qualification quota response was already delivered");
    delivered = true;
    const responseAt = new Date().toISOString();
    writeExclusive(arm.telemetryPath, {
      protocol: "clockgrove.factory/installed-controller-quota-stop-telemetry",
      caseId: arm.caseId,
      unit: arm.unit,
      armDigest,
      nodeOptionsDigest: sha256(env.NODE_OPTIONS),
      pid: process.pid,
      invocationId: observed.invocationId,
      request,
      signal: "SIGTERM",
      signalAt: stoppedAt,
      responseAt,
      injectedResponses: 1,
      upstreamFetchCalls: 0,
      injectedStatus: 403,
      primaryResource: "core",
      remaining: 0,
      resetEpoch: arm.resetEpoch,
      remoteEffect: "none-preload-intercept",
    });
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      statusText: "Forbidden",
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-resource": "core",
        "x-ratelimit-reset": String(arm.resetEpoch),
      },
    });
  };
  return true;
}

installQuotaStopFetchInterceptor();
