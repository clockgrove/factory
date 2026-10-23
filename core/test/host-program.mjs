// The library check in package.test.mjs: a host program that registers its
// own planner and worker as a kind, runs them through the configuration
// that names it, and reads the analysis of the run log they wrote.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeInteractions,
  loadConfig,
  loggedCall,
  providerPlanner,
  providerWorker,
  readInteractionMetadata,
  registerKind,
} from "@clockgrove/factory";

const [logModule, repository] = process.argv.slice(2);
registerKind({
  name: "host:echo",
  planner: (models) => ({
    answer: (call) =>
      loggedCall("host:echo", call, models.planner, async () => ({
        value: { echo: call.prompt },
        model: models.planner.model,
        effort: models.planner.effort,
      })),
  }),
  worker: (settings) => ({
    run: async () => ({ kind: "finished", finalResponse: settings.greeting }),
  }),
  check: (settings) =>
    typeof settings.greeting === "string" ? [] : ["greeting must be text"],
});
const config = loadConfig(repository);
const provider = config.providers[config.defaultProvider];
// The service's run log writer stands in for a served run.
const { RunLog } = await import(pathToFileURL(logModule).href);
const logs = join(
  process.env.FACTORY_STATE_DIR,
  repository.replace("/", "__"),
  "logs",
);
const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1");
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
const report = analyzeInteractions(repository, 7, { groupBy: ["provider"] });
process.stdout.write(
  JSON.stringify({
    answer: answer.value,
    worked: worked.finalResponse,
    calls: readInteractionMetadata(repository, 7).map((c) => [
      c.provider,
      c.outcome,
    ]),
    grouped: report.groups.map((g) => [g.key, g.usage.calls]),
    ends: report.history.runs.map((run) => run.end),
  }),
);
