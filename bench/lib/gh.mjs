// GitHub REST through `gh api`, with whatever `gh` is logged in as (or
// GH_TOKEN). Claude's cloud blocks GraphQL, so the scorecard is REST only
// (RESEARCH.md). Every read goes through `api(path)`, which score.mjs swaps
// for a snapshot reader offline, so nothing here is needed to run a test.
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];

/** One REST GET, parsed. With `paginate`, every page, flattened. Throws with the HTTP status on failure. */
export async function ghApi(path, { paginate = false, token } = {}) {
  const args = ["api", path, ...HEADERS];
  if (paginate) args.push("--paginate", "--slurp");
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  try {
    const { stdout } = await run("gh", args, { env, maxBuffer: 256 * 1024 * 1024 });
    const text = stdout.trim();
    if (!text) return paginate ? [] : null;
    const value = JSON.parse(text);
    if (!paginate) return value;
    // --slurp wraps each page; an endpoint that wraps its list ({total_count, artifacts}) stays wrapped per page.
    return Array.isArray(value) ? value.flatMap((page) => (Array.isArray(page) ? page : [page])) : [value];
  } catch (error) {
    const text = String(error.stderr || error.message || "");
    const status = Number(/HTTP (\d{3})/.exec(text)?.[1]) || 0;
    const e = new Error(`gh api ${path} failed${status ? ` (${status})` : ""}: ${text.trim().slice(0, 300)}`);
    e.status = status;
    throw e;
  }
}

/**
 * An Actions artifact's files, unpacked into a new temporary directory by
 * `gh run download` (so nothing beyond gh is needed); returns the directory.
 * `artifact` carries its `name` and `workflow_run` (the run id, or the API's
 * `{ id }` object). Needs a token with `actions: read` on the repository.
 */
export async function downloadArtifact(repoFull, artifact, { token } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-"));
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const runId = artifact.workflow_run?.id ?? artifact.workflow_run;
  await run("gh", ["run", "download", String(runId), "-n", artifact.name, "-D", dir, "-R", repoFull], { env, maxBuffer: 64 * 1024 * 1024 });
  return dir;
}

/** The first `name` found under `dir`, walking subdirectories; null when none. */
export function findFile(dir, name) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  if (entries.includes(name) && statSync(join(dir, name)).isFile()) return join(dir, name);
  for (const entry of entries) {
    const sub = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      // unreadable: skip
    }
    if (!isDir) continue;
    const found = findFile(sub, name);
    if (found) return found;
  }
  return null;
}

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** One GraphQL query through `gh api graphql`; throws where GraphQL is blocked (Claude's cloud). */
export async function ghGraphql(query, variables = {}, { token } = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const { stdout } = await run("gh", args, { env, maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; "));
  return data.data;
}
