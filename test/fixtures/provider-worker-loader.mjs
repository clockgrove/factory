import { pathToFileURL } from "node:url";

// Replace only the provider SDK boundary; exercise the production worker.
export async function resolve(specifier, context, nextResolve) {
  if (
    ["@anthropic-ai/claude-agent-sdk", "@github/copilot-sdk"].includes(
      specifier,
    )
  )
    return {
      url: pathToFileURL(
        new URL("./scripted-provider-sdk.mjs", import.meta.url).pathname,
      ).href,
      shortCircuit: true,
    };
  return nextResolve(specifier, context);
}
