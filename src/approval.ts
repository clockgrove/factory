/**
 * Blast-radius review for self-approving workflow runs (§10.6).
 *
 * GitHub holds workflow runs on coding-agent pull requests in `action_required`
 * until a maintainer clicks "Approve and run workflows". That click is a
 * security control, and Factory only gets to make it on the human's behalf if it
 * can answer the question the click is really asking: *what can this run do that
 * I would regret?*
 *
 * Approving a run is not itself destructive — it starts a workflow. The damage
 * a run can do is bounded entirely by two things:
 *
 *   1. **What the run executes.** A diff that edits the workflow definition, an
 *      action it calls, or anything the package manager runs at install time can
 *      redefine the job itself. Then "run the tests" silently becomes "run
 *      whatever the diff says", and reviewing the source files told you nothing.
 *   2. **What the run can reach.** A job with a read-only token and no secrets
 *      can leak nothing and write nothing; the worst case is a wasted runner
 *      minute. Grant it write permissions or real secrets and the same code is
 *      suddenly capable of pushing to the repo or exfiltrating credentials.
 *
 * Everything below is a check against one of those two. Note the deliberate
 * asymmetry with ordinary code review: we do *not* try to decide whether the
 * agent's source changes are "good". Running the agent's code is the entire
 * point of CI, and a test file is as capable of `fetch()`ing as any other file.
 * The question is strictly whether approving escalates privilege beyond "run the
 * tests in a sandbox that holds nothing worth stealing".
 *
 * Deny-by-default: anything unrecognised, unreadable or truncated is unsafe.
 */

/** A path that, if changed, lets the diff rewrite what CI executes. */
interface PathRule {
  test: (path: string) => boolean;
  reason: (path: string) => string;
}

const lower = (path: string): string => path.toLowerCase();

const basename = (path: string): string => {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
};

/**
 * Lockfiles and manifests are not "just config": `npm ci` executes whatever
 * `preinstall`/`install`/`postinstall` scripts the dependency tree declares,
 * with the job's full permissions, before a single test runs. A one-line
 * lockfile edit is arbitrary code execution in CI.
 */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lockb",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "pyproject.toml",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "composer.json",
  "composer.lock",
]);

/** Registry/proxy configuration — redirects where dependency code comes from. */
const REGISTRY_FILES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  "pip.conf",
]);

const PATH_RULES: PathRule[] = [
  {
    test: (p) => lower(p).startsWith(".github/workflows/"),
    reason: (p) =>
      `${p} is a workflow definition — approving would run the diff's own version of CI, including any permissions, secrets or runner it chooses to grant itself`,
  },
  {
    test: (p) => lower(p).startsWith(".github/actions/"),
    reason: (p) =>
      `${p} is a composite action invoked by CI, so its contents execute inside the job`,
  },
  {
    test: (p) => {
      const name = lower(basename(p));
      return name === "action.yml" || name === "action.yaml";
    },
    reason: (p) => `${p} defines an action whose steps execute inside the job`,
  },
  {
    test: (p) => lower(p).startsWith(".github/"),
    reason: (p) =>
      `${p} is repository automation configuration; changes here can alter how CI is triggered or what it is allowed to do`,
  },
  {
    test: (p) => DEPENDENCY_FILES.has(lower(basename(p))),
    reason: (p) =>
      `${p} controls the dependency tree, and installing dependencies executes their lifecycle scripts in CI before any test runs`,
  },
  {
    test: (p) => REGISTRY_FILES.has(lower(basename(p))),
    reason: (p) =>
      `${p} controls where dependency code is fetched from, so it can redirect installs to an untrusted source`,
  },
];

export interface WorkflowSafetyProfile {
  /**
   * The repo-wide default token permission granted to workflow runs
   * (`GET /repos/{owner}/{repo}/actions/permissions/workflow`). `write` means a
   * job can push commits, move refs and edit releases using nothing but the
   * built-in `GITHUB_TOKEN`.
   */
  defaultWorkflowPermissions: "read" | "write" | "unknown";
  /**
   * Secret names referenced by workflows that run on `pull_request`, excluding
   * the automatic `GITHUB_TOKEN`. A non-empty list means an approved run has
   * real credentials in its environment and could exfiltrate them.
   */
  referencedSecrets: string[];
}

export interface BlastRadiusInput {
  /** Repo-relative paths changed by the pull request. */
  changedFilePaths: string[];
  /**
   * True when the file list is known to be incomplete (paged out or truncated).
   * A partial list cannot support a safety claim, so it denies.
   */
  truncated: boolean;
  profile: WorkflowSafetyProfile;
}

export interface BlastRadiusVerdict {
  /** True only when every check passed and the file list was complete. */
  safe: boolean;
  /** Human-readable reasons the run must not be self-approved. */
  blockers: string[];
  /** What was affirmatively checked, for the audit trail on the issue. */
  assurances: string[];
  /**
   * True when the *repository-wide* half of the review passed, regardless of
   * what this particular diff does.
   *
   * The review answers two different questions, and they justify two different
   * actions. "Does this diff change what CI executes?" justifies approving
   * *this run*. "Is a run in this repository bounded at all?" — read-only
   * default token, no secrets reachable from a pull-request workflow, no
   * self-hosted runner — is a property of the repository that holds for every
   * run, and is the only thing that can justify relaxing a repository-wide
   * setting (§10.7).
   *
   * Kept separate so the broader action cannot be authorised by the narrower
   * evidence: a diff that happens to be clean says nothing about whether the
   * *next* one will be.
   */
  repoScopeSafe: boolean;
  /** The subset of `blockers` that are properties of the repository. */
  repoScopeBlockers: string[];
}

/**
 * Decide whether Factory may approve a held workflow run on its own authority.
 *
 * Pure and offline by design: every input is a fact already fetched, so the
 * decision is unit-testable and reproducible from the record written to the
 * issue.
 */
export function assessBlastRadius(input: BlastRadiusInput): BlastRadiusVerdict {
  const blockers: string[] = [];
  const repoScopeBlockers: string[] = [];
  const assurances: string[] = [];

  if (input.truncated) {
    blockers.push(
      "the pull request's file list is truncated, so the change cannot be shown to leave CI's definition alone",
    );
  }

  if (input.changedFilePaths.length === 0 && !input.truncated) {
    blockers.push(
      "the pull request changes no files, which means there is nothing to test and the run's purpose is unclear",
    );
  }

  const flagged: string[] = [];
  for (const path of input.changedFilePaths) {
    const rule = PATH_RULES.find((candidate) => candidate.test(path));
    if (rule) flagged.push(rule.reason(path));
  }
  blockers.push(...flagged);

  if (flagged.length === 0 && input.changedFilePaths.length > 0 && !input.truncated) {
    assurances.push(
      `all ${input.changedFilePaths.length} changed path(s) are ordinary source or test files: the workflow definition, the actions it calls, the dependency manifests and the registry configuration are all untouched, so approving runs the workflow already on the base branch`,
    );
  }

  if (input.profile.defaultWorkflowPermissions === "write") {
    repoScopeBlockers.push(
      "workflow runs in this repository get a write-scoped GITHUB_TOKEN by default, so an approved run could push commits or move refs rather than merely reporting a result",
    );
  } else if (input.profile.defaultWorkflowPermissions === "read") {
    assurances.push(
      "workflow runs get a read-only GITHUB_TOKEN by default, so the job can report a result but cannot write to the repository",
    );
  } else {
    repoScopeBlockers.push(
      "the repository's default workflow permissions could not be read, so the token scope an approved run would receive is unknown",
    );
  }

  if (input.profile.referencedSecrets.length > 0) {
    repoScopeBlockers.push(
      `pull-request workflows reference ${input.profile.referencedSecrets.length} secret(s) (${input.profile.referencedSecrets.join(", ")}), so an approved run would have real credentials available to exfiltrate`,
    );
  } else {
    assurances.push(
      "no pull-request workflow references any secret beyond the automatic GITHUB_TOKEN, so there are no credentials in the job to lose",
    );
  }

  blockers.push(...repoScopeBlockers);
  return {
    safe: blockers.length === 0,
    blockers,
    assurances,
    repoScopeSafe: repoScopeBlockers.length === 0,
    repoScopeBlockers,
  };
}

/**
 * Extract secret names referenced by a workflow file.
 *
 * Deliberately a regex over the raw text rather than a YAML parse: the goal is
 * to notice *any* mention of a secret, including inside a `run:` block or a
 * string that a parser would hand back as an opaque scalar. Over-reporting is
 * safe here — a false positive costs one escalation, a false negative approves a
 * job holding live credentials.
 *
 * `GITHUB_TOKEN` is excluded because it is minted per-run and already governed
 * by `defaultWorkflowPermissions`, which is checked separately.
 */
export function referencedSecretNames(workflowYaml: string): string[] {
  const found = new Set<string>();
  // `secrets: inherit` hands a called workflow every repository and environment
  // secret without naming one, so neither pattern below would see it. The callee
  // is invisible too: a reusable workflow is triggered by `workflow_call`, so it
  // is skipped as not pull-request-triggered. Both halves evade the scan by
  // construction rather than by coincidence, so match the caller's syntax.
  if (/^\s*secrets\s*:\s*inherit\s*$/m.test(workflowYaml)) {
    found.add("<inherit: every repository secret>");
  }
  const patterns = [
    /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /secrets\[\s*['"]([^'"]+)['"]\s*\]/g,
  ];
  for (const pattern of patterns) {
    for (const match of workflowYaml.matchAll(pattern)) {
      const name = match[1];
      if (name && name.toUpperCase() !== "GITHUB_TOKEN") found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * Extract the body of a workflow's `on:` key, whatever syntax it uses.
 *
 * Returns the inline value for `on: pull_request` and `on: [push, pull_request]`,
 * or the indented block for the mapping and sequence forms. Returns `null` when
 * no `on:` key can be found at all, which callers must treat as "undetermined"
 * rather than "no".
 */
function extractOnSection(workflowYaml: string): string | null {
  const lines = workflowYaml.split(/\r?\n/);
  const index = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
  if (index === -1) return null;

  const header = lines[index] ?? "";
  const inline = header.slice(header.indexOf(":") + 1).trim();
  if (inline && !inline.startsWith("#")) return inline;

  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    // A non-indented, non-empty line starts the next top-level key.
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

/**
 * True when a workflow can be triggered by a pull request, and is therefore in
 * scope for this review. Anything else (a release or cron workflow) is not
 * something approving a PR run can start.
 *
 * Handles all three legal spellings — `on: pull_request`, `on: [push,
 * pull_request]` and the indented mapping or sequence forms. An earlier version
 * required a colon directly after the trigger name, which silently missed the
 * two most common syntaxes and caused those workflows' secrets to be ignored
 * entirely. The false negative is the dangerous direction here, so a workflow
 * whose triggers cannot be determined is treated as pull-request-triggered.
 */
export function triggersOnPullRequest(workflowYaml: string): boolean {
  const section = extractOnSection(workflowYaml);
  if (section === null) return true;
  return /\bpull_request(_target)?\b/.test(section);
}

/**
 * True when a workflow explicitly asks for a self-hosted runner.
 *
 * "A sandbox holding nothing worth stealing" is false on a self-hosted runner
 * regardless of token scope or secrets: persistent state, network position and
 * previous jobs' residue are all reachable from it.
 *
 * Deliberately narrow — it matches the literal `self-hosted` label rather than
 * trying to decide whether an arbitrary `runs-on` expression resolves to a
 * GitHub-hosted image. Treating every `${{ matrix.os }}` as suspect would deny
 * on ordinary repositories, and the residual risk is a repository that reaches a
 * self-hosted runner through an indirection, which is rare and visible.
 */
export function usesSelfHostedRunner(workflowYaml: string): boolean {
  return /\bself-hosted\b/.test(workflowYaml);
}
