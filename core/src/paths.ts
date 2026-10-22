import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where one installation keeps its files. Nothing here is inside the target. */
export interface Paths {
  readonly root: string;
  readonly objectives: string;
  readonly requests: string;
  readonly logs: string;
  /** Linux abstract socket name: the kernel frees it when the process dies. */
  readonly lockName: string;
}

export function installationPaths(
  repository: string,
  stateRoot = process.env.FACTORY_STATE_DIR ??
    join(homedir(), ".local", "state", "factory"),
): Paths {
  const root = join(stateRoot, repository.replace("/", "__"));
  const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return {
    root,
    objectives: join(root, "objectives"),
    requests: join(root, "requests"),
    logs: join(root, "logs"),
    lockName: `\0factory-${id}`,
  };
}
