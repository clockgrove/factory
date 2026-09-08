import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MINIMUM_SYSTEMD_VERSION = 254;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 4_096;

export const releasePreflightDiagnostic =
  "Factory release verification requires Linux systemd 254+ and a reachable systemd user manager. Run `systemctl --user show --property=Version --value --no-pager` in the Linux or WSL host and rerun `npm run verify:release` there; a nested sandbox without the user bus cannot run this gate.";

function majorVersion(value) {
  const match = /^\s*(?:systemd\s+)?(\d+)/.exec(value);
  return match ? Number(match[1]) : null;
}

async function defaultRun(command, args, options) {
  return exec(command, args, options);
}

/**
 * The coordinated release suite contains host-containment tests that need the
 * real user manager. This read-only probe rejects an invalid runner before any
 * broad tests can turn a missing transport into misleading product failures.
 */
export async function verifyReleasePreflight({
  platform = process.platform,
  run = defaultRun,
} = {}) {
  if (platform !== "linux") throw new Error(releasePreflightDiagnostic);

  const options = {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  };
  try {
    const manager = await run(
      "systemctl",
      ["--user", "show", "--property=Version", "--value", "--no-pager"],
      options,
    );
    const managerMajor = majorVersion(manager.stdout);
    if (managerMajor === null || managerMajor < MINIMUM_SYSTEMD_VERSION) {
      throw new Error("unsupported user manager version");
    }

    const launcher = await run("systemd-run", ["--version"], options);
    const launcherMajor = majorVersion(launcher.stdout);
    if (launcherMajor === null || launcherMajor < MINIMUM_SYSTEMD_VERSION) {
      throw new Error("unsupported systemd-run version");
    }
  } catch {
    throw new Error(releasePreflightDiagnostic);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyReleasePreflight()
    .then(() => {
      process.stdout.write("release preflight: systemd user transport available\n");
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
