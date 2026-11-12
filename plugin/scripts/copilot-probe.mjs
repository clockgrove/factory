#!/usr/bin/env node
// Local mode's Copilot confinement probe, inside the harness's outer sandbox (srt), whose loopback the host's is not:
// the probe's model (lib/copilot-runner.mjs probeModel) on that loopback, and the command after it started with the
// model's provider variables. Exits with the command's code; its last stderr line is {"said": ...}, what Copilot
// answered for the probe's call (for the log only).
//   node scripts/copilot-probe.mjs <cmd> [args...]
import { spawn } from "node:child_process";
import { probeModel } from "./lib/copilot-runner.mjs";

const [cmd, ...args] = process.argv.slice(2);
const model = await probeModel();
const child = spawn(cmd, args, { env: { ...process.env, ...model.env }, stdio: "inherit" });
const code = await new Promise((done) => {
  child.on("error", () => done(127));
  child.on("exit", (c, sig) => done(c ?? (sig ? 128 : 1)));
});
await model.close();
process.stderr.write(`\n${JSON.stringify({ said: model.toolOutput() })}\n`);
process.exit(code);
