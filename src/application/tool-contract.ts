import type { ApplicationOperation } from "./services.js";

export type ApplicationToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const READ: ApplicationToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE: ApplicationToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE: ApplicationToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

/** The executable MCP contract; registration iterates this table directly. */
export const APPLICATION_TOOL_DEFINITIONS: ReadonlyArray<readonly [string, ApplicationOperation, ApplicationToolAnnotations]> = [
  ["factory_doctor", "doctor", READ], ["factory_plan", "plan", READ],
  ["factory_status", "status", READ], ["factory_explain", "explain", READ],
  ["factory_activate", "activate", WRITE], ["factory_pause", "pause", WRITE],
  ["factory_resume", "resume", WRITE], ["factory_drain", "drain", WRITE],
  ["factory_pause_cloud", "cloud-pause", WRITE], ["factory_retry", "retry", WRITE],
  ["factory_priority", "priority", WRITE], ["factory_replay", "replay", WRITE],
  ["factory_cancel", "cancel", DESTRUCTIVE], ["factory_controller_start", "controller-start", WRITE],
  ["factory_controller_stop", "controller-stop", DESTRUCTIVE], ["factory_controller_install", "controller-install", WRITE],
  ["factory_controller_uninstall", "controller-uninstall", DESTRUCTIVE],
];
