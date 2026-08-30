/**
 * GitHub reader (§2).
 *
 * The only job of this module is to turn GitHub into a snapshot. It performs no
 * judgement — every classification lives in `state.ts` — and it performs no
 * writes, which keeps the read path safe to run against a live repository at
 * any time.
 *
 * One GraphQL round trip per cycle where possible (§4.1). PROBE-001 triggered a
 * client-side 429 from naive polling, so throttling and retry are configured
 * rather than optional.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

import type {
  CheckRollup,
  IssueRef,
  LinkedPullRequest,
  ObjectiveSnapshot,
  WorkItemSnapshot,
} from "./types.js";
import { COPILOT_LOGIN } from "./types.js";

const FactoryOctokit = Octokit.plugin(retry, throttling);

export interface GitHubOptions {
  token: string;
  owner: string;
  repo: string;
  /** Called on throttle/abuse events so the loop can log pacing decisions. */
  onThrottle?: (message: string) => void;
}

/**
 * Fetches the Objective and its Work Items in a single query.
 *
 * `subIssues`, `blockedBy` and `closedByPullRequestsReferences` are all native
 * GitHub relationships (verified against the live schema), which is what makes
 * the "no sidecar state" claim in §3.1 hold.
 */
const OBJECTIVE_QUERY = `
query Objective($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      state
      subIssues(first: 100) {
        nodes {
          number
          title
          state
          assignees(first: 10) { nodes { login } }
          blockedBy(first: 50) { nodes { number state } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            nodes {
              number
              state
              isDraft
              additions
              deletions
              changedFiles
              commits(first: 100) {
                nodes { commit { messageHeadline } }
              }
              statusCheckRollup: commits(last: 1) {
                nodes { commit { statusCheckRollup { state } } }
              }
            }
          }
          timelineItems(last: 10, itemTypes: [ASSIGNED_EVENT]) {
            nodes {
              ... on AssignedEvent {
                createdAt
                assignee {
                  ... on Bot { login }
                  ... on User { login }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface GqlIssueState {
  state: "OPEN" | "CLOSED";
}

interface GqlPr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { nodes: { commit: { messageHeadline: string } }[] };
  statusCheckRollup: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
}

interface GqlAssignedEvent {
  createdAt: string;
  assignee: { login?: string } | null;
}

interface GqlWorkItem extends GqlIssueState {
  number: number;
  title: string;
  assignees: { nodes: { login: string }[] };
  blockedBy: { nodes: ({ number: number } & GqlIssueState)[] };
  closedByPullRequestsReferences: { nodes: GqlPr[] };
  timelineItems: { nodes: GqlAssignedEvent[] };
}

interface GqlResponse {
  repository: {
    issue: {
      number: number;
      title: string;
      state: "OPEN" | "CLOSED";
      subIssues: { nodes: GqlWorkItem[] };
    } | null;
  } | null;
}

/**
 * GitHub reports a rich set of rollup states; the loop only needs to know
 * whether checks have settled and, if so, whether they passed.
 */
function normalizeChecks(pr: GqlPr): CheckRollup {
  const raw = pr.statusCheckRollup.nodes[0]?.commit.statusCheckRollup?.state;
  if (!raw) return null;
  switch (raw) {
    case "PENDING":
    case "EXPECTED":
      return "PENDING";
    case "SUCCESS":
      return "SUCCESS";
    default:
      // FAILURE, ERROR — terminal and unsuccessful.
      return "FAILURE";
  }
}

function toPullRequest(pr: GqlPr): LinkedPullRequest {
  return {
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    changedLines: pr.additions + pr.deletions,
    changedFiles: pr.changedFiles,
    commitSubjects: pr.commits.nodes.map((n) => n.commit.messageHeadline),
    checks: normalizeChecks(pr),
  };
}

/**
 * Latest time the coding agent was assigned, from the issue's `AssignedEvent`
 * timeline (§4.2). `null` if it has never been assigned. GitHub auto-assigns
 * the requesting human alongside Copilot (verified live, 2026-08-30), so this
 * filters to the agent's own events rather than trusting timeline order.
 */
function copilotAssignedAt(wi: GqlWorkItem): Date | null {
  const events = wi.timelineItems.nodes.filter(
    (e) => e.assignee?.login === COPILOT_LOGIN,
  );
  if (events.length === 0) return null;
  const latest = events.reduce((max, e) =>
    e.createdAt > max.createdAt ? e : max,
  );
  return new Date(latest.createdAt);
}

function toWorkItem(wi: GqlWorkItem): WorkItemSnapshot {
  const blockedBy: IssueRef[] = wi.blockedBy.nodes.map((d) => ({
    number: d.number,
    closed: d.state === "CLOSED",
  }));

  return {
    number: wi.number,
    title: wi.title,
    closed: wi.state === "CLOSED",
    assignees: wi.assignees.nodes.map((a) => a.login),
    blockedBy,
    linkedPullRequests:
      wi.closedByPullRequestsReferences.nodes.map(toPullRequest),
    copilotAssignedAt: copilotAssignedAt(wi),
  };
}

export class GitHubReader {
  readonly #octokit: Octokit;
  readonly #owner: string;
  readonly #repo: string;

  constructor(opts: GitHubOptions) {
    const notify = opts.onThrottle ?? (() => {});
    this.#owner = opts.owner;
    this.#repo = opts.repo;
    this.#octokit = new FactoryOctokit({
      auth: opts.token,
      throttle: {
        onRateLimit: (after: number, o: { method: string; url: string }) => {
          notify(`rate limit on ${o.method} ${o.url}; retrying in ${after}s`);
          return true;
        },
        onSecondaryRateLimit: (
          after: number,
          o: { method: string; url: string },
        ) => {
          notify(`secondary limit on ${o.method} ${o.url}; retrying in ${after}s`);
          return true;
        },
      },
    });
  }

  /** Read one Objective and everything derivable about its Work Items. */
  async readObjective(number: number): Promise<ObjectiveSnapshot> {
    const data = await this.#octokit.graphql<GqlResponse>(OBJECTIVE_QUERY, {
      owner: this.#owner,
      repo: this.#repo,
      number,
    });

    const issue = data.repository?.issue;
    if (!issue) {
      throw new Error(
        `Objective #${number} not found in ${this.#owner}/${this.#repo}`,
      );
    }

    return {
      number: issue.number,
      title: issue.title,
      closed: issue.state === "CLOSED",
      workItems: issue.subIssues.nodes.map(toWorkItem),
      readAt: new Date(),
    };
  }
}
