import { type LogEvent, redact } from "./log.js";
import { code, prose } from "./markdown.js";
import type { HoldClosing } from "./state.js";

/**
 * Who answered or cancelled a question, for a GitHub comment: a
 * `/factory` comment's author by login in a code span (so no one is
 * mentioned) with a link to the comment, a CLI request as "the operator"
 * (never the host's user name), Factory itself, or the operator; with
 * `as`, redacted and escaped, when someone gave it on their behalf.
 */
export function answeredBy(
  closing: Pick<HoldClosing, "by" | "as" | "channel" | "comment">,
  secrets: readonly string[],
): string {
  const as = closing.as ? ` (as ${prose(redact(closing.as, secrets))})` : "";
  switch (closing.channel) {
    case "comment": {
      const link =
        closing.comment && /^https:\/\/[^\s()<>]+$/.test(closing.comment)
          ? `[a \`/factory\` comment](${closing.comment})`
          : "a `/factory` comment";
      return `${closing.by ? code(closing.by) : "someone"}${as} in ${link}`;
    }
    case "factory":
      return "Factory itself";
    default:
      return `the operator${as}${closing.channel === "cli" ? " from the CLI" : ""}`;
  }
}

/**
 * Times for people: `YYYY-MM-DD HH:MM:SS ZONE` in the host's zone, or in
 * FACTORY_DISPLAY_TIMEZONE (an IANA name) when it names a valid one. JSON
 * output keeps ISO times in UTC; only text uses this.
 */
export function displayTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    formatter()
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

let cached: Intl.DateTimeFormat | undefined;

function formatter(): Intl.DateTimeFormat {
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  };
  const zone = process.env.FACTORY_DISPLAY_TIMEZONE?.trim();
  try {
    cached = new Intl.DateTimeFormat("en-US", {
      ...options,
      ...(zone ? { timeZone: zone } : {}),
    });
  } catch {
    // Not a zone this host knows: the host's own zone.
    cached = new Intl.DateTimeFormat("en-US", options);
  }
  return cached;
}

/**
 * Every string in `value` redacted (tokens, bearer headers and the named
 * secret values), keeping its shape, so JSON output stays valid and no
 * escaped form of a secret slips past.
 */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((entry) => redactDeep(entry, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDeep(entry, secrets),
      ]),
    ) as T;
  return value;
}

/** A run log event as one line of text. */
export function eventLine(event: LogEvent): string {
  const { at, step, event: kind, ...rest } = event;
  const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${displayTime(at)}${step ? ` ${step}` : ""} ${kind ?? ""}${detail}`;
}

/** A span for people: `45 s`, `12 min`, `3 h 5 min`. */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
