import type { CoreConfig } from "./config.js";
import { crashPoint } from "./crash.js";
import type { GitHub, GraphQLError } from "./github.js";
import { WORK_ITEM_LABEL } from "./github-roles.js";

/** One Objective card on the Project. */
export interface QueueItem {
  issue: number;
  itemId: string;
  /** The Factory field's option name, or null when unset. */
  option: string | null;
  /** When the option was last set, by anyone (GitHub's clock). */
  optionAt: string | null;
  order: number | null;
  /** Whether the issue is open. A closed one is queued only to run a finished Objective again. */
  open: boolean;
}

/** A queue read: the cards, and what it couldn't read. */
export interface QueueRead {
  /** Queued cards, and the cards of `known` issues: a known issue missing here has no card on the Project. */
  items: QueueItem[];
  /** Known issues GitHub no longer has here: deleted, transferred or converted. */
  gone: number[];
  /** Queued cards past the read's bound, left for a later read. */
  truncated: number;
  /**
   * Known issues GitHub answered with an error for that issue alone, and
   * no card for them from the Project: callers keep their last good view
   * of each.
   */
  unread: number[];
  /** What the read left out and why (GitHub's error), for the log: the issue when known. */
  skipped: Skipped[];
}

/** An entry a read left out: GitHub answered with an error for it alone. */
export interface Skipped {
  issue?: number;
  error: string;
}

/** Whether `error` lies below `prefix` in the data. */
const under = (error: GraphQLError, prefix: readonly string[]) =>
  (error.path?.length ?? 0) > prefix.length &&
  prefix.every((part, at) => error.path?.[at] === part);

/** The first error below `prefix`, by the index or alias that follows it. */
function errorsUnder(
  errors: readonly GraphQLError[],
  prefix: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const error of errors) {
    const key = String(error.path?.[prefix.length]);
    if (under(error, prefix) && !found.has(key)) found.set(key, error.message);
  }
  return found;
}

/*
 * The Project's queued cards, filtered by GitHub (the items `query`), so a
 * read costs one page per 100 queued cards, not per card ever added. GitHub
 * serves that list from a search index that can lag or omit cards (seen
 * for minutes on a new Project), so the issues Factory already knows
 * (queued or running) and the most recently updated open issues (a new
 * issue added to the Project by its form) are also read from the issue
 * side, which GitHub reads directly. Cost follows the queue and the active
 * work, not the Project's history or the repository's open issues.
 */
const ITEMS = `
query($project: ID!, $after: String, $query: String!, $field: String!, $order: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $after, query: $query) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          option: fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
          order: fieldValueByName(name: $order) {
            ... on ProjectV2ItemFieldNumberValue { number }
          }
          content {
            ... on Issue { number state repository { nameWithOwner } }
          }
        }
      }
    }
  }
}`;

const ITEM_FIELDS = `
fragment Item on ProjectV2Item {
  id
  isArchived
  project { id }
  option: fieldValueByName(name: $field) {
    ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
  }
  order: fieldValueByName(name: $order) {
    ... on ProjectV2ItemFieldNumberValue { number }
  }
}`;

const ISSUE_FIELDS = `
fragment Card on Issue {
  number
  state
  repository { nameWithOwner }
  body
  projectItems(first: 20) {
    pageInfo { hasNextPage endCursor }
    nodes { ...Item }
  }
}
${ITEM_FIELDS}`;

/** An issue's further Project cards, for one on more Projects than the first page. */
const MORE_ITEMS = `
query($owner: String!, $name: String!, $number: Int!, $after: String, $field: String!, $order: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      projectItems(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...Item }
      }
    }
  }
}
${ITEM_FIELDS}`;

/** Recently updated open issues, and these issues by number. */
const issuesQuery = (numbers: number[]) => `
query($owner: String!, $name: String!, $field: String!, $order: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    recent: issues(states: OPEN, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ...Card }
    }
${numbers.map((n) => `    i${n}: issue(number: ${n}) { ...Card }`).join("\n")}
  }
}
${ISSUE_FIELDS}`;

type Value = { name?: string; number?: number; updatedAt?: string } | null;

/**
 * A Work Item issue (tracking.ts) is never an Objective: the items query
 * leaves its label out, and an issue read by number is one when its body
 * starts with Factory's item marker, however many labels it has.
 */
const NOT_WORK_ITEM = ` -label:"${WORK_ITEM_LABEL}"`;
const workItem = (body: string | undefined) =>
  /^<!-- factory:\d+:item:/.test(body ?? "");

interface ItemsPage {
  node: {
    items?: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ({
        id: string;
        isArchived: boolean;
        option: Value;
        order: Value;
        content: {
          number?: number;
          state?: string;
          repository?: { nameWithOwner?: string };
        } | null;
      } | null)[];
    };
  } | null;
}

type CardPage = Page<{
  id: string;
  isArchived: boolean;
  project: { id: string };
  option: Value;
  order: Value;
}>;

/** One page of an issue's Project cards. */
interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (T | null)[];
}

interface Card {
  number: number;
  state: string;
  repository: { nameWithOwner: string };
  body?: string;
  projectItems: CardPage;
}

/** Pages of queued cards read at most; the rest wait for a later read. */
const MAX_PAGES = 10;
/** Issues read by number in one request. */
const BY_NUMBER = 50;

/**
 * The Project filter for queued cards: a field is named in lower case with
 * dashes for spaces, and its option is quoted. Closed issues are read too,
 * so a finished Objective queued again is never ignored because its issue
 * is closed (docs/reference/queue.md#Queue).
 */
function queuedFilter(config: CoreConfig): string {
  const field = config.queue.field.trim().toLowerCase().replace(/\s+/g, "-");
  const option = config.queue.options.queued.replace(/"/g, "");
  return `${field}:"${option}"`;
}

/**
 * Every open card of this repository on the Project, whatever its option,
 * for `factory queue list`. Bounded like the queue read.
 */
export async function readCards(
  github: GitHub,
  config: CoreConfig,
  signal?: AbortSignal,
): Promise<{ items: QueueItem[]; truncated: number; skipped: Skipped[] }> {
  const items: QueueItem[] = [];
  const skipped: Skipped[] = [];
  const truncated = await readItems(
    github,
    config,
    "is:open",
    (item) => items.push(item),
    skipped,
    signal,
  );
  return { items, truncated, skipped };
}

/**
 * The other repositories with open issues on the Project, for single
 * player (holder.ts `projectRival`). Bounded like the queue read: a
 * repository whose cards all lie past the bound isn't seen.
 */
export async function projectRepositories(
  github: GitHub,
  config: CoreConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const found = new Set<string>();
  await readItems(
    github,
    config,
    "is:open",
    () => undefined,
    [],
    signal,
    (repository) => found.add(repository),
  );
  return [...found];
}

/**
 * Read the Project's items matching `query`, page by page; returns how
 * many were left unread. An item GitHub answers with an error for (an
 * issue in a repository the login can't read, say) is left out and noted
 * in `skipped`; an error for the Project or its item list fails the read.
 * Another repository's issue goes to `elsewhere`, by its `owner/name`.
 */
async function readItems(
  github: GitHub,
  config: CoreConfig,
  query: string,
  each: (item: QueueItem) => void,
  skipped: Skipped[],
  signal?: AbortSignal,
  elsewhere?: (repository: string) => void,
): Promise<number> {
  const entry = ["node", "items", "nodes"];
  let after: string | null = null;
  for (let page = 0; ; page++) {
    const read: { data: ItemsPage; errors: GraphQLError[] } =
      await github.graphqlPartial<ItemsPage>(
        ITEMS,
        {
          project: config.queue.projectId,
          after,
          query: query + NOT_WORK_ITEM,
          field: config.queue.field,
          order: config.queue.orderField,
        },
        signal,
        (error) => under(error, entry) && Number.isInteger(error.path?.[3]),
      );
    const items = read.data.node?.items;
    if (!items) throw new Error(`Project ${config.queue.projectId} not found`);
    const errored = errorsUnder(read.errors, entry);
    for (const [at, node] of items.nodes.entries()) {
      const content = node?.content;
      const error = errored.get(String(at));
      if (error !== undefined) {
        skipped.push({
          ...(typeof content?.number === "number" && {
            issue: content.number,
          }),
          error,
        });
        continue;
      }
      const repository = content?.repository?.nameWithOwner?.toLowerCase();
      if (!node || node.isArchived || typeof content?.number !== "number")
        continue;
      if (repository !== config.repository.toLowerCase()) {
        if (repository) elsewhere?.(repository);
        continue;
      }
      each({
        issue: content.number,
        itemId: node.id,
        option: node.option?.name ?? null,
        optionAt: node.option?.updatedAt ?? null,
        order: node.order?.number ?? null,
        open: content.state === "OPEN",
      });
    }
    if (!items.pageInfo.hasNextPage) return 0;
    if (page + 1 === MAX_PAGES)
      return Math.max(0, items.totalCount - MAX_PAGES * 100);
    after = items.pageInfo.endCursor;
  }
}

/**
 * Queued issues of this repository on the configured Project, open or
 * closed, and `known` issues (read from the issue side) whatever their
 * option. A known issue GitHub no longer has is reported in `gone`, never
 * a failed read. GitHub's error for one entry (a Project item, a known
 * issue, a recent issue) leaves out that entry alone, noted in `skipped`,
 * and a known issue left out is `unread`. Any other failed read throws,
 * and callers keep their last good view.
 */
export async function readQueue(
  github: GitHub,
  config: CoreConfig,
  known: readonly number[] = [],
  signal?: AbortSignal,
): Promise<QueueRead> {
  const cards = new Map<number, QueueItem | null>();
  const fields = { field: config.queue.field, order: config.queue.orderField };
  const card = (
    issue: number,
    open: boolean,
    node: { id: string; option: Value; order: Value } | undefined,
  ) =>
    cards.set(
      issue,
      node
        ? {
            issue,
            itemId: node.id,
            option: node.option?.name ?? null,
            optionAt: node.option?.updatedAt ?? null,
            order: node.order?.number ?? null,
            open,
          }
        : null,
    );
  const skipped: Skipped[] = [];
  const unread: number[] = [];
  const truncated = await readItems(
    github,
    config,
    queuedFilter(config),
    (item) => cards.set(item.issue, item),
    skipped,
    signal,
  );
  // The issue side is read directly, so it wins over the lagging index.
  const numbers = [...new Set(known)];
  const gone: number[] = [];
  for (let at = 0; at === 0 || at < numbers.length; at += BY_NUMBER) {
    const chunk = numbers.slice(at, at + BY_NUMBER);
    const aliases = new Set(chunk.map((n) => `i${n}`));
    // An error under one issue's alias, or under the recent issues, is
    // that entry's alone: a missing issue (NOT_FOUND on its alias) is
    // gone, any other leaves it unread, and the rest of the read stands.
    const entry = (error: GraphQLError) =>
      error.path?.[0] === "repository" &&
      (aliases.has(String(error.path[1])) || error.path[1] === "recent");
    const { data, errors } = await github.graphqlPartial<{
      repository:
        | (Record<string, Card | { nodes: Card[] } | null> & {
            nameWithOwner: string;
          })
        | null;
    }>(
      issuesQuery(chunk),
      { owner: github.owner, name: github.name, ...fields },
      signal,
      entry,
    );
    if (!data.repository)
      throw new Error(`Repository ${config.repository} not found`);
    // GraphQL resolves an old name: a renamed or transferred repository
    // throws RepositoryMoved here, so `ours` never loses its issues.
    github.sameRepository(data.repository.nameWithOwner);
    const errored = errorsUnder(errors, ["repository"]);
    // The recent issues only find new cards early: one with an error is
    // left out, and all of them when the list itself has one.
    const recentErrors = errorsUnder(errors, ["repository", "recent", "nodes"]);
    const recent = data.repository.recent as { nodes: (Card | null)[] } | null;
    const listError = errors.find(
      (error) =>
        error.path?.[1] === "recent" &&
        error.path.length <= 3 &&
        error.path[0] === "repository",
    )?.message;
    if (listError !== undefined) skipped.push({ error: listError });
    else
      for (const [at, issue] of (recent?.nodes ?? []).entries()) {
        const error = recentErrors.get(String(at));
        if (error !== undefined || !issue) {
          if (error !== undefined)
            skipped.push({
              ...(typeof issue?.number === "number" && {
                issue: issue.number,
              }),
              error,
            });
          continue;
        }
        const problem = await read(issue);
        if (problem) skipped.push({ issue: issue.number, error: problem });
      }
    for (const n of chunk) {
      const alias = `i${n}`;
      const issue = data.repository[alias] as Card | null | undefined;
      const missing = errors.some(
        (error) =>
          error.type === "NOT_FOUND" &&
          error.path?.length === 2 &&
          error.path[0] === "repository" &&
          error.path[1] === alias,
      );
      const error = missing ? undefined : errored.get(alias);
      const problem =
        error ?? (issue && ours(issue, n) ? await read(issue) : undefined);
      if (problem !== undefined) {
        skipped.push({ issue: n, error: problem });
        // The Project's own list may still have shown its card.
        if (!cards.has(n)) unread.push(n);
      } else if (!issue || !ours(issue, n)) {
        // One transferred away reads as the issue it is now: gone from here.
        gone.push(n);
        cards.set(n, null);
      }
    }
  }
  /** The repository itself is checked above: a mismatch here is the issue moved away. */
  function ours(issue: Card, n: number): boolean {
    return (
      issue.number === n &&
      issue.repository.nameWithOwner.toLowerCase() ===
        config.repository.toLowerCase()
    );
  }
  /**
   * An issue's queue card, paging its cards past the first page until
   * found; GitHub's error when a further page had one for it.
   */
  async function read(issue: Card): Promise<string | undefined> {
    if (workItem(issue.body)) return undefined;
    const find = (items: CardPage) =>
      items.nodes.find(
        (n) => n?.project.id === config.queue.projectId && !n.isArchived,
      ) ?? undefined;
    let items = issue.projectItems;
    let node = find(items);
    while (!node && items.pageInfo.hasNextPage) {
      const { data, errors } = await github.graphqlPartial<{
        repository: { issue: { projectItems: CardPage } | null } | null;
      }>(
        MORE_ITEMS,
        {
          owner: github.owner,
          name: github.name,
          number: issue.number,
          after: items.pageInfo.endCursor,
          ...fields,
        },
        signal,
        (error) => under(error, ["repository"]),
      );
      const more = data.repository?.issue?.projectItems;
      if (!more || errors.length)
        return errors[0]?.message ?? `Issue #${issue.number}'s cards not found`;
      items = more;
      node = find(items);
    }
    card(issue.number, issue.state === "OPEN", node);
    return undefined;
  }
  return {
    items: [...cards.values()].filter((item): item is QueueItem => !!item),
    gone,
    truncated,
    unread,
    skipped,
  };
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
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!, $name: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) {
    projectV2Item {
      id
      value: fieldValueByName(name: $name) {
        ... on ProjectV2ItemFieldSingleSelectValue { updatedAt }
      }
    }
  }
}`;

const GET = `
query($item: ID!, $name: String!) {
  node(id: $item) {
    ... on ProjectV2Item {
      isArchived
      value: fieldValueByName(name: $name) {
        ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
      }
    }
  }
}`;

/** Reads and writes the Factory field. Field and option ids are looked up once per process. */
export class QueueDisplay {
  private field?: { id: string; options: Map<string, string> };

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
  ) {}

  /** The card's option now, read directly; null when unset or the card is off the Project. */
  async get(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<{ option: string | null; at?: string }> {
    const data = await this.github.graphql<{
      node: {
        isArchived?: boolean;
        value?: { name?: string; updatedAt?: string } | null;
      } | null;
    }>(GET, { item: itemId, name: this.config.queue.field }, signal);
    const node = data.node;
    if (!node || node.isArchived || !node.value?.name) return { option: null };
    return {
      option: node.value.name,
      ...(node.value.updatedAt ? { at: node.value.updatedAt } : {}),
    };
  }

  /** Set the option; returns when the field now says it was set (GitHub's clock). */
  async set(
    itemId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const field = await this.lookup(signal);
    const optionId = field.options.get(option);
    if (!optionId)
      throw new Error(
        `The Project field "${this.config.queue.field}" has no option "${option}"`,
      );
    const data = await this.github.graphql<{
      updateProjectV2ItemFieldValue: {
        projectV2Item: { value: { updatedAt?: string } | null } | null;
      } | null;
    }>(
      SET,
      {
        project: this.config.queue.projectId,
        item: itemId,
        field: field.id,
        option: optionId,
        name: this.config.queue.field,
      },
      signal,
    );
    return (
      data.updateProjectV2ItemFieldValue?.projectV2Item?.value?.updatedAt ??
      undefined
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

const RUN_ISSUE = `
query($owner: String!, $name: String!, $issue: Int!, $field: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $issue) {
      id
      number
      state
      repository { nameWithOwner }
      projectItems(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          project { id }
          option: fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
        }
      }
    }
  }
}`;

const ADD_ITEM = `
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
    item { id }
  }
}`;

const UNARCHIVE = `
mutation($project: ID!, $item: ID!) {
  unarchiveProjectV2Item(input: { projectId: $project, itemId: $item }) {
    item { id }
  }
}`;

interface RunCard {
  id: string;
  isArchived: boolean;
  project: { id: string };
  option: Value;
}

/**
 * Issue N of this repository and its cards on the queue's Project;
 * undefined when it has none here. An issue on more Projects than a page
 * is read on, page by page, until its card here shows or none is left.
 */
async function runIssue(
  github: GitHub,
  config: CoreConfig,
  issue: number,
  signal?: AbortSignal,
): Promise<{ id: string; open: boolean; cards: RunCard[] } | undefined> {
  let after: string | null = null;
  for (;;) {
    const { data } = await github.graphqlPartial<{
      repository: {
        nameWithOwner: string;
        issue: {
          id: string;
          number: number;
          state: string;
          repository: { nameWithOwner: string };
          projectItems: Page<RunCard>;
        } | null;
      } | null;
    }>(
      RUN_ISSUE,
      {
        owner: github.owner,
        name: github.name,
        issue,
        field: config.queue.field,
        after,
      },
      signal,
      (error) => error.type === "NOT_FOUND" && error.path?.[1] === "issue",
    );
    if (!data.repository)
      throw new Error(`Repository ${config.repository} not found`);
    github.sameRepository(data.repository.nameWithOwner);
    const found = data.repository.issue;
    // A pull request, or an issue transferred away, is no Objective here.
    if (
      found?.number !== issue ||
      found.repository.nameWithOwner.toLowerCase() !==
        config.repository.toLowerCase()
    )
      return undefined;
    const items: Page<RunCard> = found.projectItems;
    const cards = items.nodes.filter(
      (node): node is RunCard => node?.project.id === config.queue.projectId,
    );
    if (cards.length || !items.pageInfo.hasNextPage)
      return { id: found.id, open: found.state === "OPEN", cards };
    after = items.pageInfo.endCursor;
  }
}

/**
 * `factory run N`: set issue N's card to the queued option, adding the
 * issue to the Project (or unarchiving its card) first when it has no
 * card there, so the next queue read admits it, as the operator's queue
 * (this write is the operator's request). A closed issue is queued only
 * when `closed` allows it (a finished Objective runs again; its new run
 * reopens the issue). The operator's latest action wins: a card someone
 * moved to another option after the request was written (`since.at`),
 * other than the option Factory last showed (`since.shown`), is
 * `dequeued`, and left alone. Idempotent otherwise:
 * the Project returns an existing item, and the option is set again.
 */
export async function queueIssue(
  github: GitHub,
  config: CoreConfig,
  display: QueueDisplay,
  issue: number,
  closed: boolean,
  since: { at: string; shown?: string | undefined },
  signal?: AbortSignal,
): Promise<"queued" | "no_such_issue" | "issue_closed" | "dequeued"> {
  const found = await runIssue(github, config, issue, signal);
  if (!found) return "no_such_issue";
  if (!found.open && !closed) return "issue_closed";
  const project = config.queue.projectId;
  const card = found.cards.find((node) => !node.isArchived);
  const changedAt = Date.parse(card?.option?.updatedAt ?? "");
  if (
    card?.option?.name &&
    card.option.name !== config.queue.options.queued &&
    changedAt > Date.parse(since.at) &&
    card.option.name !== since.shown
  )
    return "dequeued";
  let itemId = card?.id;
  if (!itemId && found.cards[0]) {
    itemId = found.cards[0].id;
    await github.graphql(UNARCHIVE, { project, item: itemId }, signal);
  }
  if (!itemId) {
    const added = await github.graphql<{
      addProjectV2ItemById: { item: { id: string } | null } | null;
    }>(ADD_ITEM, { project, content: found.id }, signal);
    itemId = added.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error(`The Project didn't add #${issue}`);
  }
  crashPoint("run:queue:before");
  await display.set(itemId, config.queue.options.queued, signal);
  crashPoint("run:queue:after");
  return "queued";
}

const CARD_PROJECT = `
query($item: ID!) {
  node(id: $item) {
    ... on ProjectV2Item { project { id } }
  }
}`;

/**
 * The Project the Objective's card (`itemId`) is on, where its Work Item
 * cards go; null when the card is gone.
 */
export async function cardProject(
  github: GitHub,
  itemId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { data } = await github.graphqlPartial<{
    node: { project?: { id: string } } | null;
  }>(
    CARD_PROJECT,
    { item: itemId },
    signal,
    (error) => error.type === "NOT_FOUND",
  );
  return data.node?.project?.id ?? null;
}

/**
 * A Work Item issue's card on the Project (tracking.ts). The Project
 * returns the card an issue already has instead of adding another, so
 * this is found before it is made. The card gets no option: it is never
 * a queue candidate (the items query leaves out the Work Item label).
 */
export async function addCard(
  github: GitHub,
  project: string,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  crashPoint("sync:item-issue:card:before");
  const added = await github.graphql<{
    addProjectV2ItemById: { item: { id: string } | null } | null;
  }>(ADD_ITEM, { project, content }, signal);
  const id = added.addProjectV2ItemById?.item?.id;
  if (!id)
    throw new Error(`The Project didn't add the Work Item issue ${content}`);
  crashPoint("sync:item-issue:card:after");
  return id;
}

/**
 * A cancel of a `factory run N` that wasn't admitted yet: a card that
 * still reads queued moves to the cancelled option, so no queue read
 * admits it. Idempotent.
 */
export async function unqueueIssue(
  github: GitHub,
  config: CoreConfig,
  display: QueueDisplay,
  issue: number,
  signal?: AbortSignal,
): Promise<void> {
  const found = await runIssue(github, config, issue, signal);
  const card = found?.cards.find((node) => !node.isArchived);
  if (card?.option?.name !== config.queue.options.queued) return;
  crashPoint("run:unqueue:before");
  await display.set(card.id, config.queue.options.cancelled, signal);
  crashPoint("run:unqueue:after");
}

const FIELDS = `
query($project: ID!, $field: String!, $order: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) {
        ... on ProjectV2SingleSelectField { options { name } }
      }
      order: field(name: $order) {
        ... on ProjectV2Field { dataType }
      }
    }
  }
}`;

/**
 * What the queue's Project lacks, empty when Factory can use it: the
 * single-select field with every configured option, and the number field
 * that orders the queue. Factory never creates them; setup reads them.
 */
export async function projectProblems(
  github: GitHub,
  config: CoreConfig,
): Promise<string[]> {
  const { projectId, field, orderField, options } = config.queue;
  // A field the Project lacks is a NOT_FOUND error at its path, with null data.
  const { data } = await github.graphqlPartial<{
    node: {
      field?: { options?: { name: string }[] } | null;
      order?: { dataType?: string } | null;
    } | null;
  }>(
    FIELDS,
    { project: projectId, field, order: orderField },
    undefined,
    (error) =>
      error.type === "NOT_FOUND" &&
      error.path?.[0] === "node" &&
      (error.path[1] === "field" || error.path[1] === "order"),
  );
  if (!data.node || !("field" in data.node))
    return [
      `queue.projectId ${projectId} is not a Project this login can read`,
    ];
  const problems: string[] = [];
  const names = data.node.field?.options?.map((option) => option.name);
  if (!names)
    problems.push(
      `The Project has no single-select field "${field}": create it with the options ${Object.values(options).join(", ")}`,
    );
  else {
    const missing = Object.values(options).filter(
      (option) => !names.includes(option),
    );
    if (missing.length)
      problems.push(
        `The Project field "${field}" lacks the options ${missing.join(", ")}: add them`,
      );
  }
  if (data.node.order?.dataType !== "NUMBER")
    problems.push(
      `The Project has no number field "${orderField}": create it, so queued Objectives run in order`,
    );
  return problems;
}

/**
 * The Project's built-in status field and the option its "Auto-close
 * issue" workflow closes on, by GitHub's default names: GitHub exposes no
 * field or option attribute that marks them (the field is an ordinary
 * single-select, and the workflow's settings aren't readable). A Project
 * that renamed them only skips the move: the check after the reopen
 * (planning/steps.ts `REOPENED`) still sees an issue the workflow closed
 * again, and asks.
 */
const BUILT_IN_STATUS = "Status";
const DONE = "Done";
/** Options to move a card off Done to, in order of preference; else the first option not named Done. */
const OFF_DONE = ["In Progress", "Todo"];

interface StatusCard {
  id: string;
  isArchived: boolean;
  project: { id: string };
  value: { name?: string } | null;
}

interface StatusField {
  id?: string;
  options?: { id: string; name: string }[];
}

const BUILT_IN = `
query($owner: String!, $name: String!, $issue: Int!, $project: ID!, $field: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $issue) {
      number
      repository { nameWithOwner }
      projectItems(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          project { id }
          value: fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

/**
 * Before a re-queue reopens a closed issue: if the issue's card has the
 * Project's built-in single-select "Status" field (not Factory's own
 * field) set to "Done", move it off Done, so the Project's "Auto-close
 * issue" workflow doesn't close the issue again. Idempotent: a card
 * already off Done, or without the field, is left alone. Returns the
 * option it set, if any.
 */
export async function moveStatusOffDone(
  github: GitHub,
  config: CoreConfig,
  issue: number,
  point: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (config.queue.field === BUILT_IN_STATUS) return undefined;
  // An issue on more Projects than a page is read on until its card shows.
  let after: string | null = null;
  let item: StatusCard | null | undefined;
  let field: StatusField | null | undefined;
  do {
    const data = await github.graphql<{
      repository: {
        nameWithOwner: string;
        issue: {
          number: number;
          repository: { nameWithOwner: string };
          projectItems: Page<StatusCard>;
        } | null;
      } | null;
      node: { field?: StatusField | null } | null;
    }>(
      BUILT_IN,
      {
        owner: github.owner,
        name: github.name,
        issue,
        project: config.queue.projectId,
        field: BUILT_IN_STATUS,
        after,
      },
      signal,
    );
    if (data.repository) github.sameRepository(data.repository.nameWithOwner);
    const found = data.repository?.issue;
    // Never the Status of an issue transferred away.
    if (
      found?.number !== issue ||
      found.repository.nameWithOwner.toLowerCase() !==
        config.repository.toLowerCase()
    )
      return undefined;
    const items: Page<StatusCard> = found.projectItems;
    item = items.nodes.find(
      (n) => n?.project.id === config.queue.projectId && !n.isArchived,
    );
    field = data.node?.field;
    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (!item && after);
  if (!item || item.value?.name !== DONE || !field?.id || !field.options)
    return undefined;
  const options = field.options.filter((o) => o.name !== DONE);
  const target =
    OFF_DONE.map((name) => options.find((o) => o.name === name)).find(
      (o) => o !== undefined,
    ) ?? options[0];
  if (!target) return undefined;
  crashPoint(`${point}:before`);
  await github.graphql(
    SET,
    {
      project: config.queue.projectId,
      item: item.id,
      field: field.id,
      option: target.id,
      name: BUILT_IN_STATUS,
    },
    signal,
  );
  crashPoint(`${point}:after`);
  return target.name;
}
