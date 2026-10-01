---
name: factory-contributor-gantt
description: Build detailed timing Gantts from existing release scripts and agent observations when developers debug BUILDING Factory itself. Excludes adopter Objectives and installed plugin use.
---

# Factory contributor Gantt

Use existing observations to explain a Factory contributor release or debugging cycle with precise agent hierarchy, boundaries and time attribution. This repository-local skill is discovered from `.agents/skills` ([Codex discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)); invoke it as `$factory-contributor-gantt`. It is contributor tooling, outside the plugin's `skills/` distribution. Follow repository contributor rules; this skill grants no execution or disclosure authority. Never run Factory against Factory source.

Select only the explicitly relevant trace files and clock window. Read [the input guide](references/inputs.md) to prepare a small manifest identifying agents, parents, existing release/audit `timing.json` files and exact boundary markers. Record candidate preparation, technical independent PASS, issue/Project tracking completion, reporting end and chart rendering separately when those boundaries exist. Do not equate PASS with the final agent message or assume a reporting checkpoint is the full turn end.

Use the helpers from this skill's directory:

```sh
python3 scripts/collect.py /path/to/manifest.json /path/to/local-output
python3 scripts/plot.py /path/to/local-output/timing.json /path/to/local-output
```

The collector uses Python's standard library; the renderer requires Matplotlib in the selected Python environment. Use an existing environment or an explicitly prepared local environment (for example `python3 -m venv /tmp/gantt-env`, then install Matplotlib there). Do not add a dependency or host-specific search path to Factory. Both commands analyze files only; they execute no recorded commands, models or Objectives.

Inspect coverage and unmatched requests in `timing.json`, the sanitized raw intervals in `intervals.csv`, and both images. Missing/untimed events and spans outside the selected sources remain unavailable. A tool request lacking a result yields no fabricated duration; record that coverage limitation. Nested waits inside orchestration tools cannot be identified reliably from the outer tool name and remain tool intervals unless independently evidenced. Review the actual image for readable agent headings, precise boundary labels and grouped subprocess detail. Keep generated outputs and manifests in ignored `release/evidence/` or local scratch. Export only metadata and curated labels; never publish native traces, hidden reasoning, prompts, arguments, tool result text, logs, secrets or private source.

Use these exact meanings when explaining the chart:

- Timed Codex `Reasoning` and `AgentMessage` **output items** are observed fragments, not complete LLM requests, request counts, full request latency or inference CPU. Untimed inference or queues can remain unclassified.
- Agent tool request/result intervals can contain script subprocesses. `spawnSync` argv observations are direct executable invocations; `npm`, `git`, `curl` or `node` is not automatically Bash.
- Explicit waits/polls overlap ongoing work. Union durations within one lane are useful; summing lane durations does not give elapsed time.
- Dispatch-to-task-start and completion-to-delivery are combined observed routing and scheduling intervals only when both endpoints and the recipient are grounded. Generic mailbox events alone do not prove a particular delivery. Supply verified routing annotations without exporting message content.
- Unclassified gaps stay unknown. Aggregate child/process CPU can exceed wall time because work overlaps; wall time minus aggregate CPU cannot identify network. Per-command CPU/network and full model requests remain unavailable unless directly recorded elsewhere.

Report the measured cycle, major observed bottlenecks, evidence gaps and image/data paths. Compare two cycles only when their scenario, artifact, start/end boundaries, exclusions and failures are actually comparable. Make no invented speedup or CPU/network split. Post-hoc chart rendering is outside the measured cycle unless deliberately included and evidenced.
