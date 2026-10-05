import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Factory's own Codex configuration for planning and review: no shell, file,
 * web, app, plugin or agent tools, and no project instructions. The prompt is
 * the complete request, so the operator's `config.toml` and `AGENTS.md` have
 * nothing to add and must never shape a plan.
 */
export const CODEX_PLANNING_CONFIG = `web_search = "disabled"
project_doc_max_bytes = 0

[features]
shell_tool = false
unified_exec = false
view_image = false
multi_agent = false
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false
code_mode_host = false
skill_search = false
tool_suggest = false
sleep_tool = false
memories = false
hooks = false
`;

/**
 * The same configuration for a result review, which reads the exact candidate
 * tree itself: only the shell is on, inside the read-only, network-less
 * permission profile `createCodexHome` adds. Codex runs shell calls through
 * its code-mode host, so the shell needs that host too.
 */
export const CODEX_TREE_REVIEW_CONFIG = CODEX_PLANNING_CONFIG.replace(
  "shell_tool = false",
  "shell_tool = true",
).replace("code_mode_host = false", "code_mode_host = true");

/** Ambient variables a Factory Codex process keeps; everything else is dropped. */
const ENVIRONMENT = [
  /^PATH$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^TZ$/,
  /^(?:HTTPS?|NO|ALL)_PROXY$/i,
  /^NODE_EXTRA_CA_CERTS$/,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^OPENAI_(?:API_KEY|BASE_URL)$/,
  /^CODEX_API_KEY$/,
];

/** What a Codex shell may do in its working directory and on the network. */
export interface CodexSandbox {
  workspace: "read" | "write";
  network: boolean;
}

/** The installed Codex runtime; its Linux sandbox helper re-executes it. */
function codexRuntimeDirectory(): string {
  const cli = createRequire(
    createRequire(import.meta.url).resolve("@openai/codex/package.json"),
  );
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return join(
    dirname(cli.resolve(`@openai/codex-linux-${arch}/package.json`)),
    "vendor",
  );
}

/**
 * A Codex permission profile: shell commands see only the platform paths
 * Codex calls `:minimal`, the Codex runtime, the working directory (its
 * `.git` entry read-only) and, when they may write, the private HOME and
 * TMPDIR. Nothing else is mounted: not the operator's HOME, logins, SSH keys
 * or gh config, nor Factory's state or the checkout's git directory.
 */
function permissionProfile(
  sandbox: CodexSandbox,
  home: string,
  temporary: string,
): string {
  const path = (value: string) => JSON.stringify(value);
  const grants = [
    `":minimal" = "read"`,
    `${path(codexRuntimeDirectory())} = "read"`,
    ...(sandbox.workspace === "write"
      ? [`${path(home)} = "write"`, `${path(temporary)} = "write"`]
      : []),
  ];
  // Name resolution: /etc/resolv.conf often links outside `:minimal`
  // (systemd-resolved under /run, WSL under /mnt/wsl).
  if (sandbox.network && existsSync("/etc/resolv.conf"))
    grants.push(`${path(realpathSync("/etc/resolv.conf"))} = "read"`);
  return `[permissions.factory.filesystem]
${grants.join("\n")}

[permissions.factory.filesystem.":workspace_roots"]
"." = "${sandbox.workspace}"
".git" = "read"

[permissions.factory.network]
enabled = ${sandbox.network}
`;
}

export interface CodexHome {
  /** Environment for the Codex process; it replaces `process.env`. */
  env: Record<string, string>;
  /** Removes the scratch home. */
  dispose(): void;
}

/**
 * A scratch CODEX_HOME, HOME and TMPDIR for one Codex thread. It holds
 * Factory's config and a link to the operator's login (`auth.json`, linked
 * so a token refresh reaches the operator), and nothing else: not the
 * operator's `config.toml`, `AGENTS.md`, skills, profiles or MCP servers.
 * With a `sandbox`, the config also confines every shell command to it.
 * `keep` names further variables to pass through, such as declared secrets.
 */
export function createCodexHome(options: {
  source?: NodeJS.ProcessEnv;
  config: string;
  sandbox?: CodexSandbox;
  keep?: readonly string[];
}): CodexHome {
  const source = options.source ?? process.env;
  const root = mkdtempSync(join(tmpdir(), "factory-codex-"));
  try {
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    const temporary = join(root, "tmp");
    for (const directory of [home, codexHome, temporary])
      mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      join(codexHome, "config.toml"),
      options.sandbox
        ? `default_permissions = "factory"\n${options.config}\n${permissionProfile(options.sandbox, home, temporary)}`
        : options.config,
    );
    const login = join(
      source.CODEX_HOME || join(source.HOME || homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(login)) symlinkSync(login, join(codexHome, "auth.json"));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source))
      if (
        value !== undefined &&
        (ENVIRONMENT.some((pattern) => pattern.test(name)) ||
          options.keep?.includes(name))
      )
        env[name] = value;
    env.HOME = home;
    env.CODEX_HOME = codexHome;
    env.TMPDIR = temporary;
    return {
      env,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
