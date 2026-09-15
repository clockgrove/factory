import { isAbsolute, relative, resolve } from "node:path";

export interface Issue404LiveGitIdentity {
  candidateCommitSha: string;
  headSha: string;
  worktreeStatus: string;
}

export interface Issue404LiveAuthority {
  candidateSha: string;
  transcriptDirectory: string;
}

export function issue404LiveAuthority(
  env: NodeJS.ProcessEnv,
  repositoryRoot: string,
  inspectGitIdentity: (candidateSha: string) => Issue404LiveGitIdentity,
): Issue404LiveAuthority {
  if (env.FACTORY_LIVE_OBJECTIVE !== "1")
    throw new Error("FACTORY_LIVE_OBJECTIVE=1 is required for the live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404 !== "1")
    throw new Error("FACTORY_LIVE_COMPILER_ISSUE404=1 is required for this live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK !== "consume-paid-compiler-evaluation")
    throw new Error(
      "FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK=consume-paid-compiler-evaluation is required",
    );

  const candidateSha = env.ISSUE404_CANDIDATE_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(candidateSha))
    throw new Error("ISSUE404_CANDIDATE_SHA must be an exact 40-character commit SHA");
  const identity = inspectGitIdentity(candidateSha);
  if (identity.candidateCommitSha !== candidateSha)
    throw new Error("ISSUE404_CANDIDATE_SHA must resolve to that exact commit");
  if (identity.headSha !== candidateSha)
    throw new Error("ISSUE404_CANDIDATE_SHA must exactly equal git HEAD");
  if (identity.worktreeStatus.trim())
    throw new Error("the live compiler candidate worktree must be clean");

  const transcriptDirectory = env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR?.trim() ?? "";
  if (!isAbsolute(transcriptDirectory))
    throw new Error("FACTORY_MANAGEMENT_TRANSCRIPT_DIR must be an absolute private local path");
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedTranscriptDirectory = resolve(transcriptDirectory);
  const repositoryRelative = relative(resolvedRepositoryRoot, resolvedTranscriptDirectory);
  if (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
    throw new Error("FACTORY_MANAGEMENT_TRANSCRIPT_DIR must remain outside the Git repository");
  return { candidateSha, transcriptDirectory: resolvedTranscriptDirectory };
}
