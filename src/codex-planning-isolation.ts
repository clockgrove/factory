import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
 * sandbox the thread starts with.
 */
export const CODEX_TREE_REVIEW_CONFIG = CODEX_PLANNING_CONFIG.replace(
  "shell_tool = false",
  "shell_tool = true",
);

/** Ambient variables a planning Codex process keeps; everything else is dropped. */
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

export interface CodexPlanningHome {
  /** Environment for the Codex process; it replaces `process.env`. */
  env: Record<string, string>;
  /** Removes the scratch home. */
  dispose(): void;
}

/**
 * A scratch CODEX_HOME and HOME for one planning thread. It holds Factory's
 * config and a link to the operator's login (`auth.json`, linked so a token
 * refresh reaches the operator), and nothing else: not the operator's
 * `config.toml`, `AGENTS.md`, skills, profiles or MCP servers.
 */
export function createCodexPlanningHome(
  source: NodeJS.ProcessEnv = process.env,
  config: string = CODEX_PLANNING_CONFIG,
): CodexPlanningHome {
  const root = mkdtempSync(join(tmpdir(), "factory-codex-planning-"));
  try {
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    mkdirSync(home);
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), config);
    const login = join(
      source.CODEX_HOME || join(homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(login)) symlinkSync(login, join(codexHome, "auth.json"));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source))
      if (
        value !== undefined &&
        ENVIRONMENT.some((pattern) => pattern.test(name))
      )
        env[name] = value;
    env.HOME = home;
    env.CODEX_HOME = codexHome;
    return {
      env,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
