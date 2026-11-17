#!/usr/bin/env node
// The work or review job's usage artifact, made ready for upload (action.yml, after the stage, whatever its outcome).
//   node scripts/usage-upload.mjs --repo OWNER/NAME --from <the stage's usage directory> --to <the upload directory>
// The job uploads `--to` only (the Action's `usage_dir` output): the usage record and the stage's other files, with the
// harness's event stream and saved sessions sealed (lib/seal.mjs) unless the repository is private or the workflow
// publishes them (PENDULUM_PUBLISH_TRANSCRIPTS). A stage cut off before this step ran uploads nothing.
import { pathToFileURL } from "node:url";
import { getRepo, repoOf } from "./lib/github.mjs";
import { input, log, parseArgs } from "./lib/inputs.mjs";
import { eventPayload, prepareUpload, sealKey, usageSeal } from "./lib/seal.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = repoOf(args.repo || process.env.GITHUB_REPOSITORY);
  if (!args.from || !args.to) throw new Error("--from and --to are required");
  const token = input("github_token") || process.env.GITHUB_TOKEN || "";
  const seal = usageSeal({ key: sealKey(input("app_private_key"), repo.full), publish: input("publish_transcripts"), payload: eventPayload(), readRepo: () => getRepo(repo, { token }) });
  const policy = await seal.policy();
  const r = await prepareUpload({ from: args.from, to: args.to, policy, key: seal.key });
  if (r.sealed.length) log(`usage artifact: ${r.sealed.join(" and ")} sealed (${policy === "sealed" ? "the repository is public or its visibility unread; publish_transcripts is off" : policy})`);
  else if (r.dropped.length) log(`usage artifact: ${r.dropped.join(" and ")} left out: ${r.error ? `the seal failed (${r.error})` : "no App private key to seal them with"}`);
  else if (policy !== "sealed") log(`usage artifact: the transcript and the event stream are uploaded readable (${policy === "private" ? "a private repository" : "publish_transcripts is on"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[pendulum] usage upload failed: ${e.message}\n`);
    process.exit(1);
  });
}
