// The library check in package.test.mjs: a host program that registers its
// own planner and worker as a kind, runs them through the configuration
// that names it, reads the analysis of the run log they wrote, and serves
// the installation in its own process until it aborts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeInteractions,
  captureResponse,
  loadConfig,
  loggedCall,
  providerPlanner,
  providerWorker,
  readInteractionContent,
  readInteractionMetadata,
  registerKind,
  serveFactory,
} from "@clockgrove/factory";

const [logModule, repository] = process.argv.slice(2);
registerKind({
  name: "host:echo",
  planner: (models) => ({
    answer: (call) =>
      loggedCall("host:echo", call, models.planner, async (record) => {
        captureResponse(record, "echoed");
        return { value: { echo: call.prompt }, ...models.planner };
      }),
  }),
  worker: (settings) => ({
    run: async () => ({ kind: "finished", finalResponse: settings.greeting }),
  }),
  check: ({ worker }) =>
    !worker || typeof worker.greeting === "string" ? [] : ["greeting: text"],
});
const config = loadConfig(repository);
const provider = config.providers[config.defaultProvider];
// The service's run log writer stands in for a served run.
const { RunLog } = await import(pathToFileURL(logModule).href);
const logs = join(process.env.FACTORY_STATE_DIR, "example__target", "logs");
const capture = { enabled: true, maxBytesPerCall: 1 << 20 };
const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", capture);
const answer = await providerPlanner(provider).answer({
  role: "planner",
  phase: "plan",
  prompt: "hello",
  schema: { type: "object" },
  signal: AbortSignal.timeout(5000),
  log: (event) => log.write(7, event),
});
log.end(() => "stopped");
const worked = await providerWorker(provider, config)({}, []).run({});
const [call] = readInteractionMetadata(repository, 7);
const report = analyzeInteractions(repository, 7, { groupBy: ["provider"] });

// Served here, a second service in this process is refused; an abort
// returns only once the run has ended and released the lock, so the next
// one starts cleanly.
const served = [];
for (const round of [1, 2]) {
  const stop = new AbortController();
  const serving = serveFactory({ repository, signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (round === 1)
    served.push(await serveFactory({ repository }).catch((e) => e.code));
  stop.abort();
  served.push(await serving);
}
const [first] = readdirSync(join(logs, "0"))
  .filter((name) => name.endsWith(".jsonl"))
  .sort();
const events = readFileSync(join(logs, "0", first), "utf8")
  .trim()
  .split("\n");
process.stdout.write(
  JSON.stringify({
    answer: answer.value,
    worked: worked.finalResponse,
    call: [call.provider, call.outcome],
    content: readInteractionContent(repository, 7, call),
    grouped: report.groups.map((g) => [g.key, g.usage.calls]),
    served,
    ended: events.slice(-2).map((line) => JSON.parse(line).event),
  }),
);
