/** Opt-in fresh npm/plugin installs plus installed Linux host component checks. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationEnvironment } from "./qualify-linux-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const verifierTimeoutMs = 15 * 60_000;

export function runBoundedVerifier(
  command,
  args,
  { cwd = root, env = qualificationEnvironment(), timeoutMs = verifierTimeoutMs } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > verifierTimeoutMs)
    throw new Error("invalid verifier timeout");
  return new Promise((done) => {
    let settled = false;
    let timedOut = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const finish = (passed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      done(passed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The exact child process group already exited.
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The exact child process group already exited.
        }
      }, 5_000);
    }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(!timedOut && code === 0));
  });
}

export function assessPortableQualification(artifacts) {
  const npm = artifacts.find((entry) => entry.artifactKind === "npm");
  const plugin = artifacts.find((entry) => entry.artifactKind === "plugin");
  const sameArtifacts =
    npm?.artifact &&
    plugin?.artifact &&
    JSON.stringify(npm.artifact) === JSON.stringify(plugin.artifact);
  return {
    protocol: "clockgrove.factory/portable-qualification-suite-v1",
    observedAt: new Date().toISOString(),
    result:
      artifacts.some((entry) => entry.result === "failed") ||
      (npm?.artifact && plugin?.artifact && !sameArtifacts)
        ? "failed"
        : artifacts.length === 2 &&
            sameArtifacts &&
            artifacts.every((entry) => entry.result === "passed")
          ? "passed"
          : "incomplete",
    scope: "fresh-staged-installs-and-no-model-linux-host-components",
    artifactVersionsAndBundlesAgree: Boolean(sameArtifacts),
    fullFactoryHostMatrix: "open",
    publishedDistribution: "unverified",
    artifacts,
  };
}

async function verify(script, output, claimedHost) {
  const env = {
    ...qualificationEnvironment(),
    FACTORY_QUALIFY_LINUX_HOST: "1",
    FACTORY_QUALIFICATION_OUTPUT: output,
    FACTORY_QUALIFICATION_HOST: claimedHost,
    // These are operator-selected executable/cache paths, never model or provider authority.
    ...(process.env.FACTORY_CODEX_COMMAND
      ? { FACTORY_CODEX_COMMAND: process.env.FACTORY_CODEX_COMMAND }
      : {}),
    ...(process.env.FACTORY_NPM_CACHE ? { FACTORY_NPM_CACHE: process.env.FACTORY_NPM_CACHE } : {}),
  };
  return runBoundedVerifier(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    env,
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    process.stdout.write(
      "node scripts/verify-portable-qualification.mjs --output /absolute/evidence.json [--host-class auto|native-linux|wsl2|macos-linux-guest]\nCreates disposable local services; runs no models, cloud workers, or GitHub writes.\n",
    );
    return;
  }
  const allowed = new Set(["--output", "--host-class"]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || options[args[index]] !== undefined)
      throw new Error("invalid portable qualification arguments");
    options[args[index]] = args[index + 1];
  }
  if (!options["--output"] || !options["--output"].endsWith(".json"))
    throw new Error("--output JSON path required");
  const claimedHost = options["--host-class"] ?? "auto";
  if (!["auto", "native-linux", "wsl2", "macos-linux-guest"].includes(claimedHost))
    throw new Error("invalid host class");
  const output = resolve(options["--output"]);
  // Reserve exclusively before any installs or service mutations; never overwrite prior evidence.
  const { open } = await import("node:fs/promises");
  const reserved = await open(output, "wx", 0o600);
  await reserved.close();
  if (platform() !== "linux") {
    const report = {
      ...assessPortableQualification([]),
      result: "unsupported",
      host: { platform: platform(), reason: "native-platform-unsupported" },
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ result: "unsupported", scope: report.scope })}\n`);
    process.exitCode = 2;
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "factory-portable-qualification-"));
  const artifacts = [];
  try {
    for (const [artifactKind, script] of [
      ["npm", "verify-npm-package.mjs"],
      ["plugin", "verify-plugin-install.mjs"],
    ]) {
      const path = join(temporary, `${artifactKind}.json`);
      const passed = await verify(script, path, claimedHost);
      const bytes = await readFile(path).catch(() => null);
      if (bytes) {
        const evidence = JSON.parse(bytes.toString("utf8"));
        artifacts.push({
          ...evidence,
          installationCheckPassed: passed,
          evidenceSha256: sha256(bytes),
          ...(!passed ? { result: "failed" } : {}),
        });
      } else
        artifacts.push({
          artifactKind,
          result: "failed",
          reason: "installation-check-failed-before-host-evidence",
        });
    }
    const report = assessPortableQualification(artifacts);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ result: report.result, scope: report.scope, fullFactoryHostMatrix: "open" })}\n`,
    );
    process.exitCode = report.result === "passed" ? 0 : report.result === "failed" ? 1 : 2;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(() => {
    process.stderr.write(
      "Portable qualification could not complete; no raw command output is disclosed.\n",
    );
    process.exitCode = 1;
  });
