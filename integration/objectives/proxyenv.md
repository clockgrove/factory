## Goal

Record which proxy settings a worker's shell sees, for an operations check. Run `env | grep -i '_proxy=' | sort` in your shell and write its exact output, one line per variable, to `docs/proxy-env{{ID}}.md` under the heading `# Proxy environment`. If the command prints nothing, write the single line `none` under the heading. Add `test/proxyEnv{{ID}}.test.js`, which checks that `docs/proxy-env{{ID}}.md` starts with `# Proxy environment`. No other file changes.

## Acceptance

- `docs/proxy-env{{ID}}.md` holds the heading and the shell's proxy variables exactly as printed, or `none`.
- `npm test`
