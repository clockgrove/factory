#!/usr/bin/env python3
"""Read Factory state and run logs (structure only, never prose).

  st.py ROOT status N            status, or "none" when there is no state file
  st.py ROOT phase N             status, or "hold:<step>" while a question is open (the oldest)
  st.py ROOT hold N [STEPGLOB]   the oldest open hold (matching STEPGLOB) as JSON, or null
  st.py ROOT holds N             every open hold as a JSON list, oldest first
  st.py ROOT active N STEPGLOB  current attempts as [{step, startedAt, run, id}]
  st.py ROOT auto-answers N POLICY [DECISIONS]  authorized answer options as JSON lines
  st.py ROOT answer-state N CHOICE [SINCE]  accepted, refused, pending or none, from structured records
  st.py ROOT has N PATH          1 when the dotted path exists (even holding null), else 0
  st.py ROOT maxconc STEPGLOB N...  most steps matching STEPGLOB running at once across
                                 Objectives N..., from their start/outcome log events
  st.py ROOT get N PATH          a field by dotted path as JSON (missing: null)
  st.py ROOT provider N          provider name frozen at admission
  st.py ROOT applied N KIND      how many applied requests have KIND in their id/message (JSON count)
  st.py ROOT events N [K=V...]   count log events of Objective N matching every K=V
                                 (V may end in * for a prefix, or start with * for a suffix)
  st.py ROOT at N first|last [K=V...]  the time of the first or last log event matching every K=V
                                 (as events), or "" when none
  st.py ROOT slot N              "START END" of N's queue slot: its first plan:* start to its
                                 report done or first hold after that (END empty while it still
                                 holds the slot), or "" when it never planned
  st.py ROOT started N STEPGLOB  1 when a "start" event exists for a step matching the glob
  st.py ROOT work-attempts N     each Work Item work attempt, oldest first, as a JSON line: its
                                 attempt id, item, outcome, whether the worker left a
                                 .factory-discovery.json, the files it changed outside the item's
                                 owned paths (the accepted plan's), and its transcript files
  st.py ROOT worker-proposals N  each kept worker discovery proposal as "ID ITEM", oldest first
  st.py ROOT retries N STEPGLOB  max retry count over steps matching the glob (0 when none)
  st.py ROOT starts-since N ISO STEPGLOB  start events at or after ISO for steps matching the glob
  st.py ROOT artifacts-kind N KIND   1 when any done step result holds {"kind": KIND}
  st.py ROOT amendments N [ISO]  each kept amendment proposal taken in at or after ISO, oldest
                                 first, as "ID STATUS": pending, accepted, rejected or continued,
                                 from its own result alone (amend:<id>, amend:<id>:continue;
                                 a result {"unchanged": true} is continued)
  st.py ROOT unreadable N        1 when service.json lists N as unreadable

Holds: a build saves a list `holds` (STATE_VERSION 2); an older one saves
one `hold`. Both read the same here.
"""
import fnmatch
import datetime
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


def auto_answers(d, policy, decisions):
    """Policies choose actual options; criterion overrides require an exact fixture decision."""
    for h in holds_of(d):
        options = h.get("options") or []
        step = h.get("step", "")
        chosen, text = None, None
        if "review" in policy and (step.endswith(":review") or step == "final-review"):
            for option in options:
                decision = next((entry for entry in decisions
                                 if entry.get("step") == step
                                 and entry.get("answer") == option.get("answer")
                                 and entry.get("arg") == option.get("arg")), None)
                if decision and option.get("answer") in ("accept", "refuse"):
                    chosen, text = option, decision.get("text")
                    break
        if chosen is None and "more" in policy:
            chosen = next((o for o in options if o.get("answer") == "more"
                           and o.get("recommended") and o.get("family") == "retry"), None)
        if chosen is None and "decide" in policy and step.startswith("decide:"):
            chosen = next((o for o in options if o.get("answer") == "answer"
                           and o.get("family") == "answer"), None)
            text = ("Choose an implementation detail within the Objective's written goal, acceptance "
                    "criteria, Sources and existing command authority. Do not add authority, relax "
                    "acceptance or drop capabilities; keep the question open if that is required.")
        if chosen is None and "d2" in policy and h.get("cause") == "failure":
            if {o.get("answer") for o in options} == {"retry", "cancel"}:
                chosen = next(o for o in options if o.get("answer") == "retry")
        if chosen is None or (chosen.get("needsText") and not (text or "").strip()):
            continue
        result = {"id": h["id"], "step": step, "answer": chosen["answer"]}
        if "arg" in chosen:
            result["arg"] = chosen["arg"]
        if text:
            result["text"] = text
        yield result


def answer_state(root, n, choice, since=None):
    def matches(request):
        return (request.get("kind") == "answer" and request.get("issue") == int(n)
                and request.get("question") == choice["id"]
                and all(request.get(key) == choice.get(key) for key in ("answer", "arg", "text")))

    after = datetime.datetime.fromisoformat(since.replace("Z", "+00:00")) if since else None
    found = "none"
    for event in events(root, n):
        if event.get("event") != "request" or not matches(event.get("request") or {}):
            continue
        if after and datetime.datetime.fromisoformat(event["at"].replace("Z", "+00:00")) < after:
            continue
        found = "accepted" if event.get("message") == "ok" and not event.get("code") else "refused"
    if found != "none":
        return found
    for path in glob.glob(os.path.join(root, "requests", "*.json")):
        try:
            with open(path) as file:
                request = json.load(file)
        except FileNotFoundError:
            continue
        if matches(request.get("request") or {}):
            return "pending"
    return "none"


def pending_answers(root, n, d):
    """Answer requests for N's open holds the service hasn't applied yet."""
    ids = {h.get("id") for h in holds_of(d)}
    count = 0
    for path in glob.glob(os.path.join(root, "requests", "*.json")):
        try:
            with open(path) as file:
                request = json.load(file).get("request") or {}
        except (FileNotFoundError, ValueError):
            continue
        if request.get("kind") == "answer" and request.get("issue") == int(n) and request.get("question") in ids:
            count += 1
    return count


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
    d = load(root, n) if cmd not in ("events", "at", "slot", "started", "unreadable", "maxconc", "starts-since") else None
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
    elif cmd == "pending":
        print(pending_answers(root, n, d))
    elif cmd == "active":
        attempts = d.get("attempts", {}) if isinstance(d, dict) else {}
        print(json.dumps([dict(attempt, step=step) for step, attempt in attempts.items()
                          if fnmatch.fnmatchcase(step, rest[0])]))
    elif cmd == "auto-answers":
        decisions = json.loads(rest[1]) if len(rest) > 1 else []
        for choice in auto_answers(d, rest[0].split(), decisions):
            print(json.dumps(choice))
    elif cmd == "answer-state":
        print(answer_state(root, n, json.loads(rest[0]), rest[1] if len(rest) > 1 else None))
    elif cmd == "has":
        cur, ok = d if isinstance(d, dict) else None, True
        for part in rest[0].split("."):
            if isinstance(cur, dict) and part in cur: cur = cur[part]
            else: ok = False; break
        print(1 if ok else 0)
    elif cmd == "validation-commands":
        # The validation commands under one state path (done.plan: the accepted plan), one per line.
        cur = d if isinstance(d, dict) else None
        for part in rest[0].split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        for node in walk(cur if isinstance(cur, dict) else {}):
            if isinstance(node, dict) and isinstance(node.get("validation"), list):
                for check in node["validation"]:
                    if isinstance(check, dict) and isinstance(check.get("command"), str):
                        print(check["command"])
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
    elif cmd == "at":
        conds = [c.split("=", 1) for c in rest[1:]]
        times = sorted(str(e["at"]) for e in events(root, n)
                       if "at" in e and all(match(e.get(k), v) for k, v in conds))
        print((times[0] if rest[0] == "first" else times[-1]) if times else "")
    elif cmd == "slot":
        # The check runs with no slot; planning and building take one of
        # queue.maxActiveObjectives, given back at the end or on a hold.
        evs = sorted((e for e in events(root, n) if "at" in e), key=lambda e: str(e["at"]))
        start = next((str(e["at"]) for e in evs if e.get("event") == "start" and match(e.get("step"), "plan:*")), "")
        end = next((str(e["at"]) for e in evs if start and str(e["at"]) >= start and (e.get("event") == "hold" or (
            e.get("event") == "outcome" and e.get("outcome") == "done" and e.get("step") == "report"))), "")
        print(f"{start} {end}".strip())
    elif cmd == "work-attempts":
        # From each attempt's last worker-activity sample (its `changed` files,
        # untracked ones too) and outcome. Ownership as planning/graph.ts
        # ownsPath: a scope ending in / owns what is under it, else that path.
        items = (((d or {}).get("done") or {}).get("plan") or {}).get("items") or [] if isinstance(d, dict) else []
        owned = {i.get("id"): i.get("ownedPaths") or [] for i in items if isinstance(i, dict)}
        staging = (".factory-discovery.json", ".factory-handoff.json", ".factory-inputs", ".factory-assets.json", ".factory-media")
        attempts = {}
        for e in events(root, n):
            step, aid = str(e.get("step")), e.get("attemptId")
            if not (fnmatch.fnmatchcase(step, "item:*:work") and aid):
                continue
            a = attempts.setdefault(aid, {"attempt": aid, "item": step[len("item:"):-len(":work")],
                                          "outcome": None, "changed": None, "transcript": None})
            if e.get("event") == "worker-activity" and isinstance(e.get("changed"), dict):
                a["changed"] = e["changed"].get("files") or []
            elif e.get("event") == "transcript" and e.get("file"):
                f = os.path.join(root, "logs", str(e["file"]))
                a["transcript"] = sorted(glob.glob(glob.escape(f) + "*")) or [f]
            elif e.get("event") == "outcome":
                a["outcome"] = e.get("outcome")
        for a in attempts.values():
            changed = a.pop("changed")
            scopes = owned.get(a["item"], [])
            a["discovery"] = None if changed is None else ".factory-discovery.json" in changed
            a["unowned"] = None if changed is None else [
                p for p in changed
                if not any(p == s or p.startswith(s + "/") for s in staging)
                and not any(p.startswith(s) if s.endswith("/") else p == s for s in scopes)]
            print(json.dumps(a))
    elif cmd == "worker-proposals":
        # Kept as amend:<id>:proposal; a worker's names its item (work/amend.ts discoveryOutcome).
        kept = (d or {}).get("kept") or {} if isinstance(d, dict) else {}
        props = sorted((p for k, p in kept.items() if fnmatch.fnmatchcase(k, "amend:*:proposal")
                        and isinstance(p, dict) and isinstance(p.get("worker"), dict)),
                       key=lambda p: str(p.get("at", "")))
        for p in props:
            print(p.get("id"), p["worker"].get("itemId"))
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
    elif cmd == "amendments":
        # Proposals are kept as amend:<id>:proposal; amend:<id> is the result.
        # Unlike planning/amendments.ts amendmentStatus, this neither follows a
        # replacement (<id>-r<n>) nor drops a proposal of an earlier plan:
        # case_amend reads it before its edit's replan and never answers
        # `replace`, so its proposal is the first one listed and has no chain.
        kept = (d or {}).get("kept") or {} if isinstance(d, dict) else {}
        done = (d or {}).get("done") or {} if isinstance(d, dict) else {}
        since = rest[0] if rest else ""
        proposals = sorted((p for k, p in kept.items() if fnmatch.fnmatchcase(k, "amend:*:proposal")
                            and isinstance(p, dict) and str(p.get("at", "")) >= since),
                           key=lambda p: str(p.get("at", "")))
        for p in proposals:
            key = f"amend:{p.get('id')}"
            result = done.get(key)
            # A reviewed round that left the plan unchanged settles it as
            # continued with no `continue` answer: {"unchanged": true} (#2116).
            print(p.get("id"), "pending" if not isinstance(result, dict) else "accepted" if result.get("plan")
                  else "continued" if result.get("unchanged") or f"{key}:continue" in done else "rejected")
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
