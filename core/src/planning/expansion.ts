import { createHash } from "node:crypto";
import type { ObjectiveState } from "../state.js";
import type { DiscoveryResult } from "../work/discovery.js";
import { fact } from "../work/facts.js";
import { ownsPath } from "./graph.js";
import type { GraphExpansionEnvelope, Plan, WorkItem } from "./types.js";

/*
 * Reviewed expansion envelopes, materialized. When an envelope's producer
 * (a discovery item) settles, its merge step works out the children from
 * the producer's kept result with no model call (`expandAt`): the files
 * the envelope selects, sorted and batched by directory, one child Work
 * Item per batch, copied from the reviewed template. Ids hash the
 * observed commit and the batch, so the same result always gives the same
 * children. The settle step saves the batches in its result; that saved
 * record is the layer `withExpansions` joins to the plan (plan.ts
 * currentPlan), so children run like any Work Item, and every integration
 * barrier waits for the producer and for each child. An empty selection,
 * or a skipped producer, settles the envelope with no children.
 */

/** One envelope's settled materialization, saved in its producer's merge result. */
export interface Expanded {
  envelopeId: string;
  /** The commit the producer observed; absent when it was skipped. */
  commit?: string;
  children: { id: string; paths: string[] }[];
  evidence: string;
}

/** A discovery item's merge result when envelopes read it. */
interface Settled {
  settled?: string;
  expansions?: Expanded[];
}

/** The producer's merge step key (work/steps.ts). */
const settledKey = (id: string) => `item:${id}:merge`;

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The first few paths of a list, for evidence. */
const someOf = (paths: readonly string[]) =>
  `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${paths.length - 5} more` : ""}`;

/**
 * Every envelope reading discovery item `producer`, materialized from its
 * kept result: the records its settle step saves, or the problem that
 * holds it (an unknown classification, a symbolic link, an id taken, or
 * more children than the envelope's limit or the controller's `cap`).
 */
export function expandAt(
  state: ObjectiveState,
  plan: Plan,
  producer: WorkItem,
  cap: number,
): Expanded[] | string {
  const envelopes = (plan.expansions ?? []).filter(
    (envelope) => envelope.input.producerItemId === producer.id,
  );
  if (!envelopes.length) return [];
  const result = fact(state, "discovery", producer.id);
  const records: Expanded[] = [];
  const problems: string[] = [];
  const ids = new Set(plan.items.map((item) => item.id));
  for (const envelope of envelopes) {
    const expanded = materialize(envelope, result, cap, ids);
    if (typeof expanded === "string") problems.push(expanded);
    else records.push(expanded);
  }
  return problems.length ? problems.join("\n\n") : records;
}

function materialize(
  envelope: GraphExpansionEnvelope,
  result: DiscoveryResult | undefined,
  cap: number,
  ids: Set<string>,
): Expanded | string {
  const { producerItemId, role, schema } = envelope.input;
  if (
    !result ||
    result.producerItemId !== producerItemId ||
    result.role !== role ||
    result.schema !== schema
  )
    return `Expansion ${envelope.id} reads discovery role ${JSON.stringify(role)} from ${producerItemId}, which has no such kept result.`;
  const at = `discovery ${producerItemId} (role ${JSON.stringify(role)}) at ${result.commit.slice(0, 12)}`;
  // The producer's inventory may be wider; the envelope owns only its selectors.
  const inScope = result.entries.filter((entry) =>
    ownsPath(entry.path, envelope.selectors),
  );
  const { selection } = envelope;
  if (selection.kind === "classified") {
    const labels = [...selection.included, ...selection.excluded];
    const unknown = inScope.filter(
      (entry) =>
        entry.classification === undefined ||
        !labels.includes(entry.classification),
    );
    if (unknown.length)
      return `Expansion ${envelope.id} can't select its files: ${at} has ${unknown.length} files with no classification from ${JSON.stringify(labels)}: ${someOf(unknown.map((entry) => `${entry.path} (${entry.classification ?? "unclassified"})`))}. A missing label is never an exclusion.`;
  }
  const selected = inScope.filter(
    (entry) =>
      selection.kind === "all-regular-files" ||
      selection.included.includes(entry.classification!),
  );
  const links = selected.filter((entry) => entry.mode === "120000");
  if (links.length)
    return `Expansion ${envelope.id} selects symbolic links, and a child can't own one: ${someOf(links.map((entry) => entry.path))} (${at}).`;
  const paths = selected.map((entry) => entry.path).sort();
  // Batch by directory, at most maxFilesPerChild files each.
  const batches: string[][] = [];
  let directory: string | undefined;
  for (const path of paths) {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const batch = batches.at(-1);
    if (
      !batch ||
      parent !== directory ||
      batch.length === envelope.batching.maxFilesPerChild
    )
      batches.push([path]);
    else batch.push(path);
    directory = parent;
  }
  const limit = Math.min(envelope.limits.maxChildren, cap);
  if (batches.length > limit)
    return `Expansion ${envelope.id} selects ${paths.length} files in ${batches.length} batches of at most ${envelope.batching.maxFilesPerChild} per directory, over its allowance of ${limit} children (the envelope's limits.maxChildren is ${envelope.limits.maxChildren}, planning.maxExpansionChildren is ${cap}); ${at} selected ${someOf(paths)}. Factory never truncates the affected set.`;
  const children = batches.map((batch) => ({
    id: `${envelope.id}-${hash([result.commit, batch]).slice(0, 12)}`,
    paths: batch,
  }));
  const taken = children.filter((child) => ids.has(child.id));
  if (taken.length)
    return `Expansion ${envelope.id} would add Work Items ${taken.map((child) => child.id).join(", ")}, but the plan already has those ids.`;
  for (const child of children) ids.add(child.id);
  return {
    envelopeId: envelope.id,
    commit: result.commit,
    children,
    evidence: children.length
      ? `Expansion ${envelope.id} selected ${paths.length} of ${result.entries.length} files from ${at} into ${children.length} children: ${someOf(paths)}.`
      : `Expansion ${envelope.id} selected none of ${result.entries.length} files from ${at}, so it settled with no children.`,
  };
}

/**
 * The settled records of every envelope in `plan`, in plan order, with
 * `undefined` for one whose producer hasn't settled. A skipped producer
 * settles its envelopes with no children.
 */
export function expansionsOf(
  state: ObjectiveState,
  plan: Pick<Plan, "expansions">,
): { envelope: GraphExpansionEnvelope; expanded?: Expanded }[] {
  return (plan.expansions ?? []).map((envelope) => {
    const producer = envelope.input.producerItemId;
    const settled = state.done[settledKey(producer)] as Settled | undefined;
    if (!settled) return { envelope };
    const expanded = settled.expansions?.find(
      (entry) => entry.envelopeId === envelope.id,
    ) ?? {
      envelopeId: envelope.id,
      children: [],
      evidence: `Expansion ${envelope.id} settled with no children: its producer ${producer} settled ${settled.settled === "skipped" ? "as skipped" : "with no record of it"}.`,
    };
    return { envelope, expanded };
  });
}

/** Child `child` of `envelope`: the reviewed template owning one batch. */
function childItem(
  envelope: GraphExpansionEnvelope,
  child: { id: string; paths: string[] },
): WorkItem {
  const { template } = envelope;
  const [first, ...rest] = child.paths;
  return {
    ...structuredClone(template),
    id: child.id,
    title: `${template.title}: ${first}${rest.length ? ` and ${rest.length} more` : ""}`,
    ownedPaths: [...child.paths],
    dependencies: [
      ...new Set([...envelope.dependencies, envelope.input.producerItemId]),
    ],
    brief: `${template.brief}\n\nThis Work Item is one child of expansion ${envelope.id}: make the change above only in these files, which it owns: ${JSON.stringify(child.paths)}. Other children own the rest of the envelope's files; the Objective's acceptance stays with its integration barriers (${envelope.integrationBarrierItemIds.join(", ")}).`,
  };
}

/**
 * `plan` with its envelopes joined: every integration barrier depends on
 * the envelope's producer, and, once the producer has settled, on each
 * child, which joins the items (an aggregate barrier's children too).
 * Derived from saved records only, so it never changes once settled.
 */
export function withExpansions(state: ObjectiveState, plan: Plan): Plan {
  if (!plan.expansions?.length) return plan;
  const children: WorkItem[] = [];
  const joins = new Map<string, { producers: string[]; children: string[] }>();
  for (const { envelope, expanded } of expansionsOf(state, plan)) {
    const added = (expanded?.children ?? []).map((child) =>
      childItem(envelope, child),
    );
    children.push(...added);
    for (const barrier of envelope.integrationBarrierItemIds) {
      const join = joins.get(barrier) ?? { producers: [], children: [] };
      join.producers.push(envelope.input.producerItemId);
      join.children.push(...added.map((child) => child.id));
      joins.set(barrier, join);
    }
  }
  const items = plan.items.map((item) => {
    const join = joins.get(item.id);
    if (!join) return item;
    return {
      ...item,
      dependencies: [
        ...new Set([...item.dependencies, ...join.producers, ...join.children]),
      ],
      ...(item.kind === "aggregate"
        ? {
            children: [
              ...new Set([...(item.children ?? []), ...join.children]),
            ],
          }
        : {}),
    };
  });
  return { ...plan, items: [...items, ...children] };
}

/**
 * A producer's settled records as the issue comments that carry them, so
 * `factory reset` can rebuild the children (reset.ts): each comment is its
 * marker, `part k of n`, and a JSON slice of at most `size` characters.
 */
export function expansionComments(
  issue: number,
  producer: string,
  expansions: readonly Expanded[],
  size: number,
): { marker: string; body: string }[] {
  const json = JSON.stringify(expansions);
  const parts: string[] = [];
  for (let at = 0; at < json.length; at += size)
    parts.push(json.slice(at, at + size));
  return parts.map((part, index) => {
    const marker = EXPANSION_MARK(issue, producer, index + 1);
    return {
      marker,
      body: `${marker}\nExpansion data of ${producer}, part ${index + 1} of ${parts.length}:\n\n\`\`\`json\n${part}\n\`\`\``,
    };
  });
}

const EXPANSION_MARK = (issue: number, producer: string, part: number) =>
  `<!-- factory:${issue}:expansion:${producer}:${part} -->`;

/**
 * The records `expansionComments` wrote for `producer`, joined from the
 * comment `marked` finds for each part; undefined when any part is missing
 * or not exactly what Factory writes.
 */
export function readExpansionComments(
  issue: number,
  producer: string,
  marked: (marker: string) => string | undefined,
): Expanded[] | undefined {
  let json = "";
  let count: number | undefined;
  for (let part = 1; count === undefined || part <= count; part++) {
    const marker = EXPANSION_MARK(issue, producer, part);
    const found = new RegExp(
      `^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nExpansion data of [^\\n]*, part ${part} of (\\d+):\\n\\n\`\`\`json\\n([^\\n]*)\\n\`\`\`$`,
    ).exec(marked(marker) ?? "");
    if (!found) return undefined;
    const total = Number(found[1]);
    if (count !== undefined && total !== count) return undefined;
    count = total;
    json += found[2];
  }
  try {
    const records = JSON.parse(json) as Expanded[];
    return Array.isArray(records) &&
      records.every(
        (record) =>
          typeof record?.envelopeId === "string" &&
          Array.isArray(record.children) &&
          record.children.every(
            (child) =>
              typeof child?.id === "string" && Array.isArray(child.paths),
          ),
      )
      ? records
      : undefined;
  } catch {
    return undefined;
  }
}
