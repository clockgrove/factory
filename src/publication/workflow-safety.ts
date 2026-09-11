import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseDocument } from "yaml";

import type { WorkflowSafetyProfile } from "../approval.js";

export function isReviewOnlyWorkflowSurface(path: string): boolean {
  return /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/i.test(path);
}

async function readBoundedWorkflow(root: string, path: string): Promise<string> {
  const target = join(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > 64 * 1024)
    throw new Error(`review-only workflow is not a bounded regular file: ${path}`);
  return readFile(target, "utf8");
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactReadPermissions(value: unknown): boolean {
  const permissions = plainRecord(value);
  return Boolean(
    permissions && Object.keys(permissions).length === 1 && permissions.contents === "read",
  );
}

function parseBoundedWorkflow(text: string, path: string): Record<string, unknown> {
  if (
    Buffer.byteLength(text, "utf8") > 64 * 1024 ||
    text.includes("\0") ||
    text.includes("\t") ||
    /(?:^|[\s:[{,])[&*][A-Za-z_][A-Za-z0-9_-]*/m.test(text) ||
    /(?:^|\s)![A-Za-z<]/m.test(text) ||
    /\bsecrets\b/i.test(text) ||
    /\bgithub\s*(?:\.|\[\s*["'])\s*token\b/i.test(text)
  )
    throw new Error(`review-only workflow has unsafe trigger or credential authority: ${path}`);
  const document = parseDocument(text, {
    schema: "core",
    uniqueKeys: true,
    merge: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error(`review-only workflow is not unambiguous bounded YAML: ${path}`);
  const value = plainRecord(document.toJS({ maxAliasCount: 0 }));
  if (!value) throw new Error(`review-only workflow root is invalid: ${path}`);
  return value;
}

function assertCannotRunWhenFeatureIsPublished(
  text: string,
  path: string,
  protectedBranch: string,
): void {
  const value = parseBoundedWorkflow(text, path);
  const on = plainRecord(value.on);
  if (!on) throw new Error(`base workflow has an invalid trigger map: ${path}`);
  const unsafe = Object.keys(on).filter((trigger) =>
    new Set([
      "create",
      "pull_request",
      "pull_request_target",
      "workflow_run",
      "workflow_call",
      "workflow_dispatch",
      "repository_dispatch",
    ]).has(trigger.toLowerCase()),
  );
  if (unsafe.length > 0)
    throw new Error(
      `base workflow may run or be chained when a feature ref or pull request is published (${unsafe.join(", ")}): ${path}`,
    );
  if (Object.hasOwn(on, "push")) {
    const push = plainRecord(on.push);
    if (
      !push ||
      Object.keys(push).length !== 1 ||
      !Array.isArray(push.branches) ||
      push.branches.length !== 1 ||
      push.branches[0] !== protectedBranch
    )
      throw new Error(
        `base workflow push trigger is not restricted to protected branch ${protectedBranch}: ${path}`,
      );
  }
}

function inspectWorkflowNode(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectWorkflowNode(child, path);
    return;
  }
  const record = plainRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (["id-token", "token", "github-token", "secrets"].includes(normalized))
      throw new Error(`review-only workflow declares credential authority: ${path}`);
    if (normalized === "uses") {
      if (
        typeof child !== "string" ||
        !/^(?:actions\/(?:checkout|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/i.test(child)
      )
        throw new Error(
          `review-only workflow action is not allowlisted and commit-pinned: ${path}`,
        );
      if (/^actions\/checkout@/i.test(child)) {
        const inputs = plainRecord(record.with);
        if (inputs?.["persist-credentials"] !== false)
          throw new Error(
            `review-only workflow checkout must disable persisted credentials: ${path}`,
          );
      }
    }
    inspectWorkflowNode(child, path);
  }
}

async function allWorkflowPaths(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, ".github/workflows"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > 512) throw new Error("workflow directory exceeds inspection bound");
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

/**
 * Publication-boundary decision for workflow-bearing artifacts. Validation
 * and semantic review intentionally happen earlier so unsafe bytes can be
 * retained behind a human pre-publication gate. Passing this function means
 * creating the feature ref and opening its PR cannot trigger the changed
 * workflow; integration remains independently human-authorized.
 */
export async function assertReviewOnlyWorkflowArtifacts(
  root: string,
  sensitivePaths: string[],
  protectedBranch?: string,
  changedPackageScripts: readonly string[] = [],
  baseWorkflows: ReadonlyMap<string, string> = new Map(),
  actionsProfile?: WorkflowSafetyProfile,
): Promise<Set<string>> {
  const workflows = sensitivePaths.filter(isReviewOnlyWorkflowSurface);
  if (workflows.length > 0 && !protectedBranch)
    throw new Error("workflow publication safety requires the exact protected base branch");
  if (
    protectedBranch &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(protectedBranch) ||
      protectedBranch.split("/").some((part) => part === "." || part === ".." || part === ""))
  )
    throw new Error("workflow publication base branch is invalid");
  if (
    workflows.length > 0 &&
    (!actionsProfile ||
      actionsProfile.defaultWorkflowPermissions !== "read" ||
      actionsProfile.referencedSecrets.length > 0)
  )
    throw new Error(
      "workflow publication requires observed read-only repository Actions permissions and no pull-request workflow secrets",
    );
  const permitted = new Set<string>();
  for (const path of workflows) {
    const text = await readBoundedWorkflow(root, path);
    const value = parseBoundedWorkflow(text, path);
    const on = plainRecord(value?.on);
    const push = plainRecord(on?.push);
    if (
      !value ||
      !on ||
      Object.keys(on).length !== 1 ||
      !push ||
      Object.keys(push).length !== 1 ||
      !Array.isArray(push.branches) ||
      push.branches.length !== 1 ||
      push.branches[0] !== protectedBranch
    )
      throw new Error(
        `review-only workflow must trigger only after a push to protected branch ${protectedBranch}: ${path}`,
      );
    if (!exactReadPermissions(value.permissions))
      throw new Error(`review-only workflow must grant only contents: read: ${path}`);
    const jobs = plainRecord(value.jobs);
    if (!jobs || Object.keys(jobs).length === 0 || Object.keys(jobs).length > 128)
      throw new Error(`review-only workflow has an invalid jobs map: ${path}`);
    for (const job of Object.values(jobs)) {
      const definition = plainRecord(job);
      if (!definition) throw new Error(`review-only workflow job is invalid: ${path}`);
      if (definition.permissions !== undefined && !exactReadPermissions(definition.permissions))
        throw new Error(`review-only workflow job may not broaden permissions: ${path}`);
      if (
        typeof definition["runs-on"] !== "string" ||
        !/^ubuntu-(?:latest|\d{2}\.\d{2})$/.test(definition["runs-on"])
      )
        throw new Error(`review-only workflow may use only GitHub-hosted Ubuntu runners: ${path}`);
    }
    inspectWorkflowNode(value, path);
    permitted.add(path);
  }
  const changed = new Set(workflows);
  const candidatePaths = new Set(await allWorkflowPaths(root));
  for (const [path, text] of baseWorkflows) {
    if (!isReviewOnlyWorkflowSurface(path))
      throw new Error(`base workflow inventory contains an invalid path: ${path}`);
    if (sensitivePaths.length > 0)
      assertCannotRunWhenFeatureIsPublished(text, path, protectedBranch!);
    // Shell steps, reusable actions, and generated arguments make proving a
    // negative invocation relationship undecidable here. If an already-live
    // workflow exists, any package-script authority change therefore waits for
    // human pre-publication approval. A newly introduced safe workflow is
    // excluded above because it cannot run until protected-branch integration.
    if (changedPackageScripts.length > 0)
      throw new Error(
        `base workflow ${path} may acquire changed package-script authority (${changedPackageScripts.join(", ")}); human pre-publication approval is required`,
      );
  }
  // A candidate workflow absent from the exact base is a new file. A changed
  // path present in both sets has already had both the candidate policy and
  // the live base trigger policy checked above.
  for (const path of changed)
    if (!candidatePaths.has(path))
      throw new Error(`review-only workflow is absent from the candidate tree: ${path}`);
  return permitted;
}
