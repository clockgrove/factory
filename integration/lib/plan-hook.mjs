// What planning receives from knowledge for Objective ISSUE, from the live
// store at the same base.
// node plan-hook.mjs <dist> <repo> <issue> <checkout> <ROOT> [playbook]   (FACTORY_CONFIG set)
const [dist, repo, issueArg, checkout, root, playbook] = process.argv.slice(2);
const { loadKnowledgeSettings, configureKnowledge } = await import(
  `${dist}/knowledge/settings.js`
);
const { planningKnowledge } = await import(`${dist}/knowledge/index.js`);
const { BaseFiles } = await import(`${dist}/planning/facts.js`);
const { declarationProblems } = await import(`${dist}/validate.js`);
const { readFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const issue = Number(issueArg);
configureKnowledge(
  loadKnowledgeSettings({
    repository: repo,
    root,
    checkout,
    allowedSecretNames: [],
  }),
);
const state = JSON.parse(
  readFileSync(`${root}/objectives/${issue}.json`, "utf8"),
);
const base = execFileSync("git", ["-C", checkout, "rev-parse", "origin/main"])
  .toString()
  .trim();
console.log("run:", state.startedAt, "base:", base);
// A build plans from the shown Objective the check saved (done.check.shown);
// an older one from the issue body text.
const shown = state.done?.check?.shown;
if (shown) {
  console.log(
    await planningKnowledge({
      state,
      shown,
      child: false,
      files: new BaseFiles(checkout, base),
      playbook: playbook ?? "",
    }),
  );
} else {
  const body = execFileSync("gh", [
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    "body",
    "--jq",
    ".body",
  ]).toString();
  console.log("check problems:", JSON.stringify(declarationProblems(body)));
  console.log(
    await planningKnowledge({
      state,
      body,
      files: new BaseFiles(checkout, base),
      playbook: playbook ?? "",
    }),
  );
}
