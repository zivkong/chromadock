#!/usr/bin/env python3
"""Sum this calendar month's Claude Code spend from local session transcripts.

Each top-level transcript (~/.claude/projects/<project>/<session>.jsonl) carries
`cost-state` rows whose `totalCostUSD` is the session's running total. The rise
between consecutive rows is spend, dated by the latest `timestamp` seen before
it and bucketed by the local calendar month. Subagent transcripts are skipped:
their cost is already inside the parent session's total.

Incremental: per file it remembers the byte offset read so far, the last total
and the last timestamp, so a later run reads only the lines appended since.

A session writes its cost-state rows as it ends, so a session still open has
none yet: `--exclude <session-id>` leaves the caller's own transcript out, and
the caller adds that session's live cost itself.

The same rows carry `modelUsage.<model>.costUSD`, each model's running total,
summed the same way into a per-model breakdown.

Prints one JSON object:
{"month": "YYYY-MM", "usd": float, "sessions": int, "models": {"<model id>": float}}.
"""

import json
import os
import re
import sys
from datetime import datetime

PROJECTS = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/.cache/aurora/month-spend.json")
# Bumped whenever a cached entry's shape changes: an older entry is rescanned from the start.
CACHE_VERSION = 2
TIMESTAMP = re.compile(rb'"timestamp":"([^"]+)"')
TOTAL = re.compile(rb'"totalCostUSD":([0-9.eE+-]+)')
COST_STATE = b'"type":"cost-state"'


def local_month(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m")
    except ValueError:
        return None


def load_cache():
    try:
        with open(CACHE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cache, fh)
    os.replace(tmp, CACHE)


def scan(path, entry, size):
    # A file that shrank was rewritten: start it over.
    if entry is None or size < entry["offset"] or entry.get("v") != CACHE_VERSION:
        entry = {"v": CACHE_VERSION, "offset": 0, "total": 0.0, "ts": None, "months": {}, "modelTotals": {}, "modelMonths": {}}

    with open(path, "rb") as fh:
        fh.seek(entry["offset"])
        for line in fh:
            if not line.endswith(b"\n"):
                break  # a row still being written: read it next time
            entry["offset"] += len(line)
            stamp = TIMESTAMP.search(line)
            if stamp:
                entry["ts"] = stamp.group(1).decode()
            if COST_STATE not in line:
                continue
            found = TOTAL.search(line)
            if not found:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                row = {}
            total = float(found.group(1))
            # A total that falls means the running sum restarted.
            delta = total - entry["total"] if total >= entry["total"] else total
            entry["total"] = total
            month = local_month(entry["ts"]) if entry["ts"] else None
            if month and delta > 0:
                entry["months"][month] = entry["months"].get(month, 0.0) + delta
            usage = row.get("modelUsage") if isinstance(row.get("modelUsage"), dict) else {}
            for model, figures in usage.items():
                cost = figures.get("costUSD") if isinstance(figures, dict) else None
                if not isinstance(cost, (int, float)):
                    continue
                before = entry["modelTotals"].get(model, 0.0)
                rise = cost - before if cost >= before else cost
                entry["modelTotals"][model] = cost
                if month and rise > 0:
                    bucket = entry["modelMonths"].setdefault(month, {})
                    bucket[model] = bucket.get(model, 0.0) + rise

    return entry


def main():
    exclude = sys.argv[sys.argv.index("--exclude") + 1] if "--exclude" in sys.argv[:-1] else None
    month = datetime.now().astimezone().strftime("%Y-%m")
    month_start = datetime.now().astimezone().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    cache = load_cache()
    usd = 0.0
    sessions = 0
    models = {}

    for project in os.scandir(PROJECTS):
        if not project.is_dir():
            continue
        for item in os.scandir(project.path):
            if not item.name.endswith(".jsonl") or not item.is_file():
                continue
            if exclude is not None and item.name == f"{exclude}.jsonl":
                continue
            stat = item.stat()
            entry = cache.get(item.path)
            # Untouched since before this month and never seen: nothing of this month inside.
            if entry is None and stat.st_mtime < month_start:
                continue
            if entry is None or stat.st_size != entry["offset"] or entry.get("v") != CACHE_VERSION:
                entry = scan(item.path, entry, stat.st_size)
                cache[item.path] = entry
            spent = entry["months"].get(month, 0.0)
            if spent > 0:
                usd += spent
                sessions += 1
            for model, cost in entry["modelMonths"].get(month, {}).items():
                models[model] = models.get(model, 0.0) + cost

    save_cache(cache)
    ranked = dict(sorted(((m, round(c, 2)) for m, c in models.items()), key=lambda kv: -kv[1]))
    json.dump({"month": month, "usd": round(usd, 2), "sessions": sessions, "models": ranked}, sys.stdout)


if __name__ == "__main__":
    main()
