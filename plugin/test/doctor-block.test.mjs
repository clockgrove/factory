// A Block from a doctor FAIL (#357): it names each failing check once, the secret by its own name, and as its fix the
// step doctor's row names, then the re-applied label; never a push to the branch or an edit to the issue.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { credentialChecks } from "../scripts/doctor.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { applyExit, blockedLine, doctorBlock } from "../scripts/lib/session.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const SCRIPTS = join(import.meta.dirname, "..", "scripts");
// A stage on GitHub Actions pinned to the account copilot-2, whose secret is not set.
const ENV = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", FACTORY_ACCOUNTS: JSON.stringify({ copilot: ["copilot", "copilot-2"] }), FACTORY_STAGE_ACCOUNT: "copilot-2" };
const failRows = async () => (await credentialChecks({ inputs: { harness: "copilot", credential: "api", repo: "acme/app" }, env: ENV })).filter((c) => c.status === "FAIL");

/** The Blocked comment applyExit posts for `block`, over a fetch fake. */
async function posted(block, pr = null) {
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const real = globalThis.fetch;
  const comments = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === "POST" && /\/issues\/7\/comments$/.test(u.pathname)) comments.push(body.body);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/graphql") return json({ data: {} });
    return json(method === "GET" && /\/comments$/.test(u.pathname) ? [] : {});
  };
  try {
    await applyExit(REPO, { issue: 7, pr, exit: "blocked", ...block, notify: "kirk" }, { token: "t" });
  } finally {
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
  assert.equal(comments.length, 1, "one Blocked notice");
  return comments[0];
}

test("a doctor Block names the failing check once, the account's secret by its name, and the step doctor names as its fix", async () => {
  const rows = await failRows();
  assert.deepEqual(rows.map((c) => c.name), ["copilot credential"]);
  const block = doctorBlock(rows);
  assert.deepEqual([block.cause, block.stage], ["setup", "doctor"], "cause setup, decided by the rows");
  for (const pr of [null, { number: 9, draft: true }]) {
    const body = await posted(block, pr);
    const line = body.split("\n").find((l) => l.includes("Blocked ("));
    assert.equal(line.match(/doctor/g)?.length, 1, `"doctor" once: ${line}`);
    assert.equal(line.match(/copilot credential/g)?.length, 1, `the check once: ${line}`);
    assert.match(line, /^@kirk Blocked \(doctor\): copilot credential: no token for Copilot[.\s]/);
    assert.match(line, /Fix: gh secret set COPILOT_GITHUB_TOKEN_COPILOT_2 to a fine-grained token with only the Copilot Requests permission \(the job's own token can write, so it is never used\); then re-apply `factory:objective`\.$/);
    assert.doesNotMatch(body, /copilot_github_token/, "the secret's name, never the action input's");
    assert.doesNotMatch(body, /Fix by pushing|editing the issue/, "no push or edit fixes a setting");
    assert.match(body, /"cause":"setup"/);
  }
});

test("a doctor Block of several FAILs names each check once and gives each row's step, in order; a row without one points to doctor", () => {
  const block = doctorBlock([
    { name: "sudo", status: "FAIL", detail: "sudo -n fails on this runner", fix: "give the runner's user passwordless sudo." },
    { name: "secrets", status: "FAIL", detail: "missing FACTORY_APP_ID", fix: "add them: gh secret set NAME" },
  ]);
  const line = blockedLine({ issue: 7, ...block }).split("\n")[0];
  assert.equal(line, "Blocked (doctor): sudo: sudo -n fails on this runner; secrets: missing FACTORY_APP_ID. Fix: give the runner's user passwordless sudo; add them: gh secret set NAME; then re-apply `factory:objective`.");
  assert.match(doctorBlock([{ name: "x", status: "FAIL", detail: "y" }]).fix, /^Fix: the step `\/factory:factory-doctor` names; then re-apply `factory:objective`\.$/);
  assert.match(blockedLine({ issue: 7, stage: "lfs", reason: "x", cause: "setup" }), /^Blocked \(lfs\): x\. Fix by pushing to `factory\/7` or editing the issue, then re-apply `factory:objective`\./, "every other Block keeps its fix");
});

test("every doctor Block of the work, review and launch stages is doctorBlock's, on the rows doctor gave", () => {
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(SCRIPTS, file), "utf8");
    assert.doesNotMatch(src, /stage: "doctor"/, `${file}: no doctor Block of its own text`);
    assert.doesNotMatch(src, /reason: agentError/, `${file}: the runner's prerequisites Block as a row`);
    assert.match(src, /doctorBlock\(\[agentError\]\)/, file);
  }
  const launch = readFileSync(join(SCRIPTS, "launch.mjs"), "utf8");
  assert.match(launch, /\{ code: "doctor", rows: failed \}/, "the launcher's failed start carries doctor's rows");
  assert.match(launch, /if \(error\.code === "doctor" && e\.rows\?\.length\) \{\n\s+const d = doctorBlock\(e\.rows\);\n\s+return out\(\{ \.\.\.\(await block\(run, d\.reason, d\.cause, d\.fix\)\), stage \}\);/);
});
