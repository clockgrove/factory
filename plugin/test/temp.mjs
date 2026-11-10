// Every test file imports this first. The file's process then keeps all its temp files, the code under test's and the
// processes it starts included, under one directory of its own in the system temp folder, removed when the process
// exits (a failed test or an uncaught throw included). One a killed run left is cleared by a later run.
import { tmpdir } from "node:os";
import { dropOwned, ownedTemp, sweepOwned } from "../scripts/lib/fsafe.mjs";

const base = tmpdir();
sweepOwned(base, /^factory-test-[A-Za-z0-9]{6}$/);
const root = ownedTemp(base, "factory-test-");
process.env.TMPDIR = root;
process.on("exit", () => dropOwned(root, { unlock: true }));
