// Preloaded into `factory serve` (node --import): the process sends itself
// SIGTERM as the service makes STOP_AT_MKDIR, its objectives directory,
// right after it takes its lock and before its loop starts. So a test stops
// the service exactly where `status` first says it is running.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const mkdirSync = fs.mkdirSync;
let sent = false;
fs.mkdirSync = (path, ...rest) => {
  const made = mkdirSync(path, ...rest);
  if (!sent && String(path) === process.env.STOP_AT_MKDIR) {
    sent = true;
    process.kill(process.pid, "SIGTERM");
  }
  return made;
};
syncBuiltinESMExports();
