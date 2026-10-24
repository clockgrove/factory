/**
 * Planner-requested context lookups: a structured turn inside a planner
 * step. The planner's answer may ask for context (repository memory, a
 * file's text, tracked paths) instead of planning. Factory answers each
 * request read-only at the base, inside the admitted selectors, keeps the
 * round in `state.kept` and asks the planner again with every answer so far.
 * A crash repeats at most the planner call: an answered round is kept, so
 * it is never asked again. The rounds, the requests per round and the
 * answer bytes are bounded by `planning.context.bounds`, which the Objective
 * froze; a request past them is refused to the planner by name, never
 * dropped.
 */
import type { CoreConfig } from "../config.js";
import type { Outcome, Step } from "../engine.js";
import { memoryLookup } from "../knowledge/index.js";
import {
  admitted,
  type PlanningContext,
  selectorText,
} from "../knowledge/settings.js";
import { redact } from "../log.js";
import { validPath } from "../objective.js";
import { type ShownObjective, shownDigest } from "../shown.js";
import type { ObjectiveState } from "../state.js";
import { errorMessage } from "../text.js";
import { type BaseFiles, sectionText } from "./facts.js";
import {
  LOOKUP_FIELD,
  LOOKUP_KINDS,
  type LookupRequest,
  withLookups,
} from "./wire.js";

/** One answered request: what was asked, how it went and the answer's text. */
interface LookupAnswer extends LookupRequest {
  disposition: "answered" | "no-match" | "refused" | "unavailable";
  detail: string;
  /** The answer, redacted of secret values; absent unless answered. */
  content?: string;
}

/** The answered rounds of one planner step, kept until the step is done or replanned. */
export const lookupsKey = (step: string) => `lookups:${step}`;

/** The rounds, with the base and the Objective as shown that they were answered for. */
interface KeptLookups {
  base: string;
  shown: string;
  rounds: LookupAnswer[][];
}

/** Echoed request fields are kept to this many characters. */
const ECHO_CHARS = 256;

/** One planner step's lookups. */
export interface Lookups {
  /** The `contextLookups` prompt data: the bounds left and every answered round. */
  data: Record<string, unknown>;
  /** Answer bodies by block label, rendered once as literal blocks. */
  bodies: { label: string; content: string }[];
  /** A round is left: the schema offers the lookup field. */
  open: boolean;
  /** The answer schema, with the lookup field while a round is left. */
  schema(schema: Record<string, unknown>): Record<string, unknown>;
  /**
   * The planner's answer without the lookup field, to decode as before; or,
   * when it asks, the outcome that keeps the answered round and asks again.
   */
  take(
    value: unknown,
    input: {
      issue: number;
      files: BaseFiles;
      secrets: readonly string[];
      log(event: Record<string, unknown>): void;
    },
  ): Promise<{ value: unknown } | { outcome: Outcome }>;
}

/** The lookups offered to the planner step `step`. */
export function plannerLookups(
  state: ObjectiveState,
  step: string,
  inputs: { base: string; shown: ShownObjective },
  config: CoreConfig,
): Lookups {
  const context = config.planning.context;
  const { bounds, selectors } = context;
  // Rounds answered for another base or another issue body (a replan's
  // re-read moved) no longer hold: start fresh.
  const binding = { base: inputs.base, shown: shownDigest(inputs.shown) };
  const kept = state.kept[lookupsKey(step)] as KeptLookups | undefined;
  const rounds =
    kept?.base === binding.base && kept.shown === binding.shown
      ? kept.rounds
      : [];
  // Each round adds one planner call, so both bounds cap the rounds.
  const roundsLeft = Math.max(
    0,
    Math.min(bounds.maxRounds, bounds.maxProviderCalls) - rounds.length,
  );
  const bytesLeft = Math.max(
    0,
    bounds.maxBytes -
      rounds
        .flat()
        .reduce(
          (sum, answer) => sum + Buffer.byteLength(answer.content ?? ""),
          0,
        ),
  );
  const label = (r: number, i: number) => `lookup ${r}.${i}`;
  return {
    data: {
      selectors: selectorText(selectors),
      memory: context.memory,
      roundsLeft,
      requestsPerRound: bounds.maxRequestsPerRound,
      bytesLeft,
      rounds: rounds.map((round, r) =>
        round.map(({ content, ...answer }, i) => ({
          ...answer,
          content: content === undefined ? null : { block: label(r, i) },
        })),
      ),
    },
    bodies: rounds.flatMap((round, r) =>
      round.flatMap(({ content }, i) =>
        content === undefined ? [] : [{ label: label(r, i), content }],
      ),
    ),
    open: roundsLeft > 0,
    schema: (schema) => (roundsLeft > 0 ? withLookups(schema) : schema),
    async take(value, input) {
      if (
        roundsLeft === 0 ||
        !value ||
        typeof value !== "object" ||
        !(LOOKUP_FIELD in value)
      )
        return { value };
      const { [LOOKUP_FIELD]: asked, ...rest } = value as Record<
        string,
        unknown
      >;
      // Anything but null or an array is a broken answer: the decoder
      // refuses the unknown field, so the step retries the call.
      if (asked !== null && !Array.isArray(asked)) return { value };
      if (!asked?.length) return { value: rest };
      const round: LookupAnswer[] = [];
      let left = bytesLeft;
      for (const raw of asked.slice(0, bounds.maxRequestsPerRound)) {
        const request = decodeRequest(raw);
        const answer = !request
          ? refused(
              { kind: "file", path: "", heading: "", query: "" },
              "not a lookup request: give exactly kind, path, heading and query as strings",
            )
          : await answerRequest(request, context, left, input);
        const bytes = Buffer.byteLength(answer.content ?? "");
        if (bytes > left)
          round.push(
            refused(
              request ?? answer,
              `the answer is ${bytes} bytes, over the ${left} bytes left of the lookup byte cap (planning.context.bounds.maxBytes); narrow it`,
            ),
          );
        else {
          left -= bytes;
          round.push(answer);
        }
      }
      // Requests past the cap are refused as one entry, so they cost no state.
      const over = asked.length - bounds.maxRequestsPerRound;
      if (over > 0)
        round.push(
          refused(
            { kind: "file", path: "", heading: "", query: "" },
            `${over} more request${over === 1 ? " was" : "s were"} refused: over the cap of ${bounds.maxRequestsPerRound} requests per round (planning.context.bounds.maxRequestsPerRound); ask again next round${roundsLeft > 1 ? "" : ", though this was the last"}`,
          ),
        );
      const count = (disposition: LookupAnswer["disposition"]) =>
        round.filter((answer) => answer.disposition === disposition).length;
      input.log({
        event: "planner-lookups",
        round: rounds.length + 1,
        requests: round.length,
        answered: count("answered"),
        refused: count("refused"),
        bytes: bytesLeft - left,
      });
      return {
        outcome: {
          kind: "retry",
          reason: `Answered the planner's context lookups (round ${rounds.length + 1})`,
          progress: true,
          keep: {
            [lookupsKey(step)]: {
              ...binding,
              rounds: [...rounds, round],
            } satisfies KeptLookups,
          },
        },
      };
    },
  };
}

/**
 * `step`, dropping its kept lookup rounds once it is done: the plan or the
 * amendment it gave is recorded, and the run log keeps each round's summary.
 */
export function forgetting(step: Step): Step {
  return {
    ...step,
    async run(context) {
      const outcome = await step.run(context);
      const key = lookupsKey(step.key);
      return outcome.kind === "done" && context.state.kept[key] !== undefined
        ? { ...outcome, keep: { ...outcome.keep, [key]: null } }
        : outcome;
    },
  };
}

function decodeRequest(raw: unknown): LookupRequest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !== "heading,kind,path,query" ||
    !LOOKUP_KINDS.includes(r.kind as never) ||
    [r.path, r.heading, r.query].some((field) => typeof field !== "string")
  )
    return undefined;
  return r as unknown as LookupRequest;
}

function refused(request: LookupRequest, detail: string): LookupAnswer {
  return { ...echo(request), disposition: "refused", detail };
}

/** The request as kept and shown again: its fields cut to a fixed length. */
function echo({ kind, path, heading, query }: LookupRequest): LookupRequest {
  const cut = (field: string) => field.slice(0, ECHO_CHARS);
  return { kind, path: cut(path), heading: cut(heading), query: cut(query) };
}

/** A relative file, or a directory prefix ending in a slash, with no traversal. */
function literal(path: string): boolean {
  return validPath(path.endsWith("/") ? path.slice(0, -1) : path);
}

/** Answer one request read-only, at the base and inside the selectors. */
async function answerRequest(
  request: LookupRequest,
  context: PlanningContext,
  bytesLeft: number,
  input: { issue: number; files: BaseFiles; secrets: readonly string[] },
): Promise<LookupAnswer> {
  const { selectors } = context;
  const { kind, path, heading, query } = request;
  const reply = (
    disposition: LookupAnswer["disposition"],
    detail: string,
    content?: string,
  ): LookupAnswer => ({
    ...echo(request),
    disposition,
    detail,
    ...(content === undefined
      ? {}
      : { content: redact(content, input.secrets) }),
  });
  const outside = `${JSON.stringify(path)} is outside the admitted planning context selectors`;
  if (kind === "memory") {
    if (!context.memory)
      return refused(
        request,
        "repository memory is off for this installation (planning.context.memory)",
      );
    if (!query.trim()) return refused(request, "a memory lookup needs a query");
    if (path && !(literal(path) && admitted(path, selectors)))
      return refused(request, outside);
    try {
      const section = await memoryLookup({
        issue: input.issue,
        context,
        text: query,
        paths: path ? [path] : selectors,
        maxBytes: bytesLeft,
        files: input.files,
      });
      return section.shown
        ? reply(
            "answered",
            `${section.shown} record${section.shown === 1 ? "" : "s"}${section.left ? `, ${section.left} more left out by the bounds` : ""}`,
            section.text,
          )
        : reply(
            "no-match",
            section.left
              ? `${section.left} relevant records were left out by the bounds; narrow it`
              : "no relevant record",
          );
    } catch (error) {
      return reply(
        "unavailable",
        `repository memory can't be read now (${errorMessage(error)}); plan without it`,
      );
    }
  }
  if (query) return refused(request, `a ${kind} lookup takes no query`);
  if (kind === "file") {
    if (path.endsWith("/") || !validPath(path) || !admitted(path, selectors))
      return refused(request, outside);
    const text = await input.files.text(path);
    if (text === undefined)
      return reply(
        "no-match",
        "not a tracked UTF-8 regular file at the base commit",
      );
    const content = heading ? sectionText(text, heading) : text;
    return content === undefined
      ? reply("no-match", `no heading ${JSON.stringify(heading)} in the file`)
      : reply("answered", heading ? "the section" : "the whole file", content);
  }
  if (heading) return refused(request, "a paths lookup takes no heading");
  if (path && !(path.endsWith("/") && literal(path)))
    return refused(
      request,
      'a paths lookup takes "" or a directory prefix ending in /',
    );
  const paths = (await input.files.paths())
    .filter((file) => file.startsWith(path) && admitted(file, selectors))
    .sort();
  return paths.length
    ? reply(
        "answered",
        `${paths.length} tracked path${paths.length === 1 ? "" : "s"}`,
        paths.join("\n"),
      )
    : reply("no-match", "no tracked path there inside the selectors");
}
