import { createHash } from "node:crypto";
import type {
  GitHubGateway,
  IntakeIssuePage,
  GraphProjection,
  MergeResult,
  NamedCheckEvidence,
  NativeStackLayer,
  ObjectiveIssue,
  ProjectedGraph,
  PullRequestIdentity,
  PullRequestObservation,
  PullRequestPublication,
  WorkItem,
} from "./contracts.js";
import * as time from "./clock.js";
import { notYet, settled } from "./delivery/lag.js";
import type { NativeStackDelivery } from "./delivery/native-stack.js";
import { deliveryReadiness } from "./delivery/readiness.js";
import { availableIssueType } from "./issue-type.js";
import { attachedFault, attachFault, decision, transient } from "./fault.js";
import {
  classifiedGitHubCall,
  type GitHubClient,
  type GitHubCall,
  GITHUB_LAG_MS,
  gitHubFault,
  GitHubRequestError,
  MERGE_COMMITS_REQUIRED,
  sharedGitHubClient,
  timelineMergeCommit,
} from "./github-client.js";

type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  pull_request?: unknown;
  labels?: (string | { name?: string })[];
  repository_url?: string;
  user?: { login?: string } | null;
  state_reason?: string | null;
  closed_at?: string | null;
  comments?: number;
};
type Pull = {
  number: number;
  state: string;
  merged: boolean;
  closed_at?: string | null;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  head: { sha: string; ref: string; repo?: { full_name?: string } | null };
  base: { ref: string; repo?: { full_name?: string } | null };
};

export function projectedIssueBody(item: WorkItem, objective: number): string {
  const marker = `<!-- factory:objective=${objective};item=${item.id} -->`;
  return `${marker}\n\n## Goal\n${item.goal}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join("\n")}\n\n## Non-goals\n${item.nonGoals.map((a) => `- ${a}`).join("\n")}\n\n## Dependencies\n${item.dependencies.length ? item.dependencies.map((id) => `- ${id}`).join("\n") : "- None"}\n\n## Sources\n${item.citations.map((c) => `- ${c.path}${c.heading ? ` — ${c.heading}` : ""}`).join("\n")}\n\n## Owned paths\n${item.ownedPaths.map((p) => `- ${p}`).join("\n")}\n\n## Validation\n${item.validation.map((check) => `- \`${check.command}\` (${check.provenance}${check.source ? `: ${check.source}` : ""})`).join("\n")}\n\n## Brief\n${item.brief}${item.executionBinding ? `\n\n## Assigned execution profile\n${JSON.stringify(item.executionProfile)}\n\nResolved binding: ${JSON.stringify(item.executionBinding)}` : ""}`;
}

/**
 * GitHub no longer matches what Factory recorded. Ownership is not checked
 * here, so the operator decides.
 */
function foreignChange(message: string): Error {
  return attachFault(
    new Error(message),
    decision(
      "GitHub no longer matches what Factory recorded. Inspect it, then retry or cancel.",
      message,
    ),
  );
}

const latest = (...times: (number | undefined)[]): number | undefined => {
  const known = times.filter((time): time is number => time !== undefined);
  return known.length ? Math.max(...known) : undefined;
};

/** Empty issue numbers in a row past the newest listed issue that end a probe. */
const PROBE_GAP = 3;

/**
 * A list that has not caught up yet, where the caller bounds the repeat
 * itself: closure-comment visibility only within the lag window after close.
 */
function listedSoon(message: string): Error {
  return attachFault(new Error(message), transient(message, false));
}

/**
 * A readback of Factory's own object has not caught up with a write GitHub
 * accepted: transient for GitHub's lag window, then the operator's decision,
 * so a human edit that keeps it from matching never repeats for 24 h (#613).
 * The key names the object; the success path calls `settled(key)`, or a
 * stale window makes the next lag an immediate decision.
 */
function stillLagging(key: string, message: string): Error {
  return notYet(
    key,
    message,
    decision(
      "GitHub does not show what Factory wrote. Inspect it, then retry or cancel.",
      message,
    ),
  );
}

/** A create answered with something unreadable: it may exist; find it again. */
function unverifiedCreate(message: string): Error {
  return attachFault(new Error(message), transient(message, true));
}

export class RealGitHubGateway implements GitHubGateway {
  constructor(
    readonly repository: string,
    private readonly native: NativeStackDelivery,
    private readonly client: GitHubClient = sharedGitHubClient,
  ) {}

  private login?: string;

  /**
   * The token's login, when GitHub tells it. Only consulted until Factory
   * has recorded the author of its first issue; an App token has no user
   * (403), which is not a permission problem: its bot is named through
   * GraphQL instead, so ownership is known before the first create.
   */
  private async viewer(): Promise<string | undefined> {
    if (this.login) return this.login;
    try {
      this.login = await this.client.viewer();
    } catch (error) {
      // Classified here, not by the generic gateway call: that would turn
      // the App token's 403 into a permission fault. A rate limit stays one.
      if (
        error instanceof GitHubRequestError &&
        [403, 404].includes(error.status) &&
        attachedFault(error)?.kind !== "transient"
      ) {
        // An App token names its bot through GraphQL, so ownership is known
        // before the first create. If that is refused too, the first create
        // records the author, as before.
        try {
          this.login = await this.client.appViewer();
        } catch (fallback) {
          if (attachedFault(fallback)?.kind === "transient") throw fallback;
        }
        return this.login;
      }
      throw attachFault(
        error,
        gitHubFault(error, { method: "GET", path: "user" }),
      );
    }
    return this.login;
  }

  /**
   * One issue (or PR) by number, or undefined when GitHub has none there: a
   * gap, a deleted or transferred issue (410), or a Discussion.
   */
  private issueIfExists(number: number): Promise<Issue | undefined> {
    return classifiedGitHubCall(
      this.client,
      this.repository,
      { method: "GET", path: `issues/${number}` },
      () =>
        this.client
          .request<Issue>("GET", this.route(`issues/${number}`))
          .catch((error: unknown) => {
            if (
              error instanceof GitHubRequestError &&
              [404, 410].includes(error.status)
            )
              return undefined;
            throw error;
          }),
    );
  }

  /**
   * Issues with this Objective's Work Item markers that Factory authored:
   * listed by creator when the author is known (oldest first, so issues
   * opened during the scan land on the last page, and deduplicated by id),
   * else every issue. GitHub's lists lag creation while single-issue reads
   * do not, so numbers past the repository's newest listed issue are read
   * until PROBE_GAP in a row hold none: an issue whose create response was
   * lost is found before the lists show it.
   */
  private async ownedWorkItemIssues(
    objective: number,
    author: string | undefined,
  ): Promise<Issue[]> {
    const byId = new Map<number, Issue>();
    for (const issue of await this.pages<Issue>(
      `issues?state=all${author ? `&creator=${encodeURIComponent(author)}` : ""}&sort=created&direction=asc`,
    ))
      byId.set(issue.id, issue);
    const [newest] = await this.api<Issue[]>(
      "GET",
      "issues?state=all&sort=created&direction=desc&per_page=1&page=1",
    );
    // The paginated list can lag; the newest-issue read is fresh. Keep what it
    // returned, or the probe below starts past it and never sees it (#621).
    if (newest) byId.set(newest.id, newest);
    let number = Math.max(
      0,
      newest?.number ?? 0,
      ...[...byId.values()].map((issue) => issue.number),
    );
    for (let misses = 0; misses < PROBE_GAP; ) {
      const issue = await this.issueIfExists(++number);
      if (!issue) misses++;
      else {
        misses = 0;
        byId.set(issue.id, issue);
      }
    }
    const prefix = `<!-- factory:objective=${objective};item=`;
    return [...byId.values()]
      .filter(
        (issue) =>
          !issue.pull_request &&
          (author === undefined || issue.user?.login === author) &&
          (issue.body ?? "").includes(prefix),
      )
      .sort((left, right) => left.number - right.number);
  }

  /**
   * Add one dependency or sub-issue link. GitHub answers a duplicate link
   * with 422, which is also how a repeat sees the link a lost response made:
   * the list is read back, and the link that is there is done (#628).
   */
  private async linked(
    post: () => Promise<unknown>,
    list: string,
    id: number,
    call: Omit<GitHubCall, "method" | "path">,
  ): Promise<void> {
    try {
      await post();
    } catch (error) {
      if (
        error instanceof GitHubRequestError &&
        error.status === 422 &&
        (await this.pages<Issue>(list, call)).some((issue) => issue.id === id)
      )
        return;
      throw error;
    }
  }

  private route(path: string): string {
    return `repos/${this.repository}/${path}`;
  }

  /** One repository request, classified with what this gateway knows about it. */
  private api<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    observation?: { etag?: string },
    call: Omit<GitHubCall, "method" | "path"> = {},
  ): Promise<T> {
    return classifiedGitHubCall(
      this.client,
      this.repository,
      { method, path, ...call },
      () => this.client.request<T>(method, this.route(path), body, observation),
    );
  }

  private pages<T>(
    path: string,
    call: Omit<GitHubCall, "method" | "path"> = {},
  ): Promise<T[]> {
    return classifiedGitHubCall(
      this.client,
      this.repository,
      { method: "GET", path, ...call },
      () => this.client.paginate<T>(this.route(path)),
    );
  }

  async namedCheck(
    headSha: string,
    name: string,
  ): Promise<NamedCheckEvidence | undefined> {
    if (!/^[a-f0-9]{40}$/.test(headSha) || !name)
      throw new Error(
        "Named CI observation requires an exact candidate and check name",
      );
    type CheckRun = {
      id: number;
      name: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      html_url: string;
    };
    const matches: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{
        total_count: number;
        check_runs: CheckRun[];
      }>(
        "GET",
        `commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.check_runs))
        throw new Error("Named CI response lacks check runs");
      matches.push(
        ...result.check_runs.filter(
          (check) => check.name === name && check.head_sha === headSha,
        ),
      );
      if (result.check_runs.length < 100) break;
    }
    // GitHub selects latest reruns. Multiple apps/suites using the same name
    // are ambiguous: choosing a convenient successful check would weaken proof.
    if (matches.length > 1)
      throw foreignChange("Required named CI check is ambiguous");
    const check = matches[0];
    return check
      ? {
          id: check.id,
          headSha: check.head_sha,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          detailsUrl: check.html_url,
        }
      : undefined;
  }

  /** The lag key of a PR that should show the pushed head. */
  private pushedHeadKey(request: PullRequestPublication): string {
    return `${this.repository}:pr-head:${request.branch}:${request.headSha}`;
  }

  /**
   * The open PR for Factory's branch, found by its head. A PR on a head an
   * earlier attempt pushed has not caught up with the push yet; any other
   * head or base is a change Factory did not make.
   */
  private async pullByHead(
    request: PullRequestPublication,
  ): Promise<PullRequestIdentity | undefined> {
    const owner = this.repository.split("/")[0]!;
    const pulls = await this.pages<Pull>(
      `pulls?state=open&head=${encodeURIComponent(`${owner}:${request.branch}`)}`,
    );
    if (pulls.length > 1)
      throw foreignChange(`Multiple open PRs for ${request.branch}`);
    const pull = pulls[0];
    if (!pull) return undefined;
    if (pull.head.ref !== request.branch || pull.base.ref !== request.base)
      throw foreignChange(`Existing PR for ${request.branch} changed base`);
    const key = this.pushedHeadKey(request);
    if (pull.head.sha === request.headSha) {
      const publication = this.assertPublicationPull(
        request,
        pull,
        Boolean(request.reconcileOnly),
      );
      settled(key);
      return {
        number: pull.number,
        branch: request.branch,
        headSha: request.headSha,
        publication,
      };
    }
    if (request.earlierHeads?.includes(pull.head.sha))
      throw stillLagging(
        key,
        `PR #${pull.number} does not show the pushed head ${request.headSha} yet`,
      );
    throw foreignChange(`Existing PR for ${request.branch} changed head`);
  }

  async defaultBranch(): Promise<string> {
    return (await this.settings()).defaultBranch;
  }

  /** The repository's default branch and whether it allows merge commits. */
  private async settings(): Promise<{
    defaultBranch: string;
    mergeCommits: boolean;
  }> {
    const result = await this.api<{
      default_branch: string;
      allow_merge_commit?: boolean;
    }>("GET", "");
    if (!result.default_branch)
      throw new Error("Repository has no default branch");
    return {
      defaultBranch: result.default_branch,
      mergeCommits: result.allow_merge_commit === true,
    };
  }

  /**
   * Factory merges with a merge commit: integration evidence binds the
   * delivered head as its second parent. Checked before any merge is sent.
   */
  private async requireMergeCommits(branch: string): Promise<void> {
    const forbidden = () =>
      attachFault(
        new Error("The repository does not allow merge commits"),
        MERGE_COMMITS_REQUIRED,
      );
    if (!(await this.settings()).mergeCommits) throw forbidden();
    // A ruleset on the base may forbid them too: linear history, or a pull
    // request rule whose allowed methods omit merge.
    type Rule = {
      type?: unknown;
      parameters?: { allowed_merge_methods?: unknown } | null;
    };
    const rules = await this.pages<Rule>(
      `rules/branches/${encodeURIComponent(branch)}`,
    );
    if (
      rules.some(
        (rule) =>
          rule?.type === "required_linear_history" ||
          (rule?.type === "pull_request" &&
            Array.isArray(rule.parameters?.allowed_merge_methods) &&
            !rule.parameters.allowed_merge_methods.includes("merge")),
      )
    )
      throw forbidden();
    // Classic branch protection can require linear history too. It is part
    // of the branch protection read, which needs admin: 404 is unprotected,
    // 403 is a login that cannot see it (an App token). Either is unknown,
    // and then the merge itself is the only test left.
    const path = `branches/${encodeURIComponent(branch)}/protection`;
    let classic:
      | { required_linear_history?: { enabled?: unknown } }
      | undefined;
    try {
      classic = await this.client.request<typeof classic>(
        "GET",
        this.route(path),
      );
    } catch (error) {
      if (
        !(
          error instanceof GitHubRequestError &&
          [403, 404].includes(error.status) &&
          attachedFault(error)?.kind !== "transient"
        )
      )
        throw attachFault(error, gitHubFault(error, { method: "GET", path }));
    }
    if (classic?.required_linear_history?.enabled === true) throw forbidden();
  }

  async objective(number: number): Promise<ObjectiveIssue> {
    const issue = await this.api<Issue>("GET", `issues/${number}`);
    if (
      issue.pull_request ||
      issue.number !== number ||
      !["open", "closed"].includes(issue.state)
    )
      throw foreignChange("Objective issue identity or state changed");
    return {
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: (issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : (label.name ?? ""),
      ),
    };
  }

  async intakePage(page: number, etag?: string): Promise<IntakeIssuePage> {
    const observed = await this.api<{
      status: number;
      etag?: string;
      data?: Issue[];
    }>(
      "GET",
      `issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
      undefined,
      { etag },
    );
    if (observed.status === 304) return { status: 304, etag: observed.etag };
    if (!Array.isArray(observed.data)) throw new Error("Invalid intake page");
    return {
      ...observed,
      data: observed.data.map((issue) => ({
        // Preserve page length including PRs for correct pagination; unauthorized IDs never execute.
        number: issue.pull_request ? 0 : issue.number,
        state: issue.state,
        labels: (issue.labels ?? []).map((label) =>
          typeof label === "string" ? label : (label.name ?? ""),
        ),
      })),
    };
  }

  async objectiveDependencies(number: number): Promise<number[]> {
    const blockedBy = await this.pages<Issue>(
      `issues/${number}/dependencies/blocked_by`,
    );
    return blockedBy.map((issue) => {
      if (
        issue.pull_request ||
        !Number.isSafeInteger(issue.number) ||
        issue.repository_url !==
          `https://api.github.com/repos/${this.repository}`
      )
        throw foreignChange(
          "Objective predecessor is outside the bound repository",
        );
      return issue.number;
    });
  }

  async closeIssue(
    number: number,
    comment: string,
    expected: {
      body?: string;
      workItem?: { objective: number; id: string };
      author?: string;
      reason?: "not_planned";
    },
  ): Promise<void> {
    const issue = await this.api<Issue>("GET", `issues/${number}`);
    const marker = expected.workItem
      ? `<!-- factory:objective=${expected.workItem.objective};item=${expected.workItem.id} -->`
      : undefined;
    if (
      issue.pull_request ||
      issue.number !== number ||
      (marker && (issue.body ?? "").split(marker).length !== 2) ||
      (expected.body !== undefined && issue.body !== expected.body)
    )
      throw foreignChange(
        `Issue #${number} identity changed; operator direction required`,
      );
    // The completion comment carries a marker, so a repeat after a lost
    // response finds it instead of posting it twice.
    // Cancellation has its own marker: a Work Item retried after cancel
    // still gets its completion comment.
    const kind = expected.reason === "not_planned" ? "cancelled" : "closure";
    const closure = expected.workItem
      ? `<!-- factory:${kind} objective=${expected.workItem.objective};item=${expected.workItem.id} -->`
      : `<!-- factory:${kind} objective=${number} -->`;
    const author = expected.author ?? (await this.viewer());
    const comments = await this.pages<{
      body?: string;
      user?: { login?: string } | null;
    }>(`issues/${number}/comments`);
    if (
      !comments.some(
        (entry) =>
          (author === undefined || entry.user?.login === author) &&
          (entry.body ?? "").includes(closure),
      )
    ) {
      // Closed moments ago with no comment listed: GitHub may not list the
      // comment Factory just posted yet.
      const closedFor = time.now() - Date.parse(issue.closed_at ?? "");
      if (issue.state !== "open" && closedFor >= 0 && closedFor < GITHUB_LAG_MS)
        throw listedSoon(
          `Issue #${number} completion comment is not listed yet`,
        );
      // Closure follows a merged Work Item or a sealed Objective, so a human
      // closing the issue reached the intended end: record it anyway.
      await this.api("POST", `issues/${number}/comments`, {
        body: `${closure}\n${comment}`,
      });
    }
    if (issue.state === "open")
      await this.api("PATCH", `issues/${number}`, {
        state: "closed",
        state_reason: expected.reason ?? "completed",
      });
    else if (issue.state !== "closed")
      throw new Error(`Issue #${number} has unexpected state`);
  }

  /** Close a duplicate Work Item issue, saying which issue Factory keeps. */
  private async closeDuplicate(
    duplicate: Issue,
    kept: Issue,
    author: string | undefined,
  ): Promise<void> {
    if (duplicate.state === "open") {
      const marker = `<!-- factory:duplicate of=${kept.number} -->`;
      const comments = await this.pages<{
        body?: string;
        user?: { login?: string } | null;
      }>(`issues/${duplicate.number}/comments`);
      if (
        !comments.some(
          (entry) =>
            (author === undefined || entry.user?.login === author) &&
            (entry.body ?? "").includes(marker),
        )
      )
        await this.api("POST", `issues/${duplicate.number}/comments`, {
          body: `${marker}\nDuplicate of #${kept.number}, which Factory keeps for this Work Item.`,
        });
    }
    await this.api("PATCH", `issues/${duplicate.number}`, {
      state: "closed",
      state_reason: "not_planned",
    });
  }

  private authenticatedIssue(issue: Issue, number?: number): Issue {
    if (
      !issue ||
      issue.pull_request ||
      !Number.isSafeInteger(issue.id) ||
      issue.id <= 0 ||
      !Number.isSafeInteger(issue.number) ||
      issue.number <= 0 ||
      (number !== undefined && issue.number !== number) ||
      typeof issue.repository_url !== "string" ||
      !issue.repository_url.startsWith("https://api.github.com/repos/") ||
      issue.repository_url
        .slice("https://api.github.com/repos/".length)
        .toLowerCase() !== this.repository.toLowerCase() ||
      !["open", "closed"].includes(issue.state)
    )
      throw new Error(
        "Work Item projection lacks authenticated issue identity",
      );
    return issue;
  }

  async projectGraph(request: GraphProjection): Promise<ProjectedGraph> {
    const authenticated = (issue: Issue, number?: number) =>
      this.authenticatedIssue(issue, number);
    const roles = ["factory:objective", "factory:work-item"];
    const labels = await this.pages<{
      name: string;
      archived_at?: string | null;
    }>("labels");
    for (const role of roles) {
      const matches = labels.filter((label) => label.name === role);
      if (matches.length > 1 || matches[0]?.archived_at)
        throw foreignChange(
          `Required Factory role label is archived or ambiguous: ${role}`,
        );
      if (!matches.length) {
        await this.api("POST", "labels", {
          name: role,
          color: "ededed",
        });
        const observed = await this.pages<{
          name: string;
          archived_at?: string | null;
        }>("labels");
        const created = observed.filter((label) => label.name === role);
        const key = `${this.repository}:label:${role}`;
        if (created.length !== 1 || created[0]!.archived_at)
          throw stillLagging(
            key,
            `Factory role label creation did not reconcile exactly: ${role}`,
          );
        settled(key);
      }
    }
    const ensureRole = async (issue: Issue, role: string): Promise<Issue> => {
      const names = (issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name,
      );
      if (names.includes(role)) return issue;
      await this.api("POST", `issues/${issue.number}/labels`, {
        labels: [role],
      });
      const observed = authenticated(
        await this.api<Issue>("GET", `issues/${issue.number}`),
        issue.number,
      );
      const observedNames = (observed.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name,
      );
      if (
        observed.id !== issue.id ||
        observed.body !== issue.body ||
        observed.title !== issue.title ||
        observed.state !== issue.state ||
        names.some((name) => !observedNames.includes(name))
      )
        throw foreignChange(
          "Factory role label did not reconcile exactly; issue changed",
        );
      const key = `${this.repository}:issue-label:${issue.number}:${role}`;
      if (!observedNames.includes(role))
        throw stillLagging(
          key,
          `Factory role label ${role} is not visible yet`,
        );
      settled(key);
      return observed;
    };
    const objective = authenticated(
      await this.api<Issue>("GET", `issues/${request.objectiveIssue}`),
      request.objectiveIssue,
    );
    await ensureRole(objective, roles[0]!);
    const issueByItemId: Record<string, number> = {};
    const issues = new Map<number, Issue>();
    // Issues this call created; GitHub may not show them for a moment.
    const createdAt = new Map<number, number>();
    let existing: Issue[] | undefined;
    let author = request.author;
    /**
     * The one owned issue for a Work Item. Duplicates (a create repeated
     * before GitHub showed the first) are exact projections of it: the one
     * with progress (completed, or commented) is kept, else the oldest, and
     * the rest are closed with a comment naming it. A duplicate closed that
     * way is no longer the item's issue. Edited copies are not duplicates.
     */
    const ownedIssue = async (
      item: WorkItem,
      marker: string,
    ): Promise<Issue | undefined> => {
      author ??= await this.viewer();
      existing ??= await this.ownedWorkItemIssues(
        request.objectiveIssue,
        author,
      );
      const candidates = existing.filter(
        (issue) =>
          (issue.body ?? "").includes(marker) &&
          !(issue.state === "closed" && issue.state_reason === "not_planned"),
      );
      if (candidates.length < 2) return candidates[0];
      const old = request.previousGraph?.items.find(
        (previous) => previous.id === item.id,
      );
      const exact = (issue: Issue) =>
        [item, ...(old ? [old] : [])].some(
          (version) =>
            issue.title === version.title &&
            issue.body === projectedIssueBody(version, request.objectiveIssue),
        ) &&
        (issue.labels ?? []).some(
          (label) =>
            (typeof label === "string" ? label : label.name) === roles[1],
        );
      if (!candidates.every(exact))
        throw foreignChange(
          `Work Item ${item.id} has ${candidates.length} issues with its marker, some edited; operator direction required`,
        );
      const progress = (issue: Issue) =>
        issue.state === "closed" ? 2 : (issue.comments ?? 0) > 0 ? 1 : 0;
      const [kept, ...duplicates] = [...candidates].sort(
        (left, right) =>
          progress(right) - progress(left) || left.number - right.number,
      );
      authenticated(kept!);
      for (const duplicate of duplicates) {
        authenticated(duplicate);
        await this.closeDuplicate(duplicate, kept!, author);
        existing = existing.filter((issue) => issue.id !== duplicate.id);
      }
      return kept;
    };
    let taskType: Promise<string | undefined> | undefined;
    for (const item of request.graph.items) {
      const marker = `<!-- factory:objective=${request.objectiveIssue};item=${item.id} -->`;
      const known = request.knownIssues?.[item.id];
      let found: Issue | undefined;
      if (known !== undefined) {
        found = await this.api<Issue>("GET", `issues/${known}`);
        if (
          found.number !== known ||
          found.pull_request ||
          (found.body ?? "").split(marker).length !== 2
        )
          throw foreignChange(
            `Known Work Item issue for ${item.id} changed identity`,
          );
      } else {
        found = await ownedIssue(item, marker);
        if (found && (found.body ?? "").split(marker).length !== 2)
          throw foreignChange(
            `Work Item issue for ${item.id} has ambiguous identity`,
          );
      }
      if (found) {
        authenticated(found, known);
        if (request.previousGraph) {
          if (
            found.state === "closed" &&
            !request.completedItems?.includes(item.id)
          )
            throw foreignChange("Unreviewed remote issue closure");
          const old = request.previousGraph.items.find(
            (previous) => previous.id === item.id,
          );
          const expectedBody = projectedIssueBody(item, request.objectiveIssue);
          if (found.body !== expectedBody || found.title !== item.title) {
            if (
              !old ||
              found.body !== projectedIssueBody(old, request.objectiveIssue) ||
              found.title !== old.title ||
              found.state !== "open"
            )
              throw foreignChange(
                `Work Item ${item.id} projection changed; edits are proposals, not graph authority`,
              );
            await this.api("PATCH", `issues/${found.number}`, {
              title: item.title,
              body: expectedBody,
            });
            const observed = await this.api<Issue>(
              "GET",
              `issues/${found.number}`,
            );
            authenticated(observed, found.number);
            const key = `${this.repository}:amend:${found.number}`;
            if (
              observed.id !== found.id ||
              observed.body !== expectedBody ||
              observed.title !== item.title
            )
              throw stillLagging(
                key,
                `Amendment issue #${found.number} projection did not reconcile exactly`,
              );
            settled(key);
            found = observed;
          }
        }
        if (
          !request.previousGraph &&
          (found.body !== projectedIssueBody(item, request.objectiveIssue) ||
            found.title !== item.title ||
            found.state !== "open")
        )
          throw foreignChange(
            `Work Item ${item.id} projection changed; edits are proposals, not graph authority`,
          );
        found = await ensureRole(found, roles[1]!);
        issueByItemId[item.id] = found.number;
        issues.set(found.number, found);
        request.projected?.(item.id, found.number);
        continue;
      }
      const body = projectedIssueBody(item, request.objectiveIssue);
      taskType ??= availableIssueType(this.client, this.repository, "Task");
      const type = await taskType;
      await request.beforeCreate?.(item.id);
      const created = await this.api<Issue>("POST", "issues", {
        title: item.title,
        body,
        labels: [roles[1]!],
        ...(type ? { type } : {}),
      });
      if (
        !created ||
        !Number.isSafeInteger(created.number) ||
        created.number <= 0
      )
        throw unverifiedCreate(
          "Cannot parse created Work Item issue identity; outcome unknown",
        );
      authenticated(created);
      // The author of Factory's first issue is its identity from now on.
      if (!request.author && created.user?.login) {
        author = created.user.login;
        request.authored?.(created.user.login);
      }
      request.projected?.(item.id, created.number);
      issueByItemId[item.id] = created.number;
      if (
        !(created.labels ?? []).some(
          (label) =>
            (typeof label === "string" ? label : label.name) === roles[1],
        )
      )
        throw new Error("Created Work Item lacks its Factory role label");
      if (
        created.title !== item.title ||
        created.body !== body ||
        created.state !== "open"
      )
        throw new Error(
          "Created Work Item projection did not reconcile exactly",
        );
      issues.set(created.number, created);
      createdAt.set(created.number, time.now());
      existing?.push(created);
    }
    for (const item of request.graph.items) {
      const number = issueByItemId[item.id]!;
      const fresh = { createdAt: createdAt.get(number) };
      const observations = await this.pages<Issue>(
        `issues/${number}/dependencies/blocked_by`,
        fresh,
      );
      for (const issue of observations) {
        authenticated(issue);
        if (issues.get(issue.number)?.id !== issue.id)
          throw foreignChange("Unreviewed remote dependency edit");
      }
      if (
        new Set(observations.map((issue) => issue.number)).size !==
        observations.length
      )
        throw foreignChange("Ambiguous remote dependency identity");
      const existing = new Set(observations.map((issue) => issue.number));
      const allowed = new Set(
        [
          ...item.dependencies,
          ...(request.previousGraph?.items.find(
            (previous) => previous.id === item.id,
          )?.dependencies ?? []),
        ].map((id) => issueByItemId[id]),
      );
      if (observations.some((issue) => !allowed.has(issue.number)))
        throw foreignChange("Unreviewed remote dependency edit");
      if (request.previousGraph) {
        for (const issue of observations) {
          if (
            item.dependencies.some((id) => issueByItemId[id] === issue.number)
          )
            continue;
          try {
            await this.api(
              "DELETE",
              `issues/${number}/dependencies/blocked_by/${issue.id}`,
            );
          } catch (error) {
            // Already removed, perhaps by a repeat whose response was lost;
            // the read-back below confirms the result.
            if (!(error instanceof GitHubRequestError && error.status === 404))
              throw error;
          }
        }
      }
      for (const dependency of item.dependencies) {
        const blocker = issueByItemId[dependency]!;
        if (!existing.has(blocker)) {
          const issue = issues.get(blocker)!;
          if (!Number.isSafeInteger(issue.id) || issue.id <= 0)
            throw new Error(
              "Dependency issue has no authenticated database identity",
            );
          await this.linked(
            () =>
              this.api(
                "POST",
                `issues/${number}/dependencies/blocked_by`,
                { issue_id: issue.id },
                undefined,
                fresh,
              ),
            `issues/${number}/dependencies/blocked_by`,
            issue.id,
            fresh,
          );
        }
      }
      {
        const observed = await this.pages<Issue>(
          `issues/${number}/dependencies/blocked_by`,
          fresh,
        );
        const expected = item.dependencies.map((id) => issueByItemId[id]);
        const key = `${this.repository}:dependencies:${number}`;
        if (
          observed.length !== expected.length ||
          new Set(observed.map((issue) => issue.number)).size !==
            observed.length ||
          observed.some((issue) => {
            authenticated(issue);
            return (
              !expected.includes(issue.number) ||
              issues.get(issue.number)?.id !== issue.id
            );
          })
        )
          throw stillLagging(
            key,
            `Work Item issue #${number} dependencies did not reconcile exactly`,
          );
        settled(key);
      }
    }
    {
      const parentsFor = (graph: GraphProjection["graph"]) => {
        const aggregateByChild = new Map(
          graph.items.flatMap((parent) =>
            (parent.children ?? []).map((id) => [id, parent.id] as const),
          ),
        );
        return new Map(
          graph.items.map((item) => [
            issueByItemId[item.id]!,
            aggregateByChild.has(item.id)
              ? issueByItemId[aggregateByChild.get(item.id)!]!
              : request.objectiveIssue,
          ]),
        );
      };
      const desiredParents = parentsFor(request.graph);
      const previousParents = request.previousGraph
        ? parentsFor(request.previousGraph)
        : new Map<number, number>();
      const childrenByParent = new Map<number, number[]>(
        [
          ...new Set([...desiredParents.values(), ...previousParents.values()]),
        ].map((parent) => [parent, []]),
      );
      for (const [child, parent] of desiredParents)
        childrenByParent.get(parent)!.push(child);

      // Inspect the complete old/new hierarchy before changing any parent. A
      // reviewed move may already have completed before an interrupted readback.
      const observedParents = new Map<number, number>();
      for (const parent of childrenByParent.keys()) {
        const existing = await this.pages<Issue>(
          `issues/${parent}/sub_issues`,
          { createdAt: createdAt.get(parent) },
        );
        for (const issue of existing) {
          authenticated(issue);
          if (issues.get(issue.number)?.id !== issue.id)
            throw foreignChange("Ambiguous remote hierarchy identity");
          if (
            observedParents.has(issue.number) ||
            (desiredParents.get(issue.number) !== parent &&
              previousParents.get(issue.number) !== parent)
          )
            throw foreignChange("Unreviewed remote hierarchy edit");
          observedParents.set(issue.number, parent);
        }
      }
      for (const [child, parent] of desiredParents) {
        const currentParent = observedParents.get(child);
        if (currentParent === parent) continue;
        const childIssue = authenticated(
          await this.api<Issue>(
            "GET",
            `issues/${child}`,
            undefined,
            undefined,
            {
              createdAt: createdAt.get(child),
            },
          ),
          child,
        );
        if (childIssue.id !== issues.get(child)!.id)
          throw foreignChange("Ambiguous remote hierarchy identity");
        const replacing = currentParent !== undefined;
        let observedParent: Issue | undefined;
        try {
          observedParent = authenticated(
            await this.api<Issue>("GET", `issues/${child}/parent`),
          );
        } catch (error) {
          if (!(error instanceof GitHubRequestError && error.status === 404))
            throw error;
        }
        const expectedParent =
          currentParent === request.objectiveIssue
            ? objective
            : currentParent === undefined
              ? undefined
              : issues.get(currentParent);
        if (
          (replacing &&
            (previousParents.get(child) !== currentParent ||
              observedParent?.number !== currentParent ||
              observedParent?.id !== expectedParent?.id)) ||
          (!replacing && observedParent !== undefined)
        )
          throw foreignChange("Unreviewed remote hierarchy parent");
        // Either side may be an issue GitHub does not show yet.
        const call = {
          createdAt: latest(createdAt.get(parent), createdAt.get(child)),
        };
        await this.linked(
          () =>
            this.api(
              "POST",
              `issues/${parent}/sub_issues`,
              { sub_issue_id: childIssue.id, replace_parent: replacing },
              undefined,
              call,
            ),
          `issues/${parent}/sub_issues`,
          childIssue.id,
          { createdAt: createdAt.get(parent) },
        );
      }
      // Read back every affected parent, including those that became empty.
      for (const [parent, children] of childrenByParent) {
        const observed = await this.pages<Issue>(
          `issues/${parent}/sub_issues`,
          { createdAt: createdAt.get(parent) },
        );
        const key = `${this.repository}:sub-issues:${parent}`;
        if (
          observed.length !== children.length ||
          new Set(observed.map((issue) => issue.number)).size !==
            observed.length ||
          observed.some((issue) => {
            authenticated(issue);
            return (
              !children.includes(issue.number) ||
              issues.get(issue.number)?.id !== issue.id
            );
          })
        )
          throw stillLagging(
            key,
            `Issue #${parent} sub-issues did not reconcile exactly`,
          );
        settled(key);
      }
    }
    return { issueByItemId };
  }

  private assertPublicationPull(
    request: PullRequestPublication,
    pull: Pull,
    exactText: boolean,
  ): NonNullable<PullRequestIdentity["publication"]> {
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    if (
      !Number.isSafeInteger(pull.number) ||
      pull.number < 1 ||
      pull.head?.ref !== request.branch ||
      pull.head.sha !== request.headSha ||
      pull.base?.ref !== request.base ||
      pull.head.repo?.full_name?.toLowerCase() !==
        this.repository.toLowerCase() ||
      pull.base.repo?.full_name?.toLowerCase() !==
        this.repository.toLowerCase() ||
      typeof pull.title !== "string" ||
      typeof pull.body !== "string"
    )
      throw foreignChange(
        "PR publication observation differs from exact repository/head/base/context binding",
      );
    const publication = {
      repository: this.repository,
      baseBranch: pull.base.ref,
      titleDigest: digest(pull.title),
      bodyDigest: digest(pull.body),
      ...(pull.user?.login ? { author: pull.user.login } : {}),
    };
    const expected = request.expectedPublication ?? {
      titleDigest: digest(request.title),
      bodyDigest: digest(request.body),
    };
    if (
      exactText &&
      (publication.titleDigest !== expected.titleDigest ||
        publication.bodyDigest !== expected.bodyDigest)
    )
      throw foreignChange(
        "PR title/body differs from the exact recorded publication request/observation",
      );
    return publication;
  }

  /** Persisted requests only reconcile; only the saved owner's one-shot callback creates. */
  async publish(request: PullRequestPublication): Promise<PullRequestIdentity> {
    const found = await this.pullByHead(request);
    if (found) return found;
    if (request.reconcileOnly || !request.beforeCreate)
      throw attachFault(
        new Error(
          `PR publication outcome remains unknown for ${request.branch}`,
        ),
        decision(
          "No exact PR is visible. Publication remains unknown; this read does not authorize another POST.",
          `Unresolved exact request for ${request.branch}; only read-only reconciliation is allowed`,
        ),
      );
    request.beforeCreate();
    // No retry, negative-read release or in-memory authority: intent already survives restart.
    const detail = await this.api<Pull>("POST", "pulls", {
      head: request.branch,
      base: request.base,
      title: request.title,
      body: request.body,
    });
    if (!detail || !Number.isSafeInteger(detail.number) || !detail.head?.sha)
      throw unverifiedCreate(
        "Cannot verify created PR identity; outcome unknown",
      );
    const publication = this.assertPublicationPull(request, detail, true);
    return {
      number: detail.number,
      branch: request.branch,
      headSha: detail.head.sha,
      publication,
    };
  }

  /**
   * The PR still shows Factory's head and branch. A head an earlier attempt
   * pushed is a read that has not caught up with the push; any other is a
   * change Factory did not make.
   */
  private assertHead(identity: PullRequestIdentity, pull: Pull): void {
    const key = `head:${identity.number}:${identity.headSha}`;
    if (
      pull.head.ref === identity.branch &&
      pull.head.sha !== identity.headSha &&
      identity.earlierHeads?.includes(pull.head.sha)
    )
      throw notYet(
        key,
        `PR #${identity.number} does not show the pushed head ${identity.headSha} yet`,
        decision(
          `PR #${identity.number} still shows an earlier head. Inspect it, then retry or cancel.`,
          `PR #${identity.number} head ${pull.head.sha}; pushed ${identity.headSha}`,
        ),
      );
    if (pull.head.sha !== identity.headSha || pull.head.ref !== identity.branch)
      throw foreignChange(
        `PR #${identity.number} head changed from ${identity.headSha} to ${pull.head.sha}`,
      );
    settled(key);
  }

  /**
   * The check names the repository requires on `branch`: its rulesets and
   * its classic branch protection (from the protection route, else from the
   * branch read, which shows them with read access).
   */
  private async requiredChecks(branch: string): Promise<string[]> {
    type Rule = {
      type?: string;
      parameters?: { required_status_checks?: { context?: string }[] };
    };
    const rules = await this.pages<Rule>(
      `rules/branches/${encodeURIComponent(branch)}`,
    );
    const names = rules.flatMap((rule) =>
      rule.type === "required_status_checks"
        ? (rule.parameters?.required_status_checks ?? []).flatMap((check) =>
            typeof check.context === "string" ? [check.context] : [],
          )
        : [],
    );
    type Required = { contexts?: unknown; checks?: unknown };
    let classic: Required = {};
    try {
      classic = await this.client.request(
        "GET",
        this.route(
          `branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
        ),
      );
    } catch (error) {
      // 404: unprotected, or no required checks. A rate limit stays one.
      if (
        !(
          error instanceof GitHubRequestError &&
          [403, 404].includes(error.status) &&
          attachedFault(error)?.kind !== "transient"
        )
      )
        throw error;
      // 403: the login may not read protection settings; the branch read
      // shows the same required checks with read access.
      if (error.status === 403)
        classic =
          (
            await this.api<{
              protection?: { required_status_checks?: Required | null } | null;
            }>("GET", `branches/${encodeURIComponent(branch)}`)
          ).protection?.required_status_checks ?? {};
    }
    return [
      ...new Set(
        [
          ...names,
          ...(Array.isArray(classic.contexts) ? classic.contexts : []),
          ...(Array.isArray(classic.checks) ? classic.checks : []).map(
            (check) => (check as { context?: unknown } | null)?.context,
          ),
        ].filter((name): name is string => typeof name === "string" && !!name),
      ),
    ];
  }

  async observe(
    identity: PullRequestIdentity,
  ): Promise<PullRequestObservation> {
    const detail = await this.api<Pull>("GET", `pulls/${identity.number}`);
    this.assertHead(identity, detail);
    if (
      identity.baseBranch !== undefined &&
      detail.base?.ref !== identity.baseBranch
    )
      throw foreignChange(
        `PR #${identity.number} base changed to ${detail.base?.ref}; operator direction required`,
      );
    const runs: {
      id: number;
      name: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      app?: { id?: number } | null;
    }[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ check_runs: typeof runs }>(
        "GET",
        `commits/${identity.headSha}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.check_runs))
        throw new Error("PR CI response lacks check runs");
      runs.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    type Status = { context?: unknown; state?: unknown };
    const contexts: Status[] = [];
    let combined: { state: string; total_count: number; statuses?: unknown };
    for (let page = 1; ; page++) {
      combined = await this.api<typeof combined>(
        "GET",
        `commits/${identity.headSha}/status?per_page=100&page=${page}`,
      );
      const listed = Array.isArray(combined.statuses)
        ? (combined.statuses as Status[])
        : [];
      contexts.push(...listed);
      if (listed.length < 100) break;
    }
    const statuses = combined;
    const failing =
      runs.some(
        (run) =>
          run.conclusion !== null &&
          !["success", "neutral", "skipped"].includes(run.conclusion),
      ) || ["error", "failure"].includes(statuses.state);
    // Completed runs that failed; cancelled or superseded runs did not.
    const failedChecks = [
      ...new Set([
        ...runs
          .filter((run) =>
            [
              "failure",
              "timed_out",
              "action_required",
              "startup_failure",
            ].includes(run.conclusion ?? ""),
          )
          .map((run) => run.name),
        // Commit statuses: branch protection often requires these contexts.
        ...contexts.flatMap((status) =>
          typeof status.context === "string" &&
          ["error", "failure"].includes(String(status.state))
            ? [status.context]
            : [],
        ),
      ]),
    ];
    const checksByName = new Map<string, typeof runs>();
    for (const run of runs) {
      const group = checksByName.get(run.name);
      if (group) group.push(run);
      else checksByName.set(run.name, [run]);
    }
    const namedChecks = [...checksByName.values()].flatMap((group) => {
      const run = group[0]!;
      const appId = run.app?.id;
      if (
        !group.every(
          (candidate) =>
            candidate.head_sha === identity.headSha &&
            candidate.status === "completed" &&
            candidate.conclusion === "success" &&
            Number.isSafeInteger(candidate.id) &&
            candidate.id > 0 &&
            typeof candidate.name === "string" &&
            candidate.name.length > 0 &&
            typeof candidate.html_url === "string" &&
            candidate.html_url.length > 0,
        ) ||
        // Repeated triggers are equivalent proof only when every current run
        // succeeds and the authenticated response identifies the same app.
        (group.length > 1 &&
          (typeof appId !== "number" ||
            !Number.isSafeInteger(appId) ||
            appId <= 0 ||
            !group.every((candidate) => candidate.app?.id === appId)))
      )
        return [];
      return [
        {
          id: run.id,
          headSha: run.head_sha,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          detailsUrl: run.html_url,
        },
      ];
    });
    let mergeReadiness: PullRequestObservation["mergeReadiness"];
    if (!detail.merged && detail.state !== "closed") {
      const readiness = await classifiedGitHubCall(
        this.client,
        this.repository,
        { method: "POST", path: "graphql" },
        () =>
          this.client.pullRequestReadiness(this.repository, identity.number),
      );
      if (
        readiness.headRefOid !== identity.headSha ||
        readiness.headRefName !== identity.branch ||
        readiness.baseRefName !== detail.base?.ref
      )
        throw foreignChange(
          `PR #${identity.number} readiness identity changed; operator direction required`,
        );
      switch (readiness.mergeStateStatus) {
        case "CLEAN":
        case "HAS_HOOKS":
          mergeReadiness = "ready";
          break;
        case "UNKNOWN":
        case "BLOCKED":
          mergeReadiness = "waiting";
          break;
        // Mergeable; only checks the repository does not require are not
        // passing.
        case "UNSTABLE":
          mergeReadiness = "ready";
          break;
        // Strict protection: Factory updates the branch (updateBranch).
        case "BEHIND":
          mergeReadiness = "behind";
          break;
        case "DIRTY":
          mergeReadiness = "conflict";
          break;
        case "DRAFT":
          mergeReadiness = "draft";
          break;
        default:
          throw new Error("GitHub PR readiness status is unsupported");
      }
    }
    // GitHub can report a PR CLEAN before a required check registers on its
    // head. A required check with no run and no status yet is pending, so
    // the merge waits for it (#626). Which checks are required also matters
    // once one failed.
    const requiredChecks =
      mergeReadiness === "ready" ||
      (failedChecks.length && !detail.merged && detail.state !== "closed")
        ? await this.requiredChecks(detail.base.ref)
        : [];
    const reported = new Set<unknown>([
      ...runs.map((run) => run.name),
      ...contexts.map((status) => status.context),
    ]);
    const unreported = requiredChecks.some((name) => !reported.has(name));
    if (unreported && mergeReadiness === "ready") mergeReadiness = "waiting";
    // Every name with any run (whatever its state or conclusion) or status
    // on the exact head; both reads above are of that commit.
    const reportedChecks = [
      ...new Set(
        [
          ...runs
            .filter((run) => run.head_sha === identity.headSha)
            .map((run) => run.name),
          ...contexts.map((status) => status.context),
        ].filter((name): name is string => typeof name === "string" && !!name),
      ),
    ];
    return {
      namedChecks,
      ...(reportedChecks.length ? { reportedChecks } : {}),
      ...(failedChecks.length ? { failedChecks } : {}),
      ...(failedChecks.length && requiredChecks.length
        ? { requiredChecks }
        : {}),
      ...(mergeReadiness ? { mergeReadiness } : {}),
      ...(!detail.merged && detail.state === "closed" && detail.closed_at
        ? { closedAt: detail.closed_at }
        : {}),
      state: detail.merged
        ? "merged"
        : detail.state === "closed"
          ? "closed"
          : "open",
      checks: failing
        ? "failing"
        : unreported ||
            runs.some((run) => run.status !== "completed") ||
            (statuses.total_count > 0 && statuses.state === "pending")
          ? "pending"
          : "passing",
    };
  }

  /**
   * Bring a PR that is BEHIND its base under strict protection up to date:
   * GitHub merges the base into Factory's head (update-branch, guarded by
   * the expected head). Returns the head GitHub made once the PR shows it;
   * until then the call is transient (lag window), then a decision. A
   * repeat that finds the update already made returns it without another
   * request. The caller records the returned head as the PR's head.
   */
  async updateBranch(identity: PullRequestIdentity): Promise<string> {
    const key = `update:${identity.number}:${identity.headSha}`;
    const pull = await this.api<Pull>("GET", `pulls/${identity.number}`);
    if (pull.merged || pull.state !== "open")
      throw foreignChange(
        `PR #${identity.number} is no longer open; its branch was not updated`,
      );
    if (pull.head.ref !== identity.branch)
      throw foreignChange(`PR #${identity.number} head branch changed`);
    // A read that has not caught up with an earlier attempt's push.
    if (identity.earlierHeads?.includes(pull.head.sha))
      this.assertHead(identity, pull);
    if (pull.head.sha !== identity.headSha) {
      const updated = await this.branchUpdateHead(identity, pull);
      settled(key);
      return updated;
    }
    const pending = () =>
      notYet(
        key,
        `PR #${identity.number} does not show its branch update yet`,
        decision(
          `GitHub did not update PR #${identity.number}'s branch with its base. Inspect it, then retry or cancel.`,
          `PUT pulls/${identity.number}/update-branch at ${identity.headSha}`,
        ),
      );
    try {
      await this.api("PUT", `pulls/${identity.number}/update-branch`, {
        expected_head_sha: identity.headSha,
      });
    } catch (error) {
      // The head moved, the branch is current, or the base conflicts: the
      // repeat observes the PR (and its readiness) again.
      if (error instanceof GitHubRequestError && error.status === 422)
        throw pending();
      throw error;
    }
    // Accepted (202): GitHub makes the merge asynchronously.
    throw pending();
  }

  /**
   * The PR's new head is the update GitHub made: a merge whose first parent
   * is Factory's head and whose second is on the base branch, committed by
   * GitHub. Anything else is a change Factory did not make.
   */
  private async branchUpdateHead(
    identity: PullRequestIdentity,
    pull: Pull,
  ): Promise<string> {
    const head = pull.head.sha;
    const foreign = () =>
      foreignChange(
        `PR #${identity.number} head changed from ${identity.headSha} to ${head}`,
      );
    if (!/^[a-f0-9]{40}$/.test(head)) throw foreign();
    const commit = await this.api<{
      sha?: string;
      parents?: { sha?: unknown }[];
      committer?: { login?: unknown } | null;
    }>("GET", `commits/${head}`);
    const parents = Array.isArray(commit.parents)
      ? commit.parents.map((parent) => parent?.sha)
      : [];
    const merged = parents[1];
    if (
      commit.sha !== head ||
      parents.length !== 2 ||
      parents[0] !== identity.headSha ||
      typeof merged !== "string" ||
      !/^[a-f0-9]{40}$/.test(merged) ||
      commit.committer?.login !== "web-flow"
    )
      throw foreign();
    const base = pull.base.ref.split("/").map(encodeURIComponent).join("/");
    const compared = await this.api<{ status?: unknown }>(
      "GET",
      `compare/${merged}...${base}`,
    );
    if (compared.status !== "identical" && compared.status !== "ahead")
      throw foreign();
    return head;
  }

  async merge(
    identity: PullRequestIdentity,
    expectedHead: string,
  ): Promise<MergeResult> {
    if (expectedHead !== identity.headSha)
      throw new Error("Merge expected head differs from PR identity");
    // Observe first: a merge whose response was lost has already happened,
    // so it is confirmed rather than sent again.
    const current = await this.api<Pull>("GET", `pulls/${identity.number}`);
    if (current.merged) return this.confirmMerged(identity, current);
    if (current.state === "closed")
      throw notYet(
        `closed:${identity.number}:${identity.headSha}`,
        `PR #${identity.number} is closed without a merge`,
        decision(
          `PR #${identity.number} was closed without merging. Start a new attempt or cancel?`,
          `PR #${identity.number} closed${current.closed_at ? ` at ${current.closed_at}` : ""}`,
        ),
      );
    this.assertHead(identity, current);
    await this.requireMergeCommits(current.base.ref);
    const refused = `merge-refused:${identity.number}:${identity.headSha}`;
    let result: { merged: boolean; sha: string };
    try {
      result = await this.api<{ merged: boolean; sha: string }>(
        "PUT",
        `pulls/${identity.number}/merge`,
        { sha: expectedHead, merge_method: "merge" },
        undefined,
        // GitHub refuses a head that moved (409). The PR held Factory's head
        // a moment ago, so a refusal is lag until the repeat observes it.
        { head: "ours" },
      );
    } catch (error) {
      // "Not mergeable" also answers a merge in progress, one a lost earlier
      // request made, or a readiness change since it was observed: the
      // repeat observes again (readiness first), within GitHub's lag window.
      if (
        error instanceof GitHubRequestError &&
        error.status === 405 &&
        !error.refusal
      ) {
        const after = await this.api<Pull>("GET", `pulls/${identity.number}`);
        if (after.merged) return this.confirmMerged(identity, after);
        // Readiness changed since it was observed: a conflict or a failed
        // required check is work on the published result, not a decision.
        const waiting = deliveryReadiness(
          identity.number,
          await this.observe(identity),
          [],
          identity.headSha,
        );
        // A required check still running or not yet reported: the repeat
        // waits for CI before it sends the merge again (#626).
        if (waiting) {
          settled(refused);
          throw attachFault(new Error(waiting), transient(waiting, false));
        }
        // Otherwise a merge in progress, or readiness GitHub has not settled.
        throw notYet(
          refused,
          `GitHub refused to merge PR #${identity.number} (HTTP 405)`,
          decision(
            "GitHub refused the merge (not mergeable, or a repository rule). Inspect the pull request, then retry or cancel.",
            `PUT pulls/${identity.number}/merge returned 405`,
          ),
        );
      }
      // GitHub refuses PUT merge on a PR in a native stack with 403, even
      // once the stack merged. Read the PR and its stack, not the message.
      if (
        error instanceof GitHubRequestError &&
        error.status === 403 &&
        attachedFault(error)?.kind !== "transient"
      ) {
        const after = await this.api<Pull>("GET", `pulls/${identity.number}`);
        if (after.merged) return this.confirmMerged(identity, after);
        if (await this.stacked(identity.number))
          throw foreignChange(
            `PR #${identity.number} is in a native stack Factory did not record`,
          );
      }
      throw error;
    }
    settled(refused);
    // A PR merged meanwhile answers 200 without a fresh merge: confirm the
    // merge from the PR and its timeline (#627).
    if (
      result.merged !== true ||
      typeof result.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(result.sha)
    ) {
      const after = await this.api<Pull>("GET", `pulls/${identity.number}`);
      if (after.merged) return this.confirmMerged(identity, after);
      throw new Error("PR merge did not produce an integrated commit");
    }
    const key = `merge:${identity.number}:${identity.headSha}`;
    const detail = await this.api<Pull>("GET", `pulls/${identity.number}`);
    if (
      detail.state !== "closed" ||
      detail.merged !== true ||
      detail.head.sha !== expectedHead ||
      detail.head.ref !== identity.branch
    )
      throw notYet(
        key,
        `PR #${identity.number} does not show its merge ${result.sha} yet`,
      );
    settled(key);
    return { integratedSha: result.sha };
  }

  /** Whether GitHub shows the PR in a native stack. */
  private async stacked(number: number): Promise<boolean> {
    try {
      const stacks = await this.api<unknown[]>(
        "GET",
        `stacks?pull_request=${number}`,
      );
      return Array.isArray(stacks) && stacks.length > 0;
    } catch (error) {
      // No stacks for this repository: the PR is in none.
      if (error instanceof GitHubRequestError && error.status === 404)
        return false;
      throw error;
    }
  }

  /** A merged PR: its head must be Factory's, its merge commit on the timeline. */
  private async confirmMerged(
    identity: PullRequestIdentity,
    pull: Pull,
  ): Promise<MergeResult> {
    if (pull.head.sha !== identity.headSha || pull.head.ref !== identity.branch)
      throw foreignChange(
        `PR #${identity.number} was merged at head ${pull.head.sha}, not ${identity.headSha}`,
      );
    const key = `timeline:${identity.number}:${identity.headSha}`;
    const integratedSha = await classifiedGitHubCall(
      this.client,
      this.repository,
      { method: "GET", path: `issues/${identity.number}/timeline` },
      () => timelineMergeCommit(this.client, this.repository, identity.number),
    );
    if (!integratedSha)
      throw notYet(
        key,
        `PR #${identity.number} merge is not on its timeline yet`,
      );
    settled(key);
    return { integratedSha };
  }

  async ensureNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
  ): Promise<number> {
    return this.native.ensureStack(layers, baseBranch);
  }
  async mergeNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      resumeUuid?: string;
      onPending: (uuid: string) => void;
      progress?: () => void;
      queued: (detail: string) => never;
      failed?: () => Promise<void>;
    },
  ): Promise<string> {
    return this.native.mergeStack(layers, baseBranch, expectedStack, {
      ...options,
      requireMergeCommits: () => this.requireMergeCommits(baseBranch),
      failed: () => this.stackReadiness(layers),
    });
  }

  /**
   * Why a merge-async ended without a merge, when readiness explains it: a
   * required check still running or not yet reported on an open layer is a
   * CI wait, and a failed one is work (#626). Otherwise it returns.
   */
  private async stackReadiness(layers: NativeStackLayer[]): Promise<void> {
    for (const layer of layers) {
      // No base: GitHub retargets a layer once the one below it merges.
      const identity = {
        number: layer.pullRequest,
        branch: layer.branch,
        headSha: layer.headSha,
      };
      const waiting = deliveryReadiness(
        layer.pullRequest,
        await this.observe(identity),
        [],
        layer.headSha,
      );
      if (waiting)
        throw attachFault(new Error(waiting), transient(waiting, false));
    }
  }
}
