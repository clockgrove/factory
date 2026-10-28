/**
 * The worker's Validate tool's name, as the Copilot and Codex workers serve
 * it (work/self-validate.ts) and as prompts and the repair diagnosis name
 * it. Its own module, importing nothing: the prompts' modules sit in an
 * import cycle with self-validate.ts.
 */
export const VALIDATION_TOOL_NAME = "run_validation";
