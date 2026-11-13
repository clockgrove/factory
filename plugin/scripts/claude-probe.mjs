#!/usr/bin/env node
// Local mode's Claude Code confinement probe, inside the harness's outer sandbox (srt) where there is one, whose loopback
// the host's is not: the probe's model (lib/claude-local-probe.mjs anthropicProbeModel) on that loopback, and the
// command after it started with the model's variables. Exits with the command's code; its last stderr line is
// {"said": ...}, what Claude Code answered for the probe's call (for the log only).
//   node scripts/claude-probe.mjs <cmd> [args...]
import { spawn } from "node:child_process";
import { anthropicProbeModel } from "./lib/claude-local-probe.mjs";

const [cmd, ...args] = process.argv.slice(2);
const model = await anthropicProbeModel();
const child = spawn(cmd, args, { env: { ...process.env, ...model.env }, stdio: "inherit" });
const code = await new Promise((done) => {
  child.on("error", () => done(127));
  child.on("exit", (c, sig) => done(c ?? (sig ? 128 : 1)));
});
await model.close();
process.stderr.write(`\n${JSON.stringify({ said: model.toolOutput() })}\n`);
process.exit(code);
