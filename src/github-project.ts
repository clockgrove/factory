import type {
  GitHubProjectStatusConfig,
  ProjectStatusObservation,
  ProjectStatusRequest,
} from "./github-project-state.js";
import {
  assertGitHubProjectStatusConfig,
  discoveredStatusOptions,
} from "./github-project-state.js";

/** The adapter supplies the existing authenticated, classified GitHub transport. */
export type ProjectGraphQL = <T>(
  query: string,
  variables: Record<string, unknown>,
  readOnly: boolean,
) => Promise<T>;
type Card = {
  id: string;
  isArchived: boolean;
  project: { id: string };
  content: {
    __typename: string;
    number?: number;
    repository?: { nameWithOwner: string };
  };
  fieldValues: {
    nodes: ({
      __typename: string;
      optionId?: string;
      field?: { id: string };
    } | null)[];
    pageInfo: { hasNextPage: boolean };
  };
};
const CARD = `id isArchived project { id } content { __typename ... on Issue { number repository { nameWithOwner } } } fieldValues(first:100) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } } } pageInfo { hasNextPage } }`;

/**
 * The default Project's Status binding: its one single-select field named Status, with an
 * option for every phase by name. Undefined when the field or an option is missing; the
 * caller reports that gap and keeps posting comments.
 */
export async function discoverProjectStatusOnGitHub(
  repository: string,
  discovery: { projectId: string; reservedFieldIds: string[] },
  graphql: ProjectGraphQL,
): Promise<GitHubProjectStatusConfig | undefined> {
  const [owner] = repository.split("/");
  const result = await graphql<{
    project: {
      __typename: string;
      id: string;
      owner: { login: string };
      fields: {
        nodes: ({
          __typename: string;
          id: string;
          name: string;
          dataType: string;
          options?: { id: string; name: string }[];
        } | null)[];
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
  }>(
    `query($project:ID!) { project:node(id:$project) { __typename ... on ProjectV2 { id owner { ... on Organization { login } ... on User { login } } fields(first:100) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } } pageInfo { hasNextPage } } } } }`,
    { project: discovery.projectId },
    true,
  );
  const project = result.project;
  if (
    project?.__typename !== "ProjectV2" ||
    project.id !== discovery.projectId ||
    project.owner?.login.toLowerCase() !== owner?.toLowerCase() ||
    project.fields?.pageInfo.hasNextPage !== false
  )
    throw new Error("Queue Project differs from its target or field inventory");
  const fields = project.fields.nodes.filter(
    (field) =>
      field?.__typename === "ProjectV2SingleSelectField" &&
      field.name === "Status" &&
      field.dataType === "SINGLE_SELECT",
  );
  const field = fields.length === 1 ? fields[0]! : undefined;
  if (!field || discovery.reservedFieldIds.includes(field.id)) return undefined;
  const options = discoveredStatusOptions(field.options ?? []);
  return options
    ? {
        repository,
        projectId: discovery.projectId,
        fieldId: field.id,
        factoryManagedField: true,
        options,
      }
    : undefined;
}

/** One existing Objective or Work Item card, one configured field; never creates a card. */
export async function projectStatusOnGitHub(
  repository: string,
  request: ProjectStatusRequest,
  graphql: ProjectGraphQL,
): Promise<ProjectStatusObservation> {
  assertGitHubProjectStatusConfig(request.config, repository);
  const issue = request.issue ?? request.objective;
  if (
    !Number.isSafeInteger(request.objective) ||
    request.objective <= 0 ||
    !Number.isSafeInteger(issue) ||
    issue <= 0 ||
    !/^[A-Za-z0-9-]{1,128}$/.test(request.runId) ||
    !/^[a-f0-9]{64}$/.test(request.configDigest) ||
    !/^[a-f0-9-]{36}$/.test(request.requestId) ||
    request.optionId !== request.config.options[request.phase]
  )
    throw new Error("Invalid GitHub Project projection request");
  const [owner, name] = repository.split("/");
  const binding = await graphql<{
    project: {
      __typename: string;
      id: string;
      closed: boolean;
      viewerCanUpdate: boolean;
      owner: { login: string };
    } | null;
    field: {
      __typename: string;
      id: string;
      name: string;
      dataType: string;
      project: { id: string };
      options: { id: string }[];
    } | null;
  }>(
    `query($project:ID!,$field:ID!) { project:node(id:$project) { __typename ... on ProjectV2 { id closed viewerCanUpdate owner { ... on Organization { login } ... on User { login } } } } field:node(id:$field) { __typename ... on ProjectV2SingleSelectField { id name dataType project { id } options { id } } } }`,
    { project: request.config.projectId, field: request.config.fieldId },
    true,
  );
  if (
    binding.project?.__typename !== "ProjectV2" ||
    binding.project.id !== request.config.projectId ||
    binding.project.owner?.login.toLowerCase() !== owner?.toLowerCase() ||
    binding.project.closed !== false ||
    binding.project.viewerCanUpdate !== true ||
    binding.field?.__typename !== "ProjectV2SingleSelectField" ||
    binding.field.id !== request.config.fieldId ||
    binding.field.project?.id !== request.config.projectId ||
    binding.field.name !== "Status" ||
    binding.field.dataType !== "SINGLE_SELECT" ||
    Object.values(request.config.options).some(
      (option) =>
        !binding.field?.options.some((candidate) => candidate.id === option),
    )
  )
    throw new Error(
      "Configured Project, owner, Status field, options or update permission differ",
    );
  const readOption = (card: Card): string | null => {
    if (
      card.isArchived !== false ||
      card.project?.id !== request.config.projectId ||
      card.content?.__typename !== "Issue" ||
      card.content.number !== issue ||
      card.content.repository?.nameWithOwner !== repository ||
      card.fieldValues?.pageInfo.hasNextPage !== false
    )
      throw new Error(
        "Project card differs from its exact issue or complete field observation",
      );
    const matches = card.fieldValues.nodes.filter(
      (value) => value?.field?.id === request.config.fieldId,
    );
    if (
      matches.length > 1 ||
      matches.some(
        (value) =>
          value?.__typename !== "ProjectV2ItemFieldSingleSelectValue" ||
          typeof value.optionId !== "string",
      )
    )
      throw new Error("Project Status field has an invalid observation");
    return matches[0]?.optionId ?? null;
  };
  if (request.pending) {
    const pending = request.pending;
    if (
      pending.response ||
      pending.notSent ||
      pending.repository !== repository ||
      pending.objective !== request.objective ||
      pending.issue !== request.issue ||
      pending.runId !== request.runId ||
      pending.configDigest !== request.configDigest ||
      pending.projectId !== request.config.projectId ||
      pending.fieldId !== request.config.fieldId
    )
      throw new Error(
        "Unknown Project status intent differs from current binding",
      );
    const result = await graphql<{ node: Card | null }>(
      `query($item:ID!) { node(id:$item) { ... on ProjectV2Item { ${CARD} } } }`,
      { item: pending.itemId },
      true,
    );
    if (!result.node || result.node.id !== pending.itemId)
      throw new Error("Unknown Project card is unavailable");
    return {
      itemId: pending.itemId,
      optionId: readOption(result.node),
      observedAt: new Date().toISOString(),
      kind: "unknown-read",
    };
  }
  const cards: Card[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 100)
      throw new Error(
        "Objective Project card inventory exceeds the observation bound",
      );
    const result: {
      repository: {
        nameWithOwner: string;
        issue: {
          number: number;
          projectItems: {
            nodes: Card[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      } | null;
    } = await graphql(
      `query($owner:String!,$name:String!,$objective:Int!,$after:String) { repository(owner:$owner,name:$name) { nameWithOwner issue(number:$objective) { number projectItems(first:100,after:$after,includeArchived:true) { nodes { ${CARD} } pageInfo { hasNextPage endCursor } } } } }`,
      { owner, name, objective: issue, after },
      true,
    );
    if (
      result.repository?.nameWithOwner !== repository ||
      result.repository.issue?.number !== issue
    )
      throw new Error("Project inventory repository or issue differs");
    const connection = result.repository.issue.projectItems;
    cards.push(
      ...connection.nodes.filter(
        (card) => card.project?.id === request.config.projectId,
      ),
    );
    if (connection.pageInfo.hasNextPage === false) break;
    after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after))
      throw new Error("Invalid Project card inventory cursor");
    cursors.add(after);
  }
  if (cards.length !== 1)
    throw new Error(
      "Exactly one existing card for the issue is required in the configured Project",
    );
  const card = cards[0]!;
  const previousOptionId = readOption(card);
  if (previousOptionId === request.optionId)
    return {
      itemId: card.id,
      optionId: previousOptionId,
      observedAt: new Date().toISOString(),
      kind: "unchanged",
    };
  await request.beforeWrite({
    requestId: request.requestId,
    repository,
    objective: request.objective,
    ...(request.issue !== undefined && { issue: request.issue }),
    runId: request.runId,
    configDigest: request.configDigest,
    projectId: request.config.projectId,
    fieldId: request.config.fieldId,
    itemId: card.id,
    phase: request.phase,
    optionId: request.optionId,
    previousOptionId,
    observedAt: new Date().toISOString(),
  });
  const result = await graphql<{
    updateProjectV2ItemFieldValue: {
      clientMutationId: string;
      projectV2Item: Card;
    };
  }>(
    `mutation($input:UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input:$input) { clientMutationId projectV2Item { ${CARD} } } }`,
    {
      input: {
        clientMutationId: request.requestId,
        projectId: request.config.projectId,
        itemId: card.id,
        fieldId: request.config.fieldId,
        value: { singleSelectOptionId: request.optionId },
      },
    },
    false,
  );
  const returned = result.updateProjectV2ItemFieldValue;
  if (
    returned?.clientMutationId !== request.requestId ||
    returned.projectV2Item?.id !== card.id ||
    readOption(returned.projectV2Item) !== request.optionId
  )
    throw new Error(
      "Project update returned no exact original mutation observation",
    );
  return {
    itemId: card.id,
    optionId: request.optionId,
    observedAt: new Date().toISOString(),
    kind: "response",
  };
}
