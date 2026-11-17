// The one decision interface (docs/ADAPTERS.md, Decision model). Every typed question Pendulum asks a model (red-check
// triage, the drift advisory, and each judgement built on them) opens its decider here: with an AI Gateway key, the
// gateway's decision model answers (adapters/decider-ai-gateway.mjs); without one, the stage's own harness on the login
// the stage runs on (adapters/decider-harness.mjs). Both answer `decide(input, question)` the same way, so a caller
// never knows which. This runs in Pendulum's own process, never in a harness: the key stays here, and scrubbedEnv
// (harness.mjs) keeps it out of every child.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { openVendor } from "./adapters/decider.mjs";
import { log, mask } from "./inputs.mjs";
import { gatewayKeyFile, keyDirExposedBy } from "./local.mjs";

/**
 * The AI Gateway key, or why there is none (a code). On Actions the `ai_gateway_api_key` input only; off Actions the file
 * ~/.config/pendulum/ai-gateway-key only, which Pendulum's own process reads and no sandbox can (the sandboxes deny that
 * literal path), so the key is in no process's environment. The file is held to local mode's rules for key files
 * (lib/local.mjs localApp): ~/.config/pendulum a real directory, the key a regular file (no symlink) with one link and
 * no group or world bits, and no home of the harness (`inputs.harness`, which the outer sandbox leaves readable) equals
 * or holds ~/.config/pendulum. Codes: no-key, key-dir-exposed, key-dir-symlink, key-file-not-regular, key-file-links,
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
 * Which decider a repository's stages use, for doctor and the logs (openDecider's choice): `ai-gateway` with a usable
 * key, else `harness` (the stage's own harness on its login) on the `auto` route, else `off`; `code` is why there is no
 * key (deciderKeyState), `route` the decision route.
 */
export function deciderKind({ inputs = {}, env = process.env, home = homedir() } = {}) {
  const route = DECISION_ROUTES.includes(inputs?.decisionRoute) ? inputs.decisionRoute : "auto";
  if (route === "off") return { name: "off", code: "route-off", route };
  const { key, code } = deciderKeyState({ inputs, env, home });
  return { name: key ? "ai-gateway" : route === "auto" ? "harness" : "off", code: key ? null : code, route };
}

/** The decision routes (the `decision_route` setting): `auto` (the gateway with a key, else the stage's harness), `gateway` (the gateway only) and `off`. */
export const DECISION_ROUTES = Object.freeze(["auto", "gateway", "off"]);

/** The gateway's answers that end the gateway for the rest of the stage on the `auto` route: its key or its credits refused. */
const GATEWAY_REFUSED = new Set(["auth", "billing"]);

/** Whether this process has said which decider its stage uses without a key: once per stage (one stage is one process). */
let harnessSaid = false;

/**
 * Each stage's shared decision state, by its `stage` object: the one harness adapter every decider of the stage asks
 * (adapters/decider-harness.mjs, so its cap on calls at once and its stop after a usage limit hold for the stage, not
 * per caller), and whether the gateway refused its key or credits (then the harness answers for the rest of the stage).
 */
const STAGES = new WeakMap();
const shared = (stage) => {
  if (!STAGES.has(stage)) STAGES.set(stage, { harness: null, opened: null, gatewayRefused: null });
  return STAGES.get(stage);
};
const harnessOf = (stage) => {
  const s = shared(stage);
  s.harness ??= openVendor({ vendor: "harness", harness: stage.harness, model: stage.model ?? null, env: stage.env, record: stage.record ?? null }).then((a) => (s.opened = a));
  return s.harness;
};

/**
 * The decider for one kind of decision call: `{name, model, off, asked(), limited(), decide(input, question, {signal})}`,
 * decide as in adapters/decider.mjs (never throws; no answer is `error` with no verdict). `asked()`: who answers now,
 * {name, model} (`ai-gateway`, or `harness` once the gateway refused); `limited()`: the stage harness's refusal that
 * stopped its decision calls (a usage limit or quota), else null.
 * The route is `inputs.decisionRoute` (DECISION_ROUTES, `auto` by default):
 * - With an AI Gateway key (deciderKeyState), on `auto` or `gateway`: the gateway, asked `model` (the caller's own
 *   model setting). On `auto` with a stage, a gateway that refuses the key or its credits (GATEWAY_REFUSED) hands this
 *   question and every later one of the stage to the stage's harness, said once in the log.
 * - Without one, on `auto` with `stage` ({harness, model, env, record}: the stage's harness and model, its harness env or
 *   a function returning it, and where the stage's decision record goes): that harness, on that env's login, through
 *   the stage's one shared adapter.
 * - Otherwise: `off` is why (the key's code, or `route-off`), and decide answers nothing.
 * `decider` stands in for the vendor (tests). The vendor module opens at the first question.
 */
export function openDecider({ inputs = {}, env = process.env, home = homedir(), model, stage = null, decider = null } = {}) {
  const fixed = (name, label) => () => ({ name, model: label });
  if (decider) return { name: decider.name ?? "given", model, off: null, asked: fixed(decider.name ?? "given", model), limited: () => null, decide: (input, question, opts) => decider.decide(input, question, opts) };
  const route = DECISION_ROUTES.includes(inputs?.decisionRoute) ? inputs.decisionRoute : "auto";
  const none = (code) => ({ name: null, model, off: code, asked: fixed(null, model), limited: () => null, decide: async () => ({ verdict: null, confidence: null, error: "no_answer" }) });
  if (route === "off") return none("route-off");
  const { key, code } = deciderKeyState({ inputs, env, home });
  const withHarness = route === "auto" && !!stage?.harness;
  const harnessLabel = withHarness ? `${stage.harness}${stage.model ? ` ${stage.model}` : ""}` : null;
  const harnessDecide = async (input, question, opts) => (await harnessOf(stage)).decide(input, question, opts);
  // The stage's harness refusal that stopped its decision calls (a usage limit), once its adapter is open.
  const limited = () => (withHarness && shared(stage).opened ? shared(stage).opened.limited() : null);
  if (key) {
    mask(key);
    // One vendor per decider, opened at the first question: concurrent first questions share it.
    let opened = null;
    const gateway = async (input, question, opts) => (await (opened ??= openVendor({ vendor: "ai-gateway", key, model }))).decide(input, question, opts);
    if (!withHarness) return { name: "ai-gateway", model, off: null, asked: fixed("ai-gateway", model), limited: () => null, decide: gateway };
    const state = shared(stage);
    return {
      name: "ai-gateway",
      model,
      off: null,
      // Who answers now: the gateway, or after it refused Pendulum's key or credits, the stage's harness.
      asked: () => (state.gatewayRefused ? { name: "harness", model: harnessLabel } : { name: "ai-gateway", model }),
      limited,
      decide: async (input, question, opts) => {
        if (state.gatewayRefused) return harnessDecide(input, question, opts);
        const a = await gateway(input, question, opts);
        if (!GATEWAY_REFUSED.has(a.error)) return a;
        if (!state.gatewayRefused) log(`decision calls: the AI Gateway refused Pendulum's key (${a.error}); the stage's own harness (${stage.harness}) answers them for the rest of this stage`);
        state.gatewayRefused = a.error;
        return harnessDecide(input, question, opts);
      },
    };
  }
  if (!withHarness) return none(code);
  if (!harnessSaid) {
    harnessSaid = true;
    log(`decision calls: no AI Gateway key (${code}); the stage's own harness (${stage.harness}) answers them on its login`);
  }
  return { name: "harness", model: harnessLabel, off: null, keyCode: code, asked: fixed("harness", harnessLabel), limited, decide: harnessDecide };
}
