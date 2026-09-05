import type { GitHubControlStore } from "../control/github-store.js";
import { GitHubStacks } from "../publication/github-stacks.js";
import type { RecoveryReadStore } from "./assessment.js";

/** Runtime capability boundary: the assessment never receives a mutation-capable store. */
export function recoveryReadPort(
  store: GitHubControlStore,
  owner: string,
  repo: string,
): RecoveryReadStore {
  const stacks = new GitHubStacks(
    {
      request: (route, parameters, mutating) => {
        if (mutating || !route.startsWith("GET ")) {
          throw new Error("recovery assessment cannot mutate GitHub");
        }
        return store.stackRequest(route, parameters, false);
      },
    },
    owner,
    repo,
  );
  return Object.freeze({
    readRef: store.readRef.bind(store),
    readCommit: store.readCommit.bind(store),
    readBlob: store.readBlob.bind(store),
    readTreeEntry: store.readTreeEntry.bind(store),
    listRefs: store.listRefs.bind(store),
    readPullRequest: store.readPullRequest.bind(store),
    getRepositoryFacts: store.getRepositoryFacts.bind(store),
    getBranchHead: store.getBranchHead.bind(store),
    readBranchRules: store.readBranchRules.bind(store),
    readChecks: store.readChecks.bind(store),
    readStack: (number: number) => stacks.get(number),
  });
}
