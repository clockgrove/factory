import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createVerificationReceipt,
  sourceIdentity,
  writeVerificationReceipt,
} from "./verification-receipt.mjs";

export const candidateCommands = Object.freeze([
  [process.execPath, ["scripts/verify-release-preflight.mjs"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "format:check"]],
  ["npm", ["run", "test:coverage"]],
  ["npm", ["run", "verify:schemas"]],
  ["npm", ["run", "verify:dist"]],
  ["npm", ["run", "verify:package"]],
  ["npm", ["run", "verify:npm"]],
  ["npm", ["audit"]],
]);

function parseArguments(argv) {
  if (argv.length === 0) return { output: "release/evidence/candidate-deterministic.json" };
  if (argv.length === 2 && argv[0] === "--output" && argv[1]) return { output: argv[1] };
  throw new Error("verify:candidate accepts only --output <path>");
}

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
  const status = await new Promise((settle, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  if (status.code !== 0) {
    const detail = status.signal ? `signal ${status.signal}` : `exit ${status.code}`;
    throw new Error(`${command} ${args.join(" ")} failed (${detail})`);
  }
}

export async function verifyCandidate({ argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const { output } = parseArguments(argv);
  const startedAt = new Date().toISOString();
  const initial = await sourceIdentity(cwd);
  if (!initial.clean) throw new Error("verify:candidate requires a clean committed working tree");
  for (const [command, args] of candidateCommands) await run(command, args, cwd);
  const final = await sourceIdentity(cwd);
  if (!final.clean || final.commit !== initial.commit || final.tree !== initial.tree) {
    throw new Error(
      "candidate source changed during verification; discard this candidate evidence",
    );
  }
  const receipt = await createVerificationReceipt({
    gate: "verify:candidate",
    command: "npm run verify:candidate",
    startedAt,
    cwd,
    expectedCommit: initial.commit,
  });
  const destination = await writeVerificationReceipt(receipt, resolve(cwd, output));
  process.stdout.write(`candidate verification passed ${initial.commit}\nreceipt ${destination}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyCandidate().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
