/**
 * Factory as a library (CORE.md#Library): serve an installation and run
 * Objectives from a host program, with the host's own Planner and Worker
 * as registered kinds (kinds.ts), and read the analysis of a run log. The
 * service stays the only writer of Factory state: runFactory sends the
 * same request `factory run` does, and every reader here only reads.
 */

import { join } from "node:path";
import {
  ANALYSIS_FIELDS,
  type AnalysisField,
  type AnalysisReport,
  analysisReport,
} from "./analysis.js";
import {
  type ExportOptions,
  type Prepared,
  prepareExport,
} from "./capture-export.js";
import {
  chosenFiles,
  type RunChoice,
  readCapture,
  readRun,
} from "./diagnostics.js";
import {
  configOf,
  type FollowOptions,
  type FollowResult,
  followRun,
  Refusal,
  serveInstallation,
} from "./host.js";
import type { LogEvent } from "./log.js";
import { captureFile, installationPaths } from "./paths.js";

/** Every run in the run log, oldest first: what a reader reads unless told otherwise. */
const ALL: RunChoice = { kind: "all" };

/** The installation's logs, and the secret values every event is redacted of. */
function readable(repository: string) {
  return {
    logs: installationPaths(repository).logs,
    secrets: configOf(repository)?.secrets ?? [],
  };
}

/**
 * Serve `repository`'s installation in this process until SIGTERM, SIGINT
 * or `signal`, as `factory serve` does: the host kinds this process
 * registered (registerKind) run there. A second service on the
 * installation is refused by its lock; a configuration that doesn't load,
 * or names a host kind this process hasn't registered, throws.
 */
export function serveFactory(options: {
  repository: string;
  /** The provider new Objectives freeze; defaultProvider without it. */
  provider?: string;
  signal?: AbortSignal;
}): Promise<number> {
  return serveInstallation(
    options.repository,
    installationPaths(options.repository),
    options,
  );
}

/**
 * Run an Objective as `factory run` does: one request to the service,
 * then follow it until it is done (code 0), cancelled (1), needs a person
 * (2: a question, or no service running) or `signal` stops the following
 * (130; the Objective keeps running). A refusal throws Refusal with its
 * stable code.
 */
export function runFactory(
  options: { repository: string } & FollowOptions,
): Promise<FollowResult> {
  const { repository, deadline } = options;
  if (
    deadline !== undefined &&
    !(Date.parse(deadline) > Date.now() && /^\d{4}-\d\d-\d\dT/.test(deadline))
  )
    throw new Refusal(
      "usage",
      `deadline ${deadline} is not an ISO time after now`,
    );
  return followRun(installationPaths(repository), repository, options);
}

/** One model call: its redacted `model-usage` event, the run it is in, and its capture file when content was captured. */
export type InteractionRecord = LogEvent & {
  run: string;
  capturePath?: string;
};

/** The model calls of an Objective's runs (all of them by default), oldest run first. */
export function readInteractionMetadata(
  repository: string,
  issue: number,
  runs: RunChoice = ALL,
): InteractionRecord[] {
  const { logs, secrets } = readable(repository);
  const records: InteractionRecord[] = [];
  for (const file of chosenFiles(logs, issue, runs))
    readRun(file, 0, secrets, (event) => {
      if (event.event !== "model-usage") return;
      const run = String(event.run);
      const capture =
        typeof event.capture === "string"
          ? captureFile(issue, run, event.capture)
          : undefined;
      records.push({
        ...event,
        run,
        ...(capture ? { capturePath: join(logs, capture) } : {}),
      });
    });
  return records;
}

/**
 * A captured call's request and response, redacted (CORE.md#Content
 * capture); cut to capture.maxBytesPerCall when `truncated`. Throws when
 * the call captured nothing, or its run was rotated away.
 */
export function readInteractionContent(
  repository: string,
  issue: number,
  record: Pick<InteractionRecord, "run" | "capture">,
): { request?: string; response?: string; truncated?: true } {
  const { logs, secrets } = readable(repository);
  const file =
    typeof record.capture === "string"
      ? captureFile(issue, record.run, record.capture)
      : undefined;
  const body = file && readCapture(logs, file, secrets);
  if (!body)
    throw new Error(
      "Captured interaction content unavailable: the call captured nothing (capture.enabled was off), or retention removed its run",
    );
  return body;
}

/** The fields analysis groups and filters model calls by. */
export const analysisFields = ANALYSIS_FIELDS;

/**
 * The analysis views of an Objective's runs (all by default), as
 * `factory diagnostics N --analyze --json` prints them: calls, tokens,
 * cache, tools, time, retries, repairs, holds and the formal history.
 */
export function analyzeInteractions(
  repository: string,
  issue: number,
  options: {
    groupBy?: AnalysisField[];
    /** FIELD=VALUE matches exactly; `null` matches a missing value. */
    filters?: Partial<Record<AnalysisField, string>>;
    runs?: RunChoice;
  } = {},
): AnalysisReport {
  const groupBy: AnalysisField[] = [
    ...new Set(options.groupBy ?? (["phase"] as const)),
  ];
  const filters = options.filters ?? {};
  for (const field of [...Object.keys(filters), ...groupBy])
    if (!ANALYSIS_FIELDS.includes(field as AnalysisField))
      throw new Error(`Unsupported analysis field: ${field}`);
  return analysisReport({
    ...readable(repository),
    issue,
    runs: options.runs ?? ALL,
    groupBy,
    filters,
  });
}

/**
 * The formal history of an Objective's runs (log.ts RunLog): step
 * attempts paired with their outcomes, and per run its header (Factory
 * version, source digest), sequence gaps, log health and how it ended.
 * `completeness` is `unknown`, with the reasons, whenever any of that is
 * missing; compare `runs` with the runs and digests you expect.
 */
export function summarizeFormalHistory(
  repository: string,
  issue: number,
  runs: RunChoice = ALL,
): AnalysisReport["history"] {
  return analyzeInteractions(repository, issue, { runs }).history;
}

/**
 * An OpenTelemetry export of an Objective's model calls, built and
 * previewed without sending, as `factory export-captures` does: send it
 * with sendExport and the preview's authorizationDigest, or write it with
 * writeExport. A string is why it can't be built.
 */
export function prepareCaptureExport(
  repository: string,
  issue: number,
  options: Pick<ExportOptions, "content" | "invocations" | "endpoint"> & {
    runs?: RunChoice;
  },
): Prepared | string {
  return prepareExport({
    ...readable(repository),
    repository,
    issue,
    runs: options.runs ?? ALL,
    content: options.content,
    ...(options.invocations ? { invocations: options.invocations } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
  });
}
