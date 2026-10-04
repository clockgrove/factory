// One judge panel call, started by gradeInIsolation in its own process. Its
// working directory is an empty Git repository and CODEX_HOME holds only the
// operator's login, so no judge sees run artifacts, the target checkout, or
// the operator's own provider configuration and instructions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  judgeTransport,
  loadJudges,
  runJudge,
} from "./eval-planning/judge.mjs";

const requestPath = process.argv[2];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const judges = loadJudges(request.judges);
const grades = await Promise.all(
  judges.map(async (judge) => {
    try {
      return await runJudge(
        judge,
        request.input,
        await judgeTransport(judge, process.cwd(), request.module),
      );
    } catch (error) {
      return {
        judge: judge.name,
        digest: judge.digest,
        verdict: "error",
        error: error instanceof Error ? error.message : String(error),
        tokens: null,
        wallMs: 0,
      };
    }
  }),
);
writeFileSync(
  join(requestPath, "..", "response.json"),
  `${JSON.stringify(grades)}\n`,
);
