// One local loop in a process of its own, for the machine-budget tests: the real serve and dispatcher (local.mjs) for
// repository LOOP_REPO against the test's fake GitHub (GITHUB_API_URL), its HOME the test's, its machine load read from
// LOOP_PROC. Each stage it starts prints `started <repo>#<n>` and holds its slot until the process ends.
import { Local } from "../../scripts/local.mjs";

const [owner, name] = process.env.LOOP_REPO.split("/");
process.env.FACTORY_LOCAL = "1";
process.env.FACTORY_LOCAL_ALL = "1";
const loop = Object.assign(Object.create(Local.prototype), {
  repo: { owner, name, full: `${owner}/${name}` },
  repoFull: `${owner}/${name}`,
  token: "t",
  notice: null,
  wf: {},
  opts: { token: "t" },
  children: new Set(),
  machine: { home: process.env.HOME, proc: process.env.LOOP_PROC },
  baseEnv: () => ({ FACTORY_LOCAL_ALL: "1", FACTORY_INPUT_MAX_CONCURRENT: "9" }),
  cleanup: async () => {},
  pausedHere: async () => [],
  pendingReviews: async () => [],
  runObjective: (n) => {
    process.stdout.write(`started ${owner}/${name}#${n}\n`);
    return new Promise(() => {});
  },
});
await loop.serve({ intervalMs: Number(process.env.LOOP_INTERVAL_MS || 100) });
