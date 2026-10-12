const VALUE = `__typename
  ... on ProjectV2ItemFieldValueCommon {
    field { ... on ProjectV2FieldCommon { id } }
  }
  ... on ProjectV2ItemFieldTextValue { text }
  ... on ProjectV2ItemFieldNumberValue { number }`;
const CARD = `id isArchived project { id }
  content { __typename
    ... on Issue { id number repository { nameWithOwner } }
    ... on PullRequest { id repository { nameWithOwner } }
    ... on DraftIssue { id }
  }
  fieldValues(first:100) {
    nodes { ${VALUE} } pageInfo { hasNextPage endCursor }
  }`;
export const ADD = `mutation FactoryQueueEnsureCard($input:AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input:$input) {
    clientMutationId item { ${CARD} }
  }
}`;
export const UPDATE = `mutation FactoryQueueSetField($input:UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input:$input) {
    clientMutationId projectV2Item { ${CARD} }
  }
}`;
export const BINDING = `query FactoryQueueBinding($project:ID!,$metadata:ID!,$order:ID!) {
  viewer { databaseId }
  project:node(id:$project) { __typename ... on ProjectV2 {
    id closed viewerCanUpdate
    owner { __typename ... on Organization { login } ... on User { login } }
  } }
  metadata:node(id:$metadata) { __typename ... on ProjectV2Field {
    id dataType project { id }
  } }
  order:node(id:$order) { __typename ... on ProjectV2Field {
    id dataType project { id }
  } }
}`;
const ISSUE_CONTENT =
  "__typename id number title body state repository { nameWithOwner }";
export const TARGET = `query FactoryQueueTarget($item:ID!,$objective:Int!,$includeIssue:Boolean!,$owner:String!,$name:String!,$project:ID!,$metadata:ID!,$order:ID!) {
  ${BINDING.slice(BINDING.indexOf("{") + 1, BINDING.lastIndexOf("}"))}
  node(id:$item) { __typename ... on ProjectV2Item { ${CARD} } }
  repository(owner:$owner,name:$name) {
    nameWithOwner issue(number:$objective) @include(if:$includeIssue) { ${ISSUE_CONTENT} }
  }
}`;
export const ITEMS = `query FactoryQueueItems($project:ID!,$after:String) {
  node(id:$project) { __typename ... on ProjectV2 {
    id items(first:100,after:$after,archivedStates:[ARCHIVED,NOT_ARCHIVED]) {
      nodes { ${CARD} } pageInfo { hasNextPage endCursor }
    }
  } }
}`;
export const FIELDS = `query FactoryQueueItemFields($item:ID!,$after:String) {
  node(id:$item) { __typename ... on ProjectV2Item {
    id project { id } fieldValues(first:100,after:$after) {
      nodes { ${VALUE} } pageInfo { hasNextPage endCursor }
    }
  } }
}`;
export const ISSUE_IDENTITY = `query FactoryQueueIssueIdentity($issue:ID!) {
  node(id:$issue) { __typename ... on Issue {
    id number repository { nameWithOwner }
  } }
}`;

/** Fixed repository-scoped shape, one alias per existing Project-page Issue. */
export function issueBatchQuery(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    throw new Error("Project queue Issue batch must fit its observed page");
  const variables = Array.from(
    { length: count },
    (_, index) => `$number${index}:Int!`,
  ).join(",");
  const selections = Array.from(
    { length: count },
    (_, index) =>
      `issue${index}:issue(number:$number${index}) { ${ISSUE_CONTENT} }`,
  ).join("\n");
  return `query FactoryQueueIssues${count}($owner:String!,$name:String!,${variables}) {
  repository(owner:$owner,name:$name) { nameWithOwner ${selections} }
}`;
}
const QUEUE_READ_QUERIES = Object.freeze([
  BINDING,
  ITEMS,
  FIELDS,
  ISSUE_IDENTITY,
  TARGET,
]);
export function isProjectQueueReadQuery(query: string): boolean {
  if (QUEUE_READ_QUERIES.includes(query)) return true;
  const match = /^query FactoryQueueIssues([1-9][0-9]{0,2})\(/.exec(query);
  const count = Number(match?.[1]);
  return count <= 100 && count >= 1 && query === issueBatchQuery(count);
}
export const QUEUE_WRITE_QUERIES = Object.freeze([ADD, UPDATE]);
