/**
 * Child threads' tokens in `model-usage` events, one view across Factory
 * versions (#2168), for diagnostics, the analysis and the scorecard.
 *
 * Since 0.5.9 a call's `tokens` hold its child threads' (Codex
 * `spawn_agent` threads), and `childTokens` says how many of them and how
 * many threads: a continued session's only what they added since the call
 * it continues. Before, a Codex call's child threads were only its
 * `providerUsage.descendants`: outside `tokens`, and cumulative over every
 * turn its home held, so a resumed call repeated the children of the call
 * it continued. `ChildThreads.counted` gives such an older call today's
 * shape: the increase of its descendants over the last call on the same
 * thread, added to its tokens. Events must come in log order.
 */
import type { LogEvent } from "./log.js";
import { type Tokens, tokens, withChildTokens } from "./providers/usage.js";

/** A call's child-thread tokens, with the threads that spent them. */
export type ChildTokens = Tokens & { threads: number };

const KEYS = ["threads", "input", "cached", "output", "reasoning", "total"];

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export class ChildThreads {
  /** Each thread's last cumulative `descendants` (older logs only). */
  private readonly last = new Map<string, Record<string, number>>();

  /** `event`, with its child threads in `tokens` and `childTokens`; any other event as it is. */
  counted(event: LogEvent): LogEvent {
    if (event.event !== "model-usage" || "childTokens" in event) return event;
    const descendants = (
      event.providerUsage as { descendants?: unknown } | null | undefined
    )?.descendants;
    if (!descendants || typeof descendants !== "object") return event;
    const now = Object.fromEntries(
      KEYS.map((key) => [
        key,
        count((descendants as Record<string, unknown>)[key]),
      ]),
    );
    const thread = typeof event.thread === "string" ? event.thread : undefined;
    const before = thread ? this.last.get(thread) : undefined;
    if (thread) this.last.set(thread, now);
    const added = (key: string) =>
      Math.max(0, now[key]! - (before?.[key] ?? 0));
    const children = tokens({
      input: added("input"),
      output: added("output"),
      cached: added("cached"),
      reasoning: added("reasoning"),
      cacheWrite: null,
      total: added("total"),
    });
    if (!children.total) return { ...event, childTokens: null };
    // A thread continued, none new: still one that spent.
    const threads = Math.max(1, added("threads"));
    const own = event.tokens as Tokens | null | undefined;
    return {
      ...event,
      ...(own && typeof own === "object"
        ? { tokens: withChildTokens(own, children) }
        : {}),
      childTokens: { ...children, threads },
    };
  }
}

/** An event's `childTokens`, when it has any. */
export function childTokensOf(event: LogEvent): ChildTokens | undefined {
  const children = event.childTokens as ChildTokens | null | undefined;
  return children && typeof children === "object" && count(children.total)
    ? children
    : undefined;
}
