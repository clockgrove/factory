import type { CoreConfig } from "./config.js";
import type { GitHub } from "./github.js";

/** One Objective card on the Project. */
export interface QueueItem {
  issue: number;
  itemId: string;
  /** The Factory field's option name, or null when unset. */
  option: string | null;
  order: number | null;
  open: boolean;
}

/*
 * Read from the issue side: each open issue's Project items. GitHub's
 * project-level item list is a search index that can lag or omit cards
 * (seen for minutes on a new Project); an issue's own project items are
 * read directly. Cost follows the number of open issues.
 */
const ISSUES = `
query($owner: String!, $name: String!, $after: String, $field: String!, $order: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        projectItems(first: 20) {
          nodes {
            id
            isArchived
            project { id }
            option: fieldValueByName(name: $field) {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            order: fieldValueByName(name: $order) {
              ... on ProjectV2ItemFieldNumberValue { number }
            }
          }
        }
      }
    }
  }
}`;

interface IssuesPage {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        projectItems: {
          nodes: {
            id: string;
            isArchived: boolean;
            project: { id: string };
            option: { name?: string } | null;
            order: { number?: number } | null;
          }[];
        };
      }[];
    };
  } | null;
}

/** Open issues that are on the configured Project. Throws on any failed page: callers keep their last good view. */
export async function readQueue(
  github: GitHub,
  config: CoreConfig,
  signal?: AbortSignal,
): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const data: IssuesPage = await github.graphql<IssuesPage>(
      ISSUES,
      {
        owner: github.owner,
        name: github.name,
        after,
        field: config.queue.field,
        order: config.queue.orderField,
      },
      signal,
    );
    if (!data.repository)
      throw new Error(`Repository ${config.repository} not found`);
    for (const issue of data.repository.issues.nodes) {
      const node = issue.projectItems.nodes.find(
        (n) => n.project.id === config.queue.projectId && !n.isArchived,
      );
      if (!node) continue;
      items.push({
        issue: issue.number,
        itemId: node.id,
        option: node.option?.name ?? null,
        order: node.order?.number ?? null,
        open: true,
      });
    }
    const info = data.repository.issues.pageInfo;
    if (!info.hasNextPage) break;
    after = info.endCursor;
  }
  return items;
}

/** Queued Objectives in queue order: the order field, then issue number. */
export function queued(items: QueueItem[], config: CoreConfig): QueueItem[] {
  return items
    .filter((item) => item.open && item.option === config.queue.options.queued)
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) || a.issue - b.issue,
    );
}

const FIELD = `
query($project: ID!, $field: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

const SET = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

/** Writes the Factory field. Field and option ids are looked up once per process. */
export class QueueDisplay {
  private field?: { id: string; options: Map<string, string> };

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
  ) {}

  async set(
    itemId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const field = await this.lookup(signal);
    const optionId = field.options.get(option);
    if (!optionId)
      throw new Error(
        `The Project field "${this.config.queue.field}" has no option "${option}"`,
      );
    await this.github.graphql(
      SET,
      {
        project: this.config.queue.projectId,
        item: itemId,
        field: field.id,
        option: optionId,
      },
      signal,
    );
  }

  private async lookup(signal?: AbortSignal) {
    if (this.field) return this.field;
    const data = await this.github.graphql<{
      node: {
        field: { id?: string; options?: { id: string; name: string }[] } | null;
      } | null;
    }>(
      FIELD,
      { project: this.config.queue.projectId, field: this.config.queue.field },
      signal,
    );
    const field = data.node?.field;
    if (!field?.id || !field.options)
      throw new Error(
        `The Project has no single-select field "${this.config.queue.field}"`,
      );
    this.field = {
      id: field.id,
      options: new Map(field.options.map((o) => [o.name, o.id])),
    };
    return this.field;
  }
}
