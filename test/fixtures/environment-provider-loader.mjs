import { pathToFileURL } from "node:url";

// Only the provider query boundary is scripted. MCP server/tool code stays real.
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "zod" &&
    process.env.FACTORY_ENVIRONMENT_SCENARIO === "missing"
  )
    throw new Error("Profile dependency zod is unavailable");
  if (specifier === "@anthropic-ai/claude-agent-sdk")
    return {
      url: pathToFileURL(
        new URL("./environment-provider-sdk.mjs", import.meta.url).pathname,
      ).href,
      shortCircuit: true,
    };
  return nextResolve(specifier, context);
}
