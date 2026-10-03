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
import type { NativeStackDelivery } from "./delivery/native-stack.js";
import {
  type GitHubClient,
  GitHubRequestError,
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
};
type Pull = {
  number: number;
  state: string;
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
};

export function projectedIssueBody(item: WorkItem, objective: number): string {
  const marker = `<!-- factory:objective=${objective};item=${item.id} -->`;
  return `${marker}\n\n## Goal\n${item.goal}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join("\n")}\n\n## Non-goals\n${item.nonGoals.map((a) => `- ${a}`).join("\n")}\n\n## Dependencies\n${item.dependencies.length ? item.dependencies.map((id) => `- ${id}`).join("\n") : "- None"}\n\n## Sources\n${item.citations.map((c) => `- ${c.path}${c.heading ? ` — ${c.heading}` : ""}`).join("\n")}\n\n## Owned paths\n${item.ownedPaths.map((p) => `- ${p}`).join("\n")}\n\n## Validation\n${item.validation.map((check) => `- \`${check.command}\` (${check.provenance}${check.source ? `: ${check.source}` : ""})`).join("\n")}\n\n## Brief\n${item.brief}${item.executionBinding ? `\n\n## Assigned execution profile\n${JSON.stringify(item.executionProfile)}\n\nResolved binding: ${JSON.stringify(item.executionBinding)}` : ""}`;
}

export class RealGitHubGateway implements GitHubGateway {
  constructor(
    readonly repository: string,
    private readonly native: NativeStackDelivery,
    private readonly client: GitHubClient = sharedGitHubClient,
  ) {}

  private route(path: string): string {
    return `repos/${this.repository}/${path}`;
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
      const result = await this.client.request<{
        total_count: number;
        check_runs: CheckRun[];
      }>(
        "GET",
        this.route(
          `commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100&page=${page}`,
        ),
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
      throw new Error("Required named CI check is ambiguous");
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

  async findOpenPullRequest(
    branch: string,
    base: string,
    headSha: string,
  ): Promise<PullRequestIdentity | undefined> {
    const owner = this.repository.split("/")[0]!;
    const pulls = await this.client.paginate<Pull>(
      this.route(
        `pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      ),
    );
    if (pulls.length > 1) throw new Error(`Multiple open PRs for ${branch}`);
    const pull = pulls[0];
    if (!pull) return undefined;
    if (
      pull.head.sha !== headSha ||
      pull.base.ref !== base ||
      pull.head.ref !== branch
    )
      throw new Error(`Existing PR for ${branch} changed head or base`);
    return { number: pull.number, branch, headSha };
  }

  async defaultBranch(): Promise<string> {
    const result = await this.client.request<{ default_branch: string }>(
      "GET",
      this.route(""),
    );
    if (!result.default_branch)
      throw new Error("Repository has no default branch");
    return result.default_branch;
  }

  async objective(number: number): Promise<ObjectiveIssue> {
    const issue = await this.client.request<Issue>(
      "GET",
      this.route(`issues/${number}`),
    );
    if (
      issue.pull_request ||
      issue.number !== number ||
      !["open", "closed"].includes(issue.state)
    )
      throw new Error("Objective issue identity or state changed");
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
    const observed = await this.client.request<{
      status: number;
      etag?: string;
      data?: Issue[];
    }>(
      "GET",
      this.route(
        `issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
      ),
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
    const blockedBy = await this.client.paginate<Issue>(
      this.route(`issues/${number}/dependencies/blocked_by`),
    );
    return blockedBy.map((issue) => {
      if (
        issue.pull_request ||
        !Number.isSafeInteger(issue.number) ||
        issue.repository_url !==
          `https://api.github.com/repos/${this.repository}`
      )
        throw new Error(
          "Objective predecessor is outside the bound repository",
        );
      return issue.number;
    });
  }

  async closeIssue(
    number: number,
    comment: string,
    expected: { body?: string; workItem?: { objective: number; id: string } },
  ): Promise<void> {
    const issue = await this.client.request<Issue>(
      "GET",
      this.route(`issues/${number}`),
    );
    const marker = expected.workItem
      ? `<!-- factory:objective=${expected.workItem.objective};item=${expected.workItem.id} -->`
      : undefined;
    if (
      issue.pull_request ||
      issue.number !== number ||
      (marker && (issue.body ?? "").split(marker).length !== 2) ||
      (expected.body !== undefined && issue.body !== expected.body)
    )
      throw new Error(
        `Issue #${number} identity changed; operator direction required`,
      );
    const comments = await this.client.paginate<{ body: string }>(
      this.route(`issues/${number}/comments`),
    );
    if (!comments.some((entry) => entry.body === comment)) {
      if (issue.state !== "open")
        throw new Error(
          `Issue #${number} closed without Factory completion evidence; operator direction required`,
        );
      await this.client.request(
        "POST",
        this.route(`issues/${number}/comments`),
        { body: comment },
      );
    }
    if (issue.state === "open")
      await this.client.request("PATCH", this.route(`issues/${number}`), {
        state: "closed",
        state_reason: "completed",
      });
    else if (issue.state !== "closed")
      throw new Error(`Issue #${number} has unexpected state`);
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
    const labels = await this.client.paginate<{
      name: string;
      archived_at?: string | null;
    }>(this.route("labels"));
    for (const role of roles) {
      const matches = labels.filter((label) => label.name === role);
      if (matches.length > 1 || matches[0]?.archived_at)
        throw new Error(
          `Required Factory role label is archived or ambiguous: ${role}`,
        );
      if (!matches.length) {
        await this.client.request("POST", this.route("labels"), {
          name: role,
          color: "ededed",
        });
        const observed = await this.client.paginate<{
          name: string;
          archived_at?: string | null;
        }>(this.route("labels"));
        const created = observed.filter((label) => label.name === role);
        if (created.length !== 1 || created[0]!.archived_at)
          throw new Error(
            `Factory role label creation did not reconcile exactly: ${role}`,
          );
      }
    }
    const ensureRole = async (issue: Issue, role: string): Promise<Issue> => {
      const names = (issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name,
      );
      if (names.includes(role)) return issue;
      await this.client.request(
        "POST",
        this.route(`issues/${issue.number}/labels`),
        { labels: [role] },
      );
      const observed = authenticated(
        await this.client.request<Issue>(
          "GET",
          this.route(`issues/${issue.number}`),
        ),
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
        !observedNames.includes(role) ||
        names.some((name) => !observedNames.includes(name))
      )
        throw new Error(
          "Factory role label did not reconcile exactly; issue changed",
        );
      return observed;
    };
    const objective = authenticated(
      await this.client.request<Issue>(
        "GET",
        this.route(`issues/${request.objectiveIssue}`),
      ),
      request.objectiveIssue,
    );
    await ensureRole(objective, roles[0]!);
    const issueByItemId: Record<string, number> = {};
    const issues = new Map<number, Issue>();
    let existing: Issue[] | undefined;
    for (const item of request.graph.items) {
      const marker = `<!-- factory:objective=${request.objectiveIssue};item=${item.id} -->`;
      const known = request.knownIssues?.[item.id];
      let found: Issue | undefined;
      if (known !== undefined) {
        found = await this.client.request<Issue>(
          "GET",
          this.route(`issues/${known}`),
        );
        if (
          found.number !== known ||
          found.pull_request ||
          (found.body ?? "").split(marker).length !== 2
        )
          throw new Error(
            `Known Work Item issue for ${item.id} changed identity`,
          );
      } else {
        existing ??= (
          await this.client.paginate<Issue>(this.route("issues?state=all"))
        ).filter((issue) => !issue.pull_request);
        const matches = existing.filter((issue) =>
          issue.body?.includes(marker),
        );
        if (matches.length > 1)
          throw new Error(
            `Multiple Work Item issues for ${item.id}; operator direction required`,
          );
        found = matches[0];
        if (found && (found.body ?? "").split(marker).length !== 2)
          throw new Error(
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
            throw new Error("Unreviewed remote issue closure");
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
              throw new Error(
                `Work Item ${item.id} projection changed; edits are proposals, not graph authority`,
              );
            await this.client.request(
              "PATCH",
              this.route(`issues/${found.number}`),
              { title: item.title, body: expectedBody },
            );
            const observed = await this.client.request<Issue>(
              "GET",
              this.route(`issues/${found.number}`),
            );
            authenticated(observed, found.number);
            if (
              observed.id !== found.id ||
              observed.body !== expectedBody ||
              observed.title !== item.title
            )
              throw new Error(
                "Amendment issue projection did not reconcile exactly",
              );
            found = observed;
          }
        }
        if (
          !request.previousGraph &&
          (found.body !== projectedIssueBody(item, request.objectiveIssue) ||
            found.title !== item.title ||
            found.state !== "open")
        )
          throw new Error(
            `Work Item ${item.id} projection changed; edits are proposals, not graph authority`,
          );
        found = await ensureRole(found, roles[1]!);
        issueByItemId[item.id] = found.number;
        issues.set(found.number, found);
        request.projected?.(item.id, found.number);
        continue;
      }
      const body = projectedIssueBody(item, request.objectiveIssue);
      await request.beforeCreate?.(item.id);
      const created = await this.client.request<Issue>(
        "POST",
        this.route("issues"),
        { title: item.title, body, labels: [roles[1]!] },
      );
      if (
        !created ||
        !Number.isSafeInteger(created.number) ||
        created.number <= 0
      )
        throw new Error(
          "Cannot parse created Work Item issue identity; outcome unknown",
        );
      authenticated(created);
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
      existing?.push(created);
    }
    for (const item of request.graph.items) {
      const number = issueByItemId[item.id]!;
      const observations = await this.client.paginate<Issue>(
        this.route(`issues/${number}/dependencies/blocked_by`),
      );
      for (const issue of observations) {
        authenticated(issue);
        if (issues.get(issue.number)?.id !== issue.id)
          throw new Error("Unreviewed remote dependency edit");
      }
      if (
        new Set(observations.map((issue) => issue.number)).size !==
        observations.length
      )
        throw new Error("Ambiguous remote dependency identity");
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
        throw new Error("Unreviewed remote dependency edit");
      if (request.previousGraph) {
        for (const issue of observations) {
          if (
            item.dependencies.some((id) => issueByItemId[id] === issue.number)
          )
            continue;
          await this.client.request(
            "DELETE",
            this.route(`issues/${number}/dependencies/blocked_by/${issue.id}`),
          );
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
          await this.client.request(
            "POST",
            this.route(`issues/${number}/dependencies/blocked_by`),
            { issue_id: issue.id },
          );
        }
      }
      {
        const observed = await this.client.paginate<Issue>(
          this.route(`issues/${number}/dependencies/blocked_by`),
        );
        const expected = item.dependencies.map((id) => issueByItemId[id]);
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
          throw new Error("Work Item dependencies did not reconcile exactly");
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
        const existing = await this.client.paginate<Issue>(
          this.route(`issues/${parent}/sub_issues`),
        );
        for (const issue of existing) {
          authenticated(issue);
          if (issues.get(issue.number)?.id !== issue.id)
            throw new Error("Ambiguous remote hierarchy identity");
          if (
            observedParents.has(issue.number) ||
            (desiredParents.get(issue.number) !== parent &&
              previousParents.get(issue.number) !== parent)
          )
            throw new Error("Unreviewed remote hierarchy edit");
          observedParents.set(issue.number, parent);
        }
      }
      for (const [child, parent] of desiredParents) {
        const currentParent = observedParents.get(child);
        if (currentParent === parent) continue;
        const childIssue = authenticated(
          await this.client.request<Issue>(
            "GET",
            this.route(`issues/${child}`),
          ),
          child,
        );
        if (childIssue.id !== issues.get(child)!.id)
          throw new Error("Ambiguous remote hierarchy identity");
        const replacing = currentParent !== undefined;
        let observedParent: Issue | undefined;
        try {
          observedParent = authenticated(
            await this.client.request<Issue>(
              "GET",
              this.route(`issues/${child}/parent`),
            ),
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
          throw new Error("Unreviewed remote hierarchy parent");
        await this.client.request(
          "POST",
          this.route(`issues/${parent}/sub_issues`),
          { sub_issue_id: childIssue.id, replace_parent: replacing },
        );
      }
      // Read back every affected parent, including those that became empty.
      for (const [parent, children] of childrenByParent) {
        const observed = await this.client.paginate<Issue>(
          this.route(`issues/${parent}/sub_issues`),
        );
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
          throw new Error("Work Item hierarchy did not reconcile exactly");
      }
    }
    return { issueByItemId };
  }

  /** Observe old/new facts only. This never completes or accepts a graph projection. */
  async publish(request: PullRequestPublication): Promise<PullRequestIdentity> {
    const detail = await this.client.request<Pull>(
      "POST",
      this.route("pulls"),
      {
        head: request.branch,
        base: request.base,
        title: request.title,
        body: request.body,
      },
    );
    if (
      !Number.isSafeInteger(detail.number) ||
      !detail.head?.sha ||
      detail.head.ref !== request.branch
    )
      throw new Error("Cannot verify created PR identity; outcome unknown");
    return {
      number: detail.number,
      branch: request.branch,
      headSha: detail.head.sha,
    };
  }

  async observe(
    identity: PullRequestIdentity,
  ): Promise<PullRequestObservation> {
    const detail = await this.client.request<Pull>(
      "GET",
      this.route(`pulls/${identity.number}`),
    );
    if (
      detail.head.sha !== identity.headSha ||
      detail.head.ref !== identity.branch ||
      (identity.baseBranch !== undefined &&
        detail.base?.ref !== identity.baseBranch)
    )
      throw new Error(
        `PR #${identity.number} identity changed; operator direction required`,
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
      const result = await this.client.request<{ check_runs: typeof runs }>(
        "GET",
        this.route(
          `commits/${identity.headSha}/check-runs?filter=latest&per_page=100&page=${page}`,
        ),
      );
      if (!Array.isArray(result.check_runs))
        throw new Error("PR CI response lacks check runs");
      runs.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    const statuses = await this.client.request<{
      state: string;
      total_count: number;
    }>("GET", this.route(`commits/${identity.headSha}/status`));
    const failing =
      runs.some(
        (run) =>
          run.conclusion !== null &&
          !["success", "neutral", "skipped"].includes(run.conclusion),
      ) || ["error", "failure"].includes(statuses.state);
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
      const readiness = await this.client.pullRequestReadiness(
        this.repository,
        identity.number,
      );
      if (
        readiness.headRefOid !== identity.headSha ||
        readiness.headRefName !== identity.branch ||
        readiness.baseRefName !== detail.base?.ref
      )
        throw new Error(
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
        case "UNSTABLE":
          mergeReadiness =
            runs.some((run) => run.status !== "completed") ||
            (statuses.total_count > 0 && statuses.state === "pending")
              ? "waiting"
              : "blocked";
          break;
        case "DIRTY":
        case "BEHIND":
        case "DRAFT":
          mergeReadiness = "blocked";
          break;
        default:
          throw new Error("GitHub PR readiness status is unsupported");
      }
    }
    return {
      namedChecks,
      ...(mergeReadiness ? { mergeReadiness } : {}),
      state: detail.merged
        ? "merged"
        : detail.state === "closed"
          ? "closed"
          : "open",
      checks: failing
        ? "failing"
        : runs.some((run) => run.status !== "completed") ||
            (statuses.total_count > 0 && statuses.state === "pending")
          ? "pending"
          : "passing",
    };
  }

  async merge(
    identity: PullRequestIdentity,
    expectedHead: string,
  ): Promise<MergeResult> {
    if (expectedHead !== identity.headSha)
      throw new Error("Merge expected head differs from PR identity");
    // A merge whose response was lost has already happened: confirm it
    // rather than merging again.
    const current = await this.client.request<Pull>(
      "GET",
      this.route(`pulls/${identity.number}`),
    );
    if (current.merged) {
      if (
        current.head.sha !== expectedHead ||
        current.head.ref !== identity.branch
      )
        throw new Error(
          `PR #${identity.number} was merged at a different head; operator direction required`,
        );
      return {
        integratedSha: await timelineMergeCommit(
          this.client,
          this.repository,
          identity.number,
        ),
      };
    }
    const result = await this.client.request<{ merged: boolean; sha: string }>(
      "PUT",
      this.route(`pulls/${identity.number}/merge`),
      { sha: expectedHead, merge_method: "merge" },
    );
    if (
      result.merged !== true ||
      typeof result.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(result.sha)
    )
      throw new Error("PR merge did not produce an integrated commit");
    const detail = await this.client.request<Pull>(
      "GET",
      this.route(`pulls/${identity.number}`),
    );
    if (
      detail.state !== "closed" ||
      detail.merged !== true ||
      detail.head.sha !== expectedHead ||
      detail.head.ref !== identity.branch
    )
      throw new Error("PR merge has not confirmed the exact integrated commit");
    return { integratedSha: result.sha };
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
      beforeMerge?: () => void;
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
    },
  ): Promise<string> {
    return this.native.mergeStack(layers, baseBranch, expectedStack, options);
  }
}
