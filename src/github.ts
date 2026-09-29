import type {
  GitHubGateway,
  GraphProjection,
  MergeResult,
  NativeStackLayer,
  ObjectiveIssue,
  ProjectedGraph,
  PullRequestIdentity,
  PullRequestObservation,
  PullRequestPublication,
} from "./contracts.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { GitHubClient, sharedGitHubClient } from "./github-client.js";

type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  pull_request?: unknown;
};
type Pull = {
  number: number;
  state: string;
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  merge_commit_sha: string | null;
};

export class RealGitHubGateway implements GitHubGateway {
  constructor(
    readonly repository: string,
    private readonly native: NativeStackDelivery,
    private readonly client: GitHubClient = sharedGitHubClient,
  ) {}

  private route(path: string): string {
    return `repos/${this.repository}/${path}`;
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
    return { title: issue.title, body: issue.body ?? "", state: issue.state };
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

  async projectGraph(request: GraphProjection): Promise<ProjectedGraph> {
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
        issueByItemId[item.id] = found.number;
        issues.set(found.number, found);
        request.projected?.(item.id, found.number);
        continue;
      }
      const body = `${marker}\n\n## Goal\n${item.goal}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join("\n")}\n\n## Non-goals\n${item.nonGoals.map((a) => `- ${a}`).join("\n")}\n\n## Dependencies\n${item.dependencies.length ? item.dependencies.map((id) => `- ${id}`).join("\n") : "- None"}\n\n## Sources\n${item.citations.map((c) => `- ${c.path}${c.heading ? ` — ${c.heading}` : ""}`).join("\n")}\n\n## Owned paths\n${item.ownedPaths.map((p) => `- ${p}`).join("\n")}\n\n## Validation\n${item.validation.map((check) => `- \`${check.command}\` (${check.provenance}${check.source ? `: ${check.source}` : ""})`).join("\n")}\n\n## Brief\n${item.brief}${item.executionBinding ? `\n\n## Assigned execution profile\n${JSON.stringify(item.executionProfile)}\n\nResolved binding: ${JSON.stringify(item.executionBinding)}` : ""}`;
      await request.beforeCreate?.(item.id);
      const created = await this.client.request<Issue>(
        "POST",
        this.route("issues"),
        { title: item.title, body },
      );
      if (!Number.isSafeInteger(created.number) || created.number <= 0)
        throw new Error(
          "Cannot parse created Work Item issue identity; outcome unknown",
        );
      request.projected?.(item.id, created.number);
      issueByItemId[item.id] = created.number;
      issues.set(created.number, created);
      existing?.push(created);
    }
    for (const item of request.graph.items) {
      if (!item.dependencies.length) continue;
      const number = issueByItemId[item.id]!;
      const existing = new Set(
        (
          await this.client.paginate<Issue>(
            this.route(`issues/${number}/dependencies/blocked_by`),
          )
        ).map((issue) => issue.number),
      );
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
    }
    return { issueByItemId };
  }

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
      detail.head.ref !== identity.branch
    )
      throw new Error(
        `PR #${identity.number} identity changed; operator direction required`,
      );
    const runs: { conclusion: string | null; status: string }[] = [];
    for (let page = 1; ; page++) {
      const result = await this.client.request<{ check_runs: typeof runs }>(
        "GET",
        this.route(
          `commits/${identity.headSha}/check-runs?per_page=100&page=${page}`,
        ),
      );
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
    return {
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
    const result = await this.client.request<{ merged: boolean; sha: string }>(
      "PUT",
      this.route(`pulls/${identity.number}/merge`),
      { sha: expectedHead, merge_method: "merge" },
    );
    if (!result.merged || !result.sha)
      throw new Error("PR merge did not produce an integrated commit");
    const detail = await this.client.request<Pull>(
      "GET",
      this.route(`pulls/${identity.number}`),
    );
    if (
      !detail.merged ||
      detail.head.sha !== expectedHead ||
      detail.head.ref !== identity.branch ||
      detail.merge_commit_sha !== result.sha
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
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
    },
  ): Promise<string> {
    return this.native.mergeStack(layers, baseBranch, expectedStack, options);
  }
}
