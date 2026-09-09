export interface RepositoryBranchRule {
  type: string;
  parameters?: unknown;
}

const SAFE_RULES = new Set(["deletion", "non_fast_forward", "required_linear_history"]);

const PULL_REQUEST_PARAMETERS = new Set([
  "allowed_merge_methods",
  "automatic_copilot_code_review_enabled",
  "dismissal_restriction",
  "dismiss_stale_reviews_on_push",
  "require_extra_approval_for_unattributed_changes",
  "require_code_owner_review",
  "require_last_push_approval",
  "required_approving_review_count",
  "required_review_thread_resolution",
  "required_reviewers",
]);

const REVIEW_DISMISSAL_ACTOR_TYPES = new Set([
  "User",
  "Team",
  "IntegrationInstallation",
  "RepositoryRole",
]);

const REQUIRED_REVIEWER_PARAMETERS = new Set(["file_patterns", "minimum_approvals", "reviewer"]);

const REVIEWER_IDENTITY_PARAMETERS = new Set(["id", "type"]);

const DISMISSAL_RESTRICTION_PARAMETERS = new Set(["enabled", "allowed_actors"]);

const STATUS_CHECK_PARAMETERS = new Set([
  "do_not_enforce_on_create",
  "required_status_checks",
  "strict_required_status_checks_policy",
]);

export interface RequiredCheck {
  context: string;
  integrationId?: number;
}

export interface ObservedChecks {
  observed: string[];
  observedChecks?: Array<{ context: string; integrationId: number | null }>;
}

export interface ClassicBranchProtection {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks: Array<{ context: string; app_id: number | null }>;
  } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_code_owner_reviews?: boolean;
    require_last_push_approval?: boolean;
  } | null;
  required_conversation_resolution?: { enabled?: boolean } | null;
  required_linear_history?: { enabled?: boolean } | null;
  required_signatures?: { enabled?: boolean } | null;
  restrictions?: unknown;
  lock_branch?: { enabled?: boolean } | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validActor(value: unknown): boolean {
  const actor = record(value);
  return (
    actor !== undefined &&
    typeof actor.id === "number" &&
    Number.isInteger(actor.id) &&
    typeof actor.type === "string" &&
    REVIEW_DISMISSAL_ACTOR_TYPES.has(actor.type)
  );
}

function requiredReviewerBlockers(value: unknown): {
  blockers: string[];
  requiresHumanReview: boolean;
} {
  if (!Array.isArray(value)) {
    return { blockers: ["malformed required reviewers"], requiresHumanReview: false };
  }
  const blockers: string[] = [];
  let requiresHumanReview = false;
  for (const [index, entry] of value.entries()) {
    const requirement = record(entry);
    if (!requirement) {
      blockers.push(`malformed required reviewer ${index}`);
      continue;
    }
    for (const name of Object.keys(requirement)) {
      if (!REQUIRED_REVIEWER_PARAMETERS.has(name)) {
        blockers.push(`unsupported required reviewer parameter ${name}`);
      }
    }
    const patterns = requirement.file_patterns;
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
      blockers.push(`malformed required reviewer file patterns ${index}`);
    }
    const approvals = requirement.minimum_approvals;
    if (
      typeof approvals !== "number" ||
      !Number.isInteger(approvals) ||
      approvals < 0 ||
      approvals > 10
    ) {
      blockers.push(`malformed required reviewer approval count ${index}`);
    } else if (approvals > 0) {
      requiresHumanReview = true;
    }
    const reviewer = record(requirement.reviewer);
    if (
      !reviewer ||
      typeof reviewer.id !== "number" ||
      !Number.isInteger(reviewer.id) ||
      reviewer.type !== "Team"
    ) {
      blockers.push(`malformed required reviewer identity ${index}`);
    } else {
      for (const name of Object.keys(reviewer)) {
        if (!REVIEWER_IDENTITY_PARAMETERS.has(name)) {
          blockers.push(`unsupported required reviewer identity parameter ${name}`);
        }
      }
    }
  }
  return { blockers, requiresHumanReview };
}

function dismissalRestrictionBlockers(value: unknown): string[] {
  const restriction = record(value);
  if (!restriction) return ["malformed review dismissal restriction"];
  const blockers: string[] = [];
  for (const name of Object.keys(restriction)) {
    if (!DISMISSAL_RESTRICTION_PARAMETERS.has(name)) {
      blockers.push(`unsupported review dismissal restriction parameter ${name}`);
    }
  }
  if (typeof restriction.enabled !== "boolean") {
    blockers.push("malformed review dismissal restriction enabled state");
  }
  if (
    !Array.isArray(restriction.allowed_actors) ||
    restriction.allowed_actors.some(
      (actor) =>
        !validActor(actor) ||
        Object.keys(record(actor)!).some((name) => !REVIEWER_IDENTITY_PARAMETERS.has(name)),
    )
  ) {
    blockers.push("malformed review dismissal restriction actors");
  }
  return blockers;
}

export function classicBranchProtectionRules(
  protection: ClassicBranchProtection,
): RepositoryBranchRule[] {
  const rules: RepositoryBranchRule[] = [];
  if (protection.required_status_checks) {
    const configured = new Map<string, { context: string; integration_id?: number }>();
    for (const context of protection.required_status_checks.contexts ?? []) {
      configured.set(`${context}\0*`, { context });
    }
    for (const check of protection.required_status_checks.checks) {
      configured.set(`${check.context}\0${check.app_id ?? "*"}`, {
        context: check.context,
        ...(check.app_id === null ? {} : { integration_id: check.app_id }),
      });
    }
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: protection.required_status_checks.strict ?? false,
        required_status_checks: [...configured.values()],
      },
    });
  }
  if (
    protection.required_pull_request_reviews ||
    protection.required_conversation_resolution?.enabled
  ) {
    const reviews = protection.required_pull_request_reviews;
    rules.push({
      type: "pull_request",
      parameters: {
        required_approving_review_count: reviews?.required_approving_review_count ?? 0,
        require_code_owner_review: reviews?.require_code_owner_reviews ?? false,
        require_last_push_approval: reviews?.require_last_push_approval ?? false,
        required_review_thread_resolution:
          protection.required_conversation_resolution?.enabled ?? false,
      },
    });
  }
  if (protection.required_linear_history?.enabled) {
    rules.push({ type: "required_linear_history" });
  }
  if (protection.required_signatures?.enabled) {
    rules.push({ type: "required_signatures" });
  }
  if (protection.restrictions) {
    rules.push({ type: "classic_push_restrictions" });
  }
  if (protection.lock_branch?.enabled) {
    rules.push({ type: "lock_branch" });
  }
  return rules;
}

export function branchRuleBlockers(rules: RepositoryBranchRule[]): string[] {
  const blockers: string[] = [];
  for (const rule of rules) {
    if (SAFE_RULES.has(rule.type)) {
      if (
        rule.parameters !== undefined &&
        (typeof rule.parameters !== "object" ||
          rule.parameters === null ||
          Object.keys(rule.parameters as Record<string, unknown>).length > 0)
      ) {
        blockers.push(`unsupported parameters for branch rule ${rule.type}`);
      }
      continue;
    }
    if (rule.type === "required_status_checks") {
      const parameters = (rule.parameters ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(parameters)) {
        if (!STATUS_CHECK_PARAMETERS.has(name)) {
          blockers.push(`unsupported required-status-check parameter ${name}`);
        }
      }
      const checks = parameters.required_status_checks;
      if (
        parameters.strict_required_status_checks_policy !== undefined &&
        typeof parameters.strict_required_status_checks_policy !== "boolean"
      ) {
        blockers.push("malformed strict required-status-check policy");
      }
      if (
        parameters.do_not_enforce_on_create !== undefined &&
        typeof parameters.do_not_enforce_on_create !== "boolean"
      ) {
        blockers.push("malformed required-status-check create policy");
      }
      if (!Array.isArray(checks)) {
        blockers.push("malformed required status checks");
        continue;
      }
      for (const check of checks) {
        const record = check as Record<string, unknown> | null;
        if (!record || typeof record.context !== "string" || record.context.length === 0) {
          blockers.push("malformed required status check");
          continue;
        }
        if (
          record.integration_id !== undefined &&
          record.integration_id !== null &&
          (typeof record.integration_id !== "number" || !Number.isInteger(record.integration_id))
        ) {
          blockers.push(`malformed integration id for required check ${record.context}`);
        }
      }
      continue;
    }
    if (rule.type !== "pull_request") {
      blockers.push(`unsupported branch rule ${rule.type}`);
      continue;
    }
    const parameters = (rule.parameters ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(parameters)) {
      if (!PULL_REQUEST_PARAMETERS.has(name)) {
        blockers.push(`unsupported pull-request parameter ${name}`);
      }
    }
    const approvals = parameters.required_approving_review_count ?? 0;
    if (typeof approvals !== "number" || !Number.isInteger(approvals) || approvals < 0) {
      blockers.push("malformed required pull-request review count");
    }
    for (const name of [
      "automatic_copilot_code_review_enabled",
      "dismiss_stale_reviews_on_push",
      "require_extra_approval_for_unattributed_changes",
      "require_code_owner_review",
      "require_last_push_approval",
      "required_review_thread_resolution",
    ]) {
      if (parameters[name] !== undefined && typeof parameters[name] !== "boolean") {
        blockers.push(`malformed pull-request parameter ${name}`);
      }
    }
    let requiredReviewerNeedsHuman = false;
    if (parameters.required_reviewers !== undefined) {
      const result = requiredReviewerBlockers(parameters.required_reviewers);
      blockers.push(...result.blockers);
      requiredReviewerNeedsHuman = result.requiresHumanReview;
    }
    if (parameters.dismissal_restriction !== undefined) {
      blockers.push(...dismissalRestrictionBlockers(parameters.dismissal_restriction));
    }
    // GitHub documents the unattributed-Copilot flag as adding one approval only
    // when the ruleset already requires approvals. Conversation resolution and
    // dismissal restrictions likewise constrain reviews without creating one.
    // GitHub mergeability and the merge mutation remain the fail-closed gate for
    // an actual unresolved conversation or blocking review.
    if (
      (typeof approvals === "number" && approvals > 0) ||
      requiredReviewerNeedsHuman ||
      parameters.require_code_owner_review === true ||
      parameters.require_last_push_approval === true ||
      parameters.automatic_copilot_code_review_enabled === true
    ) {
      blockers.push("required human pull-request review");
    }
    const methods = parameters.allowed_merge_methods;
    if (methods !== undefined) {
      if (
        !Array.isArray(methods) ||
        methods.some((method) => !["merge", "squash", "rebase"].includes(String(method)))
      ) {
        blockers.push("malformed allowed merge methods");
      } else if (!methods.includes("squash")) {
        blockers.push("squash merge is not allowed");
      }
    }
  }
  return [...new Set(blockers)];
}

export function requiredChecks(rules: RepositoryBranchRule[]): RequiredCheck[] {
  const requirements = new Map<string, RequiredCheck>();
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const parameters = (rule.parameters ?? {}) as Record<string, unknown>;
    const checks = Array.isArray(parameters.required_status_checks)
      ? parameters.required_status_checks
      : [];
    for (const check of checks) {
      if (
        check !== null &&
        typeof check === "object" &&
        typeof (check as Record<string, unknown>).context === "string"
      ) {
        const record = check as { context: string; integration_id?: unknown };
        const integrationId =
          typeof record.integration_id === "number" && Number.isInteger(record.integration_id)
            ? record.integration_id
            : undefined;
        const requirement = {
          context: record.context,
          ...(integrationId === undefined ? {} : { integrationId }),
        };
        requirements.set(`${record.context}\0${integrationId ?? "*"}`, requirement);
      }
    }
  }
  return [...requirements.values()];
}

export function requiredCheckContexts(rules: RepositoryBranchRule[]): string[] {
  return [...new Set(requiredChecks(rules).map((check) => check.context))];
}

export function missingRequiredChecks(
  rules: RepositoryBranchRule[],
  evidence: ObservedChecks,
): string[] {
  const observations =
    evidence.observedChecks ??
    evidence.observed.map((context) => ({
      context,
      integrationId: null,
    }));
  return requiredChecks(rules)
    .filter(
      (required) =>
        !observations.some(
          (observed) =>
            observed.context === required.context &&
            (required.integrationId === undefined ||
              observed.integrationId === required.integrationId),
        ),
    )
    .map((required) =>
      required.integrationId === undefined
        ? required.context
        : `${required.context} (GitHub App ${required.integrationId})`,
    );
}
