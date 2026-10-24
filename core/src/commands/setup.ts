/**
 * `factory setup`: its options, help and check, and what it does.
 */
import {
  SERVICE_MODES,
  SETUP_FLAGS,
  type ServiceReport,
  type SetupReport,
  SetupUsage,
  serviceSetup,
  setup,
} from "../setup.js";
import { recommendationText } from "../status.js";
import { type Args, type Command, usage } from "./shared.js";

export const spec: Command = {
  args: "",
  flags: SETUP_FLAGS,
  help: "Write and check the configuration (--checkout PATH --project-id PVT_... to create it), the checkout's origin and the queue's Project fields; repeated, it changes nothing. --provider NAME [--planner KIND] [--worker codex|claude|copilot] [--default] adds or changes a provider; see docs/reference/setup.md#Setup for every option",
  run: ({ repository, args }) => setupCommand(repository, args),
};

/** `factory setup`: setup.ts writes and checks; this prints its report. */
async function setupCommand(repository: string, args: Args): Promise<number> {
  const values: Record<string, string[]> = { ...args.lists };
  for (const [flag, value] of Object.entries(args.flags))
    values[flag] = [value];
  const modes = SERVICE_MODES.filter((mode) => values[mode]);
  if (modes.length > 1) throw usage(`give one of --${modes.join(", --")}`);
  if (values["credential-file"] && modes[0] !== "background")
    throw usage(
      "--credential-file binds the background service: give --background",
    );
  let report: SetupReport;
  try {
    if (modes[0])
      return printService(
        await serviceSetup(repository, modes[0], values),
        args,
      );
    report = await setup(repository, values);
  } catch (error) {
    if (error instanceof SetupUsage) throw usage(error.message);
    throw error;
  }
  if (args.flags.json !== undefined)
    process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    const what =
      report.status === "refused"
        ? `${report.config} was not changed`
        : `${report.config} ${report.created ? "created" : report.changed.length ? `changed: ${report.changed.join(", ")}` : "unchanged"}; default provider ${report.defaultProvider}`;
    const mark = { ok: "ok     ", warn: "warning", blocked: "BLOCKED" };
    const checklist = (report.readiness?.checks ?? [])
      .map(
        (check) =>
          `  ${mark[check.status]} ${check.name}: ${check.detail}${check.fix && check.status !== "ok" ? `\n          ${check.fix}` : ""}\n`,
      )
      .join("");
    process.stdout.write(
      `Setup ${report.status}: ${what}.\n${report.problems.map((problem) => `- ${problem}\n`).join("")}${checklist ? `Readiness (no model calls):\n${checklist}` : ""}${report.capacity ? `Capacity: ${recommendationText(report.capacity)}` : ""}${report.status === "refused" || report.created || !report.changed.length ? "" : "Restart the service to use the change.\n"}`,
    );
  }
  return report.status === "configured" ? 0 : 1;
}

/** `setup --background|--check|--stop|--uninstall`'s report. */
function printService(report: ServiceReport, args: Args): number {
  if (args.flags.json !== undefined)
    process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    const service = report.service;
    process.stdout.write(
      [
        `Service ${report.status}${service ? `: ${service.unit} (${service.installed ? `${service.enabled}, ${service.active}${service.serving ? ", serving" : ""}` : "not installed"})` : ""}.`,
        ...(service?.credentials.length
          ? [`  Credentials: ${service.credentials.join(", ")}`]
          : []),
        ...(report.setup && report.setup.status !== "configured"
          ? [
              `  Setup ${report.setup.status}:`,
              ...report.setup.problems.map((problem) => `  - ${problem}`),
            ]
          : []),
        ...report.problems.map((problem) => `- ${problem}`),
        ...report.warnings.map((warning) => `  Warning: ${warning}`),
        "",
      ].join("\n"),
    );
  }
  const ok =
    report.mode === "check"
      ? report.status === "running"
      : report.status !== "blocked";
  return ok ? 0 : 1;
}
