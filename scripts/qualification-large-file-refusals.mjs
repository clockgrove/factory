/** Installed refusal evidence only. These ports never activate, retry, close, or cancel an Objective. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authenticatedFaultEvents } from "./verify-local-faults.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import {
  assertQualificationEvidenceValue,
  largeFileRefusalEvidenceBytes,
} from "./qualification-evidence-boundary.mjs";
import {
  assertSettledAttemptRefusal,
  settledQualificationEvidence,
} from "./qualification-settled-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const one = (rows, message) => {
  assert.ok(rows.length === 1, message);
  return rows[0];
};
const safe = (value, maximum = 4 * 1024 * 1024) =>
  assertQualificationEvidenceValue(value, maximum, "refusal evidence");
const phases = new Set(["scope", "secret", "symlink"]);

function policyBoundary(authority) {
  assert.ok(
    authority.policy.maxAttemptsPerItem === 1,
    "refusal qualification requires one attempt",
  );
  assert.ok(
    Array.isArray(authority.policy.allowedPaidBackends) &&
      authority.policy.allowedPaidBackends.length === 0,
    "refusal qualification cannot authorize paid backends",
  );
}
function observedEvents(context, observation) {
  safe(observation);
  assert.ok(Array.isArray(observation.receipts), "authenticated refusal observation unavailable");
  for (const row of observation.receipts)
    assert.ok(
      row.actorId === context.evidence.actor.id &&
        Number.isSafeInteger(row.commentId) &&
        row.event.objective === context.evidence.objective.number,
      "refusal receipt authentication/location differs",
    );
  return deduplicateQualificationReceipts(observation.receipts).map(({ event }) => event);
}
async function noExecution(context) {
  const objective = context.evidence.objective.number;
  const children = await context.list(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    { issue_number: objective },
  );
  assert.ok(children.length === 0, "pre-compilation refusal unexpectedly has Work Items");
  const comments = await context.list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    issue_number: objective,
  });
  const receipts = authenticatedFaultEvents(comments, context.evidence.actor, objective);
  assert.ok(
    !receipts.some(({ event }) =>
      [
        "ActivationRequested",
        "FactoryRunStarted",
        "GraphCompiled",
        "GraphProjected",
        "AttemptReserved",
        "AttemptStarted",
      ].includes(event.event),
    ),
    "pre-compilation refusal has execution or activation evidence",
  );
  return { children: [], receipts };
}
function lfsDiagnostic(scenario, diagnostic, fixture) {
  if (scenario === "lfs-missing-tool")
    return (
      diagnostic ===
      "pinned repository requires git-lfs; install Git LFS on this execution host before starting a model"
    );
  if (scenario !== "lfs-missing-object") return false;
  return fixture.lfs.some(
    ({ oid }) =>
      diagnostic ===
      `required LFS object ${oid} is missing or unsafe in the standard local cache; fetch it with your repository's authorized LFS credentials before starting Factory (custom storage is not resolved automatically)`,
  );
}
export function createLargeFileRefusalPorts(context, fixture) {
  const { authority, evidence } = context,
    scenario = authority.largeFile.scenario;
  assert.ok(
    fixture.namespace === authority.namespace && evidence.base === fixture.baseSha,
    "refusal fixture differs from exact qualification namespace/base",
  );
  const save = async () => {
    largeFileRefusalEvidenceBytes(evidence.largeFileRefusal);
    await context.save();
  };
  return {
    async compileRefusal() {
      policyBoundary(authority);
      assert.ok(
        ["lfs-missing-tool", "lfs-missing-object"].includes(scenario),
        "scenario is not a compilation refusal",
      );
      assert.ok(
        !evidence.largeFileRefusal,
        "refusal action was already attempted; do not replay uncertain calls",
      );
      const before = await noExecution(context);
      const args = {
        objectiveNumber: evidence.objective.number,
        repository: authority.checkout,
        compile: true,
        baseSha: evidence.base,
        policy: authority.policy,
      };
      evidence.largeFileRefusal = {
        protocol: "clockgrove.factory/large-file-refusal-v1",
        scenario,
        action: { name: "factory_plan", arguments: args, attemptedAt: new Date().toISOString() },
        before,
      };
      await save(); // Durable local action intent precedes the sole installed invocation.
      let response;
      try {
        response = await context.invoke("factory_plan", args);
      } catch {
        evidence.largeFileRefusal.transport = "unavailable-response; no automatic retry";
        await save();
        throw Error("installed compilation refusal response unavailable; no retry authorized");
      }
      safe(response);
      assert.ok(
        Buffer.byteLength(JSON.stringify(response)) <= 65536,
        "installed refusal response exceeds bound",
      );
      evidence.largeFileRefusal.response = response;
      evidence.largeFileRefusal.respondedAt = new Date().toISOString();
      await save();
      assert.ok(
        Array.isArray(response.content) &&
          response.content.length > 0 &&
          response.content.every((part) => part.type === "text" && typeof part.text === "string"),
        "installed compilation refusal did not return bounded text",
      );
      const text = response.content.map((part) => part.text).join("\n");
      let diagnostic;
      if (response.isError === true) diagnostic = text;
      else {
        let report;
        try {
          report = JSON.parse(text);
        } catch {
          throw Error("installed plan report is not JSON");
        }
        assert.ok(
          report.operation === "plan" &&
            report.repository === authority.repository &&
            report.objective?.number === evidence.objective.number &&
            report.activationAuthorized === false &&
            report.mode === "compilation" &&
            report.compilation?.requested === true &&
            report.compilation.result === "failed" &&
            report.compilation.usagePersistence === "none" &&
            report.graph === null &&
            report.proposedGraph === undefined &&
            report.usage === null,
          "installed plan did not refuse before returning a compiled graph or usage",
        );
        diagnostic = one(
          report.diagnostics.filter((entry) => entry.status === "fail"),
          "one exact LFS refusal diagnostic required",
        ).summary;
      }
      assert.ok(
        lfsDiagnostic(scenario, diagnostic, fixture),
        "installed plan refused at a different boundary",
      );
      const after = await noExecution(context);
      const result = {
        scenario,
        refused: true,
        boundary: "pinned-lfs-pre-compilation",
        diagnostic,
        executionGraph: "not-created",
        modelCalls: null,
        modelCallEvidence: "unavailable; exact installed guard diagnostic and source ordering only",
        uploadCount: null,
        uploadEvidence: "unavailable; no content-write instrumentation",
        durableControlWrites: "not-prohibited",
        after,
      };
      evidence.largeFileRefusal.result = result;
      await save();
      return result;
    },
    async artifactRefusal(observation) {
      policyBoundary(authority);
      assert.ok(phases.has(scenario), "scenario is not an artifact refusal");
      assert.ok(!evidence.largeFileRefusal, "refusal observation already recorded");
      const events = observedEvents(context, observation),
        runId = observation.status?.run?.runId;
      assert.ok(typeof runId === "string" && runId.length > 0, "refusal run identity unavailable");
      const settled = settledQualificationEvidence(events, {
        runId,
        terminalEvent: "FactoryRunEscalated",
      });
      const run = settled.events;
      const start = one(
        run.filter((event) => event.event === "FactoryRunStarted"),
        "one original run start required",
      );
      assert.ok(
        start.activationRequestId === `${authority.namespace}-activate` &&
          start.policyDigest === hash(canonical(authority.policy)) &&
          start.repository?.toLowerCase() === authority.repository &&
          canonical(start.policy) === canonical(authority.policy),
        "refusal activation/policy differs",
      );
      const expected =
        scenario === "scope"
          ? `artifact changes paths outside scope: ${fixture.paths.prefix}/outside-scope.txt`
          : scenario === "secret"
            ? "artifact content contains suspected GitHub token"
            : "symlink artifacts support Git-object-only operations, not filesystem materialization";
      const refusal = assertSettledAttemptRefusal(settled, {
        baseSha: evidence.base,
        reason: expected,
      });
      assert.equal(
        run.find((event) => event.event === "AttemptReserved")?.policyDigest,
        start.policyDigest,
        "refusal attempt policy differs from the run",
      );
      assert.ok(
        observation.status.run.state === "escalated" &&
          observation.status.summary?.outcome === "escalated" &&
          observation.status.summary.economics.unresolvedModelInvocations === 0 &&
          observation.status.summary.economics.usage.model_tokens.availability === "observed" &&
          observation.status.summary.economics.usage.model_tokens.value ===
            refusal.model.totalTokens,
        "refusal terminal status/accounting differs from durable receipts",
      );
      for (const field of ["inputTokens", "outputTokens", "cachedInputTokens"])
        assert.equal(
          observation.status.summary.economics.modelTokenBreakdown[field].tokens.value,
          refusal.model[field],
          `refusal ${field} status differs from durable receipts`,
        );
      assert.ok(
        observation.status.summary.attempts.total === 1 &&
          observation.status.summary.attempts.failed === 1 &&
          observation.status.summary.validation.recorded === 0 &&
          observation.status.summary.delivery.publications === 0 &&
          observation.status.summary.delivery.integrationsCompleted === 0,
        "refusal terminal status claims a different execution outcome",
      );
      assert.ok(
        observation.status.workItems.length === 1 &&
          observation.status.workItems[0].number === refusal.workItem &&
          observation.status.workItems[0].state === "failed",
        "refusal Work Item did not settle as failed",
      );
      const result = {
        scenario,
        refused: true,
        boundary:
          scenario === "symlink"
            ? "filesystem-materialization"
            : "collection-before-retained-transfer",
        ...refusal,
        publication: "no authenticated publication/integration receipts",
        modelCalls: refusal.model.calls,
        modelCallEvidence: "exact authenticated BudgetReconciled receipts",
        uploadCount: null,
        uploadEvidence: "terminal receipts do not infer physical Git object writes",
        validationCommandEvidence:
          "exact pre-command guard diagnostic; no ValidationRecorded (not a separate process trace)",
        durableControlWrites: "permitted",
      };
      evidence.largeFileRefusal = {
        protocol: "clockgrove.factory/large-file-refusal-v1",
        scenario,
        result,
      };
      await save();
      return result;
    },
  };
}
