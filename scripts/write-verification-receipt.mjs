import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createVerificationReceipt, writeVerificationReceipt } from "./verification-receipt.mjs";

export function parseReceiptArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !new Set(["--gate", "--command", "--output", "--expected-commit"]).has(key)) {
      throw new Error(`invalid verification receipt argument: ${key ?? "missing"}`);
    }
    values[key.slice(2)] = value;
  }
  for (const required of ["gate", "command", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseReceiptArguments(argv);
  const now = new Date().toISOString();
  const receipt = await createVerificationReceipt({
    gate: values.gate,
    command: values.command,
    startedAt: process.env.FACTORY_VERIFICATION_STARTED_AT ?? now,
    expectedCommit: values["expected-commit"] ?? process.env.GITHUB_SHA,
  });
  const destination = await writeVerificationReceipt(receipt, values.output);
  process.stdout.write(`${destination}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
