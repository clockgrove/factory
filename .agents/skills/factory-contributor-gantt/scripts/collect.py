#!/usr/bin/env python3
"""Extract timing metadata only from explicitly selected contributor observations."""
import argparse
import csv
import datetime as dt
import json
import math
from pathlib import Path


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamps require a timezone')
    return parsed.timestamp()


def union(spans):
    result = []
    for a, b in sorted(spans):
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def collect(manifest, base):
    start, end = timestamp(manifest['startUtc']), timestamp(manifest['endUtc'])
    if end <= start:
        raise ValueError('endUtc must follow startUtc')
    agents = manifest['agents']
    identities = [a['id'] for a in agents]
    if len(set(identities)) != len(identities):
        raise ValueError('agent ids must be unique')
    for agent in agents:
        if agent.get('parent') and agent['parent'] not in identities:
            raise ValueError('parent must name a selected agent')
    rows, events, coverage = [], [], []

    def interval(agent, kind, label, a, b, **metadata):
        if not math.isfinite(a) or not math.isfinite(b) or b < a:
            raise ValueError('invalid observed interval')
        lo, hi = max(start, a), min(end, b)
        if hi > lo:
            rows.append(dict(agent=agent, kind=kind, label=label,
                             start=lo-start, end=hi-start, **metadata))

    for agent in agents:
        aid = agent['id']
        for index, trace in enumerate(agent.get('traces', [])):
            calls, items = {}, set()
            count = 0
            # Stream entire selected file: no arbitrary tail truncation or text export.
            with (base / trace).open(encoding='utf-8') as stream:
                for line in stream:
                    entry = json.loads(line)
                    stamp = entry.get('timestamp')
                    if not stamp:
                        continue
                    when = timestamp(stamp)
                    payload = entry.get('payload', {})
                    typ = payload.get('type')
                    if entry.get('type') == 'event_msg' and typ == 'item_completed':
                        item = payload.get('item', {})
                        a, b = payload.get('started_at_ms'), payload.get('completed_at_ms')
                        key = item.get('id')
                        if item.get('type') in ('Reasoning', 'AgentMessage') and a is not None and b is not None and key not in items:
                            items.add(key)
                            interval(aid, 'output-item', item['type'], a/1000, b/1000, source=f'trace-{index}', identity=key)
                    if entry.get('type') == 'response_item':
                        key = payload.get('call_id')
                        if typ in ('function_call', 'custom_tool_call'):
                            if key is not None and when <= end:
                                calls[key] = (when, payload.get('name', 'unknown-tool'))
                        elif typ in ('function_call_output', 'custom_tool_call_output') and key in calls:
                            a, name = calls.pop(key)
                            kind = 'wait' if name.rsplit('.', 1)[-1] in ('wait', 'wait_agent', 'sleep', 'write_stdin') else 'tool'
                            interval(aid, kind, name, a, when, source=f'trace-{index}', identity=key)
                    if start <= when <= end:
                        count += 1
                        if entry.get('type') == 'event_msg' and typ == 'task_started':
                            events.append(dict(agent=aid, kind='task-start', at=when-start))
                        if entry.get('type') in ('response_item', 'event_msg') and typ == 'agent_message':
                            events.append(dict(agent=aid, kind='agent-delivery', at=when-start))
                        if entry.get('type') == 'response_item' and typ == 'message' and payload.get('role') == 'assistant' and payload.get('phase') in ('final', 'final_answer'):
                            events.append(dict(agent=aid, kind='final-message', at=when-start))
            coverage.append(dict(agent=aid, source=f'trace-{index}', entriesInWindow=count,
                                 unmatchedToolRequests=sum(start <= v[0] <= end for v in calls.values()),
                                 unmatchedPreWindowToolRequests=sum(v[0] < start for v in calls.values())))
        for index, spec in enumerate(agent.get('timings', [])):
            timing = json.loads((base / spec['path']).read_text())
            labels = spec.get('labels', {})
            for phase_index, phase in enumerate(timing['phases']):
                a = timestamp(phase['startedUtc'])
                # Never copy argv; index labels are supplied, sanitized descriptions.
                label = labels.get(str(phase_index), f'Subprocess {phase_index+1}')
                interval(aid, 'subprocess', label, a, a+phase['seconds'],
                         source=f'timing-{index}', identity=phase_index, exitCode=phase['exitCode'],
                         cpuSeconds=None, networkSeconds=None)
        lo = max(start, timestamp(agent.get('startUtc', manifest['startUtc']))) - start
        hi = min(end, timestamp(agent.get('endUtc', manifest['endUtc']))) - start
        if not 0 <= lo <= hi <= end-start:
            raise ValueError('agent bounds must overlap the selected window')
        cursor = lo
        for a, b in union((max(lo, r['start']), min(hi, r['end'])) for r in rows if r['agent'] == aid and r['end'] > lo and r['start'] < hi):
            if a > cursor:
                rows.append(dict(agent=aid, kind='unknown', label='Unclassified gap', start=cursor, end=a))
            cursor = max(cursor, b)
        if cursor < hi:
            rows.append(dict(agent=aid, kind='unknown', label='Unclassified gap', start=cursor, end=hi))
    markers = []
    for marker in manifest.get('markers', []):
        at = timestamp(marker['atUtc'])-start
        if not 0 <= at <= end-start:
            raise ValueError('marker outside selected window')
        markers.append(dict(label=marker['label'], at=at))
    for span in manifest.get('routing', []):
        if span['agent'] not in identities:
            raise ValueError('routing agent must name a selected agent')
        interval(span['agent'], 'routing', span['label'], timestamp(span['startUtc']), timestamp(span['endUtc']))
    stats = {aid: {kind: sum(b-a for a,b in union((r['start'], r['end']) for r in rows if r['agent'] == aid and r['kind'] == kind)) for kind in ('output-item', 'tool', 'wait', 'subprocess', 'routing', 'unknown')} for aid in identities}
    return dict(title=manifest.get('title', 'Factory contributor diagnostic'), startUtc=manifest['startUtc'], endUtc=manifest['endUtc'], elapsedSeconds=end-start,
                agents=[{k:a[k] for k in ('id', 'parent') if k in a} for a in agents], intervals=rows, events=events, markers=markers, coverage=coverage, unionSeconds=stats,
                limitations=['Observed output items are not complete LLM requests, call counts or inference CPU.', 'Tool request/result and wait intervals overlap subprocesses and ongoing work; totals are not additive.', 'Routing includes scheduling and delivery, not proven pure network.', 'Unclassified gaps remain unknown; per-command CPU/network and full LLM requests are unavailable.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = collect(json.loads(args.manifest.read_text()), args.manifest.resolve().parent)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'timing.json').write_text(json.dumps(data, indent=2)+'\n')
    with (args.output / 'intervals.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['agent', 'kind', 'label', 'start', 'end', 'source', 'identity', 'exitCode', 'cpuSeconds', 'networkSeconds'])
        writer.writeheader()
        writer.writerows(data['intervals'])
    print(f"Collected {len(data['intervals'])} intervals; selected wall {data['elapsedSeconds']:.3f}s")


if __name__ == '__main__':
    main()
