/** Installed refusal evidence only. These ports never activate, retry, close, or cancel an Objective. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authenticatedFaultEvents } from "./verify-local-faults.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import { assertQualificationCheckpoint, nativeProofReader } from "./qualification-sibling-refresh-proof.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const one = (rows, message) => { assert.ok(rows.length === 1, message); return rows[0]; };
const gitOid = (kind, bytes) => createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
const safe = (value) => {
  const bytes = JSON.stringify(value);
  assert.ok(bytes !== undefined && Buffer.byteLength(bytes) <= 4 * 1024 * 1024, "refusal evidence exceeds bound");
  assert.ok(!/\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization\s*:\s*(?:bearer|basic)\s+\S+/i.test(bytes),
    "refusal evidence contains suspected credential material");
  return value;
};
const phases = new Set(["scope", "secret", "symlink"]);
const identityKeys = ["repository", "objective", "workItem", "attempt", "runId", "directorEpoch", "policyDigest", "baseSha"];
const sameAttempt = (left, right) => ["objective", "workItem", "attempt", "runId"].every((key) => left[key] === right[key]);

function policyBoundary(authority) {
  assert.ok(authority.policy.maxAttemptsPerItem === 1, "refusal qualification requires one attempt");
  assert.ok(Array.isArray(authority.policy.allowedPaidBackends) && authority.policy.allowedPaidBackends.length === 0,
    "refusal qualification cannot authorize paid backends");
}
function observedEvents(context, observation) {
  assert.ok(Array.isArray(observation.receipts), "authenticated refusal observation unavailable");
  for (const row of observation.receipts) assert.ok(row.actorId === context.evidence.actor.id &&
    Number.isSafeInteger(row.commentId) && row.event.objective === context.evidence.objective.number,
    "refusal receipt authentication/location differs");
  return deduplicateQualificationReceipts(observation.receipts).map(({ event }) => event);
}
async function noExecution(context) {
  const objective = context.evidence.objective.number;
  const children = await context.list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { issue_number: objective });
  assert.ok(children.length === 0, "pre-compilation refusal unexpectedly has Work Items");
  const comments = await context.list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { issue_number: objective });
  const receipts = authenticatedFaultEvents(comments, context.evidence.actor, objective);
  assert.ok(!receipts.some(({ event }) => ["ActivationRequested", "FactoryRunStarted", "GraphCompiled", "GraphProjected", "AttemptReserved", "AttemptStarted"].includes(event.event)),
    "pre-compilation refusal has execution or activation evidence");
  return { children: [], receipts };
}
function lfsDiagnostic(scenario, diagnostic, fixture) {
  if (scenario === "lfs-missing-tool") return diagnostic ===
    "pinned repository requires git-lfs; install Git LFS on this execution host before starting a model";
  if (scenario !== "lfs-missing-object") return false;
  return fixture.lfs.some(({ oid }) => diagnostic ===
    `required LFS object ${oid} is missing or unsafe in the standard local cache; fetch it with your repository's authorized LFS credentials before starting Factory (custom storage is not resolved automatically)`);
}
async function absentRef(context, ref) {
  try {
    await context.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ref: ref.slice(5) });
  } catch (error) {
    assert.ok(error?.status === 404, "exact transfer ref absence is unavailable (not a 404)");
    return { ref, status: 404, observedAt: new Date().toISOString() };
  }
  assert.fail("refused collection unexpectedly has a reachable transfer ref");
}
async function reservationProof(read, reserved) {
  const ref = `refs/clockgrove-factory/attempts/objective-${reserved.objective}/work-item-${reserved.workItem}/attempt-${reserved.attempt}`;
  const oid = await read({ kind: "ref", ref }), commit = await read({ kind: "commit", oid });
  assert.deepEqual(commit.parentOids, [reserved.baseSha], "reservation source parent differs");
  const trailer = one(commit.message.split(/\r?\n/).filter((line) => line.startsWith("Factory-Event: ")), "reservation event trailer missing or repeated");
  assert.ok(canonical(JSON.parse(Buffer.from(trailer.slice(15), "base64url").toString())) === canonical(reserved),
    "reservation trailer differs from authenticated receipt");
  return { ref, oid, commit };
}
async function packetProof(context, fixture, read, events, reserved, reservation) {
  const graphEvent = one(events.filter((event) => event.runId === reserved.runId && event.event === "GraphCompiled"), "compiled refusal graph missing or repeated");
  const graphRef = `refs/clockgrove-factory/graphs/objective-${reserved.objective}/run-${hash(reserved.runId).slice(0, 32)}`;
  assert.ok(graphEvent.graphRef === graphRef && graphEvent.baseSha === context.evidence.base, "compiled refusal graph identity differs");
  const demand = { kind: "checkpoint", ref: graphRef, path: ".clockgrove-factory/control/compiled-objective.json", maxBytes: 2 * 1024 * 1024 };
  const raw = await read(demand), graph = assertQualificationCheckpoint(raw, demand, [context.evidence.base]);
  assert.ok(raw.blobOid === graphEvent.graphBlobSha && hash(canonical(graph)) === graphEvent.graphDigest && raw.content === canonical(graph),
    "compiled refusal graph content differs");
  assert.ok(Array.isArray(graph.workItems) && graph.workItems.length > 0 && graph.workItems.length <= 3, "refusal graph cardinality unavailable");
  const outside = `${fixture.paths.prefix}/outside-scope.txt`;
  for (const packet of graph.workItems) assert.ok(Array.isArray(packet.scope) && packet.scope.length === 1 && packet.scope[0] === fixture.paths.payload &&
    !packet.scope.some((path) => path.endsWith("/") ? outside.startsWith(path) : outside === path), "compiled scope admits the refusal recipe or outside path");
  assert.ok(reserved.backend === "codex-app-server/local-worktree", "refusal packet proof requires the exact installed App Server backend");
  const attemptId = hash(JSON.stringify(["clockgrove.factory/attempt-v2", context.authority.repository, reserved.runId,
    reserved.objective, reserved.workItem, reserved.attempt, reserved.directorEpoch]));
  const sessionDemand = { kind: "checkpoint", ref: `refs/clockgrove-factory/sessions/${attemptId}/prepared`,
    path: ".clockgrove-factory/control/app-server-session.json", maxBytes: 196608 };
  const prepared = await read(sessionDemand), session = assertQualificationCheckpoint(prepared, sessionDemand, [reservation.oid]);
  const binding = session.binding;
  for (const key of identityKeys) assert.ok(binding[key] === (key === "repository" ? context.authority.repository : reserved[key]), "prepared packet attempt identity differs");
  assert.ok(session.protocol === "clockgrove.factory/app-server-session-v1" && session.stage === "prepared" && binding.attemptId === attemptId && session.packet.baseSha === reserved.baseSha &&
    hash(canonical(session.packet)) === binding.packetDigest && reserved.localScopeBatch?.identity.invocationDigest === binding.packetDigest,
    "prepared packet digest/base/scope differs");
  assert.deepEqual(session.packet.allowedPaths, [fixture.paths.payload], "prepared packet admits unintended paths");
  return { graph: raw, prepared, allowedPaths: session.packet.allowedPaths, outsideScopePath: outside };
}

function treeBytes(entries) {
  assert.ok(entries.length <= 10000 && new Set(entries.map((entry) => entry.path)).size === entries.length, "raw source tree exceeds bound or duplicates paths");
  for (const entry of entries) assert.ok(typeof entry.path === "string" && entry.path.length > 0 && entry.path.length <= 4096 &&
    !/[\0/]/.test(entry.path) && /^[a-f0-9]{40}$/.test(entry.sha) &&
    ["100644", "100755", "120000", "040000", "160000"].includes(entry.mode) &&
    entry.type === (entry.mode === "040000" ? "tree" : entry.mode === "160000" ? "commit" : "blob"), "raw source tree entry differs");
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === "tree" ? "/" : "")), Buffer.from(b.path + (b.type === "tree" ? "/" : ""))));
  const bytes = Buffer.concat(sorted.flatMap((entry) => [Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`), Buffer.from(entry.sha, "hex")]));
  assert.ok(bytes.length <= 2 * 1024 * 1024, "raw source tree byte bound exceeded");
  return bytes;
}
async function symlinkRetention(context, fixture, read, identity, ref, events, reserved) {
  const raw = {};
  const load = async (stage, parents) => {
    const demand = { kind: "checkpoint", ref: `${ref}/${stage}`, path: "artifact-transfer.json", maxBytes: 1048576 };
    raw[stage] = await read(demand);
    const descriptor = assertQualificationCheckpoint(raw[stage], demand, parents);
    assert.ok(descriptor.protocol === "clockgrove.factory/artifact-transfer-v1" && descriptor.retention === "repository-audit" &&
      canonical(descriptor.identity) === canonical(identity) && Array.isArray(descriptor.chunks) && descriptor.chunks.length === 0,
      "symlink transfer identity/chunks differ");
    const message = `Factory artifact transfer ${stage}\n\nFactory-Artifact: ${descriptor.artifact.digest}\nFactory-Descriptor: ${hash(raw[stage].content)}\nFactory-Retention: repository-audit`;
    assert.ok(raw[stage].commit.message.trim() === message, "symlink transfer lifecycle binding differs");
    return descriptor;
  };
  const intent = await load("intent", []), ready = await load("ready", [raw.intent.commit.oid]);
  assert.ok(canonical(intent) === canonical(ready), "symlink ready changed the retained intent");
  const artifact = ready.artifact, target = "../lfs/canonical.bin", path = fixture.paths.payload;
  assert.ok(artifact.baseSha === identity.baseSha && artifact.outcome === "succeeded" && artifact.payload === undefined &&
    Array.isArray(artifact.changedPaths) && artifact.changedPaths.length === 1 && artifact.changedPaths[0] === path &&
    typeof artifact.patch === "string" && Buffer.byteLength(artifact.patch) <= 4096, "symlink artifact is not the bounded original inline output");
  const blobOid = gitOid("blob", Buffer.from(target)), lines = artifact.patch.split("\n");
  assert.ok(lines.length === 9 && lines[0] === `diff --git a/${path} b/${path}` && lines[1] === "new file mode 120000" &&
    /^index 0{7,40}\.\.[a-f0-9]{7,40}$/.test(lines[2]) && blobOid.startsWith(lines[2].split("..")[1]) &&
    lines[3] === "--- /dev/null" && lines[4] === `+++ b/${path}` && lines[5] === "@@ -0,0 +1 @@" &&
    lines[6] === `+${target}` && lines[7] === "\\ No newline at end of file" && lines[8] === "",
    "symlink patch does not contain only the exact raw target bytes");
  const manifest = artifact.fileManifest;
  assert.ok(manifest?.version === 1 && Array.isArray(manifest.files) && manifest.files.length === 1, "symlink file manifest missing");
  const file = manifest.files[0];
  const expectedFile = { path, action: "write", mode: "120000", bytes: Buffer.byteLength(target), digest: hash(target), mediaType: "unknown", generated: true };
  assert.ok(canonical(file) === canonical(expectedFile), "symlink manifest misrepresents raw target bytes/mode");
  const base = await read({ kind: "commit", oid: identity.baseSha }), trees = [];
  assert.ok(base.treeOid === manifest.baseTreeSha, "symlink base tree differs from original source");
  const parts = path.split("/"); assert.ok(parts.length <= 8, "symlink fixture path exceeds bound");
  const graft = async (treeOid, index) => {
    let entries = [];
    if (treeOid) {
      const { data } = await context.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { tree_sha: treeOid });
      assert.ok(data.sha === treeOid && data.truncated === false && Array.isArray(data.tree), "symlink source tree read incomplete");
      entries = data.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
      assert.ok(gitOid("tree", treeBytes(entries)) === treeOid, "symlink source tree bytes differ from Git identity");
      trees.push({ sha: treeOid, entries });
    }
    const name = parts[index], prior = entries.find((entry) => entry.path === name);
    if (index === parts.length - 1) {
      assert.ok(!prior, "symlink recipe must create a new path, not replace source content");
      return gitOid("tree", treeBytes([...entries, { path: name, mode: "120000", type: "blob", sha: blobOid }]));
    }
    assert.ok(!prior || (prior.mode === "040000" && prior.type === "tree"), "symlink parent path is not a raw tree");
    const child = await graft(prior?.sha, index + 1);
    return gitOid("tree", treeBytes([...entries.filter((entry) => entry.path !== name), { path: name, mode: "040000", type: "tree", sha: child }]));
  };
  const resultTreeSha = await graft(base.treeOid, 0);
  assert.ok(resultTreeSha === manifest.resultTreeSha, "symlink manifest result tree differs from exact object-only transformation");
  const orderedManifest = { version: 1, baseTreeSha: manifest.baseTreeSha, resultTreeSha, files: [expectedFile] };
  const digest = createHash("sha256").update(identity.baseSha).update("\0").update(path).update("\0").update(artifact.patch)
    .update("\0content-v1\0").update(JSON.stringify({ fileManifest: orderedManifest })).digest("hex");
  assert.ok(digest === artifact.digest, "symlink artifact content digest differs");
  const succeeded = one(events.filter((event) => event.event === "AttemptSucceeded" && sameAttempt(event, reserved)), "symlink raw artifact success receipt missing");
  const failed = one(events.filter((event) => event.event === "AttemptFailed" && sameAttempt(event, reserved)), "symlink guard failure missing");
  assert.ok(succeeded.artifactDigest === digest && succeeded.sequence > reserved.sequence && succeeded.sequence < failed.sequence &&
    succeeded.baseSha === reserved.baseSha && succeeded.backend === reserved.backend &&
    succeeded.directorEpoch === reserved.directorEpoch && succeeded.policyDigest === reserved.policyDigest,
    "symlink success receipt does not bind retained raw output");
  return { ...raw, base, trees, rawTarget: target, rawTargetBlobOid: blobOid, artifactDigest: digest, resultTreeSha,
    mode: "120000", mediaType: "unknown", materialized: false };
}

export function createLargeFileRefusalPorts(context, fixture) {
  const { authority, evidence } = context, scenario = authority.largeFile.scenario;
  assert.ok(fixture.namespace === authority.namespace && evidence.base === fixture.baseSha,
    "refusal fixture differs from exact qualification namespace/base");
  const save = async () => { safe(evidence.largeFileRefusal); await context.save(); };
  return {
    async compileRefusal() {
      policyBoundary(authority);
      assert.ok(["lfs-missing-tool", "lfs-missing-object"].includes(scenario), "scenario is not a compilation refusal");
      assert.ok(!evidence.largeFileRefusal, "refusal action was already attempted; do not replay uncertain calls");
      const before = await noExecution(context);
      const args = { objectiveNumber: evidence.objective.number, repository: authority.checkout,
        compile: true, baseSha: evidence.base, policy: authority.policy };
      evidence.largeFileRefusal = { protocol: "clockgrove.factory/large-file-refusal-v1", scenario,
        action: { name: "factory_plan", arguments: args, attemptedAt: new Date().toISOString() }, before };
      await save(); // Durable local action intent precedes the sole installed invocation.
      let response;
      try { response = await context.invoke("factory_plan", args); }
      catch { evidence.largeFileRefusal.transport = "unavailable-response; no automatic retry"; await save(); throw Error("installed compilation refusal response unavailable; no retry authorized"); }
      safe(response);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 65536, "installed refusal response exceeds bound");
      evidence.largeFileRefusal.response = response;
      evidence.largeFileRefusal.respondedAt = new Date().toISOString();
      await save();
      assert.ok(Array.isArray(response.content) && response.content.length > 0 && response.content.every((part) => part.type === "text" && typeof part.text === "string"),
        "installed compilation refusal did not return bounded text");
      const text = response.content.map((part) => part.text).join("\n");
      let diagnostic;
      if (response.isError === true) diagnostic = text;
      else {
        let report; try { report = JSON.parse(text); } catch { throw Error("installed plan report is not JSON"); }
        assert.ok(report.operation === "plan" && report.repository === authority.repository && report.objective?.number === evidence.objective.number &&
          report.activationAuthorized === false && report.mode === "compilation" && report.compilation?.requested === true &&
          report.compilation.result === "failed" && report.compilation.usagePersistence === "none" &&
          report.graph === null && report.proposedGraph === undefined && report.usage === null,
          "installed plan did not refuse before returning a compiled graph or usage");
        diagnostic = one(report.diagnostics.filter((entry) => entry.status === "fail"), "one exact LFS refusal diagnostic required").summary;
      }
      assert.ok(lfsDiagnostic(scenario, diagnostic, fixture), "installed plan refused at a different boundary");
      const after = await noExecution(context);
      const result = { scenario, refused: true, boundary: "pinned-lfs-pre-compilation", diagnostic,
        executionGraph: "not-created", modelCalls: null, modelCallEvidence: "unavailable; exact installed guard diagnostic and source ordering only",
        uploadCount: null, uploadEvidence: "unavailable; no content-write instrumentation", durableControlWrites: "not-prohibited", after };
      evidence.largeFileRefusal.result = result; await save(); return result;
    },
    async artifactRefusal(observation) {
      policyBoundary(authority);
      assert.ok(phases.has(scenario), "scenario is not an artifact refusal");
      assert.ok(!evidence.largeFileRefusal, "refusal observation already recorded");
      const events = observedEvents(context, observation), runId = observation.status?.run?.runId;
      assert.ok(typeof runId === "string" && runId.length > 0, "refusal run identity unavailable");
      const run = events.filter((event) => event.runId === runId);
      for (const name of ["FactoryRunStarted", "AttemptReserved", "AttemptStarted"])
        assert.ok(events.filter((event) => event.event === name).length === 1, "refusal Objective has another execution identity");
      const start = one(run.filter((event) => event.event === "FactoryRunStarted"), "one original run start required");
      assert.ok(start.activationRequestId === `${authority.namespace}-activate` && start.policyDigest === hash(canonical(authority.policy)) &&
        start.repository?.toLowerCase() === authority.repository && canonical(start.policy) === canonical(authority.policy), "refusal activation/policy differs");
      const reserved = one(run.filter((event) => event.event === "AttemptReserved"), "one actual refusal attempt required");
      const started = one(run.filter((event) => event.event === "AttemptStarted"), "one actual worker start required");
      assert.ok(reserved.attempt === 1 && sameAttempt(reserved, started) && reserved.baseSha === evidence.base &&
        reserved.policyDigest === start.policyDigest && ["baseSha", "backend", "policyDigest", "directorEpoch"].every((key) => reserved[key] === started[key]),
        "refusal attempt identity or original base differs");
      assert.ok(!events.some((event) => ["PublicationRecorded", "AttemptPublished", "AttemptIntegrated", "AttemptValidated", "FactoryRunCompleted"].includes(event.event)), "refused artifact reached acceptance/publication");
      one(run.filter((event) => event.event === "FactoryRunEscalated"), "expected refusal run escalation is unavailable");
      const failed = one(run.filter((event) => event.event === "AttemptFailed" && sameAttempt(event, reserved)), "one exact failed artifact attempt required");
      assert.ok(failed.sequence > started.sequence && typeof failed.reason === "string" && failed.reason.length <= 8000 &&
        ["baseSha", "backend", "policyDigest", "directorEpoch"].every((key) => failed[key] === reserved[key]), "failed refusal receipt unavailable");
      const expected = scenario === "scope" ? `artifact changes paths outside scope: ${fixture.paths.prefix}/outside-scope.txt` :
        scenario === "secret" ? "artifact content contains suspected credential bytes" :
          "symlink artifacts support Git-object-only operations, not filesystem materialization";
      assert.ok(failed.reason === expected, "worker failed at a different artifact boundary");
      assert.ok(!run.some((event) => event.event === "ValidationRecorded"), "refusal unexpectedly has validation command completion evidence");
      const read = nativeProofReader(context.request), reservation = await reservationProof(read, reserved);
      const packet = await packetProof(context, fixture, read, run, reserved, reservation);
      const identity = Object.fromEntries(identityKeys.map((key) => [key, key === "repository" ? authority.repository : reserved[key]]));
      const ref = `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`;
      const transfer = scenario === "symlink" ? await symlinkRetention(context, fixture, read, identity, ref, run, reserved) : {
        intent: await absentRef(context, `${ref}/intent`), ready: await absentRef(context, `${ref}/ready`),
      };
      assert.ok(await read({ kind: "ref", ref: reservation.ref }) === reservation.oid,
        "original readable reservation authority changed during refusal observations");
      const result = { scenario, refused: true, boundary: scenario === "symlink" ? "filesystem-materialization" : "collection-before-retained-transfer",
        runId, workItem: reserved.workItem, attempt: 1, reason: expected, reservation, packet, transfer,
        publication: "no authenticated publication/integration receipts", modelCalls: null,
        modelCallEvidence: "unavailable; original worker receipts retained, no inferred count",
        uploadCount: null, uploadEvidence: scenario === "symlink" ? "exact raw Git-object retention observed; not a filesystem execution grant" :
          "exact intent/ready refs absent; unreferenced blob writes are not observable",
        validationCommandEvidence: "exact pre-command guard diagnostic; no ValidationRecorded (not a separate process trace)",
        durableControlWrites: "permitted" };
      evidence.largeFileRefusal = { protocol: "clockgrove.factory/large-file-refusal-v1", scenario, result };
      await save(); return result;
    },
  };
}
