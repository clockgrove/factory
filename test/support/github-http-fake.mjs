// A strict in-process GitHub: the subset of the REST API (version 2026-03-10)
// and Git smart-HTTP transport that Factory's real gateway calls, backed by a
// real bare Git repository. Factory's own GitHubClient, RealGitHubGateway,
// NativeStackDelivery and RegularDelivery run unchanged against it, so a
// duplicate issue, PR or merge is visible in the request log instead of being
// absorbed by an idempotent fake.
//
// Strict like GitHub:
// - POST /pulls for a head that already has an open PR into the same base is
//   422 "A pull request already exists"; a missing head or base is 422.
// - PUT /pulls/{n}/merge on a merged or closed PR is 405; a stale head sha is
//   409; a disallowed merge method is 405. Pull responses omit
//   merge_commit_sha (removed in 2026-03-10); the merge commit is only on the
//   issue timeline's `merged` event.
// - PUT /pulls/{n}/merge-async (documented for 2026-03-10): 202 pending with
//   a uuid; 200 merged with details.sha for a merged PR; 400 for a closed or
//   draft PR; 409 with the pending request's uuid and options while a merge
//   is pending. A stacked PR merges with every open PR below it. Stacks list
//   with id, node_id, number, open and base; creating one with a nonexistent
//   PR is 422.
// - Lists paginate (per_page default 30, max 100) with Link headers, and the
//   issues list includes pull requests. A 422 carries one errors entry.
// - Every REST response carries x-ratelimit-* headers.
// - Unknown routes are 404 and recorded as `unhandled`.
//
// Modes: read-after-write lag per endpoint, fault rules on the Nth matching
// request (5xx, 429 and 403 rate limits with or without retry-after, a
// dropped response after the effect, a reset before it, a controller crash
// before or after the effect, another actor changing the repository), and a
// per-request log.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const API = "https://api.github.com";

/** Every REST route the fake serves, as recorded in the request log. */
const ROUTES = [
  ["GET", "", "getRepository"],
  ["GET", "/issues", "listIssues"],
  ["POST", "/issues", "createIssue"],
  ["GET", "/issues/:number", "getIssue"],
  ["PATCH", "/issues/:number", "updateIssue"],
  ["GET", "/issues/:number/comments", "listComments"],
  ["POST", "/issues/:number/comments", "createComment"],
  ["POST", "/issues/:number/labels", "addLabels"],
  ["GET", "/issues/:number/timeline", "timeline"],
  ["GET", "/issues/:number/dependencies/blocked_by", "listBlockedBy"],
  ["POST", "/issues/:number/dependencies/blocked_by", "addBlockedBy"],
  [
    "DELETE",
    "/issues/:number/dependencies/blocked_by/:issue_id",
    "removeBlockedBy",
  ],
  ["GET", "/issues/:number/sub_issues", "listSubIssues"],
  ["POST", "/issues/:number/sub_issues", "addSubIssue"],
  ["GET", "/issues/:number/parent", "getParent"],
  ["GET", "/labels", "listLabels"],
  ["POST", "/labels", "createLabel"],
  ["GET", "/pulls", "listPulls"],
  ["POST", "/pulls", "createPull"],
  ["GET", "/pulls/:number", "getPull"],
  ["PUT", "/pulls/:number/merge", "mergePull"],
  ["PUT", "/pulls/:number/merge-async", "mergeAsync"],
  ["GET", "/pulls/:number/merge-async/:uuid", "mergeAsyncStatus"],
  ["GET", "/commits/:sha/check-runs", "checkRuns"],
  ["GET", "/commits/:sha/status", "combinedStatus"],
  ["GET", "/stacks", "listStacks"],
  ["POST", "/stacks", "createStack"],
].map(([method, pattern, handler]) => ({
  method,
  handler,
  endpoint: `${method} /repos/{owner}/{repo}${pattern.replace(/:([a-z_]+)/g, "{$1}")}`,
  regex: new RegExp(
    `^${pattern.replace(/:([a-z_]+)/g, (_, name) => `(?<${name}>[^/]+)`)}$`,
  ),
}));

/** Endpoint names as they appear in the request log. */
export const ENDPOINTS = [
  ...ROUTES.map((route) => route.endpoint),
  "GET /user",
  "POST /graphql",
  "GIT fetch-advertise",
  "GIT fetch",
  "GIT push-advertise",
  "GIT push",
];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** GitHub sends the primary rate-limit headers on every REST response. */
function rateHeaders() {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-resource": "core",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  };
}

/** GitHub's 422 shape: one errors entry carrying the reason. */
const validation = (message, fields = {}) =>
  new HttpError(422, "Validation Failed", {
    errors: [{ ...fields, message }],
  });

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "GitHub",
    GIT_AUTHOR_EMAIL: "noreply@github.com",
    GIT_COMMITTER_NAME: "GitHub",
    GIT_COMMITTER_EMAIL: "noreply@github.com",
  };
}

async function git(repository, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    env: gitEnvironment(),
    encoding: "utf8",
  });
  return stdout.trim();
}

/** Exit status and output, without throwing for a non-zero status. */
async function gitStatus(repository, ...args) {
  try {
    return { status: 0, stdout: await git(repository, ...args) };
  } catch (error) {
    return { status: error.code ?? 1, stdout: String(error.stdout ?? "") };
  }
}

let wrapperDirectory;
/**
 * Environment for a controller process whose `git` transport to
 * https://github.com/ must reach this fake. Only transport subcommands are
 * rewritten, so `git remote get-url` still reports the GitHub URL Factory
 * validates. The wrapper keys on a non-GIT_ variable because Factory strips
 * GIT_* for pinned Git calls.
 */
export function gitTransportEnvironment(gitUrl, env = process.env) {
  if (!wrapperDirectory) {
    wrapperDirectory = mkdtempSync(join(tmpdir(), "factory-http-git-"));
    const realGit = env.PATH.split(":")
      .filter((directory) => directory.startsWith("/"))
      .map((directory) => join(directory, "git"))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (!realGit) throw new Error("git is not on PATH");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const script = join(wrapperDirectory, "git");
    writeFileSync(
      script,
      `#!/bin/sh
if [ -n "$FACTORY_FAKE_GITHUB_GIT" ]; then
  for argument in "$@"; do
    case "$argument" in
      push|fetch|clone|pull|ls-remote|checkout) exec ${quote(realGit)} -c "url.$FACTORY_FAKE_GITHUB_GIT.insteadOf=https://github.com/" "$@" ;;
    esac
  done
fi
exec ${quote(realGit)} "$@"
`,
    );
    chmodSync(script, 0o755);
    process.on("exit", () =>
      rmSync(wrapperDirectory, { recursive: true, force: true }),
    );
  }
  return {
    PATH: `${wrapperDirectory}:${env.PATH}`,
    FACTORY_FAKE_GITHUB_GIT: gitUrl,
  };
}

/** An Octokit `fetch` that sends Factory's api.github.com requests here. */
export function rewritingFetch(apiUrl) {
  return (url, init) =>
    fetch(String(url).replace(/^https:\/\/api\.github\.com/, apiUrl), init);
}

export class GitHubHttpFake {
  /**
   * @param {object} options
   * @param {string} options.repository owner/name
   * @param {string} options.origin path of the bare Git repository
   * @param {{title: string, body: string, labels?: string[]}[]} [options.issues]
   *   issues created first, numbered from 1 (e.g. the Objective)
   * @param {{read: string, after?: string, reads: number}[]} [options.lag]
   *   after each write (to `after`, or any endpoint), the next `reads` reads
   *   of the `read` endpoint still see the state before that write
   * @param {(sha: string) => object[]} [options.checkRuns]
   * @param {(sha: string) => object} [options.statuses]
   * @param {number} [options.readinessUnknownReads] readiness reads per PR
   *   that report UNKNOWN before GitHub computes mergeability
   * @param {number} [options.asyncMergePolls] merge-async status polls before
   *   the merge lands (0: lands with the PUT, reported on the first poll)
   * @param {string[]} [options.mergeMethods]
   * @param {(entry: object) => void} [options.onCrash] kills the controller
   */
  constructor(options) {
    this.repository = options.repository;
    [this.owner, this.name] = options.repository.split("/");
    this.origin = options.origin;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.options = options;
    this.lag = (options.lag ?? []).map((rule) => ({ ...rule, served: 0 }));
    this.onCrash = options.onCrash;
    this.rules = [];
    this.log = [];
    this.writes = [];
    this.queue = Promise.resolve();
    this.state = {
      nextNumber: 1,
      nextId: 1000,
      nextStack: 1,
      clock: Date.parse("2026-01-01T00:00:00Z"),
      labels: [],
      issues: {},
      pulls: {},
      comments: {},
      timeline: {},
      blockedBy: {},
      parent: {},
      children: {},
      stacks: [],
      jobs: {},
      readinessReads: {},
    };
    for (const issue of options.issues ?? [])
      this.createIssueRecord(this.state, issue);
  }

  // ---- lifecycle -------------------------------------------------------

  async start() {
    this.server = createServer((request, response) =>
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: String(error.stack) }));
        }
      }),
    );
    this.sockets = new Set();
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    // Never close an idle keep-alive connection during a scenario: a client
    // reusing a socket the server is closing sees a reset, an unintended
    // fault on a loaded machine. Faults are only what a test injects.
    this.server.keepAliveTimeout = 10 * 60_000;
    this.server.headersTimeout = 10 * 60_000 + 1000;
    this.server.requestTimeout = 0;
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.apiUrl = `http://127.0.0.1:${port}`;
    this.gitUrl = `http://127.0.0.1:${port}/git/`;
    return this;
  }

  async stop() {
    for (const socket of this.sockets ?? []) socket.destroy();
    await new Promise((resolve) => this.server?.close(resolve) ?? resolve());
  }

  // ---- faults and observation ------------------------------------------

  /**
   * Apply `kind` to the `occurrence`-th request matching `match` (an endpoint
   * name, a RegExp over `METHOD path`, or a predicate over the log entry) and
   * to the `times - 1` matching requests after it.
   * Kinds: status (respond `status` with `headers`/`message`, no effect),
   * reset (close the connection before the effect), drop (apply the effect,
   * then close the connection), crash-before, crash-after (onCrash then close),
   * after (respond normally once `run(fake, entry)` has changed the repository).
   */
  inject(rule) {
    const value = { occurrence: 1, times: 1, seen: 0, fired: 0, ...rule };
    this.rules.push(value);
    return value;
  }

  /** Request log entries for an endpoint, optionally only those with `status`. */
  requests(endpoint, { status } = {}) {
    return this.log.filter(
      (entry) =>
        (endpoint === undefined || entry.endpoint === endpoint) &&
        (status === undefined ||
          (typeof status === "function"
            ? status(entry.status)
            : entry.status === status)),
    );
  }

  /** Mutations GitHub applied (whether or not the caller saw the response). */
  effects(endpoint) {
    return this.log.filter(
      (entry) => entry.endpoint === endpoint && entry.effect,
    );
  }

  counts() {
    const counts = {};
    for (const entry of this.log) {
      const key = `${entry.endpoint} → ${entry.status}${entry.fault ? ` (${entry.fault})` : ""}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  issuesWithMarker(marker) {
    return Object.values(this.state.issues).filter(
      (issue) => !issue.pull && (issue.body ?? "").includes(marker),
    );
  }

  pullsForBranch(branch) {
    return Object.values(this.state.pulls).filter(
      (pull) => pull.head.ref === branch,
    );
  }

  issue(number) {
    return this.state.issues[number];
  }

  /** Another actor pushes an empty commit to `branch` (default branch). */
  async pushForeignCommit(branch = this.defaultBranch) {
    const head = await git(this.origin, "rev-parse", `refs/heads/${branch}`);
    const commit = await git(
      this.origin,
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      head,
      "-m",
      "Unrelated change by another contributor",
    );
    await git(this.origin, "update-ref", `refs/heads/${branch}`, commit, head);
    return commit;
  }

  /** Another actor force-pushes the default branch back to its first parent. */
  async rewindDefaultBranch() {
    const head = await git(
      this.origin,
      "rev-parse",
      `refs/heads/${this.defaultBranch}`,
    );
    const parent = await git(this.origin, "rev-parse", `${head}^1`);
    await git(
      this.origin,
      "update-ref",
      `refs/heads/${this.defaultBranch}`,
      parent,
      head,
    );
    return parent;
  }

  /** Another actor opens an issue. */
  openForeignIssue(title = "Unrelated issue", body = "Not a Factory issue") {
    return this.createIssueRecord(this.state, { title, body });
  }

  commentsOn(number) {
    return this.state.comments[number] ?? [];
  }

  // ---- HTTP ------------------------------------------------------------

  async handle(request, response) {
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
    const url = new URL(request.url, "http://fake");
    if (url.pathname.startsWith("/git/"))
      return this.handleGit(request, response, url, body);
    // GitHub serializes nothing for us, but one-at-a-time keeps the log and
    // the read-after-write model exact. Factory's client queues requests too.
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      await this.handleApi(request, response, url, body);
    } finally {
      release();
    }
  }

  /** Every rule counts every request it matches; the first due rule fires. */
  matchRules(entry) {
    let fired;
    for (const rule of this.rules) {
      const matches =
        typeof rule.match === "function"
          ? rule.match(entry)
          : rule.match instanceof RegExp
            ? rule.match.test(`${entry.method} ${entry.path}`)
            : rule.match === entry.endpoint;
      if (!matches) continue;
      rule.seen++;
      if (
        !fired &&
        rule.seen >= rule.occurrence &&
        rule.seen < rule.occurrence + rule.times
      ) {
        rule.fired++;
        fired = rule;
      }
    }
    return fired;
  }

  /** Respond, close, or crash according to a fired rule. Returns true when done. */
  preEffect(rule, entry, response) {
    if (!rule) return false;
    entry.fault = rule.kind;
    if (rule.kind === "status") {
      entry.status = rule.status;
      const headers = {
        "content-type": "application/json",
        ...rateHeaders(),
        ...(rule.headers?.() ?? {}),
      };
      response.writeHead(rule.status, headers);
      response.end(
        JSON.stringify({
          message: rule.message ?? `Injected HTTP ${rule.status}`,
          documentation_url: "https://docs.github.com/rest",
        }),
      );
      return true;
    }
    if (rule.kind === "reset") {
      entry.status = "reset";
      response.socket?.destroy();
      return true;
    }
    if (rule.kind === "crash-before") {
      entry.status = "crash";
      this.onCrash?.(entry);
      response.socket?.destroy();
      return true;
    }
    return false;
  }

  postEffect(rule, entry, response) {
    if (!rule || !["drop", "crash-after"].includes(rule.kind)) return false;
    entry.status = rule.kind === "drop" ? "dropped" : "crash";
    if (rule.kind === "crash-after") this.onCrash?.(entry);
    response.socket?.destroy();
    return true;
  }

  route(method, path) {
    if (path === "/graphql")
      return method === "POST"
        ? { endpoint: "POST /graphql", handler: "graphql", params: {} }
        : undefined;
    if (path === "/user")
      return method === "GET"
        ? { endpoint: "GET /user", handler: "viewer", params: {} }
        : undefined;
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return undefined;
    if (
      match[1].toLowerCase() !== this.owner.toLowerCase() ||
      match[2].toLowerCase() !== this.name.toLowerCase()
    )
      return undefined;
    const rest = match[3] ?? "";
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const found = route.regex.exec(rest);
      if (found) return { ...route, params: { ...found.groups } };
    }
    return undefined;
  }

  async handleApi(request, response, url, raw) {
    const method = request.method;
    const route = this.route(method, url.pathname);
    const entry = {
      seq: this.log.length + 1,
      method,
      path: `${url.pathname}${url.search}`,
      endpoint: route?.endpoint ?? `${method} ${url.pathname} (unhandled)`,
      status: 0,
      effect: false,
    };
    this.log.push(entry);
    if (!route) {
      entry.unhandled = true;
      entry.status = 404;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    let body;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      entry.status = 400;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Problems parsing JSON" }));
      return;
    }
    entry.body = body;
    const rule = this.matchRules(entry);
    if (this.preEffect(rule, entry, response)) return;
    await this.synchronizeHeads();
    const reading = method === "GET" || route.handler === "graphql";
    const before = reading ? undefined : structuredClone(this.state);
    const view = reading ? this.view(route.endpoint) : this.state;
    let result;
    try {
      result = await this[route.handler](view, {
        params: route.params,
        query: url.searchParams,
        body,
        url,
        headers: request.headers,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (before) this.state = before;
      result = {
        status: error.status,
        data: {
          message: error.message,
          documentation_url: "https://docs.github.com/rest",
          ...error.extra,
        },
      };
    }
    if (!reading && result.status < 300 && result.effect !== false) {
      entry.effect = true;
      this.recordWrite(before, route.endpoint);
    }
    // Another actor changes the repository between this request and the next.
    if (rule?.kind === "after") {
      entry.fault = "after";
      await rule.run(this, entry);
    }
    if (this.postEffect(rule, entry, response)) return;
    entry.status = result.status;
    const payload =
      result.data === undefined ? "" : JSON.stringify(result.data);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "x-github-api-version-selected": "2026-03-10",
      ...rateHeaders(),
      ...(result.headers ?? {}),
    };
    if (method === "GET" && result.status === 200) {
      const etag = `W/"${createHash("sha256").update(payload).digest("hex").slice(0, 32)}"`;
      headers.etag = etag;
      if (request.headers["if-none-match"] === etag) {
        entry.status = 304;
        response.writeHead(304, headers);
        response.end();
        return;
      }
    }
    response.writeHead(result.status, headers);
    response.end(payload);
  }

  // ---- read-after-write lag ---------------------------------------------

  recordWrite(before, endpoint) {
    const pending = {};
    for (const [index, rule] of this.lag.entries())
      if (rule.reads > 0 && (!rule.after || rule.after === endpoint))
        pending[index] = rule.reads;
    if (Object.keys(pending).length) this.writes.push({ before, pending });
  }

  /** The state a read of `endpoint` observes: before the oldest lagging write. */
  view(endpoint) {
    const rules = [...this.lag.keys()].filter(
      (index) => this.lag[index].read === endpoint,
    );
    if (!rules.length) return this.state;
    const lagging = this.writes.find((write) =>
      rules.some((index) => write.pending[index] > 0),
    );
    // Count stale reads per rule so a test can prove its lag took effect.
    if (lagging)
      for (const index of rules)
        if (lagging.pending[index] > 0)
          this.lag[index].served = (this.lag[index].served ?? 0) + 1;
    for (const write of this.writes)
      for (const index of rules)
        if (write.pending[index] > 0) write.pending[index]--;
    this.writes = this.writes.filter((write) =>
      Object.values(write.pending).some((reads) => reads > 0),
    );
    return lagging ? lagging.before : this.state;
  }

  // ---- representations ------------------------------------------------

  tick(s) {
    s.clock += 1000;
    return new Date(s.clock).toISOString();
  }

  labelJson(s, name) {
    const label = s.labels.find((candidate) => candidate.name === name);
    return {
      id: label?.id ?? 0,
      node_id: `LA_${label?.id ?? 0}`,
      url: `${API}/repos/${this.repository}/labels/${encodeURIComponent(name)}`,
      name,
      color: label?.color ?? "ededed",
      default: false,
      description: label?.description ?? null,
    };
  }

  issueJson(s, number) {
    const issue = s.issues[number];
    const pull = s.pulls[number];
    return {
      id: issue.id,
      node_id: `I_${issue.id}`,
      url: `${API}/repos/${this.repository}/issues/${number}`,
      repository_url: `${API}/repos/${this.repository}`,
      html_url: `https://github.com/${this.repository}/${pull ? "pull" : "issues"}/${number}`,
      number,
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      title: issue.title,
      body: issue.body ?? null,
      user: { login: this.owner, id: 1, type: "User" },
      labels: issue.labels.map((name) => this.labelJson(s, name)),
      locked: false,
      comments: (s.comments[number] ?? []).length,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? null,
      ...(pull
        ? {
            pull_request: {
              url: `${API}/repos/${this.repository}/pulls/${number}`,
              html_url: `https://github.com/${this.repository}/pull/${number}`,
              merged_at: pull.merged_at ?? null,
            },
          }
        : {}),
    };
  }

  pullJson(s, number) {
    const issue = s.issues[number];
    const pull = s.pulls[number];
    const branch = (ref, sha) => ({
      label: `${this.owner}:${ref}`,
      ref,
      sha,
      user: { login: this.owner },
      repo: { full_name: this.repository, name: this.name },
    });
    // API version 2026-03-10 has no merge_commit_sha on pulls.
    return {
      url: `${API}/repos/${this.repository}/pulls/${number}`,
      id: issue.id + 500000,
      node_id: `PR_${issue.id}`,
      html_url: `https://github.com/${this.repository}/pull/${number}`,
      number,
      state: issue.state,
      locked: false,
      title: issue.title,
      body: issue.body ?? null,
      user: { login: this.owner },
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? null,
      merged_at: pull.merged_at ?? null,
      merged: Boolean(pull.merged_at),
      draft: false,
      head: branch(pull.head.ref, pull.head.sha),
      base: branch(pull.base.ref, pull.base.sha ?? null),
    };
  }

  page(query, items, path) {
    const perPage = Math.min(
      Math.max(Number(query.get("per_page")) || 30, 1),
      100,
    );
    const page = Math.max(Number(query.get("page")) || 1, 1);
    const last = Math.max(Math.ceil(items.length / perPage), 1);
    const link = (target) => {
      const next = new URLSearchParams(query);
      next.set("per_page", String(perPage));
      next.set("page", String(target));
      return `<${API}${path}?${next}>`;
    };
    const links = [];
    if (page < last)
      links.push(`${link(page + 1)}; rel="next"`, `${link(last)}; rel="last"`);
    if (page > 1)
      links.push(`${link(1)}; rel="first"`, `${link(page - 1)}; rel="prev"`);
    return {
      data: items.slice((page - 1) * perPage, page * perPage),
      headers: links.length ? { link: links.join(", ") } : {},
    };
  }

  createIssueRecord(s, { title, body, labels = [] }, pull) {
    const number = s.nextNumber++;
    const now = this.tick(s);
    for (const name of labels) this.ensureLabel(s, name);
    s.issues[number] = {
      id: s.nextId++,
      number,
      title,
      body: body ?? null,
      state: "open",
      labels: [...new Set(labels)],
      created_at: now,
      updated_at: now,
      pull: Boolean(pull),
    };
    s.timeline[number] = [];
    if (pull) s.pulls[number] = pull;
    return number;
  }

  ensureLabel(s, name) {
    if (!s.labels.some((label) => label.name === name))
      s.labels.push({ id: s.nextId++, name, color: "ededed" });
  }

  event(s, number, event, extra = {}) {
    s.timeline[number] ??= [];
    s.timeline[number].push({
      id: s.nextId++,
      node_id: `E_${s.nextId}`,
      event,
      actor: { login: this.owner },
      commit_id: null,
      commit_url: null,
      created_at: this.tick(s),
      ...extra,
    });
  }

  requireIssue(s, number) {
    const issue = s.issues[Number(number)];
    if (!issue) throw new HttpError(404, "Not Found");
    return issue;
  }

  async refs() {
    const output = await git(
      this.origin,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    );
    return new Map(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref, sha] = line.split(" ");
          return [ref.slice("refs/heads/".length), sha];
        }),
    );
  }

  /** GitHub follows pushes to an open PR's head branch. */
  async synchronizeHeads() {
    const open = Object.values(this.state.pulls).filter(
      (pull) =>
        !pull.merged_at && this.state.issues[pull.number].state === "open",
    );
    if (!open.length) return;
    const refs = await this.refs();
    for (const pull of open) {
      const sha = refs.get(pull.head.ref);
      if (sha && sha !== pull.head.sha) {
        pull.head.sha = sha;
        this.event(this.state, pull.number, "head_ref_force_pushed");
      }
    }
  }

  async conflicts(base, head) {
    const result = await gitStatus(
      this.origin,
      "merge-tree",
      "--write-tree",
      base,
      head,
    );
    return result.status === 0
      ? { tree: result.stdout.split("\n")[0] }
      : undefined;
  }

  /** Create a merge commit of `headSha` into `baseRef` like GitHub's merge button. */
  async mergeCommit(baseRef, headSha, message) {
    const refs = await this.refs();
    const baseSha = refs.get(baseRef);
    if (!baseSha) throw new HttpError(405, "Base branch does not exist");
    const merged = await this.conflicts(baseSha, headSha);
    if (!merged) throw new HttpError(405, "Pull Request is not mergeable");
    const commit = await git(
      this.origin,
      "commit-tree",
      merged.tree,
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      message,
    );
    const update = await gitStatus(
      this.origin,
      "update-ref",
      `refs/heads/${baseRef}`,
      commit,
      baseSha,
    );
    if (update.status !== 0)
      throw new HttpError(
        405,
        "Base branch was modified. Review and try the merge again.",
      );
    return commit;
  }

  markMerged(s, number, sha) {
    const issue = s.issues[number];
    const pull = s.pulls[number];
    const now = this.tick(s);
    pull.merged_at = now;
    pull.mergeSha = sha;
    pull.merges = (pull.merges ?? 0) + 1;
    issue.state = "closed";
    issue.closed_at = now;
    issue.updated_at = now;
    this.event(s, number, "merged", {
      commit_id: sha,
      commit_url: `${API}/repos/${this.repository}/commits/${sha}`,
    });
    this.event(s, number, "closed");
  }

  // ---- REST handlers ------------------------------------------------------

  getRepository() {
    return {
      status: 200,
      data: {
        id: 1,
        node_id: "R_1",
        name: this.name,
        full_name: this.repository,
        owner: { login: this.owner, id: 1, type: "User" },
        private: false,
        default_branch: this.defaultBranch,
        allow_merge_commit: (this.options.mergeMethods ?? ["merge"]).includes(
          "merge",
        ),
        allow_squash_merge: (this.options.mergeMethods ?? ["merge"]).includes(
          "squash",
        ),
        allow_rebase_merge: (this.options.mergeMethods ?? ["merge"]).includes(
          "rebase",
        ),
      },
    };
  }

  /** The token's user, who authors everything Factory creates here. */
  viewer() {
    return {
      status: 200,
      data: { login: this.owner, id: 1, type: "User" },
    };
  }

  listIssues(s, { query }) {
    const state = query.get("state") ?? "open";
    const labels = query.get("labels")?.split(",").filter(Boolean) ?? [];
    const direction = query.get("direction") ?? "desc";
    const sort = query.get("sort") ?? "created";
    if (!["open", "closed", "all"].includes(state))
      throw validation("Invalid state");
    if (!["created", "updated", "comments"].includes(sort))
      throw validation("Invalid sort");
    const issues = Object.keys(s.issues)
      .map(Number)
      .filter((number) => state === "all" || s.issues[number].state === state)
      .filter((number) =>
        labels.every((name) => s.issues[number].labels.includes(name)),
      )
      .sort((a, b) => (direction === "asc" ? a - b : b - a));
    const page = this.page(query, issues, `/repos/${this.repository}/issues`);
    return {
      status: 200,
      data: page.data.map((number) => this.issueJson(s, number)),
      headers: page.headers,
    };
  }

  createIssue(s, { body }) {
    if (typeof body.title !== "string" || !body.title)
      throw validation("title is missing");
    if (body.title.length > 256) throw validation("title is too long");
    if (typeof body.body === "string" && body.body.length > 65536)
      throw validation("body is too long (maximum is 65536 characters)");
    const number = this.createIssueRecord(s, {
      title: body.title,
      body: body.body,
      labels: (body.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name,
      ),
    });
    for (const name of s.issues[number].labels)
      this.event(s, number, "labeled", { label: { name } });
    return { status: 201, data: this.issueJson(s, number) };
  }

  getIssue(s, { params }) {
    this.requireIssue(s, params.number);
    return { status: 200, data: this.issueJson(s, Number(params.number)) };
  }

  updateIssue(s, { params, body }) {
    const number = Number(params.number);
    const issue = this.requireIssue(s, number);
    const pull = s.pulls[number];
    if (body.title !== undefined) issue.title = body.title;
    if (body.body !== undefined) issue.body = body.body;
    if (body.state !== undefined) {
      if (!["open", "closed"].includes(body.state))
        throw validation("Invalid state");
      if (pull?.merged_at && body.state === "open")
        throw validation("Cannot reopen a merged pull request");
      if (body.state !== issue.state) {
        issue.state = body.state;
        if (body.state === "closed") {
          issue.closed_at = this.tick(s);
          issue.state_reason = body.state_reason ?? "completed";
          this.event(s, number, "closed", {
            state_reason: issue.state_reason,
          });
        } else {
          issue.closed_at = null;
          issue.state_reason = "reopened";
          this.event(s, number, "reopened");
        }
      }
    }
    issue.updated_at = this.tick(s);
    return { status: 200, data: this.issueJson(s, number) };
  }

  listComments(s, { params, query }) {
    this.requireIssue(s, params.number);
    const page = this.page(
      query,
      s.comments[params.number] ?? [],
      `/repos/${this.repository}/issues/${params.number}/comments`,
    );
    return { status: 200, data: page.data, headers: page.headers };
  }

  createComment(s, { params, body }) {
    const number = Number(params.number);
    this.requireIssue(s, number);
    if (typeof body.body !== "string" || !body.body)
      throw validation("body is missing");
    const comment = {
      id: s.nextId++,
      node_id: `IC_${s.nextId}`,
      body: body.body,
      user: { login: this.owner },
      html_url: `https://github.com/${this.repository}/issues/${number}#issuecomment-${s.nextId}`,
      issue_url: `${API}/repos/${this.repository}/issues/${number}`,
      created_at: this.tick(s),
    };
    s.comments[number] ??= [];
    s.comments[number].push(comment);
    this.event(s, number, "commented", { body: body.body });
    return { status: 201, data: comment };
  }

  addLabels(s, { params, body }) {
    const number = Number(params.number);
    const issue = this.requireIssue(s, number);
    const names = (Array.isArray(body) ? body : (body.labels ?? [])).map(
      (label) => (typeof label === "string" ? label : label.name),
    );
    if (!names.length) throw validation("labels are missing");
    for (const name of names) {
      this.ensureLabel(s, name);
      if (!issue.labels.includes(name)) {
        issue.labels.push(name);
        this.event(s, number, "labeled", { label: { name } });
      }
    }
    return {
      status: 200,
      data: issue.labels.map((name) => this.labelJson(s, name)),
    };
  }

  timeline(s, { params, query }) {
    this.requireIssue(s, params.number);
    const page = this.page(
      query,
      s.timeline[params.number] ?? [],
      `/repos/${this.repository}/issues/${params.number}/timeline`,
    );
    return { status: 200, data: page.data, headers: page.headers };
  }

  issueById(s, id) {
    return Object.values(s.issues).find((issue) => issue.id === Number(id));
  }

  listBlockedBy(s, { params, query }) {
    this.requireIssue(s, params.number);
    const page = this.page(
      query,
      s.blockedBy[params.number] ?? [],
      `/repos/${this.repository}/issues/${params.number}/dependencies/blocked_by`,
    );
    return {
      status: 200,
      data: page.data.map((number) => this.issueJson(s, number)),
      headers: page.headers,
    };
  }

  addBlockedBy(s, { params, body }) {
    const number = Number(params.number);
    this.requireIssue(s, number);
    const blocker = this.issueById(s, body.issue_id);
    if (!blocker) throw new HttpError(404, "Not Found");
    if (blocker.number === number)
      throw validation("An issue cannot be blocked by itself");
    s.blockedBy[number] ??= [];
    if (s.blockedBy[number].includes(blocker.number))
      throw validation("Dependency already exists");
    s.blockedBy[number].push(blocker.number);
    return { status: 201, data: this.issueJson(s, blocker.number) };
  }

  removeBlockedBy(s, { params }) {
    const number = Number(params.number);
    this.requireIssue(s, number);
    const blocker = this.issueById(s, params.issue_id);
    if (!blocker || !(s.blockedBy[number] ?? []).includes(blocker.number))
      throw new HttpError(404, "Not Found");
    s.blockedBy[number] = s.blockedBy[number].filter(
      (candidate) => candidate !== blocker.number,
    );
    return { status: 200, data: this.issueJson(s, blocker.number) };
  }

  listSubIssues(s, { params, query }) {
    this.requireIssue(s, params.number);
    const page = this.page(
      query,
      s.children[params.number] ?? [],
      `/repos/${this.repository}/issues/${params.number}/sub_issues`,
    );
    return {
      status: 200,
      data: page.data.map((number) => this.issueJson(s, number)),
      headers: page.headers,
    };
  }

  addSubIssue(s, { params, body }) {
    const parent = Number(params.number);
    this.requireIssue(s, parent);
    const child = this.issueById(s, body.sub_issue_id);
    if (!child) throw new HttpError(404, "Not Found");
    if (child.number === parent)
      throw validation("An issue cannot be its own sub-issue");
    const current = s.parent[child.number];
    if (current === parent)
      throw validation("Issue is already a sub-issue of this parent");
    if (current !== undefined && body.replace_parent !== true)
      throw validation("Issue may only have one parent");
    if (current !== undefined)
      s.children[current] = s.children[current].filter(
        (number) => number !== child.number,
      );
    s.parent[child.number] = parent;
    s.children[parent] ??= [];
    s.children[parent].push(child.number);
    return { status: 201, data: this.issueJson(s, parent) };
  }

  getParent(s, { params }) {
    this.requireIssue(s, params.number);
    const parent = s.parent[params.number];
    if (parent === undefined) throw new HttpError(404, "Not Found");
    return { status: 200, data: this.issueJson(s, parent) };
  }

  listLabels(s, { query }) {
    const page = this.page(query, s.labels, `/repos/${this.repository}/labels`);
    return {
      status: 200,
      data: page.data.map((label) => this.labelJson(s, label.name)),
      headers: page.headers,
    };
  }

  createLabel(s, { body }) {
    if (typeof body.name !== "string" || !body.name)
      throw validation("name is missing");
    if (
      s.labels.some(
        (label) => label.name.toLowerCase() === body.name.toLowerCase(),
      )
    )
      throw new HttpError(422, "Validation Failed", {
        errors: [{ resource: "Label", code: "already_exists", field: "name" }],
      });
    s.labels.push({
      id: s.nextId++,
      name: body.name,
      color: body.color ?? "ededed",
      description: body.description ?? null,
    });
    return { status: 201, data: this.labelJson(s, body.name) };
  }

  parseHead(head) {
    if (typeof head !== "string" || !head) return undefined;
    if (!head.includes(":")) return head;
    const [owner, ref] = head.split(":", 2);
    return owner.toLowerCase() === this.owner.toLowerCase() ? ref : undefined;
  }

  listPulls(s, { query }) {
    const state = query.get("state") ?? "open";
    const head = query.get("head");
    const base = query.get("base");
    // GitHub filters by head only in user:ref form.
    const headRef = head?.includes(":") ? this.parseHead(head) : undefined;
    const pulls = Object.keys(s.pulls)
      .map(Number)
      .filter((number) => state === "all" || s.issues[number].state === state)
      .filter(
        (number) =>
          !head?.includes(":") || s.pulls[number].head.ref === headRef,
      )
      .filter((number) => !base || s.pulls[number].base.ref === base)
      .sort((a, b) => b - a);
    const page = this.page(query, pulls, `/repos/${this.repository}/pulls`);
    return {
      status: 200,
      data: page.data.map((number) => this.pullJson(s, number)),
      headers: page.headers,
    };
  }

  async createPull(s, { body }) {
    const headRef = this.parseHead(body.head);
    if (!headRef || typeof body.base !== "string" || !body.title)
      throw validation("head, base and title are required");
    const refs = await this.refs();
    const headSha = refs.get(headRef);
    const baseSha = refs.get(body.base);
    if (!baseSha)
      throw new HttpError(422, "Validation Failed", {
        errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
      });
    if (!headSha)
      throw new HttpError(422, "Validation Failed", {
        errors: [{ resource: "PullRequest", field: "head", code: "invalid" }],
      });
    if (
      Object.values(s.pulls).some(
        (pull) =>
          pull.head.ref === headRef &&
          pull.base.ref === body.base &&
          s.issues[pull.number].state === "open",
      )
    )
      throw validation(
        `A pull request already exists for ${this.owner}:${headRef}.`,
        { resource: "PullRequest", code: "custom" },
      );
    const ahead = await gitStatus(
      this.origin,
      "merge-base",
      "--is-ancestor",
      headSha,
      baseSha,
    );
    if (ahead.status === 0)
      throw validation(`No commits between ${body.base} and ${headRef}`, {
        resource: "PullRequest",
        code: "custom",
      });
    const number = s.nextNumber;
    this.createIssueRecord(
      s,
      { title: body.title, body: body.body },
      {
        number,
        head: { ref: headRef, sha: headSha },
        base: { ref: body.base, sha: baseSha },
      },
    );
    return { status: 201, data: this.pullJson(s, number) };
  }

  requirePull(s, number) {
    const pull = s.pulls[Number(number)];
    if (!pull) throw new HttpError(404, "Not Found");
    return pull;
  }

  getPull(s, { params }) {
    this.requirePull(s, params.number);
    return { status: 200, data: this.pullJson(s, Number(params.number)) };
  }

  checkMergeable(s, number, body) {
    const pull = this.requirePull(s, number);
    const methods = this.options.mergeMethods ?? ["merge"];
    if (pull.merged_at || s.issues[number].state !== "open")
      throw new HttpError(405, "Pull Request is not mergeable");
    if (!methods.includes(body.merge_method ?? "merge"))
      throw new HttpError(
        405,
        `${body.merge_method ?? "merge"} merges are not allowed on this repository.`,
      );
    if ((body.merge_method ?? "merge") !== "merge")
      throw validation("The fake implements merge commits only");
    if (body.sha !== undefined && body.sha !== pull.head.sha)
      throw new HttpError(
        409,
        "Head branch was modified. Review and try the merge again.",
      );
    return pull;
  }

  async mergePull(s, { params, body }) {
    const number = Number(params.number);
    const pull = this.checkMergeable(s, number, body);
    if (s.stacks.some((stack) => stack.pulls.includes(number)))
      throw new HttpError(405, "Stacked pull requests merge as a stack");
    const sha = await this.mergeCommit(
      pull.base.ref,
      pull.head.sha,
      body.commit_title ??
        `Merge pull request #${number} from ${this.owner}/${pull.head.ref}`,
    );
    this.markMerged(s, number, sha);
    return {
      status: 200,
      data: { sha, merged: true, message: "Pull Request successfully merged" },
    };
  }

  stackJson(s, stack) {
    return {
      id: stack.id,
      node_id: `ST_${stack.id}`,
      number: stack.number,
      url: `${API}/repos/${this.repository}/stacks/${stack.number}`,
      base: { ref: stack.base },
      open: stack.pulls.some((number) => !s.pulls[number].merged_at),
      created_at: stack.created_at,
      pull_requests: stack.pulls.map((number) => this.pullJson(s, number)),
    };
  }

  listStacks(s, { query }) {
    const number = Number(query.get("pull_request"));
    const stacks = s.stacks.filter(
      (stack) => !number || stack.pulls.includes(number),
    );
    const page = this.page(query, stacks, `/repos/${this.repository}/stacks`);
    return {
      status: 200,
      data: page.data.map((stack) => this.stackJson(s, stack)),
      headers: page.headers,
    };
  }

  createStack(s, { body }) {
    const numbers = body.pull_requests;
    if (!Array.isArray(numbers) || numbers.length < 2)
      throw validation("A stack needs two or more pull requests");
    for (const [index, number] of numbers.entries()) {
      const pull = s.pulls[Number(number)];
      if (!pull) throw validation(`Pull request #${number} does not exist`);
      if (s.issues[number].state !== "open")
        throw validation(`Pull request #${number} is not open`);
      if (s.stacks.some((stack) => stack.pulls.includes(number)))
        throw validation(`Pull request #${number} is already in a stack`);
      if (index && pull.base.ref !== s.pulls[numbers[index - 1]].head.ref)
        throw validation(
          `Pull request #${number} does not stack on its predecessor`,
        );
    }
    const stack = {
      id: s.nextId++,
      number: s.nextStack++,
      base: s.pulls[numbers[0]].base.ref,
      pulls: [...numbers],
      created_at: this.tick(s),
    };
    s.stacks.push(stack);
    return { status: 201, data: this.stackJson(s, stack) };
  }

  /**
   * Land an async merge: the requested PR with every open PR below it in its
   * stack, as one merge commit of the requested head into the stack's base.
   * Unverified against GitHub: whether each layer reports that one commit on
   * its timeline, or a commit of its own.
   */
  async applyJob(s, job) {
    const top = s.pulls[job.top];
    const base = s.pulls[job.layers[0]].base.ref;
    const sha = await this.mergeCommit(
      base,
      top.head.sha,
      `Merge pull request #${job.top} from ${this.owner}/${top.head.ref}`,
    );
    for (const number of job.layers) this.markMerged(s, number, sha);
    job.sha = sha;
    job.applied = true;
  }

  jobDetails(job) {
    return {
      uuid: job.uuid,
      merge_method: job.merge_method,
      merge_action: job.merge_action,
      expected_head_sha: job.expected_head_sha,
      bypass_rules: job.bypass_rules,
      ...(job.applied ? { sha: job.sha } : {}),
    };
  }

  /**
   * PUT merge-async (API 2026-03-10): 202 pending with a uuid; 200 merged
   * when the PR already merged; 400 when it is closed or a draft; 409 with
   * the pending request when a merge is already requested. For a stacked PR
   * the merge includes every open PR below it.
   */
  async mergeAsync(s, { params, body }) {
    const number = Number(params.number);
    const pull = this.requirePull(s, number);
    if (pull.merged_at)
      return {
        status: 200,
        effect: false,
        data: {
          status: "merged",
          details: {
            message: "Pull request is already merged",
            sha: pull.mergeSha,
          },
        },
      };
    if (s.issues[number].state !== "open" || pull.draft)
      throw new HttpError(400, "Pull request is not ready to be merged");
    const pending = Object.values(s.jobs).find(
      (job) => !job.applied && job.layers.includes(number),
    );
    if (pending)
      throw new HttpError(
        409,
        "A merge request is already enqueued for this pull request",
        { status: "pending", details: this.jobDetails(pending) },
      );
    const methods = this.options.mergeMethods ?? ["merge"];
    const method = body.merge_method ?? "merge";
    if (!methods.includes(method) || method !== "merge")
      throw validation(`${method} merges are not allowed on this repository`);
    if (body.sha !== undefined && body.sha !== pull.head.sha)
      throw validation("Head sha does not match the pull request head");
    const stack = s.stacks.find((candidate) =>
      candidate.pulls.includes(number),
    );
    const layers = stack
      ? stack.pulls
          .slice(0, stack.pulls.indexOf(number) + 1)
          .filter((layer) => !s.pulls[layer].merged_at)
      : [number];
    const job = {
      uuid: randomUUID(),
      top: number,
      layers,
      polls: this.options.asyncMergePolls ?? 0,
      applied: false,
      merge_method: method,
      merge_action: body.merge_action ?? "default",
      expected_head_sha: pull.head.sha,
      bypass_rules: body.bypass_rules ?? false,
    };
    s.jobs[job.uuid] = job;
    if (job.polls <= 0) await this.applyJob(s, job);
    return {
      status: 202,
      data: {
        status: "pending",
        details: this.jobDetails({ ...job, applied: false }),
      },
    };
  }

  async mergeAsyncStatus(s, { params }) {
    // A status poll observes the live job, never a lagged snapshot.
    const job = this.state.jobs[params.uuid];
    if (!job || job.top !== Number(params.number))
      throw new HttpError(404, "Not Found");
    if (!job.applied && --job.polls <= 0) await this.applyJob(this.state, job);
    return {
      status: 200,
      data: {
        status: job.applied ? "merged" : "pending",
        details: this.jobDetails(job),
      },
    };
  }

  checkRuns(s, { params, query }) {
    const name = query.get("check_name");
    const runs = (this.options.checkRuns?.(params.sha) ?? [])
      .map((run, index) => ({
        id: run.id ?? 9000 + index,
        name: run.name,
        head_sha: params.sha,
        status: run.status ?? "completed",
        conclusion: run.conclusion === undefined ? "success" : run.conclusion,
        html_url: `https://github.com/${this.repository}/runs/${run.id ?? 9000 + index}`,
        app: run.app ?? { id: 15368 },
      }))
      .filter((run) => !name || run.name === name);
    const page = this.page(
      query,
      runs,
      `/repos/${this.repository}/commits/${params.sha}/check-runs`,
    );
    return {
      status: 200,
      data: { total_count: runs.length, check_runs: page.data },
      headers: page.headers,
    };
  }

  combinedStatus(s, { params }) {
    // With no commit statuses GitHub reports a pending combined state.
    const statuses = this.options.statuses?.(params.sha) ?? [];
    const state = statuses.some((status) =>
      ["error", "failure"].includes(status.state),
    )
      ? "failure"
      : statuses.length &&
          statuses.every((status) => status.state === "success")
        ? "success"
        : "pending";
    return {
      status: 200,
      data: { state, sha: params.sha, total_count: statuses.length, statuses },
    };
  }

  async graphql(s, { body }) {
    const query = String(body.query ?? "");
    if (!/pullRequest\(number:/.test(query) || !/mergeStateStatus/.test(query))
      return {
        status: 200,
        data: { errors: [{ message: "Query not supported by the fake" }] },
      };
    const { owner, name, number } = body.variables ?? {};
    if (
      String(owner).toLowerCase() !== this.owner.toLowerCase() ||
      String(name).toLowerCase() !== this.name.toLowerCase()
    )
      return {
        status: 200,
        data: {
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
        },
      };
    const pull = s.pulls[number];
    if (!pull)
      return {
        status: 200,
        data: { data: { repository: { pullRequest: null } } },
      };
    // Mergeability is computed lazily: the live counter, not the snapshot.
    this.state.readinessReads[number] =
      (this.state.readinessReads[number] ?? 0) + 1;
    let status = this.options.readiness?.(pull, s);
    if (!status) {
      if (
        this.state.readinessReads[number] <=
        (this.options.readinessUnknownReads ?? 0)
      )
        status = "UNKNOWN";
      else {
        const refs = await this.refs();
        const base = refs.get(pull.base.ref);
        status =
          base && (await this.conflicts(base, pull.head.sha))
            ? "CLEAN"
            : "DIRTY";
      }
    }
    return {
      status: 200,
      data: {
        data: {
          repository: {
            pullRequest: {
              number: Number(number),
              headRefOid: pull.head.sha,
              headRefName: pull.head.ref,
              baseRefName: pull.base.ref,
              mergeStateStatus: status,
            },
          },
        },
      },
    };
  }

  // ---- Git smart HTTP -----------------------------------------------------

  async handleGit(request, response, url, body) {
    const prefix = `/git/${this.owner}/${this.name}.git`;
    const service = url.searchParams.get("service");
    const rest = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : undefined;
    const endpoint =
      rest === "/info/refs"
        ? service === "git-receive-pack"
          ? "GIT push-advertise"
          : "GIT fetch-advertise"
        : rest === "/git-receive-pack"
          ? "GIT push"
          : rest === "/git-upload-pack"
            ? "GIT fetch"
            : `GIT ${request.method} ${url.pathname} (unhandled)`;
    const entry = {
      seq: this.log.length + 1,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      endpoint,
      status: 0,
      effect: false,
    };
    this.log.push(entry);
    if (rest === undefined || endpoint.endsWith("(unhandled)")) {
      entry.unhandled = true;
      entry.status = 404;
      response.writeHead(404);
      response.end();
      return;
    }
    const rule = this.matchRules(entry);
    if (this.preEffect(rule, entry, response)) return;
    const env = {
      ...gitEnvironment(),
      GIT_PROJECT_ROOT: dirname(this.origin),
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: this.owner,
      REMOTE_ADDR: "127.0.0.1",
      PATH_INFO: `/${basename(this.origin)}${rest}`,
      REQUEST_METHOD: request.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      ...(request.headers["content-encoding"]
        ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] }
        : {}),
      ...(request.headers["git-protocol"]
        ? { GIT_PROTOCOL: request.headers["git-protocol"] }
        : {}),
    };
    const output = await new Promise((resolve, reject) => {
      const child = spawn("git", ["http-backend"], { env });
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", () => resolve(Buffer.concat(chunks)));
      // http-backend may exit without reading the body (e.g. a ref listing).
      child.stdin.on("error", () => {});
      child.stdin.end(body);
    });
    let split = output.indexOf("\r\n\r\n");
    let separator = 4;
    if (split < 0) {
      split = output.indexOf("\n\n");
      separator = 2;
    }
    const head = output.subarray(0, Math.max(split, 0)).toString("latin1");
    const headers = {};
    let status = 200;
    for (const line of head.split(/\r?\n/).filter(Boolean)) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    if (endpoint === "GIT push" && status === 200) entry.effect = true;
    if (this.postEffect(rule, entry, response)) return;
    entry.status = status;
    response.writeHead(status, headers);
    response.end(split < 0 ? output : output.subarray(split + separator));
  }
}

/** Fault presets for `inject`. */
export const faults = {
  unavailable: (status = 503) => ({ kind: "status", status }),
  rateLimited: ({ retryAfter } = {}) => ({
    kind: "status",
    status: 429,
    message: "API rate limit exceeded",
    headers: () =>
      retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
  }),
  secondaryRateLimit: ({ retryAfter } = {}) => ({
    kind: "status",
    status: 403,
    message:
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    headers: () =>
      retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
  }),
  // GitHub always sends x-ratelimit-reset with an exhausted primary limit.
  primaryRateLimit: ({ resetInSeconds = 60 } = {}) => ({
    kind: "status",
    status: 403,
    message: "API rate limit exceeded for user ID 1.",
    headers: () => ({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "5000",
      "x-ratelimit-reset": String(
        Math.ceil(Date.now() / 1000 + resetInSeconds),
      ),
    }),
  }),
  baseModified: () => ({
    kind: "status",
    status: 405,
    message: "Base branch was modified. Review and try the merge again.",
  }),
};
