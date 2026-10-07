import { createHash } from "node:crypto";
import type {
  PublicationControl,
  PullRequestPublication,
  PullRequestIdentity,
} from "../contracts.js";
import type { FactoryState } from "../state.js";
import { attachFault, decision } from "../fault.js";

const MAX_INTENTS = 64;
export interface PublicationIntent {
  repository: string;
  runId: string;
  configDigest: string;
  itemId: string;
  attemptId: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  treeSha: string;
  titleDigest: string;
  bodyDigest: string;
  recordedAt: string;
  submission: "possibly-submitted" | "observed-without-create";
  observation?: {
    number: number;
    branch: string;
    headSha: string;
    observedAt: string;
    publication: NonNullable<PullRequestIdentity["publication"]>;
  };
  /** Existing closed-PR operator retry, never an unknown-submission override. */
  closedConfirmedAt?: string;
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function fenced(detail: string): Error {
  return attachFault(
    new Error(detail),
    decision(
      "PR publication is unresolved. Preserve its request and use read-only exact reconciliation; retry cannot authorize another creation.",
      detail,
    ),
  );
}

/** Validate retained intent identity without granting execution or dispatch authority. */
export function assertPublicationIntents(state: FactoryState): void {
  if (
    state.publicationContract !== undefined &&
    state.publicationContract !== "exact-request-v1"
  )
    throw new Error("Unsupported publication contract");
  if (state.publicationIntents === undefined) return;
  if (
    state.publicationContract !== "exact-request-v1" ||
    !state.publicationIntents ||
    typeof state.publicationIntents !== "object" ||
    Array.isArray(state.publicationIntents)
  )
    throw new Error("Publication history lacks its admitted contract");
  for (const [itemId, intents] of Object.entries(state.publicationIntents)) {
    if (
      !Array.isArray(intents) ||
      !intents.length ||
      intents.length > MAX_INTENTS ||
      !state.work[itemId]
    )
      throw new Error("Invalid publication history item or bound");
    let unresolved = 0;
    for (const [index, intent] of intents.entries()) {
      if (
        !intent ||
        intent.repository !== state.repository ||
        intent.runId !== state.runId ||
        intent.configDigest !== state.configDigest ||
        intent.itemId !== itemId
      )
        throw new Error("Publication request owner binding differs");
      for (const key of ["attemptId", "branch", "baseBranch"] as const)
        if (typeof intent[key] !== "string" || !intent[key].trim())
          throw new Error("Publication request identity missing");
      for (const key of [
        "headSha",
        "treeSha",
        "titleDigest",
        "bodyDigest",
      ] as const)
        if (
          !new RegExp(`^[0-9a-f]{${key.endsWith("Digest") ? 64 : 40}}$`).test(
            intent[key],
          )
        )
          throw new Error("Publication request digest invalid");
      if (
        typeof intent.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(intent.recordedAt)) ||
        !["possibly-submitted", "observed-without-create"].includes(
          intent.submission,
        )
      )
        throw new Error("Publication request disposition invalid");
      if (intent.observation) {
        const observed = intent.observation;
        if (
          !Number.isSafeInteger(observed.number) ||
          observed.number < 1 ||
          observed.branch !== intent.branch ||
          observed.headSha !== intent.headSha ||
          !Number.isFinite(Date.parse(observed.observedAt))
        )
          throw new Error("Publication observation differs from exact request");
        const publication = observed.publication;
        if (
          !publication ||
          publication.repository !== state.repository ||
          publication.baseBranch !== intent.baseBranch ||
          !/^[0-9a-f]{64}$/.test(publication.titleDigest) ||
          !/^[0-9a-f]{64}$/.test(publication.bodyDigest) ||
          (publication.author !== undefined &&
            (typeof publication.author !== "string" ||
              !publication.author.trim())) ||
          (intent.submission === "possibly-submitted" &&
            (publication.titleDigest !== intent.titleDigest ||
              publication.bodyDigest !== intent.bodyDigest))
        )
          throw new Error(
            "Publication metadata differs from recorded request/observation",
          );
      } else {
        if (
          intent.submission !== "possibly-submitted" ||
          index !== intents.length - 1
        )
          throw new Error(
            "Unresolved publication is not the retained latest request",
          );
        unresolved++;
      }
      if (
        intent.closedConfirmedAt !== undefined &&
        (!intent.observation ||
          !Number.isFinite(Date.parse(intent.closedConfirmedAt)))
      )
        throw new Error("Publication closure lacks known observation");
    }
    if (unresolved > 1)
      throw new Error("Multiple unresolved publication requests");
  }
}

/** Construct only inside the existing exclusive controller/save ownership. */
export function publicationControl(
  state: FactoryState,
  itemId: string,
  save: () => void,
): PublicationControl {
  assertPublicationIntents(state);
  if (state.publicationContract !== "exact-request-v1")
    throw fenced(
      "Historical unpublished delivery has no recorded publication contract; its outcome is unrecorded/unknown",
    );
  const work = state.work[itemId];
  if (
    !work?.attempt ||
    !work.changeRef ||
    !work.treeSha ||
    work.status !== "running" ||
    work.step !== "deliver"
  )
    throw fenced("Publication lacks exact Work Item attempt/result identity");
  const owner = {
    repository: state.repository,
    runId: state.runId,
    configDigest: state.configDigest,
    attemptId: work.attempt,
    headSha: work.changeRef,
    treeSha: work.treeSha,
    graphRevisionDigest: work.graphRevisionDigest,
  };
  let installedHistory = state.publicationIntents?.[itemId];
  const history = installedHistory ?? [];
  let historySnapshot = JSON.stringify(history);
  const assertCurrent = () => {
    if (
      state.publicationContract !== "exact-request-v1" ||
      state.repository !== owner.repository ||
      state.runId !== owner.runId ||
      state.configDigest !== owner.configDigest ||
      state.work[itemId] !== work ||
      work.attempt !== owner.attemptId ||
      work.changeRef !== owner.headSha ||
      work.treeSha !== owner.treeSha ||
      work.graphRevisionDigest !== owner.graphRevisionDigest ||
      work.status !== "running" ||
      work.step !== "deliver" ||
      state.publicationIntents?.[itemId] !== installedHistory ||
      JSON.stringify(state.publicationIntents?.[itemId] ?? []) !==
        historySnapshot
    )
      throw fenced(
        "Publication control is stale; live owner/work/request history changed",
      );
  };
  const advanceHistory = () => {
    installedHistory = state.publicationIntents?.[itemId];
    historySnapshot = JSON.stringify(history);
  };

  const pending = history.find((entry) => !entry.observation);
  const retained =
    pending ??
    [...history]
      .reverse()
      .find(
        (entry) =>
          entry.attemptId === work.attempt &&
          entry.headSha === work.changeRef &&
          entry.treeSha === work.treeSha &&
          !entry.closedConfirmedAt,
      );
  if (!retained && history.length >= MAX_INTENTS)
    throw fenced(
      "Publication history is full; no new branch/LFS/create effects are permitted",
    );
  let created: PublicationIntent | undefined;
  let consumed = false;
  const matches = (entry: PublicationIntent, request: PullRequestPublication) =>
    entry.attemptId === work.attempt &&
    entry.branch === request.branch &&
    entry.baseBranch === request.base &&
    entry.headSha === request.headSha &&
    entry.treeSha === request.treeSha &&
    entry.titleDigest === digest(request.title) &&
    entry.bodyDigest === digest(request.body);
  const assertRequest = (request: PullRequestPublication) => {
    assertCurrent();
    if (
      request.headSha !== work.changeRef ||
      request.treeSha !== work.treeSha ||
      state.work[itemId] !== work ||
      !request.branch ||
      !request.base
    )
      throw fenced(
        "Publication request differs from the exact reviewed result",
      );
    const bound = retained ?? created;
    if (bound && !matches(bound, request))
      throw fenced(
        "Unresolved/retained publication request differs from this delivery; no new effects are permitted",
      );
  };
  const record = (
    request: PullRequestPublication,
    submission: PublicationIntent["submission"],
  ): PublicationIntent => {
    assertCurrent();
    if (history.length >= MAX_INTENTS)
      throw fenced(
        "Publication request history is full; unknown or observed entries cannot be evicted",
      );
    const intent: PublicationIntent = {
      repository: state.repository,
      runId: state.runId,
      configDigest: state.configDigest,
      itemId,
      attemptId: work.attempt!,
      branch: request.branch,
      baseBranch: request.base,
      headSha: request.headSha,
      treeSha: request.treeSha,
      titleDigest: digest(request.title),
      bodyDigest: digest(request.body),
      recordedAt: new Date().toISOString(),
      submission,
    };
    state.publicationIntents ??= {};
    state.publicationIntents[itemId] = history;
    history.push(intent);
    advanceHistory();
    return intent;
  };
  return {
    get reconcileOnly() {
      assertCurrent();
      return Boolean(retained || created || consumed);
    },
    get expectedPublication() {
      assertCurrent();
      return retained
        ? {
            titleDigest:
              retained.observation?.publication.titleDigest ??
              retained.titleDigest,
            bodyDigest:
              retained.observation?.publication.bodyDigest ??
              retained.bodyDigest,
          }
        : undefined;
    },
    assertRequest,
    beforeCreate(request) {
      assertRequest(request);
      if (retained || created || consumed)
        throw fenced(
          "Publication create permit is unavailable or already consumed",
        );
      consumed = true;
      created = record(request, "possibly-submitted");
      save(); // Only this invocation after successful atomic save may dispatch once.
    },
    observed(request, identity) {
      assertRequest(request);
      if (
        identity.branch !== request.branch ||
        identity.headSha !== request.headSha ||
        !Number.isSafeInteger(identity.number) ||
        identity.number < 1
      )
        throw fenced(
          "Publication observation is not the exact requested PR identity",
        );
      const intent =
        retained ?? created ?? record(request, "observed-without-create");
      if (intent.observation && intent.observation.number !== identity.number)
        throw fenced("Publication observation changed PR identity");
      const publication = identity.publication;
      if (
        !publication ||
        publication.repository !== state.repository ||
        publication.baseBranch !== request.base ||
        (intent.submission === "possibly-submitted" &&
          (publication.titleDigest !== intent.titleDigest ||
            publication.bodyDigest !== intent.bodyDigest))
      )
        throw fenced(
          "PR observation lacks exact recorded publication metadata",
        );
      if (
        intent.observation &&
        (intent.observation.publication.titleDigest !==
          publication.titleDigest ||
          intent.observation.publication.bodyDigest !== publication.bodyDigest)
      )
        throw fenced("Recorded PR metadata changed during reconciliation");
      intent.observation = {
        number: identity.number,
        branch: identity.branch,
        headSha: identity.headSha,
        observedAt: new Date().toISOString(),
        publication,
      };
      advanceHistory();
      save(); // Persist positive binding before ordinary published/delivery state.
    },
  };
}

/** Existing observed-closed PR retry can retire only that known observed identity. */
export function confirmClosedPublication(
  state: FactoryState,
  itemId: string,
  number: number,
): void {
  const entry = state.publicationIntents?.[itemId]
    ?.slice()
    .reverse()
    .find((intent) => intent.observation?.number === number);
  const work = state.work[itemId];
  if (
    state.publicationContract !== "exact-request-v1" ||
    !entry?.observation ||
    work?.status !== "published" ||
    work.pullRequest !== number ||
    work.closedPullRequest !== number
  )
    throw fenced(
      "Closed PR retry lacks its recorded observed publication identity",
    );
  entry.closedConfirmedAt = new Date().toISOString();
}
