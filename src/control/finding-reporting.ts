import type { FindingEvent } from "../protocol/events.js";
import {
  FindingDestinationSchema,
  FindingOccurrenceSchema,
  FindingReportingPolicySchema,
  canonicalFinding,
  findingCommonCauseMarker,
  findingCommonCauseIdentity,
  findingIdentity,
  findingMarker,
  findingReportDigest,
  isFindingSafeForPublicReport,
  renderFindingIssue,
  validateFindingCandidate,
  type FindingCandidate,
  type FindingClassification,
  type FindingDestination,
  type FindingDisposition,
  type FindingOccurrence,
  type FindingReportingPolicy,
} from "../protocol/findings.js";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export interface FindingIssueObservation {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  state: "open" | "closed";
  author: string;
  body: string;
}

export interface FindingDestinationProbe {
  repository: string;
  audience: "private" | "public";
  issuesEnabled: boolean;
  canCreateIssue: boolean;
  blankIssuesEnabled: boolean;
}

export interface FindingCommentObservation {
  id: string;
  author: string;
  body: string;
}

/** Implementations must use the shared authenticated GitHub scheduler/circuit/rate controls. */
export interface FindingReportingPort {
  authenticatedLogin(): Promise<string>;
  probe(destination: FindingDestination): Promise<FindingDestinationProbe>;
  findByMarker(args: {
    destination: FindingDestination;
    marker: string;
    limit: number;
  }): Promise<FindingIssueObservation[]>;
  createIssue(args: {
    destination: FindingDestination;
    title: string;
    body: string;
  }): Promise<FindingIssueObservation>;
  findEvidenceComments(args: {
    destination: FindingDestination;
    issueNumber: number;
    marker: string;
    limit: number;
  }): Promise<FindingCommentObservation[]>;
  commentEvidence(args: {
    destination: FindingDestination;
    issueNumber: number;
    body: string;
  }): Promise<FindingCommentObservation>;
}

type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
  mutating?: boolean,
) => Promise<{ status: number; data: unknown }>;

const destinationParts = (destination: FindingDestination) => {
  const [owner, repo] = destination.repository.split("/");
  if (!owner || !repo) throw new Error("invalid finding destination");
  return { owner, repo };
};

/** GitHub adapter for the Supervisor's existing fenced stackRequest transport. */
export class GitHubFindingReportingPort implements FindingReportingPort {
  readonly #request: GitHubRequest;

  constructor(request: GitHubRequest) {
    this.#request = request;
  }

  async authenticatedLogin(): Promise<string> {
    const response = await this.#request("GET /user", {});
    const login = (response.data as { login?: unknown }).login;
    if (typeof login !== "string" || !login) throw new Error("GitHub omitted authenticated login");
    return login;
  }

  async probe(destination: FindingDestination): Promise<FindingDestinationProbe> {
    const target = FindingDestinationSchema.parse(destination);
    const { owner, repo } = destinationParts(target);
    const response = await this.#request("GET /repos/{owner}/{repo}", { owner, repo });
    const data = response.data as {
      full_name?: unknown;
      visibility?: unknown;
      private?: unknown;
      has_issues?: unknown;
      permissions?: { pull?: unknown; push?: unknown; maintain?: unknown; admin?: unknown };
    };
    const audience = data.private === true || data.visibility === "private" ? "private" : "public";
    let blankIssuesEnabled = true;
    try {
      const config = await this.#request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: ".github/ISSUE_TEMPLATE/config.yml",
      });
      const encoded = (config.data as { content?: unknown }).content;
      if (typeof encoded !== "string") throw new Error("issue template config omitted content");
      const parsed = parseYaml(
        Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8"),
      ) as {
        blank_issues_enabled?: unknown;
      };
      blankIssuesEnabled = parsed?.blank_issues_enabled !== false;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return {
      repository: String(data.full_name ?? "").toLowerCase(),
      audience,
      issuesEnabled: data.has_issues === true,
      canCreateIssue: Boolean(
        data.permissions?.pull ||
          data.permissions?.push ||
          data.permissions?.maintain ||
          data.permissions?.admin,
      ),
      blankIssuesEnabled,
    };
  }

  async findByMarker(args: {
    destination: FindingDestination;
    marker: string;
    limit: number;
  }): Promise<FindingIssueObservation[]> {
    const target = FindingDestinationSchema.parse(args.destination);
    const { owner, repo } = destinationParts(target);
    const identity = /\b(?:id|cause)=([a-f0-9]{64})\b/.exec(args.marker)?.[1];
    if (!identity) throw new Error("finding marker omitted its identity");
    const response = await this.#request("GET /search/issues", {
      q: `repo:${target.repository} in:body ${identity}`,
      per_page: Math.min(20, Math.max(1, args.limit)),
    });
    const items = (response.data as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new Error("GitHub finding search omitted items");
    return items.flatMap((raw) => {
      const item = raw as Record<string, unknown>;
      const user = item.user as { login?: unknown } | undefined;
      const repositoryUrl = String(item.repository_url ?? "");
      const expectedSuffix = `/repos/${owner}/${repo}`.toLowerCase();
      if (
        !repositoryUrl.toLowerCase().endsWith(expectedSuffix) ||
        typeof item.number !== "number" ||
        typeof item.node_id !== "string" ||
        typeof item.html_url !== "string" ||
        typeof item.body !== "string" ||
        typeof user?.login !== "string" ||
        !["open", "closed"].includes(String(item.state))
      )
        return [];
      return [
        {
          repository: target.repository,
          number: item.number,
          nodeId: item.node_id,
          url: item.html_url,
          state: item.state as "open" | "closed",
          author: user.login,
          body: item.body,
        },
      ];
    });
  }

  async createIssue(args: {
    destination: FindingDestination;
    title: string;
    body: string;
  }): Promise<FindingIssueObservation> {
    const target = FindingDestinationSchema.parse(args.destination);
    const { owner, repo } = destinationParts(target);
    const response = await this.#request(
      "POST /repos/{owner}/{repo}/issues",
      { owner, repo, title: args.title, body: args.body },
      true,
    );
    const item = response.data as Record<string, unknown>;
    const user = item.user as { login?: unknown } | undefined;
    if (
      typeof item.number !== "number" ||
      typeof item.node_id !== "string" ||
      typeof item.html_url !== "string" ||
      typeof item.body !== "string" ||
      typeof user?.login !== "string"
    )
      throw new Error("GitHub create issue response omitted exact finding identity");
    return {
      repository: target.repository,
      number: item.number,
      nodeId: item.node_id,
      url: item.html_url,
      state: String(item.state) === "closed" ? "closed" : "open",
      author: user.login,
      body: item.body,
    };
  }

  async findEvidenceComments(args: {
    destination: FindingDestination;
    issueNumber: number;
    marker: string;
    limit: number;
  }): Promise<FindingCommentObservation[]> {
    const target = FindingDestinationSchema.parse(args.destination);
    const { owner, repo } = destinationParts(target);
    const response = await this.#request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: args.issueNumber,
        per_page: Math.min(20, Math.max(1, args.limit)),
      },
    );
    if (!Array.isArray(response.data)) throw new Error("GitHub finding comments omitted items");
    return response.data.flatMap((raw) => {
      const item = raw as Record<string, unknown>;
      const user = item.user as { login?: unknown } | undefined;
      if (
        typeof item.id !== "number" ||
        typeof item.body !== "string" ||
        typeof user?.login !== "string" ||
        !item.body.includes(args.marker)
      )
        return [];
      return [{ id: String(item.id), author: user.login, body: item.body }];
    });
  }

  async commentEvidence(args: {
    destination: FindingDestination;
    issueNumber: number;
    body: string;
  }): Promise<FindingCommentObservation> {
    const target = FindingDestinationSchema.parse(args.destination);
    const { owner, repo } = destinationParts(target);
    const response = await this.#request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: args.issueNumber, body: args.body },
      true,
    );
    const item = response.data as Record<string, unknown>;
    const user = item.user as { login?: unknown } | undefined;
    if (
      typeof item.id !== "number" ||
      typeof item.body !== "string" ||
      typeof user?.login !== "string"
    )
      throw new Error("GitHub finding comment response omitted exact evidence identity");
    return { id: String(item.id), author: user.login, body: item.body };
  }
}

export type FindingRecord = Omit<
  FindingEvent,
  "protocol" | "kind" | "objective" | "runId" | "sequence" | "at"
>;

export interface FindingJournal {
  /** Fresh authenticated source-Objective evidence. Absence is never cached as authority. */
  read(): Promise<readonly FindingEvent[]>;
  /** The owner adds current writer authority and atomically appends to authenticated Objective history. */
  append(record: FindingRecord): Promise<void>;
}

export function classifyFinding(input: {
  criterionOwnedByWorkItem: boolean;
  repairWithinExistingAuthority: boolean;
  preventsObjectiveAcceptance: boolean;
  safeToReport: boolean;
  reportingAvailable: boolean;
  allowanceRemaining: boolean;
}): FindingClassification {
  if (!input.safeToReport) return "reporting-refused";
  if (input.criterionOwnedByWorkItem && input.repairWithinExistingAuthority)
    return "in-scope-repair";
  if (!input.reportingAvailable) return "issue-ready";
  if (!input.allowanceRemaining) return "reporting-limit";
  return input.preventsObjectiveAcceptance ? "objective-blocker" : "nonblocking-follow-up";
}

export type FindingLifecycleDisposition = "in-scope-repair" | "blocking" | "follow-up";

/** Trusted lifecycle facts choose owner and blocking state; candidates never do. */
export function decideFindingAtSupervisor(input: {
  candidate: FindingCandidate;
  lifecycle: FindingLifecycleDisposition;
  currentRepository: string;
  policy?: FindingReportingPolicy | undefined;
}): { destination: string; classification: FindingClassification } {
  const candidate = validateFindingCandidate(input.candidate);
  const destination =
    candidate.phase === "compiler" || candidate.phase === "supervisor"
      ? "clockgrove/factory"
      : input.currentRepository.toLowerCase();
  const authority = input.policy?.destinations.find((item) => item.repository === destination);
  return {
    destination,
    classification: classifyFinding({
      criterionOwnedByWorkItem: input.lifecycle === "in-scope-repair",
      repairWithinExistingAuthority: input.lifecycle === "in-scope-repair",
      preventsObjectiveAcceptance: input.lifecycle === "blocking",
      safeToReport: authority?.audience !== "public" || isFindingSafeForPublicReport(candidate),
      reportingAvailable: Boolean(authority?.operations.includes("create-issue")),
      allowanceRemaining: (input.policy?.maxPublicationWrites ?? 0) > 0,
    }),
  };
}

function candidateDigest(candidate: FindingCandidate): string {
  return createHash("sha256")
    .update(canonicalFinding(validateFindingCandidate(candidate)))
    .digest("hex");
}

function finalRecord(input: {
  base: Omit<FindingRecord, "event" | "reportDigest" | "disposition" | "reasonCode">;
  reportDigest: string;
  disposition: FindingDisposition;
  reasonCode: NonNullable<FindingRecord["reasonCode"]>;
  issue?: FindingIssueObservation;
}): FindingRecord {
  return {
    ...input.base,
    event: "FindingDisposition",
    reportDigest: input.reportDigest,
    disposition: input.disposition,
    reasonCode: input.reasonCode,
    ...(input.issue
      ? {
          issueNumber: input.issue.number,
          issueNodeId: input.issue.nodeId,
          issueUrl: input.issue.url,
        }
      : {}),
  };
}

const exactIssue = (
  observations: FindingIssueObservation[],
  destination: FindingDestination,
  expectedBody: string,
  authenticatedLogin: string,
) =>
  observations.find(
    (issue) =>
      issue.repository.toLowerCase() === destination.repository &&
      issue.body === expectedBody &&
      issue.nodeId.length > 0 &&
      issue.author.toLowerCase() === authenticatedLogin.toLowerCase(),
  );

const exactComment = (
  observations: FindingCommentObservation[],
  expectedBody: string,
  authenticatedLogin: string,
) =>
  observations.find(
    (comment) =>
      comment.body === expectedBody &&
      comment.author.toLowerCase() === authenticatedLogin.toLowerCase(),
  );

export class FindingReporter {
  readonly #port: FindingReportingPort;
  readonly #journal: FindingJournal;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(port: FindingReportingPort, journal: FindingJournal) {
    this.#port = port;
    this.#journal = journal;
  }

  async report(input: {
    policy?: FindingReportingPolicy | undefined;
    destination: string;
    candidate: FindingCandidate;
    classification: FindingClassification;
    occurrence: FindingOccurrence;
    priorEvents: readonly FindingEvent[];
  }): Promise<FindingDisposition> {
    const candidate = validateFindingCandidate(input.candidate);
    const occurrence = FindingOccurrenceSchema.parse(input.occurrence);
    const policy = input.policy ? FindingReportingPolicySchema.parse(input.policy) : undefined;
    const destinationAuthority = policy?.destinations.find(
      (item) => item.repository === input.destination,
    );
    const id = findingIdentity(input.destination, candidate);
    const lockId = findingCommonCauseIdentity(candidate) ?? id;
    const running = this.#locks.get(lockId) ?? Promise.resolve();
    const classification =
      destinationAuthority?.audience === "public" && !isFindingSafeForPublicReport(candidate)
        ? "reporting-refused"
        : input.classification;
    const result = running.then(() =>
      this.#reportOne({
        ...input,
        candidate,
        classification,
        occurrence,
        policy,
        destinationAuthority,
        findingId: id,
      }),
    );
    this.#locks.set(lockId, result);
    try {
      return await result;
    } finally {
      if (this.#locks.get(lockId) === result) this.#locks.delete(lockId);
    }
  }

  async #reportOne(input: {
    policy?: FindingReportingPolicy | undefined;
    destinationAuthority?: FindingDestination | undefined;
    destination: string;
    candidate: FindingCandidate;
    classification: FindingClassification;
    occurrence: FindingOccurrence;
    priorEvents: readonly FindingEvent[];
    findingId: string;
  }): Promise<FindingDisposition> {
    const destinationAuthority = input.destinationAuthority
      ? FindingDestinationSchema.safeParse(input.destinationAuthority)
      : undefined;
    const reportDigest = findingReportDigest({
      destination: input.destination,
      candidate: input.candidate,
      classification: input.classification,
      occurrence: input.occurrence,
    });
    const base = {
      findingId: input.findingId,
      ...(findingCommonCauseIdentity(input.candidate)
        ? { commonCauseId: findingCommonCauseIdentity(input.candidate) }
        : {}),
      ...(input.occurrence.workItem ? { workItem: input.occurrence.workItem } : {}),
      ...(input.occurrence.attempt ? { attempt: input.occurrence.attempt } : {}),
      destination: input.destination,
      phase: input.candidate.phase,
      candidateDigest: candidateDigest(input.candidate),
      evidence: input.candidate.evidence,
      classification: input.classification,
    } satisfies Omit<FindingRecord, "event" | "reportDigest" | "disposition" | "reasonCode">;

    const sourceEvents = [
      ...new Map(
        [...input.priorEvents, ...(await this.#journal.read())].map((event) => [
          `${event.objective}:${event.runId}:${event.sequence}:${event.event}`,
          event,
        ]),
      ).values(),
    ];
    const prior = [...sourceEvents]
      .reverse()
      .find(
        (event) =>
          event.findingId === input.findingId &&
          event.event === "FindingDisposition" &&
          event.reportDigest === reportDigest,
      );
    const priorIntent = sourceEvents.some(
      (event) => event.event === "FindingPublicationIntent" && event.reportDigest === reportDigest,
    );
    const reconcileAmbiguousCreate =
      prior?.disposition === "issue-ready" &&
      prior.reasonCode === "ambiguous-transport" &&
      priorIntent &&
      sourceEvents.some(
        (event) =>
          event.event === "FindingPublicationIntent" &&
          event.reportDigest === reportDigest &&
          event.operation === "create-issue",
      );
    if (prior?.disposition && !reconcileAmbiguousCreate) return prior.disposition;

    if (!prior) await this.#journal.append({ ...base, event: "FindingDecision" });
    const settle = async (
      disposition: FindingDisposition,
      reasonCode: FindingRecord["reasonCode"],
      issue?: FindingIssueObservation,
    ) => {
      await this.#journal.append(
        finalRecord({
          base,
          reportDigest,
          disposition,
          reasonCode: reasonCode!,
          ...(issue ? { issue } : {}),
        }),
      );
      return disposition;
    };
    if (input.classification === "in-scope-repair") return settle("repaired", "repaired");
    if (input.classification === "reporting-refused")
      return settle("reporting-refused", "unsafe-content");
    if (input.classification === "issue-ready") return settle("issue-ready", "no-authority");
    if (
      !input.policy ||
      !destinationAuthority?.success ||
      !destinationAuthority.data.operations.includes("create-issue")
    )
      return settle("issue-ready", "no-authority");

    const writes = sourceEvents.filter(
      (event) =>
        event.event === "FindingPublicationIntent" && event.runId === input.occurrence.runId,
    ).length;
    const marker = findingMarker(input.findingId, reportDigest);
    const rendered = renderFindingIssue({
      findingId: input.findingId,
      reportDigest,
      candidate: input.candidate,
      classification: input.classification,
      occurrence: input.occurrence,
    });
    if (reconcileAmbiguousCreate) {
      try {
        const authenticatedLogin = await this.#port.authenticatedLogin();
        const observed = exactIssue(
          await this.#port.findByMarker({
            destination: destinationAuthority.data,
            marker,
            limit: 20,
          }),
          destinationAuthority.data,
          rendered.body,
          authenticatedLogin,
        );
        if (observed) return settle("issue-filed", "filed", observed);
      } catch {
        // An unproven absence or unavailable read never authorizes a second create.
      }
      return "issue-ready";
    }
    let authenticatedLogin: string;
    let observed: FindingIssueObservation | undefined;
    let sameFinding: FindingIssueObservation | undefined;
    try {
      authenticatedLogin = await this.#port.authenticatedLogin();
      const observations = await this.#port.findByMarker({
        destination: destinationAuthority.data,
        marker,
        limit: 20,
      });
      observed = exactIssue(
        observations,
        destinationAuthority.data,
        rendered.body,
        authenticatedLogin,
      );
      sameFinding = observations.find(
        (issue) =>
          issue.repository.toLowerCase() === destinationAuthority.data.repository &&
          issue.nodeId.length > 0 &&
          issue.author.toLowerCase() === authenticatedLogin.toLowerCase() &&
          issue.body.includes(`id=${input.findingId}`),
      );
    } catch (error) {
      if (
        sourceEvents.some(
          (event) =>
            event.event === "FindingPublicationIntent" && event.reportDigest === reportDigest,
        )
      )
        return settle("issue-ready", "ambiguous-transport");
      const status = (error as { status?: number }).status;
      return settle(
        "issue-ready",
        status === 429
          ? "rate-limited"
          : status === 403
            ? "permission-denied"
            : "destination-unavailable",
      );
    }
    if (observed) return settle("existing-issue-linked", "duplicate", observed);
    if (
      sourceEvents.some(
        (event) =>
          event.event === "FindingPublicationIntent" && event.reportDigest === reportDigest,
      )
    )
      return settle("issue-ready", "ambiguous-transport");

    if (sameFinding) {
      if (sameFinding.state === "closed") return settle("issue-ready", "closed-recurrence");
      if (!destinationAuthority.data.operations.includes("comment-evidence"))
        return settle("existing-issue-linked", "duplicate", sameFinding);
      const evidenceBody = `## Additional Factory evidence\n\n${rendered.body}`;
      let existingComment: FindingCommentObservation | undefined;
      try {
        existingComment = exactComment(
          await this.#port.findEvidenceComments({
            destination: destinationAuthority.data,
            issueNumber: sameFinding.number,
            marker,
            limit: 20,
          }),
          evidenceBody,
          authenticatedLogin,
        );
      } catch (error) {
        return settle(
          "issue-ready",
          (error as { status?: number }).status === 429
            ? "rate-limited"
            : "destination-unavailable",
        );
      }
      if (existingComment) return settle("existing-issue-linked", "duplicate", sameFinding);
      if (writes >= input.policy.maxPublicationWrites)
        return settle("reporting-limit", "reporting-limit");
      await this.#journal.append({
        ...base,
        event: "FindingPublicationIntent",
        reportDigest,
        operation: "comment-evidence",
      });
      try {
        const comment = await this.#port.commentEvidence({
          destination: destinationAuthority.data,
          issueNumber: sameFinding.number,
          body: evidenceBody,
        });
        if (!exactComment([comment], evidenceBody, authenticatedLogin))
          return settle("issue-ready", "ambiguous-transport");
        return settle("existing-issue-linked", "duplicate", sameFinding);
      } catch {
        const reconciled = await this.#port
          .findEvidenceComments({
            destination: destinationAuthority.data,
            issueNumber: sameFinding.number,
            marker,
            limit: 20,
          })
          .then((comments) => exactComment(comments, evidenceBody, authenticatedLogin))
          .catch(() => undefined);
        return reconciled
          ? settle("existing-issue-linked", "duplicate", sameFinding)
          : settle("issue-ready", "ambiguous-transport");
      }
    }

    const commonCauseId = findingCommonCauseIdentity(input.candidate);
    if (commonCauseId) {
      let commonIssue: FindingIssueObservation | undefined;
      try {
        const causeMarker = findingCommonCauseMarker(commonCauseId);
        commonIssue = (
          await this.#port.findByMarker({
            destination: destinationAuthority.data,
            marker: causeMarker,
            limit: 20,
          })
        ).find(
          (issue) =>
            issue.repository.toLowerCase() === destinationAuthority.data.repository &&
            issue.author.toLowerCase() === authenticatedLogin.toLowerCase() &&
            issue.body.includes(causeMarker),
        );
      } catch (error) {
        const status = (error as { status?: number }).status;
        return settle("issue-ready", status === 429 ? "rate-limited" : "destination-unavailable");
      }
      if (commonIssue) {
        if (commonIssue.state === "closed") return settle("issue-ready", "closed-recurrence");
        if (!destinationAuthority.data.operations.includes("comment-evidence"))
          return settle("issue-ready", "no-authority");
        const evidenceBody = `## Additional Factory evidence\n\n${rendered.body}`;
        let existingComment: FindingCommentObservation | undefined;
        try {
          existingComment = exactComment(
            await this.#port.findEvidenceComments({
              destination: destinationAuthority.data,
              issueNumber: commonIssue.number,
              marker,
              limit: 20,
            }),
            evidenceBody,
            authenticatedLogin,
          );
        } catch (error) {
          return settle(
            "issue-ready",
            (error as { status?: number }).status === 429
              ? "rate-limited"
              : "destination-unavailable",
          );
        }
        if (existingComment) return settle("existing-issue-linked", "duplicate", commonIssue);
        if (writes >= input.policy.maxPublicationWrites)
          return settle("reporting-limit", "reporting-limit");
        await this.#journal.append({
          ...base,
          event: "FindingPublicationIntent",
          reportDigest,
          operation: "comment-evidence",
        });
        try {
          const comment = await this.#port.commentEvidence({
            destination: destinationAuthority.data,
            issueNumber: commonIssue.number,
            body: evidenceBody,
          });
          if (!exactComment([comment], evidenceBody, authenticatedLogin))
            return settle("issue-ready", "ambiguous-transport");
          return settle("existing-issue-linked", "duplicate", commonIssue);
        } catch {
          const reconciled = await this.#port
            .findEvidenceComments({
              destination: destinationAuthority.data,
              issueNumber: commonIssue.number,
              marker,
              limit: 20,
            })
            .then((comments) => exactComment(comments, evidenceBody, authenticatedLogin))
            .catch(() => undefined);
          return reconciled
            ? settle("existing-issue-linked", "duplicate", commonIssue)
            : settle("issue-ready", "ambiguous-transport");
        }
      }
    }
    if (input.classification === "reporting-limit" || writes >= input.policy.maxPublicationWrites)
      return settle("reporting-limit", "reporting-limit");

    let probe: FindingDestinationProbe;
    try {
      probe = await this.#port.probe(destinationAuthority.data);
    } catch (error) {
      const status = (error as { status?: number }).status;
      return settle(
        "issue-ready",
        status === 429
          ? "rate-limited"
          : status === 403
            ? "permission-denied"
            : "destination-unavailable",
      );
    }
    if (
      probe.repository.toLowerCase() !== destinationAuthority.data.repository ||
      probe.audience !== destinationAuthority.data.audience ||
      !probe.issuesEnabled
    )
      return settle("issue-ready", "destination-unavailable");
    if (!probe.canCreateIssue) return settle("issue-ready", "permission-denied");
    if (!probe.blankIssuesEnabled) return settle("issue-ready", "template-required");

    await this.#journal.append({
      ...base,
      event: "FindingPublicationIntent",
      reportDigest,
      operation: "create-issue",
    });
    try {
      const created = await this.#port.createIssue({
        destination: destinationAuthority.data,
        ...rendered,
      });
      const exact = exactIssue(
        [created],
        destinationAuthority.data,
        rendered.body,
        authenticatedLogin,
      );
      if (!exact) return settle("issue-ready", "ambiguous-transport");
      return settle("issue-filed", "filed", exact);
    } catch (error) {
      // The request may have committed. Reconcile once by the exact marker; never blindly replay.
      const reconciled = await this.#port
        .findByMarker({
          destination: destinationAuthority.data,
          marker,
          limit: 20,
        })
        .then((issues) =>
          exactIssue(issues, destinationAuthority.data, rendered.body, authenticatedLogin),
        )
        .catch(() => undefined);
      if (reconciled) return settle("issue-filed", "filed", reconciled);
      const status = (error as { status?: number }).status;
      if (status === 429) return settle("issue-ready", "rate-limited");
      if (status === 403) return settle("issue-ready", "permission-denied");
      if (status === 404) return settle("issue-ready", "destination-unavailable");
      if (status === 422) return settle("issue-ready", "template-required");
      return settle("issue-ready", "ambiguous-transport");
    }
  }
}
