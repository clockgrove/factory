/** Explicit installed #75 negative cases. No opt-in, no calls; no runtime failpoint added. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { checkpointAuthority, appServerHoldReady, main as checkpointMain } from "./verify-local-checkpoint-restart.mjs";
import { observeAppServerCheckpoints, assertAppServerCheckpoint } from "./qualification-app-server-checkpoint.mjs";
import { assertQualificationCheckpoint } from "./qualification-sibling-refresh-proof.mjs";
import {
  failureFixture, failureObjectiveBody, assertFailureFixture, proveFailureContent,
  failureEvents, assertFailedValidation, assertFailureAccounting, assertConflictPreserved, failureHash,
} from "./qualification-failure-conflict.mjs";

const one = (rows, message) => { assert.equal(rows.length, 1, message); return rows[0]; };
const scope = "installed-local-failure-conflict";
const actionsFor = (scenario) => scenario === "failed-validation"
  ? "start,create,activate,stop"
  : "start,create,arm-terminal-artifact-hold,activate,pause,stop-original,cas-fixture-trunk,resume,restart,cancel,stop";

export function failureAuthority(env) {
  if (env.FACTORY_LOCAL_FAILURE_CONFLICT !== "1") return null;
  const scenario = env.FACTORY_FAILURE_CASE;
  assert.ok(["failed-validation", "real-conflict"].includes(scenario), "explicit negative case required");
  const repository = env.FACTORY_FAILURE_REPOSITORY, unit = env.FACTORY_FAILURE_CONTROLLER_UNIT;
  if (env.FACTORY_FAILURE_PHASE === "exercise")
    assert.equal(env.FACTORY_FAILURE_ACK, `${repository}:${unit}:${scenario}:${actionsFor(scenario)}`, "exact scenario/mutation acknowledgement required");
  assert.match(env.FACTORY_FAILURE_BASE_SHA ?? "", /^[a-f0-9]{40}$/, "explicit immutable fixture base required");
  assert.match(env.FACTORY_FAILURE_FIXTURE_SHA256 ?? "", /^[a-f0-9]{64}$/, "explicit fixture digest required");
  assert.ok(env.FACTORY_FAILURE_MAX_MODEL_TOKENS, "new scenario allowance required");
  const authority = checkpointAuthority({ ...env,
    FACTORY_LOCAL_CHECKPOINT_RESTART: "1", FACTORY_CHECKPOINT_BACKEND: "app-server",
    FACTORY_CHECKPOINT_PHASE: env.FACTORY_FAILURE_PHASE,
    FACTORY_CHECKPOINT_REPOSITORY: repository, FACTORY_CHECKPOINT_CONTROLLER_UNIT: unit,
    FACTORY_CHECKPOINT_CHECKOUT: env.FACTORY_FAILURE_CHECKOUT,
    FACTORY_CHECKPOINT_NAMESPACE: env.FACTORY_FAILURE_NAMESPACE,
    FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: env.FACTORY_FAILURE_MAX_MODEL_TOKENS,
    FACTORY_CHECKPOINT_EVIDENCE: env.FACTORY_FAILURE_EVIDENCE,
    // Exact scenario authority is checked above; the shared parser supplies path,
    // host/authentication, installed-unit and policy checks, not extra permission.
    FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,arm-terminal-artifact-hold,pause,restart,resume,stop`,
  });
  authority.policy.maxAttemptsPerItem = 1;
  authority.policy.maxParallel = 1;
  authority.policy.capacity.local.maxWorkers = 1;
  authority.policy.workItemTimeoutMinutes = 10;
  authority.policy.objectiveTimeoutMinutes = 40;
  const fixture = failureFixture(authority.namespace, scenario);
  assert.equal(env.FACTORY_FAILURE_FIXTURE_SHA256, failureHash(JSON.stringify(fixture)));
  return { ...authority, failure: { scenario, baseSha: env.FACTORY_FAILURE_BASE_SHA, fixtureDigest: env.FACTORY_FAILURE_FIXTURE_SHA256 } };
}

export function assertRefusalJournal(rows, authority, competing, producer) {
  assert.ok(Array.isArray(rows) && rows.length <= 100);
  const expected = `[factory-controller] preflight blocked: activation ${authority.namespace}-activate is stale: ${competing.branch} advanced from ${competing.before} to ${competing.after}; reactivate against the new head`;
  const matches = rows.filter((row) => row.MESSAGE === expected && row._SYSTEMD_INVOCATION_ID === producer.invocationId);
  assert.ok(matches.length > 0, "fresh exact controller reconciliation refusal not observed");
  const row = matches[0];
  assert.match(row.__REALTIME_TIMESTAMP, /^[0-9]{16}$/);
  assert.ok(Number(row.__REALTIME_TIMESTAMP) / 1000 >= Date.parse(competing.observedAt));
  return { invocationId: producer.invocationId, atMicroseconds: row.__REALTIME_TIMESTAMP, message: expected,
    diagnosticBoundary: "exact current-activation base refusal after real worker completion; not internal merge repair" };
}

export async function runFailureScenario(port, authority) {
  const before = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", before };
  await port.action("start");
  const original = await port.controller("active");
  await port.action("create");
  if (authority.failure.scenario === "failed-validation") {
    await port.action("activate");
    const failed = await port.poll("failed-validation", (value) => value.receipts.some(({ event }) => event.event === "FactoryRunEscalated"));
    const facts = assertFailedValidation(failed, authority, failureFixture(authority.namespace, "failed-validation"));
    const content = await port.contentProof(failed);
    assert.equal(content.objects.workerTree, facts.validation.outputTreeSha);
    const absence = await port.absence(failed, [original]);
    await port.noPublication();
    await port.controller("active", original);
    await port.action("stop");
    const stopped = await port.controller("inactive");
    return { result: "passed", scenario: "failed-validation", facts, content, absence, stopped };
  }
  const arm = await port.armSession(original);
  await port.action("activate");
  await port.poll("worker-start", (value) => value.receipts.some(({ event }) => event.event === "AttemptStarted"));
  await port.action("pause");
  const held = await port.poll("terminal-artifact-hold", (value) => appServerHoldReady(value, authority, arm));
  const { run } = failureEvents(held, authority);
  assertFailureAccounting(run);
  const content = await port.contentProof(held, held.checkpointReached);
  assert.equal(content.objects.conflict.exitCode, 1);
  const absence = await port.absence(held, [original], true);
  await port.noPublication();
  await port.checkpoint({ checkpoint: held, content, absence, original });
  await port.stopOriginal(original);
  const competing = await port.compete(held, content);
  // Resume is actor-authenticated authority for ONLY the existing nonterminal run.
  // No replacement activation, new allowance, foreground run, or terminal revival.
  await port.action("resume");
  await port.action("restart");
  const replacement = await port.controller("active");
  assert.notEqual(replacement.invocationId, original.invocationId);
  assert.equal(replacement.hostIdentity, original.hostIdentity);
  const refusal = await port.refusal(replacement, competing);
  const final = await port.observe();
  assertConflictPreserved(held, final, authority);
  const finalContent = await port.contentProof(final, held.checkpointReached);
  assert.deepEqual(finalContent, content, "original immutable content/session changed");
  await port.absence(final, [original, replacement], true);
  await port.noPublication();
  await port.assertCompeting(competing);
  await port.controller("active", replacement);
  // Completion includes history-preserving closeout, never a forced trunk restore.
  // If cancellation is blocked by currentness, this remains incomplete, not passed.
  await port.action("cancel");
  const cancelled = await port.poll("cancelled", (value) => value.receipts.some(({ event }) => event.event === "FactoryRunCancelled"));
  const accounting = assertConflictPreserved(held, cancelled, authority, true);
  assert.deepEqual(await port.contentProof(cancelled, held.checkpointReached), content);
  const finalAbsence = await port.absence(cancelled, [original, replacement], true);
  await port.noPublication();
  await port.assertCompeting(competing);
  await port.controller("active", replacement);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return { result: "passed", scenario: "real-conflict", boundary: "real post-execution content conflict; bounded earlier controller reconciliation refusal, not internal merge repair",
    competing, content, accounting, refusal, absence, finalAbsence, stopped, originalRunCancelled: true, trunkRestored: false };
}

// Same captured GraphQL compare-and-swap contract as control/github-store.ts;
// never REST force=false as a substitute for beforeOid identity.
const updateRefs = `mutation QualificationConflict($repositoryId: ID!, $name: GitRefname!, $beforeOid: GitObjectID!, $afterOid: GitObjectID!) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: [{ name: $name, beforeOid: $beforeOid, afterOid: $afterOid, force: false }] }) { clientMutationId }
}`;

export function failureExtension(authority) {
  const fixture = failureFixture(authority.namespace, authority.failure.scenario);
  return {
    authority, scope,
    harnessPaths: ["scripts/verify-local-failure-conflict.mjs", "scripts/qualification-failure-conflict.mjs", "scripts/qualification-receipts.mjs"],
    objectiveBody: () => failureObjectiveBody(authority.namespace, authority.failure.scenario),
    preflight: async ({ evidence, request, save }) => {
      assert.equal(evidence.base, authority.failure.baseSha, "fixture activation base changed");
      evidence.failureFixture = assertFailureFixture(authority.checkout, evidence.base, fixture);
      assert.equal(evidence.failureFixture.fixtureDigest, authority.failure.fixtureDigest);
      const repository = (await request("GET /repos/{owner}/{repo}", {})).data;
      assert.equal(repository.full_name.toLowerCase(), authority.repository);
      assert.ok(repository.private && repository.permissions?.push);
      assert.match(repository.node_id, /^[A-Za-z0-9_=+-]+$/);
      assert.match(repository.default_branch, /^[A-Za-z0-9][A-Za-z0-9_./-]*$/);
      evidence.failureRepository = { nodeId: repository.node_id, branch: repository.default_branch };
      save();
    },
    extendPort: async (context) => {
      const { port, evidence, request, list, call, save, command } = context;
      const once = async (name, action) => {
        assert.ok(!(evidence.failureActions ?? []).some((entry) => entry.name === name), "uncertain qualification mutation cannot repeat");
        const entry = { name, requestedAt: new Date().toISOString() };
        (evidence.failureActions ??= []).push(entry); save();
        // Four or fewer serial fixture writes, no automatic API retry. A refusal
        // aborts the scenario and preserves this attempted write before any next action.
        await sleep(1000);
        const response = await action();
        entry.returnedAt = new Date().toISOString(); entry.response = response; save();
        return response;
      };
      const noPublication = async () => {
        assert.equal((await list("GET /repos/{owner}/{repo}/pulls", { state: "all" })).filter((pull) =>
          (pull.head?.ref ?? "").startsWith(`factory/objective-${evidence.objective.number}/`) ||
          new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${evidence.objective.number}\\b`, "i").test(pull.body ?? "")).length, 0, "negative case has a publication");
        // A fresh all-open listing also catches differently named/linked publication.
        assert.equal((await list("GET /repos/{owner}/{repo}/pulls", { state: "open" })).length, 0);
      };
      const currentRef = async () => {
        const ref = `refs/heads/${evidence.failureRepository.branch}`;
        const data = (await request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ref: ref.slice(5) })).data;
        assert.equal(data.ref, ref); assert.equal(data.object.type, "commit");
        return data.object.sha;
      };
      const contentProof = async (observation, witness) => {
        const proofs = await observeAppServerCheckpoints(request, observation, authority, witness);
        const proof = one(proofs, "one exact original session required");
        const summary = assertAppServerCheckpoint(observation, authority, proof, witness);
        const prepared = JSON.parse(proof.prepared.content);
        assert.deepEqual(prepared.packet.allowedPaths, [fixture.paths.payload]);
        assert.deepEqual(prepared.packet.validationCommands, [fixture.validationCommand]);
        assert.equal(prepared.packet.requirements.trust, "trusted_local");
        const ready = assertQualificationCheckpoint(proof.ready, { ref: proof.ready.ref, path: "artifact-transfer.json", maxBytes: 1048576 }, [proof.intent.commit.oid]);
        const objects = proveFailureContent({ repository: authority.checkout, baseSha: evidence.base, artifact: ready.artifact, fixture });
        (evidence.failureContentObservations ??= []).push({ summary, proof, objects }); save();
        return { summary, objects };
      };
      return { ...port, noPublication, contentProof,
        stopOriginal: async (original) => {
          await port.controller("active", original);
          await once("stop-original", () => call("factory_controller_stop", { repository: authority.checkout, requestId: `${authority.namespace}-stop-original` }));
          await port.controller("inactive");
        },
        compete: async (held, content) => {
          assert.equal(authority.failure.scenario, "real-conflict");
          assertConflictPreserved(held, await port.observe(), authority);
          await port.controller("inactive");
          await noPublication();
          assert.equal(await currentRef(), evidence.base, "competing writer changed expected trunk before qualification CAS");
          const { objects } = content;
          assert.equal(objects.baseSha, evidence.base);
          const blob = await once("competing-blob", async () => (await request("POST /repos/{owner}/{repo}/git/blobs", { encoding: "utf-8", content: fixture.competing })).data);
          assert.equal(blob.sha, objects.competingBlob);
          const tree = await once("competing-tree", async () => (await request("POST /repos/{owner}/{repo}/git/trees", {
            base_tree: objects.baseTreeSha, tree: [{ path: fixture.paths.payload, mode: "100644", type: "blob", sha: blob.sha }],
          })).data);
          assert.equal(tree.sha, objects.competingTree, "remote competing tree differs from proven conflict");
          const commit = await once("competing-commit", async () => (await request("POST /repos/{owner}/{repo}/git/commits", {
            message: `Explicit qualification competing content [${authority.namespace}]`, tree: tree.sha, parents: [evidence.base],
          })).data);
          assert.match(commit.sha, /^[a-f0-9]{40}$/);
          assert.equal(commit.tree.sha, tree.sha);
          assert.deepEqual(commit.parents.map((parent) => parent.sha), [evidence.base]);
          await port.controller("inactive");
          assertConflictPreserved(held, await port.observe(), authority);
          assert.equal(await currentRef(), evidence.base);
          const result = { before: evidence.base, after: commit.sha, tree: tree.sha, branch: evidence.failureRepository.branch, requestedAt: new Date().toISOString() };
          evidence.competing = result; save();
          await once("cas-fixture-trunk", async () => {
            const response = await request("POST /graphql", { query: updateRefs, variables: { repositoryId: evidence.failureRepository.nodeId, name: `refs/heads/${result.branch}`, beforeOid: result.before, afterOid: result.after } });
            assert.equal(response.data.errors, undefined, "conditional trunk mutation refused; retain uncertain evidence");
            assert.ok(response.data.data?.updateRefs);
            return response.data;
          });
          assert.equal(await currentRef(), result.after, "exact conditional trunk mutation not observed");
          result.observedAt = new Date().toISOString(); save();
          return result;
        },
        assertCompeting: async (competing) => assert.equal(await currentRef(), competing.after),
        refusal: async (producer, competing) => {
          // No interpretation of arbitrary logs and no journal contents retained.
          // Only the fixed, exact Objective/generation diagnostic can qualify.
          for (let count = 0; count < 36; count++) {
            await port.controller("active", producer);
            const raw = command("journalctl", ["--user", "--unit", authority.unit, `_SYSTEMD_INVOCATION_ID=${producer.invocationId}`, "--output=json", "--no-pager", "-n", "100"]);
            const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
            const expected = `[factory-controller] preflight blocked: activation ${authority.namespace}-activate is stale: ${competing.branch} advanced from ${competing.before} to ${competing.after}; reactivate against the new head`;
            if (rows.some((row) => row.MESSAGE === expected)) return assertRefusalJournal(rows, authority, competing, producer);
            await sleep(5000);
          }
          throw Error("bounded post-conflict controller refusal unavailable; do not repeat execution");
        },
      };
    },
  };
}

export async function main(env = process.env) {
  const authority = failureAuthority(env);
  if (!authority) { console.log("Not exercised: explicit failure/conflict authority required."); return; }
  await checkpointMain(env, runFailureScenario, failureExtension(authority));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--print-fixture") {
    const fixture = failureFixture(process.env.FACTORY_FAILURE_NAMESPACE, process.env.FACTORY_FAILURE_CASE);
    console.log(JSON.stringify({ fixture, sha256: failureHash(JSON.stringify(fixture)), preparation: "Commit these exact files in the authorized disposable repository; retain its existing package.json test=\"node --test\". This command writes nothing and does not activate Factory." }, null, 2));
  } else main().catch(() => { process.exitCode = 2; console.error("Failure/conflict qualification unavailable; no automatic retry or cleanup."); });
}
