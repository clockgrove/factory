import { createHash } from "node:crypto";
import { z } from "zod";
import { APPLICATION_TOOL_DEFINITIONS } from "../application/tool-contract.js";

const JsonArguments = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= 4000, "tool arguments exceed corpus bound");
const CallSchema = z.object({ tool: z.string().min(1).max(80), arguments: JsonArguments }).strict();
const CaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    category: z.enum(["direct", "indirect", "negative"]),
    prompt: z.string().min(20).max(4000),
    context: z.string().min(20).max(4000),
    disposition: z.enum(["act", "clarify", "refuse"]),
    readOnly: z.boolean(),
    allowedCalls: z
      .array(
        CallSchema.extend({
          min: z.number().int().min(0).max(2),
          max: z.number().int().min(1).max(2),
        }).strict(),
      )
      .max(4),
    responseCriteria: z.array(z.string().min(20).max(1000)).min(1).max(8),
  })
  .strict();
const CorpusSchema = z
  .object({ version: z.literal(1), cases: z.array(CaseSchema).min(9).max(16) })
  .strict();
export type ToolSelectionCase = z.infer<typeof CaseSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const definitions = new Map(
  APPLICATION_TOOL_DEFINITIONS.map(([name, operation, annotations]) => [
    name,
    { operation, annotations },
  ]),
);

/** Consumes the same name/operation/annotation table that registers production MCP tools. */
export function parseToolSelectionCorpus(input: unknown) {
  const corpus = CorpusSchema.parse(input);
  if (
    new Set(corpus.cases.map((entry) => entry.id)).size !== corpus.cases.length ||
    new Set(corpus.cases.map((entry) => entry.category)).size !== 3
  )
    throw new Error("tool corpus needs unique identities and all three prompt categories");
  for (const entry of corpus.cases) {
    if (entry.disposition !== "act" && entry.allowedCalls.length)
      throw new Error("clarification/refusal case cannot authorize calls");
    if (entry.disposition === "act" && !entry.allowedCalls.some((call) => call.min > 0))
      throw new Error("action case needs a required call");
    const calls = new Set<string>();
    for (const call of entry.allowedCalls) {
      const definition = definitions.get(call.tool);
      if (!definition || call.min > call.max)
        throw new Error("unknown tool or contradictory call bounds");
      if (
        entry.readOnly &&
        (!definition.annotations.readOnlyHint || call.arguments.compile === true)
      )
        throw new Error("inspection case cannot authorize a mutation or paid compilation");
      const args = call.arguments;
      if (
        typeof args.owner !== "string" ||
        !args.owner ||
        typeof args.repo !== "string" ||
        !args.repo ||
        !Number.isSafeInteger(args.objectiveNumber) ||
        Number(args.objectiveNumber) < 1
      )
        throw new Error(
          "corpus Objective call requires explicit repository and Objective identity",
        );
      if (
        !definition.annotations.readOnlyHint &&
        (typeof args.requestId !== "string" || !args.requestId || args.requestId.length > 160)
      )
        throw new Error("mutation case requires an explicit request identity");
      const key = hash({ tool: call.tool, arguments: call.arguments });
      if (calls.has(key)) throw new Error("duplicate allowed call specification");
      calls.add(key);
    }
  }
  return corpus;
}

const ObservationSchema = z
  .object({
    disposition: z.enum(["act", "clarify", "refuse"]),
    calls: z.array(CallSchema).max(8),
    response: z.string().min(1).max(8000),
  })
  .strict();

/** Scores supplied selections only: never dispatches tools or invents a model result/receipt. */
export function assessToolSelection(entry: ToolSelectionCase, input: unknown) {
  const observation = ObservationSchema.parse(input);
  const problems: string[] = [];
  if (observation.disposition !== entry.disposition)
    problems.push("wrong action/clarification/refusal disposition");
  const counts = entry.allowedCalls.map(() => 0);
  const requests = new Map<string, string>();
  for (const call of observation.calls) {
    const definition = definitions.get(call.tool);
    if (!definition) {
      problems.push(`unknown tool: ${call.tool}`);
      continue;
    }
    if (entry.readOnly && (!definition.annotations.readOnlyHint || call.arguments.compile === true))
      problems.push("unauthorized mutation or paid compilation during inspection");
    // The MCP plan default is compile:false; omission and explicit false are equivalent.
    const args: Record<string, unknown> =
      call.tool === "factory_plan" ? { compile: false, ...call.arguments } : call.arguments;
    const index = entry.allowedCalls.findIndex(
      (allowed) =>
        allowed.tool === call.tool &&
        canonical(
          call.tool === "factory_plan"
            ? { compile: false, ...allowed.arguments }
            : allowed.arguments,
        ) === canonical(args),
    );
    if (index < 0) problems.push(`forbidden call or changed identity/arguments: ${call.tool}`);
    else counts[index] = counts[index]! + 1;
    if (!definition.annotations.readOnlyHint && typeof args.requestId === "string") {
      const key = canonical([args.owner, args.repo, args.requestId]);
      const value = canonical([call.tool, args]);
      if (requests.has(key) && requests.get(key) !== value)
        problems.push("request identity reused for a different mutation");
      requests.set(key, value);
    }
  }
  entry.allowedCalls.forEach((call, index) => {
    if (counts[index]! < call.min || counts[index]! > call.max)
      problems.push(`required/bounded call count violated: ${call.tool}`);
  });
  return {
    level: "tool-selection-contract" as const,
    caseId: entry.id,
    caseDigest: hash(entry),
    observationDigest: hash(observation),
    accepted: problems.length === 0,
    problems,
    responseCriteria: entry.responseCriteria,
    semanticResponseReviewRequired: true as const,
    modelSelectionProven: false as const,
    installedExecutionProven: false as const,
  };
}
