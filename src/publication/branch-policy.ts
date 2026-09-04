export interface RepositoryBranchRule {
  type: string;
  parameters?: unknown;
}

const SAFE_RULES = new Set(["deletion", "non_fast_forward", "required_linear_history"]);

const PULL_REQUEST_PARAMETERS = new Set([
  "allowed_merge_methods",
  "automatic_copilot_code_review_enabled",
  "dismiss_stale_reviews_on_push",
  "require_code_owner_review",
  "require_last_push_approval",
  "required_approving_review_count",
  "required_review_thread_resolution",
]);

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
      "require_code_owner_review",
      "require_last_push_approval",
      "required_review_thread_resolution",
    ]) {
      if (parameters[name] !== undefined && typeof parameters[name] !== "boolean") {
        blockers.push(`malformed pull-request parameter ${name}`);
      }
    }
    if (
      (typeof approvals === "number" && approvals > 0) ||
      parameters.require_code_owner_review === true ||
      parameters.require_last_push_approval === true ||
      parameters.required_review_thread_resolution === true ||
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
