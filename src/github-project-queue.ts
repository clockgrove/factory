import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as time from "./clock.js";
import type {
  ProjectQueueAction,
  ProjectQueueBinding,
  ProjectQueueIntent,
  ProjectQueueSnapshot,
  ProjectQueueWriteReceipt,
  ProjectQueueWriteRequest,
} from "./contracts.js";
import { GitHubProjectQueueGraphqlError } from "./github-client.js";
import type { ProjectGraphQL } from "./github-project.js";
import { currentProcessSignal, assertProcessActive } from "./process.js";

import {
  ADD,
  UPDATE,
  ITEMS,
  FIELD_BINDING,
  TARGET,
  ISSUE_IDENTITY,
  issueBatchQuery,
} from "./github-project-queue-wire.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Project queue observation is unavailable");
  return value as ObjectValue;
};
const only = (value: ObjectValue, keys: string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported Project queue receipt field");
};
const nodeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const orderValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const same = (left: unknown, right: unknown): boolean => {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      );
    return value;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
};

export function assertProjectQueueBinding(
  value: unknown,
  repository?: string,
): asserts value is ProjectQueueBinding {
  const binding = object(value);
  only(binding, [
    "repository",
    "projectId",
    "metadataFieldId",
    "orderFieldId",
    "controlItemId",
    "factoryManagedFields",
  ]);
  if (
    typeof binding.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) ||
    (repository !== undefined && binding.repository !== repository) ||
    binding.factoryManagedFields !== true ||
    !nodeId(binding.projectId) ||
    !nodeId(binding.metadataFieldId) ||
    !nodeId(binding.orderFieldId) ||
    !nodeId(binding.controlItemId) ||
    binding.metadataFieldId === binding.orderFieldId
  )
    throw new Error(
      "Project queue requires an exact target and dedicated field consent",
    );
}

type IntentBase = ProjectQueueAction &
  Omit<ProjectQueueIntent, "action" | "request">;

function mutationRequest(intent: IntentBase) {
  const input =
    intent.action === "ensure-card"
      ? {
          clientMutationId: intent.requestId,
          projectId: intent.binding.projectId,
          contentId: intent.issueNodeId,
        }
      : {
          clientMutationId: intent.requestId,
          projectId: intent.binding.projectId,
          itemId: intent.itemId,
          fieldId: intent.fieldId,
          value:
            intent.action === "set-order"
              ? { number: intent.order }
              : { text: intent.metadata },
        };
  return {
    query: intent.action === "ensure-card" ? ADD : UPDATE,
    variables: { input },
  };
}

/** Same decoder used at transport return and when authenticating archived originals. */
export function assertProjectQueueIntent(
  value: unknown,
  binding?: ProjectQueueBinding,
): asserts value is ProjectQueueIntent {
  const intent = object(value);
  const action = intent.action;
  only(intent, [
    "binding",
    "requestId",
    "actorId",
    "observedAt",
    "action",
    "fieldId",
    "request",
    ...(action === "ensure-card"
      ? ["issueNodeId"]
      : action === "set-order"
        ? ["itemId", "order"]
        : action === "set-metadata"
          ? ["itemId", "metadata"]
          : []),
  ]);
  assertProjectQueueBinding(intent.binding);
  if (
    (binding && !same(intent.binding, binding)) ||
    typeof intent.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      intent.requestId,
    ) ||
    !positiveInteger(intent.actorId) ||
    !timestamp(intent.observedAt)
  )
    throw new Error("Invalid Project queue intent identity");
  if (action === "ensure-card") {
    if (!nodeId(intent.issueNodeId) || intent.fieldId !== undefined)
      throw new Error("Invalid Project queue Issue admission target");
  } else if (action === "set-order") {
    if (
      !nodeId(intent.itemId) ||
      intent.itemId === intent.binding.controlItemId ||
      !positiveInteger(intent.order) ||
      intent.fieldId !== intent.binding.orderFieldId
    )
      throw new Error("Invalid Project queue order target");
  } else if (action === "set-metadata") {
    if (
      !nodeId(intent.itemId) ||
      typeof intent.metadata !== "string" ||
      intent.fieldId !== intent.binding.metadataFieldId
    )
      throw new Error("Invalid Project queue metadata target");
  } else throw new Error("Unsupported Project queue action");
  const typed = value as ProjectQueueIntent;
  if (!same(typed.request, mutationRequest(typed)))
    throw new Error(
      "Project queue intent does not retain its exact fixed request",
    );
}

function cardIdentity(
  value: unknown,
  binding: ProjectQueueBinding,
): ObjectValue {
  const card = object(value);
  if (
    !nodeId(card.id) ||
    typeof card.isArchived !== "boolean" ||
    object(card.project).id !== binding.projectId
  )
    throw new Error("Project queue card identity is unavailable");
  const content = object(card.content);
  if (
    !["Issue", "DraftIssue", "PullRequest"].includes(
      String(content.__typename),
    ) ||
    !nodeId(content.id)
  )
    throw new Error("Project queue card content is unavailable or redacted");
  if (
    content.__typename !== "DraftIssue" &&
    typeof object(content.repository).nameWithOwner !== "string"
  )
    throw new Error("Project queue card repository is unavailable");
  if (content.__typename === "Issue" && !positiveInteger(content.number))
    throw new Error("Project queue Issue identity is unavailable");
  return card;
}

function targetCard(value: unknown, intent: ProjectQueueIntent): ObjectValue {
  const card = cardIdentity(value, intent.binding);
  const content = object(card.content);
  if (
    card.isArchived ||
    (intent.action === "ensure-card"
      ? card.id === intent.binding.controlItemId ||
        content.__typename !== "Issue" ||
        content.id !== intent.issueNodeId ||
        object(content.repository).nameWithOwner !== intent.binding.repository
      : card.id !== intent.itemId ||
        (card.id === intent.binding.controlItemId
          ? !["Issue", "DraftIssue"].includes(String(content.__typename))
          : content.__typename !== "Issue" ||
            object(content.repository).nameWithOwner !==
              intent.binding.repository))
  )
    throw new Error("Project queue response changed its admitted target");
  return card;
}

function connection(value: unknown) {
  const page = object(value);
  const info = object(page.pageInfo);
  if (
    !Array.isArray(page.nodes) ||
    typeof info.hasNextPage !== "boolean" ||
    !(info.endCursor === null || typeof info.endCursor === "string") ||
    (info.hasNextPage && (!info.endCursor || page.nodes.length === 0))
  )
    throw new Error("Project queue pagination is unavailable or truncated");
  return {
    nodes: page.nodes,
    hasNextPage: info.hasNextPage,
    endCursor: info.endCursor as string | null,
  };
}

function fieldValues(values: unknown[], binding: ProjectQueueBinding) {
  let metadata: string | null = null;
  let order: number | null = null;
  const seen = new Set<string>();
  for (const raw of values) {
    const value = object(raw);
    if (typeof value.__typename !== "string")
      throw new Error("Project queue field value is unavailable");
    // Issue-derived fields do not implement FieldValueCommon; they carry no queue authority.
    if (value.field === undefined) {
      if (
        ![
          "ProjectV2ItemFieldUserValue",
          "ProjectV2ItemFieldLabelValue",
          "ProjectV2ItemFieldMilestoneValue",
          "ProjectV2ItemFieldPullRequestValue",
          "ProjectV2ItemFieldRepositoryValue",
          "ProjectV2ItemFieldReviewerValue",
        ].includes(value.__typename)
      )
        throw new Error("Project queue field identity is unavailable");
      continue;
    }
    const id = object(value.field).id;
    if (!nodeId(id) || seen.has(id))
      throw new Error(
        "Project queue has unavailable or duplicate field values",
      );
    seen.add(id);
    if (id === binding.metadataFieldId) {
      if (
        value.__typename !== "ProjectV2ItemFieldTextValue" ||
        typeof value.text !== "string"
      )
        throw new Error(
          "Project queue metadata is unavailable or has the wrong type",
        );
      metadata = value.text;
    } else if (id === binding.orderFieldId) {
      if (
        value.__typename !== "ProjectV2ItemFieldNumberValue" ||
        !orderValue(value.number)
      )
        throw new Error(
          "Project queue order is unavailable or has the wrong type",
        );
      order = value.number;
    }
  }
  return { metadata, order };
}

export function assertProjectQueueWriteReceipt(
  value: unknown,
): asserts value is ProjectQueueWriteReceipt {
  const receipt = object(value);
  only(receipt, ["intent", "itemId", "observedAt", "kind", "original"]);
  assertProjectQueueIntent(receipt.intent);
  if (!nodeId(receipt.itemId) || !timestamp(receipt.observedAt))
    throw new Error("Invalid Project queue response identity");
  const intent = receipt.intent;
  if (receipt.kind === "existing-read") {
    if (
      intent.action !== "ensure-card" ||
      targetCard(receipt.original, intent).id !== receipt.itemId
    )
      throw new Error("Invalid existing Project queue card read");
    return;
  }
  if (receipt.kind !== "response")
    throw new Error("Project queue mutation lacks an original response");
  const original = object(receipt.original);
  const key =
    intent.action === "ensure-card"
      ? "addProjectV2ItemById"
      : "updateProjectV2ItemFieldValue";
  only(original, [key]);
  const response = object(original[key]);
  if (response.clientMutationId !== intent.requestId)
    throw new Error(
      "Project queue mutation response has another request identity",
    );
  const card = targetCard(
    response[intent.action === "ensure-card" ? "item" : "projectV2Item"],
    intent,
  );
  if (card.id !== receipt.itemId)
    throw new Error("Project queue response has another card identity");
  if (intent.action !== "ensure-card") {
    const page = connection(card.fieldValues);
    if (page.hasNextPage)
      throw new Error("Project queue mutation response is truncated");
    const fields = fieldValues(page.nodes, intent.binding);
    if (
      intent.action === "set-order"
        ? fields.order !== intent.order
        : fields.metadata !== intent.metadata
    )
      throw new Error(
        "Project queue original response does not contain the requested value",
      );
  }
}

/** Keeps an unreadable original response private for the owner's exact receipt journal. */
export class ProjectQueueResponseError extends Error {
  constructor(
    readonly intent: ProjectQueueIntent,
    readonly original: unknown,
    cause: unknown,
  ) {
    super("Project queue mutation returned an unverified original response", {
      cause,
    });
    this.name = "ProjectQueueResponseError";
  }
}

function bindingAccess(
  repository: string,
  binding: ProjectQueueBinding,
  data: ObjectValue,
) {
  const project = object(data.project);
  const owner = object(project.owner);
  const actorId = object(data.viewer).databaseId;
  if (
    project.__typename !== "ProjectV2" ||
    project.id !== binding.projectId ||
    project.closed !== false ||
    project.viewerCanUpdate !== true ||
    !["Organization", "User"].includes(String(owner.__typename)) ||
    typeof owner.login !== "string" ||
    owner.login.toLowerCase() !== repository.split("/")[0]?.toLowerCase() ||
    !positiveInteger(actorId)
  )
    throw new Error("Project queue owner, open state or access is unavailable");
  for (const [key, id, type] of [
    ["metadata", binding.metadataFieldId, "TEXT"],
    ["order", binding.orderFieldId, "NUMBER"],
  ] as const) {
    const field = object(data[key]);
    if (
      field.__typename !== "ProjectV2Field" ||
      field.id !== id ||
      field.dataType !== type ||
      object(field.project).id !== binding.projectId
    )
      throw new Error(
        "Project queue requires its exact dedicated TEXT and NUMBER fields",
      );
  }
  return { actorId, owner: owner.login };
}

/** Complete current field-name proof is required by fieldValueByName's first-match semantics. */
async function readQueueBinding(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  assertProjectQueueBinding(binding, repository);
  let access: ReturnType<typeof bindingAccess> | undefined;
  let names: { metadata: string; order: string } | undefined;
  const fields = new Map<string, string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (;;) {
    assertProcessActive();
    const data = object(
      await graphql(
        FIELD_BINDING,
        {
          project: binding.projectId,
          metadata: binding.metadataFieldId,
          order: binding.orderFieldId,
          after,
        },
        true,
      ),
    );
    const current = bindingAccess(repository, binding, data);
    const currentNames = {
      metadata: object(data.metadata).name,
      order: object(data.order).name,
    };
    if (
      typeof currentNames.metadata !== "string" ||
      typeof currentNames.order !== "string" ||
      (access && !same(access, current)) ||
      (names && !same(names, currentNames))
    )
      throw new Error(
        "Project queue field names or access changed during observation",
      );
    access = current;
    names = currentNames as { metadata: string; order: string };
    const page = connection(object(data.project).fields);
    for (const raw of page.nodes) {
      const field = object(raw);
      if (
        !nodeId(field.id) ||
        typeof field.name !== "string" ||
        fields.has(field.id)
      )
        throw new Error(
          "Project queue field catalog is unavailable or duplicated",
        );
      fields.set(field.id, field.name);
    }
    if (!page.hasNextPage) break;
    if (!page.endCursor || cursors.has(page.endCursor))
      throw new Error(
        "Project queue field catalog pagination is incomplete or repeated",
      );
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  for (const [id, name] of [
    [binding.metadataFieldId, names!.metadata],
    [binding.orderFieldId, names!.order],
  ] as const) {
    if (
      fields.get(id) !== name ||
      [...fields.values()].filter((value) => value === name).length !== 1
    )
      throw new Error(
        "Project queue bound field names must be unique in the complete Project",
      );
  }
  return { access: access!, names: names! };
}

function queueFieldValues(card: ObjectValue, binding: ProjectQueueBinding) {
  const values: unknown[] = [];
  for (const [key, id] of [
    ["metadataValue", binding.metadataFieldId],
    ["orderValue", binding.orderFieldId],
  ] as const) {
    const value = card[key];
    if (value === null) continue;
    if (object(object(value).field).id !== id)
      throw new Error(
        "Project queue named field returned another field identity",
      );
    values.push(value);
  }
  return fieldValues(values, binding);
}

async function readIssues(
  identities: ObjectValue[],
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  const unique = [
    ...new Map(identities.map((value) => [value.id, value])).values(),
  ];
  const definitions = new Map<string, ObjectValue>();
  if (!unique.length) return definitions;
  for (const identity of unique) {
    if (
      identity.__typename !== "Issue" ||
      !nodeId(identity.id) ||
      !positiveInteger(identity.number) ||
      object(identity.repository).nameWithOwner !== binding.repository
    )
      throw new Error(
        "Project queue Issue contents require an authenticated target repository identity",
      );
  }
  const [owner, name] = binding.repository.split("/");
  assertProcessActive();
  const data = object(
    await graphql(
      issueBatchQuery(unique.length),
      {
        owner,
        name,
        ...Object.fromEntries(
          unique.map((identity, index) => [`number${index}`, identity.number]),
        ),
      },
      true,
    ),
  );
  const repository = object(data.repository);
  if (repository.nameWithOwner !== binding.repository)
    throw new Error("Project queue Issue batch changed repository identity");
  for (const [index, identity] of unique.entries()) {
    const issue = issueDefinition(
      repository[`issue${index}`],
      String(identity.id),
      binding,
    );
    if (issue.number !== identity.number)
      throw new Error(
        "Project queue Objective changed identity during observation",
      );
    definitions.set(String(issue.id), issue);
  }
  return definitions;
}

function issueDefinition(
  value: unknown,
  issueNodeId: string,
  binding: ProjectQueueBinding,
) {
  const issue = object(value);
  if (
    issue.__typename !== "Issue" ||
    issue.id !== issueNodeId ||
    !positiveInteger(issue.number) ||
    object(issue.repository).nameWithOwner !== binding.repository ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    !["OPEN", "CLOSED"].includes(String(issue.state))
  )
    throw new Error(
      "Project queue Objective definition is unavailable or changed identity",
    );
  return issue;
}

async function readQueueFresh(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  const { access, names } = await readQueueBinding(
    repository,
    binding,
    graphql,
  );
  const cards: ProjectQueueSnapshot["cards"] = [];
  const ignoredCards: ProjectQueueSnapshot["ignoredCards"] = [];
  const seenCards = new Set<string>();
  const issues = new Set<string>();
  let control: ProjectQueueSnapshot["control"] | undefined;
  let after: string | null = null;
  const cursors = new Set<string>();
  for (let index = 0; ; index++) {
    if (index >= 1000)
      throw new Error("Project queue exceeds its complete observation bound");
    assertProcessActive();
    const data = object(
      await graphql(
        ITEMS,
        {
          project: binding.projectId,
          after,
          metadataName: names.metadata,
          orderName: names.order,
        },
        true,
      ),
    );
    const project = object(data.node);
    if (project.__typename !== "ProjectV2" || project.id !== binding.projectId)
      throw new Error("Project queue pagination changed Project identity");
    const page = connection(project.items);
    // Select approved repository identities before requesting any Issue contents.
    const pageCards = page.nodes.map((raw) => cardIdentity(raw, binding));
    const definitions = await readIssues(
      pageCards
        .filter((card) => {
          const content = object(card.content);
          return (
            card.id !== binding.controlItemId &&
            content.__typename === "Issue" &&
            object(content.repository).nameWithOwner === repository
          );
        })
        .map((card) => object(card.content)),
      binding,
      graphql,
    );
    for (const raw of pageCards) {
      const card = cardIdentity(raw, binding);
      const itemId = card.id as string;
      if (seenCards.has(itemId))
        throw new Error("Project queue has duplicate card identities");
      seenCards.add(itemId);
      const fields = queueFieldValues(card, binding);
      const content = object(card.content);
      if (itemId === binding.controlItemId) {
        if (
          card.isArchived ||
          !["Issue", "DraftIssue"].includes(String(content.__typename))
        )
          throw new Error(
            "Project queue control card is unavailable or archived",
          );
        control = { itemId, metadata: fields.metadata };
        continue;
      }
      if (
        content.__typename !== "Issue" ||
        object(content.repository).nameWithOwner !== repository
      ) {
        if (fields.metadata !== null && fields.metadata !== "")
          throw new Error(
            "Project queue metadata admits an unsupported Objective target",
          );
        ignoredCards.push({
          itemId,
          archived: card.isArchived as boolean,
          kind:
            content.__typename === "DraftIssue"
              ? "draft"
              : content.__typename === "Issue"
                ? "foreign-issue"
                : "pull-request",
        });
        continue;
      }
      const issueNodeId = content.id as string;
      if (!card.isArchived && issues.has(issueNodeId))
        throw new Error("Project queue has duplicate Objective cards");
      if (!card.isArchived) issues.add(issueNodeId);
      const issue = definitions.get(issueNodeId)!;
      if (issue.number !== content.number)
        throw new Error(
          "Project queue Objective changed identity during observation",
        );
      cards.push({
        itemId,
        issueNodeId,
        objective: issue.number as number,
        repository,
        title: issue.title as string,
        body: issue.body as string,
        state: issue.state === "OPEN" ? "open" : "closed",
        archived: card.isArchived as boolean,
        ...fields,
      });
    }
    if (!page.hasNextPage) break;
    if (!page.endCursor || cursors.has(page.endCursor))
      throw new Error("Project queue pagination is repeated or incomplete");
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  if (!control)
    throw new Error("Project queue lacks its configured control card");
  // Recheck capabilities after pagination; the API offers no version/CAS guarantee.
  const current = await readQueueBinding(repository, binding, graphql);
  if (
    !same(current.names, names) ||
    current.access.actorId !== access.actorId ||
    current.access.owner !== access.owner
  )
    throw new Error("Project queue access changed during observation");
  const snapshot: ProjectQueueSnapshot = {
    binding: structuredClone(binding),
    ...access,
    observedAt: new Date(time.now()).toISOString(),
    control,
    cards,
    ignoredCards,
  };
  return { snapshot };
}

type Observation = Awaited<ReturnType<typeof readQueueFresh>>;
const observationScope = new AsyncLocalStorage<{
  repository: string;
  binding: ProjectQueueBinding;
  graphql: ProjectGraphQL;
  active: boolean;
  observation?: Promise<Observation>;
}>();

/** Rebuildable observation only for this finite owner's callback, never across commands. */
export async function withProjectQueueObservationOnGitHub<T>(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
  task: () => Promise<T>,
): Promise<T> {
  assertProjectQueueBinding(binding, repository);
  assertProcessActive();
  const scope: NonNullable<ReturnType<typeof observationScope.getStore>> = {
    repository,
    binding: structuredClone(binding),
    graphql,
    active: true,
  };
  return observationScope.run(scope, async () => {
    try {
      return await task();
    } finally {
      scope.active = false;
      scope.observation = undefined;
    }
  });
}

function currentObservation(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  const scope = observationScope.getStore();
  if (currentProcessSignal()?.aborted) {
    if (scope) scope.observation = undefined;
    return undefined;
  }
  if (!scope?.active) return undefined;
  if (
    scope.repository !== repository ||
    scope.graphql !== graphql ||
    !same(scope.binding, binding)
  ) {
    scope.observation = undefined;
    scope.active = false;
    return undefined;
  }
  return scope;
}

async function readQueue(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  assertProcessActive();
  const scope = currentObservation(repository, binding, graphql);
  if (!scope) return readQueueFresh(repository, binding, graphql);
  scope.observation ??= readQueueFresh(repository, binding, graphql);
  try {
    return await scope.observation;
  } catch (error) {
    scope.observation = undefined;
    throw error;
  }
}

async function readTarget(
  repository: string,
  request: ProjectQueueWriteRequest,
  graphql: ProjectGraphQL,
  itemId = request.action === "ensure-card"
    ? request.binding.controlItemId
    : request.itemId,
) {
  assertProcessActive();
  const data = object(
    await graphql(
      TARGET,
      {
        item: itemId,
        objective: request.expectedIssue?.objective ?? 1,
        includeIssue: request.expectedIssue !== undefined,
        owner: request.binding.repository.split("/")[0],
        name: request.binding.repository.split("/")[1],
        project: request.binding.projectId,
        metadata: request.binding.metadataFieldId,
        order: request.binding.orderFieldId,
      },
      true,
    ),
  );
  const access = bindingAccess(repository, request.binding, data);
  const card = cardIdentity(data.node, request.binding);
  if (card.__typename !== "ProjectV2Item" || card.id !== itemId)
    throw new Error("Project queue mutation target changed identity");
  const repositoryValue = object(data.repository);
  if (repositoryValue.nameWithOwner !== request.binding.repository)
    throw new Error(
      "Project queue mutation observation changed repository identity",
    );
  let issue: unknown = repositoryValue.issue;
  if (
    !request.expectedIssue &&
    (request.action === "ensure-card" ||
      itemId !== request.binding.controlItemId)
  ) {
    let identity = object(card.content);
    if (request.action === "ensure-card") {
      assertProcessActive();
      const result = object(
        await graphql(ISSUE_IDENTITY, { issue: request.issueNodeId }, true),
      );
      identity = object(result.node);
    }
    if (
      identity.__typename !== "Issue" ||
      !nodeId(identity.id) ||
      !positiveInteger(identity.number) ||
      object(identity.repository).nameWithOwner !== request.binding.repository
    )
      throw new Error(
        "Project queue mutation Issue identity is unavailable or outside its repository",
      );
    issue = (await readIssues([identity], request.binding, graphql)).get(
      String(identity.id),
    );
  }
  return { access, card, issue };
}

function expectedIssue(issue: ObjectValue, request: ProjectQueueWriteRequest) {
  const expected = request.expectedIssue;
  if (!expected) return;
  if (
    !nodeId(expected.issueNodeId) ||
    !positiveInteger(expected.objective) ||
    !/^[a-f0-9]{64}$/.test(expected.bodyDigest) ||
    issue.id !== expected.issueNodeId ||
    issue.number !== expected.objective ||
    issue.state !== "OPEN" ||
    typeof issue.body !== "string" ||
    createHash("sha256").update(issue.body).digest("hex") !==
      expected.bodyDigest
  )
    throw new Error(
      "Project queue Objective changed after exact content admission",
    );
}

export async function projectQueueReadOnGitHub(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
): Promise<ProjectQueueSnapshot> {
  return structuredClone(
    (await readQueue(repository, structuredClone(binding), graphql)).snapshot,
  );
}

export async function projectQueueWriteOnGitHub(
  repository: string,
  request: ProjectQueueWriteRequest,
  graphql: ProjectGraphQL,
): Promise<ProjectQueueWriteReceipt> {
  request = {
    ...request,
    binding: structuredClone(request.binding),
    ...(request.expectedIssue
      ? { expectedIssue: structuredClone(request.expectedIssue) }
      : {}),
  };
  assertProcessActive();
  assertProjectQueueBinding(request.binding, repository);
  if (request.pending)
    throw new Error("A submitted Project queue effect permits no replay");
  if (typeof request.beforeWrite !== "function")
    throw new Error("Project queue mutation lacks durable owner admission");
  const operationScope = currentObservation(
    repository,
    request.binding,
    graphql,
  );
  const observation =
    request.action === "ensure-card"
      ? await readQueue(repository, request.binding, graphql)
      : await operationScope?.observation;
  const initialTarget = await readTarget(repository, request, graphql);
  const access = initialTarget.access;
  if (
    observation &&
    (observation.snapshot.actorId !== access.actorId ||
      observation.snapshot.owner !== access.owner)
  ) {
    if (operationScope) operationScope.observation = undefined;
    throw new Error("Project queue access changed during its owned operation");
  }
  const action =
    request.action === "ensure-card"
      ? { action: request.action, issueNodeId: request.issueNodeId }
      : request.action === "set-order"
        ? {
            action: request.action,
            itemId: request.itemId,
            order: request.order,
          }
        : {
            action: request.action,
            itemId: request.itemId,
            metadata: request.metadata,
          };
  const base = {
    binding: structuredClone(request.binding),
    requestId: request.requestId,
    actorId: access.actorId,
    observedAt: new Date(time.now()).toISOString(),
    ...action,
    ...(request.action === "ensure-card"
      ? {}
      : {
          fieldId:
            request.action === "set-order"
              ? request.binding.orderFieldId
              : request.binding.metadataFieldId,
        }),
  } as IntentBase;
  const intent = {
    ...base,
    request: mutationRequest(base),
  } as ProjectQueueIntent;
  assertProjectQueueIntent(intent, request.binding);
  let currentIssue: ObjectValue | undefined;
  const refreshTarget = (target: Awaited<ReturnType<typeof readTarget>>) => {
    assertProcessActive();
    if (
      target.access.actorId !== access.actorId ||
      target.access.owner !== access.owner
    )
      throw new Error("Project queue access changed before mutation dispatch");
    if (request.action === "ensure-card") {
      const control = target.card;
      if (
        control.isArchived ||
        !["Issue", "DraftIssue"].includes(
          String(object(control.content).__typename),
        )
      )
        throw new Error(
          "Project queue control card is unavailable or archived",
        );
      if (object(control.content).id === request.issueNodeId)
        throw new Error(
          "Project queue control content cannot become an Objective card",
        );
      currentIssue = issueDefinition(
        target.issue,
        request.issueNodeId,
        request.binding,
      );
      if (currentIssue.state !== "OPEN")
        throw new Error("Project queue cannot admit a closed Objective");
      expectedIssue(currentIssue, request);
    } else {
      const currentCard = target.card;
      targetCard(currentCard, intent);
      // The original mutation response must itself supply complete field proof.
      const page = connection(currentCard.fieldValues);
      if (page.hasNextPage)
        throw new Error(
          "Project queue mutation cannot supply complete original field proof",
        );
      fieldValues(page.nodes, request.binding);
      if (request.itemId !== request.binding.controlItemId) {
        const content = object(currentCard.content);
        currentIssue = issueDefinition(
          target.issue,
          String(content.id),
          request.binding,
        );
        if (currentIssue.number !== content.number)
          throw new Error(
            "Project queue mutation Issue number changed identity",
          );
        expectedIssue(currentIssue, request);
      } else if (request.expectedIssue)
        throw new Error(
          "Project queue content admission cannot target the control card",
        );
    }
  };
  refreshTarget(initialTarget);
  if (request.action === "ensure-card") {
    const { snapshot } = observation!;
    const existing = snapshot.cards.find(
      (card) => !card.archived && card.issueNodeId === request.issueNodeId,
    );
    if (existing) {
      const target = await readTarget(
        repository,
        request,
        graphql,
        existing.itemId,
      );
      if (
        target.access.actorId !== access.actorId ||
        target.access.owner !== access.owner
      )
        throw new Error(
          "Project queue access changed before existing card observation",
        );
      const card = target.card;
      expectedIssue(
        issueDefinition(target.issue, request.issueNodeId, request.binding),
        request,
      );
      targetCard(card, intent);
      const receipt: ProjectQueueWriteReceipt = {
        intent,
        itemId: existing.itemId,
        observedAt: new Date(time.now()).toISOString(),
        kind: "existing-read",
        original: card,
      };
      assertProjectQueueWriteReceipt(receipt);
      return receipt;
    }
    if (snapshot.cards.some((card) => card.issueNodeId === request.issueNodeId))
      throw new Error(
        "An archived Objective card requires current unarchived membership",
      );
  }
  const admitted = structuredClone(intent);
  await request.beforeWrite(structuredClone(admitted));
  // Publication admission may await Git effects. Recheck this target and access afterward.
  refreshTarget(await readTarget(repository, request, graphql));
  assertProcessActive();
  const scope = currentObservation(repository, request.binding, graphql);
  const priorObservation = scope?.observation;
  // Submission or a lost reply never leaves a reusable pre-effect observation.
  if (scope) scope.observation = undefined;
  let original: unknown;
  try {
    original = await graphql(
      admitted.request.query,
      admitted.request.variables,
      false,
    );
  } catch (error) {
    if (error instanceof GitHubProjectQueueGraphqlError)
      throw new ProjectQueueResponseError(admitted, error.original, error);
    throw error;
  }
  try {
    const key =
      admitted.action === "ensure-card"
        ? "addProjectV2ItemById"
        : "updateProjectV2ItemFieldValue";
    const response = object(object(original)[key]);
    const card = object(
      response[admitted.action === "ensure-card" ? "item" : "projectV2Item"],
    );
    const receipt: ProjectQueueWriteReceipt = {
      intent: admitted,
      itemId: card.id as string,
      observedAt: new Date(time.now()).toISOString(),
      kind: "response",
      original,
    };
    assertProjectQueueWriteReceipt(receipt);
    if (
      scope?.active &&
      !currentProcessSignal()?.aborted &&
      priorObservation &&
      !connection(card.fieldValues).hasNextPage
    ) {
      const observed = await priorObservation;
      const fields = fieldValues(
        connection(card.fieldValues).nodes,
        request.binding,
      );
      if (receipt.itemId === request.binding.controlItemId) {
        observed.snapshot.control = {
          itemId: receipt.itemId,
          metadata: fields.metadata,
        };
      } else {
        const issue = currentIssue!;
        const content = object(card.content);
        if (content.id !== issue.id || content.number !== issue.number)
          throw new Error(
            "Project queue mutation response changed Objective identity",
          );
        const updated: ProjectQueueSnapshot["cards"][number] = {
          itemId: receipt.itemId,
          issueNodeId: String(issue.id),
          objective: Number(issue.number),
          repository,
          title: String(issue.title),
          body: String(issue.body),
          state: issue.state === "OPEN" ? "open" : "closed",
          archived: false,
          ...fields,
        };
        const index = observed.snapshot.cards.findIndex(
          (value) => value.itemId === receipt.itemId,
        );
        if (index < 0) observed.snapshot.cards.push(updated);
        else observed.snapshot.cards[index] = updated;
      }
      scope.observation = Promise.resolve(observed);
    }
    return receipt;
  } catch (error) {
    throw new ProjectQueueResponseError(admitted, original, error);
  }
}
