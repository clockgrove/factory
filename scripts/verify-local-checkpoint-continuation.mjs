/** Continue only an already held, paused installed App Server qualification. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main as checkpointMain,
  appServerHoldReady,
  continueAppServerCheckpointScenario,
  checkpointObservationFailure,
} from "./verify-local-checkpoint-restart.mjs";
import { nativeProofReader, assertQualificationCheckpoint } from "./qualification-sibling-refresh-proof.mjs";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";
import { isQuiescentFaultObjective } from "./verify-local-faults.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const one = (values) => { assert.equal(values.length, 1, "unique original identity required"); return values[0]; };
const boundedPath = (path) => {
  assert.match(path ?? "", /^\/[A-Za-z0-9_./-]+$/);
  assert.equal(resolve(path), path);
  return path;
};
export function readContinuationInput(path, digest, maximum = 8 * 1024 * 1024) {
  boundedPath(path);
  assert.match(digest ?? "", /^[a-f0-9]{64}$/);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1);
    assert.equal(stat.mode & 0o077, 0);
    assert.ok(stat.size > 0 && stat.size <= maximum);
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0, count;
    while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += count;
      assert.ok(size <= maximum);
    }
    const bytes = buffer.subarray(0, size);
    assert.equal(hash(bytes), digest, "pinned continuation input changed");
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

export function assertContinuationSeed(original, witness, pause, installed, now = Date.now()) {
  assert.equal(original.protocol, "clockgrove.factory/checkpoint-restart-qualification-v1");
  assert.equal(original.result.result, "incomplete");
  assert.equal(original.authority.sessionRecovery, true);
  assert.equal(original.authority.phase, "exercise");
  assert.deepEqual(original.artifact, installed, "installed runtime differs from original work");
  assert.match(original.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(original.harnessFiles) && original.harnessFiles.length <= 20);
  assert.deepEqual(original.actions.map((entry) => entry.action), ["start", "create", "activate"],
    "only pre-pause observer failure can continue; uncertain mutations cannot replay");
  for (const action of original.actions) {
    assert.ok(Number.isFinite(Date.parse(action.returnedAt)));
    assert.ok(Date.parse(action.returnedAt) >= Date.parse(action.requestedAt));
    assert.ok(action.response);
  }
  const startAction = original.actions[0].response;
  assert.equal(startAction.accepted, true);
  assert.equal(startAction.unit, original.authority.unit);
  assert.equal(startAction.repository, original.authority.repository);
  assert.equal(original.actions[1].response.number, original.objective.number);
  assert.equal(original.actions[1].response.node_id, original.objective.node_id);
  assert.equal(original.actions[1].response.user.id, original.actor.id);
  assert.equal(hash(original.actions[1].response.body), original.objectiveBodyDigest);
  const activation = original.actions[2].response;
  assert.equal(activation.event, "ActivationRequested");
  assert.equal(activation.requestId, `${original.authority.namespace}-activate`);
  assert.equal(activation.objective, original.objective.number);
  assert.equal(activation.repository, original.authority.repository);
  assert.equal(activation.baseSha, original.base);
  assert.deepEqual(activation.policy, original.authority.policy);
  assert.equal(activation.requestedBy.toLowerCase(), original.actor.login.toLowerCase());
  const [owner, repo] = original.authority.repository.split("/");
  assert.deepEqual(original.runRequest, {tool:"factory_activate", arguments:{ owner, repo,
    objectiveNumber:original.objective.number, requestId:activation.requestId,
    baseSha:original.base, policy:original.authority.policy }});
  assert.equal(original.authority.policy.economics.modelTokenBudgetMode, "observed-stop");
  assert.equal(original.authority.policy.objectiveTimeoutMinutes, 45);
  assert.deepEqual(original.authority.policy.allowedPaidBackends, []);
  const deadline = Date.parse(original.startedAt) + 2700000;
  assert.ok(Number.isFinite(deadline) && now < deadline, "original qualification deadline expired");
  const arm = original.sessionArm;
  assert.equal(hash(JSON.stringify(arm.arm)), arm.digest);
  assert.ok(arm.writtenAt);
  assert.equal(witness.protocol, "clockgrove.factory/app-server-checkpoint-reached-v1");
  assert.equal(witness.armDigest, arm.digest);
  for (const key of ["repository", "objective", "activationRequestId", "policyDigest", "expiresAt"])
    assert.equal(witness[key], arm.arm[key]);
  assert.equal(witness.baseSha, original.base);
  assert.equal(witness.policyDigest, activation.policyDigest);
  assert.ok(Date.parse(witness.reachedAt) >= Date.parse(arm.writtenAt));
  assert.ok(Date.parse(witness.reachedAt) < Date.parse(witness.expiresAt), "historical hold was not timely");
  assert.equal(pause.event, "RunPauseRequested");
  assert.equal(pause.runId, witness.runId);
  assert.equal(pause.objective, witness.objective);
  assert.equal(pause.requestedBy.toLowerCase(), original.actor.login.toLowerCase());
  assert.match(pause.requestId, /^[A-Za-z0-9._:-]{1,160}$/);
  const controller = one(original.controllerReadiness.filter((entry) => entry.identity).map((entry) => entry.identity));
  for (const [field, key] of [["unit", "unit"], ["invocationId", "invocationId"], ["pid", "producerPid"],
    ["startTicks", "producerStartTicks"], ["hostIdentity", "hostIdentity"]])
    assert.equal(controller[field], arm.arm[key]);
  assert.equal(controller.configDigest, original.configDigest);
  return { controller, deadline, runId: witness.runId, pauseRequestId: pause.requestId };
}

export function continuationEvidencePath(original, originalPath, outputPath) {
  assert.equal(boundedPath(originalPath), original.authority.evidence);
  assert.equal(boundedPath(outputPath), `${original.authority.evidence}.continuation.json`,
    "one exclusive output identity fences uncertain continuation actions");
  return outputPath;
}

/** A failed read can be retried only through its immutable, no-action evidence chain. */
export function assertContinuationRetry(previous, input, now = Date.now()) {
  const {original,witness,pause,originalSha256,witnessSha256,pauseSha256,previousPath,previousSha256}=input;
  const seed=assertContinuationSeed(original,witness,pause,original.artifact,now);
  assert.match(previousSha256 ?? "",/^[a-f0-9]{64}$/);
  boundedPath(previousPath);
  assert.equal(previous.protocol,"clockgrove.factory/checkpoint-restart-qualification-v1");
  assert.equal(previous.result?.result,"incomplete","only an evidenced refusal may retry");
  assert.deepEqual(previous.actions,[],"any attempted or uncertain lifecycle action blocks retry");
  assert.equal(previous.authority.evidence,previousPath);
  const priorAuthority={...previous.authority},originalAuthority={...original.authority};
  delete priorAuthority.evidence; delete originalAuthority.evidence;
  assert.deepEqual(priorAuthority,originalAuthority);
  assert.deepEqual(previous.artifact,original.artifact);
  for(const key of ["actor","base","objective","objectiveBodyDigest","configDigest","runRequest","sessionArm","startedAt"])
    assert.deepEqual(previous[key],original[key],"prior continuation seed differs");
  assert.match(previous.sourceCommit,/^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(previous.harnessFiles) && previous.harnessFiles.length<=20);
  one(previous.harnessFiles.filter((file)=>file.path==="scripts/verify-local-checkpoint-continuation.mjs"));
  const prior=previous.continuation;
  assert.equal(prior.originalSha256,originalSha256);
  assert.equal(prior.witnessSha256,witnessSha256);
  assert.equal(prior.pauseSha256,pauseSha256);
  assert.equal(prior.originalSourceCommit,original.sourceCommit);
  assert.equal(prior.runId,seed.runId);
  assert.equal(prior.deadline,new Date(seed.deadline).toISOString());
  const base=`${original.authority.evidence}.continuation.json`;
  const depth=prior.retry?.depth ?? 0;
  assert.ok(Number.isSafeInteger(depth) && depth>=0 && depth<3,"bounded read-only retry chain exhausted");
  if(depth===0) {
    assert.equal(prior.retry,undefined);
    assert.equal(previousPath,base);
  } else {
    assert.match(prior.retry.previousSha256,/^[a-f0-9]{64}$/);
    assert.equal(previousPath,`${base}.retry-${prior.retry.previousSha256}.json`);
  }
  return {outputPath:`${base}.retry-${previousSha256}.json`,retry:{previousPath,previousSha256,depth:depth+1}};
}

const diagnosticStages = new Set(["seed", "runner-seed", "original-harness", "deadline", "actor", "repository", "objective", "checkout-clean", "checkout-origin", "checkout-base", "remote-base", "open-pulls", "other-objectives", "controller-properties", "controller-fragment", "controller-config", "controller-process", "controller-stopped", "fresh-observation", "graph-proof", "session-proof", "scope-absence"]);
export async function continuationStage(stage, operation, record) {
  assert.ok(diagnosticStages.has(stage));
  record({ stage, state:"reading", at:new Date().toISOString() });
  try {
    const result = await operation();
    record({ stage, state:"verified", at:new Date().toISOString() });
    return result;
  } catch (error) {
    record({ ...checkpointObservationFailure(error, {phase:"continuation",stage:"extension"}), stage, state:"refused" });
    throw error;
  }
}

/** Exact production preflight, also callable by the observation-only entry point. */
export async function continuationPreflight(context, original, stopped, stage, bounded) {
  const {authority, command, request, list, call} = context;
  await stage("deadline", bounded);
  await stage("actor", async()=>{
    const actor=(await request("GET /user")).data;
    assert.equal(actor.id,original.actor.id); assert.equal(actor.login,original.actor.login);
  });
  const repository=await stage("repository",async()=>{
    const value=(await request("GET /repos/{owner}/{repo}")).data;
    assert.ok(value.private && !value.archived && value.permissions?.push); return value;
  });
  await stage("objective",async()=>{
    const issue=(await request("GET /repos/{owner}/{repo}/issues/{issue_number}",{issue_number:original.objective.number})).data;
    assert.equal(issue.node_id,original.objective.node_id); assert.equal(issue.id,original.objective.id);
    assert.equal(issue.user.id,original.actor.id); assert.equal(hash(issue.body),original.objectiveBodyDigest);
  });
  await stage("checkout-clean",()=>assert.equal(command("git",["status","--porcelain"],authority.checkout),""));
  await stage("checkout-origin",()=>{
    const origin=command("git",["remote","get-url","origin"],authority.checkout).replace(/\.git$/,"");
    assert.ok([`https://github.com/${authority.repository}`,`git@github.com:${authority.repository}`].includes(origin));
  });
  await stage("checkout-base",()=>assert.equal(command("git",["rev-parse","HEAD"],authority.checkout),original.base));
  await stage("remote-base",async()=>assert.equal((await request("GET /repos/{owner}/{repo}/commits/{ref}",{ref:repository.default_branch})).data.sha,original.base));
  await stage("open-pulls",async()=>assert.equal((await list("GET /repos/{owner}/{repo}/pulls",{state:"open"})).length,0));
  await stage("other-objectives",async()=>{
    for(const issue of await list("GET /repos/{owner}/{repo}/issues",{state:"open"}))
      if(issue.number!==original.objective.number && issue.labels?.some((label)=>label.name==="factory:objective"))
        assert.ok(isQuiescentFaultObjective(await call("factory_status",{objectiveNumber:issue.number}),authority.repository,issue.number),"another Objective has runnable authority");
  });
  await stopped();
}

export function assertContinuationObservation(observation, original, witness, pause, now = Date.now()) {
  const binding = assertContinuationSeed(original, witness, pause, original.artifact, now);
  const events = observation.receipts.map(({ event }) => event);
  if (observation.checkpointReached) assert.deepEqual(observation.checkpointReached, witness);
  const start = one(events.filter((event) => event.event === "FactoryRunStarted"));
  assert.equal(start.runId, binding.runId);
  assert.equal(start.actor.toLowerCase(), original.actor.login.toLowerCase());
  assert.equal(start.baseSha, original.base);
  assert.equal(start.objective, original.objective.number);
  assert.equal(start.policyDigest, witness.policyDigest);
  assert.deepEqual(one(events.filter((event) => event.event === "ActivationRequested")), original.actions[2].response);
  assert.deepEqual(one(events.filter((event) => event.event === "RunPauseRequested")), pause);
  assert.ok(events.every((event) => event.runId === binding.runId || event.event === "ActivationRequested"));
  assert.equal(observation.status.run.state, "paused");
  assert.equal(observation.status.run.runId, binding.runId);
  assert.ok(!events.some((event) => ["RunResumeRequested", "RunDrainRequested", "FactoryRunCancellationRequested", "RecoveryRequested"].includes(event.event)));
  assert.ok(appServerHoldReady({ ...observation, checkpointReached: witness }, original.authority,
    original.sessionArm, pause.requestId));
  for (const { event } of original.latest?.receipts ?? [])
    assert.ok(events.some((fresh) => canonical(fresh) === canonical(event)), "original receipt disappeared");
  const model = qualificationModelAccounting(events, { requireMarkers: true });
  assert.equal(model.unresolved.length, 0, "unknown model invocation prevents continuation");
  assert.equal(model.usage.length, 2, "only original compiler and one worker may have consumed tokens");
  assert.ok(model.total < original.authority.policy.economics.maxModelTokens);
  assert.equal(observation.status.summary.economics.unresolvedModelInvocations, 0);
  assert.equal(observation.status.summary.economics.usage.model_tokens.value, model.total);
  return { ...binding, modelTokens: model.total };
}

export function assertStoppedContinuationController(fields, original, configDigest, absent) {
  assert.equal(fields.Id, original.unit);
  assert.equal(fields.LoadState, "loaded");
  assert.ok(["inactive", "failed"].includes(fields.ActiveState));
  assert.ok(["dead", "failed"].includes(fields.SubState));
  assert.equal(fields.MainPID, "0");
  assert.ok(["", "0", "0 /"].includes(fields.Job));
  assert.equal(fields.ControlGroup, "");
  assert.equal(fields.InvocationID, original.invocationId);
  assert.equal(fields.ExecMainPID, String(original.pid));
  assert.equal(fields.KillMode, "control-group");
  assert.equal(fields.DropInPaths, "");
  assert.equal(fields.NeedDaemonReload, "no");
  assert.equal(configDigest, original.configDigest);
  assert.equal(absent, true, "original controller process absence unproved");
  return { ...fields, originalProcessAbsent: true, observedAt: new Date().toISOString() };
}

async function observeGraph(context, observation) {
  const { request, list, evidence } = context;
  const events = observation.receipts.map(({ event }) => event), read = nativeProofReader(request);
  const compiled = one(events.filter((event) => event.event === "GraphCompiled"));
  const projected = one(events.filter((event) => event.event === "GraphProjected"));
  const suffix = `objective-${evidence.objective.number}/run-${hash(observation.status.run.runId).slice(0, 32)}`;
  assert.equal(compiled.graphRef, `refs/clockgrove-factory/graphs/${suffix}`);
  assert.equal(compiled.baseSha, evidence.base);
  const graphRequest = { kind: "checkpoint", ref: compiled.graphRef, path: ".clockgrove-factory/control/compiled-objective.json", maxBytes: 2097152 };
  const graphProof = await read(graphRequest);
  const graph = assertQualificationCheckpoint(graphProof, graphRequest, evidence.base);
  assert.equal(graphProof.blobOid, compiled.graphBlobSha);
  assert.equal(hash(canonical(graph)), compiled.graphDigest);
  assert.equal(graphProof.content, canonical(graph));
  assert.equal(graph.workItems.length, 3);
  assert.equal(projected.projectionRef, `refs/clockgrove-factory/graph-projections/${suffix}`);
  assert.equal(projected.graphDigest, compiled.graphDigest);
  assert.equal(projected.graphSize, 3);
  const projectionRequest = { kind: "checkpoint", ref: projected.projectionRef, path: ".clockgrove-factory/control/graph-projection.json", maxBytes: 2097152 };
  const projectionProof = await read(projectionRequest);
  const projection = assertQualificationCheckpoint(projectionProof, projectionRequest, graphProof.commit.oid);
  assert.equal(projectionProof.blobOid, projected.projectionBlobSha);
  assert.equal(projection.graphDigest, compiled.graphDigest);
  assert.equal(projection.protocol, "clockgrove.factory/graph-projection-v1");
  assert.equal(projection.bindings.length, 3);
  const children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { issue_number: evidence.objective.number });
  assert.equal(children.length, 3);
  assert.equal(new Set(projection.bindings.map((binding) => binding.issueNumber)).size, 3);
  assert.equal(new Set(projection.bindings.map((binding) => binding.issueNodeId)).size, 3);
  for (const [index, binding] of projection.bindings.entries()) {
    const packet = graph.workItems[index];
    assert.equal(binding.compilerId, packet.id);
    const child = one(children.filter((entry) => entry.number === binding.issueNumber));
    assert.equal(child.node_id, binding.issueNodeId);
    assert.equal(child.title, packet.title);
    assert.ok(typeof child.body === "string" && Buffer.byteLength(child.body) <= 262144);
    const metadata = one([...child.body.matchAll(/<!--\s*clockgrove-factory:graph-item\s+([A-Za-z0-9_-]+)\s*-->/g)]);
    assert.deepEqual(JSON.parse(Buffer.from(metadata[1], "base64url").toString("utf8")), {
      protocol:"clockgrove.factory/graph-v1", id:packet.id, graphDigest:compiled.graphDigest,
      graphSize:3, index, dependsOn:packet.dependsOn,
    });
    const dependencies = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", { issue_number: child.number });
    assert.deepEqual(dependencies.map((entry) => entry.number).sort((a,b) => a-b),
      packet.dependsOn.map((id) => one(projection.bindings.filter((entry) => entry.compilerId === id)).issueNumber).sort((a,b) => a-b));
  }
  return { graphProof, projectionProof, children };
}

export async function runCheckpointContinuation(port, authority, input) {
  const { original, witness, pause } = input;
  const stage = port.stage ?? ((_name, operation) => operation());
  const seed = await stage("runner-seed",()=>assertContinuationSeed(original, witness, pause, input.artifact));
  await port.preflight();
  const observed = await stage("fresh-observation",()=>port.observe());
  const facts = await stage("fresh-observation",()=>assertContinuationObservation(observed, original, witness, pause));
  const held = { ...observed, checkpointReached: witness };
  const graph = await stage("graph-proof",()=>port.graphProof(held));
  const sessionProofs = await stage("session-proof",()=>port.sessionProof(held, witness));
  assert.equal(sessionProofs.length, 1);
  const scopes = await stage("scope-absence",()=>port.absence(held, [seed.controller], true));
  await port.stopped();
  const originalEvents = held.receipts.map(({event}) => event).filter((event) => ["attempt", "budget", "graph"].includes(event.kind));
  await port.checkpoint({ checkpoint: held, facts: { ...facts, stable: originalEvents }, original: seed.controller, scopes, sessionProofs, graph });
  if (input.diagnosticsOnly) return { result:"diagnostic-only", scope:"read-only-continuation-preconditions", lifecycleActionsAttempted:false };
  return continueAppServerCheckpointScenario(port, authority, {
    held, original: seed.controller, sessionProofs, scopes, originalEvents, restartAction: "start",
  });
}

export async function main(env = process.env) {
  if (env.FACTORY_LOCAL_CHECKPOINT_CONTINUATION !== "1") return;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"])
    assert.equal(env[key], undefined, "default Linux-home authentication required");
  const original = readContinuationInput(env.FACTORY_CHECKPOINT_ORIGINAL, env.FACTORY_CHECKPOINT_ORIGINAL_SHA256);
  const witness = readContinuationInput(env.FACTORY_CHECKPOINT_WITNESS, env.FACTORY_CHECKPOINT_WITNESS_SHA256, 16384);
  const pause = readContinuationInput(env.FACTORY_CHECKPOINT_PAUSE, env.FACTORY_CHECKPOINT_PAUSE_SHA256, 16384);
  const diagnosticsOnly = env.FACTORY_CHECKPOINT_DIAGNOSTICS_ONLY === "1";
  assert.equal(env.FACTORY_CHECKPOINT_CONTINUATION_ACK,
    `${original.authority.repository}:${witness.runId}:start-original-run,resume,stop`);
  let output, retry;
  const priorRecords=[];
  if (diagnosticsOnly) {
    assert.equal(env.FACTORY_CHECKPOINT_ORIGINAL, original.authority.evidence);
    output=boundedPath(env.FACTORY_CHECKPOINT_EVIDENCE);
    assert.ok(output.startsWith(`${original.authority.evidence}.diagnostic-`));
    assert.match(output.slice(`${original.authority.evidence}.diagnostic-`.length),/^[a-z0-9-]+\.json$/);
  } else if(env.FACTORY_CHECKPOINT_PREVIOUS || env.FACTORY_CHECKPOINT_PREVIOUS_SHA256) {
    assert.equal(env.FACTORY_CHECKPOINT_ORIGINAL,original.authority.evidence);
    let previousPath=env.FACTORY_CHECKPOINT_PREVIOUS, previousSha256=env.FACTORY_CHECKPOINT_PREVIOUS_SHA256;
    for(let depth=0;depth<3;depth++) {
      const previous=readContinuationInput(previousPath,previousSha256);
      const proof=assertContinuationRetry(previous,{original,witness,pause,
        originalSha256:env.FACTORY_CHECKPOINT_ORIGINAL_SHA256,witnessSha256:env.FACTORY_CHECKPOINT_WITNESS_SHA256,
        pauseSha256:env.FACTORY_CHECKPOINT_PAUSE_SHA256,previousPath,previousSha256});
      priorRecords.push(previous);
      if(depth===0) { output=proof.outputPath; retry=proof.retry; }
      if(!previous.continuation.retry) break;
      previousPath=previous.continuation.retry.previousPath;
      previousSha256=previous.continuation.retry.previousSha256;
    }
    assert.equal(priorRecords.length,retry.depth,"complete prior no-action chain required");
    assert.equal(boundedPath(env.FACTORY_CHECKPOINT_EVIDENCE),output);
  } else output=continuationEvidencePath(original,env.FACTORY_CHECKPOINT_ORIGINAL,env.FACTORY_CHECKPOINT_EVIDENCE);
  const authority = { ...original.authority, evidence:output };
  assert.match(authority.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(authority.repository, "clockgrove/factory");
  await checkpointMain(env, (port, accepted) => runCheckpointContinuation(port, accepted, { original, witness, pause, artifact: original.artifact, diagnosticsOnly }), {
    authority, scope: "installed-app-server-observation-continuation",
    harnessPaths: ["scripts/verify-local-checkpoint-continuation.mjs"],
    extendPort: async (context) => {
      const { port, evidence, artifact, command, call, save } = context;
      const stage=(name,operation)=>continuationStage(name,operation,(entry)=>{
        (evidence.continuationDiagnostics ??= []).push(entry); save();
      });
      const seed = await stage("seed",()=>assertContinuationSeed(original, witness, pause, artifact));
      const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
      await stage("original-harness",()=>{ for (const file of original.harnessFiles) {
        assert.match(file.path, /^scripts\/[A-Za-z0-9_.-]+\.mjs$/);
        assert.equal(hash(`${command("git", ["show", `${original.sourceCommit}:${file.path}`], root)}\n`), file.sha256,
          "original committed harness identity unavailable");
      } });
      await stage("original-harness",()=>{ for(const prior of priorRecords) for(const file of prior.harnessFiles) {
        assert.match(file.path,/^scripts\/[A-Za-z0-9_.-]+\.mjs$/);
        assert.equal(hash(`${command("git",["show",`${prior.sourceCommit}:${file.path}`],root)}\n`),file.sha256,
          "prior no-action collector source differs from committed identity");
      } });
      assert.equal(original.harnessSha256, one(original.harnessFiles.filter((file) => file.path === "scripts/verify-local-checkpoint-restart.mjs")).sha256);
      for (const key of ["actor", "base", "objective", "objectiveBodyDigest", "configDigest", "runRequest", "sessionArm", "startedAt"])
        evidence[key] = structuredClone(original[key]);
      evidence.continuation = { originalSha256: env.FACTORY_CHECKPOINT_ORIGINAL_SHA256, witnessSha256: env.FACTORY_CHECKPOINT_WITNESS_SHA256,
        pauseSha256: env.FACTORY_CHECKPOINT_PAUSE_SHA256, originalSourceCommit: original.sourceCommit,
        originalResult: original.result, runId: seed.runId, deadline: new Date(seed.deadline).toISOString(), enteredAt: new Date().toISOString(),
        ...(retry ? {retry} : {}) };
      save();
      const bounded = () => assert.ok(Date.now() < seed.deadline, "original qualification deadline expired");
      const stopped = async () => {
        const fields = await stage("controller-properties",()=>Object.fromEntries(command("systemctl", ["--user", "show", authority.unit,
          "--property=Id,LoadState,ActiveState,SubState,MainPID,ExecMainPID,Job,ControlGroup,InvocationID,KillMode,FragmentPath,DropInPaths,NeedDaemonReload"])
          .split("\n").map((line) => { const i = line.indexOf("="); assert.ok(i > 0); return [line.slice(0,i), line.slice(i+1)]; })));
        // The original service may be failed, not inactive. Never relabel it.
        const { assertControllerUnit } = await import("./verify-local-checkpoint-restart.mjs");
        await stage("controller-fragment",()=>{ assert.equal(fields.FragmentPath, `${realpathSync(homedir())}/.config/systemd/user/${authority.unit}`);
        const meta = lstatSync(fields.FragmentPath);
        assert.ok(meta.isFile() && meta.uid === process.getuid()); });
        const configDigest = await stage("controller-config",()=>assertControllerUnit(context.readBounded(fields.FragmentPath, 16384), {
          repository: authority.repository, checkout: authority.checkout, node: realpathSync(process.execPath),
          bundle: realpathSync(`${context.pluginRoot}/dist/factory.js`),
        }));
        let absent = false;
        await stage("controller-process",()=>{ try { lstatSync(`/proc/${seed.controller.pid}`); } catch (error) { if (error.code !== "ENOENT") throw error; absent = true; } });
        const result = await stage("controller-stopped",()=>assertStoppedContinuationController(fields, seed.controller, configDigest, absent));
        evidence.continuation.stopped = result; save(); return result;
      };
      const continuationPort = {
        ...port, pauseRequestId: pause.requestId, stopped, stage,
        graphProof: (observation) => observeGraph(context, observation),
        preflight: () => continuationPreflight(context,original,stopped,stage,bounded),
        action: async (action) => {
          assert.equal(diagnosticsOnly,false,"observation-only diagnosis cannot perform lifecycle actions");
          assert.ok(["start", "resume", "stop"].includes(action), "continuation may not create, activate, rearm or restart work");
          if (action !== "stop") bounded();
          if (action !== "start") return port.action(action);
          assert.equal(evidence.actions.length, 0, "uncertain continuation start must not repeat");
          await continuationPort.preflight();
          const fresh = await port.observe();
          assertContinuationObservation(fresh, original, witness, pause);
          assert.deepEqual(fresh.receipts.map(({event})=>event).filter((event)=>event.kind==="graph"),
            evidence.checkpoint.checkpoint.receipts.map(({event})=>event).filter((event)=>event.kind==="graph"));
          await port.absence(fresh, [seed.controller], true);
          await stopped(); bounded();
          evidence.actions.push({action, requestedAt: new Date().toISOString()}); save();
          const response = await call("factory_controller_start", { repository: authority.checkout, requestId: `${authority.namespace}-continuation-start` });
          evidence.actions[0].response = response; evidence.actions[0].returnedAt = new Date().toISOString(); save();
          assert.equal(response.accepted, true);
        },
        observe: async () => { bounded(); return port.observe(); },
      };
      return continuationPort;
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { process.exitCode = 2; console.error("Checkpoint continuation refused; no automatic replay or cleanup."); }
}
