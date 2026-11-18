// Visible times (#586): every time Pendulum writes for a person to read, in one form and one zone. The zone, first that
// names a zone: the Objective's own (the `<!-- pendulum:tz NAME -->` line its filer's machine put in its body,
// objectiveZone; a stage takes it once it has read its issue, useObjectiveZone), the repository's `time_zone` setting
// (PENDULUM_TIME_ZONE), an IANA zone name, the machine's own zone in local mode and on a developer's command line, else
// UTC (Actions, the cloud sandbox). Nothing is inferred from GitHub's own fields.
// The platform's Intl does the zone's rules (its offsets and daylight saving) and names the zone's abbreviation.
// Machine-read text never comes here: hidden markers, spend lines, the summary marker and every record's JSON stay ISO
// 8601 UTC, and a progress line carries its UTC minute in a hidden stamp beside the visible time (lineClock).
import { input, timeZoneName } from "./inputs.mjs";

/** The machine's own zone, as Intl resolves it (TZ, else the system's), UTC when it names none. */
export const machineZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Whether `env` is a run on the machine of the person reading it: local mode (PENDULUM_LOCAL), or a command run by hand,
 * which is neither an Actions job (GITHUB_ACTIONS) nor a cloud sandbox's stage (the launcher's PENDULUM_STAGE_CLAIM).
 */
export const onOwnMachine = (env = process.env) => env.PENDULUM_LOCAL === "1" || (env.GITHUB_ACTIONS !== "true" && !env.PENDULUM_STAGE_CLAIM);

/** The hidden line of an Objective's body that names its filer's zone (`pendulum zone` prints this machine's). */
export const zoneMarker = (zone) => `<!-- pendulum:tz ${zone} -->`;
const ZONE_LINE = /^<!-- pendulum:tz ([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}) -->\r?$/gm;

/**
 * The zone an Objective's body names (zoneMarker, on a line of its own), as Intl names it; null with none, with more
 * than one, or with one Intl does not know, so the next zone down applies. It changes only how times read.
 */
export function objectiveZone(body) {
  const found = [...String(body ?? "").matchAll(ZONE_LINE)];
  return found.length === 1 ? timeZoneName(found[0][1]) : null;
}

// The Objective this process works on: its zone, once read (useObjectiveZone); null names none.
let OBJECTIVE_ZONE = null;
/** Takes the zone the Objective's body names (objectiveZone) for every visible time this process writes from now on. */
export function useObjectiveZone(body) {
  OBJECTIVE_ZONE = objectiveZone(body);
  return OBJECTIVE_ZONE;
}

/**
 * The zone visible times are written in: `{zone, from, set, invalid}`. `from` names where it comes from: `objective`
 * (`objective`, the Objective's zone, else the one this process took, useObjectiveZone), `setting`, `machine` (on its
 * own machine, onOwnMachine) or `utc`. `set` is the setting's zone when it names one; `invalid` the setting's text when
 * it names none (doctor reports it), which is then ignored.
 */
export function timeZone(env = process.env, { objective = OBJECTIVE_ZONE } = {}) {
  const given = input("time_zone", { env }).trim();
  const named = given ? timeZoneName(given) : null;
  const invalid = given && !named ? given : null;
  if (objective) return { zone: objective, from: "objective", set: named, invalid };
  if (named) return { zone: named, from: "setting", set: named, invalid };
  return onOwnMachine(env) ? { zone: machineZone(), from: "machine", set: null, invalid } : { zone: "UTC", from: "utc", set: null, invalid };
}

const FORMATS = new Map();
/** One Intl formatter per zone and options, kept: building one is the costly part. */
function formatter(zone, options) {
  const key = `${zone}|${JSON.stringify(options)}`;
  let f = FORMATS.get(key);
  if (!f) FORMATS.set(key, (f = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options })));
  return f;
}

/** `t` (ms, an ISO text or a Date) as ms; NaN when it is no time. */
const msOf = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

/**
 * `t` as a person reads it in the zone (`zone`, else timeZone(env)'s): "9:00 AM PST". `seconds` adds them ("9:00:05 AM
 * PST"), `date` the month and day ("Nov 17, 9:00 AM PST"), and `abbr: false` leaves out the zone's abbreviation (for rows
 * under a heading that names the zone). Intl's narrow spaces are written as plain ones. "?" for no time.
 */
export function clockText(t, { env = process.env, zone = timeZone(env).zone, seconds = false, date = false, abbr = true } = {}) {
  const at = msOf(t);
  if (!Number.isFinite(at)) return "?";
  const f = formatter(zone, { ...(date ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), ...(abbr ? { timeZoneName: "short" } : {}) });
  return f.format(at).replace(/[  ]/g, " ");
}

/** `t` with its date, as a person reads it in the zone: "Nov 17, 9:00 AM PST" (clockText's `date`). */
export const whenText = (t, opts = {}) => clockText(t, { ...opts, date: true });

/** `t`'s UTC minute, the hidden stamp of a progress line: "17:00Z". */
const utcMinute = (t) => `${new Date(msOf(t)).toISOString().slice(11, 16)}Z`;

/**
 * A progress line's clock: the visible time in the zone, then its UTC minute in a hidden stamp, which the scorecard reads
 * (LINE_CLOCK): "9:00 AM PST<!-- 17:00Z -->".
 */
export const lineClock = (t, opts = {}) => (Number.isFinite(msOf(t)) ? `${clockText(t, opts)}<!-- ${utcMinute(t)} -->` : "?");

/**
 * A regular expression's source for a progress line's clock, lineClock's or the bare `HH:MMZ` of a line written before
 * it, capturing the UTC hour and minute.
 */
export const LINE_CLOCK = String.raw`(?:[^<\n]*<!-- )?(\d\d):(\d\d)Z(?: -->)?`;

/** The parts of `t`'s wall time in `zone`, each a number: {year, month, day, hour, minute, second}. */
function wallParts(t, zone) {
  const f = formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(f.formatToParts(msOf(t)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

/** `t`'s calendar day in `zone`: "2026-11-17". */
export function zoneDay(t, zone) {
  const p = wallParts(t, zone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** How far `zone`'s wall clock is ahead of UTC at `t`, in ms (negative west of Greenwich), as Intl reads its rules. */
export function zoneOffsetMs(t, zone) {
  const at = msOf(t);
  const p = wallParts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}
