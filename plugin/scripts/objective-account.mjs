#!/usr/bin/env node
// The account a work, review or launch job's stage runs on, on GitHub Actions and the cloud sandbox (#267): the Action's
// `account` mode, a step of its own before the stage's step (workflow-template.yml), run only when the workflow's env
// block declares accounts (FACTORY_ACCOUNTS, lib/accounts.mjs routeAccounts). It reads the Objective's labels with the
// App's token, the harness it runs on (its harness label, else the repository's) and its one `factory:account:<name>`
// label's labeler, and writes, for the next step's secret lookups:
//   account=<name>                  the account, recorded by the stage (`-`, accounts.mjs NO_SECRET, when none can be picked);
//   suffix_claude|codex|copilot=... the suffix each harness's credential secrets are looked up with: the account's own
//                                   for its harness, accounts.mjs NO_SECRET (which no secret's name can have) for the rest.
// So the stage's step resolves that one account's secrets and no other's. The stage reads the labels again and Blocks
// when they pick another account by then (objective-trust.mjs accountGate). Account names only: no secret is read here.
//   node scripts/objective-account.mjs --repo OWNER/NAME (--issue N | --branch factory/N)
import { pathToFileURL } from "node:url";
import { NO_SECRET, routeAccount, routeAccounts, routeSuffixes, routeTwoLine } from "./lib/accounts.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { choiceOf } from "./lib/choice.mjs";
import { getIssue, repoOf } from "./lib/github.mjs";
import { setMaintainers } from "./lib/logic.mjs";
import { log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { labelsVouched, trustedRoutePin } from "./lib/objective-trust.mjs";

/**
 * The account and secret suffixes for the stage of `issue` (or of the factory/<issue> `branch`), from the workflow's
 * `accounts` text: {account, suffixes, why} (`why` the line logged when no account can be picked; the account and every
 * suffix are then NO_SECRET). `harness`: the repository's (the `with:` input, else FACTORY_HARNESS). `read` (issue,
 * vouch) is a test's own. Throws on a failed read: the step fails and the job with it, before any credential is resolved.
 */
export async function stageAccount({ repo, issue = null, branch = "", harness, accounts, opts, maintainers = [], read = {} }) {
  // No account: the stage is told the step ran and picked none (NO_SECRET, no account's name), and gets no credential.
  const none = (why) => ({ account: NO_SECRET, suffixes: routeSuffixes(null), why });
  const declared = routeAccounts(accounts);
  if (!declared.ok) return none(declared.problem);
  const n = Number(issue) || Number(/^factory\/(\d+)$/.exec(String(branch || ""))?.[1]) || null;
  if (!n) return none("no Objective issue names this stage");
  const labels = ((await (read.issue ?? getIssue)(repo, n, opts))?.labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const c = choiceOf(labels);
  // Two harness labels, or one no harness: the stage Blocks on it (choiceGate); no credential is resolved meanwhile.
  if (!c.ok) return none("the Objective's harness labels cannot be used");
  const h = c.choice.harness || harness;
  // The workflow's pinned maintainers vouch by id; anyone else by their permission, read for that one login.
  setMaintainers(repo.full, maintainers);
  const vouch = read.vouch ?? ((label) => labelsVouched(repo, n, [label], opts, {}, "Factory does not run the Objective on that account"));
  // With no account label now, a pin whose removal no one who can push made still stands (trustedRoutePin).
  const kept = read.kept ?? (() => trustedRoutePin(repo, n, opts));
  const r = await routeAccount({ declared, harness: h, names: labels, vouch, kept });
  if (!r.account) return none(r.problem || routeTwoLine(r.two));
  return { account: r.account.name, suffixes: routeSuffixes(r.account), why: null };
}

/**
 * The Action's `account` mode: the App's token minted from the step's inputs (it reads the issue and, for an account label,
 * the timeline and the labeler's permission: reads the App already makes), stageAccount, and its outputs written.
 */
export async function accountStep({ args, env = process.env }) {
  const inputs = resolveInputs({ args, env });
  const repo = repoOf(args.repo || env.GITHUB_REPOSITORY);
  // Read-only: the issue, its timeline and who can push (the App's own grants, narrowed; nothing new is asked for).
  const app = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, narrowTo: { issues: "read", metadata: "read" } });
  mask(app.token);
  const r = await stageAccount({ repo, issue: args.issue, branch: args.branch, harness: inputs.harness, accounts: env.FACTORY_ACCOUNTS, opts: { token: app.token }, maintainers: inputs.maintainers });
  if (r.why) log(`no account is picked for this stage, so no credential reaches it: ${r.why}; the stage Blocks with the reason`);
  else log(`this stage runs on account ${r.account}`);
  setOutput("account", r.account, env);
  for (const [h, s] of Object.entries(r.suffixes)) setOutput(`suffix_${h}`, s, env);
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await accountStep({ args: parseArgs(process.argv.slice(2)) });
