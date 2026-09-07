export type CriterionValidationTier =
  | "mechanical"
  | "semantic"
  | "visual"
  | "deterministic-simulation";

export type CriterionValidationDesign = {
  tier: CriterionValidationTier;
  criteria: string[];
  rationale: string;
  /** Exact entries from the Work Item's grounded validationCommands. */
  evidenceCommands: string[];
};

export type CriterionRisk =
  | "ordinary"
  | "safety"
  | "security"
  | "destructive-action"
  | "accounting"
  | "recovery";

export type CriterionRiskAssessment = { criterion: string; risk: CriterionRisk };

const PROTECTED_RISK_PATTERNS: ReadonlyArray<[Exclude<CriterionRisk, "ordinary">, RegExp]> = [
  ["safety", /\b(?:safe(?:ty|ly)?|hazard|injur(?:y|ies)|danger(?:ous)?|emergency)\b/i],
  [
    "security",
    /\b(?:security|auth(?:entication|orization)?|permission|privilege|acl|access control|credential|secret|password|api[- ]?keys?|access[- ]?keys?|private[- ]?keys?|encrypt(?:ion|ed)?|decrypt(?:ion|ed)?|(?:expos(?:e[ds]?|ing)|leak(?:s|ed|ing)?|disclos(?:e[ds]?|ing)) (?:a |an |the )?(?:secret|credential|password|key|private|sensitive|user data|customer data))\b/i,
  ],
  [
    "destructive-action",
    /\b(?:destructive|overwrit(?:e[ds]?|ing|ten)|eras(?:e[ds]?|ing|ure)|purg(?:e[ds]?|ing)|wip(?:e[ds]?|ing)|data loss|corrupt(?:ion|ed|s|ing)?|(?:delet(?:e[ds]?|ing)|remov(?:e[ds]?|ing)|truncat(?:e[ds]?|ing)|drop(?:s|ped|ping)?) (?:a |an |the )?(?:file|record|data|account|resource|database|table|configuration|config)|revok(?:e[ds]?|ing) (?:a |an |the )?(?:credential|key|permission|access|token))\b/i,
  ],
  [
    "accounting",
    /\b(?:(?:charg(?:e[ds]?|ing)|refund(?:s|ed|ing)?|bill(?:s|ed|ing)?|debit(?:s|ed|ing)?|credit(?:s|ed|ing)?) (?:a |an |the )?(?:account|customer|user|payment|invoice)|(?:record(?:s|ed|ing)?|report(?:s|ed|ing)?|calculat(?:e[ds]?|ing)|reconcil(?:e[ds]?|ing)|enforc(?:e[ds]?|ing)|limit(?:s|ed|ing)?|track(?:s|ed|ing)?) (?:a |an |the )?(?:cost|usage|quota|ledger|transaction|token budget))\b/i,
  ],
  [
    "recovery",
    /\b(?:recover(?:y|able)?|rollback|restore|resume|checkpoint|failover|disaster recovery|backup|fenc(?:e|ing)|idempoten(?:t|cy))\b/i,
  ],
];

export function inferCriterionRisk(criterion: string): CriterionRisk {
  return PROTECTED_RISK_PATTERNS.find(([, pattern]) => pattern.test(criterion))?.[0] ?? "ordinary";
}

export function validateCriterionValidationDesign(args: {
  itemId: string;
  acceptance: readonly string[];
  validationCommands: readonly string[];
  validation: readonly CriterionValidationDesign[];
  criterionRisks: readonly CriterionRiskAssessment[];
  deterministicSimulation: boolean;
  visualValidation: boolean;
}): void {
  const { itemId, acceptance, validationCommands, validation, criterionRisks } = args;
  if (validation.length < 1 || validation.length > 4)
    throw new Error(`invalid validation design in ${itemId}`);
  if (new Set(validation.map((entry) => entry.tier)).size !== validation.length)
    throw new Error(`invalid validation design in ${itemId}: duplicate tier`);
  const accepted = new Set(acceptance);
  const associated = new Set<string>();
  for (const entry of validation) {
    if (
      entry.criteria.length < 1 ||
      entry.criteria.length > 64 ||
      !entry.rationale ||
      entry.rationale.length > 2_000 ||
      entry.evidenceCommands.length > 32
    )
      throw new Error(`invalid validation design in ${itemId}`);
    if (new Set(entry.criteria).size !== entry.criteria.length)
      throw new Error(`invalid validation design in ${itemId}: duplicate criterion in tier`);
    if (new Set(entry.evidenceCommands).size !== entry.evidenceCommands.length)
      throw new Error(`invalid validation design in ${itemId}: duplicate evidence command`);
    if (entry.criteria.some((criterion) => !accepted.has(criterion)))
      throw new Error(`validation design references unknown acceptance criterion in ${itemId}`);
    if (entry.evidenceCommands.some((command) => !validationCommands.includes(command)))
      throw new Error(`validation design references ungrounded command in ${itemId}`);
    if (entry.tier !== "semantic" && entry.evidenceCommands.length === 0)
      throw new Error(`deterministic validation lacks command evidence in ${itemId}`);
    if (entry.tier === "deterministic-simulation" && !args.deterministicSimulation)
      throw new Error(`deterministic simulation is not repository-grounded in ${itemId}`);
    if (entry.tier === "visual" && !args.visualValidation)
      throw new Error(`visual validation is not repository-grounded in ${itemId}`);
    entry.criteria.forEach((criterion) => associated.add(criterion));
  }
  if (acceptance.some((criterion) => !associated.has(criterion)))
    throw new Error(`unvalidated acceptance criterion in ${itemId}`);
  if (
    criterionRisks.length !== acceptance.length ||
    new Set(criterionRisks.map((entry) => entry.criterion)).size !== criterionRisks.length ||
    criterionRisks.some((entry) => !accepted.has(entry.criterion))
  )
    throw new Error(`invalid criterion risk assessment in ${itemId}`);
  const deterministic = new Set(
    validation
      .filter((entry) => entry.tier === "mechanical" || entry.tier === "deterministic-simulation")
      .flatMap((entry) => entry.criteria),
  );
  const risks = new Map(criterionRisks.map((entry) => [entry.criterion, entry.risk]));
  const understatedRisk = acceptance.find(
    (criterion) =>
      risks.get(criterion) === "ordinary" && inferCriterionRisk(criterion) !== "ordinary",
  );
  if (understatedRisk)
    throw new Error(`criterion risk is understated in ${itemId}: ${understatedRisk}`);
  const missingProtectedGate = acceptance.find(
    (criterion) => risks.get(criterion) !== "ordinary" && !deterministic.has(criterion),
  );
  if (missingProtectedGate)
    throw new Error(`protected-risk criterion lacks deterministic validation in ${itemId}`);
}
