import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export function renderStatus(state) {
  if (state !== "ready") throw new Error("unsupported status");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48" role="img"><title>Ready status</title><rect width="160" height="48" rx="8" fill="#eef6ef"/><path d="M12 24l5 5 10-12" fill="none" stroke="#226633" stroke-width="3"/><text x="40" y="30" font-size="18" fill="#163321">Ready</text></svg>\n';
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL("../visual/status.svg", import.meta.url), renderStatus("ready"));
}
