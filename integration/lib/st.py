#!/usr/bin/env python3
"""Read Factory state and run logs (structure only, never prose).

  st.py ROOT status N            status, or "none" when there is no state file
  st.py ROOT phase N             status, or "hold:<step>" while a question is open (the oldest)
  st.py ROOT hold N [STEPGLOB]   the oldest open hold (matching STEPGLOB) as JSON, or null
  st.py ROOT holds N             every open hold as a JSON list, oldest first
  st.py ROOT has N PATH          1 when the dotted path exists (even holding null), else 0
  st.py ROOT maxconc STEPGLOB N...  most steps matching STEPGLOB running at once across
                                 Objectives N..., from their start/outcome log events
  st.py ROOT get N PATH          a field by dotted path as JSON (missing: null)
  st.py ROOT provider N          provider name frozen at admission
  st.py ROOT applied N KIND      how many applied requests have KIND in their id/message (JSON count)
  st.py ROOT events N [K=V...]   count log events of Objective N matching every K=V
                                 (V may end in * for a prefix, or start with * for a suffix)
  st.py ROOT started N STEPGLOB  1 when a "start" event exists for a step matching the glob
  st.py ROOT retries N STEPGLOB  max retry count over steps matching the glob (0 when none)
  st.py ROOT starts-since N ISO STEPGLOB  start events at or after ISO for steps matching the glob
  st.py ROOT artifacts-kind N KIND   1 when any done step result holds {"kind": KIND}
  st.py ROOT unreadable N        1 when service.json lists N as unreadable

Holds: a build saves a list `holds` (STATE_VERSION 2); an older one saves
one `hold`. Both read the same here.
"""
import fnmatch
import glob
import json
import os
import sys


def load(root, n):
    # A settled Objective's file moves to objectives/finished/.
    for path in (os.path.join(root, "objectives", f"{n}.json"),
                 os.path.join(root, "objectives", "finished", f"{n}.json")):
        try:
            with open(path) as f:
                return json.load(f)
        except FileNotFoundError:
            continue
        except json.JSONDecodeError:
            return "unreadable"
    return None


def events(root, n):
    for path in sorted(glob.glob(os.path.join(root, "logs", str(n), "*.jsonl"))):
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def holds_of(d):
    """Open holds, oldest first: `holds` (STATE_VERSION 2) or the single `hold`."""
    if not isinstance(d, dict):
        return []
    if isinstance(d.get("holds"), list):
        hs = [h for h in d["holds"] if isinstance(h, dict)]
    else:
        hs = [d["hold"]] if isinstance(d.get("hold"), dict) else []
    return [with_answers(h) for h in hs]


def with_answers(h):
    """A build keeps `options` [{answer, recommended, ...}]; an older one `answers` + `recommended`."""
    opts = h.get("options")
    if isinstance(opts, list) and "answers" not in h:
        h = dict(h)
        h["answers"] = list(dict.fromkeys(o.get("answer") for o in opts if isinstance(o, dict)))
        rec = [o.get("answer") for o in opts if isinstance(o, dict) and o.get("recommended")]
        h["recommended"] = rec[0] if rec else None
    return h


def match(value, want):
    value = "" if value is None else str(value)
    if want.endswith("*") and not want.startswith("*"):
        return value.startswith(want[:-1])
    if want.startswith("*") and not want.endswith("*"):
        return value.endswith(want[1:])
    if "*" in want:
        return fnmatch.fnmatchcase(value, want)
    return value == want


def walk(obj):
    yield obj
    if isinstance(obj, dict):
        for v in obj.values():
            yield from walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v)


def main():
    root, cmd, n = sys.argv[1], sys.argv[2], sys.argv[3]
    rest = sys.argv[4:]
    d = load(root, n) if cmd not in ("events", "started", "unreadable", "maxconc", "starts-since") else None
    if cmd == "status":
        print("none" if d is None else ("unreadable" if d == "unreadable" else d.get("status")))
    elif cmd == "phase":
        if d is None or d == "unreadable":
            print("none" if d is None else "unreadable")
        elif holds_of(d):
            print("hold:" + holds_of(d)[0]["step"])
        else:
            print(d.get("status"))
    elif cmd == "hold":
        hs = [h for h in holds_of(d) if not rest or fnmatch.fnmatchcase(str(h.get("step")), rest[0])]
        print(json.dumps(hs[0] if hs else None))
    elif cmd == "holds":
        print(json.dumps(holds_of(d)))
    elif cmd == "has":
        cur, ok = d if isinstance(d, dict) else None, True
        for part in rest[0].split("."):
            if isinstance(cur, dict) and part in cur: cur = cur[part]
            else: ok = False; break
        print(1 if ok else 0)
    elif cmd == "maxconc":
        # n is the step glob here; the Objectives follow.
        edges = []
        for issue in rest:
            open_at = {}
            for e in events(root, issue):
                step = str(e.get("step"))
                if not fnmatch.fnmatchcase(step, n) or "at" not in e:
                    continue
                key = (issue, step)
                if e.get("event") == "start":
                    open_at[key] = e["at"]
                elif e.get("event") == "outcome" and key in open_at:
                    edges += [(open_at.pop(key), 1), (e["at"], -1)]
        cur = best = 0
        for _, dlt in sorted(edges, key=lambda x: (x[0], x[1])):
            cur += dlt
            best = max(best, cur)
        print(best)
    elif cmd == "get":
        cur = d if isinstance(d, dict) else None
        for part in rest[0].split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        print(json.dumps(cur))
    elif cmd == "provider":
        print(((d or {}).get("provider") or {}).get("name") if isinstance(d, dict) else None)
    elif cmd == "applied":
        reqs = (d or {}).get("appliedRequests") or [] if isinstance(d, dict) else []
        print(sum(1 for r in reqs if rest[0] in json.dumps(r)))
    elif cmd == "events":
        conds = [c.split("=", 1) for c in rest]
        print(sum(1 for e in events(root, n) if all(match(e.get(k), v) for k, v in conds)))
    elif cmd == "started":
        print(1 if any(e.get("event") == "start" and fnmatch.fnmatchcase(str(e.get("step")), rest[0]) for e in events(root, n)) else 0)
    elif cmd == "starts-since":
        print(sum(1 for e in events(root, n) if e.get("event") == "start" and str(e.get("at", "")) >= rest[0]
                  and fnmatch.fnmatchcase(str(e.get("step")), rest[1])))
    elif cmd == "retries":
        rs = (d or {}).get("retries") or {} if isinstance(d, dict) else {}
        print(max([v.get("count", 0) for k, v in rs.items() if fnmatch.fnmatchcase(k, rest[0])] or [0]))
    elif cmd == "artifacts-kind":
        done = (d or {}).get("done") or {} if isinstance(d, dict) else {}
        print(1 if any(isinstance(x, dict) and x.get("kind") == rest[0] for x in walk(done)) else 0)
    elif cmd == "unreadable":
        try:
            with open(os.path.join(root, "service.json")) as f:
                s = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            s = {}
        print(1 if str(n) in (s.get("unreadable") or {}) else 0)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
