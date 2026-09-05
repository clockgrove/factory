import type { GitHubStackTransport } from "../../src/publication/github-stacks.js";

/** Drop exactly one acknowledged response, never the mutation itself. */
export function loseAcknowledgedResponse(
  transport: GitHubStackTransport,
  routeToLose: string,
  successStatus: number,
): { transport: GitHubStackTransport; lost: () => boolean } {
  let lost = false;
  return {
    lost: () => lost,
    transport: {
      async request(route, parameters, mutating) {
        const response = await transport.request(route, parameters, mutating);
        if (
          !lost &&
          mutating === true &&
          route === routeToLose &&
          response.status === successStatus
        ) {
          lost = true;
          throw new Error("Injected response loss after acknowledged disposable-stack mutation");
        }
        return response;
      },
    },
  };
}
