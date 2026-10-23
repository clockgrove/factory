/**
 * The package entry: Factory as a library (CORE.md#Library). The CLI is
 * `factory` (cli.ts); this is what a host program imports.
 */

export type { AnalysisField, AnalysisReport, RunHistory } from "./analysis.js";
export { analysisText as renderAnalysis } from "./analysis.js";
export type { Prepared, SendReceipt } from "./capture-export.js";
export { previewText, sendExport, writeExport } from "./capture-export.js";
export type { CoreConfig } from "./config.js";
export { loadConfig } from "./config.js";
export type { RunChoice } from "./diagnostics.js";
export type { FollowOptions, FollowResult } from "./host.js";
export { ConfigurationError, Refusal } from "./host.js";
export type { RegisteredKind, WorkerContext } from "./kinds.js";
export { HOST_KIND, registerKind } from "./kinds.js";
export type { InteractionRecord } from "./library.js";
export {
  analysisFields,
  analyzeInteractions,
  dreamFactory,
  prepareCaptureExport,
  proposeFactory,
  readInteractionContent,
  readInteractionMetadata,
  runFactory,
  serveFactory,
  summarizeFormalHistory,
} from "./library.js";
export type { LogEvent } from "./log.js";
export type { Plan, WorkItem } from "./planning/types.js";
export type { ProviderConfig } from "./providers/config.js";
export type {
  ModelChoice,
  Planner,
  PlannerAnswer,
  PlannerCall,
  PlannerModels,
  PlannerPhase,
} from "./providers/planner.js";
export {
  callImages,
  loggedCall,
  modelChoice,
  PLANNER_PHASES,
  PlannerError,
} from "./providers/planner.js";
export { providerPlanner, providerWorker } from "./providers/selection.js";
export type { ModelRole, Tokens } from "./providers/usage.js";
export {
  captureResponse,
  describeRequest,
  logUsage,
  tokens,
  usageRecord,
} from "./providers/usage.js";
export type { RefusalCode } from "./requests.js";
export type { StatusView } from "./status.js";
export type {
  Worker,
  WorkerActivity,
  WorkerInput,
  WorkerResult,
  WorkerSpend,
} from "./work/worker.js";
