#!/usr/bin/env node
// The work or review job's usage artifact, made ready for upload (action.yml, after the stage, whatever its outcome).
//   node scripts/usage-upload.mjs --repo OWNER/NAME --issue N --stage work|review --from <the stage's usage directory> --to <the upload directory>
// The job uploads `--to` only (the Action's `usage_dir` output): the usage record and the stage's other files, with the
// harness's event stream and saved sessions sealed (lib/seal.mjs) unless the repository is private or the workflow
// publishes them (PENDULUM_PUBLISH_TRANSCRIPTS). `--to` appears only once it is whole: a step cut off, or one that fails,
// leaves none, so the job uploads nothing of the stage's stream.
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getRepo, repoOf } from "./lib/github.mjs";
import { input, log, parseArgs } from "./lib/inputs.mjs";
import { eventPayload, prepareUpload, sealKey, sealKeyProblem, usageSeal } from "./lib/seal.mjs";

async function main(args) {
  const repo = repoOf(args.repo || process.env.GITHUB_REPOSITORY);
  if (!args.from || !args.to) throw new Error("--from and --to are required");
  const token = input("github_token") || process.env.GITHUB_TOKEN || "";
  const pem = input("app_private_key");
  const key = sealKey(pem, repo.full);
  // The App's key is needed for the derivation alone.
  for (const k of ["PENDULUM_INPUT_APP_PRIVATE_KEY", "PENDULUM_APP_PRIVATE_KEY"]) delete process.env[k];
  const seal = usageSeal({ key, publish: input("publish_transcripts"), payload: eventPayload(), readRepo: () => getRepo(repo, { token, noRateWait: true }) });
  const policy = await seal.policy();
  const r = await prepareUpload({ from: args.from, to: args.to, policy, key, bind: { issue: args.issue, stage: args.stage } });
  if (r.sealed.length) log(`usage artifact: ${r.sealed.join(" and ")} sealed (the repository is public or its visibility unread; publish_transcripts is off)`);
  else if (r.dropped.length) log(`usage artifact: ${r.dropped.join(" and ")} left out: ${r.error ? `the seal failed (${r.error})` : `${sealKeyProblem(pem, key)} to seal them with`}`);
  else if (policy !== "sealed") log(`usage artifact: the transcript and the event stream are uploaded readable (${policy === "private" ? "a private repository" : "publish_transcripts is on"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  main(args).catch((e) => {
    // Nothing half-made is uploaded.
    for (const d of [args.to, `${args.to}.part`]) if (args.to) rmSync(d, { recursive: true, force: true });
    process.stderr.write(`[pendulum] usage upload failed: ${e.message}\n`);
    process.exit(1);
  });
}
