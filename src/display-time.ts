/**
 * Human-facing times. GitHub has no viewer time zone, so text shows the
 * controller host's zone, or FACTORY_DISPLAY_TIMEZONE (an IANA name), with
 * UTC beside it. Stored, compared and JSON times stay ISO UTC: never parse
 * these strings back or put them in a digest.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    formats.set(zone, found);
  }
  return found;
}

/** The display zone: a valid FACTORY_DISPLAY_TIMEZONE, else the host's. */
export function displayZone(): string {
  const requested = process.env.FACTORY_DISPLAY_TIMEZONE?.trim();
  if (requested)
    try {
      return format(requested).resolvedOptions().timeZone;
    } catch {
      // An invalid name falls back to the host zone.
    }
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface Parts {
  date: string;
  clock: string;
  seconds: string;
  zone: string;
}

function parts(at: Date, zone: string): Parts {
  const part: Record<string, string> = {};
  for (const { type, value } of format(zone).formatToParts(at))
    part[type] = value;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    clock: `${part.hour}:${part.minute}`,
    seconds: part.second ?? "00",
    zone: part.timeZoneName ?? zone,
  };
}

function render(
  value: string | number,
  withDate: boolean,
  withSeconds = false,
): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const utc = at.toISOString();
  const utcDate = utc.slice(0, 10);
  const utcClock = utc.slice(11, withSeconds ? 19 : 16);
  const zone = displayZone();
  if (zone === "UTC" || zone === "Etc/UTC")
    return `${withDate ? `${utcDate} ` : ""}${utcClock}Z`;
  const local = parts(at, zone);
  const clock = `${local.clock}${withSeconds ? `:${local.seconds}` : ""}`;
  // UTC names its date when it differs from the local one.
  const reference = `${local.date === utcDate ? "" : `${utcDate} `}${utcClock}Z`;
  return `${withDate ? `${local.date} ` : ""}${clock} ${local.zone} (${reference})`;
}

/** A date and time such as `2026-10-16 16:21 PDT (23:21Z)`. */
export const displayDateTime = (value: string | number): string =>
  render(value, true);

/** A time of day such as `16:21:05 PDT (23:21:05Z)`, for a same-day log. */
export const displayClock = (value: string | number): string =>
  render(value, false, true);
