/** Opt-in actual native-unavailability -> originally authorized regular delivery. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedPolicy, main as installedMain, modelTokenLimit } from "./verify-live-objective.mjs";
import {
  assertRegularPipelineCompletion,
  observeRegularCommits,
} from "./verify-regular-objective.mjs";
import { assertNativeScopes, observeNativeScopes } from "./qualification-native-scopes.mjs";
import { nativeQualificationEvents, observeNativeMergeProofs } from "./qualification-sibling-refresh-proof.mjs";

const scope = "installed-local-native-unavailable-regular-fallback";
const protocol = "clockgrove.factory/native-fallback-capability-v1";
const version = "2026-03-10";
const unsupportedReason = `repository did not expose GitHub stacks API ${version}`;
const routes = [
  "GET /repos/{owner}/{repo}",
  "GET /repos/{owner}/{repo}/pulls",
  "GET /repos/{owner}/{repo}/stacks",
  "GET /repos/{owner}/{repo}",
];

function fallbackPolicy(tokens) {
  const policy = boundedPolicy("stacked-prs", tokens);
  return { ...policy, delivery: { ...policy.delivery, onUnavailable: "regular-prs" } };
}
function parameters(repository, route) {
  const [owner, repo] = repository.split("/");
  return {
    owner,
    repo,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": version },
    ...(route.endsWith("/pulls") ? { state: "all", per_page: 1 } : {}),
    ...(route.endsWith("/stacks") ? { per_page: 1 } : {}),
  };
}
function responseRecord(route, args, response) {
  const headers = response?.headers ?? {};
  const data = response?.data;
  return {
    route,
    parameters: args,
    status: response?.status ?? null,
    url: response?.url ?? null,
    headers: {
      apiVersion: headers["x-github-api-version-selected"] ?? null,
      requestId: headers["x-github-request-id"] ?? null,
      remaining: headers["x-ratelimit-remaining"] ?? null,
      date: headers.date ?? null,
      refusal: ["retry-after", "x-github-sso", "www-authenticate"].some(
        (key) => headers[key] !== undefined,
      ),
    },
    ...(route === routes[0]
      ? {
          repository: {
            id: data?.id ?? null,
            nodeId: data?.node_id ?? null,
            fullName: data?.full_name ?? null,
            private: data?.private ?? null,
            archived: data?.archived ?? null,
            push: data?.permissions?.push ?? null,
          },
        }
      : {
          arrayLength: Array.isArray(data) ? data.length : null,
          notFound: data?.message === "Not Found",
        }),
  };
}
function assertResponse(record, repository, route, status) {
  assert.equal(record.route, route);
  assert.deepEqual(record.parameters, parameters(repository, route));
  assert.equal(record.status, status);
  const url = new URL(record.url);
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.pathname, `/repos/${repository}${route.slice(routes[0].length)}`);
  assert.equal(record.headers.apiVersion, version);
  assert.match(record.headers.requestId, /^[A-Za-z0-9:-]{1,160}$/);
  assert.ok(Number.isFinite(Date.parse(record.headers.date)));
  assert.match(String(record.headers.remaining), /^[1-9][0-9]*$/);
  assert.equal(record.headers.refusal, false, "refusal is not unsupported capability");
}
function assertRepository(record, repository) {
  assertResponse(record, repository, routes[0], 200);
  assert.ok(Number.isSafeInteger(record.repository.id) && record.repository.id > 0);
  assert.match(record.repository.nodeId, /^[A-Za-z0-9_=-]{1,200}$/);
  assert.equal(record.repository.fullName, repository);
  assert.equal(record.repository.private, true);
  assert.equal(record.repository.archived, false);
  assert.equal(record.repository.push, true);
}

/** Same authenticated transport; four bounded reads, no retry, mutation or simulated denial. */
export async function observeNativeFallbackCapability({ request, repository, actor }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const proof = {
    protocol,
    repository,
    actor: { id: actor.id, login: actor.login },
    observations: [],
  };
  try {
    for (const [index, route] of routes.entries()) {
      const args = parameters(repository, route);
      let response;
      try {
        response = await request(route, {
          ...args,
          request: { signal: AbortSignal.timeout(15000) },
        });
      } catch (error) {
        // Only an actual REST response can establish 404. Never save raw exceptions/auth headers.
        response = error?.response;
      }
      const record = responseRecord(route, args, response);
      proof.observations.push(record);
      if (index === 0 || index === 3) assertRepository(record, repository);
      else {
        assertResponse(record, repository, route, index === 2 ? 404 : 200);
        if (index === 1) assert.ok(record.arrayLength !== null && record.arrayLength <= 1);
        else assert.equal(record.notFound, true);
      }
    }
    assert.deepEqual(proof.observations[0].repository, proof.observations[3].repository);
    return { ...proof, result: "passed" };
  } catch {
    return { ...proof, result: "blocked", reason: "actual-native-unavailability-unproven" };
  }
}

export function assertNativeFallbackCapability(proof, { repository, actor }) {
  assert.equal(proof.protocol, protocol);
  assert.equal(proof.result, "passed");
  assert.equal(proof.repository, repository);
  assert.deepEqual(proof.actor, { id: actor.id, login: actor.login });
  assert.ok(Number.isSafeInteger(actor.id) && actor.id > 0);
  assert.match(actor.login, /^[A-Za-z0-9-]{1,100}$/);
  assert.equal(proof.observations.length, 4);
  const [before, pulls, stacks, after] = proof.observations;
  assertRepository(before, repository);
  assertRepository(after, repository);
  assert.deepEqual(
    after.repository,
    before.repository,
    "repository changed across capability read",
  );
  assertResponse(pulls, repository, routes[1], 200);
  assert.ok(pulls.arrayLength !== null && pulls.arrayLength >= 0 && pulls.arrayLength <= 1);
  assertResponse(stacks, repository, routes[2], 404);
  assert.equal(stacks.notFound, true);
}

export function nativeFallbackQualification(env) {
  if (env.FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE !== "1") return null;
  assert.ok(env.FACTORY_LIVE_OBJECTIVE === "1" || env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1");
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "stacked-prs",
    "fallback qualifier must originally request native delivery",
  );
  assert.ok(
    !env.FACTORY_LIVE_REGULAR_OBJECTIVE &&
      !env.FACTORY_LIVE_REGULAR_BACKEND &&
      !env.FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE,
    "conflicting qualification profile",
  );
  const policy = fallbackPolicy(modelTokenLimit(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS));
  return {
    scope,
    policy,
    privateEvidence: true,
    observePreflight: observeNativeFallbackCapability,
    beforeRun: async ({ evidence, request, save }) => {
      evidence.nativeDefaultBranch = evidence.preflight.defaultBranch;
      assertNativeFallbackCapability(evidence.preflight.scenario, evidence);
      evidence.nativeFallbackCapability = await observeNativeFallbackCapability({
        request,
        repository: evidence.repository,
        actor: evidence.actor,
      });
      save();
      assertNativeFallbackCapability(evidence.nativeFallbackCapability, evidence);
    },
    observeMergeProofs: observeNativeMergeProofs,
    afterRun: async (hooks) => {
      await observeRegularCommits({
        ...hooks,
        request: (route, args) =>
          hooks.request(route, {
            ...args,
            request: { signal: AbortSignal.timeout(15000) },
          }),
      });
      observeNativeScopes(hooks.evidence);
    },
    assessCompletion: assessNativeFallbackCompletion,
  };
}

export function assertNativeFallbackCompletion(evidence) {
  const expected = fallbackPolicy(
    modelTokenLimit(String(evidence.policy.economics.maxModelTokens)),
  );
  assertRegularPipelineCompletion(evidence, { expected, scope, deliveryMode: "native-fallback" });
  assert.equal(evidence.preflight.harness.sourceTreeClean, true);
  assertNativeFallbackCapability(evidence.preflight.scenario, evidence);
  assertNativeFallbackCapability(evidence.nativeFallbackCapability, evidence);
  const repositoryId = evidence.nativeFallbackCapability.observations[0].repository;
  assert.deepEqual(evidence.preflight.scenario.observations[0].repository, repositoryId);
  for (const proof of evidence.mergeProofs) {
    assert.equal(proof.repositoryNodeId, repositoryId.nodeId);
  }
  const events = nativeQualificationEvents(evidence);
  const selected = events.find((event) => event.event === "DeliverySelected");
  const start = events.find((event) => event.event === "FactoryRunStarted");
  assert.equal(selected.capabilityVersion, version);
  assert.equal(
    selected.reason,
    unsupportedReason,
    "fallback reason is not the actual unsupported surface",
  );
  assert.equal(selected.policyDigest, start.policyDigest);
  assert.ok(selected.sequence > start.sequence);
  assert.ok(
    events
      .filter((event) =>
        ["AttemptReserved", "AttemptStarted", "PublicationRecorded"].includes(event.event),
      )
      .every((event) => selected.sequence < event.sequence),
    "fallback selected after admission/publication",
  );
  assertNativeScopes(evidence);
}

export function assessNativeFallbackCompletion(evidence) {
  try {
    assertNativeFallbackCompletion(evidence);
    return { result: "passed", scope };
  } catch {
    return {
      result: ["cancelled", "escalated"].includes(evidence?.status?.run?.state)
        ? "failed"
        : "incomplete",
      scope,
      reason:
        "Actual native fallback evidence is incomplete or conflicting; inspect private receipts",
    };
  }
}
export async function main(env = process.env, run = installedMain) {
  const qualification = nativeFallbackQualification(env);
  if (!qualification) {
    console.log(
      "Not exercised: set FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE=1 with shared explicit guards.",
    );
    return;
  }
  await run(qualification);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error("Native fallback qualification incomplete; no automatic retry performed.");
    process.exitCode = 2;
  }
}
