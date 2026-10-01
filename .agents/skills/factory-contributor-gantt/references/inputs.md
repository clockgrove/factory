# Selected observations and manifest

Use absolute source paths or paths relative to the manifest. Source files may remain private; neither paths nor source text enter the generated timing JSON. Each exported `source` is an agent-local `trace-N` or `timing-N` alias and each `identity` is an item/call or phase index. Keep the original manifest locally to resolve aliases. Choose agent IDs and labels that are safe for the intended recipient. Do not copy an entire release plan into exported data.

```json
{
  "title": "Factory contributor release diagnostic",
  "startUtc": "2026-10-01T05:44:04.115Z",
  "endUtc": "2026-10-01T05:49:38.766250Z",
  "agents": [
    {
      "id": "/root",
      "traces": ["selected-owner.jsonl"],
      "timings": [
        {
          "path": "owner-timing.json",
          "labels": { "0": "Verify source", "1": "Build" }
        }
      ]
    },
    {
      "id": "/root/auditor",
      "parent": "/root",
      "startUtc": "2026-10-01T05:46:00Z",
      "endUtc": "2026-10-01T05:47:00Z",
      "traces": ["selected-auditor.jsonl"],
      "timings": [
        {
          "path": "audit-timing.json",
          "labels": { "0": "Anonymous archive download" }
        }
      ]
    }
  ],
  "markers": [
    {
      "label": "Independent technical PASS",
      "atUtc": "2026-10-01T05:46:36.309Z"
    },
    { "label": "Reporting checkpoint", "atUtc": "2026-10-01T05:49:38.766250Z" }
  ],
  "routing": []
}
```

Agent order controls overview/detail order; explicit `parent` identifies subagents. Agent `startUtc`/`endUtc` limit the unclassified-gap lane, not the observed intervals. Defaults use the full manifest window; set narrower bounds for an auditor's actual active period to avoid attributing pre-dispatch time to it. All timestamps require timezones. Markers require directly evidenced times inside the selected window. Record preparation or chart rendering exclusions in the analysis instead of putting out-of-window markers on the chart.

Optional `routing` entries contain `agent`, sanitized `label`, `startUtc` and `endUtc`. Add them only after correlating exact dispatch/recipient start or final/delivery identities in the selected observations. They are overlays and do not fill gaps with a causal attribution. Tool call, item ID and generic delivery metadata alone cannot determine recipients or pure network time. The helper deliberately does not inspect raw arguments or message bodies to guess this relationship.

The collector supports the Codex JSONL observations demonstrated by the clean v0.1.57 contributor analysis (#384):

- `event_msg` → `item_completed` with `item.type` equal to `Reasoning` or `AgentMessage`, `item.id`, `started_at_ms`, `completed_at_ms`. Only these numeric boundaries/type/identity are retained; item content is ignored.
- `response_item` function/custom tool request and output pairs with `call_id` and request `name`. Only matching request/result timestamps are used. Explicit outer names `wait`, `wait_agent`, `sleep` and `write_stdin` are wait/poll observations. Tool arguments/input/output content is never exported or analyzed.
- Task starts (`event_msg` → `task_started`), assistant final-message timestamps (`response_item` → `message`, role `assistant`, phase `final` or `final_answer`) and generic agent deliveries (`response_item` or `event_msg` → `agent_message`) become metadata events. Only the selected agent, event kind and timestamp are retained; message bodies and recipient fields are ignored. These events are not independent technical acceptance markers and do not establish recipient routing.

The collector streams selected files, keeping only metadata that intersects the chosen window. It does not arbitrarily tail-truncate large files. It retains paired endpoints around the window so crossing intervals can be clipped. Malformed JSON fails rather than silently dropping observations. It does not recursively search sessions, read neighboring files, or implement alternate-provider trace fallbacks. Other trace shapes require explicit analysis rather than pretending they supplied these measurements.

Existing Factory contributor release/audit timing files provide `phases` with `startedUtc`, elapsed `seconds` and `exitCode`; each is a direct subprocess observation. Supply a phase-index `labels` map of concise reviewed descriptions to group repeated invocations. Without one, rows say `Subprocess N`. Preserve fine-grained labels such as archive creation, anonymous checksum download, exact tag protection, marketplace inspection and tracking completion when actually supported. No command argv is copied. Per-command CPU/network stay null. Aggregate CPU may be discussed from separate direct process observations with its exact scope; this helper does not merge it into subprocess time.

Outputs:

- `timing.json`: window, agent hierarchy, clipped interval metadata, boundary markers, generic events, coverage/unmatched request counts (including separately counted pre-window requests with unknown possible overlap), per-lane union seconds and measurement limitations.
- `intervals.csv`: sanitized raw intervals for reproducible inspection. Zero-length records do not create bars. Unknown spans complement observed coverage within each agent's declared active bounds; they do not measure a particular cause.
- `gantt.svg` / `gantt.png`: overview lanes and one grouped script subprocess detail panel per agent with subprocess observations, sharing the original elapsed clock.
