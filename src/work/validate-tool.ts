/**
 * The worker's Validate tool's name, as the Copilot and Codex workers serve
 * it (work/self-validate.ts) and as prompts and the repair diagnosis name
 * it, and what every worker with a shell of its own is told about that
 * shell (#2156). Its own module, importing nothing: the prompts' modules sit
 * in an import cycle with self-validate.ts.
 */
export const VALIDATION_TOOL_NAME = "run_validation";

/**
 * How Factory collects and validates a worker's result, for a worker with a
 * shell: what HEAD holds in its checkout and where Factory validates.
 */
export const COLLECTED_RESULT =
  "Do not commit: Factory collects your uncommitted changes as a new commit on your checkout's HEAD and validates that commit in a fresh checkout, so a check of HEAD there sees your result, while HEAD in your checkout doesn't hold your uncommitted changes.";

/**
 * The repository's dependencies in a worker's own shell, which has the
 * network (`network`) or none: never installed there, and with no network
 * never installable.
 */
export function shellDependencies(network: boolean): string {
  return network
    ? "The repository's dependencies are not installed in your checkout. You may install them there to run a command, but Factory's validation never uses what you install: it runs the exact locked install itself."
    : "The repository's dependencies are not installed in your checkout, and without a network they can't be: package installs, and the linters, type checkers, test runners, builds and generators that need the dependencies, don't run in your shell.";
}
