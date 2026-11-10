#!/usr/bin/env node
/**
 * `node bench/sandbox-conformance.mjs [--vendor vercel] [--image REF] [--json FILE]`: one cloud-sandbox adapter
 * (plugin/scripts/lib/adapters/sandbox.mjs) against its real vendor, every contract operation once.
 *
 * Creates the smallest sandbox, runs commands (streamed output, exit codes, env and cwd, a time limit), makes a second
 * Linux user and checks the uid split Factory relies on (the user runs as its own uid, cannot sudo, cannot read the
 * default user's private file, and sees only the variables its run passed), moves files in and out, checks the network
 * allow-list, stops, resumes and finds the file and the user still there, lists by tag, reads the cost and destroys.
 * Then the image operations: snapshots a sandbox (kept, stopped, tagged with the snapshot, which the project's listing
 * shows ready, and the project's storage counts), creates from it, stops, resumes and stops that one and creates again (the image stays), destroys a
 * sandbox made from it (the image stays), destroys the source and resumes a stopped sandbox made from the image.
 * Whatever it created is destroyed, on failure too. Prints a pass/fail table and never a credential (values are only
 * read from env and handed to the adapter). Needs `npm ci --ignore-scripts` in plugin/ and the vendor's credentials
 * (Vercel: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID). Exit 1 on any failed row, 2 when it could not start.
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ERROR_CODES, OPERATIONS, SandboxError, checkRates, openSandbox, stageVendorCost } from "../plugin/scripts/lib/adapters/sandbox.mjs";

const { values } = parseArgs({ options: { vendor: { type: "string", default: "vercel" }, image: { type: "string" }, json: { type: "string" } } });
// Without --image: the adapter's base image for Node.js 24 (what an image build would start from).
let IMAGE = values.image;
const AGENT = "factory-agent";
const ALLOWED_HOST = "example.com";
const OTHER_HOST = "github.com";
// The whole run's budget: past it, the sandbox is destroyed and the run fails.
const BUDGET_MS = 15 * 60_000;

const rows = [];
const row = (name, ok, detail = "") => {
  rows.push({ name, ok: !!ok, detail: String(detail).replace(/\s+/g, " ").trim().slice(0, 160) });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${rows.at(-1).detail})` : ""}`);
  return !!ok;
};
const failed = (name, e) => row(name, false, e instanceof SandboxError ? `${e.code}: ${e.message}` : e?.message ?? String(e));

let adapter;
try {
  adapter = await openSandbox(values.vendor);
} catch (e) {
  console.error(`cannot open the ${values.vendor} adapter: ${e instanceof SandboxError ? `${e.code}: ${e.message}` : e?.message}`);
  process.exit(2);
}
row("adapter has every operation", OPERATIONS.every((op) => typeof adapter[op] === "function"), `capabilities ${JSON.stringify(adapter.capabilities)}`);
IMAGE ??= adapter.baseImage("24");

const runTag = `conf-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const TAGS = { factory: "conformance", run: runTag };
let id = null;
let destroyed = false;
let snapshotId = null;
const timer = setTimeout(() => {
  failed("whole run within budget", new Error(`over ${BUDGET_MS / 60_000} minutes`));
  finish().finally(() => process.exit(1));
}, BUDGET_MS);

/** Run argv, collecting output; `chunks` counts the stdout callbacks and `firstAt` when the first came. */
const sh = async (argv, opts = {}) => {
  const out = { stdout: "", stderr: "", chunks: 0, firstAt: null };
  const r = await adapter.run(id, {
    argv,
    ...opts,
    onStdout: (s) => {
      out.chunks += 1;
      out.firstAt ??= Date.now();
      out.stdout += s;
    },
    onStderr: (s) => {
      out.stderr += s;
    },
  });
  return { ...r, ...out };
};
const bash = (script, opts) => sh(["bash", "-c", script], opts);

async function main() {
  // Structured errors: an id that does not exist is not_found, by code.
  try {
    await adapter.readFile(`factory-conformance-missing-${randomBytes(4).toString("hex")}`, "/etc/hostname");
    row("missing sandbox is a not_found error", false, "no error");
  } catch (e) {
    row("missing sandbox is a not_found error", e instanceof SandboxError && e.code === "not_found", e instanceof SandboxError ? `code ${e.code}, status ${e.status}` : e?.message);
  }
  try {
    await adapter.create({ vcpus: 0, timeoutMs: 60_000, tags: TAGS, network: "none" });
    row("bad spec is an invalid error", false, "no error");
  } catch (e) {
    row("bad spec is an invalid error", e instanceof SandboxError && e.code === "invalid" && ERROR_CODES.includes(e.code), e?.code);
  }

  // Create: the smallest size, a short timeout, the run's tags, an allow-list of one host.
  const t0 = Date.now();
  const made = await adapter.create({ ...(IMAGE ? { image: IMAGE } : {}), vcpus: 1, timeoutMs: 10 * 60_000, tags: TAGS, network: { allow: [ALLOWED_HOST] } });
  ({ id } = made);
  row("create", typeof id === "string" && id.length > 0, `${id} in ${Date.now() - t0} ms${IMAGE ? ` from ${IMAGE}` : ""}`);
  // The session's end as the vendor set it: within a minute of the 10 minutes asked for (the launcher fits a stage to it).
  const createEnd = Date.parse(made.expiresAt) - t0;
  row("create reports the session's end", Number.isFinite(createEnd) && createEnd >= 9 * 60_000 && createEnd <= 11 * 60_000, made.expiresAt ? `${Math.round(createEnd / 1000)} s after the call for a 600 s timeout` : "no session end reported");
  const acct = await adapter.account().catch((e) => ({ error: e.code || "error" }));
  row("account names the account and its plan", typeof acct.account === "string" && typeof acct.plan === "string", acct.error ? `error ${acct.error}` : `account ${acct.account ?? "?"}, plan ${acct.plan ?? "?"} (${acct.status ?? "?"})`);

  // Run: output streamed as it is written, before the command ends.
  const s = await bash("echo out-1; echo err-1 >&2; sleep 3; echo out-2");
  const ended = Date.now();
  row("run streams stdout and stderr", s.exitCode === 0 && s.stdout === "out-1\nout-2\n" && s.stderr === "err-1\n" && s.chunks >= 2 && s.firstAt !== null && ended - s.firstAt >= 2000, `exit ${s.exitCode}, ${s.chunks} stdout chunks, first ${s.firstAt ? ended - s.firstAt : "-"} ms before the end`);
  const x = await bash("exit 7");
  row("exit code", x.exitCode === 7 && !x.timedOut, `exit ${x.exitCode}`);
  const e = await bash('printf "%s|%s" "$CONF_VAR" "$PWD"', { env: { CONF_VAR: "conf-value" }, cwd: "/tmp" });
  row("env and cwd", e.stdout === "conf-value|/tmp", e.stdout);
  const t = await sh(["sleep", "60"], { timeoutMs: 3000 });
  row("time limit kills the command", t.timedOut && t.durationMs < 30_000, `exit ${t.exitCode}, ${t.durationMs} ms`);

  // The default user is Factory's: it may sudo. Its home holds a file only it may read.
  const me = await bash('printf "%s %s %s" "$(id -un)" "$(id -u)" "$HOME"; sudo -n true && printf " sudo"');
  const [defUser, defUid, defHome, sudo] = me.stdout.split(" ");
  row("default user can sudo (Factory's setup)", me.exitCode === 0 && sudo === "sudo", `${defUser} uid ${defUid} home ${defHome}`);
  const root = await sh(["id", "-u"], { user: "root" });
  row("run as root", root.stdout.trim() === "0", `uid ${root.stdout.trim()}`);
  const secret = randomBytes(16).toString("hex");
  const secretPath = `${defHome}/conformance-private`;
  await adapter.writeFiles(id, [{ path: secretPath, content: secret, mode: 0o600 }]);

  // The second user: the harness's uid.
  const u = await adapter.addUser(id, AGENT);
  const who = await sh(["bash", "-c", 'printf "%s %s %s %s" "$(id -un)" "$(id -u)" "$HOME" "$PWD"']);
  const agentWho = await sh(["bash", "-c", 'printf "%s %s %s %s" "$(id -un)" "$(id -u)" "$HOME" "$PWD"'], { user: AGENT });
  const [aUser, aUid, aHome, aPwd] = agentWho.stdout.split(" ");
  row("second user runs as its own uid", aUser === AGENT && aUid !== defUid && aHome === u.home && aPwd === u.home, `${agentWho.stdout} (default: ${who.stdout})`);
  const aSudo = await sh(["sudo", "-n", "true"], { user: AGENT });
  row("second user cannot sudo", aSudo.exitCode !== 0, `exit ${aSudo.exitCode}`);
  const aRead = await sh(["cat", secretPath], { user: AGENT });
  row("second user cannot read the default user's private file", aRead.exitCode !== 0 && !aRead.stdout.includes(secret), `exit ${aRead.exitCode}`);
  const aEnv = await sh(["env"], { user: AGENT, env: { AGENT_VAR: "agent-value" } });
  const names = aEnv.stdout.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
  const expected = new Set(["AGENT_VAR", "PATH", "LANG", "TERM", "HOME", "USER", "LOGNAME", "PWD", "SHLVL", "_", "OLDPWD"]);
  const extra = names.filter((n) => !expected.has(n));
  row("second user sees only the env its run passed", aEnv.exitCode === 0 && aEnv.stdout.includes("AGENT_VAR=agent-value\n") && extra.length === 0, extra.length ? `unexpected: ${extra.join(", ")}` : `names: ${names.join(", ")}`);

  // Network: the allow-listed host answers, another does not.
  const fetchScript = (host) => `fetch("https://${host}/",{signal:AbortSignal.timeout(15000)}).then(r=>{console.log(r.status)},e=>{console.log("blocked:"+(e.cause?.code??e.name));process.exitCode=3})`;
  const okNet = await sh(["node", "-e", fetchScript(ALLOWED_HOST)]);
  const noNet = await sh(["node", "-e", fetchScript(OTHER_HOST)]);
  row("network allow-list", okNet.exitCode === 0 && noNet.exitCode !== 0, `${ALLOWED_HOST}: ${okNet.stdout.trim() || okNet.stderr.trim()}; ${OTHER_HOST}: ${noNet.stdout.trim() || noNet.stderr.trim()}`);

  // Files in and out.
  const payload = randomBytes(64 * 1024);
  const inPath = `${defHome}/conformance/in.bin`;
  await adapter.writeFiles(id, [{ path: inPath, content: payload }]);
  const sum = await bash(`sha256sum ${inPath} | cut -d' ' -f1 > ${defHome}/conformance/out.txt`);
  const out = await adapter.readFile(id, `${defHome}/conformance/out.txt`);
  const want = createHash("sha256").update(payload).digest("hex");
  row("files in and out", sum.exitCode === 0 && out?.toString().trim() === want, `${payload.length} bytes in, digest ${out?.toString().trim() === want ? "matches" : "differs"}`);
  row("reading a missing file gives null", (await adapter.readFile(id, `${defHome}/conformance/none`)) === null);

  // Stop keeps the files and the user; resume brings them back.
  const marker = randomBytes(8).toString("hex");
  await adapter.writeFiles(id, [{ path: `${defHome}/persist.txt`, content: marker }]);
  const agentMarker = await sh(["bash", "-c", `echo ${marker} > persist.txt`], { user: AGENT });
  const t1 = Date.now();
  await adapter.stop(id);
  const stopMs = Date.now() - t1;
  const stopped = (await adapter.list({ tag: ["run", runTag] })).find((s) => s.id === id);
  row("stop", stopped?.state === "stopped", `state ${stopped?.state ?? "not listed"} after ${stopMs} ms`);
  const t2 = Date.now();
  const resumed1 = await adapter.resume(id);
  const resumeMs = Date.now() - t2;
  const resumeEnd = Date.parse(resumed1?.expiresAt) - t2;
  row("resume reports the new session's end", Number.isFinite(resumeEnd) && resumeEnd > 60_000, resumed1?.expiresAt ? `${Math.round(resumeEnd / 1000)} s after the call (the sandbox was created with 600 s)` : "no session end reported");
  const back = await adapter.readFile(id, `${defHome}/persist.txt`);
  const agentBack = await sh(["cat", "persist.txt"], { user: AGENT });
  row("resume keeps files and the second user", agentMarker.exitCode === 0 && back?.toString() === marker && agentBack.stdout.trim() === marker, `resumed in ${resumeMs} ms; default file ${back?.toString() === marker ? "kept" : "lost"}, ${AGENT} ${agentBack.exitCode === 0 ? "kept" : `exit ${agentBack.exitCode}`}`);

  // Extend moves the running session's end later by what it is given.
  const e1 = await adapter.extend(id, 60_000);
  const e2 = await adapter.extend(id, 60_000);
  const moved = e1.expiresAt && e2.expiresAt ? Date.parse(e2.expiresAt) - Date.parse(e1.expiresAt) : null;
  row("extend", moved !== null && moved >= 55_000 && moved <= 65_000, `the session's end moved ${moved === null ? "an unknown amount" : `${Math.round(moved / 1000)} s`} for a 60 s extension`);

  // List by tag finds this sandbox and only sandboxes with that tag.
  const mine = await adapter.list({ tag: ["run", runTag] });
  const none = await adapter.list({ tag: ["run", `${runTag}-none`] });
  row("list by tag", mine.length === 1 && mine[0].id === id && mine[0].tags.run === runTag && none.length === 0, `${mine.length} with the run tag (${mine[0]?.state}), ${none.length} with another`);

  // Cost: read after a stop, when the vendor has settled the session's totals.
  await adapter.stop(id);
  const use = await adapter.usage(id);
  row("usage and cost", use.wallMs > 0 && typeof use.usd === "number" && use.usd > 0 && use.basis, `${(use.wallMs / 1000).toFixed(1)} s wall, ${use.activeCpuMs ?? "?"} ms CPU, ${use.vcpus} vCPU, ${use.memoryMb} MB, $${use.usd}`);
  console.log(`      cost basis: ${use.basis}`);
  row("stop snapshot's size and the dated rates", Number.isFinite(use.storedBytes) && use.storedBytes > 0 && checkRates(use.rates) && checkRates(adapter.rates), `${use.storedBytes ?? "no"} bytes saved for resume; rates read ${use.rates?.date ?? "?"} from ${use.rates?.source ?? "?"}`);
  // One stage's session: the totals before the resume and after the stop differ by what it ran, priced per stage.
  await adapter.resume(id);
  const burn = await bash("timeout 3 sh -c 'while :; do :; done' || true");
  await adapter.stop(id);
  const after = await adapter.usage(id);
  const stage = stageVendorCost(adapter.rates, { before: use, after });
  row("a session's cost from two readings", burn.exitCode === 0 && !stage.upperBound && stage.activeCpuMs > 0 && stage.wallMs > 0 && stage.usd > 0, `${stage.activeCpuMs} ms CPU in ${stage.wallMs} ms, $${stage.usd} at list rates`);

  await adapter.destroy(id);
  destroyed = true;
  const gone = await adapter.list({ tag: ["run", runTag] });
  let again = "ok";
  await adapter.destroy(id).catch((err) => (again = err?.code ?? "error"));
  row("destroy (twice)", gone.length === 0 && again === "ok", `${gone.length} left with the run tag; second destroy ${again}`);

  // Images: snapshot keeps its source stopped and tagged with the snapshot (the vendor's record); sandboxes made from it
  // (stages) stop, resume and go without touching it; destroying the source is how an image is pruned.
  const small = { vcpus: 1, timeoutMs: 10 * 60_000, tags: TAGS, network: "none" };
  const make = async (spec) => {
    ({ id } = await adapter.create({ ...small, ...spec }));
    destroyed = false;
    return id;
  };
  const src = await make({ image: IMAGE });
  const imgMarker = randomBytes(8).toString("hex");
  await adapter.writeFiles(src, [{ path: `${defHome}/image.txt`, content: imgMarker }]);
  const t3 = Date.now();
  const snap = await adapter.snapshot(src);
  const snapMs = Date.now() - t3;
  const state = async () => (await adapter.snapshots(src)).find((x) => x.snapshot === snap.snapshot)?.state ?? "not listed";
  const listedSrc = (await adapter.list({ tag: ["run", runTag] })).find((x) => x.id === src);
  const first = await state();
  row("snapshot keeps its source, stopped and tagged with it", listedSrc?.state === "stopped" && listedSrc.tags.snapshot === snap.snapshot && first === "ready" && snap.usage?.wallMs > 0, `${snap.snapshot}: ${snap.sizeBytes} bytes, $${snap.usdPerMonth}/month, ${snapMs} ms, source $${snap.usage?.usd}; source ${listedSrc?.state ?? "not listed"}, snapshot ${first}`);
  const stored = await adapter.storage().catch((e) => ({ error: e.code || "error" }));
  row("storage counts the project's snapshots", Number.isInteger(stored.snapshots) && stored.snapshots >= 1 && Number.isFinite(stored.bytes) && stored.bytes >= (snap.sizeBytes ?? 0), stored.error ? `error ${stored.error}` : `${stored.snapshots} snapshot(s), ${stored.bytes} bytes; limit ${stored.limitBytes ?? "not stated by the vendor"}`);
  const t4 = Date.now();
  const a = await make({ snapshot: snap.snapshot });
  const fromA = await bash(`cat ${defHome}/image.txt`);
  row("create from a snapshot", fromA.stdout === imgMarker, `create to first command's end ${Date.now() - t4} ms`);
  // A stage's life: its stops snapshot it (keeping one), it resumes; the image it came from must stay usable.
  await bash(`echo kept > ${defHome}/own.txt`);
  await adapter.stop(a);
  await adapter.resume(a);
  await adapter.stop(a);
  const b = await make({ snapshot: snap.snapshot });
  const fromB = await bash(`cat ${defHome}/image.txt`);
  const afterStops = await state();
  row("a stage's stop, resume and stop leave the image", fromB.stdout === imgMarker && afterStops === "ready", `create from it after: ${fromB.exitCode === 0 ? "ok" : `exit ${fromB.exitCode}`}; snapshot ${afterStops}`);
  await adapter.destroy(b);
  const afterDestroy = await state();
  row("destroying a sandbox made from it leaves the image", afterDestroy === "ready", `snapshot ${afterDestroy}`);
  // Prune: the source goes; a stopped stage made from the image must still resume with its own files.
  await adapter.destroy(src);
  let listed = await state();
  for (const deadline = Date.now() + 60_000; listed === "ready" && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 3000));
    listed = await state();
  }
  let createAfter = "created";
  try {
    const c = await make({ snapshot: snap.snapshot });
    await adapter.destroy(c);
  } catch (e) {
    createAfter = e?.code ?? "error";
  }
  id = a;
  const resumed = await bash(`cat ${defHome}/image.txt ${defHome}/own.txt`);
  row("after its image's source is destroyed, a stopped stage made from it resumes", resumed.stdout === `${imgMarker}kept\n`, `snapshot listed by the source's name after it is gone: ${listed}; create from it: ${createAfter}`);
  await adapter.destroy(a);
  destroyed = true;
  // With its source and every sandbox made from it gone, the snapshot goes too (Vercel deletes it asynchronously): a
  // create from it fails within a minute. That is what pruning an image relies on.
  let snapGone = null;
  for (let tries = 0; tries < 12 && !snapGone; tries += 1) {
    try {
      const c = await make({ snapshot: snap.snapshot });
      await adapter.destroy(c);
      destroyed = true;
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      snapGone = e?.code ?? "error";
    }
  }
  row("destroying the source deletes its snapshot once nothing uses it", snapGone !== null, snapGone ? `create from it then fails: ${snapGone}` : "a create from it still works after a minute");
}

/** Whatever this run made is destroyed: its id, and anything else carrying its run tag (a create that half-failed). */
async function finish() {
  clearTimeout(timer);
  if (snapshotId) await adapter.deleteSnapshot(snapshotId).then(() => console.log(`cleanup: deleted snapshot ${snapshotId}`), (e) => failed(`cleanup deletes snapshot ${snapshotId}`, e));
  if (destroyed) return;
  const ids = new Set(id ? [id] : []);
  for (const s of await adapter.list({ tag: ["run", runTag] }).catch(() => [])) ids.add(s.id);
  for (const i of ids) {
    try {
      await adapter.destroy(i);
      console.log(`cleanup: destroyed ${i}`);
    } catch (e) {
      failed(`cleanup destroys ${i}`, e);
    }
  }
}

try {
  await main();
} catch (e) {
  failed("run completed", e);
} finally {
  await finish();
}

const bad = rows.filter((r) => !r.ok);
console.log(`\n${"result".padEnd(6)}  check`);
for (const r of rows) console.log(`${(r.ok ? "pass" : "FAIL").padEnd(6)}  ${r.name}`);
console.log(`\n${rows.length - bad.length}/${rows.length} passed (${values.vendor}${IMAGE ? `, ${IMAGE}` : ""})`);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ vendor: values.vendor, image: IMAGE ?? null, run: runTag, rows }, null, 2)}\n`);
process.exit(bad.length ? 1 : 0);
