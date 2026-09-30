import {
  prepareLangSmithExport,
  sendLangSmithExport,
} from "./capture-langsmith.js";
import {
  prepareLangfuseExport,
  selectCaptures,
  sendLangfuseExport,
  type CaptureExportOptions,
} from "./capture-export.js";

export function parseCaptureExportOptions(args: string[]) {
  const values = new Map<string, string[]>();
  let send = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--send") {
      if (send) throw new Error("Duplicate --send option");
      send = true;
      continue;
    }
    if (
      ![
        "--config",
        "--objective",
        "--destination",
        "--endpoint",
        "--content",
        "--run",
        "--invocation",
        "--authorize",
        "--project-id",
        "--workspace-id",
      ].includes(flag)
    )
      throw new Error(`Unknown export-captures option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    const previous = values.get(flag) ?? [];
    if (previous.length && flag !== "--run" && flag !== "--invocation")
      throw new Error(`Duplicate ${flag} option`);
    values.set(flag, [...previous, value]);
  }
  const get = (flag: string) => values.get(flag)?.[0];
  const destination = get("--destination");
  if (destination !== "langfuse" && destination !== "langsmith")
    throw new Error("Select --destination langfuse or langsmith");
  const projectId = get("--project-id"),
    workspaceId = get("--workspace-id");
  if (destination === "langsmith" && !projectId)
    throw new Error("Select an existing LangSmith --project-id UUID");
  if (destination === "langfuse" && (projectId || workspaceId))
    throw new Error(
      "Langfuse keys select the project; project/workspace options are for LangSmith",
    );
  const endpoint = get("--endpoint");
  if (!endpoint)
    throw new Error("Select an explicit --endpoint HTTPS_BASE_URL");
  const content = get("--content");
  if (content !== "metadata" && content !== "retained")
    throw new Error("Select --content metadata or retained explicitly");
  const authorization = get("--authorize");
  if (send !== Boolean(authorization))
    throw new Error("Sending requires --send --authorize PREVIEW_DIGEST");
  return {
    options: {
      endpoint,
      content,
      ...(values.has("--run") ? { runs: values.get("--run") } : {}),
      ...(values.has("--invocation")
        ? { invocations: values.get("--invocation") }
        : {}),
    } as CaptureExportOptions,
    authorization,
    destination,
    projectId,
    workspaceId,
  };
}

export async function runCaptureExportCommand(
  config: { repository: string },
  objective: number,
  args: string[],
) {
  const { options, authorization, destination, projectId, workspaceId } =
    parseCaptureExportOptions(args);
  const selection = selectCaptures(config.repository, objective, options);
  if (destination === "langsmith") {
    const prepared = prepareLangSmithExport(selection, {
      projectId: projectId!,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!authorization) return { status: "preview", ...prepared.preview };
    return sendLangSmithExport(prepared, authorization);
  }
  const prepared = prepareLangfuseExport(selection);
  if (!authorization) return { status: "preview", ...prepared.preview };
  return sendLangfuseExport(prepared, authorization);
}
