/**
 * A generic grader for any Objective's result (#2273): bench/grade-auto.mjs.
 * Where a benchmark's own grader is written and calibrated by hand for one
 * Objective, this one reads the Objective's acceptance and the change from
 * its base commit to the graded commit, and sends four roles at it, each a
 * separate headless agent (Claude Code's CLI by default):
 *
 * 1. `grader`: splits the acceptance into criteria and gives each `pass`,
 *    `partial`, `fail` or `unknown` with file:line evidence, after running
 *    the repository's declared checks. It votes `votes` times (3 by
 *    default), independently: the first vote that answers splits the
 *    criteria, the others grade that list. A criterion's verdict is a strict
 *    majority of all the votes: `pass` with a majority of passes, `fail`
 *    with a majority of fails and partials (a partial is not a pass), and
 *    `unknown` otherwise. A vote that timed out or failed is unknown on
 *    every criterion, so it never makes a fail.
 * 2. `quality`: reviews the change (design, the repository's conventions,
 *    test economy, dead code, duplication, docs) and mutates the changed
 *    lines, reporting the mutants the delivered tests let survive.
 * 3. `adversary`: probes each guarantee the acceptance states and reports
 *    each break with a reproduce snippet.
 * 4. `verifier`: reproduces the non-minor findings of 2 and 3, at most
 *    `maxFindings` (20 by default, claimed defects first), and classifies
 *    each it confirms as `defect` (it violates a stated criterion),
 *    `quality` or `minor`. A finding it doesn't confirm, or that it never
 *    answers, is dropped: the default is rejected.
 *
 * Each role works in its own scratch checkout of the graded commit (a clone
 * sharing the repository's objects, no remote, so nothing can be pushed),
 * after the repository's install command when one is given. The original
 * tree is only read, and checked unchanged afterwards. Each role's prompt
 * (bench/grade-auto/<role>.md, repository-neutral), transcript and answer
 * are kept in the evidence directory. A role is bounded by a wall-clock
 * timeout, and the whole run by another; a role that times out yields
 * unknown, never a fail.
 *
 * The output keeps the grader contract (bench/lib/grade.mjs), plus
 * `findings`, `mutation`, `cost`, `durationMs` and the roles' outcomes.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutInto, runCommand, SEVERITIES } from "./grade.mjs";

/** The auto-grader's own version: part of graderVersion, with its prompts' digest. */
export const AUTO_GRADER_VERSION = 1;
/** Where the roles' prompts live: bench/grade-auto/<role>.md. */
export const PROMPTS = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "grade-auto",
);
export const DEFAULTS = Object.freeze({
  cli: "claude",
  model: "opus",
  effort: null,
  votes: 3,
  maxFindings: 20,
  timeoutMinutes: 30,
  roleTimeoutMinutes: 30,
});
/** A grader vote's verdict on one criterion; the combined verdict is the contract's pass, fail or unknown. */
const VOTES = ["pass", "partial", "fail", "unknown"];

const string = { type: "string" };
const whole = { type: "integer", minimum: 0 };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const list = (items) => ({ type: "array", items });
const finding = (extra) =>
  object({
    title: string,
    severity: { enum: SEVERITIES },
    evidence: string,
    reproduce: string,
    ...extra,
  });

/** Each role's final answer, as the JSON schema the CLI is given and the harness checks. */
export const SCHEMAS = {
  grader: object(
    {
      criteria: list(
        object(
          {
            id: string,
            text: string,
            verdict: { enum: VOTES },
            method: string,
            evidence: string,
          },
          ["id", "text", "verdict", "evidence"],
        ),
      ),
      checks: list(
        object(
          { command: string, passed: { type: "boolean" }, summary: string },
          ["command", "passed"],
        ),
      ),
    },
    ["criteria"],
  ),
  quality: object({
    findings: list(finding({ category: string })),
    mutation: object({
      killed: whole,
      survived: whole,
      examples: list(object({ location: string, mutant: string })),
    }),
  }),
  adversary: object({
    probes: whole,
    findings: list(finding({ guarantee: string })),
  }),
  verifier: object({
    verdicts: list(
      object(
        {
          id: string,
          confirmed: { type: "boolean" },
          severity: { enum: SEVERITIES },
          evidence: string,
          reproduce: string,
        },
        ["id", "confirmed", "severity", "evidence"],
      ),
    ),
  }),
};

/** Where `value` doesn't hold to `schema` (the subset SCHEMAS uses), each with its path; empty when it does. */
export function schemaProblems(schema, value, path = "answer") {
  if (schema.enum)
    return schema.enum.includes(value)
      ? []
      : [`${path} must be one of ${schema.enum.join(", ")}`];
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? [] : [`${path} must be a string`];
    case "boolean":
      return typeof value === "boolean"
        ? []
        : [`${path} must be true or false`];
    case "integer":
      return Number.isSafeInteger(value) &&
        value >= (schema.minimum ?? -Infinity)
        ? []
        : [`${path} must be a whole number`];
    case "array":
      return Array.isArray(value)
        ? value.flatMap((item, i) =>
            schemaProblems(schema.items, item, `${path}[${i}]`),
          )
        : [`${path} must be a list`];
    default: {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return [`${path} must be an object`];
      return [
        ...schema.required
          .filter((key) => value[key] === undefined)
          .map((key) => `${path}.${key} is missing`),
        ...Object.entries(schema.properties)
          .filter(([key]) => value[key] !== undefined)
          .flatMap(([key, sub]) =>
            schemaProblems(sub, value[key], `${path}.${key}`),
          ),
      ];
    }
  }
}

/**
 * A criterion's verdict from its votes (one per vote run, `unknown` for a
 * vote that gave none): a strict majority of all `votes.length`. `pass` with
 * a majority of passes; `fail` with a majority of fails and partials, since
 * a partial is not a pass; otherwise `unknown`.
 */
export function majority(votes) {
  const need = Math.floor(votes.length / 2) + 1;
  if (votes.filter((v) => v === "pass").length >= need) return "pass";
  if (votes.filter((v) => v === "fail" || v === "partial").length >= need)
    return "fail";
  return "unknown";
}

/**
 * The criteria in the contract's shape: each of `criteria` (`{ id, text }`,
 * as the splitting vote gave them) with the majority of `answers` (each a
 * vote's answer, or null for one that timed out or failed), and every
 * vote's verdict and evidence.
 */
export function combineVotes(criteria, answers) {
  return criteria.map(({ id, text }) => {
    const cast = answers.map(
      (answer) => answer?.criteria.find((c) => c.id === id) ?? null,
    );
    const votes = cast.map((c) => c?.verdict ?? "unknown");
    return {
      id,
      text,
      verdict: majority(votes),
      method: `majority of ${answers.length} independent grader votes; a partial is not a pass`,
      evidence: { votes, evidence: cast.map((c) => c?.evidence ?? null) },
    };
  });
}

/**
 * The quality and adversary findings, each given an id (`quality-1`,
 * `adversary-1`, ...), split into those sent to the verifier (the non-minor
 * ones, claimed defects first, at most `max`), those over the cap, and the
 * minor ones, which aren't verified.
 */
export function forVerification(quality, adversary, max) {
  // The harness's ids, over any a reporter gave: the verifier answers by them.
  const reported = [
    ...(quality?.findings ?? []).map((f, i) => ({
      ...f,
      id: `quality-${i + 1}`,
      role: "quality",
    })),
    ...(adversary?.findings ?? []).map((f, i) => ({
      ...f,
      id: `adversary-${i + 1}`,
      role: "adversary",
    })),
  ];
  const ranked = [
    ...reported.filter((f) => f.severity === "defect"),
    ...reported.filter((f) => f.severity === "quality"),
  ];
  return {
    reported,
    sent: ranked.slice(0, max),
    overCap: ranked.slice(max),
    minor: reported.filter((f) => f.severity === "minor"),
  };
}

/**
 * The findings the verifier confirmed, of those `sent` to it, with its own
 * severity, evidence and reproduction (the reporter's, when it gave none).
 * A finding it rejected, or never answered (or a verifier that timed out
 * or failed: `answer` null), is dropped.
 */
export function verifiedFindings(sent, answer) {
  const byId = new Map((answer?.verdicts ?? []).map((v) => [v.id, v]));
  return sent.flatMap((f) => {
    const verdict = byId.get(f.id);
    if (verdict?.confirmed !== true) return [];
    return [
      {
        id: f.id,
        role: f.role,
        title: f.title,
        severity: verdict.severity,
        reported: f.severity,
        evidence: verdict.evidence,
        reproduce: verdict.reproduce || f.reproduce,
      },
    ];
  });
}

/** The last result event of a CLI's output: `--output-format stream-json` (the transcript) or `json`. */
export function agentResult(stdout) {
  const lines = stdout.split("\n").filter((line) => line.trim());
  for (const line of lines.reverse()) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "result") return event;
    } catch {
      // Not an event.
    }
  }
  return null;
}

/** The CLI's arguments for one role: print mode, its transcript as stream JSON, the answer's schema, no web tools. */
export function agentArgs({ model, effort }, schema) {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(schema),
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "WebFetch,WebSearch",
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

/**
 * The agent CLI `cli` with `args`, its prompt on stdin, in its own process
 * group, killed whole at `timeoutMs` (as runCommand kills a grader). Keeps
 * all of its output: stdout is the transcript.
 */
export function runAgent(cli, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {
      // A CLI that exits without reading its prompt closes the pipe.
    });
    child.stdin.end(input);
  });
}

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** `ref` of `repo` as a full commit SHA; throws naming it when the repository has none. */
export function commitOf(repo, ref) {
  try {
    return git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    throw new Error(`${repo} has no commit ${ref}`);
  }
}

/** The original tree's state: its HEAD and its status, which grading must leave as they were. */
const treeState = (repo) =>
  `${git(repo, "rev-parse", "HEAD")}\n${git(repo, "status", "--porcelain", "--untracked-files=all")}`;

/** A digest of the roles' prompts: a prompt edited in place is another grader. */
export function promptsDigest() {
  const hash = createHash("sha256");
  for (const name of readdirSync(PROMPTS).sort())
    hash.update(`${name}\0`).update(readFileSync(join(PROMPTS, name)));
  return hash.digest("hex").slice(0, 12);
}

/** The inputs every role is given, after its prompt. */
function inputs(
  { role, base, commit, changed, checks, install, objective },
  extra,
) {
  return [
    "## Inputs",
    "",
    `Role: ${role}`,
    `Base commit: ${base}`,
    `Graded commit: ${commit} (your working directory is a scratch checkout of it)`,
    "",
    `Changed files (git diff --stat ${base} ${commit}):`,
    "",
    "```",
    changed || "(none)",
    "```",
    "",
    checks.length
      ? `The repository's declared checks:\n\n${checks.map((c) => `- \`${c}\``).join("\n")}`
      : "The repository declares no checks here: find them in its own docs and manifest.",
    "",
    install,
    "",
    ...extra,
    "The Objective:",
    "",
    "<objective>",
    objective.trim(),
    "</objective>",
    "",
  ].join("\n");
}

/**
 * Grade `commit` of `repo` against the Objective in `objective` (its
 * text), the change being `base`..`commit`. Options: `cli`, `model`,
 * `effort`, `install` (a shell command run in each scratch checkout),
 * `checks` (the repository's declared checks), `votes`, `maxFindings`,
 * `timeoutMinutes` (the whole run), `roleTimeoutMinutes`, `evidence` (the
 * directory kept with each role's prompt, transcript and answer) and `env`.
 * Returns the output: the grader contract's fields, or `error` with no
 * criteria when no grader vote split the acceptance.
 */
export async function autoGrade({
  repo,
  commit,
  base,
  objective,
  evidence,
  cli = DEFAULTS.cli,
  model = DEFAULTS.model,
  effort = DEFAULTS.effort,
  install = null,
  checks = [],
  votes = DEFAULTS.votes,
  maxFindings = DEFAULTS.maxFindings,
  timeoutMinutes = DEFAULTS.timeoutMinutes,
  roleTimeoutMinutes = DEFAULTS.roleTimeoutMinutes,
  env = process.env,
}) {
  const started = Date.now();
  const deadline = started + timeoutMinutes * 60_000;
  const graded = commitOf(repo, commit);
  const from = commitOf(repo, base);
  const before = treeState(repo);
  const changed = git(repo, "diff", "--stat", from, graded);
  const scratch = mkdtempSync(join(tmpdir(), "bench-grade-auto-"));
  mkdirSync(evidence, { recursive: true });
  const roles = [];

  /** One role, `name` (`grader-2`, `verifier`, ...), in its own scratch checkout: its answer, or null with its status. */
  async function run(name, role, label, extra = []) {
    const at = Date.now();
    const until = Math.min(at + roleTimeoutMinutes * 60_000, deadline);
    const dir = join(evidence, name);
    mkdirSync(dir, { recursive: true });
    const outcome = {
      role: name,
      status: "done",
      durationMs: 0,
      costUsd: null,
    };
    const done = (status, error) => {
      Object.assign(outcome, {
        status,
        durationMs: Date.now() - at,
        ...(error ? { error } : {}),
      });
      roles.push(outcome);
      return status === "done" ? outcome.answer : null;
    };
    if (until <= at)
      return done("timeout", "no time was left of the whole run");
    const copy = join(scratch, name);
    try {
      try {
        checkoutInto(repo, graded, copy);
        // No remote: nothing it does can be pushed.
        for (const remote of git(copy, "remote").split("\n").filter(Boolean))
          git(copy, "remote", "remove", remote);
      } catch (error) {
        return done("error", error.message);
      }
      let installed = "Nothing was installed in your checkout.";
      if (install) {
        const step = await runCommand(install, {
          cwd: copy,
          env,
          timeoutMs: until - Date.now(),
        });
        writeFileSync(join(dir, "install.txt"), step.output);
        if (step.timedOut)
          return done("timeout", `the install timed out: ${install}`);
        installed =
          step.code === 0
            ? `The repository's install command ran in your checkout: \`${install}\`.`
            : `The repository's install command \`${install}\` failed in your checkout (exit ${step.code ?? step.signal}); its output's end:\n\n\`\`\`\n${step.output.trim()}\n\`\`\``;
      }
      const prompt = `${readFileSync(join(PROMPTS, `${role}.md`), "utf8").trim()}\n\n${inputs(
        {
          role: label,
          base: from,
          commit: graded,
          changed,
          checks,
          install: installed,
          objective,
        },
        extra,
      )}`;
      writeFileSync(join(dir, "prompt.md"), prompt);
      const agent = await runAgent(
        cli,
        agentArgs({ model, effort }, SCHEMAS[role]),
        {
          cwd: copy,
          env,
          input: prompt,
          timeoutMs: until - Date.now(),
        },
      );
      writeFileSync(join(dir, "transcript.jsonl"), agent.stdout);
      if (agent.stderr) writeFileSync(join(dir, "stderr.txt"), agent.stderr);
      const result = agentResult(agent.stdout);
      if (Number.isFinite(result?.total_cost_usd))
        outcome.costUsd = result.total_cost_usd;
      if (agent.timedOut)
        return done(
          "timeout",
          `timed out after ${Math.round((until - at) / 1000)} s`,
        );
      if (
        agent.code !== 0 ||
        !result ||
        result.is_error ||
        result.subtype !== "success"
      )
        return done(
          "error",
          `the agent ${agent.code === 0 ? `ended ${result?.subtype ?? "without a result"}` : `exited ${agent.code ?? agent.signal}`}: ${agent.stderr.trim().slice(-500)}`,
        );
      let answer = result.structured_output;
      if (answer === undefined)
        try {
          answer = JSON.parse(result.result);
        } catch {
          // Checked next.
        }
      const problems = schemaProblems(SCHEMAS[role], answer);
      if (problems.length)
        return done("invalid", problems.slice(0, 5).join("; "));
      writeFileSync(
        join(dir, "answer.json"),
        `${JSON.stringify(answer, null, 2)}\n`,
      );
      outcome.answer = answer;
      return done("done");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }

  /** The grader's votes: the first to answer splits the criteria, the rest grade that list at once. */
  async function grade() {
    const answers = [];
    let criteria = null;
    while (answers.length < votes && !criteria) {
      const n = answers.length + 1;
      const answer = await run(
        `grader-${n}`,
        "grader",
        `grader, vote ${n} of ${votes}`,
      );
      answers.push(answer);
      if (answer?.criteria.length)
        criteria = answer.criteria.map(({ id, text }) => ({ id, text }));
    }
    const rest = Array.from({ length: votes - answers.length }, (_, i) => {
      const n = answers.length + i + 1;
      return run(`grader-${n}`, "grader", `grader, vote ${n} of ${votes}`, [
        "Grade exactly these criteria, by their ids, and split nothing:",
        "",
        "```json",
        JSON.stringify(criteria, null, 2),
        "```",
        "",
      ]);
    });
    answers.push(...(await Promise.all(rest)));
    return { criteria, answers };
  }

  /** Quality and adversary at once, then the verifier on their non-minor findings. */
  async function review() {
    const [quality, adversary] = await Promise.all([
      run("quality", "quality", "quality"),
      run("adversary", "adversary", "adversary"),
    ]);
    const split = forVerification(quality, adversary, maxFindings);
    const answer = split.sent.length
      ? await run("verifier", "verifier", "verifier", [
          "Findings to verify, each by its id:",
          "",
          "```json",
          JSON.stringify(
            split.sent.map(
              ({
                id,
                role,
                title,
                severity,
                evidence,
                reproduce,
                guarantee,
              }) => ({
                id,
                reportedBy: role,
                title,
                severity,
                ...(guarantee ? { guarantee } : {}),
                evidence,
                reproduce,
              }),
            ),
            null,
            2,
          ),
          "```",
          "",
        ])
      : null;
    return {
      quality,
      adversary,
      split,
      findings: verifiedFindings(split.sent, answer),
    };
  }

  let grading;
  let reviewed;
  try {
    [grading, reviewed] = await Promise.all([grade(), review()]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const warnings = [];
  if (treeState(repo) !== before)
    warnings.push(`the original tree ${repo} changed while it was graded`);
  const known = roles.every((r) => r.costUsd !== null);
  const { quality, adversary, split, findings } = reviewed;
  const mutation = quality
    ? {
        survived: quality.mutation.survived,
        killed: quality.mutation.killed,
        examples: quality.mutation.examples,
      }
    : null;
  const mutants = mutation ? mutation.survived + mutation.killed : 0;
  const output = {
    graderVersion: `grade-auto ${AUTO_GRADER_VERSION} (prompts ${promptsDigest()}; ${basename(cli)} ${model ?? "default model"}${effort ? ` ${effort}` : ""}; ${votes} votes)`,
    commit: graded,
    base: from,
    criteria: grading.criteria
      ? combineVotes(grading.criteria, grading.answers)
      : [],
    metrics: mutants ? { mutationScore: mutation.killed / mutants } : {},
    // With no reviewer's answer, nothing was looked for: no findings, not none.
    ...(quality || adversary ? { findings } : {}),
    mutation,
    verification: {
      reported: split.reported.length,
      minor: split.minor.length,
      sent: split.sent.length,
      overCap: split.overCap.length,
      confirmed: findings.length,
      rejected: split.sent.length - findings.length,
      probes: adversary?.probes ?? null,
    },
    checks: grading.answers.find((a) => a?.checks)?.checks ?? [],
    cost: {
      usd: known ? roles.reduce((sum, r) => sum + r.costUsd, 0) : null,
      byRole: Object.fromEntries(roles.map((r) => [r.role, r.costUsd])),
    },
    durationMs: Date.now() - started,
    roles: roles
      .map(({ answer, ...r }) => r)
      .sort((a, b) => a.role.localeCompare(b.role)),
    evidence,
    warnings,
  };
  if (!grading.criteria)
    output.error = `no grader vote split the acceptance into criteria: ${roles
      .filter((r) => r.role.startsWith("grader-"))
      .map((r) => `${r.role} ${r.status}${r.error ? ` (${r.error})` : ""}`)
      .join(", ")}`;
  return output;
}
