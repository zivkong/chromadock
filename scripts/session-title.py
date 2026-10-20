#!/usr/bin/env python3
"""Print a session's title from its transcript as JSON: {"title": str | null}.

A name the person gave (`custom-title`, from /rename) wins over the generated
one (`ai-title`); the latest of each kind counts.
"""

import glob
import json
import os
import sys

session_id = sys.argv[1] if len(sys.argv) > 1 else ""
paths = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{glob.escape(session_id)}.jsonl")) if session_id else []
custom = None
generated = None

for path in paths:
    with open(path, "rb") as fh:
        for line in fh:
            if b'"custom-title"' not in line and b'"ai-title"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("type") == "custom-title" and isinstance(row.get("customTitle"), str):
                custom = row["customTitle"]
            elif row.get("type") == "ai-title" and isinstance(row.get("aiTitle"), str):
                generated = row["aiTitle"]

json.dump({"title": custom or generated}, sys.stdout)
