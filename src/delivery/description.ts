import type { DeliveryRequest } from "../contracts.js";
import { redactDiagnosticDetail } from "../diagnostics.js";
import { pinnedGit, pinnedGitRaw } from "../process.js";
import type { ValidationEvidence } from "../validation-evidence.js";

/** Publication uses the already projected goal and controller facts, never worker output. */
export function deliveryDescription(
  checkout: string,
  request: Pick<DeliveryRequest, "item" | "baseSha" | "treeSha" | "changeRef">,
  context?: {
    repository: string;
    objective: number;
    issue: number;
    validation?: ValidationEvidence;
  },
  secrets: string[] = [],
): string {
  if (
    pinnedGit(checkout, "rev-parse", `${request.changeRef}^{tree}`) !==
    request.treeSha
  )
    throw new Error("Pull request description candidate tree mismatch");
  const safe = (value: string) => redactDiagnosticDetail(value, secrets);
  const code = (value: string) =>
    `<code>${safe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;")}</code>`;
  const parts: string[] = [
    safe(request.item.goal).trim().slice(0, 4000) ||
      "This candidate contains the changes listed below.",
  ];
  if (context) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
      !Number.isSafeInteger(context.objective) ||
      context.objective <= 0 ||
      !Number.isSafeInteger(context.issue) ||
      context.issue <= 0
    )
      throw new Error("Pull request description issue binding is invalid");
    const issues = `https://github.com/${context.repository}/issues`;
    parts.push(
      `Work Item: [#${context.issue}](${issues}/${context.issue}) · Objective: [#${context.objective}](${issues}/${context.objective})`,
    );
  }
  const entries = pinnedGitRaw(
    checkout,
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    request.baseSha,
    request.changeRef,
    "--",
  )
    .toString("utf8")
    .split("\0");
  const changes: string[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const verb =
      { A: "Adds", D: "Removes", M: "Updates", T: "Changes the type of" }[
        entries[index]!
      ] ?? "Changes";
    changes.push(`${verb} ${code(entries[index + 1]!)}`);
  }
  parts.push(
    changes.length
      ? `Changes in this candidate:\n\n${changes
          .slice(0, 40)
          .map((change) => `- ${change}`)
          .join(
            "\n",
          )}${changes.length > 40 ? `\n- ${changes.length - 40} further changed paths.` : ""}`
      : "This candidate has no file changes relative to its delivery base.",
  );
  const evidence = context?.validation;
  const verified =
    evidence?.treeSha === request.treeSha &&
    evidence.commands.length === request.item.validation.length &&
    evidence.commands.every(
      (receipt, index) =>
        receipt.index === index &&
        receipt.command === request.item.validation[index]!.command &&
        receipt.treeSha === request.treeSha &&
        receipt.passed === true &&
        receipt.exitCode === 0,
    );
  parts.push(
    verified && evidence.commands.length
      ? `Controller validation passed on this candidate:\n\n${evidence.commands
          .slice(0, 20)
          .map((receipt) => `- ${code(receipt.command)}`)
          .join(
            "\n",
          )}${evidence.commands.length > 20 ? `\n- ${evidence.commands.length - 20} further commands passed.` : ""}`
      : "Controller command validation receipts are unavailable for this candidate.",
  );
  parts.push(
    `Candidate commit: ${code(request.changeRef)}\n\nCandidate tree: ${code(request.treeSha)}`,
  );
  return parts.join("\n\n");
}
