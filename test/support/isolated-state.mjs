// Loaded with `node --import` for every test process. Tests never touch the
// operator's real Factory configuration or state: each process gets its own
// temporary XDG directories, removed on exit. Tests that need a specific
// directory still set these variables themselves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-test-home-"));
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
