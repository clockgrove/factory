/**
 * The spend ceiling (docs/reference/state.md#Spend ceiling): model spend
 * an Objective may reach before Factory asks, per Objective and per day,
 * in tokens, list cost, or both. The limits come from the configuration
 * the Objective froze (`autonomy.spend`); none is set by default. Every
 * model call's `model-usage` event is charged to its Objective
 * (`state.spend`) and to the installation's day (`spend.json`, a UTC
 * day). Reaching a limit holds the Objective before its next model step,
 * and `more` grants as much again of each limit reached.
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

/** An Objective's spend, with the operator's `more` grants (a day's grant counts on its day only). */
export interface Spend extends Amount {
  granted?: Limit;
  dayGranted?: Limit & { day: string };
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

/** A `model-usage` event's tokens and cost. */
export function amountOf(event: Record<string, unknown>): Amount {
  const tokens = (event.tokens as { total?: unknown } | null)?.total;
  const cost = event.costUsd;
  return {
    tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0,
    cents: typeof cost === "number" && Number.isFinite(cost) ? cost * 100 : 0,
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
export function charge(state: ObjectiveState, amount: Amount): void {
  const spend = state.spend ?? { tokens: 0, cents: 0 };
  state.spend = {
    ...spend,
    tokens: spend.tokens + amount.tokens,
    cents: spend.cents + amount.cents,
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

/** The engine's `more`: as much again of each limit reached. */
export function grantSpend(state: ObjectiveState, day: Day): void {
  const limits = spendLimits(state);
  const spend = state.spend ?? { tokens: 0, cents: 0 };
  const granted = { ...spend.granted };
  const dayGranted =
    spend.dayGranted?.day === day.day
      ? { ...spend.dayGranted }
      : { day: day.day };
  for (const { scope, unit } of reached(state, day)) {
    const more = limits[scope]![unit]!;
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

/** The question a reached limit asks. */
export function spendQuestion(state: ObjectiveState, day: Day): string {
  const limits = spendLimits(state);
  const past = reached(state, day).map(
    ({ scope, unit, used, allowed }) =>
      `${SCOPE_TEXT[scope]} ${amountText(unit, used)} of ${amountText(unit, allowed)} (autonomy.spend.${scope}.${unit}; \`more\` allows ${amountText(unit, limits[scope]![unit]!)} more)`,
  );
  return `Model spend reached ${past.join(" and ")}. Calls already running finish; no other model step starts until you answer.\n\nAnswer \`more\` to go on, or cancel.`;
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
