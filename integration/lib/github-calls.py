#!/usr/bin/env python3
"""Where a run's GitHub budget went, for its results file (#2194).

Usage: github-calls.py STATE_BASE RUN_DIR

Every installation's `github-call` events (github-trace.ts counts per sync
job, step attempt and the service's own) summed by job, ids as {n} and a Work
Item as *; and the proxied installations' requests (lib/gh-fault-proxy.mjs
calls.jsonl) by route. The 15 largest of each, as Markdown; nothing when
there are none.
"""
import collections
import glob
import json
import os
import re
import sys


def lines(pattern):
    for path in glob.glob(pattern):
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


state, run = sys.argv[1:3]
jobs, routes = collections.Counter(), collections.Counter()
for e in lines(os.path.join(state, "*", "*", "logs", "*", "*.jsonl")):
    if isinstance(e, dict) and e.get("event") == "github-call":
        job = re.sub(r":\d+(?=:|$)", ":{n}", str(e.get("job")))
        jobs[re.sub(r"^item:[^:]+", "item:*", job)] += int(e.get("calls") or 0)
for r in lines(os.path.join(run, "*.calls.jsonl")):
    if isinstance(r, dict):
        path = re.sub(r"/\d+(?=/|$)", "/{n}", str(r.get("path", "")).split("?")[0])
        routes[f"{r.get('method')} {path}"] += 1
for title, column, counts in (
    ("job (every installation)", "Job", jobs),
    ("route (proxied installations)", "Route", routes),
):
    if counts:
        print(f"\n## GitHub calls by {title}\n\n| Calls | {column} |\n|---|---|")
        for key, n in counts.most_common(15):
            print(f"| {n} | `{key}` |")
