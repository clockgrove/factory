import type { analyzeInteractions } from "./analysis.js";

type Report = ReturnType<typeof analyzeInteractions>;
const xmlEscape = (value: unknown) =>
  String(value ?? "unavailable").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
const timestamp = (at: string | null) => {
  const time = at === null ? NaN : Date.parse(at);
  return Number.isFinite(time) ? time : null;
};

// Only these existing producers report duration of the named operation.
// Snapshot events can carry whole Work Item duration, even after completion.
const timedOperations = new Set([
  "planning-preview",
  "planning-decision",
  "planning",
  "github-projection",
  "media-materialization",
  "acceptance-review",
  "github-publication",
  "github-merge",
  "github-stack-merge",
  "github-stack",
  "media-hydration-verification",
  "objective-acceptance-review",
  "objective-validation",
  "validation-command",
  "objective-validation-command",
]);

/** Presentation of retained metadata only; no pairing of unrelated events. */
export function renderAnalysisGantt(report: Report): string {
  const rows: {
    scope: string;
    label: string;
    start: number | null;
    end: number | null;
    points: number[];
    detail: string;
    kind: string;
  }[] = [];
  const scope = (identity: {
    repository: unknown;
    objective: unknown;
    runId: unknown;
    itemId: unknown;
    attemptId: unknown;
  }) =>
    `Repository ${identity.repository} / Objective ${identity.objective} / Run ${identity.runId ?? "unavailable"} / Item ${identity.itemId ?? "Objective scope"} / Attempt ${identity.attemptId ?? "unavailable"}`;
  for (const invocation of report.invocations) {
    const interval = invocation.interval;
    rows.push({
      scope: scope(invocation.identity),
      label: `Provider ${invocation.identity.phase}: ${invocation.identity.invocationId} / provider attempt ${invocation.identity.providerAttempt}`,
      start: interval.complete ? timestamp(interval.startedAt) : null,
      end: interval.complete ? timestamp(interval.endedAt) : null,
      points: interval.complete
        ? []
        : invocation.observations.flatMap((observation) => {
            const at = timestamp(observation.at);
            return at === null ? [] : [at];
          }),
      detail: interval.complete
        ? `request observed ${interval.startedAt}; provider terminal observed ${interval.endedAt}; ${interval.durationMs} ms`
        : `Incomplete provider interval: request ${interval.startedAt ?? "unavailable"}; terminal ${interval.endedAt ?? "unavailable"}; dots are retained observations only`,
      kind: "provider",
    });
  }
  for (const event of report.controllerObservations) {
    const end = timestamp(event.at);
    const timed =
      timedOperations.has(event.operation) &&
      end !== null &&
      event.durationMs !== null &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0 &&
      ["completed", "failed", "waiting"].includes(event.outcome);
    const start = timed ? end! - event.durationMs! : null;
    const validStart =
      start !== null && Number.isFinite(start) && Math.abs(start) <= 8.64e15
        ? start
        : null;
    rows.push({
      scope: scope(event),
      label: `Controller ${event.operation}: ${event.outcome} / ${event.eventId}`,
      start: validStart,
      end: validStart === null ? null : end,
      points: validStart === null && end !== null ? [end] : [],
      detail:
        validStart === null
          ? `Observation ${event.at}; operation interval unavailable; reported duration ${event.durationMs ?? "unavailable"}${event.durationMs === null ? "" : " ms (scope unavailable)"}`
          : `duration-derived start ${new Date(validStart).toISOString()}; terminal observation ${event.at}; reported ${event.durationMs} ms`,
      kind: "controller",
    });
  }
  rows.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.kind.localeCompare(b.kind) ||
      (a.start ?? a.points[0] ?? Infinity) -
        (b.start ?? b.points[0] ?? Infinity) ||
      a.label.localeCompare(b.label),
  );
  const times = rows
    .flatMap((row) => [row.start, row.end, ...row.points])
    .filter((value): value is number => value !== null);
  const first = times.length ? times.reduce((a, b) => Math.min(a, b)) : 0;
  const last = times.length ? times.reduce((a, b) => Math.max(a, b)) : 0;
  const width = rows.reduce(
    (maximum, row) =>
      Math.max(
        maximum,
        60 +
          8 * Math.max(row.scope.length, row.label.length, row.detail.length),
      ),
    1400,
  );
  const x = (at: number) =>
    30 + ((at - first) / Math.max(1, last - first)) * (width - 60);
  const footer = 170 + Math.max(1, rows.length) * 104;
  const text = (y: number, value: unknown, size = 12) =>
    `<text x="30" y="${y}" font-size="${size}">${xmlEscape(value)}</text>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footer + 160}" viewBox="0 0 ${width} ${footer + 160}" role="img" aria-labelledby="title description">`,
    `<title id="title">Factory Objective retained timeline</title><desc id="description">Provider and controller observations by recorded scope. Incomplete intervals are points. Reported controller durations have derived starts.</desc>`,
    `<rect width="100%" height="100%" fill="white"/><g font-family="monospace" fill="#172033">`,
    text(
      30,
      "Factory Objective retained timeline — private local metadata",
      18,
    ),
    text(
      55,
      "Blue: observed provider interval. Amber: reported controller duration (derived start). Dots: observations; interval unavailable.",
    ),
    text(
      77,
      "Scope hierarchy: repository → Objective → run → item → attempt. Each record has its own lane; concurrent lanes overlap.",
    ),
    text(
      102,
      times.length
        ? `Axis UTC: ${new Date(first).toISOString()} → ${new Date(last).toISOString()}`
        : "No timestamped observations available",
    ),
    text(
      125,
      `Usage and cost: inspect analyze text/JSON; missing accounting stays unavailable. ${report.observedWindow.incompleteIntervals} incomplete provider intervals.`,
    ),
  ];
  rows.forEach((row, index) => {
    const y = 155 + index * 104;
    svg.push(
      text(y, row.scope),
      text(y + 18, row.label),
      text(y + 36, row.detail, 11),
    );
    const color = row.kind === "provider" ? "#2563eb" : "#b45309";
    svg.push(`<path d="M30 ${y + 54}H${width - 30}" stroke="#e5e7eb"/>`);
    if (row.start !== null && row.end !== null)
      svg.push(
        `<rect x="${x(row.start)}" y="${y + 47}" width="${Math.max(2, x(row.end) - x(row.start))}" height="14" fill="${color}"><title>${xmlEscape(row.detail)}</title></rect>`,
      );
    for (const point of new Set(row.points))
      svg.push(
        `<circle cx="${x(point)}" cy="${y + 54}" r="4" fill="${color}"><title>${xmlEscape(new Date(point).toISOString())}</title></circle>`,
      );
  });
  if (!rows.length)
    svg.push(
      text(
        170,
        "No retained provider or controller observations match this selection.",
      ),
    );
  svg.push(
    text(footer, "Interpretation limits", 14),
    text(
      footer + 24,
      "Intervals are wall-clock observations, not CPU/network measurements or necessarily whole LLM requests.",
    ),
    text(
      footer + 44,
      "Overlapping rows must not be added. No scheduling dependencies, missing work, causal ownership or live activity are inferred.",
    ),
    text(
      footer + 64,
      "Controller scopes use repository/Objective/run/item/attempt filters only; model/invocation filters do not establish ownership.",
    ),
    text(
      footer + 84,
      "No prompts, responses, command output or tool content loaded. Capture coverage and missing endpoints remain incomplete.",
    ),
    "</g></svg>\n",
  );
  return svg.join("\n");
}
