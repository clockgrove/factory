import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { option } from "./cli-flags.js";
import { DEFAULT_CONTEXT_LOOKUP_BOUNDS } from "./compiler/context.js";
import type { FactoryConfig } from "./config.js";
import { pinnedGit } from "./process.js";
import { workflowRecipeAdmissionContext } from "./runner/planning.js";
import {
  objectiveWorkflowRecipeSelector,
  previewWorkflowRecipe,
  resolveWorkflowRecipe,
} from "./workflow-recipes.js";

/** A local preview neither creates continuation state nor admits provider work. */
export function runWorkflowRecipePreview(
  config: FactoryConfig,
  args: string[],
): void {
  const file = option(args, "file");
  if (!file || !isAbsolute(file))
    throw new Error("recipe requires --file ABSOLUTE_OBJECTIVE");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Recipe preview requires a regular Objective file");
  const body = readFileSync(file, "utf8");
  const selection = objectiveWorkflowRecipeSelector(body);
  if (!selection)
    throw new Error("Objective has no Workflow recipe declaration");
  const baseSha = pinnedGit(config.checkout, "rev-parse", "HEAD");
  const resolution = resolveWorkflowRecipe({
    selection,
    checkout: config.checkout,
    baseSha,
    maxBytes:
      config.planningContext?.bounds.maxBytes ??
      DEFAULT_CONTEXT_LOOKUP_BOUNDS.maxBytes,
  });
  const preview = previewWorkflowRecipe({
    resolution,
    admission: workflowRecipeAdmissionContext(config, body),
  });
  console.log(
    JSON.stringify(
      {
        ...preview,
        repository: config.repository,
        baseSha,
        admission: "preview-only",
      },
      null,
      2,
    ),
  );
  if (preview.status === "blocked") process.exitCode = 1;
}
