import type {
  GitHubGateway,
  GraphProjection,
  ProjectedGraph,
  PullRequestPublication,
  PullRequestIdentity,
  PullRequestObservation,
  MergeResult,
  NativeStackLayer,
  ObjectiveIssue,
} from "./contracts.js";
import { command } from "./process.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";

export class RealGitHubGateway implements GitHubGateway {
  constructor(
    readonly repository: string,
    private readonly native: NativeStackDelivery,
  ) {}

  async findOpenPullRequest(
    branch: string,
    base: string,
    headSha: string,
  ): Promise<PullRequestIdentity | undefined> {
    const pulls = JSON.parse(
      command("gh", [
        "pr",
        "list",
        "-R",
        this.repository,
        "--state",
        "open",
        "--head",
        branch,
        "--json",
        "number,headRefOid,baseRefName",
      ]),
    ) as { number: number; headRefOid: string; baseRefName: string }[];
    if (pulls.length > 1) throw new Error(`Multiple open PRs for ${branch}`);
    const pull = pulls[0];
    if (!pull) return undefined;
    if (pull.headRefOid !== headSha || pull.baseRefName !== base)
      throw new Error(`Existing PR for ${branch} changed head or base`);
    return { number: pull.number, branch, headSha };
  }

  defaultBranch(): string {
    const result = JSON.parse(
      command("gh", [
        "repo",
        "view",
        this.repository,
        "--json",
        "defaultBranchRef",
      ]),
    ) as { defaultBranchRef: { name: string } };
    if (!result.defaultBranchRef?.name)
      throw new Error("Repository has no default branch");
    return result.defaultBranchRef.name;
  }

  async objective(number: number): Promise<ObjectiveIssue> {
    return JSON.parse(
      command("gh", [
        "issue",
        "view",
        String(number),
        "-R",
        this.repository,
        "--json",
        "body,title",
      ]),
    ) as { body: string; title: string };
  }

  async closeIssue(
    number: number,
    comment: string,
    expected: { body?: string; workItem?: { objective: number; id: string } },
  ): Promise<void> {
    const issue = JSON.parse(
      command("gh", ["api", `repos/${this.repository}/issues/${number}`]),
    ) as { body: string; state: string; pull_request?: unknown };
    const marker = expected.workItem
      ? `<!-- factory:objective=${expected.workItem.objective};item=${expected.workItem.id} -->`
      : undefined;
    if (
      issue.pull_request ||
      (marker && issue.body.split(marker).length !== 2) ||
      (expected.body !== undefined && issue.body !== expected.body)
    )
      throw new Error(
        `Issue #${number} identity changed; operator direction required`,
      );
    const pages = JSON.parse(
      command("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${this.repository}/issues/${number}/comments?per_page=100`,
      ]),
    ) as { body: string }[][];
    const commented = pages.flat().some((entry) => entry.body === comment);
    if (!commented) {
      if (issue.state !== "open")
        throw new Error(
          `Issue #${number} closed without Factory completion evidence; operator direction required`,
        );
      command("gh", [
        "issue",
        "comment",
        String(number),
        "-R",
        this.repository,
        "--body",
        comment,
      ]);
    }
    if (issue.state === "open")
      command("gh", [
        "issue",
        "close",
        String(number),
        "-R",
        this.repository,
        "--reason",
        "completed",
      ]);
    else if (issue.state !== "closed")
      throw new Error(`Issue #${number} has unexpected state ${issue.state}`);
  }

  async projectGraph(request: GraphProjection): Promise<ProjectedGraph> {
    const issueByItemId: Record<string, number> = {};
    const pages = JSON.parse(
      command("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${this.repository}/issues?state=all&per_page=100`,
      ]),
    ) as { number: number; body: string | null; pull_request?: unknown }[][];
    const existing = pages.flat().filter((issue) => !issue.pull_request);
    for (const item of request.graph.items) {
      const marker = `<!-- factory:objective=${request.objectiveIssue};item=${item.id} -->`;
      const matches = existing.filter((issue) => issue.body?.includes(marker));
      if (matches.length > 1)
        throw new Error(
          `Multiple Work Item issues for ${item.id}; operator direction required`,
        );
      const found = matches[0];
      if (found) {
        issueByItemId[item.id] = found.number;
        continue;
      }
      const body = `${marker}\n\n## Goal\n${item.goal}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join("\n")}\n\n## Non-goals\n${item.nonGoals.map((a) => `- ${a}`).join("\n")}\n\n## Dependencies\n${item.dependencies.length ? item.dependencies.map((id) => `- ${id}`).join("\n") : "- None"}\n\n## Sources\n${item.citations.map((c) => `- ${c.path}${c.heading ? ` — ${c.heading}` : ""}`).join("\n")}\n\n## Owned paths\n${item.ownedPaths.map((p) => `- ${p}`).join("\n")}\n\n## Validation\n${item.validation.map((check) => `- \`${check.command}\` (${check.provenance}${check.source ? `: ${check.source}` : ""})`).join("\n")}\n\n## Brief\n${item.brief}${item.executionBinding ? `\n\n## Assigned execution profile\n${JSON.stringify(item.executionProfile)}\n\nResolved binding: ${JSON.stringify(item.executionBinding)}` : ""}`;
      const url = command("gh", [
        "issue",
        "create",
        "-R",
        this.repository,
        "--title",
        item.title,
        "--body",
        body,
      ]);
      const number = Number(url.match(/\/(\d+)$/)?.[1]);
      if (!number)
        throw new Error(`Cannot parse created Work Item issue: ${url}`);
      issueByItemId[item.id] = number;
      existing.push({ number, body });
    }
    for (const item of request.graph.items) {
      if (!item.dependencies.length) continue;
      const number = issueByItemId[item.id]!;
      const existing = new Set(
        command("gh", [
          "api",
          "--paginate",
          `repos/${this.repository}/issues/${number}/dependencies/blocked_by`,
          "--jq",
          ".[].number",
        ])
          .split("\n")
          .filter(Boolean)
          .map(Number),
      );
      for (const dependency of item.dependencies) {
        const blocker = issueByItemId[dependency]!;
        if (!existing.has(blocker)) {
          command("gh", [
            "issue",
            "edit",
            String(number),
            "-R",
            this.repository,
            "--add-blocked-by",
            String(blocker),
          ]);
        }
      }
    }
    return { issueByItemId };
  }

  async publish(request: PullRequestPublication): Promise<PullRequestIdentity> {
    const url = command("gh", [
      "pr",
      "create",
      "-R",
      this.repository,
      "--head",
      request.branch,
      "--base",
      request.base,
      "--title",
      request.title,
      "--body",
      request.body,
    ]);
    const number = Number(url.match(/\/(\d+)$/)?.[1]);
    if (!number) throw new Error(`Cannot parse created PR: ${url}`);
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(number),
        "-R",
        this.repository,
        "--json",
        "headRefOid",
      ]),
    ) as { headRefOid: string };
    return { number, branch: request.branch, headSha: detail.headRefOid };
  }

  async observe(
    identity: PullRequestIdentity,
  ): Promise<PullRequestObservation> {
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(identity.number),
        "-R",
        this.repository,
        "--json",
        "state,statusCheckRollup,headRefOid,headRefName",
      ]),
    ) as {
      state: string;
      headRefOid: string;
      headRefName: string;
      statusCheckRollup: { conclusion?: string; status?: string }[];
    };
    if (
      detail.headRefOid !== identity.headSha ||
      detail.headRefName !== identity.branch
    )
      throw new Error(
        `PR #${identity.number} identity changed; operator direction required`,
      );
    const checks = detail.statusCheckRollup ?? [];
    return {
      state:
        detail.state === "MERGED"
          ? "merged"
          : detail.state === "CLOSED"
            ? "closed"
            : "open",
      checks: checks.some((c) => c.conclusion === "FAILURE")
        ? "failing"
        : checks.some((c) => c.status !== "COMPLETED")
          ? "pending"
          : "passing",
    };
  }

  async merge(
    identity: PullRequestIdentity,
    expectedHead: string,
  ): Promise<MergeResult> {
    command("gh", [
      "pr",
      "merge",
      String(identity.number),
      "-R",
      this.repository,
      "--merge",
      "--match-head-commit",
      expectedHead,
    ]);
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(identity.number),
        "-R",
        this.repository,
        "--json",
        "mergeCommit,state",
      ]),
    ) as { mergeCommit: { oid: string } | null; state: string };
    if (detail.state !== "MERGED" || !detail.mergeCommit)
      throw new Error("PR merge did not produce an integrated commit");
    return { integratedSha: detail.mergeCommit.oid };
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
