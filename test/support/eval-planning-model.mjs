import { join } from "node:path";
import { ScriptedPlanningModel } from "./integration-fixture.mjs";

/** Credential-free `--planning-model` module: one alpha Work Item, clean review. */
export function createPlanningModel({ directory }) {
  const model = new ScriptedPlanningModel(
    undefined,
    join(directory, "scripted-planning.ndjson"),
  );
  const generate = model.generateStructured.bind(model);
  model.generateStructured = (request) => {
    model.graph = {
      objective: request.compileContext.objectiveNumber,
      baseSha: request.baseSha,
      items: [
        {
          id: "alpha",
          title: "Implement alpha",
          goal: "Return the sum of a finite number array",
          acceptance: ["node scripts/check.mjs alpha passes"],
          nonGoals: ["No changes outside src/alpha.mjs"],
          citations: [{ path: "OBJECTIVE", heading: "Goal" }],
          dependencies: [],
          ownedPaths: ["src/alpha.mjs"],
          resources: [],
          validation: [
            {
              command: "node scripts/check.mjs alpha",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          brief: "Implement alpha(values) in src/alpha.mjs",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    };
    return generate(request);
  };
  return model;
}
