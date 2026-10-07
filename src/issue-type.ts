import { type GitHubClient, GitHubRequestError } from "./github-client.js";

/** Select an existing native type without changing the repository's catalog. */
export async function availableIssueType(
  client: GitHubClient,
  repository: string,
  name: "Feature" | "Task",
): Promise<string | undefined> {
  let types: { name: string; is_enabled?: boolean }[];
  try {
    types = await client.request("GET", `repos/${repository}/issue-types`);
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 404)
      throw error;
    // A missing optional endpoint is not evidence that repository access remains.
    await client.request("GET", `repos/${repository}`);
    return undefined;
  }
  if (
    !Array.isArray(types) ||
    types.some((type) => !type || typeof type.name !== "string")
  )
    throw new Error("GitHub returned an invalid repository issue-type list");
  return types.find((type) => type.name === name && type.is_enabled !== false)
    ?.name;
}
