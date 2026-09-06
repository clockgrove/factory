import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const moduleBytes = () => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL("../assets/answer.wasm", import.meta.url), moduleBytes());
}
