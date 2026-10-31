/**
 * The spend ceiling (docs/reference/state.md#Spend ceiling): model spend
 * an Objective may reach before Factory asks, per Objective and per day,
 * in tokens, list cost, or both. The limits come from the configuration
 * the Objective froze (`autonomy.spend`); none is set by default. Every
 * model call's `model-usage` event is charged to its Objective
 * (`state.spend`) and to the installation's day (`spend.json`, a UTC
 * day), its child threads and sub-agents included. Reaching a limit holds the Objective before its next model step,
 * and `more` raises each limit reached to what is used plus one more step
 * (the limit's size), so a call that overshot it still leaves a full step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectiveState } from "./state.js";
import { writeAtomic } from "./state.js";

/** Tokens and list cost in cents, summed over calls; a count a provider doesn't report adds nothing. */
export interface Amount {
  tokens: number;
  cents: number;
}

/** Limits in either unit or both; an absent one is no limit. */
export type Limit = Partial<Amount>;

export interface SpendLimits {
  perObjective?: Limit;
  perDay?: Limit;
}

/**
 * An Objective's spend, with the operator's `more` grants (a day's grant
 * counts on its day only), and how many of its tokens child threads spent
 * (`childTokens`, a call's `model-usage` field).
 */
export interface Spend extends Amount {
  childTokens?: number;
  granted?: Limit;
  dayGranted?: Limit & { day: string };
}

/** One call's charge: its tokens (child threads' among them) and cost. */
export interface Charge extends Amount {
  childTokens: number;
}

/** The installation's spend on one UTC day. */
export interface Day extends Amount {
  day: string;
}

export type Scope = keyof SpendLimits;
export type Unit = keyof Amount;

/** One configured limit: what it counts, how much, and what it allows with grants. */
export interface Ceiling {
  scope: Scope;
  unit: Unit;
  used: number;
  allowed: number;
}

const UNITS: readonly Unit[] = ["tokens", "cents"];
const SCOPES: readonly Scope[] = ["perObjective", "perDay"];

/**
 * A `model-usage` event's tokens and cost. Its `tokens` hold its child
 * threads' and sub-agents' (#2168); when the call's own are unknown, its
 * child threads' (`childTokens`) still count.
 */
export function amountOf(event: Record<string, unknown>): Charge {
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const tokens = finite((event.tokens as { total?: unknown } | null)?.total);
  const children =
    finite((event.childTokens as { total?: unknown } | null)?.total) ?? 0;
  const cost = finite(event.costUsd);
  return {
    tokens: tokens ?? children,
    cents: cost === undefined ? 0 : cost * 100,
    childTokens: children,
  };
}

/** The limits the Objective froze; none without them. */
export function spendLimits(state: ObjectiveState): SpendLimits {
  const config = state.frozen?.config as
    | { autonomy?: { spend?: SpendLimits } }
    | undefined;
  return config?.autonomy?.spend ?? {};
}

/** Charge one call to the Objective. */
export function charge(
  state: ObjectiveState,
  amount: Amount & { childTokens?: number },
): void {
  const spend = state.spend ?? { tokens: 0, cents: 0 };
  const children = (spend.childTokens ?? 0) + (amount.childTokens ?? 0);
  state.spend = {
    ...spend,
    tokens: spend.tokens + amount.tokens,
    cents: spend.cents + amount.cents,
    ...(children ? { childTokens: children } : {}),
  };
}

/** Every configured limit, with what it has used and allows on `day`. */
export function ceilings(state: ObjectiveState, day: Day): Ceiling[] {
  const limits = spendLimits(state);
  const spend = state.spend;
  const dayGrant =
    spend?.dayGranted?.day === day.day ? spend.dayGranted : undefined;
  return SCOPES.flatMap((scope) =>
    UNITS.flatMap((unit) => {
      const base = limits[scope]?.[unit];
      if (base === undefined) return [];
      const objective = scope === "perObjective";
      return [
        {
          scope,
          unit,
          used: objective ? (spend?.[unit] ?? 0) : day[unit],
          allowed:
            base + ((objective ? spend?.granted : dayGrant)?.[unit] ?? 0),
        },
      ];
    }),
  );
}

/** The limits reached: the Objective's next model step asks first. */
export function reached(state: ObjectiveState, day: Day): Ceiling[] {
  return ceilings(state, day).filter(
    (ceiling) => ceiling.used >= ceiling.allowed,
  );
}

/** What `more` makes a reached limit allow: what is used plus one more step. */
function raisedTo(ceiling: Ceiling, limits: SpendLimits): number {
  return ceiling.used + limits[ceiling.scope]![ceiling.unit]!;
}

/** The engine's `more`: each limit reached allows one more step beyond what is used. */
export function grantSpend(state: ObjectiveState, day: Day): void {
  const limits = spendLimits(state);
  const spend = state.spend ?? { tokens: 0, cents: 0 };
  const granted = { ...spend.granted };
  const dayGranted =
    spend.dayGranted?.day === day.day
      ? { ...spend.dayGranted }
      : { day: day.day };
  for (const ceiling of reached(state, day)) {
    const { scope, unit, allowed } = ceiling;
    const more = raisedTo(ceiling, limits) - allowed;
    if (scope === "perObjective") granted[unit] = (granted[unit] ?? 0) + more;
    else dayGranted[unit] = (dayGranted[unit] ?? 0) + more;
  }
  state.spend = { ...spend, granted, dayGranted };
}

/** An amount as status and questions show it. */
export function amountText(unit: Unit, value: number): string {
  return unit === "tokens"
    ? `${Math.round(value).toLocaleString("en-US")} tokens`
    : `$${(value / 100).toFixed(2)}`;
}

const SCOPE_TEXT: Record<Scope, string> = {
  perObjective: "this Objective's",
  perDay: "today's (UTC)",
};

/** `N of them by child threads` when the Objective's tokens hold some, else empty. */
export function childText(spend: Spend | undefined): string {
  return spend?.childTokens
    ? `${Math.round(spend.childTokens).toLocaleString("en-US")} of them by child threads`
    : "";
}

/** The question a reached limit asks. */
export function spendQuestion(state: ObjectiveState, day: Day): string {
  const limits = spendLimits(state);
  const past = reached(state, day).map((ceiling) => {
    const { scope, unit, used, allowed } = ceiling;
    const children =
      scope === "perObjective" && unit === "tokens"
        ? childText(state.spend)
        : "";
    return `${SCOPE_TEXT[scope]} ${amountText(unit, used)} of ${amountText(unit, allowed)} (${children ? `${children}; ` : ""}autonomy.spend.${scope}.${unit}; \`more\` allows ${amountText(unit, limits[scope]![unit]!)} more, to ${amountText(unit, raisedTo(ceiling, limits))})`;
  });
  return `Model spend reached ${past.join(" and ")}. Tokens count every call's child threads and sub-agents too (Codex \`spawn_agent\` threads, Claude sub-agents). Calls already running finish; no other model step starts until you answer.\n\nAnswer \`more\` to go on, or cancel.`;
}

const FILE = "spend.json";

/** The UTC day of `at`, `YYYY-MM-DD`. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The installation's spend today, from `spend.json` in its root; nothing yet when it holds another day's. */
export function readDay(root: string, now = new Date()): Day {
  const day = dayOf(now);
  try {
    const saved = JSON.parse(readFileSync(join(root, FILE), "utf8")) as Day;
    if (saved.day === day)
      return {
        day,
        tokens: Number(saved.tokens) || 0,
        cents: Number(saved.cents) || 0,
      };
  } catch {
    // Nothing spent yet.
  }
  return { day, tokens: 0, cents: 0 };
}

/** The installation's day ledger: the service's runs share it. */
export class DaySpend {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  today(): Day {
    return readDay(this.root, this.now());
  }

  charge(amount: Amount): void {
    const day = this.today();
    writeAtomic(
      join(this.root, FILE),
      `${JSON.stringify({
        day: day.day,
        tokens: day.tokens + amount.tokens,
        cents: day.cents + amount.cents,
      })}\n`,
    );
  }
}
