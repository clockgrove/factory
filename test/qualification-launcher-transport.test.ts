import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { budgetStopPolicy, createBudgetStopQualification } from "../scripts/verify-budget-stop.mjs";
import { createPressureQualification } from "../scripts/verify-local-pressure.mjs";
import {
  createSchedulingQualification,
  userSystemdUnavailableError,
  type SchedulingPort,
} from "../scripts/verify-local-scheduling.mjs";
import { observeRegularLocalScopeCapability } from "../scripts/verify-regular-objective.mjs";

const repository = "example/disposable";
const namespace = "launcher-contract";
const pluginRoot = "/home/example/.codex/plugins/cache/factory";
const bundle = `${pluginRoot}/dist/mcp-server.js`;
const environment = {
  PATH: "/usr/bin:/bin",
  FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "/home/example/private/transcripts",
};
const authority = {
  repository,
  namespace,
  policy: budgetStopPolicy("gpt-5.6-sol", "xhigh"),
};

type TransportWrapper = (
  parameters: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  },
  context: {
    pluginRoot: string;
    evidence: Record<string, unknown>;
    save: () => void;
  },
) => Promise<unknown>;

function port(): SchedulingPort {
  return {
    exec: vi.fn(() => {
      throw Error("host observation must not run");
    }),
    read: vi.fn(() => {
      throw Error("host read must not run");
    }),
    link: vi.fn(() => {
      throw Error("host link must not run");
    }),
    now: vi.fn(() => "2026-09-20T00:00:00.000Z"),
    wait: vi.fn(async () => {}),
  };
}

describe("cgroup qualifier installed-launcher boundary", () => {
  const qualifiers = [
    [
      "scheduling",
      (host: SchedulingPort) => createSchedulingQualification(authority, environment, host),
    ],
    [
      "pressure",
      (host: SchedulingPort) => createPressureQualification(authority, environment, host),
    ],
    [
      "budget stop",
      (host: SchedulingPort) => createBudgetStopQualification(authority, environment, host),
    ],
  ] as const;
  it.each(qualifiers)(
    "keeps malformed %s transport fail closed with bounded private evidence",
    async (_name, create) => {
      const host = port();
      const qualification = create(host) as { wrapTransport: TransportWrapper };
      const evidence: Record<string, unknown> = {
        installedArtifact: { inventorySha256: "a".repeat(64) },
      };
      const save = vi.fn();
      await expect(
        qualification.wrapTransport(
          {
            command: "sh",
            args: [bundle],
            cwd: "/home/example/disposable",
            env: environment,
          },
          { pluginRoot, evidence, save },
        ),
      ).rejects.toThrow(/qualification boundary|budget refusal/);
      expect(evidence.qualificationFailure).toEqual({
        stage: "wrap-transport",
        code: "qualification-transport-unavailable",
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(host.exec).not.toHaveBeenCalled();
      expect(host.read).not.toHaveBeenCalled();
      expect(host.link).not.toHaveBeenCalled();
    },
  );
  it.each(qualifiers)(
    "preflights the production local-scope capability for %s",
    (_name, create) => {
      const qualification = create(port()) as { observePreflight: unknown };
      expect(qualification.observePreflight).toBe(observeRegularLocalScopeCapability);
    },
  );
  it.each(qualifiers)(
    "retains precise user-systemd unavailability for %s before launch",
    async (_name, create) => {
      const root = mkdtempSync(join(tmpdir(), "factory-cgroup-transport-"));
      const checkout = join(root, "checkout");
      const installed = join(root, "plugin");
      const launcher = join(installed, "bin/factory-mcp");
      const server = join(installed, "dist/mcp-server.js");
      mkdirSync(checkout);
      mkdirSync(join(installed, "bin"), { recursive: true });
      mkdirSync(join(installed, "dist"), { recursive: true });
      writeFileSync(launcher, "#!/bin/sh\n");
      writeFileSync(server, "export {};\n");
      const host = port();
      vi.mocked(host.exec).mockImplementation(() => {
        throw userSystemdUnavailableError();
      });
      const qualification = create(host) as { wrapTransport: TransportWrapper };
      const evidence: Record<string, unknown> = {
        installedArtifact: { inventorySha256: "a".repeat(64) },
      };
      const save = vi.fn();
      try {
        await expect(
          qualification.wrapTransport(
            {
              command: "sh",
              args: [launcher, server],
              cwd: checkout,
              env: environment,
            },
            { pluginRoot: installed, evidence, save },
          ),
        ).rejects.toThrow(/qualification boundary|budget refusal/);
        expect(evidence.qualificationFailure).toEqual({
          stage: "local-scope-observation",
          code: "user-systemd-local-scope-unavailable",
        });
        expect(save).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("records the actual scheduling hook stage instead of reporting every failure as transport", async () => {
    const qualification = createSchedulingQualification(authority, environment, port()) as {
      duringRun: (hooks: Record<string, unknown>) => Promise<unknown>;
    };
    const evidence: Record<string, unknown> = { objective: { number: 1 } };
    const save = vi.fn();
    await expect(
      qualification.duringRun({
        evidence,
        save,
        run: new Promise(() => {}),
        signal: new AbortController().signal,
        request: vi.fn(async () => {
          throw Error("fixture read failed");
        }),
        owner: "example",
        repo: "disposable",
      }),
    ).rejects.toThrow(/scheduling qualification boundary unavailable/);
    expect(evidence.qualificationFailure).toEqual({
      stage: "during-run",
      code: "during-run-unavailable",
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
