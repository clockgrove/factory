/**
 * Read-only inspector.
 *
 *   node dist/factory.js <owner>/<repo> <objective-number>
 *
 * Prints the derived state of an Objective and exits. It performs no writes,
 * which makes it safe to point at a live repository, and it is the smallest
 * thing that proves §1: state is a pure function of GitHub.
 */

import { GitHubReader } from "./github.js";
import { resolveGitHubToken } from "./auth.js";
import { allDone, counts, derive, isStalled, ready } from "./state.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const [slug, rawNumber] = argv;
  if (!slug || !rawNumber) {
    fail("usage: factory <owner>/<repo> <objective-number>");
  }

  const [owner, repo] = slug.split("/");
  const number = Number(rawNumber);
  if (!owner || !repo || !Number.isInteger(number)) {
    fail(`bad arguments: ${slug} ${rawNumber}`);
  }

  let token: string;
  try {
    token = resolveGitHubToken();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const reader = new GitHubReader({
    token,
    owner,
    repo,
    onThrottle: (m) => process.stderr.write(`[throttle] ${m}\n`),
  });

  const objective = derive(await reader.readObjective(number));

  process.stdout.write(`\n#${objective.number} ${objective.title}\n`);
  process.stdout.write(`read at ${objective.readAt.toISOString()}\n\n`);

  if (objective.items.length === 0) {
    process.stdout.write("  (no work items)\n");
  }

  for (const item of objective.items) {
    const blockers = item.blockedBy
      .filter((d) => !d.closed)
      .map((d) => `#${d.number}`);
    const notes = [
      item.attempts > 0 ? `${item.attempts} attempt(s)` : null,
      blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : null,
    ].filter(Boolean);

    process.stdout.write(
      `  ${item.state.padEnd(11)} #${item.number} ${item.title}` +
        (notes.length > 0 ? `  [${notes.join("; ")}]` : "") +
        "\n",
    );
  }

  const c = counts(objective);
  const summary = Object.entries(c)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");

  process.stdout.write(`\n${summary || "empty"}\n`);
  process.stdout.write(
    `ready=${ready(objective).length} stalled=${isStalled(objective)} ` +
      `allDone=${allDone(objective)}\n`,
  );
}

await main(process.argv.slice(2));
