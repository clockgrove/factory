import assert from "node:assert/strict";

const codexCliVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Validate the bounded identity already admitted by the behavior-qualified App Server runtime. */
export function assertQualificationAppServerIdentity(binding) {
  assert.ok(
    binding !== null && typeof binding === "object" && !Array.isArray(binding),
    "session App Server binding is invalid",
  );
  assert.ok(
    typeof binding.cliVersion === "string" &&
      binding.cliVersion.length <= 64 &&
      codexCliVersion.test(binding.cliVersion),
    "session CLI version identity is invalid",
  );
  assert.ok(
    typeof binding.serverUserAgent === "string" &&
      binding.serverUserAgent.trim().length > 0 &&
      Buffer.byteLength(binding.serverUserAgent, "utf8") <= 512 &&
      ![...binding.serverUserAgent].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
      }),
    "session server user agent identity is invalid",
  );
  return binding;
}
