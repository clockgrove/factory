import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError, checkCreateSpec, openSandbox } from "../scripts/lib/adapters/sandbox.mjs";
import { open, userCommand } from "../scripts/lib/adapters/sandbox-vercel.mjs";

const spec = { vcpus: 1, timeoutMs: 60_000, tags: { pendulum: "objective", issue: "12" }, network: { allow: ["registry.npmjs.org", "*.github.com"] } };
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

test("as another user: the sudo command line carries env names, never a value", () => {
  const { cmd, args } = userCommand({ user: "pendulum-agent", home: "/home/pendulum-agent", env: { MODEL_KEY: "sk-secret-value" }, argv: ["node", "x.js"] });
  assert.equal(cmd, "sudo");
  assert.deepEqual(args.slice(0, 4), ["-n", "-u", "pendulum-agent", "--"]);
  assert.ok(args.includes("PATH LANG TERM MODEL_KEY"));
  assert.ok(!args.some((a) => a.includes("sk-secret-value")));
  assert.deepEqual(args.slice(-2), ["node", "x.js"]);
});

test("open: an unknown vendor is unsupported; missing credentials are named, never echoed", async () => {
  await assert.rejects(openSandbox("nope"), (e) => e.code === "unsupported");
  await assert.rejects(open({ VERCEL_TOKEN: "tok-value" }), (e) => e.code === "auth" && /VERCEL_TEAM_ID, VERCEL_PROJECT_ID/.test(e.message) && !e.message.includes("tok-value"));
});
