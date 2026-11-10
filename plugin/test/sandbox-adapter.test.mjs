import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError, checkCreateSpec, checkRunSpec, openSandbox } from "../scripts/lib/adapters/sandbox.mjs";
import { open, userCommand, vendorError } from "../scripts/lib/adapters/sandbox-vercel.mjs";

const spec = { vcpus: 1, timeoutMs: 60_000, tags: { factory: "objective", issue: "12" }, network: { allow: ["registry.npmjs.org", "*.github.com"] } };
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SandboxError, `a SandboxError, got ${e}`);
    return e.code;
  }
  return "no error";
};

test("create spec: sizes, tags and the network allow-list are checked; an image and a snapshot together are refused", () => {
  assert.deepEqual(checkCreateSpec(spec).network, { allow: ["registry.npmjs.org", "*.github.com"] });
  assert.equal(checkCreateSpec({ ...spec, network: "none" }).network, "none");
  for (const bad of [{ vcpus: 0 }, { timeoutMs: 10 }, { image: "a", snapshot: "b" }, { tags: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" } }, { tags: { k: "has space" } }, { network: { allow: ["https://x.com/"] } }, { network: "some" }])
    assert.equal(code(() => checkCreateSpec({ ...spec, ...bad })), "invalid", JSON.stringify(bad));
});

test("run spec: argv, env names, the user name and the limit are checked", () => {
  assert.equal(checkRunSpec({ argv: ["true"], env: { A_1: "x" }, user: "factory-agent", timeoutMs: 5 }).user, "factory-agent");
  for (const bad of [{ argv: [] }, { argv: ["true"], env: { "A-B": "x" } }, { argv: ["true"], env: { A: 1 } }, { argv: ["true"], user: "Bad User" }, { argv: ["true"], cwd: "rel" }, { argv: ["true"], timeoutMs: 0 }])
    assert.equal(code(() => checkRunSpec(bad)), "invalid", JSON.stringify(bad));
});

test("as another user: the sudo command line carries env names, never a value", () => {
  const { cmd, args } = userCommand({ user: "factory-agent", home: "/home/factory-agent", env: { MODEL_KEY: "sk-secret-value" }, argv: ["node", "x.js"] });
  assert.equal(cmd, "sudo");
  assert.deepEqual(args.slice(0, 4), ["-n", "-u", "factory-agent", "--"]);
  assert.ok(args.includes("PATH LANG TERM MODEL_KEY"));
  assert.ok(!args.some((a) => a.includes("sk-secret-value")));
  assert.deepEqual(args.slice(-2), ["node", "x.js"]);
});

test("vendor errors map to codes by HTTP status and Vercel's error code", () => {
  const api = (status, c) => Object.assign(new Error("x"), { response: { status }, json: c ? { error: { code: c } } : undefined });
  const cases = [
    [api(401), "auth"],
    [api(404), "not_found"],
    [api(410, "snapshot_not_found"), "not_found"],
    [api(422, "sandbox_stopping"), "conflict"],
    [api(422, "bad_request"), "invalid"],
    [api(429), "rate_limited"],
    [api(503), "unavailable"],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "unavailable"],
    [Object.assign(new Error("exists"), { name: "SandboxUserAlreadyExistsError" }), "conflict"],
    [new Error("other"), "vendor"],
  ];
  for (const [err, want] of cases) assert.equal(vendorError(err).code, want, `${err.response?.status ?? err.name}`);
  assert.equal(vendorError(api(410, "snapshot_not_found")).vendorCode, "snapshot_not_found");
});

test("a create refused past the plan's session cap carries the cap it states; nothing else does", () => {
  const api = (status, code, message) => Object.assign(new Error(`Status code ${status} is not ok: ${message}`), { response: { status }, json: { error: { code, message } } });
  const capped = vendorError(api(400, "bad_request", "`timeout` should be <= 45m"));
  assert.deepEqual([capped.code, capped.status, capped.vendorCode, capped.limitMs], ["invalid", 400, "bad_request", 45 * 60_000]);
  assert.equal(vendorError(api(400, "bad_request", "`timeout` should be <= 1d")).limitMs, 24 * 60 * 60_000, "the Pro plan's answer past 24 hours");
  assert.equal(vendorError(api(400, "bad_request", "Invalid request")).limitMs, null, "no cap named");
  assert.equal(vendorError(api(400, "sandbox_timeout_invalid", "Failed to extend timeout: extension would exceed maximum execution timeout")).limitMs, null, "an extend's refusal names none");
  assert.equal(vendorError(api(422, "bad_request", "`timeout` should be <= 45m")).limitMs, null, "only an HTTP 400 bad_request is read");
});

test("open: an unknown vendor is unsupported; missing credentials are named, never echoed", async () => {
  await assert.rejects(openSandbox("nope"), (e) => e.code === "unsupported");
  await assert.rejects(open({ VERCEL_TOKEN: "tok-value" }), (e) => e.code === "auth" && /VERCEL_TEAM_ID, VERCEL_PROJECT_ID/.test(e.message) && !e.message.includes("tok-value"));
});
