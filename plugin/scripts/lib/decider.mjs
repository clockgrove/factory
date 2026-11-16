// The one decision interface (docs/ADAPTERS.md, Decision model). Every typed question Factory asks a model (red-check
// triage, the drift advisory, and each judgement built on them) opens its decider here: with an AI Gateway key, the
// gateway's decision model answers (adapters/decider-ai-gateway.mjs); without one, the stage's own harness on the login
// the stage runs on (adapters/decider-harness.mjs). Both answer `decide(input, question)` the same way, so a caller
// never knows which. This runs in Factory's own process, never in a harness: the key stays here, and scrubbedEnv
// (harness.mjs) keeps it out of every child.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { openVendor } from "./adapters/decider.mjs";
import { log, mask } from "./inputs.mjs";
import { gatewayKeyFile, keyDirExposedBy } from "./local.mjs";

/**
 * The AI Gateway key, or why there is none (a code). On Actions the `ai_gateway_api_key` input only; off Actions the file
 * ~/.config/factory/ai-gateway-key only, which Factory's own process reads and no sandbox can (the sandboxes deny that
 * literal path), so the key is in no process's environment. The file is held to local mode's rules for key files
 * (lib/local.mjs localApp): ~/.config/factory a real directory, the key a regular file (no symlink) with one link and
 * no group or world bits, and no home of the harness (`inputs.harness`, which the outer sandbox leaves readable) equals
 * or holds ~/.config/factory. Codes: no-key, key-dir-exposed, key-dir-symlink, key-file-not-regular, key-file-links,
 * key-file-mode, key-file-empty, key-file-<errno> (any other fs error, for example key-file-eacces).
 */
export function deciderKeyState({ inputs = {}, env = process.env, home = homedir() } = {}) {
  const none = (code) => ({ key: "", code });
  if (env.GITHUB_ACTIONS) {
    const key = String(inputs.aiGatewayApiKey || "").trim();
    return key ? { key, code: null } : none("no-key");
  }
  const file = gatewayKeyFile(home);
  const dir = dirname(file);
  const errno = (e) => (e?.code === "ENOENT" ? "no-key" : `key-file-${String(e?.code || "error").toLowerCase()}`);
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    return none(errno(e));
  }
  if (keyDirExposedBy(inputs.harness, env, home)) return none("key-dir-exposed");
  try {
    if (realpathSync(dir) !== dir) return none("key-dir-symlink");
  } catch (e) {
    return none(errno(e));
  }
  if (!st.isFile()) return none("key-file-not-regular");
  if (st.nlink > 1) return none("key-file-links");
  if (st.mode & 0o077) return none("key-file-mode");
  try {
    const key = readFileSync(file, "utf8").trim();
    return key ? { key, code: null } : none("key-file-empty");
  } catch (e) {
    return none(errno(e));
  }
}

/**
 * Which decider a repository's stages use, for doctor and the logs: `ai-gateway` with a usable key, else `harness` (the
 * stage's own harness on its login) with `code`, why there is no key (deciderKeyState).
 */
export function deciderKind({ inputs = {}, env = process.env, home = homedir() } = {}) {
  const { key, code } = deciderKeyState({ inputs, env, home });
  return key ? { name: "ai-gateway", code: null } : { name: "harness", code };
}

/** Whether this process has said which decider its stage uses without a key: once per stage (one stage is one process). */
let harnessSaid = false;

/**
 * The decider for one kind of decision call: `{name, model, off, decide(input, question)}`, decide as in
 * adapters/decider.mjs (never throws; no answer is `error` with no verdict, which callers treat as they always have).
 * - With an AI Gateway key (deciderKeyState): the gateway, asked `model` (the caller's own model setting).
 * - Without one, with `stage` ({harness, model, env, record}: the stage's harness and model, its harness env or a
 *   function returning it, and where each call's spend joins the stage's usage): that harness, on that env's login.
 * - Neither: `off` is the key's code, and decide answers nothing.
 * `decider` stands in for the vendor (tests). The vendor module opens at the first question.
 */
export function openDecider({ inputs = {}, env = process.env, home = homedir(), model, stage = null, decider = null } = {}) {
  if (decider) return { name: decider.name ?? "given", model, off: null, decide: (input, question) => decider.decide(input, question) };
  const { key, code } = deciderKeyState({ inputs, env, home });
  let opened = null;
  // One vendor per decider, opened at the first question: concurrent first questions share it.
  const lazy = (options) => async (input, question) => (await (opened ??= openVendor(options))).decide(input, question);
  if (key) {
    mask(key);
    return { name: "ai-gateway", model, off: null, decide: lazy({ vendor: "ai-gateway", key, model }) };
  }
  if (stage?.harness) {
    if (!harnessSaid) {
      harnessSaid = true;
      log(`decision calls: no AI Gateway key (${code}); the stage's own harness (${stage.harness}) answers them on its login`);
    }
    return { name: "harness", model: `${stage.harness}${stage.model ? ` ${stage.model}` : ""}`, off: null, keyCode: code, decide: lazy({ vendor: "harness", harness: stage.harness, model: stage.model ?? null, env: stage.env, record: stage.record ?? null, run: stage.run ?? null }) };
  }
  return { name: null, model, off: code, decide: async () => ({ verdict: null, confidence: null, error: "no_answer" }) };
}
