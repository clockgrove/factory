import {
  prepareOtlpExport,
  selectCaptures,
  sendOtlpExport,
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
        "--endpoint",
        "--content",
        "--run",
        "--invocation",
        "--authorize",
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
  };
}

export async function runCaptureExportCommand(
  config: { repository: string },
  objective: number,
  args: string[],
) {
  const { options, authorization } = parseCaptureExportOptions(args);
  const prepared = prepareOtlpExport(
    selectCaptures(config.repository, objective, options),
  );
  if (!authorization) return { status: "preview", ...prepared.preview };
  return sendOtlpExport(prepared, authorization);
}
