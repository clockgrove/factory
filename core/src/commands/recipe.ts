/**
 * `factory recipe`: its options, help and check, and what it does.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadConfig } from "../config.js";
import { gitEnvironment } from "../git.js";
import { BaseFiles } from "../planning/facts.js";
import {
  markdownBlocks,
  previewRecipe,
  recipeInstallation,
  selectRecipe,
} from "../planning/recipes.js";
import { adaptiveWorkflow } from "../validate.js";
import type { Args, Command } from "./shared.js";

export const spec: Command = {
  args: "",
  flags: { file: "value" },
  help: "Preview the Workflow recipe of the Objective in --file ABSOLUTE_PATH (Markdown) at the checkout's HEAD, with no model call; exits 1 when it can't be used",
  check: (args) => {
    const file = args.flags.file;
    if (!file || !isAbsolute(file))
      return "recipe needs --file ABSOLUTE_OBJECTIVE";
    return lstatSync(file, { throwIfNoEntry: false })?.isFile()
      ? undefined
      : `recipe --file ${file} isn't a regular file`;
  },
  run: ({ repository, args }) => recipe(repository, args),
};

/**
 * `recipe --file OBJECTIVE`: resolve and check the Objective's Workflow
 * recipe at the checkout's HEAD, as planning would, and print the preview.
 * No model call, no request, no state. Exit 1 when it can't be used.
 */
async function recipe(repository: string, args: Args): Promise<number> {
  const file = args.flags.file!;
  const config = loadConfig(repository);
  // A local file has no GitHub rendering: its sections come from the
  // Markdown itself.
  const blocks = markdownBlocks(readFileSync(file, "utf8"));
  const base = execFileSync(
    "git",
    ["-C", config.checkout, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", env: gitEnvironment() },
  ).trim();
  const adaptive = adaptiveWorkflow(blocks);
  const selected = await selectRecipe(
    blocks,
    new BaseFiles(config.checkout, base),
  );
  const problems = [adaptive.problem, selected.problem].filter(
    (problem): problem is string => problem !== undefined,
  );
  if (!problems.length && !selected.selected)
    problems.push("The Objective has no Workflow recipe section.");
  const preview = selected.selected
    ? previewRecipe(
        selected.selected,
        adaptive.enabled,
        recipeInstallation(config),
        config.execution.concurrency,
      )
    : { status: "blocked", missingPrerequisites: [] };
  const output = {
    ...preview,
    ...(problems.length
      ? {
          status: "blocked",
          missingPrerequisites: [
            ...problems,
            ...(preview.missingPrerequisites as string[]),
          ],
        }
      : {}),
    repository: config.repository,
    base,
    admission: "preview-only",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.status === "ready" ? 0 : 1;
}
